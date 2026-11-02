const test = require('node:test');
const assert = require('node:assert/strict');

const pc = require('./premap-catalog');

const DATE = '2026-11-02';
const V = (sku, title, vendor = 'Schluter', variant = 'Default Title', productType = 'Floor Heating') => ({ sku, title: variant, product: { title, vendor, handle: `h-${sku}`, status: 'ACTIVE', productType } });
const CABLE = (o = {}) => ({
  api_sku: 'DHEHK24053', prosol_sku: 'DHEHK24053', product: 'Schluter DITRA-HEAT-E Cable 240V 53 sq ft', verified: true,
  brand: 'schluter', cost_cad: 301.33, cost_source: 'prosol-offers-loc10010', map_cad: 475.78, package_shape: 'cable_kit', max_per_pkg: 2, ...o,
});
const ctxFor = (mappings, variants = []) => ({ index: pc.indexByApiSku(mappings), families: pc.buildFamilies(mappings), routing: pc.vendorRouting(variants, mappings), date: DATE });

test('unkeyedGroups: keys compare exactly like staging (case and slashes matter), one group per SKU', () => {
  const mappings = { 'DHERT102/BW': { api_sku: 'DHERT102/BW' }, kst: { api_sku: 'KST' } };
  const { groups, keyed, noSku } = pc.unkeyedGroups([
    V('DHERT102/BW', 'Thermostat'), V('DHERT102BW', 'Thermostat'), V('KST', 'Tray'), V('', 'No sku'),
    V('KSLT1000', 'Shelf', 'Schluter', 'Left'), V('KSLT1000', 'Shelf', 'Schluter', 'Right'),
  ], mappings);
  assert.equal(keyed, 1);
  assert.equal(noSku, 1);
  assert.deepEqual(groups.map((g) => g.sku), ['DHERT102BW', 'KST', 'KSLT1000']);
  const shelf = groups.find((g) => g.sku === 'KSLT1000');
  assert.deepEqual(shelf.names, ['Shelf - Left', 'Shelf - Right']);
  assert.equal(shelf.variants, 2);
  assert.equal(groups[0].names[0], 'Thermostat'); // "Default Title" is not part of the line name
});

test('decideAlias: agreeing verified aliases are copied without their channel fields, with provenance added', () => {
  const candidates = [
    ['B071VFHLJS', CABLE({ alias_of: 'B01N9VNLR4', note: 'ASIN alias', source: 'catalog-schluter-2026-10-01', shopify_handle: 'old', map_override_allowed: true, automayt_item_id: 'x', automayt_item_for: 'DHEHK24053' })],
    ['11460', CABLE({ verified: false, cost_cad: undefined })],
  ];
  const r = pc.decideAlias({ sku: 'DHEHK24053', names: ['Schluter DITRA-HEAT-E-HK Heating Cable - 240V / 53 sq ft'], candidates, families: new Map(), date: DATE });
  assert.ok(r.entry, r.reason);
  for (const f of ['alias_of', 'shopify_handle', 'map_override_allowed', 'automayt_item_id', 'automayt_item_for']) assert.equal(f in r.entry, false, f);
  assert.equal(r.entry.source, 'premap-catalog-alias'); // never the catalogue source that skips staging's name guard
  assert.equal(r.entry.api_sku, 'DHEHK24053');
  assert.equal(r.entry.map_cad, 475.78);
  assert.equal(r.entry.cost_cad, 301.33);
  assert.equal(r.entry.package_shape, 'cable_kit');
  assert.equal(r.entry.max_per_pkg, 2);
  assert.equal(r.entry.discovered_by, 'premap-catalog');
  assert.equal(r.entry.auto_discovered, true);
  assert.match(r.entry.note, /api_sku of verified key B071VFHLJS/);
  assert.deepEqual(r.from, ['B071VFHLJS', '11460']);
});

