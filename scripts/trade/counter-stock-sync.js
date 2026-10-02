#!/usr/bin/env node
/**
 * Counter stock sync: Prosol stock at each pickup counter -> `pz-no-<CODE>` product tags, which the hide-shipping app
 * reads at checkout to drop "Pickup at our <X> trade counter" (lib/counter-stock.js; Mac 2026-10-02: "We cannot offer
 * a local pickup for a product that we do not have stock of at that location").
 *
 *   node scripts/trade/counter-stock-sync.js              dry run: reads Shopify + Prosol, writes the snapshot, prints
 *   node scripts/trade/counter-stock-sync.js --apply      also writes the tag changes (tagsAdd / tagsRemove)
 *   node scripts/trade/counter-stock-sync.js --limit 20   first 20 products only (testing)
 *   node scripts/trade/counter-stock-sync.js --compare 5  also checks 5 products against checkInventory (live sync)
 *
 * Products: ACTIVE products with variants in the delivery profiles whose zones carry counter rates (Prosol and "Local
 * pickup only" today; found by reading the zones, not hard-coded).
 * Prosol, gently (Mac 2026-10-02: don't get us locked out): one session, every request COUNTER_STOCK_GAP_MS apart
 * (default 2000). SKU -> Prosol product id is cached in data/trade/prosol-product-ids.json (seeded from the FBA stock
 * snapshots; misses looked up 40 SKUs a request, then one by one; not-found re-checked weekly), so a normal run is
 * only the stock calls: 30 products a request, limit=1000 rows, no sync_inventory. Prosol lists only in-stock
 * locations, so a missing one is 0.
 * Unknown stock (not at Prosol, lookup failed, no SKU) hides every counter for that product. More than 10% failed
 * lookups (Prosol down, session lost): nothing is written and the previous tags stay.
 * Snapshot: data/trade/counter-stock/<ts>.json (last 60 kept).
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cs = require('../../lib/counter-stock');

const ROOT = path.join(__dirname, '..', '..');
const SNAP_DIR = path.join(ROOT, 'data', 'trade', 'counter-stock');
const BRANCHES = path.join(ROOT, 'data', 'trade', 'pickup-branches.json');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');
const MAX_FAILED = 0.10;
const GAP_MS = Number(process.env.COUNTER_STOCK_GAP_MS) || 2000;
const ID_CACHE = path.join(ROOT, 'data', 'trade', 'prosol-product-ids.json');
const FBA_SNAPSHOTS = path.join(ROOT, 'data', 'fba', 'snapshots');
const RECHECK_MISSING_MS = 7 * 864e5;
const SKU_BATCH = 40;
const ID_BATCH = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gqlRetry(query, variables) {
  const { graphql } = require('../../lib/shopify-graphql');
  for (let i = 0; ; i++) {
    try { return (await graphql(query, variables)).data; } catch (e) {
      if (i >= 5 || !/throttl/i.test(e.message)) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

/** Delivery profile ids whose zones carry "Pickup at our ... trade counter" rates. */
async function pickupProfiles(gql) {
  const d = await gql(`{ deliveryProfiles(first: 30) { nodes { id name profileLocationGroups { locationGroupZones(first: 60) {
    nodes { methodDefinitions(first: 40) { nodes { name } } } } } } } }`);
  return d.deliveryProfiles.nodes.filter((p) => p.profileLocationGroups.some((g) => g.locationGroupZones.nodes.some((z) =>
    z.methodDefinitions.nodes.some((m) => /^Pickup at our .+ trade counter$/.test(m.name))))).map((p) => ({ id: p.id, name: p.name }));
}

