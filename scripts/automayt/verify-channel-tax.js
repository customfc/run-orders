#!/usr/bin/env node
/**
 * Read-only check of lib/channel-tax against Lynnae's real numbers.
 *
 *   --amazon   For every Amazon period SO in Salesforce with her Date Range
 *              CSV attached: the API's tax columns vs the CSV's, and the
 *              computed net (total without transfers, minus tax) vs the SO
 *              total she adjusted to. Periods without a CSV (e.g. one she
 *              hasn't closed yet) get the API figures and the SO's state.
 *   --shopify  For every Shopify SO she adjusted (a line she added with
 *              "Adj" / "Cancelled order" / "Refund" / "Samples"), per Shopify
 *              order: the SO total(s) vs subtotal + shipping - processing fee.
 *   --from / --to  Salesforce created-date range (default 2026-05-01 / 2026-09-30).
 *
 * Writes nothing anywhere except data/channel-tax/verify-<run>.json.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const sf = require('../../lib/salesforce');
const tax = require('../../lib/channel-tax');
const io = require('../../lib/channel-tax-io');

const AMAZON_ACCOUNT_ID = '0014x00001P1SiHAAV';
const SHOPIFY_ACCOUNT_ID = '0014x000023jkuDAAQ';
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const eq = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const fix = (n) => (n == null ? '' : Number(n).toFixed(2));

/** "May 7 - 20" / "Sep 24 - Oct 7" + the SO's created year → { start, end }. */
function periodFromName(name, year) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) - (?:([A-Z][a-z]{2}) )?(\d{1,2})$/.exec(String(name || '').trim());
  if (!m) return null;
  const sm = MONTHS[m[1]];
  const em = MONTHS[m[3] || m[1]];
  const ey = em < sm ? year + 1 : year;
  const p2 = (n) => String(n).padStart(2, '0');
  return { start: `${year}-${p2(sm)}-${p2(m[2])}`, end: `${ey}-${p2(em)}-${p2(m[4])}`, label: name };
}

async function downloadCsv(conn, versionId) {
  const res = await conn.request({ method: 'GET', url: `/services/data/v59.0/sobjects/ContentVersion/${versionId}/VersionData`, headers: { Accept: '*/*' } });
  return typeof res === 'string' ? res : Buffer.from(res).toString('utf8');
}

