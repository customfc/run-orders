/**
 * Pickup-only items (02 ProZone catalogue, PROZONE-BUILD-PLAN.md section C and D).
 *
 * Full-length Schluter profiles (8' 2-1/2" and longer) are never shipped by parcel: Canada Post refuses them and the
 * other couriers charge $90 to $270 a box. Their sku-map entries carry ship_mode: "pickup_only". An order holding one
 * must never get a label, so two places refuse it:
 *   - resolveOrderItems (run-orders.js): the order is never staged;
 *   - ensureValidShipTo (shipstation-v2.js): the last stop before every label buy (pipeline single and multi-package
 *     paths and the dashboard's manual buy), reading sku-map.json from disk so live /map edits count.
 * A pickup order never reaches either one: 01's local-order guard keeps pickup orders out of the label path.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PICKUP_ONLY = 'pickup_only';
const SKU_MAP_PATH = path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json');

function isPickupOnly(entry) {
  return !!entry && typeof entry === 'object' && entry.ship_mode === PICKUP_ONLY;
}

/** SKUs among ShipStation order items whose sku-map entry is pickup only. lookup(sku) -> entry | undefined. */
function pickupOnlySkus(items, lookup) {
  const out = [];
  for (const it of items || []) {
    const sku = it && it.sku;
    if (sku && !out.includes(sku) && isPickupOnly(lookup(sku))) out.push(sku);
  }
  return out;
}

function pickupOnlyMessage(skus) {
  return `pickup-only ${skus.length > 1 ? 'items' : 'item'} ${skus.join(', ')}: full-length profiles never ship by parcel; hold the order for pickup`;
}

// sku-map.json read from disk, re-parsed only when the file changes (it is about 1 MB).
let cache = { mtimeMs: -1, mappings: null };
function diskLookup(file = SKU_MAP_PATH) {
  const { mtimeMs } = fs.statSync(file);
  if (mtimeMs !== cache.mtimeMs || cache.file !== file) {
    cache = { file, mtimeMs, mappings: JSON.parse(fs.readFileSync(file, 'utf8')).mappings || {} };
  }
  const m = cache.mappings;
  return (sku) => m[sku];
}

/**
 * Throws an Error with code PICKUP_ONLY when the order holds a pickup-only item. A sku-map that can't be read also
 * throws (code PICKUP_ONLY_CHECK_FAILED): no label is bought on a check that didn't run.
 */
function assertNoPickupOnly(items, orderNumber, lookup = null) {
  let look = lookup;
  if (!look) {
    try { look = diskLookup(); } catch (err) {
      const e = new Error(`pickup-only check failed for ${orderNumber}: sku-map unreadable (${err.message})`);
      e.code = 'PICKUP_ONLY_CHECK_FAILED';
      throw e;
    }
  }
  const skus = pickupOnlySkus(items, look);
  if (skus.length) {
    const e = new Error(`${orderNumber}: ${pickupOnlyMessage(skus)}`);
    e.code = 'PICKUP_ONLY';
    e.skus = skus;
    throw e;
  }
}

module.exports = { PICKUP_ONLY, SKU_MAP_PATH, isPickupOnly, pickupOnlySkus, pickupOnlyMessage, diskLookup, assertNoPickupOnly };
