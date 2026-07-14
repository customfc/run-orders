// Regression tests for the pre-buy carrier-address guard (assessCarrierAddress).
// Guards against the class of failure seen on order 701-5518826-4465017
// (2026-07-14): Purolator 1100238 "Receiver Address1 is invalid" because the
// whole formatted address was jammed into street1, plus a 31-char receiver name
// (would then trip 1100236). See lib/shipstation-v2.js.
// Run: `npm test`  (or `node --test scripts/shipstation/carrier-address.test.js`)

process.env.DISABLE_CRON = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessCarrierAddress } = require('../../lib/shipstation-v2');

test('flags the real 701-5518826-4465017 malformation (composite street1 + long name)', () => {
  const issues = assessCarrierAddress({
    name: 'Patricia MahPO0726-197799-27323',
    street1: 'Suite 440, 525 - 8 Avenue SW, Calgary, AB, T2P 1G1',
    city: 'Calgary', state: 'AB', postalCode: 'T2P 1G1', country: 'CA',
  });
  const codes = issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['ADDRESS1_COMPOSITE', 'NAME_TOO_LONG']);
});

test('composite detection is space-insensitive on the postal code', () => {
  const issues = assessCarrierAddress({
    name: 'Jane Doe', street1: '12 Main St, Calgary AB T2P1G1',
    postalCode: 'T2P 1G1', country: 'CA',
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'ADDRESS1_COMPOSITE');
});

test('name at exactly 30 chars is allowed; 31 is flagged', () => {
  const at30 = 'A'.repeat(30);
  const at31 = 'A'.repeat(31);
  assert.equal(assessCarrierAddress({ name: at30, street1: '1 Main St', postalCode: 'T2P 1G1' }).length, 0);
  assert.equal(assessCarrierAddress({ name: at31, street1: '1 Main St', postalCode: 'T2P 1G1' })[0].code, 'NAME_TOO_LONG');
});

test('clean address passes (no false positive)', () => {
  const issues = assessCarrierAddress({
    name: 'Patricia Mah', street1: '525 8 Avenue SW', street2: 'Suite 440',
    city: 'Calgary', state: 'AB', postalCode: 'T2P 1G1', country: 'CA',
  });
  assert.deepEqual(issues, []);
});

test('missing/empty postal code does not trigger composite (avoids false positive)', () => {
  const issues = assessCarrierAddress({ name: 'Jane Doe', street1: '525 8 Avenue SW', postalCode: '' });
  assert.deepEqual(issues, []);
});
