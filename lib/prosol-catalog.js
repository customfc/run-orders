/**
 * Prosol catalogue → Automayt items: the pure part (no network). The pull is
 * scripts/automayt/prosol-catalog-pull.js, the import scripts/automayt/prosol-catalog-import.js.
 *
 * The import rule (Mac, 2026-10-14): a product is "actively selling" at Prosol
 * when it has stock at TWO OR MORE Prosol locations (location rows with
 * available > 0). Every record keeps its location count and the as-of date so
 * a later sync can apply the rule again.
 */

const fs = require('fs');

// ── Slimming raw Prosol rows (the raw product row is ~8 KB, mostly copy and images) ──

function en(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v.en || v.fr || null;
}

function slimProduct(p) {
  return {
    id: p.id,
    sku: p.sku != null ? String(p.sku) : null,
    prosol_sku: p.prosol_sku != null ? String(p.prosol_sku) : null,
    external_id: p.external_id || null,
    name: en(p.name),
    name_fr: p.name && typeof p.name === 'object' ? p.name.fr || null : null,
    active: !!p.active,
    publish_status: p.publish_status || null,
    discontinued: !!p.discontinued,
    discontinued_at: p.discontinued_at || null,
    is_clearance: p.is_clearance != null ? !!p.is_clearance : null,
    stock_status: p.stock_status || null,
    stock_purchasable: p.stock_purchasable != null ? !!p.stock_purchasable : null,
    available_quantity: p.available_quantity != null ? Number(p.available_quantity) : null,
    msrp_price: p.msrp_price != null ? Number(p.msrp_price) : null,
    barcode: p.barcode != null ? String(p.barcode) : null,
    pricing_measure: p.pricing_measure != null ? Number(p.pricing_measure) : null,
    pricing_measure_unit: p.pricing_measure_unit || null,
    pricing_base_measure: p.pricing_base_measure != null ? Number(p.pricing_base_measure) : null,
    quantity_min: p.quantity_min != null ? Number(p.quantity_min) : null,
    quantity_inc: p.quantity_inc != null ? Number(p.quantity_inc) : null,
    shipment_package_quantity: p.shipment_package_quantity != null ? Number(p.shipment_package_quantity) : null,
    product_manufacturer_id: p.product_manufacturer_id || null,
    product_category_id: p.product_category_id || null,
    product_type_id: p.product_type_id || null,
    product_collection_id: p.product_collection_id || null,
    taxable: p.taxable != null ? !!p.taxable : null,
    updated_at: p.updated_at || null,
  };
}

function slimStockRow(r) {
  const L = r.product_inventory_location || {};
  return {
    product_id: r.product_id,
    location_id: r.product_inventory_location_id,
    location: L.id ? [L.name, L.city, L.province].filter(Boolean).join(' | ') : null,
    available: r.available != null ? Number(r.available) : null,
    net_available: r.net_available != null ? Number(r.net_available) : null,
    discontinued: !!r.discontinued,
    clearance: !!r.clearance,
  };
}

// ── Stock rule ───────────────────────────────────────────────────────────────

/**
 * product id → { locations, units, byLocation } from in-stock location rows.
 * A location counts when its `available` unit count is above zero. Several rows
 * for one product at one location (vendor items) are summed first.
 */
function stockByProduct(stockRows) {
  const out = new Map();
  for (const r of stockRows) {
    if (r.product_id == null || r.location_id == null) continue;
    let s = out.get(r.product_id);
    if (!s) { s = { byLocation: {} }; out.set(r.product_id, s); }
    const qty = Number(r.available) || 0;
    s.byLocation[r.location_id] = (s.byLocation[r.location_id] || 0) + qty;
  }
  for (const s of out.values()) {
    const qtys = Object.values(s.byLocation).filter((q) => q > 0);
    s.locations = qtys.length;
    s.units = qtys.reduce((a, b) => a + b, 0);
  }
  return out;
}

const passesRule = (rec, minLocations = 2) => (rec.locations || 0) >= minLocations;

