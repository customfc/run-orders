'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SKU_RESOLVER_SECRET = 'test-secret';
delete process.env.DISCONTINUED_SECRET;
const d = require('./discontinued');

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discontinued-')), 'state.json');
const NOW = new Date('2026-10-07T15:00:00Z');
const noSleep = async () => {};

// #1412 as it really was, 2026-10-07.
const RUBI = {
  productId: 14534, sku: '71970', prosolSku: 'R71970', name: 'Rubi - Nipper for Glass Mosaic', active: true,
  cost: 53.73, list: 76.75, total: 9,
  stock: [{ code: 'WCON', city: 'Concord', province: 'ON', qty: 4 }, { code: 'WGRF', city: 'Saint-Laurent', province: 'QC', qty: 3 },
    { code: 'QUEB', city: 'Quebec', province: 'QC', qty: 1 }, { code: 'CHIC', city: 'Chicoutimi', province: 'QC', qty: 1 }],
};
const ROW_1412 = {
  orderNumber: '1412',
  reason: 'No Prosol inventory result for 32014 (also tried Q32014QC)',
  prosolGone: {
    sku: '32014', itemName: 'QEP Xtreme 8.25" Glass Tile Nipper with Pro Control Settings', qty: 1,
    apiSku: '32014', prosolSku: 'Q32014QC', channel: 'shopify', orderDate: '2026-10-07T00:29:44.0000000', unitPrice: 68.99,
    shipTo: { name: 'Brenda Pander-Scott', city: 'Asphodel Norwood', state: 'ON' },
  },
};
const FACTS_1412 = {
  id: 'gid://shopify/Order/7319819878567', name: '#1412', email: 'Brenda.panderscott@gmail.com', createdAt: '2026-10-07T07:29:44Z',
  total: 92.64, refunded: 0, closedReason: null, firstName: 'Brenda', fullName: 'Brenda Pander-Scott', city: 'Asphodel Norwood', province: 'ON',
  line: { id: 'gid://shopify/LineItem/1', title: 'QEP Xtreme 8.25" Glass Tile Nipper with Pro Control Settings', qty: 1, unit: 68.99, productId: 'gid://shopify/Product/11037061906599', productStatus: 'ACTIVE' },
  otherLines: 0,
};
const ENTRY_32014 = { api_sku: '32014', prosol_sku: 'Q32014QC', product: 'QEP - Xtreme 8.25" Glass Tile Nipper with Pro Control Settings', cost_cad: 43.12, retail_cad: 61.6, note: 'exact Prosol filter[sku] hit (product id 82685).' };

function fakeClient(byQuery = {}) {
  const calls = [];
  return {
    calls,
    apiGet: async (p) => {
      calls.push(p);
      for (const [needle, body] of Object.entries(byQuery)) if (p.includes(needle)) return typeof body === 'number' ? { status: body, body: '' } : { status: 200, body: JSON.stringify({ data: body }) };
      return { status: 200, body: JSON.stringify({ data: [] }) };
    },
    close: async () => {},
  };
}

function deps(over = {}) {
  const sent = [];
  return {
    sent,
    opts: {
      now: NOW, file: tmpState(), sleep: noSleep, auditLog: () => {},
      send: async (m) => { sent.push(m); return { messageId: `<m${sent.length}>` }; },
      prosol: async () => fakeClient(),
      ai: async () => ({ decision: 'substitute', product_id: 14534, display_name: 'Rubi Nipper for Glass Mosaic', kind: 'glass nipper', reply_word: 'Rubi', confidence: 'high', why: 'Same job, pro grade, in stock in Ontario.' }),
      facts: async () => FACTS_1412,
      refundQuote: async () => ({ full: true, amount: 92.64 }),
      details: async () => RUBI,
      entryFor: () => ENTRY_32014,
      ...over,
    },
  };
}

// ── swaps ────────────────────────────────────────────────────────────────────

