#!/usr/bin/env node
/**
 * Raise live listings that sit below Schluter MAP up to MAP.
 *
 * Being under MAP risks authorized-reseller status and gives away margin for
 * nothing. The audit found 33 such listings, including two >$20K/yr ASINs
 * missing MAP by $0.05 and $1.35 — stale price data, not pricing decisions.
 *
 * Safety:
 *   - Re-reads each listing's LIVE price before patching. The listings report
 *     is a daily snapshot; acting on it blind can undo a deliberate change made
 *     since. If the live price is already >= MAP, the listing is skipped.
 *   - Raising price only. A computed target below the current price is a bug,
 *     and the script refuses rather than cutting a price.
 *   - Records buy-box position for large gaps, so what we traded is on record.
 *
 * Usage:
 *   node scripts/fba/map-correct.js                 # dry run
 *   node scripts/fba/map-correct.js --commit
 *   node scripts/fba/map-correct.js --commit --max-gap=5   # only trivial gaps
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'fba');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes('--' + k);
const COMMIT = flag('commit');
const MAX_GAP = arg('max-gap') != null ? Number(arg('max-gap')) : Infinity;
const BB_GAP = Number(arg('bb-gap', 20));      // record competitive position above this gap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newest = (dir, prefix) => {
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();

(async () => {
  const auditPath = newest(DATA, 'silent-losses-');
  if (!auditPath) { console.error('Run silent-losses-audit.js first.'); process.exit(1); }
  const candidates = JSON.parse(fs.readFileSync(auditPath, 'utf8')).belowMap || [];
  console.log(`audit: ${path.basename(auditPath)} — ${candidates.length} listings flagged below MAP`);

  const skuMap = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;
  const mapBy = {};
  for (const v of Object.values(skuMap)) {
    if (!v || typeof v !== 'object' || v.map_cad == null) continue;
    for (const f of ['prosol_sku', 'api_sku']) if (v[f]) mapBy[norm(v[f])] ??= Number(v.map_cad);
  }
  const mapFor = (asin, fallback) => {
    const e = skuMap[asin];
    if (e?.map_cad != null) return Number(e.map_cad);
    const ps = e?.prosol_sku || e?.api_sku;
    const m = ps ? mapBy[norm(ps)] : null;
    return m ?? fallback ?? null;
  };

  const plan = [];
  const skipped = [];

  for (const c of candidates) {
    const sku = String(c.sku).trim();
    const target = mapFor(c.asin, c.map);
    if (target == null) { skipped.push({ sku, why: 'no MAP resolved' }); continue; }

    // Live price beats the snapshot — someone may have repriced since.
    let live = null;
    try {
      const it = await sp.getListingsItem(sku, { includedData: 'summaries,offers' });
      live = Number(it?.offers?.[0]?.price?.amount);
      if (!Number.isFinite(live)) live = null;
    } catch (e) {
      skipped.push({ sku, why: `lookup failed: ${e.message.slice(0, 60)}` });
      await sleep(250);
      continue;
    }
    await sleep(250);

    if (live == null) { skipped.push({ sku, why: 'no live price on listing' }); continue; }
    if (live >= target - 0.005) { skipped.push({ sku, why: `already at/above MAP (live $${live.toFixed(2)} ≥ $${target.toFixed(2)})` }); continue; }

    const gap = +(target - live).toFixed(2);
    if (gap > MAX_GAP) { skipped.push({ sku, why: `gap $${gap} exceeds --max-gap=${MAX_GAP}` }); continue; }

    const row = { sku, asin: c.asin, live, target, gap, rev12: c.rev12, name: c.name };

    if (gap >= BB_GAP) {
      try {
        const raw = await sp.getItemOffers(c.asin);
        const p = raw?.payload || raw;
        const offers = (p?.Offers || []);
        const newOffers = offers.filter((o) => String(o.SubCondition || 'new').toLowerCase() === 'new');
        row.we_have_bb = offers.some((o) => o.IsBuyBoxWinner && o.MyOffer);
        row.lowest_new = Math.min(...newOffers.map((o) => Number(o.ListingPrice?.Amount) || Infinity));
        row.new_offer_count = newOffers.length;
        // Exclude our own offer: "lowest new" is usually us, and calling that a
        // competitor violation inverts the whole read of the risk.
        const rivals = newOffers.filter((o) => !o.MyOffer);
        row.rival_count = rivals.length;
        row.lowest_rival = rivals.length
          ? Math.min(...rivals.map((o) => Number(o.ListingPrice?.Amount) || Infinity))
          : null;
        row.competitor_below_map = row.lowest_rival != null && row.lowest_rival < target - 0.01;
        row.we_are_floor = row.lowest_rival == null || row.lowest_rival >= row.live;
      } catch { /* offers unavailable — not a blocker */ }
      await sleep(700);
    }
    plan.push(row);
  }

  console.log(`\n═══ ${COMMIT ? 'APPLYING' : 'DRY RUN —'} ${plan.length} price corrections ═══`);
  console.log('sku'.padEnd(20) + 'live'.padStart(10) + 'MAP'.padStart(10) + 'raise'.padStart(9) + 'rev12'.padStart(10) + '  note');
  for (const r of plan) {
    const note = r.gap >= BB_GAP
      ? (r.rival_count === 0
        ? 'large gap · no rival new offers — we set the floor'
        : `large gap · lowest rival $${r.lowest_rival?.toFixed(2)}${r.competitor_below_map ? ' ⚠ RIVAL UNDER MAP' : ''}`)
      : '';
    console.log(r.sku.padEnd(20) + ('$' + r.live.toFixed(2)).padStart(10) + ('$' + r.target.toFixed(2)).padStart(10) +
      ('+$' + r.gap.toFixed(2)).padStart(9) + ('$' + Math.round(r.rev12).toLocaleString()).padStart(10) + '  ' + note);
  }

  if (skipped.length) {
    console.log(`\n─── skipped (${skipped.length}) ───`);
    for (const s of skipped) console.log(`  ${String(s.sku).padEnd(20)} ${s.why}`);
  }

  const results = [];
  if (COMMIT) {
    console.log('\n─── applying ───');
    for (const r of plan) {
      try {
        const res = await sp.updateListingPrice(r.sku, r.target);
        const errs = (res.issues || []).filter((i) => i.severity === 'ERROR');
        console.log(`  ${errs.length ? '✗' : '✓'} ${r.sku.padEnd(20)} $${r.live.toFixed(2)} → $${r.target.toFixed(2)}${errs.length ? '  ' + errs.map((e) => `${e.code}: ${e.message}`).join('; ').slice(0, 100) : ''}`);
        results.push({ ...r, ok: !errs.length, issues: errs });
      } catch (e) {
        console.log(`  ✗ ${r.sku.padEnd(20)} ${e.message.slice(0, 110)}`);
        results.push({ ...r, ok: false, error: e.message });
      }
      await sleep(700);
    }
    const ok = results.filter((r) => r.ok).length;
    const recovered = results.filter((r) => r.ok).reduce((s, r) => s + r.gap, 0);
    console.log(`\n${ok}/${results.length} applied. Margin recovered: $${recovered.toFixed(2)} per unit across corrected listings.`);
  } else {
    console.log('\nDRY RUN — nothing changed. Re-run with --commit to apply.');
  }

  const out = path.join(DATA, `map-corrections-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), committed: COMMIT, plan, skipped, results }, null, 1));
  console.log(`✓ wrote ${out}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
