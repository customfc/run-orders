#!/usr/bin/env node
/**
 * Render the latest financial report to PDF via Puppeteer and email it.
 *
 * Usage:
 *   node scripts/analytics/email-financial-report.js --to mac@customfc.ca
 *   node scripts/analytics/email-financial-report.js --to mac@customfc.ca --generate
 *
 * --generate runs generate-financial-report.js first, else uses the latest
 * file in public/financial-report-*.html.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { sendEmail } = require('../../lib/emailer');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (v !== undefined) { args[k.slice(2)] = v; continue; }
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k.slice(2)] = true;
      else { args[k.slice(2)] = next; i++; }
    }
  }
  return args;
}

async function renderPdf(htmlPath) {
  console.log(`[email-report] rendering ${htmlPath} to PDF...`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 60_000 });
    // Give Chart.js a moment to finish animation
    await new Promise((r) => setTimeout(r, 3000));
    const pdfBuffer = await page.pdf({
      format: 'A3',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
      preferCSSPageSize: false,
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs();
  const to = args.to || 'mac@customfc.ca';
  const cc = args.cc;

  if (args.generate) {
    console.log('[email-report] regenerating HTML first...');
    const { main: gen } = require('./generate-financial-report');
    await gen();
  }

  // Pick latest financial-report HTML
  const files = fs.readdirSync(PUBLIC_DIR)
    .filter((f) => /^financial-report-\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort();
  if (!files.length) {
    throw new Error('No financial-report-*.html found in public/. Run with --generate first.');
  }
  const latest = files[files.length - 1];
  const htmlPath = path.join(PUBLIC_DIR, latest);
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  console.log(`[email-report] latest: ${latest} (${(htmlContent.length / 1024).toFixed(0)}KB HTML)`);

  const pdfBuffer = await renderPdf(htmlPath);
  console.log(`[email-report] PDF: ${(pdfBuffer.length / 1024).toFixed(0)}KB`);

  const today = new Date().toISOString().slice(0, 10);
  const dashboardUrl = `http://freds-mac-mini.taila452b5.ts.net:3456/${latest}`;
  const subject = `Financial Report — ${today}`;
  const bodyHtml = `
    <div style="font-family:-apple-system,'Helvetica Neue',sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
      <h2 style="color:#0f172a;margin-bottom:8px">Financial Report — ${today}</h2>
      <p style="color:#64748b;margin-bottom:20px">Full P&amp;L, cashflow, PO spend, brand/SKU analysis, and ranked recommendations.</p>

      <p><strong>PDF attached.</strong> Also viewable interactively (with live charts) at:</p>
      <p><a href="${dashboardUrl}">${dashboardUrl}</a></p>

      <h3 style="margin-top:24px;color:#0f172a">What's inside (14 sections)</h3>
      <ol style="line-height:1.9">
        <li>Executive summary — T12m revenue vs $100K goal, cash position, growth gap</li>
        <li>24-month Amazon revenue trend + YoY comparison</li>
        <li>Channel mix (FBA AFN, MFN, Shopify)</li>
        <li>Fee structure — commission, FBA fees, service fees</li>
        <li>Brand P&amp;L (Schluter, Bona, Aquamix, Perfect Level)</li>
        <li>Top 15 revenue SKUs + dog list</li>
        <li>Full 18-month cashflow waterfall — every dollar in, every dollar out</li>
        <li>Vendor spend (your SF POs only, filtered out other CFC staff's orders)</li>
        <li>ShipStation label spend per month (MFN vs Shopify)</li>
        <li>Shopify channel detail</li>
        <li>Daily cashflow + settlement deposits</li>
        <li>Buy Box + Inventory health</li>
        <li>Catalog expansion opportunity (95 unlisted ASINs)</li>
        <li>Ranked recommendations + immediate next steps</li>
      </ol>

      <p style="color:#64748b;margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px">
        Generated from analytics.sqlite on Mac Mini. Data: 6,161 orders, 39,540 financial events,
        1,690 shipping labels, 381 Mac Roy PO lines, 11,668 item costs. Regenerate anytime:
        <code>node scripts/analytics/email-financial-report.js --generate --to ${to}</code>
      </p>
    </div>`;

  await sendEmail({
    to,
    cc,
    subject,
    html: bodyHtml,
    attachments: [
      {
        filename: `financial-report-${today}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
      {
        filename: `financial-report-${today}.html`,
        content: htmlContent,
        contentType: 'text/html',
      },
    ],
  });

  console.log(`\n✓ emailed to ${to}${cc ? ' (cc ' + cc + ')' : ''}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
}

module.exports = { main };
