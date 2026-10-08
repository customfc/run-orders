const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = require('./trade-earnings-run');

const MEMBER = 'gid://shopify/Customer/111';
const NOW = new Date('2026-10-12T15:00:00Z');
const RATE = 0.05;

function order(name, o = {}) {
  return {
    id: `gid://shopify/Order/${name.replace('#', '')}`, name, test: false, cancelledAt: null, discountCodes: ['PRO-ACME'],
    customer: { id: 'gid://shopify/Customer/900' }, currentSubtotalPriceSet: { shopMoney: { amount: '200.00' } },
    displayFulfillmentStatus: 'FULFILLED', shippingLine: { title: 'Purolator Ground' },
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: '2026-10-01T18:00:00Z', deliveredAt: '2026-10-03T18:00:00Z' }],
    fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'SHIPPING' } }] },
    lineItems: { nodes: [{ id: 'l1', sku: 'J80BW', currentQuantity: 1, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '200.00' } }, product: { productType: 'Schluter Profile', tags: [] } }] },
    ...o,
  };
}

/** A fake Admin API: one member with code PRO-ACME, orders, and a CAD store credit account. */
function fakeShop(orders, { failCredit = false } = {}) {
  const shop = { orders: new Map(orders.map((o) => [o.id, o])), balance: 0, tx: [], calls: [], failCredit };
  shop.gql = async (q, v = {}) => {
    shop.calls.push(q.slice(0, 40));
    if (q.includes('discountNodes')) {
      return { data: { discountNodes: { nodes: [
        { discount: { __typename: 'DiscountAutomaticBasic', title: 'ProZone 20%', context: { customers: [{ id: MEMBER }] } } },
        { discount: { __typename: 'DiscountCodeBasic', title: 'ProZone client', codes: { nodes: [{ code: 'PRO-ACME' }, { code: 'PRO-MACTEST' }] } } },
      ] } } };
    }
    if (q.includes('displayName')) {
      return { data: { customer: { id: MEMBER, displayName: 'Ann Lee', email: 'ann@acme.ca', code: { value: 'PRO-ACME' }, business: { value: 'Acme Tile' } } } };
    }
    if (q.includes('orders(first: 50')) {
      const code = v.q.replace('discount_code:', '');
      return { data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...shop.orders.values()].filter((o) => o.discountCodes.includes(code)) } } };
    }
    if (q.includes('nodes(ids:')) return { data: { nodes: v.ids.map((id) => shop.orders.get(id) || null) } };
    if (q.includes('order(id:')) return { data: { order: shop.orders.get(v.id) || null } };
    if (q.includes('storeCreditAccounts')) {
      return { data: { customer: { storeCreditAccounts: { nodes: shop.balance || shop.tx.length ? [{ id: 'gid://shopify/StoreCreditAccount/5', balance: { amount: (shop.balance / 100).toFixed(2), currencyCode: 'CAD' },
        transactions: { nodes: shop.tx.map((t) => ({ __typename: t.kind === 'credit' ? 'StoreCreditAccountCreditTransaction' : 'StoreCreditAccountDebitTransaction', id: t.id, amount: { amount: ((t.kind === 'credit' ? 1 : -1) * t.cents / 100).toFixed(2) }, createdAt: t.createdAt })) } }] : [] } } } };
    }
    if (q.includes('storeCreditAccountCredit')) {
      const cents = Math.round(Number(v.i.creditAmount.amount) * 100);
      shop.balance += cents;
      const t = { id: `gid://shopify/StoreCreditAccountCreditTransaction/${shop.tx.length + 1}`, kind: 'credit', cents, createdAt: NOW.toISOString() };
      shop.tx.push(t);
      if (shop.failCredit) { shop.failCredit = false; throw new Error('socket hang up'); } // landed, but we never heard
      return { data: { storeCreditAccountCredit: { storeCreditAccountTransaction: { id: t.id }, userErrors: [] } } };
    }
    if (q.includes('storeCreditAccountDebit')) {
      const cents = Math.round(Number(v.i.debitAmount.amount) * 100);
      shop.balance -= cents;
      const t = { id: `gid://shopify/StoreCreditAccountDebitTransaction/${shop.tx.length + 1}`, kind: 'debit', cents, createdAt: NOW.toISOString() };
      shop.tx.push(t);
      return { data: { storeCreditAccountDebit: { storeCreditAccountTransaction: { id: t.id }, userErrors: [] } } };
    }
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  };
  return shop;
}

const fresh = () => ({ orders: {}, accounts: {}, batch: null });
const noSave = () => {};

test('propose: credits a delivered client order, records a waiting one, ignores self-referral; moves no money', async () => {
  const shop = fakeShop([
    order('#2001'),
    order('#2002', { displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [] }),
    order('#2003', { customer: { id: MEMBER } }),
  ]);
  const state = fresh();
  const { batch, counts } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  assert.deepEqual(batch.items.map((i) => [i.orderName, i.kind, i.amountCents, i.code, i.who.business]), [['#2001', 'credit', 1000, 'PRO-ACME', 'Acme Tile']]);
  assert.equal(state.orders['gid://shopify/Order/2001'].status, 'pending'); // in-flight is only written at apply time
  assert.equal(state.orders['gid://shopify/Order/2002'].status, 'pending');
  assert.equal(state.orders['gid://shopify/Order/2003'], undefined);
  assert.equal(counts.waiting, 1);
  assert.equal(shop.balance, 0);
  assert.ok(!shop.calls.some((c) => /storeCreditAccount(Credit|Debit)/.test(c)));
  const mail = run.macEmail(batch);
  assert.match(mail.subject, /1 to approve \(\$10\.00 credit\)/);
});

