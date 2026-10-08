#!/usr/bin/env node
/**
 * Monthly trim cost check (lib/trade-trim-costs.js). For every catalogue trim in the sku-map (source
 * catalog-schluter-*): Prosol's current cost (read only: one login, offers GETs paced at one a second, about 22
 * minutes), written to the Shopify inventory item's unit cost when it changed; then Mac gets an email with the changes
 * and every variant under the 5% floor at 25% off. Nothing is excluded or repriced automatically.
 *
 * Usage: node scripts/trade/trim-costs.js [--dry] [--first-sunday]
 *   --first-sunday  exit quietly unless today (BC) is the first Sunday of the month (the crontab runs it every Sunday)
 *   --dry           read and report to the console only: no Shopify writes, no email
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const tc = require(path.join(ROOT, 'lib', 'trade-trim-costs'));
const { isCatalogEntry } = require(path.join(ROOT, 'lib', 'trade-skumap'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const DRY = flag('dry');
const GAP_MS = 1000;
const LOG = path.join(ROOT, 'logs', 'trade-trim-costs.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bcNow = () => new Date(Date.now() - 7 * 3600 * 1000); // BC is UTC-7 all year
const log = (o) => { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`); };

async function main() {
  if (flag('first-sunday')) {
    const d = bcNow();
    if (d.getUTCDay() !== 0 || d.getUTCDate() > 7) return;
  }
  const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json'), 'utf8')).mappings;
  const entries = Object.entries(map).filter(([, e]) => isCatalogEntry(e));
  if (!entries.length) throw new Error('no catalogue entries in sku-map.json');

  // Shopify: price, inventory item and unit cost per catalogue SKU (one read per product)
  const shop = new Map();
  for (const handle of [...new Set(entries.map(([, e]) => e.shopify_handle).filter(Boolean))]) {
    const p = (await graphql(`query($h: String!) { productByIdentifier(identifier: { handle: $h }) { status variants(first: 250) {
      nodes { sku price inventoryItem { id unitCost { amount } } } } } }`, { h: handle })).data.productByIdentifier;
    if (!p || p.status !== 'ACTIVE') continue;
    for (const v of p.variants.nodes) shop.set(v.sku, { handle, price: v.price, inventoryItemId: v.inventoryItem.id, shopifyCost: v.inventoryItem.unitCost ? v.inventoryItem.unitCost.amount : null });
  }

  // Prosol: current cost, paced, one login; a session that drops is reopened once
  const { ProsolClientV2 } = require(path.join(ROOT, 'scripts', 'shipstation', 'prosol-client-v2'));
  let client = new ProsolClientV2();
  await client.init();
  let last = 0;
  let failures = 0;
  const rows = [];
  for (const [sku, e] of entries) {
    const s = shop.get(sku);
    if (!s) continue; // not live on Shopify
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let offer = null;
    try {
      offer = e.prosol_product_id ? await client.getOfferPrice(e.prosol_product_id) : await client.getCost(e.api_sku);
    } catch (err) {
      failures++;
      if (failures === 3) { try { await client.close(); } catch {} client = new ProsolClientV2(); await client.init(); }
      if (failures > 25) throw new Error(`Prosol keeps failing (${err.message}); stopped after ${rows.length} SKUs, nothing written`);
    }
    rows.push({ sku, ...s, prosolCost: offer ? offer.cost_cad : null });
  }
  try { await client.close(); } catch {}

  const plan = tc.planCosts(rows);
  console.log(`trim costs: ${rows.length} live variants, ${plan.updates.length} changed, ${plan.unchanged} unchanged, ${plan.missing.length} without a Prosol cost, ${plan.belowFloor.length} under the floor at 25% off${DRY ? ' (dry)' : ''}`);
  const failedUpdates = [];
  if (!DRY) {
    for (const u of plan.updates) {
      const r = (await graphql(`mutation($id: ID!, $i: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $i) { userErrors { message } } }`,
        { id: u.inventoryItemId, i: { cost: (u.toCents / 100).toFixed(2) } })).data.inventoryItemUpdate;
      if (r.userErrors.length) failedUpdates.push(`${u.sku}: ${r.userErrors[0].message}`);
    }
  }
  log({ event: 'run', dry: DRY, total: rows.length, updated: DRY ? 0 : plan.updates.length - failedUpdates.length, failed: failedUpdates.length, missing: plan.missing.length, belowFloor: plan.belowFloor.map((b) => b.sku) });
  const mail = tc.report(plan, { applied: !DRY, total: rows.length, failedUpdates });
  if (DRY || !mail) { if (mail) console.log(mail.subject); return; }
  await require(path.join(ROOT, 'lib', 'emailer')).sendEmail({ to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca', subject: mail.subject, html: mail.html });
  console.log(`emailed Mac: ${mail.subject}`);
}

main().catch((e) => { console.error(e.stack || e.message); log({ event: 'failed', error: e.message }); process.exit(1); });
