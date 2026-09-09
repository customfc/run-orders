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
    // Without this stub the default siblingAlreadyShipped() calls REAL
    // ShipStation for order numbers like 1313 — which have long since shipped —
    // so four scenario tests failed on live data, not on logic (found 2026-09-09).
    checkSibling: async () => false,
    checkCancelled: async () => false,
    loadDayState: (d) => statesByDate[d] || day(d, {}),
    sendEmail: async () => ({ sent: [] }),
    // never touch data/ops-state from a test — opsState.save() writes a REAL
    // state file keyed on state.date, which would corrupt production state
    saveDayState: () => {},
    // nor data/audit.jsonl — a stubbed send must not leave a real 'sent' record
    // in the ledger that production history is reconstructed from
    auditLog: () => {},
    // ShipStation-first discovery is stubbed to "nothing bought outside the
    // pipeline" unless a test says otherwise — never enumerate real shipments
    listShipments: async () => [],
    manualEmails: () => [],
    checkMoved: async () => false,
    ...opts,
  });
}

// A ShipStation v1 shipment as the API returns it: Pacific wall-clock
// createDate with no offset, orderId numeric, voided flag.
function shipment(orderId, orderNumber, warehouseId, date, extra = {}) {
  return { shipmentId: 900000 + orderId, orderId, orderNumber, warehouseId, trackingNumber: `SS${orderNumber}`, shipmentCost: 32.82, carrierCode: 'ups_walleted', serviceCode: 'ups_standard', createDate: `${date}T07:59:31.5430000`, voided: false, voidDate: null, ...extra };
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

// ── ShipStation-first discovery (2026-08-31: labels bought by a one-off script
// never reached phases.buy.labels, so neither phaseEmail nor this sweep could
// see them; 1368 sat a week with a live label nobody had been told about).

test('THE 08-31 REGRESSION: a label bought outside the pipeline is found in ShipStation, backfilled into its day, and reported as sendable', async () => {
  const d = daysAgo(3);
  const states = { [d]: day(d, {}) };
  const saved = [];
  const r = await sweep(states, {
    listShipments: async () => [shipment(782424944, '1368', SECHELT, d)],
    saveDayState: (s) => saved.push(s.date),
  });
  assert.equal(r.discovered.length, 1);
  assert.equal(r.discovered[0].orderNumber, '1368');
  const rec = states[d].phases.buy.labels['782424944'];
  assert.ok(rec, 'label must now exist in the ledger for the day it was bought');
  assert.equal(rec.trackingNumber, 'SS1368');
  assert.equal(rec.origin, 'shipstation-sweep');
  assert.equal(rec.source, 'shopify');
  assert.ok(saved.includes(d), 'the backfilled day must be persisted');
  assert.equal(r.sendableShadow.length, 1, 'and it flows straight into the normal rescue path');
  assert.equal(r.sendableShadow[0].orderNumber, '1368');
});

test('ShipStation-first: labels the ledger already knows are not duplicated', async () => {
  const d = daysAgo(3);
  const states = { [d]: day(d, { 1001: label('1316', DOWNSVIEW, { trackingNumber: 'SS1316' }) }, [1001]) };
  const r = await sweep(states, { listShipments: async () => [shipment(1001, '1316', DOWNSVIEW, d)] });
  assert.equal(r.discovered.length, 0);
  assert.equal(r.sendableShadow.length, 0, 'it was emailed on its own day; nothing to do');
});

test('ShipStation-first: voided labels, split children, standalone stubs, hand reships and today are all ignored', async () => {
  const d = daysAgo(3);
  const states = { [d]: day(d, {}) };
  const r = await sweep(states, {
    listShipments: async () => [
      shipment(1, '1370', SECHELT, d, { voided: true, voidDate: `${d}T09:00:00` }),
      shipment(2, '', DOWNSVIEW, d),                       // split child — parent got the email
      shipment(3, 'SEAuto-12345', DOWNSVIEW, d),
      shipment(4, 'RESHIP-1322', SECHELT, d),
      shipment(5, '1399', DOWNSVIEW, daysAgo(0)),          // today belongs to the live pipeline
    ],
  });
  assert.equal(r.discovered.length, 0);
  assert.deepEqual(Object.keys(states[d].phases.buy.labels), []);
});

test('ShipStation-first: a manual label already emailed by hand (audit.jsonl) is recorded as emailed, never re-sent', async () => {
  const d = daysAgo(3);
  const states = { [d]: day(d, {}) };
  const r = await sweep(states, {
    listShipments: async () => [shipment(782424944, '1368', SECHELT, d)],
    manualEmails: () => [{ orderNumber: '1368', at: `${daysAgo(1)}T18:54:08.896Z` }],
  });
  assert.equal(r.discovered.length, 1);
  assert.equal(r.handEmailed.length, 1);
  assert.equal(r.sendableShadow.length, 0, 'the branch already has this label; a second email would be a duplicate');
  assert.ok(states[d].phases.email.byOrder['782424944'], 'the hand email is now on record in ops-state');
});

test('ShipStation-first: a manual label that already has carrier scans is recorded as shipped, never re-emailed', async () => {
  const d = daysAgo(3);
  const states = { [d]: day(d, {}) };
  const r = await sweep(states, {
    listShipments: async () => [shipment(555, '1358', DOWNSVIEW, d)],
    checkMoved: async () => true,
  });
  assert.equal(r.discovered.length, 1);
  assert.equal(r.alreadyMoved.length, 1);
  assert.equal(r.sendableShadow.length, 0, 'the branch shipped it; a pack-email now would be a duplicate parcel');
  assert.ok(states[d].phases.buy.labels['555'], 'but the ledger now knows the label (stale tracker, reconcile)');
  assert.ok(states[d].phases.email.byOrder['555']);
});

test('ShipStation-first: an unanswered tracking lookup leaves the label for the next tick (fail closed)', async () => {
  const d = daysAgo(3);
  const states = { [d]: day(d, {}) };
  const r = await sweep(states, {
    listShipments: async () => [shipment(556, '1359', DOWNSVIEW, d)],
    checkMoved: async () => { throw new Error('track HTTP 503'); },
  });
  assert.equal(r.discovered.length, 0);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(Object.keys(states[d].phases.buy.labels), [], 'never guess: not backfilled, not sendable');
});

test('hand-email records: only labels actually ATTACHED count — a mere mention does not (1370, 2026-09-07)', () => {
  const { parseManualEmailRecords } = require('./orphan-email-sweep');
  const lines = [
    JSON.stringify({ timestamp: '2026-09-07T18:54:08.896Z', action: 'cs-email-warehouse', orders: ['1354', '1359', '1370', '1368'], attached: ['1368'] }),
    JSON.stringify({ timestamp: '2026-09-04T19:16:13.544Z', action: 'cs-email-branch', orderNumber: '#1358' }),
    JSON.stringify({ timestamp: '2026-08-31T18:12:09.933Z', action: 'pipeline-email-prosol', orderIds: [1] }),
    JSON.stringify({ timestamp: '2026-09-05T10:00:00.000Z', action: 'orphan-sweep-sent', orderNumbers: ['1399'] }),
  ].join('\n');
  const recs = parseManualEmailRecords(lines);
  assert.deepEqual(recs.map((r) => r.orderNumber).sort(), ['1358', '1368'], '1370 was named but its label was not sent; pipeline/sweep sends live in ops-state already');
});

test('ShipStation-first: a discovery failure is reported, and the ledger-based passes still run', async () => {
  const d = daysAgo(3);
  const r = await sweep({ [d]: day(d, { 1001: label('1316', DOWNSVIEW) }) }, { listShipments: async () => { throw new Error('HTTP 500'); } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /shipstation discovery/);
  assert.equal(r.sendableShadow.length, 1, 'ShipStation being down must not blind the existing sweep');
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

test('ONE EMAIL PER WAREHOUSE across days — the 2026-07-27 double-Moncton bug', async () => {
  // Moncton had orphans on two different days. Sending per day produced two
  // separate emails to Kaitlyn for the same branch, breaking the batching rule.
  const d1 = daysAgo(6);
  const d2 = daysAgo(3);
  const MONCTON = 1852856;
  const calls = [];
  const r = await sweep({
    [d1]: day(d1, { 111: label('1314', MONCTON), 222: label('702-3702412-5565024', MONCTON, { source: 'amazon_ca' }) }),
    [d2]: day(d2, { 333: label('702-4080472-0659422', MONCTON, { source: 'amazon_ca' }) }),
  }, {
    live: true,
    sendEmail: async (args) => {
      calls.push(args);
      // mimic phaseEmail: group the supplied labels by warehouse
      const ids = Object.keys(args.labels).map(Number);
      if (args.recordSent) args.recordSent('Moncton (MONC)', ids);
      return { sent: [{ warehouse: 'Moncton (MONC)', orderCount: ids.length, orderIds: ids }] };
    },
  });

  assert.equal(calls.length, 1, 'phaseEmail must be called ONCE for the whole sweep, not once per day');
  assert.equal(Object.keys(calls[0].labels).length, 3, 'all three Moncton orders in one batch');
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].count, 3);
  assert.deepEqual(r.sent[0].warehouses, ['Moncton (MONC)'], 'exactly one Moncton email');
});

test('a batched send records each order back to its ORIGINAL day, so it can never re-send', async () => {
  const d1 = daysAgo(6);
  const d2 = daysAgo(3);
  const s1 = day(d1, { 111: label('1314', 1852856) });
  const s2 = day(d2, { 333: label('702-4080472-0659422', 1852856, { source: 'amazon_ca' }) });
  const saved = [];
  await sweep({ [d1]: s1, [d2]: s2 }, {
    live: true,
    saveDayState: (st) => saved.push(st.date),
    sendEmail: async (args) => {
      const ids = Object.keys(args.labels).map(Number);
      args.recordSent('Moncton (MONC)', ids);
      return { sent: [{ warehouse: 'Moncton (MONC)', orderCount: ids.length }] };
    },
  });
  assert.ok(s1.phases.email.byOrder['111'], `order 111 must be recorded on ${d1}, not on the sweep's run-day`);
  assert.ok(s2.phases.email.byOrder['333'], `order 333 must be recorded on ${d2}`);
  assert.deepEqual(saved.sort(), [d1, d2].sort(), 'both original day-states saved');
});
