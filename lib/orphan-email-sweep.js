/**
 * Orphan-email sweep — rescues the "no-email strand".
 *
 * Failure mode (2026-05-28 incident): a cron run completes stage→buy→pos but
 * dies before the EMAIL phase. The orders have labels + POs but the warehouse
 * pack-email never sent → no package built → carrier never picks up → label
 * sits "label-only" forever. The next day's run loads a fresh date's state and
 * never looks back, so these become invisible cross-day orphans.
 *
 * This sweep scans the last 4 settled days (excludes today — the live pipeline
 * owns today), finds bought-but-never-emailed labels, and:
 *   - skips any whose label is VOIDED (dead label — don't email it)
 *   - skips any whose Amazon order is Canceled / buyer-requested-cancel, alerts
 *   - auto-sends the rest via phaseEmail (reuses the real template + paid label)
 *
 * SHADOW by default (mirrors the auto-rebooker): set ORPHAN_SWEEP_LIVE=1 to
 * actually send. Shadow reports what it WOULD send. Held-by-guard orders never
 * appear here — the void→rebuy guard holds them BEFORE a label is bought, so
 * they're not in buy.labels. Aligns with [[feedback_never_email_vendors_unprompted]]
 * (live send is the established pipeline template, gated behind the env flag).
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
const LOOKBACK_DAYS = 4;
const isLive = () => process.env.ORPHAN_SWEEP_LIVE === '1';

function recentDates() {
  // today-1 .. today-LOOKBACK_DAYS, in the same date space as opsState.today()
  const base = opsState.today(); // 'YYYY-MM-DD' (America/Toronto)
  const out = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

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

// Amazon buyer-cancellation / canceled-order check. Non-Amazon → not checked.
async function isCancelled(source, orderNumber) {
  if (!/amazon/i.test(source || '') || !/^\d{3}-\d{7}-\d{7}$/.test(orderNumber || '')) return false;
  try {
    const r = await sp.getOrder(orderNumber);
    const o = r && (r.payload || r);
    if (!o) return false;
    return o.OrderStatus === 'Canceled' || o.IsBuyerRequestedCancellation === true || o.IsBuyerRequestedCancellation === 'true';
  } catch { return false; }
}

async function runOrphanSweep({ live = isLive() } = {}) {
  const report = { live, datesScanned: recentDates(), sent: [], sendableShadow: [], cancelled: [], voided: [], errors: [] };

  for (const date of report.datesScanned) {
    const state = opsState.load(date);
    const labels = Object.entries(state.phases?.buy?.labels || {});
    const unEmailed = labels
      .map(([orderId, l]) => ({ orderId: Number(orderId), ...l }))
      .filter((l) => !opsState.orderAlreadyEmailed(state, l.orderId));
    if (!unEmailed.length) continue;

    const skipIds = [];
    const sendable = [];
    for (const l of unEmailed) {
      try {
        if (await isLabelVoided(l.orderNumber, l.trackingNumber)) {
          report.voided.push({ date, orderNumber: l.orderNumber, tracking: l.trackingNumber });
          skipIds.push(l.orderId);
          continue;
        }
        if (await isCancelled(l.source, l.orderNumber)) {
          report.cancelled.push({ date, orderNumber: l.orderNumber, tracking: l.trackingNumber });
          skipIds.push(l.orderId);
          continue;
        }
        sendable.push(l);
      } catch (e) {
        report.errors.push({ date, orderNumber: l.orderNumber, error: e.message });
        skipIds.push(l.orderId); // don't auto-send on an inconclusive check
      }
    }

    if (!sendable.length) continue;
    if (!live) {
      report.sendableShadow.push(...sendable.map((l) => ({ date, orderNumber: l.orderNumber, tracking: l.trackingNumber })));
      continue;
    }
    try {
      const r = await phaseEmail({ state, skipOrderIds: skipIds, onProgress: () => {} });
      opsState.save(state);
      const count = (r.sent || []).reduce((n, s) => n + (s.orderCount || 0), 0);
      report.sent.push({ date, warehouses: (r.sent || []).map((s) => s.warehouse), count });
      audit.log({ action: 'orphan-sweep-sent', date, count, warehouses: (r.sent || []).map((s) => s.warehouse) });
    } catch (e) {
      report.errors.push({ date, error: `phaseEmail: ${e.message}` });
    }
  }
  return report;
}

// Stable signature of the actionable findings, so the hourly cron only alerts
// when something CHANGES (not every hour while the same orphans sit).
function signature(report) {
  const ids = [
    ...report.sent.flatMap((s) => `S:${s.date}:${s.count}`),
    ...report.sendableShadow.map((s) => `W:${s.orderNumber}`),
    ...report.cancelled.map((s) => `C:${s.orderNumber}`),
    ...report.voided.map((s) => `V:${s.orderNumber}`),
  ].sort();
  return ids.join('|');
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

function formatReport(report) {
  const L = [];
  if (report.sent.length) L.push(`✅ sent ${report.sent.reduce((n, s) => n + s.count, 0)} orphan email(s): ${report.sent.map((s) => `${s.date}→${s.warehouses.join('/')}`).join(', ')}`);
  if (report.sendableShadow.length) L.push(`🟡 SHADOW — would send ${report.sendableShadow.length}: ${report.sendableShadow.map((s) => s.orderNumber).join(', ')}\n(set ORPHAN_SWEEP_LIVE=1 to send)`);
  if (report.cancelled.length) L.push(`🛑 ${report.cancelled.length} cancelled — NOT sent: ${report.cancelled.map((s) => s.orderNumber).join(', ')}`);
  if (report.voided.length) L.push(`⚪ ${report.voided.length} voided-label — skipped: ${report.voided.map((s) => s.orderNumber).join(', ')}`);
  if (report.errors.length) L.push(`⚠ ${report.errors.length} check error(s)`);
  return L.join('\n');
}

// Cron entry: run + alert only on change.
async function orphanSweepTick(source) {
  try {
    const report = await runOrphanSweep();
    const sig = signature(report);
    const st = loadState();
    if (!sig) { return report; } // nothing actionable
    if (st.lastSignature === sig && report.sent.length === 0) return report; // unchanged shadow/anomaly set — stay quiet
    saveState({ lastSignature: sig, at: new Date().toISOString() });
    const body = formatReport(report);
    if (body) await telegram.notify(report.sent.length ? 'ok' : 'attn', `Orphan-email sweep (${source})`, `${body}\n\n/orphans for detail`);
    return report;
  } catch (e) {
    audit.log({ action: 'orphan-sweep-error', source, error: e.message });
    return { error: e.message };
  }
}

module.exports = { runOrphanSweep, orphanSweepTick, formatReport, LOOKBACK_DAYS };
