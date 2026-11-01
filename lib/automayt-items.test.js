const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';
delete process.env.AUTOMAYT_REF_OVERRIDES;
delete process.env.AUTOMAYT_TEST_CODE_PREFIX;

const am = require('./automayt');
const erp = require('./automayt-erp');
const { guard } = require('../scripts/automayt/prosol-catalog-import');

function fakeFetch(handler) {
  const calls = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname.replace('/api/v1', ''), body, key: init.headers['Idempotency-Key'] || null });
    const { status = 200, json = {}, headers = {} } = handler(init.method, u.pathname.replace('/api/v1', ''), body) || {};
    const h = new Map(Object.entries({ 'x-request-id': 'req_test', ...headers }));
    return { ok: status < 400, status, statusText: '', headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => JSON.stringify(json) };
  };
  return calls;
}

const categories = { data: [{ id: 'cat-acc', name: 'Accessories' }, { id: 'cat-sup', name: 'Supplies' }], has_more: false };

test('createItem without the new options sends the same body the order flows always sent', async () => {
  const calls = fakeFetch((m, p) => (p === '/product-categories' ? { json: categories } : { status: 201, json: { id: 'it-1' } }));
  await erp.createItem({ vendorCode: 'KERDIFIXBW', itemNumber: 'KERDIFIX/BW', description: 'KERDI-FIX', category: 'Supplies', cost: 21.64, retail: 37.96, vendorId: 'ven-1', manufacturer: 'Schluter' });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.key, 'item-KERDIFIXBW');
  assert.deepEqual(Object.keys(post.body).sort(), ['category_id', 'color', 'cost', 'description', 'item_number', 'manufacturer', 'retail_price', 'size', 'stock_status', 'style', 'taxable', 'unit', 'upc', 'vendor_code', 'vendor_id'].sort());
  assert.equal(post.body.stock_status, 'Special Order');
});

test('createItem passes aliases, external refs and stock status when given', async () => {
  const calls = fakeFetch((m, p) => (p === '/product-categories' ? { json: categories } : { status: 201, json: { id: 'it-2' } }));
  await erp.createItem({
    vendorCode: 'C10097801', itemNumber: 'C1009784', category: 'Supplies', cost: 12.34, vendorId: 'ven-1', stockStatus: 'Stock',
    aliases: [{ code: 'C100978-01', kind: 'vendor_code' }, { code: '012345678905', kind: 'upc' }],
    externalRefs: [{ system: 'prosol', external_id: '5' }],
  });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.stock_status, 'Stock');
  assert.deepEqual(post.body.aliases, [{ code: 'C100978-01', kind: 'vendor_code' }, { code: '012345678905', kind: 'upc' }]);
  assert.deepEqual(post.body.external_refs, [{ system: 'prosol', external_id: '5' }]);
});

test('createItem sends brand and box quantity only when given (flooring per sq ft)', async () => {
  const calls = fakeFetch((m, p) => (p === '/product-categories' ? { json: categories } : { status: 201, json: { id: 'it-3' } }));
  await erp.createItem({ vendorCode: 'RT38S', itemNumber: '400630092', category: 'Supplies', unit: 'sqft', cost: 11.83, retail: 18.2, boxQuantity: 4, brand: 'Tarkett', manufacturer: 'Tarkett', vendorId: 'ven-1' });
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual([post.body.unit, post.body.cost, post.body.box_quantity, post.body.brand], ['sqft', '11.83', '4', 'Tarkett']);
});

test('createItem prefixes alias codes (not UPCs) in a rehearsal', async () => {
  process.env.AUTOMAYT_TEST_CODE_PREFIX = 'ROTEST-';
  try {
    const calls = fakeFetch((m, p) => (p === '/product-categories' ? { json: categories } : { status: 201, json: { id: 'it-3' } }));
    await erp.createItem({ vendorCode: 'W80', category: 'Accessories', cost: 4.09, aliases: [{ code: 'W-80', kind: 'vendor_code' }, { code: '4011832005718', kind: 'upc' }] });
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.key, 'item-ROTEST-W80');
    assert.deepEqual(post.body.aliases, [{ code: 'ROTEST-W-80', kind: 'vendor_code' }, { code: '4011832005718', kind: 'upc' }]);
  } finally {
    delete process.env.AUTOMAYT_TEST_CODE_PREFIX;
  }
});

test('updateItem PATCHes with a key derived from the id and the change', async () => {
  const calls = fakeFetch(() => ({ json: { id: 'it-9' } }));
  await erp.updateItem('it-9', { cost: '4.15' });
  await erp.updateItem('it-9', { cost: '4.15' });
  await erp.updateItem('it-9', { cost: '4.20' });
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['PATCH', '/items/it-9'], ['PATCH', '/items/it-9'], ['PATCH', '/items/it-9']]);
  assert.equal(calls[0].key, calls[1].key);
  assert.notEqual(calls[0].key, calls[2].key);
  assert.match(calls[0].key, /^item-update-it-9-[0-9a-f]{16}$/);
});

test('the transport reports the rate-limit window', async () => {
  fakeFetch(() => ({ json: {}, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1792000020' } }));
  const res = await am.get('/whoami');
  assert.deepEqual(res.rateLimit, { limit: 60, remaining: 59, resetAt: 1792000020000 });
});

test('importer guard: no real catalogue into a test environment, production needs the flag and a live key', () => {
  assert.throws(() => guard({ apply: true }), /AUTOMAYT_TEST_CODE_PREFIX/);
  assert.doesNotThrow(() => guard({}));
  assert.throws(() => guard({ production: true }), /--production given/);
  process.env.AUTOMAYT_TEST_CODE_PREFIX = 'ROTEST-';
  assert.doesNotThrow(() => guard({ apply: true }));
  delete process.env.AUTOMAYT_TEST_CODE_PREFIX;
  assert.throws(() => guard({ apply: true, 'real-codes': true }), /staging only/); // beta1: never writes the real codes
  assert.doesNotThrow(() => guard({ 'real-codes': true })); // a dry run may look them up on the beta1 CFC tenant
  const saved = [process.env.AUTOMAYT_API_BASE, process.env.AUTOMAYT_API_KEY];
  process.env.AUTOMAYT_API_BASE = 'https://staging.automayt.dev/api/v1';
  try {
    assert.throws(() => guard({ apply: true }), /--real-codes/);
    assert.doesNotThrow(() => guard({ apply: true, 'real-codes': true }));
  } finally {
    process.env.AUTOMAYT_API_BASE = saved[0];
  }
  process.env.AUTOMAYT_API_BASE = 'https://app.automayt.com/api/v1';
  process.env.AUTOMAYT_API_KEY = 'amk_live_unit_secret';
  try {
    assert.throws(() => guard({ apply: true }), /pass --production/);
    assert.doesNotThrow(() => guard({ apply: true, production: true }));
    process.env.AUTOMAYT_TEST_CODE_PREFIX = 'ROTEST-';
    assert.throws(() => guard({ apply: true, production: true }), /test-only/);
  } finally {
    delete process.env.AUTOMAYT_TEST_CODE_PREFIX;
    [process.env.AUTOMAYT_API_BASE, process.env.AUTOMAYT_API_KEY] = saved;
  }
});
