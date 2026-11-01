const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';

const shopifySf = require('./shopify-sf');
const amazonPo = require('./amazon-po');
const audit = require('./audit');
const erpBackend = require('./erp-backend');

const audited = [];
audit.log = (entry) => audited.push(entry);

const ORDERS_PATH = path.join(__dirname, 'automayt-orders.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(prev)) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

test('default backend is Salesforce, result untouched, Automayt never loaded', async () => {
  const sfResult = { soNumber: 'SO-025900', poNumber: 'PO-17100', errors: [] };
  let calls = 0;
  shopifySf.createShopifySoPo = async () => { calls++; return sfResult; };
  await withEnv({ ERP_BACKEND: null }, async () => {
    const r = await erpBackend.createShopifySoPo({ shopifyOrder: { orderNumber: '#1' } });
    assert.equal(r, sfResult);
    assert.equal('automaytShadow' in r, false);
  });
  assert.equal(calls, 1);
  assert.equal(require.cache[ORDERS_PATH], undefined, 'automayt-orders must not load on the default path');
});

test('an unknown ERP_BACKEND fails loudly instead of guessing', async () => {
  await withEnv({ ERP_BACKEND: 'automate' }, async () => {
    await assert.rejects(erpBackend.createShopifySoPo({}), /ERP_BACKEND="automate"/);
  });
});

test('shadow: a failing mirror is reported, never thrown into the Salesforce result', async () => {
  const sfResult = { soNumber: 'SO-025901', poNumber: 'PO-17101', errors: [] };
  shopifySf.createShopifySoPo = async () => sfResult;
  const orders = require('./automayt-orders');
  orders.createShopifySoPo = async () => { throw new Error('Automayt down'); };
  await withEnv({ ERP_BACKEND: 'automayt-shadow' }, async () => {
    const r = await erpBackend.createShopifySoPo({ shopifyOrder: { orderNumber: '#2' } });
    assert.equal(r.soNumber, 'SO-025901');
    assert.equal(r.automaytShadow.ok, false);
    assert.match(r.automaytShadow.error, /Automayt down/);
  });
  assert.ok(audited.some((e) => e.type === 'automayt-shadow' && e.ref === '#2' && e.ok === false));
});

test('shadow: a hung mirror is abandoned at the timeout', async () => {
  shopifySf.createShopifySoPo = async () => ({ soNumber: 'SO-025902', errors: [] });
  require('./automayt-orders').createShopifySoPo = () => new Promise(() => {});
  await withEnv({ ERP_BACKEND: 'automayt-shadow', AUTOMAYT_SHADOW_TIMEOUT_MS: '40' }, async () => {
    const t0 = Date.now();
    const r = await erpBackend.createShopifySoPo({ shopifyOrder: { orderNumber: '#3' } });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(r.soNumber, 'SO-025902');
    assert.match(r.automaytShadow.error, /timed out/);
  });
});

test('shadow: a Salesforce failure propagates and nothing is mirrored', async () => {
  let mirrored = 0;
  shopifySf.createShopifySoPo = async () => { throw new Error('SF login failed'); };
  require('./automayt-orders').createShopifySoPo = async () => { mirrored++; return {}; };
  await withEnv({ ERP_BACKEND: 'automayt-shadow' }, async () => {
    await assert.rejects(erpBackend.createShopifySoPo({ shopifyOrder: { orderNumber: '#4' } }), /SF login failed/);
  });
  assert.equal(mirrored, 0);
});

test('shadow: a successful mirror carries its numbers', async () => {
  shopifySf.createShopifySoPo = async () => ({ soNumber: 'SO-025903', poNumber: 'PO-17103', errors: [] });
  require('./automayt-orders').createShopifySoPo = async () => ({ soNumber: 'SO-0090', poNumber: 'PO-0300', errors: [] });
  await withEnv({ ERP_BACKEND: 'automayt-shadow' }, async () => {
    const r = await erpBackend.createShopifySoPo({ shopifyOrder: { orderNumber: '#5' } });
    assert.deepEqual({ ok: r.automaytShadow.ok, so: r.automaytShadow.soNumber, po: r.automaytShadow.poNumber }, { ok: true, so: 'SO-0090', po: 'PO-0300' });
    assert.equal(r.poNumber, 'PO-17103');
  });
});

test('automayt backend skips Salesforce entirely', async () => {
  let sfCalls = 0;
  shopifySf.createShopifySoPo = async () => { sfCalls++; return {}; };
  require('./automayt-orders').createShopifySoPo = async () => ({ soNumber: 'SO-0091', errors: [] });
  await withEnv({ ERP_BACKEND: 'automayt' }, async () => {
    const r = await erpBackend.createShopifySoPo({ shopifyOrder: { orderNumber: '#6' } });
    assert.equal(r.soNumber, 'SO-0091');
  });
  assert.equal(sfCalls, 0);
});

test('shadow Amazon: one ShipStation fetch shared by both backends', async () => {
  let fetches = 0;
  const shipped = { shipments: [{ trackingNumber: 'T1' }], unresolved: [] };
  amazonPo.fetchShippedOrdersForPO = async () => { fetches++; return shipped; };
  let sfSaw = null;
  let amSaw = null;
  amazonPo.createAmazonPOs = async (args) => { sfSaw = args.prefetched; return { orders: [], errors: [], soNames: ['SO-023500'] }; };
  require('./automayt-orders').createAmazonPOs = async (args) => { amSaw = args.prefetched; return { orders: [{ poNumber: 'PO-0301', status: 'created' }], errors: [], soNames: ['SO-0092'] }; };
  await withEnv({ ERP_BACKEND: 'automayt-shadow' }, async () => {
    const r = await erpBackend.createAmazonPOs({ days: 2 });
    assert.equal(r.automaytShadow.ok, true);
    assert.equal(r.automaytShadow.poNumber, 'PO-0301');
  });
  assert.equal(fetches, 1);
  assert.equal(sfSaw, shipped);
  assert.equal(amSaw, shipped);
});

test('FBA: default calls the Salesforce creator it is handed; shadow skips a skipped SF PO', async () => {
  let sf = 0;
  const sfCreate = async () => { sf++; return { skipped: true, reason: 'no SF vendor' }; };
  let mirrored = 0;
  require('./automayt-orders').createFbaPO = async () => { mirrored++; return {}; };
  await withEnv({ ERP_BACKEND: null }, () => erpBackend.createFbaPO({ vendor: 'sechelt', draft: { draftId: 'd' }, lines: [] }, sfCreate));
  await withEnv({ ERP_BACKEND: 'automayt-shadow' }, () => erpBackend.createFbaPO({ vendor: 'sechelt', draft: { draftId: 'd' }, lines: [] }, sfCreate));
  assert.equal(sf, 2);
  assert.equal(mirrored, 0);
});
