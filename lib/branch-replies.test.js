// Offline tests for the Prosol branch-reply reader: quote stripping, the stock-word guard, the order tie, the
// alternative branch, the draft wording and the Send's recipient enforcement. Fake IO and a mock Graph only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const br = require('./branch-replies');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'branch-replies-'));

// Real replies (bodies before the quote), 2026-10/11.
const FIX = {
  concord: { from: 'rinacay@prosol.ca', subject: 'Re: Order - Concord (WCON)', text: 'Good morning Order picker checked but we dont have KP27-01 available; inventory adjusted.' },
  scar: { from: 'order.scarborough@prosol.ca', subject: 'Re: Order - Scarborough (SCAR)', text: 'Hello, Item #KL1V60E90 is currently out of stock. Please let us know if you are willing to wait for this item.' },
  caln: { from: 'KLazzarotto@prosol.ca', subject: 'Re: Order - Calgary North (CALN)', text: "@mac@customfc.ca, please advise if you would like all items to have their own waybill, or if it is okay that everything from PO; PO-017652 / Order 7002740 is in 1 box?" },
  rich: { from: 'order.richmond@prosol.ca', subject: 'Re: Order - Richmond (RICH)', text: 'Hello, Is packed and ready for Puro pick up.' },
  king: { from: 'KLazzarotto@prosol.ca', subject: 'Re: Order - Kingston (KING)', text: 'Good afternoon, Mac, please see the order confirmation attached. @Order Kingston please see the waybills attached and have order #6979702 ready for pick up.' },
};
const QUOTE = '\n\n________________________________\nFrom: YourFloors <hello@yourfloors.ca>\nSent: Wednesday, November 5, 2026 12:03 PM\nTo: Kaitlyn Lazzarotto <klazzarotto@prosol.ca>\nSubject: Order - Concord (WCON)\n\nHi Kaitlyn,\nPlease find the following orders for Concord (WCON):\nPO: PO-017709\nSO: SO-028037\nRef: 1449\nCarrier: Purolator, Tracking: 520861603352\nPlease reply to confirm receipt.';

// ── Parsing ─────────────────────────────────────────────────────────────────

test('subject: plain reply, Zendesk form, and anything else is not ours', () => {
  assert.deepEqual(br.parseSubject('Re: Order - Concord (WCON)'), { branch: 'Concord', code: 'WCON', warehouse: 'Concord (WCON)' });
  assert.deepEqual(br.parseSubject('[Prosol Inc] Re: Re: Order - Calgary North (CALN)'), { branch: 'Calgary North', code: 'CALN', warehouse: 'Calgary North (CALN)' });
  assert.equal(br.parseSubject('RE: PO-017709 pickup'), null);
  assert.equal(br.isBranchReply({ subject: 'Re: Order - Concord (WCON)', from: { emailAddress: { address: 'rinacay@prosol.ca' } } }), true);
  assert.equal(br.isBranchReply({ subject: 'Re: Order - Concord (WCON)', from: { emailAddress: { address: 'hello@yourfloors.ca' } } }), false);
  assert.equal(br.isBranchReply({ subject: 'Order confirmation', from: { emailAddress: { address: 'klazzarotto@prosol.ca' } } }), false);
});

test('quote stripping keeps only the new words', () => {
  assert.equal(br.stripQuote(FIX.concord.text + QUOTE), FIX.concord.text);
  assert.equal(br.stripQuote('Packed.\r\n\r\nOn Wed, Nov 5, 2026 at 12:03 PM YourFloors <hello@yourfloors.ca> wrote:\r\n> Hi Kaitlyn'), 'Packed.');
  assert.equal(br.stripQuote('Prêt.\n\nDe : YourFloors <hello@yourfloors.ca>\nEnvoyé : mercredi'), 'Prêt.');
  assert.equal(br.stripQuote('Shipped tonight.\n-----Original Message-----\nFrom: x'), 'Shipped tonight.');
  assert.equal(br.stripQuote('ok\n> quoted line\nthanks'), 'ok\nthanks');
  // Prosol's Zendesk form (real body, 2026-10-13): only the newest comment.
  const zd = '##- Please type your reply above this line -##\r\n\r\nYour request (388785) has been updated. To add additional comments, reply to this email.\r\n\r\n[https://prosoldist.zendesk.com/images/2016/default-avatar-80.png]\r\n\r\nAboubakary Bamba (Prosol Inc)\r\n\r\nOct 13, 2026, 15:50 EDT\r\n\r\nYour delivery request is being prepared and will be shipped by PURO.\r\nThanks and have a great day\r\n\r\n[https://prosoldist.zendesk.com/images/2016/default-avatar-80.png]\r\n\r\nKaitlyn Lazzarotto\r\n\r\nOct 13, 2026, 14:50 EDT\r\n\r\nGood afternoon,\r\n\r\nMac, please see the order confirmation attached.\r\n\r\n________________________________\r\nFrom: YourFloors Support <hello@yourfloors.ca>\r\nSubject: Order - Saint-Laurent (WGRF)\r\n\r\nRef: 702-7229455-5521068';
  assert.equal(br.stripQuote(zd), 'Your delivery request is being prepared and will be shipped by PURO.\nThanks and have a great day');
});