test('applySwaps turns the discontinued line into the substitute for that order only, in every item shape', () => {
  const file = tmpState();
  d.saveState({ orders: {
    1412: { status: 'swap-approved', sku: '32014', substitute: { sku: '71970', name: 'Rubi - Nipper for Glass Mosaic' } },
    1500: { status: 'refunded', lineRefund: true, sku: '32014' },
    1501: { status: 'offered', sku: '32014', substitute: { sku: '71970', name: 'x' } },
  } }, file);
  const ss = [{ sku: '32014', name: 'QEP Xtreme', quantity: 1, unitPrice: 68.99 }, { sku: '4657', name: 'Enrich', quantity: 1 }];
  assert.deepStrictEqual(d.applySwaps('1412', ss, { file }), [{ sku: '71970', name: 'Rubi - Nipper for Glass Mosaic', quantity: 1, unitPrice: 68.99 }, ss[1]]);
  const shop = [{ sku: '32014', title: 'QEP Xtreme', displayName: 'QEP Xtreme', price: '68.99', quantity: 1 }];
  assert.deepStrictEqual(d.applySwaps('#1412', shop, { file }), [{ sku: '71970', title: 'Rubi - Nipper for Glass Mosaic', displayName: 'Rubi - Nipper for Glass Mosaic', price: '68.99', quantity: 1 }]);
  assert.deepStrictEqual(d.applySwaps('1500', ss, { file }), [ss[1]], 'a line refund drops that line so the rest ships');
  assert.strictEqual(d.applySwaps('1501', ss, { file }), ss, 'an offer that is not accepted yet changes nothing');
  assert.strictEqual(d.applySwaps('9999', ss, { file }), ss);
});

// ── Prosol checks ────────────────────────────────────────────────────────────

test('confirmGone: no hit on any code form or the pinned product id means gone, with the evidence', async () => {
  const c = fakeClient();
  const r = await d.confirmGone(c, { apiSku: '32014', prosolSku: 'Q32014QC', productId: 82685 }, { sleep: noSleep });
  assert.strictEqual(r.gone, true);
  assert.deepStrictEqual(r.evidence, ['no Prosol product with SKU 32014', 'no Prosol product with SKU Q32014QC', 'Prosol product 82685 no longer exists']);
  assert.ok(c.calls.some((p) => p.includes('filter[id]=82685')));
});

test('confirmGone: the slashless form or the product id still answering means NOT gone (KSLT1930/965S lesson)', async () => {
  const slashless = fakeClient({ 'filter[sku]=KSLT1930965S': [{ id: 13540, sku: 'KSLT1930965S', name: { en: 'Kerdi-Line tray' } }] });
  const r1 = await d.confirmGone(slashless, { apiSku: 'KSLT1930/965S', prosolSku: 'KSLT1930/965S' }, { sleep: noSleep });
  assert.strictEqual(r1.gone, false);
  assert.strictEqual(r1.found.id, 13540);
  const byId = fakeClient({ 'filter[id]=82685': [{ id: 82685, sku: '32014', name: 'QEP' }] });
  assert.strictEqual((await d.confirmGone(byId, { apiSku: '32014', prosolSku: 'Q32014QC', productId: 82685 }, { sleep: noSleep })).gone, false);
});

test('confirmGone: a Prosol HTTP failure throws instead of reading as "gone"', async () => {
  await assert.rejects(d.confirmGone(fakeClient({ 'filter[sku]=32014': 500 }), { apiSku: '32014' }, { sleep: noSleep }), /HTTP 500/);
});

test('productIdFromEntry reads the pinned id, or the one in the note', () => {
  assert.strictEqual(d.productIdFromEntry({ prosol_product_id: 18982 }), 18982);
  assert.strictEqual(d.productIdFromEntry(ENTRY_32014), 82685);
  assert.strictEqual(d.productIdFromEntry({ note: 'nothing' }), null);
});

