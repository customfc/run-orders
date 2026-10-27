const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';
process.env.AMAZON_PERIOD_ANCHOR = '2026-09-18';
delete process.env.AUTOMAYT_REF_SYSTEM;
delete process.env.AUTOMAYT_REF_OVERRIDES;
delete process.env.AUTOMAYT_TEST_CODE_PREFIX;
// FBA sales fetch from the live Finances API; tests that want them hand them in.
process.env.AUTOMAYT_FBA_SALES = '0';

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
    'GET /sales-orders/so-1': () => ({ id: 'so-1', number: 'SO-025900', invoices: [] }),
    'POST /sales-orders/so-1/invoice': () => ({ id: 'inv-1', number: 'INV-0100', status: 'draft' }),
    'POST /sales-orders/so-1/shipments': (q, body) => ({ id: 'shp-1', sales_order: { id: 'so-1', number: 'SO-025900' }, location_id: body.location_id, lines: body.lines.map((l, i) => ({ id: `shl-${i + 1}`, sales_order_line_id: l.line_id, qty: l.qty })) }),
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

  // Received into Amazon Fulfillment, then shipped straight back out to the buyer.
  const shp = calls.find((c) => c.path === '/sales-orders/so-1/shipments');
  assert.ok(calls.indexOf(shp) > calls.indexOf(rcv));
  assert.equal(shp.key, 'amazon-TRK-NEW-ship-2026-09-29');
  assert.deepEqual(shp.body, { location_id: 'loc-afc', reference: 'TRK-NEW', notes: null, lines: [{ line_id: 'sol-1', qty: '1' }], shipped_at: '2026-09-29T12:00:00-07:00' });
  assert.deepEqual(byTrk['TRK-NEW'].shipment, { shipped: true, id: 'shp-1', lines: [{ ref: 'TRK-NEW:1', qty: 1 }] });
});

test('Amazon: a parcel whose PO exists but was never shipped out is shipped on the re-run; a shipped one is left alone', async () => {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  for (const shipped of [0, 1]) {
    const calls = fakeAutomayt({
      routes: {
        'GET /sales-orders': (q) => json({ data: q.get('channel') === 'amazon' ? [{ id: 'so-p', number: 'SO-025950', external_ref: q.get('external_ref') }] : [] }),
        'POST /sales-orders/so-p/lines': (q, body) => json({ added: [] }),
        'GET /sales-orders/so-p/lines': () => json({ data: [{ id: 'sol-9', item_id: 'it-shelf', qty: '1', qty_shipped: String(shipped), external_line_ref: 'TRK-R:1' }], has_more: false }),
        'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-025950' }),
        'POST /purchase-orders': () => json({ error: { code: 'duplicate', message: 'dup', details: { existing_id: 'po-9' } } }, 409),
        'GET /purchase-orders/po-9': () => json({ id: 'po-9', number: 'PO-17101', lines: [] }),
        'POST /sales-orders/so-p/shipments': (q, body) => json({ id: 'shp-9', lines: body.lines }),
      },
    });
    const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [{ orderNumber: '701-3', trackingNumber: 'TRK-R', shipDate: '2026-09-29', items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] }] } });
    const shp = calls.filter((c) => c.path === '/sales-orders/so-p/shipments');
    assert.equal(r.orders[0].status, 'skipped', JSON.stringify(r.orders[0].errors));
    assert.equal(shp.length, shipped ? 0 : 1);
    assert.equal(r.orders[0].shipment.shipped, !shipped);
  }
});

test('Amazon: a shipment failure is reported on the parcel without undoing the receipt; AUTOMAYT_SHIP_FROM_AMAZON=0 turns shipping off', async () => {
  const shipment = { orderNumber: '701-4', trackingNumber: 'TRK-F', shipDate: '2026-09-29', items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] };
  fakeAutomayt({ routes: { 'POST /sales-orders/so-1/shipments': () => new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'item has no cost' } }), { status: 422 }) } });
  let r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [shipment] } });
  assert.equal(r.orders[0].status, 'partial');
  assert.equal(r.orders[0].received, true);
  assert.match(r.orders[0].errors[0], /Ship out of Amazon Fulfillment/);

  process.env.AUTOMAYT_SHIP_FROM_AMAZON = '0';
  try {
    const calls = fakeAutomayt();
    r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [shipment] } });
    assert.equal(r.orders[0].status, 'created');
    assert.equal(calls.some((c) => c.path.endsWith('/shipments')), false);
  } finally {
    delete process.env.AUTOMAYT_SHIP_FROM_AMAZON;
  }
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

