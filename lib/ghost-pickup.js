/**
 * Ghost pickup — trigger a carrier visit to a fringe warehouse without
 * a real shippable package. Buy a minimal label, book a pickup with it
 * attached, then void the label after the pickup window closes so the
 * wallet is refunded. Net cost: $0.
 *
 * Use case: a stuck label at a fringe warehouse (e.g. LOND) where V2 says
 * the prior pickup is "already completed" and won't let us re-attach the
 * stuck label to a new pickup. By booking a fresh pickup with a ghost
 * label, UPS/Purolator dispatches a driver to the warehouse, and per
 * Mac's ops reality ("driver grabs everything at the desk") the stuck
 * physical package rides along.
 *
 * Only UPS and Purolator need this trick. Canada Post pickups are
 * location-based (no label_ids required), so a fresh CP pickup booking
 * at the warehouse trivially solves the same problem.
 */

const fs = require('fs');
const path = require('path');
const audit = require('./audit');
const telegram = require('./telegram');
const { v1Request, bookPickup, CARRIER_IDS } = require('./shipstation-v2');

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'), 'utf8')
);

const PENDING_VOIDS = path.join(__dirname, '..', 'data', 'ghost-voids.json');

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_VOIDS, 'utf8')); } catch { return []; }
}
function savePending(list) {
  const dir = path.dirname(PENDING_VOIDS);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PENDING_VOIDS, JSON.stringify(list, null, 2));
}

function findWarehouse(code) {
  for (const loc of Object.values(LOCATION_MAP)) {
    if (loc.code === code) return loc;
  }
  return null;
}

function getGhostShipTo() {
  return {
    name: process.env.GHOST_SHIP_TO_NAME || 'Mac Roy',
    street1: process.env.GHOST_SHIP_TO_STREET1,
    street2: process.env.GHOST_SHIP_TO_STREET2 || '',
    city: process.env.GHOST_SHIP_TO_CITY,
    state: process.env.GHOST_SHIP_TO_STATE,
    postalCode: (process.env.GHOST_SHIP_TO_POSTAL || '').replace(/\s/g, ''),
    country: process.env.GHOST_SHIP_TO_COUNTRY || 'CA',
    phone: process.env.GHOST_SHIP_TO_PHONE || '6048853582',
    residential: true,
  };
}

