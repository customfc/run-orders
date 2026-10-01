'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-resolver-'));
process.env.SKU_RESOLVER_STATE_FILE = path.join(tmp, 'state.json');
process.env.SKU_RESOLVER_SECRET = 'test-secret';
const r = require('./sku-resolver');

// The real #1388 line, 2026-09-30.
const TROWEL = {
  sku: '9975',
  itemName: 'Custom Building Products - Premium Notch Trowels - Medium - 1/4" x 3/8" x 1/4"',
  qty: 1,
  variants: [{ sku: '9975', productTitle: 'Custom Building Products - Premium Notch Trowels', variantTitle: 'Medium - 1/4" x 3/8" x 1/4"', inventory: { 'Sechelt Warehouse': 10, 'Powell River Showroom & Warehouse': 0 } }],
  sfItems: [{ Name: '9975', PBSI__description__c: 'Custom Building Products - Premium Notch Trowels - Medium', PBSI__Cost__c: 12.98, PBSI__Vendor_Item_ID__c: '85-P51G', vendorName: 'Prosol Inc.' }],
};

test('decideExact maps the #1388 trowel to Sechelt', () => {
  const d = r.decideExact({ ...TROWEL, now: new Date('2026-09-30T20:00:00Z') });
  assert.ok(d.entry, d.reason);
  assert.strictEqual(d.entry.api_sku, 'NON_PROSOL');
  assert.strictEqual(d.entry.prosol_sku, 'NON_PROSOL');
  assert.strictEqual(d.entry.route_to, 'CFC_SECHELT');
  assert.strictEqual(d.entry.shipstation_warehouse_id, 147654);
  assert.strictEqual(d.entry.cost_cad, 12.98);
  assert.strictEqual(d.entry.product, 'Custom Building Products - Premium Notch Trowels - Medium - 1/4" x 3/8" x 1/4"');
  assert.match(d.entry.note, /SF item 9975/);
});

test('decideExact refuses without a single exact Shopify variant', () => {
  assert.ok(r.decideExact({ ...TROWEL, variants: [] }).reason);
  assert.ok(r.decideExact({ ...TROWEL, variants: [...TROWEL.variants, { ...TROWEL.variants[0] }] }).reason);
  assert.ok(r.decideExact({ ...TROWEL, variants: [{ ...TROWEL.variants[0], sku: '99750' }] }).reason, 'near-match SKU is not a match');
});

test('decideExact refuses without a single SF item of the same Name', () => {
  assert.ok(r.decideExact({ ...TROWEL, sfItems: [] }).reason);
  assert.ok(r.decideExact({ ...TROWEL, sfItems: [{ ...TROWEL.sfItems[0], Name: '9976' }] }).reason);
});

test('decideExact refuses when Sechelt cannot cover the quantity', () => {
  const d = r.decideExact({ ...TROWEL, qty: 11 });
  assert.match(d.reason, /10 at Sechelt/);
  const none = r.decideExact({ ...TROWEL, variants: [{ ...TROWEL.variants[0], inventory: {} }] });
  assert.match(none.reason, /0 at Sechelt/);
});

test('decideExact refuses when the order title is a different product', () => {
  const d = r.decideExact({ ...TROWEL, itemName: 'Mapei Ultracolor Plus FA Grout 10 lb' });
  assert.match(d.reason, /shares no product word/);
});

test('decideExact never identity-matches an ASIN', () => {
  assert.match(r.decideExact({ ...TROWEL, sku: 'B075RGTR84' }).reason, /ASIN/);
});

