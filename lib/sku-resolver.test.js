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

test('decideExact never maps the #1388 trowel to Sechelt: the match is evidence for Mac (policy 2026-11-02)', () => {
  const d = r.decideExact({ ...TROWEL, now: new Date('2026-09-30T20:00:00Z') });
  assert.strictEqual(d.entry, undefined, 'the exact tier never returns an entry to apply');
  assert.match(d.reason, /Shopify SKU 9975 = SF item 9975/);
  assert.match(d.reason, /Sechelt has 10, needs Mac's OK/);
  // The would-be entry is kept as evidence only.
  assert.strictEqual(d.secheltMatch.entry.route_to, 'CFC_SECHELT');
  assert.strictEqual(d.secheltMatch.entry.cost_cad, 12.98);
});

test('tryExact never returns an entry, so staging can never auto-map from it', async () => {
  // ASIN short-circuit path needs no lookups.
  const d = await r.tryExact({ sku: 'B075RGTR84', itemName: 'x', qty: 1 });
  assert.strictEqual(d.entry, undefined);
  assert.ok(d.reason);
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

  const erpText = async () => null; // no ERP item to re-check a Sechelt proposal against
  const a = await r.handleStageResult(result, { now: t0, send, ai, exact, erpText, auditLog: () => {} });
  assert.strictEqual(a.proposed, 1);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /Not shipped: order 1388 needs a mapping for SKU 9975/);
  assert.match(sent[0].text, /sku-resolver\/approve\?sku=9975&t=/);
  assert.match(sent[0].text, /0 at Sechelt/);
  assert.match(sent[0].text, /Not applied automatically: Sechelt route needs Mac's OK \(policy 2026-11-02\) \(no single ERP item 9975 to check the order title against/);

  const b = await r.handleStageResult(result, { now: new Date('2026-09-30T16:00:00Z'), send, ai, exact, auditLog: () => {} });
  assert.strictEqual(b.proposed + b.reminded, 0, 'no repeat within a day');

  const c = await r.handleStageResult(result, { now: new Date('2026-10-01T13:00:00Z'), send, ai, exact, auditLog: () => {} });
  assert.strictEqual(c.reminded, 1);
  assert.match(sent[1].subject, /^STILL NOT SHIPPED/);

  r.markApplied('9975');
  const d = await r.handleStageResult(result, { now: new Date('2026-10-03T13:00:00Z'), send, ai, exact, auditLog: () => {} });
  assert.strictEqual(d.reminded, 0, 'applied SKUs go quiet');
});

test('handleStageResult: an exact Sechelt match is not applied; it goes to Opus and Mac\'s email as evidence', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; const audits = []; const asked = [];
  const out = await r.handleStageResult({
    autoMapped: [{ sku: '1234', orders: ['1500'], summary: 'stale field from an old staging build', entry: { api_sku: 'NON_PROSOL' } }],
    manualReview: [{ orderNumber: '1388', reason: 'No sku-map entry for 9975', unmappedItems: [{ sku: '9975', name: TROWEL.itemName, qty: 1 }] }],
  }, {
    now: new Date('2026-09-30T12:00:00Z'), send: async (m) => sent.push(m),
    ai: async (line) => { asked.push(line); return null; },
    exact: async (line) => r.decideExact({ ...TROWEL, ...line }), sellerSku: async () => null,
    auditLog: (a) => audits.push(a), mappings: () => ({}), apply: () => { throw new Error('must not apply'); },
  });
  assert.strictEqual(out.autoMapped, undefined, 'no exact auto-map count any more');
  assert.strictEqual(out.proposed, 1);
  assert.ok(!audits.some((a) => a.action === 'sku-resolver-auto-applied'), 'nothing auto-applied');
  assert.match(asked[0].exactReason, /Sechelt has 10, needs Mac's OK/, 'Opus sees the exact match');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Exact check: Shopify SKU 9975 = SF item 9975 .*Sechelt has 10, needs Mac's OK/);
});

// The real #1435 line, 2026-10-28: Shopify SKU PRMPSQT1, already mapped under key 08526.
const PRIMER_MAP = {
  '08526': { cost_cad: 17.52, api_sku: 'PRMPSQT1', prosol_sku: 'PRMPSQT1', product: 'Schluter PRIMER-PS Peel & Stick Membrane Primer 946ml', verified: true, brand: 'schluter' },
  PRMPS1: { cost_cad: 49.31, api_sku: 'PRMPS1', prosol_sku: 'PRMPS1', product: 'Schluter PRIMER-PS Peel & Stick Membrane Primer 3.78L (1 Gallon)', verified: true },
};
const PRIMER_TITLE = 'Schluter® PRIMER-PS Peel & Stick Primer - 1 Quart (946 mL)';
const PRIMER_PROPOSAL = { decision: 'map', confidence: 'high', route: 'prosol', api_sku: 'PRMPSQT1', prosol_sku: 'PRMPSQT1', product: 'Schluter PRIMER-PS 1 Quart', sf_item: '08526', explanation: 'Prosol item PRMPSQT1.', evidence: [] };

