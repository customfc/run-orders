#!/usr/bin/env node
/**
 * Append a vendor-error entry to the ledger (data/vendor-errors.jsonl).
 *
 * Usage (flags):
 *   node scripts/ops/log-vendor-error.js \
 *     --vendor "Prosol" --location "Ottawa (OTTA)" --issue short_ship \
 *     --order 701-5042038-3886646 --sku B010MPQL00 --item "DHEHK24038 cable kit" \
 *     --qty 1 --label-cost 20.77 --tracking 520592844259 \
 *     --desc "Prosol shipped 1 of 2 cable kits; reshipped the missing one" \
 *     --resolution "Replacement Purolator label sent to Prosol Ottawa" \
 *     --by Mac --source mac_report
 *
 * Or pass a JSON blob:  node scripts/ops/log-vendor-error.js --json '{...}'
 */
const { logVendorError, ISSUE_TYPES } = require('../../lib/vendor-errors');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[(i++, i)] : true;
    out[key] = val;
  }
  return out;
}

const a = parseArgs(process.argv.slice(2));

let entry;
if (a.json) {
  entry = JSON.parse(a.json);
} else {
  entry = {
    vendor: a.vendor || 'Prosol',
    location: a.location,
    issue_type: a.issue,
    order_ref: a.order,
    po_ref: a.po,
    sku: a.sku,
    item: a.item,
    qty_affected: a.qty,
    description: a.desc,
    cost_label_cad: a['label-cost'],
    cost_refund_cad: a['refund-cost'],
    cost_other_cad: a['other-cost'],
    time_impact: a.time,
    tracking: a.tracking,
    resolution: a.resolution,
    reported_by: a.by,
    source: a.source,
    date: a.date,
  };
}

try {
  const rec = logVendorError(entry);
  console.log('Logged vendor error:');
  console.log(JSON.stringify(rec, null, 2));
} catch (e) {
  console.error('ERROR:', e.message);
  console.error('issue_type must be one of:', ISSUE_TYPES.join(', '));
  process.exit(1);
}
