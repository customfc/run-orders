const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const plan = require('./trade-pickup-rates');
const branchesDoc = require('../data/trade/pickup-branches.json');

// Raw GraphQL-shaped fixtures matching the live profiles read on 2026-09-28 (shopify-pickup.md 1.6).
const kg = (op, v) => ({ id: `c${Math.random()}`, field: 'TOTAL_WEIGHT', operator: op, conditionCriteria: { __typename: 'Weight', value: v, unit: 'KILOGRAMS' } });
let n = 0;
const rate = (name, price, conds = [], typename = 'DeliveryRateDefinition') => ({
  id: `gid://shopify/DeliveryMethodDefinition/${++n}`, name, active: true, description: null,
  rateProvider: typename === 'DeliveryRateDefinition' ? { __typename: typename, id: 'r', price: { amount: String(price), currencyCode: 'CAD' } } : { __typename: typename, id: 'p' },
  methodConditions: conds,
});
const tiers = (a, b, c, d) => [
  rate('Standard', a, [kg('GREATER_THAN_OR_EQUAL_TO', 0), kg('LESS_THAN_OR_EQUAL_TO', 5)]),
  rate('Standard', b, [kg('GREATER_THAN_OR_EQUAL_TO', 5), kg('LESS_THAN_OR_EQUAL_TO', 11)]),
  rate('Standard', c, [kg('GREATER_THAN_OR_EQUAL_TO', 11), kg('LESS_THAN_OR_EQUAL_TO', 23)]),
  rate('Standard', d, [kg('GREATER_THAN_OR_EQUAL_TO', 23)]),
];
const zone = (id, name, provinces, rates) => ({
  zone: { id: `gid://shopify/DeliveryZone/${id}`, name, countries: [{ code: { countryCode: 'CA', restOfWorld: false }, provinces: provinces.map((code) => ({ code })) }] },
  methodDefinitions: { pageInfo: { hasNextPage: false }, nodes: rates },
});
const profile = (id, name, zones) => ({
  id: `gid://shopify/DeliveryProfile/${id}`, name, default: false, productVariantsCount: { count: 500, precision: 'EXACT' },
  profileLocationGroups: [{
    locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/1', locations: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/Location/1', name: 'Sechelt Warehouse' }, { id: 'gid://shopify/Location/2', name: 'Calgary Warehouse' }] } },
    locationGroupZones: { pageInfo: { hasNextPage: false }, nodes: zones },
  }],
});
function liveLike({ ezName = 'Prosol EZ', carrier = false } = {}) {
  return [
    plan.normalizeProfile(profile(102840008871, 'Prosol', [
      zone(1, 'Canada Far', ['NB', 'NL', 'PE'], tiers(12.99, 17.99, 44.99, 84.99)),
      zone(2, ezName, ['AB', 'BC', 'MB', 'NS', 'ON', 'QC', 'SK'], carrier ? [rate('Calculated', 0, [], 'DeliveryParticipant')] : tiers(12.99, 17.99, 29.99, 54.99)),
    ])),
    plan.normalizeProfile(profile(77966803111, 'General profile', [zone(3, 'Canada Main', ['AB', 'MB', 'SK', 'BC', 'ON', 'QC'], tiers(12.99, 17.99, 29.99, 54.99))])),
  ];
}
const { branches } = plan.loadBranches(branchesDoc);
const run = (mode, profiles = liveLike()) => plan.buildPlan({ profiles, branches, enabled: plan.enabledCodes(branches, mode) });
const errors = (p) => p.checks.filter((c) => c.level === 'error');
const zonesOf = (p) => p.prosol.after.groups[0].zones;

test('pickup-branches.json: 43 branches, all disabled, Calgary South (WCAS) the only pilot, titles customer-safe', () => {
  const { errors: errs } = plan.loadBranches(branchesDoc);
  assert.deepEqual(errs, []);
  assert.equal(branches.length, 43);
  assert.equal(branches.filter((b) => b.enabled).length, 0);
  assert.deepEqual(branches.filter((b) => b.pilot).map((b) => [b.code, b.map_code, b.display_code, b.pickup_label]), [['WCAS', 'WCAS', 'CALS', 'Calgary South']]);
  for (const b of branches.filter((x) => x.map_code)) assert.equal(b.code, b.map_code, `${b.code}: code is the location-map code`);
  for (const b of branches) {
    assert.match(b.rate_title, /^Pickup: .+ trade counter \(ready in 2-4 business days\)$/);
    assert.doesNotMatch(`${b.rate_title} ${b.pickup_label}`, /prosol/i);
    assert.doesNotMatch(JSON.stringify(b), /[\u2013\u2014]/);
    assert.ok(b.address_full && b.hours && b.hours.mon_fri, `${b.code} has address and hours`);
  }
  assert.deepEqual(branches.filter((b) => !b.in_location_map).map((b) => b.code).sort(), ['GRPR', 'KELN', 'LETH']);
  const f2 = branches.filter((b) => b.map_corrections.some((c) => c.ref === 'F2')).map((b) => b.code).sort();
  assert.deepEqual(f2, ['KELO', 'KITC', 'MISS', 'SCAR', 'STCA', 'SUDB']);
});

