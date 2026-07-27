/**
 * Orphan-email sweep — rescues the "no-email strand".
 *
 * Failure mode: a label gets bought but the warehouse pack-email never sends,
 * so no package is built, the carrier never collects, and the label sits
 * "label-only" forever while the order shows as shipped to the customer.
 *
 * TWO root causes, both real, both seen in production:
 *   1. A cron run completes stage→buy→pos but dies before EMAIL (2026-05-28).
 *   2. A label is bought AFTER the day's only email tick has already run
 *      (2026-07-21: five labels bought 18:24–18:33 UTC, the 14:00 ET email cron
 *      finished at 18:04). The next day loads a fresh date's state and never
 *      looks back, so these become invisible cross-day orphans. Order 1316 sat
 *      unshipped for six days until the customer chased it.
 *   Cause 2 hits EVERY buy path, including `/api/labels/buy` and telegram /buy,
 *   which bypass runPipeline entirely. That is why this sweep is the backstop
 *   rather than something bolted onto one call site.
 *
 * Scans two windows:
 *   - SEND window (SEND_LOOKBACK_DAYS): recent enough to auto-rescue by sending
 *     the real warehouse email on the already-purchased label.
 *   - DETECT window (DETECT_LOOKBACK_DAYS): much wider, report-only. Nothing
 *     ages out silently — an orphan too old to auto-send is escalated for a
 *     human instead of quietly vanishing from the report, which is exactly how
 *     the July batch went unnoticed for weeks.
 *
 * Skips, with reasons reported:
 *   - VOIDED label (dead — never email it)
 *   - CANCELLED order (Amazon via SP-API, Shopify via cancelledAt)
 *   - warehouses that are intentionally not emailed (Biyork/TORLYS/TREECO/…),
 *     which phaseEmail skips by design and which must not be counted as orphans
 *
 * SHADOW by default: set ORPHAN_SWEEP_LIVE=1 to actually send. Shadow reports
 * what it WOULD send. Aligns with [[feedback_never_email_vendors_unprompted]] —
 * the live send is the established pipeline template on an already-paid label,
 * gated behind an explicit env flag.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const opsState = require('./ops-state');
const audit = require('./audit');
const telegram = require('./telegram');
const sp = require('./sp-api');
const { v1Request } = require('./shipstation-v2');
const { phaseEmail } = require('./pipeline');

const STATE_FILE = path.join(__dirname, '..', 'data', 'orphan-sweep-state.json');

// Auto-send window. Wide enough to cover a long weekend plus a holiday, so a
// Friday-evening buy is still rescued automatically.
const SEND_LOOKBACK_DAYS = Number(process.env.ORPHAN_SWEEP_SEND_DAYS || 14);
// Report-only window. Deliberately much wider than the send window: an orphan
// must never disappear from the report just because it got old.
const DETECT_LOOKBACK_DAYS = Number(process.env.ORPHAN_SWEEP_DETECT_DAYS || 60);
// Re-alert cadence while orphans remain outstanding. The old signature-only
// dedup went permanently quiet on an unchanged set, so a standing problem
// stopped being reported. Something outstanding gets raised at least daily.
const REALERT_MS = Number(process.env.ORPHAN_SWEEP_REALERT_MS || 20 * 60 * 60 * 1000);

const isLive = () => process.env.ORPHAN_SWEEP_LIVE === '1';

const LOCATION_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'));
const WH_BY_SS_ID = {};
for (const loc of Object.values(LOCATION_MAP)) {
  if (loc && loc.shipstation_warehouse_id) WH_BY_SS_ID[String(loc.shipstation_warehouse_id)] = loc;
}

/**
 * Would phaseEmail ever email this warehouse? Mirrors its classifyRecipient:
 * Prosol branches and Sechelt get emailed; other non-Prosol vendors (Biyork,
 * TORLYS, TREECO, JSON, PCW) handle their own fulfilment comms. Counting those
 * as orphans would bury the real ones in permanent false positives.
 */
function warehouseIsEmailable(warehouseId) {
  const loc = WH_BY_SS_ID[String(warehouseId || '')];
  if (!loc) return { emailable: false, reason: `unmapped warehouse ${warehouseId}`, anomaly: true };
  if (loc.non_prosol && loc.code !== 'SECH') {
    return { emailable: false, reason: `non-Prosol vendor (${loc.vendor || loc.code})`, anomaly: false };
  }
  return { emailable: true, loc };
}

