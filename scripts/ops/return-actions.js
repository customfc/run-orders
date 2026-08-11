#!/usr/bin/env node
/**
 * Return actions — what to do about every refund, and what Prosol owes us.
 *
 * Two problems this answers, which look like one and are not:
 *
 * A) ROUTING. FBA returns (293 of 319) go to an Amazon fulfilment centre and
 *    never reach us, so there is nothing to route — that population is a
 *    write-off question, handled by v_refund_recovery. MFN returns physically
 *    come back, and every one shipped from a different Prosol branch while all
 *    of them return to one address. A Regina customer returns Regina stock and
 *    it lands in BC. This lists each one with the branch that shipped it, so
 *    the goods can go back for credit instead of becoming orphan stock.
 *
 * B) BILLING. When a buyer cancels or is refunded and the branch never tendered
 *    the parcel, the goods never left Prosol's building — but our PO is already
 *    Complete and Received (we receive at label purchase), so it reads as
 *    payable. PO-16000 is the worked example: buyer cancelled 2026-08-04, roll
 *    never picked, PO still sitting there at full value.
 *
 * The rule for B needs no judgement: refunded AND no carrier scan means claim,
 * not pay. Tracking is the arbiter, not anyone's memory.
 *
 * Usage:
 *   node scripts/ops/return-actions.js
 *   node scripts/ops/return-actions.js --days=180
 *   node scripts/ops/return-actions.js --csv
 */

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const sf = require('../../lib/salesforce');
const { v2Request } = require('../../lib/shipstation-v2');