// ── Guard ───────────────────────────────────────────────────────────────────

test('guard: stock words or a question to us never stay an ack', () => {
  assert.deepEqual(br.applyGuard('ack', FIX.concord.text), { kind: 'other', guarded: 'stock words' });
  assert.deepEqual(br.applyGuard('ack', FIX.scar.text), { kind: 'other', guarded: 'stock words' });
  assert.deepEqual(br.applyGuard('ack', FIX.caln.text), { kind: 'other', guarded: 'a question to us' });
  assert.deepEqual(br.applyGuard('ack', 'Can you confirm the address?'), { kind: 'other', guarded: 'a question to us' });
  for (const w of ["We don't have it", 'backordered until Dec', 'item discontinued', 'not available at this branch', 'we are short 2', 'no stock']) {
    assert.equal(br.applyGuard('ack', w).kind, 'other', w);
  }
  // Real acks pass, and a cant_ship / question from Opus is left alone.
  assert.deepEqual(br.applyGuard('ack', FIX.rich.text), { kind: 'ack', guarded: null });
  assert.deepEqual(br.applyGuard('ack', FIX.king.text), { kind: 'ack', guarded: null });
  assert.deepEqual(br.applyGuard('ack', 'Will ship shortly.'), { kind: 'ack', guarded: null });
  // Real signatures (2026-11-05..10): a "?" inside a link and Hamilton's "Please advise that ..." notice are not questions.
  const quebec = br.stripQuote('Good afternoon, Your order will be prepared and will be shipped this evening. Winny Shipping Québec Visit : https://shop.prosol.ca/<https://cloud.letsignit.com/collect/bc/66db4fc52e?p=72cGg6cnZgx3r1>');
  assert.deepEqual(br.applyGuard('ack', quebec), { kind: 'ack', guarded: null });
  const hamilton = 'Good afternoon, Package is ready for pick up! Thank you, Rachel Order Desk Hamilton T. 905-575-8106. Please advise that orders for next day delivery must be submitted by 2:00 PM to ensure processing and delivery accuracy.';
  assert.deepEqual(br.applyGuard('ack', hamilton), { kind: 'ack', guarded: null });
  assert.equal(br.stripQuote('@Order Kelowna<mailto:order.kelowna@prosol.ca> please see the waybill'), '@Order Kelowna please see the waybill');
  assert.deepEqual(br.applyGuard('cant_ship', FIX.concord.text), { kind: 'cant_ship', guarded: null });
  assert.equal(br.applyGuard('weird', 'packed').kind, 'other');
});

// ── Order tie ───────────────────────────────────────────────────────────────

