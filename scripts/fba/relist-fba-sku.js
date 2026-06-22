#!/usr/bin/env node
/**
 * Relist a manufacturer-barcode (stickerless, fnSku==ASIN) FBA SKU as a new
 * offer-only Amazon-barcode SKU so it gets an X00 FNSKU and can be inbounded.
 *
 * Amazon CA stopped accepting stickerless inbound (FBA_INB_0465). This is the
 * one-command fix. Proven flow (memory reference_fba_reseller_amazon_barcode):
 *   PUT /listings/2021-08-01/items offer-only, clone fulfillment_availability
 *   (AMAZON_NA) + merchant_suggested_asin + price → Amazon assigns X00 FNSKU.
 *
 * GOTCHA: the new SKU will NOT register an FNSKU if the ASIN still has live
 * manufacturer-barcode FBA stock under the old SKU. This script refuses to
 * commit when stranded units exist (override with --force at your own risk).
 *
 * Usage:
 *   node scripts/fba/relist-fba-sku.js --old-sku=8D-MV2H-J3A4 --validate
 *   node scripts/fba/relist-fba-sku.js --old-sku=8D-MV2H-J3A4 --price=370.04 --commit
 *   [--new-sku=DHERT105BW-FBA]  [--asin=B0...]  [--force]
 */
require('dotenv').config();
const sp = require('../../lib/sp-api');

const arg = (k, d = null) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes('--' + k);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MP = (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');
const SELLER = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '');

function deriveNewSku(oldSku, prosolSku, asin) {
  const base = (prosolSku || oldSku || asin).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return base + '-FBA';
}

async function fbaUnitsForAsin(asin) {
  const all = await sp.getAllFbaInventory();
  let units = 0; const breakdown = [];
  for (const x of all.filter(r => r.asin === asin)) {
    const d = x.inventoryDetails || {};
    const n = (d.fulfillableQuantity || 0) + (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) +
      (d.inboundReceivingQuantity || 0) + (d.reservedQuantity?.totalReservedQuantity || 0) +
      (d.unfulfillableQuantity?.totalUnfulfillableQuantity || 0) + (d.researchingQuantity?.totalResearchingQuantity || 0);
    units += n;
    if (n > 0) breakdown.push(`${x.sellerSku}(fnSku=${x.fnSku}): ${n}`);
  }
  return { units, breakdown };
}

