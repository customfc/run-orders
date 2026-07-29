#!/usr/bin/env node
/**
 * Enumerate a brand's ASINs on Amazon.ca with sales ranks.
 *
 * searchCatalogItems has no "list everything for this brand" mode and caps
 * pagination per query, so we sweep a list of keyword seeds (one per product
 * family) with brandNames pinned, and union the results by ASIN.
 *
 * The salesRanks on each hit are the only real demand signal we can get
 * without scraping — that is what ranks the "what should we list next" list
 * in schluter-catalog-audit.js.
 *
 * Usage:
 *   node scripts/fba/pull-amazon-brand-catalog.js                 # Schluter
 *   node scripts/fba/pull-amazon-brand-catalog.js --brand=Bona --seeds=bona,bona mega
 *
 * Output: data/fba/amazon-<brand>-catalog-YYYY-MM-DD.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'fba');
const MARKETPLACE = process.env.AMAZON_SP_MARKETPLACE_ID;
const PAGES_PER_SEED = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCHLUTER_SEEDS = [
  'schluter', 'ditra', 'ditra heat', 'ditra xl', 'ditra heat cable', 'ditra heat thermostat',
  'kerdi', 'kerdi board', 'kerdi drain', 'kerdi shower kit', 'kerdi band', 'kerdi shower tray',
  'kerdi line', 'kerdi fix', 'kerdi niche', 'kerdi tubkit', 'kerdi seal',
  'schluter rondec', 'schluter jolly', 'schluter quadec', 'schluter schiene', 'schluter dilex',
  'schluter trep', 'schluter reno', 'schluter deco', 'schluter finec', 'schluter vinpro',
  'schluter shelf', 'schluter niche', 'schluter profile', 'schluter edge trim', 'schluter tile trim',
  'schluter bara', 'schluter liprotec', 'schluter designbase', 'schluter kerdi shower',
  'schluter stair nosing', 'schluter movement joint', 'schluter drain grate', 'schluter primer',
  'schluter uncoupling membrane', 'schluter waterproofing', 'schluter heated floor',
];

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

async function searchPage(keywords, brand, pageToken) {
  // pageToken must accompany the ORIGINAL query params, not replace them.
  const query = {
    keywords,
    brandNames: brand,
    marketplaceIds: MARKETPLACE,
    includedData: 'summaries,salesRanks,identifiers',
    pageSize: 20,
  };
  if (pageToken) query.pageToken = pageToken;

  const raw = await sp.spApiRequest('GET', '/catalog/2022-04-01/items', { query });
  if (raw.status === 429) throw new Error('429 throttled');
  if (raw.status !== 200) throw new Error(`HTTP ${raw.status}: ${String(raw.body).slice(0, 200)}`);
  return JSON.parse(raw.body);
}

function shapeItem(it, seed) {
  const s = (it.summaries || [])[0] || {};
  const r = (it.salesRanks || [])[0] || {};
  const cat = (r.classificationRanks || [])[0] || {};
  const dept = (r.displayGroupRanks || [])[0] || {};
  const codes = (it.identifiers || [])
    .flatMap((m) => m.identifiers || [])
    .filter((x) => x.identifierType === 'EAN' || x.identifierType === 'UPC')
    .map((x) => x.identifier);
  return {
    asin: it.asin,
    title: s.itemName || '',
    brand: s.brand || '',
    category: (s.browseClassification || {}).displayName || '',
    cat_rank: cat.rank || null,
    cat_rank_title: cat.title || '',
    dept_rank: dept.rank || null,
    codes,
    seed,
  };
}

async function sweep(brand, seeds, { onSeed } = {}) {
  const found = new Map();
  for (const seed of seeds) {
    let token = null;
    for (let page = 0; page < PAGES_PER_SEED; page++) {
      let res = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { res = await searchPage(seed, brand, token); break; }
        catch (e) {
          if (/429/.test(e.message)) { await sleep(2500 * (attempt + 1)); continue; }
          console.error(`  "${seed}": ${e.message.slice(0, 120)}`);
          break;
        }
      }
      if (!res || !Array.isArray(res.items)) break;
      for (const it of res.items) {
        if (found.has(it.asin)) continue;
        const shaped = shapeItem(it, seed);
        const re = new RegExp(brand, 'i');
        if (!re.test(shaped.brand) && !re.test(shaped.title)) continue;
        found.set(it.asin, shaped);
      }
      token = res.pagination && res.pagination.nextToken;
      if (!token) break;
      await sleep(600);
    }
    if (onSeed) onSeed(seed, found.size);
    await sleep(600);
  }
  return [...found.values()];
}

async function main() {
  const args = parseArgs();
  const brand = args.brand || 'Schluter';
  const seeds = args.seeds ? String(args.seeds).split(',').map((s) => s.trim()) : SCHLUTER_SEEDS;

  const items = await sweep(brand, seeds, {
    onSeed: (s, n) => process.stdout.write(`  "${s}" → ${n} ASINs\n`),
  });

  const ranked = items.filter((i) => i.cat_rank).length;
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `amazon-${brand.toLowerCase()}-catalog-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ pulledAt: new Date().toISOString(), brand, count: items.length, ranked, items }, null, 1));

  console.log(`\n${items.length} distinct ${brand} ASINs on Amazon.ca (${ranked} carry a sales rank)`);
  console.log(`✓ wrote ${out}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { sweep, SCHLUTER_SEEDS };
