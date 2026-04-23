/**
 * Verify the "no warehouse email without a shipping label" invariant.
 *
 * Added 2026-04-23 after the PO-14517 / 702-0157693-0857053 Prosol incident:
 * a vendor email shipped with tracking text but no PDF label attached, blocking
 * a real shipment. This harness exercises `phaseEmail` with stubbed upstream
 * modules and asserts that orders with missing label/packing-slip PDFs are
 * held back, alerted once per hour, and retried on the next tick.
 *
 * Run: `node scripts/ops/verify-email-label-guard.js`
 * Exit code: 0 on pass, 1 on any assertion failure.
 */

const path = require('path');
const assert = require('assert');

// ── Stubs: install into require.cache BEFORE pipeline is required ──────────

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

const sendCalls = [];
const telegramCalls = [];
let labelStub = async (_sid) => null; // overwrite per-scenario

stubModule('../../lib/shipstation-v2', {
  v1Request: async (_method, urlPath) => {
    // /orders/:id — return a minimal order shape shaped like ShipStation v1
    const m = /\/orders\/(\d+)/.exec(urlPath);
    if (!m) return { status: 404, body: '{}' };
    const id = Number(m[1]);
    return { status: 200, body: JSON.stringify(fakeOrder(id)) };
  },
  downloadLabelPdf: async (sid) => labelStub(sid),
  fetchShippedShipments: async () => [],
});

stubModule('../../lib/emailer', {
  sendWarehouseEmail: async (args) => { sendCalls.push(args); },
});

stubModule('../../lib/packing-slip', {
  generatePackingSlipPdf: async () => Buffer.from('%PDF-1.4 stub'),
});

stubModule('../../lib/telegram', {
  notify: async (severity, subject, body) => { telegramCalls.push({ severity, subject, body }); },
});

stubModule('../../lib/audit', { log: () => {} });

// Real modules (not stubbed):
const opsState = require('../../lib/ops-state');
const pipeline = require('../../lib/pipeline');

// ── Fixtures ──────────────────────────────────────────────────────────────

// Use a real Prosol warehouse ID from the location map so classifyRecipient
// routes to the default (Kaitlyn) path. Pick any non-Sechelt, non-unmapped ID.
const LOCATION_MAP = require('../../scripts/shipstation/prosol-location-map.json');
const prosolLoc = Object.values(LOCATION_MAP).find((l) => l.shipstation_warehouse_id && !l.non_prosol);
if (!prosolLoc) { console.error('FATAL: no Prosol warehouse in location map'); process.exit(1); }
const PROSOL_WH_ID = prosolLoc.shipstation_warehouse_id;

function fakeOrder(orderId) {
  return {
    orderId,
    orderNumber: `TEST-${orderId}`,
    advancedOptions: { warehouseId: PROSOL_WH_ID },
    shipTo: { name: 'Test Buyer', city: 'Coaticook', postalCode: 'J1A 1B7' },
    items: [{ sku: 'TEST-SKU-1', name: 'Test Product', quantity: 1, unitPrice: 10 }],
    carrierCode: 'ups',
  };
}

function freshState(orderIds) {
  const state = opsState.load('2099-01-01'); // synthetic date, ignored on reset
  state.date = '2099-01-01';
  state.phases = {
    stage:   { runs: [] },
    buy:     { labels: {} },
    pos:     { byTracking: {} },
    email:   { byWarehouse: {}, byOrder: {}, lastAlertAt: {} },
    pickups: { byGroup: {} },
  };
  state.errors = [];
  for (const id of orderIds) {
    state.phases.buy.labels[String(id)] = {
      orderNumber: `TEST-${id}`,
      shipmentId: 10_000 + id,
      trackingNumber: `TRK-${id}`,
      labelCost: 12.34,
      at: new Date().toISOString(),
    };
  }
  // Disable save() to keep scratch state off disk for this synthetic date.
  state._save = opsState.save;
  return state;
}

function reset() { sendCalls.length = 0; telegramCalls.length = 0; }

