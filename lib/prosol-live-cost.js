'use strict';
/**
 * Prosol's live price on every Prosol PO line, and the Automayt item cost kept
 * in step with it.
 *
 * Steph (Automayt), 2026-11-18: "send Prosol's live price on each line (your
 * key needs purchase_orders:set_cost); Automayt keeps the item cost alongside
 * it, so any gap shows. Updating the item cost is fine: it only changes what
 * the next PO starts from, not the value of stock we hold. And a bill above
 * the PO price is held for the PO owner, a lower one goes through with a
 * notice."
 *
 * So for each Prosol PO line:
 *   1. Price the product at Prosol now (offers, Burnaby, our account's net).
 *      Area items (stocked per sq ft / ft) divide the package price by the
 *      line's coverage, the same way the catalogue import did.
 *   2. The PO line carries that live price.
 *   3. When the item's stored cost is missing or more than 1% off, PATCH the
 *      item cost to the live price (expected_version guards a concurrent edit).
 *
 * Guards (a wrong price is worse than a stale one):
 *   - Prosol unreachable / no product / no offer: the line keeps the item's
 *     stored cost, exactly as before, and the step says why.
 *   - Live price more than 30% from a stored cost: most likely the wrong Prosol
 *     product (bare numeric codes are shared across makers) or a wrong
 *     coverage. The line keeps the stored cost, the item is not touched, and
 *     the step is flagged for a person.
 *
 * PROSOL_LIVE_PO_COST=0 turns it all off (lines go back to the stored cost).
 */

const UPDATE_THRESHOLD = 0.01;
const SUSPECT_THRESHOLD = 0.30;

const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

/**
 * On by default; PROSOL_LIVE_PO_COST=0 turns it off. Under `node --test` it is
 * off unless a test sets PROSOL_LIVE_PO_COST=1, so no test ever opens a real
 * Prosol session through a flow that happens to make a PO.
 */
function enabled() {
  const v = process.env.PROSOL_LIVE_PO_COST;
  if (v != null) return String(v) !== '0';
  return !process.env.NODE_TEST_CONTEXT;
}

/** Relative gap between the stored and live cost, as a fraction of live. */
function gapOf(stored, live) {
  if (!(stored > 0) || !(live > 0)) return null;
  return Math.abs(stored - live) / live;
}

/**
 * What to do with one line, pure. stored: the item's cost (or null), live: the
 * live unit cost (or null). Returns { unitCost, update, suspect, gap }.
 */
function decide(stored, live) {
  if (!(live > 0)) return { unitCost: stored, update: false, suspect: false, gap: null };
  const gap = gapOf(stored, live);
  if (gap != null && gap > SUSPECT_THRESHOLD) return { unitCost: stored, update: false, suspect: true, gap };
  return { unitCost: live, update: gap == null || gap > UPDATE_THRESHOLD, suspect: false, gap };
}

function defaultClientFactory() {
  const path = require('path');
  const { ProsolClientV2 } = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-client-v2'));
  return new ProsolClientV2();
}

/**
 * One pricer per batch of POs (a Shopify order, an Amazon pass, an FBA PO):
 * the Prosol session opens on the first line and close() ends it.
 *
 *   const pricer = livePricer({ erp, itemCost });
 *   const r = await pricer.price({ item, prosolSku, productId, coverage });
 *   // r.unitCost goes on the PO line; r.step goes in the results
 *   await pricer.close();
 */
let factoryOverride = null;
/** Tests: hand every new pricer this Prosol client factory (null restores the real one). */
function _setClientFactory(f) { factoryOverride = f; }

function livePricer({ erp, itemCost, clientFactory = factoryOverride || defaultClientFactory } = {}) {
  let client = null;
  let clientError = null;
  const byItem = new Map(); // item id -> { pkg, source } | { error }, one Prosol call per item per batch
  const patched = new Map(); // item id -> unit cost already written this batch

  async function session() {
    if (client || clientError) return client;
    try {
      const c = clientFactory();
      if (c.init) await c.init();
      client = c;
    } catch (e) {
      clientError = e;
    }
    return client;
  }

  async function packagePrice({ item, prosolSku, productId }) {
    if (byItem.has(item.id)) return byItem.get(item.id);
    let out;
    const c = await session();
    if (!c) out = { error: `Prosol session failed: ${clientError && clientError.message}` };
    else {
      try {
        const offer = productId ? await c.getOfferPrice(productId) : prosolSku ? await c.getCost(prosolSku) : null;
        out = offer && offer.cost_cad > 0
          ? { pkg: Number(offer.cost_cad), source: offer.costSource || 'prosol-live' }
          : { error: `no Prosol offer for ${prosolSku || productId || 'unmapped item'}` };
      } catch (e) {
        out = { error: `Prosol price lookup failed for ${prosolSku || productId}: ${e.message}` };
      }
    }
    byItem.set(item.id, out);
    return out;
  }

  async function price({ item, prosolSku = null, productId = null, coverage = null }) {
    const stored = itemCost(item);
    const label = item.item_number || item.sku || item.vendor_code || item.id;
    const base = { step: 'prosol-cost', itemNumber: label, automaytItemId: item.id, prosolSku, storedCost: stored };
    if (!enabled()) return { unitCost: stored, step: null };

    const p = await packagePrice({ item, prosolSku, productId });
    if (p.error) return { unitCost: stored, step: { ...base, success: false, fallback: 'stored cost', reason: p.error } };

    const live = coverage > 0 ? round4(p.pkg / coverage) : round4(p.pkg);
    const d = decide(stored, live);
    if (d.suspect) {
      return {
        unitCost: stored,
        step: {
          ...base, success: false, suspect: true, liveCost: live, packagePrice: p.pkg, coverage: coverage || null,
          reason: `Prosol price ${live} is ${(d.gap * 100).toFixed(1)}% from the item cost ${stored}: check the Prosol product match before trusting it. PO line kept the item cost, item not changed.`,
        },
      };
    }

    const step = { ...base, success: true, liveCost: live, source: p.source, gapPct: d.gap == null ? null : round4(d.gap * 100), itemUpdated: false };
    if (coverage > 0) Object.assign(step, { packagePrice: p.pkg, coverage });
    if (d.update && patched.get(item.id) !== live) {
      try {
        await erp.updateItem(item.id, { cost: String(live) }, { expectedVersion: item.version });
        patched.set(item.id, live);
        step.itemUpdated = true;
      } catch (e) {
        step.itemUpdateError = e.message; // the PO line still carries the live price
      }
    } else if (patched.get(item.id) === live) {
      step.itemUpdated = 'earlier line';
    }
    return { unitCost: live, step };
  }

  async function close() {
    const c = client;
    client = null;
    if (c && c.close) { try { await c.close(); } catch { /* browser already gone */ } }
  }

  return { price, close };
}

module.exports = { livePricer, decide, gapOf, enabled, UPDATE_THRESHOLD, SUSPECT_THRESHOLD, _setClientFactory };
