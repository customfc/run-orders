#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const https = require('https');
const fs = require('fs');
const path = require('path');
const { ProsolClientV2 } = require('./prosol-client-v2');

const SS_KEY = process.env.SHIPSTATION_API_KEY;
const SS_SECRET = process.env.SHIPSTATION_API_SECRET;

if (!SS_KEY || !SS_SECRET) {
  throw new Error('Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET');
}
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
const SS_HOST = 'ssapi.shipstation.com';

const SKU_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'sku-map.json'), 'utf8'));
const SKU_MAPPINGS = SKU_MAP.mappings || {};
const LOCATION_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'prosol-location-map.json'), 'utf8'));

const NON_PROSOL_MARKERS = new Set(['NON_PROSOL', 'SKIP']);
const PERFECT_LEVEL_RE = /perfect\s+level/i;
const MAIN_HUBS = {
  BC: [10010, 10054],
  AB: [10054, 10010, 10049],
  SK: [10054, 10049, 10010],
  MB: [10049, 10054, 10010],
  ON: [10001, 10013, 10024, 10027, 10032, 10043],
  QC: [10004, 10001, 10032, 10027, 10013, 10024, 10043],
  NB: [10004, 10001, 10032, 10027],
  NS: [10004, 10001, 10032, 10027],
  PE: [10004, 10001, 10032, 10027],
  NL: [10004, 10001, 10032, 10027],
  YT: [10010, 10054],
  NT: [10054, 10010, 10049],
  NU: [10049, 10054, 10001],
};

const PO_BOX_RE = /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function httpsRequest(options, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${options.method || 'GET'} ${options.path}`));
    });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function ssRequest(method, endpoint, body = null) {
  const res = await httpsRequest({
    hostname: SS_HOST,
    path: endpoint,
    method,
    headers: {
      Authorization: `Basic ${SS_AUTH}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  }, body);

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
    await sleep(retryAfter * 1000);
    return ssRequest(method, endpoint, body);
  }
  return res;
}

async function fetchAwaitingOrders() {
  const orders = [];
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const res = await ssRequest('GET', `/orders?orderStatus=awaiting_shipment&pageSize=100&page=${page}`);
    if (res.status !== 200) throw new Error(`ShipStation orders fetch failed: ${res.status} ${res.body.slice(0, 300)}`);
    const data = JSON.parse(res.body);
    orders.push(...(data.orders || []));
    pages = data.pages || 1;
    page += 1;
  }
  return orders;
}

function normalizeProvince(raw) {
  const value = String(raw || '').trim().toUpperCase();
  const map = {
    'BRITISH COLUMBIA': 'BC', BC: 'BC',
    'ALBERTA': 'AB', AB: 'AB',
    'SASKATCHEWAN': 'SK', SK: 'SK',
    'MANITOBA': 'MB', MB: 'MB',
    'ONTARIO': 'ON', ON: 'ON',
    'QUEBEC': 'QC', 'QUÉBEC': 'QC', QC: 'QC', PQ: 'QC',
    'NEW BRUNSWICK': 'NB', NB: 'NB',
    'NOVA SCOTIA': 'NS', NS: 'NS',
    'PRINCE EDWARD ISLAND': 'PE', PE: 'PE',
    'NEWFOUNDLAND AND LABRADOR': 'NL', NL: 'NL',
    'YUKON': 'YT', YT: 'YT',
    'NORTHWEST TERRITORIES': 'NT', NT: 'NT',
    'NUNAVUT': 'NU', NU: 'NU',
  };
  return map[value] || null;
}

function normalizeShipTo(shipTo) {
  if (!shipTo) return shipTo;
  const normalized = normalizeProvince(shipTo.state);
  return normalized ? { ...shipTo, state: normalized } : shipTo;
}

function toLb(weight) {
  if (!weight || !Number.isFinite(Number(weight.value))) return 1;
  const value = Number(weight.value);
  const units = String(weight.units || '').toLowerCase();
  if (units.startsWith('gram')) return value / 453.59237;
  if (units.startsWith('kil')) return value * 2.2046226218;
  if (units.startsWith('ounce')) return value / 16;
  return value;
}

