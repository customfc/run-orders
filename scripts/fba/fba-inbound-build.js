#!/usr/bin/env node
/**
 * Spec-driven FBA inbound (v2024-03-20), SPD, multi-SKU.
 *
 * fba-inbound-spd.js was written for the one-SKU Sealers Gold job: box configs
 * are hard-coded in the file and it throws when Amazon returns more than one
 * packing group. Both assumptions break on a real replenishment PO — PO-15904
 * is 7 SKUs / 78 units, and Amazon routinely splits that across groups.
 *
 * This takes the vendor's carton list as JSON and does the whole flow up to,
 * but NOT including, confirming transportation. Confirming transport books a
 * carrier and is the point of no return, so it stays a separate deliberate act.
 *
 * Handles the multi-group case properly: after packing options are generated,
 * each group is queried for the MSKUs it contains and our cartons are assigned
 * to the group that holds their SKU. A carton whose SKU lands in no group is a
 * hard stop — sending box content Amazon can't reconcile causes receiving
 * discrepancies that are painful to unwind.
 *
 * Units: Amazon wants LB and IN. Vendors send cm/kg. The spec is in LB/IN and
 * the converter below is the ONLY place a unit is touched, so a mistake is
 * visible in one line rather than smeared through the payload.
 *
 * Usage:
 *   node scripts/fba/fba-inbound-build.js --spec=data/fba/inbound-po15904.json
 *   node scripts/fba/fba-inbound-build.js --spec=... --commit
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const inbound = require('../../lib/sp-api-inbound');
const { spApiRequest } = require('../../lib/sp-api');
const plans = require('../../lib/fba-inbound-plans');

const BASE = '/inbound/fba/2024-03-20';
const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const COMMIT = process.argv.includes('--commit');
const SPEC_PATH = arg('spec');

const money = (n) => '$' + Number(n || 0).toFixed(2);
const feesOf = (o) => (o.fees || []).reduce((t, f) => t + (typeof f?.value?.amount === 'number' ? f.value.amount : 0), 0);
const quoteOf = (o) => (o.quote ? { amount: o.quote.cost?.amount || 0, code: o.quote.cost?.code || 'CAD' } : null);

// setPackingInformation wants LB/IN and per-item prepOwner+labelOwner;
// the transportation endpoint wants POUNDS/INCHES and neither. Same carton,
// two shapes — built from one definition so they can't drift apart.
const packingBox = (b, expiration, prep = {}) => ({
  weight: { unit: 'LB', value: b.lb },
  dimensions: { unitOfMeasurement: 'IN', length: b.l, width: b.w, height: b.h },
  quantity: b.qty || 1,
  items: b.units.map((u) => ({
    msku: u.msku,
    quantity: u.quantity,
    prepOwner: prep[u.msku]?.prepOwner || 'NONE',
    labelOwner: prep[u.msku]?.labelOwner || 'SELLER',
    ...(expiration ? { expiration } : {}),
  })),
  contentInformationSource: 'BOX_CONTENT_PROVIDED',
});
const transportBox = (b) => ({
  weight: { unit: 'POUNDS', value: b.lb },
  dimensions: { unit: 'INCHES', length: b.l, width: b.w, height: b.h },
  quantity: b.qty || 1,
  items: b.units.map((u) => ({ msku: u.msku, quantity: u.quantity })),
  contentInformationSource: 'BOX_CONTENT_PROVIDED',
});


/**
 * Who owns prep, per SKU, straight from Amazon rather than assumed.
 *
 * fba-inbound-spd.js hard-coded prepOwner:'SELLER' for every item. That worked
 * for the two Sealers Gold SKUs and fails on a mixed PO: createInboundPlan
 * rejected PO-15904 with "SES2D6MGS-FBA does not require prepOwner but SELLER
 * was assigned. Accepted values: [NONE]". getPrepDetails shows why the rule
 * cannot be uniform — of these 7 SKUs, five need no prep, one (SES2D6MGS) has
 * prepCategory UNKNOWN with labeling only, and KERDIFIXBW needs ITEM_POLYBAGGING
 * with prepCategory FC_PROVIDED, meaning the fulfilment centre performs it.
 *
 * Rule: strip labeling and the explicit no-prep marker; if nothing physical is
 * left, nobody owns prep (NONE). If something is, the owner is AMAZON when the
 * FC provides it, otherwise us.
 *
 * labelOwner stays SELLER — applying our own FNSKU labels is the entire point
 * of the X00 relist; letting Amazon label costs per unit.
 */
