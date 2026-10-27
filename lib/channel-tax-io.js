/**
 * IO for lib/channel-tax.js: Amazon Finances API transactions, the province
 * of each Amazon order, Shopify order money, and the per-period / per-month
 * record files under data/channel-tax/ that replace Lynnae's PDFs, CSV
 * autosums and "PST remitted by Amazon" file.
 */

const fs = require('fs');
const path = require('path');
const sp = require('./sp-api');
const { graphql } = require('./shopify-graphql');
const tax = require('./channel-tax');

const DATA_DIR = path.join(__dirname, '..', 'data', 'channel-tax');
const ANALYTICS_DB = process.env.ANALYTICS_DB || path.join(__dirname, '..', 'data', 'analytics.sqlite');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Amazon ───────────────────────────────────────────────────────────────────

/**
 * Every Finances API (2024-06-19) transaction posted in [postedAfter,
 * postedBefore) for one marketplace. 0.5 req/s sustained: pages are spaced
 * and a 429 waits. The window must be under 180 days.
 */
async function fetchAmazonTransactions({ postedAfter, postedBefore, marketplaceId = tax.AMAZON_CA }) {
  const out = [];
  let nextToken = null;
  let throttled = 0;
  do {
    const query = { postedAfter, postedBefore, marketplaceId };
    if (nextToken) query.nextToken = nextToken;
    const res = await sp.spApiRequest('GET', '/finances/2024-06-19/transactions', { query });
    if (res.status === 429) {
      if (++throttled > 8) throw new Error('Finances API throttled 8 times in a row');
      await sleep(5000 * throttled);
      continue;
    }
    throttled = 0;
    if (res.status !== 200) throw new Error(`listTransactions failed: ${res.status} ${String(res.body).slice(0, 300)}`);
    const payload = JSON.parse(res.body).payload || {};
    out.push(...(payload.transactions || []));
    nextToken = payload.nextToken || null;
    if (nextToken) await sleep(2100);
  } while (nextToken);
  return out;
}

/**
 * orderId → province, from the analytics DB's amazon_orders (ship_state is
 * messy: "ONTARIO", "Québec", blank; channel-tax.provinceCode normalises), then
 * the Orders API for the ones the DB lacks. A miss stays null and the summary
 * falls back to the effective tax rate, flagged.
 */
async function amazonProvinces(orderIds, { db = ANALYTICS_DB, useApi = true } = {}) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const found = new Map();
  if (fs.existsSync(db)) {
    const Database = require('better-sqlite3');
    const conn = new Database(db, { readonly: true, fileMustExist: true });
    try {
      const stmt = conn.prepare('SELECT ship_state FROM amazon_orders WHERE amazon_order_id = ?');
      for (const id of ids) {
        const row = stmt.get(id);
        const code = row && tax.provinceCode(row.ship_state);
        if (code) found.set(id, code);
      }
    } finally {
      conn.close();
    }
  }
  if (useApi) {
    for (const id of ids.filter((x) => !found.has(x))) {
      try {
        const body = await sp.getOrder(id);
        const order = (body && body.payload) || {};
        const code = tax.provinceCode(order.ShippingAddress && order.ShippingAddress.StateOrRegion);
        if (code) found.set(id, code);
      } catch {
        // stays unknown; the summary flags it
      }
      await sleep(2100);
    }
  }
  return found;
}

/** Today in Pacific time, YYYY-MM-DD. */
function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tax.AMAZON_REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * The tax close for one 14-day period: everything Lynnae pulled from the
 * Date Range CSV, by province and code, written to
 * data/channel-tax/amazon/<start>.json and .csv. A period still open (or
 * closed less than `settleDays` ago) is refused unless provisional is set,
 * because Amazon keeps posting into it for a few days.
 */
