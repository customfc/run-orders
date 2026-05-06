#!/usr/bin/env node
// One-off: match newly-created SS warehouses to prosol-location-map.json
// entries by postal code, and write the resulting shipstation_warehouse_id
// into the map.
//
// Run: node scripts/shipstation/_oneoff-link-new-warehouses.js [--apply]

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SS_AUTH = Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString('base64');
const APPLY = process.argv.includes('--apply');
const MAP_PATH = path.join(__dirname, 'prosol-location-map.json');

function ssGet(endpoint) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'ssapi.shipstation.com', path: endpoint, headers: { Authorization: `Basic ${SS_AUTH}` } }, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    }).on('error', reject);
  });
}

function norm(p) { return String(p || '').replace(/\s/g, '').toUpperCase(); }

async function main() {
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const res = await ssGet('/warehouses');
  const ws = JSON.parse(res.body);

  // Build postal → ssId index for SS warehouses whose name starts with vProsol/Prosol.
  const ssByPostal = new Map();
  for (const w of ws) {
    const name = String(w.warehouseName || '');
    if (!/^v?Prosol|^vPrsol/i.test(name.trim())) continue;
    const key = norm(w.originAddress?.postalCode);
    if (!key) continue;
    if (ssByPostal.has(key) && ssByPostal.get(key) !== w.warehouseId) {
      console.log(`  ⚠️  postal ${key} resolves to multiple SS warehouses (${ssByPostal.get(key)}, ${w.warehouseId})`);
    }
    ssByPostal.set(key, w.warehouseId);
  }

  let linked = 0, alreadySet = 0, skipped = 0;
  for (const [id, loc] of Object.entries(map)) {
    if (loc.non_prosol) continue;
    if (id.startsWith('old_')) continue;
    if (loc.shipstation_warehouse_id) { alreadySet++; continue; }
    const ssId = ssByPostal.get(norm(loc.postal_code));
    if (!ssId) {
      console.log(`  ✗ no SS match for ${id} ${loc.code} ${loc.city} ${loc.postal_code}`);
      skipped++;
      continue;
    }
    console.log(`  ✓ ${id} ${loc.code} (${loc.city}) → SS ${ssId}`);
    if (APPLY) loc.shipstation_warehouse_id = ssId;
    linked++;
  }

  console.log(`\nResult: linked=${linked}, alreadySet=${alreadySet}, skipped=${skipped}`);

  if (APPLY) {
    fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
    console.log(`Updated ${MAP_PATH}`);
  } else {
    console.log('DRY RUN — re-run with --apply to write.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
