'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSampleDigest } = require('./sample-watch');

const now = new Date('2026-10-08T15:30:00Z');
const lisa = {
  order: '1400', customer: 'Lisa Durant', email: 'lisa@example.com', city: 'Guelph', province: 'ON',
  pieces: ['A', 'B', 'C'], deliveredAt: '2026-10-05T18:00:00Z', tracking: '1Z', stale: false,
};
const empty = { seen: {}, ledger: {}, followups: {}, lastSentAt: null };

test('a delivered sample order produces a follow-up digest and is recorded once', () => {
  const d = buildSampleDigest({ scan: { orders: [] }, followUps: [lisa], state: empty, now });
  assert.equal(d.shouldSend, true);
  assert.match(d.subject, /1 sample customer ready for a follow-up/);
  assert.match(d.body, /Order 1400, Lisa Durant in Guelph ON \(lisa@example.com\): 3 samples delivered Oct 5/);
  assert.doesNotMatch(d.body, /Stuck orders/);
  assert.equal(d.state.followups['1400'].sentAt, now.toISOString());
  assert.equal(d.counts.followUp, 1);
});

test('stale deliveries are recorded as skipped and do not send', () => {
  const d = buildSampleDigest({ scan: { orders: [] }, followUps: [{ ...lisa, stale: true }], state: empty, now });
  assert.equal(d.shouldSend, false);
  assert.ok(d.state.followups['1400'].skipped);
});

test('follow-ups and stuck orders share one email', () => {
  const stuck = { order: '1353', orderId: 1, age: 3, stage: 'no-ask', detail: 'no vendor has been asked, 3 days after the order',
    customer: 'Kristy G', city: 'Beaumont', province: 'AB', pieces: ['X'], voidedLabels: 0 };
  const d = buildSampleDigest({ scan: { orders: [stuck] }, followUps: [lisa], state: empty, now });
  assert.match(d.subject, /ready for a follow-up, 1 sample order needs attention/);
  assert.ok(d.body.indexOf('Ready for a follow-up') < d.body.indexOf('Newly stuck'));
  assert.match(d.body, /Stuck orders do not move/);
});

test('no follow-ups and nothing stuck stays quiet', () => {
  const d = buildSampleDigest({ scan: { orders: [] }, followUps: [], state: empty, now });
  assert.equal(d.shouldSend, false);
});