const ORDERS = {
  809941751: { orderId: 809941751, orderNumber: '1440', carrier: 'purolator_walleted', tracking: '520850000001', po: 'PO-017600', packages: [{ tracking: '520850000001', po: 'PO-017600', items: [] }], items: [{ sku: '11555', name: 'Thing', qty: 1, codes: ['11555', 'C010861-01'], prosolSku: 'C010861-01' }] },
  811106590: { orderId: 811106590, orderNumber: '1449', carrier: 'purolator_walleted', tracking: '520861603352', po: 'PO-017709', packages: [{ tracking: '520861603352', po: 'PO-017709', items: [{ sku: '352701821' }] }], items: [{ sku: '352701821', name: 'Mapei Kerapoxy Kit Premium Epoxy Grout - Silver / 946 mL', qty: 1, codes: ['352701821', 'KP27-01'], prosolSku: 'KP27-01' }] },
  811106777: { orderId: 811106777, orderNumber: '1450', carrier: 'ups_walleted', tracking: '1Z0000000000000001', po: 'PO-017710', packages: [{ tracking: '1Z0000000000000001', po: 'PO-017710', items: [{ sku: 'B0ABC' }] }], items: [{ sku: 'B0ABC', name: 'Grout float', qty: 2, codes: ['B0ABC', 'FLT-9'], prosolSku: 'FLT-9' }] },
  812504991: { orderId: 812504991, orderNumber: '1460', carrier: 'purolator_walleted', tracking: '520870000009', po: 'PO-017800', packages: [], items: [{ sku: 'X1', name: 'Other', qty: 1, codes: ['X1'] }] },
};
const EMAILS = [
  { timestamp: '2026-11-03T19:05:29.938Z', action: 'pipeline-email-prosol', warehouse: 'Concord (WCON)', orderIds: [809941751], success: true },
  { timestamp: '2026-11-05T19:03:25.517Z', action: 'pipeline-email-prosol', warehouse: 'Concord (WCON)', orderIds: [811106590, 811106777], success: true },
  { timestamp: '2026-11-05T19:03:30.000Z', action: 'pipeline-email-prosol', warehouse: 'Scarborough (SCAR)', orderIds: [999], success: true },
  { timestamp: '2026-11-09T19:08:49.592Z', action: 'pipeline-email-prosol', warehouse: 'Concord (WCON)', orderIds: [812504991], success: true },
];
const factsFor = async (id) => ORDERS[id] || null;

test('tie: the send at or before the thread start, narrowed to the order carrying the named SKU', async () => {
  // Thread started by our SMTP send at 19:03:20 (the audit line lands a few seconds later).
  const t = await br.tieOrders({ code: 'WCON', threadStart: '2026-11-05T19:03:20Z', receivedAt: '2026-11-06T14:12:00Z', emails: EMAILS, refs: br.threadRefs(FIX.concord.text), skuCodes: [{ code: 'KP27-01' }], factsFor });
  assert.equal(t.sure, true, t.reasons.join('; '));
  assert.equal(t.sentAt, '2026-11-05T19:03:25.517Z');
  assert.deepEqual(t.orders.map((o) => o.orderNumber), ['1449']);
  // No SKU named: both orders on that send.
  const all = await br.tieOrders({ code: 'WCON', threadStart: '2026-11-05T19:03:20Z', receivedAt: '2026-11-06T14:12:00Z', emails: EMAILS, refs: br.threadRefs('Packed'), factsFor });
  assert.deepEqual(all.orders.map((o) => o.orderNumber), ['1449', '1450']);
  assert.equal(all.sure, true);
});

test('tie: refs quoted in the thread win over send time, and a miss is said, never guessed', async () => {
  // Zendesk form thread starts with the reply itself on 11-10 (newest Concord send is 11-09) but quotes Ref 1449.
  const t = await br.tieOrders({ code: 'WCON', threadStart: '2026-11-10T15:00:00Z', receivedAt: '2026-11-10T15:00:00Z', emails: EMAILS, refs: br.threadRefs(FIX.concord.text + QUOTE), skuCodes: [{ code: 'KP27-01' }], factsFor });
  assert.deepEqual(t.orders.map((o) => o.orderNumber), ['1449']);
  assert.equal(t.sure, false);
  assert.match(t.reasons.join(' '), /matched on the order refs quoted/);
  // A SKU no tied order carries: orders kept, flagged unsure.
  const u = await br.tieOrders({ code: 'WCON', threadStart: '2026-11-09T19:08:40Z', receivedAt: '2026-11-10T15:00:00Z', emails: EMAILS, refs: br.threadRefs('x'), skuCodes: [{ code: 'KP27-01' }], factsFor });
  assert.equal(u.sure, false);
  assert.deepEqual(u.orders.map((o) => o.orderNumber), ['1460']);
  assert.match(u.reasons.join(' '), /no tied order carries KP27-01/);
  // No send to that branch at all.
  const n = await br.tieOrders({ code: 'OTTA', threadStart: '2026-11-05T19:03:20Z', emails: EMAILS, refs: br.threadRefs(''), factsFor });
  assert.equal(n.sure, false);
  assert.equal(n.orders.length, 0);
  // Unknown thread start is called out.
  const r = await br.tieOrders({ code: 'WCON', threadStart: null, receivedAt: '2026-11-06T14:12:00Z', emails: EMAILS, refs: br.threadRefs(''), factsFor });
  assert.equal(r.sure, false);
  assert.match(r.reasons[0], /thread start unknown/);
});

