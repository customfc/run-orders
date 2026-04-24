/**
 * FBA signal normalizer.
 *
 * Raw GET_FBA_INVENTORY_PLANNING_DATA columns are verbose, inconsistent
 * (mixed casing, spaces, trailing question marks) and occasionally change.
 * Every consumer — forecaster, optimizer, dashboard, repricer — should
 * read from this normalized shape, not raw Amazon keys.
 */

const fs = require('fs');
const path = require('path');
const { evaluate: evaluateMap } = require('./map-rules');

const SNAP_DIR = path.join(__dirname, '..', 'data', 'fba', 'snapshots');
const SKU_MAP_PATH = path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json');

let _skuMapCache = null;
function loadSkuMap() {
  if (_skuMapCache) return _skuMapCache;
  const raw = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8'));
  _skuMapCache = raw.mappings || raw;
  return _skuMapCache;
}

// ── One-row normalizer ──────────────────────────────────────────────────────

function normalizeRow(raw) {
  const num = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  const units30 = num(raw['units-shipped-t30']);
  const units7 = num(raw['units-shipped-t7']);
  const available = num(raw.available);
  const inbound = num(raw['inbound-quantity']);
  const reserved = num(raw['Total Reserved Quantity']);
  const unfulfillable = num(raw['unfulfillable-quantity']);
  const recShipQty = num(raw['Recommended ship-in quantity']);

  const shipInDate = str(raw['Recommended ship-in date']);
  let daysUntilShip = null;
  if (shipInDate) {
    const d = new Date(shipInDate);
    if (!Number.isNaN(d.getTime())) {
      daysUntilShip = Math.round((d.getTime() - Date.now()) / 86400000);
    }
  }

  const dailyVelocity = units30 / 30;
  const daysOfSupply = num(raw['days-of-supply']);
  const totalDaysOfSupply = num(raw['Total Days of Supply (including units from open shipments)']);
  const historicalDaysOfSupply = num(raw['historical-days-of-supply']);

  return {
    sku: str(raw.sku),
    fnsku: str(raw.fnsku),
    asin: str(raw.asin),
    productName: str(raw['product-name']),
    condition: str(raw.condition),
    marketplace: str(raw.marketplace),
    productGroup: str(raw['product-group']),
    salesRank: num(raw['sales-rank']),

    available,
    inbound,
    inboundWorking: num(raw['inbound-working']),
    inboundShipped: num(raw['inbound-shipped']),
    inboundReceived: num(raw['inbound-received']),
    reserved,
    unfulfillable,
    pendingRemoval: num(raw['pending-removal-quantity']),

    units7, units30,
    units60: num(raw['units-shipped-t60']),
    units90: num(raw['units-shipped-t90']),
    dailyVelocity,
    sellThrough: num(raw['sell-through']),

    daysOfSupply,
    totalDaysOfSupply,
    historicalDaysOfSupply,
    shortTermDaysOfSupply: num(raw['Short term historical days of supply']),
    longTermDaysOfSupply: num(raw['Long term historical days of supply']),

    alert: str(raw.alert),
    recommendedAction: str(raw['recommended-action']),
    recShipQty,
    recShipDate: shipInDate,
    daysUntilShip,
    healthyInventoryLevel: num(raw['healthy-inventory-level']),

    yourPrice: num(raw['your-price']),
    salesPrice: num(raw['sales-price']),
    featuredOfferPrice: num(raw['featuredoffer-price']),
    lowestPrice: num(raw['lowest-price-new-plus-shipping']),
    currency: str(raw.currency),

    storageType: str(raw['storage-type']),
    itemVolume: num(raw['item-volume']),
    storageVolume: num(raw['storage-volume']),
    estimatedStorageCostNextMonth: num(raw['estimated-storage-cost-next-month']),

    ageBuckets: {
      d0_90: num(raw['inv-age-0-to-90-days']),
      d91_180: num(raw['inv-age-91-to-180-days']),
      d181_270: num(raw['inv-age-181-to-270-days']),
      d271_365: num(raw['inv-age-271-to-365-days']),
      d365plus: num(raw['inv-age-365-plus-days']),
    },

    lipcExempt: str(raw['Exempted from Low-Inventory-Level fee?']) === 'Yes',
    lipcAppliedThisWeek: str(raw['Low-Inventory-Level fee applied in current week?']) === 'Yes',

    isSeasonal: str(raw['is-seasonal-in-next-3-months']) === 'Y',
    seasonName: str(raw['season-name']),
    seasonStart: str(raw['season-start-date']),
    seasonEnd: str(raw['season-end-date']),

    raw,
  };
}

