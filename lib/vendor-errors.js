/**
 * Vendor-error ledger — append-only record of vendor (warehouse) fuckups that
 * cost CFC time / money (refunds, replacement labels, re-ships). Mac reconciles
 * these monthly / yearly to charge them back / track vendor reliability.
 *
 * Single source of truth: data/vendor-errors.jsonl (COMMITTED to git, NOT
 * gitignored — unlike the runtime .jsonl logs). One JSON object per line.
 *
 * Log via logVendorError() (from code) or scripts/ops/log-vendor-error.js (CLI).
 * Reconcile via scripts/ops/vendor-error-report.js.
 */
const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'vendor-errors.jsonl');

const ISSUE_TYPES = [
  'short_ship',     // sent fewer than ordered / missing item(s)
  'not_shipped',    // never shipped at all
  'wrong_item',     // shipped the wrong SKU
  'damaged',        // arrived damaged
  'stuck_pickup',   // pickup not collected / lost at depot
  'delayed_shipment', // label bought + branch notified, parcel never tendered to the carrier
  'wrong_address',  // shipped to wrong address
  'late',           // missed ship/delivery window
  'overship',       // sent more than ordered
  'other',
];

function loadVendorErrors() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs.readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nextId(date) {
  const existing = loadVendorErrors().filter((e) => e.date === date);
  const seq = String(existing.length + 1).padStart(3, '0');
  return `ve-${date.replace(/-/g, '')}-${seq}`;
}

/**
 * Append one vendor-error entry. Returns the stored record (with id + logged_at).
 * Required: vendor, issue_type, description. Everything else optional.
 */
function logVendorError(entry = {}) {
  const date = entry.date || todayISO();
  const issue_type = String(entry.issue_type || 'other');
  if (!entry.vendor) throw new Error('vendor is required');
  if (!entry.description) throw new Error('description is required');
  if (!ISSUE_TYPES.includes(issue_type)) {
    throw new Error(`issue_type must be one of: ${ISSUE_TYPES.join(', ')}`);
  }

  const num = (v) => (v == null || v === '' ? 0 : Number(v));
  const cost_label_cad = num(entry.cost_label_cad);
  const cost_refund_cad = num(entry.cost_refund_cad);
  const cost_other_cad = num(entry.cost_other_cad);

  const record = {
    id: entry.id || nextId(date),
    date,
    vendor: entry.vendor,
    location: entry.location || null,
    issue_type,
    order_ref: entry.order_ref || null,
    po_ref: entry.po_ref || null,
    sku: entry.sku || null,
    item: entry.item || null,
    qty_affected: entry.qty_affected != null ? Number(entry.qty_affected) : null,
    description: entry.description,
    cost_label_cad,
    cost_refund_cad,
    cost_other_cad,
    cost_total_cad: Number((cost_label_cad + cost_refund_cad + cost_other_cad).toFixed(2)),
    time_impact: entry.time_impact || null,
    tracking: entry.tracking || null,
    resolution: entry.resolution || null,
    reported_by: entry.reported_by || null,
    source: entry.source || 'claude_handled', // mac_report | pipeline_detected | claude_handled
    // Value exposed by the incident. Deliberately NOT part of cost_total_cad —
    // an undelivered order is not a loss until it is actually refunded or
    // written off. These document what was at stake so a case that later goes
    // bad can be charged back with the real number, and so an open case can be
    // ranked by exposure. When it does go bad, book the real hit in
    // cost_refund_cad via closeVendorError().
    order_value_cad: entry.order_value_cad != null ? Number(entry.order_value_cad) : null,
    product_cost_cad: entry.product_cost_cad != null ? Number(entry.product_cost_cad) : null,
    outcome: entry.outcome || 'open', // open | delivered_late | refunded | returned | written_off | resolved_no_loss
    outcome_at: entry.outcome_at || null,
    updates: [],
    logged_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n');
  return record;
}

const OUTCOMES = ['open', 'delivered_late', 'refunded', 'returned', 'written_off', 'resolved_no_loss'];

/**
 * Amend an existing entry in place. The ledger stays one-object-per-line; the
 * whole file is rewritten so an id keeps a single authoritative row. Every
 * amendment is appended to record.updates so the history is never lost — this
 * is what makes the ledger defensible when charging a vendor back.
 *
 * `patch` may set outcome, resolution, and any cost_* field. cost_total_cad is
 * always recomputed from the three cost columns.
 */
function updateVendorError(id, patch = {}, note = null) {
  const rows = loadVendorErrors();
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) throw new Error(`No vendor-error entry with id ${id}`);
  const before = rows[i];
  if (patch.outcome && !OUTCOMES.includes(patch.outcome)) {
    throw new Error(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  }

  const next = { ...before, ...patch };
  const num = (v) => (v == null || v === '' ? 0 : Number(v));
  next.cost_label_cad = num(next.cost_label_cad);
  next.cost_refund_cad = num(next.cost_refund_cad);
  next.cost_other_cad = num(next.cost_other_cad);
  next.cost_total_cad = Number((next.cost_label_cad + next.cost_refund_cad + next.cost_other_cad).toFixed(2));
  if (patch.outcome && patch.outcome !== before.outcome) next.outcome_at = new Date().toISOString();

  const changed = {};
  for (const k of Object.keys(patch)) if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changed[k] = { from: before[k] ?? null, to: next[k] };
  next.updates = [...(before.updates || []), { at: new Date().toISOString(), changed, note: note || null }];

  rows[i] = next;
  fs.writeFileSync(LEDGER_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return next;
}

module.exports = { logVendorError, updateVendorError, loadVendorErrors, ISSUE_TYPES, OUTCOMES, LEDGER_PATH };