test('thread refs: Ref lines, #orders, POs, tracking; not Prosol 7-digit order numbers', () => {
  const r = br.threadRefs(FIX.caln.text + QUOTE + ' #6979702');
  assert.deepEqual(r.orderNumbers, ['1449']);
  assert.deepEqual(r.pos.sort(), ['17652', '17709']);
  assert.deepEqual(r.trackings, ['520861603352']);
});

test('ops-state order: label, packages, PO and sku-map codes', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-11-05.json'), JSON.stringify({ phases: {
    buy: { labels: { 811106590: { orderNumber: '1449', source: 'shopify', trackingNumber: '520861603352', carrierCode: 'purolator_walleted', warehouseId: 1791764,
      packages: [{ trackingNumber: '520861603352', items: [{ sku: '352701821', name: 'Mapei Kerapoxy Kit Premium Epoxy Grout - Silver / 946 mL', quantity: 1 }] }] } } },
    pos: { byTracking: { 520861603352: { poNumber: 'PO-017709' } } } } }));
  const map = { 352701821: { api_sku: '352701821', prosol_sku: 'KP27-01' } };
  const o = br.opsStateOrder(811106590, '2026-11-05T19:03:25.517Z', { dir, readMap: () => map });
  assert.equal(o.orderNumber, '1449');
  assert.equal(o.po, 'PO-017709');
  assert.equal(o.tracking, '520861603352');
  assert.deepEqual(o.items[0].codes, ['352701821', 'KP27-01']);
  assert.equal(o.packages[0].po, 'PO-017709');
  // Found from a later send date too (label bought days earlier), and null when absent.
  assert.equal(br.opsStateOrder(811106590, '2026-11-08T19:00:00Z', { dir, readMap: () => map }).orderNumber, '1449');
  assert.equal(br.opsStateOrder(1, '2026-11-05T19:00:00Z', { dir }), null);
});

// ── Alternative branch ──────────────────────────────────────────────────────

const STOCK = [
  { code: 'WCON', city: 'Concord', province: 'ON', lat: 43.80, lng: -79.53, qty: 15 },
  { code: 'OTTA', city: 'Ottawa', province: 'ON', lat: 45.41, lng: -75.62, qty: 7 },
  { code: 'SCAR', city: 'Scarborough', province: 'ON', lat: 43.76, lng: -79.30, qty: 1 },
  { code: 'NANA', city: 'Nanaimo', province: 'BC', lat: 49.20, lng: -124.00, qty: 1 },
  { code: 'WGRF', city: 'Saint-Laurent', province: 'QC', lat: 45.48, lng: -73.70, qty: 30 },
];

test('alt branch: never the branch that said no, >= 2 beats thin stock, then the customer province, then distance', () => {
  // Scarborough is nearest a Toronto customer but shows 1 (thin); Ottawa has 7 in ON.
  const c = br.chooseAltBranch({ stock: STOCK, need: 1, exclude: 'WCON', province: 'ON' });
  assert.equal(c.pick.code, 'OTTA');
  assert.ok(!c.ranked.some((s) => s.code === 'WCON'));
  // QC customer: Saint-Laurent.
  assert.equal(br.chooseAltBranch({ stock: STOCK, need: 1, exclude: 'WCON', province: 'QC' }).pick.code, 'WGRF');
  // Needs 10: only Saint-Laurent qualifies even for an ON customer.
  assert.equal(br.chooseAltBranch({ stock: STOCK, need: 10, exclude: 'WCON', province: 'ON' }).pick.code, 'WGRF');
  // Only thin stock left: still offered, marked thin.
  const thin = br.chooseAltBranch({ stock: STOCK.filter((s) => s.qty === 1), need: 1, exclude: 'WCON', province: 'BC' });
  assert.equal(thin.pick.code, 'NANA');
  assert.equal(thin.pick.thin, true);
  // Nobody has it.
  assert.equal(br.chooseAltBranch({ stock: [{ code: 'WCON', qty: 3 }], need: 1, exclude: 'WCON' }).pick, null);
  // Unknown province: nearest the original branch.
  assert.equal(br.chooseAltBranch({ stock: STOCK.filter((s) => s.code !== 'OTTA'), need: 1, exclude: 'WCON', origin: [43.80, -79.53] }).pick.code, 'WGRF');
});