async function verifyAmazon(conn, { from, to }) {
  const sos = await sf.query(conn, `SELECT Id, Name, PBSI__Customer_Purchase_Order__c, CreatedDate, PBSI__Order_Total__c, LastModifiedBy.Name
    FROM PBSI__PBSI_Sales_Order__c WHERE PBSI__Customer__c = '${AMAZON_ACCOUNT_ID}' AND CreatedDate >= ${from}T00:00:00Z AND CreatedDate <= ${to}T23:59:59Z ORDER BY CreatedDate`);
  const ids = sos.map((s) => `'${s.Id}'`).join(',');
  const links = ids ? await sf.query(conn, `SELECT LinkedEntityId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.LatestPublishedVersionId FROM ContentDocumentLink WHERE LinkedEntityId IN (${ids})`) : [];
  const adj = ids ? await sf.query(conn, `SELECT PBSI__Sales_Order__c, PBSI__ItemDescription__c, PBSI__Total_Price__c FROM PBSI__PBSI_Sales_Order_Line__c WHERE PBSI__Sales_Order__c IN (${ids}) AND CreatedBy.Name = 'Lynnae Grohs' AND PBSI__Total_Price__c != 0`) : [];
  const out = [];
  for (const so of sos) {
    const period = periodFromName(so.PBSI__Customer_Purchase_Order__c, Number(so.CreatedDate.slice(0, 4)));
    if (!period) continue;
    const csvLink = links.find((l) => l.LinkedEntityId === so.Id && l.ContentDocument.FileExtension === 'csv');
    const adjusted = adj.some((l) => l.PBSI__Sales_Order__c === so.Id);
    const transactions = await io.fetchAmazonTransactions(tax.amazonWindow(period));
    const api = tax.amazonTaxSummary(transactions);
    const row = {
      so: so.Name, period: period.label, start: period.start, end: period.end, soTotal: so.PBSI__Order_Total__c, lynnaeAdjusted: adjusted,
      api: { collected: api.tax.collected, withheld: api.tax.withheld, cfc: api.tax.cfc, netExTax: api.netExTax, principal: api.sales.principal, shipping: api.sales.shipping, counted: api.transactions.counted },
    };
    const fees = tax.amazonOrderFees(transactions);
    row.api.fees = fees;
    if (csvLink) {
      const csvText = await downloadCsv(conn, csvLink.ContentDocument.LatestPublishedVersionId);
      const csv = tax.dateRangeCsvTotals(csvText);
      // The CSV's fee columns carry their tax; processing_fees is before tax.
      const csvFees = tax.dateRangeCsvOrderFees(csvText);
      row.fees = { api: fees.total, apiWithTax: tax.round2(fees.total + fees.tax), csvOrderFees: csvFees, match: eq(fees.total + fees.tax, csvFees) };
      row.csv = { file: csvLink.ContentDocument.Title, collected: csv.collected, withheld: csv.withheld, cfc: csv.cfc, netExTax: csv.netExTax, principal: csv.columns['product sales'], shipping: csv.columns['shipping credits'] };
      row.match = {
        principal: eq(api.sales.principal, csv.columns['product sales']),
        collected: eq(api.tax.collected, csv.collected),
        withheld: eq(api.tax.withheld, csv.withheld),
        cfc: eq(api.tax.cfc, csv.cfc),
        netExTax: eq(api.netExTax, csv.netExTax),
        csvNetVsSo: adjusted ? eq(csv.netExTax, so.PBSI__Order_Total__c) : null,
        apiNetVsSo: adjusted ? eq(api.netExTax, so.PBSI__Order_Total__c) : null,
      };
    }
    out.push(row);
    const m = row.match;
    console.log(`${so.Name} ${period.label.padEnd(16)} api cfc ${fix(api.tax.cfc).padStart(9)} wh ${fix(api.tax.withheld).padStart(9)} net ${fix(api.netExTax).padStart(10)}`
      + (row.fees ? ` | fees ${fix(row.fees.api)} (+tax ${fix(row.fees.apiWithTax)}) vs csv ${fix(row.fees.csvOrderFees)} ${row.fees.match ? 'match' : 'MISMATCH fees'}` : ` | fees ${fix(fees.total)}`)
      + (row.csv ? ` | csv cfc ${fix(row.csv.cfc).padStart(9)} wh ${fix(row.csv.withheld).padStart(9)} net ${fix(row.csv.netExTax).padStart(10)} | SO ${fix(so.PBSI__Order_Total__c)} | ${Object.entries(m).filter(([, v]) => v === false).map(([k]) => `MISMATCH ${k}`).join(' ') || 'all match'}` : ` | no CSV; SO ${fix(so.PBSI__Order_Total__c)} ${adjusted ? 'adjusted' : 'not adjusted yet'}`));
  }
  return out;
}

const LYNNAE_LINE = /adj|cancel|refund|sample|revenue/i;

