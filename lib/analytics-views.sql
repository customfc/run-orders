-- Analytics DB views — Phase B.
--
-- Recomputed on every DB open (DROP + CREATE). Plain SQLite views are
-- query-time rollups, not materialized. At current volume (100s of
-- thousands of rows max) that's fast enough; can swap to TABLE-backed
-- caches with a refresh cron later if view queries get slow.
--
-- Source precedence:
--   * Amazon settlements are source-of-truth for fees within their window.
--     finances-api rows in the same window are DELETED at ingest time
--     (see sync-amazon-finances.js dedup cleanup), so v_amazon_fees can
--     simply SUM the whole amazon_financial_events table without
--     double-counting.
--   * Amazon orders + Shopify orders go through v_orders_unified for
--     cross-channel analytics where identity (Amazon vs Shopify) doesn't
--     matter (postal code heat, revenue, velocity). For channel-specific
--     slicing, query the raw tables.

DROP VIEW IF EXISTS v_orders_unified;
DROP VIEW IF EXISTS v_amazon_fees_by_order;
DROP VIEW IF EXISTS v_amazon_fees_by_sku_month;
DROP VIEW IF EXISTS v_shopify_fees_by_order;
DROP VIEW IF EXISTS v_money_daily;
DROP VIEW IF EXISTS v_postal_heat;
DROP VIEW IF EXISTS v_warehouse_split;
DROP VIEW IF EXISTS v_sku_monthly_pnl;
DROP VIEW IF EXISTS v_missed_opportunity;
DROP VIEW IF EXISTS v_returns;

-- ── Unified orders (Amazon + Shopify) ──────────────────────────────────────
-- Normalised column set so a dashboard doesn't care which channel an order
-- came from when answering "orders this month" / "shipping to V1L".

CREATE VIEW v_orders_unified AS
SELECT
  'amazon'                                  AS channel,
  amazon_order_id                           AS order_id,
  amazon_order_id                           AS order_name,
  purchase_date                             AS ordered_at,
  order_status                              AS status,
  fulfillment_channel                       AS fulfillment,
  sales_channel                             AS marketplace,
  order_total_amount                        AS order_total,
  order_total_currency                      AS currency,
  ship_city, ship_state, ship_postal, ship_country,
  buyer_email                               AS customer_email,
  is_prime, is_business_order               AS is_business,
  number_of_items_shipped                   AS items_shipped
FROM amazon_orders
UNION ALL
SELECT
  'shopify'                                 AS channel,
  shopify_order_id                          AS order_id,
  order_name,
  created_at                                AS ordered_at,
  financial_status                          AS status,
  CASE WHEN source_name = 'pos' THEN 'POS'
       WHEN fulfillment_status = 'fulfilled' THEN 'SELF'
       ELSE 'SELF' END                      AS fulfillment,
  source_name                               AS marketplace,
  total_price                               AS order_total,
  currency,
  ship_city, ship_state, ship_postal, ship_country,
  customer_email,
  0 AS is_prime, 0 AS is_business,
  NULL                                      AS items_shipped
FROM shopify_orders;

-- ── Amazon fees per order (all categories) ─────────────────────────────────
-- Positive = revenue/credit, Negative = fee/charge. Naive SUM because dedup
-- already removed overlap.

CREATE VIEW v_amazon_fees_by_order AS
SELECT
  amazon_order_id,
  MIN(posted_at)                                                 AS first_posted_at,
  SUM(CASE WHEN fee_type = 'ItemPrice:Principal'     THEN amount_cad ELSE 0 END) AS revenue_principal,
  SUM(CASE WHEN fee_type = 'ItemPrice:Shipping' OR fee_type = 'ItemPrice:ShippingCharge' THEN amount_cad ELSE 0 END) AS revenue_shipping,
  SUM(CASE WHEN fee_type LIKE 'ItemPrice:%Tax'       THEN amount_cad ELSE 0 END) AS revenue_tax,
  SUM(CASE WHEN fee_type = 'ItemFees:Commission'     THEN amount_cad ELSE 0 END) AS fee_commission,
  SUM(CASE WHEN fee_type = 'ItemFees:FBAPerUnitFulfillmentFee' THEN amount_cad ELSE 0 END) AS fee_fba_fulfillment,
  SUM(CASE WHEN fee_type LIKE 'ItemFees:%'           THEN amount_cad ELSE 0 END) AS fee_item_total,
  SUM(CASE WHEN fee_type LIKE 'ItemWithheldTax:%'    THEN amount_cad ELSE 0 END) AS tax_withheld,
  SUM(CASE WHEN fee_type LIKE 'Promotion:%'          THEN amount_cad ELSE 0 END) AS promotion_total,
  SUM(CASE WHEN transaction_type = 'Refund'          THEN amount_cad ELSE 0 END) AS refund_total,
  SUM(amount_cad)                                                                AS net_amount
