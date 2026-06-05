/**
 * Held re-buys — durable store for orders the buy phase refused to auto-rebuy.
 *
 * Why this exists: when a shipped label is voided (e.g. the assigned warehouse
 * couldn't fulfill and a stuck reship was cleaned up), ShipStation reverts the
 * order to awaiting-shipment. The per-day buy dedup doesn't remember it ever
 * shipped, so the cron silently buys ANOTHER label at whatever warehouse has
 * stock now — duplicate spend + a second warehouse told to ship the same goods.
 * (Mary Kraftscik RESHIP-701-3527286-9081005: Surrey voided 06-03 → auto-rebought
 * Kelowna 06-04, $48.72 across two depots.)
 *
 * Policy (user choice 2026-06-05): NEVER auto-rebuy after a void. Hold the order
 * here, alert once, and require a one-tap `/buy <orderId>` to ship it.
 *
 * This MUST be durable + queryable (not a one-shot Telegram alert) — a missed
 * alert would silently strand the order, the exact failure mode that hid the
 * stale-shipment backlog. The 15:00 digest and `/held` surface it every day.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'held-rebuys.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function save(map) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
}

// Add a held order. Returns true if this is a NEW hold (so the caller alerts
// once), false if it was already held (stay silent — the digest re-surfaces it).
function add(entry) {
  const map = load();
  const key = String(entry.orderId);
  if (map[key]) return false;
  map[key] = { ...entry, heldAt: entry.heldAt || new Date().toISOString() };
  save(map);
  return true;
}

function remove(orderId) {
  const map = load();
  const key = String(orderId);
  if (!map[key]) return false;
  delete map[key];
  save(map);
  return true;
}

function get(orderId) { return load()[String(orderId)] || null; }

function list() { return Object.values(load()); }

module.exports = { load, save, add, remove, get, list, FILE };
