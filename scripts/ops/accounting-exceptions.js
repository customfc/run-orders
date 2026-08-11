#!/usr/bin/env node
/**
 * Accounting exceptions — things Lynnae and Melanie need to see before a cheque
 * goes out to Prosol.
 *
 * The leverage here is timing, not detection. Prosol's billing discipline is
 * good: they bill what they ship (five never-picked Brossard orders were never
 * invoiced), and they credit what they cancel (AP-30784, -$286.50 against
 * PO-15010). What actually costs money is an exception noticed after payment
 * instead of before it, because there is ~$139k of Prosol payables outstanding
 * at any time and an unpaid payable can simply be deducted.
 *
 * So every rule below keys off UNPAID payables and goes quiet once paid.
 *
 * RULES
 *   1. never-moved     Refunded/cancelled AND no carrier event beyond label
 *                      creation. Prosol still holds the goods, so nothing on
 *                      that PO is payable. Zero today — it should stay zero and
 *                      shout when it doesn't.
 *   2. duplicate-po    One tracking number carrying two POs. The 2026-07-24
 *                      incident, 12 parcels, $744.26. Guarded at source now;
 *                      this is the backstop.
 *   3. over-billed     Payable pre-tax subtotal above the PO value. Compared
 *                      PRE-TAX deliberately — comparing gross flags every
 *                      Ontario (13%) and Quebec (14.975%) shipment as fraud.
 *   4. return-orphan   An MFN return whose origin branch is not where it
 *                      landed. 26 units and $2,088 of stock from 14 branches
 *                      arriving at one address, each needing a credit from that
 *                      branch or acceptance as Sechelt stock.
 *
 * DESIGN RULE, learned the hard way today: an exception fires on POSITIVE
 * evidence only — a tracking event, a payable row, a duplicate. Never on
 * absence of data. Twice today an "absence means it happened" inference
 * produced a five-figure number that wasn't real.
 *
 * Usage:
 *   node scripts/ops/accounting-exceptions.js              report only
 *   node scripts/ops/accounting-exceptions.js --post       post to Chatter
 *   node scripts/ops/accounting-exceptions.js --days=180
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sf = require('../../lib/salesforce');
const { v2Request } = require('../../lib/shipstation-v2');

const ROOT = path.join(__dirname, '..', '..');
const STATE_FILE = path.join(ROOT, 'data', 'accounting-exceptions-state.json');
const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';

// Accounting. Real @mentions need the Connect API and these ids — typing
// "@Lynnae" into a FeedItem body renders as text and notifies nobody.
const ACCOUNTING = [
  { id: '0054x000005Ys0sAAC', name: 'Lynnae Grohs' },
  { id: '0054x000005Ys0rAAC', name: 'Melanie White' },
];

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const DAYS = Number(arg('days', 120));
const POST = process.argv.includes('--post');
const money = (n) => '$' + Number(n || 0).toFixed(2);

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { posted: {} }; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const LOCATIONS = require(path.join(ROOT, 'scripts', 'shipstation', 'prosol-location-map.json'));
const BRANCH = {};
for (const [, l] of Object.entries(LOCATIONS)) if (l.shipstation_warehouse_id) BRANCH[String(l.shipstation_warehouse_id)] = `${l.city} (${l.code})`;

async function neverMoved(shipmentId) {
  try {
    const r = await v2Request('GET', `/v2/labels/se-${shipmentId}/track`);
    if (r.status !== 200) return null;                       // unknown ≠ evidence
    const ev = JSON.parse(r.body).events || [];
    if (!ev.length) return null;                             // no data ≠ never moved
    return !ev.some(e => !['NY', 'AC'].includes(e.status_code));
  } catch { return null; }
}

async function main() {
  const db = new Database(path.join(ROOT, 'data', 'analytics.sqlite'), { readonly: true });
  const conn = await sf.connect();
  const q = async (soql) => (await conn.query(soql)).records;
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const exceptions = [];

  // Unpaid Prosol payables, keyed by PO. Everything else joins to this: a paid
  // payable is a debt-collection problem and out of scope by design.
  const unpaidByPo = {};
  let res = await conn.query(`SELECT Name, A2AS__Purchase_Order__c, AcctSeed__Total__c, AcctSeed__Sub_Total__c,
      AcctSeed__Paid_Amount__c, AcctSeed__Balance__c, AcctSeed__Date__c
    FROM AcctSeed__Account_Payable__c
    WHERE AcctSeed__Vendor__c = '${PROSOL_VENDOR_ID}' AND AcctSeed__Date__c >= ${since}
      AND A2AS__Purchase_Order__c != null AND AcctSeed__Balance__c > 0`);
  let payables = res.records;
  while (!res.done) { res = await conn.queryMore(res.nextRecordsUrl); payables = payables.concat(res.records); }
  for (const p of payables) (unpaidByPo[p.A2AS__Purchase_Order__c] = unpaidByPo[p.A2AS__Purchase_Order__c] || []).push(p);

  const poIds = Object.keys(unpaidByPo);
  const poById = {};
  for (let i = 0; i < poIds.length; i += 150) {
    const c = poIds.slice(i, i + 150).map(x => `'${x}'`).join(',');
    for (const p of await q(`SELECT Id, Name, PBSI__Order_Total__c, PBSI__Status__c, PBSI__Tracking_Code__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id IN (${c})`)) poById[p.Id] = p;
  }
  console.log(`Prosol payables unpaid since ${since}: ${payables.length} across ${poIds.length} PO(s)\n`);

  // ── Rule 1: refunded/cancelled, parcel never moved, still billed ──────────
  const refunded = db.prepare(`
    SELECT DISTINCT r.amazon_order_id, r.sku, r.refund_amount, sl.shipment_id, sl.tracking_number
    FROM v_refund_recovery r JOIN shipping_labels sl ON sl.order_number = r.amazon_order_id
    WHERE r.month >= substr(?, 1, 7) AND sl.shipment_id IS NOT NULL`).all(since);
  const poByTracking = {};
  for (const id of poIds) { const p = poById[id]; if (p && p.PBSI__Tracking_Code__c) poByTracking[p.PBSI__Tracking_Code__c] = p; }
  for (const r of refunded) {
    const po = poByTracking[r.tracking_number];
    if (!po) continue;
    const stuck = await neverMoved(r.shipment_id);
    if (stuck !== true) continue;
    const pays = unpaidByPo[po.Id] || [];
    exceptions.push({
      rule: 'never-moved', poId: po.Id, po: po.Name, amount: pays.reduce((s, p) => s + Number(p.AcctSeed__Balance__c || 0), 0),
      detail: `Order ${r.amazon_order_id} (${r.sku}) was refunded ${money(r.refund_amount)}, and waybill ${r.tracking_number} has no carrier scan — the goods never left Prosol. Payable ${pays.map(p => p.Name).join(', ')} is unpaid. Do not pay; request cancellation or credit.`,
    });
  }

  // ── Rule 2: one tracking number, two POs ─────────────────────────────────
  for (const g of await q(`SELECT PBSI__Tracking_Code__c, COUNT(Id) n FROM PBSI__PBSI_Purchase_Order__c
      WHERE PBSI__Tracking_Code__c != null AND CreatedDate >= ${since}T00:00:00Z
      GROUP BY PBSI__Tracking_Code__c HAVING COUNT(Id) > 1`)) {
    const dupes = await q(`SELECT Id, Name, PBSI__Order_Total__c FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Tracking_Code__c = '${g.PBSI__Tracking_Code__c}' ORDER BY CreatedDate`);
    const billed = dupes.filter(d => unpaidByPo[d.Id]);
    exceptions.push({
      rule: 'duplicate-po', poId: dupes[dupes.length - 1].Id, po: dupes.map(d => d.Name).join(' + '),
      amount: billed.reduce((s, d) => s + (unpaidByPo[d.Id] || []).reduce((t, p) => t + Number(p.AcctSeed__Balance__c || 0), 0), 0),
      detail: `Waybill ${g.PBSI__Tracking_Code__c} carries ${dupes.length} purchase orders (${dupes.map(d => `${d.Name} ${money(d.PBSI__Order_Total__c)}`).join(', ')}) for one physical parcel. Only one is real.`,
    });
  }

  // ── Rule 3: billed above PO value, pre-tax ───────────────────────────────
  for (const [poId, pays] of Object.entries(unpaidByPo)) {
    const po = poById[poId];
    if (!po || !po.PBSI__Order_Total__c) continue;
    const preTax = pays.reduce((s, p) => s + Number(p.AcctSeed__Sub_Total__c || 0), 0);
    if (!preTax) continue;
    const over = preTax - po.PBSI__Order_Total__c;
    if (over <= po.PBSI__Order_Total__c * 0.02 + 2) continue;
    exceptions.push({
      rule: 'over-billed', poId, po: po.Name, amount: over,
      detail: `Payable ${pays.map(p => p.Name).join(', ')} bills ${money(preTax)} before tax against a PO of ${money(po.PBSI__Order_Total__c)} — ${money(over)} more than ordered. Verify the unit cost against the PO line before paying; a supplier price rise between order and invoice looks identical to an error.`,
    });
  }

  // ── Rule 4: MFN return landed away from the branch that shipped it ────────
  const orphans = db.prepare(`
    SELECT ret.amazon_order_id, ret.seller_sku, substr(ret.return_date,1,10) day, sl.warehouse_id,
           COALESCE(sm.cost_cad, ic.cost_cad, 0) * COALESCE(sm.qty_per_unit, 1) AS unit_cost
    FROM amazon_returns ret
    JOIN shipping_labels sl ON sl.order_number = ret.amazon_order_id
    LEFT JOIN sku_map_canonical sm ON sm.amazon_msku = ret.seller_sku
    LEFT JOIN item_costs ic ON ic.sku = ret.seller_sku
    WHERE ret.channel = 'mfn' AND ret.return_date >= ? AND sl.warehouse_id IS NOT NULL`).all(since);
  const byBranch = {};
  for (const o of orphans) (byBranch[BRANCH[String(o.warehouse_id)] || `wh ${o.warehouse_id}`] = byBranch[BRANCH[String(o.warehouse_id)] || `wh ${o.warehouse_id}`] || []).push(o);

  // ── Report ───────────────────────────────────────────────────────────────
  const byRule = {};
  for (const e of exceptions) (byRule[e.rule] = byRule[e.rule] || []).push(e);
  for (const rule of ['never-moved', 'duplicate-po', 'over-billed']) {
    const list = byRule[rule] || [];
    console.log(`═══ ${rule.toUpperCase()} — ${list.length} exception(s), ${money(list.reduce((s, e) => s + e.amount, 0))} ═══`);
    for (const e of list) console.log(`  ${e.po.padEnd(22)} ${money(e.amount).padStart(10)}  ${e.detail.slice(0, 150)}`);
    if (!list.length) console.log('  none');
    console.log('');
  }
  const orphanValue = orphans.reduce((s, o) => s + Number(o.unit_cost || 0), 0);
  console.log(`═══ RETURN-ORPHAN — ${orphans.length} unit(s) from ${Object.keys(byBranch).length} branch(es), ${money(orphanValue)} ═══`);
  for (const [b, items] of Object.entries(byBranch).sort((a, c) => c[1].length - a[1].length))
    console.log(`  ${b.padEnd(22)} ${String(items.length).padStart(2)} unit(s)  ${money(items.reduce((s, i) => s + Number(i.unit_cost || 0), 0))}`);
  if (!orphans.length) console.log('  none');

  if (!POST) { console.log('\nREPORT ONLY — re-run with --post to Chatter these onto the PO records.'); return; }

  // ── Post to Chatter, once per exception ──────────────────────────────────
  const state = loadState();
  let posted = 0;
  for (const e of exceptions) {
    const key = `${e.rule}:${e.po}`;
    if (state.posted[key]) continue;
    const segments = [{ type: 'Text', text: `DO NOT PAY (${e.rule}) — ${money(e.amount)}\n\n${e.detail}\n\nFlagged automatically. ` }];
    for (const m of ACCOUNTING) { segments.push({ type: 'Mention', id: m.id }); segments.push({ type: 'Text', text: ' ' }); }
    try {
      await conn.requestPost('/services/data/v59.0/chatter/feed-elements', {
        feedElementType: 'FeedItem', subjectId: e.poId, body: { messageSegments: segments },
      });
      state.posted[key] = new Date().toISOString();
      posted++;
      console.log(`  posted ${key}`);
    } catch (err) {
      console.error(`  FAILED ${key}: ${err.message.slice(0, 160)}`);
    }
  }
  saveState(state);
  console.log(`\nposted ${posted} new Chatter note(s); ${exceptions.length - posted} already flagged previously.`);
}

if (require.main === module) main().catch(e => { console.error('[accounting-exceptions] ERROR:', e.message); process.exit(1); });
module.exports = { main };
