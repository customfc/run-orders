/**
 * FBA replenishment PO draft manager.
 *
 * User clicks "Queue" on a row in the FBA Command dashboard → a line gets
 * added here. Lines are grouped by vendor for review + send.
 *
 * Persistence: data/fba/po-drafts/current.json (single active draft).
 * When sent, moves to data/fba/po-drafts/sent/<draftId>.json.
 *
 * Vendor derivation precedence:
 *   1. sku-map entry has `brand` === 'schluter' → "prosol"
 *   2. sku-map entry has valid `prosol_sku` (not NON_PROSOL / UNMAPPED*) → "prosol"
 *   3. product name matches brand regex (bona / aqua mix / perfect level) → that vendor
 *   4. fallback: "unknown"
 */

const fs = require('fs');
const path = require('path');

const DRAFTS_DIR = path.join(__dirname, '..', 'data', 'fba', 'po-drafts');
const CURRENT_PATH = path.join(DRAFTS_DIR, 'current.json');
const SENT_DIR = path.join(DRAFTS_DIR, 'sent');
const SKU_MAP_PATH = path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json');

function ensureDirs() {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.mkdirSync(SENT_DIR, { recursive: true });
}

let _skuMapCache = null;
function loadSkuMap() {
  if (_skuMapCache) return _skuMapCache;
  _skuMapCache = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8')).mappings || {};
  return _skuMapCache;
}

// ── Vendor derivation ───────────────────────────────────────────────────────

const VENDOR_META = {
  prosol: {
    label: 'Prosol',
    primary_brand: 'Schluter + Aqua Mix',
    email: 'klazzarotto@prosol.ca',
    cc: [],
    contact: 'Kaitlyn Lazzarotto',
    note: 'Primary distributor for Schluter + Aqua Mix products',
  },
  treeco: {
    label: 'Treeco',
    primary_brand: 'Bona',
    email: 'robynp@treeco.ca',
    cc: ['briannam@treeco.ca'],
    contact: 'Robyn P. (Brianna M. on CC)',
    note: 'Distributor for Bona products',
    warehouses: [
      {
        code: 'TRE-DEL',
        label: 'Delta (Timeless Wood Floors)',
        address1: '1230 Cliveden Ave',
        city: 'Delta',
        state: 'BC',
        postal: 'V3M6G4',
        country: 'CA',
        phone: '604-523-2235',
      },
      {
        code: 'TRE-CAL',
        label: 'Calgary',
        address1: '5211 52 St. SE',
        city: 'Calgary',
        state: 'AB',
        postal: 'T2B3T1',
        country: 'CA',
        phone: '403-219-3303',
      },
    ],
  },
  perfectlevel: {
    label: 'Perfect Level Master',
    email: null,
    cc: [],
    contact: null,
    note: 'Confirm vendor contact before sending',
  },
  unknown: {
    label: 'Unknown vendor',
    email: null,
    cc: [],
    contact: null,
    note: 'Set vendor manually before sending',
  },
};

function deriveVendor({ asin, sku, product }) {
  const map = loadSkuMap();
  const entry = map[asin] || map[sku] || null;
  const pname = (entry?.product || product || '').toLowerCase();

  // 1. Brand-name overrides — these win over prosol_sku presence, because a
  //    Bona item may have a historical prosol_sku from the FBM pipeline but
  //    is actually ordered from Treeco. Same shape for Perfect Level.
  if (/\bbona(kemi)?\b/i.test(pname)) return 'treeco';
  if (/perfect[\s.-]*level/i.test(pname)) return 'perfectlevel';

  // 2. Schluter brand field → Prosol
  if (entry && (entry.brand || '').toLowerCase() === 'schluter') return 'prosol';

  // 3. Valid Prosol SKU → Prosol (covers Schluter + Aqua Mix + anything else
  //    Prosol stocks that we've mapped).
  if (entry && typeof entry === 'object') {
    const prosol = entry.prosol_sku || '';
    if (prosol && prosol !== 'NON_PROSOL' && !prosol.startsWith('UNMAPPED')) {
      return 'prosol';
    }
  }

  // 4. Product-name fallback for SKUs missing from map entirely
  if (/aqua[\s.-]*mix/i.test(pname)) return 'prosol';      // Prosol distributes Aqua Mix
  if (/schluter|kerdi|ditra|dilex|schiene/i.test(pname)) return 'prosol';

  return 'unknown';
}