/** ACTIVE products with their variants in the given profiles: [{ id, title, tags, variants: [{ id, sku }] }]. */
async function profileProducts(gql, profileIds) {
  const byId = new Map();
  const counts = { items: 0, inactive: 0, overflow: 0 };
  const want = new Set(profileIds);
  for (const pid of profileIds) {
    let after = null;
    do {
      const d = await gql(`query($id: ID!, $a: String) { deliveryProfile(id: $id) { profileItems(first: 8, after: $a) {
        pageInfo { hasNextPage endCursor }
        nodes { product { id title tags status } variants(first: 100) { pageInfo { hasNextPage } nodes { id sku barcode } } } } } }`, { id: pid, a: after });
      const page = d.deliveryProfile.profileItems;
      for (const it of page.nodes) {
        counts.items++;
        if (it.product.status !== 'ACTIVE') { counts.inactive++; continue; }
        let variants = it.variants.nodes;
        if (it.variants.pageInfo.hasNextPage) {
          // More than 100 variants of one product in the profile: take them from the product, kept to these profiles.
          counts.overflow++;
          variants = [];
          let va = null;
          do {
            const v = await gql(`query($id: ID!, $a: String) { product(id: $id) { variants(first: 100, after: $a) { pageInfo { hasNextPage endCursor }
              nodes { id sku barcode deliveryProfile { id } } } } }`, { id: it.product.id, a: va });
            variants.push(...v.product.variants.nodes.filter((x) => x.deliveryProfile && want.has(x.deliveryProfile.id)));
            va = v.product.variants.pageInfo.hasNextPage ? v.product.variants.pageInfo.endCursor : null;
          } while (va);
        }
        const p = byId.get(it.product.id) || { id: it.product.id, title: it.product.title, tags: it.product.tags, variants: [] };
        for (const v of variants) if (!p.variants.some((x) => x.id === v.id)) p.variants.push({ id: v.id, sku: v.sku || null, barcode: v.barcode || null });
        byId.set(it.product.id, p);
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return { products: [...byId.values()], counts };
}

/** FBA stock snapshots already know many Prosol product ids: { sku: productId }. */
function snapshotIds(dir = FBA_SNAPSHOTS) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^prosol-stock-.*\.json$/.test(x)).sort()) {
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).skus || {})) if (v && v.productId) out[k] = v.productId; } catch {}
  }
  return out;
}

/**
 * Stock for every code at every Prosol location.
 * -> { lookups: { prosolSku: { apiSku, status: ok|not_found|failed, productId?, stock? } },
 *      requests: { ids, stock, compare }, pullSec, comparison }
 */
