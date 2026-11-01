'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automayt-settle-'));
process.env.SKU_RESOLVER_STATE_FILE = path.join(tmp, 'state.json');
process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';
process.env.AMAZON_PERIOD_ANCHOR = '2026-09-18';
process.env.AUTOMAYT_FBA_SALES = '0';
delete process.env.AUTOMAYT_REF_SYSTEM;
delete process.env.AUTOMAYT_REF_OVERRIDES;
delete process.env.AUTOMAYT_TEST_CODE_PREFIX;
delete process.env.ERP_BACKEND;

// The order flows read the sku-map and the cost chain through shopify-sf: give
// them a test map and a cost answer before automayt-orders loads.
const TEST_MAP = {};
let costAnswer = { cost: null, retail: null, source: null };
const sfPath = require.resolve('./shopify-sf');
const realSf = require('./shopify-sf');
require.cache[sfPath].exports = { ...realSf, loadSkuMap: () => TEST_MAP, resolveItemCost: async () => costAnswer };

const settle = require('./automayt-settle');
const resolver = require('./sku-resolver');
const orders = require('./automayt-orders');

// ── stubs ────────────────────────────────────────────────────────────────────

const KF = { id: 'it-kf', item_number: '4172', vendor_code: 'KERDIFIXBW', description: 'Schluter KERDI-FIX Sealing/Bonding Compound Bright White 290ml', stocking_unit: 'each', retail_price: '37.96', cost: { real_cost: '21.6400' }, updated_at: '2026-10-30T10:00:00Z' };
const KF_SMALL = { id: 'it-kf-100', item_number: 'KERDIFIX100BW', vendor_code: 'KERDIFIXBW', description: 'Schluter KERDI-FIX Bright White 100ml', stocking_unit: 'each', retail_price: '17.50', cost: { real_cost: '9.1000' }, updated_at: '2025-03-02T10:00:00Z' };
const SHELF = { id: 'it-shelf', item_number: 'SES3D6EB', vendor_code: 'SES3D6EB', description: 'Schluter SHELF QUADRILAT CORNER CURVE BRUSH STN STEEL', stocking_unit: 'each', retail_price: '201.61', cost: { real_cost: '114.9200' } };
const SHELF_SF = { id: 'it-shelf-sf', item_number: '13572', vendor_code: 'SES3D6EB', description: 'Schluter SHELF QUADRILAT CORNER CURVE BRUSH STN STEEL', stocking_unit: 'each', retail_price: '201.61', cost: null };
const ALL = Object.fromEntries([KF, KF_SMALL, SHELF, SHELF_SF].map((i) => [i.id, i]));

function resetMap() {
  for (const k of Object.keys(TEST_MAP)) delete TEST_MAP[k];
  Object.assign(TEST_MAP, {
    4172: { cost_cad: 21.64, retail_cad: 37.96, api_sku: 'KERDIFIX/BW', prosol_sku: 'KERDIFIX/BW', product: 'Schluter KERDI-FIX Sealing/Bonding Compound Bright White 290ml', verified: true },
    '4EN': { api_sku: '4EN-X', prosol_sku: 'SIGMA4EN', product: 'Sigma Serie 4 "Nex" 49-3/16" Push Manual Tile Cutter', verified: true },
    B07QBD5Q86: { cost_cad: 114.92, api_sku: 'SES3D6EB', prosol_sku: 'SES3D6EB', product: 'SHELF QUADRILAT CORNER CURVE BRUSH STN STEEL', verified: true },
  });
}

/** Settle deps for one test: Opus answers from `answers`, writes land in TEST_MAP. */
function stubSettle({ answers = [], items = ALL, prosolInfo = {} } = {}) {
  const calls = { ai: [], writes: [], getItem: [], prosolOpened: 0, audits: [] };
  Object.assign(settle.deps, {
    ai: async (args) => {
      calls.ai.push(args);
      const a = answers.shift();
      if (typeof a === 'function') return a(args);
      return a === undefined ? null : a;
    },
    prosol: async () => { calls.prosolOpened++; return { getMappingInfo: async (c) => prosolInfo[c] || null, close: async () => {} }; },
    prosolSearch: async () => [],
    readEntry: (k) => (TEST_MAP[k] ? { ...TEST_MAP[k] } : null),
    write: (k, e) => { calls.writes.push([k, e]); TEST_MAP[k] = e; },
    getItem: async (id) => { calls.getItem.push(id); return items[id] || null; },
    audit: (a) => calls.audits.push(a),
    now: () => new Date('2026-11-02T15:00:00Z'),
  });
  return calls;
}

