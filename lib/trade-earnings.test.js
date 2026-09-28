// ProZone client-code earnings. Earnings are a promise to contractors and store
// credit calls have no idempotency, so the pure decisions are locked in here:
// who earns, on what base, when, and how a refund is clawed back.
// Run: `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const earn = require('./trade-earnings');

const SAM = 'gid://shopify/Customer/5001';
const BOB = 'gid://shopify/Customer/5002';
const CLIENT = 'gid://shopify/Customer/7001';
const codeTable = { 'PRO-SAMTILE': SAM, 'PRO-BOBFLOORS': BOB };
const RATE = 0.05; // PROPOSED (Z3)
const NOW = new Date('2026-10-20T12:00:00Z');
const opts = { codeTable, rate: RATE, now: NOW };

// A delivered, shipped client order: fulfilled 10 days before NOW.
function order(over = {}) {
  return {
    id: 'gid://shopify/Order/9001',
    name: '#1500',
    test: false,
    cancelledAt: null,
    customer: { id: CLIENT },
    discountCodes: ['pro-samtile'],
    currentSubtotalPriceSet: { shopMoney: { amount: '400.00' } },
    lineItems: { nodes: [
      { id: 'L1', currentQuantity: 2, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '150.00' } }, product: { tags: ['mapei'] } },
      { id: 'L2', currentQuantity: 1, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '100.00' } }, product: { tags: [] } },
    ] },
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [{ status: 'SUCCESS', createdAt: '2026-10-10T18:00:00Z' }],
    fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'SHIPPING' } }] },
    ...over,
  };
}

// Run nextAction until it settles, performing each step the way the CLI will.
function drive(o, entry, account, landed = true) {
  const steps = [];
  for (let i = 0; i < 10; i++) {
    const r = earn.nextAction(o, entry, account, opts);
    steps.push(r.action);
    if (r.action === 'none' || r.action === 'wait') return { entry, account, steps, last: r };
    if (r.action === 'credit' || r.action === 'debit') {
      const s = earn.settleInflight(r.entry, account, { landed, txId: `tx${i}`, now: NOW });
      entry = s.entry; account = s.account;
      if (!landed) return { entry, account, steps, last: r };
      continue;
    }
    if (r.entry) entry = r.entry;
    if (r.account) account = r.account;
  }
  throw new Error('did not settle');
}

test('a client code maps to its contractor, case-insensitively', () => {
  const a = earn.attribute(order({ discountCodes: ['Pro-SamTile'] }), codeTable);
  assert.equal(a.code, 'PRO-SAMTILE');
  assert.equal(a.contractorId, '5001');
});

test('earn = 5% of the current subtotal, rounded to the cent', () => {
  const c = earn.computeEarning(order({ currentSubtotalPriceSet: { shopMoney: { amount: '123.45' } }, lineItems: [] }), opts);
  assert.equal(c.attributable, true);
  assert.equal(c.baseCents, 12345);
  assert.equal(c.targetCents, 617, '6.1725 rounds to 6.17');
  assert.equal(earn.earnCents(1010, RATE), 51, '0.505 rounds half up');
});

test('lines tagged take-all-lot or prozone-exclude are taken out of the base', () => {
  const o = order({
    currentSubtotalPriceSet: { shopMoney: { amount: '1000.00' } },
    lineItems: { nodes: [
      { id: 'LOT', currentQuantity: 1, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '600.00' } }, product: { tags: ['Take-All-Lot'] } },
      { id: 'SIG', currentQuantity: 2, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '50.00' } }, tags: 'sigma, prozone-exclude' },
      { id: 'OK', currentQuantity: 3, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '100.00' } }, product: { tags: ['mapei'] } },
    ] },
  });
  const b = earn.earningBase(o);
  assert.equal(b.excludedCents, 70000);
  assert.equal(b.baseCents, 30000);
  assert.deepEqual(b.excludedLines, ['LOT', 'SIG']);
  assert.equal(earn.computeEarning(o, opts).targetCents, 1500);
});

test('self-referral: the contractor buying with their own code earns nothing (Z6)', () => {
  const c = earn.computeEarning(order({ customer: { id: SAM } }), opts);
  assert.equal(c.attributable, false);
  assert.equal(c.reason, 'self_referral');
  assert.equal(earn.nextAction(order({ customer: { id: '5001' } }), null, {}, opts).action, 'none');
});

test('guest checkout (customer null) is not a self-referral and earns', () => {
  const c = earn.computeEarning(order({ customer: null }), opts);
  assert.equal(c.attributable, true);
  assert.equal(c.targetCents, 2000);
});

