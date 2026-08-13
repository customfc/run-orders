/**
 * Per-package Amazon fulfilment confirmation.
 *
 * THE PROBLEM
 * A multi-package order is confirmed to Amazon by /orders/markasshipped with a
 * single tracking number, because ShipStation V1's /shipments/createlabel makes
 * orphan shipments with no orderId (documented in lib/pipeline.js buyOneLabel).
 * The buyer therefore sees one tracking number for an order that shipped as two
 * or three boxes. On 701-4387228-0916238 that cost real money: three DITRA-PS
 * rolls were delivered 2026-08-03, Amazon showed one tracking, the delivery
 * estimate lapsed, and the buyer opened a return on $2,190 of membrane already
 * sitting in his garage.
 *
 * WHY IT CANNOT BE PATCHED AFTER THE FACT
 * markasshipped confirms the ENTIRE order. Checked on that order:
 * order_item_id 165711286583201, qty_ordered 3, qty_shipped 3 — one line item,
 * fully fulfilled under tracking #1. There is no unfulfilled remainder left to
 * hang a second tracking number on, so a follow-up feed has nothing to confirm.
 * The split has to happen at confirmation time, not afterwards.
 *
 * WHAT THIS DOES
 * Builds a POST_ORDER_FULFILLMENT_DATA feed with one OrderFulfillment message
 * per physical package, each carrying its own tracking number and its share of
 * the order items. That is Amazon's documented model for split shipments, and
 * it is the only way the buyer sees every box.
 *
 * SAFETY
 * Confirmation is not optional — an unconfirmed order past its ship-by date is
 * a late-shipment defect against account health. So the caller ALWAYS keeps
 * markasshipped as the fallback, and this is shadow by default:
 *   AMAZON_MULTI_TRACKING_LIVE=1  → submit the feed, fall back on failure
 *   unset                         → build the XML, log it, submit nothing
 * Mirrors AUTO_REBOOK_LIVE / ORPHAN_SWEEP_LIVE / BUYBOX_DEFENDER_LIVE.
 */

const sp = require('./sp-api');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const isLive = () => process.env.AMAZON_MULTI_TRACKING_LIVE === '1';

// ShipStation carrier codes → Amazon's accepted carrier names.
const CARRIER_NAMES = {
  purolator_walleted: 'Purolator',
  purolator: 'Purolator',
  canada_post_walleted: 'Canada Post',
  canada_post: 'Canada Post',
  ups_walleted: 'UPS',
  ups: 'UPS',
};

/**
 * Allocate order items across physical packages.
 *
 * Packages carry seller SKUs and quantities; Amazon wants AmazonOrderItemCode.
 * Where a package's SKU isn't in the order (a mapping drift), we refuse rather
 * than guess — a fulfilment message naming the wrong item is worse than the
 * single-tracking status quo it replaces.
 *
 * Returns { ok: true, messages } or { ok: false, reason }.
 */
function allocate({ packages, orderItems }) {
  if (!Array.isArray(packages) || packages.length < 2) {
    return { ok: false, reason: 'not a multi-package shipment' };
  }
  const bySku = new Map();
  for (const it of orderItems || []) {
    const sku = String(it.SellerSKU || it.seller_sku || it.sku || '').trim();
    if (!sku) continue;
    bySku.set(sku, {
      code: String(it.OrderItemId || it.order_item_id || it.orderItemId || ''),
      remaining: Number(it.QuantityOrdered ?? it.qty_ordered ?? it.quantity ?? 0),
    });
  }
  if (!bySku.size) return { ok: false, reason: 'no order items resolved' };

  const messages = [];
  for (const pkg of packages) {
    if (!pkg.trackingNumber) return { ok: false, reason: 'a package has no tracking number' };
    const items = [];
    for (const li of (pkg.items || [])) {
      const sku = String(li.sku || '').trim();
      const want = Number(li.quantity || 0);
      const rec = bySku.get(sku);
      if (!rec || !rec.code) return { ok: false, reason: `package SKU ${sku || '(blank)'} is not on the Amazon order` };
      const take = Math.min(want, rec.remaining);
      if (take <= 0) return { ok: false, reason: `no unallocated quantity left for ${sku}` };
      rec.remaining -= take;
      items.push({ code: rec.code, sku, quantity: take });
    }
    if (!items.length) return { ok: false, reason: 'a package has no items to allocate' };
    messages.push({ trackingNumber: pkg.trackingNumber, items });
  }
  // Every ordered unit must be accounted for, or Amazon is left holding a
  // partially-shipped order that nothing will ever complete.
  const unallocated = [...bySku.entries()].filter(([, r]) => r.remaining > 0);
  if (unallocated.length) {
    return { ok: false, reason: `unallocated units remain: ${unallocated.map(([s, r]) => `${s} x${r.remaining}`).join(', ')}` };
  }
  return { ok: true, messages };
}