function fresh() {
  fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true });
  settle._resetBudget();
  resetMap();
}

const LINE = { sku: '4172', title: 'Schluter KERDI-FIX Sealing and Bonding Compound - Bright White 290 ml', qty: 2, unitPrice: 37.96 };
const PICK_KF = { decision: 'pick', item_id: 'it-kf', confidence: 'high', reason: '290 ml at $37.96 is the 290 ml item; the other is the 100 ml tube.' };

// ── 1. twins: pick, pin, reuse ───────────────────────────────────────────────

test('pickAmbiguous: one Opus pick, guarded, pinned on the entry, remembered', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const calls = stubSettle({ answers: [PICK_KF] });
    const r = await settle.pickAmbiguous({ key: '4172', entry: TEST_MAP[4172], code: 'KERDIFIXBW', line: LINE, candidates: [KF, KF_SMALL] });
    assert.equal(r.item.id, 'it-kf');
    assert.equal(r.pinned, true);
    assert.equal(calls.ai.length, 1);
    assert.equal(calls.ai[0].submit, 'submit_pick');
    assert.deepEqual(calls.ai[0].tools, ['prosol_lookup', 'skumap_search', 'shopify_search']);
    assert.match(calls.ai[0].content, /title "Schluter KERDI-FIX .*", quantity 2, unit price paid 37\.96/);
    assert.match(calls.ai[0].content, /"id":"it-kf-100".*"stocking_unit":"each"/);
    assert.deepEqual(calls.writes.map(([k, e]) => [k, e.automayt_item_id, e.automayt_item_for, e.cost_cad]), [['4172', 'it-kf', 'KERDIFIXBW', 21.64]]);
    assert.equal(resolver.loadState().itemPicks['KERDIFIXBW|it-kf,it-kf-100'].outcome, 'picked');
    assert.ok(calls.audits.some((a) => a.action === 'automayt-twin-pinned'));

    // Same question again (another order): no second Opus call.
    const again = await settle.pickAmbiguous({ key: '4172', entry: TEST_MAP[4172], code: 'KERDIFIXBW', line: LINE, candidates: [KF_SMALL, KF] });
    assert.equal(again.item.id, 'it-kf');
    assert.equal(calls.ai.length, 1);
  } finally { delete process.env.ERP_BACKEND; }
});

test('pickAmbiguous: a pick that fails the mapping guard is not used or pinned', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const calls = stubSettle({ answers: [{ ...PICK_KF, item_id: 'it-kf-100' }] });
    const r = await settle.pickAmbiguous({ key: '4172', entry: TEST_MAP[4172], code: 'KERDIFIXBW', line: LINE, candidates: [KF, KF_SMALL] });
    assert.equal(r.item, undefined);
    assert.match(r.reason, /failed the mapping guard: size mismatch/);
    assert.equal(calls.writes.length, 0);
  } finally { delete process.env.ERP_BACKEND; }
});

test('pickAmbiguous: can\'t tell and low confidence stay stuck, and are not asked again within a day', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const calls = stubSettle({ answers: [{ decision: 'cannot_tell', item_id: '', confidence: 'low', reason: 'both are 290 ml bright white' }] });
    const r = await settle.pickAmbiguous({ key: '4172', entry: TEST_MAP[4172], code: 'KERDIFIXBW', line: LINE, candidates: [KF, KF_SMALL] });
    assert.match(r.reason, /Opus can't tell: both are 290 ml/);
    const again = await settle.pickAmbiguous({ key: '4172', entry: TEST_MAP[4172], code: 'KERDIFIXBW', line: LINE, candidates: [KF, KF_SMALL] });
    assert.match(again.reason, /can't tell/);
    assert.equal(calls.ai.length, 1, 'remembered');
    assert.equal(calls.writes.length, 0);

    fresh();
    const low = stubSettle({ answers: [{ ...PICK_KF, confidence: 'low' }] });
    const l = await settle.pickAmbiguous({ key: '4172', entry: TEST_MAP[4172], code: 'KERDIFIXBW', line: LINE, candidates: [KF, KF_SMALL] });
    assert.match(l.reason, /low confidence only/);
    assert.equal(low.writes.length, 0);
  } finally { delete process.env.ERP_BACKEND; }
});