test('substituteProblem refuses short stock and a cheaper, lesser item', () => {
  assert.strictEqual(d.substituteProblem(RUBI, { qty: 1, paidUnit: 68.99 }), null);
  assert.match(d.substituteProblem(RUBI, { qty: 12 }), /only 9 in stock/);
  const qep7 = { ...RUBI, name: 'QEP 7.25" Glass Tile Nipper', list: 29.95, cost: 20.97 };
  assert.match(d.substituteProblem(qep7, { qty: 1, paidUnit: 68.99 }), /not a fair swap/);
  assert.match(d.substituteProblem(null), /no such product/);
});

// ── emails ───────────────────────────────────────────────────────────────────

const REC_1412 = {
  orderNumber: '1412', sku: '32014', itemName: ROW_1412.prosolGone.itemName, lineTitle: ROW_1412.prosolGone.itemName, qty: 1, paidUnit: 68.99,
  channel: 'shopify', status: 'proposed', customer: { firstName: 'Brenda', name: 'Brenda Pander-Scott', city: 'Asphodel Norwood', province: 'ON', email: 'Brenda.panderscott@gmail.com' },
  refund: { full: true, amount: 92.64 }, shopify: { id: FACTS_1412.id, productId: FACTS_1412.line.productId },
  gone: { evidence: ['no Prosol product with SKU 32014'] },
  substitute: { ...RUBI, displayName: 'Rubi Nipper for Glass Mosaic', kind: 'glass nipper', replyWord: 'Rubi', confidence: 'high', why: 'Same job.', inCustomerProvince: true },
};

test('offerEmail is the wording Mac approved for #1412', () => {
  const m = d.offerEmail(REC_1412);
  assert.strictEqual(m.subject, 'Your YourFloors order #1412');
  assert.strictEqual(m.text, `Hi Brenda,

Thanks for your order of the QEP Xtreme 8.25" Glass Tile Nipper with Pro Control Settings. Our supplier no longer carries it, so we can't ship that exact product.

We have the Rubi Nipper for Glass Mosaic in stock in Ontario, a comparable glass nipper, and we can send it at no extra cost.

Reply "Rubi" and we'll ship it right away. If you'd rather have a full refund of $92.64, reply "refund" and we'll process it the same day.

Looking forward to getting you set up.

Mac
YourFloors
`);
  assert.ok(!/—/.test(m.text), 'no em dashes in Mac\'s voice');
});

