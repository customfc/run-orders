const test = require('node:test');
const assert = require('node:assert/strict');
const { matchVendorCodes, patchBody } = require('./automayt-vendor-codes');

let n = 0;
const item = (f = {}) => ({
  id: `it-${++n}`, item_number: `PRD-${String(n).padStart(4, '0')}`, vendor_code: null, upc: null, version: 'v1',
  default_vendor: { name: 'Ames Tile & Stone' }, manufacturer: 'Ames', style: 'Fan', color: 'Clear Matte',
  retail_price: '19.94', cost: { vendor_cost: '11.50' }, ...f,
});
const sf = (f = {}) => ({
  Id: `sf-${++n}`, Name: String(10000 + n), PBSI__Vendor_Item_ID__c: 'FNCRM38', PBSI__Default_Vendor_Name__c: 'Ames Tile & Stone',
  Manufacturer__c: 'Ames', Original_Style_Name__c: 'Fan', Color__c: 'Clear Matte', PBSI__salesprice__c: 19.94, PBSI__Cost__c: 11.5,
  PBSI__UPC_Code__c: null, PBSI__UPC__c: null, ...f,
});
const one = (r) => ({ matched: r.matched.length, held: r.held.length, unmatched: r.unmatched.length, skipped: r.skipped.length });

test('one Salesforce item with the same vendor, maker, style and colour: its Vendor Item ID, stripped', () => {
  const r = matchVendorCodes([item({ manufacturer: ' AMES ', color: 'clear  matte' })], [sf({ PBSI__Vendor_Item_ID__c: '- FN-CRM/38 ' })], []);
  assert.deepEqual(one(r), { matched: 1, held: 0, unmatched: 0, skipped: 0 });
  assert.equal(r.matched[0].code, 'FNCRM38');
  assert.equal(r.matched[0].rule, 'exact');
  assert.equal(r.matched[0].source, 'salesforce');
});

test('the crosswalk Prosol code wins over the Salesforce Vendor Item ID', () => {
  const s = sf({ Name: '02505', PBSI__Vendor_Item_ID__c: 'KB KIT', PBSI__Default_Vendor_Name__c: 'Prosol Inc.' });
  const r = matchVendorCodes([item({ default_vendor: { name: 'Prosol Inc.' } })], [s], [{ sf_item_name: '02505', automayt_vendor_code: 'KBKIT', advice: 'match by vendor code' }]);
  assert.equal(r.matched[0].code, 'KBKIT');
  assert.equal(r.matched[0].source, 'prosol');
  // On another vendor's item the crosswalk is ignored: its own code, held if Prosol uses it for something else.
  const other = sf({ Name: '08438', PBSI__Vendor_Item_ID__c: '10645', PBSI__Default_Vendor_Name__c: 'Ames Tile & Stone' });
  const r2 = matchVendorCodes([item()], [other], [{ sf_item_name: '08438', automayt_vendor_code: '10645', advice: 'match by vendor code' }], new Map([['10645', 'American Moisture Test kit']]));
  assert.equal(r2.held.length, 1);
  assert.match(r2.held[0].reason, /also a Prosol code/);
});

test('a single candidate needs its retail price or cost to agree', () => {
  const r = matchVendorCodes([item({ retail_price: '25.00', cost: { vendor_cost: '14.00' } })], [sf()], []);
  assert.deepEqual(one(r), { matched: 0, held: 0, unmatched: 1, skipped: 0 });
  const ok = matchVendorCodes([item({ retail_price: '25.00' })], [sf()], []);
  assert.equal(ok.matched.length, 1, 'cost alone agrees');
});

test('several sizes: only one at this retail price AND cost is taken; otherwise unmatched', () => {
  const sizes = [sf({ PBSI__Vendor_Item_ID__c: 'FN38', PBSI__salesprice__c: 19.94 }), sf({ PBSI__Vendor_Item_ID__c: 'FN48', PBSI__salesprice__c: 24.5, PBSI__Cost__c: 14 })];
  assert.equal(matchVendorCodes([item()], sizes, []).matched[0].code, 'FN38');
  const same = [sf({ PBSI__Vendor_Item_ID__c: 'FN38' }), sf({ PBSI__Vendor_Item_ID__c: 'FN48' })];
  const r = matchVendorCodes([item()], same, []);
  assert.deepEqual(one(r), { matched: 0, held: 0, unmatched: 1, skipped: 0 });
});

