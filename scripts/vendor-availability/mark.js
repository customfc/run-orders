#!/usr/bin/env node
/**
 * Manually confirm a vendor discontinuation — the "we called them, it's dead,
 * kill it" action. Sets the discontinued flag the Shopify gate reads.
 *
 *   node scripts/vendor-availability/mark.js --vendor biyork --sku BYKHY6HT50BO \
 *     --desc "Hydrogen 6 Tile Bourbon" --note "order desk confirmed w/ Biyork (#1288)" --link
 *
 * --link refreshes the vendor_sku -> our SKU map from Salesforce so the gate can
 *        connect this to the Shopify listing.
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
const a = parseArgs(process.argv.slice(2));

(async () => {
  if (!a.vendor || !a.sku) { console.error('required: --vendor <key> --sku <vendorSku>'); process.exit(1); }
  const res = va.markDiscontinued(a.vendor, a.sku, { description: a.desc, note: a.note, as_of: a['as-of'] });
  console.log('Marked discontinued:', JSON.stringify(res));
  if (a.link) {
    const sf = require('../../lib/salesforce');
    const conn = await sf.connect();
    const lk = await va.refreshSkuLinks(sf, conn);
    console.log(`SKU links refreshed: ${lk.linked}/${lk.candidates} mapped to our catalog.`);
    const linked = va.statusForOurSku; // sanity hint
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
