const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { parseArgs, buildPlan, buildXml, readPages, createAttemptStore } = require('./amazon-refund');
const { run } = require('../scripts/ops/issue-refund');

const ORDER = '123-1234567-1234567';
const MARKETPLACE = 'A2EUQ1WTGCTBG2';
const amount = Amount => ({ Amount, CurrencyCode: 'CAD' });
const order = { AmazonOrderId: ORDER, FulfillmentChannel: 'MFN', OrderStatus: 'Shipped', MarketplaceId: MARKETPLACE, OrderTotal: amount('330.00') };
const items = [
  { OrderItemId: '111', SellerSKU: 'FIRST', QuantityOrdered: 2, ItemPrice: amount('100.00'), ItemTax: amount('10.00') },
  { OrderItemId: '222', SellerSKU: 'SECOND', QuantityOrdered: 1, ItemPrice: amount('200.00'), ItemTax: amount('20.00') },
];
const base = [`--order=${ORDER}`, '--reason=CouldNotShip'];
const partial = [...base, '--item=111:1'];
const commit = [...partial, '--commit', '--expected-total=55.00', '--evidence=Branch confirmed one unit missing; approval ref 42'];
const report = '<AmazonEnvelope><ProcessingReport><StatusCode>Complete</StatusCode><ProcessingSummary><MessagesProcessed>1</MessagesProcessed><MessagesSuccessful>1</MessagesSuccessful><MessagesWithError>0</MessagesWithError></ProcessingSummary></ProcessingReport></AmazonEnvelope>';

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), '');
  const store = createAttemptStore(dir);
  const calls = [], logs = [], audits = [];
  const json = (status, value) => ({ status, body: JSON.stringify(value) });
  const sp = {
    getOrder: async () => ({ payload: structuredClone(order) }),
    listFinancialEventsByOrder: async () => ({ payload: { FinancialEvents: {} } }),
    getOrderItems: async () => ({ payload: { OrderItems: structuredClone(items) } }),
    putToUrl: async (url, body) => { calls.push({ upload: body }); return { status: 200 }; },
    spApiRequest: async (method, endpoint, args) => {
      calls.push({ method, endpoint, args });
      if (method === 'POST' && endpoint.endsWith('/documents')) return json(201, { feedDocumentId: 'document-1', url: 'https://example.invalid/upload' });
      if (method === 'POST' && endpoint.endsWith('/feeds')) return json(202, { feedId: 'feed-1' });
      if (endpoint.endsWith('/feeds/feed-1')) return json(200, { processingStatus: 'DONE', resultFeedDocumentId: 'result-1' });
      if (endpoint.endsWith('/documents/result-1')) return json(200, { url: 'https://example.invalid/report', compressionAlgorithm: 'GZIP' });
      throw new Error('Unexpected mock API call');
    },
    ...overrides,
  };
  return { dir, calls, logs, audits, deps: { sp, store, seller: 'SELLER', marketplace: MARKETPLACE, log: line => logs.push(line), audit: { log: entry => audits.push(entry) }, sleep: async () => {}, getDocument: async () => zlib.gzipSync(report) } };
}

test('old implicit full refund invocation and missing commit approval fail offline', () => {
  assert.throws(() => parseArgs(base), /no implicit full refunds/);
  assert.throws(() => parseArgs([...partial, '--commit']), /expected-total/);
  assert.throws(() => parseArgs([...partial, '--commit', '--expected-total=55']), /evidence/);
  assert.throws(() => parseArgs([`--order=${ORDER}`, '--full']), /reason/);
});

test('typos, mixed scopes, duplicate selections and malformed quantities fail closed', () => {
  for (const args of [
    [...partial, '--ammount=55'], [...partial, '--full'], [...partial, '--item=111:1'],
    [...base, '--item=111:0'], [...base, '--item=111:-1'], [...base, '--item=111:1.5'],
    [...base, '--item=111:9007199254740992'], [...partial, '--commit=false'], [...partial, '--order=123-1234567-1234567'],
    [...partial, '--expected-total=NaN'], [...partial, '--expected-total=-1'], [...partial, '--expected-total=1.001'],
  ]) assert.throws(() => parseArgs(args), undefined, args.join(' '));
});

