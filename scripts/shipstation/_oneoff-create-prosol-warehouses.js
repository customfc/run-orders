#!/usr/bin/env node
// One-off: bring prosol-location-map.json + ShipStation warehouses into sync
// with Prosol's source-of-truth /api/storefront/inventory_locations.
//
//   1. Pull live Prosol location data (incl. real phone numbers) via API.
//   2. Patch prosol-location-map.json: contact_phone for every Prosol entry.
//   3. For each Prosol entry:
//        - has SS id, but address/phone differ → PUT to update
//        - no SS id, but a matching SS warehouse already exists (DART, MONC) → link
//        - no SS id, no SS warehouse → POST to create
//   4. Save map.
//
// Run: node scripts/shipstation/_oneoff-create-prosol-warehouses.js [--apply]

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { ProsolClientV2 } = require('./prosol-client-v2');

const SS_KEY = process.env.SHIPSTATION_API_KEY;
const SS_SECRET = process.env.SHIPSTATION_API_SECRET;
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
const SS_HOST = 'ssapi.shipstation.com';
const APPLY = process.argv.includes('--apply');

const MAP_PATH = path.join(__dirname, 'prosol-location-map.json');

// SS warehouses that already exist for Prosol locations not yet wired into
// prosol-location-map.json (discovered by listing GET /warehouses).
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

function titleCase(s) {
  return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildAddress(loc, phone) {
  const cityTitle = titleCase(loc.city);
  return {
    name: `Prosol ${cityTitle}`,
    company: 'Prosol Inc.',
    street1: loc.address || '',
    city: cityTitle,
    state: loc.province,
    postalCode: loc.postal_code || '',
    country: 'CA',
    phone,
    residential: false,
  };
}

function buildPayload(loc, phone) {
  const cityTitle = titleCase(loc.city);
  const addr = buildAddress(loc, phone);
  return {
    warehouseName: `Prosol - ${cityTitle}`,
    originAddress: addr,
    returnAddress: addr,
  };
}

async function fetchProsolLocations() {
  const c = new ProsolClientV2();
  await c.init();
  const res = await c.apiGet('/api/storefront/inventory_locations?per_page=100');
  await c.close();
  if (res.status !== 200) throw new Error(`Prosol locations fetch failed: ${res.status}`);
  return JSON.parse(res.body).data || [];
}

async function main() {
  console.log(`Fetching live Prosol locations...`);
  const live = await fetchProsolLocations();
  const liveById = new Map(live.map((l) => [String(l.id), l]));
  console.log(`  got ${live.length} locations\n`);

  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));

  // Step 1: backfill contact_phone in the map from live data.
  let phonePatched = 0;
  for (const [id, loc] of Object.entries(map)) {
    if (loc.non_prosol) continue;
    const live = liveById.get(String(id));
    if (!live || !live.phone) continue;
    const newPhone = [live.phone];
    const cur = Array.isArray(loc.contact_phone) ? loc.contact_phone : (loc.contact_phone ? [loc.contact_phone] : []);
    if (cur.length === 1 && cur[0] === live.phone) continue;
    loc.contact_phone = newPhone;
    phonePatched++;
  }
  console.log(`Patched contact_phone on ${phonePatched} map entries\n`);

  // Step 2: walk every active Prosol entry, decide: link / update / create.
  const work = { create: [], link: [], update: [], skip: [] };

  for (const [id, loc] of Object.entries(map)) {
    if (loc.non_prosol) continue;
    if (!loc.active) { work.skip.push({ id, code: loc.code, why: 'inactive' }); continue; }
    if (!loc.address || !loc.postal_code) { work.skip.push({ id, code: loc.code, why: 'missing address/postal' }); continue; }
    if (id.startsWith('old_')) continue;
    const liveLoc = liveById.get(String(id));
    const phone = (liveLoc && liveLoc.phone) || (Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone) || null;
    if (!phone) { work.skip.push({ id, code: loc.code, why: 'no phone' }); continue; }

    if (loc.shipstation_warehouse_id) {
      work.update.push({ id, loc, phone, ssId: loc.shipstation_warehouse_id });
    } else if (PRE_EXISTING[id]) {
      work.link.push({ id, loc, phone, ssId: PRE_EXISTING[id] });
    } else {
      work.create.push({ id, loc, phone });
    }
  }

  console.log(`Plan: ${work.create.length} create, ${work.link.length} link, ${work.update.length} update, ${work.skip.length} skip\n`);

  // List the LINK and CREATE work first (those changed routing surface).
  for (const w of work.link) console.log(`[link]   ${w.id} ${w.loc.code} (${w.loc.city}) → SS ${w.ssId}`);
  for (const w of work.create) console.log(`[create] ${w.id} ${w.loc.code} (${w.loc.city}, ${w.loc.province}) phone=${w.phone}`);
  for (const w of work.update) console.log(`[update] ${w.id} ${w.loc.code} (${w.loc.city}) ssId=${w.ssId} phone=${w.phone}`);
  for (const w of work.skip) console.log(`[skip]   ${w.id} ${w.code} — ${w.why}`);

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to write.');
    return;
  }

  // Apply updates → links → creates (safest order).
  for (const w of work.update) {
    const payload = buildPayload(w.loc, w.phone);
    const res = await ssRequest('PUT', `/warehouses/${w.ssId}`, payload);
    if (res.status >= 200 && res.status < 300) {
      console.log(`  ✓ updated ${w.loc.code} (SS ${w.ssId})`);
    } else {
      console.error(`  FAIL update ${w.loc.code}: ${res.status} ${res.body.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const w of work.link) {
    map[w.id].shipstation_warehouse_id = w.ssId;
    console.log(`  ✓ linked ${w.loc.code} → SS ${w.ssId}`);
  }

  for (const w of work.create) {
    const payload = buildPayload(w.loc, w.phone);
    const res = await ssRequest('POST', '/warehouses', payload);
    if (res.status !== 200 && res.status !== 201) {
      console.error(`  FAIL create ${w.loc.code}: ${res.status} ${res.body.slice(0, 300)}`);
      continue;
    }
    const data = JSON.parse(res.body);
    map[w.id].shipstation_warehouse_id = data.warehouseId;
    console.log(`  ✓ created ${w.loc.code} → SS ${data.warehouseId}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
  console.log(`\nUpdated ${MAP_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
