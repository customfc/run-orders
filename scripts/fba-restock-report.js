#!/usr/bin/env node
/**
 * FBA Restock Report — pulls FBA inventory + recent ShipStation sales velocity
 * to identify what needs restocking urgently.
 *
 * Usage: node scripts/fba-restock-report.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getAllFbaInventory } = require('../lib/sp-api');
const { v1Request } = require('../lib/shipstation-v2');

const SKU_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8'));
const SKU_MAPPINGS = SKU_MAP.mappings || {};

// Build reverse map: FBA seller SKU → { asin, product, prosolSku }
// FBA SKUs can be the prosol_sku, the api_sku, or the ASIN — we need to match flexibly.
const skuLookup = {};
for (const [asin, entry] of Object.entries(SKU_MAPPINGS)) {
  if (typeof entry === 'string') continue; // section headers
  skuLookup[asin] = { asin, product: entry.product, prosolSku: entry.prosol_sku || entry.api_sku };
  if (entry.prosol_sku) skuLookup[entry.prosol_sku] = { asin, product: entry.product, prosolSku: entry.prosol_sku };
  if (entry.api_sku && entry.api_sku !== entry.prosol_sku) skuLookup[entry.api_sku] = { asin, product: entry.product, prosolSku: entry.prosol_sku || entry.api_sku };
}

async function getRecentSalesVelocity(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const sales = {}; // sku → count
  let page = 1, pages = 1;

  while (page <= pages) {
    const res = await v1Request('GET', `/orders?orderDateStart=${since}&orderStatus=shipped&pageSize=100&page=${page}`);
    if (res.status !== 200) break;
    const data = JSON.parse(res.body);
    for (const order of (data.orders || [])) {
      for (const item of (order.items || [])) {
        const sku = item.sku || '';
        if (!sku) continue;
        if (!sales[sku]) sales[sku] = 0;
        sales[sku] += item.quantity || 1;
      }
    }
    pages = data.pages || 1;
    page++;
  }
  return sales;
}

(async () => {
  console.log('Pulling FBA inventory...');
  const inventory = await getAllFbaInventory();

  console.log('Pulling 30-day sales velocity from ShipStation...\n');
  const sales = await getRecentSalesVelocity(30);

  // Build combined report
  const report = [];
  for (const item of inventory) {
    const sellerSku = item.sellerSku || '';
    const d = item.inventoryDetails || {};
    const fulfillable = d.fulfillableQuantity || 0;
    const inbound = (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0);
    const reserved = d.reservedQuantity?.totalReservedQuantity || 0;

    // Try to match to a known product
    const match = skuLookup[sellerSku] || null;
    const asin = match?.asin || item.asin || '';
    const product = match?.product || item.productName || sellerSku;

    // Sales velocity — check by ASIN, seller SKU, and prosol SKU
    const sold30d = sales[asin] || sales[sellerSku] || (match?.prosolSku ? sales[match.prosolSku] : 0) || 0;
    const dailyRate = sold30d / 30;
    const daysOfStock = dailyRate > 0 ? Math.floor(fulfillable / dailyRate) : (fulfillable > 0 ? 999 : 0);

    report.push({
      sellerSku,
      asin,
      product: product.length > 55 ? product.slice(0, 52) + '...' : product,
      fulfillable,
      inbound,
      reserved,
      sold30d,
      dailyRate: dailyRate.toFixed(1),
      daysOfStock,
    });
  }

  // Sort: items with sales but low stock first (most urgent)
  report.sort((a, b) => {
    // Priority: selling items with 0 stock first
    if (a.sold30d > 0 && b.sold30d === 0) return -1;
    if (a.sold30d === 0 && b.sold30d > 0) return 1;
    // Among selling items, sort by days of stock ascending
    if (a.sold30d > 0 && b.sold30d > 0) return a.daysOfStock - b.daysOfStock;
    // Non-selling items last
    return 0;
  });

  // Output
  const urgent = report.filter(r => r.sold30d > 0 && r.fulfillable === 0);
  const low = report.filter(r => r.sold30d > 0 && r.fulfillable > 0 && r.daysOfStock < 14);
  const ok = report.filter(r => r.sold30d > 0 && r.daysOfStock >= 14);
  const dormant = report.filter(r => r.sold30d === 0);

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  FBA RESTOCK REPORT — ' + new Date().toISOString().slice(0, 10));
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  if (urgent.length) {
    console.log(`🚨 OUT OF STOCK & SELLING (${urgent.length} SKUs) — RESTOCK NOW\n`);
    console.log('  Product                                                  | 30d Sold | /day | Inbound');
    console.log('  ' + '-'.repeat(85));
    for (const r of urgent) {
      console.log(`  ${r.product.padEnd(57)} | ${String(r.sold30d).padStart(8)} | ${r.dailyRate.padStart(4)} | ${String(r.inbound).padStart(7)}`);
    }
    console.log();
  }

  if (low.length) {
    console.log(`⚠️  LOW STOCK & SELLING (${low.length} SKUs) — < 14 days supply\n`);
    console.log('  Product                                                  | Stock | Days | 30d Sold | Inbound');
    console.log('  ' + '-'.repeat(95));
    for (const r of low) {
      console.log(`  ${r.product.padEnd(57)} | ${String(r.fulfillable).padStart(5)} | ${String(r.daysOfStock).padStart(4)} | ${String(r.sold30d).padStart(8)} | ${String(r.inbound).padStart(7)}`);
    }
    console.log();
  }

  if (ok.length) {
    console.log(`✅ ADEQUATE STOCK (${ok.length} SKUs) — 14+ days supply\n`);
    console.log('  Product                                                  | Stock | Days | 30d Sold');
    console.log('  ' + '-'.repeat(90));
    for (const r of ok) {
      console.log(`  ${r.product.padEnd(57)} | ${String(r.fulfillable).padStart(5)} | ${String(r.daysOfStock).padStart(4)} | ${String(r.sold30d).padStart(8)}`);
    }
    console.log();
  }

  console.log(`📦 ${dormant.length} dormant SKUs (0 sales in 30d) not shown.`);
  console.log(`\nTotal FBA SKUs: ${report.length} | Selling: ${report.length - dormant.length} | Out of stock: ${urgent.length} | Low: ${low.length} | OK: ${ok.length}`);
})().catch(e => console.error('ERROR:', e.message));
