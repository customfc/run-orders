#!/usr/bin/env node
/**
 * Prosol counters as Shopify locations with Shopify's own local pickup (Mac 2026-10-02: no app, "if its 0 stock a
 * person should not be able to pick it up from that warehouse, that should be a basic shopify function"). Shopify offers
 * pickup at a location only when it can fill the cart there; scripts/trade/counter-stock-sync.js writes Prosol's count
 * to each location (lib/counter-stock.js planLocations). The shop's location limit is 1000 (shop.resourceLimits).
 *
 *   node scripts/trade/native-counters.js status              each counter: its location, pickup on or off
 *   node scripts/trade/native-counters.js create --live       add the missing locations (pickup off, no stock), save
 *                                                             their ids in data/trade/pickup-branches.json
 *   node scripts/trade/native-counters.js pickup-on --live    Shopify pickup on at every counter location
 *   node scripts/trade/native-counters.js pickup-off --live   and off again (the rollback)
 *
 * Location name "<pickup label> trade counter" (customers see it at checkout; never the distributor's name), address
 * from the branch row, instructions = the row's hours and pickup note. Every write goes to data/trade/pickup-zones-log.jsonl.
 *
 * The Coast (Mac 2026-10-02, after #1408: Powell River pickup "Shelf only"): Sechelt and Powell River get their own
 * pickup-only locations ("Sechelt warehouse pickup", "Powell River showroom pickup", id in the row's
 * pickup_location_id), stocked by the sync with CFC's real shelf from Salesforce. The existing Sechelt Warehouse /
 * Powell River locations stay shipping-only: 318 other products hold placeholder counts there.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { graphql } = require('../../lib/shopify-graphql');

const BRANCHES = path.join(ROOT, 'data', 'trade', 'pickup-branches.json');
const LOG = path.join(ROOT, 'data', 'trade', 'pickup-zones-log.jsonl');
const PICKUP_TIME = 'TWO_TO_FOUR_DAYS';
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), script: 'native-counters', ...o }) + '\n');

async function gql(q, v) {
  const r = await graphql(q, v);
  if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 400));
  return r.data;
}
const ue = (label, x) => { if (x && x.userErrors && x.userErrors.length) throw new Error(`${label}: ${JSON.stringify(x.userErrors)}`); };

const COAST_NAMES = { SECH: 'Sechelt warehouse pickup', PRIV: 'Powell River showroom pickup' };
const COAST_ADDRESS = {
  SECH: { address1: '5824 Sechelt Inlet Rd', city: 'Sechelt', provinceCode: 'BC', zip: 'V7Z 0G1', countryCode: 'CA' },
  PRIV: { address1: '7345 Duncan St', city: 'Powell River', provinceCode: 'BC', zip: 'V8A 1W6', countryCode: 'CA' },
};
const nameFor = (b) => (b.coast ? COAST_NAMES[b.code] : `${b.pickup_label} trade counter`);
const idOf = (b) => (b.coast ? b.pickup_location_id : b.shopify_location_id);
/** "Mon to Fri 7:30 am to 4:30 pm. We email you when it's ready, so please wait for that email. Bring ..." */
function instructionsFor(b) {
  const d = String(b.description || '');
  const hours = (d.match(/(Mon to Fri[^.]*\.(?:\s*Sat[^.]*\.)?)/) || [])[1] || '';
  return `${hours ? `${hours} ` : ''}We email you when your order is ready, so please wait for that email. Bring your order number${b.coast ? '' : ' and photo ID'}.`.trim();
}
function addressFor(b) {
  if (b.coast) return COAST_ADDRESS[b.code];
  const a = b.address || {};
  return { address1: a.street, city: a.city, provinceCode: a.province, zip: a.postal_code, countryCode: 'CA' };
}
const counters = (all) => all.filter((b) => b.enabled && ((!b.coast && b.map_key) || (b.coast && COAST_NAMES[b.code])));