// ── Derived buckets ─────────────────────────────────────────────────────────
//
// Urgency tiers — what to surface on the "Today" dashboard.
//
// TIER 1 — Bleeding: zero stock AND selling in last 30d.
// TIER 2 — Amazon recommends action today (CreateShippingPlan + daysUntilShip <= 3).
// TIER 3 — LIPC fee applied this week (we're actively paying penalty).
// TIER 4 — BB losing: we have stock + selling history but a competitor owns Buy Box.
// TIER 5 — Low cover: totalDaysOfSupply < 28 (LIPC risk threshold).
// TIER 6 — Coming up: Amazon ship-in date within next 14 days.

function classify(r) {
  if (r.available === 0 && r.units30 > 0) return 'bleeding';
  if (r.recShipQty > 0 && (r.daysUntilShip !== null && r.daysUntilShip <= 3)) return 'urgent';
  if (r.lipcAppliedThisWeek) return 'lipc-active';
  // Competitor violating MAP on a brand we enforce — high priority because
  // nothing we do on price fixes this. User needs to report them to the brand.
  if (r.mapDecision?.action === 'competitor-below-map') return 'map-violator-detected';
  // We're below MAP (shouldn't happen if we respect our own rules)
  if (r.mapDecision?.action === 'violation-by-us') return 'our-map-violation';
  // BB-losing with a safe match available → actionable
  if (r.bb && r.bb.ourPrice !== null && r.bb.buyBoxIsUs === false && r.bb.buyBoxSellerId && r.available > 0 && r.units30 > 0) {
    return 'bb-losing';
  }
  if (r.totalDaysOfSupply > 0 && r.totalDaysOfSupply < 28 && r.units30 > 0) return 'low-cover';
  if (r.recShipQty > 0 && r.daysUntilShip !== null && r.daysUntilShip <= 14) return 'upcoming';
  if (r.units30 === 0 && r.available > 0) return 'dormant';
  if (r.recommendedAction === 'NoRestockExcessActionRequired') return 'healthy';
  return 'other';
}

// ── Snapshot loaders ────────────────────────────────────────────────────────