test('Amazon: period lines carry Amazon\'s sale price and the buyer\'s shipping once per order', async () => {
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const calls = fakeAutomayt({
    routes: {
      'GET /sales-orders': (q) => json({ data: q.get('channel') === 'amazon' ? [{ id: 'so-p', number: 'SO-025950', external_ref: q.get('external_ref') }] : [] }),
      'POST /sales-orders/so-p/lines': (q, body) => json({ added: body.lines }),
      'GET /sales-orders/so-p/lines': () => json({ data: [{ id: 'sol-9', external_line_ref: 'TRK-S:1' }, { id: 'sol-s', external_line_ref: '701-S:ship' }], has_more: false }),
      'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-025950' }),
    },
  });
  const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [{ orderNumber: '701-S', trackingNumber: 'TRK-S', shipDate: '2026-09-29', orderShipping: 7.99, items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] }] } });
  assert.equal(r.orders[0].status, 'created', JSON.stringify(r.orders[0].errors));
  const add = calls.find((c) => c.path === '/sales-orders/so-p/lines' && c.method === 'POST');
  assert.deepEqual(add.body.lines.map((l) => [l.external_line_ref, l.item_id || l.description, l.qty, l.unit_price, l.line_type]), [
    ['TRK-S:1', 'it-shelf', '1', '199', 'material'],
    ['701-S:ship', 'Amazon shipping, order 701-S', '1', '7.99', 'delivery'],
  ]);
  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.equal(po.body.lines.length, 1);
  assert.equal(po.body.lines[0].sales_order_line_id, 'sol-9');
});

test('priceAmazonLines: bundles split by catalogue value, area items per sq ft, cents exact', () => {
  const items = [{ sku: 'BUNDLE', quantity: 2, unitPrice: 100 }, { sku: 'ROLL', quantity: 2, unitPrice: 950 }, { sku: 'NOPRICE', quantity: 1 }];
  const lines = [
    { itemIdx: 0, quantity: 2, catalogPrice: 37.96 },
    { itemIdx: 0, quantity: 1, catalogPrice: 9.99 },
    { itemIdx: 1, quantity: 538, catalogPrice: 3.02 },
    { itemIdx: 2, quantity: 1, catalogPrice: 12.5 },
  ];
  const note = orders.priceAmazonLines(items, lines);
  const total = (i) => Math.round(Number(lines[i].salePrice) * lines[i].quantity * 100);
  assert.equal(total(0) + total(1), 20000);
  assert.equal(total(0), 17674);
  assert.equal(total(2), 190000);
  assert.equal(lines[3].salePrice, '12.5');
  assert.match(note, /NOPRICE: catalogue price used/);
  assert.equal(orders.priceAmazonLines([{ sku: 'A', quantity: 1, unitPrice: 5 }], [{ itemIdx: 0, quantity: 1, catalogPrice: 0 }]), null);
});

test('Amazon: a period order mapped by external ref is found through it', async () => {
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

test('Amazon: in production a period before the cutover is refused, the cut-off stub and later periods open', async () => {
  const saved = { base: process.env.AUTOMAYT_API_BASE, key: process.env.AUTOMAYT_API_KEY, cut: process.env.AMAZON_CUTOVER_DATE };
  process.env.AUTOMAYT_API_BASE = 'https://app.automayt.com/api/v1';
  process.env.AUTOMAYT_API_KEY = 'amk_live_unit_secret';
  process.env.AMAZON_CUTOVER_DATE = '2026-09-25';
  try {
    const parcel = (trk, shipDate) => ({ orderNumber: `701-${trk}`, trackingNumber: trk, shipDate, items: [{ sku: 'B07QBD5Q86', name: 'Shelf', quantity: 1, unitPrice: 199 }] });
    let calls = fakeAutomayt();
    const before = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [parcel('TRK-A', '2026-09-24')] } });
    assert.equal(before.orders[0].status, 'error');
    assert.match(before.orders[0].errors.join(' '), /ALERT: Amazon Sep 18 - 24 \(period:2026-09-18\) is before the 2026-09-25 cutover and belongs to Salesforce/);
    assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/sales-orders'), false);
    calls = fakeAutomayt();
    const stub = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [parcel('TRK-B', '2026-09-29')] } });
    assert.equal(stub.orders[0].status, 'created', JSON.stringify(stub.orders[0].errors));
    const open = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders').body;
    assert.equal(open.external_ref, 'period:2026-09-25');
    assert.match(open.notes, /Sep 25 - Oct 1 \(2026-09-25 to 2026-10-01\)/);
    calls = fakeAutomayt();
    const later = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [parcel('TRK-C', '2026-10-05')] } });
    assert.equal(later.orders[0].status, 'created', JSON.stringify(later.orders[0].errors));
    assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/sales-orders').body.external_ref, 'period:2026-10-02');
  } finally {
    process.env.AUTOMAYT_API_BASE = saved.base;
    process.env.AUTOMAYT_API_KEY = saved.key;
    if (saved.cut === undefined) delete process.env.AMAZON_CUTOVER_DATE; else process.env.AMAZON_CUTOVER_DATE = saved.cut;
  }
});

