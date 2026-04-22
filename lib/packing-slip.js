/**
 * Packing slip PDF generator using Puppeteer.
 * Renders an HTML template to PDF (Letter size).
 */

const puppeteer = require('puppeteer');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  return browser;
}

function buildHtml({ poNumber, soNumber, date, vendor, orderNumber, tracking, carrier, shipTo, items, packages }) {
  const shipToHtml = shipTo
    ? `<p><strong>${esc(shipTo.name || '')}</strong><br>
       ${esc(shipTo.street1 || '')}<br>
       ${shipTo.street2 ? esc(shipTo.street2) + '<br>' : ''}
       ${esc(shipTo.city || '')}, ${esc(shipTo.state || '')} ${esc(shipTo.postalCode || '')}</p>`
    : '<p>N/A</p>';

  // Multi-package: render a per-box breakdown so warehouse knows what goes
  // in which box. Fall back to the flat items table for single-package.
  const multi = Array.isArray(packages) && packages.length > 1;
  const itemsSection = multi
    ? packages.map((pkg, idx) => {
        const rows = (pkg.items || []).map((item) => `
          <tr>
            <td>${esc(item.sku || item.itemNumber || '')}</td>
            <td>${esc(item.name || item.description || '')}</td>
            <td style="text-align:center">${item.quantity || item.qty || 1}</td>
          </tr>`).join('');
        const pkgTracking = pkg.trackingNumber ? `<span style="font-family:monospace;font-size:11px;color:#555">${esc(pkg.trackingNumber)}</span>` : '';
        const shapeTag = pkg.shape ? `<span style="background:#eef;padding:1px 6px;border-radius:3px;font-size:10px;color:#334;margin-left:8px">${esc(pkg.shape)}</span>` : '';
        return `
          <div style="margin-top:18px;padding:10px 12px;border:1px solid #ccc;border-radius:4px;background:#fafafa">
            <div style="font-weight:700;margin-bottom:6px">
              Package ${idx + 1} of ${packages.length}${shapeTag}
              <div style="float:right;font-weight:400">${pkgTracking}</div>
            </div>
            <table style="width:100%;border-collapse:collapse;margin:0">
              <thead>
                <tr><th style="padding:4px 8px;font-size:11px;background:#e8e8ef">SKU</th><th style="padding:4px 8px;font-size:11px;background:#e8e8ef;text-align:left">Description</th><th style="padding:4px 8px;font-size:11px;background:#e8e8ef;text-align:center">Qty</th></tr>
              </thead>
              <tbody>${rows || '<tr><td colspan="3" style="padding:6px 8px;color:#888">(empty)</td></tr>'}</tbody>
            </table>
          </div>`;
      }).join('')
    : null;

  const itemRows = (items || []).map((item, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(item.sku || item.itemNumber || '')}</td>
      <td>${esc(item.name || item.description || '')}</td>
      <td style="text-align:center">${item.quantity || item.qty || 1}</td>
      <td style="text-align:right">${item.unitPrice ? '$' + Number(item.unitPrice).toFixed(2) : ''}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #222; margin: 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 16px; }
  .header-left h1 { color: #1a1a2e; }
  .header-right { text-align: right; font-size: 11px; color: #666; }
  .meta { display: flex; gap: 40px; margin-bottom: 20px; }
  .meta-block { }
  .meta-block h3 { font-size: 11px; text-transform: uppercase; color: #888; margin: 0 0 4px; }
  .meta-block p { margin: 0; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { background: #f0f0f0; text-align: left; padding: 6px 8px; font-size: 11px; text-transform: uppercase; color: #555; border-bottom: 2px solid #ccc; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 10px; color: #999; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Packing Slip</h1>
      <div style="font-size:14px;font-weight:bold;color:#333">${esc(poNumber || '')}</div>
    </div>
    <div class="header-right">
      <strong>YourFloors.ca</strong><br>
      Custom Flooring Centres<br>
      ${esc(date || '')}
    </div>
  </div>

  <div class="meta">
    <div class="meta-block">
      <h3>Ship To</h3>
      ${shipToHtml}
    </div>
    <div class="meta-block">
      <h3>Order Details</h3>
      <p><strong>Order:</strong> ${esc(orderNumber || '')}<br>
      ${soNumber ? `<strong>SO:</strong> ${esc(soNumber)}<br>` : ''}
      <strong>Carrier:</strong> ${esc(carrier || '')}<br>
      <strong>Tracking:</strong> ${esc(tracking || '')}<br>
      <strong>Vendor:</strong> ${esc(vendor || 'Prosol Inc.')}</p>
    </div>
  </div>

  ${multi ? `
  <div style="margin-top:8px;font-size:11px;color:#555">
    <strong>Multi-package shipment:</strong> ${packages.length} box${packages.length === 1 ? '' : 'es'} —
    pack each box exactly as listed below and affix its tracking label.
  </div>
  ${itemsSection}
  ` : `
  <table>
    <thead>
      <tr><th>#</th><th>SKU</th><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th></tr>
    </thead>
    <tbody>
      ${itemRows || '<tr><td colspan="5">No items</td></tr>'}
    </tbody>
  </table>`}

  <div class="footer">
    YourFloors.ca &mdash; Custom Flooring Centres
  </div>
</body>
</html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function generatePackingSlipPdf(data) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(buildHtml(data), { waitUntil: 'domcontentloaded' });
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    return pdf;
  } finally {
    await page.close();
  }
}

// ── FBA replenishment PO PDF ────────────────────────────────────────────────
//
// Style matches the existing CustomFC SF-exported PO PDFs (e.g. PO 14251).
// Intended use: attach to the vendor email so Kaitlyn/Robyn/Sechelt has a
// printable record of what we're requesting.

function buildFbaPoHtml({ poNumber, date, vendor, vendorAddress, vendorContact, shippingInstructions, notes, lines, netTotal }) {
  const lineRows = (lines || []).map((l) => `
    <tr>
      <td style="font-family:monospace;font-size:11px">${esc(l.vendorSku || '—')}</td>
      <td>${esc(l.product || '')}</td>
      <td style="text-align:right">${l.qty}</td>
      <td style="text-align:right">${l.unitCost != null ? '$' + Number(l.unitCost).toFixed(2) : ''}</td>
      <td style="text-align:right">${l.unitCost != null ? '$' + (Number(l.unitCost) * l.qty).toFixed(2) : ''}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html><head><style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color:#222; margin: 40px }
  .hdr { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1a1a2e; padding-bottom:14px; margin-bottom:18px }
  .hdr h1 { margin:0; font-size:22px; color:#1a1a2e }
  .hdr .co-small { font-size:11px; color:#555; line-height:1.5 }
  .po-id { text-align:right }
  .po-id .title { font-size:11px; letter-spacing:2px; color:#64748b; text-transform:uppercase; margin-bottom:4px }
  .po-id .num { font-size:22px; font-weight:700; color:#1a1a2e }
  .po-id .meta { font-size:11px; color:#64748b; margin-top:4px }
  .addr-row { display:flex; gap:40px; margin-bottom:16px }
  .addr-row .box { flex:1 }
  .addr-row .label { font-size:10px; letter-spacing:1px; color:#64748b; text-transform:uppercase; margin-bottom:4px }
  .addr-row .body { font-size:12px; line-height:1.6 }
  table { width:100%; border-collapse:collapse; margin:12px 0 }
  th { background:#1a1a2e; color:#fff; text-align:left; padding:8px; font-size:11px; letter-spacing:1px; text-transform:uppercase }
  td { padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px; vertical-align:top }
  .ship-inst { background:#f8fafc; border-left:3px solid #1a1a2e; padding:8px 12px; margin:12px 0; font-size:11px }
  .totals { margin-top:16px; width:260px; margin-left:auto }
  .totals tr td { border:0; padding:4px 8px; font-size:12px }
  .totals tr td.label { text-align:right; color:#64748b; text-transform:uppercase; font-size:10px; letter-spacing:1px }
  .totals tr td.val { text-align:right; font-weight:600 }
  .totals tr.total td { border-top:2px solid #1a1a2e; padding-top:8px; font-size:14px; font-weight:700 }
  .footer { margin-top:24px; padding-top:12px; border-top:1px solid #e5e7eb; font-size:10px; color:#94a3b8 }
</style></head><body>
  <div class="hdr">
    <div>
      <h1>CustomFlooring Centres</h1>
      <div class="co-small">
        Box 166, Sechelt, BC V0N 3A0<br>
        604-885-3582 · mac@customfc.ca<br>
        GST/HST 105287064
      </div>
    </div>
    <div class="po-id">
      <div class="title">Purchase Order</div>
      <div class="num">${esc(poNumber || 'DRAFT')}</div>
      <div class="meta">Date: ${esc(date)}</div>
    </div>
  </div>

  <div class="addr-row">
    <div class="box">
      <div class="label">Vendor</div>
      <div class="body">
        <strong>${esc(vendor || '')}</strong><br>
        ${vendorAddress ? esc(vendorAddress).replace(/\n/g, '<br>') : ''}<br>
        ${vendorContact ? esc(vendorContact) : ''}
      </div>
    </div>
    <div class="box">
      <div class="label">Ship To / Notes</div>
      <div class="body">${esc(shippingInstructions || 'Replenishment order — courier will pick up once confirmed.').replace(/\n/g, '<br>')}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:120px">SKU</th>
        <th>Product</th>
        <th style="width:60px;text-align:right">Qty</th>
        <th style="width:80px;text-align:right">Unit</th>
        <th style="width:90px;text-align:right">Line Total</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  ${notes ? `<div class="ship-inst">${esc(notes).replace(/\n/g, '<br>')}</div>` : ''}

  <table class="totals">
    <tr><td class="label">Net Order</td><td class="val">${netTotal != null ? '$' + Number(netTotal).toFixed(2) : '—'}</td></tr>
    <tr class="total"><td class="label">Order Total</td><td class="val">${netTotal != null ? '$' + Number(netTotal).toFixed(2) : '—'}</td></tr>
  </table>

  <div class="footer">
    Generated ${new Date().toISOString()} · Please quote PO ${esc(poNumber || 'DRAFT')} on all correspondence, invoices, shipping papers, and packages.
  </div>
</body></html>`;
}

async function generateFbaPoPdf(data) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(buildFbaPoHtml(data), { waitUntil: 'domcontentloaded' });
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    return pdf;
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browser && browser.connected) await browser.close();
  browser = null;
}

module.exports = { generatePackingSlipPdf, generateFbaPoPdf, closeBrowser };