test('decideAlias: a real disagreement or a HALT skips; a slash-only difference, no verified entry or a failed guard falls through to Prosol', () => {
  const names = ['Schluter DITRA-HEAT-E-HK Heating Cable - 240V / 53 sq ft'];
  const run = (candidates, n = names) => pc.decideAlias({ sku: 'DHEHK24053', names: n, candidates, families: new Map(), date: DATE });
  assert.equal(run([]), null);
  let r = run([['A', CABLE()], ['B', CABLE({ prosol_sku: 'DHEHK24064' })]]);
  assert.equal(r.code, 'alias-disagree');
  assert.equal(r.fallthrough, false);
  r = run([['A', CABLE({ api_sku: 'DHERT102/BW', prosol_sku: 'DHERT102BW' })], ['B', CABLE({ api_sku: 'DHERT102/BW', prosol_sku: 'DHERT102/BW' })]]);
  assert.equal(r.code, 'alias-format');
  assert.equal(r.fallthrough, true);
  r = run([['A', CABLE({ prosol_sku: 'HALT_DISCONTINUED_X' })]]);
  assert.equal(r.code, 'alias-halted');
  assert.equal(r.fallthrough, false);
  r = run([['A', CABLE({ ship_mode: 'pickup_only' })], ['B', CABLE()]]);
  assert.equal(r.code, 'alias-disagree');
  r = run([['A', CABLE({ verified: false })]]);
  assert.equal(r.code, 'alias-unverified');
  assert.equal(r.fallthrough, true);
  r = run([['A', CABLE()]], ['Schluter KERDI-BOARD Shower Niche 12x12']);
  assert.equal(r.code, 'alias-guard');
  assert.equal(r.fallthrough, true);
  r = run([['A', CABLE()]], ['Schluter DITRA-HEAT Cable 53 sq ft - DHEHK24064']);
  assert.equal(r.code, 'title-code-mismatch');
  assert.equal(r.fallthrough, false);
});

test('decideAlias: aliases that disagree on package fields leave them out; aliases without any fall back to the family', () => {
  const names = ['Schluter DITRA-HEAT-E-HK Heating Cable - 240V / 53 sq ft'];
  let r = pc.decideAlias({ sku: 'DHEHK24053', names, candidates: [['A', CABLE()], ['B', CABLE({ package_shape: 'solo', max_per_pkg: undefined })]], families: new Map(), date: DATE });
  assert.equal(r.entry.package_shape, undefined);
  assert.match(r.packageWhy, /aliases disagree/);
  const bare = { ...CABLE() };
  delete bare.package_shape;
  delete bare.max_per_pkg;
  const families = pc.buildFamilies({ x: CABLE({ api_sku: 'DHEHK24038' }), y: CABLE({ api_sku: 'DHEHK24064' }), z: bare });
  r = pc.decideAlias({ sku: 'DHEHK24053', names, candidates: [['A', bare]], families, date: DATE });
  assert.equal(r.entry.package_shape, 'cable_kit');
  assert.match(r.packageWhy, /2 of 2 sibling codes with prefix DHEHK/);
});

test('packageSignature: package-split defaults make "cable_kit" and "cable_kit, max 2" the same box', () => {
  assert.equal(pc.packageSignature({ package_shape: 'cable_kit' }), pc.packageSignature({ package_shape: 'cable_kit', max_per_pkg: 2 }));
  assert.equal(pc.packageSignature({ package_shape: 'solo' }), pc.packageSignature({ package_shape: 'solo', max_per_pkg: 1, max_pkg_weight_lb: 50 }));
  assert.notEqual(pc.packageSignature({ package_shape: 'solo' }), pc.packageSignature({ package_shape: 'solo', max_per_pkg: 2 }));
  assert.equal(pc.packageSignature({ api_sku: 'X' }), null);
});

