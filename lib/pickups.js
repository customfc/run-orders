/**
 * Pickup booking orchestrator.
 * Groups shipped labels by warehouse + carrier, books pickups.
 *
 * Known quirks:
 * - Purolator MUST include pickup_address and pickup_notes (e.g. "FrontDesk")
 * - Canada Post may reject same-day; retry for next business day
 * - UPS confirmation emails work; Purolator may not email even on success
 */

const path = require('path');
const fs = require('fs');
const { fetchShippedShipments, bookPickup, CARRIER_IDS } = require('./shipstation-v2');
const { bookCpPickup, listLocations } = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'book-cp-pickup'));

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'), 'utf8')
);

// Reverse lookup: ShipStation warehouse ID → location info
const WAREHOUSE_BY_SS_ID = {};
for (const [prosolId, loc] of Object.entries(LOCATION_MAP)) {
  if (loc.shipstation_warehouse_id) {
    WAREHOUSE_BY_SS_ID[String(loc.shipstation_warehouse_id)] = { ...loc, prosolId };
  }
}

// TREECO Vancouver — known non-Prosol pickup address
const TREECO_VANCOUVER = {
  name: 'TREECO - VANCOUVER',
  address_line1: '1230 Cliveden Ave',
  city_locality: 'Delta',
  state_province: 'BC',
  postal_code: 'V3M 6Y1',
  country_code: 'CA',
  phone: '6045232235',
};

function nextBusinessDay(fromDate) {
  const d = fromDate ? new Date(fromDate) : new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function todayOrNextBizDay() {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  if (etNow.getHours() < 14 && etNow.getDay() !== 0 && etNow.getDay() !== 6) {
    return etNow.toISOString().slice(0, 10);
  }
  return nextBusinessDay(etNow);
}

// ── Scan & group shipped labels ──────────────────────────────────────────────

async function scanShippedLabels({ days = 7 } = {}) {
  const shipments = await fetchShippedShipments({ days });

  const buckets = {};
  for (const s of shipments) {
    const warehouseId = String(s.advancedOptions?.warehouseId || s.warehouseId || 'unknown');
    const carrier = s.carrierCode || 'unknown';
    const key = `${warehouseId}::${carrier}`;

    if (!buckets[key]) {
      const loc = WAREHOUSE_BY_SS_ID[warehouseId];
      buckets[key] = {
        warehouseId,
        warehouseName: loc ? `${loc.city} (${loc.code})` : `Warehouse ${warehouseId}`,
        warehouseCode: loc?.code || null,
        carrier,
        carrierDisplay: carrier.replace('_walleted', '').replace(/_/g, ' '),
        shipments: [],
      };
    }
    buckets[key].shipments.push({
      shipmentId: s.shipmentId,
      orderNumber: s.orderNumber,
      trackingNumber: s.trackingNumber,
      shipDate: s.shipDate,
      shipTo: s.shipTo?.name || '',
      shipToCity: s.shipTo?.city || '',
    });
  }

  return Object.values(buckets).sort((a, b) => a.warehouseName.localeCompare(b.warehouseName));
}

// ── Book pickup for a bucket ─────────────────────────────────────────────────

async function bookPickupForBucket({ warehouseId, carrier, pickupDate, shipmentIds }) {
  if (!pickupDate) pickupDate = todayOrNextBizDay();

  const loc = WAREHOUSE_BY_SS_ID[warehouseId];

  // Canada Post — use existing CP pickup script
  if (carrier === 'canada_post_walleted' || carrier === 'canada_post') {
    if (!loc?.code) {
      return { success: false, error: `No location code for warehouse ${warehouseId} — cannot book CP pickup` };
    }
    const result = await bookCpPickup({
      locationCode: loc.code,
      date: pickupDate,
      boxes: shipmentIds.length || 1,
    });
    return {
      ...result,
      carrier: 'canada_post',
      warehouseId,
      warehouseName: loc ? `${loc.city} (${loc.code})` : warehouseId,
      pickupDate,
    };
  }

  // UPS or Purolator — ShipStation V2
  const carrierKey = carrier.endsWith('_walleted') ? carrier : `${carrier}_walleted`;
  const carrierId = CARRIER_IDS[carrierKey];
  if (!carrierId) {
    return { success: false, error: `Unknown carrier for V2 pickup: ${carrier}` };
  }

  const labelIds = shipmentIds.map(id => `se-${id}`);

  // Build pickup address for Purolator (required)
  let warehouseAddress = null;
  let pickupNotes = null;

  if (carrierKey === 'purolator_walleted') {
    // Check for TREECO warehouse
    if (warehouseId === '147654' || loc?.code === 'SECH') {
      // Sechelt — not TREECO, use loc address
    }

    if (loc) {
      warehouseAddress = {
        name: `Prosol ${loc.city}`,
        address_line1: loc.address,
        city_locality: loc.city,
        state_province: loc.province,
        postal_code: (loc.postal_code || '').replace(/\s/g, ''),
        country_code: 'CA',
        phone: (Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone) || '514-745-1212',
      };
    }
    pickupNotes = 'FrontDesk';
  }

  const result = await bookPickup({
    carrierId,
    labelIds,
    pickupDate,
    warehouseAddress,
    contactName: loc ? `Prosol ${loc.city}` : 'Warehouse',
    pickupNotes,
  });

  return {
    ...result,
    carrier: carrierKey.replace('_walleted', ''),
    warehouseId,
    warehouseName: loc ? `${loc.city} (${loc.code})` : warehouseId,
    pickupDate,
    labelCount: labelIds.length,
  };
}

module.exports = { scanShippedLabels, bookPickupForBucket, listLocations, TREECO_VANCOUVER };