async function pullStock(codesList, { log = () => {}, makeClient, gapMs = GAP_MS, idCache = ID_CACHE, snapshots = FBA_SNAPSHOTS, compare = 0, now = Date.now() } = {}) {
  const mk = makeClient || (() => new (require('../shipstation/prosol-client-v2').ProsolClientV2)());
  const started = Date.now();
  const requests = { ids: 0, stock: 0, compare: 0 };
  let phase = 'ids';
  let last = 0;
  let lastStatus = 0;
  let client;
  async function open() {
    client = mk();
    await client.init();
    const raw = client.apiGet.bind(client);
    client.apiGet = async (url) => { // every Prosol call (ours, getProductId's, checkInventory's) is paced and counted
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      requests[phase]++;
      lastStatus = 0;
      const r = await raw(url);
      lastStatus = r.status;
      return r;
    };
  }
  async function getJson(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await client.apiGet(url); } catch (e) { r = { status: 0, body: e.message }; }
      if (r.status === 200) { try { return JSON.parse(r.body); } catch {} }
      if (attempt === 0) {
        log(`Prosol ${r.status || r.body} on ${url.slice(0, 80)}: retrying`);
        if (r.status === 401 || r.status === 419) { try { await client.close(); } catch {} await open(); } else if (gapMs) await sleep(Math.max(gapMs, 5000));
      }
    }
    return null;
  }
  async function allPages(urlFor) {
    const rows = [];
    for (let page = 1; ; page++) {
      const j = await getJson(urlFor(page));
      if (!j) return null;
      rows.push(...(j.data || []));
      if (page >= (j.last_page || (j.meta && j.meta.last_page) || 1)) return rows;
    }
  }

  await open();
  const out = {};
  try {
    // 1. SKU -> Prosol product id: the cache, seeded from the FBA snapshots; misses batched, then one by one
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(idCache, 'utf8')); } catch {}
    const seed = snapshotIds(snapshots);
    let seeded = 0;
    for (const c of codesList) {
      if (cache[c.prosolSku]) continue;
      const id = seed[c.apiSku] || seed[c.prosolSku];
      if (id) { cache[c.prosolSku] = { id, via: 'fba-snapshot', at: new Date(now).toISOString() }; seeded++; }
    }
    const stale = (e) => !e || (!e.id && now - Date.parse(e.at || 0) > RECHECK_MISSING_MS);
    const misses = codesList.filter((c) => stale(cache[c.prosolSku]));
    const found = new Map();
    const failedCodes = new Set(); // Prosol didn't answer: not cached (a "not found" would stick for a week), retried next run
    for (const field of ['apiSku', 'prosolSku']) { // exact SKU matches 40 a request; a SKU two products share goes one by one
      const todo = misses.filter((c) => !found.has(c.prosolSku) && !failedCodes.has(c.prosolSku) && c[field] && !c[field].includes(',') && (field === 'apiSku' || c.prosolSku !== c.apiSku));
      for (let i = 0; i < todo.length; i += SKU_BATCH) {
        const batch = todo.slice(i, i + SKU_BATCH);
        const rows = await allPages((page) => `/api/storefront/products?filter[sku]=${encodeURIComponent(batch.map((c) => c[field]).join(','))}&limit=100&page=${page}`);
        if (!rows) { batch.forEach((c) => failedCodes.add(c.prosolSku)); continue; }
        for (const c of batch) {
          const hits = [...new Set(rows.filter((p) => String(p.sku || '').toUpperCase() === c[field].toUpperCase()).map((p) => p.id))];
          if (hits.length === 1) found.set(c.prosolSku, { id: hits[0], via: field });
        }
      }
    }
    // One by one (sku-map pins for shared SKUs, the search fallback: 2 to 4 requests each) only for codes never looked
    // up; the weekly re-check of known not-found codes stays batched.
    for (const c of misses.filter((x) => !found.has(x.prosolSku) && !failedCodes.has(x.prosolSku) && !cache[x.prosolSku])) {
      let id = null;
      try {
        for (const sku of [...new Set([c.apiSku, c.prosolSku])]) {
          id = await client.getProductId(sku);
          if (id) break;
          if (lastStatus !== 200) throw new Error(`HTTP ${lastStatus}`);
        }
        found.set(c.prosolSku, { id: id || null, via: 'getProductId' });
      } catch { failedCodes.add(c.prosolSku); }
    }
    for (const c of misses) if (!found.has(c.prosolSku) && !failedCodes.has(c.prosolSku)) found.set(c.prosolSku, { id: null, via: 'batch' });
    for (const [k, v] of found) cache[k] = { ...v, at: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(idCache), { recursive: true });
    fs.writeFileSync(idCache, JSON.stringify(cache, null, 1));
    log(`product ids: ${codesList.length - misses.length} cached (${seeded} seeded from FBA snapshots), ${misses.length} looked up (${[...found.values()].filter((x) => x.id).length} found) in ${requests.ids} requests`);

    // 2. stock at every location, 30 products a request, no live sync
    phase = 'stock';
    const productIds = [...new Set(codesList.map((c) => cache[c.prosolSku] && cache[c.prosolSku].id).filter(Boolean))];
    const stockById = new Map();
    const failedIds = new Set();
    for (let i = 0; i < productIds.length; i += ID_BATCH) {
      const batch = productIds.slice(i, i + ID_BATCH);
      // COUNTER_STOCK_SYNC=1 adds sync_inventory=true (same request count; Prosol refreshes each product first). Off, the
      // numbers can lag: 2026-10-02, 3 of 4 samples were off by 1 to 3 at a counter, both ways, and a synced batch
      // matched checkInventory every time.
      const rows = await allPages((page) => `/api/storefront/product_inventory_items?filter[product_id]=${batch.join(',')}&filter[where_is_in_stock]=true${process.env.COUNTER_STOCK_SYNC === '1' ? '&sync_inventory=true' : ''}&limit=1000&page=${page}`);
      if (!rows) { batch.forEach((id) => failedIds.add(Number(id))); continue; }
      for (const id of batch) stockById.set(Number(id), {});
      for (const r of rows) {
        const s = stockById.get(Number(r.product_id));
        if (!s || !r.product_inventory_location_id) continue;
        const loc = String(r.product_inventory_location_id);
        s[loc] = (s[loc] || 0) + (Number(r.available) || 0);
      }
    }
    for (const c of codesList) {
      const id = cache[c.prosolSku] && cache[c.prosolSku].id;
      if (failedCodes.has(c.prosolSku)) out[c.prosolSku] = { apiSku: c.apiSku, status: 'failed', error: 'product id lookup' };
      else if (!id) out[c.prosolSku] = { apiSku: c.apiSku, status: 'not_found' };
      else if (failedIds.has(Number(id))) out[c.prosolSku] = { apiSku: c.apiSku, status: 'failed', productId: id, error: 'stock request' };
      else out[c.prosolSku] = { apiSku: c.apiSku, status: 'ok', productId: id, stock: stockById.get(Number(id)) || {} };
    }

    // 3. optional check: the batched numbers (no live sync) against checkInventory (sync_inventory=true)
    let comparison = null;
    if (compare) {
      phase = 'compare';
      comparison = [];
      for (const [k, r] of Object.entries(out).filter(([, x]) => x.status === 'ok' && Object.keys(x.stock).length >= 3).slice(0, compare)) {
        const inv = await client.checkInventory(r.apiSku);
        const live = {};
        for (const [loc, v] of Object.entries((inv && inv.locationStock) || {})) if (Number(v.quantity) > 0) live[loc] = Number(v.quantity);
        const locs = [...new Set([...Object.keys(live), ...Object.keys(r.stock).filter((l) => r.stock[l] > 0)])];
        const diffs = locs.filter((l) => (live[l] || 0) !== (r.stock[l] || 0)).map((l) => `${l}: batch ${r.stock[l] || 0} live ${live[l] || 0}`);
        comparison.push({ sku: k, apiSku: r.apiSku, productId: r.productId, inv: !!inv, locations: locs.length, match: !!inv && !diffs.length, diffs });
      }
    }
    return { lookups: out, requests, pullSec: Math.round((Date.now() - started) / 1000), comparison };
  } finally { try { await client.close(); } catch {} }
}

