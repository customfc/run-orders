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

const { VENDOR_META } = require('./fba-po-drafts');

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

function renderProsolBody(lines, draftId) {
  const today = new Date().toISOString().slice(0, 10);
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const hasBackorder = lines.some((l) => l.prosolStock?.decision?.action === 'backorder');
  const hasCapped = lines.some((l) => l.prosolStock?.decision?.action === 'capped');

  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi Kaitlyn,</p>`;
  html += `<p>Amazon FBA replenishment order — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units total</strong>. Please confirm stock + ship-date. Amazon inbound labels will follow once the inbound plan is created on our side.</p>`;

  if (hasBackorder) html += `<p style="color:#9a3412"><strong>Note:</strong> a few lines rely on stock at other Prosol warehouses — backorder/consolidation expected (~1wk).</p>`;
  if (hasCapped) html += `<p style="color:#9a3412"><strong>Note:</strong> some lines capped to total Prosol availability below Amazon's recommended qty.</p>`;

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

  html += `<p style="font-size:12px;color:#64748b">Draft ID: <code>${esc(draftId)}</code></p>`;
  html += `<p>Questions? Reply here or <a href="mailto:mac@customfc.ca">mac@customfc.ca</a>.</p>`;
  html += `<p>Thanks,<br>${esc(FROM_NAME)} · CustomFlooring Amazon</p>`;
  html += `</div>`;
  return html;
}

function renderTreecoBody(lines, draftId) {
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi Robyn (cc Brianna),</p>`;
  html += `<p>Amazon FBA replenishment order for Bona — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units</strong>. Please confirm stock + lead time from either warehouse (Delta / Calgary).</p>`;
  html += `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:12px 0;width:100%;max-width:720px">`;
  html += `<thead><tr style="background:#065f46;color:white"><th style="text-align:left">ASIN</th><th style="text-align:left">Product</th><th style="text-align:right">Qty</th></tr></thead><tbody>`;
  for (const l of lines) {
    html += `<tr style="border-bottom:1px solid #e5e7eb">`;
    html += `<td style="font-family:monospace">${esc(l.asin)}</td>`;
    html += `<td>${esc((l.product || '').slice(0, 80))}</td>`;
    html += `<td style="text-align:right;font-weight:600">${l.qty}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  html += `<p style="font-size:12px;color:#64748b">Draft ID: <code>${esc(draftId)}</code></p>`;
  html += `<p>Questions? Reply here or <a href="mailto:mac@customfc.ca">mac@customfc.ca</a>.</p>`;
  html += `<p>Thanks,<br>${esc(FROM_NAME)} · CustomFlooring Amazon</p>`;
  html += `</div>`;
  return html;
}

function renderSecheltBody(lines, draftId) {
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.5">`;
  html += `<p>Hi team,</p>`;
  html += `<p>Please pack and prep the following for Amazon FBA shipment — <strong>${lines.length} SKU${lines.length === 1 ? '' : 's'}, ${totalUnits} units</strong>. This is for self-fulfilled Perfect Level inventory from Sechelt stock.</p>`;
  html += `<p style="color:#b45309"><strong>Heads up:</strong> FBA box labels will follow from Amazon in a separate email once the inbound plan is created. Do not ship until labels arrive.</p>`;
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
  html += `<p style="font-size:12px;color:#64748b">Draft ID: <code>${esc(draftId)}</code></p>`;
  html += `<p>Thanks,<br>${esc(FROM_NAME)}</p>`;
  html += `</div>`;
  return html;
}

function renderBody(vendor, lines, draftId) {
  if (vendor === 'prosol') return renderProsolBody(lines, draftId);
  if (vendor === 'treeco') return renderTreecoBody(lines, draftId);
  if (vendor === 'perfectlevel') return renderSecheltBody(lines, draftId);
  throw new Error(`No email template for vendor '${vendor}'`);
}

function buildSubject(vendor, lines) {
  const today = new Date().toISOString().slice(0, 10);
  if (vendor === 'prosol') return `FBA Restock PO — ${today} — ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  if (vendor === 'treeco') return `Bona FBA Restock PO — ${today} — ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  if (vendor === 'perfectlevel') return `FBA Pack Request (Sechelt) — ${today} — ${lines.length} SKU${lines.length === 1 ? '' : 's'}`;
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

// ── Send a single vendor group ──────────────────────────────────────────────

async function sendVendorGroup({ draft, vendor }) {
  const meta = VENDOR_META[vendor];
  if (!meta) throw new Error(`Unknown vendor '${vendor}'`);
  if (!meta.email) throw new Error(`Vendor '${vendor}' has no email address configured`);

  const lines = draft.lines.filter((l) => l.vendor === vendor && !l.sentAt);
  if (!lines.length) throw new Error(`No unsent lines for vendor '${vendor}'`);

  const transport = createTransport();
  const subject = buildSubject(vendor, lines);
  const html = renderBody(vendor, lines, draft.draftId);

  try {
    await transport.sendMail({
      from: `"${FROM_NAME}" <${SMTP_USER}>`,
      to: meta.email,
      cc: (meta.cc && meta.cc.length) ? meta.cc : undefined,
      subject,
      html,
    });
  } finally {
    transport.close();
  }

  // Mark lines as sent
  const sentAt = new Date().toISOString();
  for (const line of lines) {
    line.sentAt = sentAt;
    line.sentTo = meta.email;
    line.sentCc = meta.cc || [];
  }

  return {
    sent: true,
    vendor,
    to: meta.email,
    cc: meta.cc || [],
    subject,
    lineCount: lines.length,
    totalUnits: lines.reduce((s, l) => s + l.qty, 0),
    sentAt,
  };
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

module.exports = { preview, sendVendorGroup, archiveIfAllSent, renderBody, buildSubject };
