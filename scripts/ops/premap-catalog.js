#!/usr/bin/env node
/**
 * Pre-map the ACTIVE yourfloors.ca catalogue into scripts/shipstation/sku-map.json, so an order for a variant that has
 * never sold before doesn't sit at staging until the sku-resolver maps it (#1443, DITRA-HEAT, 2026-11-02). Decisions
 * are in lib/premap-catalog.js; this file only reads Shopify and Prosol and writes the report (and, with --write, the
 * entries).
 *
 * Reads: every ACTIVE Shopify variant with a SKU (read only), sku-map.json, and Prosol (read only, one browser session,
 *        every request PREMAP_PROSOL_GAP_MS apart, 2 s default): SKUs 40 to a filter[sku] request, then one offers call
 *        per product that passed every other check.
 * Writes: <out-dir>/premap-catalog-<date>.csv (one row per unkeyed SKU: tier alias | prosol | skip, with the reason) and
 *         <out-dir>/premap-catalog-<date>.plan.json (the entries). Only with --write: each entry through
 *         lib/sku-map-file.js writeEntry, re-checking first that the key is still absent (an existing key is never
 *         touched). Nothing is deployed: staging and lib/package-split.js load sku-map.json at process start, so the
 *         entries reach the Mini only through the usual deploy (divergence check, commit, push, pull, restart).
 *
 * Usage: node scripts/ops/premap-catalog.js [--write] [--plan=<plan.json>] [--out-dir=<dir>] [--limit=<n>] [--sku=<sku>]
 *   --plan=<file> with --write writes that reviewed plan's entries without asking Shopify or Prosol again.
 *   --limit / --sku narrow the Prosol pass for a quick look (the CSV then only covers what was looked at).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pc = require(path.join(ROOT, 'lib', 'premap-catalog'));
const skuMapFile = require(path.join(ROOT, 'lib', 'sku-map-file'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const GAP_MS = Number(process.env.PREMAP_PROSOL_GAP_MS) || 2000;
const SKU_BATCH = 40;
const OUT_DIR = opt('out-dir') || path.join(ROOT, 'data', 'premap-catalog');
const bcDate = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10); // BC is UTC-7 all year
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ── Shopify ─────────────────────────────────────────────────────────────────

const VARIANTS_Q = `query($after: String) { productVariants(first: 250, after: $after, query: "product_status:active") {
  pageInfo { hasNextPage endCursor }
  nodes { sku title product { title vendor handle status productType } } } }`;

async function activeVariants() {
  const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
  const out = [];
  let after = null;
  for (;;) {
    let r;
    for (let attempt = 1; ; attempt++) {
      try { r = await graphql(VARIANTS_Q, { after }); break; } catch (e) {
        if (attempt >= 3 || !/throttl|timeout|ECONNRESET/i.test(e.message)) throw e;
        await sleep(2000 * attempt);
      }
    }
    const pv = r.data.productVariants;
    out.push(...pv.nodes.filter((v) => v.product && v.product.status === 'ACTIVE'));
    if (!pv.pageInfo.hasNextPage) return out;
    after = pv.pageInfo.endCursor;
  }
}

// ── Prosol (paced, one session) ─────────────────────────────────────────────

function prosolSession() {
  const { ProsolClientV2 } = require(path.join(ROOT, 'scripts', 'shipstation', 'prosol-client-v2'));
  let client = null;
  let last = 0;
  const counts = { lookups: 0, offers: 0 };
  async function open() {
    client = new ProsolClientV2();
    await client.init();
    const raw = client.apiGet.bind(client);
    client.apiGet = async (url) => { // every call, ours or getOfferPrice's, is spaced GAP_MS from the last
      const wait = last + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return raw(url);
    };
  }
  async function getJson(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await client.apiGet(url); } catch (e) { r = { status: 0, body: e.message }; }
      if (r.status === 200) { try { return JSON.parse(r.body); } catch {} }
      if (attempt === 0) {
        log(`Prosol ${r.status || r.body} on ${url.slice(0, 90)}: retrying once`);
        if (r.status === 401 || r.status === 419) { try { await client.close(); } catch {} await open(); } else await sleep(Math.max(GAP_MS, 5000));
      }
    }
    return null;
  }
  return {
    open,
    counts,
    close: async () => { if (client) await client.close(); },
    /** sku -> rows for every SKU in the batch, or null when Prosol didn't answer. */
    async lookup(skus) {
      const rows = [];
      for (let page = 1; ; page++) {
        counts.lookups++;
        const j = await getJson(`/api/storefront/products?filter[sku]=${encodeURIComponent(skus.join(','))}&append=prosol_sku&limit=100&page=${page}`);
        if (!j) return null;
        rows.push(...(j.data || []));
        if (page >= (j.last_page || (j.meta && j.meta.last_page) || 1)) return rows;
      }
    },
    async offer(productId) {
      counts.offers++;
      return client.getOfferPrice(productId);
    },
  };
}

// ── write ───────────────────────────────────────────────────────────────────

