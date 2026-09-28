// Pickup automation planner: what should happen now for a Coast pickup order. Every action here ends up as a
// customer email, a Shopify "Ready for pickup" email or a ping to Mac, so each rule has a case, stepped through
// time the way the runner (01's handler) will call it. Dates are BC (UTC-7 all year). Run: `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./pickup-actions');
const eta = require('./pickup-eta');
const msgs = require('./pickup-messages');
const schedule = require('../data/trade/pickup-schedule.json');

// The week of Mon Oct 19 2026 has no holiday. bc('2026-10-20 11:00') is that BC wall time with its offset.
const bc = (s) => `${s.replace(' ', 'T')}:00-07:00`;
const plan = (order, state, now, sched) => A.planActions({ order, state, now: bc(now) }, sched);
const keys = (p) => p.actions.map((a) => a.key);
const sechelt = (name, paid, lines = ['order_in'], extra = {}) => ({ name, paidAt: bc(paid), location: 'sechelt', lines, firstName: 'Sam', ...extra });
const powell = (name, paid, lines = ['order_in']) => ({ name, paidAt: bc(paid), location: 'powell_river', lines, firstName: 'Sam' });

/** What the runner does with an action: perform it, then remember it in state. */
function record(state, action, now) {
  state.done = state.done || {};
  state.done[action.key] = now;
  if (action.type === 'mark_ready') state.markedReadyAt = now;
}

/** A runner that sleeps until nextCheckAt: every action it performs, as [BC 'YYYY-MM-DD HH:MM', key, status]. */
function runUntil(order, state, from, until, sched) {
  const log = [];
  let now = bc(from);
  for (let i = 0; i < 40 && now && Date.parse(now) <= Date.parse(bc(until)); i++) {
    const p = A.planActions({ order, state, now }, sched);
    for (const a of p.actions) {
      log.push([eta.toBc(a.at).label, a.key, p.status]);
      record(state, a, now);
    }
    now = A.planActions({ order, state, now }, sched).nextCheckAt; // re-plan after the state changed
  }
  return log;
}

const sent = []; // every send_customer action the cases produce, checked against the message builder at the end
const collect = (p) => { for (const a of p.actions) if (a.type === 'send_customer') sent.push(a); return p; };