function buildFeedXml({ sellerId, amazonOrderId, carrierCode, shipDate, messages }) {
  const carrier = CARRIER_NAMES[carrierCode] || carrierCode;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">',
    '  <Header><DocumentVersion>1.01</DocumentVersion>',
    `    <MerchantIdentifier>${esc(sellerId)}</MerchantIdentifier></Header>`,
    '  <MessageType>OrderFulfillment</MessageType>',
  ];
  messages.forEach((m, i) => {
    lines.push(
      '  <Message>',
      `    <MessageID>${i + 1}</MessageID>`,
      '    <OrderFulfillment>',
      `      <AmazonOrderID>${esc(amazonOrderId)}</AmazonOrderID>`,
      `      <FulfillmentDate>${esc(shipDate)}</FulfillmentDate>`,
      '      <FulfillmentData>',
      `        <CarrierName>${esc(carrier)}</CarrierName>`,
      `        <ShipperTrackingNumber>${esc(m.trackingNumber)}</ShipperTrackingNumber>`,
      '      </FulfillmentData>',
      ...m.items.flatMap((it) => [
        '      <Item>',
        `        <AmazonOrderItemCode>${esc(it.code)}</AmazonOrderItemCode>`,
        `        <Quantity>${it.quantity}</Quantity>`,
        '      </Item>',
      ]),
      '    </OrderFulfillment>',
      '  </Message>',
    );
  });
  lines.push('</AmazonEnvelope>');
  return lines.join('\n');
}

async function submitFeed(xml) {
  const CT = 'text/xml; charset=UTF-8';
  const doc = await sp.spApiRequest('POST', '/feeds/2021-06-30/documents', { body: { contentType: CT } });
  if (doc.status !== 201) throw new Error(`createFeedDocument ${doc.status}: ${String(doc.body).slice(0, 200)}`);
  const { feedDocumentId, url } = JSON.parse(doc.body);

  const put = await sp.putToUrl(url, xml, CT);
  if (put.status !== 200) throw new Error(`feed upload ${put.status}`);

  const created = await sp.spApiRequest('POST', '/feeds/2021-06-30/feeds', {
    body: {
      feedType: 'POST_ORDER_FULFILLMENT_DATA',
      marketplaceIds: [(process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '')],
      inputFeedDocumentId: feedDocumentId,
    },
  });
  if (created.status !== 202) throw new Error(`createFeed ${created.status}: ${String(created.body).slice(0, 300)}`);
  return JSON.parse(created.body).feedId;
}

/**
 * Confirm a multi-package order to Amazon, one message per box.
 *
 * NEVER throws — the caller must still fall back to markasshipped, and an
 * exception escaping here would leave an order unconfirmed, which is the one
 * outcome worse than a missing tracking number.
 *
 * Returns { attempted, live, submitted, feedId, xml, reason }.
 */
async function confirmPackages({ amazonOrderId, packages, orderItems, carrierCode, shipDate, sellerId }) {
  const out = { attempted: false, live: isLive(), submitted: false, feedId: null, xml: null, reason: null };
  try {
    const alloc = allocate({ packages, orderItems });
    if (!alloc.ok) { out.reason = alloc.reason; return out; }
    out.attempted = true;
    out.xml = buildFeedXml({
      sellerId: sellerId || process.env.AMAZON_SP_SELLER_ID,
      amazonOrderId,
      carrierCode,
      shipDate: shipDate || new Date().toISOString().slice(0, 10),
      messages: alloc.messages,
    });
    if (!isLive()) { out.reason = 'shadow — AMAZON_MULTI_TRACKING_LIVE not set'; return out; }
    out.feedId = await submitFeed(out.xml);
    out.submitted = true;
    return out;
  } catch (e) {
    out.reason = `feed failed: ${e.message}`;
    return out;
  }
}

module.exports = { confirmPackages, allocate, buildFeedXml, CARRIER_NAMES };
