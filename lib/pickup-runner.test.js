'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PICKUP_SECRET = 'test-secret';
const R = require('./pickup-runner');
const branches = R.loadBranches();

const line = (o) => ({ id: `gid://shopify/LineItem/${o.n || 1}`, sku: o.sku || '4172', name: o.name || 'KERDI-FIX', quantity: o.q || 1, current: o.q || 1, unfulfilled: o.q || 1, pickupMode: o.mode || 'ok' });
const order = (o = {}) => ({
  id: 'gid://shopify/Order/9', name: o.name || '#1450', paidAt: o.paidAt || '2026-10-05T17:00:00Z', cancelledAt: o.cancelledAt || null,
  financial: 'PAID', fulfillment: o.fulfillment || 'UNFULFILLED', email: 'sam@example.ca', firstName: 'Sam', lastName: 'Tiler',
  ship: o.ship || { provinceCode: 'AB', zip: 'T2P 1B3', city: 'Calgary' },
  shippingLines: { nodes: [{ title: o.title || 'Pickup at our Calgary South trade counter' }] }, customAttributes: [],
  lines: o.lines || [line({})],
  fulfillmentOrders: [{ id: 'gid://shopify/FulfillmentOrder/7', status: 'OPEN', methodType: 'SHIPPING', lines: [] }],
});
const keys = (p) => p.actions.map((a) => a.key);

test('classify: counter, Coast, split, ordinary shipping', () => {
  assert.deepStrictEqual(R.classify(order(), branches), { kind: 'branch', branch: 'WCAS' });
  assert.deepStrictEqual(R.classify(order({ title: 'Pickup at our Sechelt warehouse' }), branches), { kind: 'coast', location: 'sechelt' });
  assert.deepStrictEqual(R.classify(order({ title: 'Pickup at our Powell River showroom' }), branches), { kind: 'coast', location: 'powell_river' });
  assert.deepStrictEqual(R.classify(order({ title: 'Shipping', lines: [line({ mode: 'only', sku: 'J60AE', name: 'JOLLY' }), line({ n: 2, mode: null })] }), branches), { kind: 'split' });
  assert.deepStrictEqual(R.classify(order({ title: 'Standard' }), branches), { kind: null });
});