test('Amazon: a closed period posts CFC GST/HST as one tax-only line, provisional and pre-cutover are refused', async () => {
  const erp = require('./automayt-erp');
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const calls = fakeAutomayt({
    routes: {
      'GET /sales-orders': () => json({ data: [{ id: 'so-p', number: 'SO-026800', external_ref: 'period:2026-11-05' }] }),
      'POST /sales-orders/so-p/lines': (q, body) => json({ added: body.lines }),
      'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-026800', invoices: [] }),
      'POST /sales-orders/so-p/invoice': () => json({ id: 'inv-p', number: 'INV-0200', status: 'draft' }),
    },
  });
  const line = { description: 'Amazon.ca GST/HST collected', qty: '1', unit_price: '0', external_line_ref: 'tax:2026-11-05', tax_charged: [{ code: 'GST', amount: '577.21' }, { code: 'HST', amount: '1361.59' }] };
  const record = { provisional: false, period: { start: '2026-11-05', key: 'period:2026-11-05', label: 'Nov 5 - 18' }, automaytLine: line };
  await assert.rejects(erp.postAmazonPeriodTax({ ...record, provisional: true }), /provisional/);
  await assert.rejects(erp.postAmazonPeriodTax({ ...record, period: { start: '2026-10-22', key: 'period:2026-10-22', label: 'Oct 22 - 31' } }), /before the 2026-11-01 cutover/);
  const res = await erp.postAmazonPeriodTax(record);
  assert.equal(res.posted, true);
  const add = calls.find((c) => c.path === '/sales-orders/so-p/lines');
  assert.equal(add.key, 'amazon-period:2026-11-05-tax');
  assert.deepEqual(add.body.lines, [line]);
  // Invoiced last, as a draft for Steph to post.
  assert.deepEqual(res.invoice, { number: 'INV-0200', status: 'draft', created: true });
  const inv = calls.find((c) => c.path === '/sales-orders/so-p/invoice');
  assert.equal(inv.key, 'amazon-period:2026-11-05-invoice');
  assert.ok(calls.indexOf(inv) > calls.indexOf(add));
  assert.equal(calls.some((c) => c.path === '/invoices/inv-p/post'), false);
});

test('Amazon: the period close sets the fees withheld from sales as the order\'s processing fee, once; an invoiced order refuses', async () => {
  const erp = require('./automayt-erp');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  let held = null;
  let invoices = [];
  const calls = fakeAutomayt({
    routes: {
      'GET /sales-orders': () => json({ data: [{ id: 'so-p', number: 'SO-026800', external_ref: 'period:2026-11-05' }] }),
      'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-026800', version: 'v3', processing_fees: held, invoices }),
      'PATCH /sales-orders/so-p': (q, body) => { held = body.processing_fees; return json({ id: 'so-p', processing_fees: held }); },
      'POST /sales-orders/so-p/lines': (q, body) => json({ added: body.lines }),
      'POST /sales-orders/so-p/invoice': () => { invoices = [{ id: 'inv-p', number: 'INV-0200', status: 'draft', type: 'full' }]; return json(invoices[0]); },
    },
  });
  const record = { provisional: false, period: { start: '2026-11-05', key: 'period:2026-11-05', label: 'Nov 5 - 18' }, automaytLine: { tax_charged: [] }, fees: { total: 3576.49, tax: 422.24, byType: {} } };
  const res = await erp.postAmazonPeriodTax(record);
  assert.deepEqual(res.fees, { processingFees: '3576.49', changed: true });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { processing_fees: '3576.49', expected_version: 'v3' });
  assert.equal(patch.key, 'so-fees-so-p-3576.49');
  const again = await erp.postAmazonPeriodTax(record);
  assert.equal(again.fees.changed, false);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(again.invoice.created, false, 'the draft from the first close is kept, not doubled');
  assert.equal(calls.filter((c) => c.path === '/sales-orders/so-p/invoice').length, 1);

  held = '100.00';
  fakeAutomayt({ routes: {
    'GET /sales-orders': () => json({ data: [{ id: 'so-p', number: 'SO-026800', external_ref: 'period:2026-11-05' }] }),
    'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-026800', version: 'v4', processing_fees: held }),
    'PATCH /sales-orders/so-p': () => json({ error: { code: 'invalid_state', message: 'locked', details: { locked_fields: ['processing_fees'] } } }, 409),
  } });
  await assert.rejects(erp.postAmazonPeriodTax(record), /SO-026800: processing fee 3576\.49 not set, the order is invoiced .*holds 100\.00/);
});