function datesBack(n) {
  const base = opsState.today(); // 'YYYY-MM-DD' (America/Toronto)
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const ageDays = (date) => Math.round((Date.now() - new Date(`${date}T12:00:00Z`).getTime()) / 86400000);

// Is the bought label dead (voided) or has the order no live shipment left?
async function isLabelVoided(orderNumber, trackingNumber) {
  try {
    const r = await v1Request('GET', `/shipments?orderNumber=${encodeURIComponent(orderNumber)}`);
    if (r.status !== 200) return false; // fail-open: don't block a send on a lookup blip
    const shipments = JSON.parse(r.body).shipments || [];
    if (!shipments.length) return false;
    const mine = shipments.find((s) => s.trackingNumber === trackingNumber);
    if (mine) return Boolean(mine.voidDate);
    // our tracking not found — treat "no active shipment at all" as dead
    return shipments.every((s) => s.voidDate);
  } catch { return false; }
}

// Buyer-cancellation / cancelled-order check. Amazon via SP-API; Shopify via
// the Admin API's cancelledAt. Previously Amazon-only, which meant a cancelled
// Shopify order could be rescued into a real warehouse email.
async function isCancelled(source, orderNumber) {
  if (/amazon/i.test(source || '') && /^\d{3}-\d{7}-\d{7}$/.test(orderNumber || '')) {
    try {
      const r = await sp.getOrder(orderNumber);
      const o = r && (r.payload || r);
      if (!o) return false;
      return o.OrderStatus === 'Canceled' || o.IsBuyerRequestedCancellation === true || o.IsBuyerRequestedCancellation === 'true';
    } catch { return false; }
  }
  if (/shopify/i.test(source || '')) {
    try {
      const { graphql } = require('./shopify-graphql');
      const name = String(orderNumber || '').replace(/^#/, '');
      const res = await graphql(
        `query($q:String!){ orders(first:1, query:$q){ nodes{ name cancelledAt displayFulfillmentStatus } } }`,
        { q: `name:${name}` },
      );
      const o = res?.data?.orders?.nodes?.[0];
      if (!o) return false;
      return Boolean(o.cancelledAt);
    } catch { return false; }
  }
  return false;
}

/**
 * @param live         actually send (default: ORPHAN_SWEEP_LIVE=1)
 * @param checkVoided  (orderNumber, tracking) => bool   — injectable for tests
 * @param checkCancelled (source, orderNumber) => bool   — injectable for tests
 * @param loadDayState (date) => opsState                — injectable for tests
 * @param sendEmail    ({state, skipOrderIds}) => result — injectable for tests
 * @param saveDayState (state) => void                   — injectable for tests
 * @param auditLog     (entry) => void                   — injectable for tests. The
 *   audit ledger is what production history gets reconstructed from; a test must
 *   never be able to write a 'sent' record for an email it only pretended to send.
 */
async function runOrphanSweep({
  live = isLive(),
  checkVoided = isLabelVoided,
  checkCancelled = isCancelled,
  loadDayState = (d) => opsState.load(d),
  sendEmail = (args) => phaseEmail({ ...args, onProgress: () => {} }),
  saveDayState = (s) => opsState.save(s),
  auditLog = (e) => audit.log(e),
} = {}) {
  const report = {
    live,
    sendWindowDays: SEND_LOOKBACK_DAYS,
    detectWindowDays: DETECT_LOOKBACK_DAYS,
    datesScanned: datesBack(DETECT_LOOKBACK_DAYS),
    sent: [],
    sendableShadow: [],
    tooOldToAutoSend: [], // real orphans past the send window — need a human
    cancelled: [],
    voided: [],
    notEmailable: [],     // intentional (other vendor) — not orphans
    anomalies: [],        // unmapped warehouse — routing config gap
    errors: [],
  };

  const sendDates = new Set(datesBack(SEND_LOOKBACK_DAYS));

  // PASS 1 — classify every un-emailed label across the whole detect window.
  // Nothing is sent in this pass. Collecting first is what lets pass 2 group by
  // WAREHOUSE rather than by day.
  const sendable = [];          // [{ date, state, label, base }]
  const skipIdsByDate = {};     // date -> [orderId]
  for (const date of report.datesScanned) {
    const state = loadDayState(date);
    const labels = Object.entries(state.phases?.buy?.labels || {});
    if (!labels.length) continue;
    const unEmailed = labels
      .map(([orderId, l]) => ({ orderId: Number(orderId), ...l }))
      .filter((l) => !opsState.orderAlreadyEmailed(state, l.orderId));
    if (!unEmailed.length) continue;

    skipIdsByDate[date] = skipIdsByDate[date] || [];
    for (const l of unEmailed) {
      const base = { date, ageDays: ageDays(date), orderNumber: l.orderNumber, orderId: l.orderId, tracking: l.trackingNumber, labelCost: Number(l.labelCost || 0), source: l.source };
      try {
        const cls = warehouseIsEmailable(l.warehouseId);
        if (!cls.emailable) {
          (cls.anomaly ? report.anomalies : report.notEmailable).push({ ...base, reason: cls.reason });
          skipIdsByDate[date].push(l.orderId);
          continue;
        }
        if (await checkVoided(l.orderNumber, l.trackingNumber)) {
          report.voided.push(base);
          skipIdsByDate[date].push(l.orderId);
          continue;
        }
        if (await checkCancelled(l.source, l.orderNumber)) {
          report.cancelled.push(base);
          skipIdsByDate[date].push(l.orderId);
          continue;
        }
        if (!sendDates.has(date)) {
          // Real orphan, but too old to auto-rescue: the parcel may have been
          // returned, restocked or lost. Escalate rather than silently drop.
          report.tooOldToAutoSend.push({ ...base, warehouse: `${cls.loc.city} (${cls.loc.code})` });
          skipIdsByDate[date].push(l.orderId);
          continue;
        }
        sendable.push({ date, state, label: l, base });
      } catch (e) {
        report.errors.push({ ...base, error: e.message });
        skipIdsByDate[date].push(l.orderId); // don't auto-send on an inconclusive check
      }
    }
  }

  if (!sendable.length) return report;
  if (!live) {
    report.sendableShadow.push(...sendable.map(({ base }) => base));
    return report;
  }

  // PASS 2 — ONE phaseEmail call for everything, so warehouse grouping spans
  // days and Kaitlyn gets one email per warehouse, not one per (warehouse, day).
  // Sending per day is exactly how two separate Moncton emails went out on
  // 2026-07-27 (orphans on both 07-21 and 07-24).
  const mergedLabels = {};
  const mergedPos = {};
  const stateByOrderId = {};
  for (const { date, state, label } of sendable) {
    mergedLabels[String(label.orderId)] = label;
    stateByOrderId[String(label.orderId)] = { date, state };
    const pos = state.phases?.pos?.byTracking || {};
    for (const [trk, po] of Object.entries(pos)) if (!mergedPos[trk]) mergedPos[trk] = po;
  }

  const touchedDates = new Set();
  try {
    const r = await sendEmail({
      // `state` is only used for incidental alert/error bookkeeping now; the
      // orders, POs and the "emailed" record are all supplied explicitly.
      state: loadDayState(opsState.today()),
      labels: mergedLabels,
      posByTracking: mergedPos,
      skipOrderIds: [],
      // Write each record back to the order's ORIGINAL day, so the per-day
      // idempotency check sees it and this can never re-send.
      recordSent: (warehouseKey, orderIds) => {
        const byDate = {};
        for (const id of orderIds) {
          const owner = stateByOrderId[String(id)];
          if (!owner) continue;
          (byDate[owner.date] = byDate[owner.date] || { state: owner.state, ids: [] }).ids.push(id);
        }
        for (const [date, { state: dayState, ids }] of Object.entries(byDate)) {
          opsState.recordEmailSent(dayState, { warehouseKey, orderCount: ids.length, orderIds: ids });
          saveDayState(dayState);
          touchedDates.add(date);
        }
      },
    });
    const count = (r.sent || []).reduce((n, s) => n + (s.orderCount || 0), 0);
    const warehouses = (r.sent || []).map((s) => s.warehouse);
    const orderNumbers = sendable.map(({ base }) => base.orderNumber);
    report.sent.push({ dates: [...touchedDates].sort(), warehouses, count, orderNumbers });
    auditLog({ action: 'orphan-sweep-sent', dates: [...touchedDates].sort(), count, warehouses, orderNumbers });
  } catch (e) {
    report.errors.push({ error: `phaseEmail: ${e.message}` });
  }
  return report;
}

/** Everything that still needs a human or a send. Drives alerting. */
function outstanding(report) {
  return [...report.sendableShadow, ...report.tooOldToAutoSend, ...report.anomalies];
}

function signature(report) {
  return [
    ...report.sent.map((s) => `S:${(s.dates || []).join(',')}:${s.count}`),
    ...report.sendableShadow.map((s) => `W:${s.orderNumber}`),
    ...report.tooOldToAutoSend.map((s) => `O:${s.orderNumber}`),
    ...report.anomalies.map((s) => `A:${s.orderNumber}`),
    ...report.cancelled.map((s) => `C:${s.orderNumber}`),
    ...report.voided.map((s) => `V:${s.orderNumber}`),
  ].sort().join('|');
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

function describe(o) {
  return `${o.orderNumber} (${o.ageDays}d, ${o.warehouse || o.reason || o.tracking || ''})`.trim();
}

function formatReport(report) {
  const L = [];
  if (report.sent.length) {
    const n = report.sent.reduce((a, s) => a + s.count, 0);
    L.push(`✅ RESCUED ${n} order(s) — one email per warehouse: ${report.sent.map((s) => s.warehouses.join(', ')).join('; ')}`);
  }
  if (report.sendableShadow.length) {
    L.push(`🟡 SHADOW — would send ${report.sendableShadow.length}: ${report.sendableShadow.map(describe).join(', ')}\n(set ORPHAN_SWEEP_LIVE=1 to send)`);
  }
  if (report.tooOldToAutoSend.length) {
    L.push(`🚨 ${report.tooOldToAutoSend.length} orphan(s) TOO OLD to auto-send (>${report.sendWindowDays}d) — parcel may still be sitting at the branch, needs a human:\n${report.tooOldToAutoSend.map((o) => `   • ${describe(o)}`).join('\n')}`);
  }
  if (report.anomalies.length) L.push(`⚠️ ${report.anomalies.length} unmapped-warehouse label(s): ${report.anomalies.map(describe).join(', ')}`);
  if (report.cancelled.length) L.push(`🛑 ${report.cancelled.length} cancelled — NOT sent: ${report.cancelled.map((s) => s.orderNumber).join(', ')}`);
  if (report.voided.length) L.push(`⚪ ${report.voided.length} voided-label — skipped: ${report.voided.map((s) => s.orderNumber).join(', ')}`);
  if (report.notEmailable.length) L.push(`ℹ️ ${report.notEmailable.length} at non-Prosol vendor warehouses (never emailed by design)`);
  if (report.errors.length) L.push(`⚠ ${report.errors.length} check error(s): ${report.errors.slice(0, 3).map((e) => `${e.orderNumber || e.date}: ${e.error}`).join('; ')}`);
  return L.join('\n');
}

/**
 * Cron entry. Alerts when the picture changes, AND keeps nagging while anything
 * is outstanding. The previous version went silent on an unchanged set, so a
 * standing pile of stranded orders stopped being mentioned — which is precisely
 * how they survived long enough for a customer to find them first.
 */
async function orphanSweepTick(source) {
  try {
    const report = await runOrphanSweep();
    const sig = signature(report);
    const st = loadState();
    const out = outstanding(report);
    const changed = st.lastSignature !== sig;
    const stale = out.length > 0 && (!st.lastAlertAt || Date.now() - new Date(st.lastAlertAt).getTime() >= REALERT_MS);

    if (!sig) { saveState({ lastSignature: '', at: new Date().toISOString(), lastAlertAt: st.lastAlertAt }); return report; }
    if (!report.sent.length && !changed && !stale) return report;

    const body = formatReport(report);
    if (body) {
      const worst = out.reduce((n, o) => Math.max(n, o.ageDays || 0), 0);
      const level = report.tooOldToAutoSend.length || worst >= 2 ? 'halt' : (report.sent.length ? 'ok' : 'attn');
      const title = out.length
        ? `Orphan-email sweep — ${out.length} order(s) NOT shipped (oldest ${worst}d)`
        : `Orphan-email sweep (${source})`;
      await telegram.notify(level, title, `${body}\n\n/orphans for detail`);
    }
    saveState({ lastSignature: sig, at: new Date().toISOString(), lastAlertAt: (out.length || report.sent.length) ? new Date().toISOString() : st.lastAlertAt });
    return report;
  } catch (e) {
    audit.log({ action: 'orphan-sweep-error', source, error: e.message });
    return { error: e.message };
  }
}

module.exports = {
  runOrphanSweep,
  orphanSweepTick,
  formatReport,
  outstanding,
  warehouseIsEmailable,
  SEND_LOOKBACK_DAYS,
  DETECT_LOOKBACK_DAYS,
  // back-compat: some callers referenced the old single window
  LOOKBACK_DAYS: SEND_LOOKBACK_DAYS,
};
