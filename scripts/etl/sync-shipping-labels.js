#!/usr/bin/env node
/**
 * ShipStation outbound label ETL — data/ops-state/*.json → shipping_labels.
 *
 * For every FBM order (Amazon MFN + Shopify) we ship ourselves, we buy a
 * ShipStation label. That's a real cost against the order's margin.
 * ops-state captures every label we buy in state.phases.buy.labels with
 * orderNumber, labelCost, carrierCode, tracking, packages[].items[].
 *
 * Idempotent upsert by shipment_id (ShipStation's unique ID per label).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { open, setSyncState, tx } = require('../../lib/analytics-db');

const OPS_STATE_DIR = path.join(__dirname, '..', '..', 'data', 'ops-state');

function classifyChannel(orderNumber) {
  if (!orderNumber) return null;
  // Amazon order IDs are XXX-XXXXXXX-XXXXXXX (7+7 digits)
  if (/^\d{3}-\d{7}-\d{7}$/.test(orderNumber)) return 'amazon-mfn';
  // Shopify order names are usually numeric or #<numeric>
  if (/^#?\d+$/.test(orderNumber)) return 'shopify';
  return 'unknown';
}

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null ? null : String(v); }

async function main() {
  if (!fs.existsSync(OPS_STATE_DIR)) {
    console.log('[shipping-labels] no ops-state dir — nothing to do');
    return;
  }
  const files = fs.readdirSync(OPS_STATE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) {
    console.log('[shipping-labels] no daily state files');
    return;
  }
  console.log(`[shipping-labels] scanning ${files.length} daily state file(s)`);

  const db = open();
  let totalLabels = 0;
  let totalItems = 0;
  let totalCost = 0;

  tx(() => {
    const insLabel = db.prepare(`
      INSERT INTO shipping_labels (
        shipment_id, order_number, channel, tracking_number,
        label_cost_cad, estimated_cost_cad, carrier_code, service_code,
        warehouse_id, purchased_at, raw, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shipment_id) DO UPDATE SET
        order_number = excluded.order_number,
        channel = excluded.channel,
        tracking_number = excluded.tracking_number,
        label_cost_cad = excluded.label_cost_cad,
        estimated_cost_cad = excluded.estimated_cost_cad,
        carrier_code = excluded.carrier_code,
        service_code = excluded.service_code,
        warehouse_id = excluded.warehouse_id,
        purchased_at = excluded.purchased_at,
        raw = excluded.raw,
        ingested_at = excluded.ingested_at
    `);
    const insItem = db.prepare(`
      INSERT INTO shipping_label_items (shipment_id, sku, name, qty, raw)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const f of files) {
      let state;
      try { state = JSON.parse(fs.readFileSync(path.join(OPS_STATE_DIR, f), 'utf8')); }
      catch { continue; }
      const labels = state.phases?.buy?.labels || {};
      // Pre-clear existing shipment_items per shipment we're about to
      // re-insert (the top-level upsert handles the label row, but items
      // are append-only otherwise).
      for (const [key, lbl] of Object.entries(labels)) {
        const shipmentId = String(lbl.shipmentId ?? key);
        if (!lbl.labelCost) continue;
        insLabel.run(
          shipmentId,
          str(lbl.orderNumber),
          classifyChannel(lbl.orderNumber),
          str(lbl.trackingNumber),
          num(lbl.labelCost) || 0,
          num(lbl.estimatedCost),
          str(lbl.carrierCode),
          str(lbl.serviceCode),
          num(lbl.warehouseId),
          str(lbl.at) || state.startedAt || `${state.date}T00:00:00Z`,
          JSON.stringify(lbl),
          new Date().toISOString(),
        );
        totalLabels++;
        totalCost += Number(lbl.labelCost) || 0;
        // Clear + re-insert items
        db.prepare('DELETE FROM shipping_label_items WHERE shipment_id = ?').run(shipmentId);
        for (const pkg of (lbl.packages || [])) {
          for (const it of (pkg.items || [])) {
            insItem.run(
              shipmentId,
              str(it.sku),
              str(it.name),
              num(it.quantity),
              JSON.stringify(it),
            );
            totalItems++;
          }
        }
      }
    }
  });

  setSyncState('shipping-labels', {
    cursor: new Date().toISOString().slice(0, 10),
    rowsLastRun: totalLabels,
    status: 'ok',
  });
  console.log(`[shipping-labels] ✓ ${totalLabels} labels, ${totalItems} line items, $${totalCost.toFixed(2)} total cost`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[shipping-labels] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
