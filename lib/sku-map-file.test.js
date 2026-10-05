'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSkuMap } = require('./sku-map-file');

test('a mapping written after the first read is seen on the next read (PO-17244)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skumap-')), 'sku-map.json');
  fs.writeFileSync(file, JSON.stringify({ mappings: {} }));
  fs.utimesSync(file, new Date('2026-10-05T11:00:00Z'), new Date('2026-10-05T11:00:00Z'));
  assert.equal(readSkuMap(file).mappings['4657'], undefined);

  // sku-resolver auto-maps 4657 to Sechelt mid-run.
  fs.writeFileSync(file, JSON.stringify({ mappings: { 4657: { api_sku: 'NON_PROSOL', route_to: 'CFC_SECHELT' } } }));
  fs.utimesSync(file, new Date('2026-10-05T11:03:00Z'), new Date('2026-10-05T11:03:00Z'));
  assert.equal(readSkuMap(file).mappings['4657'].api_sku, 'NON_PROSOL');
});

test('an unchanged file is parsed once and the same object comes back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skumap-')), 'sku-map.json');
  fs.writeFileSync(file, JSON.stringify({ mappings: { A: { api_sku: 'X' } } }));
  assert.strictEqual(readSkuMap(file), readSkuMap(file));
});

test('the real sku-map loads', () => {
  assert.ok(Object.keys(readSkuMap().mappings).length > 100);
});
