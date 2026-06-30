#!/usr/bin/env node
/**
 * End-to-end FBA inbound for ONE SKU through the CORRECT v2024-03-20 flow,
 * including setPackingInformation (the step the canned scripts skip — likely
 * why only LTL was offered). Stops after listing transportation options so we
 * can see whether AMAZON_PARTNERED_CARRIER (UPS SPD) is offered. Does NOT
 * confirm transport.
 *
 * Schema note: setPackingInformation boxes use weight unit LB / dim unit IN and
 * REQUIRE per-item prepOwner+labelOwner. The transportation endpoint uses
 * POUNDS / INCHES. Two different box shapes — built from one definition below.
 *
 * Usage: node scripts/fba/fba-inbound-spd.js --sku pint|quart
 */
require('dotenv').config();
const inbound = require('../../lib/sp-api-inbound');
const { spApiRequest } = require('../../lib/sp-api');
const plans = require('../../lib/fba-inbound-plans');
const BASE = '/inbound/fba/2024-03-20';
const EXP = '2028-06-11';

// generic box defs: { lb, l, w, h, qty, units:[{msku,quantity}] }
const PINT_BOXES = [
  { lb: 18, l: 13, w: 9, h: 7, qty: 2, units: [{ msku: 'C030881-05-FBA', quantity: 12 }] },
  { lb: 12, l: 13, w: 9, h: 7, qty: 1, units: [{ msku: 'C030881-05-FBA', quantity: 8 }] },
];
const QUART_BOXES = [
  { lb: 40, l: 20, w: 14, h: 19, qty: 3, units: [{ msku: 'C030882-01-FBA', quantity: 20 }] },
  { lb: 40, l: 22, w: 14, h: 15, qty: 1, units: [{ msku: 'C030882-01-FBA', quantity: 20 }] },
];
const CONFIGS = {
  pint: { name: 'PO15056 Pint SCG 32u', items: [{ msku: 'C030881-05-FBA', qty: 32 }], boxes: PINT_BOXES },
  quart: { name: 'PO15056 Quart SCG 80u', items: [{ msku: 'C030882-01-FBA', qty: 80 }], boxes: QUART_BOXES },
  combined: { name: 'PROSOL PO15056 Sealers Gold 112u', items: [{ msku: 'C030881-05-FBA', qty: 32 }, { msku: 'C030882-01-FBA', qty: 80 }], boxes: [...PINT_BOXES, ...QUART_BOXES] },
};

const packingBox = (b) => ({ weight: { unit: 'LB', value: b.lb }, dimensions: { unitOfMeasurement: 'IN', length: b.l, width: b.w, height: b.h }, quantity: b.qty, items: b.units.map((u) => ({ ...u, prepOwner: 'SELLER', labelOwner: 'SELLER', expiration: EXP })), contentInformationSource: 'BOX_CONTENT_PROVIDED' });
const transportBox = (b) => ({ weight: { unit: 'POUNDS', value: b.lb }, dimensions: { unit: 'INCHES', length: b.l, width: b.w, height: b.h }, quantity: b.qty, items: b.units.map((u) => ({ msku: u.msku, quantity: u.quantity })), contentInformationSource: 'BOX_CONTENT_PROVIDED' });

function feesOf(o) { let t = 0; for (const f of (o.fees || [])) if (typeof f?.value?.amount === 'number') t += f.value.amount; return t; }
function quoteOf(o) { const q = o.quote; return q ? { amount: q.cost?.amount || 0, code: q.cost?.code || 'CAD' } : null; }

