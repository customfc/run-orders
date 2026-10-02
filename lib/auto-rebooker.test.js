'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { groupCandidates, ALREADY_SCHEDULED_RE } = require('./auto-rebooker');
const { isManualDropoff } = require('./manual-dropoff');

const s = (o) => ({ warehouseName: 'X', age: 6, orderNumber: 'A', trackingNumber: 'T', ...o });

test('Sechelt Purolator goes to dropOff, never to a pickup group', () => {
  const { groups, dropOff } = groupCandidates([
    s({ warehouseId: 147654, warehouseName: 'Sechelt (SECH)', carrierCode: 'purolator_walleted', orderNumber: '701-3598406-2218615', age: 11, trackingNumber: '520762128533' }),
    s({ warehouseId: 147654, warehouseName: 'Sechelt (SECH)', carrierCode: 'ups_walleted' }),
    s({ warehouseId: 1869850, warehouseName: 'Calgary North (CALN)', carrierCode: 'purolator_walleted' }),
  ]);
  assert.deepEqual(Object.keys(groups).sort(), ['147654::ups', '1869850::purolator']);
  assert.equal(dropOff.length, 1);
  assert.equal(dropOff[0].oldest, 11);
  assert.deepEqual(dropOff[0].orders, ['701-3598406-2218615']);
  assert.deepEqual(dropOff[0].trackings, ['520762128533']);
});

test('manual drop-off matches walleted and plain carrier codes', () => {
  assert.equal(isManualDropoff(147654, 'purolator_walleted'), true);
  assert.equal(isManualDropoff('147654', 'purolator'), true);
  assert.equal(isManualDropoff(147654, 'ups_walleted'), false);
  assert.equal(isManualDropoff(1284722, 'purolator_walleted'), false);
});

test('Purolator "already scheduled" error is recognised', () => {
  assert.ok(ALREADY_SCHEDULED_RE.test('Cannot schedule pickup. Label(s) already scheduled for pickup.'));
  assert.ok(!ALREADY_SCHEDULED_RE.test('Error Received From Purolator Canada API: 4100702: Pickup is not available'));
});
