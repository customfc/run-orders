#!/usr/bin/env node
/**
 * Map demand-ranked Amazon ASINs to Prosol SKUs so they can become PO lines.
 *
 * 159 of the 224 ranked Schluter ASINs we don't sell are unmapped rather than
 * unavailable, and 2 FBA SKUs with real revenue resolve to nothing. Until they
 * carry a prosol_sku they cannot enter a replenishment PO or a listing decision,
 * which is why this gates both the PO and the catalog-add lever.
 *
 * Why not lib/auto-map.js: that evaluator is built for live order SKUs and
 * DEFERS anything in a variant family (SHELF-E alone has ~50 colour/shape
 * variants). Nearly every ASIN here is in a variant family, so it would defer
 * all of them. The safety argument is different in this direction: Schluter part
 * numbers appear in the Amazon title, and the part number IS the variant. That
 * is the same "listing title is ground truth" rule the pipeline already relies
 * on (feedback_sku_map_title_truth).
 *
 * Confidence tiers:
 *   EAN     barcode from Amazon's catalog matches a Prosol barcode exactly.
 *   PART#   an exact Prosol SKU appears as a token in the Amazon title, and
 *           matches exactly ONE catalog entry. Longest match wins.
 *   DEFER   ambiguous, too short to be safe, or no match. Never guessed.
 *
 * Writes nothing without --commit, and only ever ADDS new ASIN keys — existing
 * entries are never modified.
 *
 * Usage:
 *   node scripts/fba/map-gap-asins.js
 *   node scripts/fba/map-gap-asins.js --commit
 *   node scripts/fba/map-gap-asins.js --commit --tier=EAN
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'fba');
const SNAPS = path.join(DATA, 'snapshots');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const COMMIT = process.argv.includes('--commit');
const TIER = arg('tier');
const MIN_TOKEN = Number(arg('min-token', 6));   // shorter tokens collide with words

const newest = (dir, p) => {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(p) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();
const ean = (s) => String(s || '').trim().replace(/^0+/, '');
const nameOf = (p) => (p.name && (p.name.en || p.name.fr)) || '';

// Titles that describe a family rather than one variant.
const VARIATION_PARENT = /all models|size\s*\/\s*type|various sizes|multiple sizes|all sizes|choose (your|a) size|\ball variants\b/i;

(async () => {
  const cat = JSON.parse(fs.readFileSync(newest(SNAPS, 'prosol-catalog-10008-'), 'utf8')).products;
  const amz = JSON.parse(fs.readFileSync(newest(DATA, 'amazon-schluter-catalog-'), 'utf8')).items;
  const audit = JSON.parse(fs.readFileSync(newest(DATA, 'schluter-audit-'), 'utf8'));
  const mapDoc = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8'));
  const map = mapDoc.mappings;

  // Prosol indexes
  const byNorm = {};          // normalized sku -> [products]
  const byEan = {};
  for (const p of cat) {
    for (const k of [p.prosol_sku, p.sku, p.external_id]) {
      if (!k) continue;
      (byNorm[norm(k)] = byNorm[norm(k)] || []).push(p);
    }
    if (p.barcode) (byEan[ean(p.barcode)] = byEan[ean(p.barcode)] || []).push(p);
  }
  // Longest first so KD4GRKEOB wins over KD4GRKE
  const normKeys = Object.keys(byNorm).filter((k) => k.length >= MIN_TOKEN).sort((a, b) => b.length - a.length);

  const amzByAsin = Object.fromEntries(amz.map((a) => [a.asin, a]));

  // Targets: ranked gap ASINs with no prosol_sku, plus the two unresolved FBA SKUs.
  const targets = [];
  for (const g of audit.demandGaps) {
    if (g.prosol_sku) continue;
    targets.push({ asin: g.asin, title: g.title, rank: g.cat_rank, source: 'demand-gap' });
  }
  for (const [asin, why] of [['B004FQY1XC', 'WS-D4GC-Z09D'], ['B001TM5LLQ', 'YI-LNNX-HQ61']]) {
    if (!targets.find((t) => t.asin === asin)) {
      targets.push({ asin, title: amzByAsin[asin]?.title || '', rank: null, source: `unresolved FBA sku ${why}` });
    }
  }
  console.log(`targets: ${targets.length} unmapped ASINs\n`);

  const results = [];
  for (const t of targets) {
    if (map[t.asin]) { results.push({ ...t, tier: 'SKIP', reason: 'already in sku-map' }); continue; }
    const a = amzByAsin[t.asin] || {};
    const title = t.title || a.title || '';

    // 1. EAN — strongest identity available.
    let hit = null, tier = null, evidence = null;
    for (const c of (a.codes || a.eans || [])) {
      const m = byEan[ean(c)];
      if (m && m.length === 1) { hit = m[0]; tier = 'EAN'; evidence = `barcode ${c}`; break; }
      if (m && m.length > 1) { evidence = `barcode ${c} matched ${m.length} products`; }
    }

    // 2. Part number embedded in the Amazon title.
    //
    // Guard: a variation-PARENT listing ("All Models Size/Type") names one part
    // number while actually covering the whole family, so the number does NOT
    // pin the variant. That is precisely the wrong-size-into-an-unattended-PO
    // failure lib/auto-map.js exists to prevent — defer instead.
    if (!hit && title && VARIATION_PARENT.test(title)) {
      evidence = 'variation-parent title — part number does not pin the variant';
    } else if (!hit && title) {
      const n = norm(title);
      const key = normKeys.find((k) => n.includes(k));
      if (key) {
        const cands = byNorm[key];
        const distinct = [...new Map(cands.map((p) => [p.prosol_sku || p.sku, p])).values()];
        if (distinct.length === 1) { hit = distinct[0]; tier = 'PART#'; evidence = `part number ${key} in title`; }
        else evidence = `part number ${key} matched ${distinct.length} distinct products`;
      }
    }

    if (!hit) { results.push({ ...t, tier: 'DEFER', reason: evidence || 'no EAN or part number match' }); continue; }

    results.push({
      ...t, tier,
      prosol_sku: hit.prosol_sku || hit.sku,
      api_sku: hit.sku || hit.prosol_sku,
      product: nameOf(hit),
      msrp_cad: hit.msrp_price ? Number(hit.msrp_price) / 100 : null,
      prosol_qty: hit.available_quantity,
      barcode: hit.barcode || null,
      evidence,
    });
  }

  // Two ASINs resolving to the same Prosol SKU means at least one is a
  // different variant that happened to share a token. Defer both.
  const claim = {};
  for (const r of results) if (r.prosol_sku) (claim[r.prosol_sku] = claim[r.prosol_sku] || []).push(r.asin);
  for (const r of results) {
    if (r.prosol_sku && claim[r.prosol_sku].length > 1) {
      r.tier = 'DEFER';
      r.reason = `prosol_sku ${r.prosol_sku} also claimed by ${claim[r.prosol_sku].filter((x) => x !== r.asin).join(', ')}`;
      delete r.prosol_sku;
    }
  }

  const tally = results.reduce((a, r) => { a[r.tier] = (a[r.tier] || 0) + 1; return a; }, {});
  console.log('by tier:', JSON.stringify(tally), '\n');

  const mapped = results.filter((r) => r.tier === 'EAN' || r.tier === 'PART#')
    .filter((r) => !TIER || r.tier === TIER)
    .sort((a, b) => (a.rank || 9e9) - (b.rank || 9e9));

  console.log('═══ PROPOSED MAPPINGS ═══');
  console.log('rank'.padStart(6) + '  ' + 'ASIN'.padEnd(12) + 'tier'.padEnd(7) + 'prosol_sku'.padEnd(18) + 'qty'.padStart(6) + 'msrp'.padStart(9) + '  evidence');
  for (const r of mapped) {
    console.log(
      String(r.rank ?? '—').padStart(6) + '  ' + r.asin.padEnd(12) + r.tier.padEnd(7) +
      String(r.prosol_sku).slice(0, 17).padEnd(18) + String(r.prosol_qty ?? '—').padStart(6) +
      (r.msrp_cad ? '$' + r.msrp_cad.toFixed(0) : '—').padStart(9) + '  ' + r.evidence);
    console.log('        ' + String(r.title).slice(0, 78));
  }

  const deferred = results.filter((r) => r.tier === 'DEFER').sort((a, b) => (a.rank || 9e9) - (b.rank || 9e9));
  console.log(`\n─── DEFERRED (${deferred.length}) — never guessed ───`);
  for (const d of deferred.slice(0, 25)) {
    console.log(`  ${String(d.rank ?? '—').padStart(5)}  ${d.asin}  ${d.reason}`);
    console.log(`         ${String(d.title).slice(0, 74)}`);
  }
  if (deferred.length > 25) console.log(`  …and ${deferred.length - 25} more`);

  const outPath = path.join(DATA, `gap-asin-mappings-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), committed: COMMIT, results }, null, 1));

  if (!COMMIT) {
    console.log(`\nDRY RUN — ${mapped.length} mappings would be added to sku-map.json. Re-run with --commit.`);
    console.log(`✓ wrote ${outPath}`);
    return;
  }

  const backup = SKU_MAP.replace(/\.json$/, `.backup-${new Date().toISOString().slice(0, 10)}.json`);
  fs.copyFileSync(SKU_MAP, backup);
  let added = 0;
  for (const r of mapped) {
    if (map[r.asin]) continue;                       // never overwrite
    map[r.asin] = {
      api_sku: r.api_sku,
      prosol_sku: r.prosol_sku,
      product: r.product,
      brand: 'schluter',
      barcode: r.barcode || undefined,
      msrp_cad: r.msrp_cad ?? undefined,
      verified: r.tier === 'EAN',
      source: `map-gap-asins.js ${r.tier}`,
      note: `Auto-mapped ${new Date().toISOString().slice(0, 10)} from ${r.evidence}. Amazon title: "${String(r.title).slice(0, 90)}". Not yet order-verified.`,
    };
    added++;
  }
  mapDoc._updated = new Date().toISOString();
  fs.writeFileSync(SKU_MAP, JSON.stringify(mapDoc, null, 1));
  console.log(`\n✓ added ${added} mappings · backup at ${path.basename(backup)}`);
  console.log(`✓ wrote ${outPath}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
