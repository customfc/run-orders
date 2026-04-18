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