FROM amazon_financial_events
WHERE amazon_order_id IS NOT NULL
GROUP BY amazon_order_id;

-- ── Amazon fees per SKU × month ────────────────────────────────────────────

CREATE VIEW v_amazon_fees_by_sku_month AS
SELECT
  seller_sku                                          AS sku,
  substr(posted_at, 1, 7)                             AS month,
  SUM(CASE WHEN fee_type = 'ItemPrice:Principal'     THEN amount_cad ELSE 0 END) AS revenue_principal,
  SUM(CASE WHEN fee_type = 'ItemFees:Commission'     THEN amount_cad ELSE 0 END) AS fee_commission,
  SUM(CASE WHEN fee_type LIKE 'ItemFees:%'           THEN amount_cad ELSE 0 END) AS fee_item_total,
  SUM(CASE WHEN transaction_type = 'Refund'          THEN amount_cad ELSE 0 END) AS refund_total,
  SUM(CASE WHEN fee_type LIKE 'Promotion:%'          THEN amount_cad ELSE 0 END) AS promotion_total,
  SUM(amount_cad)                                                                AS net_amount,
  COUNT(DISTINCT amazon_order_id)                                                AS order_count
FROM amazon_financial_events
WHERE seller_sku IS NOT NULL
GROUP BY seller_sku, substr(posted_at, 1, 7);

-- ── Shopify fees per order ─────────────────────────────────────────────────

CREATE VIEW v_shopify_fees_by_order AS
SELECT
  f.shopify_order_id,
  o.order_name,
  o.created_at,
  SUM(CASE WHEN f.kind = 'sale' OR f.kind = 'SALE' OR f.kind = 'CAPTURE' THEN f.amount ELSE 0 END) AS gross_amount,
  SUM(CASE WHEN f.kind = 'refund' OR f.kind = 'REFUND' THEN f.amount ELSE 0 END) AS refund_amount,
  SUM(f.fee_amount)                                                               AS processor_fee,
  MAX(f.gateway)                                                                  AS gateway
FROM shopify_order_fees f
LEFT JOIN shopify_orders o ON o.shopify_order_id = f.shopify_order_id
GROUP BY f.shopify_order_id;

-- ── Money daily (net cash view) ────────────────────────────────────────────
-- Amazon side: sum of financial events by posted day. Settled days only
-- (finances-api in unsettled days is an estimate — we include it so "last
-- week" doesn't look blank, but the cashflow-this-month tile should be
-- filtered to settlement-sourced rows only).

CREATE VIEW v_money_daily AS
SELECT
  substr(posted_at, 1, 10)          AS day,
  CASE WHEN settlement_id = 'finances-api' THEN 'estimate' ELSE 'settled' END AS source_tier,
  SUM(CASE WHEN fee_type LIKE 'ItemPrice:%'          THEN amount_cad ELSE 0 END) AS revenue,
  SUM(CASE WHEN fee_type LIKE 'ItemFees:%'           THEN amount_cad ELSE 0 END) AS amazon_fees,
  SUM(CASE WHEN fee_type LIKE 'Promotion:%'          THEN amount_cad ELSE 0 END) AS promotions,
  SUM(CASE WHEN transaction_type = 'Refund'          THEN amount_cad ELSE 0 END) AS refunds,
  SUM(CASE WHEN fee_type LIKE 'ServiceFee:%'         THEN amount_cad ELSE 0 END) AS service_fees,
  SUM(amount_cad)                                                                AS net_amount,
  COUNT(DISTINCT amazon_order_id)                                                AS unique_orders
FROM amazon_financial_events
WHERE posted_at IS NOT NULL
GROUP BY substr(posted_at, 1, 10),
         CASE WHEN settlement_id = 'finances-api' THEN 'estimate' ELSE 'settled' END;

-- ── Postal code heat map ──────────────────────────────────────────────────
-- Unified across Amazon + Shopify. For the heat-map UI the consumer can
-- filter by channel / date range.

CREATE VIEW v_postal_heat AS
SELECT
  channel,
  ship_postal,
  ship_state,
  ship_country,
  substr(ordered_at, 1, 10)                   AS day,
  COUNT(*)                                    AS order_count,
  SUM(order_total)                            AS revenue
FROM v_orders_unified
WHERE ship_postal IS NOT NULL AND ship_postal <> ''
GROUP BY channel, ship_postal, ship_state, ship_country, substr(ordered_at, 1, 10);

-- ── Warehouse / fulfillment split ─────────────────────────────────────────
-- Lifetime / 90d / 30d / 7d buckets per fulfillment channel.

