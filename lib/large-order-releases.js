/**
 * Large-order releases — the "review and release" half of the large-order gate.
 *
 * The stage phase (scripts/shipstation/run-orders.js) holds any order over the
 * LARGE_ORDER_* thresholds and pages Mac by URGENT email that says "review and
 * release it from the dashboard". Until 2026-09-09 nothing implemented the
 * release: the gate re-held the order on every pass, so a $4,753 DITRA order to
 * Golden BC could only ship by hand. This store is the switch.
 *
 * An entry means "a human looked at this order and said ship it". Optional
 * `warehouseCode` pins the Prosol branch (e.g. WCAS) instead of letting the
 * nearest-branch rule pick — used when the nearest branch covers the quantity
 * with no real depth and a deeper hub sits at the same distance.
 *
 * Entries expire after RELEASE_TTL_DAYS so a stale approval never ships a
 * re-ordered or re-imported order weeks later.
 *
 * Surfaces: Telegram `/release <orderNumber> [WH_CODE]`, HTTP POST /api/orders/release.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.LARGE_ORDER_RELEASES_FILE || path.join(__dirname, '..', 'data', 'large-order-releases.json');
const RELEASE_TTL_DAYS = Number(process.env.LARGE_ORDER_RELEASE_TTL_DAYS || 14);

const norm = (orderNumber) => String(orderNumber || '').trim().replace(/^#/, '');

function load() {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { map = {}; }
  // prune expired approvals
  const cutoff = Date.now() - RELEASE_TTL_DAYS * 86400000;
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    const at = Date.parse(v && v.at);
    if (!Number.isFinite(at) || at < cutoff) { delete map[k]; changed = true; }
  }
  if (changed) save(map);
  return map;
}

function save(map) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
}

/** Approve a held order. Returns the stored entry. */
function release(orderNumber, { by = 'unknown', warehouseCode = null, note = null } = {}) {
  const key = norm(orderNumber);
  if (!key) throw new Error('orderNumber required');
  const map = load();
  map[key] = {
    orderNumber: key,
    at: new Date().toISOString(),
    by,
    warehouseCode: warehouseCode ? String(warehouseCode).trim().toUpperCase() : null,
    note: note || null,
  };
  save(map);
  return map[key];
}

function get(orderNumber) { return load()[norm(orderNumber)] || null; }
function isReleased(orderNumber) { return !!get(orderNumber); }
function pinnedWarehouse(orderNumber) { const e = get(orderNumber); return e && e.warehouseCode ? e.warehouseCode : null; }
function remove(orderNumber) {
  const map = load();
  const key = norm(orderNumber);
  if (!map[key]) return false;
  delete map[key];
  save(map);
  return true;
}
function list() { return Object.values(load()).sort((a, b) => String(b.at).localeCompare(String(a.at))); }

module.exports = { release, get, isReleased, pinnedWarehouse, remove, list, RELEASE_TTL_DAYS, FILE };
