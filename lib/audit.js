/**
 * Audit logger — append-only JSONL file.
 * Every action (run-orders, pickup, shopify-so-po) gets a line.
 */

const fs = require('fs');
const path = require('path');

const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit.jsonl');

function ensureDir() {
  const dir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(entry) {
  ensureDir();
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  return record;
}

function readRecent(limit = 100) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map(line => {
    try { return JSON.parse(line); }
    catch { return { raw: line, parseError: true }; }
  });
}

module.exports = { log, readRecent };
