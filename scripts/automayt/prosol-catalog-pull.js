#!/usr/bin/env node
/**
 * Pull Prosol's catalogue for the Automayt import (read-only against Prosol).
 *
 *   node scripts/automayt/prosol-catalog-pull.js                 # lists: manufacturers, categories, products, stock, then build
 *   node scripts/automayt/prosol-catalog-pull.js --phase=costs --limit=300
 *   node scripts/automayt/prosol-catalog-pull.js --phase=costs --skip-in-salesforce   # every new product that passes the rule (about 5 h; resumable)
 *   node scripts/automayt/prosol-catalog-pull.js --phase=sf      # read-only Salesforce item codes for the dedupe
 *
 * Options: --date=YYYY-MM-DD (snapshot folder, default today Pacific),
 *          --min-locations=2, --pause-ms=1500 (between list pages),
 *          --rps=1 (cost calls per second), --limit=N (cost calls this run).
 *
 * Output: data/prosol-catalog/<date>/
 *   manufacturers.json, categories.json, products/page-NNNN.json, stock/page-NNNN.json  (raw-but-slim pages; a re-run skips pages already saved)
 *   catalog.json   one record per product: codes, names, prices, location count, as-of, rule verdict
 *   costs.jsonl    one line per priced product (append-only; a re-run skips ids already priced)
 *   sf-items.json  Salesforce PBSI item codes (phase sf)
 *
 * What the probes found (2026-10-14):
 * - /api/storefront/products?append=prosol_sku pages at 250 in about 2 s (229 pages for 57k);
 *   adding append=is_clearance 504s at any size, so clearance is not pulled.
 * - Our cost exists only on /products/{id}/offers (current_price, cents; one product per call;
 *   other filters 500 or are ignored). include=productOffers returns every Prosol customer's
 *   offers (about 3,000 per product, 6 MB) and must not be used.
 * - /product_inventory_items?filter[where_is_in_stock]=true pages every in-stock location row
 *   for the whole catalogue (about 128k rows, 128 pages at 1000). On these raw rows `available`
 *   is the unit count (77 distinct values on one page); the "available is always 1" gotcha
 *   (project_prosol_stock_total_bug) is the derived inStock flag in checkInventory, not this field.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');
const pc = require('../../lib/prosol-catalog');

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const todayPacific = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function parse(res) {
  if (!res || res.status !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

const REQUEST_TIMEOUT_MS = 90_000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: 'timeout', body: '' }), ms))]);

async function getJson(client, url, { tries = 4 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const res = await withTimeout(client.apiGet(url), REQUEST_TIMEOUT_MS);
    const json = parse(res);
    if (json) return json;
    last = res && res.status;
    // 401/419: session expired; log in again. 429/5xx/timeouts: back off.
    if (last === 401 || last === 419) await client.init();
    await sleep(5000 * (i + 1));
  }
  throw new Error(`Prosol GET ${url} failed (last status ${last})`);
}

/** Page a list route into dir/page-NNNN.json, skipping pages already saved. Returns total rows. */
async function pageList(client, { dir, url, limit, pauseMs, slim, label }) {
  fs.mkdirSync(dir, { recursive: true });
  let lastPage = null;
  let rows = 0;
  for (let page = 1; lastPage === null || page <= lastPage; page++) {
    const file = path.join(dir, `page-${String(page).padStart(4, '0')}.json`);
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      lastPage = saved.last_page;
      rows += saved.rows.length;
      continue;
    }
    const json = await getJson(client, `${url}${url.includes('?') ? '&' : '?'}limit=${limit}&page=${page}`);
    if (!Array.isArray(json.data)) throw new Error(`${label} page ${page}: no data array`);
    lastPage = (json.meta && json.meta.last_page) || page;
    const out = { page, last_page: lastPage, total: json.meta && json.meta.total, at: new Date().toISOString(), rows: json.data.map(slim) };
    fs.writeFileSync(file, JSON.stringify(out));
    rows += out.rows.length;
    log(`${label} page ${page}/${lastPage}: +${out.rows.length} (${rows})`);
    if (!json.data.length) break;
    await sleep(pauseMs);
  }
  return rows;
}

function readPages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^page-\d+\.json$/.test(f)).sort()
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rows);
}