async function locations() {
  const d = await gql(`{ locations(first: 250, includeInactive: true) { nodes { id name isActive fulfillsOnlineOrders address { address1 city zip }
    localPickupSettingsV2 { pickupTime instructions } } } }`);
  return d.locations.nodes;
}

async function main() {
  const cmd = args[0];
  const file = JSON.parse(fs.readFileSync(BRANCHES, 'utf8'));
  const only = args.find((x) => x.startsWith('--only='));
  const rows = counters(file.branches).filter((b) => !only || only.slice(7).split(',').includes(b.code));
  const locs = await locations();
  const byId = new Map(locs.map((l) => [l.id, l]));
  const byName = new Map(locs.map((l) => [l.name, l]));
  const locFor = (b) => (idOf(b) && byId.get(idOf(b))) || byName.get(nameFor(b)) || null;

  if (cmd === 'status' || !cmd) {
    for (const b of rows) {
      const l = locFor(b);
      console.log(`${b.code.padEnd(5)} ${nameFor(b).padEnd(38)} ${l ? `${l.id.split('/').pop()} ${l.isActive ? 'active' : 'INACTIVE'} pickup ${l.localPickupSettingsV2 ? 'ON' : 'off'}` : 'no location'}${idOf(b) && !l ? ' (saved id not found!)' : ''}`);
    }
    return;
  }

  if (cmd === 'create') {
    let changed = 0;
    for (const b of rows) {
      let l = locFor(b);
      if (!l) {
        const input = { name: nameFor(b), fulfillsOnlineOrders: true, address: addressFor(b) };
        if (!LIVE) { console.log(`would create ${JSON.stringify(input)}`); continue; }
        const r = await gql(`mutation($i: LocationAddInput!) { locationAdd(input: $i) { location { id name } userErrors { field message } } }`, { i: input });
        ue(`locationAdd ${b.code}`, r.locationAdd);
        l = r.locationAdd.location;
        log({ action: 'locationAdd', code: b.code, id: l.id, input });
        console.log(`created ${b.code} ${l.id}`);
      }
      if (b.coast ? b.pickup_location_id !== l.id : b.shopify_location_id !== l.id) { if (b.coast) b.pickup_location_id = l.id; else b.shopify_location_id = l.id; changed++; }
    }
    if (LIVE && changed) {
      fs.writeFileSync(BRANCHES, JSON.stringify(file, null, 2) + '\n');
      console.log(`saved ${changed} location ids in data/trade/pickup-branches.json`);
    }
    return;
  }

  if (cmd === 'pickup-on' || cmd === 'pickup-off') {
    for (const b of rows) {
      const l = locFor(b);
      if (!l) { console.log(`${b.code}: no location, run create first`); continue; }
      if (!LIVE) { console.log(`would turn pickup ${cmd === 'pickup-on' ? 'on' : 'off'} at ${l.name}${cmd === 'pickup-on' ? `: ${instructionsFor(b)}` : ''}`); continue; }
      if (cmd === 'pickup-on') {
        const r = await gql(`mutation($s: DeliveryLocationLocalPickupEnableInput!) { locationLocalPickupEnable(localPickupSettings: $s) { localPickupSettings { pickupTime } userErrors { field message } } }`,
          { s: { locationId: l.id, pickupTime: b.coast ? 'TWENTY_FOUR_HOURS' : PICKUP_TIME, instructions: instructionsFor(b) } });
        ue(`pickup on ${b.code}`, r.locationLocalPickupEnable);
      } else {
        const r = await gql(`mutation($l: ID!) { locationLocalPickupDisable(locationId: $l) { locationId userErrors { field message } } }`, { l: l.id });
        ue(`pickup off ${b.code}`, r.locationLocalPickupDisable);
      }
      log({ action: cmd, code: b.code, id: l.id });
      console.log(`${cmd} ${b.code} ${l.name}`);
    }
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { nameFor, instructionsFor, addressFor };