test('branch: NEW sends the PO email (customer pickup, branch cc) and branch_ordered, then waits', () => {
  const p = R.plan({ order: order(), rec: { kind: 'branch', branch: 'WCAS', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches });
  assert.deepStrictEqual(keys(p), ['#1450:branch_po', '#1450:branch_ordered']);
  const po = p.actions[0];
  assert.match(po.email.subject, /CUSTOMER PICKUP \(will call\) at Calgary South/);
  assert.match(po.email.body, /Customer: Sam Tiler/);
  assert.doesNotMatch(po.email.body, /sam@example\.ca|T2P/);
  assert.strictEqual(po.cc, 'order.calgary@prosol.ca');
  const msg = R.renderCustomer(p.actions[1]);
  assert.match(msg.text, /our Calgary South trade counter/);
  assert.match(msg.text, /photo ID/);
  assert.deepStrictEqual(p.patch.status, 'PO_SENT');
});

test('branch: no ready reply after 3 business days asks Mac with one-tap links; a ready tap emails the customer', () => {
  const rec = { kind: 'branch', branch: 'WCAS', status: 'PO_SENT', poSentAt: '2026-10-05T17:00:00Z', done: {} };
  assert.deepStrictEqual(keys(R.plan({ order: order(), rec, now: '2026-10-07T17:00:00Z', branches })), []);
  const p = R.plan({ order: order(), rec, now: '2026-10-09T18:00:00Z', branches });
  assert.deepStrictEqual(keys(p), ['#1450:mac_check']);
  assert.match(p.actions[0].html, /\/pickup\/ready\?o=%231450&t=[0-9a-f]{32}/);
  const r2 = R.plan({ order: order(), rec: { ...rec, readyAt: '2026-10-08T17:00:00Z' }, now: '2026-10-08T17:05:00Z', branches });
  assert.deepStrictEqual(keys(r2), ['#1450:ready']);
  assert.strictEqual(r2.patch.status, 'READY');
});

test('branch: reminders at 3 and 7 business days after ready; picked up fulfills and thanks', () => {
  const rec = { kind: 'branch', branch: 'WCAS', status: 'READY', readyAt: '2026-10-05T17:00:00Z', done: {} };
  assert.deepStrictEqual(keys(R.plan({ order: order(), rec, now: '2026-10-09T17:00:00Z', branches })), ['#1450:reminder_1']);
  const p = R.plan({ order: order(), rec: { ...rec, pickedUpAt: '2026-10-09T18:00:00Z' }, now: '2026-10-09T18:00:00Z', branches });
  assert.deepStrictEqual(keys(p), ['#1450:fulfill', '#1450:picked_up']);
  const f = R.plan({ order: order({ fulfillment: 'FULFILLED' }), rec, now: '2026-10-09T18:00:00Z', branches });
  assert.deepStrictEqual(keys(f), ['#1450:picked_up'], 'staff fulfilled it in Shopify: just the thank-you');
});

test('coast: ordering_in at once; Coast copy, no distributor', () => {
  const p = R.plan({ order: order({ title: 'Pickup at our Sechelt warehouse', ship: { provinceCode: 'BC', zip: 'V0N 3A0' } }), rec: { kind: 'coast', location: 'sechelt', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches });
  assert.deepStrictEqual(p.actions.map((a) => a.message), ['ordering_in']);
  const msg = R.renderCustomer(p.actions[0]);
  assert.doesNotMatch(msg.text, /prosol/i);
});

test('split: asks the customer with counters in their province + refund; refund or no answer refunds the trims', () => {
  const o = order({ title: 'Shipping', lines: [line({ mode: 'only', sku: 'J60AE', name: 'Schluter JOLLY', q: 2 }), line({ n: 2, mode: null, name: 'Bona cleaner' })] });
  const p = R.plan({ order: o, rec: { kind: 'split', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches });
  assert.deepStrictEqual(keys(p), ['#1450:split_choice']);
  const ch = p.actions[0].ctx.choices.map((c) => c.code);
  assert.deepStrictEqual(ch.sort(), ['EDMN', 'WCAS']);
  assert.match(p.actions[0].ctx.refundUrl, /^https:\/\/www\.yourfloors\.ca\/pages\/trim-pickup\?o=1450&c=REFUND/);
  assert.match(R.renderCustomer(p.actions[0]).text, /we'll refund the trims/);
  assert.strictEqual(p.patch.deadline, '2026-10-13', '5 business days, Thanksgiving skipped');
  const r = R.plan({ order: o, rec: { kind: 'split', status: 'ASKED', deadline: '2026-10-13', choice: 'REFUND', done: {} }, now: '2026-10-06T17:00:00Z', branches });
  assert.deepStrictEqual(keys(r), ['#1450:refund_trims']);
  assert.deepStrictEqual(r.actions[0].lines.map((l) => [l.quantity, l.name]), [[2, 'Schluter JOLLY']]);
  const late = R.plan({ order: o, rec: { kind: 'split', status: 'ASKED', deadline: '2026-10-13', done: {} }, now: '2026-10-14T17:00:00Z', branches });
  assert.deepStrictEqual(keys(late), ['#1450:refund_trims']);
  assert.strictEqual(late.actions[0].reason, 'no_answer');
});

test('split: a Coast address is offered Sechelt and Powell River first', () => {
  const o = order({ title: 'Shipping', ship: { provinceCode: 'BC', zip: 'V0N 1V0' }, lines: [line({ mode: 'only' }), line({ n: 2, mode: null })] });
  const p = R.plan({ order: o, rec: { kind: 'split', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches });
  assert.deepStrictEqual(p.actions[0].ctx.choices.slice(0, 2).map((c) => c.code), ['SECH', 'PRIV']);
});

test('cancelled after the PO went: Mac is told to release it at the branch', () => {
  const p = R.plan({ order: order({ cancelledAt: '2026-10-06T00:00:00Z' }), rec: { kind: 'branch', branch: 'WCAS', status: 'PO_SENT', done: {} }, now: '2026-10-06T17:00:00Z', branches });
  assert.deepStrictEqual(keys(p), ['#1450:cancel_branch']);
});

test('run: SHADOW performs nothing and lists the day; live performs once (idempotent)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const file = path.join(dir, 'state.json');
  const sent = [];
  const raw = { id: 'gid://shopify/Order/9', name: '#1450', createdAt: '2026-10-05T17:00:00Z', processedAt: '2026-10-05T17:00:00Z', cancelledAt: null,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', email: 'sam@example.ca', customer: { firstName: 'Sam', lastName: 'Tiler', email: 'sam@example.ca' },
    shippingAddress: { firstName: 'Sam', lastName: 'Tiler', city: 'Calgary', provinceCode: 'AB', zip: 'T2P 1B3' },
    shippingLines: { nodes: [{ title: 'Pickup at our Calgary South trade counter' }] }, customAttributes: [],
    lineItems: { nodes: [{ id: 'L1', sku: '4172', name: 'KERDI-FIX', quantity: 1, currentQuantity: 1, unfulfilledQuantity: 1, variant: { product: { productType: 'Sealant', metafield: { value: 'ok' } } } }] },
    fulfillmentOrders: { nodes: [{ id: 'F1', status: 'OPEN', deliveryMethod: { methodType: 'SHIPPING' }, lineItems: { nodes: [] } }] } };
  const calls = { stock: 0, po: 0 };
  const io = { gql: async () => ({ data: { orders: { pageInfo: { hasNextPage: false }, nodes: [raw] } } }), sendEmail: async (m) => sent.push(m), fulfill: async () => {}, refundTrims: async () => ({ amount: 1 }),
    branchStock: async (lines, code) => { calls.stock++; return { [code]: Object.fromEntries(lines.map((l) => [l.prosolSku, 5])) }; }, ensurePo: async () => { calls.po++; return 'PO-16001'; } };
  io.gql = ((g) => async (q, v) => (await g(q, v)).data)(io.gql);
  const now = new Date('2026-10-05T17:05:00Z');
  const s1 = await R.run({ io, now, file, m: 'shadow' });
  assert.deepStrictEqual(s1.performed, []);
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(calls, { stock: 0, po: 0 }, 'SHADOW never checks stock or makes a PO');
  const st = R.loadState(file);
  assert.strictEqual(st.shadow['2026-10-05'].length, 2);
  assert.ok(R.shadowDigest(st, '2026-10-05').html.includes('CUSTOMER PICKUP'));
  const s2 = await R.run({ io, now, file, m: 'all' });
  assert.deepStrictEqual(s2.performed, ['#1450:branch_po', '#1450:branch_ordered']);
  assert.strictEqual(sent[0].to, 'klazzarotto@prosol.ca');
  assert.match(sent[0].cc, /order\.calgary@prosol\.ca/);
  assert.match(sent[0].subject, /order #1450, PO PO-16001$/);
  assert.match(sent[0].text, /Our PO: PO-16001/);
  assert.strictEqual(sent[1].to, 'sam@example.ca');
  assert.strictEqual(R.loadState(file).orders['#1450'].status, 'PO_SENT');
  assert.strictEqual(R.loadState(file).orders['#1450'].poNumber, 'PO-16001');
  const s3 = await R.run({ io, now, file, m: 'all' });
  assert.deepStrictEqual(s3.performed, []);
  assert.deepStrictEqual(calls, { stock: 1, po: 1 }, 'one stock check and one PO, never again once sent');
});

// #1405 (2026-10-02): the branch email went out with no PO, the Mapei code instead of Prosol's, and no stock check
// although Regina had none. Live counter pickups now wait for the stock check and our PO.
const regina = (o = {}) => order({ name: '#1405', title: 'Pickup at our Regina trade counter', ship: { provinceCode: 'SK', zip: 'S4N 5A3', city: 'Regina' }, lines: [line({ sku: '5LA004252', name: 'UltraCare Grout Refresh Mocha' })], ...o });
const facts = (stockMap, poNumber = 'PO-16001') => {
  const lines = [{ sku: '5LA004252', ...R.prosolCodes('5LA004252'), quantity: 1 }];
  return { lines, stock: require('./branch-pickup').checkStock(lines, 'REGI', stockMap), poNumber };
};

test('branch: the PO email carries our PO number and Prosol\'s own code, not the Mapei SKU', () => {
  assert.deepStrictEqual(R.prosolCodes('5LA004252'), { apiSku: '5LA004252', prosolSku: '943854221' });
  const p = R.plan({ order: regina(), rec: { kind: 'branch', branch: 'REGI', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches, facts: facts({ REGI: { 943854221: 2 } }) });
  assert.deepStrictEqual(keys(p), ['#1405:branch_po', '#1405:branch_ordered']);
  assert.match(p.actions[0].email.subject, /PO PO-16001/);
  assert.match(p.actions[0].email.body, /943854221 x 1/);
  assert.doesNotMatch(p.actions[0].email.body, /5LA004252|transfer/i);
  assert.match(R.renderCustomer(p.actions[1]).text, /2 to 4 business days/);
  assert.deepStrictEqual(p.patch, { status: 'PO_SENT', poSentAt: '2026-10-05T17:05:00Z', poNumber: 'PO-16001' });
});

test('branch: short at the counter (stock elsewhere) never asks for a transfer: no PO, no emails out, Mac told where it is', () => {
  const p = R.plan({ order: regina(), rec: { kind: 'branch', branch: 'REGI', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches, facts: { ...facts({ REGI: { 943854221: 0 }, EDMS: { 943854221: 1 }, BURN: { 943854221: 3 } }), poNumber: undefined } });
  assert.deepStrictEqual(keys(p), ['#1405:stock_hold']);
  assert.match(p.actions[0].subject, /Regina doesn't have it/);
  assert.match(p.actions[0].html, /943854221 x 1: Regina has 0 \(in stock at BURN 3, EDMS 1\)/);
  assert.doesNotMatch(JSON.stringify(p), /transfer in/);
  assert.deepStrictEqual(p.patch, {});
});

test('branch: no stock anywhere sends nothing to the branch or customer, tells Mac once, stays NEW', () => {
  const p = R.plan({ order: regina(), rec: { kind: 'branch', branch: 'REGI', status: 'NEW', done: {} }, now: '2026-10-05T17:05:00Z', branches, facts: { ...facts({ REGI: { 943854221: 0 } }), poNumber: undefined } });
  assert.deepStrictEqual(keys(p), ['#1405:stock_hold']);
  assert.match(p.actions[0].html, /943854221 x 1: Regina has 0<\/li>/);
  assert.deepStrictEqual(p.patch, {});
});

test('branch: a failed stock check or PO waits quietly, then tells Mac after an hour', () => {
  const rec = { kind: 'branch', branch: 'REGI', status: 'NEW', firstSeenAt: '2026-10-05T17:00:00Z', done: {} };
  assert.deepStrictEqual(keys(R.plan({ order: regina(), rec, now: '2026-10-05T17:30:00Z', branches, facts: { error: 'Prosol down' } })), []);
  const p = R.plan({ order: regina(), rec, now: '2026-10-05T18:00:00Z', branches, facts: { error: 'Prosol down' } });
  assert.deepStrictEqual(keys(p), ['#1405:branch_stuck']);
  assert.deepStrictEqual(p.patch, {});
});

test('branchFacts: stock first, no PO when short everywhere; branchStock maps Prosol locations to branch codes', async () => {
  const pio = require('./pickup-io');
  const lines = [{ sku: '5LA004252', apiSku: '5LA004252', prosolSku: '943854221', quantity: 1 }];
  const client = { checkInventory: async (sku) => (sku === '5LA004252' ? { locationStock: { 10037: { quantity: 0 }, 99999: { quantity: 3 } } } : null) };
  const m = await pio.branchStock(client, lines, 'REGI', branches);
  assert.deepStrictEqual(m, { REGI: { 943854221: 0 }, LOC99999: { 943854221: 3 } });
  let po = 0;
  const f = await R.branchFacts(regina(), { branch: 'REGI' }, branches, { branchStock: async () => ({ REGI: {} }), ensurePo: async () => { po++; return 'PO-1'; } });
  assert.strictEqual(f.stock.status, 'HOLD');
  assert.strictEqual(po, 0);
  const g = await R.branchFacts(regina(), { branch: 'REGI' }, branches, { branchStock: async () => ({ REGI: {}, LOC99999: { 943854221: 3 } }), ensurePo: async () => { po++; return 'PO-2'; } });
  assert.strictEqual(g.stock.status, 'NEEDS_TRANSFER');
  assert.strictEqual(po, 0, 'short at the counter makes no PO even when other branches have it');
  const h = await R.branchFacts(regina(), { branch: 'REGI' }, branches, { branchStock: async () => ({ REGI: { 943854221: 2 } }), ensurePo: async () => 'PO-2' });
  assert.strictEqual(h.poNumber, 'PO-2');
});

test('ensurePo: makes the SO + PO, or finds the PO of an SO that already exists', async () => {
  const pio = require('./pickup-io');
  const ssf = (r) => ({ fetchShopifyOrder: async () => ({ orderNumber: '#1405' }), createShopifySoPo: async () => r });
  assert.strictEqual(await pio.ensurePo('#1405', ssf({ poNumber: 'PO-3' }), {}), 'PO-3');
  const sf = { connect: async () => ({}), query: async (c, q) => (q.includes("'SO-022100'") ? [{ PBSI__Purchase_Order__r: { Name: 'PO-4' } }] : []) };
  assert.strictEqual(await pio.ensurePo('#1405', ssf({ skipped: true, skipReason: 'exists', existingCandidates: ['SO-022100 ("Shopify #1405", 2026-10-02, by API)'] }), sf), 'PO-4');
  await assert.rejects(pio.ensurePo('#1405', ssf({ errors: [{ error: 'SF down' }] }), sf), /SF down/);
});

test('signals: only a correctly signed link changes the record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const file = path.join(dir, 'state.json');
  R.saveState({ orders: { '#1450': { kind: 'split', status: 'ASKED', done: {} }, '#1451': { kind: 'branch', status: 'PO_SENT', done: {} } }, shadow: {} }, file);
  assert.strictEqual(R.applySignal({ action: 'choice', name: '#1450', code: 'WCAS', token: 'bad', file }), null);
  const t = new URL(R.choiceUrl('#1450', 'WCAS', 'Calgary South')).searchParams.get('t');
  assert.strictEqual(R.applySignal({ action: 'choice', name: '#1450', code: 'EDMN', token: t, file }), null, 'token is bound to the code');
  assert.strictEqual(R.applySignal({ action: 'choice', name: '#1450', code: 'WCAS', token: t, file }).choice, 'WCAS');
  const rt = new URL(R.tapUrl('ready', '#1451')).searchParams.get('t');
  assert.ok(R.applySignal({ action: 'ready', name: '#1451', token: rt, file }).readyAt);
});
