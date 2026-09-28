/**
 * Branch-pickup shipping rates: the pure planner behind scripts/trade/pickup-rates.js (02 build plan 3B, task K5).
 *
 * No I/O and no Shopify calls here. The script reads the live delivery profiles (read-only) and hands the normalized
 * profiles plus data/trade/pickup-branches.json to buildPlan(), which returns the before-state, the planned
 * after-state, the list of changes and the checks. Nothing in this file can write to Shopify.
 *
 * The design (research/2026-09-28-prozone-build/shopify-pickup.md, recommendation 1):
 *   - Every province that has a branch gets its own zone in the "Prosol" profile, carrying the same weight-tiered
 *     Standard rates as the zone it came from. "Prosol EZ" (AB/BC/MB/NS/ON/QC/SK) splits into seven zones; NB leaves
 *     "Canada Far" (NB/NL/PE) with Canada Far's own tiers, because Moncton is a branch. The original zone id is kept
 *     for the first province (BC for Prosol EZ) so its existing rates keep their ids.
 *   - One $0 rate per ENABLED branch, titled "Pickup: <City> trade counter (ready in 2-4 business days)", in that
 *     province's zone. Albertans only ever see Alberta branches.
 *   - A new "Schluter profiles (pickup only)" profile whose zones carry only those same pickup rates, so a cart mixing
 *     trims and Prosol items keeps the shared pickup names (checkout drops rate names that aren't common to every
 *     profile in the cart, finding R1). Provinces with no enabled branch get no zone there, so trims can't ship (R2).
 */

const PROVINCE_NAMES = {
  BC: 'British Columbia', AB: 'Alberta', SK: 'Saskatchewan', MB: 'Manitoba', ON: 'Ontario', QC: 'Quebec',
  NB: 'New Brunswick', NS: 'Nova Scotia', PE: 'Prince Edward Island', NL: 'Newfoundland and Labrador',
  YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut',
};
const PROVINCE_ORDER = Object.keys(PROVINCE_NAMES);

const DEFAULTS = {
  prosolProfileName: 'Prosol',
  splitZoneName: 'Prosol EZ',
  pickupProfileName: 'Schluter profiles (pickup only)',
  titlePrefix: 'Pickup:',
  currency: 'CAD',
};

const byProvinceOrder = (a, b) => PROVINCE_ORDER.indexOf(a) - PROVINCE_ORDER.indexOf(b);

/** Customer-facing text rules: the A1 marker prefix, never the distributor's name, no em or en dashes. */
function titleProblems(title, prefix = DEFAULTS.titlePrefix) {
  const out = [];
  if (typeof title !== 'string' || !title.trim()) return ['empty title'];
  if (!title.startsWith(prefix)) out.push(`does not start with "${prefix}"`);
  if (/prosol/i.test(title)) out.push('names the distributor');
  if (/[\u2013\u2014]/.test(title)) out.push('contains an en or em dash');
  return out;
}

/** Validate data/trade/pickup-branches.json. Returns { branches, errors }. */
function loadBranches(doc) {
  const errors = [];
  const branches = Array.isArray(doc && doc.branches) ? doc.branches : [];
  if (!branches.length) errors.push('pickup-branches.json has no branches');
  const codes = new Set();
  const aliases = new Map();
  const titles = new Set();
  for (const b of branches) {
    const id = b && b.code ? b.code : JSON.stringify(b).slice(0, 40);
    if (!b.code) errors.push(`branch without code: ${id}`);
    if (codes.has(b.code)) errors.push(`duplicate branch code ${b.code}`);
    codes.add(b.code);
    if (b.map_code && b.code && b.map_code !== b.code) errors.push(`${id}: code must equal map_code (${b.map_code}) when the branch is in the location map; keep another code as display_code`);
    for (const a of branchCodes(b)) {
      if (aliases.has(a) && aliases.get(a) !== b.code) errors.push(`${id}: code ${a} is also used by ${aliases.get(a)}`);
      aliases.set(a, b.code);
    }
    if (!PROVINCE_NAMES[b.province]) errors.push(`${id}: unknown province ${b.province}`);
    if (typeof b.enabled !== 'boolean') errors.push(`${id}: enabled must be true or false`);
    for (const p of titleProblems(b.rate_title)) errors.push(`${id}: rate_title ${p}`);
    if (titles.has(b.rate_title)) errors.push(`${id}: duplicate rate_title "${b.rate_title}"`);
    titles.add(b.rate_title);
    if (b.description != null) for (const p of titleProblems(`${DEFAULTS.titlePrefix} ${b.description}`)) errors.push(`${id}: description ${p}`);
  }
  return { branches, errors };
}

