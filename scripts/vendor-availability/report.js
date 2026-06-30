#!/usr/bin/env node
/**
 * Vendor-availability reports.
 *   node scripts/vendor-availability/report.js              # coverage by vendor
 *   node scripts/vendor-availability/report.js --discontinued
 *   node scripts/vendor-availability/report.js --sku 00775  # status for one of OUR skus
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const va = require('../../lib/vendor-availability');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) out[m[1]] = m[2];
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[m[1]] = argv[++i];
    else out[m[1]] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

if (args.sku) {
  const r = va.statusForOurSku(args.sku);
  console.log(r ? JSON.stringify(r, null, 2) : `No vendor-availability record linked to our SKU ${args.sku}`);
  process.exit(0);
}

if (args.discontinued) {
  const rows = va.discontinuedReport();
  console.log(`=== DISCONTINUED / GONE (${rows.length}) ===`);
  for (const r of rows) {
    const sold = r.our_sku ? `  WE SELL THIS as ${r.our_sku}` : '';
    console.log(`  [${r.vendor}] ${r.vendor_sku}  last seen ${r.last_seen || '?'}  (missing x${r.missing_count})${sold}  ${r.description || ''}`);
  }
  process.exit(0);
}

console.log('=== COVERAGE BY VENDOR ===');
for (const r of va.coverageReport()) {
  console.log(`  ${r.vendor.padEnd(12)} skus=${r.skus}  avail=${r.available} low=${r.low} out=${r.out} discontinued=${r.discontinued}  latest=${r.latest_feed}`);
}
process.exit(0);
