/**
 * Counter stock gate for YourFloors counter pickup (pure: no I/O). Mac 2026-10-02: "We cannot offer a local pickup
 * for a product that we do not have stock of at that location", "need some sort of live inventory sync from prosol",
 * no app ("that should be a basic shopify function"), "we don't want to sell things that are out of stock".
 *
 * Each Prosol counter is a Shopify location with Shopify's own local pickup (scripts/trade/native-counters.js), and the
 * sync (scripts/trade/counter-stock-sync.js) writes Prosol's count there. Shopify offers pickup at a location only when
 * it can fill the whole cart there. Tested on live checkout 2026-10-02: a "don't sell when out of stock" (DENY) variant
 * at 0 gets no pickup; a "continue selling" (CONTINUE) variant gets pickup even at 0, but not at a location where it
 * isn't stocked at all. So planLocations() keeps an item stocked at a counter only while Prosol has it there, and
 * switches Prosol-profile variants to DENY with their shipping stock = Prosol's network total (the pool location).
 * Unknown stock (lookup failed) changes nothing that run; not at Prosol means never stocked at a counter.
 *
 *   countersFrom(branches)                      enabled Prosol counters (Coast rows excluded: our own truck brings
 *                                               those in) -> [{ code, mapKey, rateTitle }]
 *   codesFor(variant, { map, upcIndex, sfIndex, itemIndex, prosolCodes })
 *                                               a Shopify variant's Prosol codes: the sku-map entry by Shopify SKU (object
 *                                               or plain string), else its barcode through the Schluter UPC list (YF's
 *                                               Schluter SKUs are numbers like 9129 that Prosol doesn't know; the UPC
 *                                               gives KMS172/12), else the Salesforce item of that name's vendor code
 *                                               (slashes put back from the Schluter list: KMS17212 -> KMS172/12), else
 *                                               the SKU itself. SKIP / NON_PROSOL / HALT_ entries are not Prosol stock:
 *                                               no codes, so every counter is hidden
 *   computeTags({ products, stockBySku, counters })
 *                                               per product { id, want, add, remove }, versus its current pz-no-*
 *                                               tags only (the tag approach, kept for the per-counter counts and for
 *                                               removing tags written before the switch)
 *   planLocations({ variants, stockBySku, counters, pool, levels })
 *                                               the inventory writes for native pickup, see below
 */

'use strict';

const PREFIX = 'pz-no-';
const tagFor = (code) => `${PREFIX}${String(code).toUpperCase()}`;
const isGateTag = (t) => String(t).toLowerCase().startsWith(PREFIX);

const NOT_PROSOL = (v) => typeof v === 'string' && (v === 'SKIP' || v === 'NON_PROSOL' || v.startsWith('HALT_'));

