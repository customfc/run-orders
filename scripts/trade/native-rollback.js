#!/usr/bin/env node
/**
 * Before-state and rollback for the native counter pickup switch (2026-10-02): the pickup-profile variants' inventory
 * policy and their counts at the shipping warehouses (Calgary, Ontario, Quebec, Vancouver), which
 * scripts/trade/counter-stock-sync.js --apply changes. Pickup itself is rolled back with native-counters.js pickup-off.
 *
 *   node scripts/trade/native-rollback.js snapshot                          read-only: data/trade/native-before/<ts>.json
 *   node scripts/trade/native-rollback.js restore --before=<file>           print what restore would write
 *   node scripts/trade/native-rollback.js restore --before=<file> --live    put the policies and those counts back
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { graphql } = require('../../lib/shopify-graphql');
const { PROFILES, POOL } = require('./counter-stock-sync');

const DIR = path.join(ROOT, 'data', 'trade', 'native-before');
const WAREHOUSES = [POOL.locationId, ...POOL.zero];
const args = process.argv.slice(2);
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(q, v) { const r = await graphql(q, v); if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 400)); return r.data; }

async function snapshot() {
  const q = `{ productVariants { edges { node { id product { id } inventoryPolicy deliveryProfile { id } inventoryItem { id inventoryLevels { edges { node { location { id } quantities(names: ["available"]) { quantity } } } } } } } } }`;
  const s = await gql(`mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id } userErrors { field message } } }`, { q });
  if (s.bulkOperationRunQuery.userErrors.length) throw new Error(JSON.stringify(s.bulkOperationRunQuery.userErrors));
  let op;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    op = (await gql(`{ currentBulkOperation { status objectCount url errorCode } }`)).currentBulkOperation;
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(op.status)) break;
  }
  if (op.status !== 'COMPLETED') throw new Error(`bulk export ${op.status} ${op.errorCode || ''}`);
  const rows = (await (await fetch(op.url)).text()).trim().split('\n').map((l) => JSON.parse(l));
  const want = new Set(PROFILES.map((p) => p.id));
  const wh = new Set(WAREHOUSES);
  const variants = new Map();
  for (const r of rows) {
    if (r.id && r.id.includes('/ProductVariant/')) { if (r.deliveryProfile && want.has(r.deliveryProfile.id)) variants.set(r.id, { id: r.id, productId: r.product.id, itemId: r.inventoryItem.id, policy: r.inventoryPolicy, levels: {} }); }
    else if (r.location && r.__parentId && variants.has(r.__parentId) && wh.has(r.location.id)) variants.get(r.__parentId).levels[r.location.id] = (r.quantities[0] || {}).quantity || 0;
  }
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), warehouses: WAREHOUSES, variants: [...variants.values()] }, null, 1));
  const pol = [...variants.values()].reduce((m, v) => ({ ...m, [v.policy]: (m[v.policy] || 0) + 1 }), {});
  console.log(`${variants.size} pickup-profile variants (${JSON.stringify(pol)}) -> ${path.relative(ROOT, file)}`);
}

async function restore(file, live) {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byProduct = new Map();
  for (const v of before.variants) byProduct.set(v.productId, [...(byProduct.get(v.productId) || []), v]);
  const sets = before.variants.flatMap((v) => Object.entries(v.levels).map(([loc, qty]) => ({ inventoryItemId: v.itemId, locationId: loc, quantity: qty })));
  console.log(`restore ${before.variants.length} variants' policies (${byProduct.size} products) and ${sets.length} warehouse counts from ${before.at}`);
  if (!live) return;
  for (const [productId, vs] of byProduct) {
    const r = await gql(`mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { message } } }`,
      { p: productId, v: vs.map((v) => ({ id: v.id, inventoryPolicy: v.policy })) });
    if (r.productVariantsBulkUpdate.userErrors.length) console.error(productId, JSON.stringify(r.productVariantsBulkUpdate.userErrors));
  }
  for (let i = 0; i < sets.length; i += 250) {
    const r = await gql(`mutation($in: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $in) { userErrors { message } } }`,
      { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, referenceDocumentUri: 'gid://yourfloors/NativeRollback/restore', quantities: sets.slice(i, i + 250) } });
    if (r.inventorySetQuantities.userErrors.length) console.error(`batch ${i}`, JSON.stringify(r.inventorySetQuantities.userErrors).slice(0, 300));
  }
  console.log('restored');
}

if (require.main === module) {
  (args[0] === 'snapshot' ? snapshot() : args[0] === 'restore' ? restore(opt('before'), args.includes('--live')) : Promise.reject(new Error('snapshot | restore --before=<file> [--live]')))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
