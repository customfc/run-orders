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

  // Get shipment IDs from the plan (listShipments endpoint 403s but
  // getInboundPlan returns them fine).
  const plan = await inbound.getInboundPlan(state.inboundPlanId);
  const shipmentIds = (plan.shipments || []).map((s) => s.shipmentId);
  if (!shipmentIds.length) throw new Error('No shipments on plan — placement may not have confirmed');
  console.log(`  ${shipmentIds.length} shipment(s):`, shipmentIds.join(', '));

  // Carton config: prefer the vendor-confirmed cartonDims recorded on the plan
  // (confirm-dims → runForBucket stamps state.cartonDims: {count,L,W,H,weightLb}
  // in INCHES/LB). Fall back to the legacy Bona Mega case-pack heuristic only
  // when no dims were recorded, so existing SKUs keep working.
  const cd = state.cartonDims;
  const haveDims = cd && [cd.count, cd.L, cd.W, cd.H, cd.weightLb]
    .every((n) => Number.isFinite(Number(n)) && Number(n) > 0);
  const itemsPerBox = 4; // legacy fallback split only
  const boxWeightLb = haveDims ? Number(cd.weightLb) : 42;
  const boxDims = haveDims
    ? { length: Number(cd.L), width: Number(cd.W), height: Number(cd.H) }
    : { length: 14, width: 12, height: 12 };
  const fixedBoxCount = haveDims ? Number(cd.count) : null;

  // Ready-to-ship window: START ONLY. Sending an `end` date suppresses the
  // AMAZON_PARTNERED_CARRIER (UPS SPD) offer — Amazon returns only LTL /
  // USE_YOUR_OWN_CARRIER. The proven fba-inbound-spd.js uses start-only and
  // reliably surfaces partnered UPS. Do NOT re-add an end date.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (offsetDays) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + offsetDays);
    return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T00:00:00Z`;
  };
  const readyWindow = { start: isoDate(3) };

  const configs = [];
  for (const shipId of shipmentIds) {
    const totalUnits = state.lines.reduce((s, l) => s + l.quantity, 0);
    const boxCount = fixedBoxCount || Math.ceil(totalUnits / itemsPerBox);
    const items = state.lines.map((l) => ({ msku: l.msku, quantity: Math.ceil(l.quantity / boxCount) }));
    configs.push({
      shipmentId: shipId,
      contactInformation: {
        name: 'Mac Roy',
        phoneNumber: state.sourceAddress.phoneNumber,
        email: state.sourceAddress.email || 'mac@customfc.ca',
      },
      readyToShipWindow: readyWindow,
      pallets: [],
      boxes: [{
        weight: { unit: 'POUNDS', value: boxWeightLb },
        dimensions: { unit: 'INCHES', length: boxDims.length, width: boxDims.width, height: boxDims.height },
        quantity: boxCount,
        items,
        contentInformationSource: 'BOX_CONTENT_PROVIDED',
      }],
    });
  }
  console.log(`  box config: ${configs[0].boxes[0].quantity} × ${boxDims.length}×${boxDims.width}×${boxDims.height}in @ ${boxWeightLb}lb ${haveDims ? '(from recorded cartonDims)' : '(legacy heuristic — no cartonDims recorded)'}`);

  console.log('\n[1/3] generateTransportationOptions...');
  const gen = await inbound.generateTransportationOptions(state.inboundPlanId, {
    placementOptionId: state.placementOptionId,
    shipmentTransportationConfigurations: configs,
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
    // Guard: never silently confirm a non-partnered / no-quote option when we
    // intended Amazon-partnered freight. Partnered SPD only appears on the FIRST
    // generateTransportationOptions after packing info is set — do NOT generate
    // transport twice (e.g. running the quote script first) or it drops to
    // LTL/own-carrier and we'd confirm a no-quote self-ship by accident.
    if (!forceOwn && !candidates.length) {
      throw new Error(`${shipmentId}: no AMAZON_PARTNERED_CARRIER offered — refusing to confirm own-carrier/LTL. Ensure step 2 set packing info and that transport was not already generated once. Use --mode=own only to deliberately self-ship.`);
    }
    const pool = candidates.length ? candidates : shipOpts;
    const picked = pool.reduce((best, o) => {
      const bQ = quoteOf(best); const oQ = quoteOf(o);
      if (!bQ) return o;
      if (!oQ) return best;
      return oQ.amount < bQ.amount ? o : best;
    }, pool[0]);
    const q = quoteOf(picked);
    if (!forceOwn && !q) {
      throw new Error(`${shipmentId}: selected partnered option has no quote — refusing to confirm.`);
    }
    // Cost cap: never confirm a partnered label above --max-cost (Mac's $30
    // label-spend rule). Default is uncapped for --mode=own / manual use.
    const maxCost = args['max-cost'] != null ? Number(args['max-cost']) : Infinity;
    if (!forceOwn && q && q.amount > maxCost) {
      throw new Error(`${shipmentId}: cheapest partnered ($${q.amount.toFixed(2)} ${q.code}) exceeds --max-cost=$${maxCost} — refusing to confirm.`);
    }
    console.log(`\n  → ${shipmentId}: ${picked.transportationOptionId}  ${picked.shippingSolution}  ${picked.carrier?.name || '?'}  ${q ? '$' + q.amount.toFixed(2) : 'no quote'}`);
    selected.push(picked);
  }

  // v2024-03-20 canonical ordering for transport options with program
  // DELIVERY_WINDOW_REQUIRED (LTL / non-partnered / no-appointment carriers):
  //   generateDeliveryWindowOptions (async) → listDeliveryWindowOptions
  //   → confirmDeliveryWindowOption → confirmTransportationOptions
  // Shipments where the picked option doesn't carry that program return empty
  // from list and we skip them cleanly.
  console.log('\n[3/4] generate + confirm delivery windows (required before transport for DELIVERY_WINDOW_REQUIRED options)...');
  for (const s of selected) {
    const needsWindow = Array.isArray(s.programs) && s.programs.includes('DELIVERY_WINDOW_REQUIRED');
    console.log(`    ${s.shipmentId}: programs=${JSON.stringify(s.programs || [])}${needsWindow ? ' (window required)' : ''}`);

    const gen = await inbound.generateDeliveryWindowOptions(state.inboundPlanId, s.shipmentId);
    if (gen.operationId) {
      await inbound.waitForOperation(gen.operationId, {
        onPoll: (op) => process.stdout.write(`      gen ${op.operationStatus}...\r`),
      });
    }

    const dwList = await inbound.listDeliveryWindowOptions(state.inboundPlanId, s.shipmentId);
    const windows = dwList.deliveryWindowOptions || [];
    if (!windows.length) {
      if (needsWindow) {
        throw new Error(`${s.shipmentId}: DELIVERY_WINDOW_REQUIRED but no windows offered after generate — Amazon may be processing, retry in a minute`);
      }
      console.log(`      no window required — skipping`);
      continue;
    }

    const picked = windows.reduce((a, b) => (new Date(a.startDate) < new Date(b.startDate) ? a : b));
    console.log(`      ${windows.length} window(s), picked ${picked.startDate} → ${picked.endDate}${picked.validUntil ? ` · validUntil=${picked.validUntil}` : ''}`);
    const cdwOp = await inbound.confirmDeliveryWindowOption(state.inboundPlanId, s.shipmentId, picked.deliveryWindowOptionId);
    if (cdwOp.operationId) {
      await inbound.waitForOperation(cdwOp.operationId, {
        onPoll: (op) => process.stdout.write(`      confirm ${op.operationStatus}...\r`),
      });
    }
    console.log(`      ✓ window confirmed`);
  }

  console.log('\n[4/4] confirmTransportationOptions...');
  const selections = selected.map((s) => ({
    shipmentId: s.shipmentId,
    transportationOptionId: s.transportationOptionId,
  }));
  const confirm = await inbound.confirmTransportationOptions(
    state.inboundPlanId,
    selections,
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
