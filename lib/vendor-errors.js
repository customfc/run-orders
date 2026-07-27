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
    logged_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n');
  return record;
}

module.exports = { logVendorError, loadVendorErrors, ISSUE_TYPES, LEDGER_PATH };
