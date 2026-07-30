#!/usr/bin/env node
/**
 * Create merchant-fulfilled offers on demand-ranked ASINs we already map but
 * don't sell. This is the catalog-add lever from the $100K plan.
 *
 * Deliberately merchant-fulfilled, not FBA: we drop-ship these from Prosol, so
 * an offer can go live today with no inbound shipment, no freight and no
 * storage risk. Winners get converted to FBA later, once they've proven demand.
 *
 * Pricing is MAP, from Schluter's own MAP list — never a guess and never below
 * the floor. Six listings were held back this morning for sitting under MAP,
 * and a below-MAP price is what suppressed the $39.6K/yr thermostat in the
 * first place. A SKU with no resolvable MAP is skipped, not estimated.
 *
 * Offer-only PUT shape is the one proven in relist-fba-sku.js.
 *
 * Usage:
 *   node scripts/fba/create-offers.js --top=11              # dry run (validates)
 *   node scripts/fba/create-offers.js --top=11 --commit
 *   node scripts/fba/create-offers.js --max-rank=250 --commit
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');
const schluterMap = require('../../lib/schluter-map');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'fba');
const SNAPS = path.join(DATA, 'snapshots');
const MP = (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');
const SELLER = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const COMMIT = process.argv.includes('--commit');
const TOP = arg('top') ? Number(arg('top')) : null;
const MAX_RANK = arg('max-rank') ? Number(arg('max-rank')) : null;
const QTY = Number(arg('qty', 10));
const MIN_PROSOL = Number(arg('min-prosol', 5));
// Without an explicit shipping group Amazon assigns "legacy-template-id"
// ("Migrated Template"), which leaves the listing stuck at Missing Offer with
// no price and zero quantity — created but not sellable. FREE SHIPPING is our
// dominant template (113 of 202 active MFN listings) and matches how the
// competition ships these.
const SHIPPING_GROUP = arg('shipping-group', '9c07060c-5452-430c-9fd7-da0139cce6a4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newest = (dir, p) => {
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(p) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();

/** Seller SKU for the new offer. -MFN marks the fulfilment channel. */
const offerSku = (prosolSku) => `${String(prosolSku).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}-MFN`;

