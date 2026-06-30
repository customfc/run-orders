#!/usr/bin/env node
/**
 * FBA Inbound step 4 (QUOTE ONLY): generate + list transportation options with
 * the REAL PO15056 carton manifest. Does NOT confirm (no freight commit).
 *
 * Manifest (7 cartons, single-SKU each):
 *   pint  C030881-05-FBA: 2× (12u, 13×9×7in, 18lb) + 1× (8u, 13×9×7in, 12lb)
 *   quart C030882-01-FBA: 3× (20u, 20×14×19in, 40lb) + 1× (20u, 22×14×15in, 40lb)
 *
 * Usage: node scripts/fba/inbound-step4-quote.js --plan <planKey>
 */
require('dotenv').config();
const inbound = require('../../lib/sp-api-inbound');
const plans = require('../../lib/fba-inbound-plans');

const PINT = 'C030881-05-FBA';
const QUART = 'C030882-01-FBA';
const BOXES = [
  { weight: { unit: 'POUNDS', value: 18 }, dimensions: { unit: 'INCHES', length: 13, width: 9,  height: 7  }, quantity: 2, items: [{ msku: PINT,  quantity: 12 }], contentInformationSource: 'BOX_CONTENT_PROVIDED' },
  { weight: { unit: 'POUNDS', value: 12 }, dimensions: { unit: 'INCHES', length: 13, width: 9,  height: 7  }, quantity: 1, items: [{ msku: PINT,  quantity: 8  }], contentInformationSource: 'BOX_CONTENT_PROVIDED' },
  { weight: { unit: 'POUNDS', value: 40 }, dimensions: { unit: 'INCHES', length: 20, width: 14, height: 19 }, quantity: 3, items: [{ msku: QUART, quantity: 20 }], contentInformationSource: 'BOX_CONTENT_PROVIDED' },
  { weight: { unit: 'POUNDS', value: 40 }, dimensions: { unit: 'INCHES', length: 22, width: 14, height: 15 }, quantity: 1, items: [{ msku: QUART, quantity: 20 }], contentInformationSource: 'BOX_CONTENT_PROVIDED' },
];

function quoteOf(o) { const q = o.quote; return q ? { amount: q.cost?.amount || 0, code: q.cost?.code || 'CAD' } : null; }

(async () => {
  const a = process.argv;
  const planKey = a.includes('--plan') ? a[a.indexOf('--plan') + 1] : null;
  if (!planKey) throw new Error('--plan required');
  const state = plans.load(planKey);
  if (!state || !state.placementOptionId) throw new Error('plan not placement-confirmed');

  const plan = await inbound.getInboundPlan(state.inboundPlanId);
  const shipmentIds = (plan.shipments || []).map((s) => s.shipmentId);
  console.log(`shipment(s): ${shipmentIds.join(', ')}`);

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (off) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + off); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T00:00:00Z`; };
  const readyToShipWindow = { start: iso(3) };

  const configs = shipmentIds.map((shipmentId) => ({
    shipmentId,
    contactInformation: { name: 'Mac Roy', phoneNumber: state.sourceAddress.phoneNumber, email: state.sourceAddress.email || 'mac@customfc.ca' },
    readyToShipWindow,
    pallets: [],
    boxes: BOXES,
  }));
  const totalBoxes = BOXES.reduce((s, b) => s + b.quantity, 0);
  const totalUnits = BOXES.reduce((s, b) => s + b.quantity * b.items.reduce((t, i) => t + i.quantity, 0), 0);
  console.log(`box config: ${totalBoxes} cartons, ${totalUnits} units`);

  console.log('\n[1/2] generateTransportationOptions...');
  const gen = await inbound.generateTransportationOptions(state.inboundPlanId, { placementOptionId: state.placementOptionId, shipmentTransportationConfigurations: configs });
  await inbound.waitForOperation(gen.operationId, { onPoll: (op) => process.stdout.write(`  ${op.operationStatus}...\r`) });
  console.log('\n  ✓ generated');
  plans.record(state, { step: 'generate-transportation', ok: true, data: { boxes: totalBoxes, units: totalUnits } });

  console.log('\n[2/2] listTransportationOptions (NOT confirming):\n');
  const list = await inbound.listTransportationOptions(state.inboundPlanId, { placementOptionId: state.placementOptionId });
  const options = list.transportationOptions || [];
  for (const o of options) {
    const q = quoteOf(o);
    console.log(`  ${o.transportationOptionId}`);
    console.log(`     shipment=${o.shipmentId} solution=${o.shippingSolution} carrier=${o.carrier?.name || '?'} mode=${o.shippingMode}`);
    console.log(`     quote=${q ? '$' + q.amount.toFixed(2) + ' ' + q.code : 'no quote'}  programs=${JSON.stringify(o.programs || [])}`);
  }
  console.log(`\nSTOPPED before confirmTransportationOptions — awaiting freight approval. plan=${planKey}`);
})().catch((e) => { console.error('ERROR:', e.message); if (e.body) console.error('body:', e.body.slice(0, 500)); process.exit(1); });
