// Branch pickup planner. A pickup must never be mistaken for a shipment (a label
// and a phantom PO), a branch pickup must never go to the wrong branch, and the
// PO email must carry only the customer's name and our order number, worded as a
// customer pickup (will call). Run: `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const bp = require('./branch-pickup');
const realMap = require('../scripts/shipstation/prosol-location-map.json');

const branches = [
  { id: 10054, code: 'WCAS', city: 'Calgary', province: 'AB', active: true, contact_email: ['order.calgary@prosol.ca'] },
  { id: 10011, code: 'CALN', city: 'Calgary North', province: 'AB', active: true },
  { id: 10010, code: 'BURN', city: 'Burnaby', province: 'BC', active: true },
  { id: 10041, code: 'STCA', city: 'St-Catharines', province: 'ON', active: true },
  { id: 10004, code: 'WGRF', city: 'Saint-Laurent', province: 'QC', active: true },
  { id: 'torlys_cal', code: 'TRLC', city: 'Calgary', province: 'AB', active: true, non_prosol: true },
  { id: 'cfc_sechelt', code: 'SECH', city: 'Sechelt', province: 'BC', active: true, non_prosol: true },
  { id: 'old_calgary', code: 'WCAS', city: 'Calgary', province: 'AB', active: true },
  { id: 10099, code: 'GONE', city: 'Nowhere', province: 'AB', active: false },
];
const title = (t) => ({ shippingLine: { title: t } });

test('a "Pickup: <City> trade counter" rate resolves to that branch', () => {
  const r = bp.resolvePickup(title('Pickup: Calgary trade counter (ready in 2-4 business days)'), branches);
  assert.deepEqual([r.kind, r.branch, r.hold], ['branch_pickup', 'WCAS', null]);
  assert.equal(bp.resolvePickup(title('Pickup: Calgary North trade counter (ready in 2-4 business days)'), branches).branch, 'CALN');
  assert.equal(bp.resolvePickup(title('pickup: burnaby'), branches).branch, 'BURN');
  assert.equal(bp.resolvePickup(title('Pickup: St. Catharines trade counter'), branches).branch, 'STCA', 'punctuation-insensitive');
  assert.equal(bp.resolvePickup({ shippingLines: { nodes: [{ title: 'Pickup: Saint Laurent trade counter' }] } }, branches).branch, 'WGRF');
});

test('a vendor warehouse in the same city never becomes a pickup branch', () => {
  // TRLC (Torlys, Calgary) shares the city with WCAS; only the Prosol branch counts.
  assert.equal(bp.resolvePickup(title('Pickup: Calgary trade counter'), branches).branch, 'WCAS');
  const r = bp.resolvePickup({ customAttributes: [{ key: 'pickup_location', value: 'TRLC' }] }, branches);
  assert.equal(r.kind, 'branch_pickup');
  assert.equal(r.branch, null);
  assert.equal(r.hold, 'not_a_pickup_branch');
});

test('Sechelt and Powell River titles are Coast pickups (no Prosol PO)', () => {
  const s = bp.resolvePickup(title('Pickup: Sechelt'), branches);
  assert.deepEqual([s.kind, s.branch, s.hold], ['coast_pickup', 'SECH', null]);
  const p = bp.resolvePickup(title('Pickup: Powell River trade counter'), branches);
  assert.equal(p.kind, 'coast_pickup');
  assert.equal(p.hold, null);
  assert.equal(bp.planPickup(title('Pickup: Sechelt'), { branches }).next, 'coast');
});

test('a normal shipping order is not a pickup', () => {
  assert.equal(bp.resolvePickup(title('Standard'), branches).kind, null);
  assert.equal(bp.resolvePickup(title('Purolator Ground'), branches).kind, null);
  assert.equal(bp.resolvePickup({}, branches).kind, null);
  assert.equal(bp.planPickup(title('Standard'), { branches }).next, 'not_pickup');
});

test('the pickup_location attribute resolves by code (attributes, note attributes or the note)', () => {
  assert.equal(bp.resolvePickup({ customAttributes: [{ key: 'pickup_location', value: 'wcas' }] }, branches).branch, 'WCAS');
  assert.equal(bp.resolvePickup({ noteAttributes: [{ name: 'pickup_location', value: 'BURN' }] }, branches).branch, 'BURN');
  const n = bp.resolvePickup({ note: 'Texted cart for Sam.\npickup_location=CALN' }, branches);
  assert.deepEqual([n.kind, n.branch, n.source], ['branch_pickup', 'CALN', 'attribute']);
  assert.equal(bp.resolvePickup({ customAttributes: [{ key: 'pickup_location', value: 'SECH' }] }, branches).kind, 'coast_pickup');
});