function latestSnapshotPath(prefix = 'inventory-planning-') {
  if (!fs.existsSync(SNAP_DIR)) return null;
  const files = fs.readdirSync(SNAP_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  return files.length ? path.join(SNAP_DIR, files[files.length - 1]) : null;
}

function latestBuyBoxPath() {
  return latestSnapshotPath('buybox-');
}

function loadLatestBuyBox() {
  const p = latestBuyBoxPath();
  if (!p) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Merge BuyBox results into normalized rows. Does nothing if BB snapshot missing.
function mergeBuyBox(rows, buyboxSnapshot) {
  if (!buyboxSnapshot) return rows;
  const byAsin = {};
  for (const r of buyboxSnapshot.results || []) {
    if (r.ok && r.summary) byAsin[r.asin] = r.summary;
  }
  for (const row of rows) {
    const bb = byAsin[row.asin];
    if (bb) {
      row.bb = {
        buyBoxPrice: bb.buyBoxPrice,
        buyBoxSellerId: bb.buyBoxSellerId,
        buyBoxIsUs: bb.buyBoxIsUs,
        buyBoxIsFba: bb.buyBoxIsFba,
        ourPrice: bb.ourPrice,
        ourIsFba: bb.ourIsFba,
        lowestPrice: bb.lowestPrice,
        lowestFbaPrice: bb.lowestFbaPrice,
        offerCount: bb.offerCount,
        gap: bb.ourPrice != null && bb.buyBoxPrice != null ? Number((bb.ourPrice - bb.buyBoxPrice).toFixed(2)) : null,
      };
    } else {
      row.bb = null;
    }
  }
  return rows;
}

// Attach sku-map entry + MAP decision to each row.
function attachMapContext(rows) {
  const skuMap = loadSkuMap();
  for (const row of rows) {
    const entry = skuMap[row.asin];
    row.skuEntry = entry && typeof entry === 'object' ? entry : null;
    row.brand = row.skuEntry?.brand || null;
    row.mapCad = row.skuEntry?.map_cad ?? null;
    row.mapOverrideAllowed = !!row.skuEntry?.map_override_allowed;
    if (row.bb) {
      row.mapDecision = evaluateMap({
        asin: row.asin,
        skuEntry: row.skuEntry,
        buyBoxSummary: row.bb,
      });
    } else {
      row.mapDecision = null;
    }
  }
  return rows;
}

// Prefer the restock-recs snapshot (GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT
// — the report that actually backs Amazon's Seller Central Restock page and
// returns all restockable SKUs) when fresh. Fall back to the inventory-planning
// snapshot (narrower dataset — usually ~30 rows) when restock-recs is absent or
// more than ~25 hours old.
// When both are present, MERGE them keyed by ASIN with restock-recs as the base
// so ageBuckets + LIPC + BB-relevant planning-only fields survive.
function loadLatestSnapshot({ withBuyBox = true } = {}) {
  const recsPath = latestSnapshotPath('restock-recs-');
  const planPath = latestSnapshotPath();
  const bestPath = recsPath || planPath;
  if (!bestPath) return null;

  let primarySnap = JSON.parse(fs.readFileSync(bestPath, 'utf8'));
  let rows = (primarySnap.rows || []).map(normalizeRow);

  // When both snapshots exist, overlay planning-only fields onto restock-recs rows
  if (recsPath && planPath && recsPath !== planPath) {
    try {
      const planSnap = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const planByAsin = {};
      for (const pr of (planSnap.rows || [])) {
        const n = normalizeRow(pr);
        if (n.asin) planByAsin[n.asin] = n;
      }
      for (const r of rows) {
        const p = planByAsin[r.asin];
        if (!p) continue;
        // Overlay fields that only planning carries or that planning computes better
        if (!r.daysOfSupply && p.daysOfSupply) r.daysOfSupply = p.daysOfSupply;
        if (!r.totalDaysOfSupply && p.totalDaysOfSupply) r.totalDaysOfSupply = p.totalDaysOfSupply;
        if (!r.historicalDaysOfSupply && p.historicalDaysOfSupply) r.historicalDaysOfSupply = p.historicalDaysOfSupply;
        if (!r.shortTermDaysOfSupply && p.shortTermDaysOfSupply) r.shortTermDaysOfSupply = p.shortTermDaysOfSupply;
        if (!r.longTermDaysOfSupply && p.longTermDaysOfSupply) r.longTermDaysOfSupply = p.longTermDaysOfSupply;
        if (!r.healthyInventoryLevel && p.healthyInventoryLevel) r.healthyInventoryLevel = p.healthyInventoryLevel;
        if (p.ageBuckets && Object.values(p.ageBuckets).some((v) => v > 0)) r.ageBuckets = p.ageBuckets;
        if (p.lipcAppliedThisWeek) r.lipcAppliedThisWeek = true;
        if (p.lipcExempt) r.lipcExempt = true;
      }
    } catch {}
  }

  const bb = withBuyBox ? loadLatestBuyBox() : null;
  if (bb) mergeBuyBox(rows, bb);
  attachMapContext(rows);
  for (const r of rows) r.tier = classify(r);
  return {
    ...primarySnap,
    path: bestPath,
    recsPath,
    planPath,
    rows,
    buyboxPath: bb ? latestBuyBoxPath() : null,
    buyboxPulledAt: bb?.pulledAt || null,
  };
}

// ── Ranking ─────────────────────────────────────────────────────────────────

const TIER_RANK = {
  bleeding: 0,
  'our-map-violation': 1,
  urgent: 2,
  'lipc-active': 3,
  'map-violator-detected': 4,
  'bb-losing': 5,
  'low-cover': 6,
  upcoming: 7,
  other: 8,
  dormant: 9,
  healthy: 10,
};

function rankForToday(rows) {
  const copy = [...rows];
  copy.sort((a, b) => {
    const ta = TIER_RANK[a.tier] ?? 99;
    const tb = TIER_RANK[b.tier] ?? 99;
    if (ta !== tb) return ta - tb;
    // Within BB-losing: biggest price gap first (biggest $ recovery)
    if (a.tier === 'bb-losing' && b.tier === 'bb-losing') {
      return (b.bb?.gap || 0) - (a.bb?.gap || 0);
    }
    // within other tiers: bigger daily velocity first (protect the earners)
    return b.dailyVelocity - a.dailyVelocity;
  });
  return copy;
}

module.exports = {
  normalizeRow,
  classify,
  latestSnapshotPath,
  latestBuyBoxPath,
  loadLatestBuyBox,
  mergeBuyBox,
  loadLatestSnapshot,
  rankForToday,
  TIER_RANK,
};
