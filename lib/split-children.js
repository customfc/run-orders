/**
 * Split-child resolver — give a multi-package child shipment its parent back.
 *
 * When the pipeline buys a label for a multi-box order, ShipStation returns one
 * shipment per box. Every box after the first comes back from the API with a
 * BLANK orderNumber and a phantom warehouseId that exists in neither the v1 nor
 * v2 warehouse list (1947192, 1956772, 1942731, 1933430, 1941886, 1956771 so
 * far). Both fields are load-bearing:
 *
 *   - pickups.scanShippedLabels drops any shipment with a blank orderNumber
 *     ("skip orphaned labels"), so the box is never offered for collection.
 *   - stale-parcel-reminder needs a warehouseId that resolves to a Prosol
 *     branch, so an unmapped origin is skipped and nobody chases the branch.
 *   - auto-rebooker's classifyOrder can't look up a blank order, so it skips.
 *   - Only the first tracking number gets pushed back to Amazon, so the buyer
 *     sees a partial shipment (DeBlois, 701-4387228-0916238: three rolls
 *     delivered 2026-08-03, two invisible, buyer opened a return believing the
 *     order was incomplete).
 *
 * Every stranded parcel in the week of 2026-08-10 was a split child: the
 * Saint-Bruno thermostat, the Richmond roll, Elvin Kao's three Downsview rolls.
 *
 * stale-tracker already tried to repair this by calling GET /orders/{orderId}.
 * That cannot work — the phantom child order 404s (verified on 768450010 and
 * 768450044). The authoritative record is our own: at buy time the pipeline
 * writes the parent's orderNumber and REAL warehouseId to ops-state alongside
 * every package's shipmentId and trackingNumber. This reads that back.
 *
 * Nothing is inferred. A child we have no buy record for stays unresolved
 * rather than being guessed at from address or timing.
 */

const fs = require('fs');
const path = require('path');

const OPS_DIR = path.join(__dirname, '..', 'data', 'ops-state');

let _cache = null;      // { byTracking, byShipmentId, builtAt, signature }

/** Cheap change-detector so a long-lived server picks up today's buys. */
function opsSignature() {
  try {
    return fs.readdirSync(OPS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => { try { const st = fs.statSync(path.join(OPS_DIR, f)); return `${f}:${st.mtimeMs}`; } catch { return f; } })
      .join('|');
  } catch { return ''; }
}

function buildIndex() {
  const byTracking = new Map();
  const byShipmentId = new Map();
  let files = [];
  try { files = fs.readdirSync(OPS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch { return { byTracking, byShipmentId }; }

  for (const f of files) {
    let day;
    try { day = JSON.parse(fs.readFileSync(path.join(OPS_DIR, f), 'utf8')); } catch { continue; }
    const labels = (day.phases && day.phases.buy && day.phases.buy.labels) || {};
    for (const orderId of Object.keys(labels)) {
      const l = labels[orderId];
      if (!l || !l.orderNumber) continue;
      const parent = {
        orderNumber: String(l.orderNumber),
        orderId: Number(orderId) || l.orderId || null,
        warehouseId: l.warehouseId != null ? String(l.warehouseId) : null,
        source: l.source || null,
        parentTracking: l.trackingNumber || null,
        packageCount: Array.isArray(l.packages) ? l.packages.length : 1,
      };
      // The parent's own shipment plus every package. Recording all of them
      // means a single-box order resolves too, which makes callers simpler.
      const pkgs = Array.isArray(l.packages) && l.packages.length ? l.packages : [{ shipmentId: l.shipmentId, trackingNumber: l.trackingNumber }];
      for (const p of pkgs) {
        if (p.trackingNumber) byTracking.set(String(p.trackingNumber), parent);
        if (p.shipmentId) byShipmentId.set(String(p.shipmentId), parent);
      }
    }
  }
  return { byTracking, byShipmentId };
}

function index() {
  const sig = opsSignature();
  if (!_cache || _cache.signature !== sig) {
    const built = buildIndex();
    _cache = { ...built, signature: sig, builtAt: Date.now() };
  }
  return _cache;
}

/**
 * Look up a shipment's parent. Accepts either a raw shipment object or
 * { trackingNumber, shipmentId }. Returns the parent record or null.
 */
function resolve(shipment = {}) {
  const { byTracking, byShipmentId } = index();
  const tn = shipment.trackingNumber != null ? String(shipment.trackingNumber) : null;
  const sid = shipment.shipmentId != null ? String(shipment.shipmentId) : null;
  return (tn && byTracking.get(tn)) || (sid && byShipmentId.get(sid)) || null;
}

/**
 * Repair a list of shipments in place: fill a blank orderNumber, and replace a
 * warehouseId that isn't a real branch. Returns a summary for logging so a
 * silent no-op is visible.
 *
 * knownWarehouseIds lets the caller decide what "real" means (pickups and the
 * reminder both hold a Prosol warehouse map). Omit it to only repair the
 * order number and leave warehouseId untouched.
 */
function repair(shipments, { knownWarehouseIds = null } = {}) {
  let orderFixed = 0;
  let warehouseFixed = 0;
  let unresolved = 0;
  for (const s of shipments || []) {
    const blankOrder = !String(s.orderNumber || '').trim();
    const whId = s.warehouseId != null ? String(s.warehouseId) : null;
    const phantomWh = knownWarehouseIds && whId && !knownWarehouseIds.has(whId);
    if (!blankOrder && !phantomWh) continue;

    const parent = resolve(s);
    if (!parent) { if (blankOrder) unresolved++; continue; }

    if (blankOrder && parent.orderNumber) { s.orderNumber = parent.orderNumber; s.splitChildOf = parent.parentTracking; orderFixed++; }
    if (phantomWh && parent.warehouseId && (!knownWarehouseIds || knownWarehouseIds.has(parent.warehouseId))) {
      s.phantomWarehouseId = whId;
      s.warehouseId = parent.warehouseId;
      // Callers read advancedOptions.warehouseId FIRST and fall back to the
      // top-level field (pickups.js groups buckets that way), so repairing only
      // one of the two leaves the phantom winning wherever the nested field
      // happens to be populated.
      if (s.advancedOptions && s.advancedOptions.warehouseId != null) {
        s.advancedOptions = { ...s.advancedOptions, warehouseId: parent.warehouseId };
      }
      warehouseFixed++;
    }
  }
  return { orderFixed, warehouseFixed, unresolved };
}

module.exports = { resolve, repair, buildIndex, index };
