#!/usr/bin/env node
/**
 * Check Amazon listing status for every ASIN in sku-map.json.
 *
 * For each ASIN, calls SP-API searchListingsItems to get:
 *   - Is there a listing? (yes/no)
 *   - Is there an active offer with price?
 *   - Listing status (ACTIVE / INCOMPLETE / SUPPRESSED / DISCONTINUED)
 *   - Any issues flagged by Amazon
 *
 * Writes report to data/fba/listings-status-<date>.json + console table.
 *
 * Rate limit: searchListingsItems ~5 req/s sustained. Batched 20 ASINs/call
 * with 1s sleep between.
 *
 * Usage:
 *   DISABLE_CRON=1 node scripts/fba/check-listings-status.js
 *   node scripts/fba/check-listings-status.js --only=B0XYZ  # single ASIN
 *   node scripts/fba/check-listings-status.js --status=missing  # filter output
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

const SKU_MAP_PATH = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'sku-map.json');
const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'fba');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (v !== undefined) { args[k.slice(2)] = v; continue; }
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k.slice(2)] = true;
      else { args[k.slice(2)] = next; i++; }
    }
  }
  return args;
}

function classifyItem(item) {
  // summaries[0] carries status + condition; offers[] has price info
  const s = item.summaries?.[0];
  const offers = item.offers || [];
  const status = s?.status?.join(',') || 'NO_STATUS';
  const hasOffer = offers.length > 0 && offers.some((o) => (o.price?.amount ?? 0) > 0);
  if (!s) return 'missing';                  // ASIN not listed by us at all
  if (!hasOffer) return 'no-offer';          // listing exists but no active offer
  if (status.includes('BUYABLE')) return 'buyable';
  if (status.includes('DISCOVERABLE')) return 'discoverable-no-stock';
  return status.toLowerCase();
}

async function main() {
  const args = parseArgs();
  const mappings = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8')).mappings;

  const asins = [];
  for (const [k, v] of Object.entries(mappings)) {
    if (!/^B0[A-Z0-9]{8}$/.test(k)) continue;
    if (typeof v !== 'object') continue;
    if (args.only && k !== args.only) continue;
    asins.push({ asin: k, product: v.product, brand: v.brand, api_sku: v.api_sku, prosol_sku: v.prosol_sku, treeco_sku: v.treeco_sku, map_cad: v.map_cad });
  }
  console.log(`Checking ${asins.length} ASINs...`);

  const results = [];
  const batchSize = 20;
  for (let i = 0; i < asins.length; i += batchSize) {
    const batch = asins.slice(i, i + batchSize);
    try {
      const data = await sp.searchListingsItems({ asins: batch.map((b) => b.asin) });
      const itemsByAsin = {};
      for (const it of (data.items || [])) {
        const a = it.asin || it.summaries?.[0]?.asin;
        if (a) itemsByAsin[a] = it;
      }
      for (const b of batch) {
        const it = itemsByAsin[b.asin];
        if (!it) {
          results.push({ ...b, sku: null, status: 'missing', listingStatus: null, price: null, issueCount: 0, issues: [] });
        } else {
          const s = it.summaries?.[0];
          const offer = (it.offers || [])[0];
          // fulfillmentAvailability per Amazon: array of
          // { fulfillmentChannelCode: 'DEFAULT'|'AMAZON_NA'|..., quantity }
          // DEFAULT = MFN (merchant-fulfilled). AMAZON_* = FBA.
          const fa = it.fulfillmentAvailability || [];
          const mfn = fa.filter((x) => !x.fulfillmentChannelCode || x.fulfillmentChannelCode === 'DEFAULT');
          const fba = fa.filter((x) => x.fulfillmentChannelCode && x.fulfillmentChannelCode !== 'DEFAULT');
          const channels = [];
          if (mfn.length) channels.push('MFN');
          if (fba.length) channels.push('FBA');
          const mfnQty = mfn.reduce((s, x) => s + (x.quantity || 0), 0);
          const fbaQty = fba.reduce((s, x) => s + (x.quantity || 0), 0);
          results.push({
            ...b,
            sku: it.sku || s?.sellerSku || null,
            status: classifyItem(it),
            listingStatus: s?.status?.join(',') || null,
            channels: channels.join(',') || null,
            mfn_qty: mfnQty,
            fba_qty: fbaQty,
            condition: s?.conditionType || null,
            productType: s?.productType || null,
            itemName: s?.itemName || null,
            price: offer?.price?.amount || null,
            offerCount: (it.offers || []).length,
            issueCount: (it.issues || []).length,
            issues: (it.issues || []).map((iss) => ({ code: iss.code, severity: iss.severity, message: iss.message })),
            fulfillmentAvailability: fa,
          });
        }
      }
      console.log(`  batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(asins.length / batchSize)}: ${batch.length} ASINs`);
    } catch (e) {
      console.warn(`  batch ${Math.floor(i / batchSize) + 1} failed: ${e.message}`);
      for (const b of batch) results.push({ ...b, sku: null, status: 'error', error: e.message });
    }
    if (i + batchSize < asins.length) await new Promise((r) => setTimeout(r, 1100));
  }

  // Summary
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  console.log('\n=== LISTING STATUS SUMMARY ===');
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(25)} ${n}`);
  }

  const filter = args.status;
  if (filter) {
    console.log(`\n=== ASINs with status="${filter}" ===`);
    for (const r of results.filter((r) => r.status === filter)) {
      console.log(`  ${r.asin} · ${(r.brand || 'nobrand').padEnd(10)} · ${(r.product || r.itemName || '').slice(0, 55)}`);
      if (r.issues?.length) for (const iss of r.issues.slice(0, 3)) console.log(`     ⚠ [${iss.severity}] ${iss.code}: ${iss.message?.slice(0, 100)}`);
    }
  } else {
    console.log(`\n=== Missing (no listing at all) ===`);
    for (const r of results.filter((r) => r.status === 'missing').slice(0, 20)) {
      console.log(`  ${r.asin} · ${(r.brand || 'nobrand').padEnd(10)} · ${(r.product || '').slice(0, 55)}`);
    }
    console.log(`\n=== No offer (listed but no active offer) ===`);
    for (const r of results.filter((r) => r.status === 'no-offer')) {
      console.log(`  ${r.asin} · sku=${r.sku} · ${(r.product || r.itemName || '').slice(0, 55)}`);
      if (r.issues?.length) for (const iss of r.issues.slice(0, 2)) console.log(`     ⚠ [${iss.severity}] ${iss.code}: ${(iss.message || '').slice(0, 100)}`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `listings-status-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pulledAt: new Date().toISOString(), asinCount: results.length, byStatus, results }, null, 2));
  console.log(`\n✓ wrote ${outPath}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
