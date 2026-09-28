// Customer pickup messages. Each one reaches a customer's inbox, so the copy rules are tests: the right sender
// and reply-to, the sign-off, dates from pickup-eta, never the distributor's name, no dashes, no generic greeting,
// and no [MAC: ...] placeholder ever marked ready to send. Run: `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const msg = require('./pickup-messages');
const eta = require('./pickup-eta');
const schedule = require('../data/trade/pickup-schedule.json');

const base = { orderName: '#1500', firstName: 'Sam', location: 'sechelt' };
const ctxFor = {
  received_in_stock: { ...base, readyBy: '2026-10-19', today: '2026-10-19' },
  ordering_in: { ...base, readyBy: '2026-10-21', truckDay: '2026-10-20', partial: { lineIndexes: [0], readyBy: '2026-10-19' }, today: '2026-10-19' },
  on_truck: { ...base, readyBy: '2026-10-21' },
  reminder_1: { ...base, readySince: '2026-10-19' },
  reminder_2: { ...base, readySince: '2026-10-19' },
  delayed: { ...base, missedTruckDay: '2026-10-20', truckDay: '2026-10-23', readyBy: '2026-10-26' },
  picked_up: { ...base },
};
// The shipped schedule with every [MAC] value filled, to prove a finished message can be sent.
const filled = JSON.parse(JSON.stringify(schedule));
filled.locations.sechelt.hours = 'Mon to Fri, 8:00 am to 4:30 pm';
filled.locations.powell_river.hours = 'Mon to Fri, 9:00 am to 5:00 pm';
filled.reminders.hold_policy = 'We hold ready orders for 14 days.';

