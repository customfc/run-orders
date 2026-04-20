#!/usr/bin/env node
/**
 * Amazon Orders ETL — SP-API /orders/v0 → analytics.sqlite.
 *
 * Modes:
 *   --backfill            — pull all orders CreatedAfter (730d - 7d buffer) for a cold start
 *   --since <ISO>         — pull LastUpdatedAfter <ISO> (daily delta)
 *   (default)             — uses etl_sync_state['amazon-orders'].cursor as LastUpdatedAfter
 *
 * Writes: amazon_orders, amazon_order_items. Idempotent upsert by natural key.
 *
 * Rate limits:
 *   /orders/v0/orders      — 0.0167 req/s sustained, burst 20
 *   /orders/.../orderItems — 0.5 req/s sustained, burst 30
 *
 * Pagination loop sleeps 60s between order pages and 2s between item calls
 * so a 730d backfill fits within the burst/sustained envelope.
 */

require('dotenv').config();
const sp = require('../../lib/sp-api');
const { open, setSyncState, getSyncState, tx } = require('../../lib/analytics-db');

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

function isoAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function str(v) { return v == null ? null : String(v); }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function bool(v) { return v === true || v === 'true' ? 1 : 0; }

function upsertOrder(db, order) {
  const addr = order.ShippingAddress || {};
  const total = order.OrderTotal || {};
  db.prepare(`
    INSERT INTO amazon_orders (
      amazon_order_id, purchase_date, last_update_date, order_status,
      fulfillment_channel, sales_channel, marketplace_id,
      order_total_amount, order_total_currency,
      number_of_items_shipped, number_of_items_unshipped,
      payment_method, is_business_order, is_prime, is_replacement,
      ship_city, ship_state, ship_postal, ship_country, buyer_email,
      is_buyer_requested_cancellation,
      raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(amazon_order_id) DO UPDATE SET
      purchase_date = excluded.purchase_date,
      last_update_date = excluded.last_update_date,
      order_status = excluded.order_status,
      fulfillment_channel = excluded.fulfillment_channel,
      sales_channel = excluded.sales_channel,
      marketplace_id = excluded.marketplace_id,
      order_total_amount = excluded.order_total_amount,
      order_total_currency = excluded.order_total_currency,
      number_of_items_shipped = excluded.number_of_items_shipped,
      number_of_items_unshipped = excluded.number_of_items_unshipped,
      payment_method = excluded.payment_method,
      is_business_order = excluded.is_business_order,
      is_prime = excluded.is_prime,
      is_replacement = excluded.is_replacement,
      ship_city = excluded.ship_city,
      ship_state = excluded.ship_state,
      ship_postal = excluded.ship_postal,
      ship_country = excluded.ship_country,
      buyer_email = excluded.buyer_email,
      is_buyer_requested_cancellation = excluded.is_buyer_requested_cancellation,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `).run(
    str(order.AmazonOrderId),
    str(order.PurchaseDate),
    str(order.LastUpdateDate),
    str(order.OrderStatus),
    str(order.FulfillmentChannel),
    str(order.SalesChannel),
    str(order.MarketplaceId),
    num(total.Amount),
    str(total.CurrencyCode),
    num(order.NumberOfItemsShipped),
    num(order.NumberOfItemsUnshipped),
    str(order.PaymentMethod),
    bool(order.IsBusinessOrder),
    bool(order.IsPrime),
    bool(order.IsReplacementOrder),
    str(addr.City),
    str(addr.StateOrRegion),
    str(addr.PostalCode),
    str(addr.CountryCode),
    str(order.BuyerInfo?.BuyerEmail),
    bool(order.IsBuyerRequestedCancellation),
    JSON.stringify(order),
    new Date().toISOString(),
  );
}

function upsertOrderItem(db, amazonOrderId, item) {
  const ip = item.ItemPrice || {};
  const sp_ = item.ShippingPrice || {};
  const it = item.ItemTax || {};
  const pd = item.PromotionDiscount || {};
  db.prepare(`
    INSERT INTO amazon_order_items (
      order_item_id, amazon_order_id, asin, seller_sku, title,
      qty_ordered, qty_shipped,
      item_price_amount, item_price_currency,
      shipping_price_amount, item_tax_amount, promotion_discount_amount,
      raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_item_id) DO UPDATE SET
      amazon_order_id = excluded.amazon_order_id,
      asin = excluded.asin,
      seller_sku = excluded.seller_sku,
      title = excluded.title,
      qty_ordered = excluded.qty_ordered,
      qty_shipped = excluded.qty_shipped,
      item_price_amount = excluded.item_price_amount,
      item_price_currency = excluded.item_price_currency,
      shipping_price_amount = excluded.shipping_price_amount,
      item_tax_amount = excluded.item_tax_amount,
      promotion_discount_amount = excluded.promotion_discount_amount,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `).run(
    str(item.OrderItemId),
    str(amazonOrderId),
    str(item.ASIN),
    str(item.SellerSKU),
    str(item.Title),
    num(item.QuantityOrdered),
    num(item.QuantityShipped),
    num(ip.Amount),
    str(ip.CurrencyCode),
    num(sp_.Amount),
    num(it.Amount),
    num(pd.Amount),
    JSON.stringify(item),
    new Date().toISOString(),
  );
}

