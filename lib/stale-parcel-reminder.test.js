// Tests for the stale-parcel reminder. These lock down the conditions that make
// the reminder fair to send — every one of them came from a real failure on
// 2026-07-27, not from imagination.
process.env.DISABLE_CRON = '1';
process.env.STALE_REMINDER_DAYS = '4';
process.env.STALE_REMINDER_ESCALATE_DAYS = '8';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findStale, buildBranchEmail, bizDaysBetween, runReminderSweep } = require('./stale-parcel-reminder');

const DOWNSVIEW = 1869852;   // Prosol branch
const SECHELT = 147654;      // our own warehouse — non_prosol
const NOW = new Date('2026-07-27T18:00:00Z'); // a Monday

function ship(over = {}) {
  return {
    trackingNumber: 'T1', orderNumber: '1316', carrierCode: 'purolator_walleted',
    warehouseId: DOWNSVIEW, shipDate: '2026-07-17', shipmentCost: 13.96, voided: false,
    shipTo: { city: 'Toronto', state: 'ON' }, ...over,
  };
}
const run = (ships, opts = {}) => findStale({
  now: NOW,
  listShipments: async () => ships,
  checkScan: async () => ({ known: true, scanned: false }),
  state: { reminded: {}, escalated: {} },
  ...opts,
});

test('bizDaysBetween ignores the weekend', () => {
  // Fri 2026-07-24 -> Mon 2026-07-27 is one business day, not three
  assert.equal(bizDaysBetween('2026-07-24', new Date('2026-07-27T12:00:00Z')), 1);
  assert.equal(bizDaysBetween('2026-07-20', new Date('2026-07-27T12:00:00Z')), 5);
});

test('flags a Purolator parcel with no scan past the trigger', async () => {
  const r = await run([ship()]);
  assert.equal(r.due.length, 1);
  assert.equal(r.byBranch.length, 1);
  assert.equal(r.byBranch[0].branch, 'Downsview (DOWN)');
});

test('PUROLATOR ONLY — Canada Post never triggers', async () => {
  // CP reports zero tracking events at any age; it would otherwise nag forever
  const r = await run([ship({ carrierCode: 'canada_post_walleted' })]);
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.otherCarrier, 1);
});

test('PUROLATOR ONLY — the dead walleted UPS account never triggers', async () => {
  const r = await run([ship({ carrierCode: 'ups_walleted' })]);
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.otherCarrier, 1);
});

test('our own Sechelt warehouse is never emailed as a vendor', async () => {
  const r = await run([ship({ warehouseId: SECHELT })]);
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.notProsol, 1);
});

test('a voided label never triggers', async () => {
  const r = await run([ship({ voided: true })]);
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.voided, 1);
});

test('a parcel that HAS moved never triggers', async () => {
  const r = await run([ship()], { checkScan: async () => ({ known: true, scanned: true }) });
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.scanned, 1);
});

test('an unverifiable parcel never triggers — never accuse on a lookup failure', async () => {
  const r = await run([ship()], { checkScan: async () => ({ known: false, scanned: false }) });
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.unknown, 1);
});

test('under the trigger it waits', async () => {
  // 2026-07-23 -> 2026-07-27 is 2 business days
  const r = await run([ship({ shipDate: '2026-07-23' })]);
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped.tooRecent, 1);
});

test('ONE EMAIL PER BRANCH, never one per parcel', async () => {
  const r = await run([
    ship({ trackingNumber: 'A', orderNumber: '1', warehouseId: DOWNSVIEW }),
    ship({ trackingNumber: 'B', orderNumber: '2', warehouseId: DOWNSVIEW }),
    ship({ trackingNumber: 'C', orderNumber: '3', warehouseId: 1793487 }),
  ]);
  assert.equal(r.due.length, 3);
  assert.equal(r.byBranch.length, 2, 'three parcels across two branches = two emails');
  const down = r.byBranch.find((g) => g.branch === 'Downsview (DOWN)');
  assert.equal(down.parcels.length, 2);
});