test('two codes on one order: only one client code counts, never double', () => {
  const withWelcome = earn.computeEarning(order({ discountCodes: ['WELCOME10', 'PRO-SAMTILE'] }), opts);
  assert.equal(withWelcome.code, 'PRO-SAMTILE');
  assert.equal(withWelcome.targetCents, 2000);
  const twoPro = earn.computeEarning(order({ discountCodes: ['PRO-SAMTILE', 'pro-bobfloors'] }), opts);
  assert.equal(twoPro.code, 'PRO-SAMTILE', 'the first client code on the order');
  assert.equal(twoPro.contractorId, '5001');
  assert.equal(twoPro.targetCents, 2000, 'one earning, not two');
  assert.ok(twoPro.flags.includes('multiple_client_codes'), 'flagged for the weekly report');
});

test('no code, or a PRO- code nobody owns, earns nothing (and the unknown one is flagged)', () => {
  assert.equal(earn.nextAction(order({ discountCodes: [] }), null, {}, opts).reason, 'no_client_code');
  const r = earn.nextAction(order({ discountCodes: ['PRO-NOBODY'] }), null, {}, opts);
  assert.equal(r.action, 'none');
  assert.ok(r.flags.includes('unknown_client_code'));
});

test('test orders never earn', () => {
  assert.equal(earn.nextAction(order({ test: true }), null, {}, opts).reason, 'test_order');
});

test('the code table refuses one code pointing at two contractors', () => {
  assert.throws(() => earn.normalizeCodeTable([{ code: 'PRO-X', customerId: SAM }, { code: 'pro-x', customerId: BOB }]), /two customers/);
});

test('earned: shipped orders at deliveredAt or fulfilled + 7 days; pickups when picked up', () => {
  const fresh = order({ fulfillments: [{ status: 'SUCCESS', createdAt: '2026-10-18T18:00:00Z' }] });
  assert.equal(earn.earnedAt(fresh, { now: NOW }), null, 'shipped 2 days ago, no delivery date');
  const delivered = order({ fulfillments: [{ status: 'SUCCESS', createdAt: '2026-10-18T18:00:00Z', deliveredAt: '2026-10-19T20:00:00Z' }] });
  assert.equal(earn.earnedAt(delivered, { now: NOW }), '2026-10-19T20:00:00.000Z');
  const pickup = order({
    fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'PICK_UP' } }] },
    fulfillments: [{ status: 'SUCCESS', createdAt: '2026-10-19T22:00:00Z' }],
  });
  assert.equal(earn.earnedAt(pickup, { now: NOW }), '2026-10-19T22:00:00.000Z');
  assert.equal(earn.earnedAt(order({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }), { now: NOW }), null);
  assert.equal(earn.earnedAt(order({ fulfillments: [] }), { now: NOW }), null);
});

test('ledger: pending -> crediting -> credited, and nothing more once settled', () => {
  const o = order();
  const r1 = earn.nextAction(o, null, { balanceCents: 0, owedCents: 0 }, opts);
  assert.equal(r1.action, 'record');
  assert.equal(r1.entry.status, 'pending');
  assert.equal(r1.entry.targetCents, 2000);
  const r2 = earn.nextAction(o, r1.entry, { balanceCents: 0, owedCents: 0 }, opts);
  assert.equal(r2.action, 'credit');
  assert.equal(r2.amountCents, 2000);
  assert.equal(r2.entry.status, 'crediting');
  const s = earn.settleInflight(r2.entry, { balanceCents: 0, owedCents: 0 }, { landed: true, txId: 'tx1', now: NOW });
  assert.equal(s.entry.status, 'credited');
  assert.equal(s.entry.settledCents, 2000);
  assert.deepEqual(s.entry.txIds, ['tx1']);
  assert.equal(s.account.balanceCents, 2000);
  assert.equal(earn.nextAction(o, s.entry, s.account, opts).reason, 'settled');
});

test('not delivered yet: the entry waits; a refund before delivery just lowers the target', () => {
  const o = order({ fulfillments: [] });
  const rec = earn.nextAction(o, null, {}, opts).entry;
  assert.equal(earn.nextAction(o, rec, {}, opts).action, 'wait');
  const refunded = order({ fulfillments: [], currentSubtotalPriceSet: { shopMoney: { amount: '300.00' } } });
  const u = earn.nextAction(refunded, rec, {}, opts);
  assert.equal(u.action, 'update');
  assert.equal(u.entry.targetCents, 1500);
});

