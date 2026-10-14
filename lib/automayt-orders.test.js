const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';
process.env.AMAZON_PERIOD_ANCHOR = '2026-09-18';
delete process.env.AUTOMAYT_REF_SYSTEM;
delete process.env.AUTOMAYT_REF_OVERRIDES;
delete process.env.AUTOMAYT_TEST_CODE_PREFIX;

const orders = require('./automayt-orders');

// ── A tiny fake Automayt ─────────────────────────────────────────────────────

const ITEMS = {
  kerdifix: { id: 'it-kf', item_number: '4172', vendor_code: 'KERDIFIXBW', description: 'KERDI-FIX', stocking_unit: 'each', retail_price: '37.96', cost: { real_cost: '21.6400' } },
  pad: { id: 'it-pad', item_number: '71', vendor_code: null, description: 'Bona pad', stocking_unit: 'each', retail_price: '9.99', cost: { real_cost: '4.0000' } },
  roll: { id: 'it-roll', item_number: 'ROLL1', vendor_code: 'DITRAPS25M', description: 'DITRA-PS roll (269 sqft)', stocking_unit: 'sqft', retail_price: '3.02', cost: { real_cost: '1.7200' } },
  shelf: { id: 'it-shelf', item_number: 'SES3D6EB', vendor_code: 'SES3D6EB', description: 'Shelf', stocking_unit: 'each', retail_price: '201.61', cost: { real_cost: '114.9200' } },
};

function fakeAutomayt(overrides = {}) {
  const calls = [];
  const lookupTable = overrides.lookups || {
    'vendor_code:KERDIFIXBW': ['kerdifix'],
    'item_number:71': ['pad'],
    'item_number:ROLL1': ['roll'],
    'vendor_code:SES3D6EB': ['shelf'],
  };
  const routes = {
    'GET /customers': () => ({ data: [{ id: 'cust-house' }] }),
    'GET /vendors': () => ({ data: [{ id: 'ven-prosol' }] }),
    'GET /locations': () => ({ data: [{ id: 'loc-afc', external_refs: [{ system: 'run-orders', external_id: 'amazon-fulfillment' }] }], has_more: false }),
    'GET /contacts': () => ({ data: [] }),
    'GET /external-refs': () => ({ data: overrides.salesOrderRefs || [] }),
    'GET /sales-orders': (q) => (overrides.existingSo && q.get('channel') === 'shopify' ? { data: [overrides.existingSo] } : { data: [] }),
    'POST /purchase-orders/check-tracking': (q, body) => overrides.checkTracking
      ? overrides.checkTracking(body)
      : { results: body.tracking_codes.map((t) => ({ tracking_code: t, matches: (overrides.trackedCodes || []).includes(t) ? [{ id: 'po-old', number: 'PO-16999' }] : [] })) },
    'POST /items/batch-lookup': (q, body) => ({
      results: body.lookups.map((l) => {
        const k = l.vendor_code ? `vendor_code:${l.vendor_code}` : `item_number:${l.item_number}`;
        const hits = (lookupTable[k] || []).map((n) => ITEMS[n]);
        return { input: l, status: hits.length === 0 ? 'not_found' : hits.length === 1 ? 'matched' : 'ambiguous', items: hits };
      }),
    }),
    'POST /sales-orders': (q, body) => ({ id: 'so-1', number: 'SO-025900', ...body, lines: body.lines.map((l, i) => ({ ...l, id: `sol-${i + 1}` })) }),
    'POST /purchase-orders': (q, body) => ({ id: 'po-1', number: 'PO-17100', status: body.status, ...body, lines: body.lines.map((l, i) => ({ ...l, id: `pol-${i + 1}`, item_id: l.item_id })) }),
    'POST /purchase-orders/po-1/receipts': () => ({ id: 'rcv-1', posted: true, inventory_movement_ids: ['mv-1'] }),
  };
  global.fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace('/api/v1', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: p, query: u.searchParams, body, key: init.headers['Idempotency-Key'] });
    const custom = overrides.routes && overrides.routes[`${init.method} ${p}`];
    if (custom) return custom(u.searchParams, body);
    const route = routes[`${init.method} ${p}`];
    if (!route) return new Response(JSON.stringify({ error: { code: 'not_found', message: `${init.method} ${p}` } }), { status: 404 });
    return new Response(JSON.stringify(route(u.searchParams, body)), { status: 200, headers: { 'x-request-id': `req-${calls.length}` } });
  };
  return calls;
}