async function pullLists(client, snapDir, { pauseMs }) {
  // Manufacturers and categories are small reference lists.
  const mfrFile = path.join(snapDir, 'manufacturers.json');
  if (!fs.existsSync(mfrFile)) {
    const all = [];
    for (let page = 1; page < 50; page++) {
      const json = await getJson(client, `/api/storefront/product_manufacturers?limit=1000&page=${page}`);
      all.push(...json.data.map((m) => ({ id: m.id, code: m.code, name: (m.name && (m.name.en || m.name.fr)) || m.code, active: m.active })));
      if (!json.meta || page >= json.meta.last_page) break;
      await sleep(pauseMs);
    }
    fs.writeFileSync(mfrFile, JSON.stringify(all));
    log(`manufacturers: ${all.length}`);
  }
  const catFile = path.join(snapDir, 'categories.json');
  if (!fs.existsSync(catFile)) {
    const all = [];
    for (let page = 1; page < 50; page++) {
      const json = await getJson(client, `/api/storefront/product_categories?limit=1000&page=${page}`);
      all.push(...json.data.map((c) => ({ id: c.id, code: c.code, parent_id: c.parent_id, name: (c.name && (c.name.en || c.name.fr)) || c.code, active: c.active })));
      if (!json.meta || page >= json.meta.last_page) break;
      await sleep(pauseMs);
    }
    fs.writeFileSync(catFile, JSON.stringify(all));
    log(`categories: ${all.length}`);
  }

  const products = await pageList(client, {
    dir: path.join(snapDir, 'products'),
    // append=is_clearance 504s on any page size; prosol_sku alone is ~2 s per 250.
    url: '/api/storefront/products?append=prosol_sku',
    limit: 250,
    pauseMs,
    slim: pc.slimProduct,
    label: 'products',
  });
  const stock = await pageList(client, {
    dir: path.join(snapDir, 'stock'),
    url: '/api/storefront/product_inventory_items?filter[where_is_in_stock]=true&include=productInventoryLocation',
    limit: 1000,
    pauseMs,
    slim: pc.slimStockRow,
    label: 'stock',
  });
  log(`lists done: ${products} products, ${stock} in-stock location rows`);
}

function build(snapDir, { minLocations, asOf }) {
  const products = readPages(path.join(snapDir, 'products'));
  const stockRows = readPages(path.join(snapDir, 'stock'));
  const manufacturers = JSON.parse(fs.readFileSync(path.join(snapDir, 'manufacturers.json'), 'utf8'));
  const categories = JSON.parse(fs.readFileSync(path.join(snapDir, 'categories.json'), 'utf8'));
  const catalog = pc.buildCatalog({ products, stockRows, manufacturers, categories, minLocations, asOf });
  fs.writeFileSync(path.join(snapDir, 'catalog.json'), JSON.stringify(catalog));
  const locations = pc.locationTable(stockRows);
  fs.writeFileSync(path.join(snapDir, 'locations.json'), JSON.stringify(locations, null, 1));
  const s = pc.summarize(catalog.records, { minLocations });
  fs.writeFileSync(path.join(snapDir, 'summary.json'), JSON.stringify({ ...s, asOf, locations: locations.length, stockRows: stockRows.length }, null, 1));
  log(`catalog.json: ${catalog.records.length} products; ${JSON.stringify(s)}`);
  return catalog;
}