test('Shopify: the processing fee before tax goes on the SO; PayPal (fee unknown) sends none', async () => {
  for (const [money, want] of [
    [{ ...shopifyMoney, fees: [{ kind: 'SALE', type: 'payment', amount: 49.08, tax: 2.45 }] }, '49.08'],
    [{ ...shopifyMoney, fee: 0, feeUnknown: true, paidVia: ['paypal'], fees: [] }, undefined],
  ]) {
    const calls = fakeAutomayt();
    await orders.createShopifySoPo({ shopifyOrder, money, trackingNumber: 'T-FEE' });
    const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
    assert.equal(so.body.processing_fees, want);
  }
});

test('Shopify: the SO is invoiced as a draft (Steph posts it), and a failed invoice still sends the PO', async () => {
  let calls = fakeAutomayt();
  let r = await orders.createShopifySoPo({ shopifyOrder, money: shopifyMoney, trackingNumber: 'T-INV' });
  const inv = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders/so-1/invoice');
  assert.equal(inv.key, 'shopify-1400-invoice');
  assert.equal(r.invoiceNumber, 'INV-0100');
  assert.equal(calls.some((c) => /\/invoices\/.*\/post$/.test(c.path)), false, 'never posted');
  assert.ok(calls.findIndex((c) => c.path === '/purchase-orders') > calls.indexOf(inv));

  calls = fakeAutomayt({ routes: { 'POST /sales-orders/so-1/invoice': () => new Response(JSON.stringify({ error: { code: 'forbidden_scope', message: 'no invoices:write' } }), { status: 403 }) } });
  r = await orders.createShopifySoPo({ shopifyOrder, money: shopifyMoney, trackingNumber: 'T-INV2' });
  assert.equal(r.steps.find((s) => s.step === 'draft-invoice').success, false);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/purchase-orders'));
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

test('category table: grout and adhesive to their own categories, everything else Accessories', () => {
  assert.equal(orders.categoryFor({ category: 'Grout / Sealant' }), 'Grout');
  assert.equal(orders.categoryFor({ category: 'Flooring Adhesive' }), 'Adhesive');
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

// ── FBA sales ────────────────────────────────────────────────────────────────

const money = (n) => ({ currencyAmount: n, currencyCode: 'CAD' });
function fbaTx({ id, order, status = 'DEFERRED', posted, items, type = 'Shipment', deferredFrom = null, marketplace = 'A2EUQ1WTGCTBG2', shipment = 'SHIP1' }) {
  return {
    transactionId: id,
    transactionType: type,
    transactionStatus: status,
    postedDate: posted,
    marketplaceDetails: { marketplaceId: marketplace },
    relatedIdentifiers: [
      { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: order },
      { relatedIdentifierName: 'SHIPMENT_ID', relatedIdentifierValue: shipment },
      ...(deferredFrom ? [{ relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: deferredFrom }] : []),
    ],
    items: items.map((it) => ({
      description: it.title || 'item',
      contexts: [{ contextType: 'ProductContext', asin: it.asin, sku: it.sku, quantityShipped: it.qty, fulfillmentNetwork: it.network || 'AFN' }],
      breakdowns: [
        { breakdownType: 'ProductCharges', breakdownAmount: money(it.principal), breakdowns: [{ breakdownType: 'OurPricePrincipal', breakdownAmount: money(it.principal) }] },
        { breakdownType: 'Tax', breakdownAmount: money(it.tax || 0) },
        ...(it.shipping ? [{ breakdownType: 'Shipping', breakdownAmount: money(it.shipping) }] : []),
        ...(it.shipDisc ? [{ breakdownType: 'PromoRebates', breakdownAmount: money(it.shipDisc), breakdowns: [{ breakdownType: 'ShippingDiscount', breakdownAmount: money(it.shipDisc) }] }] : []),
        { breakdownType: 'AmazonFees', breakdownAmount: money(-20) },
      ],
    })),
  };
}

test('FBA sales: AFN shipments counted like the Date Range report, Pacific day, principal and shipping net of discount', () => {
  const sales = orders.fbaSalesFromTransactions([
    fbaTx({ id: 't1', order: '701-A', posted: '2026-10-23T05:53:40Z', items: [{ asin: 'B1', sku: 'S1-FBA', qty: 2, principal: 252.64, shipping: 4.66, shipDisc: -4.66 }] }),
    fbaTx({ id: 't2', order: '701-B', status: 'RELEASED', posted: '2026-10-10T05:47:19Z', items: [{ asin: 'B2', sku: 'kerdiseal34', qty: 2, principal: 31.98, shipping: 3.58 }] }),
    // the release of a deferred original: counted when it first posted, never again
    fbaTx({ id: 't3', order: '701-C', status: 'RELEASED', deferredFrom: 'tx-orig', posted: '2026-10-19T17:17:50Z', items: [{ asin: 'B3', sku: 'Z8', qty: 1, principal: 169.99 }] }),
    fbaTx({ id: 't4', order: '701-D', type: 'Refund', posted: '2026-10-18T01:14:49Z', items: [{ asin: 'B3', sku: 'Z8', qty: 1, principal: -169.99 }] }),
    fbaTx({ id: 't5', order: '702-M', posted: '2026-10-20T18:00:00Z', items: [{ asin: 'B4', sku: 'MFN1', qty: 1, principal: 50, network: 'MFN' }] }),
    fbaTx({ id: 't6', order: '111-US', posted: '2026-10-20T18:00:00Z', marketplace: 'ATVPDKIKX0DER', items: [{ asin: 'B5', sku: 'US1', qty: 1, principal: 40 }] }),
  ]);
  assert.deepEqual(sales.map((s) => [s.orderId, s.day, s.shipping]), [['701-B', '2026-10-09', 3.58], ['701-A', '2026-10-22', 0]]);
  assert.equal(Math.round(sales[1].items[0].unitPrice * sales[1].items[0].quantity * 100), 25264);
  assert.deepEqual(sales[1].items[0], { asin: 'B1', sellerSku: 'S1-FBA', quantity: 2, unitPrice: 126.32, name: 'item' });
  assert.equal(sales[1].shipmentId, 'SHIP1');
});

const fbaSale = (over = {}) => ({
  orderId: '701-F',
  shipmentId: 'SHIP1',
  transactionId: 'tx-f',
  postedDate: '2026-09-29T18:00:00Z',
  day: '2026-09-29',
  items: [{ asin: 'B07QBD5Q86', sellerSku: 'SES3D6EB-FBA', quantity: 1, unitPrice: 189.5, name: 'Shelf' }],
  shipping: 3.58,
  ...over,
});

// existing: refs, or { ref, qtyShipped } for a line already on the order (item lines ship qty 1).
function fbaRoutes(existing = [], { shipment } = {}) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const asLine = (ref, i, qtyShipped = 0) => ({ id: `sol-${i}`, external_line_ref: ref, item_id: ref.endsWith(':ship') ? null : 'it-shelf', qty: '1', qty_shipped: String(qtyShipped) });
  const lines = existing.map((e, i) => (typeof e === 'string' ? asLine(e, i) : asLine(e.ref, i, e.qtyShipped)));
  return {
    'GET /sales-orders': (q) => json({ data: q.get('channel') === 'amazon' ? [{ id: 'so-p', number: 'SO-025950', external_ref: q.get('external_ref') }] : [] }),
    'POST /sales-orders/so-p/lines': (q, body) => {
      for (const l of body.lines) if (!lines.some((x) => x.external_line_ref === l.external_line_ref)) lines.push(asLine(l.external_line_ref, lines.length));
      return json({ added: body.lines });
    },
    'GET /sales-orders/so-p/lines': () => json({ data: lines, has_more: false }),
    'GET /sales-orders/so-p': () => json({ id: 'so-p', number: 'SO-025950' }),
    'POST /sales-orders/so-p/shipments': (q, body) => (shipment ? shipment(body) : json({ id: 'shp-f', lines: body.lines })),
  };
}

test('FBA sales: lines on the period order at Amazon\'s price plus buyer shipping, no PO', async () => {
  const calls = fakeAutomayt({ routes: fbaRoutes() });
  const r = await orders.addFbaSales({ sales: [fbaSale()] });
  assert.equal(r.orders[0].status, 'created', JSON.stringify(r.orders[0].errors));
  assert.deepEqual(r.soNames, ['SO-025950']);
  const add = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders/so-p/lines');
  assert.deepEqual(add.body.lines.map((l) => [l.external_line_ref, l.item_id || l.description, l.qty, l.unit_price, l.line_type]), [
    ['fba:701-F:SHIP1:1', 'it-shelf', '1', '189.5', 'material'],
    ['fba:701-F:SHIP1:ship', 'Amazon shipping, FBA order 701-F', '1', '3.58', 'delivery'],
  ]);
  assert.deepEqual(add.body.tax_treatment, { gst_exempt: true, pst_exempt: true, gst_exempt_id: 'Third Party Amazon', pst_exempt_id: 'Third Party Amazon' });
  assert.equal(add.key, 'amazon-period:2026-09-18-fba:701-F:SHIP1-lines');
  assert.equal(calls.filter((c) => c.path.startsWith('/purchase-orders')).length, 0);

  // Shipped out of Amazon Fulfillment when Amazon posted it: item lines only, not the shipping line.
  const shp = calls.find((c) => c.path === '/sales-orders/so-p/shipments');
  assert.equal(shp.key, 'fba-fba:701-F:SHIP1-ship-2026-09-29');
  assert.deepEqual(shp.body, { location_id: 'loc-afc', reference: '701-F SHIP1', notes: null, lines: [{ line_id: 'sol-0', qty: '1' }], shipped_at: '2026-09-29T18:00:00Z' });
  assert.equal(r.orders[0].shipment.shipped, true);
});

test('FBA sales: a sale already on the order and shipped is skipped without a write', async () => {
  const calls = fakeAutomayt({ routes: fbaRoutes([{ ref: 'fba:701-F:SHIP1:1', qtyShipped: 1 }, 'fba:701-F:SHIP1:ship']) });
  const r = await orders.addFbaSales({ sales: [fbaSale()] });
  assert.equal(r.orders[0].status, 'skipped');
  assert.match(r.orders[0].reason, /already on the Sep 18 - Oct 1 order/);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/sales-orders')).length, 0);
});

test('FBA sales: a sale on the order but never shipped out is shipped on the re-run, no lines re-sent', async () => {
  const calls = fakeAutomayt({ routes: fbaRoutes(['fba:701-F:SHIP1:1', 'fba:701-F:SHIP1:ship', 'fba:701-OTHER:S:1']) });
  const r = await orders.addFbaSales({ sales: [fbaSale()] });
  assert.equal(r.orders[0].status, 'skipped');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/sales-orders/so-p/lines').length, 0);
  const shp = calls.filter((c) => c.path === '/sales-orders/so-p/shipments');
  assert.equal(shp.length, 1);
  assert.deepEqual(shp[0].body.lines, [{ line_id: 'sol-0', qty: '1' }]);
});

test('FBA sales: a refused shipment leaves the sale on the order and reports it', async () => {
  const shipment = () => new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'Shelf has no cost on file' } }), { status: 422 });
  fakeAutomayt({ routes: fbaRoutes([], { shipment }) });
  const r = await orders.addFbaSales({ sales: [fbaSale()] });
  assert.equal(r.orders[0].status, 'partial');
  assert.equal(r.orders[0].soName, 'SO-025950');
  assert.match(r.errors[0].error, /701-F: Ship out of Amazon Fulfillment.*no cost on file/);
});