test('pickAmbiguous: a bundle component or someone else\'s code is picked but never pinned', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const calls = stubSettle({ answers: [PICK_KF] });
    const bundle = { bundle: true, components: [{ prosol_sku: 'KERDIFIX/BW', qty: 1 }] };
    const r = await settle.pickAmbiguous({ key: 'B0BUNDLE01', entry: bundle, code: 'KERDIFIXBW', line: LINE, candidates: [KF, KF_SMALL] });
    assert.equal(r.item.id, 'it-kf');
    assert.equal(r.pinned, false);
    assert.equal(calls.writes.length, 0);
  } finally { delete process.env.ERP_BACKEND; }
});

test('pickAmbiguous: Opus calls are capped per pass', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const calls = stubSettle({ answers: Array(settle.MAX_PER_PASS + 2).fill(null) });
    const results = [];
    for (let i = 0; i < settle.MAX_PER_PASS + 2; i++) {
      results.push(await settle.pickAmbiguous({ key: `K${i}`, entry: null, code: `CODE${i}`, line: LINE, candidates: [KF, KF_SMALL] }));
    }
    assert.equal(calls.ai.length, settle.MAX_PER_PASS);
    assert.match(results.at(-1).reason, /budget for this pass is used up/);
  } finally { delete process.env.ERP_BACKEND; }
});

test('pinnedItem: a live pin wins; a gone or inactive item loses its pin; another code\'s pin is ignored', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    TEST_MAP[4172] = { ...TEST_MAP[4172], automayt_item_id: 'it-kf', automayt_item_for: 'KERDIFIXBW' };
    let calls = stubSettle();
    const codes = ['4172', 'KERDIFIX/BW'];
    assert.equal((await settle.pinnedItem({ key: '4172', entry: TEST_MAP[4172], codes })).id, 'it-kf');
    assert.equal(calls.writes.length, 0);

    assert.equal(await settle.pinnedItem({ key: '4172', entry: TEST_MAP[4172], codes: ['OTHERCODE'] }), null);
    assert.deepEqual(calls.getItem, ['it-kf'], 'a pin for another code is not even read');

    calls = stubSettle({ items: {} }); // the item was deleted
    assert.equal(await settle.pinnedItem({ key: '4172', entry: TEST_MAP[4172], codes }), null);
    assert.equal(calls.writes.length, 1);
    assert.equal('automayt_item_id' in TEST_MAP[4172], false);
    assert.equal('automayt_item_for' in TEST_MAP[4172], false);
    assert.equal(TEST_MAP[4172].cost_cad, 21.64, 'the rest of the entry is untouched');

    TEST_MAP[4172] = { ...TEST_MAP[4172], automayt_item_id: 'it-kf', automayt_item_for: 'KERDIFIXBW' };
    calls = stubSettle({ items: { 'it-kf': { ...KF, stock_status: 'Discontinued' } } });
    assert.equal(await settle.pinnedItem({ key: '4172', entry: TEST_MAP[4172], codes }), null);
    assert.equal('automayt_item_id' in TEST_MAP[4172], false);
    assert.ok(calls.audits.some((a) => a.action === 'automayt-pin-dropped' && a.why === 'is inactive'));
  } finally { delete process.env.ERP_BACKEND; }
});

// ── 3. missing cost ──────────────────────────────────────────────────────────

const CUTTER_TITLE = 'Sigma Serie 4 "Nex" 49-3/16" Push Manual Tile Cutter (4EN)';
const CUTTER_INFO = { productId: 70011, sku: '4EN', prosol_sku: 'SIGMA4EN', name: 'Sigma - Serie 4 Nex Push Manual Tile Cutter 125 cm', cost_cad: 812.4, retail_cad: 1299 };