function formatMoney(value) {
  return value == null ? '—' : `$${Number(value).toFixed(2)}`;
}

function orderDestination(order) {
  const shipTo = order.shipTo || {};
  return [shipTo.name, shipTo.city, normalizeProvince(shipTo.state) || shipTo.state, (shipTo.postalCode || '').trim()].filter(Boolean).join(', ');
}

function isAmazonOrder(order) {
  return order.advancedOptions?.source === 'amazon_ca';
}

function isShopifyOrder(order) {
  // Shopify orders come in as source='web'. Store the specific storeId too
  // so we can distinguish from any other web-sourced store if that ever matters.
  return order.advancedOptions?.source === 'web';
}

function orderSource(order) {
  if (isAmazonOrder(order)) return 'amazon_ca';
  if (isShopifyOrder(order)) return 'shopify';
  return order.advancedOptions?.source || 'unknown';
}

// Orders the pipeline will process. Amazon CA + Shopify/web.
function isInScope(order) {
  return isAmazonOrder(order) || isShopifyOrder(order);
}

function isClearlyOutOfScope(itemName = '') {
  const name = itemName.toLowerCase();
  return /(click\s+vinyl|luxury\s+vinyl|laminate\s+floor|hardwood\s+floor|engineered\s+hardwood|sheet\s+vinyl|floor\s+protection)/i.test(name);
}

function resolveMappedEntry(rawSku) {
  return SKU_MAPPINGS[rawSku];
}

// Pull a Schluter cable SKU straight out of the item name — Amazon titles
// reliably end with the model number (e.g. "…120V, 35.3 Feet - DHEHK12011").
// This is more reliable than sqft parsing since Amazon frequently prints
// "N Feet" (linear cable length) instead of "N sqft" (coverage area).
function extractDhehkSkuFromName(name) {
  const m = String(name || '').match(/\bDHEHK(120|240)(\d{2,3})\b/i);
  if (!m) return null;
  return `DHEHK${m[1]}${m[2]}`;
}

function extractCableSku(name) {
  const text = String(name || '');
  // Prefer the explicit model number if the title carries it.
  const direct = extractDhehkSkuFromName(text);
  if (direct) return direct;
  const voltageMatch = text.match(/\b(120|240)\s*v\b/i);
  const sqftMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|square\s*feet|sqft)/i);
  if (!voltageMatch || !sqftMatch) return null;
  const voltage = voltageMatch[1];
  const sqft = sqftMatch[1];
  const table = voltage === '120' ? (SKU_MAP.cable_lookup?.sqft_to_sku_120v || {}) : (SKU_MAP.cable_lookup?.sqft_to_sku_240v || {});
  return table[sqft] || null;
}

