#!/usr/bin/env node
/**
 * FBA FNSKU-state scanner.
 *
 * Amazon CA no longer accepts stickerless / manufacturer-barcode inbound
 * (fnSku == ASIN). Such SKUs fail createInboundPlan with FBA_INB_0465 and
 * MUST be relisted as offer-only SKUs to get an X00 FNSKU before restock.
 * See memory reference_fba_reseller_amazon_barcode + skill fba-restock.
 *
 * This is the "is this SKU restock-ready?" check. Read-only.
 * Flags every broken SKU, ranks by trailing FBA revenue, and says whether
 * it can convert NOW (no FBA stock on the ASIN) or needs stranded stock
 * cleared first (the registration-blocking gotcha).
 *
 * Usage: node scripts/fba/scan-fnsku-state.js [--all] [--asin=B0...]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');
const DB = path.join(__dirname, '..', '..', 'data', 'analytics.sqlite');
const TODAY = new Date().toISOString().slice(0, 10);

function latestSnap(prefix) {
  const f = fs.readdirSync(SNAP_DIR).filter(x => x.startsWith(prefix) && x.endsWith('.json')).sort();
  return f.length ? path.join(SNAP_DIR, f[f.length - 1]) : null;
}

function fbaUnitsOnRow(r) {
  // any FBA units present on the ASIN under this SKU (blocks instant convert)
  return ['available', 'inbound-quantity', 'reserved-customer-order', 'unfulfillable-quantity',
    'fc-transfer', 'fc-processing', 'inbound-working', 'inbound-shipped', 'inbound-received']
    .reduce((s, k) => s + (Number(r[k]) || 0), 0);
}

(function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const onlyAsin = (args.find(a => a.startsWith('--asin=')) || '').split('=')[1] || null;

  const snapPath = latestSnap('restock-recs-');
  if (!snapPath) { console.error('No restock-recs snapshot found.'); process.exit(1); }
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const rows = Array.isArray(snap) ? snap : Object.values(snap).find(v => Array.isArray(v));

  // trailing FBA revenue by ASIN for priority ranking
  const rev = {};
  try {
    const db = new Database(DB, { readonly: true });
    for (const x of db.prepare(
      "SELECT i.asin asin, SUM(i.item_price_amount) rev180, " +
      "SUM(CASE WHEN o.purchase_date>=date('" + TODAY + "','-90 day') THEN i.qty_ordered ELSE 0 END) u90 " +
      "FROM amazon_orders o JOIN amazon_order_items i ON i.amazon_order_id=o.amazon_order_id " +
      "WHERE o.fulfillment_channel='AFN' AND o.order_status!='Canceled' AND o.purchase_date>=date('" + TODAY + "','-180 day') " +
      "GROUP BY i.asin").all()) rev[x.asin] = { rev180: Math.round(x.rev180 || 0), u90: x.u90 || 0 };
    db.close();
  } catch (e) { console.error('(revenue join skipped: ' + e.message + ')'); }

  let scan = rows.map(r => {
    const broken = r.fnsku === r.asin || /^B0/.test(r.fnsku || '');
    const units = fbaUnitsOnRow(r);
    return {
      sku: r.sku, asin: r.asin, fnsku: r.fnsku, broken,
      name: (r['product-name'] || '').slice(0, 38),
      fbaUnits: units,
      convert: broken ? (units === 0 ? 'NOW' : 'clear-first') : '—',
      rev180: (rev[r.asin] || {}).rev180 || 0,
      u90: (rev[r.asin] || {}).u90 || 0,
    };
  });
  if (onlyAsin) scan = scan.filter(s => s.asin === onlyAsin);

  const broken = scan.filter(s => s.broken).sort((a, b) => b.rev180 - a.rev180);
  const ready = scan.filter(s => !s.broken);
  const list = showAll ? scan.sort((a, b) => b.rev180 - a.rev180) : broken;

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const lp = (s, n) => String(s).padStart(n);
  console.log('\nFBA FNSKU-STATE SCAN — ' + TODAY + '  (snapshot: ' + path.basename(snapPath) + ')\n');
  console.log(pad('Seller SKU', 17) + pad('Product', 38) + lp('rev180', 8) + lp('u90', 5) + lp('FBAu', 5) + '  CONVERT');
  console.log('-'.repeat(92));
  for (const s of list) {
    const flag = s.convert === 'NOW' ? '✅ NOW' : s.convert === 'clear-first' ? '⛔ clear stock first' : (s.broken ? '' : '— ok (X00)');
    console.log(pad(s.sku, 17) + pad(s.name, 38) + lp('$' + s.rev180, 8) + lp(s.u90, 5) + lp(s.fbaUnits, 5) + '  ' + flag);
  }
  const now = broken.filter(s => s.convert === 'NOW');
  const blocked = broken.filter(s => s.convert === 'clear-first');
  console.log('\nTotal FBA SKUs: ' + scan.length + '  |  ✅ already X00 (ready): ' + ready.length +
    '  |  ⚠️ broken (need relist): ' + broken.length);
  console.log('   of broken → convert NOW (0 FBA stock): ' + now.length + '  |  ⛔ clear stranded stock first: ' + blocked.length);
  console.log('   broken-SKU revenue at stake (trailing 180d): $' + broken.reduce((s, x) => s + x.rev180, 0).toLocaleString());
  console.log('\nNext: node scripts/fba/relist-fba-sku.js --old-sku=<sku> --validate   (then --commit)');
})();
