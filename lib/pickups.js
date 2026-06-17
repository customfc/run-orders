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
const { fetchShippedShipments, bookPickup, v2Request, CARRIER_IDS } = require('./shipstation-v2');

// Local CP pickup log — since CP pickups don't go through ShipStation V2
const CP_PICKUP_LOG = path.join(__dirname, '..', 'data', 'cp-pickups.json');

function loadCpPickups() {
  try { return JSON.parse(fs.readFileSync(CP_PICKUP_LOG, 'utf8')); } catch { return []; }
}

function saveCpPickup(pickup) {
  const pickups = loadCpPickups();
  pickups.push(pickup);
  const dir = path.dirname(CP_PICKUP_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CP_PICKUP_LOG, JSON.stringify(pickups, null, 2));
}
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

async function fetchBookedLabelIds() {
  const booked = new Set();
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await v2Request('GET', `/v2/pickups?page_size=100&page=${page}`);
    if (res.status !== 200) break;
    const data = JSON.parse(res.body);
    const pickups = data.pickups || [];
    for (const p of pickups) {
      for (const lid of (p.label_ids || [])) booked.add(lid);
    }
    hasMore = pickups.length === 100;
    page++;
  }
  return booked;
}

async function fetchLabelStatuses(trackingNumbers) {
  const statuses = new Map();
  const batchSize = 5;
  for (let i = 0; i < trackingNumbers.length; i += batchSize) {
    const batch = trackingNumbers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (tn) => {
      try {
        const res = await v2Request('GET', `/v2/labels?tracking_number=${encodeURIComponent(tn)}`);
        if (res.status !== 200) return null;
        const data = JSON.parse(res.body);
        return data.labels?.[0] ? { tn, status: data.labels[0].tracking_status || 'unknown' } : null;
      } catch { return null; }
    }));
    for (const r of results) { if (r) statuses.set(r.tn, r.status); }
  }
  return statuses;
}

async function scanShippedLabels({ days = 14 } = {}) {
  const [shipments, bookedLabels] = await Promise.all([
    fetchShippedShipments({ days }),
    fetchBookedLabelIds(),
  ]);

  // Filter out: already have pickup booked, OR V2 confirms delivered
  const trackingNums = shipments.filter(s => !bookedLabels.has(`se-${s.shipmentId}`)).map(s => s.trackingNumber).filter(Boolean);
  const trackingStatuses = await fetchLabelStatuses(trackingNums);

  const needsPickup = shipments.filter(s => {
    if (s.voided === true) return false; // voided labels can't be picked up — skip
    if (bookedLabels.has(`se-${s.shipmentId}`)) return false;
    const ts = trackingStatuses.get(s.trackingNumber);
    if (ts === 'delivered') return false;
    // Keep 'in_transit' — V2 is unreliable for this, carrier may not have actually picked up
    if (!s.orderNumber?.trim()) return false; // skip orphaned labels
    return true;
  });

  const buckets = {};
  for (const s of needsPickup) {
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
    if (result.success) {
      saveCpPickup({
        pickupId: result.pickupId,
        carrier: 'Canada Post',
        warehouse: `${loc.city} (${loc.code})`,
        warehouseId,
        pickupDate,
        labels: shipmentIds.length || 1,
        cost: result.cost,
        bookedAt: new Date().toISOString(),
      });
    }
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

  let labelIds = shipmentIds.map(id => `se-${id}`);

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

  // Book the pickup. ShipStation V2 rejects the WHOLE batch when ANY label is
  // already bound to a prior (often spent/un-released) pickup — error_code
  // 'invalid_status' / "Label(s) already scheduled for pickup". One poisoned
  // label used to jam an entire warehouse×carrier queue for days, stranding every
  // other parcel behind it (Concord/UPS, 2026-06: 7 boxes unscanned ~1wk).
  // Self-heal: drop the cited already-bound label(s) and retry so the UNBOUND
  // labels still book. Dropping a label from the REQUEST never strands its box —
  // a carrier pickup is address-based, so the driver collects everything staged
  // at the warehouse regardless of which labels rode the request. We never cancel
  // the existing binding here (that's auto-rebooker's job, gated + order-aware).
  let result;
  let errorCode = null;
  let errorMessage = null;
  let errorLabelId = null;
  const droppedLabelIds = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    result = await bookPickup({
      carrierId,
      labelIds,
      pickupDate,
      warehouseAddress,
      warehouseProvince: loc?.province || 'ON',
      contactName: loc ? `Prosol ${loc.city}` : 'Warehouse',
      pickupNotes,
      pickupWindow: loc?.pickup_window,
    });

    // Parse ShipStation V2's error envelope so callers get the real failure
    // reason instead of "HTTP 400". V2 returns { errors: [{error_source,
    // error_type, error_code, message, field_name?, label_id?, labels?}] }.
    errorCode = null; errorMessage = null; errorLabelId = null;
    if (result.success) break;
    let parsed = {};
    try { parsed = JSON.parse(result.body); } catch { /* not JSON — raw body still in result.body */ }
    const errs = Array.isArray(parsed.errors) ? parsed.errors : [];
    const first = errs[0] || null;
    if (first) {
      errorCode = first.error_code || null;
      errorMessage = first.message || null;
      errorLabelId = first.label_id || null;
    }

    // Only retry the "already-bound label poisons the batch" case.
    const alreadyBound = errorCode === 'invalid_status'
      || /already (been )?scheduled|already been completed/i.test(result.body || '');
    if (!alreadyBound) break;
    const cited = new Set();
    for (const e of errs) for (const l of (e.labels || [])) if (l.label_id) cited.add(String(l.label_id).replace(/^se-/, ''));
    if (errorLabelId) cited.add(String(errorLabelId).replace(/^se-/, ''));
    if (!cited.size) break; // can't tell which label is bound — report stuck
    const before = labelIds.length;
    labelIds = labelIds.filter((lid) => !cited.has(lid.replace(/^se-/, '')));
    for (const c of cited) if (!droppedLabelIds.includes(c)) droppedLabelIds.push(c);
    if (labelIds.length === before || labelIds.length === 0) break; // nothing droppable / all bound
  }

  return {
    ...result,
    errorCode,
    errorMessage,
    errorLabelId,
    droppedLabelIds,
    carrier: carrierKey.replace('_walleted', ''),
    warehouseId,
    warehouseName: loc ? `${loc.city} (${loc.code})` : warehouseId,
    pickupDate,
    labelCount: labelIds.length,
  };
}

module.exports = { scanShippedLabels, bookPickupForBucket, listLocations, loadCpPickups, TREECO_VANCOUVER };
