-- Analytics DB schema — Phase A (ingest layer).
--
-- SQLite file at data/analytics.sqlite. Populated by scripts/etl/*.js as a
-- nightly cron on Mac Mini. Read-only from the dashboard side.
--
-- Design choices:
--   * Natural keys where stable (AmazonOrderId, Shopify order id) so
--     idempotent upserts just work.
--   * `raw` JSON column on every ingest table — the source-of-truth blob,
--     in case we need to re-derive columns later without re-hitting the API.
--   * cost_snapshot on order line items — captures cost-at-sale so old-
--     period margin reports don't get rewritten when today's cost changes.
--   * Timestamps stored as ISO 8601 text (SQLite has no native TIMESTAMP).
--   * All monetary values in CAD. Source currency preserved in `raw`.
--
-- P&L is computed via views (see Phase B) — SKU × month rollup.

-- ── Sync state — per-source last-successful-pull tracking ───────────────────

CREATE TABLE IF NOT EXISTS etl_sync_state (
  source TEXT PRIMARY KEY,                -- 'amazon-orders' | 'amazon-finances' | 'shopify' | 'item-costs' | …
  last_sync_at TEXT NOT NULL,             -- ISO 8601
  cursor TEXT,                            -- source-specific cursor (LastUpdatedAfter, updated_at_min, …)
  rows_last_run INTEGER,
  status TEXT,                            -- 'ok' | 'error'
  error_message TEXT
);

-- ── Amazon orders ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS amazon_orders (
  amazon_order_id TEXT PRIMARY KEY,
  purchase_date TEXT NOT NULL,            -- ISO 8601
  last_update_date TEXT,
  order_status TEXT,                      -- Pending / Unshipped / Shipped / Canceled …
  fulfillment_channel TEXT,               -- AFN (FBA) | MFN (seller-fulfilled)
  sales_channel TEXT,                     -- Amazon.ca, etc.
  marketplace_id TEXT,
  order_total_amount REAL,
  order_total_currency TEXT,
  number_of_items_shipped INTEGER,
  number_of_items_unshipped INTEGER,
  payment_method TEXT,
  is_business_order INTEGER DEFAULT 0,    -- boolean
  is_prime INTEGER DEFAULT 0,
  is_replacement INTEGER DEFAULT 0,
  ship_city TEXT,
  ship_state TEXT,                        -- province code
  ship_postal TEXT,
  ship_country TEXT,
  buyer_email TEXT,                       -- anonymized Amazon address
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_purchase ON amazon_orders(purchase_date);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_postal ON amazon_orders(ship_postal);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_channel ON amazon_orders(fulfillment_channel);

CREATE TABLE IF NOT EXISTS amazon_order_items (
  order_item_id TEXT PRIMARY KEY,
  amazon_order_id TEXT NOT NULL,
  asin TEXT,
  seller_sku TEXT,
  title TEXT,
  qty_ordered INTEGER,
  qty_shipped INTEGER,
  item_price_amount REAL,
  item_price_currency TEXT,
  shipping_price_amount REAL,
  item_tax_amount REAL,
  promotion_discount_amount REAL,
  cost_snapshot REAL,                     -- unit cost CAD at ingest time (SF/Prosol)
  cost_source TEXT,                       -- 'prosol-live' | 'sf-primary' | 'sku-map' | null
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (amazon_order_id) REFERENCES amazon_orders(amazon_order_id)
);
CREATE INDEX IF NOT EXISTS idx_amazon_items_order ON amazon_order_items(amazon_order_id);
CREATE INDEX IF NOT EXISTS idx_amazon_items_sku ON amazon_order_items(seller_sku);
CREATE INDEX IF NOT EXISTS idx_amazon_items_asin ON amazon_order_items(asin);

-- ── Amazon financial events (from settlement reports) ──────────────────────

CREATE TABLE IF NOT EXISTS amazon_financial_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id TEXT NOT NULL,            -- maps to a SettlementReport
  posted_at TEXT NOT NULL,
  transaction_type TEXT,                  -- 'Order' | 'Refund' | 'ServiceFee' | 'Storage' | 'Subscription' | …
  amazon_order_id TEXT,
  asin TEXT,
  seller_sku TEXT,
  fee_type TEXT,                          -- ReferralFee, FBAPerUnitFulfillmentFee, FBAStorageFee, etc.
  amount_cad REAL NOT NULL,
  currency TEXT,
  quantity INTEGER,                       -- quantity-purchased column from settlement CSV (Principal rows); null for fee-only rows
  description TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);
-- Migration for pre-quantity rows: add column if missing
-- (SQLite ignores ALTER TABLE ADD COLUMN if it already exists via error path,
--  but CREATE TABLE IF NOT EXISTS keeps old schema. Apply idempotently.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_events ON amazon_financial_events(settlement_id, posted_at, transaction_type, amazon_order_id, asin, fee_type, amount_cad);
CREATE INDEX IF NOT EXISTS idx_fin_events_order ON amazon_financial_events(amazon_order_id);
CREATE INDEX IF NOT EXISTS idx_fin_events_sku ON amazon_financial_events(seller_sku);
CREATE INDEX IF NOT EXISTS idx_fin_events_posted ON amazon_financial_events(posted_at);
CREATE INDEX IF NOT EXISTS idx_fin_events_settlement ON amazon_financial_events(settlement_id);

CREATE TABLE IF NOT EXISTS amazon_settlements (
  settlement_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  deposit_date TEXT,
  deposit_amount REAL,
  currency TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_deposit ON amazon_settlements(deposit_date);

-- ── Shopify orders ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shopify_orders (
  shopify_order_id TEXT PRIMARY KEY,      -- numeric as string
  order_name TEXT,                        -- e.g. #1244
  created_at TEXT NOT NULL,
  updated_at TEXT,
  processed_at TEXT,
  cancelled_at TEXT,
  financial_status TEXT,                  -- paid / refunded / voided / partially_refunded
  fulfillment_status TEXT,
  currency TEXT,
  total_price REAL,
  subtotal_price REAL,
  total_tax REAL,
  total_shipping REAL,
  total_discount REAL,
  source_name TEXT,                       -- 'web' | 'shopify_draft_order' | 'pos' …
  customer_email TEXT,
  ship_city TEXT,
  ship_state TEXT,
  ship_postal TEXT,
  ship_country TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_created ON shopify_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_postal ON shopify_orders(ship_postal);

CREATE TABLE IF NOT EXISTS shopify_order_lines (
  line_id TEXT PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  variant_id TEXT,
  product_id TEXT,
  sku TEXT,
  title TEXT,
  qty INTEGER,
  price REAL,
  total_discount REAL,
  cost_snapshot REAL,                     -- unit cost CAD at ingest
  cost_source TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (shopify_order_id) REFERENCES shopify_orders(shopify_order_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_lines_order ON shopify_order_lines(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_shopify_lines_sku ON shopify_order_lines(sku);

CREATE TABLE IF NOT EXISTS shopify_refunds (
  refund_id TEXT PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  reason TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (shopify_order_id) REFERENCES shopify_orders(shopify_order_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_refunds_order ON shopify_refunds(shopify_order_id);

CREATE TABLE IF NOT EXISTS shopify_order_fees (
  transaction_id TEXT PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  kind TEXT,                              -- 'sale' | 'refund'
  processed_at TEXT,
  amount REAL,
  fee_amount REAL,                        -- Shopify Payments / Stripe processor fee
  currency TEXT,
  gateway TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (shopify_order_id) REFERENCES shopify_orders(shopify_order_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_fees_order ON shopify_order_fees(shopify_order_id);

-- ── Item costs (tiered sources) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS item_costs (
  sku TEXT PRIMARY KEY,                   -- internal SKU (ShipStation SKU / sku-map key)
  cost_cad REAL NOT NULL,
  cost_source TEXT NOT NULL,              -- 'prosol-live' | 'sf-primary' | 'sku-map' | 'manual'
  source_detail TEXT,                     -- e.g. Prosol warehouse, SF field name, sku-map note
  pbsi_item_id TEXT,                      -- SF record ID when source is SF
  prosol_sku TEXT,
  updated_at TEXT NOT NULL,
  previous_cost_cad REAL,                 -- so we can alert on price hikes
  previous_updated_at TEXT
);

-- Canonical SKU mapping across the three universes: Amazon MSKU,
-- ShipStation SKU (sku-map.json numeric keys), SF PBSI Item Name, and
-- ASIN. Built by scripts/etl/sync-sku-map.js by walking sku-map.json ASIN
-- entries and looking up each api_sku in SF (PBSI__Vendor_Item_ID__c).
-- Downstream views JOIN via this table so analytics are cost-aware.

CREATE TABLE IF NOT EXISTS sku_map_canonical (
  asin TEXT PRIMARY KEY,
  amazon_msku TEXT,                       -- seller SKU we gave Amazon (from inventory_daily)
  api_sku TEXT,                           -- Prosol lookup SKU (sku-map.api_sku)
  prosol_sku TEXT,                        -- Prosol order SKU (sku-map.prosol_sku)
  sf_pbsi_item_id TEXT,                   -- SF record ID (PBSI__PBSI_Item__c.Id)
  sf_item_name TEXT,                      -- SF Item Name (PBSI__PBSI_Item__c.Name) — joins item_costs.sku
  brand TEXT,
  category TEXT,
  map_cad REAL,
  product_name TEXT,
  source TEXT,                            -- e.g. 'sku-map-asin', 'sku-map-override'
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skumap_msku ON sku_map_canonical(amazon_msku);
CREATE INDEX IF NOT EXISTS idx_skumap_sfitem ON sku_map_canonical(sf_item_name);
CREATE INDEX IF NOT EXISTS idx_skumap_brand ON sku_map_canonical(brand);

-- ── Inbound shipments (forward-only; powers freight attribution) ────────────

-- ── Outbound shipping labels (ShipStation — for MFN + Shopify orders) ─────
-- Populated from data/ops-state/*.json nightly. Each row is one label
-- bought; a multi-package shipment is one row per package.

CREATE TABLE IF NOT EXISTS shipping_labels (
  shipment_id TEXT PRIMARY KEY,           -- ShipStation shipmentId (numeric string)
  order_number TEXT,                      -- Shopify order name (#1244) or Amazon MFN order id
  channel TEXT,                           -- 'shopify' | 'amazon-mfn' | inferred
  tracking_number TEXT,
  label_cost_cad REAL NOT NULL,
  estimated_cost_cad REAL,
  carrier_code TEXT,
  service_code TEXT,
  warehouse_id INTEGER,
  purchased_at TEXT,
  raw TEXT,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_order ON shipping_labels(order_number);
CREATE INDEX IF NOT EXISTS idx_labels_purchased ON shipping_labels(purchased_at);

-- Per-label items (when the package's item list is available). Used to
-- allocate per-line label cost when a shipment has multiple SKUs.
CREATE TABLE IF NOT EXISTS shipping_label_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL,
  sku TEXT,
  name TEXT,
  qty INTEGER,
  raw TEXT,
  FOREIGN KEY (shipment_id) REFERENCES shipping_labels(shipment_id)
);
CREATE INDEX IF NOT EXISTS idx_label_items_sku ON shipping_label_items(sku);
CREATE INDEX IF NOT EXISTS idx_label_items_shipment ON shipping_label_items(shipment_id);

CREATE TABLE IF NOT EXISTS inbound_shipments (
  shipment_id TEXT PRIMARY KEY,           -- Amazon shipmentId or our internal id
  plan_key TEXT,                          -- links to data/fba/inbound-plans/<plan_key>.json
  amazon_reference_id TEXT,               -- FBA…
  shipment_confirmation_id TEXT,          -- FBA1234ABCD
  vendor TEXT,                            -- prosol | treeco | sechelt | perfectlevel …
  carrier TEXT,                           -- UPS, Canada Post, Amazon Partnered …
  carrier_service TEXT,
  booked_at TEXT,
  arrived_at TEXT,                        -- null until received
  total_cost_cad REAL NOT NULL,
  total_weight_lb REAL,
  box_count INTEGER,
  unit_count INTEGER,
  raw TEXT,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_shipment_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  asin TEXT,
  qty INTEGER NOT NULL,
  allocated_cost_cad REAL NOT NULL,       -- per-line freight share (single-SKU: total/qty)
  allocated_cost_per_unit REAL NOT NULL,
  raw TEXT,
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (shipment_id) REFERENCES inbound_shipments(shipment_id),
  UNIQUE(shipment_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_inbound_lines_sku ON inbound_shipment_lines(sku);

-- ── Daily buybox + inventory snapshots (promoted from JSON) ────────────────

CREATE TABLE IF NOT EXISTS buybox_daily (
  snapshot_date TEXT NOT NULL,            -- YYYY-MM-DD
  asin TEXT NOT NULL,
  sku TEXT,
  our_price REAL,
  bb_price REAL,
  bb_seller_id TEXT,
  bb_is_us INTEGER DEFAULT 0,
  bb_is_fba INTEGER DEFAULT 0,
  our_is_fba INTEGER DEFAULT 0,
  lowest_price REAL,
  lowest_fba_price REAL,
  offer_count INTEGER,
  gap REAL,                               -- our_price - bb_price (null-safe)
  tier TEXT,                              -- bb-losing, bleeding, healthy, …
  map_cad REAL,
  map_decision_action TEXT,               -- match | hold-at-map | violation-by-us | …
  raw TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, asin)
);
CREATE INDEX IF NOT EXISTS idx_buybox_sku ON buybox_daily(sku);
CREATE INDEX IF NOT EXISTS idx_buybox_tier ON buybox_daily(snapshot_date, tier);

CREATE TABLE IF NOT EXISTS inventory_daily (
  snapshot_date TEXT NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT,
  available INTEGER,
  inbound INTEGER,
  reserved INTEGER,
  unfulfillable INTEGER,
  units7 INTEGER,
  units30 INTEGER,
  units60 INTEGER,
  units90 INTEGER,
  daily_velocity REAL,
  days_of_supply REAL,
  total_days_of_supply REAL,
  rec_ship_qty INTEGER,
  rec_ship_date TEXT,
  lipc_applied_this_week INTEGER DEFAULT 0,
  estimated_storage_cost_next_month REAL,
  tier TEXT,
  raw TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, asin)
);
CREATE INDEX IF NOT EXISTS idx_inv_sku ON inventory_daily(sku);
CREATE INDEX IF NOT EXISTS idx_inv_tier ON inventory_daily(snapshot_date, tier);
