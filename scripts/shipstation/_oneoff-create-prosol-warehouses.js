#!/usr/bin/env node
// One-off: create ShipStation warehouses for Prosol locations that exist in
// prosol-location-map.json but have shipstation_warehouse_id=null. Also
// reconciles two locations (DART, MONC) where SS warehouses already exist.
//
// Run on Mac Mini: node scripts/shipstation/_oneoff-create-prosol-warehouses.js [--apply]

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SS_KEY = process.env.SHIPSTATION_API_KEY;
const SS_SECRET = process.env.SHIPSTATION_API_SECRET;
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
const SS_HOST = 'ssapi.shipstation.com';
const APPLY = process.argv.includes('--apply');

const MAP_PATH = path.join(__dirname, 'prosol-location-map.json');
const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));

// Default phone — Prosol locations route via Kaitlyn at Concord; carriers
// rarely call the phone, but it's required by SS. Using the Custom Flooring
// fallback that Mississauga and Coquitlam already use.
const DEFAULT_PHONE = '6048853582';

// Pre-existing SS warehouses for Prosol that aren't yet wired to the map.
// Discovered by listing /warehouses and matching city/province.
const PRE_EXISTING = {
  '10016': 1852858, // DART → Prosol - Dartmouth
  '10029': 1852856, // MONC → Prosol - Moncton NB
};

function ssRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SS_HOST, path: endpoint, method,
      headers: {
        Authorization: `Basic ${SS_AUTH}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function buildAddress(loc) {
  const cityTitle = loc.city.replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    name: `Prosol ${cityTitle}`,
    company: 'Prosol Inc.',
    street1: loc.address || '',
    city: cityTitle,
    state: loc.province,
    postalCode: loc.postal_code || '',
    country: 'CA',
    phone: DEFAULT_PHONE,
    residential: false,
  };
}

function buildPayload(loc) {
  const cityTitle = loc.city.replace(/\b\w/g, (c) => c.toUpperCase());
  const addr = buildAddress(loc);
  return {
    warehouseName: `Prosol - ${cityTitle}`,
    originAddress: addr,
    returnAddress: addr,
  };
}

async function main() {
  const targets = [];
  for (const [id, loc] of Object.entries(map)) {
    if (loc.shipstation_warehouse_id) continue;
    if (loc.non_prosol) continue;
    if (!loc.address || !loc.postal_code) {
      console.log(`SKIP ${id} ${loc.code} — missing address/postal`);
      continue;
    }
    if (!loc.active) {
      console.log(`SKIP ${id} ${loc.code} — inactive`);
      continue;
    }
    targets.push({ id, loc });
  }

  console.log(`\nTargets: ${targets.length}`);
  console.log(`Apply: ${APPLY}\n`);

  for (const { id, loc } of targets) {
    if (PRE_EXISTING[id]) {
      const ssId = PRE_EXISTING[id];
      console.log(`[link] ${id} ${loc.code} (${loc.city}) → SS ${ssId} (pre-existing)`);
      if (APPLY) {
        map[id].shipstation_warehouse_id = ssId;
      }
      continue;
    }
    const payload = buildPayload(loc);
    console.log(`[create] ${id} ${loc.code} (${loc.city}, ${loc.province})`);
    if (!APPLY) continue;
    const res = await ssRequest('POST', '/warehouses', payload);
    if (res.status !== 200 && res.status !== 201) {
      console.error(`  FAIL ${res.status}: ${res.body.slice(0, 300)}`);
      continue;
    }
    const data = JSON.parse(res.body);
    const ssId = data.warehouseId;
    console.log(`  ✓ created SS warehouse ${ssId}`);
    map[id].shipstation_warehouse_id = ssId;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (APPLY) {
    fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
    console.log(`\nUpdated ${MAP_PATH}`);
  } else {
    console.log('\nDRY RUN — re-run with --apply to create.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