test('FBA sales: all or nothing, an unknown item sends no lines and reports', async () => {
  const calls = fakeAutomayt({ routes: fbaRoutes() });
  const sale = fbaSale({ items: [fbaSale().items[0], { asin: 'B0NOPE', sellerSku: 'NOPE-FBA', quantity: 1, unitPrice: 10, name: 'Unknown' }] });
  const r = await orders.addFbaSales({ sales: [sale] });
  assert.equal(r.orders[0].status, 'error');
  assert.match(r.orders[0].errors.join(' '), /NOPE \(SKU NOPE-FBA\) is not in the sku-map and not in Automayt/);
  assert.equal(r.errors[0].step, 'fba-sales');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/sales-orders')).length, 0);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/items').length, 0);
});

test('FBA sales: a $0 principal is a $0 line; in production a sale before the cutover is left to Salesforce', async () => {
  fakeAutomayt({ routes: fbaRoutes() });
  const zero = await orders.addFbaSales({ sales: [fbaSale({ items: [{ ...fbaSale().items[0], unitPrice: 0 }], shipping: 0 })] });
  assert.equal(zero.orders[0].status, 'created');
  assert.equal(zero.orders[0].items[0].salePrice, '0');

  const saved = { base: process.env.AUTOMAYT_API_BASE, key: process.env.AUTOMAYT_API_KEY };
  process.env.AUTOMAYT_API_BASE = 'https://app.automayt.com/api/v1';
  process.env.AUTOMAYT_API_KEY = 'amk_live_unit_secret';
  try {
    const calls = fakeAutomayt({ routes: fbaRoutes() });
    const r = await orders.addFbaSales({ sales: [fbaSale({ day: '2026-10-30' })] });
    assert.equal(r.orders[0].status, 'skipped');
    assert.match(r.orders[0].reason, /before the 2026-11-01 cutover/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  } finally {
    process.env.AUTOMAYT_API_BASE = saved.base;
    process.env.AUTOMAYT_API_KEY = saved.key;
  }
});

test('Amazon pass: FBA sales follow the parcels, in result.fba, PO counts untouched', async () => {
  fakeAutomayt({ routes: fbaRoutes() });
  delete process.env.AUTOMAYT_FBA_SALES;
  try {
    const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [], fbaSales: [fbaSale()] } });
    assert.equal(r.orders.length, 0);
    assert.equal(r.fba.created, 1);
    assert.deepEqual(r.soNames, ['SO-025950']);
    assert.equal(r.soName, 'SO-025950');
    const off = await orders.createAmazonPOs({ fba: false, prefetched: { unresolved: [], shipments: [], fbaSales: [fbaSale()] } });
    assert.equal(off.fba, undefined);
  } finally {
    process.env.AUTOMAYT_FBA_SALES = '0';
  }
});

