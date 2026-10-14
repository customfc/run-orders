const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('./prosol-catalog');

const product = (over = {}) => ({
  id: 10000, sku: 'W80', prosol_sku: 'W80', name: 'Schluter - JOLLY-P EDGE TRIM 5/16" PVC WHITE', active: true, discontinued: false,
  msrp_price: 717, barcode: '4011832005718', pricing_measure: null, pricing_measure_unit: null,
  product_manufacturer_id: 10008, product_category_id: 10194, ...over,
});

test('stock rule counts locations with units, not rows or the boolean flag', () => {
  const rows = [
    { product_id: 1, location_id: 10010, available: 12 },
    { product_id: 1, location_id: 10010, available: 3 }, // second vendor row at the same branch
    { product_id: 1, location_id: 10003, available: 0 },
    { product_id: 2, location_id: 10010, available: 5 },
    { product_id: 2, location_id: 10054, available: 1 },
    { product_id: 3, location_id: 10001, available: 200 },
  ];
  const s = pc.stockByProduct(rows);
  assert.deepEqual([s.get(1).locations, s.get(1).units], [1, 15]);
  assert.deepEqual([s.get(2).locations, s.get(2).units], [2, 6]);
  assert.equal(pc.passesRule(s.get(1)), false);
  assert.equal(pc.passesRule(s.get(2)), true);
  assert.equal(pc.passesRule(s.get(3)), false);
  assert.equal(pc.passesRule(s.get(3), 1), true);
});

test('buildCatalog keeps the location count, as-of date and verdict on every record', () => {
  const cat = pc.buildCatalog({
    products: [pc.slimProduct({ ...product(), name: { en: 'A', fr: 'B' } }), pc.slimProduct({ ...product({ id: 2, sku: 'X' }) })],
    stockRows: [{ product_id: 10000, location_id: 1, available: 4 }, { product_id: 10000, location_id: 2, available: 9 }],
    manufacturers: [{ id: 10008, name: 'Schluter' }],
    categories: [{ id: 10320, code: 'tools_and_accessories', parent_id: null, name: 'Tools & Accessories' },
      { id: 10304, code: 'moldings_and_trim', parent_id: 10320, name: 'Moldings & Trims' },
      { id: 10194, code: 'tile_edge_trims', parent_id: 10304, name: 'Tile Edge Trims' }],
    asOf: '2026-10-14',
  });
  const [a, b] = cat.records;
  assert.equal(a.name, 'A');
  assert.equal(a.manufacturer, 'Schluter');
  assert.deepEqual(a.category_codes, ['tools_and_accessories', 'moldings_and_trim', 'tile_edge_trims']);
  assert.equal(a.locations, 2);
  assert.equal(a.stock_as_of, '2026-10-14');
  assert.equal(a.passes, true);
  assert.equal(b.locations, 0);
  assert.equal(b.passes, false);
});

test('codes: run-orders stripping, loose dedupe key, leading-zero form', () => {
  assert.equal(pc.stripSku('KERDIFIX/BW'), 'KERDIFIXBW');
  assert.equal(pc.stripSku('C100978-01'), 'C10097801');
  assert.equal(pc.normCode('kl vs sf'), pc.normCode('KL-VS/SF'));
  assert.equal(pc.leadingZeroForm('C100978-01'), 'C100978-1');
  assert.equal(pc.leadingZeroForm('W80'), null);
  // Aqua Mix: Prosol code and maker code differ; both are candidates, Prosol's forms first
  assert.deepEqual(pc.productCodes({ prosol_sku: 'C100978-01', sku: 'C100978-4' }), ['C100978-01', 'C100978-1', 'C100978-4']);
  // Schluter slash codes keep the slash in the candidate (codeVariants adds the stripped form)
  assert.deepEqual(pc.productCodes({ prosol_sku: 'KERDIFIX/BW', sku: 'KERDIFIX/BW' }), ['KERDIFIX/BW']);
});

test('category: Prosol tree to Automayt categories, leaf first, default Accessories', () => {
  const cat = (codes) => pc.automaytCategory({ category_codes: codes });
  assert.equal(cat(['flooring', 'vinyl_flooring', 'vinyl_planks']), 'LVP');
  assert.equal(cat(['flooring', 'vinyl_flooring', 'vinyl_floor_moldings']), 'Accessories');
  assert.equal(cat(['tools_and_accessories', 'installation_supplies', 'membranes_and_underlayments']), 'Underlayment');
  assert.equal(cat(['tools_and_accessories', 'installation_supplies', 'adhesives']), 'Supplies');
  assert.equal(cat(['tools_and_accessories', 'installation_supplies', 'floor_vent']), 'Accessories');
  assert.equal(cat(['tools_and_accessories', 'tools_and_equipment', 'trowels']), 'Accessories');
  assert.equal(cat(['flooring', 'wood_flooring', 'engineered_hardwood']), 'Hardwood');
  assert.equal(cat([]), 'Accessories');
});