test('an entry left mid-flight is recovered, never re-credited blind', () => {
  const o = order();
  const rec = earn.nextAction(o, null, {}, opts).entry;
  const c = earn.nextAction(o, rec, {}, opts);
  const again = earn.nextAction(o, c.entry, {}, opts);
  assert.equal(again.action, 'recover');
  const back = earn.settleInflight(c.entry, {}, { landed: false, now: NOW });
  assert.equal(back.entry.status, 'pending', 'did not land: back to where it was');
  assert.equal(back.entry.settledCents, 0);
  assert.equal(earn.nextAction(o, back.entry, {}, opts).action, 'credit');
});

test('cancelled before it earned: the pending entry is voided with no store credit', () => {
  const o = order({ fulfillments: [] });
  const rec = earn.nextAction(o, null, {}, opts).entry;
  const v = earn.nextAction(order({ fulfillments: [], cancelledAt: '2026-10-15T00:00:00Z', currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } } }), rec, {}, opts);
  assert.equal(v.action, 'void');
  assert.equal(v.entry.status, 'void');
  assert.equal(earn.nextAction(o, v.entry, {}, opts).action, 'none');
});

test('full refund after credit: the whole earning is debited back', () => {
  const settled = drive(order(), null, { balanceCents: 0, owedCents: 0 });
  assert.equal(settled.entry.settledCents, 2000);
  const refunded = order({ currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } } });
  const d = earn.nextAction(refunded, settled.entry, settled.account, opts);
  assert.equal(d.action, 'debit');
  assert.equal(d.amountCents, 2000);
  assert.equal(d.entry.status, 'debiting');
  const s = earn.settleInflight(d.entry, settled.account, { landed: true, txId: 'd1', now: NOW });
  assert.equal(s.entry.status, 'credited');
  assert.equal(s.entry.settledCents, 0);
  assert.equal(s.account.balanceCents, 0);
  assert.equal(s.account.owedCents, 0);
});

test('partial refund after credit: only the difference is clawed back', () => {
  const settled = drive(order(), null, { balanceCents: 0, owedCents: 0 });
  const partial = order({ currentSubtotalPriceSet: { shopMoney: { amount: '250.00' } } });
  const d = earn.nextAction(partial, settled.entry, settled.account, opts);
  assert.equal(d.action, 'debit');
  assert.equal(d.amountCents, 750, '$20.00 earned, now $12.50');
  const s = earn.settleInflight(d.entry, settled.account, { landed: true, now: NOW });
  assert.equal(s.entry.settledCents, 1250);
  assert.equal(s.account.balanceCents, 1250);
});

test('owed carry: the debit stops at the balance, the rest is owed and comes out of the next earning', () => {
  const settled = drive(order(), null, { balanceCents: 0, owedCents: 0 });
  // Contractor spent $15 of the $20 credit. Then the client's order is fully refunded.
  const spent = { balanceCents: 500, owedCents: 0 };
  const refunded = order({ currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } } });
  const d = earn.nextAction(refunded, settled.entry, spent, opts);
  assert.equal(d.action, 'debit');
  assert.equal(d.amountCents, 500, 'never more than the balance');
  const s = earn.settleInflight(d.entry, spent, { landed: true, now: NOW });
  assert.equal(s.account.balanceCents, 0);
  assert.equal(s.account.owedCents, 1500, 'the rest is carried as owed');
  assert.equal(s.entry.settledCents, 0);

  // Zero balance: nothing to debit, all of it is carried (no Shopify call).
  const zero = earn.nextAction(refunded, settled.entry, { balanceCents: 0, owedCents: 0 }, opts);
  assert.equal(zero.action, 'carry_owed');
  assert.equal(zero.account.owedCents, 2000);

  // Next client order earns $10.00: all of it pays off owed, no credit issued.
  const next = order({ id: 'gid://shopify/Order/9002', name: '#1501', currentSubtotalPriceSet: { shopMoney: { amount: '200.00' } } });
  const small = drive(next, null, s.account);
  assert.deepEqual(small.steps, ['record', 'apply_owed', 'none']);
  assert.equal(small.account.owedCents, 500);
  assert.equal(small.account.balanceCents, 0);
  assert.equal(small.entry.settledCents, 1000);

  // Another $20.00 earning: $5.00 pays off the rest of owed, $15.00 is credited.
  const third = order({ id: 'gid://shopify/Order/9003', name: '#1502' });
  const r = earn.nextAction(third, earn.nextAction(third, null, small.account, opts).entry, small.account, opts);
  assert.equal(r.action, 'credit');
  assert.equal(r.amountCents, 1500);
  const done = earn.settleInflight(r.entry, small.account, { landed: true, now: NOW });
  assert.equal(done.account.owedCents, 0);
  assert.equal(done.account.balanceCents, 1500);
  assert.equal(done.entry.settledCents, 2000);
});
