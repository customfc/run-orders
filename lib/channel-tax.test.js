const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';

const tax = require('./channel-tax');

const money = (a) => ({ shopMoney: { amount: String(a) } });
const bd = (type, amount, children = []) => ({ breakdownType: type, breakdownAmount: { currencyAmount: amount, currencyCode: 'CAD' }, breakdowns: children });
const tx = ({ id, type = 'Shipment', status = 'DEFERRED_RELEASED', order, deferredId, total, items, marketplaceId = 'A2EUQ1WTGCTBG2' }) => ({
  transactionId: id,
  transactionType: type,
  transactionStatus: status,
  postedDate: '2026-09-12T18:00:00Z',
  totalAmount: { currencyAmount: total, currencyCode: 'CAD' },
  marketplaceDetails: { marketplaceId, marketplaceName: marketplaceId === 'A2EUQ1WTGCTBG2' ? 'Amazon.ca' : 'Amazon.com' },
  relatedIdentifiers: [
    ...(order ? [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: order }] : []),
    ...(deferredId ? [{ relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: deferredId }] : []),
  ],
  items: items || [],
});

// ── codes and provinces ──────────────────────────────────────────────────────

test('provinceCode normalises the messy ship_state values', () => {
  for (const [input, want] of [['ONTARIO', 'ON'], ['Québec', 'QC'], ['QUéBEC', 'QC'], ['qc', 'QC'], ['British Columbia', 'BC'], ['Newfoundland', 'NL'], ['PEI', 'PE'], ['', null], [null, null], ['Texas', null]]) {
    assert.equal(tax.provinceCode(input), want, String(input));
  }
});

test('Shopify tax titles map to Automayt codes', () => {
  assert.deepEqual(['GST', 'HST', 'PST', 'BC PST', 'QST', 'TVQ', 'RST', 'Sales Tax'].map(tax.shopifyTaxCode), ['GST', 'HST', 'PST', 'PST', 'QST', 'QST', 'RST', 'SALES_TAX']);
});

test('prorateTax splits a BC refund into GST and PST to the cent', () => {
  const charged = [{ code: 'GST', amount: '26.96' }, { code: 'PST', amount: '37.75' }];
  assert.deepEqual(tax.prorateTax(64.71, charged), charged);
  const half = tax.prorateTax(32.35, charged);
  assert.equal(tax.sumCodes(half), 32.35);
  assert.deepEqual(half.map((e) => e.code), ['GST', 'PST']);
  assert.deepEqual(tax.prorateTax(0, charged), []);
});

test('unitPriceFor lands every line total on the cent, area items included', () => {
  assert.equal(tax.unitPriceFor(45.4, 1), '45.4');
  assert.equal(tax.unitPriceFor(1928.28, 432), '4.4636'); // #1385: 4 rolls of Ditra Heat Duo at 108 sqft
  assert.equal(tax.unitPriceFor(1622.62, 538), '3.01602');
  for (const [t, q] of [[1928.28, 432], [128.18, 98.5], [899.85, 15], [0, 3]]) {
    const p = Number(tax.unitPriceFor(t, q));
    assert.equal(Math.round(p * q * 100), Math.round(t * 100), `${t}/${q}`);
  }
  assert.throws(() => tax.unitPriceFor(10, 0), /qty must be > 0/);
});

// ── Shopify ──────────────────────────────────────────────────────────────────

