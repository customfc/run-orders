const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cat = require('./trade-catalog');

// Fixtures shaped like the S1 CSV rows and the S2 refresh JSONL rows (02 data/catalog, 2026-09-28).
const PRODUCTS = [
  {
    handle: 'schluter-jolly-edge-trim-color-coated-aluminum', title: 'Schluter® JOLLY Edge Trim, Color-Coated Aluminum', wave: '1',
    family: 'JOLLY', sub_family: 'JOLLY', piece_type: 'length', material_class: 'color-coated-aluminum',
    option1_name: 'Finish', option1_values: 'Bright White | White | Matte White', option2_name: 'Height',
    option2_values: '1/4" (6 mm) | 5/16" (8 mm) | 3/8" (10 mm)', option3_name: '', option3_values: '',
    delivery: 'pickup_only', product_type: 'Schluter Profile',
  },
  {
    handle: 'schluter-rondec-corners-anodized-aluminum', title: 'Schluter® RONDEC Corners, Anodized Aluminum', wave: '2a',
    family: 'RONDEC', sub_family: 'RONDEC', piece_type: 'accessory', material_class: 'anodized-aluminum',
    option1_name: 'Piece', option1_values: 'Outside Corner | Inside Corner', option2_name: 'Finish', option2_values: 'Satin | Brushed Nickel',
    option3_name: 'Height', option3_values: '5/16" (8 mm) | 3/8" (10 mm)', delivery: 'ship', product_type: 'Schluter Profile Accessory',
  },
  {
    handle: 'schluter-jolly-connector-pack-of-4', title: 'Schluter® JOLLY Connector (Pack of 4)', wave: '2a', family: 'JOLLY', sub_family: 'JOLLY',
    piece_type: 'accessory', material_class: 'none', option1_name: '', option1_values: '', option2_name: '', option2_values: '',
    option3_name: '', option3_values: '', delivery: 'ship', product_type: 'Schluter Profile Accessory',
  },
];

