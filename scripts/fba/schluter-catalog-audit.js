#!/usr/bin/env node
/**
 * Schluter catalog audit — where we are losing money and what to list next.
 *
 * Answers three questions the Schluter rep (and the P&L) actually care about:
 *
 *   1. DARK REVENUE  — ASINs that sold in the last 12 months but have no live
 *      offer today, cross-referenced against Prosol stock. Anything with stock
 *      available is a self-inflicted outage, not a supply problem.
 *   2. COVERAGE      — how much of Prosol's Schluter line we actually list.
 *   3. DEMAND GAPS   — Schluter ASINs that exist on Amazon.ca, rank well, and
 *      we don't sell. Ranked, with Prosol sourceability.
 *
 * Inputs (uses the newest snapshot of each; run the pullers first):
 *   scripts/fba/pull-prosol-catalog.js        → prosol-catalog-10008-*.json
 *   scripts/fba/pull-amazon-brand-catalog.js  → amazon-schluter-catalog-*.json
 *   a GET_MERCHANT_LISTINGS_ALL_DATA report   → merchant-listings-all-*.json
 *
 * Usage:
 *   node scripts/fba/schluter-catalog-audit.js
 *   node scripts/fba/schluter-catalog-audit.js --json    # machine-readable
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA = path.join(__dirname, '..', '..', 'data', 'fba');
const SNAPS = path.join(DATA, 'snapshots');
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'analytics.sqlite');
const SKU_MAP = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'sku-map.json');

/** Newest file matching a prefix, so the audit always reads current data. */
function newest(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
}

