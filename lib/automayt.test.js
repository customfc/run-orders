const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';

const am = require('./automayt');
const erp = require('./automayt-erp');

function reply(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const errorBody = (code, extra = {}) => ({ error: { code, message: code, request_id: 'req_x', retryable: false, ...extra } });

test('sends bearer, idempotency key and JSON body', async () => {
  const f = fakeFetch([reply(201, { id: 'so1' }, { 'x-request-id': 'req_1' })]);
  const res = await am.request('POST', '/sales-orders', { body: { a: 1 }, idempotencyKey: 'shopify-1-so', fetchImpl: f });
  assert.equal(res.data.id, 'so1');
  assert.equal(res.requestId, 'req_1');
  const h = f.calls[0].init.headers;
  assert.equal(h.Authorization, 'Bearer amk_test_unit_secret');
  assert.equal(h['Idempotency-Key'], 'shopify-1-so');
  assert.equal(f.calls[0].init.body, '{"a":1}');
});

test('drops empty query params', async () => {
  const f = fakeFetch([reply(200, { data: [] })]);
  await am.request('GET', '/purchase-orders', { query: { tracking_code: 'ABC', vendor_id: null, cursor: undefined }, fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://beta1.automayt.dev/api/v1/purchase-orders?tracking_code=ABC');
});

test('a keyed write retries a 503 with the same key', async () => {
  const f = fakeFetch([reply(503, errorBody('service_unavailable', { retryable: true }), { 'retry-after': '0' }), reply(201, { id: 'po1' })]);
  const res = await am.request('POST', '/purchase-orders', { body: {}, idempotencyKey: 'k1', fetchImpl: f });
  assert.equal(res.data.id, 'po1');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].init.headers['Idempotency-Key'], 'k1');
});

test('an unkeyed write is never resent after a lost response', async () => {
  const f = fakeFetch([new Error('socket hang up')]);
  await assert.rejects(am.request('POST', '/items/batch-lookup', { body: {}, fetchImpl: f }), /transport failure/);
  assert.equal(f.calls.length, 1);
});

test('429 waits Retry-After then succeeds', async () => {
  const f = fakeFetch([reply(429, errorBody('rate_limited'), { 'retry-after': '0' }), reply(200, { ok: true })]);
  const res = await am.request('GET', '/whoami', { fetchImpl: f });
  assert.equal(res.data.ok, true);
});

test('validation errors throw at once with code, field and request id', async () => {
  const f = fakeFetch([reply(422, errorBody('validation_failed', { field: 'lines[0].unit_cost', request_id: 'req_v' }))]);
  await assert.rejects(
    am.request('POST', '/purchase-orders/p/receipts', { body: {}, idempotencyKey: 'k', fetchImpl: f }),
    (err) => err instanceof am.AutomaytError && err.code === 'validation_failed' && err.field === 'lines[0].unit_cost' && err.requestId === 'req_v',
  );
  assert.equal(f.calls.length, 1);
});

test('409 duplicate exposes the existing id', async () => {
  const f = fakeFetch([reply(409, errorBody('duplicate', { details: { existing_id: 'so_old' } }))]);
  await assert.rejects(
    am.request('POST', '/sales-orders', { body: {}, idempotencyKey: 'k', fetchImpl: f }),
    (err) => am.isDuplicate(err) && err.existingId === 'so_old',
  );
});

test('commands refuse to go out without an idempotency key', async () => {
  await assert.rejects(am.command('/sales-orders', {}), /Idempotency-Key is required/);
});

test('a test key aimed at production is refused before any call', () => {
  const prev = process.env.AUTOMAYT_API_BASE;
  process.env.AUTOMAYT_API_BASE = 'https://app.automayt.com/api/v1';
  try {
    assert.throws(() => am.config(), /does not match/);
  } finally {
    process.env.AUTOMAYT_API_BASE = prev;
  }
});

test('Amazon periods are 14-day windows from the anchor', () => {
  const p = erp.amazonPeriod('2026-10-01', '2026-09-18');
  assert.deepEqual(p, { start: '2026-09-18', end: '2026-10-01', key: 'period:2026-09-18', label: 'Sep 18 - Oct 1' });
  assert.equal(erp.amazonPeriod('2026-10-02', '2026-09-18').key, 'period:2026-10-02');
  assert.equal(erp.amazonPeriod('2026-09-17', '2026-09-18').key, 'period:2026-09-04');
  assert.equal(erp.amazonPeriod('2026-12-31', '2026-12-25').label, 'Dec 25 - Jan 7');
});

test('vendor code variants try the stripped form first', () => {
  assert.deepEqual(erp.codeVariants('KERDI-FIX/BW'), ['KERDIFIXBW', 'KERDI-FIX/BW']);
  assert.deepEqual(erp.codeVariants('5LA001452'), ['5LA001452']);
  assert.deepEqual(erp.codeVariants(''), []);
});