test('several at the same price: the barcode settles it', () => {
  const same = [sf({ PBSI__Vendor_Item_ID__c: 'FN38', PBSI__UPC_Code__c: '0123456789012' }), sf({ PBSI__Vendor_Item_ID__c: 'FN48' })];
  const r = matchVendorCodes([item({ upc: '0123456789012' })], same, []);
  assert.equal(r.matched[0].code, 'FN38');
  assert.equal(r.matched[0].rule, 'exact+upc');
});

test('mangled characters match on letters and digits only when retail price AND cost agree', () => {
  const s = sf({ Original_Style_Name__c: 'White Décor', PBSI__Vendor_Item_ID__c: 'RFW1224' });
  const r = matchVendorCodes([item({ style: 'White DÈcor' })], [s], []);
  assert.equal(r.matched[0].rule, 'text');
  const r2 = matchVendorCodes([item({ style: 'White DÈcor', cost: { vendor_cost: '9.00' } })], [s], []);
  assert.equal(r2.unmatched.length, 1);
});

test('nothing is written when two items claim one Salesforce item or one code', () => {
  const r = matchVendorCodes([item(), item()], [sf()], []);
  assert.deepEqual(one(r), { matched: 0, held: 2, unmatched: 0, skipped: 0 });
  const r2 = matchVendorCodes([item(), item({ style: 'Fan 2' })], [sf(), sf({ Original_Style_Name__c: 'Fan 2', PBSI__Vendor_Item_ID__c: 'FN-CRM38' })], []);
  assert.equal(r2.held.length, 2);
  assert.match(r2.held[0].reason, /would go on 2 items/);
  // Automayt ignores spaces and punctuation in codes: "0790  441P4" and "0790441P4" are one code.
  const r3 = matchVendorCodes([item(), item({ style: 'Fan 2' })], [sf({ PBSI__Vendor_Item_ID__c: '0790  441P4' }), sf({ Original_Style_Name__c: 'Fan 2', PBSI__Vendor_Item_ID__c: '0790441P4' })], []);
  assert.equal(r3.held.length, 2);
});

test('a code that is already another item\'s barcode is held', () => {
  const r = matchVendorCodes([item(), item({ manufacturer: 'Other', upc: 'FNCRM38' })], [sf()], []);
  assert.equal(r.held.length, 1);
  assert.match(r.held[0].reason, /already the barcode of another item/);
});

test('another vendor\'s code that is also a Prosol code is held; Prosol\'s own is not', () => {
  const prosol = new Map([['FNCRM38', 'Some Prosol product']]);
  const r = matchVendorCodes([item()], [sf()], [], prosol);
  assert.equal(r.held.length, 1);
  assert.match(r.held[0].reason, /also a Prosol code/);
  const p = matchVendorCodes([item({ default_vendor: { name: 'Prosol Inc.' } })], [sf({ PBSI__Default_Vendor_Name__c: 'Prosol Inc.' })], [], prosol);
  assert.equal(p.matched.length, 1);
});

test('a crosswalk "do NOT match" row, or an empty Vendor Item ID, is held', () => {
  const s = sf({ Name: '05961' });
  const r = matchVendorCodes([item()], [s], [{ sf_item_name: '05961', automayt_vendor_code: 'FNCRM38', advice: 'do NOT match: same short code, different product' }]);
  assert.equal(r.held.length, 1);
  const r2 = matchVendorCodes([item()], [sf({ PBSI__Vendor_Item_ID__c: '-' })], []);
  assert.match(r2.held[0].reason, /no usable Vendor Item ID/);
  for (const placeholder of ['n/a', 'EA', 'Ames', 'AMES TILE']) {
    assert.match(matchVendorCodes([item()], [sf({ PBSI__Vendor_Item_ID__c: placeholder })], []).held[0].reason, /no usable Vendor Item ID/, placeholder);
  }
});

