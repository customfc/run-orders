#!/usr/bin/env node
/**
 * Item cost sync — tiered source priority:
 *   1. sku-map.json `unit_cost` / `cost_cad` override  (highest priority)
 *   2. Salesforce PBSI__PBSI_Item__c.PBSI__Cost__c        (fallback)
 *
 * Writes to item_costs keyed by SKU. Stores previous cost + timestamp so
 * we can alert when a supplier price jumps (useful for the "margin
 * warnings" tab). Records cost_source so the UI can show "from SF (last
 * updated 2 days ago)" vs "manual sku-map override".
 *
 * Prosol live-portal pricing is a planned enhancement — the storefront
 * API product payload likely carries a price field but the existing
 * ProsolClientV2 doesn't extract it yet. Punt for now; SF is the source
 * of truth for all SKU costs since it's updated frequently.
 *
 * Usage:
 *   DISABLE_CRON=1 node scripts/etl/sync-item-costs.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sfLib = require('../../lib/salesforce');
const { open, setSyncState, tx } = require('../../lib/analytics-db');

const SKU_MAP_PATH = path.join(__dirname, '..', '..', 'scripts', 'shipstation', 'sku-map.json');

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function loadSkuMapOverrides() {
  if (!fs.existsSync(SKU_MAP_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8'));
  const mappings = raw.mappings || raw;
  const out = [];
  for (const [key, entry] of Object.entries(mappings)) {
    if (typeof entry !== 'object') continue;
    const cost = num(entry.unit_cost) ?? num(entry.cost_cad);
    if (cost === null || cost <= 0) continue;
    out.push({
      sku: key,
      cost_cad: cost,
      cost_source: 'sku-map',
      source_detail: entry.note || null,
      prosol_sku: entry.prosol_sku && entry.prosol_sku !== 'NON_PROSOL' ? entry.prosol_sku : null,
    });
  }
  return out;
}

async function loadSfCosts() {
  const conn = await sfLib.connect();
  // SOQL query defaults to 2000-row page size. For the full ~11.7K item
  // master, stream via autoFetch with an explicit maxFetch ceiling.
  const soql = `
    SELECT Id, Name, PBSI__Cost__c, PBSI__Description__c
    FROM PBSI__PBSI_Item__c
    WHERE PBSI__Cost__c > 0
  `;
  const records = await new Promise((resolve, reject) => {
    const out = [];
    conn.query(soql)
      .on('record', (r) => out.push(r))
      .on('end', () => resolve(out))
      .on('error', reject)
      .run({ autoFetch: true, maxFetch: 100_000 });
  });
  return records.map((r) => ({
    sku: r.Name,                           // PBSI Item name == our internal SKU
    cost_cad: num(r.PBSI__Cost__c),
    cost_source: 'sf-primary',
    source_detail: 'PBSI__Cost__c',
    pbsi_item_id: r.Id,
  }));
}

function upsertCost(db, row) {
  // Read current to capture as previous_cost_cad if changed
  const prev = db.prepare('SELECT cost_cad, updated_at FROM item_costs WHERE sku = ?').get(row.sku);
  const nowIso = new Date().toISOString();
  if (prev && Number(prev.cost_cad) === Number(row.cost_cad)) {
    // No change — just refresh updated_at to reflect verified-as-of
    db.prepare('UPDATE item_costs SET updated_at = ? WHERE sku = ?').run(nowIso, row.sku);
    return 'unchanged';
  }
  db.prepare(`
    INSERT INTO item_costs (
      sku, cost_cad, cost_source, source_detail, pbsi_item_id, prosol_sku,
      updated_at, previous_cost_cad, previous_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      cost_cad = excluded.cost_cad,
      cost_source = excluded.cost_source,
      source_detail = excluded.source_detail,
      pbsi_item_id = COALESCE(excluded.pbsi_item_id, item_costs.pbsi_item_id),
      prosol_sku = COALESCE(excluded.prosol_sku, item_costs.prosol_sku),
      previous_cost_cad = item_costs.cost_cad,
      previous_updated_at = item_costs.updated_at,
      updated_at = excluded.updated_at
  `).run(
    row.sku,
    row.cost_cad,
    row.cost_source,
    row.source_detail || null,
    row.pbsi_item_id || null,
    row.prosol_sku || null,
    nowIso,
    prev?.cost_cad ?? null,
    prev?.updated_at ?? null,
  );
  return prev ? 'updated' : 'inserted';
}

async function main() {
  console.log('[item-costs] loading sku-map overrides...');
  const overrides = loadSkuMapOverrides();
  console.log(`  ${overrides.length} sku-map override(s)`);

  console.log('[item-costs] loading SF PBSI__Cost__c...');
  const sfRows = await loadSfCosts();
  console.log(`  ${sfRows.length} SF item(s) with cost`);

  const db = open();

  // Override priority: sku-map wins over SF. Build a map, overrides last
  // so they overwrite the SF entry with the same SKU.
  const all = new Map();
  for (const r of sfRows) all.set(r.sku, r);
  for (const r of overrides) all.set(r.sku, r);

  let inserted = 0, updated = 0, unchanged = 0;
  try {
    tx(() => {
      for (const row of all.values()) {
        const result = upsertCost(db, row);
        if (result === 'inserted') inserted++;
        else if (result === 'updated') updated++;
        else unchanged++;
      }
    });
    setSyncState('item-costs', {
      cursor: new Date().toISOString(),
      rowsLastRun: all.size,
      status: 'ok',
    });
    console.log(`[item-costs] ✓ ${all.size} SKUs · ${inserted} inserted, ${updated} updated, ${unchanged} unchanged`);

    // Flag price hikes > 10% for margin warnings
    const hikes = db.prepare(`
      SELECT sku, cost_cad, previous_cost_cad,
             ROUND((cost_cad - previous_cost_cad) / previous_cost_cad * 100, 1) pct
      FROM item_costs
      WHERE previous_cost_cad IS NOT NULL
        AND previous_cost_cad > 0
        AND (cost_cad - previous_cost_cad) / previous_cost_cad > 0.10
      ORDER BY pct DESC
      LIMIT 20
    `).all();
    if (hikes.length) {
      console.log(`\n[item-costs] ⚠ ${hikes.length} price hike(s) >10% since last sync:`);
      for (const h of hikes) console.log(`  ${h.sku}: $${h.previous_cost_cad} → $${h.cost_cad} (+${h.pct}%)`);
    }
  } catch (e) {
    setSyncState('item-costs', { status: 'error', errorMessage: e.message.slice(0, 500) });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[item-costs] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