async function resolvePrep(mskus) {
  const mp = (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');
  const p = new URLSearchParams({ marketplaceId: mp, mskus: mskus.join(',') });
  const res = await spApiRequest('GET', `${BASE}/items/prepDetails?${p}`, {});
  if (res.status !== 200) throw new Error(`getPrepDetails ${res.status}: ${String(res.body).slice(0, 300)}`);
  const out = {};
  for (const d of (JSON.parse(res.body).mskuPrepDetails || [])) {
    // allOwnersConstraint is the discriminator, NOT prepCategory. Amazon
    // rejected both of my earlier readings and the messages pin it exactly:
    //   SES2D6MGS  allOwnersConstraint ''           -> "does not require
    //              prepCategory UNKNOWN                prepOwner ... [NONE]"
    //   SES3D5MGS  allOwnersConstraint 'MUST_MATCH' -> "requires prepOwner
    //              prepCategory NONE                   ... [AMAZON, SELLER]"
    // prepCategory NONE therefore does not mean "no owner needed" — six of
    // these seven SKUs carry MUST_MATCH and one does not.
    const needsOwner = d.allOwnersConstraint === 'MUST_MATCH';
    out[d.msku] = {
      // FC_PROVIDED means the fulfilment centre performs the physical prep
      // (KERDIFIXBW needs polybagging), so Amazon owns it and bills per unit.
      // Claiming SELLER there would send unprepped cartridges and get them
      // flagged at receiving.
      prepOwner: !needsOwner ? 'NONE' : (d.prepCategory === 'FC_PROVIDED' ? 'AMAZON' : 'SELLER'),
      labelOwner: 'SELLER',
      why: `${d.prepCategory}/${(d.prepTypes || []).join('+') || 'none'}/${d.allOwnersConstraint || 'no-constraint'}`,
    };
  }
  const missing = mskus.filter((m) => !out[m]);
  if (missing.length) throw new Error(`no prep details returned for: ${missing.join(', ')}`);
  return out;
}

function loadSpec(p) {
  const spec = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!spec.name) throw new Error('spec.name required');
  if (!spec.source || !plans.SOURCE_ADDRESSES[spec.source]) {
    throw new Error(`spec.source must be one of: ${Object.keys(plans.SOURCE_ADDRESSES).join(', ')}`);
  }
  if (!Array.isArray(spec.boxes) || !spec.boxes.length) throw new Error('spec.boxes required');

  const boxes = spec.boxes.map((b, i) => {
    const units = b.units || (b.msku ? [{ msku: b.msku, quantity: b.quantity }] : null);
    if (!units || !units.length) throw new Error(`box ${i + 1}: needs msku+quantity or units[]`);
    for (const u of units) {
      if (!u.msku) throw new Error(`box ${i + 1}: unit missing msku`);
      if (!(Number(u.quantity) > 0)) throw new Error(`box ${i + 1}: ${u.msku} quantity must be > 0`);
    }
    for (const dim of ['lb', 'l', 'w', 'h']) {
      if (!(Number(b[dim]) > 0)) throw new Error(`box ${i + 1}: ${dim} must be > 0`);
    }
    return { ...b, units };
  });

  // Roll cartons up to plan-level item quantities.
  const items = new Map();
  for (const b of boxes) {
    for (const u of b.units) {
      items.set(u.msku, (items.get(u.msku) || 0) + Number(u.quantity) * (b.qty || 1));
    }
  }
  return { ...spec, boxes, items: [...items].map(([msku, qty]) => ({ msku, qty })) };
}

