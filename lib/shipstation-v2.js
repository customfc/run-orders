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
 * a rare manual fix is. The ONE exception is a pure suffix drop of segments that
 * exactly duplicate the order's own city/state/country/postal — see
 * stripCompositeAddress1, which invents nothing. Purolator refs: 1100238
 * (Address1 invalid), 1100236 (receiver name > 30). Returns [] when the address
 * looks carrier-safe.
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
  } else {
    // Same defect without the postal code — Shopify address autocomplete emits
    // "12316 188A Street, Pitt Meadows, BC, Canada" (order 1331, 2026-08-06:
    // four buy ticks, four Purolator 1100238s, order sat a day unshipped).
    const stripped = stripCompositeAddress1(ship);
    if (stripped) {
      issues.push({
        code: 'ADDRESS1_COMPOSITE',
        field: 'street1',
        detail: `street1 repeats the city/province/country the order already carries — "${street1}" (street is "${stripped}")`,
      });
    }
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

const COUNTRY_TOKENS = {
  CA: new Set(['CA', 'CAN', 'CANADA']),
  US: new Set(['US', 'USA', 'UNITEDSTATES', 'UNITEDSTATESOFAMERICA']),
};

/**
 * Repair a composite Address1 — the whole formatted address jammed into street1
 * by Shopify's address autocomplete ("12316 188A Street, Pitt Meadows, BC,
 * Canada"), which Purolator hard-rejects with 1100238.
 *
 * The repair is a pure SUFFIX DROP: split on commas, remove trailing segments
 * that exactly duplicate the order's own city / province / country / postal
 * fields, keep everything else verbatim. Nothing is re-parsed, reordered, or
 * inferred, and every dropped token still prints on the label from its own
 * field — so this is information-preserving, the same bar splitLongReceiverName
 * clears. The first segment is never dropped.
 *
 * Returns the corrected street1, or null when there is nothing safely droppable
 * (leave it for a human rather than guessing at the street).
 */
function stripCompositeAddress1(ship = {}) {
  const raw = String(ship.street1 || '').trim();
  if (!raw.includes(',')) return null;
  const segs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;

  const norm = (s) => String(s || '').replace(/[\s.\-]+/g, '').toUpperCase();
  const city = norm(ship.city);
  const postal = norm(ship.postalCode);
  const stateCode = normalizeProvinceCode(ship.state); // CA only; falls back to the raw match below
  const stateRaw = norm(ship.state);
  const country = String(ship.country || '').trim().toUpperCase();
  const countries = COUNTRY_TOKENS[country] || new Set([norm(country)]);

  const isRedundant = (seg) => {
    const n = norm(seg);
    if (!n) return true;
    if (city && n === city) return true;
    if (postal && n === postal) return true;
    if (stateRaw && n === stateRaw) return true;
    if (stateCode && normalizeProvinceCode(seg) === stateCode) return true;
    return countries.has(n);
  };

  let end = segs.length;
  while (end > 1 && isRedundant(segs[end - 1])) end -= 1;
  if (end === segs.length) return null; // nothing redundant — not this defect
  const head = segs.slice(0, end).join(', ').trim();
  return head && head !== raw ? head : null;
}

/**
 * Purolator hard-rejects receiver names over 30 chars (err 1100236). When the
 * long name splits at a word boundary and company is free, move the overflow
 * into company — both lines print on the label, so the full business name
 * survives verbatim. This is the one address defect that's safe to auto-fix:
 * unlike street rewriting, no token is altered or dropped, only re-wrapped.
 * Returns { name, company } or null when no safe split exists (single token
 * over 30, company already occupied, or the remainder itself exceeds 30).
 */
function splitLongReceiverName(rawName, rawCompany) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (name.length <= 30) return null;
  if (String(rawCompany || '').trim()) return null;
  const cut = name.lastIndexOf(' ', 30);
  if (cut <= 0) return null;
  const head = name.slice(0, cut).trimEnd();
  const rest = name.slice(cut + 1).trim();
  if (!head || !rest || rest.length > 30) return null;
  return { name: head, company: rest };
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
  let order = JSON.parse(getRes.body);
  let ship = order.shipTo || {};
  const country = String(ship.country || '').trim().toUpperCase();

  // Carrier hard-reject guard (all countries) — halt before spending on a label
  // the carrier will refuse. Runs ahead of the CA province logic so it also
  // covers US/intl. See assessCarrierAddress for the Purolator 1100238/1100236
  // failure modes this catches.
  let addrIssues = assessCarrierAddress(ship);

  // NAME_TOO_LONG is self-healable (see splitLongReceiverName). Before June
  // 2026 these orders wedged in awaiting_shipment for days, re-failing every
  // cron run until someone edited the name in the ShipStation UI (701-9959811
  // sat 4 days). Fix via the createorders upsert, verify it persisted
  // (Amazon-channel orders historically resist shipTo edits), then re-assess.
  if (addrIssues.some((i) => i.code === 'NAME_TOO_LONG')) {
    const split = splitLongReceiverName(ship.name, ship.company);
    if (split) {
      const upsertName = await v1Request('POST', '/orders/createorders', [{ ...order, shipTo: { ...ship, ...split } }]);
      if (upsertName.status === 200) {
        await new Promise((r) => setTimeout(r, 800));
        const check = await v1Request('GET', `/orders/${orderId}`);
        if (check.status === 200) {
          const fresh = JSON.parse(check.body);
          if (String(fresh.shipTo?.name || '') === split.name) {
            console.log(`[ensureValidShipTo] auto-split long receiver name for ${orderNumber}: name="${split.name}" company="${split.company}"`);
            order = fresh;
            ship = order.shipTo || {};
            addrIssues = assessCarrierAddress(ship);
          }
        }
      } else {
        console.warn(`[ensureValidShipTo] name-split upsert failed for ${orderNumber}: ${upsertName.status} ${upsertName.body.slice(0, 120)}`);
      }
    }
  }

  // ADDRESS1_COMPOSITE is self-healable when the overflow is purely the city /
  // province / country / postal the order already carries (see
  // stripCompositeAddress1 — no token is invented, only un-duplicated). Same
  // upsert → verify → re-assess shape as the name split above. When the strip
  // finds nothing safe to drop we fall through and halt for a human.
  if (addrIssues.some((i) => i.code === 'ADDRESS1_COMPOSITE')) {
    const street1 = stripCompositeAddress1(ship);
    if (street1) {
      const upsertAddr = await v1Request('POST', '/orders/createorders', [{ ...order, shipTo: { ...ship, street1 } }]);
      if (upsertAddr.status === 200) {
        await new Promise((r) => setTimeout(r, 800));
        const check = await v1Request('GET', `/orders/${orderId}`);
        if (check.status === 200) {
          const fresh = JSON.parse(check.body);
          if (String(fresh.shipTo?.street1 || '') === street1) {
            console.log(`[ensureValidShipTo] stripped composite Address1 for ${orderNumber}: "${ship.street1}" -> "${street1}"`);
            order = fresh;
            ship = order.shipTo || {};
            addrIssues = assessCarrierAddress(ship);
          }
        }
      } else {
        console.warn(`[ensureValidShipTo] address1 strip upsert failed for ${orderNumber}: ${upsertAddr.status} ${upsertAddr.body.slice(0, 120)}`);
      }
    }
  }

  if (addrIssues.length) {
    const e = new Error(`Ship-to will be carrier-rejected for ${orderNumber}: ${addrIssues.map((i) => i.detail).join(' | ')}. Fix shipTo in ShipStation UI then retry.`);
    e.code = 'BAD_ADDRESS_CARRIER_REJECT';
    e.orderId = orderId;
    e.orderNumber = orderNumber;
    e.issues = addrIssues;
    throw e;
  }

  // Normalize stored dimensions to inches BEFORE any label buy. Amazon.ca
  // populates order dims in CENTIMETERS, but createlabelfororder rates the
  // stored dims in the account's default unit (inches) — a 122 cm item becomes a
  // "122 inch" package and eats an oversize surcharge (order 6587132: $54 vs
  // $17). ShipStation ignores dimensions passed in the label payload, so the fix
  // must be on the ORDER, via the createorders upsert. Runs for all countries
  // (dim inflation isn't CA-specific) and independently of the province path
  // below, which returns early for already-valid addresses.
  const dimsUnit = String((order.dimensions && order.dimensions.units) || '').toLowerCase();
  const inchDims = toInchDimensions(order.dimensions);
  if (inchDims && dimsUnit && !['inches', 'inch', 'in'].includes(dimsUnit)) {
    const dimUp = await v1Request('POST', '/orders/createorders', [{ ...order, dimensions: inchDims }]);
    if (dimUp.status === 200) {
      order.dimensions = inchDims; // reflect for the return + any later province upsert
    } else {
      console.warn(`[ensureValidShipTo] dim normalize failed for ${orderNumber}: ${dimUp.status} ${dimUp.body.slice(0, 120)}`);
    }
  }

  // We only own normalization for CA right now. US/intl: pass through and let
  // the carrier reject if it must — those routes aren't part of the run-orders
  // scope today. Revisit if we expand.
  if (country !== 'CA') return { changed: false, finalState: ship.state, country, dimensions: order.dimensions };

  const current = String(ship.state || '');
  const normalized = normalizeProvinceCode(current);
  if (normalized && current === normalized) {
    return { changed: false, finalState: normalized, country, dimensions: order.dimensions };
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
  return { changed: true, finalState: normalized, country, was: current, dimensions: order.dimensions };
}

// Convert a ShipStation dimensions object to inches for label rating. Amazon.ca
// populates order dims in CENTIMETERS, but ShipStation's createlabelfororder
// rates stored dims in the account's default unit (inches) — so a 64×30×10 cm
// niche board gets rated as a 64×30×10 INCH box (~115 lb dim weight, ~$66).
// Passing explicit inch dimensions overrides that. cm → ÷2.54; inches → as-is;
// unknown-units-with-values → treat as cm (our orders come from Amazon.ca).
// Returns null when there are no usable dims (caller omits → weight-only rating).
function toInchDimensions(d) {
  if (!d) return null;
  const L = Number(d.length), W = Number(d.width), H = Number(d.height);
  if (![L, W, H].every((n) => Number.isFinite(n) && n > 0)) return null;
  const u = String(d.units || '').toLowerCase();
  const isInches = u === 'inches' || u === 'inch' || u === 'in';
  const f = isInches ? 1 : 1 / 2.54;
  const r = (x) => Math.round(x * f * 10) / 10;
  return { units: 'inches', length: r(L), width: r(W), height: r(H) };
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
  toInchDimensions,
  assessCarrierAddress,
  splitLongReceiverName,
  stripCompositeAddress1,
  normalizeProvinceCode,
  CA_PROVINCE_CODES,
  CARRIER_IDS,
};
