#!/usr/bin/env node
/**
 * Find Schluter listings that are switched off but shouldn't be, and turn the
 * safe ones back on.
 *
 * Why this exists: most of our "lost" Schluter revenue is not a purchasing
 * problem. A listing goes Inactive the moment its quantity hits zero, and it
 * stays that way even after supply comes back. We drop-ship from Prosol, so any
 * merchant-fulfilled listing whose Prosol SKU is in stock can go live again for
 * free — no PO, no inbound, no freight.
 *
 * Classification:
 *   FBA_STOCK_STRANDED  FBA units on hand but no live offer. Highest value, and
 *                       REPORT-ONLY — reopening an FBA offer is a Seller Central
 *                       action and these are too valuable to poke blindly.
 *   MFN_RESTORABLE      Merchant-fulfilled, no live quantity, Prosol has stock.
 *                       Safe, mechanical, reversible → this is what --commit does.
 *   BLOCKED             Amazon reports issues on the listing. Never touched.
 *   NO_SOURCE           Prosol has no stock. Nothing to do.
 *
 * Usage:
 *   node scripts/fba/reactivate-listings.js                  # dry run, default
 *   node scripts/fba/reactivate-listings.js --commit         # set MFN quantities
 *   node scripts/fba/reactivate-listings.js --commit --max-qty=6 --only=KKB7
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'fba');
const SNAPS = path.join(DATA, 'snapshots');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes('--' + k);
const COMMIT = flag('commit');
const MAX_QTY = Number(arg('max-qty', 10));       // conservative: we hand-pick from Prosol per order
const MIN_PROSOL = Number(arg('min-prosol', 3));  // don't advertise off a nearly-empty shelf
const MIN_MARKUP = Number(arg('min-markup', 1.15));
const FORCE_PRICE = flag('force-price');
const ONLY = arg('only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newest = (dir, prefix) => {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();
const money = (n) => '$' + Math.round(n).toLocaleString();

(async () => {
  const listingsPath = newest(DATA, 'merchant-listings-all-');
  if (!listingsPath) { console.error('No merchant-listings-all-*.json. Pull GET_MERCHANT_LISTINGS_ALL_DATA first.'); process.exit(1); }
  const listings = JSON.parse(fs.readFileSync(listingsPath, 'utf8')).rows;
  console.log(`listings report: ${path.basename(listingsPath)} (${listings.length} rows)`);

  const skuMap = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;
  const catPath = newest(SNAPS, 'prosol-catalog-10008-');
  const prosolBySku = {};
  if (catPath) {
    for (const p of JSON.parse(fs.readFileSync(catPath, 'utf8')).products) {
      for (const k of [p.prosol_sku, p.sku, p.external_id]) if (k) prosolBySku[norm(k)] = p;
    }
  }

  // A listing that went inactive keeps whatever price it had. Re-enabling it
  // blind can sell below cost or under Schluter's MAP floor — and the FBA
  // thermostat is suppressed by Amazon error 18155 for exactly this reason.
  const costBy = {};
  const mapBy = {};
  for (const v of Object.values(skuMap)) {
    if (!v || typeof v !== 'object') continue;
    for (const f of ['prosol_sku', 'api_sku']) {
      if (!v[f]) continue;
      const k = norm(v[f]);
      if (v.cost_cad != null && costBy[k] == null) costBy[k] = Number(v.cost_cad);
      if (v.map_cad != null && mapBy[k] == null) mapBy[k] = Number(v.map_cad);
    }
  }
  const priceVerdict = ({ price, cost, mapCad }) => {
    if (price == null) return 'NO PRICE';
    if (cost != null && price < cost * MIN_MARKUP) return `BELOW COST×${MIN_MARKUP}`;
    if (mapCad != null && price < mapCad) return 'BELOW MAP';
    if (cost == null) return 'OK (cost unknown)';
    return 'OK';
  };

  // Live FBA stock, so "stranded" is measured against reality not a snapshot.
  const inv = await sp.getAllFbaInventory();
  const invRows = Array.isArray(inv) ? inv : (inv.inventorySummaries || []);
  const fbaBySku = {};
  for (const r of invRows) {
    const d = r.inventoryDetails || {};
    fbaBySku[norm(r.sellerSku)] = { fulfillable: d.fulfillableQuantity || 0, inbound: d.inboundShippedQuantity || 0, asin: r.asin };
  }

  const isSch = (r) => /schluter|ditra|kerdi|rondec|jolly|schiene|quadec|dilex|trep|liprotec|bara|reno-|shelf/i.test(r['item-name'] || '');
  const activeAsins = new Set(listings.filter((r) => r.status === 'Active').map((r) => r.asin1).filter(Boolean));

  const prosolSkuFor = (asin, sellerSku) => {
    const e = skuMap[asin];
    if (e && (e.prosol_sku || e.api_sku)) return e.prosol_sku || e.api_sku;
    // Seller SKUs frequently embed the Prosol part number.
    const n = norm(sellerSku);
    const hit = Object.keys(prosolBySku).sort((a, b) => b.length - a.length).find((k) => k.length >= 5 && n.includes(k));
    return hit ? (prosolBySku[hit].prosol_sku || prosolBySku[hit].sku) : null;
  };

  const targets = listings.filter((r) => isSch(r) && r.status !== 'Active' && (!ONLY || norm(r['seller-sku']).includes(norm(ONLY))));
  console.log(`non-Active Schluter listings: ${targets.length}\n`);

  const buckets = { FBA_STOCK_STRANDED: [], MFN_RESTORABLE: [], BLOCKED: [], NO_SOURCE: [] };

  for (const r of targets) {
    const sellerSku = (r['seller-sku'] || '').trim();
    const fba = fbaBySku[norm(sellerSku)] || { fulfillable: 0, inbound: 0 };
    const ps = prosolSkuFor(r.asin1, sellerSku);
    const pc = ps ? prosolBySku[norm(ps)] : null;
    const prosolQty = pc ? Number(pc.available_quantity) : 0;

    // Ask Amazon why it's off before deciding anything.
    let issues = [];
    let liveStatus = '?';
    try {
      const item = await sp.getListingsItem(sellerSku, { includedData: 'summaries,issues,offers,fulfillmentAvailability' });
      issues = (item?.issues || []).filter((i) => i.severity === 'ERROR');
      liveStatus = (item?.summaries?.[0]?.status || []).join(',') || '(none)';
    } catch (e) {
      issues = [{ message: `getListingsItem failed: ${e.message}`, severity: 'ERROR', code: 'LOOKUP_FAILED' }];
    }
    await sleep(250);

    const price = Number(r.price) || null;
    const cost = ps ? (costBy[norm(ps)] ?? null) : null;
    const mapCad = ps ? (mapBy[norm(ps)] ?? null) : null;
    const row = {
      sellerSku, asin: r.asin1, name: r['item-name'] || '', channel: r['fulfillment-channel'] || 'DEFAULT',
      reportStatus: r.status, liveStatus, price, cost, mapCad, issues,
      margin_pct: price != null && cost != null ? Math.round(((price - cost) / price) * 100) : null,
      price_verdict: priceVerdict({ price, cost, mapCad }),
      msrp_cad: pc && pc.msrp_price ? Number(pc.msrp_price) / 100 : null,
      fba_on_hand: fba.fulfillable, fba_inbound: fba.inbound,
      prosol_sku: ps, prosol_qty: prosolQty,
      has_active_sibling: activeAsins.has(r.asin1),
    };

    if (issues.length) buckets.BLOCKED.push(row);
    else if (fba.fulfillable > 0) buckets.FBA_STOCK_STRANDED.push(row);
    else if (row.channel === 'DEFAULT' && prosolQty >= MIN_PROSOL) buckets.MFN_RESTORABLE.push(row);
    else buckets.NO_SOURCE.push(row);
  }

  const show = (title, rows, extra = () => '') => {
    console.log(`\n═══ ${title} (${rows.length}) ═══`);
    for (const x of rows) {
      console.log(`  ${x.sellerSku.padEnd(20)} ${String(x.asin).padEnd(12)} ${x.channel.padEnd(10)} ${String(x.reportStatus).padEnd(11)} live=${String(x.liveStatus).padEnd(12)} ${extra(x)}`);
      console.log(`      ${x.name.slice(0, 74)}`);
      if (x.issues.length) for (const i of x.issues.slice(0, 3)) console.log(`      ⚠ ${i.code || ''} ${i.message}`.slice(0, 150));
    }
  };

  show('FBA STOCK STRANDED — units in Amazon, no live offer (REPORT ONLY)', buckets.FBA_STOCK_STRANDED,
    (x) => `on-hand=${x.fba_on_hand}${x.has_active_sibling ? ' (has active sibling)' : ''}`);
  if (buckets.FBA_STOCK_STRANDED.length) {
    console.log('\n  → Reopen these in Seller Central. Deliberately not automated: reopening an');
    console.log('    FBA offer is a couple of clicks and these are the highest-value listings');
    console.log('    we own, so a scripted patch is the wrong risk trade.');
  }

  console.log(`\n═══ MFN RESTORABLE — set a quantity and the offer goes live (${buckets.MFN_RESTORABLE.length}) ═══`);
  console.log('  ' + 'sku'.padEnd(20) + 'price'.padStart(9) + 'cost'.padStart(9) + 'MAP'.padStart(9) + 'msrp'.padStart(9) + 'marg'.padStart(6) + 'qty'.padStart(5) + '  verdict');
  for (const x of buckets.MFN_RESTORABLE) {
    const f = (v) => (v != null ? '$' + Number(v).toFixed(2) : '—');
    console.log('  ' + x.sellerSku.padEnd(20) + f(x.price).padStart(9) + f(x.cost).padStart(9) + f(x.mapCad).padStart(9) +
      f(x.msrp_cad).padStart(9) + (x.margin_pct != null ? x.margin_pct + '%' : '—').padStart(6) +
      String(Math.min(MAX_QTY, x.prosol_qty)).padStart(5) + '  ' + x.price_verdict);
    console.log('      ' + x.name.slice(0, 74));
  }
  show('BLOCKED BY AMAZON ISSUES — fix the issue first', buckets.BLOCKED);
  show('NO SOURCE — Prosol has nothing', buckets.NO_SOURCE, (x) => `prosol ${x.prosol_sku || '(unmapped)'}=${x.prosol_qty}`);

  const priceOk = (x) => x.price_verdict.startsWith('OK');
  const willSet = FORCE_PRICE ? buckets.MFN_RESTORABLE : buckets.MFN_RESTORABLE.filter(priceOk);
  const priceHeld = buckets.MFN_RESTORABLE.filter((x) => !priceOk(x));
  if (priceHeld.length) {
    console.log(`\n  ${priceHeld.length} held back on price (fix the price, then re-run${FORCE_PRICE ? '' : '; --force-price overrides'}):`);
    for (const x of priceHeld) console.log(`    ${x.sellerSku.padEnd(20)} ${x.price_verdict}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN. ${willSet.length} of ${buckets.MFN_RESTORABLE.length} listings would be set live. Re-run with --commit to apply.`);
  } else {
    console.log(`\n=== COMMITTING ${willSet.length} MFN quantity updates ===`);
    const results = [];
    for (const x of willSet) {
      const qty = Math.min(MAX_QTY, x.prosol_qty);
      try {
        const res = await sp.setListingMfnQuantity(x.sellerSku, qty);
        const errs = (res.issues || []).filter((i) => i.severity === 'ERROR');
        console.log(`  ${errs.length ? '✗' : '✓'} ${x.sellerSku.padEnd(20)} qty=${qty} submission=${res.submissionId || '—'}${errs.length ? ' ' + errs.map((e) => e.message).join('; ') : ''}`);
        results.push({ ...x, setQty: qty, ok: !errs.length, issues: errs });
      } catch (e) {
        console.log(`  ✗ ${x.sellerSku.padEnd(20)} ${e.message}`);
        results.push({ ...x, setQty: qty, ok: false, error: e.message });
      }
      await sleep(600);
    }
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n${ok}/${results.length} succeeded. Amazon takes a few minutes to flip status to Active.`);
  }

  const out = path.join(DATA, `reactivate-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), committed: COMMIT, params: { MAX_QTY, MIN_PROSOL }, buckets }, null, 1));
  console.log(`\n✓ wrote ${out}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