const load = (p) => (p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const norm = (s) => String(s || '').replace(/[\s/]/g, '').toUpperCase();
const ean = (s) => String(s || '').trim().replace(/^0+/, '');
const money = (n) => '$' + Math.round(n).toLocaleString();
const nameOf = (p) => (p.name && (p.name.en || p.name.fr)) || '';
const prosolSku = (p) => p.prosol_sku || p.sku || p.external_id || '';

/** Schluter part numbers lead the product name, e.g. "RONDEC-CT 1/2in ...". */
function family(text) {
  const n = String(text || '').replace(/^Schluter\s*-?\s*/i, '');
  const m = n.match(/^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/);
  return m ? m[1].toUpperCase() : '(other)';
}

function main() {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has('--json');

  const prosol = load(newest(SNAPS, 'prosol-catalog-10008-'));
  const amazon = load(newest(DATA, 'amazon-schluter-catalog-'));
  const listingsDoc = load(newest(DATA, 'merchant-listings-all-'));
  if (!prosol || !listingsDoc) {
    console.error('Missing inputs. Run pull-prosol-catalog.js and pull a merchant listings report first.');
    process.exit(1);
  }
  const listings = listingsDoc.rows || listingsDoc;
  const map = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;

  // ── what we currently offer ──────────────────────────────────────────────
  const activeAsins = new Set(listings.filter((r) => r.status === 'Active').map((r) => r.asin1).filter(Boolean));
  const anyListingAsins = new Set(listings.map((r) => r.asin1).filter(Boolean));

  const ourSkus = new Set();
  for (const r of listings) if (r['seller-sku']) ourSkus.add(norm(r['seller-sku']));
  for (const v of Object.values(map)) {
    if (!v || typeof v !== 'object') continue;
    for (const f of ['prosol_sku', 'api_sku', 'schluter_item']) if (v[f]) ourSkus.add(norm(v[f]));
  }

  // ── Prosol side ──────────────────────────────────────────────────────────
  const sellable = prosol.products.filter((p) => p.active && !p.discontinued && p.publish_status === 'published');
  const bySku = {};
  const byEan = {};
  for (const p of prosol.products) {
    for (const k of [p.prosol_sku, p.sku, p.external_id]) if (k) bySku[norm(k)] = p;
    if (p.barcode) byEan[ean(p.barcode)] = p;
  }
  const covered = sellable.filter((p) => ourSkus.has(norm(prosolSku(p))));
  const gap = sellable.filter((p) => !ourSkus.has(norm(prosolSku(p))));

  // ── revenue ──────────────────────────────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 7);
  const rev = db.prepare(`
    SELECT asin, ROUND(SUM(revenue)) rev12, SUM(qty_sold) u12, MAX(month) last_month
    FROM v_sku_monthly_pnl
    WHERE month >= ? AND asin IS NOT NULL
    GROUP BY asin HAVING rev12 > 0
  `).all(since);
  db.close();

  // 1 ── DARK REVENUE ──────────────────────────────────────────────────────
  const dark = [];
  for (const r of rev) {
    const e = map[r.asin];
    if (!e || (e.brand || '').toLowerCase() !== 'schluter') continue;
    if (activeAsins.has(r.asin)) continue;
    const ps = e.prosol_sku || e.api_sku || e.schluter_item || '';
    const p = bySku[norm(ps)];
    dark.push({
      asin: r.asin,
      product: e.product || '',
      prosol_sku: ps,
      rev12: r.rev12,
      units12: r.u12,
      last_sale: r.last_month,
      listing: anyListingAsins.has(r.asin) ? 'INACTIVE' : 'NO LISTING',
      prosol_qty: p ? p.available_quantity : null,
      prosol_stock: p ? p.stock_status : 'not-in-catalog',
      restockable: !!(p && Number(p.available_quantity) > 0),
    });
  }
  dark.sort((a, b) => b.rev12 - a.rev12);
  const darkTotal = dark.reduce((s, d) => s + d.rev12, 0);
  const darkRestockable = dark.filter((d) => d.restockable);

  // 2 ── DEMAND GAPS (Amazon ASINs we don't sell) ──────────────────────────
  let demandGaps = [];
  if (amazon) {
    demandGaps = amazon.items
      .filter((i) => !anyListingAsins.has(i.asin) && i.cat_rank)
      .map((i) => {
        const hit = (i.codes || i.eans || []).map(ean).map((c) => byEan[c]).find(Boolean);
        return {
          asin: i.asin,
          title: i.title,
          category: i.cat_rank_title || i.category,
          cat_rank: i.cat_rank,
          dept_rank: i.dept_rank,
          prosol_sku: hit ? prosolSku(hit) : null,
          prosol_qty: hit ? hit.available_quantity : null,
          msrp_cad: hit && hit.msrp_price ? Number(hit.msrp_price) / 100 : null,
        };
      })
      .sort((a, b) => a.cat_rank - b.cat_rank);
  }

  // 3 ── FAMILY COVERAGE ───────────────────────────────────────────────────
  const famStats = {};
  for (const p of sellable) {
    const f = family(nameOf(p));
    famStats[f] = famStats[f] || { family: f, total: 0, listed: 0, stocked: 0 };
    famStats[f].total++;
    if (ourSkus.has(norm(prosolSku(p)))) famStats[f].listed++;
    if (Number(p.available_quantity) > 0) famStats[f].stocked++;
  }
  const families = Object.values(famStats).sort((a, b) => b.total - a.total);

  const report = {
    generatedAt: new Date().toISOString(),
    coverage: {
      prosolSellable: sellable.length,
      weList: covered.length,
      gap: gap.length,
      coveragePct: +((covered.length / sellable.length) * 100).toFixed(1),
      amazonSchluterAsins: amazon ? amazon.count : null,
      ourActiveAsins: activeAsins.size,
    },
    darkRevenue: { total: darkTotal, recoverable: darkRestockable.reduce((s, d) => s + d.rev12, 0), items: dark },
    demandGaps,
    families,
  };

  if (asJson) { console.log(JSON.stringify(report, null, 1)); return; }

  const c = report.coverage;
  console.log('\n═══ SCHLUTER CATALOG AUDIT ═══');
  console.log(`Prosol sellable Schluter SKUs : ${c.prosolSellable}`);
  console.log(`  ...we list                  : ${c.weList}  (${c.coveragePct}% coverage)`);
  console.log(`  ...gap                      : ${c.gap}`);
  if (c.amazonSchluterAsins) console.log(`Schluter ASINs live on Amazon.ca: ${c.amazonSchluterAsins} (we have an offer on ${c.ourActiveAsins} ASINs across all brands)`);

  console.log(`\n─── DARK REVENUE: sold in last 12mo, no live offer today ───`);
  console.log(`${money(darkTotal)} across ${dark.length} ASINs | ${money(report.darkRevenue.recoverable)} is restockable from Prosol TODAY\n`);
  console.log('ASIN'.padEnd(12), 'rev12'.padStart(8), 'u'.padStart(4), 'last'.padEnd(8), 'listing'.padEnd(11), 'prosol'.padEnd(16), 'qty'.padStart(6), ' product');
  for (const d of dark.slice(0, 25)) {
    console.log(
      d.asin.padEnd(12), money(d.rev12).padStart(8), String(d.units12).padStart(4), String(d.last_sale).padEnd(8),
      d.listing.padEnd(11), String(d.prosol_sku).slice(0, 15).padEnd(16), String(d.prosol_qty ?? '-').padStart(6), ' ' + d.product.slice(0, 44)
    );
  }

  if (demandGaps.length) {
    console.log(`\n─── DEMAND GAPS: ranked Amazon.ca Schluter ASINs we don't sell ───\n`);
    console.log('rank'.padStart(6), 'ASIN'.padEnd(12), 'prosol'.padEnd(16), 'qty'.padStart(6), 'msrp'.padStart(8), ' title');
    for (const g of demandGaps.slice(0, 30)) {
      console.log(
        String(g.cat_rank).padStart(6), g.asin.padEnd(12), String(g.prosol_sku || '—').slice(0, 15).padEnd(16),
        String(g.prosol_qty ?? '—').padStart(6), (g.msrp_cad ? '$' + g.msrp_cad.toFixed(0) : '—').padStart(8), ' ' + g.title.slice(0, 58)
      );
    }
  }

  console.log(`\n─── FAMILY COVERAGE (top 20 by catalog size) ───\n`);
  console.log('family'.padEnd(20), 'prosol'.padStart(7), 'listed'.padStart(7), 'stocked'.padStart(8));
  for (const f of families.slice(0, 20)) {
    console.log(f.family.padEnd(20), String(f.total).padStart(7), String(f.listed).padStart(7), String(f.stocked).padStart(8));
  }

  const out = path.join(DATA, `schluter-audit-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\n✓ wrote ${out}`);
}

if (require.main === module) main();
module.exports = { main };