/** Every code a branch answers to: code (= the location-map code when it has one), map_code, display_code. */
function branchCodes(b) {
  return [...new Set([b && b.code, b && b.map_code, b && b.display_code].filter(Boolean).map((c) => String(c).trim().toUpperCase()))];
}

/**
 * Which branches count as enabled. mode 'configured' = the enabled flags only. For previews: 'pilot' adds pilot
 * branches, 'all' enables every branch, an array of codes adds those codes (display codes such as CALS resolve to
 * the branch's code, WCAS).
 */
function enabledCodes(branches, mode = 'configured') {
  const set = new Set(branches.filter((b) => b.enabled === true).map((b) => b.code));
  if (mode === 'pilot') branches.filter((b) => b.pilot === true).forEach((b) => set.add(b.code));
  else if (mode === 'all') branches.forEach((b) => set.add(b.code));
  else if (Array.isArray(mode)) {
    const known = new Map();
    for (const b of branches) for (const a of branchCodes(b)) known.set(a, b.code);
    for (const c of mode) {
      const code = known.get(String(c).trim().toUpperCase());
      if (!code) throw new Error(`unknown branch code ${c}`);
      set.add(code);
    }
  }
  return set;
}

/** Normalize one deliveryProfile node from the Admin GraphQL read in scripts/trade/pickup-rates.js. */
function normalizeProfile(p) {
  const truncated = [];
  const groups = (p.profileLocationGroups || []).map((g) => {
    const lg = g.locationGroup || {};
    if (lg.locations && lg.locations.pageInfo && lg.locations.pageInfo.hasNextPage) truncated.push(`${p.name}: locations`);
    if (g.locationGroupZones.pageInfo && g.locationGroupZones.pageInfo.hasNextPage) truncated.push(`${p.name}: zones`);
    return {
      id: lg.id,
      locations: ((lg.locations && lg.locations.nodes) || []).map((l) => ({ id: l.id, name: l.name })),
      zones: g.locationGroupZones.nodes.map((zn) => {
        const z = zn.zone;
        const md = zn.methodDefinitions;
        if (md.pageInfo && md.pageInfo.hasNextPage) truncated.push(`${p.name} / ${z.name}: rates`);
        const countries = z.countries || [];
        const ca = countries.find((c) => c.code && c.code.countryCode === 'CA');
        return {
          id: z.id,
          name: z.name,
          restOfWorld: countries.some((c) => c.code && c.code.restOfWorld),
          countries: countries.map((c) => (c.code && c.code.restOfWorld ? 'REST_OF_WORLD' : c.code && c.code.countryCode)),
          provinces: ca ? ca.provinces.map((x) => x.code).sort(byProvinceOrder) : [],
          rates: md.nodes.map((m) => {
            const rp = m.rateProvider || {};
            const flat = rp.__typename === 'DeliveryRateDefinition';
            return {
              id: m.id,
              name: m.name,
              active: m.active,
              description: m.description || null,
              type: flat ? 'flat' : (rp.__typename || 'unknown'),
              price: flat ? Number(rp.price.amount) : null,
              currency: flat ? rp.price.currencyCode : null,
              conditions: (m.methodConditions || []).map((c) => {
                const cc = c.conditionCriteria || {};
                return cc.__typename === 'Weight'
                  ? { field: c.field, operator: c.operator, value: Number(cc.value), unit: cc.unit }
                  : { field: c.field, operator: c.operator, value: Number(cc.amount), unit: cc.currencyCode };
              }),
            };
          }),
        };
      }),
    };
  });
  return {
    id: p.id,
    name: p.name,
    default: !!p.default,
    variants: p.productVariantsCount ? { count: p.productVariantsCount.count, precision: p.productVariantsCount.precision } : null,
    groups,
    truncated,
  };
}

/** The part of a rate that must survive a copy unchanged. */
const rateSignature = (r) => JSON.stringify([r.name, r.active, r.type, r.price, r.currency,
  [...r.conditions].map((c) => [c.field, c.operator, c.value, c.unit]).sort()]);

