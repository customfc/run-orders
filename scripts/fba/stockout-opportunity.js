#!/usr/bin/env node
/**
 * Find the SKUs a trailing-window ranking cannot see.
 *
 * build-replen-po.js ranks on the last 12 months of FBA revenue. Anything
 * stocked out for longer than that window has no recent revenue and therefore
 * never surfaces — the deepest holes are invisible *because* they have been
 * broken longest. This looks at the entire sales history instead and asks a
 * different question: what did this SKU earn per month when it actually had
 * stock, and is that money currently unavailable to us?
 *
 * Method:
 *   - Take every month a SKU recorded FBA sales, back to the start of history.
 *   - Earning rate = MEDIAN monthly revenue across those months. Median rather
 *     than mean so one freak month doesn't inflate the estimate.
 *   - Annualised opportunity = median monthly revenue x 12.
 *   - Classify by why it stopped:
 *       STOCKED_OUT   sold before, zero stock now → recoverable by buying
 *       NO_OFFER      has stock or supply but no live listing → recoverable free
 *       DECAYED       stock available and still no sales → real demand decline
 *   - Cross-reference Prosol so "recoverable" means actually sourceable.
 *
 * Read-only.
 *
 * Usage:
 *   node scripts/fba/stockout-opportunity.js
 *   node scripts/fba/stockout-opportunity.js --min-months=2 --quiet-months=3
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sp = require('../../lib/sp-api');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'fba');
const SNAPS = path.join(DATA, 'snapshots');
const DB_PATH = path.join(ROOT, 'data', 'analytics.sqlite');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const MIN_MONTHS = Number(arg('min-months', 2));      // needs a track record, not one fluke sale
const QUIET_MONTHS = Number(arg('quiet-months', 3));  // months of silence before we call it stopped

const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const newest = (dir, p) => {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(p) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const monthsBetween = (a, b) => {
  const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
};

(async () => {
  const db = new Database(DB_PATH, { readonly: true });

  // FBA-only monthly series, whole history. Same join as build-replen-po:
  // orders carrying an FBA fulfilment fee, principal rows only.
  const rows = db.prepare(`
    WITH fba_keys AS (
      SELECT DISTINCT amazon_order_id, seller_sku
      FROM amazon_financial_events WHERE fee_type LIKE '%FBAPerUnitFulfillmentFee%'
    )
    SELECT e.seller_sku AS sku,
           substr(e.posted_at,1,7) AS month,
           ROUND(SUM(e.amount_cad)) AS revenue,
           SUM(COALESCE(e.quantity,0)) AS units
    FROM amazon_financial_events e
    JOIN fba_keys k ON k.amazon_order_id = e.amazon_order_id AND k.seller_sku = e.seller_sku
    WHERE e.fee_type = 'ItemPrice:Principal'
    GROUP BY e.seller_sku, month
    HAVING revenue > 0
    ORDER BY e.seller_sku, month
  `).all();
  const maxMonth = db.prepare(`SELECT MAX(substr(posted_at,1,7)) m FROM amazon_financial_events`).get().m;
  db.close();

  const bySku = {};
  for (const r of rows) (bySku[r.sku] = bySku[r.sku] || []).push(r);

  // Live stock + listing state
  const inv = await sp.getAllFbaInventory();
  const invRows = Array.isArray(inv) ? inv : (inv.inventorySummaries || []);
  const stock = {};
  for (const r of invRows) {
    const d = r.inventoryDetails || {};
    stock[norm(r.sellerSku)] = (d.fulfillableQuantity || 0) + (d.inboundShippedQuantity || 0);
  }

  const listings = JSON.parse(fs.readFileSync(newest(DATA, 'merchant-listings-all-'), 'utf8')).rows;
  const activeSkus = new Set(listings.filter((r) => r.status === 'Active').map((r) => norm(r['seller-sku'])));
  const asinBySku = {};
  for (const r of listings) if (r['seller-sku']) asinBySku[norm(r['seller-sku'])] = r.asin1;

  const skuMap = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;
  const catPath = newest(SNAPS, 'prosol-catalog-10008-');
  const prosolBySku = {};
  if (catPath) for (const p of JSON.parse(fs.readFileSync(catPath, 'utf8')).products) {
    for (const k of [p.prosol_sku, p.sku, p.external_id]) if (k) prosolBySku[norm(k)] = p;
  }

  const out = [];
  for (const [sku, series] of Object.entries(bySku)) {
    if (series.length < MIN_MONTHS) continue;
    const last = series[series.length - 1].month;
    const quiet = monthsBetween(last, maxMonth);
    const medRev = median(series.map((s) => s.revenue));
    const medUnits = median(series.map((s) => s.units || 0));
    const onHand = stock[norm(sku)] ?? 0;
    const asin = asinBySku[norm(sku)];
    const entry = asin ? skuMap[asin] : null;
    const ps = entry?.prosol_sku || entry?.api_sku || entry?.schluter_item || null;
    const pc = ps ? prosolBySku[norm(ps)] : null;

    let why;
    if (quiet < QUIET_MONTHS) why = 'SELLING';
    else if (!activeSkus.has(norm(sku))) why = 'NO_OFFER';
    else if (onHand === 0) why = 'STOCKED_OUT';
    else why = 'DECAYED';

    out.push({
      sku, asin, why, quiet_months: quiet, last_sale: last,
      active_months: series.length,
      median_monthly_rev: medRev, median_monthly_units: medUnits,
      annualised: Math.round(medRev * 12),
      peak_month_rev: Math.max(...series.map((s) => s.revenue)),
      on_hand: onHand, prosol_sku: ps, prosol_qty: pc ? pc.available_quantity : null,
      sourceable: !!(pc && Number(pc.available_quantity) > 0),
      name: entry?.product || (pc && (pc.name.en || pc.name.fr)) || '',
    });
  }

  const recoverable = out.filter((o) => o.why === 'STOCKED_OUT' || o.why === 'NO_OFFER');
  recoverable.sort((a, b) => b.annualised - a.annualised);

  console.log(`history: ${rows.length} sku-months through ${maxMonth} · ${Object.keys(bySku).length} SKUs with FBA sales`);
  console.log(`quiet threshold: ${QUIET_MONTHS} months · minimum track record: ${MIN_MONTHS} months\n`);

  console.log('═══ RECOVERABLE — sold before, not selling now ═══');
  console.log('sku'.padEnd(20) + 'why'.padEnd(12) + 'ann.opp'.padStart(10) + 'med/mo'.padStart(9) + 'mos'.padStart(5) + 'quiet'.padStart(6) + 'hand'.padStart(6) + 'prosol'.padStart(8) + '  product');
  for (const o of recoverable) {
    console.log(
      o.sku.slice(0, 19).padEnd(20) + o.why.padEnd(12) + money(o.annualised).padStart(10) +
      money(o.median_monthly_rev).padStart(9) + String(o.active_months).padStart(5) +
      String(o.quiet_months).padStart(6) + String(o.on_hand).padStart(6) +
      String(o.prosol_qty ?? '—').padStart(8) + '  ' + String(o.name).slice(0, 40));
  }
  const total = recoverable.reduce((s, o) => s + o.annualised, 0);
  const sourceable = recoverable.filter((o) => o.sourceable);
  console.log(`\n  → ${money(total)}/yr across ${recoverable.length} SKUs · ${money(sourceable.reduce((s, o) => s + o.annualised, 0))} of it sourceable from Prosol today (${sourceable.length} SKUs)`);

  // The whole point: what a 12-month window misses.
  const invisible = recoverable.filter((o) => o.quiet_months >= 12);
  console.log(`\n═══ INVISIBLE TO A 12-MONTH RANKING (quiet ${'>='}12 months) ═══`);
  for (const o of invisible) {
    console.log(`  ${o.sku.padEnd(20)} ${money(o.annualised).padStart(9)}/yr  quiet ${o.quiet_months}mo  last sold ${o.last_sale}  prosol ${o.prosol_qty ?? '—'}  ${String(o.name).slice(0, 38)}`);
  }
  console.log(`  → ${money(invisible.reduce((s, o) => s + o.annualised, 0))}/yr that build-replen-po.js structurally cannot see`);

  const decayed = out.filter((o) => o.why === 'DECAYED').sort((a, b) => b.annualised - a.annualised);
  console.log(`\n═══ DECAYED — stock on hand, sales stopped anyway (${decayed.length}) ═══`);
  for (const o of decayed.slice(0, 12)) {
    console.log(`  ${o.sku.padEnd(20)} ${money(o.annualised).padStart(9)}/yr  ${o.on_hand} on hand  quiet ${o.quiet_months}mo  ${String(o.name).slice(0, 38)}`);
  }
  console.log('  → real demand decline or a buy-box loss, NOT a restock candidate');

  const outPath = path.join(DATA, `stockout-opportunity-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), params: { MIN_MONTHS, QUIET_MONTHS }, recoverable, invisible, decayed, all: out }, null, 1));
  console.log(`\n✓ wrote ${outPath}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
