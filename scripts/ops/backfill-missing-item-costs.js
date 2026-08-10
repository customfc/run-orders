#!/usr/bin/env node
/**
 * Backfill item_costs for Amazon MSKUs the P&L cannot cost.
 *
 * v_sku_monthly_pnl resolves cost through exactly one chain:
 *   sku_map_canonical.amazon_msku = seller_sku  ->  cost_cad
 *   item_costs.sku = sku_map_canonical.sf_item_name
 *   item_costs.sku = seller_sku                            <- what we write here
 * ...and falls back to 0, which counts revenue with no COGS and reports the
 * SKU as pure profit. As of 2026-08-10 that was 55 SKUs and $130,332 of 2026
 * revenue, inflating reported profit by roughly $66k.
 *
 * We resolve each orphan MSKU to its ASIN from amazon_order_items (the order
 * lines are authoritative — the MSKU is ours, the ASIN is Amazon's), then take
 * the cost from sku_map_canonical or the repo sku-map, both of which source
 * from Prosol offers. Nothing is estimated: an MSKU we cannot resolve to a real
 * cost is left alone and reported, because a wrong cost is worse than a missing
 * one.
 *
 * IMPORTANT — per-UOM costs. Area products carry a per-sqft cost plus a
 * qty_per_unit multiplier (DH512M is $1.94/sqft x 134.5 = $261.22/roll), and
 * that multiplier lives on sku_map_canonical, which the item_costs path does
 * not read. So we write the EFFECTIVE per-unit cost and record both factors in
 * source_detail so the arithmetic stays auditable.
 *
 * Usage:
 *   node scripts/ops/backfill-missing-item-costs.js            # dry run
 *   node scripts/ops/backfill-missing-item-costs.js --commit   # write
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const COMMIT = process.argv.includes('--commit');
const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'analytics.sqlite');
const MAP = require(path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json')).mappings;

const db = new Database(DB_PATH, { readonly: !COMMIT });

if (COMMIT) {
  const dir = path.join(ROOT, 'data', 'analytics-backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = db.prepare("SELECT strftime('%Y%m%d-%H%M%S','now') s").get().s;
  const dest = path.join(dir, `analytics-before-cost-backfill-${stamp}.sqlite`);
  db.backup(dest);
  console.log(`backup written: ${dest}\n`);
}

const missing = db.prepare(`
  SELECT sku, ROUND(SUM(revenue),0) rev, SUM(qty_sold) qty
  FROM v_sku_monthly_pnl
  WHERE cost_confidence = 'missing' AND month >= '2026-02'
  GROUP BY sku ORDER BY rev DESC`).all();

const asinOf = db.prepare(`SELECT asin, COUNT(*) n FROM amazon_order_items
  WHERE seller_sku = ? AND asin IS NOT NULL GROUP BY asin ORDER BY n DESC LIMIT 1`);
const canonByAsin = db.prepare(`SELECT cost_cad, qty_per_unit, prosol_sku, api_sku FROM sku_map_canonical
  WHERE asin = ? AND cost_cad IS NOT NULL LIMIT 1`);
const existing = db.prepare(`SELECT cost_cad FROM item_costs WHERE sku = ?`);

const ins = db.prepare(`INSERT INTO item_costs (sku, cost_cad, cost_source, source_detail, prosol_sku, updated_at)
  VALUES (@sku, @cost_cad, @cost_source, @source_detail, @prosol_sku, datetime('now'))`);

const plan = [];
const skipped = [];
for (const m of missing) {
  if (existing.get(m.sku)) { skipped.push([m.sku, 'already in item_costs']); continue; }
  const a = asinOf.get(m.sku);
  let base = null, qpu = 1, prosolSku = null, via = null;

  if (a) {
    const c = canonByAsin.get(a.asin);
    if (c && c.cost_cad) { base = c.cost_cad; qpu = c.qty_per_unit || 1; prosolSku = c.prosol_sku || c.api_sku; via = `sku_map_canonical via asin ${a.asin}`; }
    if (base == null && MAP[a.asin] && MAP[a.asin].cost_cad) {
      base = MAP[a.asin].cost_cad; prosolSku = MAP[a.asin].prosol_sku || MAP[a.asin].api_sku;
      via = `sku-map.json via asin ${a.asin}`;
    }
  }
  if (base == null && MAP[m.sku] && MAP[m.sku].cost_cad) {
    base = MAP[m.sku].cost_cad; prosolSku = MAP[m.sku].prosol_sku || MAP[m.sku].api_sku;
    via = 'sku-map.json via msku';
  }
  if (base == null) { skipped.push([m.sku, `no cost resolvable (rev $${m.rev})`]); continue; }

  const effective = Number((base * qpu).toFixed(4));
  plan.push({
    sku: m.sku, cost_cad: effective, cost_source: 'prosol-offers (backfill 2026-08-10)',
    source_detail: qpu === 1 ? via : `${via}; ${base} x qty_per_unit ${qpu} = ${effective}`,
    prosol_sku: prosolSku || null,
    _rev: m.rev, _qty: m.qty, _cogs: effective * (m.qty || 0),
  });
}

console.log(`resolvable: ${plan.length}   skipped: ${skipped.length}\n`);
for (const p of plan.sort((x, y) => y._rev - x._rev)) {
  console.log(`  ${p.sku.padEnd(17)} $${String(p.cost_cad).padStart(9)}  rev $${String(p._rev).padStart(6)}  qty ${String(p._qty).padStart(4)}  COGS $${String(Math.round(p._cogs)).padStart(6)}   ${p.source_detail}`);
}
console.log('\nskipped:');
for (const [s, why] of skipped) console.log(`  ${s.padEnd(17)} ${why}`);
console.log(`\ntotal COGS to be recognised: $${Math.round(plan.reduce((s, p) => s + p._cogs, 0))}`);

if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit.'); process.exit(0); }
const tx = db.transaction((rows) => { for (const r of rows) ins.run(r); });
tx(plan);
console.log(`\nwrote ${plan.length} rows to item_costs.`);