test('fixMissingCost: Opus finds the right storefront SKU, code reads Prosol\'s cost and corrects the entry', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const calls = stubSettle({ answers: [{ decision: 'found', api_sku: '4EN', confidence: 'high', reason: 'prosol_lookup 4EN returns vendor code SIGMA4EN, the Serie 4 Nex cutter.' }], prosolInfo: { '4EN': CUTTER_INFO } });
    const r = await settle.fixMissingCost({ key: '4EN', entry: TEST_MAP['4EN'], code: 'SIGMA4EN', title: CUTTER_TITLE });
    assert.deepEqual(r, { cost: 812.4, retail: 1299, source: 'prosol-offers-loc10010' });
    assert.equal(calls.ai[0].submit, 'submit_prosol_sku');
    assert.deepEqual(calls.ai[0].tools, ['prosol_lookup', 'prosol_search', 'skumap_search']);
    assert.equal(calls.writes.length, 1);
    const [key, e] = calls.writes[0];
    assert.equal(key, '4EN');
    assert.deepEqual([e.api_sku, e.prosol_sku, e.cost_cad, e.retail_cad, e.cost_source], ['4EN', 'SIGMA4EN', 812.4, 1299, 'prosol-offers-loc10010']);
    assert.match(e.note, /Cost fixed 2026-11-02 by sku-resolver \(Opus, high confidence\): Prosol lists it as 4EN .*was api_sku 4EN-X/);
    assert.equal(resolver.loadState().costFixes['4EN|SIGMA4EN'].outcome, 'fixed');
  } finally { delete process.env.ERP_BACKEND; }
});

test('fixMissingCost: not found, another vendor code, or a failed guard leaves the entry alone and is remembered', async () => {
  process.env.ERP_BACKEND = 'automayt';
  try {
    fresh();
    let calls = stubSettle({ answers: [{ decision: 'not_found', api_sku: '', confidence: 'medium', reason: 'no Serie 4 Nex in Prosol' }] });
    let r = await settle.fixMissingCost({ key: '4EN', entry: TEST_MAP['4EN'], code: 'SIGMA4EN', title: CUTTER_TITLE });
    assert.equal(r.cost, undefined);
    assert.match(r.reason, /could not find it in Prosol/);
    r = await settle.fixMissingCost({ key: '4EN', entry: TEST_MAP['4EN'], code: 'SIGMA4EN', title: CUTTER_TITLE });
    assert.equal(calls.ai.length, 1, 'not asked again within a day');
    assert.equal(calls.writes.length, 0);

    fresh();
    calls = stubSettle({ answers: [{ decision: 'found', api_sku: '4EN', confidence: 'high', reason: 'x' }], prosolInfo: { '4EN': { ...CUTTER_INFO, prosol_sku: 'SIGMA4ENPLUS' } } });
    r = await settle.fixMissingCost({ key: '4EN', entry: TEST_MAP['4EN'], code: 'SIGMA4EN', title: CUTTER_TITLE });
    assert.match(r.reason, /vendor code for 4EN is SIGMA4ENPLUS, the item is SIGMA4EN/);
    assert.equal(calls.writes.length, 0);

    fresh();
    calls = stubSettle({ answers: [{ decision: 'found', api_sku: '4EN', confidence: 'high', reason: 'x' }], prosolInfo: { '4EN': { ...CUTTER_INFO, name: 'Sigma - Spare Scoring Wheel 22mm' } } });
    r = await settle.fixMissingCost({ key: '4EN', entry: TEST_MAP['4EN'], code: 'SIGMA4EN', title: CUTTER_TITLE });
    assert.match(r.reason, /product mismatch/);
    assert.equal(calls.writes.length, 0);
  } finally { delete process.env.ERP_BACKEND; }
});

