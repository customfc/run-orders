#!/usr/bin/env node
/**
 * FBA Inbound step 2: packing options.
 *
 * 1. generatePackingOptions → operationId → poll until SUCCESS
 * 2. listPackingOptions → array of { packingOptionId, packingGroups, fees }
 * 3. If only one option, auto-select. Else pick cheapest by total fees.
 * 4. confirmPackingOption → operationId → poll
 *
 * Usage:
 *   node scripts/fba/inbound-step2-packing.js --plan <planKey>
 */

require('dotenv').config();
const inbound = require('../../lib/sp-api-inbound');
const plans = require('../../lib/fba-inbound-plans');

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

function totalFees(option) {
  const fees = option.discounts?.concat(option.fees || []) || option.fees || [];
  let total = 0;
  for (const f of fees) {
    if (typeof f?.value?.amount === 'number') total += f.value.amount;
  }
  return total;
}

async function main() {
  const args = parseArgs();
  if (!args.plan) throw new Error('--plan <planKey> is required');

  const state = plans.load(args.plan);
  if (!state) throw new Error(`Plan state not found: ${args.plan}`);
  if (!state.inboundPlanId) throw new Error(`Plan has no inboundPlanId — run step 1 first`);

  // Sub-step 2a: generate packing options (async)
  console.log('[1/3] generatePackingOptions...');
  const gen = await inbound.generatePackingOptions(state.inboundPlanId);
  console.log(`  operationId=${gen.operationId}`);
  await inbound.waitForOperation(gen.operationId, {
    onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
  });
  console.log(`  ✓ options generated`);
  plans.record(state, { step: 'generate-packing', ok: true, data: gen });

  // Sub-step 2b: list packing options
  console.log('\n[2/3] listPackingOptions...');
  const list = await inbound.listPackingOptions(state.inboundPlanId);
  const options = list.packingOptions || [];
  console.log(`  ${options.length} packing option(s) returned`);
  for (const [i, o] of options.entries()) {
    const fee = totalFees(o);
    const groupCount = (o.packingGroups || []).length;
    console.log(`    [${i}] packingOptionId=${o.packingOptionId} · ${groupCount} group(s) · status=${o.status} · fees ≈ $${fee.toFixed(2)}`);
  }
  if (!options.length) throw new Error('No packing options returned');

  // Pick the cheapest option (Amazon only rarely presents >1 for single-SKU shipments)
  const picked = options.length === 1
    ? options[0]
    : options.reduce((best, o) => (totalFees(o) < totalFees(best) ? o : best), options[0]);
  console.log(`\n  → auto-selected: ${picked.packingOptionId}`);
  state.packingOptionId = picked.packingOptionId;
  state.status = 'packing-ready';
  plans.save(state);

  // Sub-step 2c: confirm the picked option
  console.log('\n[3/3] confirmPackingOption...');
  const confirm = await inbound.confirmPackingOption(state.inboundPlanId, picked.packingOptionId);
  console.log(`  operationId=${confirm.operationId}`);
  await inbound.waitForOperation(confirm.operationId, {
    onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
  });
  console.log(`  ✓ packing confirmed`);

  state.status = 'packing-confirmed';
  plans.record(state, { step: 'confirm-packing', ok: true, data: { packingOptionId: picked.packingOptionId } });
  console.log(`\n✓ step 2 complete. Plan is now ready for placement (step 3).`);
  console.log(`  state → data/fba/inbound-plans/${state.planKey}.json`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    if (e.body) console.error('body:', e.body.slice(0, 500));
    process.exit(1);
  });
}

module.exports = { main };
