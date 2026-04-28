/**
 * ShipStation V2 API client — used for pickups, label downloads, etc.
 * V1 API is used directly in run-orders.js; this handles V2-only endpoints.
 */

const https = require('https');

const V2_KEY = process.env.SHIPSTATION_V2_API_KEY;
const V1_KEY = process.env.SHIPSTATION_API_KEY;
const V1_SECRET = process.env.SHIPSTATION_API_SECRET;

const V2_HOST = 'api.shipstation.com';
const V1_HOST = 'ssapi.shipstation.com';

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function v2Request(method, endpoint, body = null) {
  if (!V2_KEY) throw new Error('Missing SHIPSTATION_V2_API_KEY');
  return httpsRequest({
    hostname: V2_HOST,
    path: endpoint,
    method,
    headers: {
      'API-Key': V2_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  }, body);
}

async function v1Request(method, endpoint, body = null) {
  if (!V1_KEY || !V1_SECRET) throw new Error('Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET');
  const auth = Buffer.from(`${V1_KEY}:${V1_SECRET}`).toString('base64');
  const res = await httpsRequest({
    hostname: V1_HOST,
    path: endpoint,
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  }, body);
  if (res.status === 429) {
    const wait = parseInt(res.headers['retry-after'] || '30', 10);
    await new Promise(r => setTimeout(r, wait * 1000));
    return v1Request(method, endpoint, body);
  }
  return res;
}

// ── Shipments (shipped labels) ───────────────────────────────────────────────

async function fetchShippedShipments({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const shipments = [];
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const res = await v1Request('GET', `/shipments?shipDateStart=${since}&pageSize=100&page=${page}`);
    if (res.status !== 200) throw new Error(`Shipments fetch failed: ${res.status}`);
    const data = JSON.parse(res.body);
    shipments.push(...(data.shipments || []));
    pages = data.pages || 1;
    page++;
  }
  return shipments;
}

// ── Pickups (V2) ─────────────────────────────────────────────────────────────

const CARRIER_IDS = {
  ups_walleted: 'se-1813879',
  purolator_walleted: 'se-1813880',
};

// Province → IANA timezone
const PROVINCE_TZ = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg',
  ON: 'America/Toronto', QC: 'America/Toronto', NB: 'America/Moncton', NS: 'America/Halifax',
  PE: 'America/Halifax', NL: 'America/St_Johns', YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit',
};

function localTimeToUTC(date, localHour, province) {
  const tz = PROVINCE_TZ[province] || 'America/Toronto';
  // Build a date string in the local tz, then convert to UTC
  const local = new Date(`${date}T${String(localHour).padStart(2, '0')}:00:00`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  // Get UTC offset by comparing local representation
  const localStr = `${date}T${String(localHour).padStart(2, '0')}:00:00`;
  const utcGuess = new Date(localStr + 'Z');
  const inTz = new Date(utcGuess.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = inTz.getTime() - utcGuess.getTime();
  const utc = new Date(new Date(localStr).getTime() - offsetMs);
  return utc.toISOString().replace('.000Z', 'Z');
}

async function bookPickup({ carrierId, labelIds, pickupDate, warehouseAddress, warehouseProvince, contactName, contactEmail = 'mac@customfc.ca', contactPhone, pickupNotes, pickupWindow }) {
  // Pickup window from location map [startHour, endHour] in local tz; default 11 AM - 4 PM.
  // Wide enough that the carrier driver can come anytime during business hours instead of
  // being boxed into a narrow 2-4 PM slot and skipping if their route doesn't fit.
  const [startHour, endHour] = Array.isArray(pickupWindow) && pickupWindow.length === 2 ? pickupWindow : [11, 16];
  const startUTC = localTimeToUTC(pickupDate, startHour, warehouseProvince);
  const endUTC = localTimeToUTC(pickupDate, endHour, warehouseProvince);

  const payload = {
    carrier_id: carrierId,
    label_ids: labelIds,
    pickup_date: pickupDate,
    contact_details: {
      name: contactName || 'Prosol Warehouse',
      email: contactEmail,
      phone: contactPhone || '514-745-1212',
    },
    pickup_window: {
      start_at: startUTC,
      end_at: endUTC,
    },
  };

  // Purolator requires pickup_address
  if (warehouseAddress) {
    payload.pickup_address = warehouseAddress;
  }

  if (pickupNotes) {
    payload.pickup_notes = pickupNotes;
  }

  const res = await v2Request('POST', '/v2/pickups', payload);
  const data = res.status >= 200 && res.status < 300 ? JSON.parse(res.body) : null;

  if (res.status >= 200 && res.status < 300) {
    return {
      success: true,
      pickupId: data.pickup_id || data.id,
      confirmation: data.confirmation_number || data.pickup_id,
      carrier: carrierId,
    };
  }

  return {
    success: false,
    error: `HTTP ${res.status}`,
    body: res.body,
    carrier: carrierId,
  };
}

// ── Label download (V2) ──────────────────────────────────────────────────────

// One-shot retry on retryable failures (5xx, 404). 401/403 stay hard fails —
// retrying auth errors just spams. No retry justified by warm-up (phaseEmail
// runs minutes after phaseBuy), but one retry cheaply rides out transient
// ShipStation hiccups observed in the wild.
async function getLabelUrl(shipmentId) {
  const retryable = (status) => status >= 500 || status === 404;
  const tries = 2;
  const backoffMs = 2000;
  for (let i = 0; i < tries; i++) {
    const res = await v2Request('GET', `/v2/labels/se-${shipmentId}`);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      return data.label_download?.pdf || null;
    }
    if (!retryable(res.status) || i === tries - 1) return null;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  return null;
}

function collectPdf(res) {
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) {
      res.resume(); // drain so the socket is freed
      reject(new Error(`label CDN returned HTTP ${res.statusCode}`));
      return;
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function downloadLabelPdf(shipmentId) {
  const url = await getLabelUrl(shipmentId);
  if (!url) return null;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (!res.headers.location) {
          reject(new Error('redirect without Location header'));
          return;
        }
        mod.get(res.headers.location, (res2) => {
          collectPdf(res2).then(resolve, reject);
        }).on('error', reject);
        return;
      }
      collectPdf(res).then(resolve, reject);
    }).on('error', reject);
  });
}