test('askOpus: the settle tasks run through the sku-resolver loop with their own submit tool', async () => {
  const seen = [];
  const calls = [];
  const client = { beta: { messages: { create: async (p) => {
    calls.push(JSON.parse(JSON.stringify(p)));
    return calls.length === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q1', name: 'prosol_search', input: { query: 'sigma serie 4 nex' } }] }
      : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q2', name: 'submit_prosol_sku', input: { decision: 'found', api_sku: '4EN', confidence: 'high', reason: 'r' } }] };
  } } } };
  const ans = await resolver.askOpus({
    system: 's', tools: ['prosol_lookup', 'prosol_search'], submit: 'submit_prosol_sku', content: 'c', client,
    extraTools: [{ name: 'submit_prosol_sku', description: 'd', input_schema: { type: 'object', properties: {} } }],
    ctx: { prosolSearch: async (q) => { seen.push(q); return [{ apiSku: '4EN', prosolSku: 'SIGMA4EN', name: 'Sigma Serie 4' }]; } },
  });
  assert.equal(ans.api_sku, '4EN');
  assert.deepEqual(seen, ['sigma serie 4 nex']);
  assert.deepEqual(calls[0].tools.map((t) => t.name), ['prosol_lookup', 'prosol_search', 'submit_prosol_sku']);
  assert.equal(calls[0].model, resolver.MODEL);
  assert.match(calls[1].messages.at(-1).content[0].content, /SIGMA4EN/);
});

// ── Through the order flows (fake Automayt) ──────────────────────────────────

function fakeAutomayt({ lookups, routes = {} }) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'x-request-id': 'req' } });
  const base = {
    'GET /customers': () => json({ data: [{ id: 'cust-house' }] }),
    'GET /vendors': () => json({ data: [{ id: 'ven-prosol' }] }),
    'GET /locations': () => json({ data: [{ id: 'loc-afc', external_refs: [{ system: 'run-orders', external_id: 'amazon-fulfillment' }] }], has_more: false }),
    'GET /contacts': () => json({ data: [] }),
    'GET /external-refs': () => json({ data: [] }),
    'GET /sales-orders': () => json({ data: [] }),
    'GET /product-categories': () => json({ data: [{ id: 'cat-acc', name: 'Accessories' }], has_more: false }),
    'POST /purchase-orders/check-tracking': (q, body) => json({ results: body.tracking_codes.map((t) => ({ tracking_code: t, matches: [] })) }),
    'POST /items/batch-lookup': (q, body) => json({
      results: body.lookups.map((l) => {
        const k = l.vendor_code ? `vendor_code:${l.vendor_code}` : `item_number:${l.item_number}`;
        const hits = (lookups[k] || []).map((id) => ALL[id]);
        return { input: l, status: hits.length === 0 ? 'not_found' : hits.length === 1 ? 'matched' : 'ambiguous', items: hits };
      }),
    }),
    'POST /items': (q, body) => json({ id: 'it-new', item_number: body.item_number, vendor_code: body.vendor_code, description: body.description, stocking_unit: 'each', cost: { real_cost: body.cost } }, 201),
    'POST /sales-orders': (q, body) => json({ id: 'so-1', number: 'SO-025900', ...body, lines: body.lines.map((l, i) => ({ ...l, id: `sol-${i + 1}` })) }),
    'POST /purchase-orders': (q, body) => json({ id: 'po-1', number: 'PO-17100', status: body.status, ...body, lines: body.lines.map((l, i) => ({ ...l, id: `pol-${i + 1}` })) }),
    'POST /purchase-orders/po-1/receipts': () => json({ id: 'rcv-1', posted: true }),
    'GET /sales-orders/so-1': () => json({ id: 'so-1', number: 'SO-025900', invoices: [] }),
    'POST /sales-orders/so-1/invoice': () => json({ id: 'inv-1', number: 'INV-0100', status: 'draft' }),
    'POST /sales-orders/so-1/shipments': (q, body) => json({ id: 'shp-1', lines: body.lines.map((l, i) => ({ id: `shl-${i + 1}`, sales_order_line_id: l.line_id, qty: l.qty })) }),
  };
  global.fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace('/api/v1', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: p, body });
    const route = routes[`${init.method} ${p}`] || base[`${init.method} ${p}`];
    if (!route) return json({ error: { code: 'not_found', message: `${init.method} ${p}` } }, 404);
    return route(u.searchParams, body);
  };
  return calls;
}