// ── Wording ─────────────────────────────────────────────────────────────────

test('cant_ship draft matches the wording Mac approved 2026-11-10', () => {
  const d = br.cantShipDraft({ branch: 'Concord', lines: [{ sku: 'KP27-01', order: '1449', qty: 1, name: 'Mapei Kerapoxy Silver 946 ml', carrier: 'purolator_walleted', tracking: '520861603352', po: 'PO-017709', alt: { city: 'Ottawa', code: 'OTTA', qty: 7 } }] });
  assert.equal(d, "Hi Kaitlyn,\n\nConcord let us know they don't have KP27-01. Could you send #1449 (1x KP27-01 Mapei Kerapoxy Silver 946 ml) from Ottawa instead? They show 7 in stock. Same Purolator label, tracking 520861603352, PO-017709.\n\nThanks,\nMac");
  assert.ok(!/—/.test(d));
  // Nothing to ask for: no draft.
  assert.equal(br.cantShipDraft({ branch: 'Concord', lines: [{ sku: 'KP27-01', order: '1449', alt: null }] }), null);
  // Amazon order number reads "order ...", two lines, UPS.
  const two = br.cantShipDraft({ branch: 'Scarborough', lines: [
    { sku: 'KL1V60E90', order: '702-1111111-2222222', qty: 2, name: 'Kerdi-Line', carrier: 'ups_walleted', tracking: '1Z0000000000000001', po: null, alt: { city: 'Mississauga', qty: 4 } },
    { sku: 'KP27-01', order: '1449', qty: 1, name: '', carrier: 'purolator_walleted', tracking: '520861603352', po: 'PO-017709', alt: { city: 'Ottawa', qty: 7 } }] });
  assert.match(two, /don't have KL1V60E90 and KP27-01\./);
  assert.match(two, /send order 702-1111111-2222222 \(2x KL1V60E90 Kerdi-Line\) from Mississauga instead\? They show 4 in stock\. Same UPS label, tracking 1Z0000000000000001\./);
});

// ── Run (fake IO) ───────────────────────────────────────────────────────────

const msg = (f, id, at) => ({ id, subject: f.subject, from: { emailAddress: { address: f.from } }, receivedDateTime: at, conversationId: `conv-${id}`, isDraft: false });
function fakeIo(over = {}) {
  const calls = { cards: [], audit: [], vendor: [], draft: 0 };
  const msgs = [
    msg(FIX.rich, 'm-rich', '2026-11-06T15:00:00Z'),
    msg(FIX.concord, 'm-con', '2026-11-06T16:12:00Z'),
    msg(FIX.caln, 'm-caln', '2026-11-06T17:00:00Z'),
    msg(FIX.king, 'm-king', '2026-11-06T18:00:00Z'),
    { id: 'm-other', subject: 'Lunch', from: { emailAddress: { address: 'someone@prosol.ca' } }, receivedDateTime: '2026-11-06T18:30:00Z' },
  ];
  const texts = { 'm-rich': FIX.rich.text, 'm-con': FIX.concord.text + QUOTE, 'm-caln': FIX.caln.text, 'm-king': FIX.king.text };
  // Stand-in for Opus: Concord comes back as an "ack" to prove the guard holds; the rest as Opus reads them.
  const kinds = { [FIX.rich.text]: { kind: 'ack', skus: [] }, [FIX.concord.text]: { kind: 'cant_ship', skus: [{ code: 'KP27-01', qty: null }] }, [FIX.caln.text]: { kind: 'question', skus: [] }, [FIX.king.text]: { kind: 'ack', skus: [] } };
  const io = {
    listMessages: async () => msgs,
    body: async (id) => texts[id],
    threadStart: async (cid) => ({ 'conv-m-con': '2026-11-05T19:03:20Z' }[cid] || null),
    emails: async () => EMAILS.concat([{ timestamp: '2026-11-06T18:59:00Z', warehouse: 'Richmond (RICH)', orderIds: [811106590], success: true }]),
    factsFor,
    stock: async () => STOCK,
    province: async () => 'ON',
    origin: () => [43.80, -79.53],
    classify: async ({ text }) => ({ summary: '', ...(kinds[text] || { kind: 'other', skus: [] }) }),
    draft: async () => { calls.draft++; return { reply: 'Hi Kaitlyn,\n\nOne box is fine for PO-017652.\n\nThanks,\nMac', note: '' }; },
    notifyMac: async (c) => { calls.cards.push(c); },
    audit: (o) => calls.audit.push(o),
    logVendorError: async (r) => { calls.vendor.push(r); return { id: `ve-${calls.vendor.length}` }; },
    vendorErrorExists: async () => false,
    link: (k) => `http://mini/branch-replies/send?k=${k}&t=x`,
    ...over,
  };
  return { io, calls };
}

test('run: first pass starts from now, no backfill', async () => {
  const file = path.join(tmp(), 's.json');
  const { io, calls } = fakeIo();
  const out = await br.run({ io, mode: 'live', stateFile: file, now: new Date('2026-11-10T15:00:00Z') });
  assert.equal(out.firstRun, true);
  assert.equal(calls.cards.length, 0);
  assert.equal(br.loadState(file).lastSeenAt, '2026-11-10T15:00:00.000Z');
});

test('run live: acks are audit only, cant_ship and question get cards, vendor error once per order + SKU', async () => {
  const file = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: '2026-11-06T00:00:00Z', messages: {}, vendorErrors: {} }, file);
  const { io, calls } = fakeIo();
  const out = await br.run({ io, mode: 'live', stateFile: file });
  assert.deepEqual(out.processed.map((e) => e.kind), ['ack', 'cant_ship', 'question', 'ack']);
  assert.equal(calls.cards.length, 2);
  const con = calls.cards[0];
  assert.match(con.subject, /Concord \(WCON\) can't ship KP27-01 \(#1449\)/);
  assert.match(con.text, /Could you send #1449 \(1x KP27-01 Mapei Kerapoxy Kit Premium Epoxy Grout Silver 946 mL\) from Ottawa instead\? They show 7 in stock\. Same Purolator label, tracking 520861603352, PO-017709\./);
  assert.match(con.text, /branch-replies\/send\?k=/);
  assert.match(calls.cards[1].subject, /Calgary North \(CALN\) has a question/);
  assert.equal(calls.draft, 1);
  assert.equal(calls.vendor.length, 1);
  assert.equal(calls.vendor[0].issue_type, 'not_shipped');
  assert.equal(calls.vendor[0].order_ref, '1449');
  assert.equal(calls.vendor[0].location, 'Concord (WCON)');
  assert.equal(calls.audit.filter((a) => a.action === 'branch-reply').length, 4);
  const st = br.loadState(file);
  assert.equal(Object.keys(st.messages).length, 4);
  assert.equal(st.lastSeenAt, '2026-11-06T18:00:00Z');
  // Second pass: nothing new, nothing re-carded, no second vendor error.
  const again = await br.run({ io, mode: 'live', stateFile: file });
  assert.equal(again.processed.length, 0);
  assert.equal(calls.cards.length, 2);
  assert.equal(calls.vendor.length, 1);
});

test('run shadow: classifies and audits, no cards, no vendor errors; dry writes nothing', async () => {
  const file = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: '2026-11-06T00:00:00Z', messages: {}, vendorErrors: {} }, file);
  const { io, calls } = fakeIo();
  await br.run({ io, mode: 'shadow', stateFile: file });
  assert.equal(calls.cards.length, 0);
  assert.equal(calls.vendor.length, 0);
  assert.equal(calls.audit.length, 4);
  assert.equal(br.loadState(file).messages[br.keyOf('m-con')].status, 'shadow');

  const dryFile = path.join(tmp(), 'none.json');
  const d = fakeIo();
  const out = await br.run({ io: d.io, mode: 'dry', since: '2026-10-10T00:00:00Z', stateFile: dryFile });
  assert.equal(out.processed.length, 4);
  assert.equal(d.calls.cards.length + d.calls.vendor.length + d.calls.audit.length, 0);
  assert.equal(fs.existsSync(dryFile), false);
});

