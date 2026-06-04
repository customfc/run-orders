/**
 * Exact-identity auto-map evaluator (GO-WITH-GUARDS, see
 * project_skumap_automap_spec). Given a logged-in ProsolClientV2 + an UNMAPPED
 * order SKU (+ optional item title), decide whether it's SAFE to auto-create a
 * sku-map entry. Conservative by construction — ANY ambiguity returns 'defer'
 * (the order goes to manual review, exactly as today). The danger the prior
 * review flagged is a wrong size/variant feeding an unattended PO, so the
 * sibling-free gate is the lynchpin.
 *
 * This module ONLY decides. It writes nothing. The caller (a future shadow-first
 * pre-pass in run-orders) logs the 'map' verdicts; only once validated does it
 * apply them via run-orders.liveAddMapping.
 */

const ASIN = /^B0[0-9A-Z]{8}$/;
const nameOf = (p) => ((typeof p.name === 'object' && p.name) ? (p.name.en || p.name.fr || '') : (p.name || ''));

/**
 * @returns {{sku, decision:'map'|'defer', reason?, entry?}}
 */
async function evaluate(client, sku, itemName = '') {
  // (3) never an ASIN — ASINs reach Prosol only via the curated map, never identity.
  if (ASIN.test(sku)) return { sku, decision: 'defer', reason: 'ASIN — not a Prosol code' };

  // (4) EXACTLY ONE product whose .sku == sku (uppercase only, NO slash/dash/space strip).
  const r = await client.apiGet(`/api/storefront/products?filter[sku]=${encodeURIComponent(sku)}&append=prosol_sku&limit=5`);
  if (r.status !== 200) return { sku, decision: 'defer', reason: `Prosol products ${r.status}` };
  let arr; try { arr = JSON.parse(r.body).data || []; } catch { return { sku, decision: 'defer', reason: 'parse error' }; }
  const exact = arr.filter((p) => String(p.sku).toUpperCase() === String(sku).toUpperCase());
  if (exact.length === 0) return { sku, decision: 'defer', reason: 'no exact Prosol match' };
  if (exact.length > 1) return { sku, decision: 'defer', reason: `${exact.length} exact matches` };
  const p = exact[0];

  // (5) must have a prosol_sku (the PO code — never substitute the api_sku).
  if (!p.prosol_sku) return { sku, decision: 'defer', reason: 'product has no prosol_sku' };

  // (6) SIBLING-FREE gate — the safety lynchpin. product_group_id is null in
  //     Prosol; product_collection_id buckets the variant family (e.g. SHELF-E
  //     collection 95 = 50 colour/shape/finish variants). >1 in the collection
  //     => variant-dense => DEFER (the SKU pins the variant, but a mis-stamped
  //     listing can't be caught here).
  if (p.product_collection_id) {
    const g = await client.apiGet(`/api/storefront/products?filter[product_collection_id]=${p.product_collection_id}&limit=50`);
    let fam = []; try { fam = JSON.parse(g.body).data || []; } catch {}
    if (fam.length > 1) return { sku, decision: 'defer', reason: `${fam.length} in collection ${p.product_collection_id} (variant family)` };
  }

  // (7) title must corroborate — a brand/line token (>=4 chars) from the order
  //     item name must appear in the Prosol product name. Kills coincidental
  //     numeric-id collisions.
  const name = nameOf(p);
  if (itemName) {
    const toks = String(itemName).split(/\W+/).filter((t) => t.length >= 4);
    if (toks.length && !toks.some((t) => name.toLowerCase().includes(t.toLowerCase()))) {
      return { sku, decision: 'defer', reason: 'title does not corroborate product' };
    }
  }

  // (8) must have a real cost / be purchasable (offer present).
  const offer = await client.getOfferPrice(p.id);
  if (!offer || offer.cost_cad == null) return { sku, decision: 'defer', reason: 'no offer/cost' };

  return {
    sku,
    decision: 'map',
    entry: {
      api_sku: p.sku,
      prosol_sku: p.prosol_sku,
      product: name,
      cost_cad: offer.cost_cad,
      retail_cad: offer.retail_cad,
      source: 'auto-identity',
      cost_source: 'prosol-offers-loc10010',
      auto_discovered: true,
    },
  };
}

module.exports = { evaluate };
