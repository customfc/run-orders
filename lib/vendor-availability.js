/**
 * vendor-availability — normalized vendor stock/availability truth.
 *
 * Vendors are ancient: some send EDI 846, most send a spreadsheet or PDF of
 * "here's what we have." This module turns any of those into one queryable
 * answer: "can we still get SKU X, and as of when?" — which then drives the
 * Shopify stock gate and discontinuation alerts.
 *
 * Key trick for ancient vendors: when a feed is a FULL availability list,
 * a SKU that was on prior feeds but DROPS OFF is a discontinuation signal —
 * even when the vendor never says the word "discontinued".
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.VENDOR_AVAIL_DB_PATH
  || path.join(__dirname, '..', 'data', 'vendor-availability.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'vendor-availability-schema.sql');

const LOW_QTY = 5;            // qty <= LOW (and > 0) => "low"
const DISCONTINUE_AFTER = 2;  // consecutive full feeds absent => inferred discontinued

let _db = null;
function open() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  _db = db;
  return db;
}
function nowIso() { return new Date().toISOString(); }

function deriveStatus(qty, explicit) {
  if (explicit) {
    const e = String(explicit).trim().toLowerCase();
    if (/discontinu|deleted|obsolete|dead/.test(e)) return 'discontinued';
    if (/out|none|0|backorder|b\/o|unavail/.test(e)) return 'out';
    if (/low|limited/.test(e)) return 'low';
    if (/avail|stock|in.?stock|yes/.test(e)) return 'available';
  }
  if (qty == null || Number.isNaN(Number(qty))) return 'unknown';
  const q = Number(qty);
  if (q <= 0) return 'out';
  if (q <= LOW_QTY) return 'low';
  return 'available';
}

/**
 * Ingest normalized rows for one vendor feed.
 * rows: [{ vendor_sku, description?, qty?, unit?, status? (explicit text) }]
 * meta: { vendor, format, source_file, as_of (YYYY-MM-DD), full (bool), note }
 * Returns a summary incl. newly-flagged discontinuations.
 */
function ingest(rows, meta) {
  const db = open();
  const { vendor, format, source_file = null, as_of, note = null } = meta;
  const full = meta.full !== false; // default: treat as a full availability list
  if (!vendor || !as_of) throw new Error('ingest requires meta.vendor and meta.as_of');

  const tx = db.transaction(() => {
    const feedId = db.prepare(
      `INSERT INTO feeds (vendor, format, source_file, as_of, ingested_at, row_count, note)
       VALUES (?,?,?,?,?,?,?)`
    ).run(vendor, format, source_file, as_of, nowIso(), rows.length, note).lastInsertRowid;

    const upsert = db.prepare(`
      INSERT INTO vendor_items (vendor, vendor_sku, description, last_qty, unit, last_status,
                                first_seen, last_seen, last_feed_id, missing_since, missing_count,
                                discontinued, updated_at)
      VALUES (@vendor,@vendor_sku,@description,@last_qty,@unit,@last_status,
              @as_of,@as_of,@feed_id,NULL,0,@disc,@now)
      ON CONFLICT(vendor, vendor_sku) DO UPDATE SET
        description   = COALESCE(excluded.description, vendor_items.description),
        last_qty      = excluded.last_qty,
        unit          = COALESCE(excluded.unit, vendor_items.unit),
        last_status   = excluded.last_status,
        last_seen     = excluded.last_seen,
        last_feed_id  = excluded.last_feed_id,
        missing_since = NULL,
        missing_count = 0,
        discontinued  = MAX(vendor_items.discontinued, excluded.discontinued),
        updated_at    = excluded.updated_at
    `);
    const event = db.prepare(
      `INSERT INTO availability_events (feed_id, vendor, vendor_sku, qty, status, as_of)
       VALUES (?,?,?,?,?,?)`);

    const seen = new Set();
    for (const r of rows) {
      const sku = String(r.vendor_sku || '').trim();
      if (!sku) continue;
      seen.add(sku);
      const status = deriveStatus(r.qty, r.status);
      upsert.run({
        vendor, vendor_sku: sku, description: r.description || null,
        last_qty: (r.qty == null || r.qty === '') ? null : Number(r.qty),
        unit: r.unit || null, last_status: status, as_of, feed_id: feedId,
        disc: status === 'discontinued' ? 1 : 0, now: nowIso(),
      });
      event.run(feedId, vendor, sku, (r.qty == null || r.qty === '') ? null : Number(r.qty), status, as_of);
    }

    // Absence-based discontinuation — only for FULL feeds.
    const newlyDiscontinued = [];
    if (full) {
      const prior = db.prepare(
        `SELECT vendor_sku, description, missing_count, last_seen FROM vendor_items
         WHERE vendor = ? AND discontinued = 0 AND last_seen < ?`).all(vendor, as_of);
      const markMissing = db.prepare(
        `UPDATE vendor_items SET missing_count = missing_count + 1,
           missing_since = COALESCE(missing_since, @as_of),
           last_status = CASE WHEN missing_count + 1 >= @threshold THEN 'discontinued' ELSE last_status END,
           discontinued = CASE WHEN missing_count + 1 >= @threshold THEN 1 ELSE 0 END,
           updated_at = @now
         WHERE vendor = @vendor AND vendor_sku = @sku`);
      for (const p of prior) {
        if (seen.has(p.vendor_sku)) continue; // present this feed (shouldn't be, last_seen<as_of) — skip
        markMissing.run({ vendor, sku: p.vendor_sku, as_of, threshold: DISCONTINUE_AFTER, now: nowIso() });
        if ((p.missing_count + 1) >= DISCONTINUE_AFTER) {
          newlyDiscontinued.push({ vendor_sku: p.vendor_sku, description: p.description });
        }
      }
    }
    return { feedId, ingested: seen.size, newlyDiscontinued };
  });
  return tx();
}

