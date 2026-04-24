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
// Column mapping from the actual headers Amazon's CA restock-recs TSV uses
// (verified against a real 2026-04-24 pull). Left = source, right = planning-
// canonical key fba-signals.normalizeRow expects.
const COLUMN_MAP = {
  // passthrough — already matches planning
  'product-name': 'product-name',
  'fnsku': 'fnsku',
  'sku': 'sku',
  'asin': 'asin',
  'condition': 'condition',
  'alert': 'alert',
  'available': 'available',
  'inbound-quantity': 'inbound-quantity',
  'Total Units': 'Total Units',
  'Recommended ship-in quantity': 'Recommended ship-in quantity',
  // supplier + misc (not used by signals but preserved)
  'supplier': 'supplier',
  'Country': 'country',
  'Currency code': 'currency',
  // sales — restock-recs uses 'Units Sold Last 30 Days' (a count) vs planning's
  // 'units-shipped-t30'. Plus 'Sales last 30 days' which is the dollar amount.
  'Units Sold Last 30 Days': 'units-shipped-t30',
  'Units Sold Last 7 Days': 'units-shipped-t7',
  'Units Sold Last 60 Days': 'units-shipped-t60',
  'Units Sold Last 90 Days': 'units-shipped-t90',
  'Sales last 30 days': 'sales-shipped-last-30-days',
  // date — restock-recs uses 'Recommended ship date' (MM/DD/YYYY); planning
  // uses 'Recommended ship-in date' (ISO). fba-signals reads the latter, so
  // we map into that key.
  'Recommended ship date': 'Recommended ship-in date',
  'Recommended action': 'recommended-action',
  // days of supply
  'Total Days of Supply (including units from open shipments)': 'Total Days of Supply (including units from open shipments)',
  'Days of Supply at Amazon Fulfillment Network': 'days-of-supply',
  // pricing
  'Price': 'your-price',
  'Sales Price': 'sales-price',
  // inbound pipeline (restock-recs breaks these out by state)
  'Working': 'inbound-working',
  'Shipped': 'inbound-shipped',
  'Receiving': 'inbound-received',
  'FC transfer': 'fc-transfer',
  'FC Processing': 'fc-processing',
  'Customer Order': 'reserved-customer-order',
  'Unfulfillable': 'unfulfillable-quantity',
  // storage
  'Unit storage size': 'storage-volume',
  'Fulfilled by': 'fulfilled-by',
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
