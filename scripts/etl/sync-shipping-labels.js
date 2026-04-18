#!/usr/bin/env node
/**
 * ShipStation label-cost ETL — authoritative source via V1 /shipments.
 *
 * Every label ever purchased (FBM: Amazon MFN + Shopify + manual orders +
 * FBA inbound) is in ShipStation's shipments endpoint with its exact cost.
 * This replaces the prior ops-state-based ETL which only retained a few
 * days of history locally.
 *
 * Response fields we care about:
 *   shipmentId          — stable unique id (PK)
 *   orderNumber         — Amazon MSKU order id, Shopify order name, or internal
 *   createDate          — when the label was purchased (what we bill against)
 *   shipDate            — when carrier was scheduled to pick up
 *   shipmentCost        — the label cost ← this is what we pay
 *   insuranceCost       — ShipSurance add-on if any
 *   carrierCode, serviceCode, packageCode
 *   warehouseId         — source (Sechelt / Prosol / etc)
 *   voided              — true = we refunded, cost=0
 *   voidDate
 *   shipmentItems[]     — { sku, name, quantity, unitPrice, imageUrl }
 *
 * Rate limit: 40 req/min on V1. With pageSize=500 we pull ~20K shipments/min
 * with comfortable headroom.
 *
 * Modes:
 *   --backfill                 — all shipments, from SHIPSTATION_BACKFILL_DAYS
 *                                (default 730d) ago
 *   --from <YYYY-MM-DD>        — shipDateStart = from
 *   (default)                  — delta since etl_sync_state['shipstation-labels'].cursor,
 *                                or last 14d if no cursor
 */

require('dotenv').config();
const { v1Request } = require('../../lib/shipstation-v2');
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

function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return isoDay(d); }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null ? null : String(v); }

function classifyChannel(orderNumber, orderKey) {
  if (!orderNumber) return null;
  const s = String(orderNumber);
  // Amazon order format: XXX-XXXXXXX-XXXXXXX
  if (/^\d{3}-\d{7}-\d{7}$/.test(s)) return 'amazon-mfn';
  // Numeric-only (4-10 digit) → Shopify/manual order name
  if (/^#?\d{3,10}$/.test(s)) return 'shopify';
  // FBA inbound shipment IDs are often "FBA..." prefixed
  if (/^FBA/.test(s)) return 'amazon-fba-inbound';
  return 'unknown';
}

async function fetchShipmentsPage({ shipDateStart, shipDateEnd, page = 1, pageSize = 500, includeShipmentItems = true }) {
  const params = new URLSearchParams();
  if (shipDateStart) params.set('shipDateStart', shipDateStart);
  if (shipDateEnd) params.set('shipDateEnd', shipDateEnd);
  params.set('pageSize', String(pageSize));
  params.set('page', String(page));
  if (includeShipmentItems) params.set('includeShipmentItems', 'true');
  const res = await v1Request('GET', `/shipments?${params}`);
  if (res.status !== 200) {
    throw new Error(`ShipStation /shipments HTTP ${res.status} — ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body);
}

async function main() {
  const args = parseArgs();
  let shipDateStart = null;
  let mode = 'delta';

  if (args.backfill) {
    const days = Number(process.env.SHIPSTATION_BACKFILL_DAYS) || 730;
    shipDateStart = daysAgo(days);
    mode = `backfill ${days}d (${shipDateStart} →)`;
  } else if (args.from) {
    shipDateStart = args.from;
    mode = `from ${args.from}`;
  } else {
    const state = getSyncState('shipstation-labels');
    // Slide back 3 days from last cursor to catch any late-voided shipments
    // whose state changed after our last pull.
    if (state?.cursor) {
      const d = new Date(state.cursor + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 3);
      shipDateStart = isoDay(d);
      mode = `delta from ${shipDateStart}`;
    } else {
      shipDateStart = daysAgo(14);
      mode = `first-run last 14d`;
    }
  }

  console.log(`[shipstation-labels] mode: ${mode}`);
  const db = open();

  // Prepared statements
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
  const delItems = db.prepare('DELETE FROM shipping_label_items WHERE shipment_id = ?');
  const insItem = db.prepare(`
    INSERT INTO shipping_label_items (shipment_id, sku, name, qty, raw)
    VALUES (?, ?, ?, ?, ?)
  `);

  let page = 1;
  let totalLabels = 0;
  let totalItems = 0;
  let totalCost = 0;
  let voidedCount = 0;
  let pagesDone = 0;
  let pages = 1;
  const startedAt = new Date().toISOString();

  try {
    do {
      const data = await fetchShipmentsPage({ shipDateStart, page, pageSize: 500 });
      const shipments = data.shipments || [];
      pages = data.pages || 1;
      console.log(`[shipstation-labels] page ${page}/${pages} — ${shipments.length} shipments`);

      tx(() => {
        for (const s of shipments) {
          const shipmentId = String(s.shipmentId);
          const orderNumber = str(s.orderNumber) || str(s.orderKey);
          // Voided labels are refunded — record with cost=0 but keep the
          // row so we know it existed.
          const labelCost = s.voided ? 0 : (num(s.shipmentCost) || 0);
          const insurance = s.voided ? 0 : (num(s.insuranceCost) || 0);
          const totalShipmentCost = labelCost + insurance;
          if (s.voided) voidedCount++;

          insLabel.run(
            shipmentId,
            orderNumber,
            classifyChannel(orderNumber, s.orderKey),
            str(s.trackingNumber),
            totalShipmentCost,
            num(s.estimatedCost ?? s.shipmentCost),
            str(s.carrierCode),
            str(s.serviceCode),
            num(s.warehouseId),
            str(s.createDate),
            JSON.stringify(s),
            new Date().toISOString(),
          );
          totalLabels++;
          totalCost += totalShipmentCost;

          delItems.run(shipmentId);
          for (const it of (s.shipmentItems || [])) {
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
      });

      pagesDone++;
      // V1 rate limit = 40/min = sleep 1.5s between pages is safe
      if (page < pages) await new Promise((r) => setTimeout(r, 1600));
      page++;
    } while (page <= pages);

    const cursorDate = new Date().toISOString().slice(0, 10);
    setSyncState('shipstation-labels', {
      cursor: cursorDate,
      rowsLastRun: totalLabels,
      status: 'ok',
    });
    console.log(`[shipstation-labels] ✓ ${totalLabels} labels, ${totalItems} line items, $${totalCost.toFixed(2)} total cost (${voidedCount} voided)`);
    console.log(`[shipstation-labels] started ${startedAt} → cursor ${cursorDate}`);
  } catch (e) {
    setSyncState('shipstation-labels', { rowsLastRun: totalLabels, status: 'error', errorMessage: e.message.slice(0, 500) });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[shipstation-labels] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
