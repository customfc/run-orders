#!/usr/bin/env node
/*
 * scripts/trade/pickup-rates.js: branch-pickup shipping rates, DRY-RUN PLANNER ONLY.
 * 02 ProZone build plan 3B; research/2026-09-28-prozone-build/shopify-pickup.md tasks K5 and K8.
 *
 * README
 * ------
 * What it does
 *   The store is on Grow (10 active locations), so branch pickup is a $0 shipping rate per branch inside
 *   per-province zones, not a Shopify pickup location. This script:
 *   1. Reads the live delivery profiles with read-only Admin GraphQL queries (the gql() below refuses mutations).
 *   2. Prints the "Prosol" profile's current zones and rates.
 *   3. Prints the planned change:
 *      - split the "Prosol EZ" zone into one zone per province, each with the same weight-tiered Standard rates
 *        (NB also leaves "Canada Far" with that zone's own tiers, because Moncton is a branch);
 *      - one $0 "Pickup: <City> trade counter (ready in 2-4 business days)" rate per ENABLED branch in
 *        data/trade/pickup-branches.json, in its province's zone. Every branch is enabled:false today, so the
 *        as-configured plan adds no pickup rate;
 *      - a new "Schluter profiles (pickup only)" profile whose zones carry only those pickup rates (held back
 *        while no branch is enabled).
 *      It also prints a preview with the pilot branch (Calgary South) enabled, or with --preview=all or =CODES.
 *   4. Writes the before-state and planned after-state to data/trade/pickup-rates-plan-<BC date>.json.
 *   It never writes to Shopify. There is no apply step: --apply exits 2 before any network call.
 *
 * Usage
 *   node scripts/trade/pickup-rates.js                   as configured, plus the pilot preview
 *   node scripts/trade/pickup-rates.js --preview=all     preview with every branch enabled
 *   node scripts/trade/pickup-rates.js --preview=WCAS,EDMN  (a branch's display code works too: CALS = WCAS)
 *   --no-write (print only), --out=<file>
 *
 * Dependencies before any apply (every one must hold)
 *   1. Prosol's yes (K1, drafts/prosol-branch-pickup-questions.txt): which branches hand our customers their
 *      orders at the counter and how the order is placed. Then Mac flips enabled:true per branch.
 *   2. 01's A1 marker live on the Mini: classifyLocal() in lib/local-fulfillment.js treats a shipping line
 *      starting "Pickup:" as local, so no courier label is bought. Without it a pickup order gets a label and a
 *      PO to the nearest branch.
 *   3. The K4 checkout tests below pass, recorded in 02 PLAN.
 *   Before the rates go public also: K8 (Pickup: title to branch id), K9 (branch PO path, SHADOW first),
 *   K11 (pickup_only hold), K12 (notification text). KELN, GRPR, LETH and the map corrections need N5 first.
 *
 * Checkout tests before any apply (K4: an inert test profile, one DRAFT variant, simulated checkout with
 * draftOrderAvailableDeliveryOptions, which creates nothing)
 *   T1  Pickup-only item alone, to a province with an enabled branch: only that province's "Pickup:" rates.
 *   T2  Pickup-only item plus a General, Tools or Flooring Pallets item: must NOT show a summed "Shipping"
 *       rate (Shopify adds each profile's cheapest rate when no names match). If it does, an 8-ft trim ships:
 *       stop; the K11 hold is only the backstop.
 *   T3  Pickup-only item plus a Prosol-profile item: only the shared "Pickup:" rates (Standard drops out, R1).
 *   T4  Pickup-only item to a province with no branch (PE, NL, YT/NT/NU): no rates, checkout blocked (R2).
 *   Also check a Prosol item alone still gets its Standard tiers in every province, and whether checkout
 *   shows the rate description (address and hours).
 *
 * TODO(apply): NOT IMPLEMENTED ON PURPOSE. Applying is Mac's go only, per change, and only once 01's A1
 *   "Pickup:" marker is live on the Mini (plus Prosol's yes and K4). When it is built: save a fresh before-state,
 *   make ONE deliveryProfileUpdate(id, profile: { locationGroupsToUpdate: [{ id, zonesToUpdate, zonesToCreate }] })
 *   so no province is ever without a zone mid-change, then deliveryProfileCreate for the pickup-only profile
 *   (locationGroupsToCreate with the same locations), re-read, diff against the planned after-state, and keep
 *   the before-state JSON as the rollback. Field names checked by introspection on 2026-09-28.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
const plan = require(path.join(ROOT, 'lib', 'trade-pickup-rates'));

const BRANCHES_FILE = path.join(ROOT, 'data', 'trade', 'pickup-branches.json');
// BC is UTC-7 all year from 2026 (permanent daylight time); local tzdata is stale, so no America/Vancouver.
const BC_DATE = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

/**
 * Read-only by construction: anything that isn't a plain query is refused before it reaches Shopify.
 * The word "mutation" anywhere in the document (a second operation, a comment, a string) is refused too,
 * so a multi-operation document such as `query A { ... } mutation B { ... }` can never get through.
 */