test('refunds one selected unit, including tax, and excludes the delivered sibling from XML', () => {
  const plan = buildPlan(order, items, parseArgs(partial));
  assert.equal(plan.totalCents, 5500);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].quantity, 1);
  const xml = buildXml(plan, 'SELLER');
  assert.match(xml, /<AmazonOrderItemCode>111<\/AmazonOrderItemCode>/);
  assert.doesNotMatch(xml, /<AmazonOrderItemCode>222<\/AmazonOrderItemCode>/);
  assert.match(xml, /<Type>Principal<\/Type><Amount currency="CAD">50.00/);
  assert.match(xml, /<Type>Tax<\/Type><Amount currency="CAD">5.00/);
  assert.match(xml, /<ActionType>Refund<\/ActionType>/);
  assert.match(xml, /<Quantity>1<\/Quantity>/);
});

test('incident regression: one of two identical rolls refunds 692.83, not 1385.66', () => {
  const twoRolls = [{ ...items[0], ItemPrice: amount('1205.18'), ItemTax: amount('180.48') }];
  const plan = buildPlan({ ...order, OrderTotal: amount('1385.66') }, twoRolls, parseArgs([...partial, '--expected-total=692.83']));
  assert.equal(plan.totalCents, 69283);
  assert.deepEqual(plan.items[0].components, { Principal: 60259, Tax: 9024, Shipping: 0, ShippingTax: 0 });
});

test('incident regression: missing grate selection excludes the delivered channel body', () => {
  const split = [
    { ...items[0], QuantityOrdered: 1, ItemPrice: amount('231.93'), ItemTax: amount('34.73') },
    { ...items[1], ItemPrice: amount('490.00'), ItemTax: amount('73.38') },
  ];
  const plan = buildPlan({ ...order, OrderTotal: amount('830.04') }, split, parseArgs(partial));
  assert.equal(plan.totalCents, 26666);
  assert.equal(plan.items.length, 1);
});

test('multiple selected lines are allowed, but selecting every unit requires --full', () => {
  assert.equal(buildPlan(order, items, parseArgs([...partial, '--item=222:1'])).totalCents, 27500);
  assert.throws(() => buildPlan(order, items, parseArgs([...base, '--item=111:2', '--item=222:1'])), /explicit --full/);
  assert.equal(buildPlan(order, items, parseArgs([...base, '--full'])).totalCents, 33000);
});

test('unknown IDs and excess quantities cannot widen the selection', () => {
  assert.throws(() => buildPlan(order, items, parseArgs([...base, '--item=333:1'])), /not on this order/);
  assert.throws(() => buildPlan(order, items, parseArgs([...base, '--item=111:3'])), /quantity/);
});

test('allocates shipping and shipping tax with exact cent rounding', () => {
  const sample = [{ ...items[0], QuantityOrdered: 3, ItemPrice: amount('10.00'), ItemTax: amount('1.01'), ShippingPrice: amount('2.00'), ShippingTax: amount('0.10') }];
  const plan = buildPlan({ ...order, OrderTotal: amount('13.11') }, sample, parseArgs(partial));
  assert.deepEqual(plan.items[0].components, { Principal: 333, Tax: 34, Shipping: 67, ShippingTax: 3 });
  assert.equal(plan.totalCents, 437);
});