// Cost derivation — unit cost from sku-map if present (none today, but leaves room)
function deriveUnitCost({ asin, sku }) {
  const entry = loadSkuMap()[asin] || loadSkuMap()[sku];
  return entry?.unit_cost ? Number(entry.unit_cost) : null;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function emptyDraft() {
  return {
    draftId: `draft-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    lines: [],
  };
}

function loadCurrent() {
  ensureDirs();
  if (!fs.existsSync(CURRENT_PATH)) return emptyDraft();
  try {
    const d = JSON.parse(fs.readFileSync(CURRENT_PATH, 'utf8'));
    if (!d.lines) d.lines = [];
    return d;
  } catch {
    return emptyDraft();
  }
}

function saveCurrent(draft) {
  ensureDirs();
  draft.updatedAt = new Date().toISOString();
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(draft, null, 2));
  return draft;
}

function clearCurrent() {
  ensureDirs();
  if (fs.existsSync(CURRENT_PATH)) fs.unlinkSync(CURRENT_PATH);
  return emptyDraft();
}

// ── Line operations ─────────────────────────────────────────────────────────

function findLine(draft, { asin, vendor }) {
  return draft.lines.find((l) => l.asin === asin && l.vendor === vendor);
}

/**
 * Add a line. If the same asin+vendor already exists, sets qty to the new value
 * (not additive — dashboard treats each click as "make my commitment this qty").
 */
function addLine(draft, { asin, sku, product, qty, recQty, addedFromTier, vendor: vendorOverride, mapCad, ourPrice, buyBoxPrice }) {
  if (!asin) throw new Error('addLine: asin required');
  if (qty == null || qty < 1) throw new Error('addLine: qty must be >= 1');
  const vendor = vendorOverride || deriveVendor({ asin, sku, product });
  const existing = findLine(draft, { asin, vendor });
  const unitCost = deriveUnitCost({ asin, sku });
  const now = new Date().toISOString();

  if (existing) {
    existing.qty = Number(qty);
    existing.updatedAt = now;
    return existing;
  }

  const line = {
    lineId: `L-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    asin,
    sku: sku || null,
    product: product || null,
    vendor,
    qty: Number(qty),
    recQty: recQty != null ? Number(recQty) : null,
    unitCost,
    extCost: unitCost ? Number((unitCost * Number(qty)).toFixed(2)) : null,
    mapCad: mapCad ?? null,
    ourPrice: ourPrice ?? null,
    buyBoxPrice: buyBoxPrice ?? null,
    addedFromTier: addedFromTier || null,
    addedAt: now,
    updatedAt: now,
  };
  draft.lines.push(line);
  return line;
}

function updateLine(draft, lineId, { qty }) {
  const line = draft.lines.find((l) => l.lineId === lineId);
  if (!line) throw new Error(`Line ${lineId} not found`);
  if (qty != null) {
    if (qty < 1) throw new Error('qty must be >= 1');
    line.qty = Number(qty);
    if (line.unitCost) line.extCost = Number((line.unitCost * line.qty).toFixed(2));
    line.updatedAt = new Date().toISOString();
  }
  return line;
}

function removeLine(draft, lineId) {
  const i = draft.lines.findIndex((l) => l.lineId === lineId);
  if (i < 0) return null;
  const [removed] = draft.lines.splice(i, 1);
  return removed;
}

// ── Grouped view ────────────────────────────────────────────────────────────

function groupByVendor(draft) {
  const groups = {};
  for (const line of draft.lines) {
    const v = line.vendor || 'unknown';
    if (!groups[v]) {
      groups[v] = {
        vendor: v,
        ...VENDOR_META[v],
        lines: [],
        lineCount: 0,
        totalUnits: 0,
        totalCost: 0,
        hasCostData: true,
      };
    }
    groups[v].lines.push(line);
    groups[v].lineCount++;
    groups[v].totalUnits += line.qty;
    if (line.extCost != null) groups[v].totalCost += line.extCost;
    else groups[v].hasCostData = false;
  }
  // Fix floats
  for (const g of Object.values(groups)) {
    g.totalCost = Number(g.totalCost.toFixed(2));
  }
  return groups;
}

function summarize(draft) {
  const groups = groupByVendor(draft);
  return {
    draftId: draft.draftId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    lineCount: draft.lines.length,
    totalUnits: draft.lines.reduce((s, l) => s + l.qty, 0),
    totalCostKnown: Number(draft.lines.reduce((s, l) => s + (l.extCost || 0), 0).toFixed(2)),
    unknownCostLines: draft.lines.filter((l) => l.extCost == null).length,
    vendorGroups: groups,
  };
}

module.exports = {
  VENDOR_META,
  deriveVendor,
  loadCurrent,
  saveCurrent,
  clearCurrent,
  addLine,
  updateLine,
  removeLine,
  groupByVendor,
  summarize,
  emptyDraft,
};