const shopifyOrder = {
  orderNumber: '#1400',
  email: 'buyer@example.com',
  customer: { firstName: 'Test', lastName: 'Buyer' },
  createdAt: '2026-09-30T15:04:00-07:00',
  items: [
    { id: 11, sku: '4172', title: 'KERDI-FIX', quantity: 2, price: '37.96' },
    { id: 12, sku: '71', title: 'Bona pad', quantity: 1, price: '9.99' },
    { id: 13, sku: 'ROLL1', title: 'DITRA-PS roll', quantity: 2, price: '811.31' },
  ],
};

// What Shopify charged on that order (channel-tax.shopifyOrderMoney shape).
const gst = (a) => [{ code: 'GST', amount: a }];
const shopifyMoney = {
  orderNumber: '#1400', province: 'AB', subtotal: 1708.53, shipping: 54.99, total: 1851.71, fee: 51.53, feeUnknown: false, paidVia: ['shopify_payments'],
  tax: gst('88.19'), taxTotal: 88.19, refunds: [], refunded: 0,
  lines: [
    { id: '11', sku: '4172', quantity: 2, total: 75.92, taxCharged: gst('3.80') },
    { id: '12', sku: '71', quantity: 1, total: 9.99, taxCharged: gst('0.50') },
    { id: '13', sku: 'ROLL1', quantity: 2, total: 1622.62, taxCharged: gst('81.13') },
  ],
  shippingLines: [{ title: 'Standard', total: 54.99, taxCharged: gst('2.76') }],
};

// ── Shopify ──────────────────────────────────────────────────────────────────