const gst = (a) => [{ code: 'GST', amount: a }];
const kfOrder = (n) => ({
  shopifyOrder: { orderNumber: `#${n}`, createdAt: '2026-11-02T09:00:00-07:00', items: [{ id: 11, sku: '4172', title: LINE.title, quantity: 2, price: '37.96' }] },
  money: { orderNumber: `#${n}`, province: 'BC', subtotal: 75.92, shipping: 0, total: 79.72, fee: 2.5, feeUnknown: false, paidVia: ['shopify_payments'], tax: gst('3.80'), refunds: [], lines: [{ id: '11', sku: '4172', quantity: 2, total: 75.92, taxCharged: gst('3.80') }], shippingLines: [] },
});
const TWIN_LOOKUPS = { 'vendor_code:KERDIFIXBW': ['it-kf', 'it-kf-100'], 'vendor_code:SES3D6EB': ['it-shelf', 'it-shelf-sf'] };

test('Shopify flow: a same-code twin is picked and pinned, the next order uses the pin with no Opus call', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const st = stubSettle({ answers: [PICK_KF] });
    settle.deps.getItem = (id) => require('./automayt-erp').getItem(id); // the real read, against the fake
    let calls = fakeAutomayt({ lookups: TWIN_LOOKUPS, routes: { 'GET /items/it-kf': () => new Response(JSON.stringify(KF), { status: 200 }) } });
    const r = await orders.createShopifySoPo(kfOrder(1501));
    assert.deepEqual(r.errors, []);
    const so = calls.find((c) => c.method === 'POST' && c.path === '/sales-orders');
    assert.equal(so.body.lines[0].item_id, 'it-kf');
    assert.ok(r.steps.some((s) => s.step === 'auto-pick-item' && s.automaytItemId === 'it-kf' && s.pinned));
    assert.equal(TEST_MAP[4172].automayt_item_id, 'it-kf');

    fs.rmSync(process.env.SKU_RESOLVER_STATE_FILE, { force: true }); // the pin alone must carry it
    calls = fakeAutomayt({ lookups: TWIN_LOOKUPS, routes: { 'GET /items/it-kf': () => new Response(JSON.stringify(KF), { status: 200 }) } });
    const r2 = await orders.createShopifySoPo(kfOrder(1502));
    assert.deepEqual(r2.errors, []);
    assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/sales-orders').body.lines[0].item_id, 'it-kf');
    assert.equal(st.ai.length, 1, 'no second Opus call');
    assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/items/it-kf'));
  } finally { delete process.env.ERP_BACKEND; }
});

test('Shopify flow: a stale pin (item deleted) is dropped and the line resolves again', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    TEST_MAP[4172] = { ...TEST_MAP[4172], automayt_item_id: 'it-gone', automayt_item_for: 'KERDIFIXBW' };
    const st = stubSettle({ answers: [PICK_KF] });
    settle.deps.getItem = (id) => require('./automayt-erp').getItem(id);
    const calls = fakeAutomayt({ lookups: TWIN_LOOKUPS }); // GET /items/it-gone → 404
    const r = await orders.createShopifySoPo(kfOrder(1503));
    assert.deepEqual(r.errors, []);
    assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/sales-orders').body.lines[0].item_id, 'it-kf');
    assert.equal(st.writes[0][1].automayt_item_id, undefined, 'stale pin dropped first');
    assert.equal(st.writes[1][1].automayt_item_id, 'it-kf', 'then the new pick pinned');
  } finally { delete process.env.ERP_BACKEND; }
});