function writeEntries(entries) {
  let written = 0;
  const kept = [];
  for (const [key, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(skuMapFile.readSkuMap().mappings || {}, key)) { kept.push(key); continue; }
    const { replaced } = skuMapFile.writeEntry(key, entry);
    if (replaced) throw new Error(`writeEntry replaced ${key}: refusing to go on`); // can't happen after the check above
    written++;
  }
  return { written, kept };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const date = bcDate();
  if (opt('plan')) {
    if (!flag('write')) throw new Error('--plan is only for --write (the dry run builds a fresh plan)');
    const plan = JSON.parse(fs.readFileSync(opt('plan'), 'utf8'));
    const { written, kept } = writeEntries(plan.entries);
    console.log(`wrote ${written} entries from ${opt('plan')} (made ${plan.date}); ${kept.length} keys already present, left alone${kept.length ? `: ${kept.slice(0, 20).join(', ')}` : ''}. Not deployed.`);
    return;
  }

  const mappings = skuMapFile.readSkuMap().mappings || {};
  log('Shopify: reading active variants');
  const variants = await activeVariants();
  const { groups, keyed, noSku } = pc.unkeyedGroups(variants, mappings);
  log(`Shopify: ${variants.length} active variants, ${noSku} without a SKU, ${keyed} keyed in sku-map, ${groups.length} unkeyed SKUs`);

  const ctx = { index: pc.indexByApiSku(mappings), families: pc.buildFamilies(mappings), routing: pc.vendorRouting(variants, mappings), date };
  const rows = [];
  const entries = [];
  const pending = [];
  for (const g of groups) {
    const r = pc.classifyGroup(g, ctx);
    if (r.entry) entries.push([g.sku, r.entry]);
    if (r.needsProsol) pending.push({ group: g, ...r });
    else rows.push(r.row);
  }
  const onlySku = opt('sku');
  const limit = Number(opt('limit')) || 0;
  let todo = onlySku ? pending.filter((p) => p.group.sku === onlySku) : pending;
  if (limit) todo = todo.slice(0, limit);
  if (todo.length < pending.length) log(`Prosol pass narrowed to ${todo.length} of ${pending.length} SKUs (--sku/--limit): the CSV covers only those`);
  log(`tier 1: ${entries.length} aliases; ${rows.length - entries.length} skipped before Prosol; ${todo.length} SKUs for Prosol`);

  if (todo.length) {
    const prosol = prosolSession();
    await prosol.open();
    try {
      const hitsBySku = new Map();
      for (let i = 0; i < todo.length; i += SKU_BATCH) {
        const batch = todo.slice(i, i + SKU_BATCH);
        const found = await prosol.lookup(batch.map((p) => p.group.sku));
        for (const p of batch) hitsBySku.set(p.group.sku, found ? pc.exactHits(found, p.group.sku) : null);
        log(`Prosol lookups: ${Math.min(i + SKU_BATCH, todo.length)}/${todo.length} SKUs`);
      }
      const offerQueue = [];
      for (const p of todo) {
        const hits = hitsBySku.get(p.group.sku);
        if (!hits) { rows.push({ ...p.row, tier: 'skip', reason_code: 'prosol-error', reason: 'Prosol did not answer the SKU lookup (twice)' }); continue; }
        const pre = pc.prosolPrecheck({ names: p.group.names, hits, existing: p.existing });
        if (!pre.product) rows.push(pc.prosolSkipRow(p.row, pre));
        else offerQueue.push({ ...p, pre });
      }
      log(`Prosol offers: ${offerQueue.length} products passed the checks, one offers call each`);
      let n = 0;
      for (const p of offerQueue) {
        let offer = null;
        try { offer = await prosol.offer(p.pre.product.id); } catch (e) { log(`offer ${p.pre.product.id} failed: ${e.message}`); }
        const built = pc.prosolEntry({ sku: p.group.sku, names: p.group.names, product: p.pre.product, name: p.pre.name, offer, families: ctx.families, date });
        rows.push(pc.prosolDoneRow(p.row, built));
        if (built.entry) entries.push([p.group.sku, built.entry]);
        if (++n % 50 === 0) log(`Prosol offers: ${n}/${offerQueue.length}`);
      }
      log(`Prosol: ${prosol.counts.lookups} lookup requests, ${prosol.counts.offers} offer requests`);
    } finally {
      await prosol.close();
    }
  }

  rows.sort((a, b) => (a.tier === b.tier ? String(a.vendor).localeCompare(String(b.vendor)) || a.sku.localeCompare(b.sku) : ['alias', 'prosol', 'skip'].indexOf(a.tier) - ['alias', 'prosol', 'skip'].indexOf(b.tier)));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csvFile = path.join(OUT_DIR, `premap-catalog-${date}.csv`);
  const planFile = path.join(OUT_DIR, `premap-catalog-${date}.plan.json`);
  fs.writeFileSync(csvFile, pc.toCsv(rows));
  fs.writeFileSync(planFile, `${JSON.stringify({ date, generatedAt: new Date().toISOString(), entries }, null, 1)}\n`);

  const s = pc.summarize(rows);
  const noPkg = entries.filter(([, e]) => !e.package_shape).length;
  console.log(`\npremap-catalog ${date}: ${rows.length} unkeyed SKUs -> ${s.tiers.alias || 0} tier 1 (alias), ${s.tiers.prosol || 0} tier 2 (Prosol exact), ${s.tiers.skip || 0} skipped`);
  console.log(`  ${entries.length} entries, ${entries.length - noPkg} with package fields, ${noPkg} without (package-split's default box)`);
  console.log('  skipped by reason:');
  for (const [k, v] of Object.entries(s.reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
  console.log('  by vendor (alias / prosol / skip):');
  for (const [k, v] of Object.entries(s.vendors).sort((a, b) => b[1].total - a[1].total)) console.log(`    ${String(v.total).padStart(4)}  ${k}: ${v.alias} / ${v.prosol} / ${v.skip}`);
  console.log(`  CSV:  ${csvFile}\n  plan: ${planFile}`);
  if (!flag('write')) { console.log('  dry run: sku-map.json not touched (--write, or --write --plan=<plan.json> for exactly this plan)'); return; }
  const { written, kept } = writeEntries(entries);
  console.log(`  wrote ${written} entries to ${skuMapFile.SKU_MAP_FILE}; ${kept.length} keys appeared meanwhile and were left alone. Not deployed.`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
