'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateMapping } = require('./mapping-guard');

test('Amazon "underlayment" title matches Automayt "membrane" description (DITRA-XL, 701-5478953)', () => {
  const v = validateMapping(
    'Schluter-Ditra XL 5/16" Underlayment 175square feet Roll',
    'Schluter - DITRA-XL UNCOUPLING MEMBRANE 3\'3" X 53\'3" = 175 SF');
  assert.strictEqual(v.ok, true, v.reason);
});

test('still halts a genuinely different product', () => {
  const v = validateMapping(
    'Schluter-Ditra XL 5/16" Underlayment 175square feet Roll',
    'Schluter - KERDI-DRAIN ABS HORIZ OUTLET');
  assert.strictEqual(v.ok, false);
});