function prune(dir, keep = 60) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
}

/**
 * -> { summary, snapshotPath }. apply=false never writes to Shopify.
 */
async function sfVendorCodes(names) {
  const sf = require('../../lib/salesforce');
  const conn = await sf.connect();
  const out = new Map();
  for (let i = 0; i < names.length; i += 150) {
    const list = names.slice(i, i + 150).map((n) => `'${String(n).replace(/\\/g, '').replace(/'/g, "\\'")}'`).join(',');
    const rows = await sf.query(conn, `SELECT Name, PBSI__Vendor_Item_ID__c FROM PBSI__PBSI_Item__c WHERE Name IN (${list})`);
    for (const r of rows) if (r.PBSI__Vendor_Item_ID__c && !out.has(r.Name)) out.set(r.Name, r.PBSI__Vendor_Item_ID__c);
  }
  return out;
}

async function syncCounterStock({ apply = false, limit = 0, compare = 0, log = console.log, gql = gqlRetry, makeClient, sfItems, snapDir = SNAP_DIR, gapMs = GAP_MS, idCache = ID_CACHE, snapshots = FBA_SNAPSHOTS } = {}) {
  const started = Date.now();
  const counters = cs.countersFrom(JSON.parse(fs.readFileSync(BRANCHES, 'utf8')).branches);
  const profiles = await pickupProfiles(gql);
  if (!profiles.length) throw new Error('no delivery profile carries counter pickup rates');
  const { products: all, counts } = await profileProducts(gql, profiles.map((p) => p.id));
  const products = limit ? all.slice(0, limit) : all;
  const map = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings || {};
  const { prosolCodes } = require('../../lib/pickup-runner');
  const sm = require('../../lib/schluter-map');
  const csvPath = sm.latestCsvPath();
  const schluter = csvPath ? sm.loadMap(csvPath) : null;
  const upcIndex = schluter ? new Map([...schluter.byUpc].map(([upc, r]) => [upc, r.item])) : null;
  const itemIndex = schluter ? new Map(schluter.records.map((r) => [cs.itemKey(r.item), r.item])) : null;
  // Salesforce PBSI items are named by the Shopify SKU and carry the vendor code (read only).
  let sfIndex = null;
  const unmapped = [...new Set(products.flatMap((p) => p.variants.map((v) => v.sku)).filter((k) => k && !map[k]))];
  try { sfIndex = await (sfItems || sfVendorCodes)(unmapped); } catch (e) { log(`Salesforce item lookup failed, skipped: ${e.message}`); }
  if (!upcIndex) log('no Schluter MAP CSV in data/fba/maps: Schluter variants not in the sku-map resolve by their raw SKU');
  const via = {};
  let noSku = 0;
  for (const p of products) for (const v of p.variants) {
    if (!v.sku) noSku++;
    Object.assign(v, cs.codesFor(v, { map, upcIndex, sfIndex, itemIndex, prosolCodes }));
    via[v.via] = (via[v.via] || 0) + 1;
  }
  const codes = new Map();
  for (const p of products) for (const v of p.variants) if (v.prosolSku && !codes.has(v.prosolSku)) codes.set(v.prosolSku, { apiSku: v.apiSku, prosolSku: v.prosolSku });
  log(`${products.length} products, ${products.reduce((n, p) => n + p.variants.length, 0)} variants, ${codes.size} SKUs, ${counters.length} counters (profiles: ${profiles.map((p) => p.name).join(', ')})`);

  const { lookups, requests, pullSec, comparison } = await pullStock([...codes.values()], { log, makeClient, gapMs, idCache, snapshots, compare });
  const by = (s) => Object.entries(lookups).filter(([, r]) => r.status === s);
  const failed = by('failed');
  const notFound = by('not_found');
  const stockBySku = Object.fromEntries(Object.entries(lookups).map(([k, r]) => [k, r.status === 'ok' ? r.stock : null]));
  const changes = cs.computeTags({ products, stockBySku, counters });
  const failRate = codes.size ? failed.length / codes.size : 0;
  const aborted = failRate > MAX_FAILED ? `${failed.length} of ${codes.size} lookups failed (${Math.round(failRate * 100)}%), over ${MAX_FAILED * 100}%: nothing written` : null;

  const perCounter = counters.map((c) => {
    const t = cs.tagFor(c.code);
    return { code: c.code, hidden: changes.filter((x) => x.want.includes(t)).length, add: changes.filter((x) => x.add.includes(t)).length, remove: changes.filter((x) => x.remove.some((r) => r.toUpperCase() === t.toUpperCase())).length };
  });
  const toWrite = changes.filter((x) => x.add.length || x.remove.length);
  let written = 0;
  const writeErrors = [];
  if (apply && !aborted) {
    for (const x of toWrite) {
      try {
        if (x.add.length) {
          const r = await gql(`mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { message } } }`, { id: x.id, t: x.add });
          if (r.tagsAdd.userErrors.length) throw new Error(r.tagsAdd.userErrors.map((e) => e.message).join('; '));
        }
        if (x.remove.length) {
          const r = await gql(`mutation($id: ID!, $t: [String!]!) { tagsRemove(id: $id, tags: $t) { userErrors { message } } }`, { id: x.id, t: x.remove });
          if (r.tagsRemove.userErrors.length) throw new Error(r.tagsRemove.userErrors.map((e) => e.message).join('; '));
        }
        written++;
      } catch (e) { writeErrors.push({ id: x.id, title: x.title, error: e.message }); }
    }
  }

  const summary = {
    mode: apply ? (aborted ? 'apply-aborted' : 'apply') : 'dry-run', runtimeSec: Math.round((Date.now() - started) / 1000),
    profiles: profiles.map((p) => p.name), profileItems: counts.items, inactiveSkipped: counts.inactive, variantOverflow: counts.overflow,
    products: products.length, skus: codes.size, variantsWithoutSku: noSku, resolvedVia: via,
    lookups: { ok: by('ok').length, notFound: notFound.length, failed: failed.length }, prosolRequests: requests, pullSec, gapMs, comparison, aborted,
    productsChanging: toWrite.length, written, writeErrors: writeErrors.length, perCounter,
    pickupAnywhere: changes.filter((x) => x.want.length < counters.length).length,
  };
  fs.mkdirSync(snapDir, { recursive: true });
  const snapshotPath = path.join(snapDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({ at: new Date().toISOString(), summary, counters, lookups,
    products: products.map((p) => ({ id: p.id, title: p.title, variants: p.variants.map((v) => ({ sku: v.sku, barcode: v.barcode, prosolSku: v.prosolSku, via: v.via })) })),
    changes: toWrite, writeErrors }, null, 1));
  prune(snapDir);
  return { summary, snapshotPath, notFound, failed, changes, products };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) || 0 : 0; };
  syncCounterStock({ apply, limit: arg('--limit'), compare: arg('--compare') }).then(({ summary, snapshotPath, notFound, failed, changes, products }) => {
    const titleOf = (sku) => { const p = products.find((x) => x.variants.some((v) => v.prosolSku === sku)); return p ? p.title : '?'; };
    console.log(`\n${summary.mode}: ${summary.runtimeSec}s. ${summary.products} products (${summary.profileItems} profile items, ${summary.inactiveSkipped} not active), ${summary.skus} SKUs, ${summary.variantsWithoutSku} variants without a SKU`);
    console.log(`Variant codes from: ${Object.entries(summary.resolvedVia).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    const rq = summary.prosolRequests;
    console.log(`Prosol requests: ${rq.ids} id lookups + ${rq.stock} stock${rq.compare ? ` + ${rq.compare} compare` : ''}, Prosol part ${summary.pullSec}s at ${summary.gapMs} ms apart`);
    if (summary.comparison) console.log(`Batched (no live sync) vs checkInventory (live sync):\n${summary.comparison.map((x) => `  ${x.apiSku}: ${x.match ? 'match' : `DIFF ${x.inv ? x.diffs.join('; ') : 'checkInventory returned nothing'}`} (${x.locations} locations)`).join('\n')}`);
    console.log(`Prosol lookups: ${summary.lookups.ok} ok, ${summary.lookups.notFound} not at Prosol, ${summary.lookups.failed} failed${summary.aborted ? `\nABORTED: ${summary.aborted}` : ''}`);
    console.log(`Products with pickup at one or more counters: ${summary.pickupAnywhere} of ${summary.products}`);
    console.log('\nCounter  hidden  +tags  -tags');
    for (const c of summary.perCounter) console.log(`${c.code.padEnd(8)} ${String(c.hidden).padStart(6)} ${String(c.add).padStart(6)} ${String(c.remove).padStart(6)}`);
    console.log(`\n${summary.productsChanging} products would change${summary.mode === 'apply' ? `, ${summary.written} written, ${summary.writeErrors} errors` : ''}.`);
    if (notFound.length) console.log(`\nNot at Prosol (first 15): ${notFound.slice(0, 15).map(([k, r]) => `${r.apiSku}${r.apiSku !== k ? `/${k}` : ''} (${titleOf(k).slice(0, 50)})`).join('; ')}`);
    if (failed.length) console.log(`\nFailed (first 10): ${failed.slice(0, 10).map(([k, r]) => `${k}: ${r.error}`).join('; ')}`);
    const ex = changes.filter((x) => x.want.length && x.want.length < 17).slice(0, 5);
    if (ex.length) console.log(`\nExamples:\n${ex.map((x) => `  ${x.title.slice(0, 60)}: hidden at ${x.want.map((t) => t.slice(6)).join(' ')}`).join('\n')}`);
    console.log(`\nSnapshot: ${path.relative(ROOT, snapshotPath)}`);
    if (summary.aborted) process.exitCode = 2;
  }).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { syncCounterStock, pickupProfiles, profileProducts, pullStock, snapshotIds, GAP_MS };
