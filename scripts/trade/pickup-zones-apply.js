#!/usr/bin/env node
/*
 * scripts/trade/pickup-zones-apply.js: puts the province-gated $0 pickup rates live (PICKUP-ZONES-PLAN.md S2/S3).
 *
 * Mac 2026-10-02: Shopify's native pickup showed Sechelt and Powell River to every Canadian address; replace it with
 * "Pickup at our <X>" $0 rates in per-province zones (BC: Sechelt, Powell River + hubs; other provinces: Prosol hubs),
 * in the Prosol profile and the "Local pickup only" profile, with identical names so mixed carts keep them. The plan
 * itself is lib/trade-pickup-rates.js buildPlan() over data/trade/pickup-branches.json (enabled rows).
 *
 *   node scripts/trade/pickup-zones-apply.js plan                     print the exact requests (read-only)
 *   node scripts/trade/pickup-zones-apply.js apply --live             save before-state, apply, re-read, verify
 *   node scripts/trade/pickup-zones-apply.js rollback --live --before=<file>
 *   node scripts/trade/pickup-zones-apply.js pickup-off --live        native local pickup off at Sechelt + Powell River
 *   node scripts/trade/pickup-zones-apply.js pickup-on --live         back on (2-4 days / 5+ days, saved instructions)
 *   node scripts/trade/pickup-zones-apply.js verify                   re-read and check the live state against the plan
 *
 * Prosol zones are split in batches of at most 4 new zones; each batch narrows the kept zones ("Prosol EZ" -> BC,
 * "Canada Far" -> PE/NL) only by the provinces created in that same request, so no province is ever zoneless
 * (verified 2026-10-02 on a throwaway profile: zonesToUpdate countries REPLACE the zone's provinces, and a province can
 * move to a new zone in the same request). Every write is logged to data/trade/pickup-zones-log.jsonl.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
const plan = require(path.join(ROOT, 'lib', 'trade-pickup-rates'));

const PICKUP_PROFILE_ID = 'gid://shopify/DeliveryProfile/106780786855';
const NATIVE = [
  { id: 'gid://shopify/Location/65050771623', name: 'Sechelt Warehouse', pickupTime: 'TWO_TO_FOUR_DAYS' },
  { id: 'gid://shopify/Location/65050837159', name: 'Powell River Showroom & Warehouse', pickupTime: 'FIVE_OR_MORE_DAYS' },
];
const NATIVE_INSTRUCTIONS = "We'll email you when your order is ready for pickup. Bring your order number.";
const DATA = path.join(ROOT, 'data', 'trade');
const LOG = path.join(DATA, 'pickup-zones-log.jsonl');
const args = process.argv.slice(2);
const CMD = args[0];
const LIVE = args.includes('--live');
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

async function gql(query, variables) {
  const r = await graphql(query, variables);
  return r.data;
}
function errs(label, ue) { if (ue && ue.length) throw new Error(`${label}: ${JSON.stringify(ue)}`); }

const PROFILE_FIELDS = `id name default productVariantsCount { count precision }
  profileLocationGroups {
    locationGroup { id locations(first: 50) { pageInfo { hasNextPage } nodes { id name } } }
    locationGroupZones(first: 30) { pageInfo { hasNextPage } nodes {
      zone { id name countries { code { countryCode restOfWorld } provinces { code } } }
      methodDefinitions(first: 40) { pageInfo { hasNextPage } nodes {
        id name active description
        rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } } ... on DeliveryParticipant { id } }
        methodConditions { id field operator conditionCriteria { __typename ... on Weight { value unit } ... on MoneyV2 { amount currencyCode } } }
      } }
    } }
  }`;

async function readProfile(id) {
  const d = await gql(`query($id: ID!) { deliveryProfile(id: $id) { ${PROFILE_FIELDS} } }`, { id });
  return plan.normalizeProfile(d.deliveryProfile);
}
async function readProfiles() {
  const list = await gql('{ deliveryProfiles(first: 50) { nodes { id name } } }');
  const prosol = list.deliveryProfiles.nodes.find((p) => p.name === plan.DEFAULTS.prosolProfileName);
  if (!prosol) throw new Error('no "Prosol" delivery profile');
  return [await readProfile(prosol.id), await readProfile(PICKUP_PROFILE_ID)];
}

function loadTable() {
  const doc = JSON.parse(fs.readFileSync(path.join(DATA, 'pickup-branches.json'), 'utf8'));
  const { branches, errors } = plan.loadBranches(doc);
  if (errors.length) throw new Error(`pickup-branches.json: ${errors.join('; ')}`);
  return branches;
}

function buildTarget(profiles, branches) {
  const p = plan.buildPlan({ profiles, branches, enabled: plan.enabledCodes(branches, 'configured') });
  const bad = p.checks.filter((c) => c.level === 'error');
  if (bad.length) throw new Error(`plan errors: ${bad.map((c) => `${c.id}: ${c.msg}`).join(' | ')}`);
  if (p.prosol.before.groups.length !== 1) throw new Error('Prosol profile has more than one location group');
  if (p.pickupProfile.status !== 'EXISTS') throw new Error(`pickup-only profile status ${p.pickupProfile.status}, expected EXISTS`);
  return p;
}

function rateInput(r) {
  const weight = r.conditions.filter((c) => c.field === 'TOTAL_WEIGHT').map((c) => ({ operator: c.operator, criteria: { value: c.value, unit: c.unit } }));
  const price = r.conditions.filter((c) => c.field === 'TOTAL_PRICE').map((c) => ({ operator: c.operator, criteria: { amount: c.value, currencyCode: c.unit } }));
  return {
    name: r.name, active: r.active !== false,
    ...(r.description ? { description: r.description } : {}),
    rateDefinition: { price: { amount: r.price, currencyCode: r.currency || 'CAD' } },
    ...(weight.length ? { weightConditionsToCreate: weight } : {}),
    ...(price.length ? { priceConditionsToCreate: price } : {}),
  };
}
const ca = (provinces) => [{ code: 'CA', provinces: provinces.map((code) => ({ code })) }];

/** The deliveryProfileUpdate requests, in order. */
function buildRequests(p) {
  const group = p.prosol.before.groups[0];
  const after = p.prosol.after.groups[0].zones;
  const kept = after.filter((z) => z.id);
  const created = after.filter((z) => !z.id);
  const batches = [];
  for (let i = 0; i < created.length; i += 4) batches.push(created.slice(i, i + 4));
  const requests = [];
  batches.forEach((batch, bi) => {
    const later = batches.slice(bi + 1).flat();
    const last = bi === batches.length - 1;
    const zonesToUpdate = kept.map((k) => {
      const stillHere = later.filter((z) => z.sourceZoneId === k.id).flatMap((z) => z.provinces);
      const before = group.zones.find((z) => z.id === k.id);
      const provinces = [...k.provinces, ...stillHere];
      const pick = last ? k.rates.filter((r) => r.kind === 'pickup') : [];
      const renamed = last && k.name !== before.name;
      if (!pick.length && !renamed && JSON.stringify([...provinces].sort()) === JSON.stringify([...before.provinces].sort())) return null;
      return { id: k.id, ...(renamed ? { name: k.name } : {}), countries: ca(provinces), ...(pick.length ? { methodDefinitionsToCreate: pick.map(rateInput) } : {}) };
    }).filter(Boolean);
    const zonesToCreate = batch.map((z) => ({ name: z.name, countries: ca(z.provinces), methodDefinitionsToCreate: z.rates.map(rateInput) }));
    requests.push({ profile: p.prosol.before.id, label: `Prosol batch ${bi + 1}/${batches.length}: create ${batch.map((z) => z.provinces[0]).join(', ')}`,
      input: { locationGroupsToUpdate: [{ id: group.id, zonesToUpdate, zonesToCreate }] } });
  });
  const pg = p.pickupProfile.before.groups[0];
  const pz = p.pickupProfile.after.groups[0].zones;
  const existingPickupZones = new Set(pg.zones.map((z) => z.provinces.join('/')));
  const pzNew = pz.filter((z) => !existingPickupZones.has(z.provinces.join('/')));
  for (let i = 0; i < pzNew.length; i += 5) {
    const batch = pzNew.slice(i, i + 5);
    requests.push({ profile: PICKUP_PROFILE_ID, label: `Pickup-only zones: ${batch.map((z) => z.provinces[0]).join(', ')}`,
      input: { locationGroupsToUpdate: [{ id: pg.id, zonesToCreate: batch.map((z) => ({ name: z.name, countries: ca(z.provinces), methodDefinitionsToCreate: z.rates.map(rateInput) })) }] } });
  }
  return requests;
}