test('offerEmail drops the province when no stock is there, and offers a line refund on a multi-line order', () => {
  const m = d.offerEmail({ ...REC_1412, substitute: { ...REC_1412.substitute, inCustomerProvince: false }, refund: { full: false, amount: 77.95 } });
  assert.match(m.text, /We have the Rubi Nipper for Glass Mosaic in stock, a comparable/);
  assert.match(m.text, /If you'd rather have a refund of \$77\.95 for it, reply "refund"/);
});

test('refundEmail says "as you asked" after an offer, and that the rest ships on a line refund', () => {
  const after = d.refundEmail({ ...REC_1412, status: 'offered' }, 92.64, true).text;
  assert.match(after, /^Hi Brenda,\n\nAs you asked, we've refunded your order in full \(\$92\.64\) to your original payment method\./);
  const line = d.refundEmail(REC_1412, 77.95, false).text;
  assert.match(line, /Our supplier no longer carries the QEP Xtreme .*, so we've refunded it \(\$77\.95\).*The rest of your order ships as normal\./s);
});

test('macEmail for a Shopify proposal carries the facts and both taps; Amazon gets only "mark discontinued"', () => {
  const m = d.macEmail(REC_1412, { now: NOW });
  assert.strictEqual(m.subject, 'Not shipped: order 1412, Prosol no longer carries 32014');
  assert.match(m.text, /Substitute \(Opus, high confidence\): Rubi - Nipper for Glass Mosaic, Prosol 71970 \(product 14534\)\./);
  assert.match(m.text, /Our cost \$53\.73, list \$76\.75\. That leaves \$15\.26 a unit before the label\./);
  assert.match(m.text, /In stock: Concord 4, Saint-Laurent 3, Quebec 1, Chicoutimi 1\./);
  assert.match(m.text, /\/discontinued\/act\?o=1412&a=offer&t=[0-9a-f]{32}/);
  assert.match(m.text, /\/discontinued\/act\?o=1412&a=refund&t=/);
  const amz = d.macEmail({ ...REC_1412, channel: 'amazon', refund: undefined }, { now: NOW });
  assert.match(amz.text, /Cancel it in Seller Central/);
  assert.match(amz.text, /a=halt/);
  assert.doesNotMatch(amz.text, /a=offer|a=refund/);
});

test('tap tokens are bound to order, action, SKU and substitute', () => {
  const state = { orders: { 1412: REC_1412 } };
  const t = d.actionToken('1412', 'offer', REC_1412);
  assert.ok(d.verifyAction('1412', 'offer', t, state));
  assert.ok(d.verifyAction('#1412', 'offer', t, state));
  assert.strictEqual(d.verifyAction('1412', 'refund', t, state), null);
  assert.strictEqual(d.verifyAction('1412', 'offer', 'f'.repeat(32), state), null);
  const other = { orders: { 1412: { ...REC_1412, substitute: { ...REC_1412.substitute, productId: 18982 } } } };
  assert.strictEqual(d.verifyAction('1412', 'offer', t, other), null, 'a changed substitute voids the old link');
});

// ── the stage hook ───────────────────────────────────────────────────────────

test('handleStageResult: a confirmed-gone #1412 emails Mac one proposal, then a reminder only after a day', async () => {
  const { sent, opts } = deps();
  const r = await d.handleStageResult({ manualReview: [ROW_1412] }, opts);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.proposed, 1);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'mac@customfc.ca');
  assert.match(sent[0].text, /Prosol no longer carries SKU 32014/);
  const rec = d.loadState(opts.file).orders['1412'];
  assert.strictEqual(rec.status, 'proposed');
  assert.strictEqual(rec.substitute.productId, 14534);
  assert.strictEqual(rec.substitute.inCustomerProvince, true);
  assert.deepStrictEqual(rec.refund, { full: true, amount: 92.64 });

  await d.handleStageResult({ manualReview: [ROW_1412] }, { ...opts, now: new Date(NOW.getTime() + 4 * 36e5) });
  assert.strictEqual(sent.length, 1, 'no re-email within the day');
  const r3 = await d.handleStageResult({ manualReview: [ROW_1412] }, { ...opts, now: new Date(NOW.getTime() + 25 * 36e5) });
  assert.strictEqual(r3.reminded, 1);
  assert.match(sent[1].subject, /^STILL NOT SHIPPED: order 1412/);
});

test('handleStageResult: a lookup blip stays quiet, and only a lasting one emails "lookup failing"', async () => {
  const found = fakeClient({ 'filter[sku]=32014': [{ id: 82685, sku: '32014', name: 'QEP Xtreme' }] });
  const { sent, opts } = deps({ prosol: async () => found });
  await d.handleStageResult({ manualReview: [ROW_1412] }, opts);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(d.loadState(opts.file).orders['1412'].status, 'blip');
  await d.handleStageResult({ manualReview: [ROW_1412] }, { ...opts, now: new Date(NOW.getTime() + 3.5 * 36e5) });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /Prosol lookup failing for 32014/);
  assert.match(sent[0].text, /Prosol still lists the product: QEP Xtreme \(product 82685/);
});

test('handleStageResult: an order already refunded in Shopify is closed, not proposed', async () => {
  const { sent, opts } = deps({ facts: async () => ({ ...FACTS_1412, closedReason: 'refunded in full in Shopify' }) });
  const r = await d.handleStageResult({ manualReview: [ROW_1412] }, opts);
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(sent.length, 0);
});

test('handleStageResult: with no AI budget left the order waits for the next pass instead of mailing a half proposal', async () => {
  const rows = ['1412', '1413', '1414'].map((n, i) => ({ ...ROW_1412, orderNumber: n, prosolGone: { ...ROW_1412.prosolGone, sku: `S${i}` } }));
  const { sent, opts } = deps();
  const r = await d.handleStageResult({ manualReview: rows }, opts);
  assert.strictEqual(r.proposed, 2);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(d.loadState(opts.file).orders['1414'].status, 'checking');
});

test('handleStageResult: Opus picking a lesser item is refused by code and Mac gets refund-only', async () => {
  const { sent, opts } = deps({ details: async () => ({ ...RUBI, name: 'QEP 7.25" Glass Tile Nipper', list: 29.95, cost: 20.97 }) });
  await d.handleStageResult({ manualReview: [ROW_1412] }, opts);
  const rec = d.loadState(opts.file).orders['1412'];
  assert.strictEqual(rec.substitute, null);
  assert.match(rec.substituteNote, /not a fair swap/);
  assert.match(sent[0].text, /a=refund/);
  assert.doesNotMatch(sent[0].text, /a=offer/);
});

test('handleStageResult: Prosol unreachable three passes running emails a plain alert once', async () => {
  const { sent, opts } = deps({ prosol: async () => { throw new Error('login failed'); } });
  for (let i = 0; i < 4; i++) await d.handleStageResult({ manualReview: [ROW_1412] }, { ...opts, now: new Date(NOW.getTime() + i * 36e5) });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /could not reach Prosol on 3 passes: login failed/);
});