test('decideTwin maps the #1435 primer as a twin of 08526', () => {
  const d = r.decideTwin({ sku: 'PRMPSQT1', itemName: PRIMER_TITLE, proposal: PRIMER_PROPOSAL, mappings: PRIMER_MAP, now: new Date('2026-10-28T11:00:00Z') });
  assert.ok(d.entry, d.reason);
  assert.strictEqual(d.twinKey, '08526');
  assert.deepStrictEqual([d.entry.api_sku, d.entry.prosol_sku, d.entry.cost_cad], ['PRMPSQT1', 'PRMPSQT1', 17.52]);
  assert.strictEqual(d.entry.discovered_by, 'sku-resolver-twin');
});

test('decideTwin refuses anything short of an exact, guarded twin', () => {
  const base = { sku: 'PRMPSQT1', itemName: PRIMER_TITLE, mappings: PRIMER_MAP };
  assert.match(r.decideTwin({ ...base, proposal: { ...PRIMER_PROPOSAL, confidence: 'medium' } }).reason, /needs high/);
  assert.match(r.decideTwin({ ...base, proposal: { ...PRIMER_PROPOSAL, route: 'sechelt' } }).reason, /not a Prosol/);
  assert.match(r.decideTwin({ ...base, proposal: { ...PRIMER_PROPOSAL, prosol_sku: 'PRMPSQT1-01' } }).reason, /no verified entry/, 'both codes must match');
  assert.match(r.decideTwin({ ...base, mappings: { '08526': { ...PRIMER_MAP['08526'], verified: false } }, proposal: PRIMER_PROPOSAL }).reason, /no verified entry/);
  // Title says gallon, the twin is the quart: the guard stops it.
  assert.match(r.decideTwin({ ...base, itemName: 'Schluter PRIMER-PS Peel & Stick Primer - 1 Gallon (3.78 L)', proposal: PRIMER_PROPOSAL }).reason, /size mismatch/);
  // Same code, different product words: stopped.
  assert.match(r.decideTwin({ ...base, itemName: 'Aqua Mix Grout Haze Remover 946 mL', proposal: PRIMER_PROPOSAL }).reason, /product mismatch/);
});

test('handleStageResult auto-applies a twin with no email, in the state and the audit trail', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = [];
  const applied = [];
  const audits = [];
  const out = await r.handleStageResult({
    manualReview: [{ orderNumber: '1435', reason: 'No sku-map entry for PRMPSQT1', unmappedItems: [{ sku: 'PRMPSQT1', name: PRIMER_TITLE, qty: 1 }] }],
  }, {
    now: new Date('2026-10-28T11:00:00Z'), send: async (m) => sent.push(m), ai: async () => PRIMER_PROPOSAL,
    exact: async () => ({ reason: 'Salesforce has 0 items named PRMPSQT1' }), auditLog: (a) => audits.push(a),
    mappings: () => PRIMER_MAP, apply: (k, e) => applied.push([k, e]),
  });
  assert.strictEqual(out.twinMapped, 1);
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0][0], 'PRMPSQT1');
  assert.strictEqual(sent.length, 0, 'no FYI email');
  assert.ok(audits.some((a) => a.action === 'sku-resolver-auto-applied' && a.by === 'auto-twin' && a.sku === 'PRMPSQT1' && /08526/.test(a.summary)));
  assert.strictEqual(r.loadState().skus.PRMPSQT1.status, 'applied');
  assert.strictEqual(r.loadState().skus.PRMPSQT1.appliedBy, 'auto-twin');
});

