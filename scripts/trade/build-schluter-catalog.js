#!/usr/bin/env node
/*
 * scripts/trade/build-schluter-catalog.js: Schluter profile catalogue as Shopify productSet payloads (02 task S3).
 * research/2026-09-28-prozone-build/catalog.md sections 2, 3, 5 and 7; pure logic in lib/trade-catalog.js.
 *
 * README
 * ------
 * Default (dry run, no network at all)
 *   Reads, from the 02 catalogue folder (--catalog-dir, default below):
 *     products.csv, variants.csv          S1 catalogue build (grouping, options, MAP, UPC, weight)
 *     prosol-refresh-<date>.jsonl         S2 refresh (exact code, cost, stock); newest file unless --refresh=<file>
 *     live-skus-<date>.json               read-only store snapshot for the duplicate-SKU check (newest; --no-live
 *                                         skips it). Made by 02's scripts/catalog/live-skus.js.
 *   plus the MAP list through lib/schluter-map.js (data/fba/maps, newest), and writes to <catalog-dir>/payloads/:
 *     1/<handle>.json, 2a/<handle>.json   one Admin API 2026-01 productSet input per product and wave
 *     manifest.json                       payload list with sha256, QA totals, excluded variants, and a variant
 *                                         index with the FRESH distributor code and PO code (feeds the S8 sku-map)
 *     excluded.csv                        variants left out and why
 *     QA.md                               per-wave counts, checks, five example payloads
 *   Wave 1 = the 6 products holding the wave-1 codes, created with only those variants. Wave 2a = the other
 *   products plus the FULL variant list of the 6 wave-1 products (productSet replaces the whole list).
 *
 * --apply (NOT RUN without Mac's go)
 *   node scripts/trade/build-schluter-catalog.js --apply --i-have-macs-go --wave=1|2a [--handle=a,b] [--refresh-description]
 *   Refuses (exit 2, before any network call) unless both --apply and --i-have-macs-go and a --wave are given.
 *   Then refuses if the manifest has QA errors, or if a payload file's sha256 differs from the manifest (re-run the
 *   dry run to rebuild), or if SHOPIFY_STORE is not the yourfloors.ca store. One product at a time:
 *     1. productByIdentifier(handle) lookup.
 *     2. Absent: productSet(identifier: {handle}, synchronous: false) with status DRAFT.
 *        Present: productSet(identifier: {id}) with the FULL variant list and each existing variant's ID (by SKU).
 *        Refuses if the live product has a variant the payload would delete, a SKU on two variants, more than 250
 *        variants, or another vendor. Never sends status on an update (a live product stays live), merges the live
 *        tags, and leaves descriptionHtml alone unless --refresh-description.
 *     3. Polls productOperation until COMPLETE, reads the product back and checks handle, SKUs, variant IDs,
 *        prices, barcodes and costs.
 *   Every step goes to <catalog-dir>/apply-log.jsonl. The run stops at the first problem.
 *   Never sends collections, metafields, files or media: those lists are added separately
 *   (collectionAddProductsV2, metafieldsSet, productVariantAppendMedia), and delivery-profile assignment
 *   (01's pickup-only profile) is its own step.
 *
 * Options: --catalog-dir=<dir> --refresh=<jsonl> --live-skus=<json> --no-live --out=<dir> --keep-prosol-discontinued
 *          --min-network-qty=<n> (default 5: wave 2a skips variants not available or under n units network-wide)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const cat = require(path.join(ROOT, 'lib', 'trade-catalog'));

const DEFAULT_CATALOG_DIR = '/Users/mvcddy91/daddy-dev/cfc-projects/02-yf-schluter-trade/data/catalog';
// BC is UTC-7 all year from 2026 (permanent daylight time); local tzdata is stale, so no America/Vancouver.
const bcNow = () => new Date(Date.now() - 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

const catalogDir = opt('catalog-dir') || process.env.TRADE_CATALOG_DIR || DEFAULT_CATALOG_DIR;
const outDir = opt('out') || path.join(catalogDir, 'payloads');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function newest(dir, re) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => re.test(x)).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
}

function readInput(label, p, note) {
  if (!p || !fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
  const buf = fs.readFileSync(p);
  return { label, path: p, sha256: sha256(buf), note, text: buf.toString('utf8') };
}

const csvEsc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ---------------------------------------------------------------------------------------------------------------
// Dry run

function build() {
  const inProducts = readInput('products.csv (S1)', path.join(catalogDir, 'products.csv'));
  const inVariants = readInput('variants.csv (S1)', path.join(catalogDir, 'variants.csv'));
  const inRefresh = readInput('Prosol refresh (S2)', opt('refresh') || newest(catalogDir, /^prosol-refresh-\d{4}-\d{2}-\d{2}\.jsonl$/));
  const { loadMap } = require(path.join(ROOT, 'lib', 'schluter-map'));
  const mapData = loadMap();
  const mapExact = new Map(mapData.records.map((r) => [r.item, r]));
  const inputs = [inProducts, inVariants, inRefresh, { label: 'MAP list', path: mapData.path, sha256: sha256(fs.readFileSync(mapData.path)), note: `effective ${mapData.effectiveDate}, ${mapData.records.length} rows` }];

  let liveRows = null;
  if (!flag('no-live')) {
    const liveFile = opt('live-skus') || newest(catalogDir, /^live-skus-\d{4}-\d{2}-\d{2}\.json$/);
    if (liveFile && fs.existsSync(liveFile)) {
      const live = readInput('Live store SKUs (read-only snapshot)', liveFile);
      const doc = JSON.parse(live.text);
      liveRows = doc.rows;
      live.note = `read ${doc.generated_at}, ${doc.variants} variants in ${doc.products} products`;
      inputs.push(live);
    }
  }

  const products = cat.parseCsv(inProducts.text);
  const variants = cat.parseCsv(inVariants.text);
  const refresh = cat.parseJsonl(inRefresh.text);
  const keepProsolDiscontinued = flag('keep-prosol-discontinued');
  const minNetworkQty = opt('min-network-qty') === null ? 5 : Number(opt('min-network-qty')); // Mac's "within reason"
  if (!(minNetworkQty >= 0)) throw new Error('--min-network-qty must be a number >= 0');
  const b = cat.buildCatalog({ products, variants, refresh, keepProsolDiscontinued, minNetworkQty });
  const qa = cat.runQa({ build: b, mapLookup: (sku) => mapExact.get(sku) || null, liveRows });

  // Payload files, replacing stale ones in the wave folders.
  const generatedAt = new Date().toISOString();
  const manifestWaves = {};
  for (const w of cat.WAVES) {
    const dir = path.join(outDir, w);
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    manifestWaves[w] = [];
    for (const pl of b.payloads.filter((x) => x.wave === w)) {
      const file = `${pl.handle}.json`;
      keep.add(file);
      const doc = {
        mutation: 'productSet', api_version: cat.API_VERSION, synchronous: false, wave: w, handle: pl.handle,
        extends_wave1_product: pl.extendsWave1, variants_new_in_wave: pl.newInWave, generated_at: generatedAt,
        note: 'DRAFT payload. --apply looks the handle up first and adds variant IDs on update; never send this file to productSet by hand.',
        input: pl.input,
      };
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      fs.writeFileSync(path.join(dir, file), text);
      manifestWaves[w].push({
        handle: pl.handle, file: `${w}/${file}`, sha256: sha256(text), title: pl.input.title, product_type: pl.input.productType,
        delivery: pl.product.delivery, extends_wave1_product: pl.extendsWave1, variants: pl.input.variants.length,
        variants_new_in_wave: pl.newInWave, options: pl.input.productOptions.map((o) => `${o.name} (${o.values.length})`),
      });
    }
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
  }

  // Notes carried forward into QA.md.
  const idx = b.variantIndex;
  const strip = (s) => String(s || '').replace(/\//g, '');
  const oddPo = idx.filter((x) => x.po_code && x.po_code !== strip(x.prosol_code));
  const recoded = idx.filter((x) => x.prosol_code_jul29 && x.prosol_code !== x.prosol_code_jul29);
  const special = b.excluded.filter((e) => (e.reasons || []).includes('special_order'));
  const bundles = idx.filter((x) => x.bundles_of_10);
  const poUnconfirmed = oddPo.filter((x) => cat.CONFIRMED_PO_CODES[x.sku] !== x.po_code);
  const poConfirmed = oddPo.filter((x) => cat.CONFIRMED_PO_CODES[x.sku] === x.po_code);
  const backorder = idx.filter((x) => x.stock_status === 'backorder');
  const nameFlags = idx.filter((x) => x.name_check && x.name_check !== 'ok');
  const missingW1 = b.wave1Codes.filter((s) => !idx.some((x) => x.sku === s));
  const notes = [
    `Wave 1 builds ${idx.filter((x) => x.wave === '1').length} of the ${b.wave1Codes.length} planned codes; not built: ${missingW1.map((s) => `\`${s}\``).join(', ') || 'none'}.`,
    `"Within reason" (Mac 2026-09-28): wave 2a builds a variant only if the distributor has it available with at least ${minNetworkQty} units across its network; ${b.excluded.filter((e) => e.reason === 'fringe_low_stock' || (e.reasons || []).includes('fringe_low_stock')).length} left out as fringe_low_stock (excluded.csv). \`--min-network-qty=0\` turns it off. Wave 1 is exempt; ${backorder.length} included variants are on backorder (wave 1 only).`,
    `Special order on the 2026 list: left out (Mac 2026-09-29, "forget them"): ${special.length} variants (${special.slice(0, 11).map((x) => `\`${x.sku}\``).join(', ')}${special.length > 11 ? ', ...' : ''}).`,
    `Sold in bundles of 10 on the 2026 list: ${bundles.length} SCHIENE-BASIC variants (${bundles.map((x) => `\`${x.sku}\``).join(', ')}). Mac 2026-09-29: "if they come as bundles of 10, sell them that way". The distributor stocks and prices them by the single length (branch counts like 5, 11 and 21), so they sell by the length at MAP.`,
    `Distributor PO codes that are not the storefront code minus slashes: confirmed by Mac 2026-09-29: ${poConfirmed.map((x) => `\`${x.sku}\` -> \`${x.po_code}\``).join(', ') || 'none'}; still to confirm before the first PO: ${poUnconfirmed.map((x) => `\`${x.sku}\` -> \`${x.po_code}\``).join(', ') || 'none'}.`,
    `${recoded.length} included variants have a distributor code that changed since the Jul 29 snapshot (e.g. ${recoded.slice(0, 3).map((x) => `\`${x.prosol_code_jul29}\` -> \`${x.prosol_code}\``).join(', ')}). \`manifest.json\` \`variants[]\` carries the fresh \`prosol_code\` and \`po_code\` for the S8 sku-map; variants.csv \`prosol_code\` is stale.`,
    `S1 name flags kept on ${nameFlags.length} included variants (code-based names, source-data slips): ${nameFlags.map((x) => `\`${x.sku}\``).join(', ')}.`,
    'Descriptions are short factual placeholders built from the catalogue fields (MAP text and codes). The copy pass (product-copy skill) replaces them; on an existing product `--apply` keeps the live description unless `--refresh-description`.',
    'Not in any payload by design: collections, metafields (custom.vendor_sku, bullets, data sheet, SEO tags), media, template suffix (S6 template not built yet) and the delivery profile (01\'s pickup-only profile for lengths). Each is its own step after the products exist.',
  ];

  const errors = qa.checks.filter((c) => c.level === 'error');
  const manifest = {
    generated_at: generatedAt, generated_bc: bcNow(), dry_run: true, api_version: cat.API_VERSION, store: cat.STORE,
    script: 'run-orders scripts/trade/build-schluter-catalog.js (branch trade/02)',
    inputs: inputs.map(({ label, path: p, sha256: h, note }) => ({ label, path: p, sha256: h, note: note || null })),
    options: { keep_prosol_discontinued: keepProsolDiscontinued, min_network_qty: minNetworkQty },
    qa: {
      errors: errors.length,
      warnings: qa.checks.filter((c) => c.level === 'warn').length,
      errors_by_wave: Object.fromEntries(cat.WAVES.map((w) => [w, errors.filter((c) => c.wave === w).length])),
      errors_global: errors.filter((c) => !cat.WAVES.includes(c.wave)).length,
      waves: qa.waves, final_state: qa.finalState, live: qa.live,
      checks: qa.checks,
    },
    waves: manifestWaves,
    excluded: b.excluded,
    catalog_excluded_by_reason: b.catalogExcludedByReason,
    variants: idx,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  const exCols = ['sku', 'wave', 'handle', 'stage', 'reason', 'reasons', 'prosol_match', 'prosol_code', 'cost', 'stock_status', 'network_qty', 'discontinued', 'map_text'];
  fs.writeFileSync(path.join(outDir, 'excluded.csv'), `${[exCols.join(','), ...b.excluded.map((e) => exCols.map((c) => csvEsc(Array.isArray(e[c]) ? e[c].join(' ') : e[c])).join(','))].join('\n')}\n`);

  const md = cat.renderQa({ build: b, qa, meta: { generatedBc: bcNow(), inputs: manifest.inputs, keepProsolDiscontinued, notes } });
  fs.writeFileSync(path.join(outDir, 'QA.md'), md);

  console.log(`build-schluter-catalog DRY RUN ${generatedAt} (no network)`);
  for (const w of cat.WAVES) {
    const s = qa.waves[w];
    console.log(`  wave ${w}: ${s.payloads} payloads (${s.newProducts} new products, ${s.extendsWave1} full lists for wave-1 products), ${s.newVariants} new variants, ${s.errors} errors`);
  }
  console.log(`  final state: ${qa.finalState.products} products, ${qa.finalState.variants} variants; left out ${b.excluded.filter((e) => e.stage === 'refresh').length} (${b.excluded.filter((e) => e.stage === 'refresh').map((e) => `${e.sku}:${e.reason}`).join(', ')})`);
  console.log(`  QA: ${errors.length} errors, ${manifest.qa.warnings} warnings; live check ${qa.live.checked ? 'done' : 'NOT done'}`);
  console.log(`  wrote ${outDir}/{1,2a}/*.json, manifest.json, excluded.csv, QA.md`);
  if (errors.length) process.exitCode = 3;
}

// ---------------------------------------------------------------------------------------------------------------
// --apply (Mac's go only)

const Q_LOOKUP = `query ProductByHandle($handle: String!) {
  productByIdentifier(identifier: { handle: $handle }) {
    id handle status vendor tags
    variantsCount { count precision }
    variants(first: 250) { nodes { id sku selectedOptions { name value } } }
  }
}`;
const M_SET = `mutation SetProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {
  productSet(input: $input, identifier: $identifier, synchronous: $synchronous) {
    product { id handle }
    productSetOperation { id status userErrors { code field message } }
    userErrors { code field message }
  }
}`;
const Q_OPERATION = `query ProductOperation($id: ID!) {
  productOperation(id: $id) {
    ... on ProductSetOperation { id status product { id handle } userErrors { code field message } }
  }
}`;
const Q_VERIFY = `query VerifyProduct($id: ID!) {
  product(id: $id) {
    id handle status
    variantsCount { count }
    variants(first: 250) { nodes { id sku price barcode inventoryPolicy inventoryItem { tracked unitCost { amount } measurement { weight { value unit } } } } }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apply(gate) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
  const logFile = path.join(catalogDir, 'apply-log.jsonl');
  const runId = `apply-${Date.now()}`;
  const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), run_id: runId, wave: gate.wave, ...o })}\n`);
  const stop = (msg, o = {}) => { log({ event: 'stop', msg, ...o }); console.error(`STOPPED: ${msg}`); process.exit(1); };

  if (process.env.SHOPIFY_STORE !== cat.STORE) { console.error(`REFUSED: SHOPIFY_STORE is ${process.env.SHOPIFY_STORE}, expected ${cat.STORE}.`); process.exit(2); }
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error(`REFUSED: no manifest at ${manifestPath}; run the dry run first.`); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.qa.errors_by_wave[gate.wave] || manifest.qa.errors_global) { console.error(`REFUSED: QA has ${manifest.qa.errors_by_wave[gate.wave]} wave-${gate.wave} errors and ${manifest.qa.errors_global} global errors (see QA.md).`); process.exit(2); }
  let entries = manifest.waves[gate.wave] || [];
  if (gate.handles) {
    const unknown = gate.handles.filter((h) => !entries.some((e) => e.handle === h));
    if (unknown.length) { console.error(`REFUSED: not in wave ${gate.wave}: ${unknown.join(', ')}`); process.exit(2); }
    entries = entries.filter((e) => gate.handles.includes(e.handle));
  }
  const docs = entries.map((e) => {
    const text = fs.readFileSync(path.join(outDir, e.file), 'utf8');
    if (sha256(text) !== e.sha256) { console.error(`REFUSED: ${e.file} changed since the manifest was written; re-run the dry run.`); process.exit(2); }
    return { entry: e, doc: JSON.parse(text) };
  });

  const gql = async (query, variables) => {
    for (let attempt = 1; ; attempt++) {
      try { return (await graphql(query, variables)).data; } catch (e) {
        if (/throttled/i.test(e.message) && attempt < 6) { await sleep(2000 * attempt); continue; }
        throw e;
      }
    }
  };

  log({ event: 'run-start', products: docs.length, handles: docs.map((d) => d.entry.handle), refresh_description: gate.refreshDescription });
  console.log(`APPLY wave ${gate.wave}: ${docs.length} products, one at a time. Log: ${logFile}`);
  for (const { entry, doc } of docs) {
    const handle = entry.handle;
    const found = (await gql(Q_LOOKUP, { handle })).productByIdentifier;
    const live = found ? {
      id: found.id, handle: found.handle, vendor: found.vendor, status: found.status, tags: found.tags,
      variantsCount: found.variantsCount.count, hasMoreVariants: found.variantsCount.count > found.variants.nodes.length,
      variants: found.variants.nodes,
    } : null;
    const plan = cat.planApply(doc.input, live, { refreshDescription: gate.refreshDescription });
    log({ event: 'plan', handle, action: plan.action, live_id: live ? live.id : null, live_status: live ? live.status : null, kept_variant_ids: plan.kept, new_variants: plan.created, errors: plan.errors });
    if (plan.action === 'refuse') stop(`${handle}: ${plan.errors.join('; ')}`, { handle });

    const res = (await gql(M_SET, { input: plan.input, identifier: plan.identifier, synchronous: false })).productSet;
    if (res.userErrors.length) stop(`${handle}: productSet userErrors ${JSON.stringify(res.userErrors)}`, { handle });
    let op = res.productSetOperation;
    log({ event: 'submitted', handle, operation_id: op && op.id, status: op && op.status });
    const t0 = Date.now();
    while (op && op.status !== 'COMPLETE') {
      if (Date.now() - t0 > 180000) stop(`${handle}: operation ${op.id} not COMPLETE after 180 s (status ${op.status}); check it before re-running`, { handle, operation_id: op.id });
      await sleep(1500);
      op = (await gql(Q_OPERATION, { id: op.id })).productOperation;
    }
    if (!op) stop(`${handle}: no productSetOperation returned`, { handle });
    if (op.userErrors && op.userErrors.length) stop(`${handle}: operation userErrors ${JSON.stringify(op.userErrors)}`, { handle, operation_id: op.id });
    const productId = (op.product && op.product.id) || (live && live.id);
    if (!productId) stop(`${handle}: operation COMPLETE without a product id`, { handle, operation_id: op.id });

    const after = (await gql(Q_VERIFY, { id: productId })).product;
    const afterFlat = after ? { ...after, variants: after.variants.nodes } : null;
    const problems = cat.verifyApplied(plan.input, afterFlat, { action: plan.action });
    log({ event: plan.action === 'create' ? 'created' : 'updated', handle, product_id: productId, status: after && after.status, variants: after && after.variantsCount.count, problems });
    if (problems.length) stop(`${handle}: read-back differs: ${problems.slice(0, 5).join('; ')}`, { handle, product_id: productId });
    console.log(`  ${plan.action} ${handle} -> ${productId} (${after.status}, ${after.variantsCount.count} variants, ${plan.kept} ids kept)`);
    await sleep(1000);
  }
  log({ event: 'run-done', products: docs.length });
  console.log('Done. Collections, metafields, media and the delivery profile are separate steps.');
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  if (flag('help')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  if (flag('apply') || flag('i-have-macs-go')) {
    const gate = cat.applyGate(args);
    if (!gate.ok) { console.error(gate.reason === 'not an apply run' ? 'REFUSED: --i-have-macs-go only means something with --apply. Nothing was sent.' : gate.reason); process.exit(2); }
    await apply(gate);
    return;
  }
  build();
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