test('Shopify: one SO with every line, PO without own-stock lines, at item cost', async () => {
  const calls = fakeAutomayt();
  const r = await orders.createShopifySoPo({ shopifyOrder, money: shopifyMoney, trackingNumber: '520600000001', carrierCode: 'purolator_walleted' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.soNumber, 'SO-025900');
  assert.equal(r.poNumber, 'PO-17100');

  const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
  assert.equal(so.key, 'shopify-1400-so');
  assert.equal(so.body.procurement_mode, 'external');
  assert.equal(so.body.external_ref, '1400');
  assert.equal(so.body.order_date, '2026-09-30');
  // What the customer paid: the 2 rolls' Shopify total over 538 sqft, not the catalogue price.
  assert.deepEqual(so.body.lines.map((l) => [l.item_id || l.line_type, l.qty, l.unit_price]), [['it-kf', '2', '37.96'], ['it-pad', '1', '9.99'], ['it-roll', '538', '3.01602'], ['freight', '1', '54.99']]);
  assert.deepEqual(so.body.lines.map((l) => l.tax_charged), [gst('3.80'), gst('0.50'), gst('81.13'), gst('2.76')]);
  assert.equal(so.body.tax_treatment, null);
  assert.equal(so.body.ship_to_region, 'AB');
  assert.match(so.body.notes, /Shopify Payments fee 51\.53/);
  assert.equal(r.moneyCheck.diff, 0);

  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.equal(po.key, 'shopify-1400-po');
  assert.equal(po.body.status, 'confirmed');
  assert.equal(po.body.tracking_code, '520600000001');
  assert.deepEqual(po.body.lines.map((l) => [l.item_id, l.unit_cost, l.sales_order_line_id]), [['it-kf', '21.64', 'sol-1'], ['it-roll', '1.72', 'sol-3']]);
  assert.match(po.body.shipping_instructions, /^Shopify #1400 — Test Buyer — .* — purolator — Tracking: 520600000001$/);
});

test('Shopify: an ambiguous vendor code stops that line for a person', async () => {
  fakeAutomayt({ lookups: { 'vendor_code:KERDIFIXBW': ['kerdifix', 'shelf'], 'item_number:71': ['pad'] } });
  const r = await orders.createShopifySoPo({ shopifyOrder: { ...shopifyOrder, items: shopifyOrder.items.slice(0, 2) }, money: shopifyMoney });
  assert.ok(r.errors.some((e) => /matches 2 Automayt items .* a person must pick one/.test(e.error)));
});

test('Shopify: a QC order books GST as charged (no QST), freight and samples get their own lines', async () => {
  const calls = fakeAutomayt();
  const order = { orderNumber: '#1387', createdAt: '2026-09-16T10:00:00-07:00', items: [
    { id: 21, sku: '4172', title: 'KERDI-FIX', quantity: 1, price: '45.40' },
    { id: 22, sku: null, title: 'Oak sample', sampleOf: 'Oak', quantity: 1, price: '0.00' },
  ] };
  const money = { orderNumber: '#1387', province: 'QC', subtotal: 45.4, shipping: 12.99, total: 61.31, fee: 1.89, feeUnknown: false, paidVia: ['shopify_payments'], tax: gst('2.92'), refunds: [],
    lines: [{ id: '21', sku: '4172', quantity: 1, total: 45.4, taxCharged: gst('2.27') }, { id: '22', sku: null, quantity: 1, total: 0, taxCharged: [] }],
    shippingLines: [{ title: 'Standard', total: 12.99, taxCharged: gst('0.65') }] };
  const r = await orders.createShopifySoPo({ shopifyOrder: order, money });
  assert.deepEqual(r.errors, []);
  const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
  assert.deepEqual(so.body.lines.map((l) => [l.external_line_ref, l.description || l.item_id, l.unit_price, JSON.stringify(l.tax_charged)]), [
    ['line-1', 'it-kf', '45.4', JSON.stringify(gst('2.27'))],
    ['sample-1', 'Sample: Oak sample', '0', '[]'],
    ['freight-1', 'Shipping: Standard', '12.99', JSON.stringify(gst('0.65'))],
  ]);
  assert.equal(so.body.lines.flatMap((l) => l.tax_charged).some((t) => t.code === 'QST'), false);
  assert.deepEqual(r.moneyCheck, { shopifyTotal: 61.31, soSubtotal: 58.39, soTax: 2.92, soTotal: 61.31, diff: 0 });
  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.deepEqual(po.body.lines.map((l) => l.item_id), ['it-kf']);
});

test('Shopify: AUTOMAYT_TAX_AS_CHARGED=0 sends an exempt order and no tax_charged', async () => {
  process.env.AUTOMAYT_TAX_AS_CHARGED = '0';
  try {
    const calls = fakeAutomayt();
    await orders.createShopifySoPo({ shopifyOrder, money: shopifyMoney });
    const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
    assert.equal(so.body.tax_treatment.gst_exempt, true);
    assert.equal(so.body.lines.some((l) => 'tax_charged' in l), false);
  } finally {
    delete process.env.AUTOMAYT_TAX_AS_CHARGED;
  }
});

test('Shopify: no SO when what Shopify charged cannot be read', async () => {
  const saved = process.env.SHOPIFY_STORE;
  delete process.env.SHOPIFY_STORE;
  try {
    const calls = fakeAutomayt();
    const r = await orders.createShopifySoPo({ shopifyOrder });
    assert.match(r.errors[0].error, /could not read what Shopify charged, SO not created/);
    assert.equal(calls.some((c) => c.method === 'POST'), false);
  } finally {
    if (saved !== undefined) process.env.SHOPIFY_STORE = saved;
  }
});

test('Shopify refunds: full refund before invoicing cancels the SO; partial is credit-note-pending', async () => {
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const so = { id: 'so-r', number: 'SO-026000', status: 'confirmed', version: 'v1' };
  const calls = fakeAutomayt({ existingSo: so, routes: {
    'GET /sales-orders/so-r': () => json(so),
    'POST /sales-orders/so-r/cancel': (q, body) => json({ ...so, status: 'cancelled', reason: body.reason }),
  } });
  const full = { orderNumber: '#1383', total: 242.19, refunded: 242.19, fullyRefunded: true, cancelledAt: '2026-09-15T16:44:39Z', fee: 6.6, refunds: [{ id: '1', total: 242.19, items: [], shipping: [], tax: [{ code: 'HST', amount: '27.86' }] }] };
  const dry = await orders.reconcileShopifyRefund({ orderNumber: '#1383', money: full });
  assert.equal(dry.action, 'cancel');
  assert.equal(dry.applied, false);
  const done = await orders.reconcileShopifyRefund({ orderNumber: '#1383', money: full, apply: true });
  assert.equal(done.applied, true);
  const cancel = calls.find((c) => c.path === '/sales-orders/so-r/cancel');
  assert.equal(cancel.key, 'shopify-1383-cancel');
  assert.match(cancel.body.reason, /refunded in full \(242\.19\); Shopify kept its 6\.60 processing fee/);
  const partial = await orders.reconcileShopifyRefund({ orderNumber: '#1383', money: { ...full, cancelledAt: null, refunded: 20, fullyRefunded: false } });
  assert.equal(partial.action, 'credit-note-pending');
});

test('Shopify: a failed duplicate guard aborts with nothing created', async () => {
  const calls = fakeAutomayt({ routes: { 'POST /purchase-orders/check-tracking': () => new Response(JSON.stringify({ error: { code: 'forbidden_scope', message: 'no' } }), { status: 403 }) } });
  const r = await orders.createShopifySoPo({ shopifyOrder, money: shopifyMoney, trackingNumber: 'T-X' });
  assert.match(r.errors[0].error, /duplicate guard failed/);
  assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/sales-orders'), false);
});

test('Shopify: an existing SO is a skip that names its PO first', async () => {
  fakeAutomayt({ existingSo: { id: 'so-old', number: 'SO-025800', purchase_orders: [{ id: 'po-o', number: 'PO-17000' }] } });
  const r = await orders.createShopifySoPo({ shopifyOrder, money: shopifyMoney });
  assert.equal(r.skipped, true);
  assert.deepEqual(r.existingCandidates, ['PO-17000', 'SO-025800']);
});

// ── Amazon ───────────────────────────────────────────────────────────────────

test('Amazon: tracked parcels skip, new parcel lands on the period SO and is received at PO cost', async () => {
  const calls = fakeAutomayt({ trackedCodes: ['TRK-OLD'] });
  const prefetched = {
    unresolved: [],
    shipments: [
      { orderNumber: '701-0000000-0000001', trackingNumber: 'TRK-OLD', shipDate: '2026-09-29', items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] },
      { orderNumber: '701-0000000-0000002', trackingNumber: 'TRK-NEW', shipDate: '2026-09-29', carrierCode: 'purolator_walleted', shipTo: { name: 'X', city: 'Y', postalCode: 'V0N' }, items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] },
    ],
  };
  const r = await orders.createAmazonPOs({ prefetched });
  const byTrk = Object.fromEntries(r.orders.map((o) => [o.trackingNumber, o]));
  assert.equal(byTrk['TRK-OLD'].status, 'skipped');
  assert.equal(byTrk['TRK-NEW'].status, 'created', JSON.stringify(byTrk['TRK-NEW'].errors));
  assert.deepEqual(r.soNames, ['SO-025900']);

  const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
  assert.equal(so.body.external_ref, 'period:2026-09-18');
  assert.equal(so.key, 'amazon-period:2026-09-18-open-TRK-NEW');
  assert.equal(so.body.lines[0].external_line_ref, 'TRK-NEW:1');
  assert.equal(so.body.tax_treatment.gst_exempt, true);

  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.equal(po.body.location_id, 'loc-afc');
  assert.equal(po.body.lines[0].unit_cost, '114.92');

  const rcv = calls.find((c) => c.path === '/purchase-orders/po-1/receipts');
  assert.equal(rcv.key, 'amazon-TRK-NEW-rcv');
  assert.equal(rcv.body.received_at, '2026-09-29T12:00:00-07:00');
  assert.equal('unit_cost' in rcv.body.lines[0], false);
});