const copyRate = (r, keepId) => ({
  ...(keepId ? { id: r.id } : {}),
  name: r.name, active: r.active, description: r.description, type: r.type, price: r.price, currency: r.currency,
  conditions: r.conditions.map((c) => ({ ...c })), kind: 'standard',
});

function pickupDescription(b) {
  const sat = b.hours && b.hours.sat && !/closed/i.test(b.hours.sat) ? `, Sat ${b.hours.sat}` : '';
  return b.description || `${b.address_full}. Mon-Fri ${b.hours.mon_fri}${sat}.`;
}

function pickupRate(b, currency) {
  return {
    name: b.rate_title, active: true, description: pickupDescription(b), type: 'flat', price: 0,
    currency: currency || DEFAULTS.currency, conditions: [], kind: 'pickup', branch: b.code,
  };
}

const provincesOf = (zones) => zones.flatMap((z) => z.provinces);

function zoneLine(z) {
  const prov = z.restOfWorld ? 'rest of world' : (z.provinces.join('/') || z.countries.join('/'));
  const rates = z.rates.map((r) => {
    const cond = r.conditions.map((c) => `${c.operator === 'GREATER_THAN_OR_EQUAL_TO' ? '>=' : c.operator === 'LESS_THAN_OR_EQUAL_TO' ? '<=' : c.operator} ${c.value}${c.unit === 'KILOGRAMS' ? 'kg' : ` ${c.unit}`}`).join(' ');
    return `${r.name}${r.active ? '' : ' (off)'} $${r.price == null ? '?' : r.price.toFixed(2)}${cond ? ` [${cond}]` : ''}`;
  });
  return { zone: z.name, provinces: prov, rates };
}

/**
 * Build the plan. profiles = normalized profiles (all of them, for the name checks). Returns a plain object:
 * { prosol: { before, after, changes }, pickupProfile: { status, before, after, changes }, checks, stats }.
 */
