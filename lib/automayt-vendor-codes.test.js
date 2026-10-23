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
  assert.deepEqual(rows.find((r) => r.sf.Name === 'C'), { sf: items[2], beta1: [], code: '', source: 'none', clearBarcode: '' });
  assert.equal(rows.find((r) => r.sf.Name === 'D').clearBarcode, 'D-9');
});

test('items that are not PRD items, or already carry a code, are left alone', () => {
  const r = matchVendorCodes([item({ item_number: 'ROTEST-1' }), item({ vendor_code: 'X1' })], [sf()], []);
  assert.deepEqual(one(r), { matched: 0, held: 0, unmatched: 0, skipped: 2 });
});
