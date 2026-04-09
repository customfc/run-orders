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

async function bookPickup({ carrierId, labelIds, pickupDate, warehouseAddress, contactName, contactEmail = 'mac@customfc.ca', contactPhone, pickupNotes }) {
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
      start_at: `${pickupDate}T14:00:00Z`,
      end_at: `${pickupDate}T21:00:00Z`,
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

async function getLabelUrl(shipmentId) {
  const res = await v2Request('GET', `/v2/labels/se-${shipmentId}`);
  if (res.status !== 200) return null;
  const data = JSON.parse(res.body);
  return data.label_download?.pdf || null;
}

module.exports = {
  v1Request,
  v2Request,
  fetchShippedShipments,
  bookPickup,
  getLabelUrl,
  CARRIER_IDS,
};