test('a barcode holding our own code is cleared; a real UPC is kept', () => {
  const r = matchVendorCodes([item({ upc: 'FN-CRM38' })], [sf()], []);
  assert.equal(r.matched[0].clearUpc, true);
  assert.deepEqual(patchBody(r.matched[0]), { vendor_code: 'FNCRM38', upc: null, expected_version: 'v1' });
  const r2 = matchVendorCodes([item({ upc: '4011832165979' })], [sf()], []);
  assert.equal(r2.matched[0].clearUpc, false);
  assert.deepEqual(patchBody(r2.matched[0]), { vendor_code: 'FNCRM38', expected_version: 'v1' });
});

test('the Salesforce crosswalk covers every Salesforce item: a code, no code, or held with the other items named', () => {
  const { salesforceCrosswalk } = require('./automayt-vendor-codes');
  const items = [sf({ Name: 'A', PBSI__Vendor_Item_ID__c: 'X-1' }), sf({ Name: 'B', PBSI__Vendor_Item_ID__c: 'X1' }), sf({ Name: 'C', PBSI__Vendor_Item_ID__c: 'n/a' }),
    sf({ Name: 'D', PBSI__Vendor_Item_ID__c: 'D9', PBSI__UPC_Code__c: 'D-9' }), sf({ Name: 'E', PBSI__Vendor_Item_ID__c: 'E5' }), sf({ Name: 'F', PBSI__Vendor_Item_ID__c: 'F1', PBSI__UPC_Code__c: 'E5' })];
  const { rows, held } = salesforceCrosswalk(items, [], new Map());
  assert.equal(rows.length + held.length, items.length);
  assert.deepEqual(held.map((h) => h.sf.Name).sort(), ['A', 'B', 'E']);
  assert.match(held.find((h) => h.sf.Name === 'A').issue, /same code on 2/);
  assert.match(held.find((h) => h.sf.Name === 'E').issue, /barcode of another/);
  assert.deepEqual(rows.find((r) => r.sf.Name === 'C'), { sf: items[2], beta1: [], code: '', source: 'none', clearBarcode: '', vendor: { vendor: 'Ames Tile & Stone', cost: 11.5, switched: false, rule: '', note: '' } });
  assert.equal(rows.find((r) => r.sf.Name === 'D').clearBarcode, 'D-9');
});

test('items that are not PRD items, or already carry a code, are left alone', () => {
  const r = matchVendorCodes([item({ item_number: 'ROTEST-1' }), item({ vendor_code: 'X1' })], [sf()], []);
  assert.deepEqual(one(r), { matched: 0, held: 0, unmatched: 0, skipped: 2 });
});

test('a maker\'s code is letters and digits 5+, or digits 7+; CFC short numbers never are', () => {
  const { isMakerCode } = require('./automayt-vendor-codes');
  for (const c of ['WT133918001', 'AAS388026540100', 'BR85111', 'BUZPB 4Top', '9451967', '66261040286', '801200801']) assert.equal(isMakerCode(c), true, c);
  for (const c of ['05961', '10645', '1290', 'A175', 'CA19', '4DN', 'Black', 'Flush Square Stair Nose', '']) assert.equal(isMakerCode(c), false, c);
});

test('same brand: equal, or one name starting the other (4+ letters)', () => {
  const { sameBrand } = require('./automayt-vendor-codes');
  assert.equal(sameBrand('Bona', 'BONA'), true);
  assert.equal(sameBrand('Buzon', 'Buzon Canada'), true);
  assert.equal(sameBrand('Rubi Tools', 'Rubi'), true);
  assert.equal(sameBrand('Fitties', 'Fittes'), false);
  assert.equal(sameBrand('Norton', 'Treeco'), false);
  assert.equal(sameBrand('', 'Bona'), false);
});

const MEGA = [{ brand: '^bona$', match: '\\bmega\\b', vendor: 'Treeco', why: 'Mega from Treeco' }];
const BONA = [{ brand: '^bona$', vendor: 'Prosol Inc.', costStale: true, why: 'All Bona available at Prosol' }];
const BONA_TREECO = [{ brand: '^bona$', vendor: 'Treeco', why: 'Treeco preferred until Prosol pricing is confirmed better' }];