/**
 * Manually confirm a discontinuation (e.g. order desk called the vendor).
 * This is the human "we've confirmed it's gone — kill it" action; it sets the
 * same discontinued flag the automatic drop-off detector would.
 */
function markDiscontinued(vendor, vendorSku, { description = null, note = null, as_of = null } = {}) {
  const db = open();
  const when = as_of || nowIso().slice(0, 10);
  db.prepare(`
    INSERT INTO vendor_items (vendor, vendor_sku, description, last_status, first_seen, last_seen,
                              discontinued, updated_at)
    VALUES (@vendor,@sku,@desc,'discontinued',@when,@when,1,@now)
    ON CONFLICT(vendor,vendor_sku) DO UPDATE SET
      description = COALESCE(excluded.description, vendor_items.description),
      last_status = 'discontinued', discontinued = 1, updated_at = excluded.updated_at
  `).run({ vendor, sku: vendorSku, desc: description, when, now: nowIso() });
  const feedId = db.prepare(`INSERT INTO feeds (vendor, format, source_file, as_of, ingested_at, row_count, note)
    VALUES (?,?,?,?,?,?,?)`).run(vendor, 'manual', null, when, nowIso(), 1,
      note || 'manual discontinued confirmation').lastInsertRowid;
  db.prepare(`INSERT INTO availability_events (feed_id, vendor, vendor_sku, qty, status, as_of)
    VALUES (?,?,?,?,?,?)`).run(feedId, vendor, vendorSku, null, 'discontinued', when);
  return { vendor, vendor_sku: vendorSku, discontinued: 1, as_of: when };
}

/** Rebuild vendor_sku -> our SKU links from Salesforce (PBSI__Vendor_Item_ID__c). */
async function refreshSkuLinks(sf, conn) {
  const db = open();
  const skus = db.prepare(`SELECT DISTINCT vendor, vendor_sku FROM vendor_items`).all();
  const byVendorSku = new Map(skus.map(s => [s.vendor_sku, s.vendor]));
  const ids = [...new Set(skus.map(s => s.vendor_sku))];
  const stmt = db.prepare(`INSERT INTO sku_link (vendor, vendor_sku, our_sku, sf_item_id, linked_at)
    VALUES (?,?,?,?,?) ON CONFLICT(vendor,vendor_sku) DO UPDATE SET
      our_sku=excluded.our_sku, sf_item_id=excluded.sf_item_id, linked_at=excluded.linked_at`);
  let linked = 0;
  for (let i = 0; i < ids.length; i += 180) {
    const chunk = ids.slice(i, i + 180).map(s => `'${String(s).replace(/'/g, "\\'")}'`).join(',');
    if (!chunk) continue;
    const rows = await sf.query(conn, `SELECT Id, Name, PBSI__Vendor_Item_ID__c
      FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c IN (${chunk})`);
    for (const r of rows) {
      const vsku = r.PBSI__Vendor_Item_ID__c;
      const vendor = byVendorSku.get(vsku);
      if (!vendor) continue;
      stmt.run(vendor, vsku, r.Name, r.Id, nowIso());
      linked++;
    }
  }
  return { linked, candidates: ids.length };
}

/** Gate-facing: availability for one of OUR SKUs (= Shopify SKU = SF Name). */
function statusForOurSku(ourSku) {
  const db = open();
  return db.prepare(`
    SELECT vi.vendor, vi.vendor_sku, vi.last_status AS status, vi.discontinued,
           vi.last_qty AS qty, vi.last_seen AS as_of, vi.description
    FROM sku_link sl JOIN vendor_items vi
      ON vi.vendor = sl.vendor AND vi.vendor_sku = sl.vendor_sku
    WHERE sl.our_sku = ?`).get(String(ourSku));
}

function discontinuedReport() {
  const db = open();
  return db.prepare(`
    SELECT vi.vendor, vi.vendor_sku, vi.description, vi.last_seen, vi.missing_since,
           vi.missing_count, sl.our_sku
    FROM vendor_items vi LEFT JOIN sku_link sl
      ON sl.vendor = vi.vendor AND sl.vendor_sku = vi.vendor_sku
    WHERE vi.discontinued = 1 ORDER BY vi.vendor, vi.vendor_sku`).all();
}

function coverageReport() {
  const db = open();
  return db.prepare(`
    SELECT vendor, COUNT(*) AS skus,
           SUM(CASE WHEN last_status='available' THEN 1 ELSE 0 END) AS available,
           SUM(CASE WHEN last_status='low' THEN 1 ELSE 0 END) AS low,
           SUM(CASE WHEN last_status='out' THEN 1 ELSE 0 END) AS out,
           SUM(discontinued) AS discontinued,
           MAX(last_seen) AS latest_feed
    FROM vendor_items GROUP BY vendor ORDER BY vendor`).all();
}

module.exports = {
  open, DB_PATH, ingest, markDiscontinued, refreshSkuLinks, statusForOurSku,
  discontinuedReport, coverageReport, deriveStatus, LOW_QTY, DISCONTINUE_AFTER,
};
