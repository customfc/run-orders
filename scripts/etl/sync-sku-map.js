#!/usr/bin/env node
/**
 * Build the canonical SKU map joining Amazon ASIN ↔ MSKU ↔ Prosol SKU ↔ SF
 * PBSI Item ↔ brand/category/MAP.
 *
 * Strategy:
 *   1. Walk scripts/shipstation/sku-map.json, collect ASIN-keyed entries
 *      (242 rows). These have api_sku (Prosol), brand, map_cad, product_name.
 *   2. Query Salesforce once: SELECT Id, Name, PBSI__Vendor_Item_ID__c,
 *      PBSI__Cost__c FROM PBSI__PBSI_Item__c WHERE Vendor_Item_ID IS NOT
 *      NULL. Build {vendor_item_id → {id, name, cost}} map.
 *   3. For each ASIN entry, look up its api_sku in the SF map. Capture
 *      sf_pbsi_item_id + sf_item_name so downstream JOINs work.
 *   4. Amazon MSKU: pull from inventory_daily (Amazon report sets `sku` =
 *      our MSKU per ASIN). Use the latest snapshot's rows.
 *   5. Upsert into sku_map_canonical.
 *
 * Brand fallback: 169/242 entries have explicit `brand`. For the rest,
 * derive from product name (aqua mix / schluter / bona / custom / etc.).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sfLib = require('../../lib/salesforce');
const { open, setSyncState, tx } = require('../../lib/analytics-db');

const SKU_MAP_PATH = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'sku-map.json');

function deriveBrandFromProduct(p) {
  if (!p) return null;
  const s = p.toLowerCase();
  if (/schluter/.test(s)) return 'schluter';
  if (/aqua\s*mix/.test(s)) return 'aquamix';
  if (/\bbona\b/.test(s)) return 'bona';
  if (/mapei/.test(s)) return 'mapei';
  if (/armstrong/.test(s)) return 'armstrong';
  if (/laticrete/.test(s)) return 'laticrete';
  if (/custom\s*building|\bcbp\b/.test(s)) return 'custom-building';
  if (/torlys/.test(s)) return 'torlys';
  if (/biyork/.test(s)) return 'biyork';
  if (/perfect\s*level/.test(s)) return 'perfect-level';
  return null;
}

async function main() {
  const mappings = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8')).mappings;
  const asinEntries = [];
  for (const [k, v] of Object.entries(mappings)) {
    if (!/^B0[A-Z0-9]{8}$/.test(k) || typeof v !== 'object') continue;
    asinEntries.push({ asin: k, ...v });
  }
  console.log(`[sku-map] ${asinEntries.length} ASIN entries in sku-map.json`);

  // Collect distinct Prosol + Treeco + other vendor identifiers to look up
  // in SF. PBSI__Vendor_Item_ID__c is vendor-agnostic; whichever code was
  // entered when the item was set up in SF, that's what we match against.
  const vendorIds = new Set();
  for (const e of asinEntries) {
    if (e.api_sku && e.api_sku !== 'NON_PROSOL' && !e.api_sku.startsWith('UNMAPPED')) vendorIds.add(e.api_sku);
    if (e.prosol_sku && e.prosol_sku !== 'NON_PROSOL' && !e.prosol_sku.startsWith('UNMAPPED')) vendorIds.add(e.prosol_sku);
    if (e.treeco_sku) vendorIds.add(e.treeco_sku);
  }
  console.log(`[sku-map] ${vendorIds.size} distinct vendor SKUs to resolve in SF`);

  // Build {vendor_id → SF item} map in one SOQL pass. Can't chunk a
  // WHERE IN clause to 20k values, so just pull all items with a vendor
  // ID populated and filter in JS.
  const conn = await sfLib.connect();
  const records = await new Promise((resolve, reject) => {
    const out = [];
    conn.query(`
      SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__Cost__c, PBSI__Description__c
      FROM PBSI__PBSI_Item__c
      WHERE PBSI__Vendor_Item_ID__c != NULL
    `).on('record', (r) => out.push(r))
      .on('end', () => resolve(out))
      .on('error', reject)
      .run({ autoFetch: true, maxFetch: 50_000 });
  });
  console.log(`[sku-map] ${records.length} SF items with vendor_item_id`);

  const byVendorId = new Map();
  for (const r of records) {
    const vid = r.PBSI__Vendor_Item_ID__c;
    if (!vid) continue;
    // Multiple SF items can share a vendor_id. Prefer the one with a cost set.
    const existing = byVendorId.get(vid);
    if (!existing || (r.PBSI__Cost__c > 0 && !(existing.PBSI__Cost__c > 0))) {
      byVendorId.set(vid, r);
    }
  }

  // Amazon MSKU from latest inventory_daily snapshot (maps ASIN ↔ MSKU)
  const db = open();
  const latestSnap = db.prepare('SELECT MAX(snapshot_date) d FROM inventory_daily').get();
  const mskuByAsin = {};
  if (latestSnap.d) {
    const rows = db.prepare('SELECT asin, sku FROM inventory_daily WHERE snapshot_date = ? AND sku IS NOT NULL').all(latestSnap.d);
    for (const r of rows) mskuByAsin[r.asin] = r.sku;
  }
  console.log(`[sku-map] ${Object.keys(mskuByAsin).length} ASIN↔MSKU from inventory_daily ${latestSnap.d || '(no snapshot)'}`);

  // Build canonical rows
  const nowIso = new Date().toISOString();
  let resolvedInSf = 0, hasCost = 0, hasBrand = 0;
  const rowsToInsert = [];
  for (const e of asinEntries) {
    // Match priority: api_sku → prosol_sku → treeco_sku. SF
    // PBSI__Vendor_Item_ID__c stores whichever code was entered at item
    // setup, so we check all known vendor SKUs in the sku-map entry.
    const sfItem = (e.api_sku && byVendorId.get(e.api_sku))
                || (e.prosol_sku && byVendorId.get(e.prosol_sku))
                || (e.treeco_sku && byVendorId.get(e.treeco_sku))
                || null;
    if (sfItem) resolvedInSf++;
    if (sfItem?.PBSI__Cost__c > 0) hasCost++;
    const brand = e.brand || deriveBrandFromProduct(e.product);
    if (brand) hasBrand++;

    rowsToInsert.push({
      asin: e.asin,
      amazon_msku: mskuByAsin[e.asin] || null,
      api_sku: e.api_sku || null,
      prosol_sku: e.prosol_sku || null,
      sf_pbsi_item_id: sfItem?.Id || null,
      sf_item_name: sfItem?.Name || e.sf_item_name || null,
      brand: brand || null,
      category: e.category || null,
      map_cad: e.map_cad || null,
      product_name: e.product || sfItem?.PBSI__Description__c || null,
      source: 'sku-map-asin',
      updated_at: nowIso,
    });
  }

  tx(() => {
    const ins = db.prepare(`
      INSERT INTO sku_map_canonical (
        asin, amazon_msku, api_sku, prosol_sku,
        sf_pbsi_item_id, sf_item_name, brand, category,
        map_cad, product_name, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asin) DO UPDATE SET
        amazon_msku = COALESCE(excluded.amazon_msku, sku_map_canonical.amazon_msku),
        api_sku = excluded.api_sku,
        prosol_sku = excluded.prosol_sku,
        sf_pbsi_item_id = excluded.sf_pbsi_item_id,
        sf_item_name = excluded.sf_item_name,
        brand = excluded.brand,
        category = excluded.category,
        map_cad = excluded.map_cad,
        product_name = excluded.product_name,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    for (const r of rowsToInsert) {
      ins.run(
        r.asin, r.amazon_msku, r.api_sku, r.prosol_sku,
        r.sf_pbsi_item_id, r.sf_item_name, r.brand, r.category,
        r.map_cad, r.product_name, r.source, r.updated_at,
      );
    }
  });

  setSyncState('sku-map-canonical', { cursor: nowIso, rowsLastRun: rowsToInsert.length, status: 'ok' });

  console.log(`[sku-map] ✓ ${rowsToInsert.length} canonical rows`);
  console.log(`  resolved in SF: ${resolvedInSf}/${rowsToInsert.length}`);
  console.log(`  with cost:      ${hasCost}/${rowsToInsert.length}`);
  console.log(`  with brand:     ${hasBrand}/${rowsToInsert.length}`);
  console.log(`  with MSKU:      ${rowsToInsert.filter((r) => r.amazon_msku).length}/${rowsToInsert.length}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[sku-map] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