// Patch ops-state's save to be a noop during the test run (we don't want to
// write /data/ops-state/2099-01-01.json).
const fs = require('fs');
const origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = (p, ...rest) => {
  if (String(p).includes('2099-01-01')) return;
  return origWriteFileSync(p, ...rest);
};

// ── Scenarios ─────────────────────────────────────────────────────────────

(async () => {
  const failures = [];

  // 1. Mixed batch: order 1 label OK, order 2 label fails.
  {
    reset();
    const state = freshState([1, 2]);
    labelStub = async (sid) => (sid === 10_001 ? Buffer.from('%PDF-1.4 label1') : null);
    await pipeline.phaseEmail({ state });

    try {
      assert.strictEqual(sendCalls.length, 1, 'one warehouse email');
      assert.strictEqual(sendCalls[0].orders.length, 1, 'one OK order in email');
      assert.strictEqual(sendCalls[0].orders[0].orderNumber, 'TEST-1', 'OK order is TEST-1');
      assert.strictEqual(telegramCalls.length, 1, 'one telegram alert');
      assert.strictEqual(telegramCalls[0].severity, 'attn', 'alert severity is attn');
      assert.ok(state.phases.email.byOrder['1'], 'TEST-1 recorded as emailed');
      assert.ok(!state.phases.email.byOrder['2'], 'TEST-2 NOT recorded as emailed');
      assert.ok(state.phases.email.lastAlertAt['2'], 'TEST-2 alert timestamp recorded');
      console.log('✓ scenario 1: mixed batch partitions correctly');
    } catch (e) { failures.push(`scenario 1: ${e.message}`); }
  }

  // 2. Dedup: second tick with same failure → no telegram.
  {
    reset();
    const state = freshState([2]);
    // Pre-seed the alert so shouldAlert returns false.
    state.phases.email.lastAlertAt['2'] = new Date().toISOString();
    labelStub = async () => null;
    await pipeline.phaseEmail({ state });

    try {
      assert.strictEqual(sendCalls.length, 0, 'no email sent (label failed)');
      assert.strictEqual(telegramCalls.length, 0, 'no telegram (deduped within 1h)');
      assert.ok(!state.phases.email.byOrder['2'], 'TEST-2 still NOT emailed → retries next tick');
      console.log('✓ scenario 2: dedup suppresses repeated alerts');
    } catch (e) { failures.push(`scenario 2: ${e.message}`); }
  }

  // 3. Recovery: same order, label now succeeds → email goes out.
  {
    reset();
    const state = freshState([2]);
    // Prior tick already alerted (simulates scenario 2 state).
    state.phases.email.lastAlertAt['2'] = new Date(Date.now() - 30 * 60_000).toISOString();
    labelStub = async () => Buffer.from('%PDF-1.4 recovered');
    await pipeline.phaseEmail({ state });

    try {
      assert.strictEqual(sendCalls.length, 1, 'email sent once recovered');
      assert.strictEqual(sendCalls[0].orders[0].orderNumber, 'TEST-2', 'recovered order emailed');
      assert.strictEqual(telegramCalls.length, 0, 'no new alert on success');
      assert.ok(state.phases.email.byOrder['2'], 'TEST-2 now recorded as emailed');
      console.log('✓ scenario 3: recovered order emails on next tick');
    } catch (e) { failures.push(`scenario 3: ${e.message}`); }
  }

  // 4. All-fail: entire warehouse batch fails → no email at all, one alert.
  {
    reset();
    const state = freshState([3, 4]);
    labelStub = async () => null;
    await pipeline.phaseEmail({ state });

    try {
      assert.strictEqual(sendCalls.length, 0, 'no email when all orders fail');
      assert.strictEqual(telegramCalls.length, 1, 'one alert covering both orders');
      assert.ok(!state.phases.email.byOrder['3'] && !state.phases.email.byOrder['4'], 'neither order recorded as emailed');
      console.log('✓ scenario 4: all-fail blocks email entirely');
    } catch (e) { failures.push(`scenario 4: ${e.message}`); }
  }

  if (failures.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('\nAll scenarios passed.');
  process.exit(0);
})();