const order1392 = {
  id: 'gid://shopify/Order/1', name: '#1392', createdAt: '2026-09-21T10:00:00Z', cancelledAt: null, displayFinancialStatus: 'PARTIALLY_REFUNDED',
  shippingAddress: { provinceCode: 'BC', countryCodeV2: 'CA' },
  subtotalPriceSet: money(511.24), totalShippingPriceSet: money(27.98), totalPriceSet: money(603.93), totalRefundedSet: money(46.68),
  lineItems: { nodes: [
    { id: 'gid://shopify/LineItem/101', sku: 'KERECK/FA2', name: 'KERDI-KERECK', quantity: 2, originalTotalSet: money(41.68), discountAllocations: [], taxLines: [{ title: 'GST', priceSet: money(2.08) }, { title: 'PST', priceSet: money(2.92) }] },
    { id: 'gid://shopify/LineItem/102', sku: 'KST1220/1830', name: 'Tray', quantity: 1, originalTotalSet: money(296.41), discountAllocations: [{ allocatedAmountSet: money(30) }], taxLines: [{ title: 'GST', priceSet: money(13.32) }, { title: 'PST', priceSet: money(18.65) }] },
  ] },
  shippingLines: { nodes: [{ title: 'Standard', originalPriceSet: money(27.98), discountedPriceSet: money(27.98), taxLines: [{ title: 'GST', priceSet: money(1.4) }, { title: 'PST', priceSet: money(1.96) }] }] },
  transactions: [
    { kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', amountSet: money(603.93), fees: [{ type: 'processing_fee', amount: { amount: '20.83' }, taxAmount: { amount: '0.0' } }] },
    { kind: 'REFUND', status: 'SUCCESS', gateway: 'shopify_payments', amountSet: money(46.68), fees: [] },
  ],
  refunds: [{ id: 'gid://shopify/Refund/9', createdAt: '2026-09-30T10:00:00Z', totalRefundedSet: money(46.68),
    refundLineItems: { nodes: [{ quantity: 2, lineItem: { id: 'gid://shopify/LineItem/101', sku: 'KERECK/FA2' }, subtotalSet: money(41.68), totalTaxSet: money(5.0) }] },
    refundShippingLines: { nodes: [] } }],
};

test('shopifyOrderMoney: paid line totals after discounts, tax by code, fee, refunds split by code', () => {
  const m = tax.shopifyOrderMoney(order1392);
  assert.equal(m.province, 'BC');
  assert.deepEqual(m.lines.map((l) => [l.id, l.total]), [['101', 41.68], ['102', 266.41]]);
  assert.deepEqual(m.tax, [{ code: 'GST', amount: '16.80' }, { code: 'PST', amount: '23.53' }]);
  assert.equal(m.taxTotal, 40.33);
  assert.equal(m.fee, 20.83);
  assert.equal(m.feeUnknown, false);
  assert.equal(m.lynnaeNet, 518.39); // her formula: 511.24 + 27.98 - 20.83
  assert.deepEqual(m.refunds[0].tax, [{ code: 'GST', amount: '2.08' }, { code: 'PST', amount: '2.92' }]);
  assert.equal(m.fullyRefunded, false);
});

test('shopifyOrderMoney: a PayPal order has an unknown fee, not a zero one', () => {
  const m = tax.shopifyOrderMoney({ ...order1392, transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'paypal', amountSet: money(118.58), fees: [] }] });
  assert.equal(m.fee, 0);
  assert.equal(m.feeUnknown, true);
  assert.deepEqual(m.paidVia, ['paypal']);
});

test('shopifyRefundPlan: a full refund cancels, invoiced or not; partial waits on a credit note', () => {
  const full = { orderNumber: '#1383', refunds: [{}], refunded: 242.19, total: 242.19, fullyRefunded: true, cancelledAt: 'x', fee: 6.6 };
  assert.equal(tax.shopifyRefundPlan(full, { status: 'confirmed' }).action, 'cancel');
  assert.equal(tax.shopifyRefundPlan(full, { status: 'invoiced' }).action, 'cancel');
  assert.match(tax.shopifyRefundPlan(full, { status: 'invoiced' }).reason, /credit note/);
  assert.equal(tax.shopifyRefundPlan({ ...full, fullyRefunded: false, cancelledAt: null }, { status: 'invoiced' }).action, 'credit-note-pending');
  assert.equal(tax.shopifyRefundPlan(full, { status: 'cancelled' }).action, 'none');
  assert.equal(tax.shopifyRefundPlan(full, null).action, 'no-so');
  assert.equal(tax.shopifyRefundPlan({ ...full, fullyRefunded: false, cancelledAt: null }, { status: 'confirmed' }).action, 'credit-note-pending');
  assert.equal(tax.shopifyRefundPlan({ refunds: [], cancelledAt: null }, { status: 'confirmed' }).action, 'none');
});

// ── Amazon ───────────────────────────────────────────────────────────────────