CREATE VIEW v_warehouse_split AS
SELECT
  channel,
  fulfillment,
  COUNT(*)                                         AS orders_lifetime,
  SUM(CASE WHEN julianday('now') - julianday(ordered_at) <= 90 THEN 1 ELSE 0 END) AS orders_90d,
  SUM(CASE WHEN julianday('now') - julianday(ordered_at) <= 30 THEN 1 ELSE 0 END) AS orders_30d,
  SUM(CASE WHEN julianday('now') - julianday(ordered_at) <= 7  THEN 1 ELSE 0 END) AS orders_7d,
  SUM(order_total)                                 AS revenue_lifetime,
  SUM(CASE WHEN julianday('now') - julianday(ordered_at) <= 90 THEN order_total ELSE 0 END) AS revenue_90d,
  SUM(CASE WHEN julianday('now') - julianday(ordered_at) <= 30 THEN order_total ELSE 0 END) AS revenue_30d,
  SUM(CASE WHEN julianday('now') - julianday(ordered_at) <= 7  THEN order_total ELSE 0 END) AS revenue_7d
FROM v_orders_unified
GROUP BY channel, fulfillment;

-- ── SKU × month P&L (the dog-detector) ────────────────────────────────────
-- Amazon side: revenue + fees from amazon_financial_events
-- COGS: qty × cost_snapshot (or item_costs.cost_cad fallback if snapshot null)
-- Storage: per-SKU from inventory_daily (one row per day → average per month)
-- Freight: forward-only, from inbound_shipment_lines when we have data
-- Shopify side left for a future v2 (low volume right now)

CREATE VIEW v_sku_monthly_pnl AS
WITH amz AS (
  SELECT
    seller_sku          AS sku,
    substr(posted_at, 1, 7) AS month,
    SUM(CASE WHEN fee_type = 'ItemPrice:Principal' THEN amount_cad ELSE 0 END)      AS revenue_principal,
    SUM(CASE WHEN fee_type = 'ItemFees:Commission' THEN amount_cad ELSE 0 END)      AS fee_commission,
    SUM(CASE WHEN fee_type LIKE 'ItemFees:%' THEN amount_cad ELSE 0 END)            AS fee_total,
    SUM(CASE WHEN fee_type LIKE 'Promotion:%' THEN amount_cad ELSE 0 END)           AS promotion,
    SUM(CASE WHEN transaction_type = 'Refund' THEN amount_cad ELSE 0 END)           AS refund
  FROM amazon_financial_events
  WHERE seller_sku IS NOT NULL
  GROUP BY seller_sku, substr(posted_at, 1, 7)
),
items AS (
  SELECT
    seller_sku           AS sku,
    substr(o.purchase_date, 1, 7) AS month,
    SUM(i.qty_shipped)   AS qty_sold,
    SUM(i.qty_shipped * COALESCE(i.cost_snapshot, c.cost_cad, 0)) AS cogs
  FROM amazon_order_items i
  JOIN amazon_orders o ON o.amazon_order_id = i.amazon_order_id
  LEFT JOIN item_costs c ON c.sku = i.seller_sku
  WHERE i.seller_sku IS NOT NULL
  GROUP BY i.seller_sku, substr(o.purchase_date, 1, 7)
),
storage AS (
  SELECT
    sku,
    substr(snapshot_date, 1, 7) AS month,
    -- Pro-rate monthly estimate across days in the snapshot
    AVG(estimated_storage_cost_next_month) AS avg_storage_monthly
  FROM inventory_daily
  WHERE sku IS NOT NULL
  GROUP BY sku, substr(snapshot_date, 1, 7)
),
freight AS (
  SELECT
    l.sku,
    substr(s.arrived_at, 1, 7) AS month,
    SUM(l.allocated_cost_cad)  AS freight_cost
  FROM inbound_shipment_lines l
  JOIN inbound_shipments s ON s.shipment_id = l.shipment_id
  WHERE s.arrived_at IS NOT NULL
  GROUP BY l.sku, substr(s.arrived_at, 1, 7)
)
SELECT
  COALESCE(amz.sku, items.sku)                                AS sku,
  COALESCE(amz.month, items.month)                            AS month,
  COALESCE(amz.revenue_principal, 0)                          AS revenue,
  COALESCE(items.qty_sold, 0)                                 AS qty_sold,
  COALESCE(items.cogs, 0)                                     AS cogs,
  COALESCE(amz.fee_total, 0)                                  AS amazon_fees,
  COALESCE(amz.promotion, 0)                                  AS promotions,
  COALESCE(amz.refund, 0)                                     AS refunds,
  COALESCE(storage.avg_storage_monthly, 0)                    AS storage_cost,
  COALESCE(freight.freight_cost, 0)                           AS inbound_freight,
  -- Net margin = revenue - cogs + fees (fees are negative in DB) + refunds - storage - freight
  -- Note: fees, refunds are negative amounts in the DB so they add correctly
  COALESCE(amz.revenue_principal, 0)
    - COALESCE(items.cogs, 0)
    + COALESCE(amz.fee_total, 0)
    + COALESCE(amz.promotion, 0)
    + COALESCE(amz.refund, 0)
    - COALESCE(storage.avg_storage_monthly, 0)
    - COALESCE(freight.freight_cost, 0)                       AS net_profit,
  CASE WHEN COALESCE(amz.revenue_principal, 0) > 0
       THEN ROUND(
         (COALESCE(amz.revenue_principal, 0)
          - COALESCE(items.cogs, 0)
          + COALESCE(amz.fee_total, 0)
          + COALESCE(amz.promotion, 0)
          + COALESCE(amz.refund, 0)
          - COALESCE(storage.avg_storage_monthly, 0)
          - COALESCE(freight.freight_cost, 0)
         ) * 100.0 / amz.revenue_principal, 1)
       ELSE NULL END                                          AS net_margin_pct