function buildPlan({ profiles, branches, enabled, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const checks = [];
  const add = (level, id, msg) => checks.push({ level, id, msg });

  for (const p of profiles) for (const t of p.truncated) add('error', 'truncated-read', `read was truncated (${t}); raise the page size before trusting this plan`);

  const matches = profiles.filter((p) => p.name === o.prosolProfileName);
  if (matches.length !== 1) {
    add('error', 'prosol-profile', `expected exactly one profile named "${o.prosolProfileName}", found ${matches.length}`);
    return { prosol: null, pickupProfile: null, checks, stats: {} };
  }
  const prosol = matches[0];
  const byCode = new Map(branches.map((b) => [b.code, b]));
  const enabledBranches = [...enabled].map((c) => byCode.get(c)).filter(Boolean);
  const branchProvinces = new Set(branches.map((b) => b.province));
  const pickupsFor = (prov, currency) => enabledBranches
    .filter((b) => b.province === prov)
    .sort((a, b) => a.pickup_label.localeCompare(b.pickup_label))
    .map((b) => pickupRate(b, currency));

  if (prosol.groups.length !== 1) add('warn', 'location-groups', `"${prosol.name}" has ${prosol.groups.length} location groups; the plan splits zones in each and the pickup-only profile uses the union of their locations`);

  const changes = [];
  let foundSplitZone = false;
  const afterGroups = prosol.groups.map((g) => {
    const zones = [];
    for (const z of g.zones) {
      const currency = (z.rates.find((r) => r.currency) || {}).currency || o.currency;
      if (z.name === o.splitZoneName) foundSplitZone = true;
      for (const r of z.rates) if (r.type !== 'flat') add('error', 'carrier-rate', `${z.name}: rate "${r.name}" is ${r.type}; this planner only copies flat rates`);
      const bp = z.provinces.filter((p) => branchProvinces.has(p));
      const other = z.provinces.filter((p) => !branchProvinces.has(p));
      const single = bp.length === 1 && other.length === 0;
      if (z.restOfWorld || !bp.length || single) {
        const pick = single ? pickupsFor(bp[0], currency) : [];
        zones.push({ ...z, rates: [...z.rates.map((r) => copyRate(r, true)), ...pick], change: pick.length ? 'kept, pickup rates added' : 'unchanged', sourceZoneId: z.id, sourceZone: z.name });
        for (const r of pick) changes.push({ op: 'CREATE_RATE', zone: z.name, rate: r.name, price: 0, branch: r.branch });
        continue;
      }
      // Split: provinces without a branch stay in the original zone; each branch province gets its own zone.
      let keepId = z.id;
      if (other.length) {
        zones.push({ ...z, provinces: other, rates: z.rates.map((r) => copyRate(r, true)), change: `kept for ${other.join('/')}; ${bp.join('/')} moved to ${bp.length === 1 ? 'its own zone' : 'their own zones'}`, sourceZoneId: z.id, sourceZone: z.name });
        changes.push({ op: 'UPDATE_ZONE', zoneId: z.id, from: { name: z.name, provinces: z.provinces }, to: { name: z.name, provinces: other } });
        keepId = null;
      }
      for (const prov of [...bp].sort(byProvinceOrder)) {
        const pick = pickupsFor(prov, currency);
        const name = PROVINCE_NAMES[prov];
        if (keepId) {
          zones.push({ id: keepId, name, restOfWorld: false, countries: ['CA'], provinces: [prov], rates: [...z.rates.map((r) => copyRate(r, true)), ...pick], change: `was "${z.name}" (same zone id, same rate ids), narrowed to ${prov}`, sourceZoneId: z.id, sourceZone: z.name });
          changes.push({ op: 'UPDATE_ZONE', zoneId: keepId, from: { name: z.name, provinces: z.provinces }, to: { name, provinces: [prov] } });
          keepId = null;
        } else {
          zones.push({ id: null, name, restOfWorld: false, countries: ['CA'], provinces: [prov], rates: [...z.rates.map((r) => copyRate(r, false)), ...pick], change: `new, ${z.rates.length} rates copied from "${z.name}"`, sourceZoneId: z.id, sourceZone: z.name });
          changes.push({ op: 'CREATE_ZONE', name, provinces: [prov], copyRatesFrom: z.name, rates: z.rates.length });
        }
        for (const r of pick) changes.push({ op: 'CREATE_RATE', zone: name, rate: r.name, price: 0, branch: r.branch });
      }
    }
    return { id: g.id, locations: g.locations, zones };
  });
  if (!foundSplitZone) add('error', 'split-zone', `zone "${o.splitZoneName}" not found in "${prosol.name}"; the live profile has drifted from the research, re-check before planning`);

  // Integrity: every province keeps exactly one zone per group, and every copied rate matches its source.
  prosol.groups.forEach((g, i) => {
    const before = provincesOf(g.zones).sort(byProvinceOrder);
    const after = provincesOf(afterGroups[i].zones).sort(byProvinceOrder);
    if (JSON.stringify(before) !== JSON.stringify(after)) add('error', 'coverage', `province coverage changed: before ${before.join('/')}, after ${after.join('/')}`);
    const dupes = after.filter((p, j) => after.indexOf(p) !== j);
    if (dupes.length) add('error', 'coverage', `provinces in two zones after the split: ${dupes.join('/')}`);
    for (const z of afterGroups[i].zones) {
      const src = g.zones.find((s) => s.id === z.sourceZoneId);
      const a = z.rates.filter((r) => r.kind === 'standard').map(rateSignature).sort();
      const b = src.rates.map(rateSignature).sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) add('error', 'rate-copy', `${z.name}: copied rates differ from "${src.name}"`);
    }
    const names = afterGroups[i].zones.map((z) => z.name);
    if (new Set(names).size !== names.length) add('error', 'zone-names', `duplicate zone names after the split: ${names.join(', ')}`);
  });

  // Rate names: the planned pickup titles must not collide with anything already live.
  const planned = new Set(branches.map((b) => b.rate_title));
  for (const p of profiles) {
    for (const g of p.groups) {
      for (const z of g.zones) {
        for (const r of z.rates) {
          if (r.name.startsWith(o.titlePrefix)) add(planned.has(r.name) && p.name === o.prosolProfileName ? 'info' : 'warn', 'existing-pickup-rate', `"${p.name}" / ${z.name} already has a rate "${r.name}"`);
        }
      }
    }
  }

  // The pickup-only profile.
  const existing = profiles.find((p) => p.name === o.pickupProfileName) || null;
  const locations = [...new Map(prosol.groups.flatMap((g) => g.locations).map((l) => [l.id, l])).values()];
  const pickupZones = [...new Set(enabledBranches.map((b) => b.province))].sort(byProvinceOrder).map((prov) => ({
    id: null, name: PROVINCE_NAMES[prov], restOfWorld: false, countries: ['CA'], provinces: [prov], rates: pickupsFor(prov, o.currency),
  }));
  let status;
  if (existing) {
    status = 'EXISTS';
    add('warn', 'pickup-profile-exists', `a profile named "${o.pickupProfileName}" already exists (${existing.id}); this planner only plans its creation, diff it by hand`);
  } else if (!pickupZones.length) {
    status = 'HOLD_NO_ENABLED_BRANCHES';
    add('info', 'pickup-profile-hold', `"${o.pickupProfileName}" is not created while no branch is enabled: with no zones, any variant in it could not be bought anywhere`);
  } else status = 'CREATE';
  const pickupChanges = status === 'CREATE' ? [
    { op: 'CREATE_PROFILE', name: o.pickupProfileName, locations: locations.map((l) => l.name), zones: pickupZones.map((z) => z.name), rates: pickupZones.reduce((n, z) => n + z.rates.length, 0), variantsToAssociate: 0 },
  ] : [];

  // Every planned pickup rate must also exist, same name, in the Prosol profile (mixed carts keep only shared names).
  const prosolPickup = new Set(afterGroups.flatMap((g) => g.zones.flatMap((z) => z.rates.filter((r) => r.kind === 'pickup').map((r) => `${z.provinces.join('/')}|${r.name}`))));
  for (const z of pickupZones) for (const r of z.rates) {
    if (!prosolPickup.has(`${z.provinces.join('/')}|${r.name}`)) add('error', 'shared-names', `pickup-only rate "${r.name}" (${z.name}) is missing from the "${prosol.name}" profile's ${z.name} zone`);
  }

  for (const b of enabledBranches) {
    for (const p of titleProblems(b.rate_title, o.titlePrefix)) add('error', 'title', `${b.code}: ${p}`);
    if (!b.in_location_map) add('warn', 'not-in-map', `${b.code} is enabled but not in prosol-location-map.json (build plan N5 first)`);
    if (b.map_corrections && b.map_corrections.length) add('warn', 'map-corrections', `${b.code} is enabled but the location map disagrees with the public list on ${b.map_corrections.map((c) => c.field).join(', ')} (N5 first)`);
  }

  const zonedProvinces = new Set(prosol.groups.flatMap((g) => provincesOf(g.zones)));
  const unzoned = PROVINCE_ORDER.filter((p) => !zonedProvinces.has(p));
  if (unzoned.length) add('info', 'no-zone', `"${prosol.name}" has no zone for ${unzoned.join('/')}: those addresses get no rates today (R3; adding them is K7, Mac's call, not in this plan)`);
  const noBranch = PROVINCE_ORDER.filter((p) => !branchProvinces.has(p));
  add('info', 'no-branch', `no branch in ${noBranch.join('/')}: pickup-only items can't be bought there (test T4)`);
  if (prosol.variants && prosol.variants.precision && prosol.variants.precision !== 'EXACT') add('info', 'variant-count', `"${prosol.name}" variant count ${prosol.variants.count} is ${prosol.variants.precision} (research counted 668 Schluter variants)`);

  const perProvince = {};
  for (const b of branches) perProvince[b.province] = (perProvince[b.province] || 0) + 1;
  const stats = {
    branches: branches.length,
    enabled: enabledBranches.map((b) => b.code),
    pickupRatesInProsolProfile: changes.filter((c) => c.op === 'CREATE_RATE').length,
    zonesUpdated: changes.filter((c) => c.op === 'UPDATE_ZONE').length,
    zonesCreated: changes.filter((c) => c.op === 'CREATE_ZONE').length,
    pickupRatesIfAllEnabled: perProvince,
  };

  return {
    prosol: {
      before: prosol,
      after: { id: prosol.id, name: prosol.name, groups: afterGroups },
      changes,
    },
    pickupProfile: {
      status,
      before: existing,
      after: status === 'HOLD_NO_ENABLED_BRANCHES' ? null : { id: existing ? existing.id : null, name: o.pickupProfileName, groups: [{ id: null, locations, zones: pickupZones }], variantsToAssociate: [] },
      changes: pickupChanges,
    },
    checks,
    stats,
  };
}

module.exports = {
  DEFAULTS, PROVINCE_NAMES, PROVINCE_ORDER,
  titleProblems, loadBranches, branchCodes, enabledCodes, normalizeProfile, buildPlan, zoneLine, rateSignature,
};
