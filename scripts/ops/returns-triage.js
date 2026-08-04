#!/usr/bin/env node
/**
 * Returns triage — decide what to do with every open Amazon return.
 *
 * Amazon auto-authorises most returns, so they sit in the queue doing nothing
 * until someone acts. Left alone they turn into A-to-Z claims, which cost the
 * refund AND the account-health hit. The queue is not the problem; having no
 * rule for clearing it is.
 *
 * The decision that actually matters is whether it is worth paying to get the
 * item back. A $25 tube of grout with a $17 return label is worth more written
 * off than recovered, and every day it sits is risk for no upside.
 *
 * Buckets:
 *   ESCALATED             A-to-Z filed — handle before anything else.
 *   REFUND_NOW_NO_RETURN  never arrived, or our fault and not worth freight.
 *                         There is nothing to wait for; delay only adds an A-to-Z.
 *   NEEDS_REVIEW          unauthorised-purchase / chargeback shape. Decide by hand.
 *   NEEDS_COST            no COGS on file, so recovery cannot be judged. Never
 *                         assume cheap — two of these were ~$200 items.
 *   REFUND_NOW_RECOVER    our fault but worth getting back. Refund fast, chase item.
 *   REFUNDLESS            buyer remorse, return freight >= what we'd recover.
 *                         Refund and let them keep it.
 *   AWAIT_ITEM            buyer remorse, worth recovering. Wait, then refund.
 *
 * Read-only. Prints a decision per return; issuing refunds stays manual.
 *
 * Usage:
 *   node scripts/ops/returns-triage.js
 *   node scripts/ops/returns-triage.js --json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');
const AS_JSON = process.argv.includes('--json');
// Roughly what a parcel return costs us once the label and handling are in.
const RETURN_COST = Number((process.argv.find((a) => a.startsWith('--return-cost=')) || '').split('=')[1] || 16);

const newest = (dir, p) => {
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(p) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const g = (row, ...names) => { for (const n of names) if (row[n] != null && String(row[n]).trim() !== '') return String(row[n]).trim(); return ''; };

// Amazon supplies machine codes (CR-MISSING_PARTS), not prose. Matching on
// English phrases silently misfiled everything — the never-received parcel
// landed in AWAIT_ITEM, i.e. waiting on the return of an item that never
// shipped. Classify off the codes.
const SELLER_FAULT = new Set([
  'CR-DEFECTIVE', 'CR-SWITCHEROO', 'CR-MISSING_PARTS', 'CR-NOT_AS_DESCRIBED',
  'CR-MISSED_ESTIMATED_DELIVERY', 'CR-QUALITY_UNACCEPTABLE',
  'CR-DAMAGED_BY_CARRIER', 'CR-DAMAGED_BY_FC', 'CR-ARRIVED_LATE',
]);
const BUYER_REMORSE = new Set([
  'CR-UNWANTED_ITEM', 'CR-NOT_COMPATIBLE', 'CR-ORDERED_WRONG_ITEM',
  'CR-NO_REASON_GIVEN', 'CR-FOUND_BETTER_PRICE',
]);
const NEEDS_REVIEW = new Set(['CR-UNAUTHORIZED_PURCHASE']);
// "I never got it" — there is no item to wait for, and if the parcel is one of
// our un-tendered ones the customer is simply right.
const NEVER_ARRIVED_TEXT = /n.?ai pas re[çc]u|never (arrived|received)|not received|jamais re[çc]u|no.?t deliver/i;

(async () => {
  const returns = JSON.parse(fs.readFileSync(newest(DATA, 'returns-'), 'utf8'));
  const skuMap = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;

  const db = new Database(path.join(DATA, 'analytics.sqlite'), { readonly: true });
  const priceByOrderSku = {};
  for (const r of db.prepare(`
    SELECT amazon_order_id, seller_sku, asin, SUM(item_price_amount) price, SUM(qty_ordered) qty
    FROM amazon_order_items GROUP BY amazon_order_id, seller_sku
  `).all()) priceByOrderSku[`${r.amazon_order_id}|${norm(r.seller_sku)}`] = r;
  const costBySku = {};
  for (const r of db.prepare('SELECT sku, cost_cad, prosol_sku FROM item_costs').all()) {
    if (r.sku) costBySku[norm(r.sku)] = r.cost_cad;
    if (r.prosol_sku) costBySku[norm(r.prosol_sku)] = r.cost_cad;
  }
  db.close();
  for (const v of Object.values(skuMap)) {
    if (v && typeof v === 'object' && v.cost_cad != null) {
      for (const f of ['prosol_sku', 'api_sku']) if (v[f]) costBySku[norm(v[f])] ??= Number(v.cost_cad);
    }
  }

  const rows = [];
  for (const r of returns) {
    const order = g(r, 'Order ID', 'order-id', 'Order Id');
    const sku = g(r, 'Merchant SKU', 'merchant-sku', 'sku');
    const asin = g(r, 'ASIN', 'asin');
    const reason = g(r, 'Return reason', 'Return Reason', 'reason');
    const comment = g(r, 'Buyer comment', 'Buyer Comment', 'customer-comments');
    const status = g(r, 'Return request status', 'status');
    const atoz = g(r, 'A-to-Z Claim', 'a-to-z-claim');
    const payer = g(r, 'Label to be paid by');
    const qty = Number(g(r, 'Return quantity', 'quantity') || 1);
    const reqDate = g(r, 'Return request date', 'return-request-date');
    const days = reqDate ? Math.round((Date.now() - Date.parse(reqDate)) / 864e5) : null;

    const oi = priceByOrderSku[`${order}|${norm(sku)}`];
    const value = oi ? Number(oi.price) : null;
    const entry = skuMap[asin];
    const ps = entry?.prosol_sku || entry?.api_sku;
    const cost = ps ? (costBySku[norm(ps)] ?? null) : (costBySku[norm(sku)] ?? null);

    const code = reason.toUpperCase();
    const neverArrived = NEVER_ARRIVED_TEXT.test(comment) || code === 'CR-MISSING_PARTS';
    const ourFault = SELLER_FAULT.has(code) || neverArrived;
    const needsReview = NEEDS_REVIEW.has(code);
    const costKnown = cost != null && Number(cost) > 0;
    // Recovering a unit is only worth it if what we'd get back beats the
    // return cost. Use our cost as the recovery value: a returned unit goes
    // back into sellable stock at cost, not at retail.
    const recover = cost != null ? cost * qty : null;
    const worthRecovering = recover != null && recover > RETURN_COST * 1.5;

    let bucket, why;
    if (String(atoz).toUpperCase() === 'Y') { bucket = 'ESCALATED'; why = 'A-to-Z claim filed — handle first'; }
    else if (neverArrived) { bucket = 'REFUND_NOW_NO_RETURN'; why = 'buyer never received it — there is no item to wait for'; }
    else if (needsReview) { bucket = 'NEEDS_REVIEW'; why = `${code} — possible fraud/chargeback, decide by hand`; }
    else if (!costKnown) { bucket = 'NEEDS_COST'; why = 'no cost on file — cannot judge recovery, and value may be high'; }
    else if (ourFault && !worthRecovering) { bucket = 'REFUND_NOW_NO_RETURN'; why = `our fault (${code}) and recovery ${money(recover)} < ${money(RETURN_COST)} return cost`; }
    else if (ourFault) { bucket = 'REFUND_NOW_RECOVER'; why = `our fault (${code}); worth recovering at ${money(recover)}`; }
    else if (!worthRecovering) { bucket = 'REFUNDLESS'; why = `remorse (${code}); recovery ${money(recover)} < return cost ${money(RETURN_COST)}×1.5`; }
    else { bucket = 'AWAIT_ITEM'; why = `remorse (${code}); recovery ${money(recover)} beats ${money(RETURN_COST)}`; }

    rows.push({ order, sku, asin, reason, comment, status, atoz, payer, qty, days, value, cost, recover, bucket, why,
      item: g(r, 'Item Name', 'item-name').slice(0, 60) });
  }

  rows.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  if (AS_JSON) { console.log(JSON.stringify(rows, null, 1)); return; }

  const B = ['ESCALATED', 'REFUND_NOW_NO_RETURN', 'NEEDS_REVIEW', 'NEEDS_COST', 'REFUND_NOW_RECOVER', 'REFUNDLESS', 'AWAIT_ITEM'];
  console.log(`OPEN RETURNS: ${rows.length}   (return cost assumption ${money(RETURN_COST)})\n`);
  for (const b of B) {
    const set = rows.filter((r) => r.bucket === b);
    if (!set.length) continue;
    const exposure = set.reduce((s, r) => s + (r.value || 0), 0);
    console.log(`═══ ${b} — ${set.length} return(s), ${money(exposure)} refund exposure ═══`);
    for (const r of set) {
      console.log(`  ${String(r.days + 'd').padStart(5)}  ${r.order}  ${String(r.sku).slice(0, 16).padEnd(17)} ${money(r.value).padStart(9)}  cost ${money(r.cost).padStart(8)}`);
      console.log(`         ${r.item}`);
      console.log(`         reason: ${r.reason}${r.comment ? `  |  "${r.comment.slice(0, 70)}"` : ''}`);
      console.log(`         → ${r.why}`);
    }
    console.log();
  }

  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  const refundNow = rows.filter((r) => ['REFUND_NOW_NO_RETURN', 'REFUND_NOW_RECOVER', 'ESCALATED'].includes(r.bucket));
  console.log('────────────────────────────────────────────────');
  console.log(`total refund exposure sitting in the queue : ${money(total)}`);
  console.log(`needs action today (our fault / A-to-Z)    : ${refundNow.length} returns, ${money(refundNow.reduce((s, r) => s + (r.value || 0), 0))}`);
  console.log(`oldest open return                         : ${rows[0]?.days ?? '?'} days`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
