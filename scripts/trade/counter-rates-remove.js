#!/usr/bin/env node
/**
 * Takes the 17 "Pickup at our <X> trade counter" $0 rates out of the Prosol and "Local pickup only" profiles once the
 * counters use Shopify's own pickup (scripts/trade/native-counters.js; Mac 2026-10-02). The Coast rates (Sechelt,
 * Powell River) and every Standard rate stay. A "Local pickup only" zone left with no rate is deleted (trims can't ship
 * there anyway; with no zone Shopify offers them only native pickup, which is the point).
 *
 *   node scripts/trade/counter-rates-remove.js plan                      read-only: what would go
 *   node scripts/trade/counter-rates-remove.js apply --live              save the before-state, delete, re-read, verify
 *   node scripts/trade/counter-rates-remove.js rollback --before=<file> --live
 *                                                                        re-create the deleted rates (and zones)
 * Writes are logged to data/trade/pickup-zones-log.jsonl; before-state in data/trade/counter-rates-before-<ts>.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { graphql } = require('../../lib/shopify-graphql');

const PROFILES = ['gid://shopify/DeliveryProfile/102840008871', 'gid://shopify/DeliveryProfile/106780786855'];
const PICKUP_ONLY = 'gid://shopify/DeliveryProfile/106780786855';
const DATA = path.join(ROOT, 'data', 'trade');
const LOG = path.join(DATA, 'pickup-zones-log.jsonl');
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), script: 'counter-rates-remove', ...o }) + '\n');
async function gql(q, v) { const r = await graphql(q, v); if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 400)); return r.data; }

const COUNTER_RATE = /^Pickup at our .+ trade counter$/;

async function readProfile(id) {
  const d = await gql(`query($id: ID!) { deliveryProfile(id: $id) { id name profileLocationGroups { locationGroup { id }
    locationGroupZones(first: 60) { pageInfo { hasNextPage } nodes { zone { id name countries { code { countryCode } provinces { code } } }
      methodDefinitions(first: 60) { pageInfo { hasNextPage } nodes { id name description active
        rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } } } } } } } } }`, { id });
  const p = d.deliveryProfile;
  for (const g of p.profileLocationGroups) {
    if (g.locationGroupZones.pageInfo.hasNextPage) throw new Error(`${p.name}: more than 60 zones`);
    for (const z of g.locationGroupZones.nodes) if (z.methodDefinitions.pageInfo.hasNextPage) throw new Error(`${p.name} ${z.zone.name}: more than 60 rates`);
  }
  return p;
}

/** -> [{ profile, name, deletes: [{ id, name, zone }], emptyZones: [{ id, name }] }] */
function planFor(profiles) {
  return profiles.map((p) => {
    const deletes = [];
    const emptyZones = [];
    for (const g of p.profileLocationGroups) for (const z of g.locationGroupZones.nodes) {
      const counter = z.methodDefinitions.nodes.filter((m) => COUNTER_RATE.test(m.name));
      deletes.push(...counter.map((m) => ({ id: m.id, name: m.name, zone: z.zone.name })));
      if (p.id === PICKUP_ONLY && counter.length && counter.length === z.methodDefinitions.nodes.length) emptyZones.push({ id: z.zone.id, name: z.zone.name });
    }
    return { profile: p.id, name: p.name, deletes, emptyZones };
  });
}