test('promotions, extra charges, malformed money, inconsistent totals and duplicate API items stop planning', () => {
  for (const field of ['PromotionDiscount', 'ShippingDiscount', 'GiftWrapPrice', 'GiftWrapTax', 'CODFee']) {
    assert.throws(() => buildPlan(order, [{ ...items[0], [field]: amount('1.00') }, items[1]], parseArgs(partial)), /manual refund review/);
  }
  for (const value of ['NaN', '-10', '1.001', '', '9007199254740992']) {
    assert.throws(() => buildPlan(order, [{ ...items[0], ItemPrice: amount(value) }, items[1]], parseArgs(partial)));
  }
  assert.throws(() => buildPlan(order, [{ ...items[0], ItemPrice: undefined }, items[1]], parseArgs(partial)), /missing amount/);
  assert.throws(() => buildPlan({ ...order, OrderTotal: amount('331.00') }, items, parseArgs(partial)), /reconcile/);
  assert.throws(() => buildPlan(order, [items[0], items[0]], parseArgs(partial)), /duplicate/);
  assert.throws(() => buildPlan(order, items, parseArgs([...partial, '--expected-total=330.00'])), /does not match/);
});

test('FBA, other currencies, canceled orders and order-ID mismatch are rejected', () => {
  for (const patch of [{ FulfillmentChannel: 'AFN' }, { OrderTotal: { Amount: '330.00', CurrencyCode: 'USD' } }, { OrderStatus: 'Canceled' }, { AmazonOrderId: '999-1234567-1234567' }]) {
    assert.throws(() => buildPlan({ ...order, ...patch }, items, parseArgs(partial)));
  }
});

test('reads every item page and refuses malformed responses or pagination loops', async () => {
  const seen = [];
  const result = await readPages(async ({ nextToken }) => {
    seen.push(nextToken);
    return { payload: nextToken ? { OrderItems: [items[1]] } : { OrderItems: [items[0]], NextToken: 'page2' } };
  }, 'OrderItems');
  assert.deepEqual(result, items);
  assert.deepEqual(seen, [undefined, 'page2']);
  await assert.rejects(readPages(async () => ({}), 'FinancialEvents'), /Invalid/);
  await assert.rejects(readPages(async () => ({ FinancialEvents: null }), 'FinancialEvents'), /Invalid/);
  await assert.rejects(readPages(async () => ({ OrderItems: [], NextToken: 'loop' }), 'OrderItems'), /repeated/);
});

test('refunds and claims on a later financial page block all write calls', async t => {
  for (const event of ['RefundEventList', 'GuaranteeClaimEventList', 'ChargebackEventList']) {
    const h = harness(t, { listFinancialEventsByOrder: async (_, { nextToken }) => ({ payload: nextToken ? { FinancialEvents: { [event]: [{}] } } : { FinancialEvents: {}, NextToken: 'page2' } }) });
    await assert.rejects(run(commit, h.deps), /already exists/);
    assert.equal(h.calls.length, 0);
  }
});

test('dry-run prints exact selection but performs no writes or reservations', async t => {
  const h = harness(t);
  const result = await run(partial, h.deps);
  assert.equal(result.totalCents, 5500);
  assert.equal(h.calls.length, 0);
  assert.equal(h.audits.length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'refund-attempts')), false);
  assert.ok(h.logs.includes('DRY RUN — nothing submitted.'));
});

test('commit amount mismatch fails before any feed write or reservation', async t => {
  const h = harness(t);
  await assert.rejects(run(commit.map(a => a === '--expected-total=55.00' ? '--expected-total=330.00' : a), h.deps), /does not match/);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'refund-attempts')), false);
});

test('historical audit submissions block before API access, even with empty Amazon history', async t => {
  const h = harness(t, { getOrder: async () => { throw new Error('must not call API'); } });
  fs.writeFileSync(path.join(h.dir, 'audit.jsonl'), JSON.stringify({ action: 'amazon-refund-submitted', order: ORDER }) + '\n');
  await assert.rejects(run(commit, h.deps), /already submitted/);
});

test('missing or corrupt local history cannot be mistaken for no previous refunds', t => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.dir, 'audit.jsonl'), '{incomplete');
  assert.throws(() => h.deps.store.assertClear(ORDER), /Unreadable/);
  fs.unlinkSync(path.join(h.dir, 'audit.jsonl'));
  assert.throws(() => h.deps.store.assertClear(ORDER), /missing/);
});