function nextBusinessDay(from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Service codes known to exist + cheap for ghosts
const GHOST_SERVICE = {
  ups:       { v1Carrier: 'ups_walleted',       serviceCode: 'ups_standard' },
  purolator: { v1Carrier: 'purolator_walleted', serviceCode: 'purolator_ground' },
};

/**
 * Create a ghost pickup for a fringe warehouse.
 * @returns {Promise<{success:bool, pickupId?, confirmation?, trackingNumber?, pickupDate?, voidAfter?, labelCost?, error?}>}
 */
async function createGhostPickup({ warehouseCode, carrier }) {
  const loc = findWarehouse(warehouseCode);
  if (!loc) return { success: false, error: `Unknown warehouse code: ${warehouseCode}` };
  const svc = GHOST_SERVICE[carrier];
  if (!svc) return { success: false, error: `Ghost pickup not supported for ${carrier} (try ups or purolator)` };

  const shipTo = getGhostShipTo();
  if (!shipTo.street1 || !shipTo.city || !shipTo.state || !shipTo.postalCode) {
    return { success: false, error: 'GHOST_SHIP_TO_* env vars not set' };
  }

  const shipFrom = {
    name: `Prosol ${loc.city}`,
    company: 'Prosol Inc.',
    street1: loc.address,
    city: loc.city,
    state: loc.province,
    postalCode: (loc.postal_code || '').replace(/\s/g, ''),
    country: 'CA',
    phone: (Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone) || '514-745-1212',
  };

  const pickupDate = nextBusinessDay();

  // Step 1: create the minimal label
  const labelPayload = {
    carrierCode: svc.v1Carrier,
    serviceCode: svc.serviceCode,
    packageCode: 'package',
    confirmation: 'none',
    shipDate: new Date().toISOString().slice(0, 10),
    weight: { value: 1, units: 'pounds' },
    shipFrom,
    shipTo,
    testLabel: false,
  };
  const labelRes = await v1Request('POST', '/shipments/createlabel', labelPayload);
  if (labelRes.status !== 200) {
    return { success: false, step: 'create-label', error: `HTTP ${labelRes.status}: ${labelRes.body.slice(0, 250)}` };
  }
  const labelData = JSON.parse(labelRes.body);
  const ghostShipmentId = labelData.shipmentId;
  const ghostTracking = labelData.trackingNumber;
  const labelCost = labelData.shipmentCost;

  // Step 2: book the pickup with the ghost label attached
  const carrierId = CARRIER_IDS[svc.v1Carrier];
  const purolatorAddress = carrier === 'purolator' ? {
    name: shipFrom.name,
    phone: shipFrom.phone,
    company_name: 'Prosol Inc.',
    address_line1: shipFrom.street1,
    city_locality: shipFrom.city,
    state_province: shipFrom.state,
    postal_code: shipFrom.postalCode,
    country_code: 'CA',
    address_residential_indicator: 'no',
  } : null;

  const pickupRes = await bookPickup({
    carrierId,
    labelIds: [`se-${ghostShipmentId}`],
    pickupDate,
    warehouseAddress: purolatorAddress,
    warehouseProvince: loc.province,
    contactName: `Prosol ${loc.city}`,
    pickupNotes: carrier === 'purolator' ? 'FrontDesk' : null,
    pickupWindow: loc.pickup_window,
  });

  if (!pickupRes.success) {
    // Undo label purchase — void immediately to refund
    await v1Request('POST', '/shipments/voidlabel', { shipmentId: ghostShipmentId });
    return { success: false, step: 'book-pickup', error: pickupRes.error || pickupRes.body?.slice(0, 250), refunded: true };
  }

  // Step 3: record for later auto-void (after pickup window closes so UPS doesn't cancel the pickup)
  const voidAfter = new Date();
  voidAfter.setDate(voidAfter.getDate() + 2); // void on day after pickup
  voidAfter.setHours(12, 0, 0, 0);

  const pending = loadPending();
  pending.push({
    shipmentId: ghostShipmentId,
    labelId: `se-${ghostShipmentId}`,
    trackingNumber: ghostTracking,
    pickupId: pickupRes.pickupId,
    confirmation: pickupRes.confirmation,
    warehouseCode,
    carrier,
    pickupDate,
    labelCost,
    voidAfter: voidAfter.toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
  });
  savePending(pending);

  audit.log({
    action: 'ghost-pickup-create',
    warehouseCode, carrier,
    pickupId: pickupRes.pickupId,
    trackingNumber: ghostTracking,
    labelCost,
    pickupDate,
    voidAfter: voidAfter.toISOString(),
    success: true,
  });

  return {
    success: true,
    pickupId: pickupRes.pickupId,
    confirmation: pickupRes.confirmation,
    trackingNumber: ghostTracking,
    pickupDate,
    voidAfter: voidAfter.toISOString(),
    labelCost,
  };
}

/**
 * Walk the pending voids file; for any entry whose voidAfter <= now, attempt
 * to void via V1 voidlabel. On success, mark as voided (remove from file).
 * Called by daily cron.
 */
async function processPendingVoids() {
  const pending = loadPending();
  if (!pending.length) return { attempted: 0, voided: 0, remaining: 0 };
  const now = new Date();
  const still = [];
  let voided = 0;
  let attempted = 0;
  for (const entry of pending) {
    if (entry.status !== 'pending') continue;
    if (new Date(entry.voidAfter) > now) {
      still.push(entry);
      continue;
    }
    attempted++;
    try {
      const res = await v1Request('POST', '/shipments/voidlabel', { shipmentId: entry.shipmentId });
      const data = res.status === 200 ? JSON.parse(res.body) : null;
      if (data?.approved) {
        voided++;
        audit.log({ action: 'ghost-pickup-void', shipmentId: entry.shipmentId, trackingNumber: entry.trackingNumber, success: true, refundedCost: entry.labelCost });
      } else {
        // Keep in file; try again next day
        still.push(entry);
        audit.log({ action: 'ghost-pickup-void', shipmentId: entry.shipmentId, success: false, error: data?.message || res.body.slice(0, 200) });
      }
    } catch (err) {
      still.push(entry);
      audit.log({ action: 'ghost-pickup-void', shipmentId: entry.shipmentId, success: false, error: err.message });
    }
  }
  savePending(still);

  if (voided > 0) {
    const refunded = pending.filter((e) => !still.find((s) => s.shipmentId === e.shipmentId)).reduce((sum, e) => sum + (Number(e.labelCost) || 0), 0);
    await telegram.notify('ok', `Ghost labels voided: ${voided}`, `Refunded ~$${refunded.toFixed(2)} to the wallet.`);
  }
  return { attempted, voided, remaining: still.length };
}

module.exports = { createGhostPickup, processPendingVoids, loadPending };
