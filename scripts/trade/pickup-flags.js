#!/usr/bin/env node
/*
 * scripts/trade/pickup-flags.js: product metafield pickup.mode, read by the cart guard in the theme
 * (snippets/cart-pickup-guard.liquid). PICKUP-ZONES-PLAN.md 2.6, Mac 2026-10-02.
 *
 *   "only" = every variant is in the "Local pickup only" profile (full-length trims: no courier rate anywhere)
 *   "ok"   = every variant is in the Prosol profile (can share a pickup order: same "Pickup at our ..." rates)
 *   unset  = anything else (General, Tools, Extra Long, Pallets, Bulky, or split across profiles)
 *
 * The cart refuses to check out a cart holding an "only" product together with an unset product, because Shopify would
 * merge the rates into one "Shipping" charge and the trims can't ship. Re-run any time products move between profiles
 * (idempotent: writes only what changed, clears flags that no longer apply).
 *   node scripts/trade/pickup-flags.js            dry run
 *   node scripts/trade/pickup-flags.js --apply
 */

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));

const APPLY = process.argv.includes('--apply');
const PROFILES = { only: 'gid://shopify/DeliveryProfile/106780786855', ok: 'gid://shopify/DeliveryProfile/102840008871' };
const gql = async (q, v) => (await graphql(q, v)).data;

async function profileProducts(id) {
  const out = new Map();
  let after = null;
  do {
    const d = await gql(`query($id: ID!, $a: String) { deliveryProfile(id: $id) { profileItems(first: 50, after: $a) {
      pageInfo { hasNextPage endCursor } nodes { product { id variantsCount { count } } variants(first: 250) { nodes { id } } } } } }`, { id, a: after });
    for (const n of d.deliveryProfile.profileItems.nodes) out.set(n.product.id, n.variants.nodes.length === n.product.variantsCount.count);
    after = d.deliveryProfile.profileItems.pageInfo.hasNextPage ? d.deliveryProfile.profileItems.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function currentFlags() {
  const out = new Map();
  let after = null;
  do {
    const d = await gql(`query($a: String) { products(first: 250, after: $a, query: "metafields.pickup.mode:*") { pageInfo { hasNextPage endCursor }
      nodes { id metafield(namespace: "pickup", key: "mode") { value } } } }`, { a: after });
    for (const n of d.products.nodes) if (n.metafield) out.set(n.id, n.metafield.value);
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

(async () => {
  const want = new Map();
  for (const [mode, id] of Object.entries(PROFILES)) {
    for (const [pid, whole] of await profileProducts(id)) if (whole) want.set(pid, mode);
  }
  const have = await currentFlags();
  const set = [...want].filter(([pid, m]) => have.get(pid) !== m);
  const clear = [...have.keys()].filter((pid) => !want.has(pid));
  const counts = [...want.values()].reduce((a, m) => ({ ...a, [m]: (a[m] || 0) + 1 }), {});
  console.log(`${APPLY ? '' : '[dry] '}pickup.mode wanted: ${JSON.stringify(counts)}; to set ${set.length}, to clear ${clear.length}`);
  if (!APPLY) return;
  for (let i = 0; i < set.length; i += 25) {
    const r = await gql(`mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
      { m: set.slice(i, i + 25).map(([ownerId, value]) => ({ ownerId, namespace: 'pickup', key: 'mode', type: 'single_line_text_field', value })) });
    if (r.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(r.metafieldsSet.userErrors));
  }
  for (let i = 0; i < clear.length; i += 25) {
    const r = await gql(`mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`,
      { m: clear.slice(i, i + 25).map((ownerId) => ({ ownerId, namespace: 'pickup', key: 'mode' })) });
    if (r.metafieldsDelete.userErrors.length) throw new Error(JSON.stringify(r.metafieldsDelete.userErrors));
  }
  const after = await currentFlags();
  const ok = [...want].every(([pid, m]) => after.get(pid) === m) && clear.every((pid) => !after.has(pid));
  console.log(`READ-BACK: ${after.size} flagged, ${ok ? 'matches' : 'MISMATCH'}`);
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
