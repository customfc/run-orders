'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ac = require('./order-autocancel');

const BRANCHES = [
  { code: 'BURN', email: 'order.burnaby@prosol.ca', pickup_label: 'Burnaby' },
  { code: 'SECH', pickup_label: 'Sechelt' },
  { code: 'RICH', email: 'order.richmond@prosol.ca', pickup_label: 'Richmond' },
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const holdsMatch = (ev, re) => ev.holds.some((h) => re.test(h));
const types = (ev) => ev.plan.map((s) => s.type);

// #1444 as it stood at 06:14 PT on 2026-11-04: Burnaby counter pickup, PO sent the evening before, nothing refunded.
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
    refund: { amount: '96.30', transactions: [{ parentId: 'gid://shopify/OrderTransaction/1', amount: '96.30', gateway: 'shopify_payments' }] },
  };
}

// A shipping order not yet staged: in ShipStation awaiting_shipment, no label.
function unstagedFacts() {
  const f = pickupFacts();
  f.pickup = { kind: null, branch: null, rec: null };
  f.shipstation = { orders: [{ orderId: 810472227, orderNumber: '1444', orderStatus: 'awaiting_shipment' }], labels: [] };
  f.erp.pos[0].vendorRef = null;
  return f;
}

// Stage 1: a stage pass bought one Purolator label at Richmond (ShipStation shipped, Shopify fulfilled + archived),
// branch NOT emailed yet, carrier has only "electronically submitted".
function stage1Facts() {
  const f = unstagedFacts();
  f.order.fulfillmentStatus = 'FULFILLED'; f.order.closed = true;
  f.order.fulfillments = [{ id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', displayStatus: 'FULFILLED', inTransitAt: null, deliveredAt: null, tracking: ['520000000001'], methods: ['SHIPPING'] }];
  f.shipstation.orders[0].orderStatus = 'shipped';
  f.shipstation.labels = [{ shipmentId: 470300001, trackingNumber: '520000000001', voided: false, unmoved: true, trackStatus: 'AC', carrierCode: 'purolator_walleted', warehouseId: 1869865 }];
  f.opsState = { labels: [{ date: '2026-11-04', ssOrderId: '810472227', shipmentIds: [470300001], warehouseId: 1869865 }], emailed: [] };
  return f;
}
// Stage 2: same, the 14:00 ET email pass already told Richmond.
function stage2Facts() {
  const f = stage1Facts();
  f.opsState.emailed = [{ date: '2026-11-04', ssOrderId: '810472227', warehouse: 'Richmond (RICH)' }];
  return f;
}
// Multi-package: two Purolator packages under one ShipStation order, one Shopify fulfillment carrying both numbers.
function multiFacts() {
  const f = stage2Facts();
  f.shipstation.labels.push({ shipmentId: 470300002, trackingNumber: '520000000002', voided: false, unmoved: true, trackStatus: 'AC', carrierCode: 'purolator_walleted', warehouseId: 1869865 });
  f.opsState.labels[0].shipmentIds = [470300001, 470300002];
  f.order.fulfillments[0].tracking = ['520000000001', '520000000002'];
  return f;
}

// ── labelUnmoved ──
test('labelUnmoved: only label-only events count as unmoved', () => {
  assert.equal(ac.labelUnmoved({ status_code: 'AC', events: [{ description: 'Label information electronically submitted', status_code: 'AC' }] }), true);
  assert.equal(ac.labelUnmoved({ status_code: 'NY', events: [{ description: 'Shipper created a label', status_code: 'NY' }] }), true);
  assert.equal(ac.labelUnmoved({ status_code: 'NY', events: [] }), true);
  assert.equal(ac.labelUnmoved({ status_code: 'IT', events: [{ description: 'Picked up', status_code: 'IT' }] }), false);
  // #1441 (real, 2026-11-04): Purolator's pickup scan comes through with status_code AC
  assert.equal(ac.labelUnmoved({ status_code: 'AC', events: [{ status_code: 'AC', description: 'Picked up by Purolator at' }, { status_code: 'AC', description: 'Label information electronically submitted' }, { status_code: 'NY', description: 'Shipper created a label' }] }), false);
  assert.equal(ac.labelUnmoved({ status_code: 'AC', events: [{ description: 'Electronically submitted' }, { description: 'Dropped off at Shoppers Drug Mart' }] }), false);
  assert.equal(ac.labelUnmoved({ status_code: 'UN', events: [{ description: 'Arrived at sort facility' }] }), false);
  assert.equal(ac.labelUnmoved(null), false);
});

test('branchCodeOf / carrierName', () => {
  assert.equal(ac.branchCodeOf('Burnaby (BURN)'), 'BURN');
  assert.equal(ac.branchCodeOf('Sechelt'), null);
  assert.equal(ac.carrierName('purolator_walleted'), 'Purolator');
  assert.equal(ac.carrierName('ups_walleted'), 'UPS');
  assert.equal(ac.carrierName('canada_post_walleted'), 'Canada Post');
});

// ── pickup (#1444) ──
test('#1444 at 06:14: eligible, goods first, money last', () => {
  const ev = ac.evaluate(pickupFacts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(types(ev), ['pickup_cancel', 'branch_email', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
  const email = ev.plan.find((s) => s.type === 'branch_email');
  assert.deepEqual(email.to, ['KLazzarotto@prosol.ca', 'order.burnaby@prosol.ca']);
  assert.equal(email.cc, 'mac@customfc.ca');
  assert.match(email.text, /^Hi Kaitlyn and Burnaby team,/);
  assert.match(email.text, /Please cancel PO-017678 \(your order 7005871\), YourFloors order #1444/);
  assert.match(email.text, /go back to stock/);
  assert.match(email.text, /Please reply to confirm\.\n\nThanks,\nMac$/);
  assert.doesNotMatch(email.text, /—/);
  assert.equal(ev.plan[ev.plan.length - 1].amount, 96.3);
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
  assert.deepEqual(types(before), ['pickup_cancel', 'branch_email', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
});

// ── shipping orders ──
test('not yet staged: ShipStation removal, ERP and refund only', () => {
  const ev = ac.evaluate(unstagedFacts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(types(ev), ['ss_remove', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
});

test('stage 1, our unscanned label + our fulfillment (ShipStation shipped, Shopify fulfilled+archived): eligible, no Prosol email', () => {
  const ev = ac.evaluate(stage1Facts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(types(ev), ['void_label', 'ops_state_remove', 'order_open', 'fulfillment_cancel', 'ss_remove', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
  assert.deepEqual(ev.plan.find((s) => s.type === 'refund').recheckShipmentIds, [470300001]);
  assert.ok(!types(ev).includes('branch_email'));
});

test('stage 2, branch already emailed: the pull-the-box email goes right after the void, before Shopify/ShipStation housekeeping', () => {
  const ev = ac.evaluate(stage2Facts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(types(ev), ['void_label', 'ops_state_remove', 'branch_email', 'order_open', 'fulfillment_cancel', 'ss_remove', 'erp_cancel_po', 'erp_cancel_so', 'refund']);
  const email = ev.plan.find((s) => s.type === 'branch_email');
  assert.deepEqual(email.to, ['KLazzarotto@prosol.ca', 'order.richmond@prosol.ca']);
  assert.equal(email.subject, 'Please pull PO-017678 (YourFloors #1444), cancelled');
  assert.match(email.text, /^Hi Kaitlyn and Richmond team,\n\nPlease pull the box for PO-017678, YourFloors order #1444, and don't hand it to Purolator\. The customer cancelled\. The label \(520000000001\) has been voided\. The contents can go back to stock\.\n\nPlease reply to confirm\.\n\nThanks,\nMac$/);
});

test('multi-package: every package voided, one fulfillment with both numbers is ours, plural email', () => {
  const ev = ac.evaluate(multiFacts());
  assert.equal(ev.eligible, true, ev.holds.join('; '));
  assert.deepEqual(ev.plan.filter((s) => s.type === 'void_label').map((s) => s.shipmentId), [470300001, 470300002]);
  assert.deepEqual(ev.plan.find((s) => s.type === 'refund').recheckShipmentIds, [470300001, 470300002]);
  const email = ev.plan.find((s) => s.type === 'branch_email');
  assert.match(email.text, /pull the boxes for PO-017678.*don't hand them to Purolator.*The labels \(520000000001, 520000000002\) have been voided/s);
});

test('multi-package: a scan on ONE package holds the whole order', () => {
  const f = multiFacts(); f.shipstation.labels[1].unmoved = false; f.shipstation.labels[1].trackStatus = 'IT'; f.shipstation.labels[1].events = ['IT Picked up'];
  const ev = ac.evaluate(f);
  assert.equal(ev.eligible, false);
  assert.ok(holdsMatch(ev, /520000000002 has a carrier scan \(IT: IT Picked up\)/));
});

test('dry-run harness --ignore-scans reads a scanned label as unmoved (never used to commit)', () => {
  const f = stage2Facts(); f.shipstation.labels[0].unmoved = false; f.shipstation.labels[0].trackStatus = 'DE';
  assert.equal(ac.evaluate(f).eligible, false);
  assert.equal(ac.evaluate(f, { ignoreScans: true }).eligible, true);
});

const SHIP_HOLDS = [
  ['label scanned', stage2Facts, (f) => { f.shipstation.labels[0].unmoved = false; f.shipstation.labels[0].trackStatus = 'IT'; }, /carrier scan/],
  ['tracking unreadable', stage2Facts, (f) => { f.shipstation.labels[0].trackError = 'track HTTP 500'; }, /could not read tracking/],
  ['foreign fulfillment tracking', stage1Facts, (f) => { f.order.fulfillments[0].tracking = ['1Z999']; }, /1Z999 is not a live label we bought/],
  ['fulfillment carries a voided label number', stage1Facts, (f) => { f.shipstation.labels[0].voided = true; }, /not a live label we bought/],
  ['untracked fulfillment', stage1Facts, (f) => { f.order.fulfillments[0].tracking = []; }, /no tracking number/],
  ['second, hand-made fulfillment', stage1Facts, (f) => { f.order.fulfillments.push({ id: 'gid://shopify/Fulfillment/2', status: 'SUCCESS', tracking: [], methods: ['SHIPPING'] }); }, /Fulfillment\/2 has no tracking/],
  ['Shopify says in transit', stage1Facts, (f) => { f.order.fulfillments[0].inTransitAt = '2026-11-04T22:00:00Z'; }, /in transit/],
  ['Shopify says delivered', stage1Facts, (f) => { f.order.fulfillments[0].deliveredAt = '2026-11-05T22:00:00Z'; }, /delivered/],
  ['Shopify fulfillment display OUT_FOR_DELIVERY', stage1Facts, (f) => { f.order.fulfillments[0].displayStatus = 'OUT_FOR_DELIVERY'; }, /OUT_FOR_DELIVERY/],
  ['ShipStation shipped with no label we know', stage1Facts, (f) => { f.shipstation.labels = []; f.order.fulfillments = []; f.order.fulfillmentStatus = 'UNFULFILLED'; }, /marked shipped but has no live label/],
  ['FULFILLED with no fulfillment found', unstagedFacts, (f) => { f.order.fulfillmentStatus = 'FULFILLED'; }, /no fulfillment was found/],
  ['labels at two warehouses', multiFacts, (f) => { f.shipstation.labels[1].warehouseId = 1869852; }, /more than one warehouse/],
  ['emailed two branches', stage2Facts, (f) => { f.opsState.emailed.push({ warehouse: 'Burnaby (BURN)' }); }, /more than one branch/],
  ['ShipStation unreachable', stage2Facts, (f) => { f.shipstation.error = 'orders list HTTP 503'; }, /ShipStation check failed/],
  ['emailed branch has no order desk (Sechelt)', stage2Facts, (f) => { f.opsState.emailed[0].warehouse = 'Sechelt (SECH)'; }, /no order desk/],
  ['branch told but no PO', stage2Facts, (f) => { f.erp.pos = []; }, /no PO number/],
  ['ops-state unreadable', stage2Facts, (f) => { f.opsState.labels.push({ date: '2026-11-03', error: 'bad json' }); }, /ops-state read failed/],
];
for (const [name, base, mut, re] of SHIP_HOLDS) {
  test(`hold (shipping): ${name}`, () => {
    const f = base(); mut(f);
    const ev = ac.evaluate(f);
    assert.equal(ev.eligible, false);
    assert.ok(holdsMatch(ev, re), `expected ${re} in ${JSON.stringify(ev.holds)}`);
  });
}

const HOLDS = [
  ['sender is not the order email', (f) => { f.sender = 'someone@else.ca'; }, /not the order's email/],
  ['order cancelled', (f) => { f.order.cancelledAt = '2026-11-04T10:00:00Z'; }, /already cancelled/],
  ['not paid', (f) => { f.order.financial = 'PENDING'; }, /not PAID/],
  ['over $500', (f) => { f.order.total = '500.01'; f.refund.amount = '500.01'; f.refund.transactions[0].amount = '500.01'; f.order.transactions[0].amount = '500.01'; }, /over the \$500\.00/],
  ['pickup collected (Shopify fulfillment on a pickup)', (f) => { f.order.fulfillments = [{ id: 'f1', status: 'SUCCESS', tracking: [], methods: ['PICK_UP'] }]; f.order.fulfillmentStatus = 'FULFILLED'; }, /pickup fulfillment/],
  ['pickup PICKED_UP in the runner', (f) => { f.pickup.rec.status = 'PICKED_UP'; }, /PICKED_UP/],
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

test('one open order by email is enough without a number', () => {
  const f = pickupFacts(); f.lookup = { numbers: [], openOrders: ['#1444'] };
  assert.equal(ac.evaluate(f).eligible, true);
});

// ── executor (all IO mocked; journal goes to a temp order number) ──
const TRACK_OK = { status_code: 'AC', events: [{ status_code: 'AC', description: 'Label information electronically submitted' }] };
const TRACK_SCANNED = { status_code: 'IT', events: [{ status_code: 'IT', description: 'Picked up by Purolator' }] };

function mockDeps({ tracks = {}, refundState, opsDir }) {
  const calls = [];
  const state = refundState || {
    cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', refunds: [], transactions: [{ kind: 'SALE', status: 'SUCCESS' }], fulfillments: [{ id: 'gid://shopify/Fulfillment/1', status: 'CANCELLED' }],
    lineItems: { nodes: [{ id: 'li1', refundableQuantity: 2 }] }, fulfillmentOrders: { nodes: [{ status: 'OPEN', assignedLocation: { location: { id: 'gid://shopify/Location/CAL' } } }] },
  };
  let ssOrder = { orderId: 810472227, orderStatus: 'shipped' };
  const deps = {
    opsDir, settleMs: 0,
    ssV2: async (m, p) => { const id = Number(/se-(\d+)/.exec(p)[1]); calls.push(`track:${id}`); const t = typeof tracks[id] === 'function' ? tracks[id]() : (tracks[id] || TRACK_OK); return { status: 200, body: JSON.stringify(t) }; },
    ssV1: async (m, p, b) => { calls.push(`void:${b.shipmentId}`); return { status: 200, body: JSON.stringify({ approved: true }) }; },
    ssGetOrder: async () => ssOrder,
    ssCancelOrder: async () => { calls.push('ss-delete'); ssOrder = null; },
    ssCreateOrder: async () => { calls.push('ss-createorder'); },
    pickupRunner: { loadState: () => ({ orders: {} }), saveState: () => calls.push('pickup') },
    emailer: { sendEmail: async (m) => { calls.push(`email:${m.to}`); return { accepted: [m.to], rejected: [] }; } },
    erp: { cancelPurchaseOrder: async () => calls.push('po'), cancelSalesOrder: async () => calls.push('so') },
    audit: { log: () => {} },
    gql: async (q, v) => {
      if (/orderOpen/.test(q)) { calls.push('order-open'); return { orderOpen: { order: { id: v.input.id, closed: false }, userErrors: [] } }; }
      if (/fulfillmentCancel/.test(q)) { calls.push(`fulfillment-cancel:${v.id}`); return { fulfillmentCancel: { fulfillment: { id: v.id, status: 'CANCELLED' }, userErrors: [] } }; }
      if (/fulfillment\(id/.test(q)) return { fulfillment: { id: v.id, status: 'SUCCESS' } };
      if (/suggestedRefund/.test(q)) { calls.push(`suggest:${v.li.map((l) => `${l.restockType}@${l.locationId}`).join(',')}`); return { order: { suggestedRefund: { amountSet: { shopMoney: { amount: '96.30' } }, suggestedTransactions: [{ gateway: 'shopify_payments', amountSet: { shopMoney: { amount: '96.30' } }, parentTransaction: { id: 'gid://shopify/OrderTransaction/1' } }] } } }; }
      if (/refundCreate/.test(q)) { calls.push(`refund:${v.input.refundLineItems.map((l) => l.restockType).join(',')}:notify=${v.input.notify}`); return { refundCreate: { refund: { id: 'gid://shopify/Refund/9' }, userErrors: [] } }; }
      if (/displayFulfillmentStatus/.test(q)) return { order: state };
      throw new Error('unexpected gql ' + q.slice(0, 60));
    },
  };
  return { deps, calls };
}
function opsDirWith(ssOrderId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ops-'));
  fs.writeFileSync(path.join(dir, '2026-11-04.json'), JSON.stringify({ date: '2026-11-04', phases: { buy: { labels: { [ssOrderId]: { orderNumber: '1444' } } }, email: { byOrder: {} } } }));
  return dir;
}
function freshName(ev) { ev.order.name = `#9${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 1000)}`; return ev; }

test('execute, stage 2 multi-package: rescans before each void and before the refund, cancels the fulfillment before refunding, restocks CANCEL at the open location', async () => {
  const ev = freshName(ac.evaluate(multiFacts()));
  const opsDir = opsDirWith('810472227');
  const { deps, calls } = mockDeps({ opsDir });
  const r = await ac.execute(ev, { requestNote: 'please cancel', requestedAt: '2026-11-04T15:00:00Z' }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.deepEqual(calls, [
    'track:470300001', 'void:470300001', 'track:470300002', 'void:470300002',
    'email:KLazzarotto@prosol.ca, order.richmond@prosol.ca',
    'order-open', 'fulfillment-cancel:gid://shopify/Fulfillment/1', 'ss-delete', 'po', 'so',
    'track:470300001', 'track:470300002', 'suggest:CANCEL@gid://shopify/Location/CAL', 'refund:CANCEL:notify=false',
  ]);
  const ops = JSON.parse(fs.readFileSync(path.join(opsDir, '2026-11-04.json'), 'utf8'));
  assert.equal(ops.phases.buy.labels['810472227'], undefined);
  fs.rmSync(r.journal, { force: true });
});

test('execute: a scan appears on the second package mid-run -> stops after the first void, no email, no refund', async () => {
  const ev = freshName(ac.evaluate(multiFacts()));
  const { deps, calls } = mockDeps({ opsDir: opsDirWith('810472227'), tracks: { 470300002: TRACK_SCANNED } });
  const r = await ac.execute(ev, {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed.key, 'void:470300002');
  assert.match(r.failed.error, /carrier scan just before the void/);
  assert.deepEqual(calls, ['track:470300001', 'void:470300001', 'track:470300002']);
  fs.rmSync(r.journal, { force: true });
});

test('execute: a scan appears after the voids -> stops before the refund', async () => {
  const ev = freshName(ac.evaluate(stage1Facts()));
  let n = 0;
  const { deps, calls } = mockDeps({ opsDir: opsDirWith('810472227'), tracks: { 470300001: () => (n++ === 0 ? TRACK_OK : TRACK_SCANNED) } });
  const r = await ac.execute(ev, {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed.key, 'refund');
  assert.match(r.failed.error, /carrier scan before the refund/);
  assert.ok(!calls.some((c) => c.startsWith('refund:')));
  fs.rmSync(r.journal, { force: true });
});

test('execute: Shopify still reads FULFILLED at refund time -> no refund (never refunds a fulfilled order)', async () => {
  const ev = freshName(ac.evaluate(stage1Facts()));
  const { deps, calls } = mockDeps({ opsDir: opsDirWith('810472227'), refundState: {
    cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', refunds: [], transactions: [], fulfillments: [{ id: 'f', status: 'SUCCESS' }],
    lineItems: { nodes: [{ id: 'li1', refundableQuantity: 2 }] }, fulfillmentOrders: { nodes: [] } } });
  const r = await ac.execute(ev, {}, deps);
  assert.equal(r.ok, false); assert.equal(r.failed.key, 'refund'); assert.match(r.failed.error, /still reads FULFILLED/);
  assert.ok(!calls.some((c) => c.startsWith('refund:')));
  fs.rmSync(r.journal, { force: true });
});

test('execute: a refund appeared since the check -> no second refund', async () => {
  const ev = freshName(ac.evaluate(stage1Facts()));
  const { deps, calls } = mockDeps({ opsDir: opsDirWith('810472227'), refundState: {
    cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', refunds: [{ id: 'r' }], transactions: [{ kind: 'REFUND', status: 'PENDING' }], fulfillments: [],
    lineItems: { nodes: [] }, fulfillmentOrders: { nodes: [] } } });
  const r = await ac.execute(ev, {}, deps);
  assert.equal(r.ok, false); assert.match(r.failed.error, /refund or cancel appeared/);
  assert.ok(!calls.some((c) => c.startsWith('refund:')));
  fs.rmSync(r.journal, { force: true });
});

test('execute: a re-run skips the steps the journal already has (no second void, email or refund)', async () => {
  const ev = freshName(ac.evaluate(stage2Facts()));
  const first = mockDeps({ opsDir: opsDirWith('810472227') });
  first.deps.emailer.sendEmail = async () => { throw new Error('smtp down'); };
  const r1 = await ac.execute(ev, {}, first.deps);
  assert.equal(r1.ok, false); assert.equal(r1.failed.key, 'branch_email');
  const second = mockDeps({ opsDir: opsDirWith('810472227') });
  const r2 = await ac.execute(ev, {}, second.deps);
  assert.equal(r2.ok, true, JSON.stringify(r2.failed));
  assert.ok(!second.calls.includes('void:470300001'), 'void not repeated');
  assert.equal(second.calls.filter((c) => c.startsWith('email:')).length, 1);
  fs.rmSync(r2.journal, { force: true });
});

test('execute: pickup flow still stops at the first failing step and never reaches the refund', async () => {
  const ev = freshName(ac.evaluate(pickupFacts()));
  const { deps, calls } = mockDeps({ opsDir: opsDirWith('x') });
  deps.emailer.sendEmail = async () => { calls.push('email'); throw new Error('smtp down'); };
  const r = await ac.execute(ev, {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed.key, 'branch_email');
  assert.deepEqual(calls, ['pickup', 'email']);
  fs.rmSync(r.journal, { force: true });
});
