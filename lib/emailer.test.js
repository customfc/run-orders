const test = require('node:test');
const assert = require('node:assert');
const { carrierName, prosolFulfillmentLine, prosolLabelShipTo } = require('./emailer');

test('Purolator labels go out with Prosol\'s daily pickup, never "hold for our carrier"', () => {
  for (const code of ['purolator', 'purolator_ca', 'purolator_walleted']) {
    const line = prosolFulfillmentLine(code);
    assert.match(line, /daily Purolator pickup/);
    assert.doesNotMatch(line, /our carrier|we collect|do not ship/i);
    const slip = prosolLabelShipTo(code);
    assert.match(slip.street1, /daily Purolator pickup/);
    assert.doesNotMatch(`${slip.name} ${slip.street1}`, /our carrier|we collect/i);
  }
});

test('other carriers name the carrier we book', () => {
  assert.match(prosolFulfillmentLine('ups'), /UPS label.*we book the UPS pickup/);
  assert.match(prosolFulfillmentLine('canada post'), /Canada Post label/);
  assert.match(prosolFulfillmentLine(''), /carrier on the label/);
});

test('carrier names read cleanly', () => {
  assert.strictEqual(carrierName('purolator'), 'Purolator');
  assert.strictEqual(carrierName('ups_walleted'), 'UPS');
  assert.strictEqual(carrierName('canada_post'), 'Canada Post');
  assert.strictEqual(carrierName(''), '');
});
