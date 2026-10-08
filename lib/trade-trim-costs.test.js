const test = require('node:test');
const assert = require('node:assert/strict');

const tc = require('./trade-trim-costs');

const CFG = { floor: { minNetMarginPercent: 5 } };

test('planCosts: updates changed costs, reports the floor at 25% off on the new cost, leaves unknown costs alone', () => {
  const p = tc.planCosts([
    { sku: 'J80BW', handle: 'jolly', inventoryItemId: 'i1', price: '18.72', shopifyCost: '11.86', prosolCost: 11.86 },
    { sku: 'J100BW', handle: 'jolly', inventoryItemId: 'i2', price: '19.87', shopifyCost: '12.58', prosolCost: 13.10 },
    { sku: 'A60AE', handle: 'schiene', inventoryItemId: 'i3', price: '10.00', shopifyCost: '6.00', prosolCost: 7.20 },
    { sku: 'X', handle: 'x', inventoryItemId: 'i4', price: '10.00', shopifyCost: '6.00', prosolCost: null },
    { sku: 'Y', handle: 'y', inventoryItemId: 'i5', price: '10.00', shopifyCost: null, prosolCost: '6.00' },
  ], { cfg: CFG });
  assert.deepEqual(p.updates.map((u) => [u.sku, u.fromCents, u.toCents]), [['J100BW', 1258, 1310], ['A60AE', 600, 720], ['Y', null, 600]]);
  assert.equal(p.unchanged, 1);
  assert.deepEqual(p.missing, ['X']);
  // 10.00 at 25% off = 7.50; cost 7.20 leaves 4.0% < 5%
  assert.deepEqual(p.belowFloor.map((b) => [b.sku, b.marginPct]), [['A60AE', 4]]);
});

test('report: nothing to tell is null; otherwise counts, the floor table and the biggest increases', () => {
  assert.equal(tc.report({ updates: [], belowFloor: [], missing: [], unchanged: 3 }, { applied: true, total: 3 }), null);
  const r = tc.report(tc.planCosts([
    { sku: 'A60AE', handle: 'schiene-<b>', inventoryItemId: 'i3', price: '10.00', shopifyCost: '6.00', prosolCost: 7.20 },
  ], { cfg: CFG }), { applied: true, total: 1 });
  assert.match(r.subject, /^Trim costs: 1 changed, 1 under the 5% floor at 25% off$/);
  assert.match(r.html, /updated in Shopify: 1 up, 0 down/);
  assert.match(r.html, /schiene-&lt;b&gt;/);
  assert.match(r.html, /A60AE \$6\.00 to \$7\.20/);
});