test('amazonWindow uses Pacific days and follows the DST change inside a period', () => {
  assert.deepEqual(tax.amazonWindow({ start: '2026-09-10', end: '2026-09-23' }), { postedAfter: '2026-09-10T07:00:00Z', postedBefore: '2026-09-24T07:00:00Z' });
  assert.deepEqual(tax.amazonWindow({ start: '2026-10-22', end: '2026-11-04' }), { postedAfter: '2026-10-22T07:00:00Z', postedBefore: '2026-11-05T08:00:00Z' });
});

test('periodsBetween keeps the Salesforce 14-day schedule from any anchor on it, split at Nov 1', () => {
  const a = tax.periodsBetween('2026-09-24', '2026-10-08', '2026-11-18').map((p) => p.label);
  const b = tax.periodsBetween('2026-10-22', '2026-10-08', '2026-11-18').map((p) => p.label);
  assert.deepEqual(a, ['Oct 8 - 21', 'Oct 22 - 31', 'Nov 1 - 4', 'Nov 5 - 18']);
  assert.deepEqual(b, a);
});

test('countsLikeDateRange: deferred originals count, their releases do not', () => {
  assert.equal(tax.countsLikeDateRange({ transactionStatus: 'DEFERRED' }), true);
  assert.equal(tax.countsLikeDateRange({ transactionStatus: 'DEFERRED_RELEASED' }), true);
  assert.equal(tax.countsLikeDateRange({ transactionStatus: 'RELEASED', relatedIdentifiers: [] }), true);
  assert.equal(tax.countsLikeDateRange({ transactionStatus: 'RELEASED', relatedIdentifiers: [{ relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'd1' }] }), false);
});

const sale = (id, order, principal, taxAmt, withheld, extra = {}) => tx({
  id, order, total: principal + taxAmt + withheld, ...extra,
  items: [{ breakdowns: [
    bd('ProductCharges', principal, [bd('OurPricePrincipal', principal)]),
    bd('Tax', taxAmt + withheld, [bd('OurPriceTax', taxAmt), ...(withheld ? [bd('MarketplaceFacilitatorTax-Principal', withheld)] : [])]),
    bd('AmazonFees', -1, [bd('Commission', -1, [bd('Base', -0.88), bd('Tax', -0.12)])]),
  ] }],
});

test('amazonTaxSummary: Lynnae\'s autosum, by province and code, withheld kept apart', () => {
  const txs = [
    sale('t-on', 'ON-1', 100, 13, 0),
    sale('t-qc', 'QC-1', 100, 14.98, -9.98),
    sale('t-bc', 'BC-1', 50, 6, -3.5),
    sale('t-mb', 'MB-1', 50, 6, -3.5),
    sale('t-ab', 'AB-1', 20, 1, 0),
    // the release of t-on, posted later: must not count twice
    sale('t-on-rel', 'ON-1', 100, 13, 0, { status: 'RELEASED', deferredId: 't-on' }),
    // a refund of the BC order gives tax and withholding back
    tx({ id: 't-ref', type: 'Refund', status: 'RELEASED', order: 'BC-1', total: -52.5, items: [{ breakdowns: [bd('ProductCharges', -50), bd('Tax', -2.5, [bd('OurPriceTax', -6), bd('MarketplaceFacilitatorTax-Principal', 3.5)])] }] }),
    // tax on Amazon's ad fees is not tax collected
    tx({ id: 't-ads', type: 'ProductAdsPayment', status: 'RELEASED', total: -56, items: [{ breakdowns: [bd('Base', -50), bd('Tax', -6)] }] }),
    // a transfer is the payout, never part of the net
    tx({ id: 't-xfer', type: 'Transfer', status: 'RELEASED', total: 999, items: [] }),
    // Amazon.com: US tax withheld in full, flagged and left out
    sale('t-us', 'US-1', 30, 2, -2, { marketplaceId: 'ATVPDKIKX0DER' }),
  ];
  const provinces = { 'ON-1': 'Ontario', 'QC-1': 'QUéBEC', 'BC-1': 'bc', 'MB-1': 'MB', 'AB-1': 'AB' };
  const s = tax.amazonTaxSummary(txs, { provinceOf: (id) => provinces[id] });
  assert.equal(s.transactions.counted, 8);
  assert.equal(s.tax.collected, 34.98); // 13 + 14.98 + 6 + 6 + 1 - 6
  assert.equal(s.tax.withheld, -13.48); // -9.98 - 3.5 - 3.5 + 3.5
  assert.equal(s.tax.cfc, 21.5);
  assert.deepEqual(s.cfcByCode, [{ code: 'GST', amount: '8.50' }, { code: 'HST', amount: '13.00' }]);
  assert.deepEqual(s.withheldByCode, [{ code: 'PST', amount: '0.00' }, { code: 'QST', amount: '9.98' }, { code: 'RST', amount: '3.50' }].filter((e) => Number(e.amount)));
  const bc = s.byProvince.find((p) => p.province === 'BC');
  assert.deepEqual([bc.collected, bc.withheld, bc.cfc, bc.cfcCode, bc.withheldCode], [0, 0, 0, 'GST', 'PST']);
  assert.equal(s.otherMarketplace.length, 1);
  assert.equal(s.otherMarketplace[0].orderId, 'US-1');
  assert.equal(s.inferredProvince.length, 0);
  // net ex-tax = totals without the transfer (and without Amazon.com), minus every tax column
  const totals = 113 + 105 + 52.5 + 52.5 + 21 - 52.5 - 56;
  assert.equal(s.netExTax, tax.round2(totals - 34.98 + 13.48));
});