const cleanCode = (s) => String(s || '').replace(/[\u200B-\u200F\u2060\uFEFF\s]/g, '');
const itemKey = (s) => cleanCode(s).replace(/\//g, '').toUpperCase();

function codesFor(variant, { map = {}, upcIndex = null, sfIndex = null, itemIndex = null, prosolCodes } = {}) {
  const sku = variant.sku ? String(variant.sku).trim() : '';
  const e = sku ? map[sku] : undefined;
  if (typeof e === 'string') return NOT_PROSOL(e) ? { apiSku: null, prosolSku: null, via: `sku-map ${e}` } : { apiSku: e, prosolSku: e, via: 'sku-map' };
  if (e && typeof e === 'object') {
    if (NOT_PROSOL(e.api_sku) || NOT_PROSOL(e.prosol_sku)) return { apiSku: null, prosolSku: null, via: `sku-map ${e.api_sku || e.prosol_sku}` };
    return { ...prosolCodes(sku, map), via: 'sku-map' };
  }
  const hit = variant.barcode && upcIndex ? upcIndex.get(String(variant.barcode).trim()) : null;
  if (hit) return { apiSku: hit, prosolSku: hit, via: 'schluter-upc' };
  const vendor = sku && sfIndex ? cleanCode(sfIndex.get(sku)) : '';
  if (vendor) {
    const code = (itemIndex && itemIndex.get(itemKey(vendor))) || vendor;
    return { apiSku: code, prosolSku: code, via: 'sf-item' };
  }
  return sku ? { apiSku: sku, prosolSku: sku, via: 'raw-sku' } : { apiSku: null, prosolSku: null, via: 'no-sku' };
}

function countersFrom(branches) {
  return (branches || [])
    .filter((b) => b.enabled && !b.coast && b.map_key)
    .map((b) => ({ code: String(b.code).toUpperCase(), mapKey: String(b.map_key), rateTitle: b.rate_title, locationId: b.shopify_location_id || null }));
}

/**
 * products: [{ id, tags, variants: [{ sku, apiSku, prosolSku }] }]
 * stockBySku: { prosolSku: { [prosolLocationId]: qty } | null }   null or missing = lookup failed / not at Prosol
 * A product is out at a counter when ANY of its variants has less than 1 there (or unknown stock, or no SKU).
 */
function computeTags({ products, stockBySku, counters }) {
  const stock = stockBySku || {};
  return (products || []).map((p) => {
    const want = new Set();
    for (const c of counters) {
      const out = !(p.variants || []).length || p.variants.some((v) => {
        const s = v.prosolSku ? stock[v.prosolSku] : null;
        return !s || !(Number(s[c.mapKey]) >= 1);
      });
      if (out) want.add(tagFor(c.code));
    }
    const have = new Map((p.tags || []).filter(isGateTag).map((t) => [t.toUpperCase(), t]));
    const add = [...want].filter((t) => !have.has(t.toUpperCase()));
    const wantU = new Set([...want].map((t) => t.toUpperCase()));
    const remove = [...have].filter(([u]) => !wantU.has(u)).map(([, t]) => t);
    return { id: p.id, title: p.title, want: [...want], add, remove };
  });
}

/**
 * Salesforce counts some items in square or linear feet (KERDI rolls SqFt, KERDI-BAND LnFt) while Shopify sells the roll.
 * -> whole sellable units: qty itself for EA, qty / the roll size read from the variant or product title ("108 ft²",
 * "98.5 LF") for area/length, and 0 when the size can't be read (never guess a shelf count).
 */
function shelfUnits(qty, uom, titles) {
  const q = Math.max(0, Number(qty) || 0);
  const u = String(uom || 'EA').toLowerCase().replace(/[\s.]/g, '');
  if (!u || u === 'ea' || u === 'each') return Math.floor(q);
  const area = ['sqft', 'sf', 'ft2'].includes(u);
  const length = ['lnft', 'lf', 'lft', 'linft', 'length'].includes(u);
  if (!area && !length) return 0;
  const re = area ? /(\d+(?:\.\d+)?)\s*(?:ft²|ft2|sq\.?\s*ft|sqft|square\s*feet)/i : /(\d+(?:\.\d+)?)\s*(?:LF|lin\.?\s*ft|linear\s*f(?:ee|oo)t|')/i;
  for (const t of titles || []) {
    const m = String(t || '').match(re);
    if (m && Number(m[1]) > 0) return Math.floor(q / Number(m[1]));
  }
  return 0;
}

/**
 * variants: [{ id, productId, itemId, policy: 'DENY'|'CONTINUE', prosolSku, pooled }]   pooled = Prosol profile (ships):
 *           gets DENY and the pool; false = "Local pickup only" (trims, Coast pickup off Sechelt/PR): policy left alone
 * stockBySku: { prosolSku: { [prosolLocationId]: qty } | null | undefined }   null = not at Prosol, undefined = failed
 * counters: [{ code, mapKey, locationId }]   only counters with a locationId are written
 * pool: { locationId, zero: [locationId] }   shipping stock: the Prosol network total at locationId, 0 at `zero`
 * cfc: { bySku: Map shopifySku -> { [shopifyLocationId]: qty }, locations: [shipping location ids],
 *        pickup: { [pickupLocationId]: shippingLocationId } }   CFC's own shelf (Salesforce PBSI available at Sechelt
 *      and Powell River), written for every variant with a SKU: the shipping locations get the count, the Coast
 *      pickup-only locations (Mac 2026-10-02 "Shelf only") are stocked only while it's on the shelf; null =
 *      Salesforce failed, those levels stay
 * levels: Map `${itemId}|${locationId}` -> { levelId, qty }   what Shopify has now
 * -> { activate: [{ itemId, locationId }], set: [{ itemId, locationId, qty }], deactivate: [{ itemId, locationId, levelId }],
 *      deny: [{ productId, variantId }], skipped: n }
 * Order of writes (the sync does it): activate, set, deny, deactivate. A variant is never DENY before its pool is set.
 */
function planLocations({ variants, stockBySku, counters, pool, levels, cfc = null }) {
  const out = { activate: [], set: [], deactivate: [], deny: [], skipped: 0 };
  const cs = (counters || []).filter((c) => c.locationId);
  const has = (itemId, loc) => levels.get(`${itemId}|${loc}`);
  const want = (itemId, loc, qty) => {
    const l = has(itemId, loc);
    if (!l) out.activate.push({ itemId, locationId: loc });
    if (!l || l.qty !== qty) out.set.push({ itemId, locationId: loc, qty });
  };
  const drop = (itemId, loc) => { const l = has(itemId, loc); if (l) out.deactivate.push({ itemId, locationId: loc, levelId: l.levelId }); };
  const cfcLocs = cfc && cfc.locations ? cfc.locations : [];
  for (const v of variants || []) {
    if (!v.itemId) { out.skipped++; continue; }
    // CFC's own shelf (replaces the old placeholder counts), whatever Prosol says
    if (cfc && cfc.bySku && v.sku) {
      const own = cfc.bySku.get(v.sku) || {};
      for (const loc of cfcLocs) {
        const q = Math.max(0, Math.floor(Number(own[loc]) || 0));
        const l = has(v.itemId, loc);
        if (q > 0) want(v.itemId, loc, q); else if (l && l.qty !== 0) out.set.push({ itemId: v.itemId, locationId: loc, qty: 0 });
      }
      for (const [pickupLoc, shipLoc] of Object.entries(cfc.pickup || {})) {
        const q = Math.max(0, Math.floor(Number(own[shipLoc]) || 0));
        if (q > 0) want(v.itemId, pickupLoc, q); else drop(v.itemId, pickupLoc);
      }
    }
    const stock = v.prosolSku ? stockBySku[v.prosolSku] : null;
    if (stock === undefined && v.prosolSku) { out.skipped++; continue; } // lookup failed this run: leave it as it is
    for (const c of cs) {
      const q = stock ? Math.max(0, Math.floor(Number(stock[c.mapKey]) || 0)) : 0;
      if (q > 0) want(v.itemId, c.locationId, q); else drop(v.itemId, c.locationId);
    }
    if (v.pooled && stock && pool && pool.locationId) {
      const total = Object.values(stock).reduce((n, x) => n + Math.max(0, Math.floor(Number(x) || 0)), 0);
      want(v.itemId, pool.locationId, total);
      for (const z of pool.zero || []) { const l = has(v.itemId, z); if (l && l.qty !== 0) out.set.push({ itemId: v.itemId, locationId: z, qty: 0 }); }
      if (v.policy !== 'DENY') out.deny.push({ productId: v.productId, variantId: v.id });
    }
  }
  return out;
}

/**
 * Products outside the pickup profiles that hold counts at the Sechelt / Powell River shipping locations (Mac
 * 2026-10-02 "clean up the other 318 placeholders too"): their real shelf, but only where it's known for sure.
 * Flooring sells by the box (product metafield my_fields.sq_ft_per_carton); Salesforce counts it in SqFt or SqYd.
 * -> whole sellable units, or null = can't tell (the count is left as it is, so nothing stops selling by accident).
 */
function otherShelfUnits(qty, uom, { titles = [], sqftPerCarton = null } = {}) {
  const q = Math.max(0, Number(qty) || 0);
  const u = String(uom || '').toLowerCase().replace(/[\s.]/g, '');
  const box = Number(sqftPerCarton) > 0 ? Number(sqftPerCarton) : null;
  if (u === 'ea' || u === 'each') return Math.floor(q);
  if (['sqft', 'sf', 'ft2'].includes(u)) return box ? Math.floor(q / box) : (shelfUnits(q, uom, titles) || (q === 0 ? 0 : null));
  if (['sqyd', 'sy', 'sqyrds'].includes(u)) return box ? Math.floor((q * 9) / box) : null;
  if (['lnft', 'lf', 'lft', 'linft'].includes(u)) { const n = shelfUnits(q, uom, titles); return n || (q === 0 ? 0 : null); }
  return null;
}

/**
 * items: [{ itemId, sku, titles, sqftPerCarton }]   variants stocked at the shelf locations, outside the pickup profiles
 * shelf: Map sku -> { [locationId]: qty, uom }   Salesforce
 * moveTo: a shipping location in the same shipping group (Vancouver Warehouse). No Salesforce item (special-order
 *   flooring; Mac 2026-10-02: "keep them orderable from other warehouses, but if salesforce don't have the stock then we
 *   sure don't allow for pickup"): the placeholder moves off Sechelt / Powell River onto moveTo, once (idempotent).
 * pickup: { [pickupLocationId]: shippingLocationId }   the Coast pickup-only locations (Mac 2026-10-02 "everything on
 *   the shelf"): stocked with the same real shelf count while it's above 0, unstocked otherwise (no Salesforce item or a
 *   unit that won't convert: never stocked there)
 * -> { set: [{ itemId, locationId, qty }], activate: [{ itemId, locationId }], deactivate: [{ itemId, locationId, levelId }] }
 */
function planOtherShelf({ items, shelf, locations, levels, moveTo = null, pickup = {}, shelfOnly = new Set() }) {
  const out = [];
  const activate = [];
  const deactivate = [];
  for (const it of items || []) {
    const s = it.sku ? shelf.get(it.sku) : null;
    for (const [pickupLoc, shipLoc] of Object.entries(pickup)) {
      const q = s ? otherShelfUnits(s[shipLoc] || 0, s.uom, { titles: it.titles, sqftPerCarton: it.sqftPerCarton }) : null;
      const l = levels.get(`${it.itemId}|${pickupLoc}`);
      if (q > 0) {
        if (!l) activate.push({ itemId: it.itemId, locationId: pickupLoc });
        if (!l || l.qty !== q) out.push({ itemId: it.itemId, locationId: pickupLoc, qty: q });
      } else if (l) deactivate.push({ itemId: it.itemId, locationId: pickupLoc, levelId: l.levelId });
    }
    if (!s) {
      if (!moveTo) continue;
      const here = locations.map((loc) => [loc, levels.get(`${it.itemId}|${loc}`)]).filter(([, l]) => l && l.qty > 0);
      if (!here.length) continue;
      const dest = levels.get(`${it.itemId}|${moveTo}`);
      if (!dest) activate.push({ itemId: it.itemId, locationId: moveTo });
      out.push({ itemId: it.itemId, locationId: moveTo, qty: (dest ? Math.max(0, dest.qty) : 0) + here.reduce((n, [, l]) => n + l.qty, 0) });
      for (const [loc] of here) out.push({ itemId: it.itemId, locationId: loc, qty: 0 });
      continue;
    }
    const real = locations.map((loc) => [loc, levels.get(`${it.itemId}|${loc}`), otherShelfUnits(s[loc] || 0, s.uom, { titles: it.titles, sqftPerCarton: it.sqftPerCarton })]).filter(([, l]) => l);
    // Nothing on either shelf and nothing at moveTo yet: keep it orderable the same way (the placeholder moves there)
    // instead of taking the product off sale (17 such on 2026-10-02: own-collection flooring, long mouldings, tools).
    const dest = moveTo ? levels.get(`${it.itemId}|${moveTo}`) : null;
    // Shelf-only SKUs (Mac 2026-10-02 on the matching mouldings: "don't have reliable stock of those"): sold only while
    // they're on our shelf; nothing held for them anywhere else.
    if (shelfOnly.has(it.sku)) {
      if (dest && dest.qty !== 0) out.push({ itemId: it.itemId, locationId: moveTo, qty: 0 });
    } else if (moveTo && real.every(([, , q]) => q === 0) && !(dest && dest.qty > 0)) {
      const amount = real.reduce((n, [, l]) => n + Math.max(0, l.qty), 0);
      if (amount > 0) {
        if (!dest) activate.push({ itemId: it.itemId, locationId: moveTo });
        out.push({ itemId: it.itemId, locationId: moveTo, qty: amount });
      }
    }
    for (const [loc, l, q] of real) {
      if (q === null || q === l.qty) continue;
      out.push({ itemId: it.itemId, locationId: loc, qty: q });
    }
  }
  return { set: out, activate, deactivate };
}

module.exports = { PREFIX, tagFor, isGateTag, codesFor, itemKey, countersFrom, computeTags, planLocations, shelfUnits, otherShelfUnits, planOtherShelf };