test('familyPrefix: leading letters before the first digit or slash; numeric and letter-only codes have none', () => {
  assert.equal(pc.familyPrefix('DHEHK24053'), 'DHEHK');
  assert.equal(pc.familyPrefix('KERDI200/5M'), 'KERDI');
  assert.equal(pc.familyPrefix('DITRA-XL/175'), 'DITRA-XL');
  assert.equal(pc.familyPrefix('3BU003891'), null);
  assert.equal(pc.familyPrefix('11458'), null);
  assert.equal(pc.familyPrefix('KBKIT'), null);
});

test('inferPackage: copied only when 2+ siblings and 80% of them carry the same package behaviour', () => {
  const sib = (code, o = {}) => CABLE({ api_sku: code, prosol_sku: code, ...o });
  const plain = (code) => ({ api_sku: code, prosol_sku: code, product: code });
  // 4 of 5 carry it (one through the default max), the code itself is not counted
  let fam = pc.buildFamilies({ a: sib('DHEHK1'), b: sib('DHEHK2'), c: sib('DHEHK3', { max_per_pkg: undefined }), d: sib('DHEHK4'), e: plain('DHEHK5'), self: plain('DHEHK9') });
  let r = pc.inferPackage('DHEHK9', fam);
  assert.deepEqual(r.fields, { package_shape: 'cable_kit', max_per_pkg: 2 });
  // KL: channels carry solo/2, grates carry nothing -> left out
  fam = pc.buildFamilies({ a: sib('KL1V60E60', { package_shape: 'solo' }), b: sib('KL1V60E90', { package_shape: 'solo' }), c: plain('KL1DRE60'), d: plain('KL1DRE90') });
  r = pc.inferPackage('KL1V60E50', fam);
  assert.equal(r.fields, null);
  assert.match(r.why, /only 2 of 4 sibling codes with prefix KL/);
  // siblings that disagree (sheet vs roll) -> left out
  fam = pc.buildFamilies({ a: sib('DHD8MA', { package_shape: 'heat_sheet', max_per_pkg: undefined, max_pkg_weight_lb: 50 }), b: sib('DHD810M', { package_shape: 'solo', max_per_pkg: undefined }) });
  r = pc.inferPackage('DHD825M', fam);
  assert.equal(r.fields, null);
  assert.match(r.why, /disagree/);
  // one code whose own entries disagree is a conflict
  fam = pc.buildFamilies({ a: sib('KST1'), b: sib('KST1', { package_shape: 'solo' }), c: sib('KST2') });
  assert.match(pc.inferPackage('KST3', fam).why, /conflicting/);
  assert.match(pc.inferPackage('11458', fam).why, /no letter family/);
  assert.match(pc.inferPackage('ZZ12', fam).why, /no mapped siblings/);
  // a single sibling is not a pattern
  fam = pc.buildFamilies({ a: sib('SETA50W', { package_shape: 'solo' }) });
  assert.equal(pc.inferPackage('SETA50G', fam).fields, null);
});

test('exactHits: auto-map\'s compare (case only, no slash/space strip), one row per Prosol product id', () => {
  const rows = [
    { id: 1, sku: 'DHERT102/BW' }, { id: 1, sku: 'DHERT102/BW' }, { id: 2, sku: 'DHERT102BW' },
    { id: 3, sku: 'dhert102/bw' }, { id: 4, sku: 'DHERT102/BW-FBA' },
  ];
  assert.deepEqual(pc.exactHits(rows, 'DHERT102/BW').map((p) => p.id), [1, 3]);
  assert.deepEqual(pc.exactHits(rows, 'NOPE'), []);
});