// ── Order lookup + cancel (V1) ──────────────────────────────────────────────
// ShipStation V1 addresses orders by numeric `orderId` and a store-scoped
// `orderKey` (Amazon order id is stored as `orderNumber`). The GET filter is
// `orderNumber=` which returns at most one order per store for a normal MFN
// Amazon integration.

async function findOrderByAmazonOrderId(amazonOrderId) {
  const res = await v1Request('GET', `/orders?orderNumber=${encodeURIComponent(amazonOrderId)}`);
  if (res.status !== 200) return null;
  const data = JSON.parse(res.body);
  const orders = data.orders || [];
  if (!orders.length) return null;
  // If multiple stores pull the same MFN order (rare), prefer the first
  // unshipped one. Otherwise just return the first match.
  const unshipped = orders.find((o) => o.orderStatus && o.orderStatus.toLowerCase() === 'awaiting_shipment');
  return unshipped || orders[0];
}

// DELETE /orders/{orderId} soft-cancels — ShipStation sets orderStatus='cancelled'
// and removes the order from shipping queues. Data is retained and visible
// under the Cancelled filter; the action can be reversed by Mac in the UI.
async function cancelOrder(orderId) {
  const res = await v1Request('DELETE', `/orders/${orderId}`);
  if (res.status !== 200) throw new Error(`ShipStation cancel failed: ${res.status} ${res.body}`);
  return JSON.parse(res.body || '{}');
}

// Normalize province code on an order before buying labels
async function normalizeOrderAddress(orderId, shipTo) {
  if (!shipTo?.state) return false;
  const raw = String(shipTo.state || '').trim().toUpperCase();
  const provinceMap = {
    'BRITISH COLUMBIA': 'BC', 'ALBERTA': 'AB', 'SASKATCHEWAN': 'SK', 'MANITOBA': 'MB',
    'ONTARIO': 'ON', 'QUEBEC': 'QC', 'QUÉBEC': 'QC', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS',
    'PRINCE EDWARD ISLAND': 'PE', 'NEWFOUNDLAND AND LABRADOR': 'NL', 'YUKON': 'YT', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU',
  };
  const normalized = provinceMap[raw] || raw;
  if (normalized === raw) return false; // already normalized or unknown

  const updated = { ...shipTo, state: normalized };
  const res = await v1Request('PUT', `/orders/${orderId}`, { shipTo: updated });
  if (res.status !== 200) {
    console.error(`normalizeOrderAddress failed: ${res.status} ${res.body.slice(0, 100)}`);
    return false;
  }
  return true;
}

module.exports = {
  v1Request,
  v2Request,
  fetchShippedShipments,
  bookPickup,
  getLabelUrl,
  downloadLabelPdf,
  findOrderByAmazonOrderId,
  cancelOrder,
  normalizeOrderAddress,
  CARRIER_IDS,
};
