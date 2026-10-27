#!/usr/bin/env node
/**
 * Channel tax for Automayt: the automated replacement for Lynnae's Amazon CSV
 * autosum + "PST remitted by Amazon" file, and her Shopify order PDFs.
 *
 *   amazon-close  --period YYYY-MM-DD | --date YYYY-MM-DD  [--provisional] [--post]
 *       Close one period (whole period, Pacific days): tax collected,
 *       withheld by Amazon by province and code, CFC's GST/HST, the net
 *       Lynnae adjusts the period SO to. Writes data/channel-tax/amazon/<start>.{json,csv}.
 *       --post adds CFC's GST/HST to the Automayt period order as a tax-only line.
 *   amazon-compare --csv <Seller Central Date Range CSV> [--start --end]
 *       API figures vs a downloaded report, column by column.
 *   shopify-record --from YYYY-MM-DD --to YYYY-MM-DD
 *       Per-order subtotal, shipping, tax by code, fee, refunds (replaces the PDFs).
 *       Writes data/channel-tax/shopify/<from>_<to>.{json,csv}.
 *   shopify-refunds --from YYYY-MM-DD --to YYYY-MM-DD [--apply]
 *       Refunded/cancelled orders vs their Automayt SO. Dry run unless --apply,
 *       which cancels an SO refunded in full before invoicing (nothing else can
 *       be posted until Automayt has credit notes).
 *
 * Period schedule: Salesforce's 14-day periods (AMAZON_PERIOD_ANCHOR or
 * --anchor overrides), split at the Nov 1 cutover: --period 2026-10-22 closes
 * Oct 22 - 31 for the Salesforce order, --period 2026-11-01 closes Nov 1 - 4
 * for Automayt, and Nov 5 on are whole periods again.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const tax = require('../../lib/channel-tax');
const io = require('../../lib/channel-tax-io');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
};
const flag = (name) => argv.includes(`--${name}`);
const ymd = (s, name) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) throw new Error(`--${name} YYYY-MM-DD required`);
  return s;
};

function anchor() {
  return ymd(arg('anchor') || require('../../lib/automayt-erp').amazonPeriodAnchor(), 'anchor');
}

function show(r) {
  console.log(`Amazon ${r.period.label} (${r.period.start} to ${r.period.end})${r.provisional ? ' PROVISIONAL' : ''}`);
  console.log(`  transactions counted ${r.transactions.counted} of ${r.transactions.fetched}; product sales ${r.sales.principal.toFixed(2)}, shipping ${r.sales.shipping.toFixed(2)}`);
  console.log(`  tax collected ${r.tax.collected.toFixed(2)} (orders ${r.tax.collectedOnOrders.toFixed(2)}, refunds ${r.tax.refundedOnRefunds.toFixed(2)})`);
  console.log(`  withheld by Amazon ${r.tax.withheld.toFixed(2)}: ${r.withheldByCode.map((c) => `${c.code} ${c.amount}`).join(', ') || 'none'} (Amazon remitted; record only)`);
  console.log(`  CFC GST/HST ${r.tax.cfc.toFixed(2)}: ${r.cfcByCode.map((c) => `${c.code} ${c.amount}`).join(', ') || 'none'}`);
  console.log(`  net ex-tax (what Lynnae adjusts the SO to) ${r.netExTax.toFixed(2)}`);
  for (const p of r.byProvince) console.log(`    ${p.province.padEnd(8)} collected ${p.collected.toFixed(2).padStart(9)} withheld ${p.withheld.toFixed(2).padStart(9)} ${p.withheldCode || ''} CFC ${p.cfc.toFixed(2).padStart(9)} ${p.cfcCode}`);
  if (r.inferredProvince.length) console.log(`  ${r.inferredProvince.length} transaction(s) with no province: coded by rate, see inferredProvince${r.inferredProvince.some((x) => x.fullyWithheld) ? ' (some fully withheld: check them)' : ''}`);
  if (r.otherMarketplace.length) console.log(`  ${r.otherMarketplace.length} transaction(s) from another marketplace left out: see otherMarketplace`);
  if (r.files) console.log(`  wrote ${r.files.join(', ')}`);
}

async function amazonClose() {
  const erp = require('../../lib/automayt-erp');
  const ref = arg('period') || arg('date');
  const period = erp.amazonPeriod(ymd(ref, arg('period') ? 'period' : 'date'), anchor());
  if (arg('period') && period.start !== arg('period')) throw new Error(`${arg('period')} is not a period start on this schedule (that period starts ${period.start})`);
  const record = await io.closeAmazonPeriod({ period, provisional: flag('provisional') });
  show(record);
  if (flag('post')) {
    if (process.env.AUTOMAYT_TAX_AS_CHARGED === '0') throw new Error('AUTOMAYT_TAX_AS_CHARGED=0: posting is off; the record above is the books entry');
    const res = await erp.postAmazonPeriodTax(record);
    console.log(res.posted ? `  posted to ${res.so}` : `  not posted: ${res.reason}`);
  }
}

function periodFromFilename(file) {
  const M = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const m = /(\d{4})([A-Z][a-z]{2})(\d{1,2})-(\d{4})([A-Z][a-z]{2})(\d{1,2})/.exec(path.basename(file));
  if (!m) return null;
  const d = (y, mo, da) => `${y}-${String(M[mo]).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  return { start: d(m[1], m[2], m[3]), end: d(m[4], m[5], m[6]) };
}

async function amazonCompare() {
  const file = arg('csv');
  if (!file) throw new Error('--csv <file> required');
  const fromName = periodFromFilename(file) || {};
  const start = arg('start') || fromName.start;
  const end = arg('end') || fromName.end;
  const csv = tax.dateRangeCsvTotals(fs.readFileSync(file, 'utf8'));
  const api = tax.amazonTaxSummary(await io.fetchAmazonTransactions(tax.amazonWindow({ start: ymd(start, 'start'), end: ymd(end, 'end') })));
  const rows = [
    ['product sales', api.sales.principal, csv.columns['product sales']],
    ['shipping credits', api.sales.shipping, csv.columns['shipping credits']],
    ['tax collected', api.tax.collected, csv.collected],
    ['withheld by Amazon', api.tax.withheld, csv.withheld],
    ['CFC GST/HST', api.tax.cfc, csv.cfc],
    ['net ex-tax', api.netExTax, csv.netExTax],
  ];
  console.log(`${start} to ${end}: API vs ${path.basename(file)}`);
  for (const [k, a, c] of rows) console.log(`  ${k.padEnd(20)} ${a.toFixed(2).padStart(11)} ${c.toFixed(2).padStart(11)} ${Math.round(a * 100) === Math.round(c * 100) ? 'match' : `DIFF ${(a - c).toFixed(2)}`}`);
}

async function shopifyRecord() {
  const from = ymd(arg('from'), 'from');
  const to = ymd(arg('to'), 'to');
  const orders = await io.listShopifyOrderMoney({ from, to });
  const files = io.writeShopifyRecord(orders, { from, to });
  const sum = (k) => orders.reduce((s, o) => s + o[k], 0).toFixed(2);
  console.log(`${orders.length} Shopify orders ${from} to ${to}: subtotal ${sum('subtotal')}, shipping ${sum('shipping')}, tax ${sum('taxTotal')}, fees ${sum('fee')}, refunded ${sum('refunded')}`);
  const unknown = orders.filter((o) => o.feeUnknown);
  if (unknown.length) console.log(`  fee not reported by the gateway on ${unknown.map((o) => `${o.orderNumber} (${o.paidVia.join('/')})`).join(', ')}`);
  console.log(`  wrote ${files.join(', ')}`);
}

async function shopifyRefunds() {
  const orders = require('../../lib/automayt-orders');
  const from = ymd(arg('from'), 'from');
  const to = ymd(arg('to'), 'to');
  const list = (await io.listShopifyOrderMoney({ from, to })).filter((o) => o.refunds.length || o.cancelledAt);
  for (const m of list) {
    const r = await orders.reconcileShopifyRefund({ orderNumber: m.orderNumber, money: m, apply: flag('apply') });
    console.log(`${r.order.padEnd(6)} ${String(r.so || '-').padEnd(10)} ${r.action}${r.applied ? ' (done)' : ''}${r.reason ? `: ${r.reason}` : ''}${r.feeNote ? `; ${r.feeNote}` : ''}${r.creditNotes ? `; credit notes ${r.creditNotes.map((c) => `${c.refundId} ${c.status}`).join(", ")}` : ''}`);
  }
  if (!list.length) console.log('no refunded or cancelled orders in range');
}

const COMMANDS = { 'amazon-close': amazonClose, 'amazon-compare': amazonCompare, 'shopify-record': shopifyRecord, 'shopify-refunds': shopifyRefunds };

if (!COMMANDS[cmd]) {
  console.error(`usage: node scripts/automayt/channel-tax.js <${Object.keys(COMMANDS).join('|')}> ...`);
  process.exit(2);
}
COMMANDS[cmd]().catch((e) => { console.error(`${cmd} failed: ${e.message}`); process.exit(1); });
