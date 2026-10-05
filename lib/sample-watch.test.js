'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSampleDigest, stageFor, readTrack } = require('./sample-watch');

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

// #1374's Unifloor half as ShipStation V2 really returned it on 2026-10-05.
// UPS files the Pickup Scan under AC, the same code as "label created".
const track1374 = {
  status_code: 'IT',
  events: [
    { status_code: 'IT', occurred_at: '2026-10-02T18:22:00Z', description: 'Departed from Facility' },
    { status_code: 'IT', occurred_at: '2026-10-02T04:03:03Z', description: 'Arrived at Facility' },
    { status_code: 'AC', occurred_at: '2026-10-01T17:32:11Z', description: 'Pickup Scan' },
    { status_code: 'NY', occurred_at: '2026-09-29T22:07:43Z', description: 'Shipper created a label, UPS has not received the package yet.' },
  ],
};
const label = (track) => ({ trackingNumber: '1ZH0R6652032583627', createDate: '2026-09-29T15:07:00', carrierCode: 'ups_walleted', track });
const asked = [{ vendor: 'Unifloor', at: '2026-09-28T19:00:00Z' }];

test('the UPS Pickup Scan counts as a scan even though it is coded AC', () => {
  const t = readTrack(track1374);
  assert.equal(t.known, true);
  assert.equal(t.scanned, true);
  assert.equal(t.scannedAt, '2026-10-01T17:32:11Z');
  assert.equal(t.deliveredAt, null);
});

test('a label the carrier has only heard about is not scanned', () => {
  const t = readTrack({ status_code: 'NY', events: [track1374.events[3]] });
  assert.equal(t.known, true);
  assert.equal(t.scanned, false);
});

test('a failed lookup is unknown, never "not picked up"', () => {
  assert.deepEqual(readTrack(null), { known: false, scanned: false, scannedAt: null, deliveredAt: null });
});

test('#1374: a scanned label is not idle, however old it is', () => {
  const s = stageFor({ age: 18, asks: asked, labels: [label(readTrack(track1374))], now: new Date('2026-10-05T12:30:00Z') });
  assert.equal(s.stage, 'ok');
});

test('#1374: still open 5 days after pickup names the pickup and what to do', () => {
  const s = stageFor({ age: 20, asks: asked, labels: [label(readTrack(track1374))], now: new Date('2026-10-07T15:30:00Z') });
  assert.equal(s.stage, 'open-after-pickup');
  assert.match(s.detail, /^UPS picked up 1ZH0R6652032583627 on Oct 1 but the order is still open/);
});

test('a label never scanned is idle and says the carrier has not picked it up', () => {
  const s = stageFor({ age: 10, asks: asked, labels: [label(readTrack({ status_code: 'NY', events: [] }))], now: new Date('2026-10-05T12:30:00Z') });
  assert.equal(s.stage, 'label-idle');
  assert.match(s.detail, /bought \d+ days ago, and UPS has not picked it up$/);
});

test('an unreadable track on an old label still surfaces, without accusing anyone', () => {
  const s = stageFor({ age: 10, asks: asked, labels: [label(readTrack(null))], now: new Date('2026-10-05T12:30:00Z') });
  assert.equal(s.stage, 'label-idle');
  assert.match(s.detail, /its tracking could not be read$/);
});

test('no-ask and no-reply rules are unchanged', () => {
  assert.equal(stageFor({ age: 3, asks: [], labels: [] }).stage, 'no-ask');
  const s = stageFor({ age: 9, asks: asked, labels: [], now: new Date('2026-10-05T12:30:00Z') });
  assert.equal(s.stage, 'no-reply');
});
