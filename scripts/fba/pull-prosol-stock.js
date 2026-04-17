#!/usr/bin/env node
/**
 * Pull Prosol stock for every FBA-relevant SKU.
 *
 * Iterates scripts/shipstation/sku-map.json, pulls Schluter + Aqua Mix
 * entries with a valid prosol_sku, and fetches warehouse-level stock
 * via the existing ProsolClientV2 (Puppeteer-based login + storefront API).
 *
 * Output:
 *   data/fba/snapshots/prosol-stock-YYYY-MM-DD.json
 *
 * Usage:
 *   node scripts/fba/pull-prosol-stock.js                 # all
 *   node scripts/fba/pull-prosol-stock.js --only=B0xyz    # single ASIN (for debugging)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');
const { PRIMARY_LOCATION_ID } = require('../../lib/prosol-stock');

const SKU_MAP_PATH = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'sku-map.json');
const LOC_MAP_PATH = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'prosol-location-map.json');
const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');

function loadEligibleSkus(onlyAsin) {
  const map = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8')).mappings;
  const rows = [];
  for (const [asin, entry] of Object.entries(map)) {
    if (typeof entry !== 'object') continue;
    const ps = entry.prosol_sku || '';
    if (!ps || ps === 'NON_PROSOL' || ps.startsWith('UNMAPPED')) continue;
    if (onlyAsin && asin !== onlyAsin) continue;
    // Schluter (brand field) OR Aqua Mix (product name) — Prosol distributes both
    const isSchluter = (entry.brand || '').toLowerCase() === 'schluter';
    const isAquamix = /aqua[\s.-]*mix/i.test(entry.product || '');
    if (!isSchluter && !isAquamix) continue;
    rows.push({ asin, prosolSku: ps, product: entry.product || '' });
  }
  // De-dupe by prosolSku (multiple ASINs can share a prosol SKU)
  const byPs = new Map();
  for (const r of rows) if (!byPs.has(r.prosolSku)) byPs.set(r.prosolSku, r);
  return [...byPs.values()];
}

function loadLocations() {
  try { return JSON.parse(fs.readFileSync(LOC_MAP_PATH, 'utf8')); }
  catch { return {}; }
}

async function main() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

  const eligible = loadEligibleSkus(only);
  const locMap = loadLocations();
  console.log(`Fetching Prosol stock for ${eligible.length} SKUs...\n`);
  if (!eligible.length) { console.log('nothing to do'); return; }

  const client = new ProsolClientV2();
  await client.init();

  const skus = {};
  let ok = 0, miss = 0, err = 0;
  for (let i = 0; i < eligible.length; i++) {
    const { prosolSku, product } = eligible[i];
    process.stdout.write(`  [${i + 1}/${eligible.length}] ${prosolSku.padEnd(18)} `);
    try {
      const inv = await client.checkInventory(prosolSku);
      if (!inv || !inv.locationStock) {
        console.log('(no match)');
        miss++;
        continue;
      }
      const locations = [];
      let totalAvailable = 0, atPrimary = 0;
      for (const [locId, stock] of Object.entries(inv.locationStock)) {
        const id = Number(locId);
        const available = Number(stock.available) || 0;
        const qty = Number(stock.quantity) || 0;
        const loc = locMap[id] || {};
        locations.push({
          locationId: id,
          code: loc.code || null,
          city: loc.city || null,
          qty,
          available,
        });
        totalAvailable += available;
        if (id === PRIMARY_LOCATION_ID) atPrimary = available;
      }
      const atOthers = totalAvailable - atPrimary;
      skus[prosolSku] = {
        productId: inv.productId,
        product,
        fetchedAt: new Date().toISOString(),
        locations,
        totalAvailable,
        atPrimary,
        atOthers,
      };
      console.log(`WCAS=${atPrimary}, others=${atOthers}, total=${totalAvailable}`);
      ok++;
    } catch (e) {
      console.log(`ERR: ${e.message.slice(0, 80)}`);
      err++;
    }
  }

  await client.close();

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(SNAP_DIR, `prosol-stock-${today}.json`);
  const snapshot = {
    pulledAt: new Date().toISOString(),
    primaryLocationId: PRIMARY_LOCATION_ID,
    skuCount: Object.keys(skus).length,
    skus,
  };
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`\n✓ Saved ${Object.keys(skus).length} SKUs → ${outPath}`);
  console.log(`  ok=${ok}  miss=${miss}  err=${err}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
