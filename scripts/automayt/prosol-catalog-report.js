#!/usr/bin/env node
/**
 * Counts for the Prosol catalogue import, from a snapshot (no network):
 * the location rule, the Salesforce dedupe, categories, costs.
 *
 *   node scripts/automayt/prosol-catalog-report.js [--date=YYYY-MM-DD] [--min-locations=2]
 *
 * Writes data/prosol-catalog/<date>/report.json plus CSVs:
 *   to-import.csv          passing, not discontinued, not in Salesforce
 *   in-salesforce.csv      passing and already a Salesforce item (migrates; the import skips it)
 *   conflicts.csv          ambiguous matches and Salesforce items claimed by two Prosol products
 *   sf-prosol-unmatched.csv  Salesforce items with vendor Prosol that no Prosol product code matches
 */

const fs = require('fs');
const path = require('path');
const pc = require('../../lib/prosol-catalog');

const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV'; // Salesforce Account "Prosol Inc." (lib/shopify-sf.js)
const ROOT = path.join(__dirname, '..', '..', 'data', 'prosol-catalog');

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(file, header, rows) {
  fs.writeFileSync(file, [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n');
}

function countBy(rows, f, top = 20) {
  const m = new Map();
  for (const r of rows) { const k = f(r) || '(none)'; m.set(k, (m.get(k) || 0) + 1); }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top));
}

