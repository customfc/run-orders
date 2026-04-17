#!/usr/bin/env node
/**
 * Pull GET_FBA_INVENTORY_PLANNING_DATA — the data source behind
 * Seller Central's "Restock Inventory" page.
 *
 * Key columns (TSV):
 *   sku, fnsku, asin, product-name, condition,
 *   available, inbound-quantity, days-of-supply,
 *   alert, recommended-ship-date, recommended-replenishment-qty,
 *   units-shipped-t7, units-shipped-t30, units-shipped-t60, units-shipped-t90,
 *   sales-shipped-last-30-days, lowest-price-new-plus-shipping,
 *   inv-age-0-to-90-days, inv-age-91-to-180-days, ... 365-plus-days,
 *   your-price, sales-price, currency,
 *   fba-inventory-level-fee-applied, ... (many more)
 *
 * Usage:
 *   node scripts/fba/pull-inventory-planning.js
 *
 * Output:
 *   data/fba/snapshots/inventory-planning-YYYY-MM-DD.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchReport } = require('../../lib/sp-api-reports');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');

async function main() {
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID;
  if (!marketplaceId) throw new Error('AMAZON_SP_MARKETPLACE_ID not set');

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(SNAP_DIR, `inventory-planning-${today}.json`);

  console.log('Requesting GET_FBA_INVENTORY_PLANNING_DATA...');
  console.log('(usually takes 1–5 min — polling every 15s)\n');

  const { report, rows } = await fetchReport({
    reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
    marketplaceIds: [marketplaceId],
    parse: 'tsv',
    onProgress: (ev) => {
      if (ev.step === 'created') console.log(`  created reportId=${ev.reportId}`);
      else if (ev.step === 'poll') console.log(`  poll: ${ev.status}`);
      else if (ev.step === 'ready') console.log(`  ready, downloading document...`);
      else if (ev.step === 'downloaded') console.log(`  downloaded ${ev.bytes} bytes, parsing...`);
    },
  });

  // Coerce numeric fields for downstream use
  const numericKeys = [
    'available', 'inbound-quantity', 'inbound-working', 'inbound-shipped', 'inbound-received',
    'pending-removal-quantity', 'unfulfillable-quantity', 'days-of-supply',
    'recommended-sales-price', 'recommended-removal-quantity', 'recommended-sale-duration-days',
    'healthy-inventory-level', 'Recommended ship-in quantity',
    'units-shipped-t7', 'units-shipped-t30', 'units-shipped-t60', 'units-shipped-t90',
    'sales-shipped-last-7-days', 'sales-shipped-last-30-days',
    'sales-shipped-last-60-days', 'sales-shipped-last-90-days',
    'inv-age-0-to-90-days', 'inv-age-91-to-180-days', 'inv-age-181-to-270-days',
    'inv-age-271-to-365-days', 'inv-age-365-plus-days',
    'inv-age-0-to-30-days', 'inv-age-31-to-60-days', 'inv-age-61-to-90-days',
    'inv-age-181-to-330-days', 'inv-age-331-to-365-days',
    'your-price', 'sales-price', 'lowest-price-new-plus-shipping', 'lowest-price-used',
    'featuredoffer-price', 'sales-rank', 'sell-through',
    'weeks-of-cover-t30', 'weeks-of-cover-t90',
    'historical-days-of-supply', 'Short term historical days of supply', 'Long term historical days of supply',
    'estimated-excess-quantity', 'estimated-storage-cost-next-month', 'storage-volume', 'item-volume',
    'Inventory Supply at FBA', 'Total Reserved Quantity',
    'Total Days of Supply (including units from open shipments)',
  ];
  const normalized = rows.map((r) => {
    const out = { ...r };
    for (const k of numericKeys) {
      if (out[k] !== undefined && out[k] !== '') {
        const n = Number(out[k]);
        if (!Number.isNaN(n)) out[k] = n;
      }
    }
    return out;
  });

  const snapshot = {
    pulledAt: new Date().toISOString(),
    reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
    marketplaceId,
    reportId: report.reportId,
    reportDocumentId: report.reportDocumentId,
    dataStartTime: report.dataStartTime,
    dataEndTime: report.dataEndTime,
    rowCount: normalized.length,
    rows: normalized,
  };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n✓ Saved ${normalized.length} rows → ${outPath}`);

  // Quick summary
  const alerted = normalized.filter((r) => r.alert && r.alert.trim() && r.alert !== 'Low traffic');
  const zeroStock = normalized.filter((r) => r.available === 0 && (r['units-shipped-t30'] || 0) > 0);
  const createPlan = normalized.filter((r) => r['recommended-action'] === 'CreateShippingPlan');
  const recommendedToShip = normalized.filter((r) => (r['Recommended ship-in quantity'] || 0) > 0);
  const lipcApplied = normalized.filter((r) => r['Low-Inventory-Level fee applied in current week?'] === 'Yes');

  console.log('\n── Quick Summary ──────────────────────────────');
  console.log(`  Total rows:                ${normalized.length}`);
  console.log(`  Amazon alerts (non-traffic): ${alerted.length}`);
  console.log(`  Zero-stock + selling:      ${zeroStock.length}`);
  console.log(`  Action = CreateShippingPlan: ${createPlan.length}`);
  console.log(`  Has ship-in quantity:      ${recommendedToShip.length}`);
  console.log(`  LIPC fee applied this wk:  ${lipcApplied.length}`);
  if (recommendedToShip.length) {
    const totalUnits = recommendedToShip.reduce((s, r) => s + (r['Recommended ship-in quantity'] || 0), 0);
    console.log(`  Total recommended units:   ${totalUnits}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