test('titleProblems: prefix, distributor name and dashes', () => {
  assert.deepEqual(plan.titleProblems('Pickup: Calgary South trade counter (ready in 2-4 business days)'), []);
  assert.ok(plan.titleProblems('Pickup: Prosol Calgary').some((p) => /distributor/.test(p)));
  assert.ok(plan.titleProblems('Calgary pickup').some((p) => /start with/.test(p)));
  assert.ok(plan.titleProblems('Pickup: Calgary \u2014 South').some((p) => /dash/.test(p)));
});

test('loadBranches rejects a title naming the distributor and duplicate codes', () => {
  const bad = { branches: [branches[0], { ...branches[1], rate_title: 'Pickup: Prosol Burnaby' }, { ...branches[2], code: branches[0].code }] };
  const { errors: errs } = plan.loadBranches(bad);
  assert.ok(errs.some((e) => /names the distributor/.test(e)));
  assert.ok(errs.some((e) => /duplicate branch code/.test(e)));
});

test('as configured: Prosol EZ splits per province, NB leaves Canada Far, no pickup rates, pickup profile held', () => {
  const p = run('configured');
  assert.deepEqual(errors(p), []);
  const zones = zonesOf(p);
  assert.deepEqual(zones.map((z) => z.provinces.join('/')), ['PE/NL', 'NB', 'BC', 'AB', 'SK', 'MB', 'ON', 'QC', 'NS']);
  const bc = zones.find((z) => z.name === 'British Columbia');
  assert.equal(bc.id, 'gid://shopify/DeliveryZone/2', 'BC keeps the Prosol EZ zone id');
  assert.ok(bc.rates.every((r) => r.id), 'BC keeps its rate ids');
  const ab = zones.find((z) => z.name === 'Alberta');
  assert.equal(ab.id, null);
  assert.deepEqual(ab.rates.map((r) => r.price), [12.99, 17.99, 29.99, 54.99]);
  const nb = zones.find((z) => z.name === 'New Brunswick');
  assert.deepEqual(nb.rates.map((r) => r.price), [12.99, 17.99, 44.99, 84.99], 'NB keeps the Canada Far tiers');
  assert.equal(zones.find((z) => z.name === 'Canada Far').id, 'gid://shopify/DeliveryZone/1');
  assert.equal(p.stats.pickupRatesInProsolProfile, 0);
  assert.equal(p.pickupProfile.status, 'HOLD_NO_ENABLED_BRANCHES');
  assert.equal(p.pickupProfile.after, null);
  assert.deepEqual(p.prosol.changes.map((c) => c.op).sort(), [...Array(7).fill('CREATE_ZONE'), 'UPDATE_ZONE', 'UPDATE_ZONE'].sort());
});

test('pilot preview: one $0 Calgary South rate in Alberta, pickup-only profile with the same name', () => {
  const p = run('pilot');
  assert.deepEqual(errors(p), []);
  const ab = zonesOf(p).find((z) => z.name === 'Alberta');
  const pick = ab.rates.filter((r) => r.kind === 'pickup');
  assert.equal(pick.length, 1);
  assert.equal(pick[0].name, 'Pickup: Calgary South trade counter (ready in 2-4 business days)');
  assert.equal(pick[0].price, 0);
  assert.deepEqual(pick[0].conditions, []);
  assert.equal(ab.rates.filter((r) => r.kind === 'standard').length, 4);
  for (const z of zonesOf(p).filter((x) => x.name !== 'Alberta')) assert.equal(z.rates.filter((r) => r.kind === 'pickup').length, 0);
  assert.equal(p.pickupProfile.status, 'CREATE');
  const pz = p.pickupProfile.after.groups[0].zones;
  assert.deepEqual(pz.map((z) => z.provinces.join('/')), ['AB']);
  assert.deepEqual(pz[0].rates.map((r) => r.name), [pick[0].name]);
  assert.equal(pz[0].rates.filter((r) => r.kind !== 'pickup').length, 0, 'pickup-only zones carry no Standard rate');
  assert.deepEqual(p.pickupProfile.after.groups[0].locations.map((l) => l.name), ['Sechelt Warehouse', 'Calgary Warehouse']);
});

