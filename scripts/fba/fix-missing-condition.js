#!/usr/bin/env node
/**
 * Batch-fix FBM listings that are DISCOVERABLE due to missing condition_type.
 *
 * Amazon's Seller Central marks these as "Missing Offer — Add missing offer
 * details" and blocks BUYABLE status until condition_type is set. The
 * Listings Items API validation throws WARNING code 8115 on these. PATCHing
 * /attributes/condition_type = 'new_new' clears the warning and lets the
 * listing propagate to BUYABLE over the next ~15-60 minutes.
 *
 * Paginates through ALL our listings (not just sku-map ASINs) so newly-
 * added Seller Central listings that haven't been mapped yet get caught.
 *
 * Usage:
 *   node scripts/fba/fix-missing-condition.js --dry-run
 *   node scripts/fba/fix-missing-condition.js --apply
 *   node scripts/fba/fix-missing-condition.js --apply --only=KERDI200,KBKIT
 *   node scripts/fba/fix-missing-condition.js --apply --condition=new_open_box
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'fba');
const ISSUE_CODE = '8115';

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

async function scanAllListings(onlyFilter) {
  const sellerId = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await sp.getSellerId();
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  let pageToken = null;
  const candidates = [];
  let page = 0;
  do {
    const q = { marketplaceIds: marketplaceId, pageSize: 20, includedData: 'summaries,issues' };
    if (pageToken) q.pageToken = pageToken;
    const res = await sp.spApiRequest('GET', `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, { query: q });
    if (res.status !== 200) throw new Error(`searchListingsItems page ${page}: ${res.status} — ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    for (const it of (data.items || [])) {
      if (!(it.issues || []).some((iss) => iss.code === ISSUE_CODE)) continue;
      const sku = it.sku || it.summaries?.[0]?.sellerSku;
      if (!sku) continue;
      if (onlyFilter && !onlyFilter.has(sku)) continue;
      candidates.push({
        asin: it.summaries?.[0]?.asin,
        sku,
        productType: it.summaries?.[0]?.productType,
        status: it.summaries?.[0]?.status?.join(',') || null,
        itemName: it.summaries?.[0]?.itemName,
      });
    }
    pageToken = data.pagination?.nextToken;
    page++;
    if (pageToken) await new Promise((r) => setTimeout(r, 300));
  } while (pageToken && page < 100);
  return candidates;
}

async function patchCondition(sku, productType, condition) {
  const sellerId = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await sp.getSellerId();
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  const body = {
    productType,
    patches: [{
      op: 'replace',
      path: '/attributes/condition_type',
      value: [{ value: condition, marketplace_id: marketplaceId }],
    }],
  };
  const res = await sp.spApiRequest('PATCH', `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, { query: { marketplaceIds: marketplaceId }, body });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} — ${res.body.slice(0, 200)}`);
  const parsed = JSON.parse(res.body || '{}');
  return { submissionId: parsed.submissionId, issues: parsed.issues || [] };
}

async function main() {
  const args = parseArgs();
  const apply = !!args.apply;
  const condition = args.condition || 'new_new';
  const onlyFilter = args.only ? new Set(String(args.only).split(',')) : null;

  console.log(`Scanning all listings for issue ${ISSUE_CODE}${onlyFilter ? ` (filtered to ${onlyFilter.size} SKUs)` : ''}...`);
  const candidates = await scanAllListings(onlyFilter);
  console.log(`Found ${candidates.length} listings with issue ${ISSUE_CODE}`);
  for (const c of candidates) {
    console.log(`  ${c.asin} · ${c.sku.padEnd(22)} · ${c.productType || '?'} · ${c.status} · ${(c.itemName || '').slice(0, 50)}`);
  }

  if (!apply) {
    console.log(`\n(dry-run; pass --apply to PATCH condition_type=${condition})`);
    return;
  }

  console.log(`\n→ PATCHing ${candidates.length} SKUs with condition_type=${condition}...`);
  const results = [];
  for (const c of candidates) {
    try {
      const r = await patchCondition(c.sku, c.productType, condition);
      console.log(`  ✓ ${c.sku.padEnd(22)} · submission ${r.submissionId}`);
      results.push({ ...c, ok: true, submissionId: r.submissionId });
    } catch (e) {
      console.log(`  ✗ ${c.sku.padEnd(22)} · ${e.message}`);
      results.push({ ...c, ok: false, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n✓ ${ok}/${results.length} patched`);
  console.log(`Amazon propagation: attribute visible within ~1 min; BUYABLE status flips in 15-60 min.`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `fix-missing-condition-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), condition, ok, total: results.length, results }, null, 2));
  console.log(`\n✓ log: ${outPath}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { main, scanAllListings, patchCondition };