test('Amazon: parcels added to an existing period SO stay GST/PST exempt', async () => {
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const calls = fakeAutomayt({
    routes: {
      'GET /sales-orders': (q) => json({ data: q.get('channel') === 'amazon' ? [{ id: 'so-p', number: 'SO-025950', external_ref: q.get('external_ref') }] : [] }),
      'POST /sales-orders/so-p/lines': (q, body) => json({ added: body.lines }),
      'GET /sales-orders/so-p/lines': () => json({ data: [{ id: 'sol-9', external_line_ref: 'TRK-2ND:1' }], has_more: false }),
      'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-025950' }),
    },
  });
  const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [{ orderNumber: '701-2', trackingNumber: 'TRK-2ND', shipDate: '2026-09-29', items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] }] } });
  assert.equal(r.orders[0].status, 'created', JSON.stringify(r.orders[0].errors));
  const add = calls.find((c) => c.path === '/sales-orders/so-p/lines' && c.method === 'POST');
  assert.deepEqual(add.body.tax_treatment, { gst_exempt: true, pst_exempt: true, gst_exempt_id: 'Third Party Amazon', pst_exempt_id: 'Third Party Amazon' });
  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.equal(po.body.lines[0].sales_order_line_id, 'sol-9');
});

test('Amazon: the migrated period order is found through its external ref', async () => {
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const calls = fakeAutomayt({
    salesOrderRefs: [{ system: 'run-orders', entity_type: 'sales_order', external_id: 'period:2026-09-18', id: 'so-mig' }],
    routes: {
      'GET /sales-orders/so-mig': () => json({ id: 'so-mig', number: 'SO-026700' }),
      'POST /sales-orders/so-mig/lines': (q, body) => json({ added: body.lines }),
      'GET /sales-orders/so-mig/lines': () => json({ data: [{ id: 'sol-m', external_line_ref: 'TRK-M:1' }], has_more: false }),
    },
  });
  const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [{ orderNumber: '701-3', trackingNumber: 'TRK-M', shipDate: '2026-09-29', items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] }] } });
  assert.equal(r.orders[0].status, 'created', JSON.stringify(r.orders[0].errors));
  const ref = calls.find((c) => c.path === '/external-refs');
  assert.equal(ref.query.get('entity_type'), 'sales_order');
  assert.equal(ref.query.get('external_id'), 'period:2026-09-18');
  assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/sales-orders'), false);
});

