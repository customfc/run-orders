#!/usr/bin/env node
/**
 * Vendor-error reconciliation report. Reads data/vendor-errors.jsonl.
 *
 * Usage:
 *   node scripts/ops/vendor-error-report.js                # all time
 *   node scripts/ops/vendor-error-report.js --month 2026-06 # one month
 *   node scripts/ops/vendor-error-report.js --year 2026     # one year
 *   node scripts/ops/vendor-error-report.js --vendor Prosol # one vendor
 *   node scripts/ops/vendor-error-report.js --csv           # CSV dump (for the accountant)
 */
const { loadVendorErrors } = require('../../lib/vendor-errors');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    out[key] = val;
  }
  return out;
}
const a = parseArgs(process.argv.slice(2));

let rows = loadVendorErrors();
if (a.month) rows = rows.filter((r) => (r.date || '').startsWith(a.month));
if (a.year) rows = rows.filter((r) => (r.date || '').startsWith(String(a.year)));
if (a.vendor) rows = rows.filter((r) => (r.vendor || '').toLowerCase() === String(a.vendor).toLowerCase());
rows.sort((x, y) => String(x.date).localeCompare(String(y.date)));

const money = (n) => '$' + Number(n || 0).toFixed(2);

if (a.csv) {
  const cols = ['date', 'vendor', 'location', 'issue_type', 'order_ref', 'po_ref', 'sku', 'qty_affected',
    'cost_label_cad', 'cost_refund_cad', 'cost_other_cad', 'cost_total_cad', 'tracking', 'description', 'resolution', 'source'];
  console.log(cols.join(','));
  for (const r of rows) {
    console.log(cols.map((c) => {
      const v = r[c] == null ? '' : String(r[c]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','));
  }
  process.exit(0);
}

const scope = a.month ? `month ${a.month}` : a.year ? `year ${a.year}` : 'all time';
console.log(`\n=== VENDOR ERROR REPORT — ${scope}${a.vendor ? ` — ${a.vendor}` : ''} ===`);
console.log(`${rows.length} incident(s)\n`);

if (!rows.length) { console.log('(none)'); process.exit(0); }

// Line items
for (const r of rows) {
  console.log(`${r.date}  ${r.id}  [${r.vendor}${r.location ? '/' + r.location : ''}]  ${r.issue_type}`);
  console.log(`   ${r.order_ref ? 'order ' + r.order_ref + '  ' : ''}${r.sku ? 'sku ' + r.sku + '  ' : ''}${r.qty_affected != null ? 'qty ' + r.qty_affected : ''}`);
  console.log(`   cost: ${money(r.cost_total_cad)}  (label ${money(r.cost_label_cad)} / refund ${money(r.cost_refund_cad)} / other ${money(r.cost_other_cad)})`);
  if (r.description) console.log(`   ${r.description}`);
  console.log('');
}

// Totals
const sum = (k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
console.log('--- TOTALS ---');
console.log(`label spend:   ${money(sum('cost_label_cad'))}`);
console.log(`refunds:       ${money(sum('cost_refund_cad'))}`);
console.log(`other:         ${money(sum('cost_other_cad'))}`);
console.log(`GRAND TOTAL:   ${money(sum('cost_total_cad'))}`);

// By vendor
const byVendor = {};
for (const r of rows) {
  byVendor[r.vendor] = byVendor[r.vendor] || { n: 0, cost: 0 };
  byVendor[r.vendor].n++; byVendor[r.vendor].cost += Number(r.cost_total_cad || 0);
}
console.log('\n--- BY VENDOR ---');
for (const [v, s] of Object.entries(byVendor).sort((x, y) => y[1].cost - x[1].cost)) {
  console.log(`  ${v}: ${s.n} incident(s), ${money(s.cost)}`);
}

// By issue type
const byType = {};
for (const r of rows) byType[r.issue_type] = (byType[r.issue_type] || 0) + 1;
console.log('\n--- BY ISSUE TYPE ---');
for (const [t, n] of Object.entries(byType).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${t}: ${n}`);
}
console.log('');