test('unknown, inactive or conflicting pickups are still pickups, but held', () => {
  const u = bp.resolvePickup(title('Pickup: Moose Jaw trade counter'), branches);
  assert.deepEqual([u.kind, u.branch, u.hold], ['branch_pickup', null, 'unknown_branch']);
  assert.equal(bp.resolvePickup({ customAttributes: [{ key: 'pickup_location', value: 'GONE' }] }, branches).hold, 'unknown_branch');
  assert.equal(bp.resolvePickup({ customAttributes: [{ key: 'pickup_location', value: 'WCSS' }] }, branches).hold, 'unknown_branch', 'typo in the code');
  const c = bp.resolvePickup({ ...title('Pickup: Calgary trade counter'), customAttributes: [{ key: 'pickup_location', value: 'BURN' }] }, branches);
  assert.deepEqual([c.kind, c.branch, c.hold], ['branch_pickup', null, 'conflict']);
  const same = bp.resolvePickup({ ...title('Pickup: Calgary trade counter'), customAttributes: [{ key: 'pickup_location', value: 'WCAS' }] }, branches);
  assert.equal(same.branch, 'WCAS', 'title and attribute agree');
  assert.equal(bp.planPickup(title('Pickup: Moose Jaw'), { branches }).next, 'hold');
});

test('a { branches } table with pickup labels: exact rate title, then label; disabled branches are held', () => {
  const table = { branches: [
    { code: 'CALS', city: 'Calgary', pickup_label: 'Calgary South', province: 'AB', email: 'order.calgary@prosol.ca', rate_title: 'Pickup: Calgary South trade counter (ready in 2-4 business days)', enabled: true },
    { code: 'CALN', city: 'Calgary', pickup_label: 'Calgary North', province: 'AB', rate_title: 'Pickup: Calgary North trade counter (ready in 2-4 business days)', enabled: false },
    { code: 'WGRF', city: 'Saint-Laurent', pickup_label: 'Montreal Saint-Laurent', province: 'QC', enabled: true },
  ] };
  const s = bp.resolvePickup(title('Pickup: Calgary South trade counter (ready in 2-4 business days)'), table);
  assert.deepEqual([s.kind, s.branch, s.hold, s.city], ['branch_pickup', 'CALS', null, 'Calgary South']);
  assert.equal(bp.resolvePickup(title('Pickup: Montreal Saint-Laurent trade counter'), table).branch, 'WGRF');
  const n = bp.resolvePickup(title('Pickup: Calgary North trade counter (ready in 2-4 business days)'), table);
  assert.deepEqual([n.kind, n.branch, n.hold, n.code], ['branch_pickup', null, 'branch_not_enabled', 'CALN']);
  assert.equal(bp.resolvePickup({ customAttributes: [{ key: 'pickup_location', value: 'CALN' }] }, table).hold, 'branch_not_enabled');
  const a = bp.resolvePickup(title('Pickup: Calgary trade counter'), table);
  assert.deepEqual([a.branch, a.hold], [null, 'ambiguous_branch'], 'two Calgary branches: never guess');
});

test('native checkout pickup (fulfillment order PICK_UP) is classified by its location city', () => {
  const o = { shippingLine: { title: 'Sechelt Warehouse' }, fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'PICK_UP' }, assignedLocation: { location: { address: { city: 'Sechelt' } } } }] } };
  assert.equal(bp.resolvePickup(o, branches).kind, 'coast_pickup');
});

test('the real Prosol location map resolves the national branches, not vendors or legacy rows', () => {
  assert.equal(bp.resolvePickup(title('Pickup: Calgary trade counter'), realMap).branch, 'WCAS');
  assert.equal(bp.resolvePickup(title('Pickup: Calgary North trade counter'), realMap).branch, 'CALN');
  assert.equal(bp.resolvePickup(title('Pickup: Mississauga trade counter'), realMap).branch, 'MISS');
  assert.equal(bp.resolvePickup(title('Pickup: Edmonton North trade counter'), realMap).branch, 'EDMN');
  assert.equal(bp.resolvePickup(title('Pickup: Saint-Laurent trade counter'), realMap).branch, 'WGRF');
  assert.equal(bp.resolvePickup(title('Pickup: Sechelt'), realMap).kind, 'coast_pickup');
});

