'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ac = require('./order-autocancel');

const BRANCHES = [
  { code: 'BURN', email: 'order.burnaby@prosol.ca', label: 'Burnaby' },
  { code: 'SECH', label: 'Sechelt' },
  { code: 'RICH', email: 'order.richmond@prosol.ca', label: 'Richmond' },
];

// #1444 as it stood at 7:14 PT on 2026-11-04: Burnaby counter pickup, PO sent the evening before, nothing refunded.
function pickupFacts() {
  return {
    sender: 'jesmyboy@yahoo.ca',
    branches: BRANCHES,
    lookup: { numbers: ['1444'] },
    order: {
      id: 'gid://shopify/Order/7384209359015', legacyId: '7384209359015', name: '#1444', email: 'jesmyboy@yahoo.ca', firstName: 'Jesse',
      cancelledAt: null, closed: false, financial: 'PAID', fulfillmentStatus: 'UNFULFILLED', total: '96.30', currency: 'CAD',
      fulfillments: [], refundCount: 0,
      transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', amount: '96.30', gateway: 'shopify_payments' }],
    },
    shipstation: { orders: [], labels: [] },
    opsState: { labels: [], emailed: [] },
    pickup: { kind: 'branch', branch: 'BURN', rec: { id: 'gid://shopify/Order/7384209359015', kind: 'branch', branch: 'BURN', status: 'PO_SENT', poNumber: 'PO-017678', poSentAt: '2026-11-03T23:45:00Z', done: { '#1444:branch_po': 'x' } } },
    erp: { so: { id: 'so1', number: 'SO-028020', status: 'open', processingFees: '2.80' }, pos: [{ id: 'po1', number: 'PO-017678', status: 'confirmed', vendorRef: '7005871', qtyReceived: 0 }] },
    refund: { amount: '96.30', locationId: 'gid://shopify/Location/87453499559', lineItems: [{ lineItemId: 'li1', quantity: 2, restockType: 'CANCEL' }],
      transactions: [{ parentId: 'gid://shopify/OrderTransaction/1', amount: '96.30', gateway: 'shopify_payments' }] },
  };
}

