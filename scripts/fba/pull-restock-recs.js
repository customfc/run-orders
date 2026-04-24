#!/usr/bin/env node
/**
 * Pull GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT — the SP-API report
 * that actually backs Amazon's Seller Central Restock page UI.
 *
 * Added 2026-04-24 after discovering GET_FBA_INVENTORY_PLANNING_DATA
 * (our previous primary source) returned only 30 rows while Amazon's
 * Restock page clearly showed 15+ additional replenishable SKUs that
 * were never surfaced to our /po flow.
 *
 * Column names in this report differ from planning; we normalize into
 * the SAME shape planning emits (same keys fba-signals.normalizeRow
 * looks up) so downstream code doesn't care which source was used.
 *
 * Writes to data/fba/snapshots/restock-recs-YYYY-MM-DD.json. fba-signals
 * loadLatestSnapshot now prefers this file when fresh; falls back to
 * planning when absent.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchReport } = require('../../lib/sp-api-reports');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');

// Amazon's restock-recs column headers → planning's canonical keys.
// Restock report headers are typically Title Case with spaces; planning's
// normalizer keys are lowercase-hyphen. Left field is the header Amazon
// gives us; right is the planning key fba-signals expects.
const COLUMN_MAP = {
  'Product Name': 'product-name',
  'FNSKU': 'fnsku',
  'Merchant SKU': 'sku',
  'ASIN': 'asin',
  'Condition': 'condition',
  'Supplier': 'supplier',
  'Supplier part no.': 'supplier-part-no',
  'Country/Region of Origin': 'country-of-origin',
  'Product Group': 'product-group',
  'product-group': 'product-group',
  'Sales Rank': 'sales-rank',
  'sales-rank': 'sales-rank',
  'Total Units': 'Total Units',
  'Inbound': 'inbound-quantity',
  'Available': 'available',
  'available': 'available',
  'Sales shipped last 7 days': 'units-shipped-t7',
  'Sales shipped last 30 days': 'units-shipped-t30',
  'Sales shipped last 60 days': 'units-shipped-t60',
  'Sales shipped last 90 days': 'units-shipped-t90',
  'units-shipped-last-7-days': 'units-shipped-t7',
  'units-shipped-last-30-days': 'units-shipped-t30',
  'units-shipped-last-60-days': 'units-shipped-t60',
  'units-shipped-last-90-days': 'units-shipped-t90',
  'Days of Supply': 'days-of-supply',
  'days-of-supply': 'days-of-supply',
  'Alert': 'alert',
  'alert': 'alert',
  'Recommended replenishment qty': 'Recommended ship-in quantity',
  'Recommended ship-in date': 'Recommended ship-in date',
  'Recommended action': 'recommended-action',
  'recommended-action': 'recommended-action',
  'Your Price': 'your-price',
  'Sales Price': 'sales-price',
  'your-price': 'your-price',
};

function normalizeRow(raw) {
  const out = {};
  // Map known columns
  for (const [src, dst] of Object.entries(COLUMN_MAP)) {
    if (raw[src] !== undefined && raw[src] !== '') out[dst] = raw[src];
  }
  // Keep everything else untouched so we don't lose data
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in COLUMN_MAP) && !(k in out)) out[k] = v;
  }
  // Coerce the numerics fba-signals touches
  const numericKeys = [
    'available', 'inbound-quantity', 'days-of-supply',
    'Recommended ship-in quantity', 'Total Units',
    'units-shipped-t7', 'units-shipped-t30', 'units-shipped-t60', 'units-shipped-t90',
    'your-price', 'sales-price', 'sales-rank',
  ];
  for (const k of numericKeys) {
    if (out[k] !== undefined && out[k] !== '') {
      const n = Number(out[k]);
      if (!Number.isNaN(n)) out[k] = n;
    }
  }
  return out;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.split('=');
    return [k.slice(2), v !== undefined ? v : true];
  }));
  const marketplaceId = args.marketplaceId || process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '') || 'A2EUQ1WTGCTBG2';
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(SNAP_DIR, `restock-recs-${today}.json`);

  console.log('Requesting GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT...');
  console.log('(usually takes 1–5 min — polling every 15s)\n');
  const { report, rows } = await fetchReport({
    reportType: 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
    marketplaceIds: [marketplaceId],
    parse: 'tsv',
    onProgress: (ev) => {
      if (ev.step === 'created') console.log(`  created reportId=${ev.reportId}`);
      else if (ev.step === 'poll') console.log(`  poll: ${ev.status}`);
      else if (ev.step === 'ready') console.log(`  ready, downloading document...`);
      else if (ev.step === 'downloaded') console.log(`  downloaded ${ev.bytes} bytes, parsing...`);
    },
  });

  const normalized = (rows || []).map(normalizeRow);

  const snapshot = {
    pulledAt: new Date().toISOString(),
    reportType: 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
    marketplaceId,
    reportId: report?.reportId,
    reportDocumentId: report?.reportDocumentId,
    dataStartTime: report?.dataStartTime,
    dataEndTime: report?.dataEndTime,
    rowCount: normalized.length,
    rows: normalized,
  };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  const recommendedToShip = normalized.filter((r) => (r['Recommended ship-in quantity'] || 0) > 0);
  console.log(`\n✓ ${normalized.length} rows saved to ${outPath}`);
  console.log(`  Rows with recommended ship-in qty > 0: ${recommendedToShip.length}`);
  if (recommendedToShip.length <= 30) {
    console.log('\n  ASINs with recShipQty > 0:');
    for (const r of recommendedToShip) {
      console.log(`    ${r.asin}  qty=${r['Recommended ship-in quantity']}  ${(r['product-name'] || '').slice(0, 60)}`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    if (e.body) console.error('body:', String(e.body).slice(0, 500));
    process.exit(1);
  });
}

module.exports = { main, normalizeRow, COLUMN_MAP };
