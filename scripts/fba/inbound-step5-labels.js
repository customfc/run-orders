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
 * **URL expiry:** the presigned PDF URL lives for only 29 seconds. Pass
 * --download to fetch the bytes immediately after the call, else the URL
 * will be dead by the time you open it. --email additionally mails the PDF
 * as an attachment (uses the shared emailer SMTP transport).
 *
 * Usage:
 *   node scripts/fba/inbound-step5-labels.js --plan <planKey>
 *   node scripts/fba/inbound-step5-labels.js --plan <planKey> --pageType Letter_30
 *   node scripts/fba/inbound-step5-labels.js --plan <planKey> --download --email mac@customfc.ca
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const inbound = require('../../lib/sp-api-inbound');
const plans = require('../../lib/fba-inbound-plans');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (v !== undefined) {
        args[k.slice(2)] = v;
      } else {
        // If next token is another --flag (or absent), treat this as a boolean
        // flag. Otherwise consume it as the value.
        const next = process.argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          args[k.slice(2)] = true;
        } else {
          args[k.slice(2)] = next;
          i++;
        }
      }
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

  // Download immediately — URL expires in ~29s
  let savedPdfPath = null;
  if (args.download) {
    const defaultPath = path.join(__dirname, '..', '..', 'data', 'fba', 'inbound-plans', `${state.planKey}-item-labels.pdf`);
    savedPdfPath = args.download === true ? defaultPath : args.download;
    console.log(`\n[3a/3] download PDF to ${savedPdfPath} (URL expires in seconds)...`);
    const resDl = await fetch(docs[0].uri);
    if (!resDl.ok) throw new Error(`PDF download failed: ${resDl.status} ${resDl.statusText}`);
    const buf = Buffer.from(await resDl.arrayBuffer());
    fs.mkdirSync(path.dirname(savedPdfPath), { recursive: true });
    fs.writeFileSync(savedPdfPath, buf);
    console.log(`  ✓ ${buf.length} bytes saved`);
  }

  if (args.email) {
    if (!savedPdfPath) throw new Error('--email requires --download (need PDF bytes to attach)');
    console.log(`\n[3b/3] email to ${args.email}${args['email-cc'] ? ' (cc ' + args['email-cc'] + ')' : ''}...`);
    const { sendEmail } = require('../../lib/emailer');
    const confIds = shipmentDetails.map((s) => s.shipmentConfirmationId).filter(Boolean).join(', ');
    const refIds = shipmentDetails.map((s) => s.amazonReferenceId).filter(Boolean).join(', ');
    const mskuList = mskuQuantities.map((m) => `${m.msku} × ${m.quantity}`).join('<br>');
    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#333">
        <p>Hi,</p>
        <p>Attached are the FNSKU item labels for the Amazon FBA inbound shipment below. Please apply one label per unit.</p>
        <p>
          <strong>Plan:</strong> ${state.name}<br>
          <strong>Shipment Confirmation ID:</strong> ${confIds || '(pending)'}<br>
          <strong>Amazon Reference ID:</strong> ${refIds || '(pending)'} <em>(use this on the BOL / carrier paperwork)</em><br>
          <strong>Items:</strong><br>${mskuList}
        </p>
        <p>Thanks,<br>Mac</p>
      </div>`;
    await sendEmail({
      to: args.email,
      cc: args['email-cc'] || undefined,
      subject: `FBA Inbound Labels — ${state.name}${confIds ? ' — ' + confIds : ''}`,
      html,
      attachments: [{ filename: path.basename(savedPdfPath), content: fs.readFileSync(savedPdfPath), contentType: 'application/pdf' }],
    });
    console.log(`  ✓ email sent`);
  }

  console.log(`\n[3/3] save to plan state...`);
  state.labels = {
    itemLabelsPdfUrl: docs[0].uri,
    itemLabelsExpiration: docs[0].expiration,
    itemLabelsPdfPath: savedPdfPath,
    emailedTo: args.email || null,
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
