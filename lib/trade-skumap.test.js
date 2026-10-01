const test = require('node:test');
const assert = require('node:assert/strict');

const sm = require('./trade-skumap');

const RAW = `{
  "_comment": "ShipStation SKU \\u2192 Prosol",
  "mappings": {
    "DHDPS8MA": {
      "api_sku": "DHDPS8MA",
      "prosol_sku": "DHDPS8MA"
    },
    "1040010": {
      "api_sku": "1040010"
    },
    "EV/J80BW": {
      "api_sku": "EV/J80BW",
      "note": "curated by hand"
    }
  },
  "cable_lookup": {
    "a": 1
  }
}
`;
const V = (o) => ({ sku: 'J80BW', handle: 'schluter-jolly-edge-trim-color-coated-aluminum', map_price: 18.72, cost: 11.86, upc: '4011832192388',
  prosol_code: 'J80BW', po_code: 'J80BW', prosol_product_id: 84401, delivery: 'pickup_only', ...o });
const META = { mapText: 'JOLLY EDGE TRIM 5/16" ALUM BRT WHITE', date: '2026-10-01', mapEffective: '2025-10-01' };

test('buildEntry: Prosol code for stock, Prosol PO code for POs, pickup_only lengths, catalogue source', () => {
  const { entry, problems } = sm.buildEntry(V({ sku: 'EV/J125TSBG', prosol_code: 'EV/J125TSBG', po_code: 'EVJ125TSGB', delivery: 'ship' }), META);
  assert.deepEqual(problems, []);
  assert.equal(entry.api_sku, 'EV/J125TSBG');
  assert.equal(entry.prosol_sku, 'EVJ125TSGB');
  assert.equal(entry.ship_mode, 'ship');
  assert.equal(entry.schluter_item, 'EV/J125TSBG');
  assert.equal(entry.product, 'Schluter JOLLY EDGE TRIM 5/16" ALUM BRT WHITE');
  assert.equal(entry.source, 'catalog-schluter-2026-10-01');
  assert.equal(sm.isCatalogEntry(entry), true);
  assert.equal(sm.isCatalogEntry({ source: 'prosol-live-2026-09-21' }), false);
  assert.equal(sm.buildEntry(V({}), META).entry.ship_mode, 'pickup_only');
  assert.deepEqual(sm.buildEntry(V({ po_code: null, cost: 0, delivery: 'freight' }), META).problems, ['no PO code', 'no cost', 'delivery "freight"']);
});

test('trailingSku matches run-orders: our option-value line names never look like a code', () => {
  assert.equal(sm.trailingSku('Schluter KERDI-LINE Drain - KL1V60E60'), 'KL1V60E60');
  for (const n of ['Schluter® JOLLY Edge Trim, Color-Coated Aluminum - Bright White / 5/16" (8 mm)',
    'Schluter® RONDEC-CT Corners for Anodized Aluminum Profiles - Inside Corner 135° / Satin / 1/2" (12.5 mm)',
    'Schluter® SCHIENE-BASIC Profile, Anodized Aluminum - Satin / 3/8" (10 mm) / 9\' (2.75 m)']) {
    assert.equal(sm.trailingSku(n), null, n);
  }
});

test('applyBlock: appends at the end of mappings, ASCII escapes, keeps every other byte, skips curated keys', () => {
  const a = sm.buildEntry(V({}), META).entry;
  const b = sm.buildEntry(V({ sku: 'EV/J80BW', prosol_code: 'EV/J80BW', po_code: 'EVJ80BW', delivery: 'ship' }), META).entry;
  const c = sm.buildEntry(V({ sku: 'RO80AE', prosol_code: 'RO80AE', po_code: 'RO80AE' }), { ...META, mapText: 'RONDEC 5/16" ALUM SATIN ANOD°' }).entry;
  const out = sm.applyBlock(RAW, [['J80BW', a], ['EV/J80BW', b], ['RO80AE', c]], '=== SCHLUTER PROFILES CATALOGUE ===');
  assert.deepEqual(out.written, ['J80BW', 'RO80AE']);
  assert.deepEqual(out.skipped, ['EV/J80BW']); // curated entry kept as it was
  const parsed = JSON.parse(out.text);
  assert.deepEqual(Object.keys(parsed.mappings), ['DHDPS8MA', '1040010', 'EV/J80BW', sm.START_KEY, 'J80BW', 'RO80AE', sm.END_KEY].sort((x, y) => (/^\d+$/.test(x) ? -1 : (/^\d+$/.test(y) ? 1 : 0))));
  assert.equal(parsed.mappings['EV/J80BW'].note, 'curated by hand');
  assert.match(out.text, /\\u00b0/); // non-ASCII escaped like the rest of the file
  assert.ok(out.text.startsWith(RAW.slice(0, RAW.indexOf('\n  },\n  "cable_lookup"'))));
  assert.ok(out.text.endsWith(RAW.slice(RAW.indexOf('\n  },\n  "cable_lookup"'))));
});

test('applyBlock: a re-run replaces the block in place, and an emptied list leaves just the markers', () => {
  const a = sm.buildEntry(V({}), META).entry;
  const first = sm.applyBlock(RAW, [['J80BW', a]], 'note').text;
  const changed = { ...a, cost_cad: 12.5 };
  const second = sm.applyBlock(first, [['J80BW', changed]], 'note').text;
  assert.equal(JSON.parse(second).mappings.J80BW.cost_cad, 12.5);
  assert.equal(second.split(`"${sm.START_KEY}"`).length, 2); // still one block
  const empty = sm.applyBlock(second, [], 'note').text;
  assert.equal(JSON.parse(empty).mappings.J80BW, undefined);
  assert.equal(sm.applyBlock(empty, [['J80BW', a]], 'note').text, first);
});

test('applyBlock refuses a broken block', () => {
  const first = sm.applyBlock(RAW, [], 'note').text;
  assert.throws(() => sm.applyBlock(first.replace(sm.END_KEY, 'something_else'), [], 'note'), /no end marker/);
});
