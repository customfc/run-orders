#!/usr/bin/env node
/**
 * Counts for the Prosol catalogue import, from a snapshot (no network):
 * the location rule, conflicts, categories, costs, and the Salesforce
 * crosswalk.
 *
 *   node scripts/automayt/prosol-catalog-report.js [--date=YYYY-MM-DD] [--min-locations=2]
 *
 * ONE import (Mac, 2026-10-14): every product with stock at 2+ branches that
 * Prosol hasn't discontinued. Salesforce items are NOT subtracted: Automayt
 * imports only quantities on hand from Salesforce, and its QOH load matches
 * onto our items by vendor code. The Salesforce match is information for that
 * load, never a reason to skip a product.
 *
 * Writes data/prosol-catalog/<date>/report.json plus CSVs:
 *   to-import.csv          every product the import creates (Salesforce match as info columns)
 *   qoh-crosswalk.csv      Salesforce item → the vendor code we create, for Automayt's QOH load
 *   conflicts.csv          scope "import": blocks a product from the import (shared Prosol code);
 *                          scope "qoh": only matters for matching Salesforce QOH onto our items
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

  // Import-side conflict: two passing products with one Prosol code can't both have it as a vendor code.
  const collisions = pc.codeCollisions(importable);
  const colliding = new Set([...collisions.values()].flat());
  const toImport = importable.filter((r) => !colliding.has(r.id));

  // QOH-side (information for Automayt's load; none of these stop the import)
  const sfMatched = importable.filter((r) => statusOf(r) === 'matched');
  const sfAmbiguous = importable.filter((r) => statusOf(r) === 'ambiguous');
  const sfTaken = importable.filter((r) => statusOf(r) === 'taken');
  const importableIds = new Set(importable.map((r) => r.id));
  const sharedSfImportable = sharedSfItems.filter((x) => x.prosolIds.filter((id) => importableIds.has(id)).length > 1);

  // Salesforce Prosol items no Prosol product claims (dead or mistyped codes): their QOH has no item to land on.
  const claimedSf = new Set();
  for (const r of records) for (const h of results.get(r.id).sf) claimedSf.add(h.id);
  const sfProsol = sfItems.filter((i) => i.vendorId === PROSOL_VENDOR_ID);
  const sfProsolUnmatched = sfProsol.filter((i) => !claimedSf.has(i.id));
  // Salesforce Prosol items whose product fails the rule: not imported, so their QOH has no item either.
  const belowRuleSf = new Set();
  for (const r of records) if (r.locations < minLocations || r.discontinued) for (const h of results.get(r.id).sf) belowRuleSf.add(h.id);
  const sfProsolNotImported = sfProsol.filter((i) => belowRuleSf.has(i.id) && !importable.some((r) => results.get(r.id).sf.some((h) => h.id === i.id))).length;

  const priced = toImport.filter((r) => costs.has(r.id));
  const pricedOk = priced.filter((r) => costs.get(r.id).cost != null);

  const report = {
    date,
    minLocations,
    prosol: pc.summarize(records, { minLocations }),
    import: {
      [`${minLocations}+ branches`]: passing.length,
      'of which discontinued at Prosol (left out)': passing.length - importable.length,
      importable: importable.length,
      'share a Prosol code with another passing product (held for a person)': colliding.size,
      sharedProsolCodes: collisions.size,
      toImport: toImport.length,
    },
    salesforceInfo: {
      sfItemsTotal: sfItems.length,
      sfItemsVendorProsol: sfProsol.length,
      toImportWithOneSalesforceMatch: sfMatched.filter((r) => !colliding.has(r.id)).length,
      'of which the Salesforce item is under another vendor': sfMatched.filter((r) => !colliding.has(r.id) && results.get(r.id).otherVendor).length,
      toImportMatchingTwoOrMoreSalesforceItems: sfAmbiguous.filter((r) => !colliding.has(r.id)).length,
      toImportWhoseShortCodeIsOnAnotherVendorsSalesforceItem: sfTaken.filter((r) => !colliding.has(r.id)).length,
      salesforceItemsClaimedByTwoImportedProducts: sharedSfImportable.length,
      sfProsolItemsNoProsolCodeMatch: sfProsolUnmatched.length,
      sfProsolItemsWhoseProductIsNotImported: sfProsolNotImported,
    },
    costs: { toImportPriced: priced.length, toImportPricedOk: pricedOk.length, toImportNotYetPriced: toImport.length - priced.length },
    toImportByCategory: countBy(toImport, (r) => pc.automaytCategory(r)),
    toImportByManufacturer: countBy(toImport, (r) => r.manufacturer, 25),
    toImportByUnit: countBy(toImport, (r) => r.pricing_measure_unit || 'each'),
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));

  const row = (r) => {
    const d = results.get(r.id);
    const c = costs.get(r.id);
    return {
      prosol_id: r.id, prosol_sku: r.prosol_sku, maker_sku: r.sku, automayt_vendor_code: pc.stripSku(r.prosol_sku || r.sku),
      name: r.name, manufacturer: r.manufacturer,
      automayt_category: pc.automaytCategory(r), locations: r.locations, units: r.units, stock_as_of: r.stock_as_of,
      msrp: r.msrp_price != null ? (r.msrp_price / 100).toFixed(2) : '', cost: c && c.cost != null ? c.cost : '',
      measure: r.pricing_measure_unit ? `${r.pricing_measure} ${r.pricing_measure_unit}` : '',
      sf_status: d.status, sf_via: d.via || '', sf_items: d.sf.map((h) => `${h.name} (${h.vendorItemId || '-'}, ${h.vendorName || '-'})`).join('; '),
    };
  };
  const header = ['prosol_id', 'prosol_sku', 'maker_sku', 'automayt_vendor_code', 'name', 'manufacturer', 'automayt_category', 'locations', 'units', 'stock_as_of', 'msrp', 'cost', 'measure', 'sf_status', 'sf_via', 'sf_items'];
  writeCsv(path.join(dir, 'to-import.csv'), header, toImport.map(row));

  // Crosswalk for Automayt's QOH load: one row per Salesforce item a passing product claims.
  const QOH_ADVICE = {
    matched: 'match by vendor code',
    ambiguous: 'two or more Salesforce items map to one item: sum or pick',
    taken: 'do NOT match: same short code, different product',
  };
  const walk = [];
  for (const r of toImport) {
    const d = results.get(r.id);
    if (d.status === 'new') continue;
    for (const h of d.sf) {
      walk.push({
        sf_item_name: h.name, sf_vendor_item_id: h.vendorItemId || '', sf_vendor: h.vendorName || '', sf_uom: h.uom || '',
        automayt_vendor_code: pc.stripSku(r.prosol_sku || r.sku), prosol_sku: r.prosol_sku, maker_sku: r.sku, prosol_id: r.id,
        matched_via: d.via || '', advice: QOH_ADVICE[d.status] || d.status,
      });
    }
  }
  writeCsv(path.join(dir, 'qoh-crosswalk.csv'), ['sf_item_name', 'sf_vendor_item_id', 'sf_vendor', 'sf_uom', 'automayt_vendor_code', 'prosol_sku', 'maker_sku', 'prosol_id', 'matched_via', 'advice'], walk);

  const byId = new Map(records.map((r) => [r.id, r]));
  const sfById = new Map(sfItems.map((i) => [i.id, i]));
  writeCsv(path.join(dir, 'conflicts.csv'), ['scope', 'kind', ...header], [
    ...importable.filter((r) => colliding.has(r.id)).map((r) => ({ scope: 'import', kind: `Prosol code ${r.prosol_sku} shared by ${collisions.get(pc.normCode(r.prosol_sku || r.sku)).length} passing products; one vendor code can't be two items`, ...row(r) })),
    ...sfAmbiguous.filter((r) => !colliding.has(r.id)).map((r) => ({ scope: 'qoh', kind: 'matches 2+ Salesforce items (legacy duplicates): their QOH lands on one item', ...row(r) })),
    ...sfTaken.filter((r) => !colliding.has(r.id)).map((r) => ({ scope: 'qoh', kind: 'short code also on another vendor\'s Salesforce item: that QOH is a different product', ...row(r) })),
    ...sharedSfImportable.map((x) => {
      const it = sfById.get(x.sfId) || {};
      const ids = x.prosolIds.filter((id) => importableIds.has(id));
      return { scope: 'qoh', kind: `Salesforce ${it.name} (${it.vendorItemId || '-'}) claimed by ${ids.length} imported products: its QOH belongs to one`, prosol_id: ids.join(' '), prosol_sku: ids.map((id) => (byId.get(id) || {}).prosol_sku).join(' '), sf_items: it.name };
    }),
  ]);
  writeCsv(path.join(dir, 'sf-prosol-unmatched.csv'), ['id', 'name', 'vendorItemId', 'uom', 'description'], sfProsolUnmatched);
  for (const f of ['in-salesforce.csv']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* not there */ } }
  console.log(JSON.stringify(report, null, 1));
}

main();
