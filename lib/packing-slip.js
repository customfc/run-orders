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

function buildHtml({ poNumber, date, vendor, orderNumber, tracking, carrier, shipTo, items }) {
  const shipToHtml = shipTo
    ? `<p><strong>${esc(shipTo.name || '')}</strong><br>
       ${esc(shipTo.street1 || '')}<br>
       ${shipTo.street2 ? esc(shipTo.street2) + '<br>' : ''}
       ${esc(shipTo.city || '')}, ${esc(shipTo.state || '')} ${esc(shipTo.postalCode || '')}</p>`
    : '<p>N/A</p>';

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
      <strong>Carrier:</strong> ${esc(carrier || '')}<br>
      <strong>Tracking:</strong> ${esc(tracking || '')}<br>
      <strong>Vendor:</strong> ${esc(vendor || 'Prosol Inc.')}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>#</th><th>SKU</th><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th></tr>
    </thead>
    <tbody>
      ${itemRows || '<tr><td colspan="5">No items</td></tr>'}
    </tbody>
  </table>

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

module.exports = { generatePackingSlipPdf };
