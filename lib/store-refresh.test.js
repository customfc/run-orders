'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { refreshStores, pickStores } = require('./store-refresh');

const STORES = [
  { storeId: 829859, storeName: 'Api Shipments', active: true, autoRefresh: false },
  { storeId: 190566, storeName: 'Manual Orders', active: true, autoRefresh: false },
  { storeId: 190578, storeName: 'New Amazon CA Store', active: true, autoRefresh: true },
  { storeId: 798860, storeName: 'yourfloors', active: true, autoRefresh: true },
];

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function ok(body) { return { status: 200, body: JSON.stringify(body) }; }

test('pickStores keeps only active auto-importing marketplace stores', () => {
  assert.deepStrictEqual(pickStores(STORES).map((s) => s.storeId), [190578, 798860]);
});

test('refreshes each marketplace store and waits until each has a new refresh attempt', async () => {
  const clock = fakeClock();
  const calls = [];
  const statusReads = {};
  const request = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith('/stores?')) return ok(STORES);
    const id = Number((path.match(/storeId=(\d+)/) || [])[1]);
    if (method === 'POST') return ok({ success: 'true' });
    statusReads[id] = (statusReads[id] || 0) + 1;
    // first read = "before"; Shopify takes two polls to finish, Amazon one
    const finishedAt = id === 798860 ? 3 : 2;
    const fresh = statusReads[id] >= finishedAt;
    return ok({ storeId: id, refreshStatusId: fresh ? 0 : 2, lastRefreshAttempt: fresh ? 'new' : 'old' });
  };
  const r = await refreshStores({ request, ...clock, pollMs: 3000 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.stores.map((s) => [s.storeId, s.done]), [[190578, true], [798860, true]]);
  assert.ok(calls.includes('POST /stores/refreshstore?storeId=190578'));
  assert.ok(calls.includes('POST /stores/refreshstore?storeId=798860'));
  assert.ok(!calls.some((c) => c.includes('storeId=190566')), 'never refreshes Manual Orders');
  assert.strictEqual(r.waitedMs, 6000);
});

test('gives up at the cap and reports it, without throwing', async () => {
  const clock = fakeClock();
  const request = async (method, path) => {
    if (path.startsWith('/stores?')) return ok(STORES);
    if (method === 'POST') return ok({ success: 'true' });
    return ok({ refreshStatusId: 2, lastRefreshAttempt: 'old' });
  };
  const r = await refreshStores({ request, ...clock, maxWaitMs: 9000, pollMs: 3000 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.stores.every((s) => !s.done && /still importing/.test(s.error)));
  assert.ok(r.waitedMs <= 9000);
});

test('fails open when ShipStation errors', async () => {
  const clock = fakeClock();
  const r = await refreshStores({ request: async () => ({ status: 500, body: 'boom' }), ...clock });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 500/);
  const r2 = await refreshStores({ request: async () => { throw new Error('ECONNRESET'); }, ...clock });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /ECONNRESET/);
});