test('apply: issues the credit, settles the ledger, and refuses a second apply of the same batch', async () => {
  const shop = fakeShop([order('#2001')]);
  const state = fresh();
  const { batch } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  const { results } = await run.apply(shop.gql, batch.id, { rate: RATE, now: NOW, state, save: noSave });
  assert.deepEqual(results.map((r) => [r.orderName, r.outcome, r.amountCents]), [['#2001', 'credited', 1000]]);
  assert.equal(shop.balance, 1000);
  const e = state.orders['gid://shopify/Order/2001'];
  assert.equal(e.status, 'credited');
  assert.equal(e.settledCents, 1000);
  assert.equal(e.txIds.length, 1);
  await assert.rejects(run.apply(shop.gql, batch.id, { rate: RATE, now: NOW, state, save: noSave }), /already applied/);
  const again = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  assert.equal(again.batch.items.length, 0); // nothing new to do
});

test('apply skips a move that changed since the proposal; next week proposes the new amount', async () => {
  const o = order('#2001');
  const shop = fakeShop([o]);
  const state = fresh();
  const { batch } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  o.currentSubtotalPriceSet = { shopMoney: { amount: '100.00' } }; // partial refund before Mac tapped
  const { results } = await run.apply(shop.gql, batch.id, { rate: RATE, now: NOW, state, save: noSave });
  assert.equal(results[0].outcome, 'skipped');
  assert.equal(shop.balance, 0);
  const next = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  assert.deepEqual(next.batch.items.map((i) => [i.kind, i.amountCents]), [['credit', 500]]);
});

test('a refund after the credit is taken back (debit), up to the balance', async () => {
  const o = order('#2001');
  const shop = fakeShop([o]);
  const state = fresh();
  let { batch } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  await run.apply(shop.gql, batch.id, { rate: RATE, now: NOW, state, save: noSave });
  o.currentSubtotalPriceSet = { shopMoney: { amount: '100.00' } };
  ({ batch } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave }));
  assert.deepEqual(batch.items.map((i) => [i.kind, i.amountCents]), [['debit', 500]]);
  const { results } = await run.apply(shop.gql, batch.id, { rate: RATE, now: NOW, state, save: noSave });
  assert.equal(results[0].outcome, 'debited');
  assert.equal(shop.balance, 500);
  assert.equal(state.orders['gid://shopify/Order/2001'].settledCents, 500);
});

test('a credit whose answer never came back stays in flight and is recovered from the account, not repeated', async () => {
  const shop = fakeShop([order('#2001')], { failCredit: true });
  const state = fresh();
  let { batch } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave });
  const first = await run.apply(shop.gql, batch.id, { rate: RATE, now: NOW, state, save: noSave });
  assert.equal(first.results[0].outcome, 'unknown');
  assert.equal(state.orders['gid://shopify/Order/2001'].status, 'crediting');
  ({ batch } = await run.propose(shop.gql, { rate: RATE, now: NOW, state, save: noSave }));
  assert.deepEqual(batch.items.map((i) => i.kind), ['recover']);
  const later = new Date(NOW.getTime() + 20 * 60 * 1000);
  const second = await run.apply(shop.gql, batch.id, { rate: RATE, now: later, state, save: noSave });
  assert.equal(second.results[0].outcome, 'recovered');
  assert.equal(shop.balance, 1000); // credited once, not twice
  assert.equal(state.orders['gid://shopify/Order/2001'].status, 'credited');
  assert.equal(state.orders['gid://shopify/Order/2001'].settledCents, 1000);
});

test('findLanded: too early is null; after the grace with no transaction it did not land; claimed ids are skipped', () => {
  const entry = { inflight: { kind: 'credit', amountCents: 1000, at: NOW.toISOString() } };
  const none = { transactions: [] };
  assert.equal(run.findLanded(entry, none, NOW.getTime() + 60 * 1000), null);
  assert.deepEqual(run.findLanded(entry, none, NOW.getTime() + 20 * 60 * 1000), { landed: false, txId: null });
  const acc = { transactions: [{ id: 't1', kind: 'credit', cents: 1000, createdAt: NOW.toISOString() }] };
  assert.deepEqual(run.findLanded(entry, acc, NOW.getTime()), { landed: true, txId: 't1' });
  assert.equal(run.findLanded(entry, acc, NOW.getTime(), new Set(['t1'])), null);
});

test('state: a missing file starts empty; a corrupt file stops the run; the lock is exclusive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earn-'));
  assert.deepEqual(run.loadState(path.join(dir, 'none.json')), fresh());
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  assert.throws(() => run.loadState(path.join(dir, 'bad.json')));
  const lock = path.join(dir, 'x.lock');
  let inner;
  await run.withLock(async () => { inner = await assert.rejects(run.withLock(async () => 1, lock), /in progress/); }, lock);
  assert.equal(fs.existsSync(lock), false);
});

test('signed link: verifies only its own batch id', () => {
  const s = 'k';
  assert.equal(run.verify('eb-1', run.token('eb-1', s), s), true);
  assert.equal(run.verify('eb-2', run.token('eb-1', s), s), false);
  assert.equal(run.verify('eb-1', 'short', s), false);
  assert.match(run.reviewPage({ id: 'eb-1', items: [{ kind: 'credit', amountCents: 1000, contractorId: '1', code: '<x>', orderName: '#1', who: null }], appliedAt: null }, 't'), /&lt;x&gt;/);
});
