#!/usr/bin/env node
/**
 * YourFloors.ca — Automated Order Router v1.3
 * 
 * Pulls awaiting_shipment orders from ShipStation, checks Prosol inventory
 * by location, and assigns the optimal warehouse based on:
 *   1. Province-based preferred hub routing
 *   2. Haversine distance fallback (nearest stocked warehouse)
 *   3. Carrier selection: UPS preferred within $4 of CP (UPS pickups are free vs $4 CP pickup fee)
 *
 * Usage:
 *   node order-router.js              # dry-run (default)
 *   node order-router.js --dry-run    # explicit dry-run
 *   node order-router.js --execute    # actually update ShipStation
 *   node order-router.js --discover   # print Prosol location map
 *
 * Environment:
 *   SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET  (or uses hardcoded defaults)
 *   PROSOL_EMAIL / PROSOL_PASSWORD                (or uses hardcoded defaults)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { ProsolClientV2 } = require('./prosol-client-v2');
const { normalizeShipTo } = require('./run-orders');

// ─── Configuration ────────────────────────────────────────────────────────────

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;
if (!SHIPSTATION_API_KEY || !SHIPSTATION_API_SECRET) {
  throw new Error('Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET');
}
const SHIPSTATION_AUTH = Buffer.from(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`).toString('base64');
const SHIPSTATION_BASE = 'ssapi.shipstation.com';

const PROSOL_EMAIL = process.env.PROSOL_EMAIL;
const PROSOL_PASSWORD = process.env.PROSOL_PASSWORD;
if (!PROSOL_EMAIL || !PROSOL_PASSWORD) {
  throw new Error('Missing PROSOL_EMAIL or PROSOL_PASSWORD');
}

// ─── Carrier Selection ────────────────────────────────────────────────────────
// Rules (in order):
//   1. Compare UPS vs Purolator — pick the cheapest of the two
//   2. Canada Post: only use if >$4 cheaper than both UPS AND Purolator
//   3. Canada Post ALWAYS for PO Boxes
// UPS pickups are free; Purolator pickups bookable via ShipStation V2 API.
const CP_THRESHOLD = 4.00; // CP must beat both UPS & Puro by this much to win

const WAREHOUSE_POSTCODES = {
  147654:  'V0N3A3', // Sechelt
  1374417: 'V5B3A9', // Burnaby
  1284722: 'T2H1Z9', // Calgary
  1791764: 'L4K4G5', // Concord
  1791765: 'H4T2A2', // Montreal (St. Laurent)
  1793463: 'N1T1N5', // Cambridge
  1793487: 'N6E1K7', // London
  1786140: 'P3C5L8', // Sudbury
  1811347: 'R2X2R4', // Winnipeg
  1814007: 'K1B4N4', // Ottawa
  1504076: 'K7P0E9', // Kingston
  1824506: 'L4X2G1', // Mississauga
  1824505: 'V3K7C1', // Coquitlam
};

async function getBestCarrier(order, fromPostalCode) {
  if (!fromPostalCode) return null;

  function fetchRates(carrier) {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        carrierCode: carrier,
        packageCode: 'package',
        fromPostalCode,
        toState: order.shipTo?.state,
        toCountry: 'CA',
        toPostalCode: (order.shipTo?.postalCode || '').replace(/\s/g, ''),
        toCity: order.shipTo?.city,
        weight: order.weight || { value: 1, units: 'pounds' },
        confirmation: 'none',
        residential: order.shipTo?.residential || false,
      });
      const req = https.request({
        hostname: SHIPSTATION_BASE,
        path: '/shipments/getrates',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${SHIPSTATION_AUTH}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const rates = JSON.parse(d);
            const best = Array.isArray(rates)
              ? rates.sort((a, b) => a.shipmentCost - b.shipmentCost)[0]
              : null;
            resolve(best ? { ...best, carrierCode: carrier } : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  // Check PO Box — always Canada Post
  const street = (order.shipTo?.street1 || '').toLowerCase();
  const isPOBox = /\bpo\s*box\b|^\s*box\s+\d/i.test(street);
  if (isPOBox) {
    const cp = await fetchRates('canada_post_walleted');
    return cp;
  }

  const [cp, ups, puro] = await Promise.all([
    fetchRates('canada_post_walleted'),
    fetchRates('ups_walleted'),
    fetchRates('purolator_walleted'),
  ]);

  // Step 1: best of UPS vs Purolator
  let bestNonCP = null;
  if (ups && puro) {
    bestNonCP = ups.shipmentCost <= puro.shipmentCost ? ups : puro;
  } else {
    bestNonCP = ups || puro;
  }

  if (!bestNonCP && !cp) return null;
  if (!bestNonCP) return cp;
  if (!cp) return bestNonCP;

  // Step 2: only switch to CP if it beats best by >$4
  if (bestNonCP.shipmentCost - cp.shipmentCost > CP_THRESHOLD) return cp;
  return bestNonCP;
}

// ─── Load Prosol location map from JSON ──────────────────────────────────────

const LOCATION_MAP_PATH = path.join(__dirname, 'prosol-location-map.json');
let PROSOL_LOCATIONS = {};

try {
  PROSOL_LOCATIONS = JSON.parse(fs.readFileSync(LOCATION_MAP_PATH, 'utf8'));
} catch (e) {
  console.error(`⚠️  Could not load ${LOCATION_MAP_PATH}: ${e.message}`);
  console.error('   Run with --discover to regenerate, or check the file exists.');
  process.exit(1);
}

// ─── ShipStation Warehouse IDs (for display names) ───────────────────────────

const SS_WAREHOUSES = {
  147654:  'Custom Flooring Warehouse (Sechelt BC)',
  1374417: 'Prosol - Burnaby',
  1284722: 'Prosol - Calgary South',
  1791764: 'Prosol - Concord',
  1791765: 'Prosol - Montreal (St. Laurent)',
  1504076: 'Prosol - Kingston',
  1793463: 'Prosol - Cambridge',
  1793487: 'Prosol - London',
  1786140: 'Prosol - Sudbury',
  1811347: 'Prosol - Winnipeg',
  1814007: 'Prosol - Ottawa',
  1274501: 'Biyork (Markham)',
  1274274: 'PCW Richmond',
};

// ─── Province → Preferred hub routing (Prosol location IDs, priority order) ──

// Order: A-tier first, B-tier last. The legacy router doesn't model B-tier
// explicitly — its Phase 1 walks this list in order and picks the first
// hub with stock, so simply appending B-tier ids after A-tier achieves the
// same A-then-B effect.
const PROVINCE_ROUTING = {
  'BC': [10010, 10003, 10054,  10007, 10022, 10023, 10026, 10031, 10034, 10038, 10044, 10045, 10055],
  'AB': [10054, 10010, 10003, 10049,  10011, 10018, 10019, 10036],
  'SK': [10054, 10049, 10010,  10037, 10039],
  'MB': [10049, 10054, 10010],
  'ON': [10001, 10028, 10013, 10024, 10027, 10032, 10043,  10017, 10021, 10025, 10040, 10041, 10048, 10052],
  'QC': [10001,  10004,  10014, 10035, 10051],   // WGRF deprioritized to bottom of A-tier; QC retail outlets last
  'NB': [10001,  10004,  10029],
  'NS': [10001,  10004,  10016],
  'PE': [10001,  10004,  10016, 10029],
  'NL': [10001,  10004,  10016],
  'YT': [10010, 10003, 10054],
  'NT': [10054, 10010, 10003, 10049],
  'NU': [10049, 10054, 10001],
};

// ─── Haversine distance (km) ─────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Canadian postal code → approximate lat/lng ──────────────────────────────
// Uses the FSA (first 3 chars) to estimate location. Falls back to province capitals.

const PROVINCE_CENTROIDS = {
  'BC': [53.7, -127.6], 'AB': [53.9, -116.6], 'SK': [52.9, -106.5],
  'MB': [53.8, -98.8],  'ON': [51.3, -85.3],  'QC': [52.9, -73.5],
  'NB': [46.5, -66.2],  'NS': [44.7, -63.7],  'PE': [46.5, -63.4],
  'NL': [53.1, -57.7],  'YT': [64.3, -135.0], 'NT': [64.3, -124.0],
  'NU': [70.3, -86.0],
};

// Major city postal code prefixes → [lat, lng] for common FSAs
const POSTAL_CODE_COORDS = {
  // Ontario
  'K': [45.4, -75.7], 'L': [43.7, -79.4], 'M': [43.7, -79.4], 'N': [43.0, -81.0], 'P': [46.5, -81.0],
  // Quebec
  'G': [46.8, -71.2], 'H': [45.5, -73.6], 'J': [45.5, -73.2],
  // BC
  'V': [49.3, -123.1],
  // Alberta
  'T': [51.0, -114.1],
  // Saskatchewan
  'S': [50.5, -104.6],
  // Manitoba
  'R': [49.9, -97.1],
  // New Brunswick
  'E': [46.1, -66.7],
  // Nova Scotia
  'B': [44.6, -63.6],
  // PEI
  'C': [46.2, -63.1],
  // Newfoundland
  'A': [47.6, -52.7],
};

function estimateCustomerCoords(postalCode, province) {
  if (postalCode && postalCode.length >= 1) {
    const prefix = postalCode[0].toUpperCase();
    if (POSTAL_CODE_COORDS[prefix]) {
      return POSTAL_CODE_COORDS[prefix];
    }
  }
  if (province && PROVINCE_CENTROIDS[province]) {
    return PROVINCE_CENTROIDS[province];
  }
  return null;
}

// ─── SKU Map ─────────────────────────────────────────────────────────────────

const SKU_MAP_PATH = path.join(__dirname, 'sku-map.json');

function loadSkuMap() {
  try {
    const data = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8'));
    return data.mappings || {};
  } catch {
    return {};
  }
}

function saveSkuMap(mappings) {
  try {
    // Preserve existing file structure, just update mappings + timestamp
    const existing = JSON.parse(fs.readFileSync(SKU_MAP_PATH, 'utf8'));
    existing.mappings = mappings;
    existing._updated = new Date().toISOString();
    fs.writeFileSync(SKU_MAP_PATH, JSON.stringify(existing, null, 2) + '\n');
  } catch {
    const data = {
      _comment: 'Maps ShipStation SKUs (Amazon ASINs, Shopify SKUs) to Prosol SKUs',
      _updated: new Date().toISOString(),
      mappings,
    };
    fs.writeFileSync(SKU_MAP_PATH, JSON.stringify(data, null, 2) + '\n');
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── ShipStation API ─────────────────────────────────────────────────────────

async function ssRequest(method, endpoint, body = null) {
  const options = {
    hostname: SHIPSTATION_BASE,
    path: endpoint,
    method,
    headers: {
      'Authorization': `Basic ${SHIPSTATION_AUTH}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  const res = await httpsRequest(options, body);
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
    log(`⏳ ShipStation rate limited. Waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return ssRequest(method, endpoint, body);
  }
  return res;
}

async function fetchAwaitingOrders() {
  const orders = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await ssRequest('GET', `/orders?orderStatus=awaiting_shipment&pageSize=100&page=${page}`);
    if (res.status !== 200) {
      throw new Error(`ShipStation GET /orders failed: ${res.status} — ${res.body.substring(0, 300)}`);
    }
    const data = JSON.parse(res.body);
    orders.push(...(data.orders || []));
    totalPages = data.pages || 1;
    page++;
    if (page <= totalPages) await sleep(500);
  }

  return orders;
}

async function updateOrderWarehouse(orderId, orderNumber, warehouseId) {
  const getRes = await ssRequest('GET', `/orders/${orderId}`);
  if (getRes.status !== 200) {
    throw new Error(`Failed to GET order ${orderId}: ${getRes.status}`);
  }
  const order = JSON.parse(getRes.body);

  if (!order.advancedOptions) order.advancedOptions = {};
  order.advancedOptions.warehouseId = warehouseId;

  // Pick cheapest carrier, preferring UPS within $4 (free pickup vs ~$4 CP pickup)
  const fromPostal = WAREHOUSE_POSTCODES[warehouseId];
  let carrierCode, serviceCode;
  if (fromPostal) {
    const best = await getBestCarrier(order, fromPostal);
    if (best) {
      carrierCode = best.carrierCode;
      serviceCode = best.serviceCode;
      const label = best.carrierCode === 'ups_walleted' ? 'UPS' : 'CP';
      log(`  💰 Carrier: ${label} ${best.serviceName} $${best.shipmentCost.toFixed(2)}`);
    }
  }

  // IMPORTANT: Do NOT send weight/dimensions — ShipStation's createorders
  // will overwrite existing packaging templates if we include them.
  const updatePayload = {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderKey: order.orderKey,
    orderDate: order.orderDate,
    orderStatus: order.orderStatus,
    billTo: order.billTo,
    shipTo: normalizeShipTo(order.shipTo),
    items: order.items,
    advancedOptions: order.advancedOptions,
    ...(carrierCode && { carrierCode, serviceCode }),
  };

  const postRes = await ssRequest('POST', '/orders/createorders', JSON.stringify([updatePayload]));
  if (postRes.status !== 200) {
    throw new Error(`Failed to update order ${orderNumber}: ${postRes.status} — ${postRes.body.substring(0, 300)}`);
  }
  return JSON.parse(postRes.body);
}

// ─── Prosol API ──────────────────────────────────────────────────────────────

class ProsolClient {
  constructor() {
    this.cookies = {};
  }

  _parseCookies(headers) {
    const setCookies = headers['set-cookie'] || [];
    for (const c of setCookies) {
      const parts = c.split(';')[0].split('=');
      const name = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      this.cookies[name] = value;
    }
  }

  _cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _xsrf() {
    return decodeURIComponent(this.cookies['XSRF-TOKEN'] || '');
  }

  async request(method, urlPath, body = null) {
    const options = {
      hostname: PROSOL_API_BASE,
      path: urlPath,
      method,
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://shop.prosol.ca',
        'Referer': 'https://shop.prosol.ca/',
        'Cookie': this._cookieHeader(),
        'X-XSRF-TOKEN': this._xsrf(),
      },
    };
    if (body) options.headers['Content-Type'] = 'application/json';
    const res = await httpsRequest(options, body);
    this._parseCookies(res.headers);
    return res;
  }

  async login() {
    await this.request('GET', '/sanctum/csrf-cookie');
    const res = await this.request('POST', '/api/login', {
      email: PROSOL_EMAIL,
      password: PROSOL_PASSWORD,
    });
    if (res.status !== 200) {
      throw new Error(`Prosol login failed: ${res.status} — ${res.body.substring(0, 300)}`);
    }
    log('✅ Prosol login successful');
    return true;
  }

  async checkInventory(prosolSku) {
    const res = await this.request('GET',
      `/api/storefront/products?filter[sku]=${encodeURIComponent(prosolSku)}&append=availability_by_location_ids`
    );
    if (res.status !== 200) {
      log(`⚠️  Prosol product lookup failed for ${prosolSku}: ${res.status}`);
      return null;
    }
    const data = JSON.parse(res.body);
    const products = data.data || data;
    if (!Array.isArray(products) || products.length === 0) return null;

    const product = products[0];
    const items = product.product_inventory_items || [];
    const availability = product.availability_by_location_ids || [];
    
    const locationStock = {};
    items.forEach((item, i) => {
      const locId = item.product_inventory_location_id;
      const available = availability[i] === true || availability[i] === 1;
      const qty = typeof item.available === 'number' ? item.available : (available ? 1 : 0);
      locationStock[locId] = { available, quantity: qty };
    });

    return {
      sku: product.sku,
      name: typeof product.name === 'object' ? product.name.en : product.name,
      locationStock,
    };
  }
}

// ─── Routing Logic ───────────────────────────────────────────────────────────

/**
 * Get all Prosol locations that have a ShipStation warehouse mapping,
 * sorted by distance from customer coordinates.
 */