// OrderItems: 0.5 req/s sustained, burst 30. Sleep 2.1s after EVERY call
// (not just between pagination) to stay comfortably under the sustained
// rate. Retries once on 429 with a 30s pause.
async function fetchAllItems(orderId) {
  const all = [];
  let nextToken = null;
  do {
    let data;
    try {
      data = await sp.getOrderItems(orderId, { nextToken });
    } catch (e) {
      if (e.status === 429) {
        await new Promise((r) => setTimeout(r, 30_000));
        data = await sp.getOrderItems(orderId, { nextToken });
      } else throw e;
    }
    all.push(...(data.payload?.OrderItems || []));
    nextToken = data.payload?.NextToken || null;
    await new Promise((r) => setTimeout(r, 2100));
  } while (nextToken);
  return all;
}

// Retry pass: find already-ingested orders that have zero line items but
// NumberOfItemsShipped > 0 in the order payload. Re-fetch items only.
async function retryMissingItems() {
  const db = open();
  const rows = db.prepare(`
    SELECT o.amazon_order_id, o.number_of_items_shipped, o.number_of_items_unshipped
    FROM amazon_orders o
    LEFT JOIN amazon_order_items i ON i.amazon_order_id = o.amazon_order_id
    WHERE i.order_item_id IS NULL
      AND ((o.number_of_items_shipped IS NOT NULL AND o.number_of_items_shipped > 0)
           OR (o.number_of_items_unshipped IS NOT NULL AND o.number_of_items_unshipped > 0))
    ORDER BY o.purchase_date DESC
  `).all();
  console.log(`[amazon-orders] retry: ${rows.length} orders with missing items`);
  let fetched = 0;
  for (const r of rows) {
    try {
      const items = await fetchAllItems(r.amazon_order_id);
      if (items.length) {
        tx(() => { for (const it of items) upsertOrderItem(db, r.amazon_order_id, it); });
        fetched += items.length;
      }
    } catch (e) {
      console.warn(`[amazon-orders] retry ${r.amazon_order_id}: ${e.message}`);
    }
  }
  console.log(`[amazon-orders] retry ✓ ${fetched} items across ${rows.length} order(s)`);
}

async function main() {
  const args = parseArgs();
  if (args['retry-missing-items']) {
    return retryMissingItems();
  }

  let createdAfter = null;
  let lastUpdatedAfter = null;
  let mode = 'delta';

  if (args.backfill) {
    // 723 days to leave a 7-day buffer from Amazon's 730-day retention edge
    createdAfter = isoAgo(723);
    mode = 'backfill';
  } else if (args.since) {
    lastUpdatedAfter = args.since;
    mode = `since ${args.since}`;
  } else {
    const state = getSyncState('amazon-orders');
    if (state?.cursor) {
      lastUpdatedAfter = state.cursor;
      mode = `delta since ${state.cursor}`;
    } else {
      // First-ever run with no flag → treat as backfill to be safe
      createdAfter = isoAgo(723);
      mode = 'first-run backfill';
    }
  }

  console.log(`[amazon-orders] mode: ${mode}`);
  const db = open();

  let pageCount = 0;
  let orderCount = 0;
  let itemCount = 0;
  let maxLastUpdate = lastUpdatedAfter || createdAfter;
  const startedAt = new Date().toISOString();

  try {
    for await (const orders of sp.iterateOrders({
      createdAfter,
      lastUpdatedAfter,
      pageSleepMs: 61_000, // 60s + buffer for Orders sustained limit
      maxResultsPerPage: 100,
    })) {
      pageCount++;
      console.log(`[amazon-orders] page ${pageCount}: ${orders.length} order(s)`);

      for (const order of orders) {
        if (!order.AmazonOrderId) continue;
        // Upsert order header first (FK requirement)
        tx(() => upsertOrder(db, order));
        orderCount++;
        if (order.LastUpdateDate && order.LastUpdateDate > maxLastUpdate) {
          maxLastUpdate = order.LastUpdateDate;
        }

        // Fetch items — one API call per order
        try {
          const items = await fetchAllItems(order.AmazonOrderId);
          if (items.length) {
            tx(() => { for (const it of items) upsertOrderItem(db, order.AmazonOrderId, it); });
            itemCount += items.length;
          }
        } catch (e) {
          console.warn(`[amazon-orders] items for ${order.AmazonOrderId} failed: ${e.message}`);
        }
      }

      // Periodic checkpoint — if backfill takes hours and dies, we resume from here
      setSyncState('amazon-orders', {
        cursor: maxLastUpdate,
        rowsLastRun: orderCount,
        status: 'ok',
      });
    }

    setSyncState('amazon-orders', {
      cursor: maxLastUpdate,
      rowsLastRun: orderCount,
      status: 'ok',
    });
    console.log(`[amazon-orders] ✓ ${orderCount} orders, ${itemCount} items across ${pageCount} page(s)`);
    console.log(`[amazon-orders] started ${startedAt} → cursor ${maxLastUpdate}`);
  } catch (e) {
    setSyncState('amazon-orders', {
      cursor: maxLastUpdate,
      rowsLastRun: orderCount,
      status: 'error',
      errorMessage: e.message.slice(0, 500),
    });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[amazon-orders] ERROR:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
