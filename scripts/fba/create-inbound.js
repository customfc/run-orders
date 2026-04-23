#!/usr/bin/env node
/**
 * Create an FBA inbound plan from a sent PO draft.
 *
 * Usage:
 *   node scripts/fba/create-inbound.js --draft draft-2026-04-17-mo2vr9q0
 *   node scripts/fba/create-inbound.js --draft <id> --vendor treeco --source treeco_delta
 *
 * Resolves each draft line to its Amazon MSKU from the latest inventory-
 * planning snapshot (falls back to ASIN if MSKU not found), picks a source
 * address from lib/fba-inbound-plans.js SOURCE_ADDRESSES, and calls
 * createInboundPlan. Saves state to data/fba/inbound-plans/<planKey>.json.
 *
 * This is step 1 of 5. After plan creation, run step 2 (packing options)
 * via a separate script once it's built.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const inbound = require('../../lib/sp-api-inbound');
const plans = require('../../lib/fba-inbound-plans');
const { loadLatestSnapshot } = require('../../lib/fba-signals');

const DRAFTS_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'po-drafts');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      args[k.slice(2)] = v !== undefined ? v : process.argv[++i];
    }
  }
  return args;
}

function loadDraft(draftId) {
  const sent = path.join(DRAFTS_DIR, 'sent', `${draftId}.json`);
  if (fs.existsSync(sent)) return JSON.parse(fs.readFileSync(sent, 'utf8'));
  const current = path.join(DRAFTS_DIR, 'current.json');
  if (fs.existsSync(current)) {
    const cur = JSON.parse(fs.readFileSync(current, 'utf8'));
    if (cur.draftId === draftId) return cur;
  }
  return null;
}

function defaultSourceForVendor(vendor) {
  if (vendor === 'prosol') return 'prosol_wcas';
  if (vendor === 'treeco') return 'treeco_delta';
  if (vendor === 'perfectlevel') return 'sechelt';
  return null;
}

async function main() {
  const args = parseArgs();
  if (!args.draft) throw new Error('--draft <draft-id> is required');

  const draft = loadDraft(args.draft);
  if (!draft) throw new Error(`Draft not found: ${args.draft}`);

  const vendor = args.vendor || (draft.lines[0]?.vendor);
  const bucket = args.bucket || null;
  const lines = draft.lines.filter((l) =>
    l.vendor === vendor && (!bucket || l.availabilityBucket === bucket));
  if (!lines.length) throw new Error(`No lines for vendor '${vendor}'${bucket ? ` bucket '${bucket}'` : ''} in draft ${args.draft}`);

  const sourceKey = args.source || defaultSourceForVendor(vendor);
  const sourceAddress = plans.SOURCE_ADDRESSES[sourceKey];
  if (!sourceAddress) throw new Error(`Unknown source address key '${sourceKey}'. Available: ${Object.keys(plans.SOURCE_ADDRESSES).join(', ')}`);

  // Resolve MSKU per line from latest inventory-planning snapshot
  const snap = loadLatestSnapshot();
  const mskuByAsin = {};
  for (const r of (snap?.rows || [])) {
    if (r.asin && r.sku) mskuByAsin[r.asin] = r.sku;
  }

  // Default expiration for consumables (finishes, cleaners, sealers): ~2 years
  // out. Amazon rejects inbound of consumables without an expiration date.
  // Conservative default; user can override per-line later via sku-map
  // expiration_months or similar.
  const defaultExpiration = () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 2);
    return d.toISOString().slice(0, 10);
  };
  const needsExpiration = (product) => /\b(finish|sealer|cleaner|oil|polish|mop|coating|grout|spray|liquid|gallon|quart|litre|liter|473ml|946ml|3\.78l|3\.79l)\b/i.test(product || '');

  const items = [];
  const unresolved = [];
  for (const line of lines) {
    const msku = mskuByAsin[line.asin];
    if (!msku) {
      unresolved.push({ asin: line.asin, product: line.product });
      continue;
    }
    const item = {
      msku,
      quantity: line.qty,
      prepOwner: 'SELLER',
      labelOwner: 'SELLER',
    };
    if (needsExpiration(line.product)) item.expiration = defaultExpiration();
    items.push(item);
  }
  if (!items.length) {
    console.error('No items resolved to MSKU — inventory-planning snapshot may be stale:');
    for (const u of unresolved) console.error(`  ${u.asin}  ${u.product}`);
    process.exit(1);
  }
  if (unresolved.length) {
    console.warn(`⚠ ${unresolved.length} line(s) not in FBA snapshot — skipping those:`);
    for (const u of unresolved) console.warn(`  ${u.asin}  ${u.product}`);
  }

  const planKey = `${args.draft}-${vendor}${bucket ? '-' + bucket : ''}-inbound`;
  const name = `${vendor.toUpperCase()}${bucket ? ' ' + bucket.toUpperCase() : ''} — ${args.draft.replace('draft-', '')} — ${items.length} SKU`;

  console.log(`Creating inbound plan for ${items.length} SKU(s) from ${sourceKey}...`);
  for (const it of items) console.log(`  ${it.msku}  ×${it.quantity}`);
  console.log('');

  const state = plans.create({ planKey, sourceDraftId: args.draft, vendor, lines: items, sourceAddress, name });

  try {
    const created = await inbound.createInboundPlan({
      name,
      sourceAddress,
      items,
    });
    state.inboundPlanId = created.inboundPlanId;
    state.createOperationId = created.operationId;
    state.status = 'creating';
    plans.record(state, { step: 'create', ok: true, data: created });
    console.log(`  inboundPlanId: ${created.inboundPlanId}`);
    console.log(`  operationId: ${created.operationId}  (polling for completion...)`);

    // Poll the async creation — catches validation errors immediately so we
    // don't discover them at step 2 when the plan is already ERRORED.
    try {
      await inbound.waitForOperation(created.operationId, {
        onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
      });
    } catch (opErr) {
      state.status = 'errored';
      plans.record(state, { step: 'create-op', ok: false, error: opErr.message, data: opErr.operation });
      console.error(`\n✗ createInboundPlan operation failed:`);
      for (const p of (opErr.operation?.operationProblems || [])) {
        console.error(`    [${p.severity}] ${p.code}: ${p.message}${p.details ? '  (' + p.details + ')' : ''}`);
      }
      process.exit(1);
    }

    state.status = 'created';
    plans.save(state);
    console.log(`\n✓ Inbound plan created and validated`);
    console.log(`  state saved → data/fba/inbound-plans/${planKey}.json`);
  } catch (err) {
    plans.record(state, { step: 'create', ok: false, error: err.message });
    console.error(`✗ createInboundPlan failed: ${err.message}`);
    if (err.body) console.error('  body:', err.body.slice(0, 600));
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