// ── Shopify partial refunds as credit notes ─────────────────────────────────

const tax = require('./channel-tax');
const rollPrice = tax.unitPriceFor(1622.62, 538);
// The SO createShopifySoPo makes from shopifyMoney (the roll in sq ft), as GET .../lines returns it.
const refundSoLines = [
  { id: 'sol-1', external_line_ref: 'line-1', item_id: 'it-kf', qty: '2', unit_price: '37.96', line_total: '75.92', tax_charged: gst('3.80') },
  { id: 'sol-2', external_line_ref: 'line-2', item_id: 'it-pad', qty: '1', unit_price: '9.99', line_total: '9.99', tax_charged: gst('0.50') },
  { id: 'sol-3', external_line_ref: 'line-3', item_id: 'it-roll', qty: '538', unit_price: rollPrice, line_total: '1622.62', tax_charged: gst('81.13') },
  { id: 'sol-4', external_line_ref: 'freight-1', item_id: null, qty: '1', unit_price: '54.99', line_total: '54.99', tax_charged: gst('2.76') },
];
const refundOf = (over) => ({ id: 'r1', createdAt: '2026-10-20T17:00:00Z', items: [], shipping: [], ...over });

test('credit note lines: a box and one roll of two come back by SO quantity (sq ft), tax as refunded', () => {
  const refund = refundOf({
    total: 891.74,
    items: [
      { lineId: '11', sku: '4172', quantity: 1, subtotal: 37.96, tax: gst('1.90') },
      { lineId: '13', sku: 'ROLL1', quantity: 1, subtotal: 811.31, tax: gst('40.57') },
    ],
  });
  const r = tax.shopifyCreditNoteLines(shopifyMoney, refund, refundSoLines);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.lines.map((l) => [l.soLineId, l.qty, l.amount, l.taxCharged]), [['sol-1', 1, 37.96, gst('1.90')], ['sol-3', 269, 811.31, gst('40.57')]]);
  assert.equal(r.credited, 891.74);
});