test('Amazon: in production an unmapped anchor period is refused, a later period opens', async () => {
  const saved = { base: process.env.AUTOMAYT_API_BASE, key: process.env.AUTOMAYT_API_KEY };
  process.env.AUTOMAYT_API_BASE = 'https://app.automayt.com/api/v1';
  process.env.AUTOMAYT_API_KEY = 'amk_live_unit_secret';
  try {
    let calls = fakeAutomayt();
    const parcel = (trk, shipDate) => ({ orderNumber: `701-${trk}`, trackingNumber: trk, shipDate, items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] });
    const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [parcel('TRK-A', '2026-09-29')] } });
    assert.equal(r.orders[0].status, 'error');
    assert.match(r.orders[0].errors.join(' '), /ALERT: Amazon Sep 18 - Oct 1 \(period:2026-09-18\) has no mapped Automayt order/);
    assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/sales-orders'), false);
    calls = fakeAutomayt();
    const later = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [parcel('TRK-B', '2026-10-05')] } });
    assert.equal(later.orders[0].status, 'created', JSON.stringify(later.orders[0].errors));
    assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/sales-orders').body.external_ref, 'period:2026-10-02');
  } finally {
    process.env.AUTOMAYT_API_BASE = saved.base;
    process.env.AUTOMAYT_API_KEY = saved.key;
  }
});

