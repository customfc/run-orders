'use strict';
/**
 * Pre-mapping the ACTIVE Shopify catalogue (pure). The CLI is scripts/ops/premap-catalog.js.
 *
 * Staging looks an order line up in sku-map.json `mappings` by its raw SKU (run-orders.js resolveMappedEntry, no case,
 * slash or space normalisation), and a line with no entry holds the whole order until the sku-resolver maps it. This
 * module decides, for every active variant SKU with no key, whether an entry can be written ahead of the first order:
 *
 *   Tier 1, alias: existing entries whose api_sku IS the variant SKU (an ASIN alias, or an old Shopify key from before
 *     the catalogue rebuild). All of them must agree on api_sku + prosol_sku, at least one must be verified, and the
 *     Shopify title must pass the mapping guard against the entry's product. The copy keeps the product fields and
 *     drops what belongs to the original key (CHANNEL_FIELDS).
 *   Tier 2, Prosol exact: exactly one Prosol storefront product whose sku is the variant SKU (auto-map.js's lookup),
 *     with a prosol_sku and an offer cost, and the Shopify title passes the mapping guard against Prosol's name. No
 *     sibling gate: the key is the variant's own SKU, so the variant is pinned by the code itself.
 *   Everything else is a CSV row with the reason.
 *
 * Both tiers also refuse a title that ends in a different code (staging's title-vs-map check would halt the order).
 * Package fields (lib/package-split.js) are copied only when the aliases carry them, or when the code's letter family
 * carries them consistently (inferPackage); otherwise they are left out and the row says why.
 */

const { validateMapping } = require('./mapping-guard');
const { trailingSku } = require('./trade-skumap');

const DISCOVERED_BY = 'premap-catalog';
const COST_SOURCE = 'prosol-offers-loc10010';
const SENTINEL = /^(HALT|UNMAPPED|NON_PROSOL|SKIP)/;
const PACKAGE_FIELDS = ['package_shape', 'max_per_pkg', 'max_pkg_weight_lb'];

/**
 * Fields that describe the ORIGINAL key rather than the product, so an alias never inherits them:
 *   note, source, discovered_by, auto_discovered, verified_source, added: how that key was found. `source` also matters
 *     to staging: a catalog-schluter-* source skips the Salesforce name guard (lib/trade-skumap isCatalogEntry), which
 *     was earned by checking THAT key's Shopify title, not this one.
 *   alias_of, seller_sku, needs_order_lookup: Amazon listing facts (ASIN aliases, our seller SKU, title lookups).
 *   shopify_handle: the catalogue listing the original key belongs to (scripts/trade/trim-costs.js reads it).
 *   map_override_allowed/_reason, referral_pct, fba_fulfillment_fee: Amazon repricer inputs (lib/map-rules.js).
 *   automayt_item_id/_for: an Opus pick pinned on the original key (lib/automayt-settle.js); the new key earns its own.
 * Everything else (codes, product, cost, MAP, barcode, brand, ship_mode, package fields, route) is the product's.
 */
const CHANNEL_FIELDS = [
  'note', 'source', 'discovered_by', 'auto_discovered', 'verified_source', 'added',
  'alias_of', 'seller_sku', 'needs_order_lookup', 'shopify_handle',
  'map_override_allowed', 'map_override_reason', 'referral_pct', 'fba_fulfillment_fee',
  'automayt_item_id', 'automayt_item_for',
];

