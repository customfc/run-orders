'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCoverageFromDescription, resolveLineQty } = require('./pbsi-uom');

test('Salesforce-style "SqFt" coverage', () => {
  assert.strictEqual(parseCoverageFromDescription('Schluter DITRA-HEAT Membrane Roll - 134.5 SqFt'), 134.5);
  assert.strictEqual(parseCoverageFromDescription('Roll (269 sqft)'), 269);
  assert.strictEqual(parseCoverageFromDescription('1,076 sq ft pallet'), 1076);
});

test('Automayt "= N SF" dimension total', () => {
  assert.strictEqual(parseCoverageFromDescription('Schluter - KERDI WATERPROOFING MEMBRANE 3\'3" X 33\' = 108 SF'), 108);
  assert.strictEqual(parseCoverageFromDescription('Schluter - DITRA-HEAT-DUO ROLL 3\'2-5/8" X 33\'6-1/2"= 108 SF'), 108);
  assert.strictEqual(parseCoverageFromDescription('Schluter - DITRA-HEAT ROLL 3\'2-5/8" X 41\'10-3/4" = 134.5 SF'), 134.5);
});

test('loose bare SF and dimension-only descriptions do not resolve', () => {
  assert.strictEqual(parseCoverageFromDescription('108 SF roll'), null);
  assert.strictEqual(parseCoverageFromDescription('SF grey 5 gal'), null);
  assert.strictEqual(parseCoverageFromDescription('Schluter · Ditra Heat · Uncoupling Membrane Peel & Stick (5mm) · 38 5/8" x 502 3/4"'), null);
});

test('sqft wins over "= N SF" when both are present', () => {
  assert.strictEqual(parseCoverageFromDescription('ROLL X 33\' = 100 SF (108 sqft)'), 108);
});

test('resolveLineQty: override, parsed, refused', () => {
  assert.deepStrictEqual(resolveLineQty({ uom: 'each', description: 'x', orderQty: 2 }), { qty: 2, isArea: false, coverage: 1 });
  assert.deepStrictEqual(resolveLineQty({ uom: 'sqft', description: 'no size', orderQty: 1, coverageOverride: 134.5 }), { qty: 134.5, isArea: true, coverage: 134.5 });
  assert.deepStrictEqual(resolveLineQty({ uom: 'sqft', description: 'KERDI 3\'3" X 33\' = 108 SF', orderQty: 2 }), { qty: 216, isArea: true, coverage: 108 });
  assert.ok(resolveLineQty({ uom: 'sqft', description: '38 5/8" x 502 3/4"', orderQty: 1 }).error);
});