function getMappedLocationsByDistance(customerLat, customerLng) {
  const mapped = [];
  for (const [locId, loc] of Object.entries(PROSOL_LOCATIONS)) {
    if (!loc.shipstation_warehouse_id) continue;
    const dist = (customerLat && customerLng && loc.lat && loc.lng)
      ? haversine(customerLat, customerLng, loc.lat, loc.lng)
      : 99999;
    mapped.push({ locId: parseInt(locId), ...loc, distance: dist });
  }
  return mapped.sort((a, b) => a.distance - b.distance);
}

function determineWarehouse(province, locationStock, customerCoords) {
  const [custLat, custLng] = customerCoords || [null, null];
  const routing = PROVINCE_ROUTING[province] || [];

  // Phase 1: Try province-based preferred hubs in priority order
  for (const prosolLocId of routing) {
    const loc = PROSOL_LOCATIONS[prosolLocId];
    if (!loc || !loc.shipstation_warehouse_id) continue;
    const stock = locationStock[prosolLocId];
    if (stock && stock.available && stock.quantity > 0) {
      const dist = (custLat && loc.lat) ? haversine(custLat, custLng, loc.lat, loc.lng) : null;
      const distStr = dist ? ` (~${Math.round(dist)} km)` : '';
      return {
        ssWarehouseId: loc.shipstation_warehouse_id,
        prosolLocId,
        reason: `${loc.city} (${loc.code}) — ${stock.quantity} in stock${distStr}`,
      };
    }
  }

  // Phase 2: Haversine fallback — find nearest stocked warehouse with SS mapping
  const byDistance = getMappedLocationsByDistance(custLat, custLng);
  for (const loc of byDistance) {
    const stock = locationStock[loc.locId];
    if (stock && stock.available && stock.quantity > 0) {
      const distStr = loc.distance < 99999 ? ` (~${Math.round(loc.distance)} km)` : '';
      return {
        ssWarehouseId: loc.shipstation_warehouse_id,
        prosolLocId: loc.locId,
        reason: `NEAREST: ${loc.city} (${loc.code}) — ${stock.quantity} in stock${distStr}`,
      };
    }
  }

  return { ssWarehouseId: null, reason: 'No stock at any mapped location' };
}