test('amazonTaxSummary: no province falls back to the rate and is flagged', () => {
  const s = tax.amazonTaxSummary([sale('a', 'X-1', 100, 15, 0), sale('b', 'X-2', 100, 14.98, -9.98)]);
  assert.deepEqual(s.cfcByCode, [{ code: 'GST', amount: '5.00' }, { code: 'HST', amount: '15.00' }]);
  assert.deepEqual(s.withheldByCode, [{ code: 'QST', amount: '9.98' }]);
  assert.equal(s.inferredProvince.length, 2);
});

test('amazonTaxLine: one tax-only line per period, GST/HST only', () => {
  const line = tax.amazonTaxLine({ cfcByCode: [{ code: 'GST', amount: '577.21' }, { code: 'HST', amount: '1361.59' }] }, { start: '2026-10-22', end: '2026-11-04', label: 'Oct 22 - Nov 4' });
  assert.deepEqual([line.qty, line.unit_price, line.external_line_ref], ['1', '0', 'tax:2026-10-22']);
  assert.deepEqual(line.tax_charged.map((t) => t.code), ['GST', 'HST']);
});

test('dateRangeCsvTotals: Lynnae\'s autosum, hand-added total row and transfers left out', () => {
  const header = '"date/time","settlement id","type","order id","sku","description","quantity","marketplace","fulfillment","order city","order state","order postal","tax collection model","product sales","product sales tax","shipping credits","shipping credits tax","gift wrap credits","gift wrap credits tax","Regulatory fee","Tax on regulatory fee","promotional rebates","promotional rebates tax","marketplace withheld tax","selling fees","fba fees","other transaction fees","other","total","Transaction status","Transaction Release Date"';
  const row = (type, ps, pst, wh, total, other = '0') => `"Sep 10, 2026 4:04:03 a.m. PDT","1","${type}","701-1","SKU","d","1","amazon.ca","Seller","X","QC","H0H","MarketplaceFacilitator","${ps}","${pst}","0","0","0","0","0","0","0","0","${wh}","-10","0","0","${other}","${total}","Released",""`;
  const csv = ['"Includes Amazon Marketplace"', '"Date/Time: Posted date/time of the transaction"', header,
    row('Order', '100.00', '14.98', '-9.98', '95.00'),
    row('Order', '1,000.00', '130.00', '0', '1,120.00'),
    row('Transfer', '0', '0', '0', '-500.00', '-500.00'),
    ',,,,,,,,,,,,,1100,144.98,0,0,0,0,0,0,0,0,-9.98,-20,0,0,-500,715,,'].join('\n');
  const t = tax.dateRangeCsvTotals(csv);
  assert.equal(t.rows, 3);
  assert.equal(t.columns['product sales'], 1100);
  assert.equal(t.collected, 144.98);
  assert.equal(t.withheld, -9.98);
  assert.equal(t.cfc, 135);
  assert.equal(t.totalWithoutTransfers, 1215);
  assert.equal(t.netExTax, 1080);
});
