'use strict';
// ERP_BACKEND=automayt switches Salesforce off: the Salesforce-only paths outside
// the SO/PO writes stand down, and every other value keeps them exactly as today.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

delete process.env.ERP_BACKEND;

// Fake Salesforce that fails loudly when reached, so "still uses Salesforce"
// and "never touches Salesforce" are both visible.
const sfPath = require.resolve('./salesforce');
let sfConnects = 0;
require.cache[sfPath] = {
  id: sfPath, filename: sfPath, loaded: true,
  exports: { connect: async () => { sfConnects++; throw new Error('salesforce reached'); }, query: async () => [] },
};

const erpMode = require('./erp-mode');
const reconcile = require('./shopify-so-reconcile');
const telegram = require('./telegram');
const etl = require('../scripts/etl/run-all');

function withBackend(value, fn) {
  return async () => {
    if (value === undefined) delete process.env.ERP_BACKEND; else process.env.ERP_BACKEND = value;
    try { await fn(); } finally { delete process.env.ERP_BACKEND; }
  };
}

test('automaytOnly is true only for exactly "automayt" (any case, trimmed)', () => {
  const cases = [[undefined, false], ['', false], ['salesforce', false], ['automayt-shadow', false], ['automyat', false], ['automayt', true], [' Automayt ', true]];
  for (const [value, want] of cases) {
    if (value === undefined) delete process.env.ERP_BACKEND; else process.env.ERP_BACKEND = value;
    assert.equal(erpMode.automaytOnly(), want, `ERP_BACKEND=${value}`);
  }
  delete process.env.ERP_BACKEND;
});

test('SO reconcile: unset ERP_BACKEND goes to Salesforce as today', withBackend(undefined, async () => {
  sfConnects = 0;
  await assert.rejects(reconcile.reconcileShopifySOs({ live: false }), /salesforce reached/);
  assert.equal(sfConnects, 1);
}));

test('SO reconcile: automayt-shadow still goes to Salesforce', withBackend('automayt-shadow', async () => {
  sfConnects = 0;
  await assert.rejects(reconcile.reconcileShopifySOs({ live: false }), /salesforce reached/);
  assert.equal(sfConnects, 1);
}));

test('SO reconcile: ERP_BACKEND=automayt is skipped with a clear line, no Salesforce, no error', withBackend('automayt', async () => {
  sfConnects = 0;
  const events = [];
  const r = await reconcile.reconcileShopifySOs({ live: true, onProgress: (e) => events.push(e) });
  assert.equal(sfConnects, 0);
  assert.equal(r.disabled, 'ERP_BACKEND=automayt');
  assert.deepEqual([r.missing.length, r.created.length, r.errors.length], [0, 0, 0]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'status');
  assert.match(events[0].message, /^\[so-reconcile\] skipped \(ERP_BACKEND=automayt\)/);
  assert.equal(reconcile.formatReport(r), 'Shopify→SF SO reconcile skipped (ERP_BACKEND=automayt)');
}));

test('ETL: only the two Salesforce steps are flagged, and they run unless ERP_BACKEND=automayt', withBackend(undefined, async () => {
  assert.deepEqual(etl.STEPS.filter((s) => s.salesforce).map((s) => s.name), ['item-costs', 'sku-map-canonical']);
  for (const s of etl.STEPS) assert.equal(etl.skipReason(s), null);
  process.env.ERP_BACKEND = 'automayt-shadow';
  for (const s of etl.STEPS) assert.equal(etl.skipReason(s), null);
  process.env.ERP_BACKEND = 'automayt';
  assert.deepEqual(etl.STEPS.filter((s) => etl.skipReason(s)).map((s) => s.name), ['item-costs', 'sku-map-canonical']);
}));

test('ETL: under ERP_BACKEND=automayt the Salesforce steps are skipped and the summary is ok, not a page', withBackend('automayt', async () => {
  const notes = [];
  const realNotify = telegram.notify;
  const realArgv = process.argv;
  const realLog = console.log;
  telegram.notify = async (...a) => { notes.push(a); };
  process.argv = [realArgv[0], path.join(__dirname, '../scripts/etl/run-all.js'), '--only', 'item-costs,sku-map-canonical'];
  console.log = () => {};
  try {
    await etl.main();
  } finally {
    telegram.notify = realNotify; process.argv = realArgv; console.log = realLog;
  }
  assert.equal(sfConnects, 0);
  assert.equal(notes.length, 1);
  const [severity, subject, body] = notes[0];
  assert.equal(severity, 'ok');
  assert.match(subject, /all 2 step\(s\) ok/);
  assert.equal(body, '- item-costs skipped (ERP_BACKEND=automayt)\n- sku-map-canonical skipped (ERP_BACKEND=automayt)');
  assert.equal(process.exitCode, 0);
  process.exitCode = undefined;
}));