const arg = (k, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const DAYS = Number(arg('days', 120));
const CSV = process.argv.includes('--csv');

const ROOT = path.join(__dirname, '..', '..');
const LOCATIONS = require(path.join(ROOT, 'scripts', 'shipstation', 'prosol-location-map.json'));
const BRANCH = {};
for (const [, loc] of Object.entries(LOCATIONS)) {
  if (loc.shipstation_warehouse_id) BRANCH[String(loc.shipstation_warehouse_id)] = `${loc.city} (${loc.code})`;
}

const money = (n) => '$' + Number(n || 0).toFixed(2);

/** A parcel that never left the branch has no carrier event beyond label creation. */
async function everTendered(shipmentId) {
  try {
    const r = await v2Request('GET', `/v2/labels/se-${shipmentId}/track`);
    if (r.status !== 200) return null;                    // unknown, never guess
    const d = JSON.parse(r.body);
    const events = d.events || [];
    if (!events.length) return false;
    return events.some((e) => !['NY', 'AC'].includes(e.status_code));
  } catch { return null; }
}

async function main() {
  const db = new Database(path.join(ROOT, 'data', 'analytics.sqlite'), { readonly: true });
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();

  // Every refunded unit in the window, with the label that shipped it.
  const refunds = db.prepare(`
    SELECT r.month, r.sku, r.amazon_order_id, r.refund_amount, r.outcome, r.unit_cost,
           sl.shipment_id, sl.tracking_number, sl.warehouse_id, sl.label_cost_cad
    FROM v_refund_recovery r
    LEFT JOIN shipping_labels sl ON sl.order_number = r.amazon_order_id
    WHERE r.month >= substr(?, 1, 7)
    ORDER BY r.month DESC`).all(since);

  // MFN returns physically coming back, with the branch that shipped them.
  const inbound = db.prepare(`
    SELECT ret.amazon_order_id, ret.seller_sku, substr(ret.return_date, 1, 10) AS day,
           ret.reason, ret.status, sl.warehouse_id, sl.tracking_number,
           COALESCE(sm.cost_cad, ic.cost_cad, 0) * COALESCE(sm.qty_per_unit, 1) AS unit_cost
    FROM amazon_returns ret
    LEFT JOIN shipping_labels sl ON sl.order_number = ret.amazon_order_id
    LEFT JOIN sku_map_canonical sm ON sm.amazon_msku = ret.seller_sku
    LEFT JOIN item_costs ic ON ic.sku = ret.seller_sku
    WHERE ret.channel = 'mfn' AND ret.return_date >= ?
    ORDER BY ret.return_date DESC`).all(since);

  // ── B) credit claims: refunded, and the parcel never moved ────────────────
  const claims = [];
  for (const r of refunds) {
    if (!r.shipment_id) continue;
    const tendered = await everTendered(r.shipment_id);
    if (tendered === false) claims.push({ ...r, branch: BRANCH[String(r.warehouse_id)] || `wh ${r.warehouse_id}` });
  }

  // Attach the Salesforce PO so accounting has the document to act on.
  if (claims.length) {
    try {
      const conn = await sf.connect();
      const tns = claims.map((c) => `'${c.tracking_number}'`).join(',');
      const pos = await conn.query(`SELECT Name, PBSI__Tracking_Code__c, PBSI__Order_Total__c, PBSI__Status__c
        FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Tracking_Code__c IN (${tns})`);
      const byTn = {};
      for (const p of pos.records) byTn[p.PBSI__Tracking_Code__c] = p;
      for (const c of claims) {
        const p = byTn[c.tracking_number];
        c.po = p ? p.Name : null;
        c.poTotal = p ? p.PBSI__Order_Total__c : null;
        c.poStatus = p ? p.PBSI__Status__c : null;
      }
    } catch (e) {
      console.error(`[return-actions] Salesforce lookup failed, POs omitted: ${e.message}`);
    }
  }

  if (CSV) {
    console.log('type,date,order,sku,branch,po,po_total,refund,label_cost,note');
    for (const c of claims) console.log(`claim,${c.month},${c.amazon_order_id},${c.sku},"${c.branch}",${c.po || ''},${c.poTotal ?? ''},${c.refund_amount},${c.label_cost_cad ?? ''},never tendered`);
    for (const i of inbound) console.log(`inbound,${i.day},${i.amazon_order_id},${i.seller_sku},"${BRANCH[String(i.warehouse_id)] || ''}",,,,,"${(i.reason || '').replace(/"/g, "'")}"`);
    return;
  }

  console.log(`\n═══ CREDIT CLAIMS — refunded, never left the branch (${DAYS}d) ═══`);
  if (!claims.length) console.log('  none');
  let claimTotal = 0;
  for (const c of claims) {
    claimTotal += Number(c.poTotal || 0);
    console.log(`  ${c.month}  ${String(c.amazon_order_id).padEnd(20)} ${String(c.sku).padEnd(16)} ${String(c.branch).padEnd(20)} ${String(c.po || 'no PO found').padEnd(10)} ${String(c.poStatus || '').padEnd(9)} PO ${money(c.poTotal)}  refunded ${money(c.refund_amount)}`);
  }
  if (claims.length) {
    console.log(`  → ${claims.length} PO(s), ${money(claimTotal)} that Prosol must not bill. Goods never left their building.`);
  }

  console.log(`\n═══ INBOUND RETURNS — physically coming back, by origin branch (${DAYS}d) ═══`);
  const byBranch = {};
  for (const i of inbound) {
    const b = BRANCH[String(i.warehouse_id)] || 'unknown origin';
    (byBranch[b] = byBranch[b] || []).push(i);
  }
  if (!Object.keys(byBranch).length) console.log('  none');
  for (const [b, items] of Object.entries(byBranch).sort((a, c) => c[1].length - a[1].length)) {
    const value = items.reduce((s, i) => s + Number(i.unit_cost || 0), 0);
    console.log(`  ${b.padEnd(22)} ${String(items.length).padStart(2)} unit(s)  ${money(value)} of stock`);
    for (const i of items) console.log(`      ${i.day}  ${String(i.seller_sku).padEnd(16)} ${money(i.unit_cost)}  ${String(i.reason || '').slice(0, 34)}`);
  }
  const orphanValue = inbound.reduce((s, i) => s + Number(i.unit_cost || 0), 0);
  if (inbound.length) {
    console.log(`\n  → ${inbound.length} unit(s), ${money(orphanValue)}, all landing at one return address while sourced from ${Object.keys(byBranch).length} branches.`);
    console.log('    Each is either returned to its origin branch for credit, or accepted as Sechelt stock at the cost shown.');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[return-actions] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
