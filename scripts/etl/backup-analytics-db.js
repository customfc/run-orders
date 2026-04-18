#!/usr/bin/env node
/**
 * Daily backup of data/analytics.sqlite.
 *
 * Uses SQLite's online backup API (better-sqlite3 `db.backup(dest)`) so
 * the copy is consistent even while WAL writes are in flight — safer
 * than a raw file copy.
 *
 * Output: data/analytics-backup/YYYY-MM-DD.sqlite
 * Retention: last 30 files (rolling)
 *
 * For off-site durability, rclone or Tailscale Drive can sync
 * data/analytics-backup/ on a separate cadence.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { open, close, DB_PATH } = require('../../lib/analytics-db');

const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'analytics-backup');
const RETAIN_DAYS = 30;

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(BACKUP_DIR, `${today}.sqlite`);

  const db = open();
  console.log(`[analytics-backup] ${DB_PATH} → ${dest}`);
  await db.backup(dest);
  const stat = fs.statSync(dest);
  console.log(`[analytics-backup] ✓ ${(stat.size / 1024).toFixed(1)}KB`);

  // Prune old backups — keep most recent RETAIN_DAYS files
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort();
  const toDelete = files.slice(0, Math.max(0, files.length - RETAIN_DAYS));
  for (const f of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[analytics-backup] pruned old backup ${f}`);
  }
  close();
}

if (require.main === module) {
  main().catch((e) => { console.error('[analytics-backup] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