test('prosolPrecheck: one product with a PO code whose name passes the guard; every other case says why', () => {
  const names = ['Schluter® DITRA-HEAT Programmable Touchscreen Thermostat for Heated Floors, White (E-RT)'];
  const P = (o = {}) => ({ id: 10711, sku: 'DHERT102/BW', prosol_sku: 'DHERT102BW', name: { en: 'Schluter - DITRA-HEAT-E-RT TOUCH PROGRAM THERMOSTAT WHITE' }, ...o });
  assert.equal(pc.prosolPrecheck({ names, hits: [] }).code, 'no-prosol-match');
  assert.equal(pc.prosolPrecheck({ names, hits: [P(), P({ id: 2 })] }).code, 'several-prosol-matches');
  assert.equal(pc.prosolPrecheck({ names, hits: [P({ prosol_sku: null })] }).code, 'no-prosol-sku');
  const ok = pc.prosolPrecheck({ names, hits: [P()], existing: [['B01BMZOE6W', { api_sku: 'DHERT102/BW', prosol_sku: 'DHERT102/BW' }]] });
  assert.equal(ok.product.id, 10711); // the slash-only spelling of the same PO code is not a clash
  assert.equal(ok.name, 'Schluter - DITRA-HEAT-E-RT TOUCH PROGRAM THERMOSTAT WHITE');
  const clash = pc.prosolPrecheck({ names, hits: [P()], existing: [['11458', { api_sku: 'DHERT102/BW', prosol_sku: 'DHERT105BW' }]] });
  assert.equal(clash.code, 'conflicts-existing');
  const size = pc.prosolPrecheck({ names: ['Aqua Mix Grout Haze Clean-Up - Pint'], hits: [P({ sku: 'X1', prosol_sku: 'X1', name: 'Aqua Mix Grout Haze Clean-Up 1 Quart (946ml)' })] });
  assert.equal(size.code, 'guard-failed');
  assert.match(size.reason, /size mismatch/);
  const product = pc.prosolPrecheck({ names: ['Schluter KERDI-BOARD Shower Niche 12 x 12'], hits: [P()] });
  assert.equal(product.code, 'guard-failed');
  assert.match(product.reason, /product mismatch/);
  const title = pc.prosolPrecheck({ names: ['DITRA-HEAT Thermostat White - DHERT105/BW'], hits: [P()] });
  assert.equal(title.code, 'title-code-mismatch');
});

test('prosolEntry: needs a cost; entry shaped like auto-map\'s with provenance, product id pin and family package fields', () => {
  const p = { id: 80001, sku: 'DHEHK24064', prosol_sku: 'DHEHK24064' };
  const families = pc.buildFamilies({ a: CABLE({ api_sku: 'DHEHK24038' }), b: CABLE({ api_sku: 'DHEHK24053' }) });
  const base = { sku: 'DHEHK24064', names: ['DITRA-HEAT-E-HK Cable - 240V / 64.6 sq ft'], product: p, name: 'Schluter DITRA-HEAT-E-HK Cable 240V 64.6 sqft', families, date: DATE };
  assert.equal(pc.prosolEntry({ ...base, offer: null }).code, 'no-cost');
  assert.equal(pc.prosolEntry({ ...base, offer: { cost_cad: null } }).code, 'no-cost');
  const { entry, packageWhy } = pc.prosolEntry({ ...base, offer: { cost_cad: 340.1, retail_cad: 596.67 } });
  assert.deepEqual(
    { ...entry, note: undefined },
    {
      cost_cad: 340.1, retail_cad: 596.67, cost_source: 'prosol-offers-loc10010', api_sku: 'DHEHK24064', prosol_sku: 'DHEHK24064',
      prosol_product_id: 80001, product: 'Schluter DITRA-HEAT-E-HK Cable 240V 64.6 sqft', package_shape: 'cable_kit', max_per_pkg: 2,
      note: undefined, verified: true, source: 'prosol-offers-loc10010', auto_discovered: true, discovered_by: 'premap-catalog',
    },
  );
  assert.match(entry.note, /exact Prosol storefront SKU \(product 80001, the only one\)/);
  assert.match(packageWhy, /2 of 2 sibling codes/);
  const lone = pc.prosolEntry({ ...base, families: new Map(), offer: { cost_cad: 1 } });
  assert.equal(lone.entry.package_shape, undefined);
  assert.match(lone.packageWhy, /^left out: /);
});