test('handleStageResult still asks when the twin check fails, and says why', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = [];
  const applied = [];
  await r.handleStageResult({
    manualReview: [{ orderNumber: '1436', reason: 'No sku-map entry for PRMPSQT1', unmappedItems: [{ sku: 'PRMPSQT1', name: PRIMER_TITLE, qty: 1 }] }],
  }, {
    now: new Date('2026-10-28T11:00:00Z'), send: async (m) => sent.push(m), ai: async () => ({ ...PRIMER_PROPOSAL, confidence: 'medium' }),
    exact: async () => ({ reason: 'x' }), auditLog: () => {}, mappings: () => PRIMER_MAP, apply: (k, e) => applied.push([k, e]),
    prosol: async () => ({ getMappingInfo: async () => null, close: async () => {} }),
  });
  assert.strictEqual(applied.length, 0);
  assert.match(sent[0].text, /sku-resolver\/approve\?sku=PRMPSQT1/);
  assert.match(sent[0].text, /Not mapped as a twin of an existing entry: confidence medium/);
  assert.match(sent[0].text, /Not applied automatically: Prosol has no product with SKU PRMPSQT1/);
});

// The real 702-3620151-6391423 line, 2026-10-29: ASIN B07XQJNY76, seller SKU KDIF4GRKEBTD8.
const GRATE_TITLE = 'Schluter Kerdi 4 Inch Square Stainless Steel Grate - Pure Design in Brushed Nickel Finish';
const GRATE_INFO = { productId: 56568, sku: 'KDIF4GRKEBTD8', prosol_sku: 'KDIF4GRKEBTD8', name: 'Schluter - KERDI-DRAIN GRATE KIT 4" BRUSHED NICKEL PURE', cost_cad: 113.23, retail_cad: 198.64 };

test('decideSellerSku maps the grate by its seller SKU', () => {
  const d = r.decideSellerSku({ sku: 'B07XQJNY76', itemName: GRATE_TITLE, sellerSku: 'KDIF4GRKEBTD8', info: GRATE_INFO, now: new Date('2026-10-29T17:00:00Z') });
  assert.ok(d.entry, d.reason);
  assert.deepStrictEqual([d.entry.api_sku, d.entry.prosol_sku, d.entry.cost_cad, d.entry.seller_sku], ['KDIF4GRKEBTD8', 'KDIF4GRKEBTD8', 113.23, 'KDIF4GRKEBTD8']);
  assert.strictEqual(d.entry.discovered_by, 'sku-resolver-seller-sku');
});

test('decideSellerSku keeps api_sku and prosol_sku apart (Aqua Mix)', () => {
  const d = r.decideSellerSku({ sku: 'B000UOJGME', itemName: "Aqua Mix Sealer's Choice Gold Grout Sealant 946 ml", sellerSku: 'C030882-4',
    info: { productId: 17821, sku: 'C030882-4', prosol_sku: 'C030882-01', name: 'Aqua Mix - Grout Sealant Sealer’s Choice Gold 946 ml', cost_cad: 48.15 } });
  assert.ok(d.entry, d.reason);
  assert.deepStrictEqual([d.entry.api_sku, d.entry.prosol_sku], ['C030882-4', 'C030882-01']);
});

test('decideSellerSku refuses anything short of an exact, guarded, costed match', () => {
  const base = { sku: 'B07XQJNY76', itemName: GRATE_TITLE, sellerSku: 'KDIF4GRKEBTD8' };
  assert.match(r.decideSellerSku({ ...base, sellerSku: null, info: GRATE_INFO }).reason, /no seller SKU/);
  assert.match(r.decideSellerSku({ ...base, info: null }).reason, /no product/);
  assert.match(r.decideSellerSku({ ...base, info: { ambiguous: true, count: 2 } }).reason, /2 products/);
  assert.match(r.decideSellerSku({ ...base, info: { ...GRATE_INFO, sku: 'KDIF4GRKEBD6' } }).reason, /answered/);
  assert.match(r.decideSellerSku({ ...base, info: { ...GRATE_INFO, prosol_sku: null } }).reason, /no vendor code/);
  assert.match(r.decideSellerSku({ ...base, info: { ...GRATE_INFO, cost_cad: null } }).reason, /no cost/);
  // Seller SKU points at a different product than the buyer ordered: the guard stops it.
  assert.match(r.decideSellerSku({ ...base, info: { ...GRATE_INFO, name: 'Schluter - PRIMER-PS PEEL&STICK PRIMER 1 QT (946ML)' } }).reason, /mismatch/);
});

test('sellerSkuFor reads the SellerSKU for the ASIN from Amazon order items', async () => {
  const calls = [];
  const sp = { getOrderItems: async (o) => { calls.push(o); return { payload: { OrderItems: [{ ASIN: 'B000OTHER1', SellerSKU: 'X' }, { ASIN: 'B07XQJNY76', SellerSKU: 'KDIF4GRKEBTD8' }] } }; } };
  assert.strictEqual(await r.sellerSkuFor({ sku: 'B07XQJNY76', orders: ['1435', '702-3620151-6391423'] }, sp), 'KDIF4GRKEBTD8');
  assert.deepStrictEqual(calls, ['702-3620151-6391423'], 'Shopify order numbers are skipped');
  assert.strictEqual(await r.sellerSkuFor({ sku: 'PRMPSQT1', orders: ['702-3620151-6391423'] }, sp), null, 'only ASIN lines');
});