function resolveOrderItems(order) {
  const resolved = [];
  const fixedWarehouseItems = [];
  const failures = [];
  for (const item of (order.items || [])) {
    const sku = item.sku || 'UNKNOWN';
    const mapped = resolveMappedEntry(sku);
    const base = { sku, name: item.name || sku, qty: item.quantity || 1, original: item };
    const displayName = item.name || mapped?.product || sku;

    if (!mapped) {
      // Unknown ASIN — try to recover a Schluter cable SKU from the title
      // before giving up. Catches new cable-kit ASINs that haven't been
      // added to the map yet.
      const dhehkSku = extractDhehkSkuFromName(item.name);
      if (dhehkSku) {
        resolved.push({ ...base, kind: 'prosol', apiSku: dhehkSku, label: `${item.name || sku} → ${dhehkSku}` });
        continue;
      }
      failures.push(`No sku-map entry for ${sku} (${item.name || 'unnamed item'})`);
      continue;
    }

    if (typeof mapped === 'string') {
      if (mapped === 'SKIP') continue;
      if (PERFECT_LEVEL_RE.test(displayName)) {
        failures.push(`Perfect Level requires explicit non-Prosol routing before automation (${displayName})`);
        continue;
      }
      resolved.push({ ...base, kind: 'prosol', apiSku: mapped, label: item.name || sku });
      continue;
    }

    if (mapped.api_sku === 'SKIP') continue;

    if (mapped.api_sku === 'UNMAPPED' || mapped.api_sku === 'UNMAPPED_GROUT') {
      failures.push(`Manual lookup required for ${sku} (${mapped.product || item.name || sku})`);
      continue;
    }

    if (mapped.api_sku === 'UNMAPPED_CABLE') {
      const cableSku = extractCableSku(item.name);
      if (!cableSku) {
        failures.push(`Cable SKU unresolved from title for ${sku} (${item.name || sku})`);
        continue;
      }
      resolved.push({ ...base, kind: 'prosol', apiSku: cableSku, label: `${mapped.product || item.name} → ${cableSku}` });
      continue;
    }

    if (mapped.bundle) {
      if (!Array.isArray(mapped.components) || mapped.components.length === 0) {
        failures.push(`Bundle mapping malformed for ${sku}`);
        continue;
      }
      for (const comp of mapped.components) {
        if (!comp.api_sku || String(comp.api_sku).startsWith('UNMAPPED')) {
          failures.push(`Bundle component unresolved for ${sku} (${comp.product || comp.api_sku || 'unknown'})`);
          continue;
        }
        resolved.push({ ...base, kind: 'prosol', apiSku: comp.api_sku, label: `${mapped.product || item.name} / ${comp.product || comp.api_sku}` });
      }
      continue;
    }

    if (NON_PROSOL_MARKERS.has(mapped.api_sku)) {
      if (mapped.shipstation_warehouse_id) {
        fixedWarehouseItems.push({
          ...base,
          kind: 'fixed-warehouse',
          warehouseId: Number(mapped.shipstation_warehouse_id),
          routeTo: mapped.route_to || null,
          label: mapped.product || item.name || sku,
        });
      } else {
        failures.push(`Non-Prosol item has no deterministic warehouse route: ${mapped.product || item.name || sku}`);
      }
      continue;
    }

    if (PERFECT_LEVEL_RE.test(mapped.product || displayName)) {
      failures.push(`Perfect Level requires explicit non-Prosol routing before automation (${mapped.product || displayName})`);
      continue;
    }

    resolved.push({ ...base, kind: 'prosol', apiSku: mapped.api_sku, label: mapped.product || item.name || sku });
  }
  return { resolved, fixedWarehouseItems, failures };
}

