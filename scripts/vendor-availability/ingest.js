#!/usr/bin/env node
/**
 * Ingest a vendor availability feed.
 *
 *   node scripts/vendor-availability/ingest.js --vendor biyork --file feed.csv --as-of 2026-06-18
 *   node scripts/vendor-availability/ingest.js --vendor someedi --file inv.edi --format edi846 --as-of 2026-06-18
 *   node scripts/vendor-availability/ingest.js --vendor x --file list.pdf --format pdf --as-of 2026-06-18
 *
 * Flags: --vendor (registry key, required) --file (required) --as-of YYYY-MM-DD (required)
 *        --format (override registry) --partial (don't infer discontinuations from drop-off)
 *        --link (refresh vendor_sku -> our SKU map from Salesforce after ingest)
 *        --dry  (parse + print, do not write)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const path = require('path');
const { parseFeed, vendorConfig } = require('../../lib/vendor-feeds');
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

(async () => {
  const vendor = args.vendor, file = args.file, asOf = args['as-of'];
  if (!vendor || !file || !asOf) {
    console.error('required: --vendor <key> --file <path> --as-of YYYY-MM-DD');
    process.exit(1);
  }
  const cfg = vendorConfig(vendor);
  if (!cfg) { console.error(`Vendor "${vendor}" not in registry (data/vendor-feeds/vendors.json)`); process.exit(1); }
  const format = args.format || cfg.format;

  console.log(`Ingesting ${file} as vendor=${vendor} format=${format} as-of=${asOf}`);
  const rows = await parseFeed(path.resolve(file), format, cfg);
  console.log(`Parsed ${rows.length} rows. Sample:`);
  for (const r of rows.slice(0, 5)) console.log('  ', JSON.stringify(r));

  if (args.dry) { console.log('\n--dry: not writing.'); process.exit(0); }

  const res = va.ingest(rows, {
    vendor, format, source_file: path.basename(file), as_of: asOf,
    full: cfg.full !== false && !args.partial,
  });
  console.log(`\nFeed #${res.feedId}: ${res.ingested} SKUs upserted.`);
  if (res.newlyDiscontinued.length) {
    console.log(`\n*** ${res.newlyDiscontinued.length} NEWLY DISCONTINUED (dropped off ${va.DISCONTINUE_AFTER}+ full feeds) ***`);
    for (const d of res.newlyDiscontinued.slice(0, 50)) console.log(`   ${d.vendor_sku}  ${d.description || ''}`);
  }

  if (args.link) {
    const sf = require('../../lib/salesforce');
    const conn = await sf.connect();
    const lk = await va.refreshSkuLinks(sf, conn);
    console.log(`\nSKU links refreshed: ${lk.linked}/${lk.candidates} vendor SKUs mapped to our catalog.`);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