test('every message: sender, reply-to, sign-off, greeting, order number, clean copy, HTML', () => {
  assert.deepEqual(Object.keys(ctxFor).sort(), [...msg.TYPES].sort());
  for (const type of msg.TYPES) {
    const m = msg.buildPickupMessage(type, ctxFor[type]);
    assert.equal(m.from, 'YourFloors Support <hello@yourfloors.ca>', type);
    assert.equal(m.replyTo, 'hello@yourfloors.ca', type);
    assert.match(m.text, /^Hi Sam,\n/, type);
    assert.match(m.text, /\nThe YourFloors team\n$/, type);
    assert.match(`${m.subject} ${m.text}`, /#1500/, type);
    const all = `${m.subject}\n${m.text}\n${m.html}`;
    assert.doesNotMatch(all, /prosol/i, `${type}: never the distributor`);
    assert.doesNotMatch(all, /[–—]/, `${type}: no en or em dash`);
    assert.doesNotMatch(all, /hi there|hey there|real person|automated/i, type);
    assert.deepEqual(msg.customerTextProblems(all), [], type);
    assert.match(m.html, /^<div style="font-family:Arial/, type);
    assert.match(m.html, /The YourFloors team/, type);
  }
});

test('(a) in stock: ready later today, or by a named day', () => {
  const today = msg.buildPickupMessage('received_in_stock', ctxFor.received_in_stock);
  assert.match(today.text, /ready for pickup later today/);
  assert.match(today.text, /Everything is in stock at our Sechelt warehouse/);
  assert.match(today.text, /5824 Sechelt Inlet Rd, Sechelt/);
  const tomorrow = msg.buildPickupMessage('received_in_stock', { ...base, readyBy: '2026-10-20', today: '2026-10-19' });
  assert.match(tomorrow.text, /ready for pickup by Tuesday, October 20/);
});

test('(b) ordering in, the whole order: truck day, expected ready date, next steps', () => {
  const whole = msg.buildPickupMessage('ordering_in', { ...ctxFor.ordering_in, partial: null });
  assert.equal(whole.subject, "Order #1500: we're bringing it in");
  assert.match(whole.text, /Thanks for your order #1500\. We're bringing it in on our Tuesday, October 20 truck\./);
  assert.match(whole.text, /Expected ready for pickup: Wednesday, October 21, at our Sechelt warehouse, 5824 Sechelt Inlet Rd, Sechelt\./);
  assert.match(whole.text, /Please wait for that email before you come in\./);
  assert.match(whole.html, /<ul[^>]*><li>On Tuesday, October 20/);
  assert.doesNotMatch(whole.text, /in-stock|same time|twice/);
  const pr = msg.buildPickupMessage('ordering_in', { ...base, location: 'powell_river', truckDay: '2026-10-22', readyBy: '2026-10-23' });
  assert.match(pr.text, /Friday, October 23, at our Powell River showroom, 7345 Duncan St, Powell River/);
});

test('(b) ordering in with an in-stock part: early pickup offered plainly, once or twice, dates for both', () => {
  // Mac 2026-09-28: "let them take in-stock part early if they want".
  const m = msg.buildPickupMessage('ordering_in', ctxFor.ordering_in);
  assert.equal(m.subject, "Order #1500: we're bringing it in");
  assert.match(m.text, /Some of it is in stock at our Sechelt warehouse, and we're bringing the rest in on our Tuesday, October 20 truck\./);
  assert.match(m.text, /If you'd like the in-stock items early, they'll be ready for pickup later today\. We'll email you when that part is ready\./);
  assert.match(m.text, /Everything else is expected ready for pickup Wednesday, October 21, at our Sechelt warehouse, 5824 Sechelt Inlet Rd, Sechelt\./);
  assert.match(m.text, /You can come in once for everything, or twice: once for the in-stock items and again for the rest\./);
  assert.match(m.text, /On Tuesday, October 20 we'll email you when the rest of your order is on the truck\./);
  assert.match(m.text, /Please wait for that email before you come in for those items\./);
  assert.doesNotMatch(m.text, /all ready at the same time/);
  assert.deepEqual(msg.customerTextProblems(`${m.subject}\n${m.text}\n${m.html}`), []);
  assert.match(m.html, /<li>On Tuesday, October 20 we'll email you when the rest/);
  const nextDay = msg.buildPickupMessage('ordering_in', { ...ctxFor.ordering_in, partial: { lineIndexes: [0], readyBy: '2026-10-21' }, today: '2026-10-20', truckDay: '2026-10-23', readyBy: '2026-10-26' });
  assert.match(nextDay.text, /they'll be ready for pickup on Wednesday, October 21\./);
  const noToday = msg.buildPickupMessage('ordering_in', { ...ctxFor.ordering_in, today: undefined });
  assert.match(noToday.text, /ready for pickup on Monday, October 19\./, 'no today: always the date');
  const pr = msg.buildPickupMessage('ordering_in', { ...ctxFor.ordering_in, location: 'powell_river', truckDay: '2026-10-22', readyBy: '2026-10-23' });
  assert.match(pr.text, /Some of it is in stock at our Powell River showroom, and we're bringing the rest in on our Thursday, October 22 truck\./);
  assert.match(pr.text, /Everything else is expected ready for pickup Friday, October 23, at our Powell River showroom, 7345 Duncan St, Powell River\./);
  assert.throws(() => msg.buildPickupMessage('ordering_in', { ...ctxFor.ordering_in, partial: true }), /partial\.readyBy is required/);
  // Straight from pickupEta:
  const r = eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: ['on_shelf', 'order_in'] });
  const fromEta = msg.buildPickupMessage('ordering_in', { ...base, truckDay: r.truckDay, readyBy: r.readyBy, partial: r.partial, today: '2026-10-19' });
  assert.equal(fromEta.text, m.text);
});

test("standing OK: Mac's listed templates may go out without a per-email send-it, once nothing is left to fill", () => {
  assert.deepEqual([...msg.STANDING_OK.types], ['ordering_in', 'on_truck', 'delayed', 'reminder_1', 'reminder_2', 'picked_up']);
  assert.equal(msg.STANDING_OK.shopifyReadyTemplate, true);
  assert.equal(msg.STANDING_OK.grantedBy, 'Mac');
  assert.equal(msg.STANDING_OK.date, '2026-09-28');
  assert.match(msg.STANDING_OK.note, /any new template or other customer email still needs a per-email send-it/);
  assert.ok(Object.isFrozen(msg.STANDING_OK) && Object.isFrozen(msg.STANDING_OK.types));
  for (const type of ['ordering_in', 'on_truck', 'delayed', 'picked_up']) {
    assert.equal(msg.autoSendAllowed(type, msg.buildPickupMessage(type, ctxFor[type])), true, `${type}: nothing to fill`);
  }
  for (const type of ['reminder_1', 'reminder_2']) {
    assert.equal(msg.autoSendAllowed(type, msg.buildPickupMessage(type, ctxFor[type])), false, `${type}: hours still [MAC]`);
    assert.equal(msg.autoSendAllowed(type, msg.buildPickupMessage(type, ctxFor[type], filled)), true, `${type}: filled`);
  }
  const inStock = msg.buildPickupMessage('received_in_stock', ctxFor.received_in_stock, filled);
  assert.equal(msg.readyToSend(inStock), true);
  assert.equal(msg.autoSendAllowed('received_in_stock', inStock), false, 'not under the standing OK');
  assert.equal(msg.autoSendAllowed('on_truck', msg.buildPickupMessage('picked_up', ctxFor.picked_up)), false, 'a message built for another type');
  assert.equal(msg.autoSendAllowed('picked_up', null), false);
  assert.equal(msg.autoSendAllowed('vendor_po', { type: 'vendor_po', subject: 'x', text: 'x', html: 'x' }), false);
});

test('(c) on the truck, (g) delayed, (h) picked up', () => {
  const c = msg.buildPickupMessage('on_truck', ctxFor.on_truck);
  assert.equal(c.subject, 'Order #1500 is on the truck today');
  assert.match(c.text, /ready for pickup Wednesday, October 21, at our Sechelt warehouse/);
  const g = msg.buildPickupMessage('delayed', ctxFor.delayed);
  assert.equal(g.subject, 'Order #1500: new pickup date');
  assert.match(g.text, /didn't come in on our Tuesday, October 20 truck\. They're now coming on Friday, October 23, and we expect your order ready for pickup Monday, October 26\./);
  const h = msg.buildPickupMessage('picked_up', ctxFor.picked_up);
  assert.equal(h.subject, 'Thanks for picking up order #1500');
});

test('the delayed dates come straight from delayedEta', () => {
  const d = eta.delayedEta({ missedTruckDay: '2026-10-20', location: 'sechelt' });
  const g = msg.buildPickupMessage('delayed', { ...base, missedTruckDay: d.missedTruckDay, truckDay: d.truckDay, readyBy: d.readyBy });
  assert.equal(g.text, msg.buildPickupMessage('delayed', ctxFor.delayed).text);
});

test('(e) and (f) reminders: ready since, where, hours, order number; (f) carries the hold policy', () => {
  const e = msg.buildPickupMessage('reminder_1', ctxFor.reminder_1);
  assert.match(e.text, /ready for pickup since Monday, October 19/);
  assert.match(e.text, /Pickup: our Sechelt warehouse, 5824 Sechelt Inlet Rd, Sechelt\nHours: \[MAC: Sechelt pickup hours\]\nBring your order number, #1500\./);
  const f = msg.buildPickupMessage('reminder_2', ctxFor.reminder_2);
  assert.match(f.text, /\[MAC: how long we hold a ready order/);
  assert.match(msg.buildPickupMessage('reminder_2', ctxFor.reminder_2, filled).text, /We hold ready orders for 14 days\./);
});

test('placeholders: listed on the message, and readyToSend is false until Mac fills them', () => {
  const draft = msg.buildPickupMessage('reminder_1', ctxFor.reminder_1);
  assert.deepEqual(draft.placeholders, ['[MAC: Sechelt pickup hours]']);
  assert.equal(msg.readyToSend(draft), false);
  const done = msg.buildPickupMessage('reminder_1', ctxFor.reminder_1, filled);
  assert.deepEqual(done.placeholders, []);
  assert.equal(msg.readyToSend(done), true);
  assert.equal(msg.readyToSend(msg.buildPickupMessage('picked_up', ctxFor.picked_up)), true, 'nothing to fill');
});

test('no first name: a plain "Hi," and never "Hi there"; order numbers get their #', () => {
  const m = msg.buildPickupMessage('picked_up', { orderName: '1501', location: 'sechelt' });
  assert.match(m.text, /^Hi,\n/);
  assert.match(m.subject, /#1501/);
  assert.match(msg.buildPickupMessage('picked_up', { ...base, firstName: '  Sam  Smith ' }).text, /^Hi Sam,/);
});

test('missing or wrong input throws instead of sending a half-filled message', () => {
  assert.throws(() => msg.buildPickupMessage('nope', ctxFor.picked_up), /unknown type/);
  assert.throws(() => msg.buildPickupMessage('picked_up', { ...base, orderName: '' }), /orderName/);
  assert.throws(() => msg.buildPickupMessage('picked_up', { ...base, location: 'gibsons' }), /unknown location/);
  assert.throws(() => msg.buildPickupMessage('ordering_in', { ...base, readyBy: '2026-10-21' }), /truckDay is required/);
  assert.throws(() => msg.buildPickupMessage('delayed', { ...base, truckDay: '2026-10-23', readyBy: '2026-10-26' }), /missedTruckDay is required/);
  const bad = JSON.parse(JSON.stringify(schedule));
  bad.locations.sechelt.hours = 'Prosol hours — 8 to 4';
  assert.throws(() => msg.buildPickupMessage('reminder_1', ctxFor.reminder_1, bad), /em dash, names the distributor/);
});

test('(d) Shopify ready-for-pickup template: Liquid name and first name, both addresses, a fallback, clean', () => {
  const t = msg.shopifyReadyForPickupTemplate();
  assert.equal(t.subject, 'Your order {{ name }} is ready for pickup');
  assert.match(t.body, /^Hi\{% if customer\.first_name != blank %\} \{\{ customer\.first_name \}\}\{% endif %\},/);
  assert.match(t.body, /7345 Duncan St, Powell River/);
  assert.match(t.body, /5824 Sechelt Inlet Rd, Sechelt/);
  assert.match(t.body, /\{% else %\}Pick it up at the location you chose at checkout\.\{% endif %\}/);
  assert.match(t.body, /Bring your order number, \{\{ name \}\}\./);
  assert.equal((t.body.match(/\{% if /g) || []).length, (t.body.match(/\{% endif %\}/g) || []).length, 'balanced if/endif');
  assert.deepEqual(msg.customerTextProblems(`${t.subject}\n${t.body}`), []);
  assert.deepEqual(t.placeholders.sort(), ['[MAC: Powell River pickup hours]', '[MAC: Sechelt pickup hours]', '[MAC: how long we hold a ready order, and what happens after]'].sort());
});

test('pickup instructions per location, for the Shopify pickup settings', () => {
  assert.equal(msg.pickupInstructions('sechelt', filled), 'Pick up at our Sechelt warehouse, 5824 Sechelt Inlet Rd, Sechelt. Hours: Mon to Fri, 8:00 am to 4:30 pm. Please wait for our "ready for pickup" email, then bring your order number.');
  assert.match(msg.pickupInstructions('powell_river'), /7345 Duncan St, Powell River\. Hours: \[MAC: Powell River pickup hours\]/);
});

test('timeline: which message goes out when, for both kinds of order', () => {
  const inStock = msg.messageTimeline(eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: ['on_shelf'] }));
  assert.deepEqual(inStock.map((s) => s.type), ['received_in_stock', 'ready_for_pickup', 'reminder_1', 'reminder_2', 'picked_up']);
  assert.deepEqual(inStock.filter((s) => /^reminder/.test(s.type)).map((s) => s.on), ['2026-10-22', '2026-10-28']);
  const ordered = msg.messageTimeline(eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: ['order_in'] }));
  assert.deepEqual(ordered.map((s) => s.type), ['ordering_in', 'on_truck', 'delayed', 'ready_for_pickup', 'reminder_1', 'reminder_2', 'picked_up']);
  assert.equal(ordered.find((s) => s.type === 'on_truck').on, '2026-10-20');
  assert.equal(ordered.find((s) => s.type === 'ready_for_pickup').sentBy, 'Shopify');
  const mixed = msg.messageTimeline(eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: ['on_shelf', 'order_in'] }));
  assert.deepEqual(mixed.map((s) => s.type), ['ordering_in', 'ready_for_pickup', 'on_truck', 'delayed', 'ready_for_pickup', 'reminder_1', 'reminder_2', 'picked_up']);
  assert.deepEqual(mixed[1], { type: 'ready_for_pickup', on: 'in-stock part marked ready in Shopify (expected 2026-10-19)', sentBy: 'Shopify', partial: true });
});
