#!/usr/bin/env node
/**
 * Issue a full or partial refund on an Amazon MFN order.
 *
 * SP-API has no direct refund endpoint for seller-fulfilled orders. The
 * supported route is a POST_PAYMENT_ADJUSTMENT_DATA feed: create a feed
 * document, PUT the XML to the presigned URL, submit the feed, poll it.
 *
 * Refunds are irreversible. This therefore:
 *   - refuses if the order already has refund events (never double-refund),
 *   - reads the real amounts from the order items rather than accepting a
 *     figure on the command line,
 *   - refunds Principal AND Tax, since principal-only silently short-pays the
 *     customer by the GST/PST,
 *   - is dry-run by default and prints the exact XML before anything is sent.
 *
 * Adjustment reasons: CouldNotShip (we never tendered it), CustomerReturn,
 * NoInventory, ShippingAddressUndeliverable, GeneralAdjustment, PricingError.
 *
 * Usage:
 *   node scripts/ops/issue-refund.js --order=702-5460059-3914617 --reason=CouldNotShip
 *   node scripts/ops/issue-refund.js --order=702-5460059-3914617 --reason=CouldNotShip --commit
 */

require('dotenv').config();
const https = require('https');
const sp = require('../../lib/sp-api');
const audit = require('../../lib/audit');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const ORDER = arg('order');
const REASON = arg('reason', 'GeneralAdjustment');
const COMMIT = process.argv.includes('--commit');
const SELLER = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!ORDER) { console.error('--order=<amazon order id> required'); process.exit(1); }

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function put(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const o = await sp.getOrder(ORDER);
  const order = o?.payload || o;
  console.log(`order   : ${ORDER}`);
  console.log(`status  : ${order?.OrderStatus}`);
  console.log(`total   : ${order?.OrderTotal?.Amount} ${order?.OrderTotal?.CurrencyCode}`);

  // Never double-refund.
  const fin = await sp.listFinancialEventsByOrder(ORDER);
  const refunds = ((fin?.payload || fin)?.FinancialEvents || {}).RefundEventList || [];
  if (refunds.length) {
    console.error(`\n⛔ ABORT: ${refunds.length} refund event(s) already on this order. Refusing to refund twice.`);
    process.exit(2);
  }
  console.log('refunds : none on record ✓');

  const it = await sp.getOrderItems(ORDER);
  const items = ((it?.payload || it)?.OrderItems) || [];
  if (!items.length) { console.error('no order items'); process.exit(1); }

  const currency = order?.OrderTotal?.CurrencyCode || 'CAD';
  let total = 0;
  const adjusted = items.map((i) => {
    const principal = Number(i.ItemPrice?.Amount || 0);
    const tax = Number(i.ItemTax?.Amount || 0);
    const ship = Number(i.ShippingPrice?.Amount || 0);
    const shipTax = Number(i.ShippingTax?.Amount || 0);
    total += principal + tax + ship + shipTax;
    return { code: i.OrderItemId, sku: i.SellerSKU, principal, tax, ship, shipTax };
  });

  console.log('\nrefunding:');
  for (const a of adjusted) {
    console.log(`  ${a.sku}  principal ${a.principal.toFixed(2)}  tax ${a.tax.toFixed(2)}${a.ship ? `  shipping ${a.ship.toFixed(2)}` : ''}`);
  }
  console.log(`  TOTAL ${total.toFixed(2)} ${currency}   reason: ${REASON}`);

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">',
    '  <Header><DocumentVersion>1.01</DocumentVersion>',
    `    <MerchantIdentifier>${esc(SELLER)}</MerchantIdentifier></Header>`,
    '  <MessageType>OrderAdjustment</MessageType>',
    '  <Message>',
    '    <MessageID>1</MessageID>',
    '    <OrderAdjustment>',
    `      <AmazonOrderID>${esc(ORDER)}</AmazonOrderID>`,
    ...adjusted.flatMap((a) => [
      '      <AdjustedItem>',
      `        <AmazonOrderItemCode>${esc(a.code)}</AmazonOrderItemCode>`,
      `        <AdjustmentReason>${esc(REASON)}</AdjustmentReason>`,
      '        <ItemPriceAdjustments>',
      `          <Component><Type>Principal</Type><Amount currency="${currency}">${a.principal.toFixed(2)}</Amount></Component>`,
      ...(a.tax ? [`          <Component><Type>Tax</Type><Amount currency="${currency}">${a.tax.toFixed(2)}</Amount></Component>`] : []),
      ...(a.ship ? [`          <Component><Type>Shipping</Type><Amount currency="${currency}">${a.ship.toFixed(2)}</Amount></Component>`] : []),
      ...(a.shipTax ? [`          <Component><Type>ShippingTax</Type><Amount currency="${currency}">${a.shipTax.toFixed(2)}</Amount></Component>`] : []),
      '        </ItemPriceAdjustments>',
      '      </AdjustedItem>',
    ]),
    '    </OrderAdjustment>',
    '  </Message>',
    '</AmazonEnvelope>',
  ].join('\n');

  console.log(`\n${'─'.repeat(60)}\n${body}\n${'─'.repeat(60)}`);
  if (!COMMIT) { console.log('\nDRY RUN — nothing submitted. Re-run with --commit to refund.'); return; }

  const CT = 'text/xml; charset=UTF-8';
  const doc = await sp.spApiRequest('POST', '/feeds/2021-06-30/documents', { body: { contentType: CT } });
  if (doc.status !== 201) { console.error('createFeedDocument failed', doc.status, String(doc.body).slice(0, 200)); process.exit(1); }
  const { feedDocumentId, url } = JSON.parse(doc.body);

  const up = await put(url, body, CT);
  if (up.status !== 200) { console.error('upload failed', up.status, String(up.body).slice(0, 200)); process.exit(1); }
  console.log('uploaded ✓');

  const created = await sp.spApiRequest('POST', '/feeds/2021-06-30/feeds', {
    body: { feedType: 'POST_PAYMENT_ADJUSTMENT_DATA', marketplaceIds: [(process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '')], inputFeedDocumentId: feedDocumentId },
  });
  if (created.status !== 202) { console.error('createFeed failed', created.status, String(created.body).slice(0, 300)); process.exit(1); }
  const { feedId } = JSON.parse(created.body);
  console.log(`feed submitted: ${feedId}`);
  audit.log({ action: 'amazon-refund-submitted', order: ORDER, amount: Number(total.toFixed(2)), currency, reason: REASON, feedId });

  for (let i = 0; i < 20; i++) {
    await sleep(15000);
    const f = await sp.spApiRequest('GET', `/feeds/2021-06-30/feeds/${feedId}`);
    const j = JSON.parse(f.body);
    console.log(`  ${j.processingStatus}`);
    if (['DONE', 'FATAL', 'CANCELLED'].includes(j.processingStatus)) {
      if (j.resultFeedDocumentId) {
        const rd = await sp.spApiRequest('GET', `/feeds/2021-06-30/documents/${j.resultFeedDocumentId}`);
        const { url: rurl } = JSON.parse(rd.body);
        const txt = await new Promise((res) => https.get(rurl, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }));
        console.log('\nfeed result:\n' + String(txt).slice(0, 1200));
      }
      break;
    }
  }
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
