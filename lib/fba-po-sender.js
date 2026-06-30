/**
 * FBA PO sender — per-vendor email templates + send pipeline.
 *
 * Three distinct flows:
 *
 * - prosol       → Kaitlyn at Prosol. Restock PO for Schluter + Aqua Mix.
 *                  Includes stock-situation notes (backorder, capped, etc.)
 *                  so Prosol knows if we're triggering a cross-warehouse
 *                  consolidation.
 *
 * - treeco       → Robyn at Treeco, cc Brianna. Restock PO for Bona.
 *                  Similar template, no stock-situation (we don't track
 *                  Treeco stock yet).
 *
 * - perfectlevel → warehouse@customfc.ca (Sechelt). NOT a vendor PO —
 *                  internal pack/prep request. Body explicitly says the
 *                  FBA inbound labels will follow separately (Phase 5
 *                  Amazon Inbound API not wired yet).
 *
 * Sends via nodemailer + Office 365 SMTP (same transport as lib/emailer.js).
 * All sends cc mac@customfc.ca per GLOBAL_CC in lib/fba-po-drafts.js.
 *
 * Sent drafts are archived to data/fba/po-drafts/sent/<draftId>.json.
 */

const fs = require('fs');
const path = require('path');

let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const sf = require('./salesforce');
const { findPbsiItem } = require('./amazon-po');
const { VENDOR_META } = require('./fba-po-drafts');
const { generateFbaPoPdf } = require('./packing-slip');
const inbound = require('./sp-api-inbound');

const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';
const TREECO_VENDOR_ID = '0014x00001P1SW2AAN';

// Map our vendor keys to SF Account IDs. Only vendors with an SF ID get an SF PO.
const SF_VENDOR_IDS = {
  prosol: PROSOL_VENDOR_ID,
  treeco: TREECO_VENDOR_ID,
  // perfectlevel intentionally omitted — internal transfer, not a vendor PO
};

const SMTP_USER = 'hello@yourfloors.ca';
const SMTP_PASS = process.env.SMTP_PASSWORD;
const FROM_NAME = process.env.FROM_NAME || 'Mac Roy';

const DRAFTS_DIR = path.join(__dirname, '..', 'data', 'fba', 'po-drafts');
const SENT_DIR = path.join(DRAFTS_DIR, 'sent');

function createTransport() {
  if (!nodemailer) throw new Error('nodemailer is not installed');
  if (!SMTP_PASS) throw new Error('SMTP_PASSWORD missing from env');
  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { ciphers: 'SSLv3' },
  });
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Email body rendering ────────────────────────────────────────────────────

function renderStockNote(line) {
  // Explicit per-branch sourcing instruction (e.g. "pull 40 from London +
  // 20 from WCAS") overrides the auto note — precise pulls avoid the
  // vague-PO mis-ship that bit PO-14179.
  if (line.sourcingNote) return `<span style="color:#1d4ed8">${esc(line.sourcingNote)}</span>`;
  const d = line.prosolStock?.decision;
  if (!d) return '';
  if (d.action === 'full') return `<span style="color:#059669">WCAS has ${d.atPrimary} — direct ship</span>`;
  if (d.action === 'backorder') return `<span style="color:#d97706">WCAS has ${d.atPrimary} of ${line.qty} on hand; remaining ${line.qty - d.atPrimary} on backorder to WCAS — ship the full ${line.qty} once it fills</span>`;
  if (d.action === 'capped') return `<span style="color:#dc2626">capped to Prosol total (${d.total})</span>`;
  return '';
}

