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

// ── Per-box rate shopping (2026-09-09: 6x DITRA30M = 234 lb rated as ONE parcel
// got no quote from any carrier and the released large order halted at staging).
const { bestCommonService } = require('./run-orders');

test('bestCommonService: sums the cheapest service offered for every box, weighted by box count', () => {
  const perWeight = [
    { count: 6, rates: [
      { serviceCode: 'ups_standard', serviceName: 'UPS Standard', shipmentCost: 50, otherCost: 6.79 },
      { serviceCode: 'ups_2nd_day_air', serviceName: 'UPS 2nd Day', shipmentCost: 150, otherCost: 5.14 },
    ] },
  ];
  const best = bestCommonService(perWeight);
  assert.equal(best.serviceCode, 'ups_standard');
  assert.equal(Number(best.totalCost.toFixed(2)), 340.74, '6 boxes x (50 + 6.79)');
});

test('bestCommonService: only a service quoted for EVERY box qualifies', () => {
  const perWeight = [
    { count: 1, rates: [{ serviceCode: 'a', shipmentCost: 10, otherCost: 0 }, { serviceCode: 'b', shipmentCost: 12, otherCost: 0 }] },
    { count: 2, rates: [{ serviceCode: 'b', shipmentCost: 20, otherCost: 1 }] },
  ];
  const best = bestCommonService(perWeight);
  assert.equal(best.serviceCode, 'b', 'a is cheaper on box 1 but is not offered for box 2');
  assert.equal(best.totalCost, 12 + 2 * 21);
});

test('bestCommonService: no quote for any box means no quote at all', () => {
  assert.equal(bestCommonService([{ count: 1, rates: [] }]), null);
  assert.equal(bestCommonService([]), null);
});

// ── Sechelt UPS preference (2026-09-22). Mac: "we gotta try n use ups at the
// sechelt warehouse cuz they the only ones that do pickups from our warehouse."
// Purolator has no pickup at V0N 3A3, so its labels wait for a manual depot run;
// six parcels were stranded that way, the oldest 12 days. Costs below are the
// real Sechelt-origin quotes measured that day.
const { chooseNonCpCarrier } = require('./run-orders');
const SECH = 147654;
const PROSOL_BURNABY = 1374417;
const q = (c) => ({ shipmentCost: c });

test('Sechelt: ordinary parcels route UPS (the only carrier that collects there)', () => {
  // Suares 3 lb, Van Damme 36.5 lb, Mesenchuk 1.5 lb — UPS cheaper on all three
  assert.equal(chooseNonCpCarrier({ ups: q(12.41), purolator: q(17.51), warehouseId: SECH }).winner.shipmentCost, 12.41);
  assert.equal(chooseNonCpCarrier({ ups: q(36.12), purolator: q(47.12), warehouseId: SECH }).winner.shipmentCost, 36.12);
  assert.equal(chooseNonCpCarrier({ ups: q(13.99), purolator: q(20.35), warehouseId: SECH }).winner.shipmentCost, 13.99);
});

test('Sechelt: long/light goods stay Purolator when it is clearly cheaper', () => {
  // #1386 floor-protection roll, 22 lb: UPS bills dimensional weight, Puro does not
  const roll = chooseNonCpCarrier({ ups: q(76.10), purolator: q(51.36), warehouseId: SECH });
  assert.equal(roll.winner.shipmentCost, 51.36);
  assert.match(roll.note, /depot drop/, 'flags that a human must drive it down');
  // Hope BC grout, 20 lb
  assert.equal(chooseNonCpCarrier({ ups: q(57.47), purolator: q(38.00), warehouseId: SECH }).winner.shipmentCost, 38.00);
});

test('Sechelt: a modest Purolator saving is not worth a depot run', () => {
  // UPS is a preference, not absolute — but the drop-off has to actually pay.
  assert.equal(chooseNonCpCarrier({ ups: q(20.00), purolator: q(16.00), warehouseId: SECH }).winner.shipmentCost,
    20.00, '$4 saving does not justify driving to the depot');
  assert.equal(chooseNonCpCarrier({ ups: q(26.00), purolator: q(16.00), warehouseId: SECH }).winner.shipmentCost,
    26.00, '$10 saving still does not — under the $15 gap');
});

test('Sechelt: a big Purolator saving DOES earn the depot run', () => {
  const pick = chooseNonCpCarrier({ ups: q(40.00), purolator: q(20.00), warehouseId: SECH });
  assert.equal(pick.winner.shipmentCost, 20.00, '$20 saving clears the gap');
  assert.match(pick.note, /depot drop/);
});

test('Prosol lanes are unchanged — Purolator preferred, kill-switch respected', () => {
  const pick = chooseNonCpCarrier({ ups: q(10.00), purolator: q(47.12), warehouseId: PROSOL_BURNABY });
  assert.equal(pick.winner.shipmentCost, 47.12, 'UPS_ROUTING_DISABLED keeps Prosol on Purolator');
});

test('single-carrier quotes still resolve', () => {
  assert.equal(chooseNonCpCarrier({ ups: null, purolator: q(30), warehouseId: SECH }).winner.shipmentCost, 30);
  assert.equal(chooseNonCpCarrier({ ups: q(30), purolator: null, warehouseId: SECH }).note, '', 'no DOWN warning at Sechelt');
  assert.match(chooseNonCpCarrier({ ups: q(30), purolator: null, warehouseId: PROSOL_BURNABY }).note, /pickups are DOWN/);
  assert.equal(chooseNonCpCarrier({ ups: null, purolator: null }).winner, null);
});
