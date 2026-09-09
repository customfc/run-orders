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

// ── splitLongReceiverName (auto-heal for NAME_TOO_LONG) ────────────────────────
const { splitLongReceiverName } = require('../../lib/shipstation-v2');

test('splits the real 701-9959811-7549839 name at a word boundary', () => {
  const s = splitLongReceiverName('Blue Opal Recovery and Wellness', '');
  assert.deepEqual(s, { name: 'Blue Opal Recovery and', company: 'Wellness' });
  assert.ok(s.name.length <= 30 && s.company.length <= 30);
});

test('splits the real 702-1145389-6497821 name (31 chars, lowercase)', () => {
  const s = splitLongReceiverName('north of 53 industrial supplies', null);
  assert.deepEqual(s, { name: 'north of 53 industrial', company: 'supplies' });
});

test('null when name already fits (30 chars exactly)', () => {
  assert.equal(splitLongReceiverName('A'.repeat(30), ''), null);
});

test('null when company is already occupied (nowhere to spill)', () => {
  assert.equal(splitLongReceiverName('Blue Opal Recovery and Wellness', 'Existing Co'), null);
});

test('null when a single token exceeds 30 (no boundary to split at)', () => {
  assert.equal(splitLongReceiverName('A'.repeat(31), ''), null);
});

test('null when the remainder itself exceeds 30', () => {
  const s = splitLongReceiverName('Short ' + 'B'.repeat(35), '');
  assert.equal(s, null);
});

test('collapses interior whitespace before measuring', () => {
  const s = splitLongReceiverName('Blue  Opal   Recovery and Wellness', '');
  assert.deepEqual(s, { name: 'Blue Opal Recovery and', company: 'Wellness' });
});

// ── No-comma composite: street + unit + business in one line (701-7987961-9571407,
// 2026-09-09 — two Purolator 1100238s, fixed by hand; now self-healed).
const { splitUnitAndBusiness } = require('../../lib/shipstation-v2');

test('splits the real 701-7987961-9571407 line into street / unit / company, every token kept', () => {
  const r = splitUnitAndBusiness({ street1: '5000 Highway 7 East Unit 2006L Auric King Fine Restaurant', street2: '', company: '' });
  assert.deepEqual(r, { street1: '5000 Highway 7 East', street2: 'Unit 2006L', company: 'Auric King Fine Restaurant' });
});

test('assessCarrierAddress flags it as the self-healable unit composite, not the comma composite', () => {
  const issues = assessCarrierAddress({ name: 'Chris Zhang', street1: '5000 Highway 7 East Unit 2006L Auric King Fine Restaurant', city: 'Markham', state: 'ON', postalCode: 'L3R 4M9', country: 'CA' });
  assert.deepEqual(issues.map((i) => i.code), ['ADDRESS1_UNIT_COMPOSITE']);
});

test('a short "street Unit N" is left exactly as written', () => {
  assert.equal(splitUnitAndBusiness({ street1: '12 Main St Unit 4' }), null);
});

test('unit with no business name: street2 only, existing company untouched', () => {
  assert.deepEqual(splitUnitAndBusiness({ street1: '5000 Highway 7 East Suite 2006L', company: 'Existing Co' }), { street1: '5000 Highway 7 East', street2: 'Suite 2006L' });
});

test('business name with company already occupied goes to a human, never overwritten', () => {
  assert.equal(splitUnitAndBusiness({ street1: '5000 Highway 7 East Unit 2006L Auric King Fine Restaurant', company: 'Other Co' }), null);
});

test('street2 already occupied goes to a human, never overwritten', () => {
  assert.equal(splitUnitAndBusiness({ street1: '5000 Highway 7 East Unit 2006L Auric King Fine Restaurant', street2: 'Buzzer 12' }), null);
});

test('# form works, and "Ste" cannot fire inside a word like Stewart', () => {
  assert.deepEqual(splitUnitAndBusiness({ street1: '5000 Highway 7 East #2006L Auric King Fine Restaurant' }), { street1: '5000 Highway 7 East', street2: '#2006L', company: 'Auric King Fine Restaurant' });
  assert.equal(splitUnitAndBusiness({ street1: '123 Stewart Street Northwest Extension' }), null);
});

test('street part still over 30 chars is not a self-heal (would be rejected anyway)', () => {
  assert.equal(splitUnitAndBusiness({ street1: '1234 Some Very Long Street Name Unit 5 Business' }), null);
});

test('comma composites belong to stripCompositeAddress1, not this split', () => {
  assert.equal(splitUnitAndBusiness({ street1: '12316 188A Street, Pitt Meadows, BC, Canada Unit 5 Biz' }), null);
});
