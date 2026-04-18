#!/usr/bin/env node
/**
 * FBA Inbound step 5: FNSKU item labels + shipment IDs.
 *
 * v2024-03-20 only exposes ONE label-document endpoint:
 *   POST /inbound/fba/2024-03-20/items/labels  (createMarketplaceItemLabels)
 *
 * That returns a signed PDF URL containing the FNSKU stickers that go on
 * each individual unit. There is no box-label or BOL endpoint in this API
 * version — at the shipment level, Amazon surfaces `shipmentConfirmationId`
 * (e.g. FBA1234ABCD) and `amazonReferenceId` on the shipment object, which
 * the carrier references on the BOL / paperwork.
 *
 * This script:
 *   1. Re-fetches the plan so we pick up confirmed IDs post-step-4.
 *   2. Aggregates MSKU quantities across all shipments on the plan.
 *   3. Calls createMarketplaceItemLabels once to get the FNSKU PDF URL.
 *   4. Saves the URL, expiration, and per-shipment confirmation IDs to plan state.
 *
 * Usage:
 *   node scripts/fba/inbound-step5-labels.js --plan <planKey>
 *   node scripts/fba/inbound-step5-labels.js --plan <planKey> --pageType Letter_30
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

async function main() {
  const args = parseArgs();
  if (!args.plan) throw new Error('--plan <planKey> is required');

  const state = plans.load(args.plan);
  if (!state) throw new Error(`Plan state not found: ${args.plan}`);
  if (!state.inboundPlanId) throw new Error('No inboundPlanId — plan was never created');

  console.log(`\n[1/3] getInboundPlan (refresh shipment IDs + confirmation IDs)...`);
  const plan = await inbound.getInboundPlan(state.inboundPlanId);
  const shipments = plan.shipments || [];
  if (!shipments.length) throw new Error('No shipments on plan — step 3/4 must run first');

  const shipmentDetails = [];
  for (const s of shipments) {
    const full = await inbound.getShipment(state.inboundPlanId, s.shipmentId);
    shipmentDetails.push(full);
    const conf = full.shipmentConfirmationId || '(not yet assigned)';
    const ref = full.amazonReferenceId || '(not yet assigned)';
    console.log(`  ${s.shipmentId}: status=${full.status} confirmation=${conf} ref=${ref}`);
  }

  console.log(`\n[2/3] createMarketplaceItemLabels (FNSKU stickers)...`);
  // Aggregate MSKU qty across all shipments' items. state.lines holds the plan-
  // level quantity — that's what gets printed on stickers (one per unit).
  const mskuQuantities = state.lines.map((l) => ({ msku: l.msku, quantity: l.quantity }));
  console.log(`  ${mskuQuantities.length} MSKU(s):`, mskuQuantities.map((m) => `${m.msku}×${m.quantity}`).join(', '));

  const pageType = args.pageType || 'Letter_30';
  const labelType = args.labelType || 'STANDARD_FORMAT';
  const resp = await inbound.createMarketplaceItemLabels({
    mskuQuantities,
    labelType,
    pageType,
  });
  const docs = resp.documentDownloads || [];
  if (!docs.length) throw new Error('No documentDownloads returned');
  for (const d of docs) {
    console.log(`  → ${d.downloadType} ${d.uri.slice(0, 80)}...  expires ${d.expiration || '—'}`);
  }

  console.log(`\n[3/3] save to plan state...`);
  state.labels = {
    itemLabelsPdfUrl: docs[0].uri,
    itemLabelsExpiration: docs[0].expiration,
    generatedAt: new Date().toISOString(),
    pageType,
    labelType,
    mskuQuantities,
  };
  state.shipmentDetails = shipmentDetails.map((s) => ({
    shipmentId: s.shipmentId,
    shipmentConfirmationId: s.shipmentConfirmationId || null,
    amazonReferenceId: s.amazonReferenceId || null,
    status: s.status,
    destination: s.destination,
    selectedTransportationOptionId: s.selectedTransportationOptionId || null,
  }));
  state.status = 'labels-ready';
  plans.record(state, {
    step: 'create-item-labels',
    ok: true,
    data: {
      itemLabelsPdfUrl: docs[0].uri,
      itemLabelsExpiration: docs[0].expiration,
      shipmentConfirmationIds: shipmentDetails.map((s) => s.shipmentConfirmationId),
    },
  });
  plans.save(state);

  console.log(`\n✓ step 5 complete.`);
  console.log(`  FNSKU PDF: ${docs[0].uri}`);
  console.log(`  Expiration: ${docs[0].expiration || 'none'}`);
  console.log(`  Shipment confirmations: ${shipmentDetails.map((s) => s.shipmentConfirmationId || '—').join(', ')}`);
  console.log(`\nNext: email labels + confirmation IDs to the vendor; book carrier pickup with shipment IDs on the BOL.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    if (e.body) console.error('body:', e.body.slice(0, 600));
    process.exit(1);
  });
}

module.exports = { main };