test('Bona stays with Treeco (the live preference): no switch to Prosol whatever the price, and nothing moved off Prosol', () => {
  const { chooseVendor } = require('./automayt-vendor-codes');
  const quantum = chooseVendor({ currentVendor: 'Treeco', currentCost: 197.4, prosolCost: 149.5, brand: 'Bona', text: 'Quantum', preferences: BONA_TREECO });
  assert.deepEqual([quantum.vendor, quantum.cost, quantum.switched, quantum.rule], ['Treeco', 197.4, false, 'preference']);
  const atProsol = chooseVendor({ currentVendor: 'Prosol Inc.', currentCost: 20, prosolCost: 20, brand: 'Bona', text: 'x', preferences: BONA_TREECO });
  assert.deepEqual([atProsol.vendor, atProsol.switched, atProsol.rule], ['Prosol Inc.', false, 'preference not applied']);
  const t = matchVendorCodes([item({ default_vendor: { name: 'Treeco' }, manufacturer: 'Bona', cost: { vendor_cost: '197.40' } })], [sf({ PBSI__Default_Vendor_Name__c: 'Treeco', Manufacturer__c: 'Bona', PBSI__Vendor_Item_ID__c: 'BR85111', PBSI__Cost__c: 197.4 })], [], new Map([['BR85111', { name: 'Bona Quantum', manufacturer: 'Bona', cost: 149.5 }]]), { preferences: BONA_TREECO });
  assert.deepEqual(patchBody(t.matched[0]), { vendor_code: 'BR85111', expected_version: 'v1' }, 'code written, vendor and cost untouched');
});

test('the cheaper unit cost wins; a tie, a missing cost or costs 3x apart keep the current vendor', () => {
  const { chooseVendor } = require('./automayt-vendor-codes');
  const base = { currentVendor: 'Treeco', brand: 'Norton', text: 'Edger disc', preferences: BONA };
  assert.deepEqual(chooseVendor({ ...base, currentCost: 197.4, prosolCost: 149.5 }), { vendor: 'Prosol Inc.', cost: 149.5, switched: true, rule: 'cheaper', note: 'Prosol 149.5 < Treeco 197.4' });
  assert.equal(chooseVendor({ ...base, currentCost: 6.49, prosolCost: 12.25 }).switched, false);
  assert.equal(chooseVendor({ ...base, currentCost: 10, prosolCost: 10 }).rule, 'tie');
  assert.equal(chooseVendor({ ...base, currentCost: 10, prosolCost: null }).rule, 'no Prosol cost');
  assert.equal(chooseVendor({ ...base, currentCost: 0, prosolCost: 5 }).rule, 'no current cost');
  const far = chooseVendor({ ...base, currentCost: 92.26, prosolCost: 24.38 });
  assert.deepEqual([far.switched, far.rule, far.vendor, far.cost], [false, 'review', 'Treeco', 92.26]);
});