/** Check the live profiles against the plan's after-state. Returns a list of problems (empty = good). */
function verify(beforePlan, liveProfiles) {
  const problems = [];
  const [prosol, pickup] = liveProfiles;
  const want = beforePlan.prosol.after.groups[0].zones;
  const live = prosol.groups[0].zones;
  const byProv = (zones) => { const m = {}; for (const z of zones) for (const pr of z.provinces) { if (m[pr]) problems.push(`${pr} is in two zones`); m[pr] = z; } return m; };
  const L = byProv(live);
  for (const w of want) {
    for (const pr of w.provinces) {
      const z = L[pr];
      if (!z) { problems.push(`Prosol: ${pr} has no zone`); continue; }
      const sig = (rates) => rates.map((r) => plan.rateSignature({ ...r, conditions: r.conditions || [] })).sort();
      const wantStd = sig(w.rates.filter((r) => r.kind === 'standard'));
      const liveStd = sig(z.rates.filter((r) => !/^Pickup at our /.test(r.name)));
      if (JSON.stringify(wantStd) !== JSON.stringify(liveStd)) problems.push(`Prosol ${pr}: Standard rates differ from before`);
      const wantPick = w.rates.filter((r) => r.kind === 'pickup').map((r) => `${r.name}|${r.price}|${r.description}`).sort();
      const livePick = z.rates.filter((r) => /^Pickup at our /.test(r.name)).map((r) => `${r.name}|${r.price}|${r.description}`).sort();
      if (JSON.stringify(wantPick) !== JSON.stringify(livePick)) problems.push(`Prosol ${pr}: pickup rates ${JSON.stringify(livePick.map((x) => x.split('|')[0]))} != ${JSON.stringify(wantPick.map((x) => x.split('|')[0]))}`);
    }
  }
  const P = byProv(pickup.groups[0].zones);
  for (const w of beforePlan.pickupProfile.after.groups[0].zones) {
    const z = P[w.provinces[0]];
    if (!z) { problems.push(`pickup-only: ${w.provinces[0]} has no zone`); continue; }
    const a = z.rates.map((r) => r.name).sort(); const b = w.rates.map((r) => r.name).sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`pickup-only ${w.provinces[0]}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    if (z.rates.some((r) => r.price !== 0)) problems.push(`pickup-only ${w.provinces[0]}: a non-zero rate`);
  }
  for (const z of live) {
    if (!z.provinces.includes('BC') && z.rates.some((r) => /Sechelt|Powell River/.test(r.name))) problems.push(`Prosol ${z.name}: a Coast rate outside BC`);
  }
  return problems;
}

async function runRequests(requests) {
  for (const r of requests) {
    console.log(`  -> ${r.label}`);
    const d = await gql(`mutation($id: ID!, $p: DeliveryProfileInput!) { deliveryProfileUpdate(id: $id, profile: $p) { profile { id } userErrors { field message } } }`, { id: r.profile, p: r.input });
    errs(r.label, d.deliveryProfileUpdate.userErrors);
    log({ step: 'deliveryProfileUpdate', label: r.label, profile: r.profile });
  }
}

async function main() {
  if (['apply', 'rollback', 'pickup-off', 'pickup-on'].includes(CMD) && !LIVE) throw new Error(`${CMD} writes to Shopify: add --live`);
  if (CMD === 'plan' || CMD === 'apply' || CMD === 'verify') {
    const branches = loadTable();
    const profiles = await readProfiles();
    if (CMD === 'verify') {
      const target = JSON.parse(fs.readFileSync(opt('target') || path.join(DATA, 'pickup-zones-target.json'), 'utf8'));
      const problems = verify(target, profiles);
      console.log(problems.length ? `PROBLEMS:\n  ${problems.join('\n  ')}` : 'OK: live profiles match the plan');
      process.exitCode = problems.length ? 1 : 0;
      return;
    }
    const p = buildTarget(profiles, branches);
    const requests = buildRequests(p);
    console.log(`${requests.length} requests:`);
    for (const r of requests) {
      const g = r.input.locationGroupsToUpdate[0];
      console.log(`  ${r.label}`);
      for (const u of g.zonesToUpdate || []) console.log(`     update ${u.id.split('/').pop()}${u.name ? ` -> "${u.name}"` : ''}: ${u.countries[0].provinces.map((x) => x.code).join('/')}${u.methodDefinitionsToCreate ? ` + ${u.methodDefinitionsToCreate.length} pickup rates` : ''}`);
      for (const c of g.zonesToCreate || []) console.log(`     create "${c.name}" ${c.countries[0].provinces.map((x) => x.code).join('/')}: ${c.methodDefinitionsToCreate.map((m) => `${m.name} $${m.rateDefinition.price.amount}`).join('; ')}`);
    }
    if (CMD === 'plan') return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const beforeFile = path.join(DATA, `pickup-zones-before-${stamp}.json`);
    fs.writeFileSync(beforeFile, JSON.stringify({ profiles, native: await nativeState() }, null, 1));
    fs.writeFileSync(path.join(DATA, 'pickup-zones-target.json'), JSON.stringify(p, null, 1));
    log({ step: 'before-saved', file: beforeFile });
    console.log(`before-state: ${beforeFile}`);
    await runRequests(requests);
    await new Promise((s) => setTimeout(s, 3000));
    const problems = verify(p, await readProfiles());
    log({ step: 'verify', problems });
    console.log(problems.length ? `VERIFY PROBLEMS:\n  ${problems.join('\n  ')}\nRoll back: node scripts/trade/pickup-zones-apply.js rollback --live --before=${beforeFile}` : 'VERIFIED: live profiles match the plan.');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (CMD === 'rollback') {
    const file = opt('before');
    if (!file) throw new Error('--before=<file> required');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [nowProsol, nowPickup] = await readProfiles();
    const [wasProsol, wasPickup] = before.profiles;
    const keptIds = new Set(wasProsol.groups[0].zones.map((z) => z.id));
    const createdZones = nowProsol.groups[0].zones.filter((z) => !keptIds.has(z.id)).map((z) => z.id);
    const keptRateIds = new Set(wasProsol.groups[0].zones.flatMap((z) => z.rates.map((r) => r.id)));
    const addedRates = nowProsol.groups[0].zones.filter((z) => keptIds.has(z.id)).flatMap((z) => z.rates.filter((r) => !keptRateIds.has(r.id)).map((r) => r.id));
    const pickupWas = new Set(wasPickup.groups[0].zones.map((z) => z.id));
    const pickupCreated = nowPickup.groups[0].zones.filter((z) => !pickupWas.has(z.id)).map((z) => z.id);
    console.log(`rollback: delete ${createdZones.length} Prosol zones + ${addedRates.length} added rates, restore ${keptIds.size} zones; delete ${pickupCreated.length} pickup-only zones`);
    await runRequests([
      { profile: nowProsol.id, label: 'Prosol: delete created zones and added rates', input: { zonesToDelete: createdZones, methodDefinitionsToDelete: addedRates } },
      { profile: nowProsol.id, label: 'Prosol: restore kept zones', input: { locationGroupsToUpdate: [{ id: wasProsol.groups[0].id, zonesToUpdate: wasProsol.groups[0].zones.map((z) => ({ id: z.id, name: z.name, countries: ca(z.provinces) })) }] } },
      ...(pickupCreated.length ? [{ profile: PICKUP_PROFILE_ID, label: 'pickup-only: delete zones', input: { zonesToDelete: pickupCreated } }] : []),
    ]);
    console.log('rolled back. Re-run the simulator.');
    return;
  }
  if (CMD === 'pickup-off' || CMD === 'pickup-on') {
    for (const loc of NATIVE) {
      if (CMD === 'pickup-off') {
        const d = await gql(`mutation($id: ID!) { locationLocalPickupDisable(locationId: $id) { locationId userErrors { field message } } }`, { id: loc.id });
        errs(`disable ${loc.name}`, d.locationLocalPickupDisable.userErrors);
      } else {
        const d = await gql(`mutation($s: DeliveryLocationLocalPickupEnableInput!) { locationLocalPickupEnable(localPickupSettings: $s) { localPickupSettings { pickupTime } userErrors { field message } } }`,
          { s: { locationId: loc.id, pickupTime: loc.pickupTime, instructions: NATIVE_INSTRUCTIONS } });
        errs(`enable ${loc.name}`, d.locationLocalPickupEnable.userErrors);
      }
      log({ step: CMD, location: loc.name });
    }
    console.log(`${CMD}: ${JSON.stringify(await nativeState())}`);
    return;
  }
  console.error('usage: pickup-zones-apply.js plan | apply --live | verify | rollback --live --before=<file> | pickup-off --live | pickup-on --live');
  process.exitCode = 2;
}

async function nativeState() {
  const out = {};
  for (const loc of NATIVE) {
    const d = await gql(`query($id: ID!) { location(id: $id) { localPickupSettingsV2 { pickupTime instructions } } }`, { id: loc.id });
    out[loc.name] = d.location.localPickupSettingsV2;
  }
  return out;
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
module.exports = { buildRequests, verify, rateInput };