test('credit note lines: whole shipping comes back on the freight line; a partial shipping refund or money beyond the lines is refused', () => {
  const whole = tax.shopifyCreditNoteLines(shopifyMoney, refundOf({ total: 57.75, shipping: [{ subtotal: 54.99, tax: gst('2.76') }] }), refundSoLines);
  assert.deepEqual(whole.lines.map((l) => [l.soLineId, l.qty]), [['sol-4', 1]]);
  assert.deepEqual(whole.problems, []);

  const part = tax.shopifyCreditNoteLines(shopifyMoney, refundOf({ total: 10.5, shipping: [{ subtotal: 10, tax: gst('0.50') }] }), refundSoLines);
  assert.match(part.problems[0], /not a whole shipping line/);

  const goodwill = tax.shopifyCreditNoteLines(shopifyMoney, refundOf({ total: 25 }), refundSoLines);
  assert.match(goodwill.problems[0], /25\.00 refunded beyond the lines/);
});

test('credit note lines: an SO line out of position is found by its total and tax; no match is refused', () => {
  const swapped = refundSoLines.map((l) => (l.id === 'sol-1' ? { ...l, external_line_ref: 'line-9' } : l));
  const r = tax.shopifyCreditNoteLines(shopifyMoney, refundOf({ total: 39.86, items: [{ lineId: '11', sku: '4172', quantity: 1, subtotal: 37.96, tax: gst('1.90') }] }), swapped);
  assert.deepEqual(r.lines.map((l) => l.soLineId), ['sol-1']);
  const none = tax.shopifyCreditNoteLines(shopifyMoney, refundOf({ total: 39.86, items: [{ lineId: '11', sku: '4172', quantity: 1, subtotal: 37.96, tax: gst('1.90') }] }), refundSoLines.filter((l) => l.id !== 'sol-1'));
  assert.match(none.problems[0], /4172: no matching line on the SO/);
});