/** Which MSKUs did Amazon put in each packing group? */
async function groupItems(planId, packingOptionId, packingGroupId) {
  const res = await spApiRequest('GET', `${BASE}/inboundPlans/${planId}/packingOptions/${packingOptionId}/packingGroups/${packingGroupId}/items?pageSize=100`, {});
  if (res.status !== 200) throw new Error(`listPackingGroupItems ${res.status}: ${String(res.body).slice(0, 200)}`);
  return (JSON.parse(res.body).items || []).map((i) => i.msku);
}

(async () => {
  if (!SPEC_PATH) throw new Error('--spec=<file.json> required');
  const spec = loadSpec(path.resolve(SPEC_PATH));
  const src = plans.SOURCE_ADDRESSES[spec.source];
  const totalUnits = spec.items.reduce((s, i) => s + i.qty, 0);
  const totalWeight = spec.boxes.reduce((s, b) => s + b.lb * (b.qty || 1), 0);

  console.log(`=== ${spec.name} ===`);
  console.log(`source: ${spec.source} — ${src.addressLine1}, ${src.city} ${src.stateOrProvinceCode}`);
  if (spec.poRef) console.log(`PO: ${spec.poRef}`);
  console.log(`\n${spec.boxes.length} carton(s), ${totalUnits} units, ${totalWeight.toFixed(1)} lb total`);
  for (const b of spec.boxes) {
    console.log(`  ${b.units.map((u) => `${u.quantity} x ${u.msku}`).join(' + ').padEnd(34)} ${b.l}x${b.w}x${b.h} in  ${b.lb} lb`);
  }

  if (!COMMIT) {
    console.log('\n--- setPackingInformation payload (first grouping) ---');
    console.log(JSON.stringify({ packageGroupings: [{ packingGroupId: '<resolved at run time>', boxes: spec.boxes.map((b) => packingBox(b, spec.expiration, {})) }] }, null, 1).slice(0, 1400));
    console.log('\nDRY RUN — nothing created. Re-run with --commit to create the inbound plan.');
    return;
  }

  const prep = await resolvePrep(spec.items.map((i) => i.msku));
  console.log('\nprep ownership (from Amazon getPrepDetails):');
  for (const i of spec.items) console.log(`  ${i.msku.padEnd(20)} prepOwner=${prep[i.msku].prepOwner.padEnd(6)} labelOwner=${prep[i.msku].labelOwner}  (${prep[i.msku].why})`);

  const created = await inbound.createInboundPlan({
    name: spec.name,
    sourceAddress: src,
    items: spec.items.map((i) => ({ msku: i.msku, quantity: i.qty, prepOwner: prep[i.msku].prepOwner, labelOwner: prep[i.msku].labelOwner, ...(spec.expiration ? { expiration: spec.expiration } : {}) })),
  });
  await inbound.waitForOperation(created.operationId);
  const planId = created.inboundPlanId;
  console.log(`\n1) plan created ${planId}`);

  await inbound.waitForOperation((await inbound.generatePackingOptions(planId)).operationId);
  const opt = (await inbound.listPackingOptions(planId)).packingOptions[0];
  const groups = opt.packingGroups || [];
  console.log(`2) packing option ${opt.packingOptionId} — ${groups.length} group(s)`);

  // Assign each carton to the group holding its SKU. Unlike the old script this
  // supports N groups; what it will NOT do is guess when a carton's SKU appears
  // in no group, because mismatched box content causes receiving discrepancies.
  const groupings = [];
  const assigned = new Set();
  for (const gid of groups) {
    const mskus = new Set(await groupItems(planId, opt.packingOptionId, gid));
    const mine = spec.boxes.filter((b) => b.units.every((u) => mskus.has(u.msku)));
    mine.forEach((b) => assigned.add(b));
    console.log(`   group ${gid}: ${mskus.size} sku(s) → ${mine.length} carton(s)`);
    if (mine.length) groupings.push({ packingGroupId: gid, boxes: mine.map((b) => packingBox(b, spec.expiration, prep)) });
  }
  const orphan = spec.boxes.filter((b) => !assigned.has(b));
  if (orphan.length) {
    throw new Error(`${orphan.length} carton(s) match no packing group: ${orphan.map((b) => b.units.map((u) => u.msku).join('+')).join(', ')}`);
  }

  await inbound.waitForOperation((await inbound.confirmPackingOption(planId, opt.packingOptionId)).operationId);
  console.log('   packing option confirmed');

  const spi = await spApiRequest('POST', `${BASE}/inboundPlans/${planId}/packingInformation`, { body: { packageGroupings: groupings } });
  if (spi.status !== 200 && spi.status !== 202) throw new Error(`setPackingInformation ${spi.status}: ${String(spi.body).slice(0, 500)}`);
  const spiB = JSON.parse(spi.body || '{}');
  if (spiB.operationId) await inbound.waitForOperation(spiB.operationId);
  console.log('3) setPackingInformation OK');

  await inbound.waitForOperation((await inbound.generatePlacementOptions(planId)).operationId);
  const placement = (await inbound.listPlacementOptions(planId)).placementOptions.reduce((b, o) => (feesOf(o) < feesOf(b) ? o : b));
  console.log(`4) placement ${placement.placementOptionId} fee=${money(feesOf(placement))} shipments=${(placement.shipmentIds || []).length}`);
  await inbound.waitForOperation((await inbound.confirmPlacementOption(planId, placement.placementOptionId)).operationId);

  const plan = await inbound.getInboundPlan(planId);
  const shipmentIds = (plan.shipments || []).map((s) => s.shipmentId);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (off) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + off); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T00:00:00Z`; };
  const configs = shipmentIds.map((shipmentId) => ({
    shipmentId,
    contactInformation: { name: 'Mac Roy', phoneNumber: src.phoneNumber, email: 'mac@customfc.ca' },
    readyToShipWindow: { start: iso(Number(spec.readyInDays ?? 3)) },
    pallets: [],
    boxes: spec.boxes.map(transportBox),
  }));
  await inbound.waitForOperation((await inbound.generateTransportationOptions(planId, { placementOptionId: placement.placementOptionId, shipmentTransportationConfigurations: configs })).operationId);

  const all = []; let token = null;
  do {
    const p = new URLSearchParams({ pageSize: '20', placementOptionId: placement.placementOptionId });
    if (token) p.set('paginationToken', token);
    const res = await spApiRequest('GET', `${BASE}/inboundPlans/${planId}/transportationOptions?${p}`, {});
    const b = JSON.parse(res.body); all.push(...(b.transportationOptions || [])); token = b.pagination?.nextToken || null;
  } while (token);

  const partnered = all.filter((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');
  console.log(`5) ${all.length} transport option(s), ${partnered.length} partnered (SPD is what we want):`);
  for (const o of partnered.slice(0, 10)) {
    const q = quoteOf(o);
    console.log(`     ${o.transportationOptionId}  ${o.shippingMode}  ${o.carrier?.name || '?'}  ${q ? money(q.amount) + ' ' + q.code : 'no quote'}`);
  }
  console.log(`\nplanId=${planId}  shipments=${shipmentIds.join(',')}  placementOption=${placement.placementOptionId}`);
  console.log('TRANSPORT NOT CONFIRMED — confirming books the carrier and is a separate deliberate step.');
})().catch((e) => { console.error('ERROR:', e.message); if (e.body) console.error('body:', String(e.body).slice(0, 500)); process.exit(1); });
