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

const { writeEntry } = require('./sku-map-file');

function tmpMap(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skumap-')), 'sku-map.json');
  fs.writeFileSync(file, text);
  return file;
}
const SAMPLE = `{
  "_comment": "x",
  "cable_lookup": {
    "32014": "not a mapping"
  },
  "mappings": {
    "A": {
      "api_sku": "A1",
      "note": "caf\\u00e9 {braces} \\"quoted\\""
    },
    "32014": {
      "api_sku": "32014",
      "prosol_sku": "Q32014QC",
      "nested": { "x": [1, 2, { "y": "}" }] }
    },
    "B0X": "C030192-4"
  }
}
`;

test('writeEntry replaces one mapping in place and leaves every other byte alone', () => {
  const file = tmpMap(SAMPLE);
  const entry = { api_sku: 'HALT_DISCONTINUED_32014', prosol_sku: 'HALT_DISCONTINUED_Q32014QC', note: 'gone — café' };
  assert.deepStrictEqual(writeEntry('32014', entry, file), { replaced: true });
  const text = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(text);
  assert.deepStrictEqual(j.mappings['32014'], entry);
  assert.strictEqual(j.cable_lookup['32014'], 'not a mapping');
  assert.ok(text.includes('"note": "gone \\u2014 caf\\u00e9"'), 'non-ASCII written as \\u escapes');
  const [head] = SAMPLE.split('    "32014": {');
  assert.ok(text.startsWith(head), 'bytes before the entry unchanged');
  assert.ok(text.endsWith('    "B0X": "C030192-4"\n  }\n}\n'), 'bytes after the entry unchanged');
});

test('writeEntry inserts a new key at the top of mappings and can replace a string entry', () => {
  const file = tmpMap(SAMPLE);
  assert.deepStrictEqual(writeEntry('71970', { api_sku: '71970' }, file), { replaced: false });
  assert.ok(fs.readFileSync(file, 'utf8').includes('  "mappings": {\n    "71970": {\n      "api_sku": "71970"\n    },\n    "A": {'));
  writeEntry('B0X', { api_sku: 'C030192-4', prosol_sku: 'C030192-01' }, file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const text = fs.readFileSync(file, 'utf8');
  const order = ['"71970"', '"A"', '"32014": {', '"B0X"'].map((k) => text.indexOf(k, text.indexOf('"mappings"')));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'file order: new key first, rest unchanged');
  assert.strictEqual(j.mappings.B0X.prosol_sku, 'C030192-01');
});

test('writeEntry on a copy of the real sku-map changes only that entry', () => {
  const real = fs.readFileSync(require('./sku-map-file').SKU_MAP_FILE, 'utf8');
  const file = tmpMap(real);
  const before = JSON.parse(real).mappings;
  const key = Object.keys(before).find((k) => before[k] && typeof before[k] === 'object' && before[k].api_sku && !String(before[k].api_sku).startsWith('HALT_'));
  writeEntry(key, { ...before[key], api_sku: `HALT_DISCONTINUED_${before[key].api_sku}` }, file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).mappings;
  assert.strictEqual(Object.keys(after).length, Object.keys(before).length);
  assert.ok(after[key].api_sku.startsWith('HALT_DISCONTINUED_'));
  const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  assert.deepStrictEqual(changed, [key]);
});
