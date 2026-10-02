'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apps = require('./trade-applications');
const { approveAccount, codeFor, e164 } = require('./trade-accounts');

const SAME_LINE = `You received a new message from your online store's contact form.
Country Code: CA
Form: ProZone application (Coast)
Name: Sam Tiler
Email: Sam@Example.ca
Phone: 604-555-1234
Business name: Sam's Tile & Stone Ltd
Town: Lower Sunshine Coast
GST/HST number: 123456789RT0001
OK to send ProZone offers: Yes`;

const NEXT_LINE = `Form:
ProZone application (Coast)
Name:
Jo Lee
Business name:
Coastline Floors
Town:
Powell River
GST/HST number:

`;

test('parseApplication: label and value on one line', () => {
  const a = apps.parseApplication(SAME_LINE);
  assert.strictEqual(a.email, 'sam@example.ca');
  assert.strictEqual(a.firstName, 'Sam');
  assert.strictEqual(a.lastName, 'Tiler');
  assert.strictEqual(a.business, "Sam's Tile & Stone Ltd");
  assert.strictEqual(a.area, 'Lower Sunshine Coast');
  assert.strictEqual(a.gst, '123456789RT0001');
  assert.strictEqual(a.optIn, true);
  assert.ok(apps.isProZoneApplication(SAME_LINE));
});

test('parseApplication: value on the next line; email from Reply-To; blank GST stays blank', () => {
  const a = apps.parseApplication(NEXT_LINE, 'jo@coastline.ca');
  assert.strictEqual(a.email, 'jo@coastline.ca');
  assert.strictEqual(a.business, 'Coastline Floors');
  assert.strictEqual(a.area, 'Powell River');
  assert.strictEqual(a.gst, '');
  assert.strictEqual(a.optIn, false);
});

test('tokens: verify only the signed id', () => {
  const id = apps.idFor('sam@example.ca');
  const t = apps.token(id, 'shh');
  assert.ok(apps.verify(id, t, 'shh'));
  assert.ok(!apps.verify(id, t, 'other'));
  assert.ok(!apps.verify(apps.idFor('x@y.ca'), t, 'shh'));
  assert.ok(!apps.verify(id, '', 'shh'));
  assert.strictEqual(apps.token(id, ''), null);
});

test('recordApplication: one record per email, repeats never reset an approval', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pz-')), 'state.json');
  const a = apps.parseApplication(SAME_LINE);
  const r1 = apps.recordApplication(a, { state: apps.loadState(file), file });
  assert.ok(r1.isNew);
  apps.setStatus(r1.rec.id, { status: 'approved' }, { file });
  const r2 = apps.recordApplication({ ...a, phone: '604-555-9999' }, { state: apps.loadState(file), file });
  assert.ok(!r2.isNew);
  assert.strictEqual(r2.rec.status, 'approved');
  assert.strictEqual(r2.rec.app.phone, '604-555-9999');
});

