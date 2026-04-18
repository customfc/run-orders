#!/usr/bin/env node
/**
 * Shopify orders ETL — GraphQL Admin API → analytics.sqlite.
 *
 * Pulls orders with line items, refunds, and transactions (for Shopify
 * Payments / Stripe fees). Cursor-based pagination, respects Shopify's
 * query-cost throttling via sleep between pages.
 *
 * Modes:
 *   --backfill           — pull ALL orders (createdAtMin = 2000-01-01)
 *   --since <ISO>        — updated_at ≥ ISO
 *   (default)            — uses etl_sync_state['shopify'].cursor (updated_at)
 */

require('dotenv').config();
const { graphql } = require('../../lib/shopify-graphql');
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

const ORDERS_QUERY = `
  query orders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          updatedAt
          processedAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          sourceName
          currencyCode
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
          currentTotalTaxSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          currentTotalDiscountsSet { shopMoney { amount currencyCode } }
          customer { email }
          shippingAddress { city provinceCode zip countryCode }
          lineItems(first: 50) {
            edges {
              node {
                id
                sku
                title
                quantity
                variant { id product { id } }
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                totalDiscountSet { shopMoney { amount currencyCode } }
              }
            }
          }
          refunds {
            id
            createdAt
            totalRefundedSet { shopMoney { amount currencyCode } }
            note
          }
          transactions {
            id
            kind
            status
            processedAt
            gateway
            amountSet { shopMoney { amount currencyCode } }
            fees { amount { amount currencyCode } }
          }
        }
      }
    }
  }
`;

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null ? null : String(v); }
function moneyAmt(m) { return m?.shopMoney?.amount != null ? num(m.shopMoney.amount) : null; }
function idFromGID(gid) { return gid ? String(gid).split('/').pop() : null; }

function upsertOrder(db, o) {
  const addr = o.shippingAddress || {};
  const orderId = idFromGID(o.id);
  db.prepare(`
    INSERT INTO shopify_orders (
      shopify_order_id, order_name, created_at, updated_at, processed_at, cancelled_at,
      financial_status, fulfillment_status, currency,
      total_price, subtotal_price, total_tax, total_shipping, total_discount,
      source_name, customer_email, ship_city, ship_state, ship_postal, ship_country,
      raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shopify_order_id) DO UPDATE SET
      order_name = excluded.order_name,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      processed_at = excluded.processed_at,
      cancelled_at = excluded.cancelled_at,
      financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status,
      currency = excluded.currency,
      total_price = excluded.total_price,
      subtotal_price = excluded.subtotal_price,
      total_tax = excluded.total_tax,
      total_shipping = excluded.total_shipping,
      total_discount = excluded.total_discount,
      source_name = excluded.source_name,
      customer_email = excluded.customer_email,
      ship_city = excluded.ship_city,
      ship_state = excluded.ship_state,
      ship_postal = excluded.ship_postal,
      ship_country = excluded.ship_country,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `).run(
    orderId,
    str(o.name),
    str(o.createdAt),
    str(o.updatedAt),
    str(o.processedAt),
    str(o.cancelledAt),
    str(o.displayFinancialStatus),
    str(o.displayFulfillmentStatus),
    str(o.currencyCode),
    moneyAmt(o.currentTotalPriceSet),
    moneyAmt(o.currentSubtotalPriceSet),
    moneyAmt(o.currentTotalTaxSet),
    moneyAmt(o.totalShippingPriceSet),
    moneyAmt(o.currentTotalDiscountsSet),
    str(o.sourceName),
    str(o.customer?.email),
    str(addr.city),
    str(addr.provinceCode),
    str(addr.zip),
    str(addr.countryCode),
    JSON.stringify(o),
    new Date().toISOString(),
  );
  return orderId;
}

function upsertLines(db, orderId, lineEdges) {
  const ins = db.prepare(`
    INSERT INTO shopify_order_lines (
      line_id, shopify_order_id, variant_id, product_id, sku, title, qty, price, total_discount, raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(line_id) DO UPDATE SET
      shopify_order_id = excluded.shopify_order_id,
      variant_id = excluded.variant_id,
      product_id = excluded.product_id,
      sku = excluded.sku,
      title = excluded.title,
      qty = excluded.qty,
      price = excluded.price,
      total_discount = excluded.total_discount,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `);
  for (const { node } of lineEdges || []) {
    ins.run(
      idFromGID(node.id),
      orderId,
      idFromGID(node.variant?.id),
      idFromGID(node.variant?.product?.id),
      str(node.sku),
      str(node.title),
      num(node.quantity),
      moneyAmt(node.originalUnitPriceSet),
      moneyAmt(node.totalDiscountSet),
      JSON.stringify(node),
      new Date().toISOString(),
    );
  }
}