(async () => {
  const a = process.argv;
  const which = a.includes('--sku') ? a[a.indexOf('--sku') + 1] : null;
  const cfg = CONFIGS[which];
  if (!cfg) throw new Error('--sku pint|quart|combined required');
  const src = plans.SOURCE_ADDRESSES.prosol_wcas;
  console.log(`=== ${cfg.name} ===`);

  const created = await inbound.createInboundPlan({ name: cfg.name, sourceAddress: src, items: cfg.items.map((i) => ({ msku: i.msku, quantity: i.qty, prepOwner: 'SELLER', labelOwner: 'SELLER', expiration: EXP })) });
  await inbound.waitForOperation(created.operationId);
  const planId = created.inboundPlanId;
  console.log('1) created', planId);

  const gp = await inbound.generatePackingOptions(planId); await inbound.waitForOperation(gp.operationId);
  const po = (await inbound.listPackingOptions(planId)).packingOptions[0];
  const groups = po.packingGroups || [];
  if (groups.length !== 1) throw new Error(`expected 1 packing group, got ${groups.length}: ${JSON.stringify(groups)} — boxes-to-group mapping needed`);
  const packingGroupId = groups[0];
  await inbound.waitForOperation((await inbound.confirmPackingOption(planId, po.packingOptionId)).operationId);
  console.log('2) packing confirmed, group', packingGroupId);

  // 3) setPackingInformation — FAIL HARD if it errors (don't waste placement)
  const spi = await spApiRequest('POST', `${BASE}/inboundPlans/${planId}/packingInformation`, { body: { packageGroupings: [{ packingGroupId, boxes: cfg.boxes.map(packingBox) }] } });
  if (spi.status !== 200 && spi.status !== 202) { console.error('3) setPackingInformation FAILED', spi.status, spi.body.slice(0, 500)); process.exit(1); }
  const spiB = JSON.parse(spi.body || '{}');
  if (spiB.operationId) await inbound.waitForOperation(spiB.operationId);
  console.log('3) setPackingInformation OK');

  const gpl = await inbound.generatePlacementOptions(planId); await inbound.waitForOperation(gpl.operationId);
  const plopt = (await inbound.listPlacementOptions(planId)).placementOptions.reduce((b, o) => feesOf(o) < feesOf(b) ? o : b);
  console.log(`4) placement option ${plopt.placementOptionId} fee=$${feesOf(plopt).toFixed(2)} shipments=${(plopt.shipmentIds || []).length}`);
  await inbound.waitForOperation((await inbound.confirmPlacementOption(planId, plopt.placementOptionId)).operationId);
  console.log('   placement confirmed');

  const plan = await inbound.getInboundPlan(planId);
  const shipmentIds = (plan.shipments || []).map((s) => s.shipmentId);
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const iso = (off) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + off); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T00:00:00Z`; };
  const configs = shipmentIds.map((shipmentId) => ({ shipmentId, contactInformation: { name: 'Mac Roy', phoneNumber: src.phoneNumber, email: 'mac@customfc.ca' }, readyToShipWindow: { start: iso(3) }, pallets: [], boxes: cfg.boxes.map(transportBox) }));
  const gt = await inbound.generateTransportationOptions(planId, { placementOptionId: plopt.placementOptionId, shipmentTransportationConfigurations: configs });
  await inbound.waitForOperation(gt.operationId);

  const all = []; let token = null;
  do {
    const p = new URLSearchParams({ pageSize: '20', placementOptionId: plopt.placementOptionId });
    if (token) p.set('paginationToken', token);
    const res = await spApiRequest('GET', `${BASE}/inboundPlans/${planId}/transportationOptions?${p}`, {});
    const b = JSON.parse(res.body); all.push(...(b.transportationOptions || [])); token = b.pagination?.nextToken || null;
  } while (token);

  const byKey = {}; for (const o of all) { const k = `${o.shippingSolution}/${o.shippingMode}`; byKey[k] = (byKey[k] || 0) + 1; }
  console.log(`5) ${all.length} transport options:`, JSON.stringify(byKey));
  const partnered = all.filter((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');
  console.log(`   AMAZON_PARTNERED_CARRIER: ${partnered.length}`);
  for (const o of partnered.slice(0, 8)) { const q = quoteOf(o); console.log(`     ${o.transportationOptionId} ${o.shippingMode} ${o.carrier?.name} ${q ? '$' + q.amount.toFixed(2) + ' ' + q.code : 'no quote'} programs=${JSON.stringify(o.programs || [])}`); }
  console.log(`\n   planId=${planId} shipment=${shipmentIds.join(',')} placementOption=${plopt.placementOptionId} (transport NOT confirmed)`);
})().catch((e) => { console.error('ERROR:', e.message); if (e.body) console.error('body:', e.body.slice(0, 500)); process.exit(1); });
