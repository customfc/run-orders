'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ensurePo } = require('./pickup-io');

const order = { orderNumber: '1500' };
const ssf = (createResult) => ({
  fetchShopifyOrder: async () => order,
  createShopifySoPo: async () => { if (createResult instanceof Error) throw createResult; return createResult; },
});
const noSf = { connect: async () => { throw new Error('Salesforce must not be called'); }, query: async () => { throw new Error('Salesforce must not be called'); } };
const withEnv = async (value, fn) => {
  const prev = process.env.ERP_BACKEND;
  if (value == null) delete process.env.ERP_BACKEND; else process.env.ERP_BACKEND = value;
  try { await fn(); } finally { if (prev == null) delete process.env.ERP_BACKEND; else process.env.ERP_BACKEND = prev; }
};

test('automayt: creates through the switch, never Salesforce', () => withEnv('automayt', async () => {
  let seen = null;
  const erp = { createShopifySoPo: async (args) => { seen = args; return { poNumber: 'PO-18001' }; } };
  const po = await ensurePo('#1500', ssf(new Error('shopify-sf create must not be called')), noSf, erp);
  assert.strictEqual(po, 'PO-18001');
  assert.strictEqual(seen.shopifyOrder, order);
}));

test('automayt: existing SO returns its PO from existingCandidates', () => withEnv('automayt', async () => {
  const erp = { createShopifySoPo: async () => ({ skipped: true, skipReason: 'SO SO-028004 exists', existingCandidates: ['PO-18002', 'SO-028004'] }) };
  assert.strictEqual(await ensurePo('#1500', ssf({}), noSf, erp), 'PO-18002');
}));

test('automayt: existing SO without a PO throws (retried next tick)', () => withEnv('automayt', async () => {
  const erp = { createShopifySoPo: async () => ({ skipped: true, skipReason: 'SO SO-028004 exists', existingCandidates: ['SO-028004'] }) };
  await assert.rejects(ensurePo('#1500', ssf({}), noSf, erp), /has no Prosol PO/);
}));

test('automayt: a failed create throws with its errors', () => withEnv('automayt', async () => {
  const erp = { createShopifySoPo: async () => ({ errors: [{ error: 'Item not found' }] }) };
  await assert.rejects(ensurePo('#1500', ssf({}), noSf, erp), /Item not found/);
}));

test('salesforce (unset): unchanged path, erp backend not used', () => withEnv(null, async () => {
  const erp = { createShopifySoPo: async () => { throw new Error('switch must not be called in Salesforce mode'); } };
  assert.strictEqual(await ensurePo('#1500', ssf({ poNumber: 'PO-16999' }), noSf, erp), 'PO-16999');
}));