test('Shopify flow: can\'t tell keeps today\'s error, with Opus\'s reason', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    stubSettle({ answers: [{ decision: 'cannot_tell', item_id: '', confidence: 'low', reason: 'both look like 290 ml' }] });
    fakeAutomayt({ lookups: TWIN_LOOKUPS });
    const r = await orders.createShopifySoPo(kfOrder(1504));
    assert.ok(r.errors.some((e) => /matches 2 Automayt items .* a person must pick one \(auto-pick: Opus can't tell: both look like 290 ml\)/.test(e.error)), JSON.stringify(r.errors));
  } finally { delete process.env.ERP_BACKEND; }
});

test('Salesforce and shadow modes unchanged: no Opus, no pin read, today\'s exact error', async () => {
  for (const mode of [undefined, 'salesforce', 'automayt-shadow']) {
    fresh();
    if (mode) process.env.ERP_BACKEND = mode; else delete process.env.ERP_BACKEND;
    try {
      TEST_MAP[4172] = { ...TEST_MAP[4172], automayt_item_id: 'it-kf', automayt_item_for: 'KERDIFIXBW' };
      const st = stubSettle({ answers: [PICK_KF] });
      fakeAutomayt({ lookups: TWIN_LOOKUPS });
      const r = await orders.createShopifySoPo(kfOrder(1505));
      const err = r.errors.find((e) => e.step === 'find-item');
      assert.equal(err.error, 'Item 4172: vendor code 4172 matches 2 Automayt items (4172, KERDIFIX100BW); a person must pick one');
      assert.equal(st.ai.length, 0);
      assert.equal(st.getItem.length, 0);
      assert.equal(st.writes.length, 0);

      costAnswer = { cost: null, retail: null, source: null };
      await assert.rejects(
        orders.autoCreateItem({ mfgSku: '4EN', prosolSku: 'SIGMA4EN', title: CUTTER_TITLE, vendorId: 'ven-prosol' }),
        (e) => e.message === 'no Prosol cost for SIGMA4EN (sku-map cost_cad empty, live Prosol + mirror miss) — add cost via /map',
      );
      assert.equal(st.ai.length, 0);
    } finally { delete process.env.ERP_BACKEND; }
  }
});

test('Amazon flow: an ambiguous Prosol code is picked, the PO carries the pick, the listing is pinned', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    const st = stubSettle({ answers: [{ decision: 'pick', item_id: 'it-shelf', confidence: 'medium', reason: 'Same shelf; it-shelf has the Prosol cost, the Salesforce copy has none.' }] });
    const calls = fakeAutomayt({ lookups: TWIN_LOOKUPS });
    const r = await orders.createAmazonPOs({ prefetched: { unresolved: [], shipments: [
      { orderNumber: '701-0000000-0000009', trackingNumber: 'TRK-TWIN', shipDate: '2026-10-30', items: [{ sku: 'B07QBD5Q86', name: 'Schluter SHELF Quadrilateral Corner Shelf, Curved, Brushed Stainless Steel', quantity: 1, unitPrice: 199 }] },
    ] } });
    assert.equal(r.orders[0].status, 'created', JSON.stringify(r.orders[0].errors));
    const po = calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders');
    assert.equal(po.body.lines[0].item_id, 'it-shelf');
    assert.match(st.ai[0].content, /SKU B07QBD5Q86, title "Schluter SHELF .*", quantity 1, unit price paid 199/);
    assert.equal(TEST_MAP.B07QBD5Q86.automayt_item_id, 'it-shelf');
    assert.equal(TEST_MAP.B07QBD5Q86.automayt_item_for, 'SES3D6EB');
  } finally { delete process.env.ERP_BACKEND; }
});

