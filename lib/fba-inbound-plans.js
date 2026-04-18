/**
 * FBA Inbound Plan state manager.
 *
 * Tracks the position of each inbound plan through the multi-step workflow.
 * Persists to data/fba/inbound-plans/<planKey>.json so we can resume mid-way.
 *
 * State machine:
 *   created          → createInboundPlan returned an inboundPlanId
 *   packing-ready    → generatePackingOptions operation SUCCESS
 *   packing-confirmed → confirmPackingOption operation SUCCESS
 *   placement-ready  → generatePlacementOptions operation SUCCESS
 *   placement-confirmed → confirmPlacementOption operation SUCCESS
 *   transportation-ready → generateTransportationOptions operation SUCCESS
 *   transportation-confirmed → confirmTransportationOptions operation SUCCESS
 *   labels-ready     → generateShipmentLabels operation SUCCESS
 *   done             → confirmShipment (if needed)
 *   error            → something failed — see lastError
 */

const fs = require('fs');
const path = require('path');

const PLANS_DIR = path.join(__dirname, '..', 'data', 'fba', 'inbound-plans');

function ensureDir() {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

function pathFor(planKey) {
  return path.join(PLANS_DIR, `${planKey}.json`);
}

function load(planKey) {
  ensureDir();
  const p = pathFor(planKey);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function save(state) {
  ensureDir();
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(pathFor(state.planKey), JSON.stringify(state, null, 2));
  return state;
}

function create({ planKey, sourceDraftId, vendor, lines, sourceAddress, name }) {
  const state = {
    planKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceDraftId,
    vendor,
    status: 'draft',
    name,
    sourceAddress,
    lines,                 // [{ asin, msku, quantity, product }]
    inboundPlanId: null,
    packingOptionId: null,
    placementOptionId: null,
    transportationOptionIds: null,
    shipmentIds: [],
    labelsUrl: null,
    lastError: null,
    history: [],
  };
  return save(state);
}

function record(state, { step, ok, data, error }) {
  state.history = state.history || [];
  state.history.push({ at: new Date().toISOString(), step, ok: !!ok, data: data || null, error: error || null });
  if (error) state.lastError = { step, error, at: new Date().toISOString() };
  return save(state);
}

function list() {
  ensureDir();
  return fs.readdirSync(PLANS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

// Source address for plans originating at a specific vendor warehouse.
// Used as the "ship from" — Prosol WCAS / Treeco Delta / Sechelt.
const SOURCE_ADDRESSES = {
  prosol_wcas: {
    name: 'Prosol Calgary',
    companyName: 'Prosol Inc.',
    addressLine1: '5760 9 St SE #105',
    city: 'Calgary',
    stateOrProvinceCode: 'AB',
    countryCode: 'CA',
    postalCode: 'T2H1Z9',
    phoneNumber: '403-253-2214',
    email: 'mac@customfc.ca',
  },
  treeco_delta: {
    name: 'Treeco Delta',
    companyName: 'Treeco',
    addressLine1: '1230 Cliveden Ave',
    city: 'Delta',
    stateOrProvinceCode: 'BC',
    countryCode: 'CA',
    postalCode: 'V3M6G4',
    phoneNumber: '604-523-2235',
    email: 'mac@customfc.ca',
  },
  treeco_calgary: {
    name: 'Treeco Calgary',
    companyName: 'Treeco',
    addressLine1: '5211 52 St. SE',
    city: 'Calgary',
    stateOrProvinceCode: 'AB',
    countryCode: 'CA',
    postalCode: 'T2B3T1',
    phoneNumber: '403-219-3303',
    email: 'mac@customfc.ca',
  },
  sechelt: {
    name: 'Custom Flooring Sechelt',
    companyName: 'Custom Flooring Centres',
    addressLine1: 'PO Box 166',
    city: 'Sechelt',
    stateOrProvinceCode: 'BC',
    countryCode: 'CA',
    postalCode: 'V0N3A0',
    phoneNumber: '604-885-3582',
    email: 'mac@customfc.ca',
  },
};

module.exports = { create, save, load, record, list, pathFor, SOURCE_ADDRESSES };