test('a preference wins over price: every Bona item to Prosol, at the (possibly stale) Prosol cost', () => {
  const { chooseVendor } = require('./automayt-vendor-codes');
  const mega = chooseVendor({ currentVendor: 'Treeco', currentCost: 119.99, prosolCost: 163.77, brand: 'Bona', text: 'Mega Satin', preferences: BONA });
  assert.deepEqual([mega.vendor, mega.switched, mega.rule, mega.cost, mega.costStale], ['Prosol Inc.', true, 'preference', 163.77, true]);
  assert.match(mega.note, /All Bona available at Prosol; Prosol cost 163\.77 from the 2026-10-14 portal pull, may be stale/);
  const far = chooseVendor({ currentVendor: 'Treeco', currentCost: 2.04, prosolCost: 212.16, brand: 'Bona', text: 'x', preferences: BONA });
  assert.deepEqual([far.switched, far.cost], [true, 212.16], 'the 3x guard only warns under a preference');
  assert.match(far.note, /more than 3x apart/);
  const unpriced = chooseVendor({ currentVendor: 'Treeco', currentCost: 50, prosolCost: null, brand: 'Bona', text: 'x', preferences: BONA });
  assert.deepEqual([unpriced.vendor, unpriced.cost, unpriced.costStale], ['Prosol Inc.', 50, undefined]);
  assert.match(unpriced.note, /no Prosol cost in the snapshot: cost left at Treeco's 50/);
  // No Prosol product under the item's code: not moved, listed.
  const none = chooseVendor({ currentVendor: 'Treeco', currentCost: 119.99, prosolCost: null, brand: 'Bona', text: 'Mega ONE', preferences: BONA, atProsol: false });
  assert.deepEqual([none.vendor, none.switched, none.rule], ['Treeco', false, 'no Prosol code']);
  const already = chooseVendor({ currentVendor: 'Prosol Inc.', currentCost: 150, prosolCost: 150, brand: 'Bona', text: 'Gloss', preferences: BONA });
  assert.deepEqual([already.vendor, already.switched, already.rule], ['Prosol Inc.', false, 'preference']);
  // A style pattern narrows a preference to whole words.
  assert.equal(chooseVendor({ currentVendor: 'Treeco', currentCost: 200, prosolCost: 150, brand: 'Bona', text: 'Mega Satin', preferences: MEGA }).rule, 'preference');
  assert.equal(chooseVendor({ currentVendor: 'Treeco', currentCost: 200, prosolCost: 250, brand: 'Bona', text: 'Megastar', preferences: MEGA }).rule, 'cheaper');
});

test('another vendor\'s code Prosol shares: written when same brand + maker\'s code, with the cheaper default vendor', () => {
  const treeco = (f) => item({ default_vendor: { name: 'Treeco' }, manufacturer: 'Norton', style: 'Redheat', color: '36 grit', cost: { vendor_cost: '197.40' }, retail_price: '249.99', ...f });
  const s = (f) => sf({ PBSI__Default_Vendor_Name__c: 'Treeco', Manufacturer__c: 'Norton', Original_Style_Name__c: 'Redheat', Color__c: '36 grit', PBSI__salesprice__c: 249.99, PBSI__Cost__c: 197.4, ...f });
  const prosol = new Map([['NR66261040286', { name: 'Norton RedHeat disc', manufacturer: 'Norton', cost: 149.5 }], ['05961', { name: 'Rubi drill bit', manufacturer: 'Norton', cost: 10 }], ['NR12345', { name: 'Norton pad', manufacturer: 'Norton', cost: 250 }], ['BR85111', { name: 'Bona Quantum', manufacturer: 'Bona', cost: 149.5 }]]);
  const r = matchVendorCodes([treeco()], [s({ PBSI__Vendor_Item_ID__c: 'NR66261040286' })], [], prosol, { preferences: BONA });
  assert.equal(r.matched.length, 1);
  assert.deepEqual([r.matched[0].vendor.vendor, r.matched[0].vendor.switched, r.matched[0].vendor.shared], ['Prosol Inc.', true, true]);
  const body = patchBody(r.matched[0], new Map([['prosol inc.', 'v-prosol']]));
  assert.deepEqual(body, { vendor_code: 'NR66261040286', vendor_id: 'v-prosol', cost: '149.5000', expected_version: 'v1' });
  assert.throws(() => patchBody(r.matched[0]), /no Automayt vendor named Prosol Inc\./);
  const stays = matchVendorCodes([treeco()], [s({ PBSI__Vendor_Item_ID__c: 'NR12345' })], [], prosol, { preferences: BONA });
  assert.deepEqual(patchBody(stays.matched[0]), { vendor_code: 'NR12345', expected_version: 'v1' }, 'no vendor change when the current vendor is cheaper');

  const short = matchVendorCodes([treeco()], [s({ PBSI__Vendor_Item_ID__c: '05961' })], [], prosol);
  assert.match(short.held[0].reason, /also a Prosol code .*not a maker's code/);
  const brand = matchVendorCodes([treeco({ manufacturer: 'Klingspor' })], [s({ Manufacturer__c: 'Klingspor', PBSI__Vendor_Item_ID__c: 'NR66261040286' })], [], prosol);
  assert.match(brand.held[0].reason, /different brand \(Klingspor vs Prosol's Norton\)/);

  // Bona: Prosol whatever the price; a Bona item Prosol has no code for keeps its vendor.
  const bona = (f) => item({ default_vendor: { name: 'Treeco' }, manufacturer: 'Bona', style: 'Quantum', color: 'R851', cost: { vendor_cost: '100.00' }, retail_price: '249.99', ...f });
  const bsf = (f) => sf({ PBSI__Default_Vendor_Name__c: 'Treeco', Manufacturer__c: 'Bona', Original_Style_Name__c: 'Quantum', Color__c: 'R851', PBSI__salesprice__c: 249.99, PBSI__Cost__c: 100, ...f });
  const q = matchVendorCodes([bona()], [bsf({ PBSI__Vendor_Item_ID__c: 'BR85111' })], [], prosol, { preferences: BONA });
  assert.deepEqual([q.matched[0].vendor.vendor, q.matched[0].vendor.cost, q.matched[0].vendor.rule], ['Prosol Inc.', 149.5, 'preference']);
  const one = matchVendorCodes([bona()], [bsf({ PBSI__Vendor_Item_ID__c: 'BONAMEGA1' })], [], prosol, { preferences: BONA });
  assert.deepEqual([one.matched[0].vendor.vendor, one.matched[0].vendor.switched, one.matched[0].vendor.rule], ['Treeco', false, 'no Prosol code']);
  assert.deepEqual(patchBody(one.matched[0]), { vendor_code: 'BONAMEGA1', expected_version: 'v1' });
});

test('the Salesforce crosswalk carries a default vendor and cost on every row', () => {
  const { salesforceCrosswalk } = require('./automayt-vendor-codes');
  const prosol = new Map([['NR66261040286', { name: 'Norton disc', manufacturer: 'Norton', cost: 149.5 }], ['SS750051100', { name: 'Bona DriFast Natural', manufacturer: 'Bona', cost: 43.37 }], ['A175', { name: 'Schluter SCHIENE', manufacturer: 'Schluter', cost: 9 }]]);
  const items = [
    sf({ Name: 'Q', PBSI__Default_Vendor_Name__c: 'Treeco', Manufacturer__c: 'Norton', PBSI__Vendor_Item_ID__c: 'NR66261040286', PBSI__Cost__c: 197.4 }),
    sf({ Name: 'D', PBSI__Default_Vendor_Name__c: 'Treeco', Manufacturer__c: 'Bona', PBSI__Vendor_Item_ID__c: 'SS750051100', PBSI__Cost__c: 35.69 }),
    sf({ Name: 'M', PBSI__Default_Vendor_Name__c: 'Treeco', Manufacturer__c: 'Bona', PBSI__Vendor_Item_ID__c: 'Bona Mega ONE', PBSI__Cost__c: 119.99 }),
    sf({ Name: 'S', PBSI__Default_Vendor_Name__c: 'Cloverdale', Manufacturer__c: 'Schluter', PBSI__Vendor_Item_ID__c: 'A175', PBSI__Cost__c: 9.64 }),
    sf({ Name: 'P', PBSI__Vendor_Item_ID__c: 'FN38', PBSI__Cost__c: 11.5 }),
  ];
  const { rows, held } = salesforceCrosswalk(items, [], prosol, undefined, { preferences: BONA });
  const by = (n) => rows.find((r) => r.sf.Name === n);
  assert.deepEqual([by('Q').vendor.vendor, by('Q').vendor.cost, by('Q').vendor.switched], ['Prosol Inc.', 149.5, true]);
  assert.deepEqual([by('D').vendor.vendor, by('D').vendor.cost, by('D').vendor.switched, by('D').vendor.costStale], ['Prosol Inc.', 43.37, true, true], 'Bona goes to Prosol even when dearer');
  assert.deepEqual([by('M').vendor.vendor, by('M').vendor.rule], ['Treeco', 'no Prosol code']);
  assert.deepEqual([by('P').vendor.vendor, by('P').vendor.cost], ['Ames Tile & Stone', 11.5]);
  assert.equal(held.length, 1);
  assert.match(held[0].issue, /also a Prosol code \(Prosol: Schluter SCHIENE\); not a maker's code/);
});