test('FBA flow: an ambiguous code is picked; can\'t tell keeps the error', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  try {
    stubSettle({ answers: [{ decision: 'pick', item_id: 'it-shelf', confidence: 'high', reason: 'Prosol-costed copy of the same shelf.' }] });
    let calls = fakeAutomayt({ lookups: TWIN_LOOKUPS });
    const draft = { draftId: 'draft-2026-11-02-x', createdAt: '2026-11-02T18:00:00.000Z' };
    const r = await orders.createFbaPO({ vendor: 'prosol', draft, lines: [{ asin: 'B07QBD5Q86', qty: 4, product: 'Schluter SHELF QUADRILAT CORNER CURVE BRUSH STN STEEL', vendor: 'prosol' }], bucket: 'instock' });
    assert.equal(r.created, true, JSON.stringify(r.errors));
    assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders').body.lines[0].item_id, 'it-shelf');

    fresh();
    stubSettle({ answers: [{ decision: 'cannot_tell', item_id: '', confidence: 'low', reason: 'two shelves, no price to compare' }] });
    calls = fakeAutomayt({ lookups: TWIN_LOOKUPS });
    const r2 = await orders.createFbaPO({ vendor: 'prosol', draft, lines: [{ asin: 'B07QBD5Q86', qty: 4, product: 'Schluter SHELF QUADRILAT CORNER CURVE BRUSH STN STEEL', vendor: 'prosol' }], bucket: 'instock' });
    assert.equal(r2.created, false);
    assert.match(r2.errors[0], /SES3D6EB \(B07QBD5Q86\): vendor code SES3D6EB matches 2 Automayt items .*\(auto-pick: Opus can't tell: two shelves/);
  } finally { delete process.env.ERP_BACKEND; }
});

test('Shopify flow: a missing cost is found in Prosol, the entry corrected, the item created at Prosol\'s cost', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  costAnswer = { cost: null, retail: null, source: null };
  try {
    const st = stubSettle({ answers: [{ decision: 'found', api_sku: '4EN', confidence: 'high', reason: 'prosol_lookup 4EN = SIGMA4EN' }], prosolInfo: { '4EN': CUTTER_INFO } });
    const calls = fakeAutomayt({ lookups: {} });
    const r = await orders.createShopifySoPo({
      shopifyOrder: { orderNumber: '#1506', createdAt: '2026-11-02T09:00:00-07:00', items: [{ id: 21, sku: '4EN', title: CUTTER_TITLE, quantity: 1, price: '1299.00' }] },
      money: { orderNumber: '#1506', province: 'BC', subtotal: 1299, shipping: 0, total: 1363.95, fee: 38, feeUnknown: false, paidVia: ['shopify_payments'], tax: gst('64.95'), refunds: [], lines: [{ id: '21', sku: '4EN', quantity: 1, total: 1299, taxCharged: gst('64.95') }], shippingLines: [] },
    });
    assert.deepEqual(r.errors, []);
    const item = calls.find((c) => c.method === 'POST' && c.path === '/items');
    assert.equal(item.body.cost, '812.4');
    assert.equal(item.body.vendor_code, 'SIGMA4EN');
    assert.equal(TEST_MAP['4EN'].api_sku, '4EN');
    assert.equal(TEST_MAP['4EN'].cost_cad, 812.4);
    assert.equal(st.ai.length, 1);
  } finally { delete process.env.ERP_BACKEND; }
});

test('Shopify flow: a cost Opus cannot find still refuses the item, as today', async () => {
  fresh();
  process.env.ERP_BACKEND = 'automayt';
  costAnswer = { cost: null, retail: null, source: null };
  try {
    const st = stubSettle({ answers: [{ decision: 'not_found', api_sku: '', confidence: 'high', reason: 'Prosol has no Serie 4 Nex' }] });
    const calls = fakeAutomayt({ lookups: {} });
    const r = await orders.createShopifySoPo({
      shopifyOrder: { orderNumber: '#1507', createdAt: '2026-11-02T09:00:00-07:00', items: [{ id: 21, sku: '4EN', title: CUTTER_TITLE, quantity: 1, price: '1299.00' }] },
      money: { orderNumber: '#1507', province: 'BC', subtotal: 1299, shipping: 0, total: 1363.95, fee: 38, feeUnknown: false, paidVia: ['shopify_payments'], tax: gst('64.95'), refunds: [], lines: [{ id: '21', sku: '4EN', quantity: 1, total: 1299, taxCharged: gst('64.95') }], shippingLines: [] },
    });
    assert.ok(r.errors.some((e) => /no Prosol cost for SIGMA4EN .* add cost via \/map \(auto-fix: Opus could not find it in Prosol: Prosol has no Serie 4 Nex\)/.test(e.error)), JSON.stringify(r.errors));
    assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/items'), false);
    assert.equal(st.writes.length, 0);
    assert.equal(TEST_MAP['4EN'].api_sku, '4EN-X');
  } finally { delete process.env.ERP_BACKEND; }
});

test('state: the stage resolver\'s save keeps the settle sections written meanwhile', async () => {
  fresh();
  resolver.updateState((s) => { s.itemPicks = { 'X|a,b': { outcome: 'picked', itemId: 'a' } }; });
  await resolver.handleStageResult({ manualReview: [] }, { send: async () => {}, auditLog: () => {} });
  assert.equal(resolver.loadState().itemPicks['X|a,b'].itemId, 'a');
});
