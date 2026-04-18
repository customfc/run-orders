#!/usr/bin/env node
/**
 * Promote local FBA JSON snapshots into analytics DB daily tables.
 *
 * Walks data/fba/snapshots/ and upserts:
 *   - buybox-YYYY-MM-DD.json     → buybox_daily rows
 *   - inventory-planning-YYYY-MM-DD.json → inventory_daily rows
 *
 * Idempotent (PK is snapshot_date + asin). The 6 AM morning-pull cron
 * also calls this after its snapshots land, so the DB stays fresh.
 *
 * Usage:
 *   node scripts/etl/sync-snapshots.js                  # walk all files
 *   node scripts/etl/sync-snapshots.js --only <date>    # one day, e.g. 2026-04-17
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fbaSignals = require('../../lib/fba-signals');
const { open, setSyncState, tx } = require('../../lib/analytics-db');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');

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

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null ? null : String(v); }
function bool(v) { return v === true || v === 'true' ? 1 : 0; }

function extractDate(filename) {
  // buybox-2026-04-17.json or inventory-planning-2026-04-17.json
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Promote a single buybox snapshot's rows (via fba-signals merging logic
// if we also have matching inventory-planning data for that date).
function promoteBuyboxSnapshot(db, snapPath, snapshotDate) {
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const results = snap.results || [];
  if (!results.length) return 0;

  const ins = db.prepare(`
    INSERT INTO buybox_daily (
      snapshot_date, asin, sku, our_price, bb_price, bb_seller_id,
      bb_is_us, bb_is_fba, our_is_fba, lowest_price, lowest_fba_price,
      offer_count, gap, tier, map_cad, map_decision_action,
      raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, asin) DO UPDATE SET
      sku = excluded.sku,
      our_price = excluded.our_price,
      bb_price = excluded.bb_price,
      bb_seller_id = excluded.bb_seller_id,
      bb_is_us = excluded.bb_is_us,
      bb_is_fba = excluded.bb_is_fba,
      our_is_fba = excluded.our_is_fba,
      lowest_price = excluded.lowest_price,
      lowest_fba_price = excluded.lowest_fba_price,
      offer_count = excluded.offer_count,
      gap = excluded.gap,
      tier = excluded.tier,
      map_cad = excluded.map_cad,
      map_decision_action = excluded.map_decision_action,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `);

  let count = 0;
  const now = new Date().toISOString();
  for (const r of results) {
    if (!r.ok || !r.summary) continue;
    const s = r.summary;
    const gap = (s.ourPrice != null && s.buyBoxPrice != null)
      ? Number((s.ourPrice - s.buyBoxPrice).toFixed(2))
      : null;
    ins.run(
      snapshotDate,
      str(r.asin),
      null, // sku populated by inventory snapshot merge below
      num(s.ourPrice),
      num(s.buyBoxPrice),
      str(s.buyBoxSellerId),
      bool(s.buyBoxIsUs),
      bool(s.buyBoxIsFba),
      bool(s.ourIsFba),
      num(s.lowestPrice),
      num(s.lowestFbaPrice),
      num(s.offerCount),
      gap,
      null, // tier comes from the enriched row in fba-signals (needs inventory)
      null, // map_cad comes from sku-map
      null, // map_decision_action same
      JSON.stringify(r),
      now,
    );
    count++;
  }
  return count;
}

function promoteInventorySnapshot(db, snapPath, snapshotDate) {
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const rawRows = snap.rows || [];
  if (!rawRows.length) return { inventory: 0, buyboxEnriched: 0 };

  // Use fba-signals normalize + merge buybox if present + attach MAP to
  // build the same enriched-row shape the dashboard renders. This
  // populates tier, map_cad, map_decision_action fields on both buybox
  // and inventory rows so analytics views can slice by tier directly.
  const rows = rawRows.map((r) => fbaSignals.normalizeRow ? fbaSignals.normalizeRow(r) : null).filter(Boolean);
  // fba-signals doesn't export normalizeRow publicly — fallback: use the
  // raw + enrichment via loadLatestSnapshot when the snapshot matches.
  // For historical snapshots that aren't "latest", we just ingest raw
  // fields directly since the tier/MAP require a live sku-map lookup
  // which may have changed since the snapshot.

  const insInv = db.prepare(`
    INSERT INTO inventory_daily (
      snapshot_date, asin, sku, available, inbound, reserved, unfulfillable,
      units7, units30, units60, units90, daily_velocity,
      days_of_supply, total_days_of_supply, rec_ship_qty, rec_ship_date,
      lipc_applied_this_week, estimated_storage_cost_next_month, tier,
      raw, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, asin) DO UPDATE SET
      sku = excluded.sku,
      available = excluded.available,
      inbound = excluded.inbound,
      reserved = excluded.reserved,
      unfulfillable = excluded.unfulfillable,
      units7 = excluded.units7,
      units30 = excluded.units30,
      units60 = excluded.units60,
      units90 = excluded.units90,
      daily_velocity = excluded.daily_velocity,
      days_of_supply = excluded.days_of_supply,
      total_days_of_supply = excluded.total_days_of_supply,
      rec_ship_qty = excluded.rec_ship_qty,
      rec_ship_date = excluded.rec_ship_date,
      lipc_applied_this_week = excluded.lipc_applied_this_week,
      estimated_storage_cost_next_month = excluded.estimated_storage_cost_next_month,
      tier = excluded.tier,
      raw = excluded.raw,
      ingested_at = excluded.ingested_at
  `);

  const updBuybox = db.prepare(`
    UPDATE buybox_daily
    SET sku = ?, tier = ?, map_cad = ?, map_decision_action = ?
    WHERE snapshot_date = ? AND asin = ?
  `);

  const now = new Date().toISOString();
  let invCount = 0, bbEnrichedCount = 0;

  for (const raw of rawRows) {
    const asin = str(raw.asin);
    if (!asin) continue;
    // Normalize fields (matches fba-signals.normalizeRow)
    const available = num(raw['afn-fulfillable-quantity']) || 0;
    const inbound = num(raw['inbound-quantity']);
    const reserved = num(raw['reserved-quantity']);
    const unfulfillable = num(raw['afn-unsellable-quantity']);
    const units7 = num(raw['units-shipped-t7']) || 0;
    const units30 = num(raw['units-shipped-t30']) || 0;
    const units60 = num(raw['units-shipped-t60']);
    const units90 = num(raw['units-shipped-t90']);
    const dailyVelocity = units30 / 30;
    const daysOfSupply = num(raw['days-of-supply']);
    const totalDaysOfSupply = num(raw['Total Days of Supply (including units from open shipments)']);
    const recShipQty = num(raw['recommended-ship-in-quantity']) || 0;
    const recShipDate = str(raw['recommended-ship-in-date']);
    const storageCost = num(raw['estimated-storage-cost-next-month']);
    const lipcApplied = str(raw['Low-Inventory-Level fee applied in current week?']) === 'Yes' ? 1 : 0;

    insInv.run(
      snapshotDate,
      asin,
      str(raw.sku),
      available, inbound, reserved, unfulfillable,
      units7, units30, units60, units90, dailyVelocity,
      daysOfSupply, totalDaysOfSupply, recShipQty, recShipDate,
      lipcApplied, storageCost,
      null, // tier requires the enriched classify() which also needs BB + MAP
      JSON.stringify(raw),
      now,
    );
    invCount++;
  }

  // If this is the "latest" date, also enrich buybox_daily rows with sku + tier via fba-signals
  const latestLoaded = fbaSignals.loadLatestSnapshot({ withBuyBox: true });
  if (latestLoaded && latestLoaded.path && latestLoaded.path.endsWith(path.basename(snapPath))) {
    for (const row of latestLoaded.rows || []) {
      if (!row.asin) continue;
      updBuybox.run(
        str(row.sku),
        str(row.tier),
        num(row.mapCad),
        str(row.mapDecision?.action),
        snapshotDate,
        str(row.asin),
      );
      bbEnrichedCount++;
    }
  }

  return { inventory: invCount, buyboxEnriched: bbEnrichedCount };
}

async function main() {
  const args = parseArgs();
  const onlyDate = args.only || null;
  const db = open();

  if (!fs.existsSync(SNAP_DIR)) {
    console.log('[sync-snapshots] no snapshot dir — nothing to do');
    return;
  }
  const files = fs.readdirSync(SNAP_DIR).sort();

  // Buybox first (so inventory pass can enrich them)
  const bbFiles = files.filter((f) => f.startsWith('buybox-') && f.endsWith('.json'));
  const invFiles = files.filter((f) => f.startsWith('inventory-planning-') && f.endsWith('.json'));

  let bbTotal = 0, invTotal = 0, bbEnrichedTotal = 0;
  tx(() => {
    for (const f of bbFiles) {
      const d = extractDate(f);
      if (!d) continue;
      if (onlyDate && d !== onlyDate) continue;
      const n = promoteBuyboxSnapshot(db, path.join(SNAP_DIR, f), d);
      console.log(`[sync-snapshots] buybox ${d}: ${n} rows`);
      bbTotal += n;
    }
    for (const f of invFiles) {
      const d = extractDate(f);
      if (!d) continue;
      if (onlyDate && d !== onlyDate) continue;
      const r = promoteInventorySnapshot(db, path.join(SNAP_DIR, f), d);
      console.log(`[sync-snapshots] inventory ${d}: ${r.inventory} rows (${r.buyboxEnriched} buybox enriched)`);
      invTotal += r.inventory;
      bbEnrichedTotal += r.buyboxEnriched;
    }
  });

  setSyncState('snapshots', {
    cursor: new Date().toISOString().slice(0, 10),
    rowsLastRun: bbTotal + invTotal,
    status: 'ok',
  });
  console.log(`[sync-snapshots] ✓ ${bbTotal} buybox, ${invTotal} inventory, ${bbEnrichedTotal} buybox rows enriched with sku/tier`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[sync-snapshots] ERROR:', e.message); console.error(e.stack); process.exit(1); });
}

module.exports = { main };