test('handleStageResult maps an ASIN by seller SKU before asking Opus', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; const applied = []; const audits = []; let aiCalls = 0; let closed = 0;
  const out = await r.handleStageResult({
    manualReview: [{ orderNumber: '702-3620151-6391423', reason: 'No sku-map entry for B07XQJNY76', unmappedItems: [{ sku: 'B07XQJNY76', name: GRATE_TITLE, qty: 1 }] }],
  }, {
    now: new Date('2026-10-29T17:00:00Z'), send: async (m) => sent.push(m), ai: async () => { aiCalls++; return null; },
    exact: async () => ({ reason: 'ASIN' }), auditLog: (a) => audits.push(a), mappings: () => ({}), apply: (k, e) => applied.push([k, e]),
    sellerSku: async () => 'KDIF4GRKEBTD8',
    prosol: async () => ({ getMappingInfo: async () => GRATE_INFO, close: async () => { closed++; } }),
  });
  assert.strictEqual(out.sellerSkuMapped, 1);
  assert.strictEqual(aiCalls, 0, 'no Opus call needed');
  assert.strictEqual(applied[0][0], 'B07XQJNY76');
  assert.strictEqual(applied[0][1].prosol_sku, 'KDIF4GRKEBTD8');
  assert.strictEqual(sent.length, 0, 'no FYI email');
  assert.ok(audits.some((a) => a.action === 'sku-resolver-auto-applied' && a.by === 'auto-seller-sku' && a.sku === 'B07XQJNY76'));
  assert.strictEqual(r.loadState().skus.B07XQJNY76.appliedBy, 'auto-seller-sku');
  assert.strictEqual(closed, 1, 'Prosol session closed');
});

test('handleStageResult hands the seller SKU and a Prosol lookup to Opus when the match fails', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; let seen = null; let lookup = null;
  await r.handleStageResult({
    manualReview: [{ orderNumber: '702-3620151-6391423', reason: 'No sku-map entry for B07XQJNY76', unmappedItems: [{ sku: 'B07XQJNY76', name: GRATE_TITLE, qty: 1 }] }],
  }, {
    now: new Date('2026-10-29T17:00:00Z'), send: async (m) => sent.push(m),
    ai: async (line, opts) => { seen = line; lookup = opts && opts.prosolLookup; return null; },
    exact: async () => ({ reason: 'ASIN' }), auditLog: () => {}, mappings: () => ({}), apply: () => { throw new Error('must not apply'); },
    sellerSku: async () => 'KDIF4GRKEBTD8',
    prosol: async () => ({ getMappingInfo: async () => null, close: async () => {} }),
  });
  assert.strictEqual(seen.sellerSku, 'KDIF4GRKEBTD8');
  assert.match(seen.sellerSkuReason, /no product/);
  assert.strictEqual(typeof lookup, 'function');
  assert.match(sent[0].text, /Seller SKU check \(KDIF4GRKEBTD8\): Prosol has no product/);
});

// ── ERP_BACKEND=automayt: no Salesforce from the resolver ──────────────────

