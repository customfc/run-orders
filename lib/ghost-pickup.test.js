'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextBusinessDay, voidAfterFor } = require('./ghost-pickup');

// Dates are built in server-local time, the same clock the module uses.
test('Friday booking picks up Monday and voids Tuesday noon, after the pickup', () => {
  const fri = new Date(2026, 9, 2, 13, 50); // Fri Oct 2, 1:50 PM
  const pickup = nextBusinessDay(fri);
  assert.equal(pickup, '2026-10-05');
  const v = voidAfterFor(pickup);
  assert.equal(v.getDate(), 6);
  assert.equal(v.getHours(), 12);
  assert.ok(v > new Date(2026, 9, 5, 23, 59));
});

test('evening bookings keep the local date (no UTC rollover)', () => {
  assert.equal(nextBusinessDay(new Date(2026, 9, 1, 18, 30)), '2026-10-02'); // Thu evening -> Fri, not Sat
  assert.equal(nextBusinessDay(new Date(2026, 9, 2, 21, 0)), '2026-10-05');  // Fri evening -> Mon, not Tue
});

test('void is always the day after the pickup, across month ends', () => {
  const v = voidAfterFor('2026-10-30');
  assert.equal(v.getMonth(), 9);
  assert.equal(v.getDate(), 31);
  const w = voidAfterFor('2026-10-31');
  assert.equal(w.getMonth(), 10);
  assert.equal(w.getDate(), 1);
});

test('an orphan ghost shipped Friday voids Tuesday noon, after its Monday pickup', () => {
  const v = voidAfterFor(nextBusinessDay(new Date(2026, 9, 2, 12)));
  assert.equal(v.getDate(), 6);
  assert.equal(v.getHours(), 12);
});
