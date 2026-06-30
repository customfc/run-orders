#!/usr/bin/env node
/**
 * FBA Inbound step 3 (LIST ONLY): generate + list placement options WITHOUT
 * confirming. Confirming a placement option commits the inbound placement
 * service fee and locks destination FCs — so we stop here and report fees +
 * destinations for human approval, then confirm separately.
 *
 * Usage: node scripts/fba/inbound-step3-list-only.js --plan <planKey>
 */
require('dotenv').config();
const inbound = require('../../lib/sp-api-inbound');
const plans = require('../../lib/fba-inbound-plans');

function feesOf(o) { let t = 0; for (const f of (o.fees || [])) if (typeof f?.value?.amount === 'number') t += f.value.amount; return t; }

(async () => {
  const planKey = process.argv.includes('--plan') ? process.argv[process.argv.indexOf('--plan') + 1] : null;
  if (!planKey) throw new Error('--plan <planKey> required');
  const state = plans.load(planKey);
  if (!state) throw new Error('plan state not found');

  console.log('[1/2] generatePlacementOptions...');
  const gen = await inbound.generatePlacementOptions(state.inboundPlanId);
  await inbound.waitForOperation(gen.operationId, { onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`) });
  console.log('\n  ✓ generated');
  plans.record(state, { step: 'generate-placement', ok: true, data: gen });

  console.log('\n[2/2] listPlacementOptions (NOT confirming):');
  const list = await inbound.listPlacementOptions(state.inboundPlanId);
  const options = list.placementOptions || [];
  console.log(`  ${options.length} option(s):\n`);
  for (const [i, o] of options.entries()) {
    console.log(`  [${i}] placementOptionId=${o.placementOptionId}`);
    console.log(`       status=${o.status}  shipments=${(o.shipmentIds || []).length}  totalFees=$${feesOf(o).toFixed(2)}  expires=${o.expiresAt || '—'}`);
    for (const f of (o.fees || [])) console.log(`       fee: ${f.type || '?'} $${f.value?.amount?.toFixed?.(2) || 0} ${f.value?.code || ''} — ${f.description || ''}`);
    for (const sid of (o.shipmentIds || [])) console.log(`       shipmentId=${sid}`);
  }
  // Try to surface destination FCs per shipment (best-effort).
  console.log('\n  Destinations (best-effort):');
  for (const o of options) {
    for (const sid of (o.shipmentIds || [])) {
      try {
        const sh = await inbound.getShipment(state.inboundPlanId, sid);
        const d = sh.destination || {};
        console.log(`   ${o.placementOptionId.slice(0,12)}… ${sid}: FC=${d.warehouseId || '?'} ${d.address?.city || ''} ${d.address?.stateOrProvinceCode || ''}`);
      } catch (e) { console.log(`   ${sid}: (destination not available pre-confirm: ${e.status || ''})`); }
    }
  }
  console.log(`\nSTOPPED before confirmPlacementOption — awaiting approval. plan=${planKey}`);
})().catch((e) => { console.error('ERROR:', e.message); if (e.body) console.error('body:', e.body.slice(0, 400)); process.exit(1); });