(async () => {
  const mappings = JSON.parse(fs.readFileSync(newest(DATA, 'gap-asin-mappings-'), 'utf8')).results
    .filter((r) => r.tier === 'PART#' || r.tier === 'EAN');
  const mapData = schluterMap.loadMap();
  console.log(`Schluter MAP list: ${path.basename(mapData.path)} (effective ${mapData.effectiveDate}) · ${mapData.records.length} records`);

  const catPath = newest(SNAPS, 'prosol-catalog-10008-');
  const prosolBySku = {};
  for (const p of JSON.parse(fs.readFileSync(catPath, 'utf8')).products) {
    for (const k of [p.prosol_sku, p.sku, p.external_id]) if (k) prosolBySku[norm(k)] = p;
  }

  let candidates = mappings
    .filter((r) => r.rank && Number(r.prosol_qty) >= MIN_PROSOL)
    .sort((a, b) => a.rank - b.rank);
  if (MAX_RANK) candidates = candidates.filter((r) => r.rank <= MAX_RANK);
  if (TOP) candidates = candidates.slice(0, TOP);

  console.log(`candidates: ${candidates.length} (qty ${QTY} each, min Prosol stock ${MIN_PROSOL})\n`);

  const plan = [];
  const skipped = [];
  for (const c of candidates) {
    const rec = schluterMap.findByProsolSku(mapData, c.prosol_sku)
      || schluterMap.findByProsolSku(mapData, c.api_sku);
    const map = rec?.mapCad ?? null;
    if (!map) { skipped.push({ ...c, why: 'no MAP resolved — refusing to guess a price' }); continue; }

    const pc = prosolBySku[norm(c.prosol_sku)];
    const cost = null;   // cost lives in sku-map/item_costs; margin sanity below uses MSRP
    const sku = offerSku(c.prosol_sku);

    // Never create a duplicate offer.
    try {
      const ex = await sp.getListingsItem(sku, { includedData: 'summaries' });
      if (ex?.summaries?.length) { skipped.push({ ...c, why: `offer SKU ${sku} already exists` }); await sleep(250); continue; }
    } catch { /* 404 = good */ }
    await sleep(250);

    plan.push({ ...c, offer_sku: sku, price: map, map, retail: rec.retailCad, prosol_qty: pc ? pc.available_quantity : c.prosol_qty });
  }

  console.log('═══ PLAN ═══');
  console.log('rank'.padStart(5) + '  ' + 'ASIN'.padEnd(12) + 'offer SKU'.padEnd(20) + 'price'.padStart(9) + 'retail'.padStart(9) + 'stk'.padStart(6) + '  product');
  for (const p of plan) {
    console.log(String(p.rank).padStart(5) + '  ' + p.asin.padEnd(12) + p.offer_sku.padEnd(20) +
      ('$' + p.price.toFixed(2)).padStart(9) + (p.retail ? '$' + p.retail.toFixed(2) : '—').padStart(9) +
      String(p.prosol_qty).padStart(6) + '  ' + String(p.title).slice(0, 46));
  }
  if (skipped.length) {
    console.log(`\n─── skipped (${skipped.length}) ───`);
    for (const s of skipped) console.log(`  ${String(s.asin).padEnd(12)} ${s.why}`);
  }

  console.log(`\n─── ${COMMIT ? 'CREATING' : 'VALIDATING'} ${plan.length} offers ───`);
  const results = [];
  for (const p of plan) {
    // productType comes from the ASIN's catalog record; offer-only still needs it.
    let productType = null;
    try {
      const raw = await sp.spApiRequest('GET', `/catalog/2022-04-01/items/${p.asin}`, { query: { marketplaceIds: MP, includedData: 'productTypes' } });
      productType = JSON.parse(raw.body)?.productTypes?.[0]?.productType;
    } catch { /* fall through */ }
    if (!productType) { console.log(`  ✗ ${p.offer_sku.padEnd(20)} could not resolve productType`); results.push({ ...p, ok: false, stage: 'productType' }); continue; }

    const body = {
      productType,
      requirements: 'LISTING_OFFER_ONLY',
      attributes: {
        condition_type: [{ value: 'new_new', marketplace_id: MP }],
        merchant_suggested_asin: [{ value: p.asin, marketplace_id: MP }],
        fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: QTY, marketplace_id: MP }],
        purchasable_offer: [{ marketplace_id: MP, currency: 'CAD', our_price: [{ schedule: [{ value_with_tax: p.price }] }] }],
        merchant_shipping_group: [{ value: SHIPPING_GROUP, marketplace_id: MP }],
        batteries_required: [{ value: false, marketplace_id: MP }],
        supplier_declared_dg_hz_regulation: [{ value: 'not_applicable', marketplace_id: MP }],
      },
    };

    const put = async (mode) => {
      const query = { marketplaceIds: MP, issueLocale: 'en_CA' };
      if (mode) query.mode = mode;
      const res = await sp.spApiRequest('PUT', `/listings/2021-08-01/items/${encodeURIComponent(SELLER)}/${encodeURIComponent(p.offer_sku)}`, { query, body });
      let j = null; try { j = JSON.parse(res.body); } catch {}
      return { http: res.status, status: j?.status, issues: j?.issues || [], submissionId: j?.submissionId, raw: res.body };
    };

    const v = await put('VALIDATION_PREVIEW');
    const verr = v.issues.filter((i) => i.severity === 'ERROR');
    if (v.http !== 200 || verr.length) {
      console.log(`  ✗ ${p.offer_sku.padEnd(20)} validation: ${verr.map((e) => `${e.code} ${e.message}`).join('; ').replace(/\s+/g, ' ').slice(0, 120) || 'http ' + v.http}`);
      results.push({ ...p, ok: false, stage: 'validate', issues: verr });
      await sleep(700);
      continue;
    }
    if (!COMMIT) {
      console.log(`  ✓ ${p.offer_sku.padEnd(20)} validates clean @ $${p.price.toFixed(2)}`);
      results.push({ ...p, ok: true, stage: 'validate-only' });
      await sleep(700);
      continue;
    }
    const r = await put(null);
    const rerr = r.issues.filter((i) => i.severity === 'ERROR');
    const ok = r.http === 200 && !rerr.length;
    console.log(`  ${ok ? '✓' : '✗'} ${p.offer_sku.padEnd(20)} ${ok ? `CREATED @ $${p.price.toFixed(2)}` : rerr.map((e) => e.code).join(',')}`);
    results.push({ ...p, ok, stage: 'commit', submissionId: r.submissionId, issues: rerr });
    await sleep(900);
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} ${COMMIT ? 'created' : 'validated'}.`);
  if (COMMIT && ok) console.log('Amazon takes a few minutes to make new offers buyable.');

  const out = path.join(DATA, `created-offers-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), committed: COMMIT, qty: QTY, plan, skipped, results }, null, 1));
  console.log(`✓ wrote ${out}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
