// Regression tests for quantity-aware branch routing (commit 528e10f, 2026-07-09).
// Guards against the qty-blind bug where a multi-unit order routed to the nearest
// branch reporting only 1-2 units (order 701-2156847 -> Richmond).
// Run: `npm test`  (or `node --test scripts/shipstation/routing.test.js`)

process.env.DISABLE_CRON = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requiredQtyBySku,
  scoreWarehouseAgainstOrder,
  determineWarehouse,
  summarizeCoverage,
} = require('./run-orders');

test('requiredQtyBySku: single SKU carries full order qty', () => {
  const order = { resolvedItems: [{ apiSku: 'DITRA-XL/175', qty: 5 }] };
  assert.deepEqual(requiredQtyBySku(order), { 'DITRA-XL/175': 5 });
});

test('requiredQtyBySku: sums duplicate SKUs and tracks multiple SKUs', () => {
  const order = { resolvedItems: [{ apiSku: 'A', qty: 2 }, { apiSku: 'A', qty: 1 }, { apiSku: 'B', qty: 4 }] };
  assert.deepEqual(requiredQtyBySku(order), { A: 3, B: 4 });
});

test('scoreWarehouseAgainstOrder: surplus / -Infinity (order needs 5)', () => {
  const inv = { 'DITRA-XL/175': { locationStock: {
    '10038': { available: true, quantity: 2 },   // short (the bug scenario)
    '10010': { available: true, quantity: 9 },   // plenty
    '10020': { available: true, quantity: 5 },   // exact
    '10030': { available: false, quantity: 8 },  // available:false => 0
  } } };
  const req = { 'DITRA-XL/175': 5 };
  assert.equal(scoreWarehouseAgainstOrder('10038', inv, req), -Infinity, 'branch w/ 2 cannot cover 5');
  assert.equal(scoreWarehouseAgainstOrder('10010', inv, req), 4, 'branch w/ 9 => surplus 4');
  assert.equal(scoreWarehouseAgainstOrder('10020', inv, req), 0, 'branch w/ exactly 5 => surplus 0');
  assert.equal(scoreWarehouseAgainstOrder('10030', inv, req), -Infinity, 'available:false treated as 0');
  assert.equal(scoreWarehouseAgainstOrder('99999', inv, req), -Infinity, 'unknown branch cannot cover');
});

test('qty-1 orders behave identically to the old >=2/>=1 guard (no regression)', () => {
  const req = { X: 1 };
  const inv = { X: { locationStock: { P2: { available: true, quantity: 2 }, P1: { available: true, quantity: 1 } } } };
  assert.equal(scoreWarehouseAgainstOrder('P2', inv, req), 1, 'branch w/ 2 => pass-1 eligible (surplus 1)');
  assert.equal(scoreWarehouseAgainstOrder('P1', inv, req), 0, 'branch w/ 1 => pass-2 only (surplus 0)');
});

test('determineWarehouse: Vancouver order needing 5, Richmond has only 2 => null (no mis-route)', () => {
  const order = { shipTo: { postalCode: 'V5T 2A5' }, normalizedProvince: 'BC', resolvedItems: [{ apiSku: 'DITRA-XL/175', qty: 5 }] };
  const inv = { 'DITRA-XL/175': { locationStock: { '10038': { available: true, quantity: 2 } } } };
  assert.equal(determineWarehouse(order, inv), null);
});

test('determineWarehouse: picks the branch that can cover the full qty, not the nearest-but-short one', () => {
  const order = { shipTo: { postalCode: 'V5T 2A5' }, normalizedProvince: 'BC', resolvedItems: [{ apiSku: 'DITRA-XL/175', qty: 5 }] };
  const inv = { 'DITRA-XL/175': { locationStock: {
    '10038': { available: true, quantity: 2 },   // Richmond (nearest) short
    '10010': { available: true, quantity: 6 },   // covers
  } } };
  const pick = determineWarehouse(order, inv);
  assert.ok(pick && pick.prosolLocId === 10010, 'routes to the covering branch');
});

test('determineWarehouse: qty-1 Vancouver order routes to nearest branch with buffer', () => {
  const order = { shipTo: { postalCode: 'V5T 2A5' }, normalizedProvince: 'BC', resolvedItems: [{ apiSku: 'DITRA-XL/175', qty: 1 }] };
  const inv = { 'DITRA-XL/175': { locationStock: { '10038': { available: true, quantity: 3 } } } };
  const pick = determineWarehouse(order, inv);
  assert.ok(pick && pick.prosolLocId === 10038);
});

test('summarizeCoverage: reports need / best branch / total for manual-review error', () => {
  const order = { resolvedItems: [{ apiSku: 'DITRA-XL/175', qty: 5 }] };
  const inv = { 'DITRA-XL/175': { locationStock: {
    '10038': { available: true, quantity: 2 }, '10010': { available: true, quantity: 6 },
  } } };
  assert.match(summarizeCoverage(order, inv), /DITRA-XL\/175: need 5, best branch 6, total 8/);
});
