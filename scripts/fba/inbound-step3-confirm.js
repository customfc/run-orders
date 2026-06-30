#!/usr/bin/env node
/**
 * FBA Inbound step 3 (CONFIRM): confirm a specific placement option.
 * Only run after reviewing fees from inbound-step3-list-only.js.
 * Usage: node scripts/fba/inbound-step3-confirm.js --plan <planKey> --option <placementOptionId>
 */
require('dotenv').config();
const inbound = require('../../lib/sp-api-inbound');
const plans = require('../../lib/fba-inbound-plans');

(async () => {
  const a = process.argv;
  const planKey = a.includes('--plan') ? a[a.indexOf('--plan') + 1] : null;
  const option = a.includes('--option') ? a[a.indexOf('--option') + 1] : null;
  if (!planKey || !option) throw new Error('--plan and --option required');
  const state = plans.load(planKey);
  if (!state) throw new Error('plan state not found');

  console.log(`confirmPlacementOption ${option}...`);
  const confirm = await inbound.confirmPlacementOption(state.inboundPlanId, option);
  await inbound.waitForOperation(confirm.operationId, { onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`) });
  console.log('\n  ✓ placement confirmed');

  state.placementOptionId = option;
  state.status = 'placement-confirmed';

  const plan = await inbound.getInboundPlan(state.inboundPlanId);
  const shipments = plan.shipments || [];
  state.shipmentIds = shipments.map((s) => s.shipmentId);
  console.log(`\n  ${shipments.length} shipment(s):`);
  for (const s of shipments) {
    const d = s.destination || {};
    console.log(`    ${s.shipmentId}  confirmationId=${s.shipmentConfirmationId || '(pending transport)'}  FC=${d.warehouseId || '?'} ${d.address?.city || ''} ${d.address?.stateOrProvinceCode || ''}`);
  }
  plans.record(state, { step: 'confirm-placement', ok: true, data: { option, shipmentIds: state.shipmentIds } });
  console.log(`\n✓ step 3 confirmed. plan=${planKey}`);
})().catch((e) => { console.error('ERROR:', e.message); if (e.body) console.error('body:', e.body.slice(0, 400)); process.exit(1); });
