#!/usr/bin/env node
/**
 * Counter stock sync: Prosol stock -> Shopify inventory at each counter location (Shopify's own pickup offers a counter
 * only when it can fill the cart there) and, for Prosol-profile variants, "don't sell when out of stock" with their
 * shipping stock = Prosol's network total at the pool location (lib/counter-stock.js planLocations; Mac 2026-10-02:
 * "We cannot offer a local pickup for a product that we do not have stock of at that location", "we don't want to sell
 * things that are out of stock"). Counter locations: scripts/trade/native-counters.js.
 *
 *   node scripts/trade/counter-stock-sync.js              dry run: reads Shopify + Prosol, writes the snapshot, prints
 *   node scripts/trade/counter-stock-sync.js --apply      also writes the inventory, activations and policies
 *   node scripts/trade/counter-stock-sync.js --limit 20   first 20 products only (testing)
 *   node scripts/trade/counter-stock-sync.js --compare 5  also checks 5 products against checkInventory (live sync)
 *
 * Products: ACTIVE products with variants in the Prosol profile (pooled: DENY + network total) and the "Local pickup
 * only" profile (full-length trims: Coast pickup ships off Sechelt/PR, so their policy and shipping stock stay; they
 * are gated at counters by being stocked there or not).
 * Prosol, gently (Mac 2026-10-02: don't get us locked out): one session, every request COUNTER_STOCK_GAP_MS apart
 * (default 2000). SKU -> Prosol product id is cached in data/trade/prosol-product-ids.json (seeded from the FBA stock
 * snapshots; misses looked up 40 SKUs a request, then one by one; not-found re-checked weekly), so a normal run is
 * only the stock calls: 30 products a request, limit=1000 rows, no sync_inventory. Prosol lists only in-stock
 * locations, so a missing one is 0.
 * Not at Prosol or no SKU: never stocked at a counter (so never offered pickup), policy and shipping stock untouched.
 * A failed lookup leaves that variant as it is this run. More than 10% failed (Prosol down, session lost): nothing is
 * written.
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
// The pickup products and how they're stocked (2026-10-02). Shipping pool: Calgary Warehouse carries the Prosol network
// total; the other shipping warehouses' placeholder counts go to 0 for these variants. Sechelt / Powell River untouched.
const PROFILES = [
  { id: 'gid://shopify/DeliveryProfile/102840008871', name: 'Prosol', pooled: true },
  { id: 'gid://shopify/DeliveryProfile/106780786855', name: 'Local pickup only', pooled: false },
];
const POOL = {
  locationId: 'gid://shopify/Location/66856386727', // Calgary Warehouse
  zero: ['gid://shopify/Location/66861301927', 'gid://shopify/Location/82853724327', 'gid://shopify/Location/82853822631'], // Ontario, Quebec, Vancouver
};
const SET_BATCH = 250;
// CFC's own shelf: Salesforce PBSI available -> the Shopify Sechelt Warehouse and Powell River locations (replacing the
// old placeholder counts, Mac 2026-10-02). Staging and in-transit rows are left out.
const CFC = {
  'gid://shopify/Location/65050771623': ['Sechelt', 'Sechelt Warehouse', 'Sechelt Showroom'],
  'gid://shopify/Location/65050837159': ['Powell River'],
};

/** Map shopifySku -> { shopifyLocationId: qty, uom } from Salesforce (PBSI items are named by the Shopify SKU). */
async function sfShelfStock(skus) {
  const sf = require('../../lib/salesforce');
  const conn = await sf.connect();
  const byName = new Map(Object.entries(CFC).flatMap(([loc, names]) => names.map((n) => [n, loc])));
  const out = new Map();
  for (let i = 0; i < skus.length; i += 150) {
    const list = skus.slice(i, i + 150).map((n) => `'${String(n).replace(/\\/g, '').replace(/'/g, "\\'")}'`).join(',');
    const rows = await sf.query(conn, `SELECT PBSI__item_lookup__r.Name n, PBSI__location_lookup__r.Name l, SUM(PBSI__Quantity_Available__c) q FROM PBSI__PBSI_Inventory__c WHERE PBSI__item_lookup__r.Name IN (${list}) GROUP BY PBSI__item_lookup__r.Name, PBSI__location_lookup__r.Name`);
    for (const r of rows) {
      const loc = byName.get(r.l);
      if (!loc) continue;
      const m = out.get(r.n) || {};
      m[loc] = (m[loc] || 0) + (Number(r.q) || 0);
      out.set(r.n, m);
    }
    const items = await sf.query(conn, `SELECT Name, PBSI__defaultunitofmeasure__c FROM PBSI__PBSI_Item__c WHERE Name IN (${list})`);
    for (const it of items) if (out.has(it.Name)) out.get(it.Name).uom = it.PBSI__defaultunitofmeasure__c || 'EA';
  }
  return out;
}
const ID_BATCH = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gqlRetry(query, variables) {
  const { graphql } = require('../../lib/shopify-graphql');
  for (let i = 0; ; i++) {
    try { return (await graphql(query, variables)).data; } catch (e) {
      // Throttles and dropped connections are retried (every write here sets an absolute value, so a retry is safe):
      // the first live run (2026-10-02) lost one 250-quantity batch to an ECONNRESET.
      if (i >= 5 || !/throttl|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|network|\b50[0234]\b/i.test(e.message)) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

/** The pickup profiles (PROFILES), checked to exist. */
async function pickupProfiles(gql) {
  const d = await gql(`{ deliveryProfiles(first: 30) { nodes { id name } } }`);
  const live = new Set(d.deliveryProfiles.nodes.map((p) => p.id));
  return PROFILES.filter((p) => live.has(p.id));
}

/** Shopify's inventory levels at the given locations: Map `${itemId}|${locationId}` -> { levelId, qty }. */
async function readLevels(gql, locationIds) {
  const out = new Map();
  for (const loc of locationIds) {
    let after = null;
    do {
      const d = await gql(`query($id: ID!, $a: String) { location(id: $id) { inventoryLevels(first: 250, after: $a) { pageInfo { hasNextPage endCursor }
        nodes { id item { id } quantities(names: ["available"]) { quantity } } } } }`, { id: loc, a: after });
      const page = d.location.inventoryLevels;
      for (const n of page.nodes) out.set(`${n.item.id}|${loc}`, { levelId: n.id, qty: (n.quantities[0] || {}).quantity || 0 });
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return out;
}

/** ACTIVE products with their variants in the given profiles: [{ id, title, tags, variants: [{ id, sku, itemId, policy, pooled }] }]. */
async function profileProducts(gql, profiles) {
  const byId = new Map();
  const counts = { items: 0, inactive: 0, overflow: 0 };
  const profileIds = profiles.map((p) => p.id);
  const pooledOf = new Map(profiles.map((p) => [p.id, !!p.pooled]));
  const want = new Set(profileIds);
  for (const pid of profileIds) {
    let after = null;
    do {
      const d = await gql(`query($id: ID!, $a: String) { deliveryProfile(id: $id) { profileItems(first: 8, after: $a) {
        pageInfo { hasNextPage endCursor }
        nodes { product { id title tags status } variants(first: 100) { pageInfo { hasNextPage } nodes { id sku title barcode inventoryPolicy inventoryItem { id } } } } } } }`, { id: pid, a: after });
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
              nodes { id sku title barcode inventoryPolicy inventoryItem { id } deliveryProfile { id } } } } }`, { id: it.product.id, a: va });
            variants.push(...v.product.variants.nodes.filter((x) => x.deliveryProfile && want.has(x.deliveryProfile.id)));
            va = v.product.variants.pageInfo.hasNextPage ? v.product.variants.pageInfo.endCursor : null;
          } while (va);
        }
        const p = byId.get(it.product.id) || { id: it.product.id, title: it.product.title, tags: it.product.tags, variants: [] };
        for (const v of variants) if (!p.variants.some((x) => x.id === v.id)) p.variants.push({ id: v.id, sku: v.sku || null, title: v.title || '', barcode: v.barcode || null, itemId: v.inventoryItem ? v.inventoryItem.id : null, policy: v.inventoryPolicy, pooled: pooledOf.get(pid) });
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

async function syncCounterStock({ apply = false, limit = 0, compare = 0, log = console.log, gql = gqlRetry, makeClient, sfItems, sfShelf, snapDir = SNAP_DIR, gapMs = GAP_MS, idCache = ID_CACHE, snapshots = FBA_SNAPSHOTS } = {}) {
  const started = Date.now();
  const counters = cs.countersFrom(JSON.parse(fs.readFileSync(BRANCHES, 'utf8')).branches);
  const located = counters.filter((c) => c.locationId);
  if (!located.length) throw new Error('no counter has a Shopify location (run scripts/trade/native-counters.js create)');
  const profiles = await pickupProfiles(gql);
  if (!profiles.length) throw new Error('the pickup delivery profiles are gone');
  const { products: all, counts } = await profileProducts(gql, profiles);
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
  log(`${products.length} products, ${products.reduce((n, p) => n + p.variants.length, 0)} variants, ${codes.size} SKUs, ${located.length} counter locations (profiles: ${profiles.map((p) => p.name).join(', ')})`);

  const { lookups, requests, pullSec, comparison } = await pullStock([...codes.values()], { log, makeClient, gapMs, idCache, snapshots, compare });
  const by = (st) => Object.entries(lookups).filter(([, r]) => r.status === st);
  const failed = by('failed');
  const notFound = by('not_found');
  // ok -> the stock map, not at Prosol -> null, failed -> undefined (planLocations leaves those variants alone)
  const stockBySku = {};
  for (const [k, r] of Object.entries(lookups)) if (r.status === 'ok') stockBySku[k] = r.stock; else if (r.status === 'not_found') stockBySku[k] = null;
  const failRate = codes.size ? failed.length / codes.size : 0;
  const aborted = failRate > MAX_FAILED ? `${failed.length} of ${codes.size} lookups failed (${Math.round(failRate * 100)}%), over ${MAX_FAILED * 100}%: nothing written` : null;

  // Coast pickup-only locations (native-counters.js): stocked from the shelf of the matching shipping location.
  const coastPickup = Object.fromEntries(JSON.parse(fs.readFileSync(BRANCHES, 'utf8')).branches.filter((b) => b.coast && b.pickup_location_id && b.shopify_location_id && CFC[b.shopify_location_id]).map((b) => [b.pickup_location_id, b.shopify_location_id]));
  const levels = await readLevels(gql, [...located.map((c) => c.locationId), POOL.locationId, ...POOL.zero, ...Object.keys(CFC), ...Object.keys(coastPickup)]);
  const variants = products.flatMap((p) => p.variants.map((v) => ({ id: v.id, productId: p.id, itemId: v.itemId, policy: v.policy, sku: v.sku, prosolSku: v.prosolSku, pooled: v.pooled })));
  let shelf = null;
  try {
    const raw = await (sfShelf || sfShelfStock)([...new Set(variants.map((v) => v.sku).filter(Boolean))]);
    // Into Shopify's selling unit per variant (a roll, not its square feet): keyed by SKU, so one row per SKU.
    shelf = new Map();
    for (const p of products) for (const v of p.variants) {
      const r = v.sku && raw.get(v.sku);
      if (!r || shelf.has(v.sku)) continue;
      shelf.set(v.sku, Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'uom').map(([loc, q]) => [loc, cs.shelfUnits(q, r.uom, [v.title, p.title])])));
    }
  } catch (e) { log(`Salesforce shelf stock failed, Sechelt/Powell River left as they are: ${e.message}`); }
  const plan = cs.planLocations({ variants, stockBySku, counters: located, pool: POOL, levels, cfc: shelf ? { bySku: shelf, locations: Object.keys(CFC), pickup: coastPickup } : null });
  const counts2 = { activate: plan.activate.length, set: plan.set.length, deny: plan.deny.length, deactivate: plan.deactivate.length, skipped: plan.skipped };
  log(`plan: ${counts2.activate} activations, ${counts2.set} quantities, ${counts2.deny} variants to "don't sell when out of stock", ${counts2.deactivate} unstocks, ${counts2.skipped} skipped`);

  // Per counter: products whose every variant Prosol has there (what a one-product cart can pick up).
  const stockedAt = (v, c) => { const st = v.prosolSku ? stockBySku[v.prosolSku] : null; return !!st && Number(st[c.mapKey]) >= 1; };
  const perCounter = located.map((c) => ({ code: c.code, products: products.filter((p) => p.variants.length && p.variants.every((v) => stockedAt(v, c))).length }));

  const writeErrors = [];
  const done = { activate: 0, set: 0, deny: 0, deactivate: 0 };
  if (apply && !aborted) {
    const groupBy = (xs, k) => xs.reduce((m, x) => m.set(x[k], [...(m.get(x[k]) || []), x]), new Map());
    for (const [itemId, xs] of groupBy(plan.activate, 'itemId')) {
      try {
        const r = await gql(`mutation($i: ID!, $u: [InventoryBulkToggleActivationInput!]!) { inventoryBulkToggleActivation(inventoryItemId: $i, inventoryItemUpdates: $u) { userErrors { field message } } }`,
          { i: itemId, u: xs.map((x) => ({ locationId: x.locationId, activate: true })) });
        if (r.inventoryBulkToggleActivation.userErrors.length) throw new Error(JSON.stringify(r.inventoryBulkToggleActivation.userErrors));
        done.activate += xs.length;
      } catch (e) { writeErrors.push({ step: 'activate', itemId, error: e.message }); }
    }
    for (let i = 0; i < plan.set.length; i += SET_BATCH) {
      const batch = plan.set.slice(i, i + SET_BATCH);
      try {
        const r = await gql(`mutation($in: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $in) { userErrors { field message } } }`,
          { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, referenceDocumentUri: 'gid://yourfloors/CounterStockSync/prosol', quantities: batch.map((x) => ({ inventoryItemId: x.itemId, locationId: x.locationId, quantity: x.qty })) } });
        if (r.inventorySetQuantities.userErrors.length) throw new Error(JSON.stringify(r.inventorySetQuantities.userErrors).slice(0, 500));
        done.set += batch.length;
      } catch (e) { writeErrors.push({ step: 'set', from: i, error: e.message }); }
    }
    for (const [productId, xs] of groupBy(plan.deny, 'productId')) {
      try {
        const r = await gql(`mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { field message } } }`,
          { p: productId, v: xs.map((x) => ({ id: x.variantId, inventoryPolicy: 'DENY' })) });
        if (r.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(r.productVariantsBulkUpdate.userErrors));
        done.deny += xs.length;
      } catch (e) { writeErrors.push({ step: 'deny', productId, error: e.message }); }
    }
    for (const [itemId, xs] of groupBy(plan.deactivate, 'itemId')) {
      try {
        const r = await gql(`mutation($i: ID!, $u: [InventoryBulkToggleActivationInput!]!) { inventoryBulkToggleActivation(inventoryItemId: $i, inventoryItemUpdates: $u) { userErrors { field message } } }`,
          { i: itemId, u: xs.map((x) => ({ locationId: x.locationId, activate: false })) });
        if (r.inventoryBulkToggleActivation.userErrors.length) throw new Error(JSON.stringify(r.inventoryBulkToggleActivation.userErrors));
        done.deactivate += xs.length;
      } catch (e) {
        // Can't unstock (an open pickup order holds some): set 0 instead, which hides pickup for DENY variants.
        writeErrors.push({ step: 'deactivate', itemId, error: e.message });
        try {
          await gql(`mutation($in: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $in) { userErrors { field message } } }`,
            { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, referenceDocumentUri: 'gid://yourfloors/CounterStockSync/prosol', quantities: xs.map((x) => ({ inventoryItemId: itemId, locationId: x.locationId, quantity: 0 })) } });
        } catch {}
      }
    }
  }

  const summary = {
    mode: apply ? (aborted ? 'apply-aborted' : 'apply') : 'dry-run', runtimeSec: Math.round((Date.now() - started) / 1000),
    profiles: profiles.map((p) => p.name), profileItems: counts.items, inactiveSkipped: counts.inactive, variantOverflow: counts.overflow,
    products: products.length, skus: codes.size, variantsWithoutSku: noSku, resolvedVia: via,
    lookups: { ok: by('ok').length, notFound: notFound.length, failed: failed.length }, prosolRequests: requests, pullSec, gapMs, comparison, aborted,
    plan: counts2, done, writeErrors: writeErrors.length, perCounter,
    pickupAnywhere: products.filter((p) => located.some((c) => p.variants.length && p.variants.every((v) => stockedAt(v, c)))).length,
  };
  fs.mkdirSync(snapDir, { recursive: true });
  const snapshotPath = path.join(snapDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({ at: new Date().toISOString(), summary, counters: located, lookups,
    products: products.map((p) => ({ id: p.id, title: p.title, variants: p.variants.map((v) => ({ id: v.id, sku: v.sku, barcode: v.barcode, prosolSku: v.prosolSku, via: v.via, policy: v.policy, pooled: v.pooled })) })),
    plan, writeErrors }, null, 1));
  prune(snapDir);
  return { summary, snapshotPath, notFound, failed, products, plan };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) || 0 : 0; };
  syncCounterStock({ apply, limit: arg('--limit'), compare: arg('--compare') }).then(({ summary, snapshotPath, notFound, failed, products }) => {
    const titleOf = (sku) => { const p = products.find((x) => x.variants.some((v) => v.prosolSku === sku)); return p ? p.title : '?'; };
    console.log(`\n${summary.mode}: ${summary.runtimeSec}s. ${summary.products} products (${summary.profileItems} profile items, ${summary.inactiveSkipped} not active), ${summary.skus} SKUs, ${summary.variantsWithoutSku} variants without a SKU`);
    console.log(`Variant codes from: ${Object.entries(summary.resolvedVia).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    const rq = summary.prosolRequests;
    console.log(`Prosol requests: ${rq.ids} id lookups + ${rq.stock} stock${rq.compare ? ` + ${rq.compare} compare` : ''}, Prosol part ${summary.pullSec}s at ${summary.gapMs} ms apart`);
    if (summary.comparison) console.log(`Batched vs checkInventory (live sync):\n${summary.comparison.map((x) => `  ${x.apiSku}: ${x.match ? 'match' : `DIFF ${x.inv ? x.diffs.join('; ') : 'checkInventory returned nothing'}`} (${x.locations} locations)`).join('\n')}`);
    console.log(`Prosol lookups: ${summary.lookups.ok} ok, ${summary.lookups.notFound} not at Prosol, ${summary.lookups.failed} failed${summary.aborted ? `\nABORTED: ${summary.aborted}` : ''}`);
    console.log(`Products a counter can fill on their own: ${summary.pickupAnywhere} of ${summary.products}`);
    console.log(`Plan: ${JSON.stringify(summary.plan)}${summary.mode === 'apply' ? `\nDone: ${JSON.stringify(summary.done)}, ${summary.writeErrors} write errors` : ''}`);
    console.log('\nCounter  products');
    for (const c of summary.perCounter) console.log(`${c.code.padEnd(8)} ${String(c.products).padStart(8)}`);
    if (notFound.length) console.log(`\nNot at Prosol (first 15): ${notFound.slice(0, 15).map(([k, r]) => `${r.apiSku}${r.apiSku !== k ? `/${k}` : ''} (${titleOf(k).slice(0, 50)})`).join('; ')}`);
    if (failed.length) console.log(`\nFailed (first 10): ${failed.slice(0, 10).map(([k, r]) => `${k}: ${r.error}`).join('; ')}`);
    console.log(`\nSnapshot: ${path.relative(ROOT, snapshotPath)}`);
    if (summary.aborted) process.exitCode = 2;
  }).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { syncCounterStock, pickupProfiles, profileProducts, readLevels, pullStock, snapshotIds, sfShelfStock, GAP_MS, PROFILES, POOL, CFC };