function locationTable(stockRows) {
  const seen = new Map();
  for (const r of stockRows) {
    if (r.location_id == null) continue;
    const e = seen.get(r.location_id) || { id: r.location_id, name: r.location, rows: 0 };
    if (!e.name && r.location) e.name = r.location;
    e.rows++;
    seen.set(r.location_id, e);
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

// ── Catalogue build ──────────────────────────────────────────────────────────

function categoryPath(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map();
  return function pathOf(id) {
    if (id == null) return { names: [], codes: [] };
    if (memo.has(id)) return memo.get(id);
    const names = [];
    const codes = [];
    const guard = new Set();
    let c = byId.get(id);
    while (c && !guard.has(c.id)) {
      guard.add(c.id);
      names.unshift(c.name);
      codes.unshift(c.code);
      c = c.parent_id ? byId.get(c.parent_id) : null;
    }
    const out = { names, codes };
    memo.set(id, out);
    return out;
  };
}

function buildCatalog({ products, stockRows, manufacturers, categories, minLocations = 2, asOf }) {
  const stock = stockByProduct(stockRows);
  const mfr = new Map(manufacturers.map((m) => [m.id, m.name]));
  const pathOf = categoryPath(categories);
  const seen = new Set();
  const records = [];
  for (const p of products) {
    if (seen.has(p.id)) continue; // a list that shifts between pages can repeat a row
    seen.add(p.id);
    const s = stock.get(p.id) || { locations: 0, units: 0, byLocation: {} };
    const rec = {
      ...p,
      manufacturer: mfr.get(p.product_manufacturer_id) || null,
      category_path: pathOf(p.product_category_id).names,
      category_codes: pathOf(p.product_category_id).codes,
      locations: s.locations,
      units: s.units,
      stock_by_location: s.byLocation,
      stock_as_of: asOf,
    };
    rec.passes = passesRule(rec, minLocations);
    records.push(rec);
  }
  return { asOf, minLocations, count: records.length, records };
}

function summarize(records, { minLocations = 2 } = {}) {
  const n = (f) => records.filter(f).length;
  return {
    total: records.length,
    active: n((r) => r.active),
    published: n((r) => r.publish_status === 'published'),
    discontinued: n((r) => r.discontinued),
    activeNotDiscontinued: n((r) => r.active && !r.discontinued),
    stockAnyLocation: n((r) => r.locations >= 1),
    stockExactlyOne: n((r) => r.locations === 1),
    [`stock${minLocations}PlusLocations`]: n((r) => r.locations >= minLocations),
    passingDiscontinued: n((r) => r.locations >= minLocations && r.discontinued),
    passingToImport: n((r) => r.locations >= minLocations && !r.discontinued),
    availableQuantityZeroButStocked: n((r) => r.available_quantity === 0 && r.locations >= 1),
  };
}

// ── Codes ────────────────────────────────────────────────────────────────────

/** The run-orders vendor-code form (automayt-orders stripSku, Salesforce PBSI__Vendor_Item_ID__c): no slashes or dashes. */
const stripSku = (s) => String(s || '').trim().replace(/[\/-]/g, '');

/** Loose comparison key for the dedupe: case, spaces, dashes, slashes, dots and underscores ignored. */
const normCode = (s) => String(s || '').toUpperCase().replace(/[\s\-\/._]/g, '');

/** C100978-01 → C100978-1 (the leading-zero fuzzy form amazonCandidates also tries). */
function leadingZeroForm(code) {
  const m = String(code || '').match(/^(.+)-0*(\d+)$/);
  return m && `${m[1]}-${m[2]}` !== code ? `${m[1]}-${m[2]}` : null;
}

/**
 * A code that is only digits, 6 or fewer: the shape of CFC's own Salesforce
 * item numbers (01977, 10940). Some makers use the same shape (Rubi 05961,
 * Richard 13304), so such a code never matches by item number, and a maker's
 * code of that shape is not looked up at all. Measured 2026-10-14: every one of
 * the 355 item-number matches was a short number and 342 were different
 * products (a Rubi drill bit "matching" an Engineered Floors carpet).
 */
const isShortNumeric = (code) => /^\d{1,6}$/.test(normCode(code));

/**
 * Codes to look a product up by. vendorCodes: Prosol's code, its leading-zero
 * form, then the maker's code (unless it is a short number). itemNumbers: the
 * same codes minus short numbers (legacy item numbers are CFC's own numbering).
 */
function lookupCodes(rec) {
  const vendorCodes = [];
  const add = (c) => { if (c && !vendorCodes.some((x) => normCode(x) === normCode(c))) vendorCodes.push(String(c)); };
  add(rec.prosol_sku || rec.sku);
  add(leadingZeroForm(rec.prosol_sku));
  if (rec.sku && !isShortNumeric(rec.sku)) add(rec.sku);
  return { vendorCodes, itemNumbers: vendorCodes.filter((c) => !isShortNumeric(c)) };
}

/** Every code a product may be filed under (vendor codes, in lookup order). */
const productCodes = (rec) => lookupCodes(rec).vendorCodes;

/**
 * Groups of records whose Prosol codes are the same once Automayt's matching
 * rules apply (case, spaces and dashes ignored; we strip slashes too). Prosol
 * reuses codes (e.g. Tarkett stair treads VIRNRD2048 on several products with
 * different maker codes), and two items can't share a vendor code in Automayt:
 * the second create would 409 and be linked to the first product's item.
 * Returns Map key → [record ids] for keys with two or more records.
 */
function codeCollisions(records) {
  const groups = new Map();
  for (const r of records) {
    const k = normCode(r.prosol_sku || r.sku);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.id);
  }
  return new Map([...groups.entries()].filter(([, ids]) => ids.length > 1));
}

// ── Category: Prosol's tree → Automayt's ten categories ─────────────────────
// Matched on Prosol category codes, most specific first. Anything unmatched
// falls to AUTOMAYT_CATEGORY_DEFAULT (Accessories), the same fallback the
// order flows use for auto-created items (lib/automayt-orders.js categoryFor).

const CATEGORY_RULES = [
  // flooring itself
  [['vinyl_planks', 'vinyl_tiles', 'sheet_vinyl'], 'LVP'],
  [['linoleum_and_marmoleum', 'rubber_flooring', 'anti-static_flooring', 'accessibility_flooring'], 'LVP'],
  [['engineered_hardwood', 'hardwood', 'wood_panellings'], 'Hardwood'],
  [['laminate_floors'], 'Laminate'],
  [['carpet_tiles', 'broadloom_carpets', 'rugs'], 'Carpet'],
  [['floor_tiles', 'mosaic', 'wall_tiles', 'tiles'], 'Tile'],
  // underlayment
  [['membranes_and_underlayments'], 'Underlayment'],
  // consumable supplies (the grout/adhesive bucket of categoryFor)
  [['adhesives', 'caulk_and_sealants', 'floor_patch_and_levelers_and_primers', 'tile_setting_materials',
    'hardwood_stains_and_finishes', 'tapes', 'fasteners', 'hot-melt_carpet__seam_tape', 'kool_glide_tape',
    'silicones_and_sealants', 'shower_waterproofing_membranes', 'ceramic_and_stone_cleaners', 'tile_and_grout_sealers',
    'stain_removers', 'wood_and_laminate_floor_cleaners', 'floor_finish_remover', 'vinyl_floor_cleaners',
    'coatings', 'epoxy_coating', 'epoxy_flakes', 'epoxy_pigments'], 'Supplies'],
];

function automaytCategory(rec) {
  const codes = (rec.category_codes || []).slice().reverse(); // leaf first
  for (const code of codes) {
    for (const [list, cat] of CATEGORY_RULES) if (list.includes(code)) return cat;
  }
  return process.env.AUTOMAYT_CATEGORY_DEFAULT || 'Accessories';
}

// ── Units ────────────────────────────────────────────────────────────────────
// Every imported item is stocked in Prosol's selling unit ("each": the roll,
// box, pail or piece a Prosol PO line orders), priced at our Prosol cost for
// that unit. That keeps the PO quantity, the PO cost and Prosol's own order
// unit identical with no conversion. Products Prosol prices per area or length
// keep that measure in the snapshot (pricing_measure / _unit) and get it in
// the description, which is where lib/pbsi-uom.js reads coverage from if an
// item is ever restocked per square foot.

function measureNote(rec) {
  const unit = String(rec.pricing_measure_unit || '').toLowerCase();
  const qty = Number(rec.pricing_measure);
  if (!unit || !(qty > 0)) return null;
  const label = { sqft: 'SqFt', sq_ft: 'SqFt', ft2: 'SqFt', lnft: 'LnFt', lf: 'LnFt', ft: 'LnFt', sqm: 'SqM', m2: 'SqM', m: 'LnM', lnm: 'LnM', sqyd: 'SqYd' }[unit];
  return label ? `${qty} ${label}` : null;
}

// ── Where to price a product ─────────────────────────────────────────────────
// Prosol keeps one offer per branch that carries the product, and prices are
// regional (a QC branch's offer can differ from the BC one). Our cost is the
// Burnaby (10010) offer, as getOfferPrice has always used; a product Burnaby
// doesn't carry is priced at the BC branch with the most stock, then at any
// other stocking branch. The record keeps which branch priced it.

const PRIMARY_PRICE_LOCATION = 10010;

function priceLocations(rec, { bcLocationIds = new Set(), max = 3 } = {}) {
  const stocked = Object.entries(rec.stock_by_location || {})
    .map(([loc, qty]) => ({ loc: Number(loc), qty: Number(qty) || 0 }))
    .sort((a, b) => b.qty - a.qty || a.loc - b.loc);
  const out = [PRIMARY_PRICE_LOCATION];
  for (const s of stocked.filter((x) => bcLocationIds.has(x.loc))) out.push(s.loc);
  for (const s of stocked) out.push(s.loc);
  return [...new Set(out)].slice(0, max);
}

const bcLocationIds = (locations) => new Set(locations.filter((l) => /\|\s*BC\s*$/.test(l.name || '')).map((l) => Number(l.id)));

// ── Prosol record → createItem input ─────────────────────────────────────────

/**
 * Input for lib/automayt-erp.js createItem, or { skip: reason }.
 * vendor_code = Prosol's code stripped the run-orders way (what the order
 * flows look up and what autoCreateItem writes); item_number = the maker's
 * code stripped. The raw forms ride along as aliases so lookups by either
 * spelling resolve, and the Prosol product id is an external ref (system
 * "prosol") for the later sync.
 */
function toItemInput(rec, { cost, retail } = {}) {
  const prosol = rec.prosol_sku || rec.sku;
  if (!prosol) return { skip: 'no code' };
  if (cost == null || !(Number(cost) >= 0)) return { skip: 'no cost' };
  const vendorCode = stripSku(prosol);
  const itemNumber = stripSku(rec.sku || prosol);
  const aliases = [];
  const addAlias = (code, kind) => {
    if (!code) return;
    const c = String(code).trim();
    if (!c || c === vendorCode || aliases.some((a) => a.code === c)) return;
    aliases.push({ code: c, kind });
  };
  addAlias(prosol, 'vendor_code');
  if (rec.sku && normCode(rec.sku) !== normCode(prosol)) addAlias(String(rec.sku), 'vendor_code');
  if (rec.barcode && /^\d{8,14}$/.test(rec.barcode)) addAlias(rec.barcode, 'upc');
  const note = measureNote(rec);
  let description = String(rec.name || itemNumber).trim();
  if (note && !new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(description)) description = `${description} - ${note}`;
  const msrp = rec.msrp_price != null ? Math.round(Number(rec.msrp_price)) / 100 : null;
  return {
    vendorCode,
    itemNumber,
    description: description.slice(0, 250),
    category: automaytCategory(rec),
    unit: 'each',
    cost: Number(cost),
    retail: retail != null ? Number(retail) : msrp,
    manufacturer: rec.manufacturer || null,
    upc: rec.barcode && /^\d{8,14}$/.test(rec.barcode) ? rec.barcode : null,
    stockStatus: 'Special Order',
    aliases: aliases.slice(0, 20),
    externalRefs: [{ system: 'prosol', external_id: String(rec.id) }],
  };
}

// ── Salesforce dedupe ────────────────────────────────────────────────────────

/**
 * For each catalogue record: which Salesforce PBSI item carries one of its
 * codes? INFORMATIONAL (Mac, 2026-10-14): Automayt does not migrate the
 * Salesforce item master, only quantities on hand, and its QOH load matches
 * onto our imported items by vendor code; this is the crosswalk for that load.
 * Matched on PBSI__Vendor_Item_ID__c (lookupCodes.vendorCodes), then Name
 * (lookupCodes.itemNumbers, never a short number), with normCode on both sides.
 *   matched      exactly one Salesforce item
 *   ambiguous    two or more (legacy duplicates): their QOH would land on one item
 *   taken        a short-number code on another vendor's item (numbering coincidence):
 *                that item's QOH must NOT be matched onto ours by vendor code alone
 *   new          none
 * Also flags Salesforce items claimed by two different Prosol products.
 */
function dedupeAgainstSf(records, sfItems, { prosolVendorId } = {}) {
  const byVendor = new Map();
  const byName = new Map();
  const push = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const it of sfItems) {
    push(byVendor, normCode(it.vendorItemId), it);
    push(byName, normCode(it.name), it);
  }
  const claimed = new Map();
  const results = new Map();
  for (const rec of records) {
    let hits = [];
    let via = null;
    const codes = lookupCodes(rec);
    for (const code of codes.vendorCodes) {
      const k = normCode(code);
      const v = byVendor.get(k) || [];
      if (v.length) { hits = v; via = `vendor_item_id:${code}`; break; }
    }
    if (!hits.length) {
      for (const code of codes.itemNumbers) {
        const n = byName.get(normCode(code)) || [];
        if (n.length) { hits = n; via = `name:${code}`; break; }
      }
    }
    const uniq = [...new Map(hits.map((h) => [h.id, h])).values()];
    let status = uniq.length === 0 ? 'new' : uniq.length === 1 ? 'matched' : 'ambiguous';
    // A short-number code on another vendor's item is a coincidence of numbering, not the same product,
    // and Automayt vendor codes are tenant-wide, so the code is taken: a person decides.
    const viaCode = via ? via.slice(via.indexOf(':') + 1) : null;
    if (status === 'matched' && prosolVendorId && isShortNumeric(viaCode) && uniq[0].vendorId !== prosolVendorId) status = 'taken';
    const r = {
      status,
      via,
      sf: uniq.map((h) => ({ id: h.id, name: h.name, vendorItemId: h.vendorItemId, vendorName: h.vendorName, uom: h.uom })),
      otherVendor: prosolVendorId ? uniq.some((h) => h.vendorId && h.vendorId !== prosolVendorId) : false,
    };
    results.set(rec.id, r);
    for (const h of uniq) { if (!claimed.has(h.id)) claimed.set(h.id, []); claimed.get(h.id).push(rec.id); }
  }
  const sharedSfItems = [...claimed.entries()].filter(([, ids]) => ids.length > 1).map(([sfId, ids]) => ({ sfId, prosolIds: ids }));
  return { results, sharedSfItems };
}

// ── Small helpers ────────────────────────────────────────────────────────────

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** n items spread evenly across arr (a representative slice, not just the head). */
function spread(arr, n) {
  if (n >= arr.length) return arr.slice();
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

module.exports = {
  CATEGORY_RULES,
  stripSku,
  normCode,
  leadingZeroForm,
  isShortNumeric,
  lookupCodes,
  productCodes,
  codeCollisions,
  automaytCategory,
  measureNote,
  PRIMARY_PRICE_LOCATION,
  priceLocations,
  bcLocationIds,
  toItemInput,
  dedupeAgainstSf,
  slimProduct,
  slimStockRow,
  stockByProduct,
  passesRule,
  locationTable,
  buildCatalog,
  summarize,
  readJsonl,
  spread,
};
