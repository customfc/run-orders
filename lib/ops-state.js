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
      email:   { byWarehouse: {} },
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

// ── Helpers for each phase ───────────────────────────────────────────────────

function recordStageRun(state, { count, errors }) {
  state.phases.stage.runs.push({ at: new Date().toISOString(), count, errors });
  save(state);
}

function alreadyBought(state, orderId) {
  return !!state.phases.buy.labels[String(orderId)];
}

function recordLabelBought(state, { orderId, orderNumber, shipmentId, trackingNumber, labelCost, costWarning, carrierCode, serviceCode, estimatedCost, warehouseId, packages }) {
  state.phases.buy.labels[String(orderId)] = {
    orderNumber: orderNumber || null,
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
    at: new Date().toISOString(),
  };
  save(state);
}

function poAlreadyCreated(state, trackingNumber) {
  return !!state.phases.pos.byTracking[trackingNumber];
}

function recordPo(state, { trackingNumber, poNumber, poId }) {
  state.phases.pos.byTracking[trackingNumber] = { poNumber, poId, at: new Date().toISOString() };
  save(state);
}

function emailAlreadySent(state, warehouseKey) {
  return !!state.phases.email.byWarehouse[warehouseKey];
}

function recordEmailSent(state, { warehouseKey, orderCount }) {
  state.phases.email.byWarehouse[warehouseKey] = { orderCount, at: new Date().toISOString() };
  save(state);
}

function pickupAlreadyBooked(state, groupKey) {
  return !!state.phases.pickups.byGroup[groupKey];
}

function recordPickup(state, { groupKey, pickupId, confirmation, labelCount, pickupDate }) {
  state.phases.pickups.byGroup[groupKey] = {
    pickupId, confirmation, labelCount, pickupDate,
    at: new Date().toISOString(),
  };
  save(state);
}

function recordError(state, { phase, reason, context }) {
  state.errors.push({ phase, at: new Date().toISOString(), reason, context: context || null });
  save(state);
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
  emailAlreadySent, recordEmailSent,
  pickupAlreadyBooked, recordPickup,
  recordError,
  summarize,
  isPaused, setPaused,
};