async function verifyShopify(conn, { from, to }) {
  const sos = await sf.query(conn, `SELECT Id, Name, PBSI__Customer_Purchase_Order__c, CreatedDate, CreatedBy.Name, PBSI__Order_Total__c
    FROM PBSI__PBSI_Sales_Order__c WHERE PBSI__Customer__c = '${SHOPIFY_ACCOUNT_ID}' AND CreatedDate >= ${from}T00:00:00Z AND CreatedDate <= ${to}T23:59:59Z ORDER BY CreatedDate`);
  if (!sos.length) return { orders: [], unmapped: [] };
  const ids = sos.map((s) => `'${s.Id}'`).join(',');
  const lines = await sf.query(conn, `SELECT PBSI__Sales_Order__c, PBSI__ItemDescription__c, PBSI__Total_Price__c, CreatedBy.Name FROM PBSI__PBSI_Sales_Order_Line__c WHERE PBSI__Sales_Order__c IN (${ids})`);
  const touched = new Set(lines.filter((l) => l.CreatedBy.Name === 'Lynnae Grohs' && LYNNAE_LINE.test(l.PBSI__ItemDescription__c || '')).map((l) => l.PBSI__Sales_Order__c));
  const byOrder = new Map();
  const unmapped = [];
  for (const so of sos) {
    if (!touched.has(so.Id)) continue;
    const digits = /(\d{4,5})/.exec(String(so.PBSI__Customer_Purchase_Order__c || ''));
    if (!digits) {
      unmapped.push({ so: so.Name, ref: so.PBSI__Customer_Purchase_Order__c, total: so.PBSI__Order_Total__c, lines: lines.filter((l) => l.PBSI__Sales_Order__c === so.Id).map((l) => `${l.PBSI__ItemDescription__c} ${fix(l.PBSI__Total_Price__c)}`) });
      continue;
    }
    const list = byOrder.get(digits[1]) || [];
    list.push(so);
    byOrder.set(digits[1], list);
  }
  const out = [];
  for (const [num, list] of [...byOrder.entries()].sort()) {
    let money;
    try {
      money = await io.fetchShopifyOrderMoney(num);
    } catch (err) {
      out.push({ order: `#${num}`, error: err.message });
      continue;
    }
    // Every SF order for this Shopify order counts, touched or not (a
    // cancelled order gets a second SO from Lynnae next to the pipeline's).
    const all = sos.filter((s) => (/(\d{4,5})/.exec(String(s.PBSI__Customer_Purchase_Order__c || '')) || [])[1] === num);
    const soTotal = tax.round2(all.reduce((s, x) => s + Number(x.PBSI__Order_Total__c || 0), 0));
    const gross = money.lynnaeNet;
    const afterRefunds = tax.round2(money.subtotal + money.shipping - money.fee - money.refunds.reduce((s, r) => s + r.items.reduce((a, i) => a + i.subtotal, 0) + r.shipping.reduce((a, x) => a + x.subtotal, 0), 0));
    const verdict = eq(soTotal, gross) ? 'match' : eq(soTotal, afterRefunds) ? 'match-after-refunds' : 'mismatch';
    out.push({ order: money.orderNumber, sos: all.map((s) => s.Name), soTotal, subtotal: money.subtotal, shipping: money.shipping, fee: money.fee, formula: gross, afterRefunds, diff: tax.round2(soTotal - gross), verdict, status: money.financialStatus, cancelled: !!money.cancelledAt, tax: money.tax });
    console.log(`${money.orderNumber.padEnd(6)} ${all.map((s) => s.Name).join('+').padEnd(20)} SO ${fix(soTotal).padStart(9)} | ${fix(money.subtotal)} + ${fix(money.shipping)} - fee ${fix(money.fee)} = ${fix(gross).padStart(9)} | after refunds ${fix(afterRefunds).padStart(9)} | ${verdict}${verdict === 'mismatch' ? ` (${fix(soTotal - gross)})` : ''}${money.cancelledAt ? ' CANCELLED' : ''} ${money.financialStatus}`);
  }
  for (const u of unmapped) console.log(`unmapped ${u.so} ref=${u.ref} total ${fix(u.total)}: ${u.lines.join('; ')}`);
  return { orders: out, unmapped };
}

async function main() {
  const from = arg('from', '2026-05-01');
  const to = arg('to', '2026-09-30');
  const conn = await sf.connect();
  const report = { run: new Date().toISOString(), from, to };
  if (has('amazon')) {
    console.log('\nAmazon periods (API vs Lynnae\'s CSV vs her SO total)');
    report.amazon = await verifyAmazon(conn, { from, to: arg('amazon-to', '2026-10-07') });
  }
  if (has('shopify')) {
    console.log('\nShopify orders Lynnae adjusted (SO total vs subtotal + shipping - fee)');
    report.shopify = await verifyShopify(conn, { from: arg('shopify-from', '2026-08-01'), to });
    const v = report.shopify.orders.reduce((m, o) => ({ ...m, [o.verdict || 'error']: (m[o.verdict || 'error'] || 0) + 1 }), {});
    console.log('verdicts', JSON.stringify(v), 'unmapped SOs', report.shopify.unmapped.length);
  }
  fs.mkdirSync(io.DATA_DIR, { recursive: true });
  const file = path.join(io.DATA_DIR, `verify-${report.run.replace(/[-:T]/g, '').slice(0, 12)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nreport ${file}`);
}

main().catch((e) => { console.error('verify-channel-tax failed:', e.message); process.exit(1); });