test('classifyGroup: alias first, then flooring and non-Prosol vendors are skipped before any Prosol lookup', () => {
  const mappings = {
    B071VFHLJS: CABLE(),
    BONA1: { api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL', route_to: 'CFC_SECHELT' },
  };
  const variants = [V('BONA1', 'Bona Mega', 'Bona', 'Default Title', 'Sealer')];
  const ctx = ctxFor(mappings, variants);
  const g = (sku, title, vendor, type) => pc.unkeyedGroups([V(sku, title, vendor, 'Default Title', type)], mappings).groups[0];
  const alias = pc.classifyGroup(g('DHEHK24053', 'Schluter DITRA-HEAT-E-HK Heating Cable 240V 53 sq ft', 'Schluter', 'Floor Heating'), ctx);
  assert.equal(alias.row.tier, 'alias');
  assert.equal(alias.entry.api_sku, 'DHEHK24053');
  assert.equal(alias.row.alias_keys, 'B071VFHLJS');
  assert.equal(pc.classifyGroup(g('03861', 'Cashmere - HydroGen 5 - Click Vinyl Plank by Biyork', 'Biyork', 'Vinyl Plank'), ctx).row.reason_code, 'flooring');
  assert.equal(pc.classifyGroup(g('EC921', 'AquaFix SPC Harmony - Aqua', 'Unifloor', 'Vinyl Plank'), ctx).row.reason_code, 'flooring');
  assert.equal(pc.classifyGroup(g('T1', 'Treeco Stair Nose', 'Treeco', 'Transition & Trim'), ctx).row.reason_code, 'non-prosol-vendor');
  const bona = pc.classifyGroup(g('82', 'Bona Pro Series Hardwood Cleaner 32 oz', 'Bona', 'Cleaner'), ctx);
  assert.equal(bona.row.reason_code, 'non-prosol-vendor');
  assert.match(bona.row.reason, /all ship off-Prosol/);
  const glue = pc.classifyGroup(g('975', 'Ultrabond ECO 975 Urethane Adhesive for Hardwood Flooring', 'Mapei', 'Adhesive'), ctx);
  assert.equal(glue.needsProsol, true); // adhesives name the floor they glue, staging ships them
  assert.equal(pc.classifyGroup(g('A,B', 'Comma', 'Mapei', 'Grout'), ctx).row.reason_code, 'bad-sku');
});

test('nonProsolVendor: the own-warehouse list matches whole words only', () => {
  assert.match(pc.nonProsolVendor('Biyork', new Map()), /own warehouse/);
  assert.match(pc.nonProsolVendor('Biyork Materials Canada Inc.', new Map()), /own warehouse/);
  assert.equal(pc.nonProsolVendor('Jsonite', new Map()), null);
  assert.equal(pc.nonProsolVendor('Mapei', new Map([['Mapei', { prosol: 3, offProsol: 1 }]])), null);
});

test('toCsv escapes quotes, commas and newlines; summarize counts tiers, skip reasons and vendors', () => {
  const rows = [
    { sku: 'A', tier: 'alias', vendor: 'Schluter', line_name: 'Niche 12" x 12", white' },
    { sku: 'B', tier: 'skip', reason_code: 'flooring', vendor: 'Biyork' },
    { sku: 'C', tier: 'skip', reason_code: 'flooring', vendor: 'Biyork' },
    { sku: 'D', tier: 'prosol', vendor: 'Schluter' },
  ];
  const csv = pc.toCsv(rows);
  assert.equal(csv.split('\n')[0], pc.CSV_COLS.join(','));
  assert.match(csv, /"Niche 12"" x 12"", white"/);
  const s = pc.summarize(rows);
  assert.deepEqual(s.tiers, { alias: 1, skip: 2, prosol: 1 });
  assert.deepEqual(s.reasons, { flooring: 2 });
  assert.deepEqual(s.vendors.Schluter, { alias: 1, prosol: 1, skip: 0, total: 2 });
});