test('all enabled: Ontario lists 14 rates, no pickup-only zone for PE/NL, warnings for unmapped branches', () => {
  const p = run('all');
  assert.deepEqual(errors(p), []);
  assert.equal(zonesOf(p).find((z) => z.name === 'Ontario').rates.filter((r) => r.kind === 'pickup').length, 14);
  const pz = p.pickupProfile.after.groups[0].zones.map((z) => z.provinces[0]);
  assert.deepEqual(pz, ['BC', 'AB', 'SK', 'MB', 'ON', 'QC', 'NB', 'NS']);
  assert.ok(p.checks.some((c) => c.id === 'not-in-map' && /KELN/.test(c.msg)));
  assert.ok(p.checks.some((c) => c.id === 'map-corrections' && /KITC/.test(c.msg)));
  assert.equal(p.stats.pickupRatesInProsolProfile, 43);
});

test('drift and unsupported rates are errors', () => {
  assert.ok(errors(run('configured', liveLike({ ezName: 'Renamed zone' }))).some((c) => c.id === 'split-zone'));
  assert.ok(errors(run('configured', liveLike({ carrier: true }))).some((c) => c.id === 'carrier-rate'));
  const none = plan.buildPlan({ profiles: liveLike().slice(1), branches, enabled: new Set() });
  assert.equal(none.prosol, null);
  assert.ok(errors(none).some((c) => c.id === 'prosol-profile'));
});

test('enabledCodes: unknown code throws, configured ignores pilot, display codes resolve', () => {
  assert.throws(() => plan.enabledCodes(branches, ['NOPE']), /unknown branch code/);
  assert.equal(plan.enabledCodes(branches, 'configured').size, 0);
  assert.deepEqual([...plan.enabledCodes(branches, ['EDMN'])], ['EDMN']);
  assert.deepEqual([...plan.enabledCodes(branches, ['CALS'])], ['WCAS'], 'the public code CALS is Calgary South, WCAS');
  assert.deepEqual([...plan.enabledCodes(branches, ['wcas', 'CALS'])], ['WCAS']);
  assert.deepEqual([...plan.enabledCodes(branches, 'pilot')], ['WCAS']);
});

test('loadBranches: code must be the location-map code, and no code may name two branches', () => {
  const cal = branches.find((b) => b.map_code === 'WCAS');
  const renamed = plan.loadBranches({ branches: [{ ...cal, code: 'CALS', display_code: undefined }] });
  assert.ok(renamed.errors.some((e) => /code must equal map_code/.test(e)));
  const clash = plan.loadBranches({ branches: [cal, { ...branches.find((b) => b.code === 'EDMN'), display_code: 'CALS' }] });
  assert.ok(clash.errors.some((e) => /CALS is also used by WCAS/.test(e)));
});

test('script: read-only guard refuses the word mutation anywhere, and --apply before any network call', async () => {
  // Point any accidental request at a dead host: dotenv (loaded by the script) never overrides a set variable.
  process.env.SHOPIFY_STORE = 'invalid.invalid';
  process.env.SHOPIFY_ACCESS_TOKEN = 'x';
  const { gql, assertReadOnly } = require('../scripts/trade/pickup-rates');
  await assert.rejects(gql('mutation { deliveryProfileRemove(id: "x") { userErrors { message } } }'), /read-only/);
  await assert.rejects(gql('# comment\n  mutation X { a }'), /read-only/);
  for (const doc of [
    'query A { shop { id } } mutation B { shop { id } }', // second operation on the same line
    'query A { shop { id } }\n  mutation B { shop { id } }', // indented second operation
    '{ shop { id } } mutation{ shop { id } }',
    'query A { shop { id } } Mutation B { shop { id } }',
    'query A { shop { id } } # mutation later',
    'subscription S { shop { id } }',
    '',
    null,
  ]) assert.throws(() => assertReadOnly(doc), /read-only/, JSON.stringify(doc));
  for (const doc of ['query { deliveryProfiles(first: 5) { nodes { id } } }', '{ shop { id } }', '# note\nquery($id: ID!) { deliveryProfile(id: $id) { id methodDefinitions: id } }']) {
    assert.doesNotThrow(() => assertReadOnly(doc), doc);
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'trade', 'pickup-rates.js'), '--apply'], { encoding: 'utf8', env: { ...process.env, SHOPIFY_ACCESS_TOKEN: 'x', SHOPIFY_STORE: 'invalid.invalid' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED/);
});
