#!/usr/bin/env node
/**
 * Enumerate a vendor's FULL catalog from the Prosol storefront API.
 *
 * The storefront /api/storefront/products endpoint accepts
 * filter[product_manufacturer_id], so we can page the entire line for one
 * manufacturer rather than probing SKU-by-SKU like pull-prosol-stock.js does.
 * That is what makes a catalog-gap audit possible: we get everything Prosol
 * carries, not just the SKUs we already sell.
 *
 * Manufacturer IDs (from product_manufacturer_id on any product record):
 *   10008 = Schluter-Systems
 *
 * Useful fields on each product: sku / prosol_sku, name{en,fr}, barcode (EAN),
 * msrp_price (CENTS), available_quantity, stock_status, discontinued, active.
 *
 * Usage:
 *   node scripts/fba/pull-prosol-catalog.js                # Schluter
 *   node scripts/fba/pull-prosol-catalog.js --mfr=10008
 *
 * Output: data/fba/snapshots/prosol-catalog-<mfr>-YYYY-MM-DD.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

/** ProsolClientV2.apiGet returns { status, body } with body as a raw string. */
function parseBody(res) {
  if (res && typeof res.body === 'string') {
    try { return JSON.parse(res.body); } catch { return null; }
  }
  return res;
}

async function pullCatalog(client, mfrId, { onPage } = {}) {
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `/api/storefront/products?filter[product_manufacturer_id]=${encodeURIComponent(mfrId)}&limit=${PAGE_SIZE}&page=${page}`;
    const json = parseBody(await client.apiGet(url));
    if (!json || !Array.isArray(json.data)) {
      throw new Error(`unexpected response on page ${page}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    products.push(...json.data);
    if (onPage) onPage(page, json.data.length, products.length);
    if (json.data.length < PAGE_SIZE) break;
  }
  return products;
}

async function main() {
  const args = parseArgs();
  const mfr = args.mfr || '10008';

  const client = new ProsolClientV2();
  await client.init();
  try {
    const products = await pullCatalog(client, mfr, {
      onPage: (p, n, total) => process.stdout.write(`  page ${p}: +${n} (${total})\n`),
    });

    const sellable = products.filter((p) => p.active && !p.discontinued && p.publish_status === 'published');
    const stocked = sellable.filter((p) => Number(p.available_quantity) > 0);

    if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
    const out = path.join(SNAP_DIR, `prosol-catalog-${mfr}-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(out, JSON.stringify({
      pulledAt: new Date().toISOString(),
      manufacturerId: mfr,
      count: products.length,
      sellableCount: sellable.length,
      stockedCount: stocked.length,
      products,
    }, null, 1));

    console.log(`\ntotal ${products.length} | sellable ${sellable.length} | in stock ${stocked.length}`);
    console.log(`✓ wrote ${out}`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { pullCatalog };