async function main() {
  const cmd = args[0];
  if (cmd === 'plan' || cmd === 'apply') {
    const profiles = [];
    for (const id of PROFILES) profiles.push(await readProfile(id));
    const plan = planFor(profiles);
    for (const x of plan) {
      const names = [...new Set(x.deletes.map((d) => d.name))];
      console.log(`${x.name}: delete ${x.deletes.length} counter rates (${names.length} names) in ${new Set(x.deletes.map((d) => d.zone)).size} zones; delete ${x.emptyZones.length} emptied zones${x.emptyZones.length ? ` (${x.emptyZones.map((z) => z.name).join(', ')})` : ''}`);
    }
    if (cmd === 'plan' || !LIVE) return;
    const file = path.join(DATA, `counter-rates-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), profiles }, null, 1));
    log({ action: 'before', file: path.relative(ROOT, file) });
    for (const x of plan) {
      const emptied = new Set(x.emptyZones.map((z) => z.id));
      const methodIds = x.deletes.filter((d) => !x.emptyZones.some((z) => z.name === d.zone)).map((d) => d.id);
      const input = { ...(methodIds.length ? { methodDefinitionsToDelete: methodIds } : {}), ...(emptied.size ? { zonesToDelete: [...emptied] } : {}) };
      if (!Object.keys(input).length) continue;
      const r = await gql(`mutation($id: ID!, $p: DeliveryProfileInput!) { deliveryProfileUpdate(id: $id, profile: $p) { profile { id } userErrors { field message } } }`, { id: x.profile, p: input });
      if (r.deliveryProfileUpdate.userErrors.length) throw new Error(`${x.name}: ${JSON.stringify(r.deliveryProfileUpdate.userErrors)}`);
      log({ action: 'delete', profile: x.name, methods: methodIds.length, zones: emptied.size });
      console.log(`${x.name}: deleted ${methodIds.length} rates and ${emptied.size} zones`);
    }
    const left = [];
    for (const id of PROFILES) for (const g of (await readProfile(id)).profileLocationGroups) for (const z of g.locationGroupZones.nodes) left.push(...z.methodDefinitions.nodes.filter((m) => COUNTER_RATE.test(m.name)));
    console.log(left.length ? `VERIFY FAILED: ${left.length} counter rates still there` : `verified: no counter rates left. Rollback: node scripts/trade/counter-rates-remove.js rollback --before=${path.relative(ROOT, file)} --live`);
    if (left.length) process.exitCode = 2;
    return;
  }
  if (cmd === 'rollback') {
    const before = JSON.parse(fs.readFileSync(opt('before'), 'utf8'));
    for (const p of before.profiles) {
      const now = await readProfile(p.id);
      const liveZones = new Map(now.profileLocationGroups.flatMap((g) => g.locationGroupZones.nodes.map((z) => [z.zone.name, { groupId: g.locationGroup.id, zone: z }])));
      const toUpdate = [];
      const toCreate = [];
      for (const g of p.profileLocationGroups) for (const z of g.locationGroupZones.nodes) {
        const rates = z.methodDefinitions.nodes.filter((m) => COUNTER_RATE.test(m.name)).map((m) => ({ name: m.name, description: m.description, active: m.active, rateDefinition: { price: { amount: m.rateProvider.price.amount, currencyCode: m.rateProvider.price.currencyCode } } }));
        if (!rates.length) continue;
        const live = liveZones.get(z.zone.name);
        if (live) {
          const have = new Set(live.zone.methodDefinitions.nodes.map((m) => m.name));
          const missing = rates.filter((r) => !have.has(r.name));
          if (missing.length) toUpdate.push({ groupId: live.groupId, zone: { id: live.zone.id, methodDefinitionsToCreate: missing } });
        } else {
          toCreate.push({ groupId: g.locationGroup.id, zone: { name: z.zone.name, countries: z.zone.countries.map((c) => ({ code: c.code.countryCode, provinces: c.provinces.map((x) => ({ code: x.code })) })), methodDefinitionsToCreate: rates } });
        }
      }
      const groups = new Map();
      for (const u of toUpdate) (groups.get(u.groupId) || groups.set(u.groupId, { id: u.groupId, zonesToUpdate: [], zonesToCreate: [] }).get(u.groupId)).zonesToUpdate.push(u.zone);
      for (const c of toCreate) (groups.get(c.groupId) || groups.set(c.groupId, { id: c.groupId, zonesToUpdate: [], zonesToCreate: [] }).get(c.groupId)).zonesToCreate.push(c.zone);
      const input = { locationGroupsToUpdate: [...groups.values()] };
      console.log(`${p.name}: re-create rates in ${toUpdate.length} zones, re-create ${toCreate.length} zones`);
      if (!LIVE || !groups.size) continue;
      const r = await gql(`mutation($id: ID!, $p: DeliveryProfileInput!) { deliveryProfileUpdate(id: $id, profile: $p) { profile { id } userErrors { field message } } }`, { id: p.id, p: input });
      if (r.deliveryProfileUpdate.userErrors.length) throw new Error(`${p.name}: ${JSON.stringify(r.deliveryProfileUpdate.userErrors)}`);
      log({ action: 'rollback', profile: p.name, zonesUpdated: toUpdate.length, zonesCreated: toCreate.length });
    }
    return;
  }
  throw new Error('plan | apply --live | rollback --before=<file> --live');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { planFor, COUNTER_RATE };
