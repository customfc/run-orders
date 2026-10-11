#!/usr/bin/env node
/**
 * Discontinued-at-Prosol desk (lib/discontinued.js).
 *
 *   node scripts/ops/discontinued.js status
 *       every order the desk knows, with its status
 *
 *   node scripts/ops/discontinued.js offered --order=1412 --sku=32014 --sub=14534 \
 *       --display="Rubi Nipper for Glass Mosaic" --kind="glass nipper" --reply-word=Rubi --at=2026-10-11T18:31:46Z
 *       record a swap offer that was emailed by hand, so the desk carries it from here: emails Mac the
 *       Ship the swap / Refund links now and nudges if the customer stays quiet. Sends nothing to the customer.
 *
 * Runs on the Mac Mini (Prosol session, Shopify, hello@ SMTP all come from run-orders' .env).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const desk = require('../../lib/discontinued');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };

async function offered() {
  const n = desk.normOrder(arg('order'));
  const sku = arg('sku');
  const subId = Number(arg('sub'));
  const at = arg('at') || new Date().toISOString();
  if (!n || !sku || !subId) throw new Error('need --order, --sku and --sub (Prosol product id of the substitute)');
  const entry = require('../../lib/sku-map-file').readSkuMap().mappings[sku] || {};
  const strip = (s) => String(s || '').replace(/^HALT_DISCONTINUED_/, '') || null;

  const f = await desk.shopifyFacts(n, sku);
  if (f.closedReason) throw new Error(`order ${n} was ${f.closedReason}; nothing to carry`);
  if (!f.line) throw new Error(`SKU ${sku} is not a line on Shopify order ${n}`);
  const q = await desk.suggestRefund(f);

  const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');
  const client = new ProsolClientV2();
  await client.init();
  let sub;
  try { sub = await desk.productDetails(client, subId); } finally { await client.close(); }
  const problem = desk.substituteProblem(sub, { qty: f.line.qty, paidUnit: f.line.unit });
  if (problem) throw new Error(problem);

  const state = desk.loadState();
  const rec = {
    orderNumber: n, sku, itemName: f.line.title, lineTitle: f.line.title, qty: f.line.qty, paidUnit: f.line.unit,
    apiSku: strip(entry.api_sku) || sku, prosolSku: strip(entry.prosol_sku),
    channel: 'shopify', orderDate: f.createdAt,
    customer: { email: f.email, firstName: f.firstName, name: f.fullName, city: f.city, province: f.province },
    shopify: { id: f.id, productId: f.line.productId, lineId: f.line.id },
    refund: { full: q.full, amount: q.amount },
    gone: { checkedAt: at, evidence: [`checked by hand before the offer (${entry.note ? 'see the sku-map note' : 'no sku-map note'})`] },
    substitute: {
      ...sub, displayName: arg('display') || sub.name, kind: arg('kind') || 'replacement', replyWord: arg('reply-word') || 'yes',
      confidence: 'high', why: 'Chosen by hand in a Claude session and approved by Mac.',
      inCustomerProvince: sub.stock.some((s) => s.province === f.province),
    },
    status: 'offered', firstSeenAt: at, offeredAt: at, attempts: 0,
    actions: [{ action: 'offer', at, done: ['offer emailed by hand from hello@ (Claude session)'] }],
  };
  const m = desk.macEmail(rec);
  await require('../../lib/emailer').sendEmail({ to: process.env.DISCONTINUED_EMAIL || process.env.SKU_RESOLVER_EMAIL || process.env.MAC_CC_EMAIL || 'mac@customfc.ca', subject: m.subject, text: m.text });
  rec.lastEmailAt = new Date().toISOString();
  state.orders[n] = rec;
  desk.saveState(state);
  console.log(`order ${n}: recorded as offered (${sub.name}, product ${sub.productId}); refund on tap would be $${q.amount.toFixed(2)}${q.full ? ' (full)' : ' (line)'}`);
  console.log(`emailed Mac: ${m.subject}`);
}

function status() {
  const orders = Object.values(desk.loadState().orders);
  if (!orders.length) return console.log('no orders');
  for (const r of orders) {
    console.log(`${r.orderNumber}  ${r.status.padEnd(14)} ${r.sku}  ${r.substitute ? `-> ${r.substitute.sku} ${r.substitute.name}` : (r.substituteNote || '')}  last email ${r.lastEmailAt || '-'}`);
  }
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'offered') await offered();
  else if (cmd === 'status') status();
  else { console.log('usage: discontinued.js status | offered --order= --sku= --sub= [--display= --kind= --reply-word= --at=]'); process.exit(2); }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
