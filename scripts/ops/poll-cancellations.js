/**
 * Buyer-cancellation guard — runs every 15 min.
 *
 * Checks Amazon for unshipped MFN orders where the buyer has requested
 * cancellation. For each new match (not yet alerted):
 *
 *   1. Look up the order in ShipStation.
 *   2. Ship-protect guard: if already shipped OR a label has been
 *      purchased (tracking number exists), DO NOT cancel — it's out the
 *      door. Alert Mac so he can handle the buyer side.
 *   3. Otherwise cancel the ShipStation order so it can't be batch-shipped.
 *   4. Telegram alert with the Seller-Central deep-link — closing the
 *      Amazon side (which triggers the refund) is still a manual click.
 *   5. Write cancel_alert_sent_at so the next 15-min poll doesn't re-fire.
 *
 * CLI:
 *   node scripts/ops/poll-cancellations.js            run it for real
 *   node scripts/ops/poll-cancellations.js --dry-run  print what would happen
 */

require('dotenv').config();

const sp = require('../../lib/sp-api');
const { findOrderByAmazonOrderId, cancelOrder } = require('../../lib/shipstation-v2');
const { notify } = require('../../lib/telegram');
const { open } = require('../../lib/analytics-db');

const MARKETPLACE = process.env.AMAZON_SP_MARKETPLACE_ID || 'A2EUQ1WTGCTBG2'; // Amazon.ca

function sellerCentralLink(orderId) {
  return `https://sellercentral.amazon.ca/orders-v3/order/${orderId}`;
}

async function listBuyerCancellationsFromApi({ lookbackMinutes = 60 * 24 * 7 } = {}) {
  // Cast a wider net than 20 min — buyer can request cancel on an older
  // order. Keep it ≤ 7 days to stay within the unshipped window.
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
  const matches = [];
  let nextToken;
  do {
    const page = await sp.listOrders({
      orderStatuses: 'Unshipped',
      lastUpdatedAfter: since,
      nextToken,
      marketplaceIds: MARKETPLACE,
    });
    const orders = page.payload?.Orders || [];
    for (const o of orders) {
      if (o.FulfillmentChannel !== 'MFN') continue;
      // Amazon returns the flag as a boolean literal, sometimes stringified
      const flagged = o.IsBuyerRequestedCancellation === true || o.IsBuyerRequestedCancellation === 'true';
      if (!flagged) continue;
      matches.push(o);
    }
    nextToken = page.payload?.NextToken;
  } while (nextToken);
  return matches;
}

function hasLabelForOrder(db, amazonOrderId) {
  const row = db.prepare(`
    SELECT 1
      FROM shipping_labels
     WHERE channel = 'amazon-mfn'
       AND order_number = ?
       AND tracking_number IS NOT NULL
     LIMIT 1
  `).get(amazonOrderId);
  return Boolean(row);
}

function alreadyAlerted(db, amazonOrderId) {
  const row = db.prepare(`
    SELECT cancel_alert_sent_at
      FROM amazon_orders
     WHERE amazon_order_id = ?
  `).get(amazonOrderId);
  return Boolean(row?.cancel_alert_sent_at);
}

function markAlerted(db, amazonOrderId) {
  db.prepare(`
    UPDATE amazon_orders
       SET is_buyer_requested_cancellation = 1,
           cancel_alert_sent_at = ?
     WHERE amazon_order_id = ?
  `).run(new Date().toISOString(), amazonOrderId);
}

async function handleOrder(db, order, { dryRun }) {
  const id = order.AmazonOrderId;
  const reason = order.CancelReason || order.BuyerRequestedCancelReason || '(reason not provided)';
  const summary = {
    order: id,
    reason,
    purchaseDate: order.PurchaseDate,
    shipByDate: order.LatestShipDate,
    total: `${order.OrderTotal?.Amount || '?'} ${order.OrderTotal?.CurrencyCode || ''}`.trim(),
  };

  if (alreadyAlerted(db, id)) {
    console.log(`[poll-cancel] ${id} already alerted, skip`);
    return { order: id, action: 'skip-already-alerted' };
  }

  // Ship-protect guard — DB-side (label table). API-side is done below via
  // the ShipStation lookup in case the label hasn't synced to our DB yet.
  const labeled = hasLabelForOrder(db, id);

  const ssOrder = await findOrderByAmazonOrderId(id).catch((e) => {
    console.error(`[poll-cancel] ShipStation lookup failed for ${id}:`, e.message);
    return null;
  });
  const ssStatus = (ssOrder?.orderStatus || '').toLowerCase();
  const alreadyShipped = labeled || ssStatus === 'shipped';

  let action;
  let ssResult = null;

  if (alreadyShipped) {
    action = 'alert-only-already-shipped';
  } else if (!ssOrder) {
    action = 'alert-only-not-in-shipstation';
  } else if (ssStatus === 'cancelled') {
    action = 'alert-only-already-cancelled';
  } else if (dryRun) {
    action = 'would-cancel';
  } else {
    try {
      ssResult = await cancelOrder(ssOrder.orderId);
      action = 'cancelled-in-shipstation';
    } catch (e) {
      console.error(`[poll-cancel] Cancel failed for ${id} (ssOrderId=${ssOrder.orderId}):`, e.message);
      action = 'alert-only-cancel-failed';
    }
  }

  const lines = [
    `Buyer requested cancellation — ${reason}`,
    `Amazon order: ${id}`,
    `Total: ${summary.total}`,
    `Ship-by: ${summary.shipByDate || '?'}`,
    ssOrder ? `ShipStation: ${ssOrder.orderNumber} (#${ssOrder.orderId}, ${ssStatus || '?'})` : 'ShipStation: not found',
    '',
    `Action taken: ${action}`,
    '',
    `Close in Seller Central to trigger the refund:`,
    sellerCentralLink(id),
  ];

  if (dryRun) {
    console.log('---');
    console.log(lines.join('\n'));
  } else {
    await notify('attn', `Buyer cancellation — ${id}`, lines.join('\n'));
    markAlerted(db, id);
  }

  return { order: id, action, ssOrderId: ssOrder?.orderId, ssStatus, alreadyShipped };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = open();

  let orders;
  try {
    orders = await listBuyerCancellationsFromApi();
  } catch (e) {
    console.error('[poll-cancel] listBuyerCancellationsFromApi failed:', e.message);
    if (!dryRun) await notify('debug', 'poll-cancellations error', e.message);
    return { error: e.message };
  }

  console.log(`[poll-cancel] ${orders.length} buyer-cancellation-flagged MFN order(s) returned by Amazon`);
  const results = [];
  for (const order of orders) {
    try {
      results.push(await handleOrder(db, order, { dryRun }));
    } catch (e) {
      console.error(`[poll-cancel] handleOrder(${order.AmazonOrderId}) threw:`, e.message);
      results.push({ order: order.AmazonOrderId, error: e.message });
    }
  }

  const summary = results.reduce((acc, r) => { acc[r.action || 'error'] = (acc[r.action || 'error'] || 0) + 1; return acc; }, {});
  console.log('[poll-cancel] summary:', JSON.stringify(summary));
  return { results, summary };
}

if (require.main === module) {
  main().then((r) => {
    if (r?.error) process.exit(1);
  }).catch((e) => {
    console.error('[poll-cancel] fatal:', e);
    process.exit(1);
  });
}

module.exports = { main };
