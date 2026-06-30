-- vendor-availability: normalized store for whatever vendors send us
-- (CSV/spreadsheet exports, EDI 846 inventory advice, PDF lists, email drops).
-- The whole point: turn heterogeneous, ancient vendor data into one queryable
-- truth of "can we still get SKU X from vendor Y, as of when?" — and feed that
-- into the Shopify stock gate + discontinuation alerts.

-- One row per ingested file/feed.
CREATE TABLE IF NOT EXISTS feeds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor       TEXT NOT NULL,           -- registry key, e.g. "biyork"
  format       TEXT NOT NULL,           -- csv | xlsx | edi846 | pdf | manual
  source_file  TEXT,                    -- original filename/path
  as_of        TEXT NOT NULL,           -- the date this feed represents (vendor's data date)
  ingested_at  TEXT NOT NULL,           -- when we processed it (ISO)
  row_count    INTEGER DEFAULT 0,
  note         TEXT
);

-- Current best-known state per (vendor, vendor_sku). Upserted on every ingest.
CREATE TABLE IF NOT EXISTS vendor_items (
  vendor         TEXT NOT NULL,
  vendor_sku     TEXT NOT NULL,
  description    TEXT,
  last_qty       REAL,                  -- qty on the most recent feed (NULL if feed had no qty)
  unit           TEXT,
  last_status    TEXT NOT NULL DEFAULT 'unknown', -- available | low | out | discontinued | unknown
  first_seen     TEXT,                  -- as_of of the first feed this SKU appeared on
  last_seen      TEXT,                  -- as_of of the most recent feed it appeared on
  last_feed_id   INTEGER,
  missing_since  TEXT,                  -- as_of of first feed it was ABSENT from after having been present
  missing_count  INTEGER DEFAULT 0,     -- consecutive feeds absent
  discontinued   INTEGER DEFAULT 0,     -- 1 = confirmed/inferred gone
  updated_at     TEXT,
  PRIMARY KEY (vendor, vendor_sku)
);

-- Append-only history so we can chart availability over time / audit.
CREATE TABLE IF NOT EXISTS availability_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id     INTEGER NOT NULL,
  vendor      TEXT NOT NULL,
  vendor_sku  TEXT NOT NULL,
  qty         REAL,
  status      TEXT,
  as_of       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avail_events_sku ON availability_events(vendor, vendor_sku);

-- Map a vendor SKU to our own catalog so availability can drive the storefront.
-- Populated from Salesforce: PBSI__Vendor_Item_ID__c -> Name (our SKU = Shopify SKU).
CREATE TABLE IF NOT EXISTS sku_link (
  vendor       TEXT NOT NULL,
  vendor_sku   TEXT NOT NULL,
  our_sku      TEXT NOT NULL,           -- SF item Name == Shopify SKU
  sf_item_id   TEXT,
  linked_at    TEXT,
  PRIMARY KEY (vendor, vendor_sku)
);
CREATE INDEX IF NOT EXISTS idx_sku_link_our ON sku_link(our_sku);
