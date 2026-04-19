#!/usr/bin/env node
/**
 * Batch-fix FBM listings that are DISCOVERABLE due to missing condition_type.
 *
 * Amazon's Seller Central marks these as "Missing Offer — Add missing offer
 * details" and blocks BUYABLE status until condition_type is set. PATCHing
 * /attributes/condition_type = 'new_new' via Listings Items API clears the
 * 8115 warning and lets the listing propagate to BUYABLE.
 *
 * Reads the latest data/fba/listings-status-<date>.json report to find
 * candidates, then PATCHes each one. Dry-run mode available.
 *
 * Usage:
 *   node scripts/fba/fix-missing-condition.js --dry-run
 *   node scripts/fba/fix-missing-condition.js --apply
 *   node scripts/fba/fix-missing-condition.js --apply --only=KERDI200,KBKIT
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

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

async function patchCondition(sku, productType, condition = 'new_new') {
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
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  if (res.status !== 200) {
    throw new Error(`PATCH ${sku}: HTTP ${res.status} — ${res.body.slice(0, 200)}`);
  }
  return { submissionId: parsed?.submissionId, issues: parsed?.issues || [] };
}

async function main() {
  const args = parseArgs();
  const apply = !!args.apply;
  const dryRun = !apply;
  const onlyFilter = args.only ? new Set(String(args.only).split(',')) : null;

  // Load latest listings-status report
  const files = fs.readdirSync(OUT_DIR).filter((f) => /^listings-status-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) {
    console.error('No listings-status report found. Run check-listings-status.js first.');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(path.join(OUT_DIR, files[files.length - 1]), 'utf8'));
  console.log(`Using report: ${files[files.length - 1]} (${report.asinCount} ASINs)`);

  // Candidates: have sku + issue code 8115 (invalid condition type)
  const candidates = report.results.filter((r) => {
    if (!r.sku) return false;
    if (!(r.issues || []).some((iss) => iss.code === '8115')) return false;
    if (onlyFilter && !onlyFilter.has(r.sku)) return false;
    return true;
  });
  console.log(`Candidates: ${candidates.length}`);
  for (const c of candidates) console.log(`  ${c.asin} · ${c.sku.padEnd(22)} · ${c.productType} · ${(c.itemName || c.product || '').slice(0, 50)}`);

  if (dryRun) {
    console.log('\n(dry-run; pass --apply to PATCH)');
    return;
  }

  console.log(`\n→ PATCHing ${candidates.length} SKUs...`);
  const results = [];
  for (const c of candidates) {
    try {
      const r = await patchCondition(c.sku, c.productType, 'new_new');
      results.push({ ...c, ok: true, submissionId: r.submissionId });
      console.log(`  ✓ ${c.sku} · submission ${r.submissionId}`);
    } catch (e) {
      results.push({ ...c, ok: false, error: e.message });
      console.log(`  ✗ ${c.sku} · ${e.message}`);
    }
    // Rate limit — Listings Items PATCH is 5/s
    await new Promise((r) => setTimeout(r, 300));
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n✓ ${ok}/${results.length} patched`);
  console.log(`\nAmazon propagation: attribute.condition_type updates within ~1 min (confirm with API).`);
  console.log(`Listing BUYABLE status typically flips within 15-60 min (visible in Seller Central).`);

  const outPath = path.join(OUT_DIR, `fix-missing-condition-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), dryRun, ok, total: results.length, results }, null, 2));
  console.log(`\n✓ log: ${outPath}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
