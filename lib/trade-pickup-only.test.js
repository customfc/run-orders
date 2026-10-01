const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const po = require('./trade-pickup-only');

const MAP = {
  J80BW: { api_sku: 'J80BW', prosol_sku: 'J80BW', ship_mode: 'pickup_only' },
  'EV/J80BW': { api_sku: 'EV/J80BW', prosol_sku: 'EVJ80BW', ship_mode: 'ship' },
  KEBA100: { api_sku: 'KEBA100', prosol_sku: 'KEBA100' },
  OLD: 'OLDCODE',
};
const lookup = (s) => MAP[s];

test('isPickupOnly: only an object entry with ship_mode pickup_only', () => {
  assert.equal(po.isPickupOnly(MAP.J80BW), true);
  assert.equal(po.isPickupOnly(MAP['EV/J80BW']), false);
  assert.equal(po.isPickupOnly(MAP.KEBA100), false);
  assert.equal(po.isPickupOnly(MAP.OLD), false);
  assert.equal(po.isPickupOnly(undefined), false);
});

test('pickupOnlySkus: picks the lengths out of a mixed order, once each', () => {
  const items = [{ sku: 'EV/J80BW' }, { sku: 'J80BW' }, { sku: 'J80BW' }, { sku: 'KEBA100' }, { sku: null }, {}, null];
  assert.deepEqual(po.pickupOnlySkus(items, lookup), ['J80BW']);
  assert.deepEqual(po.pickupOnlySkus([{ sku: 'EV/J80BW' }], lookup), []);
  assert.match(po.pickupOnlyMessage(['J80BW']), /^pickup-only item J80BW: full-length profiles never ship by parcel/);
});

test('assertNoPickupOnly: throws PICKUP_ONLY with the SKUs; passes a corner-only order', () => {
  assert.throws(() => po.assertNoPickupOnly([{ sku: 'J80BW' }, { sku: 'EV/J80BW' }], '#1500', lookup),
    (e) => e.code === 'PICKUP_ONLY' && e.skus.join() === 'J80BW' && /#1500/.test(e.message));
  assert.doesNotThrow(() => po.assertNoPickupOnly([{ sku: 'EV/J80BW' }, { sku: 'KEBA100' }], '#1501', lookup));
});

test('diskLookup reads the map file and re-reads it when it changes; an unreadable map fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-only-'));
  const file = path.join(dir, 'sku-map.json');
  fs.writeFileSync(file, JSON.stringify({ mappings: { A1: { ship_mode: 'pickup_only' } } }));
  assert.equal(po.isPickupOnly(po.diskLookup(file)('A1')), true);
  fs.writeFileSync(file, JSON.stringify({ mappings: { A1: { ship_mode: 'ship' } } }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(po.isPickupOnly(po.diskLookup(file)('A1')), false);
  fs.writeFileSync(file, '{ broken');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
  assert.throws(() => po.diskLookup(file));
});

test('the real sku-map parses and the default lookup works', () => {
  const look = po.diskLookup();
  assert.equal(typeof look, 'function');
  assert.doesNotThrow(() => po.assertNoPickupOnly([{ sku: 'KEBA100/125' }], '#test'));
});
