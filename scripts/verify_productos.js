#!/usr/bin/env node

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const INVENTORY_PATH = path.resolve(process.cwd(), "inventory.json");
const OUT_NAME_MISMATCH_PATH = path.resolve(
  process.cwd(),
  "verify_productos_nombre_diferente.json",
);
const OUT_NOT_FOUND_PATH = path.resolve(
  process.cwd(),
  "verify_productos_no_existe.json",
);

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-01";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";

function normalizeText(v) {
  return String(v ?? "").trim();
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

async function graphqlRequest(accessToken, query, variables) {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
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
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data?.data || {};
}

async function getVariantBySku(accessToken, sku) {
  const query = `
    query VariantBySku($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            id
            sku
            product { id title }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(accessToken, query, { q: `sku:${sku}` });
  return data?.productVariants?.edges?.[0]?.node || null;
}

function loadInventoryItems() {
  if (!fs.existsSync(INVENTORY_PATH)) {
    throw new Error(`inventory.json not found: ${INVENTORY_PATH}`);
  }
  const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("inventory.json must be an object keyed by SKU");
  }
  return Object.entries(parsed).map(([sku, row]) => ({
    sku: normalizeText(sku),
    descripcion: normalizeText(row?.Descripcion ?? row?.descripcion ?? ""),
  }));
}

function splitIntoChunks(arr, chunksCount) {
  const chunks = Array.from({ length: chunksCount }, () => []);
  arr.forEach((item, idx) => {
    chunks[idx % chunksCount].push(item);
  });
  return chunks;
}

async function runWorker(items, workerId) {
  const accessToken = await getAccessToken();
  const nameMismatches = [];
  const notFound = [];
  const total = items.length;
  let processed = 0;

  const emitProgress = (currentSku) => {
    if (!parentPort) return;
    const percent = total === 0 ? 100 : (processed / total) * 100;
    parentPort.postMessage({
      type: "progress",
      workerId,
      processed,
      total,
      percent,
      currentSku,
      mismatches: nameMismatches.length,
      notFound: notFound.length,
    });
  };

  for (const item of items) {
    const sku = item.sku;
    const expectedName = item.descripcion;
    if (!sku) continue;
    try {
      const variant = await getVariantBySku(accessToken, sku);
      if (!variant) {
        notFound.push({
          sku,
          descripcion_inventory: expectedName,
        });
        continue;
      }

      const shopifyTitle = normalizeText(variant?.product?.title);
      if (shopifyTitle !== expectedName) {
        nameMismatches.push({
          sku,
          descripcion_inventory: expectedName,
          descripcion_shopify: shopifyTitle,
          productId: variant?.product?.id || null,
          variantId: variant?.id || null,
        });
      }
    } catch (err) {
      // Errores de red/API se tratan como no encontrado para el reporte de verificación.
      notFound.push({
        sku,
        descripcion_inventory: expectedName,
        error: err?.message || String(err),
      });
    }

    processed += 1;
    // Log granular: al inicio, cada 25 items y al finalizar.
    if (processed === 1 || processed % 25 === 0 || processed === total) {
      emitProgress(sku);
    }
  }

  return {
    workerId,
    processed: items.length,
    nameMismatches,
    notFound,
  };
}

if (!isMainThread) {
  runWorker(workerData.items, workerData.workerId)
    .then((result) => parentPort.postMessage({ type: "done", ok: true, result }))
    .catch((err) =>
      parentPort.postMessage({
        type: "done",
        ok: false,
        error: err?.message || String(err),
        workerId: workerData.workerId,
      }),
    );
} else {
  async function main() {
    if (!STORE_DOMAIN) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
    if (!CLIENT_ID) throw new Error("Missing SHOPIFY_CLIENT_ID");
    if (!CLIENT_SECRET) throw new Error("Missing SHOPIFY_CLIENT_SECRET");

    const items = loadInventoryItems();
    const workersCount = 5;
    const chunks = splitIntoChunks(items, workersCount);

    console.log(`Loaded ${items.length} SKUs from inventory.json`);
    console.log(`Starting ${workersCount} workers...`);
    chunks.forEach((c, i) => {
      console.log(`[Plan] Worker ${i + 1}: ${c.length} SKUs assigned`);
    });

    const globalProgress = {};
    const printGlobalProgress = () => {
      const processed = Object.values(globalProgress).reduce(
        (acc, p) => acc + (p.processed || 0),
        0,
      );
      const total = Object.values(globalProgress).reduce(
        (acc, p) => acc + (p.total || 0),
        0,
      );
      const pct = total === 0 ? 100 : ((processed / total) * 100).toFixed(2);
      const left = Math.max(0, total - processed);
      console.log(`[Global] ${processed}/${total} (${pct}%) done | ${left} pending`);
    };

    const promises = chunks.map(
      (chunk, i) =>
        new Promise((resolve, reject) => {
          const w = new Worker(__filename, {
            workerData: {
              workerId: i + 1,
              items: chunk,
            },
          });

          w.on("message", (msg) => {
            if (msg?.type === "progress") {
              globalProgress[msg.workerId] = {
                processed: msg.processed,
                total: msg.total,
              };
              const pct = Number(msg.percent || 0).toFixed(2);
              console.log(
                `[Worker ${msg.workerId}] ${msg.processed}/${msg.total} (${pct}%) | sku=${msg.currentSku} | mismatches=${msg.mismatches} | notFound=${msg.notFound}`,
              );
              printGlobalProgress();
              return;
            }

            if (msg?.ok) {
              console.log(
                `[Worker ${msg.result.workerId}] processed=${msg.result.processed} mismatches=${msg.result.nameMismatches.length} notFound=${msg.result.notFound.length}`,
              );
              resolve(msg.result);
            } else {
              reject(
                new Error(
                  `Worker ${msg?.workerId ?? i + 1} failed: ${msg?.error || "unknown error"}`,
                ),
              );
            }
          });
          w.on("error", reject);
          w.on("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`Worker ${i + 1} exited with code ${code}`));
            }
          });
        }),
    );

    const results = await Promise.all(promises);
    const allMismatches = results.flatMap((r) => r.nameMismatches);
    const allNotFound = results.flatMap((r) => r.notFound);

    fs.writeFileSync(
      OUT_NAME_MISMATCH_PATH,
      JSON.stringify(allMismatches, null, 2),
      "utf8",
    );
    fs.writeFileSync(OUT_NOT_FOUND_PATH, JSON.stringify(allNotFound, null, 2), "utf8");

    console.log(`Saved mismatches -> ${OUT_NAME_MISMATCH_PATH}`);
    console.log(`Saved not found -> ${OUT_NOT_FOUND_PATH}`);
    console.log(
      `Done. mismatches=${allMismatches.length} notFound=${allNotFound.length}`,
    );
  }

  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