function assertReadOnly(query) {
  const doc = typeof query === 'string' ? query : '';
  const op = doc.replace(/#[^\n]*/g, '').trim();
  if (!op || !/^(query\b|\{)/.test(op) || /\bmutation\b/i.test(doc)) throw new Error('pickup-rates.js is read-only: only GraphQL queries are allowed');
}

async function gql(query, variables) {
  assertReadOnly(query);
  const r = await graphql(query, variables);
  return r.data;
}

const PROFILE_FIELDS = `id name default productVariantsCount { count precision }
  profileLocationGroups {
    locationGroup { id locations(first: 50) { pageInfo { hasNextPage } nodes { id name } } }
    locationGroupZones(first: 30) { pageInfo { hasNextPage } nodes {
      zone { id name countries { code { countryCode restOfWorld } provinces { code } } }
      methodDefinitions(first: 30) { pageInfo { hasNextPage } nodes {
        id name active description
        rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } } ... on DeliveryParticipant { id } }
        methodConditions { id field operator conditionCriteria { __typename ... on Weight { value unit } ... on MoneyV2 { amount currencyCode } } }
      } }
    } }
  }`;

async function readProfiles() {
  const list = await gql('query { deliveryProfiles(first: 50) { pageInfo { hasNextPage } nodes { id name } } }');
  if (list.deliveryProfiles.pageInfo.hasNextPage) throw new Error('more than 50 delivery profiles: raise the page size');
  const out = [];
  for (const p of list.deliveryProfiles.nodes) {
    const d = await gql(`query($id: ID!) { deliveryProfile(id: $id) { ${PROFILE_FIELDS} } }`, { id: p.id });
    out.push(plan.normalizeProfile(d.deliveryProfile));
  }
  return out;
}

const short = (gid) => (gid ? gid.split('/').pop() : 'new');

function printZones(title, profile) {
  console.log(`\n${title}`);
  for (const g of profile.groups) {
    console.log(`  location group ${short(g.id)}: ${g.locations.map((l) => l.name).join(', ')}`);
    for (const z of g.zones) {
      const l = plan.zoneLine(z);
      console.log(`    zone "${l.zone}" (${l.provinces}) id ${short(z.id)}${z.change ? `  <- ${z.change}` : ''}`);
      for (const r of l.rates) console.log(`      ${r}`);
    }
  }
}

function printChecks(checks) {
  const order = { error: 0, warn: 1, info: 2 };
  for (const c of [...checks].sort((a, b) => order[a.level] - order[b.level])) console.log(`  ${c.level.toUpperCase().padEnd(5)} ${c.id}: ${c.msg}`);
}

function summarize(label, p) {
  const s = p.stats;
  const pk = p.pickupProfile;
  console.log(`\n== ${label} ==`);
  console.log(`  enabled branches: ${s.enabled.length ? s.enabled.join(', ') : 'none'}`);
  console.log(`  "Prosol" profile: ${s.zonesUpdated} zones updated, ${s.zonesCreated} zones created, ${s.pickupRatesInProsolProfile} pickup rates added`);
  for (const c of p.prosol.changes) {
    if (c.op === 'UPDATE_ZONE') console.log(`    UPDATE_ZONE ${short(c.zoneId)} "${c.from.name}" ${c.from.provinces.join('/')} -> "${c.to.name}" ${c.to.provinces.join('/')}`);
    else if (c.op === 'CREATE_ZONE') console.log(`    CREATE_ZONE "${c.name}" ${c.provinces.join('/')} with ${c.rates} rates copied from "${c.copyRatesFrom}"`);
    else console.log(`    CREATE_RATE "${c.zone}": "${c.rate}" $0.00 (${c.branch})`);
  }
  console.log(`  "${plan.DEFAULTS.pickupProfileName}": ${pk.status}`);
  for (const c of pk.changes) console.log(`    CREATE_PROFILE locations [${c.locations.join(', ')}], zones [${c.zones.join(', ')}], ${c.rates} pickup rates, ${c.variantsToAssociate} variants (trims are assigned by 02 tasks 4.1/4.3, not here)`);
  if (pk.after && pk.after.groups[0].zones.length) {
    for (const z of pk.after.groups[0].zones) for (const r of z.rates) console.log(`      ${z.name}: "${r.name}" $0.00; description "${r.description}"`);
  }
}

async function main() {
  if (flag('apply')) {
    console.error('REFUSED: pickup-rates.js has no apply step. Applying is Mac\'s go only and depends on Prosol\'s yes, 01\'s A1 "Pickup:" marker being live on the Mini, and the K4 checkout tests (see the README at the top of this file).');
    process.exit(2);
  }
  if (flag('help')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }

  const branchesDoc = JSON.parse(fs.readFileSync(BRANCHES_FILE, 'utf8'));
  const { branches, errors } = plan.loadBranches(branchesDoc);
  if (errors.length) { console.error(`pickup-branches.json is invalid:\n  ${errors.join('\n  ')}`); process.exit(1); }

  const previewArg = opt('preview') || 'pilot';
  const previewMode = ['pilot', 'all'].includes(previewArg) ? previewArg : previewArg.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

  console.log(`pickup-rates.js DRY RUN (read-only) ${new Date().toISOString()}  store ${process.env.SHOPIFY_STORE}`);
  console.log(`branches: ${branches.length} in ${path.relative(ROOT, BRANCHES_FILE)}, enabled ${branches.filter((b) => b.enabled).length}, pilot ${branches.filter((b) => b.pilot).map((b) => b.code).join(', ') || 'none'}`);

  const profiles = await readProfiles();
  console.log(`\nDelivery profiles (read ${profiles.length}):`);
  for (const p of profiles) {
    const zones = p.groups.reduce((n, g) => n + g.zones.length, 0);
    const rates = p.groups.reduce((n, g) => n + g.zones.reduce((m, z) => m + z.rates.length, 0), 0);
    console.log(`  ${p.name} (${short(p.id)})${p.default ? ' default' : ''}: ${p.variants ? `${p.variants.count} variants${p.variants.precision === 'EXACT' ? '' : ` (${p.variants.precision})`}` : ''}, ${p.groups.length} location groups, ${zones} zones, ${rates} rates`);
  }

  const configured = plan.buildPlan({ profiles, branches, enabled: plan.enabledCodes(branches, 'configured') });
  if (!configured.prosol) { printChecks(configured.checks); process.exit(3); }
  const preview = plan.buildPlan({ profiles, branches, enabled: plan.enabledCodes(branches, previewMode) });

  printZones(`BEFORE: "${configured.prosol.before.name}" profile (${short(configured.prosol.before.id)})`, configured.prosol.before);
  printZones('AFTER, as configured:', configured.prosol.after);
  summarize('PLAN AS CONFIGURED (enabled flags in pickup-branches.json)', configured);
  summarize(`PREVIEW (--preview=${Array.isArray(previewMode) ? previewMode.join(',') : previewMode}; not a plan to apply)`, preview);
  console.log(`\n  Pickup rates a buyer would see per province if every branch were enabled: ${Object.entries(configured.stats.pickupRatesIfAllEnabled).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  console.log('\nCHECKS (as configured):');
  printChecks(configured.checks);
  const previewOnly = preview.checks.filter((c) => !configured.checks.some((x) => x.id === c.id && x.msg === c.msg));
  if (previewOnly.length) { console.log('CHECKS (preview only):'); printChecks(previewOnly); }

  console.log('\nBEFORE ANY APPLY: Prosol\'s yes (K1) and Mac\'s go per branch; 01 A1 "Pickup:" marker live on the Mini; K4 checkout tests T1 (alone), T2 (+ General/Tools/Pallets item: no summed "Shipping"), T3 (+ Prosol item), T4 (province with no branch). There is no --apply.');

  const out = {
    generated_at: new Date().toISOString(),
    bc_date: BC_DATE,
    mode: 'DRY RUN, read-only; nothing was written to Shopify',
    store: process.env.SHOPIFY_STORE,
    branches_file: path.relative(ROOT, BRANCHES_FILE),
    dependencies_before_apply: [
      "Prosol's yes (K1) for each branch, then Mac's go to set enabled:true",
      "01 A1: classifyLocal() treats a 'Pickup:' shipping line as local (no label), live on the Mini",
      'K4 checkout tests T1-T4 pass and are recorded in 02 PLAN',
      'Before public: K8 (title to branch id), K9 (branch PO path, SHADOW), K11 (pickup_only hold), K12 (notification text); N5 for KELN/GRPR/LETH and map corrections',
    ],
    checkout_tests: {
      T1: "pickup-only item alone, to a province with an enabled branch: only that province's Pickup: rates",
      T2: "pickup-only item + a General, Tools or Flooring Pallets item: no summed 'Shipping' rate",
      T3: 'pickup-only item + a Prosol-profile item: only the shared Pickup: rates',
      T4: 'pickup-only item to a province with no branch (PE, NL, YT/NT/NU): no rates',
    },
    before: {
      prosol_profile: configured.prosol.before,
      pickup_only_profile: configured.pickupProfile.before,
      other_profiles: profiles.filter((p) => p.name !== plan.DEFAULTS.prosolProfileName).map((p) => ({ id: p.id, name: p.name, variants: p.variants, rate_names: [...new Set(p.groups.flatMap((g) => g.zones.flatMap((z) => z.rates.map((r) => r.name))))] })),
    },
    after: {
      prosol_profile: configured.prosol.after,
      pickup_only_profile: configured.pickupProfile.after,
      pickup_only_status: configured.pickupProfile.status,
      changes: [...configured.prosol.changes, ...configured.pickupProfile.changes],
      checks: configured.checks,
      stats: configured.stats,
    },
    preview: {
      mode: previewMode,
      prosol_profile: preview.prosol.after,
      pickup_only_profile: preview.pickupProfile.after,
      pickup_only_status: preview.pickupProfile.status,
      changes: [...preview.prosol.changes, ...preview.pickupProfile.changes],
      checks: preview.checks,
      stats: preview.stats,
    },
  };
  if (!flag('no-write')) {
    const file = opt('out') || path.join(ROOT, 'data', 'trade', `pickup-rates-plan-${BC_DATE}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(ROOT, file)}`);
  }
  if (configured.checks.some((c) => c.level === 'error')) process.exit(3);
}

module.exports = { gql, assertReadOnly };

if (require.main === module) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