function stubModule(rel, exports) {
  const p = require.resolve(rel);
  const prev = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

test('tryExact: unset ERP_BACKEND still proves the item in Salesforce', async () => {
  delete process.env.ERP_BACKEND;
  const soql = [];
  const restoreSf = stubModule('./salesforce', { connect: async () => ({}), query: async (c, q) => { soql.push(q); return [{ Name: '9975', PBSI__description__c: 'Trowel', PBSI__Cost__c: 12.98 }]; } });
  const restoreShop = stubModule('./shopify-graphql', { graphql: async () => ({ data: { productVariants: { nodes: [] } } }) });
  try {
    const res = await r.tryExact({ sku: '9975', itemName: TROWEL.itemName, qty: 1 });
    assert.strictEqual(soql.length, 1);
    assert.match(soql[0], /FROM PBSI__PBSI_Item__c WHERE Name = '9975'/);
    assert.match(res.reason, /Shopify has 0 variants/);
  } finally { restoreSf(); restoreShop(); }
});

test('tryExact: ERP_BACKEND=automayt proves the item in Automayt by item number, never Salesforce', async () => {
  process.env.ERP_BACKEND = 'automayt';
  const realErp = require('./automayt-erp');
  const lookups = [];
  const restoreSf = stubModule('./salesforce', { connect: async () => { throw new Error('Salesforce must not be called'); } });
  const restoreErp = stubModule('./automayt-erp', {
    ...realErp,
    resolveItems: async (entries) => {
      lookups.push(...entries);
      return new Map(entries.map((e) => [e.key, e.itemNumbers
        ? { status: 'matched', candidates: [{
          id: 'it-9975', item_number: '9975', vendor_code: '85P51G', description: 'Custom Building Products - Premium Notch Trowels - Medium',
          active: true, stock_status: 'Special Order', stocking_unit: 'each', retail_price: '24.9900',
          default_vendor: { id: 'ven-prosol', name: 'Prosol Inc.', account_number: 'V-1001' },
          cost: { real_cost: '12.9800', real_cost_source: 'vendor_cost', landed_cost: '0.0000', vendor_cost: '12.9800' },
        }] }
        : { status: 'not_found', candidates: [] }]));
    },
  });
  const restoreShop = stubModule('./shopify-graphql', { graphql: async () => ({ data: { productVariants: { nodes: [{
    sku: '9975', title: 'Medium - 1/4" x 3/8" x 1/4"', product: { title: 'Custom Building Products - Premium Notch Trowels' },
    inventoryItem: { inventoryLevels: { nodes: [{ location: { name: 'Sechelt Warehouse' }, quantities: [{ quantity: 10 }] }] } },
  }] } } }) });
  try {
    const res = await r.tryExact({ sku: '9975', itemName: TROWEL.itemName, qty: 1 });
    assert.strictEqual(res.entry, undefined, 'never an entry: Sechelt needs Mac (2026-11-02)');
    assert.match(res.reason, /Shopify SKU 9975 = Automayt item 9975 .*Sechelt has 10, needs Mac's OK/);
    assert.strictEqual(res.secheltMatch.entry.cost_cad, 12.98);
    assert.match(res.secheltMatch.entry.note, /Shopify SKU 9975 = Automayt item 9975/);
    assert.ok(lookups.some((e) => e.itemNumbers && e.itemNumbers[0] === '9975'));
  } finally { delete process.env.ERP_BACKEND; restoreSf(); restoreErp(); restoreShop(); }
});

function fakeClient(script) {
  const calls = [];
  return { calls, beta: { messages: { create: async (params) => { calls.push(JSON.parse(JSON.stringify(params))); return script(calls.length); } } } };
}
const submit = (id) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'submit_proposal', input: { decision: 'cannot_resolve' } }] });

test('proposeWithAi: unset ERP_BACKEND offers the Salesforce search tool as before', async () => {
  delete process.env.ERP_BACKEND;
  const client = fakeClient(() => submit('s1'));
  await r.proposeWithAi({ sku: 'X1', itemName: 'thing', qty: 1, orders: ['1'] }, { client });
  assert.ok(client.calls[0].tools.some((t) => t.name === 'salesforce_item_search'));
  assert.doesNotMatch(client.calls[0].system, /Salesforce is retired/);
});

test('proposeWithAi: ERP_BACKEND=automayt drops the Salesforce tool and refuses a call to it', async () => {
  process.env.ERP_BACKEND = 'automayt';
  const restoreSf = stubModule('./salesforce', { connect: async () => { throw new Error('Salesforce must not be called'); } });
  try {
    const client = fakeClient((n) => (n === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'salesforce_item_search', input: { text: 'X1' } }] }
      : submit('s2')));
    const p = await r.proposeWithAi({ sku: 'X1', itemName: 'thing', qty: 1, orders: ['1'] }, { client });
    assert.strictEqual(p.decision, 'cannot_resolve');
    assert.ok(!client.calls[0].tools.some((t) => t.name === 'salesforce_item_search'));
    assert.match(client.calls[0].system, /Salesforce is retired/);
    const toolResult = client.calls[1].messages.at(-1).content[0];
    assert.strictEqual(toolResult.tool_use_id, 't1');
    assert.match(toolResult.content, /Salesforce is off \(ERP_BACKEND=automayt\)/);
  } finally { delete process.env.ERP_BACKEND; restoreSf(); }
});