function upsertRefunds(db, orderId, refunds) {
  const ins = db.prepare(`
    INSERT INTO shopify_refunds (
      refund_id, shopify_order_id, created_at, amount, currency, reason, raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(refund_id) DO UPDATE SET
      shopify_order_id = excluded.shopify_order_id,
      created_at = excluded.created_at,
      amount = excluded.amount,
      currency = excluded.currency,
      reason = excluded.reason,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `);
  for (const r of refunds || []) {
    ins.run(
      idFromGID(r.id),
      orderId,
      str(r.createdAt),
      moneyAmt(r.totalRefundedSet),
      str(r.totalRefundedSet?.shopMoney?.currencyCode),
      str(r.note),
      JSON.stringify(r),
      new Date().toISOString(),
    );
  }
}

function upsertFees(db, orderId, transactions) {
  const ins = db.prepare(`
    INSERT INTO shopify_order_fees (
      transaction_id, shopify_order_id, kind, processed_at, amount, fee_amount, currency, gateway, raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      shopify_order_id = excluded.shopify_order_id,
      kind = excluded.kind,
      processed_at = excluded.processed_at,
      amount = excluded.amount,
      fee_amount = excluded.fee_amount,
      currency = excluded.currency,
      gateway = excluded.gateway,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `);
  for (const t of transactions || []) {
    if (t.status !== 'SUCCESS') continue;
    const feeSum = (t.fees || []).reduce((s, f) => s + (num(f.amount?.amount) || 0), 0);
    const currency = t.amountSet?.shopMoney?.currencyCode || null;
    ins.run(
      idFromGID(t.id),
      orderId,
      str(t.kind),
      str(t.processedAt),
      moneyAmt(t.amountSet),
      feeSum,
      currency,
      str(t.gateway),
      JSON.stringify(t),
      new Date().toISOString(),
    );
  }
}

async function main() {
  const args = parseArgs();

  let queryStr;
  let mode;
  if (args.backfill) {
    queryStr = 'created_at:>=2000-01-01';
    mode = 'backfill';
  } else if (args.since) {
    queryStr = `updated_at:>=${args.since}`;
    mode = `since ${args.since}`;
  } else {
    const state = getSyncState('shopify');
    if (state?.cursor) {
      queryStr = `updated_at:>=${state.cursor}`;
      mode = `delta since ${state.cursor}`;
    } else {
      queryStr = 'created_at:>=2000-01-01';
      mode = 'first-run backfill';
    }
  }

  console.log(`[shopify] mode: ${mode}`);
  const db = open();

  let cursor = null;
  let orderCount = 0;
  let maxUpdatedAt = args.since || null;

  try {
    while (true) {
      const resp = await graphql(ORDERS_QUERY, { first: 50, after: cursor, query: queryStr });
      const edges = resp.data?.orders?.edges || [];
      const pageInfo = resp.data?.orders?.pageInfo;

      tx(() => {
        for (const { node } of edges) {
          const orderId = upsertOrder(db, node);
          upsertLines(db, orderId, node.lineItems?.edges);
          upsertRefunds(db, orderId, node.refunds);
          upsertFees(db, orderId, node.transactions);
          orderCount++;
          if (node.updatedAt && (!maxUpdatedAt || node.updatedAt > maxUpdatedAt)) {
            maxUpdatedAt = node.updatedAt;
          }
        }
      });
      console.log(`[shopify] page: ${edges.length} orders (total so far: ${orderCount})`);

      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      // Respect Shopify's query cost throttling
      await new Promise((r) => setTimeout(r, 1000));
    }

    setSyncState('shopify', {
      cursor: maxUpdatedAt || new Date().toISOString(),
      rowsLastRun: orderCount,
      status: 'ok',
    });
    console.log(`[shopify] ✓ ${orderCount} orders. cursor=${maxUpdatedAt}`);
  } catch (e) {
    setSyncState('shopify', { cursor: maxUpdatedAt, rowsLastRun: orderCount, status: 'error', errorMessage: e.message.slice(0, 500) });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[shopify] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