(async () => {
  const oldSku = arg('old-sku');
  if (!oldSku) { console.error('--old-sku required'); process.exit(1); }
  const validate = flag('validate') || !flag('commit');
  const mode = flag('commit') ? 'commit' : 'VALIDATION_PREVIEW';

  console.log(`\nRelist ${oldSku} → offer-only Amazon-barcode SKU  [${flag('commit') ? 'COMMIT' : 'VALIDATE (dry-run)'}]\n`);

  // 1. read old listing
  const old = await sp.getListingsItem(oldSku, { includedData: 'summaries,attributes,fulfillmentAvailability' });
  const summary = old?.summaries?.[0] || {};
  const asin = arg('asin') || summary.asin;
  const productType = summary.productType;
  if (!asin || !productType) { console.error('Could not resolve asin/productType from ' + oldSku, JSON.stringify(summary)); process.exit(1); }
  console.log(`  old fnSku: ${summary.fnSku}  asin: ${asin}  productType: ${productType}`);

  // 2. stranded-stock gotcha check
  const { units, breakdown } = await fbaUnitsForAsin(asin);
  console.log(`  FBA units on ASIN: ${units}${units ? ' → ' + breakdown.join(', ') : ' (clean — converts instantly)'}`);
  if (units > 0 && flag('commit') && !flag('force')) {
    console.error(`\n⛔ ABORT: ${units} FBA units still on ${asin}. New SKU won't register an FNSKU until cleared (removal order, ~days). Re-run after clearing, or --force.`);
    process.exit(2);
  }

  // 3. price (default: clone old offer, else require --price)
  let price = arg('price');
  if (!price) {
    const po = (old?.attributes?.purchasable_offer || [])[0];
    price = po?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  }
  if (!price) { console.error('No --price and could not clone old price. Pass --price=<cad>.'); process.exit(1); }
  price = Number(price);

  const newSku = arg('new-sku') || deriveNewSku(oldSku, arg('prosol'), asin);
  console.log(`  new SKU: ${newSku}  price: $${price}`);

  // productType-specific required attrs via --attr name=value (value JSON-parsed if possible).
  // Repeatable: validate catches what's missing; add it here without touching the script.
  const extraAttrs = {};
  for (const a of process.argv.filter(x => x.startsWith('--attr='))) {
    const kv = a.slice('--attr='.length); const i = kv.indexOf('=');
    const k = kv.slice(0, i); let v = kv.slice(i + 1);
    try { v = JSON.parse(v); } catch {}
    extraAttrs[k] = [{ value: v, marketplace_id: MP }];
  }

  // 4. existence check
  try {
    const ex = await sp.getListingsItem(newSku, { includedData: 'summaries' });
    if (ex?.summaries?.length) { console.log(`  NOTE: ${newSku} already exists (fnSku=${ex.summaries[0].fnSku}). Nothing to create.`); return; }
  } catch { /* not found = good */ }

  // 5. build offer-only PUT
  const body = {
    productType,
    requirements: 'LISTING_OFFER_ONLY',
    attributes: {
      condition_type: [{ value: 'new_new', marketplace_id: MP }],
      merchant_suggested_asin: [{ value: asin, marketplace_id: MP }],
      fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_NA', marketplace_id: MP }],
      purchasable_offer: [{ marketplace_id: MP, currency: 'CAD', our_price: [{ schedule: [{ value_with_tax: price }] }] }],
      // Near-universal offer-only safety attrs (override/extend via --attr).
      // Harmless warning (90000900) if a productType doesn't use one.
      batteries_required: [{ value: false, marketplace_id: MP }],
      supplier_declared_dg_hz_regulation: [{ value: 'not_applicable', marketplace_id: MP }],
      ...extraAttrs,
    },
  };
  const query = { marketplaceIds: MP, issueLocale: 'en_CA' };
  if (mode === 'VALIDATION_PREVIEW') query.mode = 'VALIDATION_PREVIEW';

  const res = await sp.spApiRequest('PUT', `/listings/2021-08-01/items/${encodeURIComponent(SELLER)}/${encodeURIComponent(newSku)}`, { query, body });
  let parsed = null; try { parsed = JSON.parse(res.body); } catch {}
  console.log(`\n  PUT status: ${res.status}  submission: ${parsed?.submissionId || '-'}  result: ${parsed?.status || '-'}`);
  const issues = parsed?.issues || [];
  if (issues.length) { console.log('  issues:'); for (const i of issues) console.log(`    [${i.severity}] ${i.code} ${i.message}`); }
  else console.log('  issues: none ✅');

  if (mode === 'VALIDATION_PREVIEW') {
    const errs = issues.filter(i => i.severity === 'ERROR');
    console.log(errs.length ? `\n❌ ${errs.length} ERROR(s) — fix before --commit.` : '\n✅ Payload valid. Re-run with --commit to create the listing.');
    return;
  }

  // 6a. delete the old manufacturer-barcode SKU — REQUIRED to unblock FNSKU
  // registration (Amazon won't mix barcode types on one ASIN's FBA slot, even
  // with 0 stranded stock). Gated behind --delete-old since it removes a live
  // listing. Verify first that the old SKU is FBA-only and NOT your buy-box offer.
  if (flag('delete-old')) {
    console.log(`\n  deleting old SKU ${oldSku} to unblock registration...`);
    const del = await sp.spApiRequest('DELETE', `/listings/2021-08-01/items/${encodeURIComponent(SELLER)}/${encodeURIComponent(oldSku)}`, { query: { marketplaceIds: MP } });
    console.log(`    DELETE status: ${del.status}`);
  } else {
    console.log(`\n  NOTE: old SKU ${oldSku} left in place. If FNSKU doesn't register, re-run with --delete-old (removes the barcode conflict).`);
  }

  // 6b. poll for the X00 FNSKU
  console.log('\n  polling for FNSKU registration (up to ~60s)...');
  for (let i = 0; i < 6; i++) {
    await sleep(10000);
    try {
      const it = await sp.getListingsItem(newSku, { includedData: 'summaries' });
      const fn = it?.summaries?.[0]?.fnSku;
      if (fn && /^X0/.test(fn)) { console.log(`\n✅ DONE — ${newSku} registered FNSKU ${fn}. Restock-ready (stickered). Update sku-map + queue the PO.`); return; }
      console.log(`    poll ${i + 1}: fnSku=${fn || '(none yet)'}`);
    } catch (e) { console.log(`    poll ${i + 1}: ${e.message}`); }
  }
  console.log('\n⚠️ Created but FNSKU not X00 yet — re-check in a few min: node scripts/fba/scan-fnsku-state.js --asin=' + asin);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