test('the schedule carries the automation defaults, each still PROPOSED [MAC]; the module reads no clock or tz database', () => {
  const a = schedule.automation;
  assert.deepEqual(
    { on_truck_time: a.on_truck_time, ready_time: a.ready_time, ready_now_delay_minutes: a.ready_now_delay_minutes, business_hours: a.business_hours, reminder_time: a.reminder_time, escalate_after_business_days: a.escalate_after_business_days },
    JSON.parse(JSON.stringify(A.AUTOMATION_DEFAULTS)),
  );
  for (const k of Object.keys(A.AUTOMATION_DEFAULTS)) assert.match(a._status[k], /^PROPOSED \[MAC/, k);
  assert.equal(schedule.notify.received_in_stock, false);
  assert.match(schedule.notify._status.received_in_stock, /^PROPOSED \[MAC/);
  assert.deepEqual(eta.validateSchedule(schedule), []);
  const { automation, ...noAutomation } = schedule;
  assert.deepEqual(A.automationSettings(noAutomation), A.automationSettings(schedule), 'defaults apply without the block');
  const src = require('fs').readFileSync(require.resolve('./pickup-actions'), 'utf8');
  assert.doesNotMatch(src, /Date\.now\(|new Date\(\)|timeZone\s*:|toLocale|getHours\(|getDay\(|getDate\(/, 'no clock reads, no tz database');
  assert.doesNotMatch(src, /require\(['"](fs|https?|net|child_process|\.\/emailer|\.\/shopify-graphql)['"]\)/, 'no I/O');
});

test('Sechelt, ordered in, paid Mon 10:00: the whole week, driven by nextCheckAt', () => {
  const order = sechelt('#1500', '2026-10-19 10:00');
  const state = {};
  const log = runUntil(order, state, '2026-10-19 10:00', '2026-11-30 00:00');
  assert.deepEqual(log, [
    ['2026-10-19 10:00', '#1500:ordering_in', 'ordered_in'],
    ['2026-10-20 11:00', '#1500:on_truck:2026-10-20', 'on_truck'],
    ['2026-10-21 09:00', '#1500:mark_ready', 'on_truck'],
    ['2026-10-26 10:00', '#1500:reminder_1', 'ready'], // 3 business days after Wed: Thu, Fri, Mon
    ['2026-10-30 10:00', '#1500:reminder_2', 'ready'], // 7 business days
    ['2026-11-04 10:00', '#1500:escalate:not_picked_up', 'ready'], // 10 business days
  ]);
  const after = plan(order, state, '2026-11-30 00:00');
  assert.deepEqual(after.actions, []);
  assert.equal(after.nextCheckAt, null, 'nothing left to wait for');
  assert.equal(after.status, 'ready');
  assert.equal(after.readyAt, bc('2026-10-21 09:00'));
});

test('Sechelt, ordered in: stepping every 30 minutes, each action once, never early, with its payload', () => {
  const order = sechelt('#1500', '2026-10-19 10:00', ['on_shelf', 'order_in']);
  const state = {};
  const seen = [];
  const statuses = new Map();
  const start = Date.parse(bc('2026-10-19 10:00'));
  for (let t = start; t <= start + 17 * 864e5; t += 30 * 6e4) {
    const now = new Date(t).toISOString(); // a UTC 'Z' time, as a runner would pass
    const p = collect(A.planActions({ order, state, now }));
    statuses.set(eta.toBc(t).label, p.status);
    for (const a of p.actions) { seen.push([eta.toBc(t).label, a]); record(state, a, now); }
  }
  assert.deepEqual(seen.map(([when, a]) => `${when} ${a.key}`), [
    '2026-10-19 10:00 #1500:ordering_in',
    '2026-10-20 11:00 #1500:on_truck:2026-10-20',
    '2026-10-21 09:00 #1500:mark_ready',
    '2026-10-26 10:00 #1500:reminder_1',
    '2026-10-30 10:00 #1500:reminder_2',
    '2026-11-04 10:00 #1500:escalate:not_picked_up',
  ]);
  const by = Object.fromEntries(seen.map(([, a]) => [a.key, a]));
  assert.deepEqual(by['#1500:ordering_in'], {
    key: '#1500:ordering_in', type: 'send_customer', at: bc('2026-10-19 10:00'), message: 'ordering_in',
    orderName: '#1500', firstName: 'Sam', location: 'sechelt', truckDay: '2026-10-20', readyBy: '2026-10-21', partial: true,
  });
  assert.deepEqual(by['#1500:mark_ready'], {
    key: '#1500:mark_ready', type: 'mark_ready', at: bc('2026-10-21 09:00'),
    location: 'sechelt', shopifyLocationId: schedule.locations.sechelt.shopify_location_id, readyBy: '2026-10-21',
  });
  assert.equal(by['#1500:reminder_1'].readySince, '2026-10-21');
  assert.equal(by['#1500:escalate:not_picked_up'].to, 'mac');
  assert.match(by['#1500:escalate:not_picked_up'].note, /ready for pickup at Sechelt Warehouse since Wednesday, October 21 and has not been picked up after 10 business days/);
  assert.equal(statuses.get('2026-10-19 12:00'), 'ordered_in');
  assert.equal(statuses.get('2026-10-20 08:00'), 'on_truck');
  assert.equal(statuses.get('2026-10-21 12:00'), 'ready');
});

test('on the shelf: marked ready 2 hours after payment, clipped into business hours (08:00 to 16:00)', () => {
  const readyAt = (paid) => plan(sechelt('#1510', paid, ['on_shelf']), {}, paid).readyAt;
  assert.equal(readyAt('2026-10-19 10:00'), bc('2026-10-19 12:00'), 'Mon 10:00: 12:00');
  assert.equal(readyAt('2026-10-19 15:30'), bc('2026-10-20 08:00'), 'Mon 15:30: 17:30 is after close, Tue at open');
  assert.equal(readyAt('2026-10-19 13:59'), bc('2026-10-19 15:59'));
  assert.equal(readyAt('2026-10-19 14:00'), bc('2026-10-20 08:00'), 'lands exactly at close: next business day');
  assert.equal(readyAt('2026-10-19 05:30'), bc('2026-10-19 08:00'), 'before open: at open');
  assert.equal(readyAt('2026-10-23 15:30'), bc('2026-10-26 08:00'), 'Fri late: Mon');
  assert.equal(readyAt('2026-10-24 11:00'), bc('2026-10-26 08:00'), 'Saturday: Mon');
  assert.equal(readyAt('2026-10-09 15:30'), bc('2026-10-13 08:00'), 'over Thanksgiving Monday');

  const order = sechelt('#1510', '2026-10-19 10:00', ['on_shelf']);
  const first = plan(order, {}, '2026-10-19 10:00');
  assert.deepEqual(first.actions, [], 'no own email by default (notify.received_in_stock is false)');
  assert.equal(first.status, 'preparing');
  assert.equal(first.nextCheckAt, bc('2026-10-19 12:00'));
  assert.deepEqual(keys(plan(order, {}, '2026-10-19 11:59')), []);
  const due = plan(order, {}, '2026-10-19 12:00');
  assert.deepEqual(keys(due), ['#1510:mark_ready']);
  assert.equal(due.actions[0].readyBy, '2026-10-19');

  const late = sechelt('#1511', '2026-10-19 15:30', ['on_shelf']);
  assert.deepEqual(keys(plan(late, {}, '2026-10-19 23:00')), []);
  assert.deepEqual(keys(plan(late, {}, '2026-10-20 08:00')), ['#1511:mark_ready']);
  assert.equal(plan(late, {}, '2026-10-19 15:30').eta.kind, 'ready_now');
});

test('on the shelf with notify.received_in_stock: the in-stock email at payment, once, then Ready', () => {
  const withNotify = { ...schedule, notify: { received_in_stock: true } };
  const order = sechelt('#1512', '2026-10-19 15:30', ['on_shelf']);
  const state = {};
  const log = runUntil(order, state, '2026-10-19 15:30', '2026-10-21 00:00', withNotify);
  assert.deepEqual(log.map((l) => `${l[0]} ${l[1]}`), ['2026-10-19 15:30 #1512:received_in_stock', '2026-10-20 08:00 #1512:mark_ready']);
  const p = collect(plan(order, {}, '2026-10-19 15:30', withNotify));
  assert.deepEqual(p.actions[0], {
    key: '#1512:received_in_stock', type: 'send_customer', at: bc('2026-10-19 15:30'), message: 'received_in_stock',
    orderName: '#1512', firstName: 'Sam', location: 'sechelt', readyBy: '2026-10-20', today: '2026-10-19',
  });
  assert.deepEqual(keys(plan(order, {}, '2026-10-20 09:00', withNotify)), ['#1512:mark_ready'], 'first seen after it was due: Ready only');
});

test('a hold stops mark_ready and on_truck until released', () => {
  const order = sechelt('#1520', '2026-10-19 10:00');
  const held = () => ({ done: { '#1520:ordering_in': bc('2026-10-19 10:00') }, holds: [{ at: bc('2026-10-19 12:00'), by: 'Doug', note: 'customer called' }] });

  for (const now of ['2026-10-20 11:00', '2026-10-21 09:00', '2026-10-28 10:00']) {
    const p = plan(order, held(), now);
    assert.deepEqual(p.actions, [], now);
    assert.equal(p.status, 'held', now);
    assert.equal(p.nextCheckAt, null, `${now}: nothing to wake for until the state changes`);
  }

  // Released on the truck day: the truck email still goes out, then Ready as planned.
  const tue = { ...held(), releasedAt: bc('2026-10-20 14:00') };
  const r1 = collect(plan(order, tue, '2026-10-20 14:00'));
  assert.deepEqual(keys(r1), ['#1520:on_truck:2026-10-20']);
  assert.equal(r1.status, 'on_truck');
  assert.equal(r1.nextCheckAt, bc('2026-10-21 09:00'));

  // Released the next day at 12:30: "on the truck today" is stale; Ready goes at the release.
  const wed = { ...held(), releasedAt: bc('2026-10-21 12:30') };
  const r2 = plan(order, wed, '2026-10-21 12:30');
  assert.deepEqual(keys(r2), ['#1520:mark_ready']);
  assert.equal(r2.actions[0].at, bc('2026-10-21 12:30'));

  // Released after close: Ready at the next business day's open.
  const eve = { ...held(), releasedAt: bc('2026-10-21 17:00') };
  assert.deepEqual(keys(plan(order, eve, '2026-10-21 17:00')), []);
  assert.equal(plan(order, eve, '2026-10-21 17:00').nextCheckAt, bc('2026-10-22 08:00'));
  assert.deepEqual(keys(plan(order, eve, '2026-10-22 08:00')), ['#1520:mark_ready']);

  // A new hold after the release is active again.
  const again = { ...tue, holds: [...tue.holds, { at: bc('2026-10-21 08:30'), by: 'Doug' }] };
  assert.equal(plan(order, again, '2026-10-21 09:00').status, 'held');
  assert.deepEqual(keys(plan(order, again, '2026-10-21 09:00')), []);

  // A shelf order held before its Ready time.
  const shelf = sechelt('#1521', '2026-10-19 10:00', ['on_shelf']);
  const hs = { holds: [{ at: bc('2026-10-19 10:30') }] };
  assert.deepEqual(keys(plan(shelf, hs, '2026-10-19 12:00')), []);
  assert.deepEqual(keys(plan(shelf, { ...hs, releasedAt: bc('2026-10-19 13:00') }, '2026-10-19 13:00')), ['#1521:mark_ready']);
});

test('a short on the truck day: one delayed email, the next run from delayedEta, Ready moves; shorts chain', () => {
  const order = sechelt('#1530', '2026-10-19 10:00');
  const state = {};
  runUntil(order, state, '2026-10-19 10:00', '2026-10-20 12:00');
  assert.deepEqual(Object.keys(state.done), ['#1530:ordering_in', '#1530:on_truck:2026-10-20']);

  state.shorts = [{ truckDay: '2026-10-20', at: bc('2026-10-20 18:00') }];
  const p = collect(plan(order, state, '2026-10-20 18:00'));
  assert.deepEqual(p.actions, [{
    key: '#1530:delayed:2026-10-20', type: 'send_customer', at: bc('2026-10-20 18:00'), message: 'delayed',
    orderName: '#1530', firstName: 'Sam', location: 'sechelt', missedTruckDay: '2026-10-20', truckDay: '2026-10-23', readyBy: '2026-10-26',
  }]);
  const d = eta.delayedEta({ missedTruckDay: '2026-10-20', location: 'sechelt' });
  assert.equal(p.eta.readyBy, d.readyBy);
  assert.equal(p.eta.truckDay, d.truckDay);
  assert.equal(p.eta.shortDay, '2026-10-23', 'the next SHORT would be recorded against the Friday run');
  assert.equal(p.status, 'delayed');
  assert.equal(p.readyAt, bc('2026-10-26 09:00'));
  assert.equal(p.nextCheckAt, bc('2026-10-23 11:00'), 'the next truck email, not the old Wednesday Ready');
  assert.deepEqual(keys(plan(order, state, '2026-10-20 18:00')), ['#1530:delayed:2026-10-20'], 'until recorded, it comes back');

  const log = runUntil(order, state, '2026-10-20 18:00', '2026-10-26 12:00');
  assert.deepEqual(log.map((l) => `${l[0]} ${l[1]}`), [
    '2026-10-20 18:00 #1530:delayed:2026-10-20',
    '2026-10-23 11:00 #1530:on_truck:2026-10-23',
    '2026-10-26 09:00 #1530:mark_ready',
  ]);

  // Shorted again before it was marked ready: chains to the run after.
  const s2 = { done: { '#1530:ordering_in': 'x', '#1530:delayed:2026-10-20': 'x' }, shorts: [state.shorts[0], { truckDay: '2026-10-23', at: bc('2026-10-23 18:00') }] };
  const p2 = collect(plan(order, s2, '2026-10-23 18:00'));
  assert.deepEqual(keys(p2), ['#1530:delayed:2026-10-23']);
  assert.deepEqual([p2.actions[0].truckDay, p2.actions[0].readyBy], ['2026-10-27', '2026-10-28']);
  assert.equal(p2.eta.delays.length, 2);
  assert.deepEqual(keys(plan(order, { ...s2, done: { '#1530:ordering_in': 'x' } }, '2026-10-23 18:00')), ['#1530:delayed:2026-10-23'], 'only the newest date goes out');

  // A short for a day the order is not on changes nothing.
  const wrong = plan(order, { done: { '#1530:ordering_in': 'x', '#1530:on_truck:2026-10-20': 'x' }, shorts: [{ truckDay: '2026-10-23', at: bc('2026-10-20 18:00') }] }, '2026-10-20 18:00');
  assert.deepEqual(keys(wrong), []);
  assert.equal(wrong.readyAt, bc('2026-10-21 09:00'));
  assert.match(wrong.warnings.join(' '), /does not match #1530's truck day 2026-10-20; ignored/);

  // Short known before the customer heard anything: ordering_in carries the new dates, no delayed email.
  const early = collect(plan(order, { shorts: [{ truckDay: '2026-10-20', at: bc('2026-10-19 09:00') }] }, '2026-10-19 10:00'));
  assert.deepEqual(keys(early), ['#1530:ordering_in']);
  assert.deepEqual([early.actions[0].truckDay, early.actions[0].readyBy], ['2026-10-23', '2026-10-26']);
});

test('a short after the order was marked ready is ignored with a warning (the Ready email already went)', () => {
  const order = sechelt('#1531', '2026-10-19 10:00');
  const state = { markedReadyAt: bc('2026-10-21 09:00'), shorts: [{ truckDay: '2026-10-20', at: bc('2026-10-21 10:00') }] };
  const p = plan(order, state, '2026-10-21 10:00');
  assert.equal(p.status, 'ready');
  assert.deepEqual(keys(p), []);
  assert.match(p.warnings.join(' '), /after #1531 was marked ready; ignored/);
});

test('SHORT on a shelf order: never marked ready, Mac is told once', () => {
  const order = sechelt('#1532', '2026-10-19 10:00', ['on_shelf']);
  const state = { shorts: [{ truckDay: null, at: bc('2026-10-19 11:00') }] };
  const p = plan(order, state, '2026-10-19 12:00');
  assert.deepEqual(keys(p), ['#1532:escalate:shelf_short']);
  assert.equal(p.actions[0].reason, 'shelf_short');
  assert.equal(p.status, 'held');
  record(state, p.actions[0], bc('2026-10-19 12:00'));
  const after = plan(order, state, '2026-10-20 12:00');
  assert.deepEqual(keys(after), []);
  assert.equal(after.nextCheckAt, null);
});

test('paid after 14:00 the day before a run: ask the supplier once; confirmed moves Ready earlier, otherwise the promise holds', () => {
  const order = sechelt('#1540', '2026-10-19 16:00');
  const first = collect(plan(order, {}, '2026-10-19 16:00'));
  assert.deepEqual(keys(first), ['#1540:supplier_confirm_request', '#1540:ordering_in']);
  const ask = first.actions[0];
  assert.deepEqual(
    [ask.supplierRunDay, ask.readyByIfConfirmed, ask.promisedRunDay, ask.promisedReadyBy],
    ['2026-10-20', '2026-10-21', '2026-10-23', '2026-10-26'],
  );
  assert.match(ask.note, /paid after 14:00 on the cutoff day\. Ask the supplier whether it can still make the Tuesday, October 20 run/);
  assert.doesNotMatch(ask.note, /prosol/i);
  assert.deepEqual([first.actions[1].truckDay, first.actions[1].readyBy], ['2026-10-23', '2026-10-26'], 'the customer is promised the safe run');
  assert.equal(first.status, 'awaiting_supplier_confirm');
  assert.deepEqual(first.eta.supplierConfirm, { runDay: '2026-10-20', readyByIfConfirmed: '2026-10-21', answer: null });

  const asked = { done: { '#1540:supplier_confirm_request': bc('2026-10-19 16:00'), '#1540:ordering_in': bc('2026-10-19 16:00') } };
  assert.deepEqual(keys(plan(order, asked, '2026-10-19 16:05')), [], 'asked once');

  const yes = { done: { ...asked.done }, supplierConfirmed: true };
  const py = plan(order, yes, '2026-10-19 18:00');
  assert.equal(py.status, 'ordered_in');
  assert.equal(py.readyAt, bc('2026-10-21 09:00'), 'confirmed: the earlier date');
  assert.equal(py.nextCheckAt, bc('2026-10-20 11:00'));
  assert.deepEqual(runUntil(order, yes, '2026-10-20 11:00', '2026-10-21 09:00').map((l) => `${l[0]} ${l[1]}`),
    ['2026-10-20 11:00 #1540:on_truck:2026-10-20', '2026-10-21 09:00 #1540:mark_ready']);

  for (const answer of [false, null]) {
    const st = { ...asked, supplierConfirmed: answer };
    const p = plan(order, st, '2026-10-21 12:00');
    assert.equal(p.readyAt, bc('2026-10-26 09:00'), `${answer}: the promised date`);
    assert.deepEqual(keys(p), [], `${answer}: no Tuesday truck email`);
    assert.equal(p.status, 'ordered_in');
    assert.equal(p.nextCheckAt, bc('2026-10-23 11:00'));
  }
  assert.equal(plan(order, asked, '2026-10-20 09:00').status, 'awaiting_supplier_confirm', 'unanswered: still hoping on the run day');
  assert.deepEqual(keys(plan(order, { supplierConfirmed: false }, '2026-10-19 16:00')), ['#1540:ordering_in'], 'answered before we asked: no request');
  assert.deepEqual(keys(plan(order, { done: { '#1540:ordering_in': 'x' } }, '2026-10-21 08:00')), [], 'the run day passed unasked: too late to ask');
});

test('Powell River: truck email on the Thursday truck day, Ready Friday 09:00', () => {
  const order = powell('#1550', '2026-10-19 10:00');
  const state = {};
  const log = runUntil(order, state, '2026-10-19 10:00', '2026-10-23 12:00');
  assert.deepEqual(log.map((l) => `${l[0]} ${l[1]}`), [
    '2026-10-19 10:00 #1550:ordering_in',
    '2026-10-22 11:00 #1550:on_truck:2026-10-22',
    '2026-10-23 09:00 #1550:mark_ready',
  ]);
  const p = collect(plan(order, {}, '2026-10-19 10:00'));
  assert.deepEqual([p.actions[0].truckDay, p.actions[0].readyBy], ['2026-10-22', '2026-10-23']);
  assert.equal(p.eta.supplierRunDay, '2026-10-20');
  assert.equal(p.eta.shortDay, '2026-10-20', 'a SHORT is recorded against the Tuesday supplier run');
  assert.equal(plan(order, { markedReadyAt: bc('2026-10-23 09:00') }, '2026-10-23 09:00').status, 'ready');
  const ready = plan(order, { done: { '#1550:ordering_in': 'x', '#1550:on_truck:2026-10-22': 'x' } }, '2026-10-23 09:00');
  assert.equal(ready.actions[0].shopifyLocationId, schedule.locations.powell_river.shopify_location_id);
  assert.equal(plan(order, {}, '2026-10-20 12:00').status, 'ordered_in', 'Tuesday: the supplier run, not yet the Powell River truck');
  assert.equal(plan(order, {}, '2026-10-22 08:00').status, 'on_truck');

  // The Tuesday run was short: next run Friday, Sechelt Monday, the next Thursday truck.
  const short = { done: { '#1550:ordering_in': 'x' }, shorts: [{ truckDay: '2026-10-20', at: bc('2026-10-21 08:00') }] };
  const ps = collect(plan(order, short, '2026-10-21 08:00'));
  assert.deepEqual(ps.actions.map((a) => [a.key, a.missedTruckDay, a.truckDay, a.readyBy]), [['#1550:delayed:2026-10-22', '2026-10-22', '2026-10-29', '2026-10-30']]);
  assert.equal(ps.readyAt, bc('2026-10-30 09:00'));

  // Paid Thursday after 14:00: an earlier Friday run would still miss the Thursday truck, so nothing to ask.
  const late = plan(powell('#1551', '2026-10-22 16:00'), {}, '2026-10-22 16:00');
  assert.deepEqual(keys(late), ['#1551:ordering_in']);
  assert.equal(late.status, 'ordered_in');
  // Paid Monday after 14:00: confirming Tuesday gets this Thursday's truck, so ask.
  const mon = plan(powell('#1552', '2026-10-19 16:00'), {}, '2026-10-19 16:00');
  assert.deepEqual(mon.actions.map((a) => [a.key, a.supplierRunDay, a.readyByIfConfirmed]).slice(0, 1), [['#1552:supplier_confirm_request', '2026-10-20', '2026-10-23']]);
  assert.equal(plan(powell('#1552', '2026-10-19 16:00'), { supplierConfirmed: true }, '2026-10-19 17:00').readyAt, bc('2026-10-23 09:00'));
});

test('idempotent: the same inputs give the same keys; done keys suppress; undone ones keep coming back', () => {
  const order = sechelt('#1560', '2026-10-19 16:00');
  const a = plan(order, {}, '2026-10-21 08:00');
  const b = plan(order, {}, '2026-10-21 08:00');
  assert.deepEqual(a, b);
  assert.deepEqual(keys(plan(order, {}, '2026-10-19 16:00')), ['#1560:supplier_confirm_request', '#1560:ordering_in']);
  assert.deepEqual(keys(plan(order, {}, '2026-10-19 23:00')), ['#1560:supplier_confirm_request', '#1560:ordering_in'], 'nothing recorded: same keys, same at');
  const half = { done: { '#1560:ordering_in': bc('2026-10-19 16:00') } };
  assert.deepEqual(keys(plan(order, half, '2026-10-19 23:00')), ['#1560:supplier_confirm_request']);
  const all = { done: { '#1560:ordering_in': 'x', '#1560:supplier_confirm_request': 'x' } };
  assert.deepEqual(keys(plan(order, all, '2026-10-19 23:00')), []);
  const at = plan(order, {}, '2026-10-19 23:00').actions.map((x) => x.at);
  assert.deepEqual(at, [bc('2026-10-19 16:00'), bc('2026-10-19 16:00')], 'at is when it became due, not now');
  // A runner that was down: the truck email is only for the truck day; a late Ready does not drag old emails along.
  const down = plan(sechelt('#1561', '2026-10-19 10:00'), {}, '2026-10-21 10:00');
  assert.deepEqual(keys(down), ['#1561:mark_ready']);
  const r2 = plan(sechelt('#1562', '2026-10-19 10:00'), { markedReadyAt: bc('2026-10-21 09:00') }, '2026-10-30 12:00');
  assert.deepEqual(keys(r2), ['#1562:reminder_2'], 'reminder_1 is stale once reminder_2 is due');
});

test('cancelled or picked up: nothing, and the status says so', () => {
  const due = '2026-10-21 09:00';
  const order = sechelt('#1570', '2026-10-19 10:00');
  assert.ok(plan(order, {}, due).actions.length > 0, 'there would be actions');
  for (const [o, st, status] of [
    [{ ...order, cancelled: true }, {}, 'cancelled'],
    [{ ...order, cancelledAt: bc('2026-10-20 10:00') }, {}, 'cancelled'],
    [{ ...order, pickedUpAt: bc('2026-10-21 08:30') }, {}, 'picked_up'],
    [order, { pickedUpAt: bc('2026-10-22 10:00'), markedReadyAt: bc('2026-10-21 09:00') }, 'picked_up'],
  ]) {
    const p = plan(o, st, due);
    assert.deepEqual(p.actions, [], status);
    assert.equal(p.nextCheckAt, null, status);
    assert.equal(p.status, status);
  }
});

test('bad input throws instead of guessing', () => {
  const order = sechelt('#1580', '2026-10-19 10:00');
  assert.throws(() => A.planActions({ order, state: {} }), /now must be a time/);
  assert.throws(() => A.planActions({ order, state: {}, now: '2026-10-19' }), /now must be a time/);
  assert.throws(() => A.planActions({ order, state: {}, now: '2026-02-30T10:00' }), /now must be a time/);
  assert.throws(() => A.planActions({ order: { ...order, name: '' }, now: bc('2026-10-19 10:00') }), /order\.name/);
  assert.throws(() => plan({ ...order, location: 'gibsons' }, {}, '2026-10-19 10:00'), /unknown pickup location/);
  assert.throws(() => plan(order, {}, '2026-10-19 10:00', { ...schedule, automation: { business_hours: { open: '16:00', close: '08:00' } } }), /open must be before close/);
  assert.throws(() => plan(order, {}, '2026-10-19 10:00', { ...schedule, automation: { on_truck_time: '11am' } }), /on_truck_time must be HH:MM/);
  assert.throws(() => plan(order, {}, '2026-10-19 10:00', { ...schedule, utc_offset_hours: -8 }), /-7/);
});

test('every customer action builds a real message with pickup-messages (no copy problems)', () => {
  const types = new Set(sent.map((a) => a.message));
  for (const t of ['ordering_in', 'on_truck', 'delayed', 'received_in_stock']) assert.ok(types.has(t), t);
  const reminders = ['reminder_1', 'reminder_2'].map((m) => plan(sechelt('#1590', '2026-10-19 10:00'), { markedReadyAt: bc('2026-10-21 09:00') }, m === 'reminder_1' ? '2026-10-26 10:00' : '2026-10-30 10:00').actions[0]);
  for (const a of [...sent, ...reminders]) {
    const m = msgs.buildPickupMessage(a.message, a);
    assert.match(m.subject, new RegExp(a.orderName), a.key);
    assert.match(m.text, /^Hi Sam,/, a.key);
    assert.deepEqual(msgs.customerTextProblems(`${m.subject}\n${m.text}`), [], a.key);
  }
  assert.equal(msgs.buildPickupMessage('reminder_1', reminders[0]).text.includes('ready for pickup since Wednesday, October 21'), true);
});

test('digestFor: the warehouse list for Tue Oct 20, plain prose with HOLD and SHORT explained', () => {
  const orders = [
    sechelt('#1600', '2026-10-19 10:00'), // on the Tuesday run
    sechelt('#1601', '2026-10-19 16:00'), // waiting on the supplier's confirmation for today's run
    sechelt('#1602', '2026-10-19 15:30', ['on_shelf']), // marked ready automatically at 08:00
    sechelt('#1603', '2026-10-19 11:00'), // held
    sechelt('#1598', '2026-10-14 10:00', ['on_shelf']), // ready since last Wednesday
    sechelt('#1597', '2026-10-19 09:00'), // the supplier was short for today's run
    powell('#1605', '2026-10-16 10:00'), // arrives on today's run for Thursday's Powell River truck
    { ...sechelt('#1596', '2026-10-19 10:00'), cancelled: true },
    sechelt('#1595', '2026-10-14 10:00', ['on_shelf']), // picked up
  ];
  const states = {
    '#1600': { done: { '#1600:ordering_in': 'x' } },
    '#1603': { holds: [{ at: bc('2026-10-19 17:00'), by: 'Doug', note: 'Customer asked us to wait — call first -> then release' }] },
    '#1598': { markedReadyAt: bc('2026-10-14 12:00') },
    '#1597': { done: { '#1597:ordering_in': 'x' }, shorts: [{ truckDay: '2026-10-20', at: bc('2026-10-19 17:00') }] },
    '#1595': { markedReadyAt: bc('2026-10-14 12:00'), pickedUpAt: bc('2026-10-16 12:00') },
  };
  const d = A.digestFor({ orders, states, date: '2026-10-20' });
  const names = (list) => list.map((x) => x.order);
  assert.equal(d.subject, 'Pickup orders for Tuesday, October 20');
  assert.deepEqual(names(d.autoReadyToday), ['#1602']);
  assert.equal(d.autoReadyToday[0].time, '08:00');
  assert.deepEqual(d.onTruckToday.map((x) => [x.order, x.leg, x.truckDay]), [['#1600', 'supplier_run', '2026-10-20'], ['#1605', 'supplier_run', '2026-10-22']]);
  assert.deepEqual(d.waitingForPickup.map((x) => [x.order, x.readySince, x.businessDaysWaiting]), [['#1598', '2026-10-14', 4]]);
  assert.deepEqual(d.held.map((x) => [x.order, x.by, x.sinceDate]), [['#1603', 'Doug', '2026-10-19']]);
  assert.deepEqual(d.shorted.map((x) => [x.order, x.missedTruckDay, x.truckDay, x.readyBy]), [['#1597', '2026-10-20', '2026-10-23', '2026-10-26']]);
  assert.deepEqual(d.needsSupplierConfirm.map((x) => [x.order, x.runDay, x.readyByIfConfirmed, x.promisedReadyBy]), [['#1601', '2026-10-20', '2026-10-21', '2026-10-26']]);
  assert.deepEqual(d.errors, []);

  const t = d.text;
  assert.match(t, /^Pickup orders for Tuesday, October 20\./);
  assert.match(t, /#1602 at Sechelt Warehouse is marked ready at 8:00 am\./);
  assert.match(t, /#1600 for Sechelt Warehouse comes in on today's supplier run\./);
  assert.match(t, /#1605 for Powell River Showroom & Warehouse comes in on today's supplier run and goes on the Thursday, October 22 truck\./);
  assert.match(t, /#1598 at Sechelt Warehouse: ready since Wednesday, October 14, waiting 4 business days\./);
  assert.match(t, /#1603 at Sechelt Warehouse, held by Doug since Monday, October 19: Customer asked us to wait, call first to then release\./);
  assert.match(t, /#1597 for Sechelt Warehouse did not come in for the Tuesday, October 20 truck\. It is now on the Friday, October 23 truck, ready Monday, October 26\./);
  assert.match(t, /#1601 for Sechelt Warehouse can make the Tuesday, October 20 run if the supplier confirms/);
  assert.match(t, /Replying HOLD or SHORT with an order number stops the automation for that order\./);
  assert.match(t, /HOLD, for example HOLD #1602, pauses it until someone releases it\./);
  assert.match(t, /SHORT, for example SHORT #1602, means the truck did not bring it/);
  assert.doesNotMatch(t, /#1596|#1595/, 'cancelled and picked-up orders are left out');
  assert.doesNotMatch(t, /[—–]/, 'no em or en dash');
  assert.doesNotMatch(t, /->|=>|→/, 'no arrows');
  assert.doesNotMatch(t, /prosol/i, 'never the distributor');
  assert.doesNotMatch(t, /[[\]<>{}]/, 'no bracketed keys');
  assert.deepEqual(A.digestTextProblems(t), []);
  assert.deepEqual(A.digestTextProblems('a -> b — Prosol [x]'), ['dash', 'arrow', 'bracket', 'names the distributor']);

  // Thursday: the Powell River order goes on the truck; states as an array works too.
  const thu = A.digestFor({ orders: [orders[6]], states: [{ done: {} }], date: '2026-10-22' });
  assert.deepEqual(thu.onTruckToday.map((x) => [x.order, x.leg]), [['#1605', 'transfer_truck']]);
  assert.match(thu.text, /#1605 goes on today's truck to Powell River Showroom & Warehouse\./);

  // A bad order does not sink the digest; an empty day says so.
  const bad = A.digestFor({ orders: [{ name: '#1699', paidAt: 'soon', location: 'sechelt', lines: ['on_shelf'] }], date: '2026-10-20' });
  assert.deepEqual(bad.errors.map((e) => e.order), ['#1699']);
  assert.match(bad.text, /#1699 could not be planned automatically\./);
  assert.equal(A.digestFor({ orders: [], date: '2026-10-20' }).text, 'Pickup orders for Tuesday, October 20.\n\nNothing needs anything today.\n');
  assert.throws(() => A.digestFor({ orders: [], date: '2026-02-30' }), /not a real date/);
});