// Prosol FBA replenishment request — Email 1 of 2.
//
// Rewritten 2026-04-23 after the PO-14179 incident (vague "please process"
// email → Kaitlyn shipped palletized to Sechelt without FBA prep). Updated
// 2026-05-25 to attach FNSKU labels directly to this PO email so Prosol can
// apply them as they pull, instead of waiting for a separate labels email.
//
//  (a) Says FBA up front so it can't be confused with a normal replenishment.
//  (b) Attaches FNSKU labels PDF (generated via SP-API createMarketplaceItemLabels)
//      so Prosol applies them per unit during pull, covering each manufacturer
//      barcode with the Amazon FNSKU.
//  (c) Asks for carton count + L×W×H + weight per carton so we can create the
//      Amazon inbound plan and book the UPS Amazon Partner Carrier transport.
//  (d) Email #2 (renderLabelsBody) follows once dims confirmed — contains FC
//      address + shipment ID for the carton-level routing.
//
function renderProsolBody(lines, draftId, { bucket, fnskuAttached, introNote } = {}) {
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const isBackorder = bucket === 'backorder';

  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi Kaitlyn,</p>`;
  if (introNote) html += `<p>${esc(introNote)}</p>`;
  html += `<p>New <strong>Amazon FBA</strong> replenishment — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units total</strong>.</p>`;

  if (isBackorder) {
    html += `<p style="color:#9a3412"><strong>Heads up:</strong> this is a backorder PO. Not all units are in stock at WCAS yet, so please ship the full quantity once WCAS is replenished.</p>`;
  }

  // Label-as-you-pull block (FNSKU PDF attached to this email).
  if (fnskuAttached) {
    html += `<div style="margin:16px 0;padding:12px 14px;background:#e0e7ff;border-left:3px solid #4338ca">`;
    html += `<strong>FNSKU labels:</strong>`;
    html += `<ol style="margin:6px 0 0 22px;padding:0">`;
    html += `<li>Print the attached <strong>FNSKU PDF</strong>.</li>`;
    html += `<li>At WCAS, apply one label per unit over the manufacturer barcode.</li>`;
    html += `</ol>`;
    html += `</div>`;
  }

  // Ask block — what we still need from Prosol to book the UPS transport.
  html += `<div style="margin:16px 0;padding:12px 14px;background:#fef3c7;border-left:3px solid #d97706">`;
  html += `<strong>Please reply with:</strong>`;
  html += `<ol style="margin:6px 0 0 22px;padding:0">`;
  html += `<li>Stock confirmation + expected ship-ready date.</li>`;
  html += `<li><strong>Carton dimensions:</strong> total carton count, L × W × H per carton, and weight per carton (or per box if mixed).</li>`;
  html += `</ol>`;
  html += `<p style="margin:10px 0 0 0;font-size:13px;color:#78350f">Once we have the dims, Amazon assigns an FC and we'll send you the <strong>carton/transport label info</strong> (FC address + shipment ID for the UPS Amazon Partner Carrier pickup).</p>`;
  html += `</div>`;

  html += `<p style="font-size:13px;color:#475569">Max 50 lb / carton per Amazon. No mixed SKUs per carton unless we flag otherwise in the manifest.</p>`;

  html += `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:12px 0;width:100%;max-width:720px">`;
  html += `<thead><tr style="background:#1a1a2e;color:white"><th style="text-align:left">Prosol SKU</th><th style="text-align:left">Product</th><th style="text-align:right">Qty</th><th style="text-align:left">Notes</th></tr></thead><tbody>`;
  for (const l of lines) {
    const prosolSku = l.prosolStock?.prosolSku || '—';
    html += `<tr style="border-bottom:1px solid #e5e7eb">`;
    html += `<td style="font-family:monospace">${esc(prosolSku)}</td>`;
    html += `<td>${esc((l.product || '').slice(0, 80))}</td>`;
    html += `<td style="text-align:right;font-weight:600">${l.qty}</td>`;
    html += `<td style="font-size:12px">${renderStockNote(l)}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;

  html += `<p>Questions? Reply here or <a href="mailto:mac@customfc.ca">mac@customfc.ca</a>.</p>`;
  html += `<p>Thanks,<br>${esc(FROM_NAME)} · CustomFlooring</p>`;
  html += `</div>`;
  return html;
}

// Treeco (Bona) FBA replenishment request — same two-email pattern as Prosol.
function renderTreecoBody(lines, draftId, { bucket } = {}) {
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const skuMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8')).mappings;

  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi Robyn,</p>`;
  html += `<p>New <strong>Amazon FBA</strong> replenishment for Bona — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units</strong>. Ship path: Treeco → Amazon FC direct via UPS Amazon Partner Carrier (we book pickup once ready).</p>`;

  html += `<div style="margin:16px 0;padding:12px 14px;background:#fef3c7;border-left:3px solid #d97706">`;
  html += `<strong>Please reply with:</strong>`;
  html += `<ol style="margin:6px 0 0 22px;padding:0">`;
  html += `<li>Stock confirmation + ship-ready date (Delta or Calgary, whichever's faster).</li>`;
  html += `<li><strong>Carton dimensions:</strong> total carton count, L × W × H per carton, and weight per carton.</li>`;
  html += `</ol>`;
  html += `<p style="margin:10px 0 0 0;font-size:13px;color:#78350f">Once we have dims, Amazon assigns an FC and we send two PDFs: FNSKU item labels (one per unit) and carton/transport labels (one per carton).</p>`;
  html += `</div>`;

  html += `<p style="font-size:13px;color:#475569">Per-carton prep is on your side — max 50 lb / carton per Amazon, no mixed SKUs per carton unless flagged.</p>`;

  html += `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:12px 0;width:100%;max-width:720px">`;
  html += `<thead><tr style="background:#065f46;color:white"><th style="text-align:left">Treeco SKU</th><th style="text-align:left">Product</th><th style="text-align:right">Qty</th></tr></thead><tbody>`;
  for (const l of lines) {
    const treecoSku = skuMap[l.asin]?.treeco_sku || '(not mapped)';
    html += `<tr style="border-bottom:1px solid #e5e7eb">`;
    html += `<td style="font-family:monospace">${esc(treecoSku)}</td>`;
    html += `<td>${esc((l.product || '').slice(0, 80))}</td>`;
    html += `<td style="text-align:right;font-weight:600">${l.qty}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  html += `<p>Questions? Reply here or <a href="mailto:mac@customfc.ca">mac@customfc.ca</a>.</p>`;
  html += `<p>Thanks,<br>${esc(FROM_NAME)} · CustomFlooring</p>`;
  html += `</div>`;
  return html;
}

function renderSecheltBody(lines, draftId) {
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi team,</p>`;
  html += `<p>Please pack and prep the following for shipment — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units</strong> from Sechelt stock.</p>`;
  html += `<p style="color:#b45309"><strong>Heads up:</strong> box labels will follow in a separate email once the shipment plan is created. Do not ship until labels arrive.</p>`;
  html += `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:12px 0;width:100%;max-width:720px">`;
  html += `<thead><tr style="background:#86198f;color:white"><th style="text-align:left">ASIN</th><th style="text-align:left">Product</th><th style="text-align:right">Qty to prep</th></tr></thead><tbody>`;
  for (const l of lines) {
    html += `<tr style="border-bottom:1px solid #e5e7eb">`;
    html += `<td style="font-family:monospace">${esc(l.asin)}</td>`;
    html += `<td>${esc((l.product || '').slice(0, 80))}</td>`;
    html += `<td style="text-align:right;font-weight:600">${l.qty}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  html += `<p style="font-size:12px;color:#64748b">If a SKU doesn't match Salesforce inventory, flag before packing.</p>`;
  html += `<p>Thanks,<br>${esc(FROM_NAME)}</p>`;
  html += `</div>`;
  return html;
}

// Labels-ready email (email #2 of the two-email flow). Fires after the
// inbound plan is confirmed and we have:
//   - FNSKU item labels PDF (one label per unit)
//   - Transport/carton labels PDF (one per carton, with destination FC + APC UPS tracking)
//   - Amazon FC destination (fcCode + fcAddress)
//
// Kaitlyn applies the FNSKU labels per unit, the transport labels per carton,
// and replies "ready to ship" once packing is done. That reply triggers the
// UPS pickup booking flow.
function renderLabelsBody({ vendor, lines, bucket, fcCode, fcAddress, poNumber, shipmentConfirmationId, amazonReferenceId, cartonDims }) {
  const greeting = vendor === 'treeco' ? 'Hi Robyn,' : 'Hi Kaitlyn,';
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>${greeting}</p>`;
  html += `<p>Amazon has confirmed the destination FC for <strong>${poNumber || 'PO-DRAFT'}</strong> (${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units). FNSKU labels went out with the PO — apply per unit during the pull. Ship-to + shipment ID below; reply "ready" with final carton count when packed and we'll book the UPS pickup.</p>`;

  // Ship-to block — unmissable.
  html += `<div style="margin:16px 0;padding:14px 16px;background:#ecfdf5;border:2px solid #059669;border-radius:6px">`;
  html += `<div style="font-size:11px;color:#065f46;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Ship to — Amazon Fulfillment Center</div>`;
  html += `<div style="font-size:16px;font-weight:700;color:#064e3b;margin-top:4px">${esc(fcCode || '(FC code pending)')}</div>`;
  if (fcAddress) {
    const lineOrder = ['companyName', 'name', 'addressLine1', 'addressLine2', 'city', 'stateOrProvinceCode', 'postalCode', 'countryCode'];
    const lines2 = lineOrder.map((k) => fcAddress[k]).filter(Boolean);
    html += `<div style="font-size:14px;color:#064e3b;margin-top:4px">${lines2.map(esc).join('<br>')}</div>`;
  }
  if (shipmentConfirmationId) {
    html += `<div style="font-size:12px;color:#475569;margin-top:8px"><strong>Shipment ID:</strong> ${esc(shipmentConfirmationId)}</div>`;
  }
  if (amazonReferenceId) {
    html += `<div style="font-size:12px;color:#475569"><strong>Amazon Ref:</strong> ${esc(amazonReferenceId)} <em>(use this on the BOL / carrier paperwork)</em></div>`;
  }
  html += `</div>`;

  // Prep + shipment routing instructions. FNSKU labels were already sent
  // with the PO email — Prosol should have applied them as they pulled.
  html += `<div style="margin:16px 0;padding:12px 14px;background:#fef3c7;border-left:3px solid #d97706">`;
  html += `<strong>Final prep:</strong>`;
  html += `<ul style="margin:6px 0 0 22px;padding:0">`;
  html += `<li>FNSKU labels should already be applied per unit (sent with the PO email). Double-check each unit's manufacturer barcode is covered.</li>`;
  html += `<li>Mark each carton's exterior with the <strong>Shipment ID</strong> above (handwritten or printed on a sticker is fine — UPS APC pickup uses this to manifest the shipment).</li>`;
  html += `<li>Max 50 lb / carton. No mixed SKUs per carton unless flagged in the manifest.</li>`;
  if (cartonDims) {
    html += `<li style="color:#475569"><em>Confirmed dims: ${cartonDims.count} carton${cartonDims.count === 1 ? '' : 's'} @ ${cartonDims.L}×${cartonDims.W}×${cartonDims.H} in, ${cartonDims.weightLb} lb each.</em></li>`;
  }
  html += `</ul>`;
  html += `</div>`;

  html += `<p><strong>When packed:</strong> reply "ready to ship" with final carton count (if different from above) and we'll book the UPS pickup same-day or next business day.</p>`;

  html += `<p>Thanks,<br>${esc(FROM_NAME)} · CustomFlooring</p>`;
  html += `</div>`;
  return html;
}

function renderBody(vendor, lines, draftId, opts = {}) {
  if (vendor === 'prosol') return renderProsolBody(lines, draftId, opts);
  if (vendor === 'treeco') return renderTreecoBody(lines, draftId, opts);
  if (vendor === 'perfectlevel') return renderSecheltBody(lines, draftId);
  throw new Error(`No email template for vendor '${vendor}'`);
}

// Generate the FNSKU label PDF for a list of PO lines (one label per unit,
// quantity = line.qty). Calls Amazon's createMarketplaceItemLabels and
// downloads the signed-URL PDF (URL expires in ~29s, so download is sync).
//
// Returns { buffer, mskuQuantities } or null on failure (caller falls back
// to sending the PO email without FNSKU PDF + alerts).
async function generateFnskuLabelsPdf(lines) {
  const mskuQuantities = lines
    .filter((l) => l.sku && l.qty > 0)
    .map((l) => ({ msku: l.sku, quantity: Number(l.qty) }));
  if (!mskuQuantities.length) {
    throw new Error('No lines with a usable msku for FNSKU label generation');
  }
  const resp = await inbound.createMarketplaceItemLabels({
    mskuQuantities,
    labelType: 'STANDARD_FORMAT',
    pageType: 'Letter_30',
  });
  const docs = resp.documentDownloads || [];
  if (!docs.length) throw new Error('createMarketplaceItemLabels returned no documentDownloads');
  const url = docs[0].uri;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FNSKU PDF download failed: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mskuQuantities, downloadedAt: new Date().toISOString() };
}

function buildSubject(vendor, lines, bucket) {
  const today = new Date().toISOString().slice(0, 10);
  const bucketTag = bucket && bucket !== 'ready' ? ` (${bucket.toUpperCase()})` : '';
  // Subjects say "FBA" + "need carton dims + ETA" so the ask is obvious from
  // the inbox preview and the thread is easy to match on reply (dims parser
  // uses the subject's PO number / In-Reply-To header to match).
  if (vendor === 'prosol') return `FBA Replenishment PO${bucketTag} — ${today} — need carton dims + ETA — ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  if (vendor === 'treeco') return `FBA Bona Replenishment PO${bucketTag} — ${today} — need carton dims + ETA — ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  if (vendor === 'perfectlevel') return `Pack Request (Sechelt)${bucketTag} — ${today} — ${lines.length} SKU${lines.length === 1 ? '' : 's'}`;
  throw new Error(`No subject template for vendor '${vendor}'`);
}

// ── Preview (no send) ───────────────────────────────────────────────────────

function preview(vendor, lines, draftId) {
  const meta = VENDOR_META[vendor];
  if (!meta) throw new Error(`Unknown vendor '${vendor}'`);
  // For Prosol, FNSKU PDF is generated + attached at send-time. The preview
  // assumes that will succeed so the copy reflects the expected outcome.
  const previewOpts = vendor === 'prosol' ? { fnskuAttached: true } : {};
  return {
    vendor,
    to: meta.email,
    cc: meta.cc || [],
    subject: buildSubject(vendor, lines),
    html: renderBody(vendor, lines, draftId, previewOpts),
    lineCount: lines.length,
    totalUnits: lines.reduce((s, l) => s + l.qty, 0),
    fnskuPlanned: vendor === 'prosol',
  };
}

// ── Salesforce PO creation ──────────────────────────────────────────────────
//
// Creates a PBSI__PBSI_Purchase_Order__c tagged as FBA restock. One PO per
// send, one PO line per SKU. No SO linkage — FBA inventory isn't a customer
// sale; the sale happens later when Amazon fulfills an order from FBA stock.
//
// Currently supported vendors:
//   prosol → PROSOL_VENDOR_ID, PBSI items looked up by prosol_sku
//
// Others skipped until user provides SF vendor IDs.

async function createSalesforceFbaPO({ vendor, draft, lines, bucket }) {
  const sfVendorId = SF_VENDOR_IDS[vendor];
  if (!sfVendorId) {
    return { skipped: true, reason: `SF PO skipped — no SF vendor ID configured for '${vendor}'` };
  }

  const conn = await sf.connect();
  const resolvedLines = [];
  const errors = [];

  // sku-map cache for treeco_sku lookups
  const skuMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8')).mappings;

  // 1. Resolve each line to a PBSI item — vendor-specific source of vendor item ID
  for (const line of lines) {
    let vendorItemId = null;
    let vendorItemIdSource = null;

    if (vendor === 'prosol') {
      vendorItemId = line.prosolStock?.prosolSku || skuMap[line.asin]?.prosol_sku || null;
      vendorItemIdSource = 'prosol_sku';
    } else if (vendor === 'treeco') {
      vendorItemId = skuMap[line.asin]?.treeco_sku || null;
      vendorItemIdSource = 'treeco_sku';
    }

    if (!vendorItemId) {
      errors.push(`No ${vendorItemIdSource} mapped for ${line.asin} (${(line.product || '').slice(0, 40)})`);
      continue;
    }
    try {
      const pbsiItem = await findPbsiItem(conn, vendorItemId);
      if (!pbsiItem) {
        errors.push(`PBSI item not found for ${vendorItemId} (${line.asin})`);
        continue;
      }
      resolvedLines.push({
        line,
        vendorItemId,
        pbsiItemId: pbsiItem.Id,
        pbsiItemName: pbsiItem.Name,
        costPrice: pbsiItem.PBSI__Cost__c || 0,
      });
    } catch (e) {
      errors.push(`Lookup failed for ${vendorItemId}: ${e.message}`);
    }
  }

  if (!resolvedLines.length) {
    return { skipped: false, created: false, errors, reason: 'No PBSI items resolved — nothing to create' };
  }

  // 2. Create the PO
  const today = new Date().toISOString().slice(0, 10);
  const bucketTag = bucket ? ` — ${bucket.toUpperCase()}` : '';
  const shippingInstructions = `FBA Restock — Amazon CA${bucketTag} — Draft ${draft.draftId} — ${resolvedLines.length} lines`.slice(0, 255);

  const poId = await sf.create(conn, 'PBSI__PBSI_Purchase_Order__c', {
    PBSI__Account__c: sfVendorId,
    PBSI__Order_Date__c: today,
    PBSI__Status__c: 'Open',
    PBSI__Shipping_Instructions__c: shippingInstructions,
  });

  // 3. Get PO number
  const poRecords = await sf.query(conn, `SELECT Name FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '${poId}'`);
  const poNumber = poRecords[0]?.Name || poId;

  // 4. Create PO lines
  const createdLines = [];
  for (const r of resolvedLines) {
    try {
      const poLineId = await sf.create(conn, 'PBSI__PBSI_Purchase_Order_Line__c', {
        PBSI__Purchase_Order__c: poId,
        PBSI__Item__c: r.pbsiItemId,
        PBSI__Quantity_Ordered__c: r.line.qty,
        PBSI__Price__c: r.costPrice,
      });
      createdLines.push({
        asin: r.line.asin,
        prosolSku: r.prosolSku,
        pbsiItemName: r.pbsiItemName,
        qty: r.line.qty,
        costPrice: r.costPrice,
        poLineId,
      });
      // Stamp the draft line with the SF reference
      r.line.sfPoId = poId;
      r.line.sfPoNumber = poNumber;
      r.line.sfPoLineId = poLineId;
    } catch (e) {
      errors.push(`PO line create failed for ${r.prosolSku}: ${e.message}`);
    }
  }

  return {
    skipped: false,
    created: true,
    poId,
    poNumber,
    lineCount: createdLines.length,
    totalCost: Number(createdLines.reduce((s, l) => s + (l.costPrice * l.qty), 0).toFixed(2)),
    lines: createdLines,
    errors,
  };
}

// ── Send a single vendor group ──────────────────────────────────────────────

async function sendVendorGroup({ draft, vendor, bucket, skipEmail = false, reviewTo = null }) {
  const meta = VENDOR_META[vendor];
  if (!meta) throw new Error(`Unknown vendor '${vendor}'`);
  if (!meta.email) throw new Error(`Vendor '${vendor}' has no email address configured`);

  // bucket filter: when provided, one SF PO + one email per (vendor, bucket)
  // so in-stock ships in its own PO and backorder consolidation doesn't hold
  // it up. When omitted, legacy behavior (all unsent lines together) — kept
  // for backward compat with the Telegram auto-restock approval path until
  // that path is updated to be bucket-aware.
  const lines = draft.lines.filter((l) =>
    l.vendor === vendor && !l.sentAt && (!bucket || l.availabilityBucket === bucket));
  if (!lines.length) {
    throw new Error(`No unsent lines for vendor '${vendor}'${bucket ? ` bucket '${bucket}'` : ''}`);
  }

  // Create Salesforce PO FIRST so we can put the PO number on the PDF.
  // If SF fails, we still send the email — with a "DRAFT" PO number on the PDF.
  // Review mode (reviewTo set): send Mac a copy only — no SF PO, no vendor email,
  // no line-state change. Real attachments so he sees exactly what would go out.
  let sfPo = null;
  if (!reviewTo) {
    try {
      sfPo = await createSalesforceFbaPO({ vendor, draft, lines, bucket });
    } catch (e) {
      sfPo = { skipped: false, created: false, error: e.message };
    }
  }

  // Render PO PDF
  const skuMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8')).mappings;
  const today = new Date().toISOString().slice(0, 10);
  const vendorSkuField = vendor === 'prosol' ? 'prosol_sku' : (vendor === 'treeco' ? 'treeco_sku' : null);
  const pdfLines = lines.map((l) => ({
    vendorSku: vendorSkuField && skuMap[l.asin]?.[vendorSkuField] || l.prosolStock?.prosolSku || l.asin,
    product: l.product || '',
    qty: l.qty,
    unitCost: l.unitCost ?? (sfPo?.lines?.find((s) => s.asin === l.asin)?.costPrice ?? null),
  }));
  const netTotal = pdfLines.reduce((s, l) => s + (l.unitCost ? l.unitCost * l.qty : 0), 0) || null;

  const vendorAddress = vendor === 'prosol'
    ? '5760 9 St SE #105, Calgary AB T2H 1Z9'
    : (vendor === 'treeco' ? '1230 Cliveden Avenue, Delta BC V3M 6G4' : '');
  const vendorContactLine = meta.contact ? `Attn: ${meta.contact}` : '';

  const shippingInstructions = [
    'Replenishment order — courier will pick up once confirmed.',
    'Courier labels will be sent separately to attach to the package.',
  ].join('\n');

  let pdfBuffer = null;
  if (!reviewTo) try {
    pdfBuffer = await generateFbaPoPdf({
      poNumber: sfPo?.poNumber || 'DRAFT',
      date: today,
      vendor: meta.label,
      vendorAddress,
      vendorContact: vendorContactLine,
      shippingInstructions,
      lines: pdfLines,
      netTotal,
    });
  } catch (e) {
    console.error('fba-po-sender: PDF generation failed, email will send without attachment:', e.message);
  }

  // Generate FNSKU labels PDF (Prosol only — they apply labels at the WCAS
  // warehouse as they pull each unit). Failure is non-fatal: PO still sends,
  // we just flag in the email that labels couldn't be attached.
  let fnskuResult = null;
  if (vendor === 'prosol' && !reviewTo) {
    try {
      fnskuResult = await generateFnskuLabelsPdf(lines);
    } catch (e) {
      console.error('fba-po-sender: FNSKU PDF generation failed, PO email will go without FNSKU attachment:', e.message);
    }
  }

  // Compose the email regardless — we render subject/body here even when
  // skipEmail so callers get the preview back and can copy-paste into a
  // manual send from the user's own mail client.
  const subject = (reviewTo ? '[REVIEW] ' : '') + buildSubject(vendor, lines, bucket);
  const html = renderBody(vendor, lines, draft.draftId, { bucket, fnskuAttached: reviewTo ? (vendor === 'prosol') : !!fnskuResult });
  const attachments = [];
  if (pdfBuffer) {
    attachments.push({
      filename: `PO-${sfPo?.poNumber || 'draft'}-${today}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    });
  }
  if (fnskuResult) {
    attachments.push({
      filename: `FNSKU-${sfPo?.poNumber || 'draft'}-${today}.pdf`,
      content: fnskuResult.buffer,
      contentType: 'application/pdf',
    });
  }

  if (!skipEmail) {
    const transport = createTransport();
    try {
      await transport.sendMail({
        from: `"${FROM_NAME}" <${SMTP_USER}>`,
        to: reviewTo || meta.email,
        cc: reviewTo ? undefined : ((meta.cc && meta.cc.length) ? meta.cc : undefined),
        subject,
        html,
        attachments,
      });
    } finally {
      transport.close();
    }
  }

  // Mark lines as sent (or as sf-only-created when skipEmail) + transition
  // state. skipEmail still advances state so the dashboard knows dims are
  // expected next — the vendor won't know to reply unless the user sends the
  // manual email, which is fine; state reflects *our* commitment.
  const sentAt = reviewTo ? null : new Date().toISOString();
  if (!reviewTo) {
    for (const line of lines) {
      line.sentAt = sentAt;
      line.sentTo = skipEmail ? null : meta.email;
      line.sentCc = skipEmail ? [] : (meta.cc || []);
      line.emailSkipped = skipEmail || false;
      if (sfPo?.poNumber) line.sfPoNumber = sfPo.poNumber;
      if ((line.state || 'draft') === 'draft') line.state = 'awaiting-dims';
      line.updatedAt = sentAt;
    }
  }

  return {
    sent: !skipEmail,
    emailSkipped: skipEmail,
    vendor,
    bucket: bucket || null,
    to: skipEmail ? null : meta.email,
    cc: skipEmail ? [] : (meta.cc || []),
    subject,
    html,  // surface the rendered HTML so callers can preview / forward
    pdfAttached: !!pdfBuffer,
    lineCount: lines.length,
    totalUnits: lines.reduce((s, l) => s + l.qty, 0),
    sentAt,
    sfPo,
    pdfAttached: !!pdfBuffer,
  };
}

/**
 * Send the labels-ready email (email #2 of the two-email flow). Called from
 * /api/fba/po-draft/send-labels after the orchestrator has produced the
 * FNSKU + carton label PDFs and the FC placement is confirmed.
 *
 * Lines passed in must already be in state 'awaiting-labels-ack'. This fn
 * does NOT transition state — caller does that after confirming the send
 * succeeded.
 */
async function sendLabelsEmail({ vendor, bucket, lines, poNumber, fcCode, fcAddress, shipmentConfirmationId, amazonReferenceId, cartonDims, fnskuPdfPath, transportPdfPath }) {
  const meta = VENDOR_META[vendor];
  if (!meta) throw new Error(`Unknown vendor '${vendor}'`);
  if (!meta.email) throw new Error(`Vendor '${vendor}' has no email configured`);

  const transport = createTransport();
  const today = new Date().toISOString().slice(0, 10);
  const bucketTag = bucket && bucket !== 'ready' ? ` (${bucket.toUpperCase()})` : '';
  const subject = `FBA Labels ready${bucketTag} — ${poNumber || today} — ship to ${fcCode || 'Amazon FC'}`;
  const html = renderLabelsBody({ vendor, lines, bucket, fcCode, fcAddress, poNumber, shipmentConfirmationId, amazonReferenceId, cartonDims });

  const attachments = [];
  if (fnskuPdfPath && fs.existsSync(fnskuPdfPath)) {
    attachments.push({ filename: `FNSKU-${poNumber || today}.pdf`, content: fs.readFileSync(fnskuPdfPath), contentType: 'application/pdf' });
  }
  if (transportPdfPath && fs.existsSync(transportPdfPath)) {
    attachments.push({ filename: `CartonLabels-${poNumber || today}.pdf`, content: fs.readFileSync(transportPdfPath), contentType: 'application/pdf' });
  }

  try {
    await transport.sendMail({
      from: `"${FROM_NAME}" <${SMTP_USER}>`,
      to: meta.email,
      cc: (meta.cc && meta.cc.length) ? meta.cc : undefined,
      subject,
      html,
      attachments,
    });
  } finally {
    transport.close();
  }

  return {
    sent: true,
    vendor,
    bucket: bucket || null,
    to: meta.email,
    cc: meta.cc || [],
    subject,
    lineCount: lines.length,
    attachmentCount: attachments.length,
    fnskuAttached: !!fnskuPdfPath && fs.existsSync(fnskuPdfPath || ''),
    transportAttached: !!transportPdfPath && fs.existsSync(transportPdfPath || ''),
    sentAt: new Date().toISOString(),
  };
}

// Send every bucket a vendor owns, in priority order, with 60s SMTP gaps so
// Office 365 doesn't quarantine (same rule as lib/emailer.js warehouse loop).
// Ready first so in-stock lands in Kaitlyn's inbox first and the backorder
// email is clearly distinguished from it.
const BUCKET_ORDER = ['ready', 'backorder', 'sechelt'];

async function sendAllBucketsForVendor({ draft, vendor, skipEmail = false }) {
  const results = [];
  const pending = BUCKET_ORDER.filter((b) =>
    draft.lines.some((l) => l.vendor === vendor && !l.sentAt && l.availabilityBucket === b));
  for (let i = 0; i < pending.length; i++) {
    const bucket = pending[i];
    try {
      const r = await sendVendorGroup({ draft, vendor, bucket, skipEmail });
      results.push(r);
    } catch (e) {
      results.push({ sent: false, vendor, bucket, error: e.message });
    }
    // No SMTP gap needed when skipEmail (no SMTP call), so ship all buckets
    // back-to-back for a fast SF-PO-only run.
    if (i < pending.length - 1 && !skipEmail) await new Promise((r) => setTimeout(r, 60_000));
  }
  return { vendor, buckets: results };
}

// ── Archive completed drafts ────────────────────────────────────────────────

function archiveIfAllSent(draft) {
  fs.mkdirSync(SENT_DIR, { recursive: true });
  const allSent = draft.lines.every((l) => l.sentAt);
  if (!allSent) return null;
  draft.status = 'sent';
  draft.archivedAt = new Date().toISOString();
  const archivePath = path.join(SENT_DIR, `${draft.draftId}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(draft, null, 2));
  return archivePath;
}

// Send ONE combined Prosol email containing multiple POs: one SF PO + one PO
// PDF per draft line (e.g. a rush 20 + backorder 40 of the same SKU), a single
// FNSKU label sheet, and a body summarising the split. Always builds the real
// attachments. reviewTo: send only to that address with DRAFT PO numbers, no SF
// PO, no line-state change (Mac's pre-send review with the real attachments).
async function sendCombinedProsolPo({ draft, reviewTo = null }) {
  const vendor = 'prosol';
  const meta = VENDOR_META[vendor];
  const lines = draft.lines.filter((l) => l.vendor === vendor && !l.sentAt);
  if (!lines.length) throw new Error('No unsent prosol lines');

  const today = new Date().toISOString().slice(0, 10);
  const skuMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8')).mappings;
  const vendorAddress = '5760 9 St SE #105, Calgary AB T2H 1Z9';
  const shippingInstructions = 'Replenishment order. Courier labels will be sent separately to attach to the package.';

  const attachments = [];
  const pos = [];
  let totalUnits = 0;
  for (const line of lines) {
    totalUnits += line.qty;
    let sfPo = null;
    if (!reviewTo) {
      try { sfPo = await createSalesforceFbaPO({ vendor, draft, lines: [line], bucket: line.availabilityBucket }); }
      catch (e) { sfPo = { error: e.message }; }
    }
    const poNumber = sfPo?.poNumber || (reviewTo ? `REVIEW-${line.qty}u` : 'DRAFT');
    const pdfLines = [{
      vendorSku: skuMap[line.asin]?.prosol_sku || line.prosolStock?.prosolSku || line.asin,
      product: line.product || '', qty: line.qty,
      unitCost: line.unitCost ?? (sfPo?.lines?.find((s) => s.asin === line.asin)?.costPrice ?? null),
    }];
    const netTotal = pdfLines.reduce((s, l) => s + (l.unitCost ? l.unitCost * l.qty : 0), 0) || null;
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateFbaPoPdf({ poNumber, date: today, vendor: meta.label, vendorAddress, vendorContact: meta.contact ? `Attn: ${meta.contact}` : '', shippingInstructions, lines: pdfLines, netTotal });
    } catch (e) { console.error('combined PO PDF fail:', e.message); }
    if (pdfBuffer) attachments.push({ filename: `PO-${poNumber}-${today}.pdf`, content: pdfBuffer, contentType: 'application/pdf' });
    if (sfPo?.poNumber) line.sfPoNumber = sfPo.poNumber;
    pos.push({ poNumber, qty: line.qty, bucket: line.availabilityBucket, sfErr: sfPo?.error || null });
  }

  let fnskuResult = null;
  try { fnskuResult = await generateFnskuLabelsPdf(lines); } catch (e) { console.error('combined FNSKU fail:', e.message); }
  if (fnskuResult) attachments.push({ filename: `FNSKU-${today}.pdf`, content: fnskuResult.buffer, contentType: 'application/pdf' });

  const introNote = "I noticed you don't have full stock on this one, so I split it into two POs (both attached): you can ship the 20 from WCAS stock now, and we'll backorder the second PO of 40. Sound good?";
  const display = { ...lines[0], qty: totalUnits, sourcingNote: '20 in stock at WCAS (ship now) + 40 on backorder. See the two attached POs.' };
  const subject = (reviewTo ? '[REVIEW] ' : '') + buildSubject(vendor, [display]);
  const html = renderBody(vendor, [display], draft.draftId, { fnskuAttached: !!fnskuResult, introNote });

  const transport = createTransport();
  try {
    await transport.sendMail({ from: `"${FROM_NAME}" <${SMTP_USER}>`, to: reviewTo || meta.email, cc: reviewTo ? undefined : ((meta.cc && meta.cc.length) ? meta.cc : undefined), subject, html, attachments });
  } finally { transport.close(); }

  if (!reviewTo) {
    const sentAt = new Date().toISOString();
    for (const line of lines) { line.sentAt = sentAt; line.sentTo = meta.email; line.sentCc = meta.cc || []; if ((line.state || 'draft') === 'draft') line.state = 'awaiting-dims'; line.updatedAt = sentAt; }
  }
  return { to: reviewTo || meta.email, cc: reviewTo ? [] : (meta.cc || []), subject, attachments: attachments.map((a) => a.filename), pos };
}

module.exports = { preview, sendVendorGroup, sendAllBucketsForVendor, sendCombinedProsolPo, sendLabelsEmail, renderLabelsBody, archiveIfAllSent, renderBody, buildSubject, createSalesforceFbaPO, BUCKET_ORDER };
