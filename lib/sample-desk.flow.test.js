'use strict';
// End-to-end pass of the sample desk with every outside system stubbed: ask -> packed reply -> label -> pickup ->
// label email -> Shopify fulfil -> ShipStation shipped. Also: chase after 2 business days, discontinued -> Mac,
// and a failed label email resumes without buying a second label.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-desk-'));
process.env.SAMPLE_DESK_STATE_FILE = path.join(tmp, 'state.json');
process.env.SAMPLE_DESK_LABEL_GAP_MS = '0';
process.env.SAMPLE_DESK_LABEL_DIR = path.join(tmp, 'labels');

const calls = [];
const stub = (rel, exp) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
let ssStatus = 'awaiting_shipment';
let labelsBought = 0;
stub('./shipstation-v2', {
  CARRIER_IDS: { ups_walleted: 'se-1813879' },
  v1Request: async (method, p, body) => {
    calls.push(['ss', method, p.split('?')[0]]);
    if (p.startsWith('/orders?')) return { status: 200, body: JSON.stringify({ pages: 1, orders: ssStatus === 'awaiting_shipment' ? [{ orderId: 810525676, orderNumber: '1446', orderDate: '2026-11-04T09:22:27', shipTo: { name: 'Siri Bright', street1: '1 Test Rd', city: 'Sooke', state: 'BC', postalCode: 'V9Z 0A1', country: 'CA', phone: '2505550000', residential: true }, items: [{ sku: null, name: 'Order a Sample', options: [{ name: 'Sample of', value: 'AquaFix SPC Grand Cru — Romanée' }, { name: ' ref handle', value: 'aquafix-spc-grand-cru-series-romanee' }] }] }] : [] }) };
    if (p.startsWith('/orders/') && method === 'GET') return { status: 200, body: JSON.stringify({ orderStatus: ssStatus }) };
    if (p === '/shipments/getrates') return { status: 200, body: JSON.stringify([{ serviceCode: 'ups_standard', shipmentCost: 12.1, otherCost: 0.4 }]) };
    if (p === '/shipments/createlabel') { labelsBought++; assert.ok(!body.dimensions, 'never pass dims'); return { status: 200, body: JSON.stringify({ trackingNumber: `1ZTEST${labelsBought}`, shipmentId: 900 + labelsBought, shipmentCost: 12.5, labelData: Buffer.from('%PDF').toString('base64') }) }; }
    if (p === '/orders/markasshipped') { ssStatus = 'shipped'; return { status: 200, body: '{}' }; }
    throw new Error(`unstubbed ss ${method} ${p}`);
  },
  bookPickup: async (a) => { calls.push(['pickup', a.pickupDate, a.labelIds.join(',')]); return { success: true, pickupId: 'pik_test', confirmation: 'CONF1' }; },
});
const mails = [];
stub('./emailer', { sendEmail: async (m) => { mails.push(m); return { messageId: 'x' }; } });
stub('./audit', { log: () => {} });
let ledgerThrows = false;
stub('./sample-watch', { recordVendorAsk: (n, v, when) => { if (ledgerThrows) throw new Error('when.toISOString is not a function'); assert.ok(when instanceof Date, 'ledger gets a Date'); calls.push(['ask-ledger', n.join(), v]); } });

const desk = require('./sample-desk');

