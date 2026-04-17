#!/usr/bin/env node
/**
 * Augment scripts/shipstation/sku-map.json with Schluter MAP prices.
 *
 * Reads the latest data/fba/maps/schluter-map-*.csv, matches each entry's
 * ITEM# against our prosol_sku (normalized — strip slashes, uppercase),
 * and writes map fields onto the sku-map entry:
 *
 *   schluter_item:  original ITEM# from MAP list
 *   map_cad:        MAP price in CAD (effective date ~ the CSV file date)
 *   retail_cad:     MSRP in CAD
 *   map_effective:  effective date (YYYY-MM-DD)
 *   brand:          "schluter"
 *   map_source:     "schluter-map-YYYY-MM-DD.csv"
 *
 * Thermostat SKUs (DHERT*) are marked with `map_override_allowed: true`
 * — user policy: they break MAP on thermostats (highest-value products).
 * The repricer still won't auto-violate — this flag is informational.
 *
 * Usage:
 *   node scripts/fba/ingest-schluter-map.js            # dry run (reports only)
 *   node scripts/fba/ingest-schluter-map.js --write    # actually modifies sku-map.json
 */

const fs = require('fs');
const path = require('path');
const { loadMap, findByProsolSku, findByUpc } = require('../../lib/schluter-map');

const SKU_MAP_PATH = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'sku-map.json');

const SCHLUTER_CATEGORIES = new Set([
  'DITRA', 'KERDI', 'SCHIENE', 'DILEX', 'KBSC', 'KB', 'RENO', 'JOLLY',
  'TREP', 'TRENO', 'BARA', 'ECK', 'FINEC', 'QUADEC', 'RONDEC', 'DHE', 'DHERT',
]);
const SCHLUTER_SKU_PREFIXES = ['DHE', 'DHERT', 'KERDI', 'KBSC', 'KDIF', 'KD4GR', 'KS', 'KST', 'KM', 'KGT', 'KL', 'SES', 'AE', 'A/', 'A1'];

function isSchluter(entry) {
  if (!entry || typeof entry === 'string') return false;
  const name = (entry.product || '').toLowerCase();
  if (name.includes('schluter')) return true;
  if (entry.source === 'schluter-reference') return true;
  const cat = (entry.category || '').toUpperCase();
  if (SCHLUTER_CATEGORIES.has(cat)) return true;
  const sku = (entry.prosol_sku || '').toUpperCase();
  if (SCHLUTER_SKU_PREFIXES.some((p) => sku.startsWith(p))) return true;
  return false;
}

function isThermostat(entry) {
  const sku = (entry.prosol_sku || '').toUpperCase();
  const name = (entry.product || '').toLowerCase();
  return sku.startsWith('DHERT') || /thermostat/.test(name);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const write = args.has('--write');

  const mapData = loadMap();
  console.log(`Loaded Schluter MAP: ${mapData.records.length} records  (effective ${mapData.effectiveDate})`);
  console.log(`Source: ${path.basename(mapData.path)}\n`);

  const skuMapRaw = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8'));
  const mappings = skuMapRaw.mappings;

  const schluter = [];
  for (const [asin, entry] of Object.entries(mappings)) {
    if (isSchluter(entry)) schluter.push({ asin, entry });
  }
  console.log(`Schluter ASINs in sku-map: ${schluter.length}`);

  let matched = 0, unmatched = [], updated = 0, thermostats = [], matchedViaUpc = 0;
  for (const { asin, entry } of schluter) {
    let mapRec = null;
    let matchMethod = null;

    const key = entry.prosol_sku || entry.api_sku;
    if (key && key !== 'NON_PROSOL' && !key.startsWith('UNMAPPED')) {
      mapRec = findByProsolSku(mapData, key);
      if (mapRec) matchMethod = 'prosol_sku';
    }
    if (!mapRec && entry.barcode) {
      mapRec = findByUpc(mapData, entry.barcode);
      if (mapRec) { matchMethod = 'upc'; matchedViaUpc++; }
    }

    if (!mapRec) {
      unmatched.push({
        asin,
        reason: key ? 'item-not-in-map-list' : 'no-prosol-sku',
        prosol_sku: key || null,
        barcode: entry.barcode || null,
        product: (entry.product || '').slice(0, 50),
      });
      continue;
    }
    matched++;
    const thermo = isThermostat(entry);
    if (thermo) thermostats.push({ asin, prosol_sku: key, map_cad: mapRec.mapCad, product: (entry.product || '').slice(0, 50) });

    // Compute the augmented fields
    const augments = {
      brand: 'schluter',
      schluter_item: mapRec.item,
      map_cad: mapRec.mapCad,
      retail_cad: mapRec.retailCad,
      map_effective: mapData.effectiveDate,
      map_source: path.basename(mapData.path),
      ...(thermo ? { map_override_allowed: true, map_override_reason: 'thermostats — user policy: biggest-value products, occasional MAP breaks' } : {}),
    };

    // Only write if values differ
    let changed = false;
    for (const [k, v] of Object.entries(augments)) {
      if (entry[k] !== v) { changed = true; break; }
    }
    if (changed) {
      Object.assign(entry, augments);
      updated++;
    }
  }

  console.log(`\nMatch results:`);
  console.log(`  Matched:        ${matched}  (${matchedViaUpc} via UPC fallback)`);
  console.log(`  Unmatched:      ${unmatched.length}`);
  console.log(`  Thermostats:    ${thermostats.length} (flagged map_override_allowed)`);
  console.log(`  To update:      ${updated} entries`);

  if (unmatched.length) {
    console.log('\nUnmatched Schluter ASINs (need manual MAP entry or investigation):');
    for (const u of unmatched) {
      console.log(`  ${u.asin.padEnd(12)} ${(u.prosol_sku || '').padEnd(18)} ${u.reason.padEnd(22)} | ${u.product}`);
    }
  }

  if (thermostats.length) {
    console.log('\nThermostats (MAP known, break flag set):');
    for (const t of thermostats) {
      console.log(`  ${t.asin.padEnd(12)} ${t.prosol_sku.padEnd(14)} MAP=$${t.map_cad.toFixed(2).padStart(7)}  | ${t.product}`);
    }
  }

  if (!write) {
    console.log('\n(dry run — rerun with --write to persist changes to sku-map.json)');
    return;
  }

  // Write back — preserve structured _notes; track ingest history separately
  skuMapRaw._updated = new Date().toISOString();
  skuMapRaw._map_ingest_history = skuMapRaw._map_ingest_history || [];
  skuMapRaw._map_ingest_history.push({
    at: new Date().toISOString(),
    source: path.basename(mapData.path),
    matched,
    matchedViaUpc,
    unmatched: unmatched.length,
    thermostatsFlagged: thermostats.length,
    updatedEntries: updated,
  });
  fs.writeFileSync(SKU_MAP_PATH, JSON.stringify(skuMapRaw, null, 2));
  console.log(`\n✓ Wrote ${updated} updated entries to sku-map.json`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
}

module.exports = { main };
