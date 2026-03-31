#!/usr/bin/env node

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const INVENTORY_PATH = path.resolve(process.cwd(), "inventory.json");
const NOT_FOUND_PATH = path.resolve(process.cwd(), "prodcutos_not_found.json");

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-01";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";
const LOCATION_ID =
  process.env.SHOPIFY_LOCATION_ID || "gid://shopify/Location/88096276709";
const WORKERS_COUNT = 5;
const PROGRESS_EVERY = Number(process.env.SHOPIFY_SYNC_PROGRESS_EVERY || 25);
// GraphQL limita por costo (puntos), no solo por requests.
// Default conservador para evitar THROTTLED en cuentas standard.
const SHOPIFY_GLOBAL_RPS = Number(process.env.SHOPIFY_GLOBAL_RPS || 20);
const PER_WORKER_RPS = Math.max(1, Math.floor(SHOPIFY_GLOBAL_RPS / WORKERS_COUNT));
const THROTTLE_MAX_RETRIES = 5;
const THROTTLE_BASE_MS = Number(process.env.SHOPIFY_THROTTLE_BASE_MS || 700);
const THROTTLE_MAX_MS = Number(process.env.SHOPIFY_THROTTLE_MAX_MS || 10000);

function toNumber(v) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function toPriceString(v) {
  const n = toNumber(v);
  if (n == null) return null;
  return String(n);
}

function splitIntoChunks(arr, chunksCount) {
  const chunks = Array.from({ length: chunksCount }, () => []);
  arr.forEach((item, idx) => {
    chunks[idx % chunksCount].push(item);
  });
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRateLimiter(rps) {
  const intervalMs = Math.ceil(1000 / Math.max(1, rps));
  let nextAt = Date.now();
  return async function waitTurn() {
    const now = Date.now();
    if (nextAt > now) {
      await sleep(nextAt - now);
    }
    const ts = Date.now();
    nextAt = Math.max(nextAt, ts) + intervalMs;
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function isThrottledGraphQLError(errors) {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => e?.extensions?.code === "THROTTLED");
}

function throttleBackoffMs(attempt) {
  const exp = THROTTLE_BASE_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 350);
  return Math.min(THROTTLE_MAX_MS, exp + jitter);
}

async function getAccessToken() {
  const tokenUrl = `https://${STORE_DOMAIN}/admin/oauth/access_token`;
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const { data } = await axios.post(tokenUrl, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  const token = data?.access_token || data?.accessToken;
  if (!token) throw new Error("Shopify OAuth did not return access_token");
  return token;
}

async function graphqlRequest(accessToken, query, variables, waitTurn) {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

  for (let attempt = 1; attempt <= THROTTLE_MAX_RETRIES + 1; attempt += 1) {
    if (waitTurn) await waitTurn();
    const { data } = await axios.post(
      url,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        timeout: 30000,
      },
    );

    const errors = data?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      if (isThrottledGraphQLError(errors) && attempt <= THROTTLE_MAX_RETRIES) {
        const waitMs = throttleBackoffMs(attempt);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
    }

    return data?.data || {};
  }

  throw new Error("GraphQL throttled repeatedly after max retries");
}

async function getVariantBySku(accessToken, sku, waitTurn) {
  const query = `
    query VariantBySku($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            id
            sku
            product { id }
            inventoryItem { id }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(accessToken, query, { q: `sku:${sku}` }, waitTurn);
  const edge = data?.productVariants?.edges?.[0];
  return edge?.node || null;
}

async function setInventoryQuantity(accessToken, inventoryItemId, quantity, waitTurn) {
  const mutation = `
    mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      name: "available",
      quantities: [
        {
          inventoryItemId,
          locationId: LOCATION_ID,
          quantity,
        },
      ],
      reason: "correction",
      ignoreCompareQuantity: true,
    },
  };

  const data = await graphqlRequest(accessToken, mutation, variables, waitTurn);
  const errs = data?.inventorySetQuantities?.userErrors || [];
  if (errs.length > 0) {
    throw new Error(`inventorySetQuantities userErrors: ${JSON.stringify(errs)}`);
  }
}

async function updateVariantPrice(accessToken, productId, variantId, price, waitTurn) {
  const mutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    productId,
    variants: [
      {
        id: variantId,
        price,
      },
    ],
  };

  const data = await graphqlRequest(accessToken, mutation, variables, waitTurn);
  const errs = data?.productVariantsBulkUpdate?.userErrors || [];
  if (errs.length > 0) {
    throw new Error(`productVariantsBulkUpdate userErrors: ${JSON.stringify(errs)}`);
  }
}

