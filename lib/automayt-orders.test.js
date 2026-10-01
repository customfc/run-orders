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
    { sku: '4172', title: 'KERDI-FIX', quantity: 2, price: '37.96' },
    { sku: '71', title: 'Bona pad', quantity: 1, price: '9.99' },
    { sku: 'ROLL1', title: 'DITRA-PS roll', quantity: 2, price: '811.31' },
  ],
};

// ── Shopify ──────────────────────────────────────────────────────────────────

test('Shopify: one SO with every line, PO without own-stock lines, at item cost', async () => {
  const calls = fakeAutomayt();
  const r = await orders.createShopifySoPo({ shopifyOrder, trackingNumber: '520600000001', carrierCode: 'purolator_walleted' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.soNumber, 'SO-025900');
  assert.equal(r.poNumber, 'PO-17100');

  const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
  assert.equal(so.key, 'shopify-1400-so');
  assert.equal(so.body.procurement_mode, 'external');
  assert.equal(so.body.external_ref, '1400');
  assert.equal(so.body.order_date, '2026-09-30');
  assert.deepEqual(so.body.lines.map((l) => [l.item_id, l.qty, l.unit_price]), [['it-kf', '2', '37.96'], ['it-pad', '1', '9.99'], ['it-roll', '538', '811.31']]);

  const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
  assert.equal(po.key, 'shopify-1400-po');
  assert.equal(po.body.status, 'confirmed');
  assert.equal(po.body.tracking_code, '520600000001');
  assert.deepEqual(po.body.lines.map((l) => [l.item_id, l.unit_cost, l.sales_order_line_id]), [['it-kf', '21.64', 'sol-1'], ['it-roll', '1.72', 'sol-3']]);
  assert.match(po.body.shipping_instructions, /^Shopify #1400 — Test Buyer — .* — purolator — Tracking: 520600000001$/);
});

test('Shopify: an ambiguous vendor code stops that line for a person', async () => {
  fakeAutomayt({ lookups: { 'vendor_code:KERDIFIXBW': ['kerdifix', 'shelf'], 'item_number:71': ['pad'] } });
  const r = await orders.createShopifySoPo({ shopifyOrder: { ...shopifyOrder, items: shopifyOrder.items.slice(0, 2) } });
  assert.ok(r.errors.some((e) => /matches 2 Automayt items .* a person must pick one/.test(e.error)));
});

test('Shopify: a failed duplicate guard aborts with nothing created', async () => {
  const calls = fakeAutomayt({ routes: { 'POST /purchase-orders/check-tracking': () => new Response(JSON.stringify({ error: { code: 'forbidden_scope', message: 'no' } }), { status: 403 }) } });
  const r = await orders.createShopifySoPo({ shopifyOrder, trackingNumber: 'T-X' });
  assert.match(r.errors[0].error, /duplicate guard failed/);
  assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/sales-orders'), false);
});

test('Shopify: an existing SO is a skip that names its PO first', async () => {
  fakeAutomayt({ existingSo: { id: 'so-old', number: 'SO-025800', purchase_orders: [{ id: 'po-o', number: 'PO-17000' }] } });
  const r = await orders.createShopifySoPo({ shopifyOrder });
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
