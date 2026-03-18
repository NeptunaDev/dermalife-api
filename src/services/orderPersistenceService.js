const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const DB_PATH = path.resolve(__dirname, '../../data/orders.db');

let db;

function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  // Asegura comportamiento más seguro y concurrente para escrituras.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
}

function upsertOrderPending(orderNumber, rawPayload) {
  const db = getDb();

  const existing = db
    .prepare('SELECT uuid, estado, numero_doc FROM orders WHERE order_number = ?')
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
  db.prepare(`
    INSERT INTO orders (uuid, order_number, payload)
    VALUES (?, ?, ?)
  `).run(uuid, orderNumber, typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload));

  return {
    uuid,
    estado: 'pendiente',
    numero_doc: null,
    createdNew: true,
  };
}

function markOrderCreated(uuid, numeroDoc) {
  getDb().prepare(`
    UPDATE orders
    SET estado      = 'creado',
        numero_doc  = ?,
        ultimo_error        = NULL,
        ultimo_stack        = NULL,
        ultimo_paso_fallido = NULL,
        updated_at           = datetime('now')
    WHERE uuid = ?
  `).run(numeroDoc ?? null, uuid);
}

function recordOrderFailure(uuid, { paso, error }) {
  getDb().prepare(`
    UPDATE orders
    SET intentos             = intentos + 1,
        ultimo_error         = ?,
        ultimo_stack         = ?,
        ultimo_paso_fallido  = ?,
        updated_at           = datetime('now')
    WHERE uuid = ?
  `).run(
    error?.message ?? String(error),
    error?.stack ?? null,
    paso ?? null,
    uuid,
  );
}

function getOrders({ estado } = {}) {
  const db = getDb();
  if (estado && String(estado).trim() !== '') {
    return db
      .prepare('SELECT * FROM orders WHERE estado = ? ORDER BY updated_at DESC')
      .all(String(estado));
  }

  return db
    .prepare('SELECT * FROM orders ORDER BY updated_at DESC')
    .all();
}

module.exports = {
  getDb,
  upsertOrderPending,
  markOrderCreated,
  recordOrderFailure,
  getOrders,
};