async function closeAmazonPeriod({ period, provisional = false, settleDays = 3, write = true, useApi = true, outDir = path.join(DATA_DIR, 'amazon') }) {
  const settledOn = tax.addDaysYmd(period.end, settleDays);
  const isProvisional = todayPacific() < settledOn;
  if (isProvisional && !provisional) {
    throw new Error(`period ${period.label} (${period.start} to ${period.end}) settles on ${settledOn}; run with provisional to get a draft`);
  }
  const window = tax.amazonWindow(period);
  const transactions = await fetchAmazonTransactions(window);
  const orderIds = transactions.map((t) => ((t.relatedIdentifiers || []).find((r) => r.relatedIdentifierName === 'ORDER_ID') || {}).relatedIdentifierValue);
  const provinces = await amazonProvinces(orderIds, { useApi });
  const summary = tax.amazonTaxSummary(transactions, { provinceOf: (id) => provinces.get(id) || null });
  const record = {
    kind: 'amazon-period-tax',
    period: { start: period.start, end: period.end, label: period.label, key: period.key },
    window: { ...window, tz: tax.AMAZON_REPORT_TZ },
    provisional: isProvisional,
    generatedAt: new Date().toISOString(),
    source: 'SP-API Finances 2024-06-19 listTransactions, counted like the Seller Central Date Range report',
    ...summary,
    automaytLine: tax.amazonTaxLine(summary, period),
    // Amazon's fees withheld from the period's sales, before tax: the order's processing_fees.
    fees: tax.amazonOrderFees(transactions),
    note: 'cfcByCode is CFC\'s GST/HST to book. withheldByCode / byProvince[].withheld is what Amazon withheld and remitted as marketplace facilitator: a note proving remittance, never booked by CFC.',
  };
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${period.start}${isProvisional ? '.provisional' : ''}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(record, null, 2));
    fs.writeFileSync(`${base}.csv`, amazonRecordCsv(record));
    record.files = [`${base}.json`, `${base}.csv`];
  }
  return record;
}

/** One row per province plus totals: the "PST remitted by Amazon" file and the GST/HST figure, side by side. */
function amazonRecordCsv(r) {
  const rows = r.byProvince.map((p) => ({ ...p, period: r.period.label }));
  const totals = {
    period: r.period.label,
    province: 'TOTAL',
    transactions: r.transactions.counted,
    principal: r.sales.principal,
    shipping: r.sales.shipping,
    collected: r.tax.collected,
    withheld: r.tax.withheld,
    cfc: r.tax.cfc,
    cfcCode: r.cfcByCode.map((c) => `${c.code} ${c.amount}`).join('; '),
    withheldCode: r.withheldByCode.map((c) => `${c.code} ${c.amount}`).join('; '),
  };
  return tax.toCsv([...rows, totals], [
    { key: 'period', label: 'Period' },
    { key: 'province', label: 'Province' },
    { key: 'transactions', label: 'Transactions' },
    { key: 'principal', label: 'Product sales' },
    { key: 'shipping', label: 'Shipping credits' },
    { key: 'collected', label: 'Tax collected from buyers' },
    { key: 'withheld', label: 'Withheld and remitted by Amazon' },
    { key: 'withheldCode', label: 'Withheld tax type' },
    { key: 'cfc', label: 'CFC tax (GST/HST)' },
    { key: 'cfcCode', label: 'CFC tax type' },
  ]);
}

// ── Shopify ──────────────────────────────────────────────────────────────────

const MONEY = 'shopMoney { amount }';
const ORDER_FIELDS = `
  id name createdAt cancelledAt displayFinancialStatus
  shippingAddress { provinceCode countryCodeV2 }
  subtotalPriceSet { ${MONEY} } totalShippingPriceSet { ${MONEY} } totalTaxSet { ${MONEY} } totalPriceSet { ${MONEY} } totalRefundedSet { ${MONEY} }
  lineItems(first: 100) { nodes { id sku name quantity currentQuantity originalTotalSet { ${MONEY} }
    discountAllocations { allocatedAmountSet { ${MONEY} } } taxLines { title rate priceSet { ${MONEY} } } } }
  shippingLines(first: 10, includeRemovals: true) { nodes { title originalPriceSet { ${MONEY} } discountedPriceSet { ${MONEY} }
    taxLines { title rate priceSet { ${MONEY} } } } }
  transactions(first: 30) { kind status gateway processedAt amountSet { ${MONEY} } fees { type amount { amount } taxAmount { amount } } }
  refunds(first: 30) { id createdAt totalRefundedSet { ${MONEY} }
    refundLineItems(first: 100) { nodes { quantity lineItem { id sku } subtotalSet { ${MONEY} } totalTaxSet { ${MONEY} } } }
    refundShippingLines(first: 10) { nodes { subtotalAmountSet { ${MONEY} } taxAmountSet { ${MONEY} } } } }`;