async function pullCosts(client, snapDir, { rps, limit, minLocations, all, skipInSalesforce }) {
  const catalog = JSON.parse(fs.readFileSync(path.join(snapDir, 'catalog.json'), 'utf8'));
  const costFile = path.join(snapDir, 'costs.jsonl');
  const done = new Set(pc.readJsonl(costFile).map((r) => r.id));
  // --skip-in-salesforce: products already a Salesforce item migrate on their own, so only price the new ones.
  let inSf = new Set();
  if (skipInSalesforce) {
    const sfItems = JSON.parse(fs.readFileSync(path.join(snapDir, 'sf-items.json'), 'utf8'));
    const { results } = pc.dedupeAgainstSf(catalog.records, sfItems, { prosolVendorId: '0014x00001P1ScCAAV' }); // Salesforce "Prosol Inc."
    inSf = new Set([...results.entries()].filter(([, v]) => v.status !== 'new').map(([id]) => id));
  }
  const todo = catalog.records
    .filter((r) => all || (r.locations >= minLocations && !r.discontinued))
    .filter((r) => !done.has(r.id) && !inSf.has(r.id));
  const n = limit ? Math.min(Number(limit), todo.length) : todo.length;
  const gap = Math.max(250, Math.round(1000 / Number(rps || 1)));
  log(`costs: ${done.size} priced already, ${todo.length} to go, this run ${n} at ~${(1000 / gap).toFixed(2)}/s (about ${Math.round((n * (gap + 600)) / 60000)} min)`);
  // Spread a partial run across the list so a slice is representative, not just the first ids.
  const pick = limit ? pc.spread(todo, n) : todo;
  const bc = pc.bcLocationIds(JSON.parse(fs.readFileSync(path.join(snapDir, 'locations.json'), 'utf8')));
  let ok = 0; let miss = 0;
  for (const r of pick) {
    let offer = null; let error = null; let tried = [];
    for (const loc of pc.priceLocations(r, { bcLocationIds: bc })) {
      tried.push(loc);
      try { offer = await withTimeout(client.getOfferPrice(r.id, loc), REQUEST_TIMEOUT_MS); } catch (e) { error = e.message; }
      if (offer && offer.status === 'timeout') { offer = null; error = 'timeout'; }
      if (offer) break;
      await sleep(gap);
    }
    if (!offer && tried.length === 1 && !error) {
      // A lone miss can be an expired session; re-login once and retry before recording it.
      try { await client.init(); offer = await client.getOfferPrice(r.id, tried[0]); } catch (e) { error = e.message; }
    }
    const line = { id: r.id, at: new Date().toISOString(), cost: offer ? offer.cost_cad : null, retail: offer ? offer.retail_cad : null, source: offer ? offer.costSource : null, tried, error };
    fs.appendFileSync(costFile, JSON.stringify(line) + '\n');
    if (offer) ok++; else miss++;
    if ((ok + miss) % 50 === 0) log(`  priced ${ok + miss}/${n} (${miss} without a price)`);
    await sleep(gap);
  }
  log(`costs: ${ok} priced, ${miss} without a price`);
}

async function pullSf(snapDir) {
  const sf = require('../../lib/salesforce');
  const conn = await sf.connect();
  const soql = `SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor__c, PBSI__Default_Vendor_Name__c,
    PBSI__Item_Status__c, PBSI__UPC_Code__c, Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
    FROM PBSI__PBSI_Item__c`;
  const rows = [];
  let res = await conn.query(soql);
  rows.push(...res.records);
  while (!res.done) { res = await conn.queryMore(res.nextRecordsUrl); rows.push(...res.records); }
  const slim = rows.map((r) => ({
    id: r.Id, name: r.Name, vendorItemId: r.PBSI__Vendor_Item_ID__c, vendorId: r.PBSI__Default_Vendor__c,
    vendorName: r.PBSI__Default_Vendor_Name__c, status: r.PBSI__Item_Status__c, upc: r.PBSI__UPC_Code__c,
    uom: r.Unit_of_Measure__c || r.PBSI__defaultunitofmeasure__c, description: r.PBSI__description__c,
  }));
  fs.writeFileSync(path.join(snapDir, 'sf-items.json'), JSON.stringify(slim));
  log(`sf-items.json: ${slim.length} PBSI items (read-only)`);
}

async function main() {
  const args = parseArgs();
  const phase = args.phase || 'lists';
  const date = args.date || todayPacific();
  const snapDir = path.join(__dirname, '..', '..', 'data', 'prosol-catalog', date);
  fs.mkdirSync(snapDir, { recursive: true });
  const minLocations = Number(args['min-locations'] || 2);
  const pauseMs = Number(args['pause-ms'] || 1500);

  if (phase === 'build') return build(snapDir, { minLocations, asOf: date });
  if (phase === 'sf') return pullSf(snapDir);

  const client = new ProsolClientV2();
  await client.init();
  try {
    if (phase === 'lists') {
      await pullLists(client, snapDir, { pauseMs });
      build(snapDir, { minLocations, asOf: date });
    } else if (phase === 'costs') {
      await pullCosts(client, snapDir, { rps: args.rps || 1, limit: args.limit, minLocations, all: !!args.all, skipInSalesforce: !!args['skip-in-salesforce'] });
    } else {
      throw new Error(`unknown --phase=${phase}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