test('exclusive reservation allows only one local attempt', t => {
  const h = harness(t);
  const plan = buildPlan(order, items, parseArgs(partial));
  h.deps.store.reserve(plan);
  assert.throws(() => createAttemptStore(h.dir).reserve(plan), /attempt exists/);
});

test('refund appearing on the final history refresh prevents the first feed write', async t => {
  let reads = 0;
  const h = harness(t, { listFinancialEventsByOrder: async () => ({ FinancialEvents: ++reads === 1 ? {} : { RefundEventList: [{}] } }) });
  await assert.rejects(run(commit, h.deps), /already exists/);
  assert.equal(h.calls.length, 0);
  assert.throws(() => h.deps.store.assertClear(ORDER), /attempt exists/);
});

test('successful mocked submission sends selected XML only and saves evidence plus processing report', async t => {
  const h = harness(t);
  const result = await run(commit, h.deps);
  assert.equal(result.feedId, 'feed-1');
  assert.equal(h.calls.filter(c => c.method === 'POST' && c.endpoint.endsWith('/feeds')).length, 1);
  assert.doesNotMatch(h.calls.find(c => c.upload).upload, /<AmazonOrderItemCode>222/);
  assert.equal(h.audits[0].amount, 55);
  assert.equal(h.audits[0].items[0].quantity, 1);
  assert.match(h.audits[0].evidence, /approval ref 42/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'refund-attempts', `${ORDER}.json`)));
  assert.equal(saved.status, 'processed');
  assert.equal(saved.processingReport, report);
  await assert.rejects(run(commit, h.deps), /attempt exists/);
});

test('ambiguous createFeed timeout keeps document ID and blocks retry across restarts', async t => {
  const h = harness(t);
  const api = h.deps.sp.spApiRequest;
  h.deps.sp.spApiRequest = async (method, endpoint, args) => {
    if (method === 'POST' && endpoint.endsWith('/feeds')) throw new Error('network timeout after possible acceptance');
    return api(method, endpoint, args);
  };
  await assert.rejects(run(commit, h.deps), /network timeout/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'refund-attempts', `${ORDER}.json`)));
  assert.equal(saved.status, 'submitting');
  assert.equal(saved.feedDocumentId, 'document-1');
  assert.throws(() => createAttemptStore(h.dir).assertClear(ORDER), /attempt exists/);
});

test('DONE is not success when the processing report has errors or is malformed', async t => {
  for (const result of [report.replace('<MessagesWithError>0', '<MessagesWithError>1'), '<html>error</html>']) {
    const h = harness(t);
    h.deps.getDocument = async () => zlib.gzipSync(result);
    await assert.rejects(run(commit, h.deps), /did not confirm/);
    const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'refund-attempts', `${ORDER}.json`)));
    assert.equal(saved.status, 'needs-review');
  }
});

test('fatal or pending feeds do not report success and retain retry protection', async t => {
  for (const status of ['FATAL', 'CANCELLED', 'IN_PROGRESS']) {
    const h = harness(t);
    const api = h.deps.sp.spApiRequest;
    h.deps.sp.spApiRequest = async (method, endpoint, args) => endpoint.endsWith('/feeds/feed-1') ? { status: 200, body: JSON.stringify({ processingStatus: status }) } : api(method, endpoint, args);
    await assert.rejects(run(commit, h.deps), /inspect Amazon|still pending/);
    assert.throws(() => h.deps.store.assertClear(ORDER), /attempt exists/);
  }
});

test('CLI help and invalid legacy invocation work without loading credentials', () => {
  const script = path.join(__dirname, '../scripts/ops/issue-refund.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: {} });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /OrderItemId/);
  const invalid = spawnSync(process.execPath, [script, ...base, '--commit'], { encoding: 'utf8', env: {} });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /no implicit full refunds/);
  assert.doesNotMatch(invalid.stdout, /dotenv/);
});