const LEN = '8\' 2-1/2" (2.5 m)';
function vr(o) {
  return {
    wave: '2a', product_handle: '', sku: '', prosol_code: '', family: 'JOLLY', piece_type: 'length', piece: '', option1_name: '', option1_value: '',
    option2_name: '', option2_value: '', option3_name: '', option3_value: '', finish_name: '', height: '', extra_option: '', extra_value: '',
    length: LEN, map_price: '19.87', schluter_retail_2026: '22.08', upc: '4011832192395', weight_lb: '0.5', delivery: 'pickup_only',
    special_order: '0', sold_in_bundles_of_10: '0', excluded_reason: '', name_check: 'ok', map_text: '', ...o,
  };
}
const len = (sku, wave, finish, height, extra = {}) => vr({
  sku, wave, product_handle: PRODUCTS[0].handle, option1_name: 'Finish', option1_value: finish, option2_name: 'Height', option2_value: height,
  finish_name: finish, height, map_text: `JOLLY EDGE TRIM ${height} ALUM ${finish.toUpperCase()}`, ...extra,
});
const corner = (sku, piece, finish, height, extra = {}) => vr({
  sku, product_handle: PRODUCTS[1].handle, family: 'RONDEC', piece_type: 'accessory', piece, length: '', delivery: 'ship',
  option1_name: 'Piece', option1_value: piece, option2_name: 'Finish', option2_value: finish, option3_name: 'Height', option3_value: height,
  finish_name: finish, height, map_price: '9.39', schluter_retail_2026: '10.43', upc: '4011832049989', weight_lb: '0.01', ...extra,
});
const VARIANTS = [
  len('J80BW', '1', 'Bright White', '5/16" (8 mm)', { map_price: '18.72', schluter_retail_2026: '20.80', upc: '4011832192388' }),
  len('J100BW', '1', 'Bright White', '3/8" (10 mm)'),
  len('J100W', '2a', 'White', '3/8" (10 mm)', { upc: '4011832192395' }),
  len('J100MBW', '2a', 'Matte White', '3/8" (10 mm)'), // refresh says no cost: left out
  corner('EV/RO80AE', 'Outside Corner', 'Satin', '5/16" (8 mm)'),
  corner('ID/RO100ATGB', 'Inside Corner', 'Brushed Nickel', '3/8" (10 mm)'),
  vr({ sku: 'V/JPP4', product_handle: PRODUCTS[2].handle, piece_type: 'accessory', piece: 'Connector (Pack of 4)', length: '', delivery: 'ship', map_price: '3.41', schluter_retail_2026: '3.79', upc: '4011832202582', weight_lb: '0.01' }),
  vr({ sku: 'EV/J125BW', wave: '1', product_handle: '', excluded_reason: 'not_in_prosol' }),
  vr({ sku: 'A100AGRB', product_handle: '', excluded_reason: 'discontinuing' }),
];
function rr(sku, o = {}) {
  const v = VARIANTS.find((x) => x.sku === sku);
  return {
    sku, product_handle: v ? v.product_handle : null, match: 'exact', prosol_code: sku.replace('/', ''), po_code: sku.replace(/\//g, ''),
    cost_cad: Math.round(Number(v ? v.map_price : 10) * 0.633 * 100) / 100, discontinued: 0, stock_status: 'available', barcode: v ? v.upc : null,
    inventory: [{ code: 'COQL', net_available: 5 }, { code: 'BURN', net_available: 2 }], product_id: 1, ...o,
  };
}
const REFRESH = [
  rr('J80BW'), rr('J100BW'), rr('J100W', { stock_status: 'backorder' }), rr('J100MBW', { cost_cad: null }),
  rr('EV/RO80AE'), rr('ID/RO100ATGB'), rr('V/JPP4'), { sku: 'EV/J125BW', match: 'missing' },
];
const MAP = new Map(VARIANTS.map((v) => [v.sku, { mapCad: Number(v.map_price), upc: v.upc }]));
const mapLookup = (sku) => MAP.get(sku) || null;
const built = () => cat.buildCatalog({ products: PRODUCTS, variants: VARIANTS, refresh: REFRESH });
const clone = (x) => JSON.parse(JSON.stringify(x));

test('parseCsv: quotes, doubled quotes, commas, CRLF, BOM, embedded newline', () => {
  const rows = cat.parseCsv('﻿a,b,c\r\n1,"3/8"" (10 mm)","x, y"\r\n2,"line\nbreak",\n');
  assert.deepEqual(rows, [{ a: '1', b: '3/8" (10 mm)', c: 'x, y' }, { a: '2', b: 'line\nbreak', c: '' }]);
});

test('money rounds like the price list and gtinValid checks the check digit', () => {
  assert.equal(cat.money(22.15 * 0.9), '19.94');
  assert.equal(cat.money('19.87'), '19.87');
  assert.equal(cat.money(null), null);
  assert.equal(cat.gtinValid('4011832192388'), true);
  assert.equal(cat.gtinValid('4011832192389'), false);
  assert.equal(cat.gtinValid('4011832192388.0'), false);
  assert.equal(cat.gtinValid(''), false);
});

test('decideVariant: builds only with one exact distributor match, a cost, and not discontinued', () => {
  const v = VARIANTS[0];
  assert.equal(cat.decideVariant(v, rr('J80BW')).include, true);
  assert.equal(cat.decideVariant({ ...v, excluded_reason: 'radius' }, rr('J80BW')).reason, 'catalog:radius');
  assert.equal(cat.decideVariant(v, undefined).reason, 'not_in_refresh');
  assert.equal(cat.decideVariant(v, { sku: 'J80BW', match: 'missing' }).reason, 'no_exact_prosol_match');
  assert.equal(cat.decideVariant(v, rr('J80BW', { match: 'ambiguous' })).reason, 'no_exact_prosol_match');
  assert.equal(cat.decideVariant(v, rr('J80BW', { cost_cad: 0 })).reason, 'no_cost');
  const both = cat.decideVariant(v, rr('J80BW', { cost_cad: null, discontinued: 1 }));
  assert.deepEqual(both.reasons, ['no_cost', 'prosol_discontinued']);
  assert.equal(cat.decideVariant(v, rr('J80BW', { discontinued: 1 })).reason, 'prosol_discontinued');
  assert.equal(cat.decideVariant(v, rr('J80BW', { discontinued: 1 }), { keepProsolDiscontinued: true }).include, true);
});

test('decideVariant: "within reason" drops wave-2a fringe (not available, or under n units network-wide); wave 1 exempt', () => {
  const w2 = VARIANTS.find((x) => x.sku === 'J100W');
  const w1 = VARIANTS[0];
  const opts = { minNetworkQty: 5 };
  assert.equal(cat.decideVariant(w2, rr('J100W'), opts).include, true); // 7 units, available
  assert.equal(cat.decideVariant(w2, rr('J100W', { inventory: [{ code: 'COQL', net_available: 4 }] }), opts).reason, 'fringe_low_stock');
  assert.equal(cat.decideVariant(w2, rr('J100W', { stock_status: 'backorder' }), opts).reason, 'fringe_low_stock');
  assert.equal(cat.decideVariant(w2, rr('J100W', { inventory: null }), opts).reason, 'fringe_low_stock');
  assert.equal(cat.decideVariant(w1, rr('J80BW', { stock_status: 'backorder', inventory: [] }), opts).include, true);
  assert.equal(cat.decideVariant(w2, rr('J100W', { stock_status: 'backorder' })).include, true); // rule off by default in the lib
  const b = cat.buildCatalog({ products: PRODUCTS, variants: VARIANTS, refresh: REFRESH, minNetworkQty: 5 });
  const fringe = b.excluded.find((e) => e.sku === 'J100W');
  assert.equal(fringe.reason, 'fringe_low_stock');
  assert.equal(fringe.network_qty, 7);
});

test('decideVariant: Mac 2026-09-29 leaves out special-order codes and MAC_SKIP codes in every wave', () => {
  const w2 = VARIANTS.find((x) => x.sku === 'J100W');
  assert.equal(cat.decideVariant({ ...w2, special_order: '1' }, rr('J100W')).reason, 'special_order');
  assert.equal(cat.decideVariant({ ...VARIANTS[0], special_order: '1' }, rr('J80BW')).reason, 'special_order');
  assert.equal(cat.decideVariant({ ...w2, sku: 'EV/J125BW' }, rr('J100W', { sku: 'EV/J125BW' })).reason, 'mac_skip');
  const b = cat.buildCatalog({ products: PRODUCTS, variants: VARIANTS.map((v) => (v.sku === 'EV/RO80AE' ? { ...v, special_order: '1' } : v)), refresh: REFRESH });
  assert.equal(b.variantIndex.some((x) => x.sku === 'EV/RO80AE'), false);
  assert.deepEqual(b.excluded.find((e) => e.sku === 'EV/RO80AE').reasons, ['special_order']);
});

test('variant input: WEIGHT_FIX_LB replaces a price-list weight slip', () => {
  const v = vr({ sku: 'VPSL90ACGB', product_handle: PRODUCTS[0].handle, weight_lb: '0.08' });
  assert.equal(cat.buildVariantInput(PRODUCTS[0], v, rr('J80BW')).inventoryItem.measurement.weight.value, 0.8);
});

test('variant input: SKU verbatim with slash, MAP price, UPC string, CONTINUE, tracked, cost, weight in lb', () => {
  const v = VARIANTS.find((x) => x.sku === 'EV/RO80AE');
  const out = cat.buildVariantInput(PRODUCTS[1], v, rr('EV/RO80AE', { cost_cad: 5.95 }));
  assert.deepEqual(out, {
    optionValues: [{ optionName: 'Piece', name: 'Outside Corner' }, { optionName: 'Finish', name: 'Satin' }, { optionName: 'Height', name: '5/16" (8 mm)' }],
    sku: 'EV/RO80AE', price: '9.39', barcode: '4011832049989', inventoryPolicy: 'CONTINUE',
    inventoryItem: { tracked: true, cost: '5.95', measurement: { weight: { value: 0.01, unit: 'POUNDS' } } },
  });
  const noOpt = cat.buildVariantInput(PRODUCTS[2], VARIANTS.find((x) => x.sku === 'V/JPP4'), rr('V/JPP4'));
  assert.deepEqual(noOpt.optionValues, [{ optionName: 'Title', name: 'Default Title' }]);
});

test('waves: wave-1 product gets a wave-1 payload with only its wave-1 variants and a wave-2a payload with the full list', () => {
  const b = built();
  assert.deepEqual(b.errors, []);
  const byKey = new Map(b.payloads.map((p) => [`${p.wave}:${p.handle}`, p]));
  const w1 = byKey.get(`1:${PRODUCTS[0].handle}`);
  const w2 = byKey.get(`2a:${PRODUCTS[0].handle}`);
  assert.deepEqual(w1.input.variants.map((v) => v.sku), ['J80BW', 'J100BW']);
  assert.equal(w1.extendsWave1, false);
  assert.deepEqual(w2.input.variants.map((v) => v.sku), ['J80BW', 'J100BW', 'J100W']);
  assert.equal(w2.extendsWave1, true);
  assert.equal(w2.newInWave, 1);
  assert.ok(byKey.has(`2a:${PRODUCTS[1].handle}`) && !byKey.has(`1:${PRODUCTS[1].handle}`));
  assert.ok(byKey.has(`2a:${PRODUCTS[2].handle}`));
  assert.equal(b.payloads.length, 4);
  // Left out: the no-cost variant (refresh stage) and the wave-1 code the catalogue already dropped; not the other S1 exclusions.
  assert.deepEqual(b.excluded.map((e) => `${e.sku}:${e.reason}`).sort(), ['EV/J125BW:catalog:not_in_prosol', 'J100MBW:no_cost']);
  assert.deepEqual(b.catalogExcludedByReason, { not_in_prosol: 1, discontinuing: 1 });
  const idx = b.variantIndex.find((x) => x.sku === 'EV/RO80AE');
  assert.equal(idx.prosol_code, 'EVRO80AE');
  assert.equal(idx.network_qty, 7);
});

test('product input: DRAFT, vendor, type, tags, used option values only, no collections/metafields/media', () => {
  const b = built();
  const len = b.payloads.find((p) => p.wave === '2a' && p.handle === PRODUCTS[0].handle).input;
  const acc = b.payloads.find((p) => p.handle === PRODUCTS[1].handle).input;
  const none = b.payloads.find((p) => p.handle === PRODUCTS[2].handle).input;
  assert.equal(len.status, 'DRAFT');
  assert.equal(len.vendor, 'Schluter');
  assert.equal(len.productType, 'Schluter Profile');
  assert.equal(acc.productType, 'Schluter Profile Accessory');
  assert.deepEqual(len.tags, ['schluter', 'profile', 'family:jolly', 'pickup-only', 'Prosol-Dropship']);
  assert.deepEqual(acc.tags, ['schluter', 'profile', 'family:rondec', 'profile-fn:corners-end-caps', 'Prosol-Dropship']);
  for (const inp of [len, acc, none]) for (const k of cat.FORBIDDEN_INPUT_KEYS) assert.ok(!(k in inp), `${k} must not be in the input`);
  // Matte White (no cost) and 1/4" (no variant) are declared in products.csv but unused, so they are left out; order kept.
  assert.deepEqual(len.productOptions, [
    { name: 'Finish', position: 1, values: [{ name: 'Bright White' }, { name: 'White' }] },
    { name: 'Height', position: 2, values: [{ name: '5/16" (8 mm)' }, { name: '3/8" (10 mm)' }] },
  ]);
  assert.equal(acc.productOptions.length, 3);
  assert.deepEqual(none.productOptions, [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }]);
});

