/**
 * Prosol stock cache + sourcing decisions for FBA replenishment POs.
 *
 * Snapshots live at data/fba/snapshots/prosol-stock-YYYY-MM-DD.json.
 * Shape:
 *   {
 *     pulledAt: "2026-04-17T...",
 *     primaryLocationId: 10054,
 *     skus: {
 *       [prosolSku]: {
 *         productId, fetchedAt,
 *         locations: [{locationId, code, city, qty, available}],
 *         totalAvailable, atPrimary, atOthers
 *       }
 *     }
 *   }
 *
 * Sourcing rules (see project_fba_prosol_sourcing memory):
 *   primary>=rec           → action=full,      suggestedQty=rec
 *   primary<rec, total>=rec → action=backorder, suggestedQty=rec
 *   total<rec, total>0     → action=capped,    suggestedQty=total
 *   total=0                → action=oos,       suggestedQty=0
 */

const fs = require('fs');
const path = require('path');

const SNAP_DIR = path.join(__dirname, '..', 'data', 'fba', 'snapshots');
const PRIMARY_LOCATION_ID = 10054;              // WCAS (Calgary)
const PRIMARY_LOCATION_CODE = 'WCAS';

function latestSnapshotPath() {
  if (!fs.existsSync(SNAP_DIR)) return null;
  const files = fs.readdirSync(SNAP_DIR)
    .filter((f) => f.startsWith('prosol-stock-') && f.endsWith('.json'))
    .sort();
  return files.length ? path.join(SNAP_DIR, files[files.length - 1]) : null;
}

let _cache = null;
function loadLatest() {
  const p = latestSnapshotPath();
  if (!p) return null;
  if (_cache && _cache._path === p && _cache._mtime === fs.statSync(p).mtimeMs) return _cache;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data._path = p;
  data._mtime = fs.statSync(p).mtimeMs;
  _cache = data;
  return data;
}

function invalidate() { _cache = null; }

/**
 * Lookup stock for a Prosol SKU. Returns null if snapshot missing or SKU not present.
 */
function lookup(prosolSku) {
  if (!prosolSku) return null;
  const snap = loadLatest();
  if (!snap) return null;
  return snap.skus[prosolSku] || null;
}

/**
 * Find the single non-primary warehouse with the most available stock.
 * Returned when it alone can fulfill an order the primary can't — so the
 * user can choose to ship from that warehouse instead of WCAS+backorder.
 *
 * Caveat: non-WCAS warehouses currently have minimum-stock reservations
 * that may block using them as the FBA source. Surfaced as info only,
 * never auto-selected.
 */
function bestAltWarehouse(stock) {
  if (!stock || !Array.isArray(stock.locations)) return null;
  let best = null;
  for (const loc of stock.locations) {
    if (loc.locationId === PRIMARY_LOCATION_ID) continue;
    const avail = Number(loc.available) || 0;
    if (avail <= 0) continue;
    if (!best || avail > best.available) best = { locationId: loc.locationId, code: loc.code, city: loc.city, available: avail };
  }
  return best;
}

/**
 * Compute sourcing decision given requested qty + stock entry.
 */
function decide(stock, requestedQty) {
  const rec = Number(requestedQty) || 0;
  if (!stock) {
    return { action: 'unknown', suggestedQty: rec, reason: 'No Prosol stock data — pull a snapshot' };
  }
  const primary = Number(stock.atPrimary) || 0;
  const total = Number(stock.totalAvailable) || 0;
  const alt = bestAltWarehouse(stock);
  const altCanFulfill = alt && alt.available >= rec;

  if (total === 0) return { action: 'oos', suggestedQty: 0, atPrimary: primary, atOthers: total - primary, total, reason: 'Prosol is out of stock across all warehouses' };
  if (primary >= rec) return { action: 'full', suggestedQty: rec, atPrimary: primary, atOthers: total - primary, total, reason: `WCAS has ${primary} — fills order` };

  const atOthers = total - primary;
  if (total >= rec) {
    const base = {
      action: 'backorder',
      suggestedQty: rec,
      atPrimary: primary,
      atOthers,
      total,
      reason: `WCAS has ${primary} of ${rec}; backorder ${rec - primary} from other PS warehouses (~1wk)`,
    };
    if (altCanFulfill) {
      base.altSource = alt;
      base.altSourceNote = `Alt: ${alt.code || 'location ' + alt.locationId}${alt.city ? ' (' + alt.city + ')' : ''} has ${alt.available} — could ship all ${rec} from there instead (requires MOQ adjustment with Prosol).`;
    }
    return base;
  }
  return { action: 'capped', suggestedQty: total, atPrimary: primary, atOthers, total, reason: `Prosol total is only ${total}; capping order from ${rec} to ${total}` };
}

/**
 * One-shot: given prosolSku + rec, return decision with full stock context.
 */
function resolve(prosolSku, requestedQty) {
  const stock = lookup(prosolSku);
  const decision = decide(stock, requestedQty);
  return {
    prosolSku,
    stock: stock ? {
      totalAvailable: stock.totalAvailable,
      atPrimary: stock.atPrimary,
      atOthers: stock.atOthers,
      locations: stock.locations,
      fetchedAt: stock.fetchedAt,
    } : null,
    decision,
  };
}

module.exports = {
  PRIMARY_LOCATION_ID,
  PRIMARY_LOCATION_CODE,
  latestSnapshotPath,
  loadLatest,
  invalidate,
  lookup,
  decide,
  resolve,
};
