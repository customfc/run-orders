/**
 * Email sender — sends warehouse order emails.
 * Uses nodemailer with Office 365 SMTP.
 *
 * Default: Kaitlyn at Prosol (klazzarotto@prosol.ca). Callers can override
 * `to`, `cc`, `greeting`, `subject`, and `vendorName` to route to other
 * recipients (e.g. Sechelt → warehouse@customfc.ca).
 *
 * Rules:
 * - One email per warehouse (all orders from that warehouse grouped)
 * - 60 seconds between emails (got quarantined March 20 from rapid-fire)
 * - Default subject: "Order - {Warehouse}"
 * - Default To: klazzarotto@prosol.ca, CC: mac@customfc.ca
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

// What we disclose to Prosol as the destination. We self-ship: our own carrier
// label is attached and OUR carrier collects at the branch (carrier_pickup, NOT
// will-call — the customer is not picking it up). Prosol only stages the goods
// for our carrier; they never ship to, or need to see, the end customer.
// Sending the customer's out-of-province address also tripped Prosol's Tecsys
// VAT-region validation (Sales Order ship-to province must match the branch
// province). A carrier-pickup line keeps Prosol's records clean and our
// customer's data off their system entirely. The carrier + tracking still go in
// the email so the warehouse knows who is collecting; label->pick matching is by
// PO/order number, not customer name.
const PROSOL_CARRIER_PICKUP_LINE = 'CARRIER PICKUP: hold for our carrier to collect at your branch; label attached (do not ship to customer).';
function prosolCarrierPickupShipTo() {
  return { name: 'CARRIER PICKUP (we collect)', street1: 'Hold for our carrier to collect, label attached', city: '', state: '', postalCode: '' };
}

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

// `placedDirect` switches the email from "please enter this PO" (legacy: Prosol
// types our emailed order into Tecsys) to a HAND-OFF for orders we already
// placed ourselves on shop.prosol.ca. In direct mode the Prosol order number is
// the reference Prosol matches on, and the email's only job is to hand the
// warehouse the shipping labels for carrier pickup. Callers route CC to the
// fulfilling branch's order email (+ Mac) so the warehouse that picks it gets it.
async function sendWarehouseEmail({ warehouse, orders, attachments, to, cc, subject, greeting, placedDirect = false }) {
  const transport = createTransport();
  const toAddr = to || TO_EMAIL;
  const ccAddr = cc === null ? undefined : (cc || CC_EMAIL);
  const subj = subject || (placedDirect ? `Orders placed - ${warehouse} (labels attached)` : `Order - ${warehouse}`);
  const greet = greeting || 'Hi Kaitlyn,';

  let bodyHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">`;
  bodyHtml += `<p>${escHtml(greet)}</p>`;
  bodyHtml += placedDirect
    ? `<p>The following orders are placed in your system for <strong>${escHtml(warehouse)}</strong>. Shipping labels are attached. Please pick and hold each order for carrier pickup (we collect, do not ship to customer).</p>`
    : `<p>Please find the following orders for <strong>${escHtml(warehouse)}</strong>:</p>`;

  for (const order of orders) {
    bodyHtml += `<div style="margin:12px 0;padding:12px;background:#f8f8f8;border-left:3px solid #1a1a2e">`;
    if (order.prosolOrderNumber) bodyHtml += `<strong>Prosol Order:</strong> ${escHtml(order.prosolOrderNumber)}<br>`;
    bodyHtml += `<strong>PO:</strong> ${escHtml(order.poNumber)}<br>`;
    if (order.soNumber) bodyHtml += `<strong>SO:</strong> ${escHtml(order.soNumber)}<br>`;
    bodyHtml += `<strong>Ref:</strong> ${escHtml(order.orderNumber)}<br>`;
    bodyHtml += `<strong>Fulfillment:</strong> ${escHtml(order.shipTo)}<br>`;
    bodyHtml += `<strong>Carrier:</strong> ${escHtml(order.carrier)}, Tracking: ${escHtml(order.tracking)}`;
    bodyHtml += `</div>`;
  }

  bodyHtml += `<p>Please reply to confirm receipt.</p>`;
  bodyHtml += `<p>Thanks,<br>${escHtml(FROM_NAME)}</p>`;
  bodyHtml += `</div>`;

  await transport.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: toAddr,
    cc: ccAddr,
    subject: subj,
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

// Generic single-recipient email. Uses the same SMTP transport as the
// warehouse flow; intended for one-off operational emails (e.g. FBA inbound
// labels, internal notifications) that don't need the warehouse template.
async function sendEmail({ to, cc, subject, html, text, attachments, priority, headers }) {
  if (!to) throw new Error('to required');
  if (!subject) throw new Error('subject required');
  const transport = createTransport();
  try {
    const info = await transport.sendMail({
      from: `"${FROM_NAME}" <${SMTP_USER}>`,
      to,
      cc,
      subject,
      html,
      text,
      attachments: (attachments || []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/octet-stream',
      })),
      ...(priority ? { priority } : {}),       // 'high' => Importance/X-Priority headers
      ...(headers ? { headers } : {}),
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transport.close();
  }
}

module.exports = { sendWarehouseEmail, sendEmail, PROSOL_CARRIER_PICKUP_LINE, prosolCarrierPickupShipTo };