test('run: the guard overrides an Opus ack, and a failing reply is retried then carded as an error', async () => {
  const file = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: '2026-11-06T00:00:00Z', messages: {}, vendorErrors: {} }, file);
  const { io, calls } = fakeIo({ classify: async ({ text }) => ({ kind: 'ack', skus: [], summary: '' }) });
  const out = await br.run({ io, mode: 'live', stateFile: file });
  const con = out.processed.find((e) => e.graphId === 'm-con');
  assert.equal(con.kind, 'other');
  assert.equal(con.guarded, 'stock words');
  assert.equal(out.processed.find((e) => e.graphId === 'm-rich').kind, 'ack');

  const f2 = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: '2026-11-06T00:00:00Z', messages: {}, vendorErrors: {} }, f2);
  const bad = fakeIo({ body: async (id) => { if (id === 'm-caln') throw new Error('graph 504'); return FIX.rich.text; } });
  for (let i = 0; i < 3; i++) await br.run({ io: bad.io, mode: 'live', stateFile: f2 });
  const st = br.loadState(f2);
  assert.equal(st.messages[br.keyOf('m-caln')].status, 'error');
  assert.equal(bad.calls.cards.filter((c) => /could not process/.test(c.subject)).length, 1);
});

test('run: cant_ship with no code named (Concord 2026-10-19 "does not have stock of this item") uses the only item, says so', async () => {
  const file = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: '2026-11-06T00:00:00Z', messages: {}, vendorErrors: {} }, file);
  const { io, calls } = fakeIo({
    listMessages: async () => [msg(FIX.concord, 'm-con', '2026-11-06T16:12:00Z')],
    body: async () => 'Hey Mac, Concord does not have stock of this item. Would you like to redirect the order?' + QUOTE,
    classify: async () => ({ kind: 'cant_ship', skus: [], summary: '' }),
  });
  const out = await br.run({ io, mode: 'live', stateFile: file });
  const e = out.processed[0];
  assert.equal(e.lines[0].sku, 'KP27-01');
  assert.equal(e.lines[0].alt.code, 'OTTA');
  assert.match(calls.cards[0].text, /Check: The reply names no code/);
});