test('emails: plain, no em dashes, client code only when codes are live', () => {
  const a = apps.parseApplication(SAME_LINE);
  const w = apps.welcomeEmail(a, { code: 'PRO-SAMSTILE' }, { clientCodesLive: false });
  assert.doesNotMatch(w.text, /PRO-SAMSTILE/);
  assert.match(w.text, /20% off accessories on orders up to \$1,000/);
  assert.match(w.text, /25% off accessories on orders over \$1,000/);
  assert.match(w.text, /10% off trims and profiles/);
  assert.match(w.text, /Sechelt Warehouse or Powell River/);
  assert.match(w.text, /\nYourFloors$/);
  const w2 = apps.welcomeEmail(a, { code: 'PRO-SAMSTILE' }, { clientCodesLive: true });
  assert.match(w2.text, /Your client code is PRO-SAMSTILE/);
  const m = apps.macEmail({ id: 'pz-1', app: a });
  for (const t of [w.text, w2.text, m.html, m.subject]) assert.doesNotMatch(t, /—/);
  assert.match(m.subject, /^ProZone application \(Coast\): Sam's Tile & Stone Ltd \(Lower Sunshine Coast\)/);
  assert.match(m.html, /from the Coast page/);
  assert.match(m.html, /20%\/25% on accessories, 10% trims/);
});

const NATIONAL = `You received a new message from your online store's contact form.

Country Code: CA
Form: ProZone application
Name: Dana Prairie
Business Name: Prairie Tile Co
Email: dana@prairietile.ca
Phone: 403-555-0100
Province: AB
Gst/Hst Number: 715756839RT0001
Website Or Licence: prairietile.ca
Ok To Send Pro Zone Offers: Yes`;

test('national application: detected from the form name, province and website parsed', () => {
  const a = apps.parseApplication(NATIONAL);
  assert.strictEqual(a.national, true);
  assert.strictEqual(a.province, 'AB');
  assert.strictEqual(a.website, 'prairietile.ca');
  assert.strictEqual(a.area, '');
  assert.strictEqual(apps.programName(a), 'national');
  assert.strictEqual(apps.parseApplication(SAME_LINE).national, false);
  assert.strictEqual(apps.programName(apps.parseApplication(SAME_LINE)), 'Coast');
  // no form line at all: a province with no town reads as national, a town as Coast
  assert.strictEqual(apps.isNational({ province: 'ON' }), true);
  assert.strictEqual(apps.isNational({ area: 'Powell River' }), false);
});

test('national emails: 10% on accessories, trade counters, never the Coast', () => {
  const a = apps.parseApplication(NATIONAL);
  const w = apps.welcomeEmail(a, { code: 'PRO-PRAIRIE' }, { clientCodesLive: true });
  assert.match(w.text, /Hi Dana,/);
  assert.match(w.text, /10% off accessories/);
  assert.match(w.text, /trade counter near you/);
  assert.match(w.text, /Your client code is PRO-PRAIRIE/);
  assert.match(w.text, /\nYourFloors$/);
  for (const bad of [/Sechelt/, /Powell River/, /Coast/, /ferr/i, /Prosol/, /20%/, /25%/, /—/]) assert.doesNotMatch(w.text, bad);
  const m = apps.macEmail({ id: 'pz-2', app: a });
  assert.match(m.subject, /^ProZone application \(national\): Prairie Tile Co \(AB\)/);
  assert.match(m.html, /national page/);
  assert.match(m.html, /10% on accessories/);
  assert.match(m.html, /prairietile\.ca/);
  assert.doesNotMatch(m.html, /—/);
});

test('approveAccount: a national applicant gets the 10% only, local false, their province', async () => {
  const { gql, calls } = fakeShopify();
  const r = await approveAccount(apps.parseApplication(NATIONAL), { gql });
  assert.deepStrictEqual(r.discountsAdded, ['ProZone 10%']);
  const mf = calls.find((c) => c.q.includes('metafieldsSet')).v.m;
  assert.strictEqual(mf.find((f) => f.key === 'local').value, 'false');
  assert.strictEqual(mf.find((f) => f.key === 'province').value, 'AB');
  assert.strictEqual(mf.find((f) => f.key === 'business').value, 'Prairie Tile Co');
});

test('codeFor / e164', () => {
  assert.strictEqual(codeFor("Sam's Tile & Stone Ltd"), 'PRO-SAMSTILE');
  assert.strictEqual(codeFor('Zeitner Construction'), 'PRO-ZEITNER');
  assert.strictEqual(e164('604-555-1234'), '+16045551234');
  assert.strictEqual(e164('12'), '');
});

function fakeShopify({ customer = null, codesTaken = [] } = {}) {
  const calls = [];
  const disc = (title, id) => ({ id, discount: { __typename: 'DiscountAutomaticBasic', title, status: 'ACTIVE', context: { customers: [] } } });
  const gql = async (q, v) => {
    calls.push({ q, v });
    if (q.includes('discountNodes')) return { data: { discountNodes: { nodes: [
      disc('ProZone 10%', 'a1'), disc('ProZone Coast 20%', 'a2'), disc('ProZone Coast 25%', 'a3'),
      { id: 'c1', discount: { __typename: 'DiscountCodeBasic', title: 'ProZone client', status: 'ACTIVE', codes: { nodes: [] } } },
    ] } } };
    if (q.includes('customers(')) return { data: { customers: { nodes: customer ? [customer] : [] } } };
    if (q.includes('customerCreate')) return { data: { customerCreate: { customer: { id: 'gid://shopify/Customer/9' }, userErrors: [] } } };
    if (q.includes('codeDiscountNodeByCode')) return { data: { codeDiscountNodeByCode: codesTaken.includes(v.c) ? { id: 'x' } : null } };
    if (q.includes('metafieldsSet')) return { data: { metafieldsSet: { userErrors: [] } } };
    if (q.includes('discountAutomaticBasicUpdate')) return { data: { discountAutomaticBasicUpdate: { userErrors: [] } } };
    if (q.includes('discountRedeemCodeBulkAdd')) return { data: { discountRedeemCodeBulkAdd: { bulkCreation: { id: 'b' }, userErrors: [] } } };
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  };
  return { gql, calls };
}

test('approveAccount: new applicant gets a customer, metafields, 3 discounts and a free code', async () => {
  const { gql, calls } = fakeShopify({ codesTaken: ['PRO-SAMSTILE'] });
  const r = await approveAccount(apps.parseApplication(SAME_LINE), { gql, now: new Date('2026-10-02T17:00:00Z') });
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.code, 'PRO-SAMSTILE-2');
  assert.deepStrictEqual(r.discountsAdded, ['ProZone 10%', 'ProZone Coast 20%', 'ProZone Coast 25%']);
  assert.ok(r.codeAdded);
  const create = calls.find((c) => c.q.includes('customerCreate'));
  assert.strictEqual(create.v.i.phone, '+16045551234');
  assert.ok(!('emailMarketingConsent' in create.v.i));
});