function refundAutomayt({ invoices, creditNotes = [] }) {
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const so = { id: 'so-r', number: 'SO-028100', status: 'confirmed', version: 'v1', invoices };
  return fakeAutomayt({ existingSo: so, routes: {
    'GET /sales-orders/so-r': () => json(so),
    'GET /sales-orders/so-r/lines': () => json({ data: refundSoLines, has_more: false }),
    'GET /invoices/inv-1': () => json({ id: 'inv-1', status: 'posted', lines: refundSoLines.map((l, i) => ({ id: `il-${i}`, sales_order_line_id: l.id })) }),
    'GET /invoices/inv-1/credit-notes': () => json({ data: creditNotes, has_more: false }),
    'POST /invoices/inv-1/credit-notes': (q, body) => json({ id: 'cn-1', number: 'INV-0099', type: 'credit-note', total: '-39.86', notes: body.notes }),
  } });
}

const partialMoney = { ...shopifyMoney, refunded: 39.86, refunds: [refundOf({ id: '7001', total: 39.86, items: [{ lineId: '11', sku: '4172', quantity: 1, subtotal: 37.96, tax: gst('1.90') }] })] };

test('Shopify refunds: a partial refund becomes a credit note on the posted invoice, once', async () => {
  let calls = refundAutomayt({ invoices: [{ id: 'inv-1', number: 'INV-0050', status: 'posted', type: 'full', total: '1851.71', balance_due: '0' }] });
  const dry = await orders.reconcileShopifyRefund({ orderNumber: '#1400', money: partialMoney });
  assert.equal(dry.action, 'credit-note');
  assert.equal(dry.creditNotes[0].status, 'ready');
  assert.equal(calls.some((c) => c.method === 'POST'), false);

  const done = await orders.reconcileShopifyRefund({ orderNumber: '#1400', money: partialMoney, apply: true });
  assert.equal(done.action, 'credited');
  assert.equal(done.applied, true);
  const cn = calls.find((c) => c.method === 'POST' && c.path === '/invoices/inv-1/credit-notes');
  assert.equal(cn.key, 'shopify-1400-refund-7001-cn-inv-1');
  assert.deepEqual(cn.body, { reason: 'other', notes: 'Shopify refund 7001, 2026-10-20, order #1400', lines: [{ sales_order_line_id: 'sol-1', qty: '1', tax_charged: gst('1.90') }] });

  // The credit note is there now: a re-run posts nothing.
  calls = refundAutomayt({ invoices: [{ id: 'inv-1', number: 'INV-0050', status: 'posted', type: 'full' }], creditNotes: [{ id: 'cn-1', notes: 'Shopify refund 7001, 2026-10-20, order #1400' }] });
  const again = await orders.reconcileShopifyRefund({ orderNumber: '#1400', money: partialMoney, apply: true });
  assert.equal(again.action, 'credited');
  assert.equal(again.creditNotes[0].status, 'done');
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('Shopify refunds: no posted invoice yet, or a refund that is not by line, stays pending', async () => {
  let calls = refundAutomayt({ invoices: [{ id: 'inv-d', number: 'INV-0051', status: 'draft', type: 'full' }] });
  let r = await orders.reconcileShopifyRefund({ orderNumber: '#1400', money: partialMoney, apply: true });
  assert.equal(r.action, 'credit-note-pending');
  assert.match(r.reason, /no posted invoice/);
  assert.equal(calls.some((c) => c.method === 'POST'), false);

  calls = refundAutomayt({ invoices: [{ id: 'inv-1', number: 'INV-0050', status: 'paid', type: 'full' }] });
  r = await orders.reconcileShopifyRefund({ orderNumber: '#1400', money: { ...partialMoney, refunds: [refundOf({ id: '7002', total: 25 })] }, apply: true });
  assert.equal(r.action, 'credit-note-pending');
  assert.match(r.reason, /refund 7002: 25\.00 refunded beyond the lines/);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});
