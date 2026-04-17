#!/usr/bin/env node
/**
 * Pull Buy Box / competitive offers for every ASIN in the latest
 * inventory-planning snapshot. Save to data/fba/snapshots/buybox-YYYY-MM-DD.json.
 *
 * Uses Pricing v0 getItemOffersBatch (20 ASINs per call, 30s between batches
 * to stay under the SP-API rate limit with margin).
 *
 * Usage:
 *   node scripts/fba/pull-buybox.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getOffersForAsins } = require('../../lib/sp-api');
const { loadLatestSnapshot } = require('../../lib/fba-signals');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');

async function main() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const sellerId = process.env.AMAZON_SELLER_ID?.replace(/"/g, '');
  if (!sellerId) throw new Error('AMAZON_SELLER_ID not set in .env');

  const snap = loadLatestSnapshot();
  if (!snap) throw new Error('No inventory-planning snapshot. Run pull-inventory-planning.js first.');

  const asins = [...new Set(snap.rows.map((r) => r.asin).filter(Boolean))];
  console.log(`Pulling Buy Box data for ${asins.length} ASINs (batches of 20, 30s apart)...`);

  const results = await getOffersForAsins(asins, {
    sellerId,
    onProgress: (p) => console.log(`  batch: ${p.done}/${p.total}`),
  });

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(SNAP_DIR, `buybox-${today}.json`);
  const payload = {
    pulledAt: new Date().toISOString(),
    sellerId,
    asinCount: asins.length,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n✓ Saved to ${outPath}`);

  const ok = results.filter((r) => r.ok);
  const winning = ok.filter((r) => r.summary.buyBoxIsUs);
  const losing = ok.filter((r) => r.summary.buyBoxSellerId && !r.summary.buyBoxIsUs && r.summary.ourPrice !== null);
  const noOffer = ok.filter((r) => r.summary.ourPrice === null);
  const sole = ok.filter((r) => !r.summary.buyBoxSellerId);
  const err = results.filter((r) => !r.ok);

  console.log('\n── Buy Box Summary ────────────────────────────');
  console.log(`  Winning Buy Box:   ${winning.length}`);
  console.log(`  Losing Buy Box:    ${losing.length}`);
  console.log(`  No offer from us:  ${noOffer.length}  (listed but not live — suppressed?)`);
  console.log(`  Sole offer:        ${sole.length}`);
  console.log(`  Errors:            ${err.length}`);

  if (losing.length) {
    // cross-reference with snapshot for product names
    const nameByAsin = Object.fromEntries(snap.rows.map((r) => [r.asin, r.productName]));
    console.log('\n── LOSING Buy Box — immediate revenue action ──');
    const sorted = [...losing].sort((a, b) => {
      const gapA = (a.summary.ourPrice || 0) - (a.summary.buyBoxPrice || 0);
      const gapB = (b.summary.ourPrice || 0) - (b.summary.buyBoxPrice || 0);
      return gapB - gapA;
    });
    for (const r of sorted) {
      const s = r.summary;
      const gap = ((s.ourPrice || 0) - (s.buyBoxPrice || 0)).toFixed(2);
      const name = (nameByAsin[r.asin] || r.asin).slice(0, 55);
      console.log(`  ${name.padEnd(55)}  BB=$${(s.buyBoxPrice || 0).toFixed(2).padStart(7)}  US=$${(s.ourPrice || 0).toFixed(2).padStart(7)}  +$${gap.padStart(5)}  offers=${s.offerCount}`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