test('a branch is asked ONCE — no repeat nagging', async () => {
  const state = { reminded: { T1: { at: '2026-07-20T00:00:00Z' } }, escalated: {} };
  const r = await run([ship()], { state });
  assert.equal(r.due.length, 0, 'already asked, do not ask again');
  assert.equal(r.skipped.alreadyReminded, 1);
});

test('past the escalation point it comes to Mac instead of the vendor', async () => {
  const state = { reminded: { T1: { at: '2026-07-16T00:00:00Z' } }, escalated: {} };
  // 2026-07-13 -> 2026-07-27 is 10 business days, past ESCALATE of 8
  const r = await run([ship({ shipDate: '2026-07-13' })], { state });
  assert.equal(r.due.length, 0, 'the vendor is not emailed a second time');
  assert.equal(r.escalate.length, 1, 'it becomes ours to chase');
});

test('the email asks rather than accuses, and lists every parcel', () => {
  const { subject, text, html } = buildBranchEmail({
    branch: 'Downsview (DOWN)', email: 'order.downsview@prosol.ca',
    parcels: [
      { tracking: 'T1', order: '1316', shipDate: '2026-07-17', bizDays: 6, cost: 13.96 },
      { tracking: 'T2', order: '1317', shipDate: '2026-07-18', bizDays: 5, cost: 10 },
    ],
  });
  assert.match(subject, /Downsview \(DOWN\)/);
  assert.match(text, /Can you confirm/, 'a question, not a chase — a third of these turn out to be ours');
  assert.ok(text.includes('T1') && text.includes('T2'), 'every parcel listed');
  assert.ok(html.includes('1316') && html.includes('1317'));
  assert.ok(!/why has|failed to|unacceptable/i.test(text), 'no accusatory language');
  assert.ok(!/these parcel is/.test(text), 'singular/plural must agree');
});

test('singular and plural both read correctly', () => {
  const one = buildBranchEmail({ branch: 'Downsview (DOWN)', parcels: [{ tracking: 'T1', order: '1316', shipDate: '2026-07-17', bizDays: 4, cost: 1 }] });
  assert.match(one.text, /whether this parcel is still at/);
  assert.match(one.subject, /1 parcel with/);
  const two = buildBranchEmail({ branch: 'Brossard (BROS)', parcels: [
    { tracking: 'T1', order: 'a', shipDate: '2026-07-17', bizDays: 4, cost: 1 },
    { tracking: 'T2', order: 'b', shipDate: '2026-07-17', bizDays: 4, cost: 1 }] });
  assert.match(two.text, /whether these 2 parcels are still at/);
  assert.match(two.subject, /2 parcels with/);
});

test('SHADOW mode sends nothing', async () => {
  const sent = [];
  const r = await runReminderSweep({
    live: false,
    now: NOW,
    listShipments: async () => [ship()],
    checkScan: async () => ({ known: true, scanned: false }),
    state: { reminded: {}, escalated: {} },
    sendMail: async (m) => { sent.push(m); },
    notify: async () => {},
    auditLog: () => {},
    persist: () => {},
  });
  assert.equal(sent.length, 0, 'shadow must not send');
  assert.equal(r.byBranch.length, 1, 'but it still reports what it would send');
});

test('live mode sends one mail per branch and records it so it never repeats', async () => {
  const sent = [];
  const state = { reminded: {}, escalated: {} };
  await runReminderSweep({
    live: true,
    now: NOW,
    listShipments: async () => [ship({ trackingNumber: 'A' }), ship({ trackingNumber: 'B' })],
    checkScan: async () => ({ known: true, scanned: false }),
    state,
    sendMail: async (m) => { sent.push(m); },
    notify: async () => {},
    auditLog: () => {},
    persist: () => {},
  });
  assert.equal(sent.length, 1, 'two parcels at one branch = one email');
  assert.ok(state.reminded.A && state.reminded.B, 'both parcels recorded as asked');
  assert.match(sent[0].cc, /mac@customfc\.ca/);
});