test('copy: family intro, material line, accessory intro, trademark notice, function tag; no copy keeps the placeholder', () => {
  const copy = {
    trademark_notice: 'Schluter® and JOLLY are trademarks of Schluter-Systems.',
    materials: { 'color-coated-aluminum': 'Color-coated aluminum resists scratches.' },
    families: {
      JOLLY: { function: 'edge-trims', intro: ['Finishes tile edges.', 'Second paragraph.'], bullets: ['a', 'b', 'c'] },
      RONDEC: { function: 'edge-trims', intro: ['Rounded edge.'], accessory_intro: 'Corners for RONDEC.' },
    },
  };
  const p0 = { ...PRODUCTS[0], sub_family: 'JOLLY' };
  const p1 = { ...PRODUCTS[1], sub_family: 'RONDEC' };
  const vs0 = VARIANTS.filter((v) => v.product_handle === p0.handle && !v.excluded_reason);
  const html = cat.describe(p0, vs0, copy);
  assert.match(html, /^<p>Finishes tile edges\.<\/p><p>Second paragraph\.<\/p><p>Color-coated aluminum resists scratches\.<\/p><p>Each length is/);
  assert.match(html, /<p><small>Schluter® and JOLLY are trademarks of Schluter-Systems\.<\/small><\/p>$/);
  const accHtml = cat.describe({ ...p1, material_class: 'color-coated-aluminum' }, VARIANTS.filter((v) => v.product_handle === p1.handle), copy);
  assert.match(accHtml, /^<p>Corners for RONDEC\.<\/p><ul>/); // no material line on corners
  assert.doesNotMatch(accHtml, /resists scratches/);
  assert.equal(cat.describe(p0, vs0), cat.describe(p0, vs0, { families: {} }));
  assert.deepEqual(cat.tagsFor(p0, copy).filter((t) => t.startsWith('profile-fn:')), ['profile-fn:edge-trims']);
  assert.deepEqual(cat.tagsFor(p1, copy).filter((t) => t.startsWith('profile-fn:')), ['profile-fn:corners-end-caps']);
  assert.deepEqual(cat.tagsFor(p0).filter((t) => t.startsWith('profile-fn:')), []);
});

