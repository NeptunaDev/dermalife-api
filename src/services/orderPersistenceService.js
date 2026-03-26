const path = require("path");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const DB_PATH = path.resolve(__dirname, "../../data/orders.db");

let db;

function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  // Asegura comportamiento más seguro y concurrente para escrituras.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema();
  return db;
}

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid                 TEXT    NOT NULL UNIQUE,

      order_number         TEXT    NOT NULL UNIQUE,
      payload              TEXT    NOT NULL,

      numero_doc           TEXT,

      estado               TEXT    NOT NULL DEFAULT 'pendiente',

      ultimo_error         TEXT,
      ultimo_stack         TEXT,
      ultimo_paso_fallido  TEXT,
      intentos             INTEGER NOT NULL DEFAULT 0,

      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_estado ON orders(estado);
    CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
  `);

  migrateShopifyOrderIdColumn();
}

function migrateShopifyOrderIdColumn() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(orders)").all();
  const hasShopify = cols.some((c) => c.name === "shopify_order_id");
  if (!hasShopify) {
    db.exec(`ALTER TABLE orders ADD COLUMN shopify_order_id TEXT;`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shopify_order_id ON orders(shopify_order_id) WHERE shopify_order_id IS NOT NULL;`,
    );
  }
}

function upsertOrderPending(orderNumber, rawPayload) {
  const db = getDb();

  const existing = db
    .prepare(
      "SELECT uuid, estado, numero_doc FROM orders WHERE order_number = ?",
    )
    .get(orderNumber);

  if (existing) {
    return {
      uuid: existing.uuid,
      estado: existing.estado,
      numero_doc: existing.numero_doc,
      createdNew: false,
    };
  }

  const uuid = randomUUID();
  db.prepare(
    `
    INSERT INTO orders (uuid, order_number, payload)
    VALUES (?, ?, ?)
  `,
  ).run(
    uuid,
    orderNumber,
    typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload),
  );

  return {
    uuid,
    estado: "pendiente",
    numero_doc: null,
    createdNew: true,
  };
}

/**
 * Evita doble facturación: solo un proceso puede pasar a `procesando` por orden de Shopify.
 * Usa transacción + shopify_order_id (id global de la orden).
 *
 * @returns {{ action: 'process', uuid } | { action: 'skip_done', uuid, numero_doc } | { action: 'skip_inflight', uuid }}
 */
function beginOrderProcessingOrSkip({
  shopifyOrderId,
  orderNumberDisplay,
  rawPayload,
}) {
  const db = getDb();
  const payloadStr =
    typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);

  return db.transaction(() => {
    let row = db
      .prepare(
        "SELECT uuid, estado, numero_doc FROM orders WHERE shopify_order_id = ?",
      )
      .get(shopifyOrderId);

    if (!row) {
      row = db
        .prepare(
          "SELECT uuid, estado, numero_doc FROM orders WHERE order_number = ?",
        )
        .get(orderNumberDisplay);
      if (row) {
        db.prepare(
          "UPDATE orders SET shopify_order_id = ? WHERE uuid = ? AND (shopify_order_id IS NULL OR shopify_order_id = '')",
        ).run(shopifyOrderId, row.uuid);
      }
    }

    if (row) {
      if (row.estado === "creado") {
        return {
          action: "skip_done",
          uuid: row.uuid,
          numero_doc: row.numero_doc,
        };
      }
      if (row.estado === "procesando") {
        return { action: "skip_inflight", uuid: row.uuid };
      }
      if (row.estado === "pendiente") {
        const r = db
          .prepare(
            `UPDATE orders SET estado = 'procesando', updated_at = datetime('now')
             WHERE uuid = ? AND estado = 'pendiente'`,
          )
          .run(row.uuid);
        if (r.changes === 1) {
          return { action: "process", uuid: row.uuid };
        }
        const re = db
          .prepare("SELECT estado, numero_doc FROM orders WHERE uuid = ?")
          .get(row.uuid);
        if (re.estado === "procesando") {
          return { action: "skip_inflight", uuid: row.uuid };
        }
        if (re.estado === "creado") {
          return {
            action: "skip_done",
            uuid: row.uuid,
            numero_doc: re.numero_doc,
          };
        }
      }
      return { action: "skip_inflight", uuid: row.uuid };
    }

    const uuid = randomUUID();
    try {
      db.prepare(
        `INSERT INTO orders (uuid, order_number, shopify_order_id, payload, estado)
         VALUES (?, ?, ?, ?, 'procesando')`,
      ).run(uuid, orderNumberDisplay, shopifyOrderId, payloadStr);
      return { action: "process", uuid };
    } catch (e) {
      if (e.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
      const again = db
        .prepare(
          "SELECT uuid, estado, numero_doc FROM orders WHERE shopify_order_id = ?",
        )
        .get(shopifyOrderId);
      if (!again) throw e;
      if (again.estado === "creado") {
        return {
          action: "skip_done",
          uuid: again.uuid,
          numero_doc: again.numero_doc,
        };
      }
      if (again.estado === "procesando") {
        return { action: "skip_inflight", uuid: again.uuid };
      }
      const r = db
        .prepare(
          `UPDATE orders SET estado = 'procesando', updated_at = datetime('now')
           WHERE uuid = ? AND estado = 'pendiente'`,
        )
        .run(again.uuid);
      if (r.changes === 1) return { action: "process", uuid: again.uuid };
      return { action: "skip_inflight", uuid: again.uuid };
    }
  })();
}

/** Libera el lock si falló HGI antes de marcar creado (permite reintento de Shopify). */
function releaseProcessingLock(uuid) {
  getDb()
    .prepare(
      `UPDATE orders SET estado = 'pendiente', updated_at = datetime('now')
       WHERE uuid = ? AND estado = 'procesando'`,
    )
    .run(uuid);
}

function markOrderCreated(uuid, numeroDoc) {
  getDb()
    .prepare(
      `
    UPDATE orders
    SET estado      = 'creado',
        numero_doc  = ?,
        ultimo_error        = NULL,
        ultimo_stack        = NULL,
        ultimo_paso_fallido = NULL,
        updated_at           = datetime('now')
    WHERE uuid = ?
  `,
    )
    .run(numeroDoc ?? null, uuid);
}

function recordOrderFailure(uuid, { paso, error }) {
  getDb()
    .prepare(
      `
    UPDATE orders
    SET intentos             = intentos + 1,
        ultimo_error         = ?,
        ultimo_stack         = ?,
        ultimo_paso_fallido  = ?,
        updated_at           = datetime('now')
    WHERE uuid = ?
  `,
    )
    .run(
      error?.message ?? String(error),
      error?.stack ?? null,
      paso ?? null,
      uuid,
    );
}

function getOrders({ estado } = {}) {
  const db = getDb();
  if (estado && String(estado).trim() !== "") {
    return db
      .prepare("SELECT * FROM orders WHERE estado = ? ORDER BY updated_at DESC")
      .all(String(estado));
  }

  return db.prepare("SELECT * FROM orders ORDER BY updated_at DESC").all();
}

module.exports = {
  getDb,
  upsertOrderPending,
  beginOrderProcessingOrSkip,
  releaseProcessingLock,
  markOrderCreated,
  recordOrderFailure,
  getOrders,
};
