#!/usr/bin/env node
/**
 * FBA Inbound step 4: transportation options.
 *
 * For each shipment created by placement, Amazon offers:
 *   - AMAZON_PARTNERED_CARRIER options (SPD / LTL) where Amazon arranges
 *     pickup + freight at negotiated rates
 *   - USE_YOUR_OWN_CARRIER (we arrange pickup ourselves via ShipStation)
 *
 * Strategy: auto-select cheapest AMAZON_PARTNERED_CARRIER if available,
 * else USE_YOUR_OWN_CARRIER (which we'd then book via ShipStation pickup).
 *
 * Usage:
 *   node scripts/fba/inbound-step4-transport.js --plan <planKey>
 *   node scripts/fba/inbound-step4-transport.js --plan <planKey> --mode=own
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

function quoteOf(option) {
  const q = option.quote;
  if (!q) return null;
  return { amount: q.cost?.amount || 0, code: q.cost?.code || 'CAD', expiration: q.expiration };
}

async function main() {
  const args = parseArgs();
  if (!args.plan) throw new Error('--plan <planKey> is required');

  const state = plans.load(args.plan);
  if (!state) throw new Error(`Plan state not found: ${args.plan}`);
  if (!state.placementOptionId) throw new Error('No placementOptionId — run step 3 first');

  console.log('[1/3] generateTransportationOptions...');
  const gen = await inbound.generateTransportationOptions(state.inboundPlanId, {
    placementOptionId: state.placementOptionId,
  });
  console.log(`  operationId=${gen.operationId}`);
  await inbound.waitForOperation(gen.operationId, {
    onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
  });
  console.log(`  ✓ options generated`);
  plans.record(state, { step: 'generate-transportation', ok: true, data: gen });

  console.log('\n[2/3] listTransportationOptions...');
  const list = await inbound.listTransportationOptions(state.inboundPlanId, { placementOptionId: state.placementOptionId });
  const options = list.transportationOptions || [];
  console.log(`  ${options.length} transportation option(s):\n`);
  const grouped = {};
  for (const o of options) {
    const key = o.shipmentId || 'shipment-?';
    (grouped[key] ||= []).push(o);
  }
  for (const [shipmentId, shipOpts] of Object.entries(grouped)) {
    console.log(`  Shipment ${shipmentId}:`);
    for (const o of shipOpts) {
      const q = quoteOf(o);
      const cost = q ? `$${q.amount.toFixed(2)} ${q.code}` : 'no quote';
      console.log(`    ${o.transportationOptionId}  carrier=${o.carrier?.name || '?'}  method=${o.shippingSolution}  mode=${o.shippingMode}  ${cost}`);
    }
  }
  if (!options.length) throw new Error('No transportation options returned');

  // Pick cheapest AMAZON_PARTNERED_CARRIER per shipment (or USE_YOUR_OWN_CARRIER if forced)
  const forceOwn = args.mode === 'own';
  const selected = [];
  for (const [shipmentId, shipOpts] of Object.entries(grouped)) {
    const candidates = forceOwn
      ? shipOpts.filter((o) => o.shippingSolution === 'USE_YOUR_OWN_CARRIER')
      : shipOpts.filter((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');
    const pool = candidates.length ? candidates : shipOpts;
    const picked = pool.reduce((best, o) => {
      const bQ = quoteOf(best); const oQ = quoteOf(o);
      if (!bQ) return o;
      if (!oQ) return best;
      return oQ.amount < bQ.amount ? o : best;
    }, pool[0]);
    const q = quoteOf(picked);
    console.log(`\n  → ${shipmentId}: ${picked.transportationOptionId}  ${picked.shippingSolution}  ${picked.carrier?.name || '?'}  ${q ? '$' + q.amount.toFixed(2) : 'no quote'}`);
    selected.push(picked);
  }

  console.log('\n[3/3] confirmTransportationOptions...');
  const confirm = await inbound.confirmTransportationOptions(
    state.inboundPlanId,
    selected.map((s) => s.transportationOptionId),
  );
  console.log(`  operationId=${confirm.operationId}`);
  await inbound.waitForOperation(confirm.operationId, {
    onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`),
  });
  console.log(`  ✓ transportation confirmed`);

  state.transportationOptionIds = selected.map((s) => s.transportationOptionId);
  state.transportationSummary = selected.map((s) => ({
    shipmentId: s.shipmentId,
    solution: s.shippingSolution,
    carrier: s.carrier?.name,
    cost: quoteOf(s)?.amount || null,
  }));
  state.status = 'transportation-confirmed';
  plans.record(state, { step: 'confirm-transportation', ok: true, data: state.transportationSummary });
  plans.save(state);

  console.log(`\n✓ step 4 complete. Next: step 5 (labels).`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    if (e.body) console.error('body:', e.body.slice(0, 600));
    process.exit(1);
  });
}

module.exports = { main };
