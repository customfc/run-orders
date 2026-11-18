const test = require('node:test');
const assert = require('node:assert/strict');
const { livePricer, decide, enabled } = require('./prosol-live-cost');

// Off under node --test by default; these tests price with a fake Prosol.
process.env.PROSOL_LIVE_PO_COST = '1';

const itemCost = (item) => (item.cost != null ? Number(item.cost) : null);

test('decide: >1% updates, <=1% keeps the item, >30% is doubted, no stored cost updates, no live keeps stored', () => {
  assert.deepEqual(decide(9.08, 9.08), { unitCost: 9.08, update: false, suspect: false, gap: 0 });
  assert.equal(decide(48.44, 49.43).update, true); // Enrich 'N' Seal pint, 11-10: 2.0% off
  assert.equal(decide(100, 100.9).update, false);
  assert.equal(decide(6.93, 9.08).update, true); // Aqua Mix cleaner 23.7%: still trusted
  assert.equal(decide(50, 100).suspect, true);
  assert.deepEqual(decide(null, 12), { unitCost: 12, update: true, suspect: false, gap: null });
  assert.equal(decide(12, null).unitCost, 12);
});

function fakeClient(prices, log) {
  return () => ({
    init: async () => log.push('init'),
    close: async () => log.push('close'),
    getCost: async (sku) => { log.push(`cost:${sku}`); return prices[sku] != null ? { cost_cad: prices[sku] } : null; },
    getOfferPrice: async (id) => { log.push(`offer:${id}`); return prices[`id:${id}`] != null ? { cost_cad: prices[`id:${id}`] } : null; },
  });
}

test('pricer: one Prosol session, one lookup per item, pinned product id first, area lines per sq ft, one PATCH', async () => {
  const log = [];
  const patches = [];
  const erp = { updateItem: async (id, f, o) => patches.push([id, f, o]) };
  const p = livePricer({ erp, itemCost, clientFactory: fakeClient({ 'id:777': 9.08, ROLL: 538 }, log) });
  const cleaner = { id: 'a', item_number: 'C010382-01', cost: '6.93', version: 'v3' };
  const r1 = await p.price({ item: cleaner, prosolSku: 'C010382-01', productId: 777 });
  const r2 = await p.price({ item: cleaner, prosolSku: 'C010382-01', productId: 777 });
  assert.equal(r1.unitCost, 9.08);
  assert.equal(r2.unitCost, 9.08);
  assert.equal(r2.step.itemUpdated, 'earlier line');
  const roll = await p.price({ item: { id: 'b', cost: '2.00', version: 'v1' }, prosolSku: 'ROLL', coverage: 269 });
  assert.equal(roll.unitCost, 2); // 538 / 269
  assert.equal(roll.step.itemUpdated, false);
  await p.close();
  assert.deepEqual(log, ['init', 'offer:777', 'cost:ROLL', 'close']);
  assert.deepEqual(patches, [['a', { cost: '9.08' }, { expectedVersion: 'v3' }]]);
});

test('pricer: Prosol down, no offer, or a failed PATCH never stops the line', async () => {
  const down = livePricer({ erp: {}, itemCost, clientFactory: () => ({ init: async () => { throw new Error('login timeout'); } }) });
  const r = await down.price({ item: { id: 'a', cost: '5' }, prosolSku: 'X' });
  assert.equal(r.unitCost, 5);
  assert.match(r.step.reason, /login timeout/);

  const log = [];
  const noOffer = livePricer({ erp: {}, itemCost, clientFactory: fakeClient({}, log) });
  assert.equal((await noOffer.price({ item: { id: 'a', cost: '5' }, prosolSku: 'X' })).unitCost, 5);

  const failing = livePricer({ erp: { updateItem: async () => { throw new Error('409 version_conflict'); } }, itemCost, clientFactory: fakeClient({ X: 6 }, []) });
  const f = await failing.price({ item: { id: 'a', cost: '5', version: 'v1' }, prosolSku: 'X' });
  assert.equal(f.unitCost, 6);
  assert.match(f.step.itemUpdateError, /version_conflict/);
});

test('pricer: PROSOL_LIVE_PO_COST=0 is today\'s behaviour (stored cost, no Prosol)', async () => {
  process.env.PROSOL_LIVE_PO_COST = '0';
  try {
    const log = [];
    const p = livePricer({ erp: {}, itemCost, clientFactory: fakeClient({ X: 6 }, log) });
    const r = await p.price({ item: { id: 'a', cost: '5' }, prosolSku: 'X' });
    assert.deepEqual(r, { unitCost: 5, step: null });
    assert.deepEqual(log, []);
  } finally { process.env.PROSOL_LIVE_PO_COST = '1'; }
});

test('enabled: off under the test runner unless asked, on in production unless PROSOL_LIVE_PO_COST=0', () => {
  const saved = { v: process.env.PROSOL_LIVE_PO_COST, t: process.env.NODE_TEST_CONTEXT };
  try {
    delete process.env.PROSOL_LIVE_PO_COST;
    process.env.NODE_TEST_CONTEXT = 'child';
    assert.equal(enabled(), false);
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(enabled(), true);
    process.env.PROSOL_LIVE_PO_COST = '0';
    assert.equal(enabled(), false);
  } finally {
    process.env.PROSOL_LIVE_PO_COST = saved.v;
    if (saved.t == null) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved.t;
  }
});