// Vendors that ship from their own warehouse (prosol-location-map.json non_prosol vendors) or are CFC's own stock.
const OWN_WAREHOUSE_VENDORS = ['biyork', 'torlys', 'treeco', 'json', 'pcw', 'custom flooring centres', 'perfect level master'];
// Flooring is sold by the box from the flooring vendor; staging also holds "flooring-style" titles out of run scope.
const FLOORING_TYPES = new Set(['vinyl plank', 'vinyl tile', 'hardwood', 'engineered hardwood', 'laminate', 'rubber flooring', 'carpet']);
const FLOORING_TITLE = /(click\s+vinyl|luxury\s+vinyl|laminate\s+floor|hardwood\s+floor|engineered\s+hardwood|sheet\s+vinyl|floor\s+protection)/i;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isEntry = (e) => !!e && typeof e === 'object' && !Array.isArray(e);
const effectiveProsol = (e) => e.prosol_sku || e.api_sku; // what staging puts on the PO
const prosolName = (p) => ((typeof p.name === 'object' && p.name) ? (p.name.en || p.name.fr || '') : (p.name || ''));
const codeKey = (s) => String(s || '').toUpperCase().replace(/[\s\-/]/g, ''); // run-orders.js normalizeSkuForCompare
const clip = (s, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The order line name Shopify gives a variant: product title, plus " - <variant title>" unless it is the default. */
function lineName(productTitle, variantTitle) {
  const t = String(productTitle || '').trim();
  const v = String(variantTitle || '').trim();
  return v && v !== 'Default Title' ? `${t} - ${v}` : t;
}

/** Same rule as run-orders.js isClearlyOutOfScope. */
function isFlooringTitle(name) {
  if (/\badhesive\b/i.test(name)) return false;
  return FLOORING_TITLE.test(name);
}

/** Same check as run-orders.js titleSkuMismatchReason: a title ending in a code must name the mapped code. */
function titleCodeMismatch(name, code) {
  const extracted = trailingSku(name);
  if (!extracted) return null;
  const a = codeKey(extracted);
  const b = codeKey(code);
  if (!a || !b || a === b || a.includes(b) || b.includes(a)) return null;
  return `title ends in "${extracted}" but the code is "${code}" (staging's title check would halt the order)`;
}

/**
 * Active variants grouped by SKU, keeping only SKUs that have no key in mappings (exact, as staging looks them up).
 * variants: [{ sku, title, product: { title, vendor, handle, productType } }]. Returns { groups, keyed, noSku }.
 */
function unkeyedGroups(variants, mappings) {
  const bySku = new Map();
  let keyed = 0;
  let noSku = 0;
  for (const v of variants || []) {
    const sku = v && v.sku;
    if (!sku || !String(sku).trim()) { noSku++; continue; }
    if (own(mappings, sku)) { keyed++; continue; }
    const p = v.product || {};
    const g = bySku.get(sku) || { sku, names: [], vendors: [], productTypes: [], handles: [], variants: 0 };
    const add = (arr, x) => { if (x && !arr.includes(x)) arr.push(x); };
    add(g.names, lineName(p.title, v.title));
    add(g.vendors, p.vendor);
    add(g.productTypes, p.productType);
    add(g.handles, p.handle);
    g.variants++;
    bySku.set(sku, g);
  }
  return { groups: [...bySku.values()], keyed, noSku };
}

/** api_sku -> [[key, entry], ...] over the object entries of mappings. */
function indexByApiSku(mappings) {
  const idx = new Map();
  for (const [key, e] of Object.entries(mappings || {})) {
    if (!isEntry(e) || typeof e.api_sku !== 'string') continue;
    if (!idx.has(e.api_sku)) idx.set(e.api_sku, []);
    idx.get(e.api_sku).push([key, e]);
  }
  return idx;
}

// ── package fields ──────────────────────────────────────────────────────────

/** Package fields as lib/package-split.js applies them (its defaults filled in), so equal behaviour compares equal. */
function packageSignature(e) {
  if (!isEntry(e) || !e.package_shape) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  const mpp = n(e.max_per_pkg);
  const wt = n(e.max_pkg_weight_lb);
  switch (e.package_shape) {
    case 'solo': return `solo/per${mpp || 1}/lb${wt || 50}`;
    case 'roll_kerdi': return `roll_kerdi/per${mpp || 5}`;
    case 'cable_kit': return `cable_kit/per${mpp || 2}`;
    case 'heat_sheet': return `heat_sheet/lb${wt || 50}`;
    default: return `${e.package_shape}/per${mpp}/lb${wt}`;
  }
}

function packageFields(e) {
  const out = {};
  for (const f of PACKAGE_FIELDS) if (e[f] !== undefined && e[f] !== null) out[f] = e[f];
  return out;
}

/** Of entries that carry package fields: the most common raw form if they all behave the same, else null + why. */
function agreeingPackage(entries) {
  const carriers = entries.filter((e) => packageSignature(e));
  if (!carriers.length) return { fields: null, carriers: 0 };
  const sigs = new Set(carriers.map(packageSignature));
  if (sigs.size > 1) return { fields: null, carriers: carriers.length, conflict: [...sigs].join(' vs ') };
  const counts = new Map();
  for (const e of carriers) {
    const raw = JSON.stringify(packageFields(e));
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { fields: JSON.parse(best), carriers: carriers.length, signature: [...sigs][0] };
}

/** A code's letter family: the leading letters (and hyphens) before its first digit or slash. Numeric codes have none. */
function familyPrefix(code) {
  const s = String(code || '').toUpperCase();
  const m = /^([A-Z][A-Z-]*)[\d/]/.exec(s);
  return m && m[1].length >= 2 ? m[1] : null;
}

/** prefix -> Map(code -> entries) over the real (non-sentinel) codes in mappings. */
function buildFamilies(mappings) {
  const fam = new Map();
  for (const e of Object.values(mappings || {})) {
    if (!isEntry(e) || typeof e.api_sku !== 'string' || SENTINEL.test(e.api_sku)) continue;
    const prefix = familyPrefix(e.api_sku);
    if (!prefix) continue;
    if (!fam.has(prefix)) fam.set(prefix, new Map());
    const codes = fam.get(prefix);
    if (!codes.has(e.api_sku)) codes.set(e.api_sku, []);
    codes.get(e.api_sku).push(e);
  }
  return fam;
}

/**
 * Package fields for a code with no entry of its own, from its letter family: copied only when at least 2 sibling
 * codes and at least minShare of them carry package fields, and every carrier behaves the same. A sibling whose own
 * entries disagree counts as a conflict. Returns { fields|null, why }.
 */
function inferPackage(code, families, { minShare = 0.8 } = {}) {
  const prefix = familyPrefix(code);
  if (!prefix) return { fields: null, why: 'no letter family to learn package fields from' };
  const codes = families.get(prefix);
  const siblings = codes ? [...codes.entries()].filter(([c]) => c !== code) : [];
  if (!siblings.length) return { fields: null, why: `no mapped siblings with prefix ${prefix}` };
  const perCode = siblings.map(([c, entries]) => [c, agreeingPackage(entries)]);
  const conflicted = perCode.filter(([, r]) => r.conflict);
  if (conflicted.length) return { fields: null, why: `sibling ${conflicted[0][0]} (prefix ${prefix}) has conflicting package fields: ${conflicted[0][1].conflict}` };
  const carriers = perCode.filter(([, r]) => r.fields);
  const share = `${carriers.length} of ${siblings.length} sibling codes with prefix ${prefix}`;
  if (carriers.length < 2 || carriers.length / siblings.length < minShare) return { fields: null, why: `only ${share} carry package fields` };
  const sigs = new Set(carriers.map(([, r]) => r.signature));
  if (sigs.size > 1) return { fields: null, why: `siblings with prefix ${prefix} disagree: ${[...sigs].join(' vs ')}` };
  const counts = new Map();
  for (const [, r] of carriers) {
    const raw = JSON.stringify(r.fields);
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  const fields = JSON.parse([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return { fields, why: `${share} carry ${[...sigs][0]}` };
}

// ── vendors ─────────────────────────────────────────────────────────────────

/**
 * vendor -> { prosol, offProsol }: how the vendor's already-keyed active variants route. offProsol = NON_PROSOL
 * entries (Sechelt or another fixed warehouse).
 */
function vendorRouting(variants, mappings) {
  const out = new Map();
  for (const v of variants || []) {
    const e = v && v.sku && own(mappings, v.sku) ? mappings[v.sku] : null;
    if (!isEntry(e) || typeof e.api_sku !== 'string') continue;
    const vendor = (v.product && v.product.vendor) || '';
    const r = out.get(vendor) || { prosol: 0, offProsol: 0 };
    if (e.api_sku === 'NON_PROSOL') r.offProsol++;
    else if (!SENTINEL.test(e.api_sku)) r.prosol++;
    out.set(vendor, r);
  }
  return out;
}

/** Why a vendor's SKUs should not be mapped to Prosol, or null. */
function nonProsolVendor(vendor, routing) {
  const v = String(vendor || '').trim().toLowerCase();
  if (OWN_WAREHOUSE_VENDORS.some((x) => v === x || v.startsWith(`${x} `))) return `${vendor} ships from its own warehouse or CFC stock, not Prosol`;
  const r = routing && routing.get(vendor);
  if (r && r.offProsol > 0 && r.prosol === 0) return `${vendor}'s ${r.offProsol} keyed active SKU(s) all ship off-Prosol (NON_PROSOL), none from Prosol`;
  return null;
}

// ── tier 1 ──────────────────────────────────────────────────────────────────

/**
 * Tier 1. candidates: [[key, entry]] whose api_sku === sku. Returns null (no candidates), { entry, from, packageWhy },
 * or { reason, code, fallthrough } — fallthrough=true lets tier 2 try (nothing contradicts the code, it just couldn't
 * be copied), false means skip the SKU.
 */
function decideAlias({ sku, names, candidates, families, date }) {
  if (!candidates || !candidates.length) return null;
  const keys = candidates.map(([k]) => k);
  const halted = candidates.find(([, e]) => SENTINEL.test(String(e.prosol_sku || '')) || e.bundle);
  if (halted) return { code: 'alias-halted', fallthrough: false, reason: `key ${halted[0]} maps ${sku} to ${halted[1].bundle ? 'a bundle' : halted[1].prosol_sku}` };
  const codes = new Set(candidates.map(([, e]) => effectiveProsol(e)));
  if (codes.size > 1) {
    const listed = candidates.map(([k, e]) => `${k} → ${effectiveProsol(e)}`).join(', ');
    // The same PO code written with and without its slashes (the schluter-reference entries copied api_sku into
    // prosol_sku): nothing contradicts the product, but only Prosol's record says which spelling is the PO code.
    if (new Set([...codes].map(codeKey)).size === 1) return { code: 'alias-format', fallthrough: true, reason: `entries write the PO code two ways (${listed}); Prosol's record decides` };
    return { code: 'alias-disagree', fallthrough: false, reason: `entries disagree: ${listed}` };
  }
  const modes = new Set(candidates.map(([, e]) => e.ship_mode || 'ship'));
  if (modes.size > 1) return { code: 'alias-disagree', fallthrough: false, reason: `entries disagree on ship_mode: ${[...modes].join(' vs ')}` };
  const verified = candidates.filter(([, e]) => e.verified === true);
  if (!verified.length) return { code: 'alias-unverified', fallthrough: true, reason: `entries for this code are not verified (${keys.join(', ')})` };
  const [baseKey, base] = [...verified].sort((a, b) => (b[1].cost_cad != null) - (a[1].cost_cad != null))[0];
  const prosol = effectiveProsol(base);
  for (const n of names) {
    const t = titleCodeMismatch(n, prosol);
    if (t) return { code: 'title-code-mismatch', fallthrough: false, reason: t };
  }
  for (const n of names) {
    const g = validateMapping(n, base.product || '');
    if (!g.ok || !g.verified) return { code: 'alias-guard', fallthrough: true, reason: `"${n}" vs ${baseKey} "${base.product || ''}": ${g.reason}`, guard: g.reason };
  }
  const entry = {};
  for (const [k, v] of Object.entries(base)) if (!CHANNEL_FIELDS.includes(k) && !PACKAGE_FIELDS.includes(k)) entry[k] = v;
  const pkg = agreeingPackage(candidates.map(([, e]) => e));
  let packageWhy;
  if (pkg.fields) {
    Object.assign(entry, pkg.fields);
    packageWhy = `from ${pkg.carriers} of ${candidates.length} alias entr${candidates.length === 1 ? 'y' : 'ies'} (${pkg.signature})`;
  } else if (pkg.conflict) {
    packageWhy = `left out: aliases disagree (${pkg.conflict})`;
  } else {
    const inf = inferPackage(base.api_sku, families);
    if (inf.fields) Object.assign(entry, inf.fields);
    packageWhy = inf.fields ? `aliases carry none; ${inf.why}` : `left out: aliases carry none; ${inf.why}`;
  }
  entry.note = clip(`Pre-mapped ${date} by premap-catalog: Shopify SKU ${sku} is the api_sku of verified key${verified.length > 1 ? 's' : ''} ${verified.map(([k]) => k).join(', ')} (all ${base.api_sku} / ${prosol}); copied from ${baseKey} without its channel fields; "${names[0]}" passed the mapping guard against "${base.product}".`);
  entry.verified = true;
  entry.source = 'premap-catalog-alias';
  entry.auto_discovered = true;
  entry.discovered_by = DISCOVERED_BY;
  return { entry, from: keys, baseKey, guard: 'match', packageWhy };
}

// ── tier 2 ──────────────────────────────────────────────────────────────────

/** Prosol rows (from a filter[sku] answer) whose sku is this SKU, as auto-map compares (case only), one per product id. */
function exactHits(rows, sku) {
  const want = String(sku).toUpperCase();
  const seen = new Set();
  const out = [];
  for (const p of rows || []) {
    if (!p || String(p.sku || '').toUpperCase() !== want || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Tier 2 before the offer call. hits: exactHits(). existing: [[key, entry]] whose api_sku === sku (tier 1 leftovers).
 * Returns { product, name } or { reason, code }.
 */
function prosolPrecheck({ names, hits, existing = [] }) {
  if (!hits.length) return { code: 'no-prosol-match', reason: 'no Prosol storefront product has this SKU' };
  if (hits.length > 1) return { code: 'several-prosol-matches', reason: `${hits.length} Prosol products have this SKU (ids ${hits.map((p) => p.id).join(', ')})` };
  const p = hits[0];
  if (!p.prosol_sku) return { code: 'no-prosol-sku', reason: `Prosol product ${p.id} has no prosol_sku (PO code)` };
  const name = prosolName(p);
  const clash = existing.find(([, e]) => codeKey(effectiveProsol(e)) !== codeKey(p.prosol_sku));
  if (clash) return { code: 'conflicts-existing', reason: `key ${clash[0]} maps this code to ${effectiveProsol(clash[1])}, Prosol says ${p.prosol_sku}` };
  for (const n of names) {
    const t = titleCodeMismatch(n, p.prosol_sku);
    if (t) return { code: 'title-code-mismatch', reason: t };
  }
  for (const n of names) {
    const g = validateMapping(n, name);
    if (!g.ok || !g.verified) return { code: 'guard-failed', reason: `"${n}" vs Prosol "${name}": ${g.reason}`, guard: g.reason, name };
  }
  return { product: p, name };
}

/** Tier 2 entry once the offer is in. offer: getOfferPrice() answer or null. Returns { entry, packageWhy } or { reason, code }. */
function prosolEntry({ sku, names, product: p, name, offer, families, date }) {
  if (!offer || offer.cost_cad == null) return { code: 'no-cost', reason: `Prosol product ${p.id} has no offer/cost` };
  const inf = inferPackage(p.sku, families);
  const entry = {
    cost_cad: offer.cost_cad,
    ...(offer.retail_cad != null ? { retail_cad: offer.retail_cad } : {}),
    cost_source: COST_SOURCE,
    api_sku: p.sku,
    prosol_sku: p.prosol_sku,
    prosol_product_id: p.id,
    product: name,
    ...(inf.fields || {}),
    note: clip(`Pre-mapped ${date} by premap-catalog: Shopify SKU ${sku} is an exact Prosol storefront SKU (product ${p.id}, the only one); "${names[0]}" passed the mapping guard against "${name}".${inf.fields ? ` Package fields from siblings: ${inf.why}.` : ''}`),
    verified: true,
    source: COST_SOURCE,
    auto_discovered: true,
    discovered_by: DISCOVERED_BY,
  };
  return { entry, packageWhy: inf.fields ? inf.why : `left out: ${inf.why}` };
}

// ── one SKU, start to finish ────────────────────────────────────────────────

function rowBase(group) {
  return {
    sku: group.sku,
    vendor: group.vendors.join(' | '),
    product_type: group.productTypes.join(' | '),
    line_name: group.names.join(' | '),
    variants: group.variants,
    handle: group.handles.join(' | '),
  };
}

const entryCols = (entry) => ({
  api_sku: entry.api_sku,
  prosol_sku: entry.prosol_sku,
  cost_cad: entry.cost_cad,
  entry_product: entry.product,
  prosol_product_id: entry.prosol_product_id,
  package: PACKAGE_FIELDS.filter((f) => entry[f] !== undefined).map((f) => `${f}=${entry[f]}`).join(' '),
});

/**
 * Everything decided before Prosol is asked: tier 1, then the skips that need no lookup (bad SKU, flooring, non-Prosol
 * vendor). Returns { entry, row } (alias), { row } (skip) or { needsProsol: true, row, existing, aliasNote }.
 */
function classifyGroup(group, { index, families, routing, date }) {
  const row = rowBase(group);
  const skip = (code, reason, extra = {}) => ({ row: { ...row, ...extra, tier: 'skip', reason_code: code, reason } });
  if (group.sku.includes(',')) return skip('bad-sku', 'SKU contains a comma (Prosol uses it to separate codes)');
  const existing = index.get(group.sku) || [];
  const a = decideAlias({ sku: group.sku, names: group.names, candidates: existing, families, date });
  if (a && a.entry) {
    return { entry: a.entry, row: { ...row, ...entryCols(a.entry), tier: 'alias', reason_code: 'alias', reason: `copied from ${a.baseKey}`, guard: a.guard, package_why: a.packageWhy, alias_keys: a.from.join(' ') } };
  }
  const aliasKeys = existing.map(([k]) => k).join(' ');
  if (a && !a.fallthrough) return skip(a.code, a.reason, { alias_keys: aliasKeys, guard: a.guard });
  const aliasNote = a ? `${a.code}: ${a.reason}` : '';
  const flooringType = group.productTypes.find((t) => FLOORING_TYPES.has(String(t).toLowerCase()));
  if (flooringType || group.names.some(isFlooringTitle)) {
    return skip('flooring', `flooring (${flooringType || 'flooring-style title'}): sold by the box from the flooring vendor; staging holds flooring-style titles out of run scope`, { alias_keys: aliasKeys, alias_note: aliasNote });
  }
  const vendorWhy = group.vendors.map((v) => nonProsolVendor(v, routing)).find(Boolean);
  if (vendorWhy) return skip('non-prosol-vendor', vendorWhy, { alias_keys: aliasKeys, alias_note: aliasNote });
  return { needsProsol: true, existing, row: { ...row, alias_keys: aliasKeys, alias_note: aliasNote } };
}

/** Tier 2 rows: precheck verdict -> skip row, or (with the offer) an entry + row. */
function prosolSkipRow(row, pre) {
  return { ...row, tier: 'skip', reason_code: pre.code, reason: pre.reason, guard: pre.guard || '', entry_product: pre.name || '' };
}
function prosolDoneRow(row, built) {
  if (!built.entry) return { ...row, tier: 'skip', reason_code: built.code, reason: built.reason };
  return { ...row, ...entryCols(built.entry), tier: 'prosol', reason_code: 'prosol-exact', reason: 'one exact Prosol product', guard: 'match', package_why: built.packageWhy };
}

// ── report ──────────────────────────────────────────────────────────────────

const CSV_COLS = ['sku', 'tier', 'reason_code', 'reason', 'vendor', 'product_type', 'line_name', 'api_sku', 'prosol_sku', 'cost_cad',
  'entry_product', 'guard', 'package', 'package_why', 'alias_keys', 'alias_note', 'prosol_product_id', 'variants', 'handle'];

const csvEsc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function toCsv(rows) {
  return `${[CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvEsc(r[c])).join(','))].join('\n')}\n`;
}

/** Counts per tier, per skip reason code and per vendor (tier counts in each). */
function summarize(rows) {
  const tiers = {};
  const reasons = {};
  const vendors = {};
  for (const r of rows) {
    tiers[r.tier] = (tiers[r.tier] || 0) + 1;
    if (r.tier === 'skip') reasons[r.reason_code] = (reasons[r.reason_code] || 0) + 1;
    const v = vendors[r.vendor] || (vendors[r.vendor] = { alias: 0, prosol: 0, skip: 0, total: 0 });
    v[r.tier] = (v[r.tier] || 0) + 1;
    v.total++;
  }
  return { tiers, reasons, vendors };
}

module.exports = {
  DISCOVERED_BY, CHANNEL_FIELDS, PACKAGE_FIELDS, CSV_COLS,
  lineName, isFlooringTitle, titleCodeMismatch, unkeyedGroups, indexByApiSku,
  packageSignature, agreeingPackage, familyPrefix, buildFamilies, inferPackage,
  vendorRouting, nonProsolVendor, FLOORING_TYPES,
  decideAlias, exactHits, prosolPrecheck, prosolEntry, prosolName,
  classifyGroup, prosolSkipRow, prosolDoneRow,
  toCsv, summarize,
};
