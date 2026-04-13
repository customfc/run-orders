/**
 * Email sender — sends warehouse order emails to Kaitlyn at Prosol.
 * Uses nodemailer with Office 365 SMTP.
 *
 * Rules:
 * - One email per warehouse (all orders from that warehouse grouped)
 * - 60 seconds between emails (got quarantined March 20 from rapid-fire)
 * - Subject: "Order - {Warehouse}"
 * - To: klazzarotto@prosol.ca, CC: mac@customfc.ca
 * - From: Mac Roy <hello@yourfloors.ca>
 */

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

const SMTP_USER = 'hello@yourfloors.ca';
const SMTP_PASS = process.env.SMTP_PASSWORD;
const TO_EMAIL = process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca';
const CC_EMAIL = process.env.MAC_CC_EMAIL || 'mac@customfc.ca';
const FROM_NAME = process.env.FROM_NAME || 'Mac Roy';

function createTransport() {
  if (!nodemailer) throw new Error('nodemailer is not installed. Run: npm install nodemailer');
  if (!SMTP_PASS) throw new Error('Missing SMTP_PASSWORD environment variable');

  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { ciphers: 'SSLv3' },
  });
}

async function sendWarehouseEmail({ warehouse, orders, attachments }) {
  const transport = createTransport();

  let bodyHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">`;
  bodyHtml += `<p>Hi Kaitlyn,</p>`;
  bodyHtml += `<p>Please find the following orders for <strong>${escHtml(warehouse)}</strong>:</p>`;

  for (const order of orders) {
    bodyHtml += `<div style="margin:12px 0;padding:12px;background:#f8f8f8;border-left:3px solid #1a1a2e">`;
    bodyHtml += `<strong>Amazon Order:</strong> ${escHtml(order.orderNumber)}<br>`;
    bodyHtml += `<strong>PO:</strong> ${escHtml(order.poNumber)}<br>`;
    bodyHtml += `<strong>Ship To:</strong> ${escHtml(order.shipTo)}<br>`;
    bodyHtml += `<strong>Carrier:</strong> ${escHtml(order.carrier)} — Tracking: ${escHtml(order.tracking)}`;
    bodyHtml += `</div>`;
  }

  bodyHtml += `<p>Please reply to confirm receipt.</p>`;
  bodyHtml += `<p>Thanks,<br>${escHtml(FROM_NAME)}</p>`;
  bodyHtml += `</div>`;

  await transport.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: TO_EMAIL,
    cc: CC_EMAIL,
    subject: `Order - ${warehouse}`,
    html: bodyHtml,
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: 'application/pdf',
    })),
  });

  transport.close();
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendWarehouseEmail };
