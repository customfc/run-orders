// Pickup ETA: which day a Coast pickup order is ready. A wrong date here goes straight into a customer email,
// so every rule in data/trade/pickup-schedule.json has a case. Dates are BC (UTC-7 all year). Run: `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const eta = require('./pickup-eta');
const schedule = require('../data/trade/pickup-schedule.json');

// Wall times without a zone are BC time. The week of Mon Oct 19 2026 has no holiday.
const at = (paidAt, lines, location = 'sechelt') => eta.pickupEta({ paidAt, location, lines });
const shelf = ['on_shelf'];
const order = ['order_in'];
const pick = (r) => [r.kind, r.readyBy, r.truckDay];

test('the shipped schedule is valid: Tue and Fri runs, UTC-7, both Coast locations, the 2026 closures', () => {
  assert.deepEqual(eta.validateSchedule(schedule), []);
  assert.deepEqual(schedule.truck.run_days, ['tue', 'fri']);
  assert.equal(schedule.utc_offset_hours, -7);
  assert.deepEqual(Object.keys(schedule.locations), ['sechelt', 'powell_river']);
  const days = schedule.holidays.map((h) => h.date);
  for (const d of ['2026-09-30', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-26', '2027-01-01']) assert.ok(days.includes(d), d);
  const src = require('fs').readFileSync(require.resolve('./pickup-eta'), 'utf8');
  assert.doesNotMatch(src, /timeZone\s*:|toLocale|getHours\(|getDay\(|getDate\(/, 'no tz database and no machine-local getters');
});

test('on the shelf, paid Mon 10:00: ready today', () => {
  const r = at('2026-10-19T10:00', shelf);
  assert.deepEqual(pick(r), ['ready_now', '2026-10-19', null]);
  assert.equal(r.cutoff, null);
  assert.match(r.reason, /ready today/);
});

test('on the shelf, paid Mon 16:00 (after 14:00): ready Tue morning', () => {
  assert.deepEqual(pick(at('2026-10-19T16:00', shelf)), ['ready_now', '2026-10-20', null]);
  assert.deepEqual(pick(at('2026-10-19T13:59', shelf)), ['ready_now', '2026-10-19', null], 'one minute before the cutoff');
  assert.deepEqual(pick(at('2026-10-19T14:00', shelf)), ['ready_now', '2026-10-20', null], 'at 14:00 the cutoff has passed');
});

test('on the shelf, paid Fri late or on the weekend: ready Mon', () => {
  assert.deepEqual(pick(at('2026-10-23T16:30', shelf)), ['ready_now', '2026-10-26', null]);
  assert.deepEqual(pick(at('2026-10-24T09:00', shelf)), ['ready_now', '2026-10-26', null], 'Saturday');
  assert.deepEqual(pick(at('2026-10-25T09:00', shelf)), ['ready_now', '2026-10-26', null], 'Sunday');
});

test('ordered in, paid Mon 10:00: rides the Tue run, ready Wed', () => {
  const r = at('2026-10-19T10:00', order);
  assert.deepEqual(pick(r), ['order_in', '2026-10-21', '2026-10-20']);
  assert.deepEqual(r.cutoff, { date: '2026-10-19', time: '14:00', label: '2026-10-19 14:00' });
});

test('ordered in, paid Mon 14:00 or later: misses Tuesday, rides Friday, ready Mon', () => {
  assert.deepEqual(pick(at('2026-10-19T14:00', order)), ['order_in', '2026-10-26', '2026-10-23']);
});

test('ordered in, paid Tue 15:00: the Fri run, ready Mon', () => {
  const r = at('2026-10-20T15:00', order);
  assert.deepEqual(pick(r), ['order_in', '2026-10-26', '2026-10-23']);
  assert.equal(r.cutoff.date, '2026-10-22');
  assert.ok(r.skippedRuns.some((s) => s.date === '2026-10-20' && /cutoff/.test(s.why)), 'the same-day Tue run is already closed');
});

test('ordered in, paid Thu: before 14:00 makes Friday, after misses it and rides Tuesday', () => {
  assert.deepEqual(pick(at('2026-10-22T13:59', order)), ['order_in', '2026-10-26', '2026-10-23']);
  const late = at('2026-10-22T16:00', order);
  assert.deepEqual(pick(late), ['order_in', '2026-10-28', '2026-10-27']);
  assert.equal(late.cutoff.label, '2026-10-26 14:00');
  assert.match(late.reason, /cutoff Thu 2026-10-22 14:00 passed/);
});

test('ordered in, paid Fri late or on the weekend: the Tue run, ready Wed', () => {
  assert.deepEqual(pick(at('2026-10-23T17:00', order)), ['order_in', '2026-10-28', '2026-10-27']);
  assert.deepEqual(pick(at('2026-10-24T11:00', order)), ['order_in', '2026-10-28', '2026-10-27'], 'Saturday');
});

test('Sep 30 holiday: ready dates skip it, and a holiday order is ready the next business day', () => {
  // Mon Sep 28 10:00, ordered in: Tue Sep 29 run; Wed Sep 30 is closed, so ready Thu Oct 1.
  assert.deepEqual(pick(at('2026-09-28T10:00', order)), ['order_in', '2026-10-01', '2026-09-29']);
  // Tue Sep 29 10:00, ordered in: Tue's cutoff was Mon 14:00; Fri Oct 2 run (cutoff Thu Oct 1 14:00); ready Mon Oct 5.
  const tue = at('2026-09-29T10:00', order);
  assert.deepEqual(pick(tue), ['order_in', '2026-10-05', '2026-10-02']);
  assert.equal(tue.cutoff.date, '2026-10-01');
  // On the shelf, Tue Sep 29 16:00: the next business morning is Thu Oct 1, not the holiday.
  assert.deepEqual(pick(at('2026-09-29T16:00', shelf)), ['ready_now', '2026-10-01', null]);
  // Paid on the holiday itself, before 14:00: still not a business day.
  const h = at('2026-09-30T10:00', shelf);
  assert.deepEqual(pick(h), ['ready_now', '2026-10-01', null]);
  assert.match(h.reason, /National Day for Truth and Reconciliation/);
});

test('a run on a holiday is cancelled: Christmas Friday moves to Tuesday', () => {
  const r = at('2026-12-23T10:00', order);
  assert.deepEqual(pick(r), ['order_in', '2026-12-30', '2026-12-29']);
  assert.ok(r.skippedRuns.some((s) => s.date === '2026-12-25' && /Christmas/.test(s.why)));
  assert.deepEqual(pick(at('2026-12-30T10:00', order)), ['order_in', '2027-01-06', '2027-01-05'], 'New Year Friday is cancelled too');
});

test('Thanksgiving Monday moves the Tuesday cutoff back to Friday', () => {
  const r = at('2026-10-09T10:00', order);
  assert.deepEqual(pick(r), ['order_in', '2026-10-14', '2026-10-13']);
  assert.equal(r.cutoff.date, '2026-10-09');
  assert.deepEqual(pick(at('2026-10-09T15:00', order)), ['order_in', '2026-10-19', '2026-10-16'], 'after Friday 14:00: the next Friday');
  assert.deepEqual(pick(at('2026-10-12T09:00', order)), ['order_in', '2026-10-19', '2026-10-16'], 'on the holiday');
});

test('Powell River: ordered-in goods are one business day later; shelf stock is not', () => {
  assert.deepEqual(pick(at('2026-10-19T10:00', order, 'powell_river')), ['order_in', '2026-10-22', '2026-10-20']);
  assert.deepEqual(pick(at('2026-10-21T10:00', order, 'powell_river')), ['order_in', '2026-10-27', '2026-10-23'], 'Fri run: Sechelt Mon, Powell River Tue');
  assert.deepEqual(pick(at('2026-10-19T10:00', shelf, 'powell_river')), ['ready_now', '2026-10-19', null]);
});

test('a mixed order waits for its ordered-in line', () => {
  const r = at('2026-10-19T10:00', ['on_shelf', { sku: '4172', availability: 'order_in' }, { availability: 'on_shelf' }]);
  assert.deepEqual(pick(r), ['order_in', '2026-10-21', '2026-10-20']);
  assert.match(r.reason, /1 of 3 line\(s\) ordered in/);
  assert.deepEqual(pick(at('2026-10-19T10:00', [{ availability: 'on_shelf' }, { availability: 'on_shelf' }])), ['ready_now', '2026-10-19', null]);
});

test('BC is UTC-7 all year: zoned times convert with a fixed offset, also after Nov 1', () => {
  assert.deepEqual(pick(at('2026-10-19T17:00:00Z', shelf)), ['ready_now', '2026-10-19', null], '17:00Z = 10:00 BC');
  assert.deepEqual(pick(at('2026-10-19T21:30:00Z', shelf)), ['ready_now', '2026-10-20', null], '21:30Z = 14:30 BC');
  assert.deepEqual(pick(at('2026-10-20T03:00:00Z', shelf)), ['ready_now', '2026-10-20', null], '03:00Z Tue = Mon 20:00 BC');
  // 21:30Z on Mon Nov 2 is 14:30 BC. A stale tz database would say 13:30 (UTC-8) and promise today.
  assert.deepEqual(pick(at('2026-11-02T21:30:00Z', shelf)), ['ready_now', '2026-11-03', null]);
  assert.deepEqual(pick(at('2026-11-02T13:30:00-08:00', shelf)), ['ready_now', '2026-11-03', null], 'an explicit -08:00 is still 14:30 BC');
  assert.deepEqual(pick(at(new Date('2026-10-19T17:00:00Z'), shelf)), ['ready_now', '2026-10-19', null], 'a Date');
  assert.equal(eta.toBc('2026-10-19T10:00:00').label, '2026-10-19 10:00', 'no zone = BC wall time');
  assert.equal(eta.toBc(Date.parse('2026-12-01T20:00:00Z')).label, '2026-12-01 13:00');
});

test('bad input throws instead of guessing', () => {
  assert.throws(() => at('2026-10-19T10:00', ['in_stock']), /on_shelf or order_in/);
  assert.throws(() => at('2026-10-19T10:00', []), /at least one line/);
  assert.throws(() => at('2026-10-19T10:00', shelf, 'gibsons'), /unknown pickup location/);
  assert.throws(() => at('2026-10-19', shelf), /date and a time/);
  assert.throws(() => at('not a date', shelf), /date and a time/);
  assert.throws(() => eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: shelf }, { ...schedule, utc_offset_hours: -8 }), /-7/);
});

test('delayed: the run did not bring it, so it rides the next run (no cutoff)', () => {
  const r = eta.delayedEta({ missedTruckDay: '2026-10-20', location: 'sechelt' });
  assert.deepEqual(pick(r), ['order_in', '2026-10-26', '2026-10-23']);
  assert.deepEqual(pick(eta.delayedEta({ missedTruckDay: '2026-10-23', location: 'sechelt' })), ['order_in', '2026-10-28', '2026-10-27']);
  assert.deepEqual(pick(eta.delayedEta({ missedTruckDay: '2026-12-22', location: 'sechelt' })), ['order_in', '2026-12-30', '2026-12-29'], 'skips the Christmas run');
  assert.deepEqual(pick(eta.delayedEta({ missedTruckDay: '2026-10-20', location: 'powell_river' })), ['order_in', '2026-10-27', '2026-10-23']);
});

test('reminders: 3 and 7 business days after the ready date', () => {
  assert.deepEqual(eta.reminderDates('2026-10-19'), { first: '2026-10-22', second: '2026-10-28' });
  assert.deepEqual(eta.reminderDates('2026-11-09'), { first: '2026-11-13', second: '2026-11-19' }, 'skips Remembrance Day, Wed Nov 11');
});

test('customer date format', () => {
  assert.equal(eta.formatCustomerDate('2026-10-02'), 'Friday, October 2');
  assert.equal(eta.formatCustomerDate('2026-12-29'), 'Tuesday, December 29');
  assert.equal(eta.formatCustomerDate('2027-01-05', { year: true }), 'Tuesday, January 5, 2027');
  assert.throws(() => eta.formatCustomerDate('2026-02-30'), /not a real date/);
});

test('helpers: truck days and business days follow the holidays', () => {
  assert.equal(eta.isTruckDay('2026-10-20'), true);
  assert.equal(eta.isTruckDay('2026-10-21'), false);
  assert.equal(eta.isTruckDay('2026-12-25'), false, 'Christmas Friday: no run');
  assert.equal(eta.isBusinessDay('2026-09-30'), false);
  assert.equal(eta.addBusinessDays('2026-10-09', 1), '2026-10-13', 'over Thanksgiving');
});

test('dates past the holiday list carry a warning', () => {
  assert.deepEqual(at('2026-10-19T10:00', order).warnings, []);
  const late = at('2027-02-12T16:00', order);
  assert.equal(late.warnings.length, 1);
  assert.match(late.warnings[0], /past the holiday list/);
});
