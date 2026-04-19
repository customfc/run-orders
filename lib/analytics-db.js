/**
 * Analytics SQLite connection + migrations.
 *
 * Single DB file at data/analytics.sqlite (mac mini). All writes come from
 * scripts/etl/*.js running as a nightly cron. Reads are served by the
 * dashboard. WAL mode + synchronous=NORMAL gives concurrent read-while-
 * writing without corruption risk for single-writer workloads.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ANALYTICS_DB_PATH
  || path.join(__dirname, '..', 'data', 'analytics.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'analytics-schema.sql');
const VIEWS_PATH = path.join(__dirname, 'analytics-views.sql');

let _db = null;

function open() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  _db = db;
  return db;
}

function migrate(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  // Additive migrations — columns added after initial ship. Each wrapped
  // in try/catch so re-running on a fresh DB (where the column already
  // exists from the schema) is safe.
  const additiveColumns = [
    { table: 'amazon_financial_events', col: 'quantity', type: 'INTEGER' },
    { table: 'sku_map_canonical', col: 'cost_cad', type: 'REAL' },
    { table: 'sku_map_canonical', col: 'cost_source', type: 'TEXT' },
    { table: 'sku_map_canonical', col: 'qty_per_unit', type: 'REAL' },
  ];
  for (const { table, col, type } of additiveColumns) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {} // ignore "duplicate column"
  }
  // Views — DROPped + recreated every open, so schema-file changes take
  // effect without needing explicit migrations.
  if (fs.existsSync(VIEWS_PATH)) {
    const views = fs.readFileSync(VIEWS_PATH, 'utf8');
    try {
      db.exec(views);
    } catch (e) {
      // If a view references a column that doesn't exist (schema drift),
      // log + continue rather than bricking the DB open.
      console.error('[analytics-db] views migration failed:', e.message);
    }
  }
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Sync-state helpers ──────────────────────────────────────────────────────

function getSyncState(source) {
  const db = open();
  return db.prepare('SELECT * FROM etl_sync_state WHERE source = ?').get(source) || null;
}

function setSyncState(source, { cursor, rowsLastRun, status = 'ok', errorMessage = null } = {}) {
  const db = open();
  db.prepare(`
    INSERT INTO etl_sync_state (source, last_sync_at, cursor, rows_last_run, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      last_sync_at = excluded.last_sync_at,
      cursor = excluded.cursor,
      rows_last_run = excluded.rows_last_run,
      status = excluded.status,
      error_message = excluded.error_message
  `).run(source, new Date().toISOString(), cursor || null, rowsLastRun ?? null, status, errorMessage);
}

// ── Transaction helper — auto-rollback on throw ────────────────────────────

function tx(fn) {
  const db = open();
  const run = db.transaction(fn);
  return run();
}

module.exports = {
  open,
  close,
  getSyncState,
  setSyncState,
  tx,
  DB_PATH,
};