test('proposeWithAi: ERP_BACKEND=automayt offers the Automayt item lookup in its place', async () => {
  process.env.ERP_BACKEND = 'automayt';
  try {
    const seen = [];
    const client = fakeClient((n) => (n === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a1', name: 'automayt_item_lookup', input: { code: '9975' } }] }
      : submit('s3')));
    await r.proposeWithAi({ sku: '9975', itemName: 'trowel', qty: 1, orders: ['1'] }, {
      client, automaytLookup: async (code) => { seen.push(code); return { by_vendor_code: [], by_item_number: [{ id: 'it-1', item_number: '9975' }] }; },
    });
    assert.ok(client.calls[0].tools.some((t) => t.name === 'automayt_item_lookup'));
    assert.deepStrictEqual(seen, ['9975']);
    assert.match(client.calls[1].messages.at(-1).content[0].content, /it-1/);
  } finally { delete process.env.ERP_BACKEND; }
  const sf = fakeClient(() => submit('s4'));
  await r.proposeWithAi({ sku: 'X1', itemName: 'thing', qty: 1, orders: ['1'] }, { client: sf });
  assert.ok(!sf.calls[0].tools.some((t) => t.name === 'automayt_item_lookup'), 'Salesforce mode unchanged');
});

// ── Tier 2c: Opus auto-apply ────────────────────────────────────────────────

// The real 2026-10-23 power module line: Opus said medium, Mac approved, never changed.
const RRS_TITLE = 'Schluter® DITRA-HEAT-E-RRS POWER MODULE WHITE';
const RRS_PROPOSAL = { decision: 'map', confidence: 'medium', route: 'prosol', api_sku: 'DHERR2/BW', prosol_sku: 'DHERR2/BW', product: 'Schluter DITRA-HEAT-E-RRS Power Module, White', sf_item: '', explanation: 'Prosol DHERR2/BW is the RRS power module in white.', evidence: ['prosol_lookup DHERR2/BW'] };
const RRS_INFO = { productId: 51234, sku: 'DHERR2/BW', prosol_sku: 'DHERR2/BW', name: 'Schluter - DITRA-HEAT-E-RRS POWER MODULE WHITE', cost_cad: 166.54, retail_cad: 291.99 };
const RRS_LINE = { manualReview: [{ orderNumber: '702-1111111-2222222', reason: 'No sku-map entry for DHERR2/BW', unmappedItems: [{ sku: 'DHERR2/BW', name: RRS_TITLE, qty: 1 }] }] };

test('decideAutoApply maps a medium Prosol proposal Prosol confirms, with Prosol\'s cost and an auto-applied note', () => {
  const d = r.decideAutoApply({ itemName: RRS_TITLE, proposal: RRS_PROPOSAL, info: RRS_INFO, now: new Date('2026-11-02T15:00:00Z') });
  assert.ok(d.entry, d.reason);
  assert.deepStrictEqual([d.entry.api_sku, d.entry.prosol_sku, d.entry.cost_cad, d.entry.retail_cad], ['DHERR2/BW', 'DHERR2/BW', 166.54, 291.99]);
  assert.strictEqual(d.entry.verified, true);
  assert.strictEqual(d.entry.discovered_by, 'sku-resolver-ai');
  assert.match(d.entry.note, /^Auto-applied 2026-11-02 by sku-resolver \(Opus, medium confidence; Prosol DHERR2\/BW .* passed the mapping guard\)/);
  assert.doesNotMatch(d.entry.note, /approved by Mac/);
});

test('decideAutoApply refuses low confidence, a code Prosol doesn\'t confirm, no cost, and a failed guard', () => {
  const base = { itemName: RRS_TITLE, proposal: RRS_PROPOSAL, info: RRS_INFO };
  assert.match(r.decideAutoApply({ ...base, proposal: { ...RRS_PROPOSAL, confidence: 'low' } }).reason, /confidence low/);
  assert.match(r.decideAutoApply({ ...base, info: null }).reason, /no product/);
  assert.match(r.decideAutoApply({ ...base, info: { ambiguous: true, count: 2 } }).reason, /2 products/);
  assert.match(r.decideAutoApply({ ...base, info: { ...RRS_INFO, prosol_sku: 'DHERR2BW' } }).reason, /vendor code/);
  assert.match(r.decideAutoApply({ ...base, info: { ...RRS_INFO, cost_cad: null } }).reason, /no cost/);
  // Prosol's product under that code is a different product: the guard stops it.
  assert.match(r.decideAutoApply({ ...base, info: { ...RRS_INFO, name: 'Schluter - KERDI-BAND WATERPROOFING STRIP 5M' } }).reason, /product mismatch/);
});