test('stock: READY when the branch has every line', () => {
  const s = bp.checkStock([{ sku: 'J100BW', quantity: 10 }, { sku: 'EV/Q125ABGB', prosolSku: 'EVQ125ABGB', quantity: 2 }], 'WCAS', {
    WCAS: { J100BW: 12, EVQ125ABGB: { qty: 2 } },
  });
  assert.equal(s.status, 'READY');
  assert.deepEqual(s.lines.map((l) => l.status), ['READY', 'READY']);
  assert.equal(s.lines[1].prosolSku, 'EVQ125ABGB', 'looked up by the Prosol PO code, not the storefront SKU');
});

test('stock: NEEDS_TRANSFER when the branch is short but other branches cover it', () => {
  const s = bp.checkStock([{ sku: 'J100BW', quantity: 10 }, { sku: 'AE100', quantity: 1 }], 'WCAS', {
    WCAS: { J100BW: 4, AE100: 3 },
    CALN: { J100BW: 5 },
    EDMN: { J100BW: 20 },
  });
  assert.equal(s.status, 'NEEDS_TRANSFER');
  const j = s.lines[0];
  assert.equal(j.status, 'NEEDS_TRANSFER');
  assert.equal(j.short, 6);
  assert.deepEqual(j.transferFrom.map((b) => b.code), ['EDMN', 'CALN'], 'deepest branch first');
  assert.equal(s.lines[1].status, 'READY');
});

test('stock: the same code on two lines is added up before checking', () => {
  const s = bp.checkStock([{ sku: 'J100BW', quantity: 5 }, { sku: 'j100bw', quantity: 5 }], 'WCAS', { WCAS: { J100BW: 8 } });
  assert.equal(s.status, 'HOLD', 'each line alone fits, together they do not, and nowhere else has it');
  assert.equal(s.lines[0].needTotal, 10);
});

test('stock: HOLD when unmapped, not a Prosol item, no data for the branch, or short everywhere', () => {
  assert.equal(bp.checkStock([{ sku: '', quantity: 1 }], 'WCAS', { WCAS: {} }).lines[0].reason, 'unmapped');
  assert.equal(bp.checkStock([{ sku: 'UNI-OAK', quantity: 1, nonProsol: true }], 'WCAS', { WCAS: {} }).lines[0].reason, 'non_prosol');
  assert.equal(bp.checkStock([{ sku: 'J100BW', quantity: 1 }], 'WCAS', { CALN: { J100BW: 9 } }).lines[0].reason, 'no_stock_data');
  assert.equal(bp.checkStock([{ sku: 'J100BW', quantity: 30 }], 'WCAS', { WCAS: { J100BW: 4 }, CALN: { J100BW: 5 } }).lines[0].reason, 'short_in_network');
  assert.equal(bp.checkStock([], 'WCAS', {}).reason, 'no_lines');
  assert.equal(bp.checkStock([{ sku: 'J100BW', quantity: 1, available: true }], 'WCAS', { WCAS: { J100BW: { available: true } } }).status, 'HOLD', 'a boolean available is not a quantity');
});

test('planPickup: branch pickups send a PO (asking for a transfer when short) or hold', () => {
  const o = title('Pickup: Calgary trade counter (ready in 2-4 business days)');
  const lines = [{ sku: 'J100BW', quantity: 10 }];
  assert.deepEqual(
    (({ next, transfer }) => ({ next, transfer }))(bp.planPickup(o, { branches, lines, stock: { WCAS: { J100BW: 10 } } })),
    { next: 'send_po', transfer: false },
  );
  assert.equal(bp.planPickup(o, { branches, lines, stock: { WCAS: { J100BW: 1 }, EDMN: { J100BW: 50 } } }).transfer, true);
  assert.equal(bp.planPickup(o, { branches, lines, stock: { WCAS: {} } }).next, 'hold');
});

