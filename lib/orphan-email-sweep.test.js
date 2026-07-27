// Regression tests for the orphan-email sweep — the backstop that catches
// labels bought but never emailed to the warehouse.
//
// The bug these lock down (2026-07-21): five labels were bought at 18:24–18:33
// UTC, AFTER the day's only email tick finished at 18:04. The next day loads a
// fresh state file that doesn't contain them, so they were never emailed at
// all. Order 1316 sat unshipped for six days until the customer chased it, and
// the old 4-day sweep window let it age out of the report silently first.
//
// Run: `npm test`  (or `node --test lib/orphan-email-sweep.test.js`)

process.env.DISABLE_CRON = '1';
process.env.ORPHAN_SWEEP_SEND_DAYS = '14';
process.env.ORPHAN_SWEEP_DETECT_DAYS = '60';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runOrphanSweep,
  outstanding,
  warehouseIsEmailable,
  SEND_LOOKBACK_DAYS,
  DETECT_LOOKBACK_DAYS,
} = require('./orphan-email-sweep');

const DOWNSVIEW = 1869852;   // real Prosol branch — emailable
const SECHELT = 147654;      // our own warehouse — emailable
const TREECO = 1637650;      // other vendor — never emailed by design
const UNMAPPED = 1941886;    // not in prosol-location-map.json

// Build a fake ops-state day containing labels, plus who was already emailed.
function day(date, labels, emailedOrderIds = []) {
  const byOrder = {};
  for (const id of emailedOrderIds) byOrder[String(id)] = { warehouse: 'X', at: `${date}T18:00:00Z` };
  return {
    date,
    phases: {
      stage: { runs: [] },
      buy: { labels },
      pos: { byTracking: {} },
      email: { byWarehouse: {}, byOrder, lastAlertAt: {} },
      pickups: { byGroup: {} },
    },
    errors: [],
  };
}

function label(orderNumber, warehouseId, extra = {}) {
  return { orderNumber, warehouseId, trackingNumber: `TRK${orderNumber}`, labelCost: 15, source: 'shopify', ...extra };
}

// Date N days before today in the same space the sweep scans.
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// A sweep run with everything network-y stubbed out.
function sweep(statesByDate, opts = {}) {
  return runOrphanSweep({
    live: false,
    checkVoided: async () => false,
    checkCancelled: async () => false,
    loadDayState: (d) => statesByDate[d] || day(d, {}),
    sendEmail: async () => ({ sent: [] }),
    // never touch data/ops-state from a test — opsState.save() writes a REAL
    // state file keyed on state.date, which would corrupt production state
    saveDayState: () => {},
    // nor data/audit.jsonl — a stubbed send must not leave a real 'sent' record
    // in the ledger that production history is reconstructed from
    auditLog: () => {},
    ...opts,
  });
}

test('warehouseIsEmailable: Prosol branch and Sechelt are emailable', () => {
  assert.equal(warehouseIsEmailable(DOWNSVIEW).emailable, true);
  assert.equal(warehouseIsEmailable(SECHELT).emailable, true);
});

test('warehouseIsEmailable: other vendors are not orphans, unmapped is an anomaly', () => {
  const treeco = warehouseIsEmailable(TREECO);
  assert.equal(treeco.emailable, false);
  assert.equal(treeco.anomaly, false, 'TREECO is intentional, must not be flagged as an anomaly');

  const unknown = warehouseIsEmailable(UNMAPPED);
  assert.equal(unknown.emailable, false);
  assert.equal(unknown.anomaly, true, 'an unmapped warehouse is a real config gap');
});

test('detects a label bought after the email tick on a prior day', async () => {
  const d = daysAgo(3);
  const r = await sweep({ [d]: day(d, { 1001: label('1316', DOWNSVIEW) }) });
  assert.equal(r.sendableShadow.length, 1);
  assert.equal(r.sendableShadow[0].orderNumber, '1316');
});

test('an already-emailed order is never re-sent', async () => {
  const d = daysAgo(3);
  const r = await sweep({ [d]: day(d, { 1001: label('1316', DOWNSVIEW) }, [1001]) });
  assert.equal(r.sendableShadow.length, 0);
  assert.equal(outstanding(r).length, 0);
});

