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

// ShipStation V2 rate-limits aggressively (HTTP 429). When the hanging-shipment
// backlog grows, the daily stale-scan + pickup sweep bursts enough V2 calls to
// trip the limit — and without back-off EVERY pickup booking then returns 429
// and fails, collapsing the whole sweep (this is exactly what happened June 1-2,
// 2026). Retry on 429 honoring the Retry-After header, with capped exponential
// back-off so a throttled run slows down instead of failing. Attempts + per-wait
// are capped so a persistent throttle can never wedge a cron.
const V2_MAX_ATTEMPTS = 5;
const V2_MAX_WAIT_MS = 30000;

async function v2Request(method, endpoint, body = null) {
  if (!V2_KEY) throw new Error('Missing SHIPSTATION_V2_API_KEY');
  for (let attempt = 1; ; attempt++) {
    const res = await httpsRequest({
      hostname: V2_HOST,
      path: endpoint,
      method,
      headers: {
        'API-Key': V2_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    }, body);
    if (res.status !== 429 || attempt >= V2_MAX_ATTEMPTS) return res;
    const retryAfter = parseInt(res.headers['retry-after'] || '', 10);
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s…
    await new Promise((r) => setTimeout(r, Math.min(wait, V2_MAX_WAIT_MS)));
  }
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

// Canonical 2-letter province codes the carriers accept for country=CA
const CA_PROVINCE_CODES = new Set(['BC','AB','SK','MB','ON','QC','NB','NS','PE','NL','YT','NT','NU']);

const PROVINCE_NAME_TO_CODE = {
  'BRITISH COLUMBIA': 'BC', 'COLOMBIE-BRITANNIQUE': 'BC',
  'ALBERTA': 'AB',
  'SASKATCHEWAN': 'SK',
  'MANITOBA': 'MB',
  'ONTARIO': 'ON',
  'QUEBEC': 'QC', 'QUÉBEC': 'QC',
  'NEW BRUNSWICK': 'NB', 'NOUVEAU-BRUNSWICK': 'NB',
  'NOVA SCOTIA': 'NS', 'NOUVELLE-ÉCOSSE': 'NS', 'NOUVELLE-ECOSSE': 'NS',
  'PRINCE EDWARD ISLAND': 'PE', 'ÎLE-DU-PRINCE-ÉDOUARD': 'PE', 'ILE-DU-PRINCE-EDOUARD': 'PE',
  'NEWFOUNDLAND AND LABRADOR': 'NL', 'NEWFOUNDLAND': 'NL', 'TERRE-NEUVE-ET-LABRADOR': 'NL',
  'YUKON': 'YT', 'YUKON TERRITORY': 'YT',
  'NORTHWEST TERRITORIES': 'NT', 'TERRITOIRES DU NORD-OUEST': 'NT',
  'NUNAVUT': 'NU',
  PQ: 'QC', // legacy code Amazon sometimes still emits
};

function normalizeProvinceCode(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return null;
  if (CA_PROVINCE_CODES.has(value)) return value;
  return PROVINCE_NAME_TO_CODE[value] || null;
}

/**
 * Detect ship-to fields that carriers (Purolator especially) hard-reject, so we
 * HALT before spending on a guaranteed-rejected label instead of eating the
 * error after the buy (as happened on 701-5518826-4465017, 2026-07-14).
 *
 * Fails safe — reports issues for a human to fix — rather than auto-rewriting
 * the address. A mis-parsed street could mis-ship, which is NOT reversible;
 * a rare manual fix is. Purolator refs: 1100238 (Address1 invalid),
 * 1100236 (receiver name > 30). Returns [] when the address looks carrier-safe.
 */
function assessCarrierAddress(ship = {}) {
  const issues = [];
  const name = String(ship.name || '').trim();
  const street1 = String(ship.street1 || '').trim();
  const postal = String(ship.postalCode || '').replace(/\s+/g, '').toUpperCase();

  // Composite Address1: the whole formatted address got jammed into street1.
  // Strongest low-false-positive signal — street1 contains the destination
  // postal code, which a real single street line never does. (Purolator 1100238.)
  if (postal && street1.replace(/\s+/g, '').toUpperCase().includes(postal)) {
    issues.push({
      code: 'ADDRESS1_COMPOSITE',
      field: 'street1',
      detail: `street1 contains the postal code (${ship.postalCode}) — full address jammed into Address1: "${street1}"`,
    });
  }

  // Receiver name over Purolator's 30-char limit (1100236).
  if (name.length > 30) {
    issues.push({
      code: 'NAME_TOO_LONG',
      field: 'name',
      detail: `receiver name is ${name.length} chars (Purolator max 30): "${name}"`,
    });
  }

  return issues;
}

/**
 * Pre-buy guard: read the live order's shipTo, and if its province isn't a
 * carrier-acceptable 2-letter code, attempt one upsert via /orders/createorders
 * and verify. Throws a structured error if the address still can't be made
 * carrier-safe — caller should surface this directly to ops (don't spend money
 * calling /orders/createlabelfororder when we know UPS will reject it).
 *
 * Replaces the previous `normalizeOrderAddress` which used an unsupported
 * `PUT /orders/{id}` endpoint and silently no-op'd.
 */
async function ensureValidShipTo(orderId, orderNumber) {
  const getRes = await v1Request('GET', `/orders/${orderId}`);
  if (getRes.status !== 200) {
    throw new Error(`ensureValidShipTo: GET /orders/${orderId} failed: ${getRes.status}`);
  }
  const order = JSON.parse(getRes.body);
  const ship = order.shipTo || {};
  const country = String(ship.country || '').trim().toUpperCase();

  // Carrier hard-reject guard (all countries) — halt before spending on a label
  // the carrier will refuse. Runs ahead of the CA province logic so it also
  // covers US/intl. See assessCarrierAddress for the Purolator 1100238/1100236
  // failure modes this catches.
  const addrIssues = assessCarrierAddress(ship);
  if (addrIssues.length) {
    const e = new Error(`Ship-to will be carrier-rejected for ${orderNumber}: ${addrIssues.map((i) => i.detail).join(' | ')}. Fix shipTo in ShipStation UI then retry.`);
    e.code = 'BAD_ADDRESS_CARRIER_REJECT';
    e.orderId = orderId;
    e.orderNumber = orderNumber;
    e.issues = addrIssues;
    throw e;
  }

  // We only own normalization for CA right now. US/intl: pass through and let
  // the carrier reject if it must — those routes aren't part of the run-orders
  // scope today. Revisit if we expand.
  if (country !== 'CA') return { changed: false, finalState: ship.state, country };

  const current = String(ship.state || '');
  const normalized = normalizeProvinceCode(current);
  if (normalized && current === normalized) {
    return { changed: false, finalState: normalized, country };
  }
  if (!normalized) {
    const e = new Error(`Bad ship-to province for ${orderNumber}: state="${current}" country="${country}". Fix manually in ShipStation UI then retry.`);
    e.code = 'BAD_ADDRESS_PROVINCE';
    e.orderId = orderId;
    e.orderNumber = orderNumber;
    throw e;
  }

  // Upsert via /orders/createorders with full order body + normalized state.
  // ShipStation V1's createorders is the documented upsert endpoint (matches on
  // orderKey). The previous PUT /orders/{id} path returned 404.
  const updated = {
    ...order,
    shipTo: { ...ship, state: normalized },
  };
  const upsertRes = await v1Request('POST', '/orders/createorders', [updated]);
  if (upsertRes.status !== 200) {
    const e = new Error(`ensureValidShipTo: createorders failed for ${orderNumber}: ${upsertRes.status} ${upsertRes.body.slice(0, 200)}`);
    e.code = 'BAD_ADDRESS_UPSERT_FAILED';
    e.orderId = orderId;
    e.orderNumber = orderNumber;
    throw e;
  }

  // Verify the change actually persisted (Amazon-channel orders historically
  // resist shipTo edits — fail loud if it didn't take).
  await new Promise((r) => setTimeout(r, 800));
  const verifyRes = await v1Request('GET', `/orders/${orderId}`);
  if (verifyRes.status !== 200) {
    throw new Error(`ensureValidShipTo: verify GET failed: ${verifyRes.status}`);
  }
  const verified = JSON.parse(verifyRes.body);
  const after = String(verified.shipTo?.state || '');
  if (after !== normalized) {
    const e = new Error(`Address fix did not persist for ${orderNumber}: state still "${after}" (wanted "${normalized}"). Edit shipTo manually in ShipStation UI then retry.`);
    e.code = 'BAD_ADDRESS_NOT_PERSISTED';
    e.orderId = orderId;
    e.orderNumber = orderNumber;
    throw e;
  }
  return { changed: true, finalState: normalized, country, was: current };
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
  ensureValidShipTo,
  assessCarrierAddress,
  normalizeProvinceCode,
  CA_PROVINCE_CODES,
  CARRIER_IDS,
};