const pickupOrder = {
  name: '#1500',
  customer: { firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', phone: '+16045550123' },
  billingAddress: { firstName: 'Jane', lastName: 'Smith', address1: '123 Main St', city: 'Calgary', zip: 'T2X 1A1', phone: '+16045550123' },
  shippingAddress: { address1: '123 Main St', city: 'Calgary', zip: 'T2X 1A1' },
  email: 'jane@example.com',
  phone: '+16045550123',
};

test('PO email: customer pickup (will call) wording, name and order number only', () => {
  const e = bp.buildPickupEmail({ order: pickupOrder, branch: { code: 'wcas', city: 'Calgary' }, lines: [{ sku: 'J100BW', quantity: 10 }], poNumber: 'PO-16500' });
  assert.match(e.subject, /^CUSTOMER PICKUP \(will call\) at Calgary \(WCAS\): order #1500, PO PO-16500$/);
  assert.match(e.body, /^CUSTOMER PICKUP \(will call\) at Calgary \(WCAS\)$/m);
  assert.match(e.body, /^Customer: Jane Smith$/m);
  assert.match(e.body, /^Our order: #1500$/m);
  assert.match(e.body, /^ {2}J100BW x 10$/m);
  const all = `${e.subject}\n${e.body}`;
  assert.doesNotMatch(all, /carrier/i, 'never carrier pickup wording');
  assert.doesNotMatch(all, /123 Main|T2X|6045550123|example\.com|@/, 'no address, phone or email');
  assert.doesNotMatch(all, /\u2014/, 'no em dashes');
});

test('PO email: short lines ask the branch for a transfer; a missing name refuses to build', () => {
  const stock = bp.checkStock([{ sku: 'J100BW', quantity: 10 }], 'WCAS', { WCAS: { J100BW: 4 }, EDMN: { J100BW: 20 } });
  const e = bp.buildPickupEmail({ order: pickupOrder, branch: 'WCAS', lines: [{ sku: 'J100BW', quantity: 10 }], stock });
  assert.match(e.body, /transfer in/);
  assert.match(e.body, /J100BW: need 10, branch shows 4/);
  assert.throws(() => bp.buildPickupEmail({ order: { name: '#1', customer: {} }, branch: 'WCAS', lines: [] }), /first and last name/);
});

test('state machine: NEW -> PO_SENT -> READY -> PICKED_UP, and illegal moves throw', () => {
  const r0 = bp.newPickupRecord({ orderName: '#1500', branch: 'wcas' }, '2026-10-20T10:00:00Z');
  assert.equal(r0.state, 'NEW');
  assert.equal(r0.branch, 'WCAS');
  const r1 = bp.transition(r0, 'PO_SENT', { at: '2026-10-20T10:05:00Z' });
  const r2 = bp.transition(r1, 'READY', { at: '2026-10-22T09:00:00Z' });
  const r3 = bp.transition(r2, 'PICKED_UP', { at: '2026-10-23T15:00:00Z' });
  assert.equal(r3.state, 'PICKED_UP');
  assert.deepEqual(r3.history.map((h) => h.to), ['NEW', 'PO_SENT', 'READY', 'PICKED_UP']);
  assert.equal(r0.state, 'NEW', 'records are not mutated');
  assert.throws(() => bp.transition(r0, 'READY'), /not allowed/, 'no READY before the PO');
  assert.throws(() => bp.transition(r0, 'PICKED_UP'), /not allowed/);
  assert.throws(() => bp.transition(r3, 'CANCELLED'), /not allowed/, 'picked up is final');
  assert.throws(() => bp.transition(bp.transition(r0, 'CANCELLED'), 'PO_SENT'), /not allowed/, 'cancelled is final');
});

test('cancellation: after the PO went out, Mac is emailed to cancel with the branch', () => {
  const r0 = bp.newPickupRecord({ orderName: '#1500', branch: 'WCAS' });
  assert.deepEqual(bp.cancelPlan(r0), { to: 'CANCELLED', emailMac: false, reason: 'cancelled before the PO' });
  const sent = bp.transition(r0, 'PO_SENT');
  assert.equal(bp.cancelPlan(sent).emailMac, true);
  assert.equal(bp.cancelPlan(bp.transition(sent, 'READY')).to, 'CANCELLED');
  const gone = bp.transition(bp.transition(sent, 'READY'), 'PICKED_UP');
  assert.deepEqual([bp.cancelPlan(gone).to, bp.cancelPlan(gone).emailMac], [null, true]);
});