async function updateProductStatus(accessToken, productId, waitTurn) {
  const status = "ACTIVE";
  const mutation = `
    mutation UpdateProductStatus($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      id: productId,
      status,
    },
  };

  const data = await graphqlRequest(accessToken, mutation, variables, waitTurn);
  const errs = data?.productUpdate?.userErrors || [];
  if (errs.length > 0) {
    throw new Error(`productUpdate userErrors: ${JSON.stringify(errs)}`);
  }
}

function loadInventoryMap() {
  if (!fs.existsSync(INVENTORY_PATH)) {
    throw new Error(`inventory.json not found: ${INVENTORY_PATH}`);
  }
  const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("inventory.json must be an object keyed by SKU");
  }
  return parsed;
}

async function runWorker(items, workerId) {
  const accessToken = await getAccessToken();
  const waitTurn = createRateLimiter(PER_WORKER_RPS);
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  const totalItems = items.length;
  /** @type {Array<{ Codigo: string, Descripcion: string, sku: string, precio: string, total: number, status: "ACTIVE" | "ARCHIVED" }>} */
  const notFound = [];

  const emitProgress = (currentSku) => {
    if (!parentPort) return;
    const pct = totalItems === 0 ? 100 : (processed / totalItems) * 100;
    parentPort.postMessage({
      type: "progress",
      workerId,
      currentSku,
      processed,
      total: totalItems,
      percent: pct,
      ok,
      skipped,
      failed,
      notFound: notFound.length,
    });
  };

  const emitItemLog = (payload) => {
    if (!parentPort) return;
    parentPort.postMessage({
      type: "item_log",
      workerId,
      ...payload,
    });
  };

  for (const [sku, row] of items) {
    const total = toNumber(row?.total);
    const price = toPriceString(row?.Precio1);
    const status = "ACTIVE";
    const descripcion = String(row?.Descripcion ?? row?.descripcion ?? "").trim();

    if (total == null) {
      skipped += 1;
      emitItemLog({
        action: "SKIP",
        sku,
        reason: "missing/invalid total",
      });
      processed += 1;
      if (processed === 1 || processed % PROGRESS_EVERY === 0 || processed === totalItems) {
        emitProgress(sku);
      }
      continue;
    }

    if (price == null) {
      skipped += 1;
      emitItemLog({
        action: "SKIP",
        sku,
        reason: "missing/invalid Precio1",
        total,
        status,
      });
      processed += 1;
      if (processed === 1 || processed % PROGRESS_EVERY === 0 || processed === totalItems) {
        emitProgress(sku);
      }
      continue;
    }

    try {
      const variant = await getVariantBySku(accessToken, sku, waitTurn);
      if (!variant) {
        notFound.push({
          Codigo: sku,
          Descripcion: descripcion,
          sku,
          precio: price,
          total,
          status,
        });
        skipped += 1;
        emitItemLog({
          action: "SKIP",
          sku,
          reason: "variant not found in Shopify",
          total,
          precio: price,
          status,
        });
      } else {
        const variantId = variant.id;
        const productId = variant.product?.id;
        const inventoryItemId = variant.inventoryItem?.id;
        if (!variantId || !productId || !inventoryItemId) {
          skipped += 1;
          emitItemLog({
            action: "SKIP",
            sku,
            reason: "missing Shopify IDs",
            total,
            precio: price,
            status,
          });
        } else {
          const qty = Math.trunc(total);
          await setInventoryQuantity(accessToken, inventoryItemId, qty, waitTurn);
          await updateVariantPrice(accessToken, productId, variantId, price, waitTurn);
          await updateProductStatus(accessToken, productId, waitTurn);
          ok += 1;
          emitItemLog({
            action: "OK",
            sku,
            qty,
            precio: price,
            status,
          });
        }
      }
    } catch (err) {
      failed += 1;
      if (parentPort) {
        parentPort.postMessage({
          type: "item_error",
          workerId,
          sku,
          error: err?.message || String(err),
        });
      }
    }

    processed += 1;
    if (processed === 1 || processed % PROGRESS_EVERY === 0 || processed === totalItems) {
      emitProgress(sku);
    }
  }

  return {
    workerId,
    total: totalItems,
    processed,
    ok,
    skipped,
    failed,
    notFound,
  };
}

if (!isMainThread) {
  runWorker(workerData.items, workerData.workerId)
    .then((result) => {
      parentPort.postMessage({ type: "done", ok: true, result });
    })
    .catch((err) => {
      parentPort.postMessage({
        type: "done",
        ok: false,
        workerId: workerData.workerId,
        error: err?.message || String(err),
      });
    });
} else {
  async function main() {
    const startedAt = new Date();
    const startedMs = Date.now();
    console.log(`Run started at: ${startedAt.toISOString()}`);

    if (!STORE_DOMAIN) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
    if (!CLIENT_ID) throw new Error("Missing SHOPIFY_CLIENT_ID");
    if (!CLIENT_SECRET) throw new Error("Missing SHOPIFY_CLIENT_SECRET");
    if (!LOCATION_ID) throw new Error("Missing SHOPIFY_LOCATION_ID");

    const inventory = loadInventoryMap();
    const entries = Object.entries(inventory);
    const chunks = splitIntoChunks(entries, WORKERS_COUNT);

    console.log(`Loaded ${entries.length} SKUs from inventory.json`);
    console.log(`Starting ${WORKERS_COUNT} workers (progress every ${PROGRESS_EVERY} items)...`);
    console.log(
      `Rate limit config: globalRPS=${SHOPIFY_GLOBAL_RPS}, perWorkerRPS=${PER_WORKER_RPS}, approxTotalRPS=${PER_WORKER_RPS * WORKERS_COUNT}`,
    );
    chunks.forEach((chunk, i) => {
      console.log(`[Plan] Worker ${i + 1}: ${chunk.length} SKUs assigned`);
    });

    const progressByWorker = {};
    const printGlobalProgress = () => {
      const processed = Object.values(progressByWorker).reduce(
        (acc, p) => acc + (p.processed || 0),
        0,
      );
      const total = Object.values(progressByWorker).reduce(
        (acc, p) => acc + (p.total || 0),
        0,
      );
      const ok = Object.values(progressByWorker).reduce((acc, p) => acc + (p.ok || 0), 0);
      const skipped = Object.values(progressByWorker).reduce(
        (acc, p) => acc + (p.skipped || 0),
        0,
      );
      const failed = Object.values(progressByWorker).reduce(
        (acc, p) => acc + (p.failed || 0),
        0,
      );
      const pct = total === 0 ? 100 : ((processed / total) * 100).toFixed(2);
      const pending = Math.max(0, total - processed);
      console.log(
        `[Global] ${processed}/${total} (${pct}%) | ok=${ok} skipped=${skipped} failed=${failed} | pending=${pending}`,
      );
    };

    const workerPromises = chunks.map(
      (chunk, i) =>
        new Promise((resolve, reject) => {
          const workerId = i + 1;
          const w = new Worker(__filename, {
            workerData: { workerId, items: chunk },
          });

          w.on("message", (msg) => {
            if (msg?.type === "progress") {
              progressByWorker[msg.workerId] = {
                processed: msg.processed,
                total: msg.total,
                ok: msg.ok,
                skipped: msg.skipped,
                failed: msg.failed,
              };
              const pct = Number(msg.percent || 0).toFixed(2);
              console.log(
                `[Worker ${msg.workerId}] ${msg.processed}/${msg.total} (${pct}%) sku=${msg.currentSku} | ok=${msg.ok} skipped=${msg.skipped} failed=${msg.failed} notFound=${msg.notFound}`,
              );
              printGlobalProgress();
              return;
            }

            if (msg?.type === "item_error") {
              console.log(`[Worker ${msg.workerId}] [ERR] ${msg.sku}: ${msg.error}`);
              return;
            }

            if (msg?.type === "item_log") {
              if (msg.action === "OK") {
                console.log(
                  `[Worker ${msg.workerId}] [OK] sku=${msg.sku} -> qty=${msg.qty}, precio=${msg.precio}, status=${msg.status}`,
                );
              } else {
                const extra = [
                  msg.total != null ? `total=${msg.total}` : "",
                  msg.precio != null ? `precio=${msg.precio}` : "",
                  msg.status ? `status=${msg.status}` : "",
                ]
                  .filter(Boolean)
                  .join(", ");
                console.log(
                  `[Worker ${msg.workerId}] [SKIP] sku=${msg.sku} -> ${msg.reason}${extra ? ` (${extra})` : ""}`,
                );
              }
              return;
            }

            if (msg?.type === "done" && msg.ok) {
              const r = msg.result;
              console.log(
                `[Worker ${r.workerId}] DONE processed=${r.processed}/${r.total} ok=${r.ok} skipped=${r.skipped} failed=${r.failed} notFound=${r.notFound.length}`,
              );
              resolve(r);
              return;
            }

            if (msg?.type === "done" && !msg.ok) {
              reject(new Error(`Worker ${msg.workerId} failed: ${msg.error}`));
            }
          });

          w.on("error", reject);
          w.on("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`Worker ${workerId} exited with code ${code}`));
            }
          });
        }),
    );

    const results = await Promise.all(workerPromises);

    const final = results.reduce(
      (acc, r) => {
        acc.total += r.total;
        acc.processed += r.processed;
        acc.ok += r.ok;
        acc.skipped += r.skipped;
        acc.failed += r.failed;
        acc.notFound.push(...r.notFound);
        return acc;
      },
      { total: 0, processed: 0, ok: 0, skipped: 0, failed: 0, notFound: [] },
    );

    fs.writeFileSync(NOT_FOUND_PATH, JSON.stringify(final.notFound, null, 2), "utf8");
    console.log(
      `Saved ${final.notFound.length} SKUs not found in Shopify to ${NOT_FOUND_PATH}`,
    );
    console.log(
      `Done. processed=${final.processed}/${final.total} ok=${final.ok} skipped=${final.skipped} failed=${final.failed}`,
    );
    const endedAt = new Date();
    const elapsedMs = Date.now() - startedMs;
    console.log(`Run finished at: ${endedAt.toISOString()}`);
    console.log(
      `Elapsed time: ${formatDuration(elapsedMs)} (${elapsedMs} ms)`,
    );
    if (final.failed > 0) process.exitCode = 1;
  }

  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