test('approveAccount: an existing approved customer keeps their code and nothing is re-added', async () => {
  const customer = { id: 'gid://shopify/Customer/5', email: 'sam@example.ca', metafields: { nodes: [{ key: 'code', value: 'PRO-SAM' }, { key: 'approved_at', value: '2026-10-01T00:00:00Z' }] } };
  const { gql, calls } = fakeShopify({ customer });
  const r = await approveAccount(apps.parseApplication(SAME_LINE), { gql });
  assert.strictEqual(r.created, false);
  assert.strictEqual(r.code, 'PRO-SAM');
  assert.ok(!calls.some((c) => c.q.includes('customerCreate')));
});

test('approveAccount: refuses a bad email or no business', async () => {
  const { gql } = fakeShopify();
  await assert.rejects(approveAccount({ email: 'nope', business: 'X' }, { gql }), /bad email/);
  await assert.rejects(approveAccount({ email: 'a@b.ca', business: '' }, { gql }), /business/);
});

const { parseGst, luhnOk, gstValid, nameMatch, verifyBusiness } = require('./trade-verify');

// The real email from Mac's 2026-10-02 test (Shopify title-cases labels and splits "ProZone").
const MAC_TEST = "You received a new message from your online store's contact form.\n\nCountry Code: CA\nForm: ProZone application (Coast)\nName: Macgregor Roy\nBusiness Name: joe floors\nEmail: mac.roy.co@gmail.com\nPhone: 16042120275\nTown: Lower Sunshine Coast\nGst/Hst Number: 000\nOk To Send Pro Zone Offers: Yes";

test('parseApplication: Shopify title-cased labels, including the offers checkbox', () => {
  const a = apps.parseApplication(MAC_TEST);
  assert.strictEqual(a.business, 'joe floors');
  assert.strictEqual(a.gst, '000');
  assert.strictEqual(a.optIn, true);
  assert.strictEqual(a.area, 'Lower Sunshine Coast');
});

test('GST: format and CRA check digit', () => {
  assert.deepStrictEqual(parseGst('896557238 RT 0001'), { bn9: '896557238', gst: '896557238RT0001' });
  assert.ok(luhnOk('896557238'));   // SC Custom Flooring Centres
  assert.ok(luhnOk('715756839'));   // Automayt Technologies
  assert.ok(gstValid('715756839RT0001'));
  assert.ok(!gstValid('000'));
  assert.ok(!gstValid('000000000RT0001'));
  assert.ok(!gstValid('123456789RT0001'));
  assert.ok(!gstValid('896557238'));
});

test('nameMatch ignores Ltd/Inc and punctuation', () => {
  assert.ok(nameMatch("Sam's Tile & Stone Ltd.", 'SAMS TILE AND STONE LIMITED') >= 0.6);
  assert.ok(nameMatch('Joe Floors', 'Coastline Tile') < 0.6);
});

const orgbookStub = (byQuery) => async (url) => {
  const q = decodeURIComponent(/q=([^&]+)/.exec(url)[1]);
  return { ok: true, json: async () => ({ results: byQuery[q] || [] }) };
};
const ent = (name, bn9, status = 'ACT', type = 'BC') => ({ source_id: 'X1', names: [{ text: name }, ...(bn9 ? [{ text: bn9 }] : [])], attributes: [{ type: 'entity_status', value: status }, { type: 'entity_type', value: type }, { type: 'registration_date', value: '2018-04-01T00:00:00Z' }] });

test('verifyBusiness: levels', async () => {
  assert.strictEqual((await verifyBusiness({ gst: '000', business: 'joe floors' })).level, 'invalid');
  const v = await verifyBusiness({ gst: '715756839RT0001', business: 'Automayt' }, { fetchImpl: orgbookStub({ '715756839': [ent('AUTOMAYT TECHNOLOGIES INC.', '715756839')] }) });
  assert.strictEqual(v.level, 'verified');
  assert.match(v.summary, /AUTOMAYT TECHNOLOGIES INC\./);
  const gone = await verifyBusiness({ gst: '715756839RT0001', business: 'x' }, { fetchImpl: orgbookStub({ '715756839': [ent('OLD CO LTD.', '715756839', 'HIS')] }) });
  assert.strictEqual(gone.level, 'inactive');
  const sp = await verifyBusiness({ gst: '896557238RT0001', business: "Sam's Tile" }, { fetchImpl: orgbookStub({ "Sam's Tile": [ent("SAM'S TILE", null, 'ACT', 'SP')] }) });
  assert.strictEqual(sp.level, 'name_found');
  assert.strictEqual((await verifyBusiness({ gst: '896557238RT0001', business: 'Nobody' }, { fetchImpl: orgbookStub({}) })).level, 'number_only');
  assert.strictEqual((await verifyBusiness({ gst: '896557238RT0001', business: 'x' }, { fetchImpl: async () => { throw new Error('down'); } })).level, 'lookup_failed');
});