// ── Send (mock Graph) ───────────────────────────────────────────────────────

function mockGraph({ draftConv = 'conv-1', ignorePatchTo = false, sentLands = true } = {}) {
  const log = [];
  let draft = null;
  const sent = [];
  const res = (obj) => ({ ok: true, text: async () => JSON.stringify(obj || {}), json: async () => obj || {} });
  const graphFetch = async (p, opts = {}) => {
    const method = opts.method || 'GET';
    log.push(`${method} ${p.split('?')[0]}`);
    if (method === 'POST' && p.endsWith('/createReplyAll')) {
      draft = { id: 'd1', conversationId: draftConv, toRecipients: [{ emailAddress: { address: 'rinacay@prosol.ca' } }, { emailAddress: { address: 'klazzarotto@prosol.ca' } }],
        ccRecipients: [{ emailAddress: { address: 'order.vaughan@prosol.ca' } }], bccRecipients: [], attachments: [{ id: 'a1' }, { id: 'a2' }], body: null };
      return res(draft);
    }
    if (method === 'PATCH') {
      const b = JSON.parse(opts.body);
      draft.body = b.body;
      if (!ignorePatchTo) Object.assign(draft, { toRecipients: b.toRecipients, ccRecipients: b.ccRecipients, bccRecipients: b.bccRecipients });
      return res({});
    }
    if (method === 'DELETE' && /\/attachments\//.test(p)) { const id = decodeURIComponent(p.split('/').pop()); draft.attachments = draft.attachments.filter((a) => a.id !== id); return res({}); }
    if (method === 'DELETE') { draft.deleted = true; return res({}); }
    if (method === 'GET' && /\/messages\/d1\/attachments/.test(p)) return res({ value: draft.attachments });
    if (method === 'GET' && /\/messages\/d1\?/.test(p)) return res(draft);
    if (method === 'POST' && p.endsWith('/send')) { if (sentLands) sent.push({ id: 's1', sentDateTime: new Date().toISOString(), toRecipients: draft.toRecipients, conversationId: draft.conversationId }); return res({}); }
    if (method === 'GET' && p.startsWith('/me/mailFolders/sentitems/messages')) return res({ value: sent });
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { graphFetch, log, get draft() { return draft; }, sent };
}
const ENTRY = { key: 'k1', graphId: 'g-con', conversationId: 'conv-1', from: 'rinacay@prosol.ca', subject: 'Re: Order - Concord (WCON)', receivedAt: '2026-11-06T16:12:00Z', said: FIX.concord.text, warehouse: 'Concord (WCON)', kind: 'cant_ship', draft: 'Hi Kaitlyn,\n\nCould you send #1449 from Ottawa instead?\n\nThanks,\nMac', status: 'carded', tie: { orders: [{ orderNumber: '1449' }] } };
const OPTS = { kaitlyn: 'klazzarotto@prosol.ca', mac: 'mac@customfc.ca', sleep: async () => {} };

test('send: To Kaitlyn only, CC Mac, no BCC, attachments deleted, plain text, confirmed in Sent Items', async () => {
  const g = mockGraph();
  const r = await br.sendReply(g, ENTRY, ENTRY.draft, OPTS);
  assert.equal(r.sentId, 's1');
  const d = g.draft;
  assert.deepEqual(d.toRecipients.map((x) => x.emailAddress.address), ['klazzarotto@prosol.ca']);
  assert.deepEqual(d.ccRecipients.map((x) => x.emailAddress.address), ['mac@customfc.ca']);
  assert.deepEqual(d.bccRecipients, []);
  assert.equal(d.attachments.length, 0);
  assert.equal(d.body.contentType, 'Text');
  assert.ok(d.body.content.startsWith(ENTRY.draft));
  assert.ok(g.log.indexOf('POST /me/messages/d1/send') > g.log.lastIndexOf('DELETE /me/messages/d1/attachments/a2'));
});

test('send: refuses (draft deleted, nothing sent) when recipients do not stick or the thread differs', async () => {
  const g = mockGraph({ ignorePatchTo: true });
  await assert.rejects(br.sendReply(g, ENTRY, ENTRY.draft, OPTS), (e) => /To must be only klazzarotto@prosol\.ca/.test(e.message) && e.phase === 'pre-send');
  assert.equal(g.draft.deleted, true);
  assert.ok(!g.log.includes('POST /me/messages/d1/send'));

  const g2 = mockGraph({ draftConv: 'conv-OTHER' });
  await assert.rejects(br.sendReply(g2, ENTRY, ENTRY.draft, OPTS), /not in the branch thread/);
  assert.ok(!g2.log.includes('POST /me/messages/d1/send'));
});

test('sendCarded: one send per key, a second tap does not send again; unconfirmed send blocks a retry', async () => {
  const file = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: 'x', messages: { k1: { ...ENTRY } }, vendorErrors: {} }, file);
  const g = mockGraph();
  const audits = [];
  const e = await br.sendCarded('k1', { graph: g, stateFile: file, audit: (a) => audits.push(a), sendOpts: OPTS });
  assert.equal(e.status, 'sent');
  assert.equal(audits[0].action, 'branch-reply-sent');
  const again = await br.sendCarded('k1', { graph: g, stateFile: file, sendOpts: OPTS });
  assert.equal(again.status, 'sent');
  assert.equal(g.log.filter((l) => l === 'POST /me/messages/d1/send').length, 1);

  // Sent but never seen in Sent Items: stays 'sending'; a tap within 10 minutes refuses.
  const f2 = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: 'x', messages: { k1: { ...ENTRY } }, vendorErrors: {} }, f2);
  const lost = mockGraph({ sentLands: false });
  await assert.rejects(br.sendCarded('k1', { graph: lost, stateFile: f2, sendOpts: OPTS }), /not in hello@ Sent Items/);
  assert.equal(br.loadState(f2).messages.k1.status, 'sending');
  await assert.rejects(br.sendCarded('k1', { graph: lost, stateFile: f2, sendOpts: OPTS }), /is not in Sent Items yet/);
  assert.equal(lost.log.filter((l) => l === 'POST /me/messages/d1/send').length, 1);

  // A pre-send refusal puts the card back so Mac can tap again.
  const f3 = path.join(tmp(), 's.json');
  br.saveState({ lastSeenAt: 'x', messages: { k1: { ...ENTRY } }, vendorErrors: {} }, f3);
  await assert.rejects(br.sendCarded('k1', { graph: mockGraph({ ignorePatchTo: true }), stateFile: f3, sendOpts: OPTS }));
  assert.equal(br.loadState(f3).messages.k1.status, 'carded');
});

test('send tokens verify only for their own key', () => {
  const t = br.sendToken('k1', 's3cret');
  assert.equal(br.verifySend('k1', t, 's3cret'), true);
  assert.equal(br.verifySend('k2', t, 's3cret'), false);
  assert.equal(br.verifySend('k1', 'nope', 's3cret'), false);
  assert.equal(br.verifySend('k1', t, ''), false);
});
