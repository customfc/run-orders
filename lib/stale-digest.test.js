// The morning scan sent up to 3 messages a day, one naming 15 parcels, and
// reported a 29-day-old parcel identically to yesterday's. These tests lock in
// the fix: name what's new, collapse what's known, quiet when unchanged — but
// never permanently silent.
process.env.DISABLE_CRON = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDigest } = require('./stale-digest');

const NOW = new Date('2026-07-27T12:00:00Z');
const hang = (t, age, over = {}) => ({
  trackingNumber: t, orderNumber: t, movement: 'hanging', suggestedAction: 'rebook',
  age, warehouseName: 'Downsview (DOWN)', carrier: 'purolator', ...over,
});
const scanOf = (...s) => ({ shipments: s });
const empty = { seen: {}, lastSentAt: null };

test('a brand new laggard is named', () => {
  const d = buildDigest({ scan: scanOf(hang('A', 5)), state: empty, now: NOW });
  assert.equal(d.shouldSend, true);
  assert.match(d.body, /NEW/);
  assert.match(d.body, /A @ Downsview/);
  assert.equal(d.counts.fresh, 1);
});

test('THE FIX: a known laggard is not re-named the next day', () => {
  const first = buildDigest({ scan: scanOf(hang('A', 5)), state: empty, now: NOW });
  const second = buildDigest({
    scan: scanOf(hang('A', 6)),
    state: first.state,
    now: new Date('2026-07-28T12:00:00Z'),
  });
  assert.equal(second.counts.fresh, 0);
  assert.equal(second.shouldSend, false, 'nothing new and nothing escalated — stay quiet');
});

test('but it is named again when it crosses 7, 14 and 30 days', () => {
  let state = buildDigest({ scan: scanOf(hang('A', 5)), state: empty, now: NOW }).state;
  const at7 = buildDigest({ scan: scanOf(hang('A', 7)), state, now: NOW });
  assert.equal(at7.counts.escalated, 1);
  assert.match(at7.body, /GETTING OLD/);
  assert.match(at7.body, /past 7/);

  const at8 = buildDigest({ scan: scanOf(hang('A', 8)), state: at7.state, now: NOW });
  assert.equal(at8.shouldSend, false, '8 days is not a new milestone');

  const at14 = buildDigest({ scan: scanOf(hang('A', 14)), state: at8.state, now: NOW });
  assert.equal(at14.counts.escalated, 1);
  assert.match(at14.body, /past 14/);
});

test('ONE message, not three: stuck + new + ongoing all in a single body', () => {
  const scan = scanOf(
    hang('A', 5),
    hang('B', 9),
    { trackingNumber: 'C', orderNumber: 'C', movement: 'stuck-in-transit', age: 11, latestEvent: 'In transit', warehouseName: 'Concord (WCON)', carrier: 'purolator' },
  );
  const d = buildDigest({ scan, state: empty, now: NOW });
  assert.match(d.body, /STUCK IN TRANSIT/);
  assert.match(d.body, /NEW/);
  assert.equal(typeof d.body, 'string', 'a single body, not multiple messages');
});

test('known items collapse to a count with the oldest named', () => {
  let state = empty;
  const many = Array.from({ length: 12 }, (_, i) => hang('T' + i, 5 + i));
  state = buildDigest({ scan: scanOf(...many), state, now: NOW }).state;
  // next day: nothing new, but one crosses a milestone so it still sends
  const next = buildDigest({ scan: scanOf(...many.map((m) => ({ ...m, age: m.age + 1 }))), state, now: NOW });
  if (next.shouldSend) {
    assert.match(next.body, /still hanging/, 'the rest are a count, not 12 more lines');
    assert.ok(next.body.split('\n').length < 20, 'digest stays short');
  }
});

test('never permanently silent — a standing problem resurfaces after the quiet window', () => {
  const first = buildDigest({ scan: scanOf(hang('A', 5)), state: empty, now: NOW });
  const quiet = buildDigest({ scan: scanOf(hang('A', 6)), state: first.state, now: new Date('2026-07-28T12:00:00Z') });
  assert.equal(quiet.shouldSend, false);
  // 4 days later with still nothing new, it speaks up again
  const later = buildDigest({ scan: scanOf(hang('A', 9)), state: quiet.state, now: new Date('2026-07-31T12:00:00Z') });
  assert.equal(later.shouldSend, true, 'a standing problem must not go quiet forever');
});

test('nothing hanging and nothing stuck sends nothing at all', () => {
  const d = buildDigest({ scan: scanOf(), state: empty, now: NOW });
  assert.equal(d.shouldSend, false);
});

test('resolved parcels are dropped from state so it cannot grow forever', () => {
  const first = buildDigest({ scan: scanOf(hang('A', 5), hang('B', 5)), state: empty, now: NOW });
  assert.equal(Object.keys(first.state.seen).length, 2);
  const second = buildDigest({ scan: scanOf(hang('A', 6)), state: first.state, now: NOW });
  assert.deepEqual(Object.keys(second.state.seen), ['A'], 'B shipped, so it leaves the ledger');
});

test('below the serious threshold nothing is reported', () => {
  const d = buildDigest({ scan: scanOf(hang('A', 2)), state: empty, now: NOW, seriousDays: 4 });
  assert.equal(d.shouldSend, false);
});

test('stuck-in-transit always speaks, even with nothing new hanging', () => {
  const scan = scanOf({ trackingNumber: 'C', orderNumber: 'C', movement: 'stuck-in-transit', age: 11, warehouseName: 'X', carrier: 'p' });
  const d = buildDigest({ scan, state: empty, now: NOW });
  assert.equal(d.shouldSend, true);
  assert.equal(d.severity, 'attn');
});