test('toItemInput: vendor code stripped like autoCreateItem, raw forms as aliases, Prosol id as external ref', () => {
  const rec = { ...product({ id: 5, sku: 'C100978-4', prosol_sku: 'C100978-01', name: 'Aqua Mix - NanoScrub 946ml', barcode: '012345678905' }), manufacturer: 'Aqua Mix', category_codes: ['floorcare', 'ceramic_and_stone_cleaners'] };
  const input = pc.toItemInput(rec, { cost: 12.34, retail: 21.5 });
  assert.equal(input.vendorCode, 'C10097801');
  assert.equal(input.itemNumber, 'C1009784');
  assert.equal(input.unit, 'each');
  assert.equal(input.cost, 12.34);
  assert.equal(input.retail, 21.5);
  assert.equal(input.category, 'Supplies');
  assert.equal(input.stockStatus, 'Special Order');
  assert.deepEqual(input.aliases, [
    { code: 'C100978-01', kind: 'vendor_code' },
    { code: 'C100978-4', kind: 'vendor_code' },
    { code: '012345678905', kind: 'upc' },
  ]);
  assert.deepEqual(input.externalRefs, [{ system: 'prosol', external_id: '5' }]);
});

test('toItemInput: retail falls back to msrp (cents), EAN-13 kept, no cost = skip', () => {
  const rec = { ...product(), manufacturer: 'Schluter', category_codes: ['tile_edge_trims'] };
  const input = pc.toItemInput(rec, { cost: 4.09 });
  assert.equal(input.retail, 7.17);
  assert.equal(input.upc, '4011832005718');
  assert.equal(input.vendorCode, 'W80');
  assert.deepEqual(input.aliases, [{ code: '4011832005718', kind: 'upc' }]);
  assert.deepEqual(pc.toItemInput(rec, {}), { skip: 'no cost' });
  assert.deepEqual(pc.toItemInput(rec, { cost: null }), { skip: 'no cost' });
});

test('toItemInput: flooring with coverage goes in per sq ft / ft (Prosol prices the whole tile or roll); others keep the selling unit', () => {
  const vinyl = ['flooring', 'vinyl_flooring', 'vinyl_tiles'];
  // RT38S: Prosol offer $47.32 for a 4 sq ft tile (2026-10-14)
  const tile = pc.toItemInput({ ...product({ prosol_sku: 'RT38S', sku: '400630092', name: 'Tarkett - Rubber Tile Solid Color RT 38', pricing_measure: 4, pricing_measure_unit: 'sqft' }), manufacturer: 'Tarkett', category_codes: vinyl }, { cost: 47.32, retail: 72.8 });
  assert.equal(tile.category, 'LVP');
  assert.equal(tile.unit, 'sqft');
  assert.equal(tile.cost, 11.83);
  assert.equal(tile.retail, 18.2);
  assert.equal(tile.boxQuantity, 4);
  assert.match(tile.description, / - 4 SqFt$/);
  // TW55: $237.25 for a 50 ft roll
  const roll = pc.toItemInput({ ...product({ prosol_sku: 'TW55', sku: 'TW55', name: 'Tarkett - Tactile Warning Surface Vinyl Roll', pricing_measure: 50, pricing_measure_unit: 'lf' }), category_codes: vinyl }, { cost: 237.25, retail: 365 });
  assert.deepEqual([roll.unit, roll.cost, roll.retail, roll.boxQuantity], ['lnft', 4.745, 7.3, 50]);
  assert.equal(pc.unitCostFor({ pricing_measure: 50, pricing_measure_unit: 'lf', category_codes: vinyl }, 237.25), 4.745);
  // non-flooring keeps the selling unit, coverage only in the description
  const mould = pc.toItemInput({ ...product({ prosol_sku: '440587000', sku: 'TM-50A', name: "Tarkett - Tub Mouldings White 5'", pricing_measure: 5, pricing_measure_unit: 'lf' }), category_codes: ['flooring', 'vinyl_flooring', 'vinyl_floor_moldings'] }, { cost: 6 });
  assert.equal(mould.unit, 'each');
  assert.equal(mould.boxQuantity, undefined);
  assert.match(mould.description, / - 5 LnFt$/);
  assert.equal(pc.unitCostFor({ pricing_measure: 5, pricing_measure_unit: 'lf', category_codes: [] }, 6), 6);
  const pack = pc.toItemInput({ ...product({ name: 'Tajima - Blade - Pack of 10', pricing_measure: 10, pricing_measure_unit: 'ea' }) }, { cost: 60 });
  assert.equal(pack.description, 'Tajima - Blade - Pack of 10');
  // coverage already in the name is not repeated; a membrane roll is not flooring
  const ditra = pc.toItemInput({ ...product({ name: 'Schluter - DITRA-HEAT - 134.5 SqFt', pricing_measure: 134.5, pricing_measure_unit: 'sqft' }), category_codes: ['membranes_and_underlayments'] }, { cost: 600 });
  assert.equal(ditra.description, 'Schluter - DITRA-HEAT - 134.5 SqFt');
  assert.equal(ditra.unit, 'each');
});