// Province centroids for distance-based fallback sorting
const PROVINCE_LAT_LNG = {
  BC: [49.28, -123.12], AB: [51.05, -114.07], SK: [50.45, -104.62], MB: [49.90, -97.14],
  ON: [43.65, -79.38], QC: [46.81, -71.21], NB: [46.09, -66.66], NS: [44.65, -63.57],
  PE: [46.24, -63.13], NL: [47.56, -52.71], YT: [60.72, -135.05], NT: [62.45, -114.37], NU: [63.75, -68.52],
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Minimum qty required at a preferred hub for it to be chosen. Avoids the
// "phantom last unit" trap (2026-04-21 order 702-7750339 routed to BURN
// because Prosol reported qty=1 of DHEHK24085 there; physically BURN had
// none — likely a reserved/allocated unit reported as available).
// Tier-down to >= 1 in the fallback tier so low-stock items still ship.
const MIN_QTY_PREFERRED = 2;

function scoreWarehouseAgainstOrder(locId, inventoryBySku) {
  // Returns the min qty across all SKUs at this warehouse, or 0 if any SKU
  // has no stock there. Higher = more stock for the whole order.
  let minQty = Infinity;
  for (const entry of Object.values(inventoryBySku)) {
    const stock = entry.locationStock?.[locId];
    const q = (stock && stock.available) ? (Number(stock.quantity) || 0) : 0;
    if (q === 0) return 0;
    if (q < minQty) minQty = q;
  }
  return minQty === Infinity ? 0 : minQty;
}

function determineWarehouse(province, inventoryBySku) {
  const preferred = MAIN_HUBS[province] || [];
  const [provLat, provLng] = PROVINCE_LAT_LNG[province] || [45, -75];
  const candidates = Object.entries(LOCATION_MAP)
    .map(([id, loc]) => ({ id: Number(id), ...loc }))
    .filter((loc) => loc.shipstation_warehouse_id);

  // Sort non-preferred candidates by distance to destination province
  const fallback = candidates
    .filter((c) => !preferred.includes(c.id))
    .sort((a, b) => haversineKm(provLat, provLng, a.lat || 0, a.lng || 0) - haversineKm(provLat, provLng, b.lat || 0, b.lng || 0));

  // Pass 1: preferred hubs, require qty >= MIN_QTY_PREFERRED across ALL SKUs.
  // Among passing hubs, pick the one with the highest min-qty (most stock
  // cushion) rather than the first in the hardcoded MAIN_HUBS list order.
  // This would have rejected BURN for the Terrace DITRA-HEAT order on
  // 2026-04-21 (1 phantom cable) and chosen WCAS or a fallback instead.
  const preferredScored = preferred
    .map((id) => ({ id, score: scoreWarehouseAgainstOrder(id, inventoryBySku) }))
    .filter((c) => c.score >= MIN_QTY_PREFERRED)
    .sort((a, b) => b.score - a.score);
  if (preferredScored.length) {
    const best = preferredScored[0];
    const location = LOCATION_MAP[String(best.id)];
    if (location && location.shipstation_warehouse_id) return { prosolLocId: best.id, location };
  }

  // Pass 2: preserve old ranked fallback (distance-sorted) with relaxed
  // threshold (qty >= 1) so low-stock items still ship from nearest source.
  const ranked = [...preferred, ...fallback.map((c) => c.id)];
  for (const locId of ranked) {
    const location = LOCATION_MAP[String(locId)];
    if (!location || !location.shipstation_warehouse_id) continue;
    if (scoreWarehouseAgainstOrder(locId, inventoryBySku) > 0) {
      return { prosolLocId: locId, location };
    }
  }
  return null;
}

async function getRates(order, fromPostalCode) {
  const bodyBase = {
    packageCode: 'package',
    fromPostalCode: fromPostalCode.replace(/\s/g, ''),
    toPostalCode: String(order.shipTo?.postalCode || '').replace(/\s/g, ''),
    toState: normalizeProvince(order.shipTo?.state) || order.shipTo?.state,
    toCountry: order.shipTo?.country || 'CA',
    toCity: order.shipTo?.city,
    weight: { value: Math.max(0.1, Number(toLb(order.weight).toFixed(2))), units: 'pounds' },
    confirmation: 'none',
    residential: !!order.shipTo?.residential,
  };

  async function one(carrierCode) {
    const res = await ssRequest('POST', '/shipments/getrates', { ...bodyBase, carrierCode });
    if (res.status !== 200) return null;
    const rates = JSON.parse(res.body);
    if (!Array.isArray(rates) || !rates.length) return null;
    // ShipStation actually charges shipmentCost + otherCost (fuel surcharge, accessorials).
    // Sort and report by the all-in total so the displayed estimate matches what hits the wallet.
    const best = rates
      .filter((r) => Number.isFinite(Number(r.shipmentCost)) && r.serviceCode)
      .map((r) => ({ ...r, totalCost: Number(r.shipmentCost) + Number(r.otherCost || 0) }))
      .sort((a, b) => a.totalCost - b.totalCost)[0];
    if (!best) return null;
    return {
      carrierCode,
      serviceCode: best.serviceCode,
      serviceName: best.serviceName || best.serviceCode,
      shipmentCost: best.totalCost,
    };
  }

  const street = `${order.shipTo?.street1 || ''} ${order.shipTo?.street2 || ''}`.trim();
  const isPoBox = PO_BOX_RE.test(street);
  const [ups, purolator, canadaPost] = await Promise.all([
    one('ups_walleted'),
    one('purolator_walleted'),
    one('canada_post_walleted'),
  ]);

  if (isPoBox) {
    if (!canadaPost) throw new Error('PO Box order but Canada Post returned no rate');
    return { winner: canadaPost, note: 'PO Box → Canada Post forced', compared: { ups, purolator, canadaPost } };
  }

  if (!ups && !purolator) throw new Error('No UPS or Purolator rate returned');
  const bestNonCp = [ups, purolator].filter(Boolean).sort((a, b) => a.shipmentCost - b.shipmentCost)[0];
  if (!canadaPost) return { winner: bestNonCp, note: '', compared: { ups, purolator, canadaPost } };

  const cpBeatsUps = ups ? (ups.shipmentCost - canadaPost.shipmentCost) > 4 : false;
  const cpBeatsPuro = purolator ? (purolator.shipmentCost - canadaPost.shipmentCost) > 4 : false;
  if (cpBeatsUps && cpBeatsPuro) {
    return { winner: canadaPost, note: 'Canada Post >$4 cheaper than UPS and Purolator', compared: { ups, purolator, canadaPost } };
  }

  return { winner: bestNonCp, note: '', compared: { ups, purolator, canadaPost } };
}

const SHIPSTATION_WAREHOUSE_META = Object.fromEntries(
  Object.values(LOCATION_MAP)
    .filter((loc) => loc.shipstation_warehouse_id)
    .map((loc) => [String(loc.shipstation_warehouse_id), loc])
);

function formatCarrier(code) {
  return String(code || '—').replace('_walleted', '').replace(/_/g, ' ');
}

async function fetchOrder(orderId) {
  const res = await ssRequest('GET', `/orders/${orderId}`);
  if (res.status !== 200) throw new Error(`GET /orders/${orderId} failed: ${res.status} ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

function assignmentMatches(order, assignment) {
  return Number(order.advancedOptions?.warehouseId || 0) === Number(assignment.warehouseId)
    && String(order.carrierCode || '') === String(assignment.carrierCode || '')
    && String(order.serviceCode || '') === String(assignment.serviceCode || '')
    && String(order.packageCode || '') === String(assignment.packageCode || '');
}

function buildUpdatePayload(order, assignment) {
  const advancedOptions = { ...(order.advancedOptions || {}), warehouseId: assignment.warehouseId };
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderKey: order.orderKey,
    orderDate: order.orderDate,
    orderStatus: order.orderStatus,
    billTo: order.billTo,
    shipTo: normalizeShipTo(order.shipTo),
    items: order.items,
    advancedOptions,
    carrierCode: assignment.carrierCode,
    serviceCode: assignment.serviceCode,
    packageCode: assignment.packageCode,
  };
}

async function stageAssignment(orderSummary, assignment) {
  const liveOrder = await fetchOrder(orderSummary.orderId);
  if (assignmentMatches(liveOrder, assignment)) {
    return { status: 'already-correct', order: liveOrder };
  }

  const res = await ssRequest('POST', '/orders/createorders', [buildUpdatePayload(liveOrder, assignment)]);
  if (res.status !== 200) {
    throw new Error(`ShipStation update failed: ${res.status} ${res.body.slice(0, 300)}`);
  }

  await sleep(1200);
  const verified = await fetchOrder(orderSummary.orderId);
  if (!assignmentMatches(verified, assignment)) {
    throw new Error(
      `Verification mismatch after update. Expected warehouse=${assignment.warehouseId}, carrier=${assignment.carrierCode}, service=${assignment.serviceCode}, package=${assignment.packageCode}; got warehouse=${verified.advancedOptions?.warehouseId || 'blank'}, carrier=${verified.carrierCode || 'blank'}, service=${verified.serviceCode || 'blank'}, package=${verified.packageCode || 'blank'}`
    );
  }

  return { status: 'updated', order: verified };
}

function renderTable(rows) {
  const headers = ['Order #', 'Item', 'To', 'From', 'Carrier', 'Cost', 'Notes'];
  const widths = headers.map((h) => h.length);
  const matrix = rows.map((row) => [row.orderNumber, row.item, row.to, row.from, row.carrier, row.cost, row.notes || '']);
  for (const cols of matrix) cols.forEach((v, i) => { widths[i] = Math.max(widths[i], String(v || '').length); });
  const line = (cols) => `| ${cols.map((v, i) => String(v || '').padEnd(widths[i])).join(' | ')} |`;
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...matrix.map(line)].join('\n');
}

// ── Core exported function ───────────────────────────────────────────────────

async function runOrders({ dryRun = false, filterOrderNumber = null, onProgress = () => {} } = {}) {
  onProgress({ type: 'status', message: filterOrderNumber ? `Fetching order ${filterOrderNumber}...` : 'Fetching awaiting_shipment orders from ShipStation...' });
  const allOrders = await fetchAwaitingOrders();
  let inScope = allOrders.filter(isInScope);
  if (filterOrderNumber) {
    inScope = inScope.filter(o => o.orderNumber === filterOrderNumber);
    if (!inScope.length) {
      return { dryRun, summary: { totalAwaiting: allOrders.length, amazonAwaiting: 0, plannable: 0, rejected: 0, errors: 1 }, assignments: [], manualReview: [{ orderNumber: filterOrderNumber, reason: 'Order not found in awaiting_shipment queue' }], errors: [] };
    }
  }
  const scopeOrders = [];
  const rejected = [];

  const amazonCount = inScope.filter(isAmazonOrder).length;
  const shopifyCount = inScope.filter(isShopifyOrder).length;
  onProgress({ type: 'status', message: `Found ${allOrders.length} total · ${amazonCount} Amazon · ${shopifyCount} Shopify. Filtering...` });

  for (const order of inScope) {
    const province = normalizeProvince(order.shipTo?.state);
    if (!province) {
      rejected.push({ orderNumber: order.orderNumber, reason: `Unsupported province/state: ${order.shipTo?.state || 'blank'}` });
      continue;
    }

    const { resolved, fixedWarehouseItems, failures } = resolveOrderItems(order);
    if (failures.length) {
      rejected.push({ orderNumber: order.orderNumber, reason: failures.join('; ') });
      continue;
    }
    const fixedWarehouseIds = [...new Set(fixedWarehouseItems.map((item) => item.warehouseId))];
    if (fixedWarehouseIds.length > 1) {
      rejected.push({ orderNumber: order.orderNumber, reason: `Conflicting fixed-warehouse rules: ${fixedWarehouseIds.join(', ')}` });
      continue;
    }
    if (fixedWarehouseIds.length && resolved.length) {
      rejected.push({ orderNumber: order.orderNumber, reason: 'Mixed Prosol and fixed non-Prosol routing requires manual review' });
      continue;
    }
    if (!resolved.length && !fixedWarehouseIds.length) {
      rejected.push({ orderNumber: order.orderNumber, reason: 'No in-scope run-orders items after filtering' });
      continue;
    }
    if (resolved.some((item) => isClearlyOutOfScope(item.name))) {
      rejected.push({ orderNumber: order.orderNumber, reason: 'Contains flooring-style item outside Amazon/Prosol run scope' });
      continue;
    }
    scopeOrders.push({
      ...order,
      source: orderSource(order),
      normalizedProvince: province,
      resolvedItems: resolved,
      fixedWarehouseId: fixedWarehouseIds[0] || null,
      fixedWarehouseItems,
    });
  }

  onProgress({ type: 'status', message: `${scopeOrders.length} orders in scope, ${rejected.length} flagged. Logging into Prosol...` });

  const client = new ProsolClientV2();
  await client.init();
  onProgress({ type: 'status', message: 'Prosol session ready. Checking inventory and rates...' });

  try {
    const inventoryCache = new Map();
    const plannedAssignments = [];
    const planningErrors = [];
    const stagingErrors = [];

    for (const order of scopeOrders) {
      try {
        let warehouseId;
        let warehouseLabel;
        let fromPostalCode;
        const itemPool = order.resolvedItems.length ? order.resolvedItems : order.fixedWarehouseItems;

        if (order.fixedWarehouseId) {
          const fixedWarehouse = SHIPSTATION_WAREHOUSE_META[String(order.fixedWarehouseId)];
          if (!fixedWarehouse) throw new Error(`Fixed warehouse ${order.fixedWarehouseId} is not in the ShipStation warehouse map`);
          warehouseId = Number(order.fixedWarehouseId);
          warehouseLabel = `${fixedWarehouse.city} (${fixedWarehouse.code})`;
          fromPostalCode = fixedWarehouse.postal_code;
        } else {
          const inventoryBySku = {};
          const uniqueSkus = [...new Set(order.resolvedItems.map((item) => item.apiSku))];
          for (const sku of uniqueSkus) {
            if (!inventoryCache.has(sku)) {
              onProgress({ type: 'inventory', message: `Checking Prosol stock: ${sku}`, orderNumber: order.orderNumber });
              inventoryCache.set(sku, await client.checkInventory(sku));
              await sleep(5000);
            }
            const inv = inventoryCache.get(sku);
            if (!inv) throw new Error(`No Prosol inventory result for ${sku}`);
            inventoryBySku[sku] = inv;
          }

          const warehouse = determineWarehouse(order.normalizedProvince, inventoryBySku);
          if (!warehouse) throw new Error('No single mapped Prosol warehouse has all required items');
          warehouseId = Number(warehouse.location.shipstation_warehouse_id);
          warehouseLabel = `${warehouse.location.city} (${warehouse.location.code})`;
          fromPostalCode = warehouse.location.postal_code;
        }

        onProgress({ type: 'rates', message: `Rate shopping for ${order.orderNumber}...`, orderNumber: order.orderNumber });
        const rate = await getRates(order, fromPostalCode);
        const itemSummary = itemPool.map((item) => `${item.qty}x ${item.label}`).join('; ');

        const assignment = {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          source: order.source || orderSource(order),
          itemSummary,
          destination: orderDestination(order),
          warehouseId,
          warehouseLabel,
          carrierCode: rate.winner.carrierCode,
          serviceCode: rate.winner.serviceCode,
          packageCode: 'package',
          serviceName: rate.winner.serviceName,
          shipmentCost: rate.winner.shipmentCost,
          rateNote: rate.note,
          compared: rate.compared,
        };
        plannedAssignments.push(assignment);
        onProgress({ type: 'order-planned', orderNumber: order.orderNumber, warehouse: warehouseLabel, carrier: formatCarrier(rate.winner.carrierCode), cost: formatMoney(rate.winner.shipmentCost) });
      } catch (error) {
        planningErrors.push({ orderNumber: order.orderNumber, reason: error.message });
        onProgress({ type: 'order-error', orderNumber: order.orderNumber, reason: error.message });
      }
    }

    plannedAssignments.sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber)));

    const assignments = [];
    if (!dryRun) {
      onProgress({ type: 'status', message: 'Staging assignments in ShipStation...' });
    }

    for (const assignment of plannedAssignments) {
      try {
        const staged = dryRun
          ? { status: 'planned', order: await fetchOrder(assignment.orderId) }
          : await stageAssignment(assignment, assignment);
        const actualWarehouse = SHIPSTATION_WAREHOUSE_META[String(staged.order.advancedOptions?.warehouseId || '')];

        const row = {
          // Display fields
          orderNumber: assignment.orderNumber,
          item: assignment.itemSummary,
          to: assignment.destination,
          from: dryRun ? assignment.warehouseLabel : (actualWarehouse ? `${actualWarehouse.city} (${actualWarehouse.code})` : assignment.warehouseLabel),
          carrier: dryRun
            ? `${formatCarrier(assignment.carrierCode)} / ${assignment.serviceCode}`
            : `${formatCarrier(staged.order.carrierCode || assignment.carrierCode)} / ${staged.order.serviceCode || assignment.serviceCode}`,
          cost: formatMoney(assignment.shipmentCost),
          notes: [
            dryRun ? 'DRY RUN' : (staged.status === 'already-correct' ? 'Already staged' : 'Staged'),
            assignment.rateNote,
          ].filter(Boolean).join('; '),
          status: dryRun ? 'dry-run' : staged.status,
          compared: assignment.compared,
          // Machine-readable fields for pipeline (label buying, POs, email)
          orderId: assignment.orderId,
          warehouseId: assignment.warehouseId,
          carrierCode: assignment.carrierCode,
          serviceCode: assignment.serviceCode,
          packageCode: assignment.packageCode,
          shipmentCost: assignment.shipmentCost,
          weight: { value: Math.max(0.1, Number(toLb(staged.order.weight).toFixed(2))), units: 'pounds' },
          shipTo: staged.order.shipTo,
          items: staged.order.items,
          // 'amazon_ca' | 'shopify' — drives phasePos routing (Amazon goes to
          // the rotating 14-day SO; Shopify per-order calls createShopifySoPo
          // to create an SF Sales Order + PO under the Shopify account). Was
          // silently dropped from the row for a long time, which is why
          // Shopify orders shipped without SF SOs getting created.
          source: assignment.source || null,
        };
        assignments.push(row);

        if (!dryRun) {
          onProgress({ type: 'order-staged', orderNumber: assignment.orderNumber, status: staged.status });
        }
      } catch (error) {
        stagingErrors.push({ orderNumber: assignment.orderNumber, reason: error.message });
        onProgress({ type: 'order-error', orderNumber: assignment.orderNumber, reason: error.message });
      }
    }

    assignments.sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber)));

    return {
      dryRun,
      summary: {
        totalAwaiting: allOrders.length,
        amazonAwaiting: amazonCount,
        shopifyAwaiting: shopifyCount,
        plannable: assignments.length,
        rejected: rejected.length,
        errors: planningErrors.length + stagingErrors.length,
      },
      assignments,
      manualReview: [...rejected, ...planningErrors].sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber))),
      errors: stagingErrors,
    };
  } finally {
    await client.close();
  }
}

// ── CLI mode ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run') || args.has('--plan');

  runOrders({
    dryRun,
    onProgress: (ev) => {
      if (ev.type === 'status') console.log(ev.message);
      else if (ev.type === 'inventory') console.log(`  ${ev.message}`);
      else if (ev.type === 'order-planned') console.log(`  Planned: ${ev.orderNumber} → ${ev.warehouse} via ${ev.carrier} (${ev.cost})`);
      else if (ev.type === 'order-staged') console.log(`  Staged: ${ev.orderNumber} (${ev.status})`);
      else if (ev.type === 'order-error') console.log(`  ERROR: ${ev.orderNumber} — ${ev.reason}`);
    },
  }).then((result) => {
    console.log(`\nRun-Orders ${dryRun ? 'planning snapshot (dry run)' : 'staging snapshot'}`);
    console.log(`Awaiting shipment total: ${result.summary.totalAwaiting}`);
    console.log(`Amazon awaiting shipment: ${result.summary.amazonAwaiting}`);
    console.log(`Plannable run-orders: ${result.summary.plannable}`);
    console.log('');
    if (result.assignments.length) console.log(renderTable(result.assignments));
    else console.log('No plannable run-orders found.');
    if (result.manualReview.length) {
      console.log('\nFlags / manual review');
      for (const row of result.manualReview) console.log(`- ${row.orderNumber}: ${row.reason}`);
    }
    process.exit(result.errors.length ? 2 : 0);
  }).catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runOrders, normalizeProvince, normalizeShipTo };