// ── taps ─────────────────────────────────────────────────────────────────────

function actDeps(file, over = {}) {
  const sent = [];
  const mapWrites = [];
  const gqlCalls = [];
  const map = { 32014: ENTRY_32014 };
  return {
    sent, mapWrites, gqlCalls,
    opts: {
      now: new Date('2026-10-11T18:31:00Z'), file,
      send: async (m) => { sent.push(m); return { messageId: '<x>' }; },
      setMapping: (k, e) => { mapWrites.push([k, e]); map[k] = e; },
      readMap: () => map,
      facts: async () => FACTS_1412,
      gql: async (q) => {
        gqlCalls.push(q);
        if (q.includes('product(id')) return { data: { product: { status: 'ACTIVE' } } };
        if (q.includes('productUpdate')) return { data: { productUpdate: { product: { status: 'DRAFT' }, userErrors: [] } } };
        if (q.includes('suggestedRefund')) return { data: { order: { suggestedRefund: { amountSet: { shopMoney: { amount: '92.64' } }, refundLineItems: [{ lineItem: { id: 'gid://shopify/LineItem/1' }, quantity: 1 }], suggestedTransactions: [{ gateway: 'shopify_payments', kind: 'SUGGESTED_REFUND', amountSet: { shopMoney: { amount: '92.64' } }, parentTransaction: { id: 'gid://shopify/OrderTransaction/9' } }] } } } };
        // A Shopify Payments refund is PENDING at first, and a pending refund's totalRefundedSet reads 0 (#1412).
        if (q.includes('refundCreate')) return { data: { refundCreate: { refund: { id: 'gid://shopify/Refund/1', totalRefundedSet: { shopMoney: { amount: '0.0' } } }, userErrors: [] } } };
        throw new Error(`unexpected gql ${q.slice(0, 40)}`);
      },
      ...over,
    },
  };
}

