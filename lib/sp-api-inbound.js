/**
 * Amazon SP-API Fulfillment Inbound v2024-03-20 wrapper.
 *
 * The new "Send to Amazon" workflow (replaces legacy Inbound v0).
 *
 * Multi-step state machine. Typical flow:
 *   1. createInboundPlan         → inboundPlanId (immediate)
 *   2. generatePackingOptions    → operationId (async)
 *   3. getOperation              → poll until SUCCESS
 *   4. listPackingOptions        → pick one
 *   5. confirmPackingOption      → operationId → poll
 *   6. generatePlacementOptions  → operationId → poll
 *   7. listPlacementOptions      → pick one (locks destination FCs)
 *   8. confirmPlacementOption    → operationId → poll
 *   9. generateTransportationOptions → operationId → poll
 *  10. listTransportationOptions → pick partnered carrier or own
 *  11. confirmTransportationOptions → operationId → poll
 *  12. generateShipmentContentUpdatePreviews (optional)
 *  13. listShipments
 *  14. (per shipment) generateLabels → operationId → poll
 *  15. getLabels                  → signed URL for FNSKU + box labels PDF
 *  16. confirmShipment            → final
 *
 * Every "generate*" call is async → returns operationId; poll /operations/{id}
 * until status is SUCCESS (or FAILED), then call list*.
 */

const { spApiRequest } = require('./sp-api');

const BASE = '/inbound/fba/2024-03-20';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60_000; // 5 min per operation

// ── Helpers ─────────────────────────────────────────────────────────────────

async function _request(method, endpoint, body) {
  const res = await spApiRequest(method, endpoint, body ? { body } : {});
  if (res.status === 200 || res.status === 202) {
    return res.body ? JSON.parse(res.body) : {};
  }
  const err = new Error(`Inbound API ${method} ${endpoint}: ${res.status} — ${res.body.slice(0, 400)}`);
  err.status = res.status;
  err.body = res.body;
  try { err.parsed = JSON.parse(res.body); } catch {}
  throw err;
}

// ── Operation polling ──────────────────────────────────────────────────────

async function getOperation(operationId) {
  return _request('GET', `${BASE}/operations/${operationId}`);
}

async function waitForOperation(operationId, { onPoll } = {}) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const op = await getOperation(operationId);
    if (onPoll) onPoll(op);
    if (op.operationStatus === 'SUCCESS') return op;
    if (op.operationStatus === 'FAILED') {
      const err = new Error(`Operation ${operationId} FAILED: ${JSON.stringify(op.operationProblems || []).slice(0, 400)}`);
      err.operation = op;
      throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Operation ${operationId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ── Create plan ─────────────────────────────────────────────────────────────
//
// items: [{ msku, quantity, prepOwner?, labelOwner?, expiration?, ... }]
// sourceAddress: { name, addressLine1, addressLine2?, city, stateOrProvinceCode,
//                  countryCode, postalCode, companyName?, email?, phoneNumber? }

async function createInboundPlan({ name, sourceAddress, destinationMarketplaces, items }) {
  const body = {
    name,
    sourceAddress,
    destinationMarketplaces: destinationMarketplaces || [process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '')],
    items: items.map((it) => ({
      msku: it.msku,
      quantity: it.quantity,
      ...(it.prepOwner ? { prepOwner: it.prepOwner } : {}),
      ...(it.labelOwner ? { labelOwner: it.labelOwner } : {}),
      ...(it.expiration ? { expiration: it.expiration } : {}),
    })),
  };
  return _request('POST', `${BASE}/inboundPlans`, body);
}

async function getInboundPlan(inboundPlanId) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}`);
}

// ── Packing options ─────────────────────────────────────────────────────────

async function generatePackingOptions(inboundPlanId) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/packingOptions`, {});
}

async function listPackingOptions(inboundPlanId, { pageSize = 10 } = {}) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/packingOptions?pageSize=${pageSize}`);
}

async function confirmPackingOption(inboundPlanId, packingOptionId) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/packingOptions/${packingOptionId}/confirmation`, {});
}

// ── Placement options ───────────────────────────────────────────────────────

async function generatePlacementOptions(inboundPlanId) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/placementOptions`, {});
}

async function listPlacementOptions(inboundPlanId, { pageSize = 10 } = {}) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/placementOptions?pageSize=${pageSize}`);
}

async function confirmPlacementOption(inboundPlanId, placementOptionId) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/placementOptions/${placementOptionId}/confirmation`, {});
}

// ── Transportation options ──────────────────────────────────────────────────

async function generateTransportationOptions(inboundPlanId, { placementOptionId, shipmentTransportationConfigurations }) {
  const body = { placementOptionId };
  if (shipmentTransportationConfigurations) body.shipmentTransportationConfigurations = shipmentTransportationConfigurations;
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/transportationOptions`, body);
}

async function listTransportationOptions(inboundPlanId, { placementOptionId, shipmentId, pageSize = 20 } = {}) {
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (placementOptionId) params.set('placementOptionId', placementOptionId);
  if (shipmentId) params.set('shipmentId', shipmentId);
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/transportationOptions?${params}`);
}

// transportationSelections: [{ shipmentId, transportationOptionId, contactInformation? }]
async function confirmTransportationOptions(inboundPlanId, transportationSelections) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/transportationOptions/confirmation`, {
    transportationSelections,
  });
}

// ── Shipments + labels ──────────────────────────────────────────────────────

async function listShipments(inboundPlanId, { pageSize = 20 } = {}) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/shipments?pageSize=${pageSize}`);
}

async function getShipment(inboundPlanId, shipmentId) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}`);
}

async function generateShipmentLabels(inboundPlanId, shipmentId) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/labels`, {});
}

// pageType: 'PackageLabel_Letter_2', 'PackageLabel_Letter_4', 'PackageLabel_Letter_6', 'PackageLabel_Letter_6_CarrierLeft', 'PackageLabel_A4_2', 'PackageLabel_A4_4', 'PackageLabel_Plain_Paper'
async function getShipmentLabels(inboundPlanId, shipmentId, { pageType = 'PackageLabel_Letter_6' } = {}) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/labels?pageType=${pageType}`);
}

async function confirmDeliveryWindowOption(inboundPlanId, shipmentId, deliveryWindowOptionId) {
  return _request('POST', `${BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/deliveryWindowOptions/${deliveryWindowOptionId}/confirmation`, {});
}

async function listDeliveryWindowOptions(inboundPlanId, shipmentId, { pageSize = 10 } = {}) {
  return _request('GET', `${BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/deliveryWindowOptions?pageSize=${pageSize}`);
}

// ── Delivery challan (for India) / Carton content update — not used for CA

module.exports = {
  // Plans
  createInboundPlan,
  getInboundPlan,
  // Packing
  generatePackingOptions,
  listPackingOptions,
  confirmPackingOption,
  // Placement
  generatePlacementOptions,
  listPlacementOptions,
  confirmPlacementOption,
  // Transportation
  generateTransportationOptions,
  listTransportationOptions,
  confirmTransportationOptions,
  // Delivery window
  listDeliveryWindowOptions,
  confirmDeliveryWindowOption,
  // Shipments
  listShipments,
  getShipment,
  generateShipmentLabels,
  getShipmentLabels,
  // Operations
  getOperation,
  waitForOperation,
};
