#!/usr/bin/env node
/**
 * Maps pickup-profile Shopify SKUs that Prosol didn't recognise (the counter stock sync's "not at Prosol" list) to
 * Prosol's own codes, by EXACT barcode only (Mac 2026-10-02 "clean up those last few items"). Prosol's catalog can't be
 * searched by barcode, so: find the manufacturers of these product lines (a name search per brand term), list each
 * manufacturer's whole catalog (filter[product_manufacturer_id], 100 a page), and accept a Prosol product only when its
 * barcode equals the Shopify barcode (leading zeros and a trailing ".0" ignored) and exactly one product has it. Cost comes from Prosol's offers (getCost), like Telegram /map. Anything else stays unmapped: it simply never
 * offers counter pickup.
 *
 *   node scripts/trade/map-by-barcode.js            dry run: prints the matches and the misses
 *   node scripts/trade/map-by-barcode.js --apply    adds the matches to scripts/shipstation/sku-map.json
 *
 * Input: the latest data/trade/counter-stock/<ts>.json snapshot. Prosol requests are 2 s apart, one session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const SNAP_DIR = path.join(ROOT, 'data', 'trade', 'counter-stock');
const GAP_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Brand terms whose search results reveal the manufacturers of the unmapped lines.
const BRAND_TERMS = ['AcrylPro', 'RedGard', 'Aqua Mix', 'Prism', 'Polyblend', 'Ultrabond', 'Ardex', 'PL Premium', 'StainBlocker', 'Silicone', 'KERDI', 'Barwalt', 'Shur-Fast', 'Richard', 'Mapei', 'Primer T', 'Tuck Tape'];
const normBarcode = (b) => String(b || '').replace(/\.0+$/, '').replace(/\D/g, '').replace(/^0+/, '');

/** A search term for a product line: the title without brand marks and pack sizes, first two words. */
function termFor(title) {
  const t = String(title || '')
    .replace(/®|™/g, ' ')
    .replace(/^(Schluter|MAPEI|Mapei|AQUA MIX|Custom Building Products|Ardex|Barwalt|Shur-Fast|Richard)\s*[-–—]?\s*/i, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[—–-].*$/, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim();
  return t.split(/\s+/).slice(0, 2).join(' ');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const snapFile = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json')).sort().pop();
  const snap = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, snapFile), 'utf8'));
  const notFound = new Set(Object.entries(snap.lookups).filter(([, v]) => v.status === 'not_found').map(([k]) => k));
  const todo = [];
  for (const p of snap.products) for (const v of p.variants) if (notFound.has(v.prosolSku) && v.sku) todo.push({ sku: v.sku, barcode: v.barcode, title: p.title });
  const withBc = todo.filter((x) => normBarcode(x.barcode));
  console.log(`${todo.length} unmapped variants in ${snapFile}; ${withBc.length} with a barcode`);

  const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');
  const c = new ProsolClientV2();
  const found = [];
  const misses = [];
  let last = 0;
  const get = async (url) => { const w = last + GAP_MS - Date.now(); if (w > 0) await sleep(w); last = Date.now(); return c.apiGet(url); };
  try {
    await c.init();
    // 1. the manufacturers behind these lines
    const mfr = new Set();
    for (const term of BRAND_TERMS) {
      const r = await get(`/api/storefront/products?filter[name]=${encodeURIComponent(term)}&limit=100`);
      if (r.status !== 200) continue;
      for (const p of JSON.parse(r.body).data || []) if (p.product_manufacturer_id) mfr.add(p.product_manufacturer_id);
    }
    // 2. their whole catalogs, indexed by barcode
    const byBarcode = new Map();
    let listed = 0;
    for (const id of mfr) {
      for (let page = 1; page <= 60; page++) {
        const r = await get(`/api/storefront/products?filter[product_manufacturer_id]=${id}&limit=100&page=${page}`);
        if (r.status !== 200) break;
        const j = JSON.parse(r.body);
        for (const p of j.data || []) {
          listed++;
          const b = normBarcode(p.barcode);
          if (b) byBarcode.set(b, [...(byBarcode.get(b) || []), p]);
        }
        if (page >= ((j.meta && j.meta.last_page) || 1)) break;
      }
    }
    console.log(`${mfr.size} manufacturers, ${listed} Prosol products listed, ${byBarcode.size} barcodes`);
    for (const x of withBc) {
      const hits = byBarcode.get(normBarcode(x.barcode)) || [];
      const ids = [...new Set(hits.map((h) => h.id))];
      if (ids.length === 1) found.push({ ...x, prosol: hits[0] });
      else misses.push({ ...x, reason: ids.length ? `${ids.length} Prosol products share the barcode` : 'barcode not in these manufacturers\' Prosol catalogs' });
    }
    for (const f of found) {
      await sleep(GAP_MS);
      const cost = await c.getCost(f.prosol.sku).catch(() => null);
      f.cost = cost;
    }
  } finally { try { await c.close(); } catch {} }

  for (const f of found) console.log(`MATCH ${f.sku.padEnd(14)} -> ${f.prosol.sku} / ${f.prosol.prosol_sku}  ${f.prosol.name && f.prosol.name.en}  cost ${f.cost ? f.cost.cost_cad : '?'}`);
  for (const m of misses) console.log(`miss  ${m.sku.padEnd(14)} ${m.title.slice(0, 60)}: ${m.reason}`);
  for (const x of todo.filter((t) => !normBarcode(t.barcode))) console.log(`nobc  ${x.sku.padEnd(14)} ${x.title.slice(0, 60)}`);

  if (!apply) return console.log(`\nDry run: ${found.length} would be mapped. --apply writes them to the sku-map.`);
  const { liveAddMapping, resolveMappedEntry } = require('../shipstation/run-orders');
  let added = 0;
  for (const f of found) {
    if (resolveMappedEntry(f.sku)) continue;
    if (!f.cost || f.cost.cost_cad == null) { console.log(`skip ${f.sku}: no Prosol cost (never leave cost pending)`); continue; }
    liveAddMapping(f.sku, {
      api_sku: f.prosol.sku, prosol_sku: f.prosol.prosol_sku || f.prosol.sku, product: f.prosol.name && f.prosol.name.en,
      cost_cad: f.cost.cost_cad, retail_cad: f.cost.retail_cad, source: 'barcode-match', cost_source: f.cost.costSource || 'prosol-offers-loc10010',
      barcode: normBarcode(f.barcode), verified: true, added: new Date().toISOString().slice(0, 10),
    });
    added++;
  }
  console.log(`\nAdded ${added} sku-map entries.`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { termFor, normBarcode };
