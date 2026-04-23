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
  const d = line.prosolStock?.decision;
  if (!d) return '';
  if (d.action === 'full') return `<span style="color:#059669">WCAS has ${d.atPrimary} — direct ship</span>`;
  if (d.action === 'backorder') return `<span style="color:#d97706">WCAS ${d.atPrimary} of ${line.qty}; backorder ${line.qty - d.atPrimary} from other PS warehouses (~1wk)</span>`;
  if (d.action === 'capped') return `<span style="color:#dc2626">capped to Prosol total (${d.total})</span>`;
  return '';
}

// Prosol FBA replenishment request — Email 1 of 2.
//
// Rewritten 2026-04-23 after the PO-14179 incident, where Kaitlyn received a
// vague "please process" email and shipped palletized to Sechelt without any
// FBA prep because nothing told her this was Amazon-bound. The new template:
//
//  (a) Says FBA up front so it can't be confused with a normal replenishment.
//  (b) Confirms per-carton prep is on Prosol's side (they're equipped).
//  (c) Asks for carton count + L×W×H + weight per carton so we can create the
//      Amazon inbound plan and get FC-assigned labels.
//  (d) States that FNSKU + carton labels follow in a second email after dims
//      come back — Prosol doesn't need to source their own barcodes.
//
// Ship path: Prosol WCAS → Amazon FC directly (UPS Amazon Partner Carrier).
function renderProsolBody(lines, draftId, { bucket } = {}) {
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const isBackorder = bucket === 'backorder';

  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi Kaitlyn,</p>`;
  html += `<p>New <strong>Amazon FBA</strong> replenishment — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units total</strong>. Ship path: <strong>Prosol WCAS → Amazon FC direct</strong> via UPS Amazon Partner Carrier (we book the pickup once you're ready).</p>`;

  if (isBackorder) {
    html += `<p style="color:#9a3412"><strong>Heads up:</strong> this PO relies on cross-warehouse stock — consolidation expected (~1 week). In-stock WCAS items are on a separate PO going out at the same time.</p>`;
  }

  // Ask block — the two things we need back before we can send labels.
  html += `<div style="margin:16px 0;padding:12px 14px;background:#fef3c7;border-left:3px solid #d97706">`;
  html += `<strong>Please reply with:</strong>`;
  html += `<ol style="margin:6px 0 0 22px;padding:0">`;
  html += `<li>Stock confirmation + expected ship-ready date.</li>`;
  html += `<li><strong>Carton dimensions:</strong> total carton count, L × W × H per carton, and weight per carton (or per box if mixed).</li>`;
  html += `</ol>`;
  html += `<p style="margin:10px 0 0 0;font-size:13px;color:#78350f">Once we have the dims, Amazon assigns an FC and we'll send you two PDFs: <strong>FNSKU item labels</strong> (one per unit — replaces the manufacturer barcodes that have been flagged) and <strong>carton/transport labels</strong> (one per carton with the FC address).</p>`;
  html += `</div>`;

  html += `<p style="font-size:13px;color:#475569">Per-carton prep is on your side as usual — we'll supply all the barcodes + labels, you apply + pack per carton. Max 50 lb / carton per Amazon, no mixed SKUs per carton unless we flag otherwise in the manifest.</p>`;

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

function renderBody(vendor, lines, draftId, opts = {}) {
  if (vendor === 'prosol') return renderProsolBody(lines, draftId, opts);
  if (vendor === 'treeco') return renderTreecoBody(lines, draftId, opts);
  if (vendor === 'perfectlevel') return renderSecheltBody(lines, draftId);
  throw new Error(`No email template for vendor '${vendor}'`);
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
  return {
    vendor,
    to: meta.email,
    cc: meta.cc || [],
    subject: buildSubject(vendor, lines),
    html: renderBody(vendor, lines, draftId),
    lineCount: lines.length,
    totalUnits: lines.reduce((s, l) => s + l.qty, 0),
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

async function sendVendorGroup({ draft, vendor, bucket }) {
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
  let sfPo = null;
  try {
    sfPo = await createSalesforceFbaPO({ vendor, draft, lines, bucket });
  } catch (e) {
    sfPo = { skipped: false, created: false, error: e.message };
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
  try {
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

  // Send email with PDF attached
  const transport = createTransport();
  const subject = buildSubject(vendor, lines, bucket);
  const html = renderBody(vendor, lines, draft.draftId, { bucket });
  const attachments = pdfBuffer ? [{
    filename: `PO-${sfPo?.poNumber || 'draft'}-${today}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }] : [];

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

  // Mark lines as sent + transition state: draft → awaiting-dims
  // (so the dashboard's Awaiting-Dimensions column picks these up, and the
  // confirm-dims endpoint can advance them once the vendor replies).
  const sentAt = new Date().toISOString();
  for (const line of lines) {
    line.sentAt = sentAt;
    line.sentTo = meta.email;
    line.sentCc = meta.cc || [];
    if (sfPo?.poNumber) line.sfPoNumber = sfPo.poNumber;
    if ((line.state || 'draft') === 'draft') line.state = 'awaiting-dims';
    line.updatedAt = sentAt;
  }

  return {
    sent: true,
    vendor,
    bucket: bucket || null,
    to: meta.email,
    cc: meta.cc || [],
    subject,
    lineCount: lines.length,
    totalUnits: lines.reduce((s, l) => s + l.qty, 0),
    sentAt,
    sfPo,
    pdfAttached: !!pdfBuffer,
  };
}

// Send every bucket a vendor owns, in priority order, with 60s SMTP gaps so
// Office 365 doesn't quarantine (same rule as lib/emailer.js warehouse loop).
// Ready first so in-stock lands in Kaitlyn's inbox first and the backorder
// email is clearly distinguished from it.
const BUCKET_ORDER = ['ready', 'backorder', 'sechelt'];

async function sendAllBucketsForVendor({ draft, vendor }) {
  const results = [];
  const pending = BUCKET_ORDER.filter((b) =>
    draft.lines.some((l) => l.vendor === vendor && !l.sentAt && l.availabilityBucket === b));
  for (let i = 0; i < pending.length; i++) {
    const bucket = pending[i];
    try {
      const r = await sendVendorGroup({ draft, vendor, bucket });
      results.push(r);
    } catch (e) {
      results.push({ sent: false, vendor, bucket, error: e.message });
    }
    if (i < pending.length - 1) await new Promise((r) => setTimeout(r, 60_000));
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

module.exports = { preview, sendVendorGroup, sendAllBucketsForVendor, archiveIfAllSent, renderBody, buildSubject, createSalesforceFbaPO, BUCKET_ORDER };