test('THE REGRESSION: an orphan older than the send window is escalated, never silently dropped', async () => {
  const old = daysAgo(SEND_LOOKBACK_DAYS + 5);
  const r = await sweep({ [old]: day(old, { 2002: label('701-5518826-4465017', DOWNSVIEW, { source: 'amazon_ca' }) }) });
  assert.equal(r.sendableShadow.length, 0, 'too old to auto-send');
  assert.equal(r.tooOldToAutoSend.length, 1, 'but it MUST still be reported');
  assert.equal(r.tooOldToAutoSend[0].orderNumber, '701-5518826-4465017');
  assert.ok(outstanding(r).length >= 1, 'and it must count as outstanding so alerting keeps nagging');
});

test('detect window is much wider than the send window', () => {
  assert.ok(DETECT_LOOKBACK_DAYS > SEND_LOOKBACK_DAYS,
    'if these were equal, an ageing orphan would vanish from the report — the original bug');
});

test('other-vendor warehouses are not counted as orphans', async () => {
  const d = daysAgo(2);
  const r = await sweep({ [d]: day(d, { 3003: label('X-1', TREECO) }) });
  assert.equal(r.sendableShadow.length, 0);
  assert.equal(r.notEmailable.length, 1);
  assert.equal(outstanding(r).length, 0, 'TREECO must not generate permanent false-positive noise');
});

test('an unmapped warehouse is surfaced as an anomaly and counts as outstanding', async () => {
  const d = daysAgo(2);
  const r = await sweep({ [d]: day(d, { 4004: label('X-2', UNMAPPED) }) });
  assert.equal(r.anomalies.length, 1);
  assert.equal(outstanding(r).length, 1);
});

test('voided labels are skipped, not emailed', async () => {
  const d = daysAgo(2);
  const r = await sweep({ [d]: day(d, { 5005: label('X-3', DOWNSVIEW) }) }, { checkVoided: async () => true });
  assert.equal(r.voided.length, 1);
  assert.equal(r.sendableShadow.length, 0);
});

test('cancelled orders are skipped, not emailed', async () => {
  const d = daysAgo(2);
  const r = await sweep({ [d]: day(d, { 6006: label('X-4', DOWNSVIEW) }) }, { checkCancelled: async () => true });
  assert.equal(r.cancelled.length, 1);
  assert.equal(r.sendableShadow.length, 0);
});

test('an inconclusive check never auto-sends', async () => {
  const d = daysAgo(2);
  const r = await sweep({ [d]: day(d, { 7007: label('X-5', DOWNSVIEW) }) }, {
    checkVoided: async () => { throw new Error('ShipStation 503'); },
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.sendableShadow.length, 0, 'a lookup failure must not become a vendor email');
});

test('live mode sends and records what went out', async () => {
  const d = daysAgo(3);
  const calls = [];
  const r = await sweep({ [d]: day(d, { 8008: label('1316', DOWNSVIEW) }) }, {
    live: true,
    sendEmail: async (args) => { calls.push(args); return { sent: [{ warehouse: 'Downsview (DOWN)', orderCount: 1 }] }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].count, 1);
  assert.deepEqual(r.sent[0].orderNumbers, ['1316']);
});

test('the full 2026-07-21 scenario: 5 late-bought labels across 4 branches all surface', async () => {
  const d = daysAgo(6);
  const r = await sweep({
    [d]: day(d, {
      763910760: label('1313', 1793487),
      764122834: label('1314', 1852856),
      764696341: label('1315', 1869868),
      764915816: label('1316', DOWNSVIEW),
      765661579: label('702-3702412-5565024', 1852856, { source: 'amazon_ca' }),
      // the six that DID get emailed that day must not reappear
      765304493: label('702-3414577-7454667', 1814007, { source: 'amazon_ca' }),
    }, [765304493]),
  });
  const nums = r.sendableShadow.map((s) => s.orderNumber).sort();
  assert.deepEqual(nums, ['1313', '1314', '1315', '1316', '702-3702412-5565024']);
  assert.ok(!nums.includes('702-3414577-7454667'), 'already-emailed order must not be re-sent');
});
