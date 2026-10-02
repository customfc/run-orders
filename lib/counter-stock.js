/**
 * Counter stock gate for YourFloors counter pickup (pure: no I/O). Mac 2026-10-02: "We cannot offer a local pickup
 * for a product that we do not have stock of at that location", "need some sort of live inventory sync from prosol".
 *
 * Checkout can't see Prosol stock, so the sync (scripts/trade/counter-stock-sync.js) tags each pickup-eligible product
 * `pz-no-<CODE>` for every counter that can't fill it, and a hide-shipping app hides "Pickup at our <X> trade counter"
 * when any cart product carries that counter's tag. Unknown stock counts as none: a counter is only offered when Prosol
 * shows it holding every variant of the product.
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
 *                                               tags only; every other tag is left alone
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
    .map((b) => ({ code: String(b.code).toUpperCase(), mapKey: String(b.map_key), rateTitle: b.rate_title }));
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

module.exports = { PREFIX, tagFor, isGateTag, codesFor, itemKey, countersFrom, computeTags };
