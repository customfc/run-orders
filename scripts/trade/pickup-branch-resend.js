#!/usr/bin/env node
/**
 * Re-send a counter pickup's branch email with our PO number and Prosol's item codes, for orders
 * the pickup runner sent before 285539d (it sent on the first tick with no PO, the Shopify SKU, and no stock check;
 * #1405 Regina, 2026-10-02). Uses the order's Salesforce PO; with --send and none yet (the pipeline's last stage pass
 * is 13:30 Toronto time), makes the SO + PO the SO reconcile's way first.
 *
 *   node scripts/trade/pickup-branch-resend.js '#1405'          dry run: prints the email, writes nothing
 *   node scripts/trade/pickup-branch-resend.js '#1405' --send   makes the PO if needed, sends (Mac's per-email OK),
 *                                                                records the PO in the runner state
 */

'use strict';

require('dotenv').config();
const R = require('../../lib/pickup-runner');
const bp = require('../../lib/branch-pickup');
const pio = require('../../lib/pickup-io');
const sf = require('../../lib/salesforce');
const { graphql } = require('../../lib/shopify-graphql');
const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');

async function poFor(orderName) {
  const digits = String(orderName).replace(/\D/g, '');
  const conn = await sf.connect();
  const rows = await sf.query(conn, `SELECT PBSI__Purchase_Order__r.Name, PBSI__Sales_Order__r.Name, PBSI__Sales_Order__r.PBSI__Customer_Purchase_Order__c
    FROM PBSI__PBSI_Purchase_Order_Line__c WHERE PBSI__Sales_Order__r.PBSI__Customer_Purchase_Order__c LIKE '%${digits}%' AND CreatedDate = LAST_N_DAYS:60`);
  const re = new RegExp(`(^|[^0-9])${digits}([^0-9]|$)`);
  const pos = [...new Set(rows.filter((x) => re.test((x.PBSI__Sales_Order__r || {}).PBSI__Customer_Purchase_Order__c || '')).map((x) => x.PBSI__Purchase_Order__r && x.PBSI__Purchase_Order__r.Name).filter(Boolean))];
  if (pos.length > 1) throw new Error(`${orderName} has ${pos.length} POs: ${pos.join(', ')}`);
  return pos[0] || null;
}

(async () => {
  const name = process.argv[2];
  const send = process.argv.includes('--send');
  if (!/^#?\d+$/.test(name || '')) throw new Error("usage: pickup-branch-resend.js '#1405' [--send]");
  const orderName = name.startsWith('#') ? name : `#${name}`;
  const state = R.loadState();
  const rec = (state.orders || {})[orderName];
  if (!rec || rec.kind !== 'branch') throw new Error(`${orderName} is not a counter pickup in the runner state`);
  const branches = R.loadBranches();
  const b = branches.find((x) => x.code === rec.branch);
  const gql = async (q, v) => (await graphql(q, v)).data;
  const order = await R.fetchOrder(gql, rec.id);
  if (!order || order.cancelledAt) throw new Error(`${orderName} not found or cancelled`);

  const lines = order.lines.filter((l) => l.current > 0).map((l) => ({ sku: l.sku, ...R.prosolCodes(l.sku), quantity: l.current }));
  const client = new ProsolClientV2();
  let stock;
  try { await client.init(); stock = bp.checkStock(lines, b.map_code || b.code, await pio.branchStock(client, lines, b.map_code || b.code, branches)); }
  finally { try { await client.close(); } catch {} }

  // No transfer arrangement with Prosol (Mac 2026-10-02): the counter has to have it all.
  if (stock.status !== 'READY') throw new Error(`${b.pickup_label} doesn't have everything for ${orderName}, nothing to send: ${stock.lines.map((l) => `${l.prosolSku} x ${l.quantity} (has ${l.have})`).join(', ')}`);
  let poNumber = await poFor(orderName);
  if (!poNumber && send) poNumber = await pio.ensurePo(orderName, require('../../lib/shopify-sf'), sf);
  if (!poNumber) poNumber = 'PO-(made on --send)';
  const email = bp.buildPickupEmail({ order: { name: orderName, customer: { firstName: order.firstName, lastName: order.lastName } }, branch: { code: b.code, city: b.pickup_label }, lines, poNumber });
  const body = `This replaces our earlier email for order ${orderName}: it adds our PO number and your item code.\n\n${email.body}`;
  const to = process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca';
  const cc = [b.email, process.env.MAC_CC_EMAIL || 'mac@customfc.ca'].filter(Boolean).join(', ');
  console.log(`To: ${to}\nCc: ${cc}\nSubject: ${email.subject}\n\n${body}\n\n(stock: ${stock.status})`);
  if (!send) return console.log('\nDry run. Add --send to send it.');
  await require('../../lib/emailer').sendEmail({ to, cc, subject: email.subject, text: body,
    html: `<pre style="font-family:Arial,sans-serif;font-size:14px">${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>` });
  const s2 = R.loadState();
  Object.assign(s2.orders[orderName], { poNumber, resentAt: new Date().toISOString() });
  R.saveState(s2);
  console.log(`\nSent. ${orderName} now records ${poNumber}.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