/** One order's money (channel-tax.shopifyOrderMoney) by number, '#1387' or '1387'. */
async function fetchShopifyOrderMoney(orderNumber) {
  const n = String(orderNumber || '').replace(/^#/, '').trim();
  if (!n) throw new Error('fetchShopifyOrderMoney: order number required');
  const res = await graphql(`query($q: String!) { orders(first: 2, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:#${n}` });
  const nodes = ((res.data || res).orders || {}).nodes || [];
  const hit = nodes.find((o) => o.name === `#${n}`);
  if (!hit) throw new Error(`Shopify order #${n} not found`);
  return tax.shopifyOrderMoney(hit);
}

// BC is UTC-7 all year from Nov 1, 2026 and the tz data on the laptop and
// Mini is stale, so BC days are a fixed UTC-7, never America/Vancouver.
const BC_TZ = process.env.BC_TZ || 'Etc/GMT+7';

/** Every order created in [from, to] (BC days), as money. */
async function listShopifyOrderMoney({ from, to }) {
  const after = tax.zonedMidnightUtc(from, BC_TZ);
  const before = tax.zonedMidnightUtc(tax.addDaysYmd(to, 1), BC_TZ);
  const out = [];
  let cursor = null;
  do {
    const res = await graphql(`query($q: String!, $after: String) { orders(first: 25, after: $after, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`, { q: `created_at:>='${after}' created_at:<'${before}' status:any`, after: cursor });
    const page = (res.data || res).orders;
    out.push(...page.nodes.map(tax.shopifyOrderMoney));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

/** The record that replaces Lynnae's per-order PDFs: one row per order with tax by code, fee and refunds. */
function shopifyRecordCsv(orders) {
  const code = (list, c) => {
    const hit = (list || []).find((e) => e.code === c);
    return hit ? hit.amount : '';
  };
  const refundTax = (o) => tax.byCode(o.refunds.flatMap((r) => r.tax));
  return tax.toCsv(orders, [
    { key: 'orderNumber', label: 'Order' },
    { label: 'Created', get: (o) => String(o.createdAt || '').slice(0, 10) },
    { key: 'province', label: 'Province' },
    { key: 'financialStatus', label: 'Status' },
    { label: 'Cancelled', get: (o) => (o.cancelledAt ? String(o.cancelledAt).slice(0, 10) : '') },
    { key: 'subtotal', label: 'Subtotal' },
    { key: 'shipping', label: 'Shipping' },
    { label: 'GST', get: (o) => code(o.tax, 'GST') },
    { label: 'HST', get: (o) => code(o.tax, 'HST') },
    { label: 'PST', get: (o) => code(o.tax, 'PST') },
    { label: 'Other tax', get: (o) => o.tax.filter((e) => !['GST', 'HST', 'PST'].includes(e.code)).map((e) => `${e.code} ${e.amount}`).join('; ') },
    { key: 'total', label: 'Total' },
    { key: 'fee', label: 'Shopify Payments fee' },
    { key: 'refunded', label: 'Refunded' },
    { label: 'Refunded tax', get: (o) => refundTax(o).map((e) => `${e.code} ${e.amount}`).join('; ') },
    { key: 'lynnaeNet', label: 'Subtotal + shipping - fee' },
  ]);
}

function writeShopifyRecord(orders, { from, to, outDir = path.join(DATA_DIR, 'shopify') }) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${from}_${to}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ kind: 'shopify-order-tax', from, to, generatedAt: new Date().toISOString(), orders }, null, 2));
  fs.writeFileSync(`${base}.csv`, shopifyRecordCsv(orders));
  return [`${base}.json`, `${base}.csv`];
}

module.exports = {
  DATA_DIR,
  fetchAmazonTransactions,
  amazonProvinces,
  closeAmazonPeriod,
  amazonRecordCsv,
  fetchShopifyOrderMoney,
  listShopifyOrderMoney,
  shopifyRecordCsv,
  writeShopifyRecord,
  todayPacific,
};