test('accessories are named for the profiles they match, not a material', () => {
  assert.equal(cat.productTitle(PRODUCTS[1]), 'Schluter® RONDEC Corners for Anodized Aluminum Profiles');
  assert.equal(cat.productTitle(PRODUCTS[0]), PRODUCTS[0].title);
  assert.equal(cat.productTitle(PRODUCTS[2]), PRODUCTS[2].title); // no material in the title: unchanged
  const acc = cat.buildProductInput(PRODUCTS[1], VARIANTS.filter((v) => v.product_handle === PRODUCTS[1].handle).map((v) => ({ v, r: rr(v.sku) })));
  assert.equal(acc.title, 'Schluter® RONDEC Corners for Anodized Aluminum Profiles');
  assert.match(acc.descriptionHtml, /<li>For profiles in: Anodized Aluminum<\/li>/);
});

test('description: factual, length only on lengths, no distributor name, no en or em dash, HTML escaped', () => {
  const b = built();
  const len = b.payloads.find((p) => p.wave === '2a' && p.handle === PRODUCTS[0].handle).input.descriptionHtml;
  const acc = b.payloads.find((p) => p.handle === PRODUCTS[1].handle).input.descriptionHtml;
  const none = b.payloads.find((p) => p.handle === PRODUCTS[2].handle).input.descriptionHtml;
  assert.match(len, /Each length is 8' 2-1\/2" \(2\.5 m\)\./);
  assert.match(len, /<li>Finishes: Bright White, White<\/li>/);
  assert.match(len, /<li>Material: Color-Coated Aluminum<\/li>/);
  assert.doesNotMatch(acc, /2\.5 m/);
  assert.match(acc, /<li>Pieces: Outside Corner, Inside Corner<\/li>/);
  assert.doesNotMatch(none, /Piece:/, 'no Piece line that repeats the product name');
  for (const d of [len, acc, none]) assert.deepEqual(cat.textProblems(d), []);
  const html = cat.describe({ ...PRODUCTS[0], title: 'Schluter® A<B> & C, PVC' }, [VARIANTS[0]]);
  assert.match(html, /A&lt;B&gt; &amp; C/);
  assert.deepEqual(cat.textProblems('Schluter — trim'), ['en or em dash']);
  assert.deepEqual(cat.textProblems('ships from Prosol'), ['names the distributor']);
});

test('QA: clean build has no errors; live check skips same-handle variants', () => {
  const b = built();
  const qa = cat.runQa({ build: b, mapLookup, liveRows: [
    { sku: 'J80BW', handle: PRODUCTS[0].handle, status: 'DRAFT', vendor: 'Schluter' },
    { sku: 'OTHER1', handle: 'something-else', status: 'ACTIVE', vendor: 'Mapei' },
  ] });
  assert.deepEqual(qa.checks.filter((c) => c.level === 'error'), []);
  assert.ok(qa.checks.some((c) => c.id === 'handle-exists-live' && c.level === 'warn'));
  assert.equal(qa.waves['1'].newVariants, 2);
  assert.equal(qa.waves['2a'].newVariants, 4);
  assert.equal(qa.waves['2a'].backorder, 1);
  assert.deepEqual(qa.finalState, { products: 3, variants: 6 });
});

test('QA flags: over 250 variants, over 3 options, price != MAP, missing cost, missing barcode, duplicate SKUs, live clashes', () => {
  const b = built();
  const acc = b.payloads.find((p) => p.handle === PRODUCTS[1].handle);
  const len2 = b.payloads.find((p) => p.wave === '2a' && p.handle === PRODUCTS[0].handle);
  acc.input.variants[0].price = '9.40';
  acc.input.variants[1].inventoryItem.cost = null;
  acc.input.variants[1].barcode = '';
  len2.input.variants[2].sku = 'EV/RO80AE'; // same SKU as a corner
  const big = clone(len2);
  big.handle = 'big'; big.input.handle = 'big';
  big.input.variants = Array.from({ length: 251 }, (_, i) => ({ ...clone(len2.input.variants[0]), sku: `X${i}`, optionValues: [{ optionName: 'Finish', name: `F${i}` }, { optionName: 'Height', name: '3/8" (10 mm)' }] }));
  big.input.productOptions = [{ name: 'Finish', position: 1, values: big.input.variants.map((v) => ({ name: v.optionValues[0].name })) }, { name: 'Height', position: 2, values: [{ name: '3/8" (10 mm)' }] }];
  big.rows = [];
  const four = clone(acc);
  four.handle = 'four'; four.input.handle = 'four';
  four.input.productOptions.push({ name: 'Colour', position: 4, values: [{ name: 'Red' }] });
  four.input.variants = four.input.variants.map((v, i) => ({ ...v, sku: `Y${i}`, optionValues: [...v.optionValues, { optionName: 'Colour', name: 'Red' }] }));
  four.rows = [];
  b.payloads.push(big, four);
  const qa = cat.runQa({ build: b, mapLookup, liveRows: [{ sku: 'J80BW', handle: 'old-listing', status: 'ARCHIVED', vendor: 'Schluter' }, { sku: 'IDRO100ATGB', handle: 'old2', status: 'ACTIVE', vendor: 'Schluter' }] });
  const ids = new Set(qa.checks.filter((c) => c.level === 'error').map((c) => c.id));
  for (const id of ['variants-over-250', 'options-over-3', 'price-not-map', 'missing-cost', 'missing-barcode', 'duplicate-sku', 'duplicate-sku-live']) assert.ok(ids.has(id), `expected ${id}`);
  assert.ok(qa.checks.some((c) => c.id === 'near-duplicate-sku-live' && c.sku === 'ID/RO100ATGB'));
  const md = cat.renderQa({ build: b, qa, meta: { generatedBc: '2026-09-28 17:00', inputs: [], notes: ['a note'], keepProsolDiscontinued: false } });
  assert.match(md, /Five example payloads/);
  assert.match(md, /Products over 250 variants \| \*\*1\*\*/);
  assert.doesNotMatch(md, /[–—]/);
});

test('planApply: create is DRAFT by handle; update keeps variant IDs, keeps live status, merges tags, keeps description', () => {
  const b = built();
  const inp = b.payloads.find((p) => p.wave === '2a' && p.handle === PRODUCTS[0].handle).input;
  const c = cat.planApply(inp, null);
  assert.equal(c.action, 'create');
  assert.deepEqual(c.identifier, { handle: PRODUCTS[0].handle });
  assert.equal(c.input.status, 'DRAFT');
  const live = {
    id: 'gid://shopify/Product/1', handle: PRODUCTS[0].handle, vendor: 'Schluter', status: 'DRAFT', tags: ['schluter', 'manual-tag'],
    variantsCount: 2, hasMoreVariants: false,
    variants: [{ id: 'gid://shopify/ProductVariant/11', sku: 'J80BW' }, { id: 'gid://shopify/ProductVariant/12', sku: 'J100BW' }],
  };
  const u = cat.planApply(inp, live);
  assert.equal(u.action, 'update');
  assert.deepEqual(u.identifier, { id: 'gid://shopify/Product/1' });
  assert.deepEqual(u.input.variants.map((v) => v.id || null), ['gid://shopify/ProductVariant/11', 'gid://shopify/ProductVariant/12', null]);
  assert.equal(u.kept, 2);
  assert.equal(u.created, 1);
  assert.ok(!('status' in u.input), 'never changes a live product status');
  assert.ok(!('descriptionHtml' in u.input));
  assert.ok(u.input.tags.includes('manual-tag') && u.input.tags.includes('pickup-only'));
  assert.equal(inp.variants[0].id, undefined, 'the payload itself is not mutated');
  assert.ok('descriptionHtml' in cat.planApply(inp, live, { refreshDescription: true }).input);
});

test('planApply refuses: would delete live variants, other vendor, over 250, duplicate live SKU', () => {
  const inp = built().payloads.find((p) => p.wave === '1').input;
  const base = { id: 'gid://shopify/Product/1', handle: inp.handle, vendor: 'Schluter', status: 'DRAFT', tags: [], variantsCount: 3, hasMoreVariants: false };
  const extra = cat.planApply(inp, { ...base, variants: [{ id: 'a', sku: 'J80BW' }, { id: 'b', sku: 'J100BW' }, { id: 'c', sku: 'J100W' }] });
  assert.equal(extra.action, 'refuse');
  assert.match(extra.errors.join(' '), /would delete 1 live variants \(J100W\)/);
  assert.equal(cat.planApply(inp, { ...base, vendor: 'Mapei', variants: [] }).action, 'refuse');
  assert.equal(cat.planApply(inp, { ...base, variantsCount: 300, hasMoreVariants: true, variants: [] }).action, 'refuse');
  assert.equal(cat.planApply(inp, { ...base, variants: [{ id: 'a', sku: 'J80BW' }, { id: 'b', sku: 'J80BW' }] }).action, 'refuse');
  const active = cat.planApply(inp, { ...base, status: 'ACTIVE', variants: [{ id: 'a', sku: 'J80BW' }, { id: 'b', sku: 'J100BW' }] });
  assert.equal(active.action, 'refuse');
  assert.match(active.errors.join(' '), /ACTIVE; --apply only builds drafts/);
});

test('verifyApplied catches changed IDs, missing SKUs and wrong prices', () => {
  const inp = cat.planApply(built().payloads.find((p) => p.wave === '1').input, {
    id: 'p', handle: PRODUCTS[0].handle, vendor: 'Schluter', status: 'DRAFT', tags: [], variantsCount: 1, hasMoreVariants: false, variants: [{ id: 'v1', sku: 'J80BW' }],
  }).input;
  const good = { handle: inp.handle, status: 'DRAFT', variants: inp.variants.map((v, i) => ({ id: v.id || `new${i}`, sku: v.sku, price: v.price, barcode: v.barcode, inventoryItem: { unitCost: { amount: v.inventoryItem.cost } } })) };
  assert.deepEqual(cat.verifyApplied(inp, good, { action: 'update' }), []);
  const bad = clone(good);
  bad.variants[0].id = 'v9';
  bad.variants[1].price = '1.00';
  bad.variants.pop();
  const problems = cat.verifyApplied(inp, bad, { action: 'update' }).join(' | ');
  assert.match(problems, /variant id changed/);
  assert.match(problems, /missing after productSet/);
  assert.deepEqual(cat.verifyApplied(inp, { ...good, status: 'ACTIVE' }, { action: 'create' }), ['status ACTIVE, expected DRAFT']);
});

test('applyGate: --apply needs --i-have-macs-go and a wave', () => {
  assert.equal(cat.applyGate([]).ok, false);
  assert.match(cat.applyGate(['--apply']).reason, /REFUSED: --apply needs --i-have-macs-go/);
  assert.match(cat.applyGate(['--apply', '--i-have-macs-go']).reason, /--wave=1\|2a/);
  assert.match(cat.applyGate(['--apply', '--i-have-macs-go', '--wave=3']).reason, /REFUSED/);
  assert.deepEqual(cat.applyGate(['--apply', '--i-have-macs-go', '--wave=2a', '--handle=a,b']), { ok: true, wave: '2a', handles: ['a', 'b'], refreshDescription: false, reason: null });
});

test('script: --apply without Mac\'s go exits 2 before any file or network access', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-catalog-'));
  const script = path.join(__dirname, '..', 'scripts', 'trade', 'build-schluter-catalog.js');
  for (const argv of [['--apply'], ['--i-have-macs-go'], ['--apply', '--i-have-macs-go']]) {
    const r = spawnSync(process.execPath, [script, ...argv, `--catalog-dir=${tmp}`], { encoding: 'utf8', env: { ...process.env, SHOPIFY_STORE: '', SHOPIFY_ACCESS_TOKEN: '' } });
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/);
  }
  assert.deepEqual(fs.readdirSync(tmp), [], 'nothing written');
  fs.rmSync(tmp, { recursive: true, force: true });
});