test('toItemInput: flooring with no coverage in Prosol data is left out unless asked; brand = manufacturer', () => {
  const plank = { ...product({ prosol_sku: 'IDLAT-7018', sku: 'IDLAT-7018', name: 'Tarkett - Vinyl Plank iD Latitude' }), manufacturer: 'Tarkett', category_codes: ['flooring', 'vinyl_flooring', 'vinyl_planks'] };
  assert.deepEqual(pc.toItemInput(plank, { cost: 197.89 }), { skip: 'flooring without coverage' });
  const kept = pc.toItemInput(plank, { cost: 197.89, includeFlooringWithoutCoverage: true });
  assert.equal(kept.unit, 'each');
  assert.equal(kept.brand, 'Tarkett');
  assert.equal(kept.manufacturer, 'Tarkett');
});

test('resolveCollisions: same code and price = one item (newest listing), twins ride along; different prices are held', () => {
  const plm = { id: 100564, prosol_sku: '100WM', sku: '100WM', manufacturer: 'Perfect Level Master', msrp_price: 2925, updated_at: '2026-10-09T00:00:00Z', locations: 26, barcode: null, category_codes: [] };
  const ptx = { id: 100642, prosol_sku: '100WM', sku: '100WM', manufacturer: 'PTX Group', msrp_price: 2925, updated_at: '2026-09-03T00:00:00Z', locations: 25, barcode: '812730003141', category_codes: [] };
  const a = { id: 1, prosol_sku: 'VIRNRD2048', sku: 'X1', msrp_price: 5000, updated_at: '2026-10-01', locations: 3 };
  const b = { id: 2, prosol_sku: 'VIRNRD2048', sku: 'X2', msrp_price: 6100, updated_at: '2026-10-02', locations: 4 };
  const recs = [plm, ptx, a, b];
  const settled = pc.resolveCollisions(pc.codeCollisions(recs), new Map(recs.map((r) => [r.id, r])));
  assert.deepEqual([...settled.keep.keys()], [100564]);
  assert.deepEqual([...settled.drop], [100642]);
  assert.deepEqual([...settled.held.values()], [[1, 2]]);
  const input = pc.toItemInput(plm, { cost: 20.48, retail: 29.25, twins: settled.keep.get(100564) });
  assert.equal(input.upc, '812730003141');
  assert.deepEqual(input.aliases, [{ code: '812730003141', kind: 'upc' }]);
  assert.deepEqual(input.externalRefs, [{ system: 'prosol', external_id: '100564' }, { system: 'prosol', external_id: '100642' }]);
});

test('short numbers never match by item number, and a short-number maker code is not looked up', () => {
  assert.equal(pc.isShortNumeric('05961'), true);
  assert.equal(pc.isShortNumeric('10-940'), true);
  assert.equal(pc.isShortNumeric('943851421'), false);
  assert.equal(pc.isShortNumeric('R5961'), false);
  // Rubi: Prosol code R5961, maker code 05961 (same shape as CFC item number 05961)
  assert.deepEqual(pc.lookupCodes({ prosol_sku: 'R5961', sku: '05961' }), { vendorCodes: ['R5961'], itemNumbers: ['R5961'] });
  // Richard: Prosol and maker code both 05301; still looked up as a vendor code, never as an item number
  assert.deepEqual(pc.lookupCodes({ prosol_sku: '05301', sku: '05301' }), { vendorCodes: ['05301'], itemNumbers: [] });
  const sf = [{ id: 'carpet', name: '05961', vendorItemId: '4748-815', vendorId: 'OTHER' }, { id: 'glove', name: '02311', vendorItemId: '05301', vendorId: 'PROSOL' }];
  const { results } = pc.dedupeAgainstSf([{ id: 1, prosol_sku: 'R5961', sku: '05961' }, { id: 2, prosol_sku: '05301', sku: '05301' }], sf, { prosolVendorId: 'PROSOL' });
  assert.equal(results.get(1).status, 'new');
  assert.equal(results.get(2).status, 'matched');
  // Crain 341 vs another vendor's vendor item id 341: taken, not the same product
  const r2 = pc.dedupeAgainstSf([{ id: 3, prosol_sku: '341', sku: '341' }, { id: 4, prosol_sku: 'WB252018002', sku: 'WB252018002' }],
    [{ id: 'erv', name: '14616', vendorItemId: '341', vendorId: 'ERV' }, { id: 'bona', name: '08640', vendorItemId: 'WB252018002', vendorId: 'TREECO' }], { prosolVendorId: 'PROSOL' });
  assert.equal(r2.results.get(3).status, 'taken');
  assert.equal(r2.results.get(4).status, 'matched');
  assert.equal(r2.results.get(4).otherVendor, true);
});