test('act offer: HALTs the SKU, drafts the listing, maps the substitute, then emails the customer', async () => {
  const file = tmpState();
  d.saveState({ orders: { 1412: REC_1412 } }, file);
  const { sent, mapWrites, opts } = actDeps(file);
  const r = await d.act('1412', 'offer', d.actionToken('1412', 'offer', REC_1412), opts);
  assert.ok(r.ok, r.message);
  assert.deepStrictEqual(mapWrites.map(([k]) => k), ['32014', '71970']);
  assert.strictEqual(mapWrites[0][1].api_sku, 'HALT_DISCONTINUED_32014');
  assert.strictEqual(mapWrites[0][1].prosol_sku, 'HALT_DISCONTINUED_Q32014QC');
  assert.deepStrictEqual({ api: mapWrites[1][1].api_sku, pro: mapWrites[1][1].prosol_sku, id: mapWrites[1][1].prosol_product_id }, { api: '71970', pro: 'R71970', id: 14534 });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].to, 'Brenda.panderscott@gmail.com');
  assert.strictEqual(sent[0].replyTo, 'hello@yourfloors.ca');
  assert.strictEqual(sent[1].to, 'mac@customfc.ca');
  assert.match(sent[1].text, /a=ship&t=[0-9a-f]{32}/);
  assert.match(sent[1].text, /a=refund&t=/);
  const rec = d.loadState(file).orders['1412'];
  assert.strictEqual(rec.status, 'offered');
  assert.deepStrictEqual({ before: rec.listing.before, after: rec.listing.after }, { before: 'ACTIVE', after: 'DRAFT' });
  // the same link can't fire twice
  const again = await d.act('1412', 'offer', d.actionToken('1412', 'offer', rec), opts);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(sent.length, 2);
});

test('act ship after an offer: the next staging pass sees the substitute', async () => {
  const file = tmpState();
  const offered = { ...REC_1412, status: 'offered', offeredAt: '2026-10-11T18:31:46Z' };
  d.saveState({ orders: { 1412: offered } }, file);
  const { sent, opts } = actDeps(file);
  const r = await d.act('1412', 'ship', d.actionToken('1412', 'ship', offered), opts);
  assert.ok(r.ok, r.message);
  assert.strictEqual(sent.length, 0, 'no customer email on ship');
  assert.strictEqual(d.applySwaps('1412', [{ sku: '32014', name: 'QEP' }], { file })[0].sku, '71970');
});

test('act refund: refunds in Shopify, records it before emailing, and the order stays open', async () => {
  const file = tmpState();
  d.saveState({ orders: { 1412: REC_1412 } }, file);
  const { sent, gqlCalls, opts } = actDeps(file);
  const r = await d.act('1412', 'refund', d.actionToken('1412', 'refund', REC_1412), opts);
  assert.ok(r.ok, r.message);
  const create = gqlCalls.find((q) => q.includes('refundCreate'));
  assert.ok(create);
  assert.ok(!gqlCalls.some((q) => /orderCancel/.test(q)), 'never cancels a paid order');
  assert.match(sent[0].text, /we've refunded your order in full \(\$92\.64\)/);
  assert.strictEqual(d.loadState(file).orders['1412'].status, 'refunded');
  assert.strictEqual(d.loadState(file).orders['1412'].refunded.amount, 92.64);
});

test('act stops cold when the order was refunded or fulfilled elsewhere', async () => {
  const file = tmpState();
  d.saveState({ orders: { 1412: REC_1412 } }, file);
  const { sent, mapWrites, opts } = actDeps(file, { facts: async () => ({ ...FACTS_1412, closedReason: 'fulfilled in Shopify' }) });
  const r = await d.act('1412', 'offer', d.actionToken('1412', 'offer', REC_1412), opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /fulfilled in Shopify/);
  assert.strictEqual(sent.length + mapWrites.length, 0);
});

test('an offered swap nudges Mac every three days, not daily', async () => {
  const file = tmpState();
  const offered = { ...REC_1412, status: 'offered', offeredAt: NOW.toISOString(), lastEmailAt: NOW.toISOString() };
  d.saveState({ orders: { 1412: offered } }, file);
  const { sent, opts } = deps({ file });
  await d.handleStageResult({ manualReview: [] }, { ...opts, file, now: new Date(NOW.getTime() + 30 * 36e5) });
  assert.strictEqual(sent.length, 0);
  await d.handleStageResult({ manualReview: [] }, { ...opts, file, now: new Date(NOW.getTime() + 73 * 36e5) });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /^No answer yet from Brenda to the swap offer on order 1412/);
});