function main() {
  const args = parseArgs();
  const date = args.date || fs.readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
  const dir = path.join(ROOT, date);
  const minLocations = Number(args['min-locations'] || 2);
  const { records } = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  const sfItems = fs.existsSync(path.join(dir, 'sf-items.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'sf-items.json'), 'utf8')) : [];
  const costs = new Map(pc.readJsonl(path.join(dir, 'costs.jsonl')).map((l) => [l.id, l]));

  const passing = records.filter((r) => r.locations >= minLocations);
  const importable = passing.filter((r) => !r.discontinued);
  const { results, sharedSfItems } = pc.dedupeAgainstSf(records, sfItems, { prosolVendorId: PROSOL_VENDOR_ID });
  const statusOf = (r) => results.get(r.id).status;

  const collisions = pc.codeCollisions(importable);
  const colliding = new Set([...collisions.values()].flat());
  const inSf = importable.filter((r) => statusOf(r) === 'matched');
  const ambiguous = importable.filter((r) => statusOf(r) === 'ambiguous');
  const taken = importable.filter((r) => statusOf(r) === 'taken');
  const toImport = importable.filter((r) => statusOf(r) === 'new' && !colliding.has(r.id));
  const newButSharedCode = importable.filter((r) => statusOf(r) === 'new' && colliding.has(r.id));

  // Salesforce Prosol items that no Prosol product claims (dead codes, typos, or products Prosol no longer lists)
  const claimedSf = new Set();
  for (const r of records) for (const h of results.get(r.id).sf) claimedSf.add(h.id);
  const sfProsol = sfItems.filter((i) => i.vendorId === PROSOL_VENDOR_ID);
  const sfProsolUnmatched = sfProsol.filter((i) => !claimedSf.has(i.id));
  // Salesforce Prosol items whose Prosol product fails the rule (they migrate anyway; a later sync can flag them)
  const belowRuleSf = new Set();
  for (const r of records) if (r.locations < minLocations) for (const h of results.get(r.id).sf) belowRuleSf.add(h.id);
  const sfProsolBelowRule = sfProsol.filter((i) => belowRuleSf.has(i.id)).length;

  const priced = importable.filter((r) => costs.has(r.id));
  const pricedOk = priced.filter((r) => costs.get(r.id).cost != null);

  const report = {
    date,
    minLocations,
    prosol: pc.summarize(records, { minLocations }),
    rule: {
      [`${minLocations}+ locations`]: passing.length,
      'of which discontinued at Prosol (left out)': passing.length - importable.length,
      importable: importable.length,
    },
    salesforce: {
      sfItemsTotal: sfItems.length,
      sfItemsVendorProsol: sfProsol.length,
      importableAlreadyInSalesforce: inSf.length,
      importableAlreadyInSalesforceUnderOtherVendor: inSf.filter((r) => results.get(r.id).otherVendor).length,
      importableAmbiguousInSalesforce: ambiguous.length,
      importableCodeTakenByOtherVendorItem: taken.length,
      importableNewToImport: toImport.length,
      importableNewButShareAProsolCode: newButSharedCode.length,
      sharedProsolCodeGroups: collisions.size,
      sfItemsClaimedByTwoProsolProducts: sharedSfItems.length,
      sfProsolItemsNoProsolCodeMatch: sfProsolUnmatched.length,
      sfProsolItemsWhoseProductFailsRule: sfProsolBelowRule,
      matchVia: countBy(inSf, (r) => (results.get(r.id).via || '').split(':')[0]),
    },
    costs: { importablePriced: priced.length, importablePricedOk: pricedOk.length, importableNotYetPriced: importable.length - priced.length },
    toImportByCategory: countBy(toImport, (r) => pc.automaytCategory(r)),
    toImportByManufacturer: countBy(toImport, (r) => r.manufacturer, 25),
    toImportByUnit: countBy(toImport, (r) => r.pricing_measure_unit || 'each'),
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));

  const row = (r) => {
    const d = results.get(r.id);
    const c = costs.get(r.id);
    return {
      prosol_id: r.id, prosol_sku: r.prosol_sku, maker_sku: r.sku, name: r.name, manufacturer: r.manufacturer,
      automayt_category: pc.automaytCategory(r), locations: r.locations, units: r.units, stock_as_of: r.stock_as_of,
      msrp: r.msrp_price != null ? (r.msrp_price / 100).toFixed(2) : '', cost: c && c.cost != null ? c.cost : '',
      measure: r.pricing_measure_unit ? `${r.pricing_measure} ${r.pricing_measure_unit}` : '',
      sf_status: d.status, sf_via: d.via || '', sf_items: d.sf.map((h) => `${h.name} (${h.vendorItemId || '-'}, ${h.vendorName || '-'})`).join('; '),
    };
  };
  const header = ['prosol_id', 'prosol_sku', 'maker_sku', 'name', 'manufacturer', 'automayt_category', 'locations', 'units', 'stock_as_of', 'msrp', 'cost', 'measure', 'sf_status', 'sf_via', 'sf_items'];
  writeCsv(path.join(dir, 'to-import.csv'), header, toImport.map(row));
  writeCsv(path.join(dir, 'in-salesforce.csv'), header, inSf.map(row));
  const byId = new Map(records.map((r) => [r.id, r]));
  const sfById = new Map(sfItems.map((i) => [i.id, i]));
  writeCsv(path.join(dir, 'conflicts.csv'), ['kind', ...header], [
    ...ambiguous.map((r) => ({ kind: 'prosol product matches 2+ Salesforce items', ...row(r) })),
    ...taken.map((r) => ({ kind: 'short Prosol code already used by another vendor\'s Salesforce item', ...row(r) })),
    ...importable.filter((r) => colliding.has(r.id)).map((r) => ({ kind: `Prosol code ${r.prosol_sku} shared by ${collisions.get(pc.normCode(r.prosol_sku || r.sku)).length} passing products`, ...row(r) })),
    ...sharedSfItems.map((s) => {
      const it = sfById.get(s.sfId) || {};
      return { kind: `Salesforce ${it.name} (${it.vendorItemId || '-'}) claimed by ${s.prosolIds.length} Prosol products`, prosol_id: s.prosolIds.join(' '), prosol_sku: s.prosolIds.map((id) => (byId.get(id) || {}).prosol_sku).join(' '), sf_items: it.name };
    }),
  ]);
  writeCsv(path.join(dir, 'sf-prosol-unmatched.csv'), ['id', 'name', 'vendorItemId', 'uom', 'description'], sfProsolUnmatched);
  console.log(JSON.stringify(report, null, 1));
}

main();