test('dedupe: matched on vendor item id or name, ambiguous legacy duplicates, shared Salesforce items', () => {
  const sf = [
    { id: 'a1', name: '02368', vendorItemId: 'A60PG', vendorId: 'PROSOL' },
    { id: 'a2', name: '01177', vendorItemId: 'KL VS SF', vendorId: 'PROSOL' },
    { id: 'a3', name: 'KERDIFIXBW', vendorItemId: 'KERDIFIXBW', vendorId: 'PROSOL' },
    { id: 'a4', name: '09999', vendorItemId: 'KERDIFIX/BW', vendorId: 'PROSOL' }, // legacy slashed twin
    { id: 'a5', name: 'X4WHITE', vendorItemId: null, vendorId: 'OTHER' },
    { id: 'a6', name: '05961', vendorItemId: '4748-815', vendorId: 'OTHER' },
  ];
  const recs = [
    { id: 1, prosol_sku: 'A60/PG', sku: 'A60/PG' },
    { id: 2, prosol_sku: 'KL-VS-SF', sku: 'KL-VS-SF' },
    { id: 3, prosol_sku: 'KERDIFIX/BW', sku: 'KERDIFIX/BW' },
    { id: 4, prosol_sku: 'X4White', sku: 'X4White' },
    { id: 5, prosol_sku: 'NEW-1', sku: 'NEW-1' },
    { id: 6, prosol_sku: 'A60PG', sku: 'A60PG' },
  ];
  const { results, sharedSfItems } = pc.dedupeAgainstSf(recs, sf, { prosolVendorId: 'PROSOL' });
  assert.equal(results.get(1).status, 'matched');
  assert.equal(results.get(2).status, 'matched');
  assert.equal(results.get(3).status, 'ambiguous');
  assert.equal(results.get(4).status, 'matched');
  assert.match(results.get(4).via, /^name:/);
  assert.equal(results.get(4).otherVendor, true);
  assert.equal(results.get(5).status, 'new');
  assert.deepEqual(sharedSfItems, [{ sfId: 'a1', prosolIds: [1, 6] }]);
});

test('spread picks evenly across the list', () => {
  assert.deepEqual(pc.spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [1, 4, 7]);
  assert.deepEqual(pc.spread([1, 2], 5), [1, 2]);
});

test('price at Burnaby first, then the BC branch with most stock, then any stocking branch', () => {
  const bc = pc.bcLocationIds([{ id: 10010, name: 'Prosol | Burnaby | BC' }, { id: 10003, name: 'Prosol | Coquitlam | BC' }, { id: 10004, name: 'Prosol | Saint-Laurent | QC' }, { id: 10054, name: 'Prosol | Calgary | AB' }]);
  assert.deepEqual([...bc].sort(), [10003, 10010]);
  assert.deepEqual(pc.priceLocations({ stock_by_location: { 10004: 50, 10003: 2, 10054: 9 } }, { bcLocationIds: bc }), [10010, 10003, 10004]);
  assert.deepEqual(pc.priceLocations({ stock_by_location: { 10004: 50, 10054: 9 } }, { bcLocationIds: bc }), [10010, 10004, 10054]);
  assert.deepEqual(pc.priceLocations({ stock_by_location: { 10010: 5, 10003: 2 } }, { bcLocationIds: bc }), [10010, 10003]);
  assert.deepEqual(pc.priceLocations({}, { bcLocationIds: bc }), [10010]);
});

test('codeCollisions finds Prosol codes reused across products (Automayt would merge them)', () => {
  const recs = [
    { id: 1, prosol_sku: 'VIRNRD2048', sku: 'PRO-401299127' },
    { id: 2, prosol_sku: 'VIRNRD2048', sku: '401295206' },
    { id: 3, prosol_sku: 'TDCR167-4R', sku: '440570058' },
    { id: 4, prosol_sku: 'TDCR167-4-R', sku: '440570058-LF' },
    { id: 5, prosol_sku: 'W80', sku: 'W80' },
  ];
  assert.deepEqual([...pc.codeCollisions(recs).values()], [[1, 2], [3, 4]]);
});