test('Amazon: a closed period posts CFC GST/HST as one tax-only line, provisional is refused', async () => {
  const erp = require('./automayt-erp');
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const calls = fakeAutomayt({
    routes: {
      'GET /sales-orders': () => json({ data: [{ id: 'so-p', number: 'SO-026800', external_ref: 'period:2026-10-22' }] }),
      'POST /sales-orders/so-p/lines': (q, body) => json({ added: body.lines }),
    },
  });
  const line = { description: 'Amazon.ca GST/HST collected', qty: '1', unit_price: '0', external_line_ref: 'tax:2026-10-22', tax_charged: [{ code: 'GST', amount: '577.21' }, { code: 'HST', amount: '1361.59' }] };
  const record = { provisional: false, period: { key: 'period:2026-10-22', label: 'Oct 22 - Nov 4' }, automaytLine: line };
  await assert.rejects(erp.postAmazonPeriodTax({ ...record, provisional: true }), /provisional/);
  const res = await erp.postAmazonPeriodTax(record);
  assert.equal(res.posted, true);
  const add = calls.find((c) => c.path === '/sales-orders/so-p/lines');
  assert.equal(add.key, 'amazon-period:2026-10-22-tax');
  assert.deepEqual(add.body.lines, [line]);
});

test('Amazon: a failed tracking check creates nothing', async () => {
  const calls = fakeAutomayt({ routes: { 'POST /purchase-orders/check-tracking': () => new Response(JSON.stringify({ error: { code: 'forbidden_scope', message: 'no' } }), { status: 403 }) } });
  const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [{ orderNumber: 'A', trackingNumber: 'T', items: [] }] } });
  assert.match(r.errors[0].error, /duplicate guard failed/);
  assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/purchase-orders'), false);
});

// ── FBA ──────────────────────────────────────────────────────────────────────

test('FBA: stock PO into Amazon Fulfillment, draft lines stamped', async () => {
  const calls = fakeAutomayt();
  const draft = { draftId: 'draft-2026-09-30-abc', createdAt: '2026-09-30T18:00:00.000Z' };
  const lines = [{ asin: 'B07QBD5Q86', qty: 10, product: 'Shelf', vendor: 'prosol' }];
  const r = await orders.createFbaPO({ vendor: 'prosol', draft, lines, bucket: 'instock' });
  assert.equal(r.created, true);
  assert.equal(r.poNumber, 'PO-17100');
  assert.equal(lines[0].automaytPoNumber, 'PO-17100');
  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.equal(po.body.type, 'stock');
  assert.equal(po.body.channel, 'fba');
  assert.match(po.body.external_ref, /^draft-2026-09-30-abc:instock:[0-9a-f]{10}$/);
  assert.equal(po.body.order_date, '2026-09-30');
  assert.equal(po.key, `fba-${po.body.external_ref}-po`);
});

test('FBA: an unmapped vendor is skipped like Salesforce', async () => {
  const r = await orders.createFbaPO({ vendor: 'perfectlevel', draft: { draftId: 'd' }, lines: [] });
  assert.equal(r.skipped, true);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test('category table: grout/adhesive to one category, everything else Accessories', () => {
  assert.equal(orders.categoryFor({ category: 'Grout / Sealant' }), 'Supplies');
  assert.equal(orders.categoryFor({ category: 'TOOLS' }), 'Accessories');
  assert.equal(orders.categoryFor(null), 'Accessories');
});

test('received_at: ship date at noon Pacific when past, server time when today or later', () => {
  assert.equal(orders.amazonReceivedAt('2026-01-05'), '2026-01-05T12:00:00-07:00');
  assert.equal(orders.amazonReceivedAt('2999-01-01'), null);
});

test('FBA channel refs differ per line set in one draft bucket', () => {
  const d = { draftId: 'draft-x' };
  assert.notEqual(orders.fbaExternalRef(d, 'instock', [{ asin: 'A' }]), orders.fbaExternalRef(d, 'instock', [{ asin: 'B' }]));
  assert.equal(orders.fbaExternalRef(d, 'instock', [{ asin: 'A' }, { asin: 'B' }]), orders.fbaExternalRef(d, 'instock', [{ asin: 'B' }, { asin: 'A' }]));
});
