#!/usr/bin/env node
/**
 * Sweep for revenue that is silently switched off.
 *
 * Born from B07BKST1ZY: a $39.6K/yr listing sat dark for three months with 36
 * paid-for FBA units behind it, because a price cut tripped our own min-price
 * floor (error 18155) and suppressed the offer. Nothing alerted. This finds the
 * rest of that class, across every brand.
 *
 *   1 STRANDED FBA      units in Amazon's warehouse, no live offer. Money already spent.
 *   2 BLOCKED           listing carries an Amazon ERROR. Ranked by trailing revenue.
 *   3 BELOW MAP         live listings under the manufacturer floor. Compliance exposure.
 *   4 USED-BUYBOX TRAP  the reported buy box is a USED offer, so our new-condition
 *                       price is being compared against the wrong thing.
 *   5 DEAD WEIGHT       earned real revenue, now zero stock and no offer.
 *
 * Read-only. Changes nothing.
 *
 * Usage:
 *   node scripts/fba/silent-losses-audit.js
 *   node scripts/fba/silent-losses-audit.js --offers=60   # deeper buybox scan
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sp = require('../../lib/sp-api');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'fba');
const SNAPS = path.join(DATA, 'snapshots');
const DB_PATH = path.join(ROOT, 'data', 'analytics.sqlite');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const OFFER_SCAN = Number(arg('offers', 40));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newest = (dir, prefix) => {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();

(async () => {
  const listings = JSON.parse(fs.readFileSync(newest(DATA, 'merchant-listings-all-'), 'utf8')).rows;
  const skuMap = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;

  const db = new Database(DB_PATH, { readonly: true });
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 7);
  const revByAsin = {};
  for (const r of db.prepare(`
    SELECT asin, ROUND(SUM(revenue)) rev12, SUM(qty_sold) u12, MAX(month) last_month
    FROM v_sku_monthly_pnl WHERE month >= ? AND asin IS NOT NULL GROUP BY asin
  `).all(since)) revByAsin[r.asin] = r;
  db.close();

  const catPath = newest(SNAPS, 'prosol-catalog-10008-');
  const prosolBySku = {};
  if (catPath) for (const p of JSON.parse(fs.readFileSync(catPath, 'utf8')).products) {
    for (const k of [p.prosol_sku, p.sku, p.external_id]) if (k) prosolBySku[norm(k)] = p;
  }

  const mapBy = {}, costBy = {};
  for (const v of Object.values(skuMap)) {
    if (!v || typeof v !== 'object') continue;
    for (const f of ['prosol_sku', 'api_sku']) {
      if (!v[f]) continue;
      const k = norm(v[f]);
      if (v.map_cad != null && mapBy[k] == null) mapBy[k] = Number(v.map_cad);
      if (v.cost_cad != null && costBy[k] == null) costBy[k] = Number(v.cost_cad);
    }
  }
  const mapForAsin = (asin) => {
    const e = skuMap[asin];
    if (e?.map_cad != null) return Number(e.map_cad);
    const ps = e?.prosol_sku || e?.api_sku;
    return ps ? (mapBy[norm(ps)] ?? null) : null;
  };

  const inv = await sp.getAllFbaInventory();
  const invRows = Array.isArray(inv) ? inv : (inv.inventorySummaries || []);

  const activeAsins = new Set(listings.filter((r) => r.status === 'Active').map((r) => r.asin1).filter(Boolean));
  const bySku = {};
  for (const r of listings) bySku[norm(r['seller-sku'])] = r;
  const rev = (asin) => revByAsin[asin]?.rev12 || 0;

  // ── 1. Stranded FBA ──────────────────────────────────────────────────────
  const stranded = [];
  for (const r of invRows) {
    const q = r.inventoryDetails?.fulfillableQuantity || 0;
    if (q <= 0) continue;
    const l = bySku[norm(r.sellerSku)];
    if (l && l.status === 'Active') continue;
    if (activeAsins.has(r.asin)) continue;   // a sibling listing is carrying it
    stranded.push({ sku: r.sellerSku, asin: r.asin, qty: q, rev12: rev(r.asin), name: l?.['item-name'] || '' });
  }
  stranded.sort((a, b) => b.rev12 - a.rev12);

  // ── 2. Blocked listings, revenue-ranked ─────────────────────────────────
  const nonActive = listings.filter((r) => r.status !== 'Active')
    .sort((a, b) => rev(b.asin1) - rev(a.asin1));
  const blocked = [];
  for (const r of nonActive) {
    try {
      const it = await sp.getListingsItem((r['seller-sku'] || '').trim(), { includedData: 'summaries,issues' });
      const errs = (it?.issues || []).filter((i) => i.severity === 'ERROR');
      if (errs.length) blocked.push({ sku: r['seller-sku'], asin: r.asin1, rev12: rev(r.asin1), name: r['item-name'] || '', errs });
    } catch { /* transient lookup failure — not a finding */ }
    await sleep(220);
  }
  blocked.sort((a, b) => b.rev12 - a.rev12);

  // ── 3. Live listings under MAP ──────────────────────────────────────────
  const belowMap = [];
  for (const r of listings) {
    if (r.status !== 'Active') continue;
    const price = Number(r.price);
    const m = mapForAsin(r.asin1);
    if (!price || m == null) continue;
    if (price < m - 0.01) belowMap.push({ sku: r['seller-sku'], asin: r.asin1, price, map: m, gap: +(m - price).toFixed(2), rev12: rev(r.asin1), name: r['item-name'] || '' });
  }
  belowMap.sort((a, b) => b.rev12 - a.rev12);

  // ── 4. Used-condition buy box on our top earners ────────────────────────
  const topAsins = [...new Set(listings.map((r) => r.asin1).filter(Boolean))]
    .sort((a, b) => rev(b) - rev(a)).slice(0, OFFER_SCAN);
  const usedTrap = [];
  for (const asin of topAsins) {
    try {
      const raw = await sp.getItemOffers(asin);
      const p = raw?.payload || raw;
      const bb = (p?.Summary?.BuyBoxPrices || [])[0];
      if (!bb) continue;
      const offers = p?.Offers || [];
      const newOffers = offers.filter((o) => (o.SubCondition || '').toLowerCase() === 'new' || o.IsFulfilledByAmazon !== undefined);
      const anyPrime = offers.some((o) => o.IsFulfilledByAmazon);
      if (String(bb.condition || '').toLowerCase() === 'used') {
        usedTrap.push({
          asin, rev12: rev(asin), usedBB: bb.ListingPrice?.Amount,
          lowestNew: Math.min(...newOffers.map((o) => Number(o.ListingPrice?.Amount) || Infinity)),
          newCount: newOffers.length, anyPrime, map: mapForAsin(asin),
        });
      }
    } catch { /* throttled or unavailable */ }
    await sleep(700);
  }
  usedTrap.sort((a, b) => b.rev12 - a.rev12);

  // ── 5. Dead weight: earned revenue, now nothing ─────────────────────────
  const fbaQty = {};
  for (const r of invRows) fbaQty[r.asin] = (fbaQty[r.asin] || 0) + (r.inventoryDetails?.fulfillableQuantity || 0);
  const dead = Object.values(revByAsin)
    .filter((r) => r.rev12 > 0 && !activeAsins.has(r.asin) && !(fbaQty[r.asin] > 0))
    .sort((a, b) => b.rev12 - a.rev12);

  // ── Report ───────────────────────────────────────────────────────────────
  const H = (t) => console.log(`\n═══ ${t} ═══`);

  H(`1. STRANDED FBA STOCK — units in Amazon, no live offer (${stranded.length})`);
  let strandedRev = 0;
  for (const s of stranded) { strandedRev += s.rev12; console.log(`  ${String(s.sku).padEnd(20)} ${s.asin}  ${String(s.qty).padStart(4)} units  ${money(s.rev12).padStart(9)}/yr  ${s.name.slice(0, 42)}`); }
  console.log(`  → ${money(strandedRev)}/yr of demand sitting behind paid-for stock`);

  H(`2. BLOCKED BY AMAZON ERRORS (${blocked.length})`);
  let blockedRev = 0;
  for (const b of blocked) {
    blockedRev += b.rev12;
    console.log(`  ${String(b.sku).padEnd(20)} ${b.asin}  ${money(b.rev12).padStart(9)}/yr  ${b.name.slice(0, 40)}`);
    for (const e of b.errs.slice(0, 2)) console.log(`      ${e.code}: ${String(e.message).slice(0, 96)}`);
  }
  console.log(`  → ${money(blockedRev)}/yr behind fixable listing errors`);

  H(`3. LIVE LISTINGS PRICED UNDER MAP (${belowMap.length})`);
  for (const b of belowMap) console.log(`  ${String(b.sku).padEnd(20)} ${b.asin}  $${b.price.toFixed(2)} vs MAP $${b.map.toFixed(2)}  (−$${b.gap})  ${money(b.rev12)}/yr  ${b.name.slice(0, 34)}`);

  H(`4. USED-CONDITION BUY BOX — our new price is being judged against a used offer (${usedTrap.length})`);
  for (const u of usedTrap) console.log(`  ${u.asin}  ${money(u.rev12).padStart(9)}/yr  usedBB $${u.usedBB}  lowestNew $${Number.isFinite(u.lowestNew) ? u.lowestNew : '—'}  newOffers=${u.newCount}  anyFBA=${u.anyPrime}  MAP $${u.map ?? '—'}`);

  H(`5. EARNED REVENUE, NOW NO OFFER AND NO STOCK (top 20 of ${dead.length})`);
  let deadRev = 0;
  for (const d of dead) deadRev += d.rev12;
  for (const d of dead.slice(0, 20)) console.log(`  ${d.asin}  ${money(d.rev12).padStart(9)}/yr  ${d.u12} units  last sale ${d.last_month}  ${(skuMap[d.asin]?.product || '').slice(0, 40)}`);
  console.log(`  → ${money(deadRev)}/yr across ${dead.length} ASINs with no offer and no stock`);

  const out = path.join(DATA, `silent-losses-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), stranded, blocked, belowMap, usedTrap, dead }, null, 1));
  console.log(`\n✓ wrote ${out}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
