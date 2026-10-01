#!/usr/bin/env node
/**
 * sku-map entries for the Schluter profile catalogue (02 task B.2). Builds them with lib/trade-skumap.js from the
 * catalogue manifest and a read-only check of the store, and writes them into scripts/shipstation/sku-map.json only
 * with --write.
 *
 * Reads: <catalog-dir>/payloads/manifest.json (variants: Prosol code, PO code, cost, MAP, delivery, handle),
 *        <catalog-dir>/variants.csv (Schluter's MAP description, used as the entry's product name),
 *        the MAP list date through lib/schluter-map.js, and Shopify (read only): each catalogue product's status and
 *        variant SKUs, so an entry is only written for a SKU that is on its product exactly once.
 * Writes: <catalog-dir>/skumap/premap-<date>.csv (one row per catalogue variant, with any problem), and with --write
 *         the catalogue block at the end of "mappings" in this checkout's sku-map.json (replaced in place on a re-run;
 *         curated keys are never overwritten). Nothing is deployed: a deploy is a separate step (divergence check on
 *         the Mini, commit, push, pull, verified hard restart).
 *
 * Usage: node scripts/trade/premap-schluter.js [--status=active|any] [--write] [--catalog-dir=<dir>]
 *   --status=active (default) maps only products that are ACTIVE on Shopify, the "live SKUs only" rule;
 *   --status=any also maps DRAFT products (harmless: a draft can't be ordered) so entries can land before activation.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const sm = require(path.join(ROOT, 'lib', 'trade-skumap'));
const cat = require(path.join(ROOT, 'lib', 'trade-catalog'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const DEFAULT_CATALOG_DIR = '/Users/mvcddy91/daddy-dev/cfc-projects/02-yf-schluter-trade/data/catalog';
const catalogDir = opt('catalog-dir') || process.env.TRADE_CATALOG_DIR || DEFAULT_CATALOG_DIR;
const STATUS = opt('status') || 'active';
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');
const bcDate = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10); // BC is UTC-7 all year
const csvEsc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const Q = `query($h: String!) { productByIdentifier(identifier: { handle: $h }) {
  id status vendor title variantsCount { count } variants(first: 250) { nodes { sku selectedOptions { value } } } } }`;

async function main() {
  if (!['active', 'any'].includes(STATUS)) throw new Error('--status must be active or any');
  const manifest = JSON.parse(fs.readFileSync(path.join(catalogDir, 'payloads', 'manifest.json'), 'utf8'));
  const mapText = new Map(cat.parseCsv(fs.readFileSync(path.join(catalogDir, 'variants.csv'), 'utf8')).map((r) => [r.sku, r.map_text]));
  const mapEffective = require(path.join(ROOT, 'lib', 'schluter-map')).loadMap().effectiveDate;
  const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
  const date = bcDate();

  const handles = [...new Set(manifest.variants.map((v) => v.handle))];
  const live = new Map();
  for (const h of handles) {
    const p = (await graphql(Q, { h })).data.productByIdentifier;
    live.set(h, p);
  }

  const rows = [];
  const entries = [];
  const seen = new Set();
  for (const v of manifest.variants) {
    const p = live.get(v.handle);
    const problems = [];
    if (!p) problems.push('product not found');
    else {
      if (p.vendor !== 'Schluter') problems.push(`vendor ${p.vendor}`);
      if (p.variantsCount.count > p.variants.nodes.length) problems.push('over 250 variants');
      const hits = p.variants.nodes.filter((x) => x.sku === v.sku);
      if (hits.length !== 1) problems.push(`${hits.length} variants with this SKU on the product`);
      else {
        const lineName = `${p.title} - ${hits[0].selectedOptions.map((o) => o.value).join(' / ')}`;
        if (sm.trailingSku(lineName)) problems.push(`order line name ends in a code: ${sm.trailingSku(lineName)}`);
      }
    }
    if (seen.has(v.sku)) problems.push('SKU twice in the manifest');
    seen.add(v.sku);
    const { entry, problems: entryProblems } = sm.buildEntry(v, { mapText: mapText.get(v.sku), date, mapEffective });
    problems.push(...entryProblems);
    const status = p ? p.status : null;
    const inScope = STATUS === 'any' ? ['ACTIVE', 'DRAFT'].includes(status) : status === 'ACTIVE';
    if (!problems.length && inScope) entries.push([v.sku, entry]);
    rows.push({ sku: v.sku, handle: v.handle, status, in_scope: inScope, ship_mode: entry.ship_mode, api_sku: entry.api_sku, prosol_sku: entry.prosol_sku, cost_cad: entry.cost_cad, map_cad: entry.map_cad, problems: problems.join('; ') });
  }

  const outDir = path.join(catalogDir, 'skumap');
  fs.mkdirSync(outDir, { recursive: true });
  const cols = ['sku', 'handle', 'status', 'in_scope', 'ship_mode', 'api_sku', 'prosol_sku', 'cost_cad', 'map_cad', 'problems'];
  const csvFile = path.join(outDir, `premap-${date}.csv`);
  fs.writeFileSync(csvFile, `${[cols.join(','), ...rows.map((r) => cols.map((c) => csvEsc(r[c])).join(','))].join('\n')}\n`);

  const raw = fs.readFileSync(SKU_MAP, 'utf8');
  const note = `=== SCHLUTER PROFILES CATALOGUE (02 premap-schluter.js, ${date}, status=${STATUS}; replaced as a block, never hand-edit) ===`;
  const result = sm.applyBlock(raw, entries, note);
  const problemRows = rows.filter((r) => r.problems);
  const pickup = entries.filter(([, e]) => e.ship_mode === 'pickup_only').length;
  console.log(`premap-schluter ${date} status=${STATUS}: ${rows.length} catalogue variants, ${entries.length} entries (${pickup} pickup_only, ${entries.length - pickup} ship), ${problemRows.length} with problems, ${result.skipped.length} kept as curated (${result.skipped.join(', ') || 'none'})`);
  for (const r of problemRows.slice(0, 15)) console.log(`  PROBLEM ${r.sku} (${r.handle}): ${r.problems}`);
  console.log(`  review CSV: ${csvFile}`);
  if (!flag('write')) { console.log('  dry run: sku-map.json not touched (--write to write the block)'); return; }
  fs.writeFileSync(SKU_MAP, result.text);
  console.log(`  wrote ${result.written.length} entries to ${SKU_MAP} (${(Buffer.byteLength(result.text) / 1024).toFixed(0)} KB). Not deployed.`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