test('entryFromProposal builds Sechelt and Prosol entries and rejects the rest', () => {
  const base = { decision: 'map', confidence: 'high', product: 'X', sf_item: '', explanation: 'because', evidence: [] };
  const sech = r.entryFromProposal({ ...base, route: 'sechelt', api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL' });
  assert.strictEqual(sech.route_to, 'CFC_SECHELT');
  assert.strictEqual(sech.discovered_by, 'sku-resolver-ai');
  const pro = r.entryFromProposal({ ...base, route: 'prosol', api_sku: 'C100978-4', prosol_sku: 'C100978-01' });
  assert.deepStrictEqual([pro.api_sku, pro.prosol_sku], ['C100978-4', 'C100978-01']);
  assert.strictEqual(r.entryFromProposal({ ...base, route: 'prosol', api_sku: 'C100978-4', prosol_sku: '' }), null, 'no vendor code, no entry');
  assert.strictEqual(r.entryFromProposal({ ...base, decision: 'cannot_resolve', route: 'none', api_sku: '', prosol_sku: '' }), null);
  assert.strictEqual(r.entryFromProposal(null), null);
});

test('collectUnmapped aggregates by SKU and keeps the Prosol candidates', () => {
  const lines = r.collectUnmapped([
    { orderNumber: '1388', reason: 'No sku-map entry for 9975 (Trowel)\n\nProsol candidates for "Trowel":\n  1. Trowel A', unmappedItems: [{ sku: '9975', name: 'Trowel', qty: 1 }] },
    { orderNumber: '1401', reason: 'No sku-map entry for 9975 (Trowel)', unmappedItems: [{ sku: '9975', name: 'Trowel', qty: 2 }] },
    { orderNumber: '1402', reason: 'Large order held for review' },
  ]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].qty, 3);
  assert.deepStrictEqual(lines[0].orders, ['1388', '1401']);
  assert.match(lines[0].prosolCandidates, /Trowel A/);
});

test('approve token verifies only for the exact stored entry', () => {
  const entry = { api_sku: 'NON_PROSOL', route_to: 'CFC_SECHELT' };
  const t = r.approveToken('9975', entry);
  const state = { skus: { 9975: { entry, orders: ['1388'] } } };
  assert.ok(r.verifyApprove('9975', t, state));
  assert.strictEqual(r.verifyApprove('9975', t.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), state), null);
  assert.strictEqual(r.verifyApprove('9975', r.approveToken('9975', { ...entry, route_to: 'X' }), state), null, 'token is bound to the entry');
  assert.strictEqual(r.verifyApprove('9976', t, state), null);
});

test('handleStageResult proposes once, then reminds only after a day', async () => {
  const sent = [];
  const send = async (m) => { sent.push(m); };
  const ai = async () => ({ decision: 'map', confidence: 'high', route: 'sechelt', api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL', product: 'Trowel', sf_item: '9975', explanation: 'Shopify SKU equals SF item 9975.', evidence: ['sku:9975'] });
  const exact = async () => ({ reason: 'Shopify shows 0 at Sechelt, order needs 1' });
  const result = { manualReview: [{ orderNumber: '1388', reason: 'No sku-map entry for 9975', unmappedItems: [{ sku: '9975', name: 'Trowel', qty: 1 }] }] };
  const t0 = new Date('2026-09-30T12:00:00Z');

  const a = await r.handleStageResult(result, { now: t0, send, ai, exact, auditLog: () => {} });
  assert.strictEqual(a.proposed, 1);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /Not shipped: order 1388 needs a mapping for SKU 9975/);
  assert.match(sent[0].text, /sku-resolver\/approve\?sku=9975&t=/);
  assert.match(sent[0].text, /0 at Sechelt/);

  const b = await r.handleStageResult(result, { now: new Date('2026-09-30T16:00:00Z'), send, ai, exact, auditLog: () => {} });
  assert.strictEqual(b.proposed + b.reminded, 0, 'no repeat within a day');

  const c = await r.handleStageResult(result, { now: new Date('2026-10-01T13:00:00Z'), send, ai, exact, auditLog: () => {} });
  assert.strictEqual(c.reminded, 1);
  assert.match(sent[1].subject, /^STILL NOT SHIPPED/);

  r.markApplied('9975');
  const d = await r.handleStageResult(result, { now: new Date('2026-10-03T13:00:00Z'), send, ai, exact, auditLog: () => {} });
  assert.strictEqual(d.reminded, 0, 'applied SKUs go quiet');
});

test('handleStageResult emails auto-maps and still emails when the AI has nothing', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = [];
  const out = await r.handleStageResult({
    autoMapped: [{ sku: '1234', orders: ['1500'], summary: 'Thing: Shopify SKU = SF item 1234, 4 at Sechelt' }],
    manualReview: [{ orderNumber: '1501', reason: 'No sku-map entry for B0XXXXXXXX', unmappedItems: [{ sku: 'B0XXXXXXXX', name: 'Mystery', qty: 1 }] }],
  }, { now: new Date('2026-09-30T12:00:00Z'), send: async (m) => sent.push(m), ai: async () => null, exact: async () => ({ reason: 'ASIN' }), auditLog: () => {} });
  assert.strictEqual(out.autoMappedEmailed, 1);
  assert.strictEqual(out.proposed, 1);
  assert.match(sent[0].subject, /Auto-mapped SKU 1234 to Sechelt/);
  assert.match(sent[1].text, /needs a mapping by hand/);
});
