#!/usr/bin/env node
/**
 * FBA Inbound step 3: placement options.
 *
 * Amazon returns a set of placement options — each locks the destination
 * FC(s) for the shipment(s). Single-group shipments usually get one or two
 * options (e.g. "ship to YYC4" vs "ship to multiple FCs, Amazon allocates").
 *
 * We auto-pick the option with the lowest total placement fees.
 *
 * Usage:
 *   node scripts/fba/inbound-step3-placement.js --plan <planKey>
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

function feesOf(option) {
  let total = 0;
  for (const f of (option.fees || [])) {
    if (typeof f?.value?.amount === 'number') total += f.value.amount;
  }
  return total;
}

async function main() {
  const args = parseArgs();
  if (!args.plan) throw new Error('--plan <planKey> is required');

  const state = plans.load(args.plan);
  if (!state) throw new Error(`Plan state not found: ${args.plan}`);
  if (!state.inboundPlanId) throw new Error(`No inboundPlanId on state`);
  if (state.status !== 'packing-confirmed' && state.status !== 'placement-ready') {
    console.warn(`⚠ plan status is '${state.status}'. Expected 'packing-confirmed'.`);
  }

  console.log('[1/3] generatePlacementOptions...');
  const gen = await inbound.generatePlacementOptions(state.inboundPlanId);
  console.log(`  operationId=${gen.operationId}`);
  await inbound.waitForOperation(gen.operationId, {
    onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
  });
  console.log(`  ✓ options generated`);
  plans.record(state, { step: 'generate-placement', ok: true, data: gen });

  console.log('\n[2/3] listPlacementOptions...');
  const list = await inbound.listPlacementOptions(state.inboundPlanId);
  const options = list.placementOptions || [];
  console.log(`  ${options.length} placement option(s) returned`);
  for (const [i, o] of options.entries()) {
    const fee = feesOf(o);
    const shipments = o.shipmentIds?.length || 0;
    const expires = o.expiresAt || '—';
    console.log(`    [${i}] placementOptionId=${o.placementOptionId} · ${shipments} shipment(s) · status=${o.status} · fees ≈ $${fee.toFixed(2)} · expires ${expires}`);
    for (const fee of (o.fees || [])) {
      console.log(`         fee: ${fee.type || '?'} $${fee.value?.amount?.toFixed?.(2) || 0} ${fee.value?.code || ''} — ${fee.description || ''}`);
    }
  }
  if (!options.length) throw new Error('No placement options returned');

  const picked = options.reduce((best, o) => (feesOf(o) < feesOf(best) ? o : best), options[0]);
  console.log(`\n  → auto-selected (cheapest): ${picked.placementOptionId}  ($${feesOf(picked).toFixed(2)})`);
  state.placementOptionId = picked.placementOptionId;
  state.placementShipmentIds = picked.shipmentIds || [];
  state.status = 'placement-ready';
  plans.save(state);

  console.log('\n[3/3] confirmPlacementOption...');
  const confirm = await inbound.confirmPlacementOption(state.inboundPlanId, picked.placementOptionId);
  console.log(`  operationId=${confirm.operationId}`);
  await inbound.waitForOperation(confirm.operationId, {
    onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
  });
  console.log(`  ✓ placement confirmed`);

  state.status = 'placement-confirmed';
  plans.record(state, { step: 'confirm-placement', ok: true, data: { placementOptionId: picked.placementOptionId, shipmentIds: picked.shipmentIds } });

  // Try to surface concrete shipments. Non-fatal if this endpoint 403s —
  // we have placementOptionId which is all step 4 needs.
  try {
    const shipList = await inbound.listShipments(state.inboundPlanId);
    const shipments = shipList.shipments || [];
    console.log(`\n  ${shipments.length} shipment(s) now tied to this plan:`);
    for (const s of shipments) {
      console.log(`    ${s.shipmentId} → ${s.destination?.address?.city || '?'} (${s.destination?.warehouseId || '?'})`);
    }
    state.shipmentIds = shipments.map((s) => s.shipmentId);
    plans.save(state);
  } catch (err) {
    console.warn(`\n  (listShipments skipped: ${err.status || ''} — we'll surface shipment info in step 4/5)`);
  }

  console.log(`\n✓ step 3 complete. Next: step 4 (transportation).`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    if (e.body) console.error('body:', e.body.slice(0, 500));
    process.exit(1);
  });
}

module.exports = { main };