test('decideAutoApply never applies a Sechelt route, even when every check passes (policy 2026-11-02)', () => {
  const sech = { ...RRS_PROPOSAL, route: 'sechelt', api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL', sf_item: '4172' };
  const kf = { sku: '4172', itemName: 'Schluter KERDI-FIX Sealant 290 ml Bright White', qty: 2, proposal: sech, erpText: 'KERDI-FIX sealing and bonding compound 290ml bright white' };
  const atSechelt = (n) => [{ sku: '4172', productTitle: 'Schluter KERDI-FIX', inventory: { 'Sechelt Warehouse': n } }];
  for (const conf of ['high', 'medium']) {
    const all = r.decideAutoApply({ ...kf, proposal: { ...sech, confidence: conf }, variants: atSechelt(5) });
    assert.strictEqual(all.entry, undefined, `${conf}: no entry`);
    assert.match(all.reason, /^Sechelt route needs Mac's OK \(policy 2026-11-02\)/);
    assert.match(all.reason, /passes the mapping guard; Shopify shows 5 at Sechelt/);
  }
  // The checks still run, so the email says what Mac is approving.
  assert.match(r.decideAutoApply({ ...kf, erpText: null, variants: atSechelt(5) }).reason, /needs Mac's OK.*no single ERP item 4172/);
  assert.match(r.decideAutoApply({ ...kf, erpText: 'KERDI-FIX sealant 100ml grey', variants: atSechelt(5) }).reason, /needs Mac's OK.*size mismatch/);
  assert.match(r.decideAutoApply({ ...kf, variants: atSechelt(1) }).reason, /needs Mac's OK.*Shopify shows 1 at Sechelt, order needs 2/);
  assert.match(r.decideAutoApply({ ...kf, variants: [] }).reason, /needs Mac's OK.*Sechelt stock unproven: Shopify has 0 variants with SKU 4172/);
});

test('handleStageResult applies a confirmed proposal itself: no email, applied by opus-auto, audited', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; const applied = []; const audits = []; const looked = [];
  const out = await r.handleStageResult(RRS_LINE, {
    now: new Date('2026-11-02T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => RRS_PROPOSAL,
    exact: async () => ({ reason: 'ASIN' }), auditLog: (a) => audits.push(a), mappings: () => ({}), apply: (k, e) => applied.push([k, e]),
    prosol: async () => ({ getMappingInfo: async (c) => { looked.push(c); return RRS_INFO; }, close: async () => {} }),
  });
  assert.strictEqual(out.opusApplied, 1);
  assert.strictEqual(sent.length, 0, 'no email for an auto-applied mapping');
  assert.deepStrictEqual(looked, ['DHERR2/BW']);
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0][0], 'DHERR2/BW');
  assert.strictEqual(applied[0][1].cost_cad, 166.54);
  const rec = r.loadState().skus['DHERR2/BW'];
  assert.strictEqual(rec.status, 'applied');
  assert.strictEqual(rec.appliedBy, 'opus-auto');
  assert.ok(audits.some((a) => a.action === 'sku-resolver-auto-applied' && a.sku === 'DHERR2/BW'));
  // Next pass: applied, so quiet.
  const again = await r.handleStageResult(RRS_LINE, { now: new Date('2026-11-03T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => { throw new Error('no second ask'); }, auditLog: () => {} });
  assert.strictEqual(again.proposed + again.reminded, 0);
  assert.strictEqual(sent.length, 0);
});

test('handleStageResult emails Mac when the guard fails, and never applies', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; const applied = [];
  await r.handleStageResult(RRS_LINE, {
    now: new Date('2026-11-02T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => RRS_PROPOSAL,
    exact: async () => ({ reason: 'ASIN' }), auditLog: () => {}, mappings: () => ({}), apply: (k, e) => applied.push([k, e]),
    prosol: async () => ({ getMappingInfo: async () => ({ ...RRS_INFO, name: 'Schluter - KERDI-BAND WATERPROOFING STRIP 5M' }), close: async () => {} }),
  });
  assert.strictEqual(applied.length, 0);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /sku-resolver\/approve\?sku=DHERR2%2FBW&t=/);
  assert.match(sent[0].text, /Not applied automatically: order title vs Prosol .*product mismatch/);
  assert.strictEqual(r.loadState().skus['DHERR2/BW'].status, 'proposed');
});

test('handleStageResult emails a low-confidence proposal without re-checking it', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; let opened = 0;
  await r.handleStageResult(RRS_LINE, {
    now: new Date('2026-11-02T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => ({ ...RRS_PROPOSAL, confidence: 'low' }),
    exact: async () => ({ reason: 'ASIN' }), auditLog: () => {}, mappings: () => ({}), apply: () => { throw new Error('must not apply'); },
    sellerSku: async () => null,
    prosol: async () => { opened++; return { getMappingInfo: async () => RRS_INFO, close: async () => {} }; },
  });
  assert.strictEqual(opened, 0, 'no Prosol session for a low-confidence proposal');
  assert.match(sent[0].text, /Not applied automatically: confidence low, needs high or medium/);
});

// A Sechelt proposal ships from our own shelf: never auto-applied (Mac
// 2026-11-02, "unless i say so"). It always goes out on the approve link.
const KF_LINE = { manualReview: [{ orderNumber: '1510', reason: 'No sku-map entry for 4172', unmappedItems: [{ sku: '4172', name: 'Schluter KERDI-FIX Sealant 290 ml Bright White', qty: 3 }] }] };
const KF_SECHELT = { decision: 'map', confidence: 'high', route: 'sechelt', api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL', product: 'Schluter KERDI-FIX Bright White 290ml', sf_item: '4172', explanation: 'Shopify SKU 4172 is our own stock at Sechelt.', evidence: [] };
const kfVariants = (n) => async () => [{ sku: '4172', productTitle: 'Schluter KERDI-FIX', variantTitle: 'Bright White', inventory: { 'Sechelt Warehouse': n } }];

test('handleStageResult emails a Sechelt proposal even when Sechelt covers the quantity, and never applies it', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = []; const asked = []; const audits = [];
  const out = await r.handleStageResult(KF_LINE, {
    now: new Date('2026-11-02T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => KF_SECHELT,
    exact: async () => ({ reason: 'x' }), auditLog: (a) => audits.push(a), mappings: () => ({}), apply: () => { throw new Error('must not apply'); },
    erpText: async (code) => { asked.push(code); return 'KERDI-FIX sealing and bonding compound 290ml bright white'; },
    variantsFor: kfVariants(3),
  });
  assert.ok(!out.opusApplied, 'nothing auto-applied');
  assert.ok(!audits.some((a) => a.action === 'sku-resolver-auto-applied'));
  assert.deepStrictEqual(asked, ['4172']);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /sku-resolver\/approve\?sku=4172&t=/);
  assert.match(sent[0].text, /Not applied automatically: Sechelt route needs Mac's OK \(policy 2026-11-02\).*Shopify shows 3 at Sechelt/);
  const rec = r.loadState().skus['4172'];
  assert.strictEqual(rec.status, 'proposed');
});

test('the approve link still applies a Sechelt entry: Mac\'s one tap', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = [];
  await r.handleStageResult(KF_LINE, {
    now: new Date('2026-11-02T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => KF_SECHELT,
    exact: async () => ({ reason: 'x' }), auditLog: () => {}, mappings: () => ({}), apply: () => { throw new Error('must not apply'); },
    erpText: async () => 'KERDI-FIX sealing and bonding compound 290ml bright white', variantsFor: kfVariants(3),
  });
  const t = /sku-resolver\/approve\?sku=4172&t=([0-9a-f]+)/.exec(sent[0].text)[1];
  // What server.js POST /sku-resolver/approve does: verifyApprove, liveAddMapping(rec.entry), markApplied.
  const rec = r.verifyApprove('4172', t);
  assert.ok(rec, 'the emailed token verifies');
  assert.strictEqual(rec.entry.route_to, 'CFC_SECHELT');
  assert.strictEqual(rec.entry.api_sku, 'NON_PROSOL');
  assert.match(rec.entry.note, /approved by Mac/);
  assert.strictEqual(r.verifyApprove('4172', t.replace(/^./, (c) => (c === '0' ? '1' : '0'))), null, 'a tampered token does not');
  r.markApplied('4172');
  assert.strictEqual(r.loadState().skus['4172'].status, 'applied');
});

test('handleStageResult emails Mac when Sechelt can\'t cover the quantity, and never applies', async () => {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  const sent = [];
  await r.handleStageResult(KF_LINE, {
    now: new Date('2026-11-02T15:00:00Z'), send: async (m) => sent.push(m), ai: async () => KF_SECHELT,
    exact: async () => ({ reason: 'x' }), auditLog: () => {}, mappings: () => ({}), apply: () => { throw new Error('must not apply'); },
    erpText: async () => 'KERDI-FIX sealing and bonding compound 290ml bright white',
    variantsFor: kfVariants(2),
  });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /sku-resolver\/approve\?sku=4172&t=/);
  assert.match(sent[0].text, /Not applied automatically: Sechelt route needs Mac's OK .*Shopify shows 2 at Sechelt, order needs 3\)\./);
  const rec = r.loadState().skus['4172'];
  assert.strictEqual(rec.status, 'proposed');
  assert.match(rec.autoReason, /Shopify shows 2 at Sechelt, order needs 3/);
});