FROM amz
LEFT JOIN items   ON items.sku = amz.sku AND items.month = amz.month
LEFT JOIN storage ON storage.sku = amz.sku AND storage.month = amz.month
LEFT JOIN freight ON freight.sku = amz.sku AND freight.month = amz.month;

-- ── Missed opportunity (BB loss + OOS) ─────────────────────────────────────
-- Per-SKU estimate of revenue lost to (a) buy-box losses with velocity, and
-- (b) out-of-stock periods. Forward-only — only meaningful once daily
-- snapshots have accrued a few weeks.

CREATE VIEW v_missed_opportunity AS
WITH bb_loss AS (
  SELECT
    b.sku,
    substr(b.snapshot_date, 1, 7) AS month,
    COUNT(*) AS days_bb_lost,
    AVG(b.bb_price) AS avg_bb_price
  FROM buybox_daily b
  WHERE b.tier = 'bb-losing'
  GROUP BY b.sku, substr(b.snapshot_date, 1, 7)
),
oos AS (
  SELECT
    i.sku,
    substr(i.snapshot_date, 1, 7) AS month,
    COUNT(*) AS days_oos,
    AVG(i.daily_velocity) AS avg_velocity
  FROM inventory_daily i
  WHERE i.tier = 'bleeding' OR (i.available = 0 AND i.units30 > 0)
  GROUP BY i.sku, substr(i.snapshot_date, 1, 7)
),
v AS (
  -- latest daily velocity per sku from inventory_daily (used for BB loss estimate)
  SELECT
    sku,
    substr(snapshot_date, 1, 7) AS month,
    AVG(daily_velocity) AS avg_velocity
  FROM inventory_daily
  WHERE sku IS NOT NULL
  GROUP BY sku, substr(snapshot_date, 1, 7)
)
SELECT
  COALESCE(bb_loss.sku, oos.sku)                           AS sku,
  COALESCE(bb_loss.month, oos.month)                       AS month,
  COALESCE(bb_loss.days_bb_lost, 0)                        AS days_bb_lost,
  COALESCE(oos.days_oos, 0)                                AS days_oos,
  COALESCE(v.avg_velocity, oos.avg_velocity, 0)            AS avg_velocity,
  COALESCE(bb_loss.avg_bb_price, 0)                        AS avg_bb_price,
  -- Rough estimate: (days_bb_lost + days_oos) × velocity × price
  ROUND(
    (COALESCE(bb_loss.days_bb_lost, 0) + COALESCE(oos.days_oos, 0))
    * COALESCE(v.avg_velocity, oos.avg_velocity, 0)
    * COALESCE(bb_loss.avg_bb_price, 0), 2
  ) AS estimated_missed_revenue
FROM bb_loss
FULL OUTER JOIN oos ON oos.sku = bb_loss.sku AND oos.month = bb_loss.month
LEFT JOIN v ON v.sku = COALESCE(bb_loss.sku, oos.sku) AND v.month = COALESCE(bb_loss.month, oos.month);

-- ── Returns (Amazon refund events + Shopify refunds) ──────────────────────

CREATE VIEW v_returns AS
SELECT
  'amazon' AS channel,
  amazon_order_id AS order_id,
  seller_sku      AS sku,
  substr(posted_at, 1, 10) AS day,
  -SUM(amount_cad) AS refund_amount,   -- stored negative, return positive here
  MAX(description) AS description
FROM amazon_financial_events
WHERE transaction_type = 'Refund' AND amazon_order_id IS NOT NULL
GROUP BY amazon_order_id, seller_sku, substr(posted_at, 1, 10)
UNION ALL
SELECT
  'shopify' AS channel,
  shopify_order_id AS order_id,
  NULL AS sku,
  substr(created_at, 1, 10) AS day,
  amount AS refund_amount,
  reason AS description
FROM shopify_refunds;