// A shipped order: label bought at Richmond, not yet scanned, branch already emailed.
function shippedFacts() {
  const f = pickupFacts();
  f.pickup = { kind: null, branch: null, rec: null };
  f.shipstation = { orders: [{ orderId: 810472227, orderNumber: '1444', orderStatus: 'awaiting_shipment' }],
    labels: [{ shipmentId: 470300001, trackingNumber: '520000000001', voided: false, unmoved: true, trackStatus: 'AC' },
      { shipmentId: 470300002, trackingNumber: '520000000002', voided: false, unmoved: true, trackStatus: 'AC' }] };
  f.opsState = { labels: [{ date: '2026-11-04', ssOrderId: '810472227', shipmentIds: [470300001, 470300002] }], emailed: [{ date: '2026-11-04', ssOrderId: '810472227', warehouse: 'Richmond (RICH)' }] };
  return f;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const holdsMatch = (ev, re) => ev.holds.some((h) => re.test(h));

test('labelUnmoved: only electronic submissions count as unmoved', () => {
  assert.equal(ac.labelUnmoved({ status_code: 'AC', events: [{ description: 'Shipment information electronically submitted', status_code: 'AC' }] }), true);
  assert.equal(ac.labelUnmoved({ status_code: 'NY', events: [] }), true);
  assert.equal(ac.labelUnmoved({ status_code: 'IT', events: [{ description: 'Picked up', status_code: 'IT' }] }), false);
  assert.equal(ac.labelUnmoved({ status_code: 'AC', events: [{ description: 'Electronically submitted' }, { description: 'Dropped off at Shoppers Drug Mart' }] }), false);
  assert.equal(ac.labelUnmoved({ status_code: 'UN', events: [{ description: 'Arrived at sort facility' }] }), false);
  assert.equal(ac.labelUnmoved(null), false);
});

test('branchCodeOf reads the warehouse name', () => {
  assert.equal(ac.branchCodeOf('Burnaby (BURN)'), 'BURN');
  assert.equal(ac.branchCodeOf('Edmonton North (EDMN)'), 'EDMN');
  assert.equal(ac.branchCodeOf('Sechelt'), null);
});

test('#1444 at 7:14: eligible, goods first, money last', () => {
  const ev = ac.evaluate(pickupFacts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(ev.plan.map((s) => s.type), ['pickup_cancel', 'branch_email', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
  const email = ev.plan.find((s) => s.type === 'branch_email');
  assert.deepEqual(email.to, ['KLazzarotto@prosol.ca', 'order.burnaby@prosol.ca']);
  assert.equal(email.cc, 'mac@customfc.ca');
  assert.match(email.text, /Please cancel PO-017678 \(your order 7005871\), YourFloors order #1444/);
  assert.match(email.text, /go back to stock/);
  assert.match(email.text, /Please reply to confirm\./);
  assert.match(email.text, /Thanks,\nMac$/);
  assert.doesNotMatch(email.text, /—/);
  assert.equal(ev.plan[ev.plan.length - 1].amount, 96.3);
});

test('shipped order: void every package, pull ops-state, remove from ShipStation, then branch email, ERP, refund', () => {
  const ev = ac.evaluate(shippedFacts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(ev.plan.map((s) => s.type), ['void_label', 'void_label', 'ops_state_remove', 'ss_remove', 'branch_email', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
  const email = ev.plan.find((s) => s.type === 'branch_email');
  assert.deepEqual(email.to, ['KLazzarotto@prosol.ca', 'order.richmond@prosol.ca']);
  assert.match(email.text, /520000000001, 520000000002\) has been voided/);
});

test('not yet staged: just ShipStation removal, ERP and refund, no branch email', () => {
  const f = shippedFacts();
  f.shipstation.labels = []; f.opsState = { labels: [], emailed: [] };
  const ev = ac.evaluate(f);
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(ev.plan.map((s) => s.type), ['ss_remove', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
});

test('already refunded (even PENDING) holds; the dry-run harness can look past it', () => {
  const f = pickupFacts();
  f.order.financial = 'REFUNDED'; f.order.refundCount = 1;
  f.order.transactions.push({ id: 't2', kind: 'REFUND', status: 'PENDING', amount: '96.30' });
  f.pickup.rec.status = 'CANCELLED';
  f.erp.so.status = 'cancelled'; f.erp.pos[0].status = 'cancelled';
  f.refund = { error: 'no refundable line items' };
  const ev = ac.evaluate(f);
  assert.equal(ev.eligible, false);
  assert.ok(holdsMatch(ev, /already has a refund/));
  const before = ac.evaluate(f, { ignoreCancelState: true });
  assert.equal(before.eligible, true, before.holds.join('; '));
  assert.deepEqual(before.plan.map((s) => s.type), ['pickup_cancel', 'branch_email', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
});

const HOLDS = [
  ['sender is not the order email', (f) => { f.sender = 'someone@else.ca'; }, /not the order's email/],
  ['order cancelled', (f) => { f.order.cancelledAt = '2026-11-04T10:00:00Z'; }, /already cancelled/],
  ['not paid', (f) => { f.order.financial = 'PENDING'; }, /not PAID/],
  ['over $500', (f) => { f.order.total = '500.01'; f.refund.amount = '500.01'; f.refund.transactions[0].amount = '500.01'; f.order.transactions[0].amount = '500.01'; }, /over the \$500\.00/],
  ['fulfilled in Shopify', (f) => { f.order.fulfillments = [{ id: 'f1', status: 'SUCCESS' }]; }, /fulfillment\(s\)/],
  ['pickup collected', (f) => { f.pickup.rec.status = 'PICKED_UP'; }, /PICKED_UP/],
  ['pickup collected by tap', (f) => { f.pickup.rec.pickedUpAt = '2026-11-04T18:00:00Z'; }, /collected/],
  ['coast pickup', (f) => { f.pickup.kind = 'coast'; f.pickup.rec.kind = 'coast'; }, /coast pickup/],
  ['two order numbers', (f) => { f.lookup.numbers = ['1444', '1445']; }, /2 order numbers/],
  ['number not found', (f) => { f.order = null; }, /not found/],
  ['no number, two open orders', (f) => { f.lookup = { numbers: [], openOrders: ['#1444', '#1440'] }; }, /2 open orders/],
  ['partial refund suggestion', (f) => { f.refund.amount = '90.00'; }, /not the full/],
  ['refund not against the sale', (f) => { f.refund.transactions[0].parentId = 'other'; }, /original payment/],
  ['ERP lookup failed', (f) => { f.erp = { error: 'ERP_BACKEND is salesforce, not automayt', pos: [] }; }, /Automayt check failed/],
  ['PO received', (f) => { f.erp.pos[0].qtyReceived = 2; }, /received/],
  ['Shopify lookup error', (f) => { f.lookup.error = 'timeout'; }, /could not look the order up/],
];
for (const [name, mut, re] of HOLDS) {
  test(`hold: ${name}`, () => {
    const f = pickupFacts(); mut(f);
    const ev = ac.evaluate(f);
    assert.equal(ev.eligible, false);
    assert.ok(holdsMatch(ev, re), `expected ${re} in ${JSON.stringify(ev.holds)}`);
  });
}

const SHIP_HOLDS = [
  ['label scanned', (f) => { f.shipstation.labels[1].unmoved = false; f.shipstation.labels[1].trackStatus = 'IT'; }, /carrier scan/],
  ['tracking unreadable', (f) => { f.shipstation.labels[0].trackError = 'track HTTP 500'; }, /could not read tracking/],
  ['ShipStation shipped', (f) => { f.shipstation.orders[0].orderStatus = 'shipped'; }, /marked shipped/],
  ['ShipStation unreachable', (f) => { f.shipstation.error = 'orders list HTTP 503'; }, /ShipStation check failed/],
  ['emailed branch has no order desk (Sechelt)', (f) => { f.opsState.emailed[0].warehouse = 'Sechelt (SECH)'; }, /no order desk/],
  ['branch told but no PO', (f) => { f.erp.pos = []; }, /no PO number/],
];
for (const [name, mut, re] of SHIP_HOLDS) {
  test(`hold (shipped): ${name}`, () => {
    const f = shippedFacts(); mut(f);
    const ev = ac.evaluate(f);
    assert.equal(ev.eligible, false);
    assert.ok(holdsMatch(ev, re), `expected ${re} in ${JSON.stringify(ev.holds)}`);
  });
}

test('one open order by email is enough without a number', () => {
  const f = pickupFacts(); f.lookup = { numbers: [], openOrders: ['#1444'] };
  assert.equal(ac.evaluate(f).eligible, true);
});

test('a voided label is ignored', () => {
  const f = shippedFacts(); f.shipstation.labels[1].voided = true; f.shipstation.labels[1].unmoved = false;
  const ev = ac.evaluate(f);
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.equal(ev.plan.filter((s) => s.type === 'void_label').length, 1);
});

test('execute stops at the first failing step and never reaches the refund', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const ev = ac.evaluate(pickupFacts());
  ev.order.name = `#9${Date.now() % 100000}`; // own journal file
  const calls = [];
  const deps = {
    pickupRunner: { loadState: () => ({ orders: {} }), saveState: () => calls.push('pickup') },
    emailer: { sendEmail: async () => { calls.push('email'); throw new Error('smtp down'); } },
    erp: { cancelPurchaseOrder: async () => calls.push('po'), cancelSalesOrder: async () => calls.push('so') },
    gql: async () => { calls.push('gql'); return {}; },
    audit: { log: () => {} },
  };
  const r = await ac.execute(ev, { requestNote: 'cancel', requestedAt: 'now' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed.key, 'branch_email');
  assert.deepEqual(calls, ['pickup', 'email']);
  fs.rmSync(r.journal, { force: true });
  void os; void path;
});
