const path = require("path");
const { spawn } = require("child_process");
const logger = require("./logger");
const inventoryBuildService = require("./inventoryBuildService");

const ROOT = path.resolve(__dirname, "../..");
const SHOPIFY_SYNC_SCRIPT = path.resolve(ROOT, "scripts/inventory_shopify.js");

let timer = null;
let running = false;

function msUntilNextHalfHour(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  if (next.getMinutes() < 30) {
    next.setMinutes(30);
  } else {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  }
  return Math.max(0, next.getTime() - now.getTime());
}

function runShopifySyncScript() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHOPIFY_SYNC_SCRIPT], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        logger.stepInfo(`[cron/shopify] ${line}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        logger.stepErr(`[cron/shopify] ${line}`);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`inventory_shopify.js exited with code ${code}`));
    });
  });
}

async function runCycle(sourceLabel = "cron") {
  if (running) {
    logger.stepInfo(`[cron] ciclo omitido (${sourceLabel}): ya hay uno en ejecución`);
    return;
  }
  running = true;
  const started = Date.now();
  logger.stepInfo(`[cron] inicio ciclo (${sourceLabel})`);

  try {
    const result = await inventoryBuildService.buildInventoryFiles();
    logger.stepOk(
      `[cron] inventario actualizado (${result.bytesInventory} bytes en inventory.json)`,
    );

    await runShopifySyncScript();
    logger.stepOk("[cron] sync Shopify completado");
  } catch (err) {
    logger.stepErr(`[cron] error: ${err.message || err}`);
  } finally {
    const elapsed = Date.now() - started;
    logger.stepInfo(`[cron] fin ciclo (${sourceLabel}) en ${elapsed}ms`);
    running = false;
  }
}

function scheduleNext() {
  const waitMs = msUntilNextHalfHour();
  const nextAt = new Date(Date.now() + waitMs).toISOString();
  logger.stepInfo(`[cron] próximo ciclo a las ${nextAt}`);
  timer = setTimeout(async () => {
    await runCycle("scheduled");
    scheduleNext();
  }, waitMs);
}

function startInventoryCron() {
  if (timer) return;
  logger.stepInfo("[cron] scheduler inventory iniciado (:00 y :30)");
  scheduleNext();
}

module.exports = {
  startInventoryCron,
};
