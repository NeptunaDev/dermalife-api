const { getDb } = require('./orderPersistenceService');

const OBTEINENDO_TOKEN_VALUE = 'OBTENIENDO';
const STALE_LOCK_SECONDS = 30;

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS hgi_token (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT,
      obtenido_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Garantiza que existe exactamente una fila (id=1)
    INSERT OR IGNORE INTO hgi_token (id, token) VALUES (1, '');
  `);
}

function getToken() {
  initSchema();
  const row = getDb().prepare('SELECT token FROM hgi_token WHERE id = 1').get();
  return row?.token ?? '';
}

function setToken(token) {
  initSchema();
  const t = typeof token === 'string' ? token : String(token ?? '');
  getDb()
    .prepare(
      `
        UPDATE hgi_token
        SET token = ?,
            obtenido_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = 1
      `,
    )
    .run(t);
}

// Intenta adquirir el lock a nivel DB cambiando el token a OBTENIENDO.
// Retorna true si ganaste la carrera.
function tryAcquireObtainingLock() {
  initSchema();
  const { changes } = getDb()
    .prepare(
      `
        UPDATE hgi_token
        SET token = ?,
            obtenido_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = 1
          AND (
            COALESCE(token,'') != ?
            OR (token = ? AND updated_at <= datetime('now', ?))
          )
      `,
    )
    .run(OBTEINENDO_TOKEN_VALUE, OBTEINENDO_TOKEN_VALUE, OBTEINENDO_TOKEN_VALUE, `-${STALE_LOCK_SECONDS} seconds`);
  return changes === 1;
}

module.exports = {
  OBTEINENDO_TOKEN_VALUE,
  STALE_LOCK_SECONDS,
  getToken,
  setToken,
  tryAcquireObtainingLock,
};

