/**
 * Daily ops state — per-date JSON at data/ops-state/YYYY-MM-DD.json.
 * Source of truth for idempotency (don't re-buy a label, don't re-email a warehouse)
 * and for end-of-day batching (accumulate today's labels, then one email sweep + one pickup sweep).
 *
 * Shape:
 * {
 *   date: "2026-04-13",
 *   startedAt: "2026-04-13T11:00:00Z",
 *   phases: {
 *     stage: { runs: [{at, count, errors}], ...},
 *     buy: { labels: { <orderId>: { shipmentId, trackingNumber, labelCost, at } } },
 *     pos: { byTracking: { <tracking>: { poNumber, poId, at } } },
 *     email: { byWarehouse: { <warehouseKey>: { orderCount, at } } },
 *     pickups: { byGroup: { "<wid>::<carrier>::<date>": { pickupId, labelCount, at } } }
 *   },
 *   errors: [{phase, at, reason, context}]
 * }
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'data', 'ops-state');

function today(tz = 'America/Toronto') {
  const s = new Date().toLocaleString('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  // en-CA gives YYYY-MM-DD
  return s;
}

function fileFor(date) {
  return path.join(STATE_DIR, `${date}.json`);
}

function emptyState(date) {
  return {
    date,
    startedAt: new Date().toISOString(),
    phases: {
      stage:   { runs: [] },
      buy:     { labels: {} },
      pos:     { byTracking: {} },
      email:   { byWarehouse: {}, byOrder: {}, lastAlertAt: {}, lastLargeEmailAt: {} },
      pickups: { byGroup: {} },
    },
    errors: [],
  };
}

function load(date = today()) {
  const f = fileFor(date);
  if (!fs.existsSync(f)) return emptyState(date);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return emptyState(date); }
}

function save(state) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(fileFor(state.date), JSON.stringify(state, null, 2));
}

// Replace every key on `target` with the keys of `source`. Used to keep the
// pipeline's long-lived in-memory state object in sync with what's on disk
// after a concurrent writer (e.g. the dashboard /api/labels/buy endpoint)
// touched the same file. Mutates target in place so existing references stay
// live. Without this the cron pipeline holds a stale snapshot of state for
// 20+ minutes and the next save() clobbers any intervening external changes —
// that's how the 4/28 dashboard-bought label for 702-7794489-8149801 lost its
// PO and email.
function replaceContents(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

// All record* helpers go through this. Re-load the file on every write so we
// merge with anything that landed since the caller's `state` was loaded.
function applyAndSave(state, mutator) {
  const fresh = load(state.date);
  mutator(fresh);
  save(fresh);
  replaceContents(state, fresh);
}

// ── Helpers for each phase ───────────────────────────────────────────────────

function recordStageRun(state, { count, errors }) {
  applyAndSave(state, (s) => {
    s.phases.stage.runs.push({ at: new Date().toISOString(), count, errors });
  });
}

function alreadyBought(state, orderId) {
  return !!state.phases.buy.labels[String(orderId)];
}

function recordLabelBought(state, { orderId, orderNumber, shipmentId, trackingNumber, labelCost, costWarning, carrierCode, serviceCode, estimatedCost, warehouseId, packages, source, internalNotes }) {
  applyAndSave(state, (s) => {
    s.phases.buy.labels[String(orderId)] = {
      orderNumber: orderNumber || null,
      source: source || null, // 'amazon_ca' | 'shopify' | other — drives POS phase routing
      // Primary shipment (first package) — kept at top-level for backward compat
      // with consumers that expect one trackingNumber per order (packing-slip
      // lookup by tracking, pickup scanner, etc.). The full package list is in
      // `packages` below.
      shipmentId, trackingNumber, labelCost, costWarning: !!costWarning,
      carrierCode: carrierCode || null,
      serviceCode: serviceCode || null,
      estimatedCost: Number.isFinite(Number(estimatedCost)) ? Number(estimatedCost) : null,
      warehouseId: warehouseId || null,
      packages: Array.isArray(packages) ? packages : null,
      ...(internalNotes ? { internalNotes } : {}),
      at: new Date().toISOString(),
    };
  });
}

function poAlreadyCreated(state, trackingNumber) {
  return !!state.phases.pos.byTracking[trackingNumber];
}

function recordPo(state, { trackingNumber, poNumber, poId, soNumber, soId }) {
  applyAndSave(state, (s) => {
    s.phases.pos.byTracking[trackingNumber] = {
      poNumber,
      poId,
      soNumber: soNumber || null,
      soId: soId || null,
      at: new Date().toISOString(),
    };
  });
}

// Per-order idempotency: prevents duplicate emails when an order is processed
// across multiple cron ticks. Replaces the old warehouse-level check that
// silently dropped later-day labels whose warehouse had been emailed earlier.
function orderAlreadyEmailed(state, orderId) {
  const byOrder = state.phases.email.byOrder || {};
  return !!byOrder[String(orderId)];
}

// Legacy warehouse-level check — kept only for backward compat with any
// external consumers. Internal phaseEmail no longer uses it.
function emailAlreadySent(state, warehouseKey) {
  return !!state.phases.email.byWarehouse[warehouseKey];
}

function recordEmailSent(state, { warehouseKey, orderCount, orderIds }) {
  applyAndSave(state, (s) => {
    const at = new Date().toISOString();
    // Keep byWarehouse for summary/display (emailsSent count) + audit continuity
    s.phases.email.byWarehouse[warehouseKey] = { orderCount, at };
    // Per-order idempotency source of truth
    if (!s.phases.email.byOrder) s.phases.email.byOrder = {};
    for (const id of (orderIds || [])) {
      s.phases.email.byOrder[String(id)] = { warehouse: warehouseKey, at };
    }
  });
}

// Dedup Telegram alerts for orders held back from a warehouse email (missing
// label or packing-slip PDF). First failure pages ops; subsequent ticks within
// the window stay silent so a persistent ShipStation outage doesn't spam.
function shouldAlert(state, orderId, windowMs = 3600_000) {
  if (!state.phases.email.lastAlertAt) state.phases.email.lastAlertAt = {};
  const last = state.phases.email.lastAlertAt[String(orderId)];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= windowMs;
}

function recordAlert(state, orderId) {
  applyAndSave(state, (s) => {
    if (!s.phases.email.lastAlertAt) s.phases.email.lastAlertAt = {};
    s.phases.email.lastAlertAt[String(orderId)] = new Date().toISOString();
  });
}

// Dedup the URGENT large-order email separately from the Telegram alert. Wider
// window (default ~20h) so a held big order re-pages Mac about once a day until
// it's actioned, rather than every cron tick.
function shouldEmailLargeOrder(state, orderId, windowMs = 20 * 3600_000) {
  if (!state.phases.email.lastLargeEmailAt) state.phases.email.lastLargeEmailAt = {};
  const last = state.phases.email.lastLargeEmailAt[String(orderId)];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= windowMs;
}

function recordEmailLargeOrder(state, orderId) {
  applyAndSave(state, (s) => {
    if (!s.phases.email.lastLargeEmailAt) s.phases.email.lastLargeEmailAt = {};
    s.phases.email.lastLargeEmailAt[String(orderId)] = new Date().toISOString();
  });
}

function pickupAlreadyBooked(state, groupKey) {
  return !!state.phases.pickups.byGroup[groupKey];
}

function recordPickup(state, { groupKey, pickupId, confirmation, labelCount, pickupDate }) {
  applyAndSave(state, (s) => {
    s.phases.pickups.byGroup[groupKey] = {
      pickupId, confirmation, labelCount, pickupDate,
      at: new Date().toISOString(),
    };
  });
}

function recordError(state, { phase, reason, context }) {
  applyAndSave(state, (s) => {
    s.errors.push({ phase, at: new Date().toISOString(), reason, context: context || null });
  });
}

// ── Summary for digest / "Today's status" panel ──────────────────────────────

function summarize(state) {
  const { phases, errors } = state;
  const labels = Object.values(phases.buy.labels);
  const pos = Object.values(phases.pos.byTracking);
  const emails = Object.values(phases.email.byWarehouse);
  const pickups = Object.values(phases.pickups.byGroup);
  const totalLabelCost = labels.reduce((sum, l) => sum + (Number(l.labelCost) || 0), 0);
  const costWarnings = labels.filter((l) => l.costWarning).length;
  return {
    date: state.date,
    staged: phases.stage.runs.reduce((sum, r) => sum + (r.count || 0), 0),
    labelsBought: labels.length,
    totalLabelCost: Number(totalLabelCost.toFixed(2)),
    costWarnings,
    posCreated: pos.length,
    poNumbers: pos.map((p) => p.poNumber).filter(Boolean),
    emailsSent: emails.length,
    pickupsBooked: pickups.length,
    totalPickedLabels: pickups.reduce((sum, p) => sum + (p.labelCount || 0), 0),
    errorCount: errors.length,
    lastError: errors[errors.length - 1] || null,
  };
}

// ── Pause flag (runtime, togglable via Telegram or curl) ─────────────────────

const PAUSE_FLAG = path.join(__dirname, '..', 'data', 'ops-paused.flag');

function isPaused() {
  if (process.env.OPS_PAUSED === '1') return true;
  return fs.existsSync(PAUSE_FLAG);
}

function setPaused(paused, reason = '') {
  if (paused) {
    const dir = path.dirname(PAUSE_FLAG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PAUSE_FLAG, JSON.stringify({ at: new Date().toISOString(), reason }, null, 2));
  } else if (fs.existsSync(PAUSE_FLAG)) {
    fs.unlinkSync(PAUSE_FLAG);
  }
}

module.exports = {
  today, load, save,
  recordStageRun,
  alreadyBought, recordLabelBought,
  poAlreadyCreated, recordPo,
  emailAlreadySent, orderAlreadyEmailed, recordEmailSent,
  shouldAlert, recordAlert, shouldEmailLargeOrder, recordEmailLargeOrder,
  pickupAlreadyBooked, recordPickup,
  recordError,
  summarize,
  isPaused, setPaused,
};