// Shopify stub
const fulfils = [];
const gql = async (q, v) => {
  if (q.includes('orders(first: 1')) return { data: { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: '#1446', cancelledAt: null, lineItems: { nodes: [{ id: 'gid://shopify/LineItem/1', title: 'Order a Sample', quantity: 1, customAttributes: [{ key: 'Sample of', value: 'AquaFix SPC Grand Cru — Romanée' }, { key: '_ref_handle', value: 'aquafix-spc-grand-cru-series-romanee' }] }] } }] } } };
  if (q.includes('productByHandle')) return { data: { productByHandle: { title: 'AquaFix SPC Grand Cru — Romanée', vendor: 'Unifloor' } } };
  if (q.includes('fulfillmentOrders')) return { data: { order: { fulfillmentOrders: { nodes: [{ id: 'FO1', status: 'OPEN', lineItems: { nodes: [{ id: 'FOLI1', remainingQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/1' } }] } }] } } } };
  if (q.includes('fulfillmentCreate')) { fulfils.push(v.f); return { data: { fulfillmentCreate: { fulfillment: { id: 'F1' }, userErrors: [] } } }; }
  throw new Error('unstubbed gql');
};

// hello@ stub: a thread we can add vendor replies to
const thread = [];
const sent = [];
let failNextSend = false;
const res = (j) => ({ json: async () => j, text: async () => JSON.stringify(j) });
const graph = {
  bodyText: (b) => (b && b.content) || '',
  graphFetch: async (p, opts = {}) => {
    const m = opts.method || 'GET';
    if (m === 'POST' && p === '/me/messages') { const b = JSON.parse(opts.body); sent.push({ kind: 'new', ...b }); thread.push({ id: `our${thread.length}`, subject: b.subject, from: { emailAddress: { address: '/o=ExchangeLabs/ou=x' } }, sentDateTime: '2026-11-04T19:00:00Z', conversationId: 'conv1', body: { content: b.body.content } }); return res({ id: 'draft1', conversationId: 'conv1' }); }
    if (m === 'POST' && p.endsWith('/createReplyAll')) return res({ id: `reply${sent.length}`, body: { content: '<quoted>' } });
    if (m === 'PATCH') { const b = JSON.parse(opts.body); sent.push({ kind: 'reply', to: b.toRecipients.map((x) => x.emailAddress.address), text: b.body.content, attachments: 0 }); return res({}); }
    if (m === 'POST' && p.endsWith('/attachments')) { sent[sent.length - 1].attachments++; return res({}); }
    if (p.includes('$select=hasAttachments')) return res({ hasAttachments: true });
    if (m === 'POST' && p.endsWith('/send')) { if (failNextSend) { failNextSend = false; throw new Error('Graph 503'); } return res({}); }
    if (p.includes('conversationId')) return res({ value: thread });
    if (p.includes('$search')) return res({ value: [] });
    throw new Error(`unstubbed graph ${m} ${p}`);
  },
};
const vendorSays = (id, text, at) => thread.push({ id, subject: 'RE: [SAMPLE-1446] Sample request', from: { emailAddress: { address: 'olivia@unifloor.ca', name: 'Olivia' } }, receivedDateTime: at, conversationId: 'conv1', body: { content: text } });
let reading = null;
const anthropic = { beta: { messages: { create: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_reading', input: reading }] }) } } };
const base = { parcels: [], tracking: [], discontinued: [], ack_only: false, summary: 's', confident: true };
const run = (now) => desk.tick({ live: true, gql, graph, anthropic, now: new Date(now), log: () => {} });

test('full loop: ask, wait, chase, packed, label, pickup, email, fulfil, close', async () => {
  // Wed 11-04 11:10 PT: intake + ask
  await run('2026-11-04T19:10:00Z');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].toRecipients.map((x) => x.emailAddress.address), ['sample@unifloor.ca']);
  assert.ok(sent[0].subject.startsWith('[SAMPLE-1446]'));
  assert.ok(!sent[0].body.content.includes('Sooke'), 'label mode never sends the customer address');
  assert.ok(calls.some((c) => c[0] === 'ask-ledger'));

  // Same day, nothing new: our own ask (Exchange DN sender) is not read as a vendor reply, no chase yet
  await run('2026-11-04T23:00:00Z');
  assert.strictEqual(sent.length, 1);

  // Fri 11-06: two business days, one chase in the thread
  await run('2026-11-06T18:00:00Z');
  assert.strictEqual(sent.length, 2);
  assert.ok(sent[1].text.includes('Just checking in'));

  // Vendor packs it; the label email fails once
  vendorSays('v1', 'Packed: 0.8 kg, 25x34x5 cm', '2026-11-06T20:00:00Z');
  reading = { ...base, parcels: [{ weight_lb: 1.76, length_cm: 25, width_cm: 34, height_cm: 5 }] };
  failNextSend = true;
  await run('2026-11-06T20:10:00Z');
  assert.strictEqual(labelsBought, 1);
  assert.strictEqual(desk.loadState().orders['1446'].legs.unifloor.status, 'labelled');
  assert.strictEqual(fulfils.length, 0);

  // Next pass resumes: no second label, no second pickup, email goes, Shopify fulfilled, ShipStation shipped
  await run('2026-11-06T20:40:00Z');
  assert.strictEqual(labelsBought, 1, 'no second label');
  assert.strictEqual(calls.filter((c) => c[0] === 'pickup').length, 1);
  assert.strictEqual(calls.find((c) => c[0] === 'pickup')[1], '2026-11-09', 'pickup next business day (Mon)');
  const labelMail = sent[sent.length - 1];
  assert.ok(labelMail.text.includes('1ZTEST1') && labelMail.text.includes('CONF1'));
  assert.strictEqual(labelMail.attachments, 1);
  assert.ok(labelMail.to.includes('olivia@unifloor.ca') && labelMail.to.includes('sample@unifloor.ca'));
  assert.strictEqual(fulfils.length, 1);
  assert.deepStrictEqual(fulfils[0].trackingInfo, { company: 'UPS', numbers: ['1ZTEST1'] });
  assert.strictEqual(fulfils[0].notifyCustomer, true);
  assert.ok(calls.some((c) => c[2] === '/orders/markasshipped'));
  const st = desk.loadState().orders['1446'];
  assert.strictEqual(st.done, true);
  assert.strictEqual(mails.length, 0, 'Mac heard nothing on the happy path');
});

test('discontinued goes to Mac once, no label', async () => {
  // fresh state + fresh order
  fs.rmSync(process.env.SAMPLE_DESK_STATE_FILE, { force: true });
  ssStatus = 'awaiting_shipment'; thread.length = 0; sent.length = 0; labelsBought = 0; mails.length = 0;
  await run('2026-11-09T18:00:00Z');
  vendorSays('v9', 'Romanée is discontinued, sorry', '2026-11-09T20:00:00Z');
  reading = { ...base, discontinued: ['AquaFix SPC Grand Cru Romanée'] };
  await run('2026-11-09T20:10:00Z');
  await run('2026-11-09T20:40:00Z');
  assert.strictEqual(labelsBought, 0);
  assert.strictEqual(mails.length, 1);
  assert.ok(mails[0].subject.includes('Sample #1446 needs you'));
  assert.ok(mails[0].text.includes('Romanée is discontinued'));
  assert.strictEqual(desk.loadState().orders['1446'].legs.unifloor.status, 'escalated');
});

test('#1453: a crash after the ask is sent never sends the ask again', async () => {
  fs.rmSync(process.env.SAMPLE_DESK_STATE_FILE, { force: true });
  ssStatus = 'awaiting_shipment'; thread.length = 0; sent.length = 0; labelsBought = 0; mails.length = 0;
  ledgerThrows = true;
  await run('2026-11-10T18:10:00Z');
  await run('2026-11-10T18:40:00Z');
  await run('2026-11-10T19:10:00Z');
  ledgerThrows = false;
  assert.strictEqual(sent.filter((m) => m.kind === 'new').length, 1, 'one ask, not three');
  assert.strictEqual(desk.loadState().orders['1446'].legs.unifloor.status, 'asked');
  assert.strictEqual(mails.length, 0);
});

test('a send that dies mid-flight escalates instead of resending', async () => {
  fs.rmSync(process.env.SAMPLE_DESK_STATE_FILE, { force: true });
  ssStatus = 'awaiting_shipment'; thread.length = 0; sent.length = 0; labelsBought = 0; mails.length = 0;
  failNextSend = true;
  await run('2026-11-10T18:10:00Z');
  await run('2026-11-10T18:40:00Z');
  await run('2026-11-10T19:10:00Z');
  assert.strictEqual(sent.filter((m) => m.kind === 'new').length, 1, 'no second ask');
  assert.strictEqual(mails.length, 1);
  assert.ok(mails[0].subject.includes('may or may not have gone out'));
  assert.strictEqual(desk.loadState().orders['1446'].legs.unifloor.status, 'escalated');
});

test('#1446: Mac nudging the vendor from mac@ is ours: never read as their reply, and the chase waits from it', async () => {
  fs.rmSync(process.env.SAMPLE_DESK_STATE_FILE, { force: true });
  ssStatus = 'awaiting_shipment'; thread.length = 0; sent.length = 0; labelsBought = 0; mails.length = 0;
  let reads = 0;
  const counting = { beta: { messages: { create: async (...a) => { reads++; return anthropic.beta.messages.create(...a); } } } };
  const go = (now) => desk.tick({ live: true, gql, graph, anthropic: counting, now: new Date(now), log: () => {} });
  await go('2026-11-06T18:42:00Z'); // Fri: ask
  thread.push({ id: 'mac1', subject: 'Re: [SAMPLE-1446] Sample request', from: { emailAddress: { address: 'Mac@CustomFC.ca', name: 'Mac' } }, receivedDateTime: '2026-11-09T17:19:22Z', conversationId: 'conv1', body: { content: 'Hi, any update on this sample?' } });
  await go('2026-11-09T17:40:00Z'); // Mon: Mac's nudge is in the thread
  assert.strictEqual(reads, 0, 'Mac is not the vendor');
  assert.strictEqual(mails.length, 0);
  const leg = desk.loadState().orders['1446'].legs.unifloor;
  assert.strictEqual(leg.status, 'asked');
  assert.strictEqual(leg.lastActivityAt, '2026-11-09T17:19:22Z');
  await go('2026-11-10T18:00:00Z'); // Tue: would have been the chase (2 business days from Fri), now 1 from Mac's nudge
  assert.strictEqual(sent.filter((m) => m.kind === 'reply').length, 0, 'no chase on top of Mac\'s nudge');
  await go('2026-11-11T18:00:00Z'); // Wed 11-11: Remembrance Day, not a business day
  assert.strictEqual(sent.filter((m) => m.kind === 'reply').length, 0);
  await go('2026-11-12T18:00:00Z'); // Thu: 2 business days from the nudge
  assert.strictEqual(sent.filter((m) => m.kind === 'reply').length, 1);
});