function determineWarehouseMultiSku(province, inventoryResults, customerCoords) {
  const [custLat, custLng] = customerCoords || [null, null];
  const routing = PROVINCE_ROUTING[province] || [];

  // Build candidate list: preferred hubs first, then by distance
  const byDistance = getMappedLocationsByDistance(custLat, custLng);
  const preferredIds = new Set(routing);
  const candidates = [
    ...routing.filter(id => PROSOL_LOCATIONS[id]?.shipstation_warehouse_id),
    ...byDistance.filter(l => !preferredIds.has(l.locId)).map(l => l.locId),
  ];

  for (const prosolLocId of candidates) {
    const loc = PROSOL_LOCATIONS[prosolLocId];
    if (!loc || !loc.shipstation_warehouse_id) continue;

    const allInStock = inventoryResults.every(inv => {
      if (!inv) return false;
      const stock = inv.locationStock[prosolLocId];
      return stock && stock.available && stock.quantity > 0;
    });

    if (allInStock) {
      const stockDetails = inventoryResults.map(inv => {
        const stock = inv.locationStock[prosolLocId];
        return `${inv.sku}:${stock.quantity}`;
      }).join(', ');
      const dist = (custLat && loc.lat) ? haversine(custLat, custLng, loc.lat, loc.lng) : null;
      const distStr = dist ? ` (~${Math.round(dist)} km)` : '';
      return {
        ssWarehouseId: loc.shipstation_warehouse_id,
        prosolLocId,
        reason: `${loc.city} (${loc.code}) — all SKUs in stock [${stockDetails}]${distStr}`,
      };
    }
  }

  // If no single location has all items, route based on first SKU and flag
  if (inventoryResults.length > 0 && inventoryResults[0]) {
    const result = determineWarehouse(province, inventoryResults[0].locationStock, customerCoords);
    result.reason = `⚠️ SPLIT ORDER — routed by first SKU: ${result.reason}`;
    result.splitOrder = true;
    return result;
  }

  return { ssWarehouseId: null, reason: 'No inventory data for any SKU' };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const executeMode = args.includes('--execute');
  const discoverMode = args.includes('--discover');
  const dryRun = !executeMode;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    YourFloors.ca — Automated Order Router v1.2              ║');
  console.log(`║    Mode: ${executeMode ? '🚀 EXECUTE (will update ShipStation)     ' : '🔍 DRY RUN (no changes)             '}  ║`);
  console.log(`║    Locations loaded: ${Object.keys(PROSOL_LOCATIONS).length} Prosol warehouses                  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const skuMap = loadSkuMap();
  const unmappedSkus = new Set();

  const prosol = new ProsolClientV2();
  await prosol.init();

  if (discoverMode) {
    log('📍 Prosol location map (from prosol-location-map.json):');
    console.log('');
    console.log('  ID     Code  City                  Prov  ShipStation          Hub');
    console.log('  ─────  ────  ────────────────────  ────  ───────────────────  ─────');
    for (const [locId, loc] of Object.entries(PROSOL_LOCATIONS)) {
      const ssName = loc.shipstation_warehouse_id
        ? SS_WAREHOUSES[loc.shipstation_warehouse_id] || `SS#${loc.shipstation_warehouse_id}`
        : '(not mapped)';
      const hub = loc.is_main_hub ? 'MAIN' : loc.shipstation_warehouse_id ? '2nd' : '—';
      console.log(`  ${locId}  ${loc.code.padEnd(5)} ${loc.city.padEnd(22)} ${loc.province.padEnd(4)}  ${ssName.padEnd(19)}  ${hub}`);
    }
    return;
  }

  log('📦 Fetching awaiting_shipment orders from ShipStation...');
  const orders = await fetchAwaitingOrders();
  log(`📦 Found ${orders.length} orders awaiting shipment`);

  if (orders.length === 0) {
    log('✅ No orders to route. Done!');
    return;
  }

  const results = { routed: [], unmapped: [], noStock: [], errors: [], skipped: [] };

  for (const order of orders) {
    const orderNum = order.orderNumber || order.orderId;
    const shipTo = order.shipTo || {};
    const province = shipTo.state || '';
    const country = shipTo.country || '';
    const city = shipTo.city || '';
    const postalCode = (shipTo.postalCode || '').replace(/\s/g, '');
    const items = order.items || [];

    log(`\n─── Order #${orderNum} ───`);
    log(`  📍 Ship to: ${city}, ${province} ${postalCode}, ${country}`);
    log(`  📋 Items: ${items.length}`);

    if (country && country !== 'CA') {
      log(`  ⏭️  Skipping — non-Canadian order (${country})`);
      results.skipped.push({ orderNum, reason: `Non-Canadian (${country})` });
      continue;
    }

    if (!province) {
      log(`  ⚠️  No province on order — skipping`);
      results.errors.push({ orderNum, reason: 'No province/state on shipping address' });
      continue;
    }

    // Estimate customer coordinates for haversine routing
    const customerCoords = estimateCustomerCoords(postalCode, province);
    if (customerCoords) {
      log(`  📐 Customer coords: ${customerCoords[0].toFixed(2)}, ${customerCoords[1].toFixed(2)}`);
    }

    // Look up Prosol inventory for each item
    const inventoryResults = [];
    let hasUnmapped = false;
    let forceWarehouse = null; // For NON_PROSOL items with fixed routing

    for (const item of items) {
      const ssSku = item.sku || item.name || 'UNKNOWN';
      const mapping = skuMap[ssSku] || null;

      log(`  🏷️  Item: ${(item.name || ssSku).substring(0, 80)} (SKU: ${ssSku})`);

      // Resolve the mapping to Prosol API SKUs
      // New format: { api_sku, prosol_sku, product, verified } or { bundle, components: [...] }
      // Legacy format: plain string
      // NON_PROSOL: { api_sku: "NON_PROSOL", route_to: "CFC_SECHELT", shipstation_warehouse_id: 147654 }
      // SKIP: { api_sku: "SKIP" }
      // UNMAPPED: { api_sku: "UNMAPPED" }

      if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
        // New object format
        if (mapping.api_sku === 'NON_PROSOL') {
          const ssWh = mapping.shipstation_warehouse_id || 147654;
          log(`    🏠 NON_PROSOL → CFC Sechelt (${mapping.product || ssSku})`);
          forceWarehouse = ssWh;
          continue;
        }
        if (mapping.api_sku === 'SKIP') {
          log(`    ⏭️  SKIP — not a real product`);
          continue;
        }
        if (mapping.api_sku === 'UNMAPPED') {
          log(`    ❌ UNMAPPED — needs manual verification (${mapping.product || ''})`);
          unmappedSkus.add(ssSku);
          hasUnmapped = true;
          continue;
        }
        if (mapping.bundle && mapping.components) {
          // Bundle: check each component
          log(`    📦 Bundle: ${mapping.product || ssSku} (${mapping.components.length} components)`);
          for (const comp of mapping.components) {
            const apiSku = comp.api_sku;
            log(`    🔄 Component: ${apiSku} (${comp.product || ''})`);
            const inv = await prosol.checkInventory(apiSku);
            if (inv) {
              log(`    ✅ Found: ${inv.name}`);
              inventoryResults.push(inv);
            } else {
              log(`    ⚠️  Component not found in Prosol`);
            }
            await sleep(200);
          }
          continue;
        }
        // Standard object mapping
        const apiSku = mapping.api_sku;
        log(`    🔄 Mapped to Prosol SKU: ${apiSku}`);
        const inv = await prosol.checkInventory(apiSku);
        if (inv) {
          log(`    ✅ Found: ${inv.name}`);
          inventoryResults.push(inv);
        } else {
          log(`    ⚠️  Product not found in Prosol`);
        }
        await sleep(200);
        continue;
      }

      // Legacy string format or array format
      if (mapping) {
        const prosolSkus = Array.isArray(mapping) ? mapping : [mapping];
        for (const prosolSku of prosolSkus) {
          log(`    🔄 Mapped to Prosol SKU: ${prosolSku}${prosolSkus.length > 1 ? ' (bundle)' : ''}`);
          const inv = await prosol.checkInventory(prosolSku);
          if (inv) {
            log(`    ✅ Found: ${inv.name}`);
            inventoryResults.push(inv);
          } else {
            log(`    ⚠️  Product not found in Prosol`);
          }
          await sleep(200);
        }
        continue;
      }

      // No mapping at all — try direct Prosol lookup
      const mightBeProsol = /^[A-Z]\d/.test(ssSku);
      if (mightBeProsol) {
        log(`    🔍 Trying direct Prosol lookup...`);
        const inv = await prosol.checkInventory(ssSku);
        if (inv) {
          log(`    ✅ Found: ${inv.name}`);
          inventoryResults.push(inv);
          skuMap[ssSku] = { api_sku: ssSku, product: inv.name, verified: false, auto_discovered: true };
          continue;
        }
      }
      log(`    ❌ No Prosol SKU mapping for "${ssSku}"`);
      unmappedSkus.add(ssSku);
      hasUnmapped = true;
    }

    // If all items are NON_PROSOL with a forced warehouse, assign directly
    if (forceWarehouse && inventoryResults.length === 0 && !hasUnmapped) {
      const warehouseName = SS_WAREHOUSES[forceWarehouse] || `ID:${forceWarehouse}`;
      log(`  ✅ Route → ${warehouseName} (non-Prosol, fixed routing)`);
      const currentWarehouse = order.advancedOptions?.warehouseId;
      if (currentWarehouse === forceWarehouse) {
        log(`  ℹ️  Already assigned to correct warehouse`);
        results.routed.push({ orderNum, warehouse: warehouseName, warehouseId: forceWarehouse, reason: 'NON_PROSOL fixed route', action: 'already-correct' });
      } else if (executeMode) {
        try {
          await updateOrderWarehouse(order.orderId, orderNum, forceWarehouse);
          log(`  🚀 Updated ShipStation → ${warehouseName}`);
          results.routed.push({ orderNum, warehouse: warehouseName, warehouseId: forceWarehouse, reason: 'NON_PROSOL fixed route', action: 'updated' });
          await sleep(500);
        } catch (err) {
          log(`  ❌ Failed to update: ${err.message}`);
          results.errors.push({ orderNum, reason: err.message });
        }
      } else {
        log(`  📝 [DRY RUN] Would assign → ${warehouseName}`);
        results.routed.push({ orderNum, warehouse: warehouseName, warehouseId: forceWarehouse, reason: 'NON_PROSOL fixed route', action: 'dry-run' });
      }
      continue;
    }

    if (hasUnmapped && inventoryResults.length === 0) {
      log(`  ❌ All items unmapped — cannot route`);
      results.unmapped.push({ orderNum, skus: items.map(i => i.sku || 'UNKNOWN') });
      continue;
    }

    if (inventoryResults.length === 0) {
      log(`  ❌ No inventory data available`);
      results.noStock.push({ orderNum, reason: 'No inventory data' });
      continue;
    }

    // Determine optimal warehouse
    const warehouseResult = inventoryResults.length === 1
      ? determineWarehouse(province, inventoryResults[0].locationStock, customerCoords)
      : determineWarehouseMultiSku(province, inventoryResults, customerCoords);

    if (!warehouseResult.ssWarehouseId) {
      log(`  ❌ ${warehouseResult.reason}`);
      results.noStock.push({ orderNum, reason: warehouseResult.reason });
      continue;
    }

    const warehouseName = SS_WAREHOUSES[warehouseResult.ssWarehouseId] || `ID:${warehouseResult.ssWarehouseId}`;
    log(`  ✅ Route → ${warehouseName}`);
    log(`     Reason: ${warehouseResult.reason}`);

    // Check if already correct
    const currentWarehouse = order.advancedOptions?.warehouseId;
    if (currentWarehouse === warehouseResult.ssWarehouseId) {
      log(`  ℹ️  Already assigned to correct warehouse`);
      results.routed.push({
        orderNum, warehouse: warehouseName,
        warehouseId: warehouseResult.ssWarehouseId,
        reason: warehouseResult.reason, action: 'already-correct',
      });
      continue;
    }

    if (executeMode) {
      try {
        await updateOrderWarehouse(order.orderId, orderNum, warehouseResult.ssWarehouseId);
        log(`  🚀 Updated ShipStation → ${warehouseName}`);
        results.routed.push({
          orderNum, warehouse: warehouseName,
          warehouseId: warehouseResult.ssWarehouseId,
          reason: warehouseResult.reason, action: 'updated',
        });
        await sleep(500);
      } catch (err) {
        log(`  ❌ Failed to update: ${err.message}`);
        results.errors.push({ orderNum, reason: err.message });
      }
    } else {
      log(`  📝 [DRY RUN] Would assign → ${warehouseName}`);
      results.routed.push({
        orderNum, warehouse: warehouseName,
        warehouseId: warehouseResult.ssWarehouseId,
        reason: warehouseResult.reason, action: 'dry-run',
        splitOrder: warehouseResult.splitOrder || false,
      });
    }
  }

  saveSkuMap(skuMap);
  await prosol.close();

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                      ROUTING SUMMARY                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Total orders processed:  ${orders.length}`);
  console.log(`  ✅ Routed successfully:  ${results.routed.length}`);
  console.log(`  ❌ Unmapped SKUs:        ${results.unmapped.length}`);
  console.log(`  ⚠️  No stock found:       ${results.noStock.length}`);
  console.log(`  🚫 Errors:               ${results.errors.length}`);
  console.log(`  ⏭️  Skipped:              ${results.skipped.length}`);

  if (results.routed.length > 0) {
    console.log('\n  📦 Routed Orders:');
    for (const r of results.routed) {
      const icon = r.action === 'updated' ? '🚀' : r.action === 'already-correct' ? 'ℹ️' : '📝';
      console.log(`    ${icon} #${r.orderNum} → ${r.warehouse}${r.splitOrder ? ' ⚠️ SPLIT' : ''}`);
    }
  }

  if (results.unmapped.length > 0) {
    console.log('\n  ❌ Orders with unmapped SKUs (add to sku-map.json):');
    for (const u of results.unmapped) {
      console.log(`    #${u.orderNum}: ${u.skus.join(', ')}`);
    }
  }

  if (results.noStock.length > 0) {
    console.log('\n  ⚠️  No stock (manual review):');
    for (const n of results.noStock) {
      console.log(`    #${n.orderNum}: ${n.reason}`);
    }
  }

  if (results.errors.length > 0) {
    console.log('\n  🚫 Errors:');
    for (const e of results.errors) {
      console.log(`    #${e.orderNum}: ${e.reason}`);
    }
  }

  if (unmappedSkus.size > 0) {
    console.log('\n  📋 Unmapped SKUs (add to sku-map.json):');
    for (const sku of [...unmappedSkus].sort()) {
      console.log(`    "${sku}": "PROSOL_SKU_HERE"`);
    }
  }

  console.log('');
  if (dryRun) {
    console.log('  💡 DRY RUN complete. Use --execute to update ShipStation.');
  }
  console.log('');
}

main().catch((err) => {
  log(`💥 Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
