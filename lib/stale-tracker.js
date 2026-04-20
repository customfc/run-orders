/**
 * Stale shipment tracker — finds "hanging" shipments (label printed, carrier hasn't
 * physically scanned the package yet).
 *
 * Source of truth: V2 /v2/labels/{label_id}/track events with carrier status codes:
 *   NY = Not Yet In System  (label created, carrier hasn't received) — HANGING
 *   AC = Accepted           (electronic info only, no physical scan)  — HANGING
 *   UN = Unknown                                                       — HANGING
 *   IT = In Transit                                                    — moved
 *   AT = Attempted delivery                                            — moved
 *   DE = Delivered                                                     — terminal
 *   EX = Exception                                                     — moved
 *
 * Anything in {NY, AC, UN, ''} (or no events) means the carrier hasn't taken
 * possession yet. The V2 `tracking_status` field is unreliable (returns 'in_transit'
 * even when the carrier message says "Shipper created a label, UPS has not received
 * the package yet"), so we ignore it.
 *
 * Pickup state is reported as orthogonal metadata, not a status — a hanging shipment
 * may have no pickup, a future-booked pickup, or a past-booked pickup that the
 * carrier no-showed.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { fetchShippedShipments, v1Request, v2Request } = require('./shipstation-v2');

// ── Canada Post direct API fallback ──────────────────────────────────────────
// V2 /v2/labels/{id}/track returns empty events for older CP shipments that
// actually moved or delivered. CP's own tracking API is authoritative — we
// hit it whenever a CP label has zero V2 events.

const CP_KEY = process.env.CANADA_POST_API_KEY;
const CP_SECRET = process.env.CANADA_POST_API_SECRET;

function cpTrack(trackingNumber) {
  if (!CP_KEY || !CP_SECRET) return Promise.resolve(null);
  const auth = Buffer.from(`${CP_KEY}:${CP_SECRET}`).toString('base64');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'soa-gw.canadapost.ca',
      path: `/vis/track/pin/${trackingNumber}/summary`,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/vnd.cpc.track-v2+xml',
        'Accept-language': 'en-CA',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        const events = (d.match(/<event-description>([^<]+)<\/event-description>/g) || [])
          .map((m) => m.replace(/<[^>]+>/g, ''));
        const deliveredDate = (d.match(/<actual-delivery-date>([^<]+)</) || [])[1] || null;
        resolve({ events, deliveredDate, latestEvent: events[0] || null });
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Map CP event text to a V2-style status code so downstream logic stays unified.
function cpEventToStatusCode(eventText, deliveredDate) {
  if (deliveredDate) return 'DE';
  const s = String(eventText || '').toLowerCase();
  if (!s) return '';
  if (s.includes('delivered')) return 'DE';
  // "Electronic information submitted by shipper" is CP's AC — carrier hasn't received yet
  if (s.includes('electronic information') || s.includes('shipper has electronically')) return 'AC';
  // Any other event = real carrier movement
  return 'IT';
}

// ── Purolator status reclassification ──────────────────────────────────────
// ShipEngine maps many Purolator events to AC (Accepted) even when the carrier
// description clearly indicates physical movement (e.g. "Picked up by Purolator
// at …", "In transit", "Arrived at …"). Override the status code based on
// description text so the stale tracker sees real movement.

function puroEventToStatusCode(description, originalCode) {
  const s = String(description || '').toLowerCase();
  if (!s) return originalCode;
  if (s.includes('delivered'))                               return 'DE';
  if (s.includes('out for delivery'))                        return 'IT';
  if (s.includes('picked up'))                               return 'IT';
  if (s.includes('in transit'))                              return 'IT';
  if (s.includes('arrived') || s.includes('departure'))      return 'IT';
  if (s.includes('processing') || s.includes('processed'))   return 'IT';
  if (s.includes('on vehicle') || s.includes('with courier')) return 'IT';
  if (s.includes('attempted delivery'))                      return 'AT';
  if (s.includes('exception') || s.includes('delay'))        return 'EX';
  // Label-only events — keep original code
  if (s.includes('shipper created') || s.includes('electronically submitted')) return originalCode;
  if (s.includes('label information'))                       return originalCode;
  return originalCode;
}

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'), 'utf8')
);
const WAREHOUSE_BY_SS_ID = {};
for (const [, loc] of Object.entries(LOCATION_MAP)) {
  if (loc.shipstation_warehouse_id) {
    WAREHOUSE_BY_SS_ID[String(loc.shipstation_warehouse_id)] = loc;
  }
}

const HANGING_CODES = new Set(['NY', 'AC', 'UN', '']);

// ── Fetch V2 tracking events per label ───────────────────────────────────────

async function fetchV2Track(labelId) {
  const res = await v2Request('GET', `/v2/labels/${labelId}/track`);
  if (res.status !== 200) return null;
  const data = JSON.parse(res.body);
  const events = (data.events || []).map(e => ({
    status_code: e.status_code || '',
    occurred_at: e.occurred_at,
    description: e.description || e.carrier_status_description || '',
  }));
  return { events, topStatusCode: data.status_code || null };
}

async function fetchTrackingDetails(labelIds, labelToShipment) {
  const out = new Map();
  const batchSize = 5;
  for (let i = 0; i < labelIds.length; i += batchSize) {
    const batch = labelIds.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (labelId) => {
      try {
        let v2 = await fetchV2Track(labelId);
        // Retry-on-empty: ShipEngine sometimes returns 200 w/ no events on cold-cache.
        // If V2 top-level status says the carrier has it (IT/AT/DE) but events[] is empty,
        // that's a stale cache — sleep 2s and retry once.
        const MOVED_TOP = new Set(['IT', 'AT', 'DE', 'EX']);
        if (v2 && v2.events.length === 0 && MOVED_TOP.has(v2.topStatusCode)) {
          await new Promise((r) => setTimeout(r, 2000));
          const v2b = await fetchV2Track(labelId);
          if (v2b && v2b.events.length > 0) v2 = v2b;
        }
        if (!v2) return { labelId, events: [], hasCarrierMovement: false, delivered: false };
        const events = v2.events;
        // Events take priority. Fall back to top-level status_code only when events[] is empty
        // (persistent cold cache) — the top-level field is usually a rollup of carrier state.
        const movedByEvents = events.some(e => !HANGING_CODES.has(e.status_code));
        const movedByTop = events.length === 0 && MOVED_TOP.has(v2.topStatusCode);
        const hasCarrierMovement = movedByEvents || movedByTop;
        const delivered = events.some(e => e.status_code === 'DE') || v2.topStatusCode === 'DE';
        const latest = events[0] || null;
        return {
          labelId, events, hasCarrierMovement, delivered,
          latestEvent: latest?.description || (movedByTop ? `(V2 top-level: ${v2.topStatusCode})` : null),
          latestEventCode: latest?.status_code || v2.topStatusCode || null,
          latestEventAt: latest?.occurred_at || null,
          source: movedByTop ? 'v2-top' : 'v2',
          topStatusCode: v2.topStatusCode,
        };
      } catch {
        return { labelId, events: [], hasCarrierMovement: false, delivered: false };
      }
    }));
    for (const r of results) out.set(r.labelId, r);
  }

  // ── Purolator reclassification: fix ShipEngine's broken AC mapping ────────
  // ShipEngine tags Purolator pickup/transit events as AC instead of IT.
  // Reclassify by description text — zero additional API calls.
  if (labelToShipment) {
    for (const labelId of labelIds) {
      const track = out.get(labelId);
      if (!track || !track.events.length) continue;
      const ship = labelToShipment.get(labelId);
      if (!ship?.carrierCode?.includes('purolator')) continue;
      let reclassified = false;
      for (const e of track.events) {
        if (!HANGING_CODES.has(e.status_code)) continue; // already correct
        const fixed = puroEventToStatusCode(e.description, e.status_code);
        if (fixed !== e.status_code) {
          e.status_code = fixed;
          reclassified = true;
        }
      }
      if (reclassified) {
        track.hasCarrierMovement = track.events.some(e => !HANGING_CODES.has(e.status_code));
        track.delivered = track.events.some(e => e.status_code === 'DE');
        const latest = track.events[0];
        track.latestEventCode = latest?.status_code || track.topStatusCode || null;
        track.source = 'v2-puro-reclassified';
      }
    }
  }

  // CP fallback: for every Canada Post label where V2 returned 0 events, hit
  // CP's own tracking API. V2 is unreliable for older CP shipments that actually
  // moved or delivered.
  if (CP_KEY && CP_SECRET && labelToShipment) {
    const cpCandidates = [];
    for (const labelId of labelIds) {
      const track = out.get(labelId);
      if (track && track.events.length) continue; // V2 had data, trust it
      const ship = labelToShipment.get(labelId);
      if (!ship?.carrierCode?.includes('canada_post')) continue;
      if (!ship.trackingNumber) continue;
      cpCandidates.push({ labelId, trackingNumber: ship.trackingNumber });
    }
    for (const c of cpCandidates) {
      const cp = await cpTrack(c.trackingNumber);
      await new Promise((r) => setTimeout(r, 150));
      if (!cp) continue;
      const code = cpEventToStatusCode(cp.latestEvent, cp.deliveredDate);
      const evs = cp.events.map((desc, idx) => ({
        status_code: idx === 0 ? code : (String(desc).toLowerCase().includes('electronic information') ? 'AC' : 'IT'),
        occurred_at: null,
        description: desc,
      }));
      out.set(c.labelId, {
        labelId: c.labelId,
        events: evs,
        hasCarrierMovement: code === 'IT' || code === 'DE',
        delivered: code === 'DE',
        latestEvent: cp.latestEvent,
        latestEventCode: code,
        latestEventAt: cp.deliveredDate || null,
        source: 'cp-api',
      });
    }
  }

  // ── Purolator / UPS fallback: V2 /v2/tracking by-number ──────────────────
  // For non-CP labels where V2 label-level tracking returned no real movement
  // events, try the V2 /v2/tracking endpoint (carrier-level lookup). ShipEngine's
  // carrier-level tracking poll can return fresher data than the label-level
  // cache — it sometimes triggers a real-time carrier query that the label
  // endpoint doesn't.
  if (labelToShipment) {
    const byNumCandidates = [];
    for (const labelId of labelIds) {
      const track = out.get(labelId);
      // Skip if V2 already returned real movement events
      if (track && track.events.length > 0 && track.events.some(e => !HANGING_CODES.has(e.status_code))) continue;
      const ship = labelToShipment.get(labelId);
      if (!ship?.trackingNumber) continue;
      if (ship.carrierCode?.includes('canada_post')) continue; // handled by CP fallback above
      // Build list of carrier codes to try (walleted first, then plain)
      const raw = String(ship.carrierCode || '');
      const plain = raw.replace(/_walleted$/, '');
      const codes = raw !== plain ? [raw, plain] : [raw];
      byNumCandidates.push({ labelId, trackingNumber: ship.trackingNumber, carrierCodes: codes });
    }
    for (const c of byNumCandidates) {
      let found = null;
      for (const cc of c.carrierCodes) {
        try {
          const res = await v2Request('GET', `/v2/tracking?carrier_code=${encodeURIComponent(cc)}&tracking_number=${encodeURIComponent(c.trackingNumber)}`);
          if (res.status !== 200) continue;
          const d = JSON.parse(res.body);
          const evs = (d.events || []).map(e => ({
            status_code: e.status_code || '',
            occurred_at: e.occurred_at || null,
            description: e.description || e.carrier_status_description || '',
          }));
          if (evs.length > 0 && evs.some(e => !HANGING_CODES.has(e.status_code))) {
            found = { events: evs, topStatusCode: d.status_code || null, via: cc };
            break;
          }
        } catch {}
      }
      if (found) {
        const hasMovement = found.events.some(e => !HANGING_CODES.has(e.status_code));
        const delivered = found.events.some(e => e.status_code === 'DE') || found.topStatusCode === 'DE';
        const latest = found.events[0] || null;
        out.set(c.labelId, {
          labelId: c.labelId,
          events: found.events,
          hasCarrierMovement: hasMovement,
          delivered,
          latestEvent: latest?.description || null,
          latestEventCode: latest?.status_code || found.topStatusCode || null,
          latestEventAt: latest?.occurred_at || null,
          source: `v2-tracking-${found.via}`,
          topStatusCode: found.topStatusCode,
        });
      }
      await new Promise((r) => setTimeout(r, 150)); // throttle
    }
  }

  return out;
}

// ── Fetch active pickups (V2 + CP JSON) keyed by exact label_id AND by
//    (warehouseId, carrierKey). The warehouse-level map implements the
//    "driver grabs everything at the desk" rule: any active pickup at a
//    warehouse+carrier covers every label for that combo, regardless of
//    which specific label_ids were declared on the booking.

// Reverse map: V2 carrier_id ("se-1813879") → canonical carrier key.
// Canonical key = ShipStation V1 carrier code with "_walleted" stripped.
const V2_CARRIER_ID_TO_KEY = {
  'se-1813879': 'ups',
  'se-1813880': 'purolator',
  'se-159867':  'canada_post',
  'se-159866':  'canpar',
  'se-1813881': 'fedex',
  'se-1813882': 'dhl_express',
};

function canonicalCarrierKey(v1CarrierCode) {
  return String(v1CarrierCode || '').replace(/_walleted$/, '');
}

async function fetchBookedLabelDetails() {
  const byLabel = new Map();           // "se-<shipmentId>" → pickup info
  const byWhCarrier = new Map();       // "<warehouseId>::<carrierKey>" → [pickup info sorted by date desc]

  // V2 pickups
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await v2Request('GET', `/v2/pickups?page_size=100&page=${page}`);
    if (res.status !== 200) break;
    const data = JSON.parse(res.body);
    const pickups = data.pickups || [];
    for (const p of pickups) {
      if (p.canceled_at) continue;
      const pickupDate = p.pickup_windows?.[0]?.start_at?.slice(0, 10) || null;
      const info = {
        pickupId: p.pickup_id,
        confirmation: p.confirmation_number || p.pickup_id,
        pickupDate,
        source: 'v2',
      };
      // Exact label match
      for (const lid of (p.label_ids || [])) {
        const existing = byLabel.get(lid);
        if (!existing || (pickupDate && (!existing.pickupDate || pickupDate > existing.pickupDate))) {
          byLabel.set(lid, info);
        }
      }
      // Warehouse-level coverage
      const whId = String(p.warehouse_id || '').replace(/^se-/, '');
      const carrierKey = V2_CARRIER_ID_TO_KEY[p.carrier_id] || p.carrier_id;
      if (whId && carrierKey) {
        const key = `${whId}::${carrierKey}`;
        if (!byWhCarrier.has(key)) byWhCarrier.set(key, []);
        byWhCarrier.get(key).push(info);
      }
    }
    hasMore = pickups.length === 100;
    page++;
  }

  // CP pickups (separate subsystem — stored in data/cp-pickups.json)
  try {
    const cpLog = path.join(__dirname, '..', 'data', 'cp-pickups.json');
    if (fs.existsSync(cpLog)) {
      const cpPickups = JSON.parse(fs.readFileSync(cpLog, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      for (const p of cpPickups) {
        // CP pickups don't track per-label IDs, only warehouse + date + count.
        // Only use pickups whose date is today or later — past CP pickups are done.
        if (!p.pickupDate || p.pickupDate < today) continue;
        const info = {
          pickupId: p.pickupId,
          confirmation: p.pickupId,
          pickupDate: p.pickupDate,
          source: 'cp-api',
        };
        const key = `${p.warehouseId}::canada_post`;
        if (!byWhCarrier.has(key)) byWhCarrier.set(key, []);
        byWhCarrier.get(key).push(info);
      }
    }
  } catch {}

  // Sort each warehouse-level list by pickupDate desc so "latest pickup" is [0]
  for (const arr of byWhCarrier.values()) {
    arr.sort((a, b) => String(b.pickupDate || '').localeCompare(String(a.pickupDate || '')));
  }

  return { byLabel, byWhCarrier };
}

function lookupPickup({ byLabel, byWhCarrier }, labelId, warehouseId, carrierCode) {
  // Exact label match wins
  const exact = byLabel.get(labelId);
  if (exact) return exact;
  // Fall back to warehouse+carrier coverage (driver grabs everything at the desk)
  const carrierKey = canonicalCarrierKey(carrierCode);
  const list = byWhCarrier.get(`${warehouseId}::${carrierKey}`);
  if (!list || !list.length) return null;
  // Prefer a future-dated pickup over a past one
  const today = new Date().toISOString().slice(0, 10);
  const future = list.find(p => !p.pickupDate || p.pickupDate >= today);
  return future || list[0];
}

// ── Classification ───────────────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return 999;
  const shipped = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - shipped) / 86400000);
}

// Threshold for promoting an in-transit shipment to 'stuck-in-transit'.
// Most Canadian domestic MFN deliveries land in <7 days; >10 days with no
// delivery scan is the A-to-Z "item not received" risk zone.
const STUCK_IN_TRANSIT_DAYS = 10;

function classifyMovement(track, age) {
  if (!track) return 'hanging';
  if (track.delivered) return 'delivered';
  if (track.hasCarrierMovement) {
    if (typeof age === 'number' && age >= STUCK_IN_TRANSIT_DAYS) return 'stuck-in-transit';
    return 'in-transit';
  }
  return 'hanging';
}

function classifyPickup(pickupInfo, today) {
  if (!pickupInfo) return 'none';
  if (!pickupInfo.pickupDate) return 'booked-future'; // unknown date, treat as booked
  return pickupInfo.pickupDate < today ? 'booked-past' : 'booked-future';
}

function suggestedAction(movement, pickupState, age) {
  if (movement !== 'hanging') return null;
  if (pickupState === 'booked-past') return 'rebook';   // carrier no-show
  if (pickupState === 'booked-future') return 'monitor'; // will be picked up on date
  if (age <= 1) return 'wait';                           // just shipped
  return 'book';                                         // no pickup, age > 1 day
}

// ── Main scan ────────────────────────────────────────────────────────────────

async function scanStaleShipments({ days = 14 } = {}) {
  const [shipments, bookedLabels] = await Promise.all([
    fetchShippedShipments({ days }),
    fetchBookedLabelDetails(),
  ]);

  // Filter out auto-generated test/void labels
  const validShipments = shipments.filter(s => {
    const on = (s.orderNumber || '').trim();
    if (on.startsWith('SEAuto-')) return false;
    return true;
  });

  // Look up V2 label metadata to drop voided labels up front (they linger in V1 /shipments)
  const voidedShipmentIds = new Set();
  {
    const ids = validShipments.map(s => s.shipmentId);
    const batchSize = 10;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await Promise.all(batch.map(async (sid) => {
        try {
          const r = await v2Request('GET', `/v2/labels/se-${sid}`);
          if (r.status !== 200) return;
          const d = JSON.parse(r.body);
          if (d.voided === true || d.status === 'voided') voidedShipmentIds.add(sid);
        } catch {}
      }));
    }
  }
  const liveShipments = validShipments.filter(s => !voidedShipmentIds.has(s.shipmentId));

  // Backfill missing order numbers — persistent cache for dead orders
  const cacheFile = path.join(__dirname, '..', 'data', 'order-cache.json');
  let orderCache = {};
  try { orderCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

  const needsOrderLookup = liveShipments.filter(s => !s.orderNumber?.trim() && s.orderId && !orderCache.hasOwnProperty(String(s.orderId)));
  for (const s of needsOrderLookup) {
    try {
      const res = await v1Request('GET', `/orders/${s.orderId}`);
      orderCache[String(s.orderId)] = res.status === 200 ? (JSON.parse(res.body).orderNumber || '') : '';
    } catch {
      orderCache[String(s.orderId)] = '';
    }
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify(orderCache, null, 2)); } catch {}

  for (const s of liveShipments) {
    if (!s.orderNumber?.trim() && s.orderId && orderCache[String(s.orderId)]) {
      s.orderNumber = orderCache[String(s.orderId)];
    }
  }

  // Fetch carrier events for every shipment by label_id
  const labelIds = liveShipments.map(s => `se-${s.shipmentId}`);
  const labelToShipment = new Map(liveShipments.map(s => [`se-${s.shipmentId}`, s]));
  const tracking = await fetchTrackingDetails(labelIds, labelToShipment);

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const s of liveShipments) {
    const labelId = `se-${s.shipmentId}`;
    const track = tracking.get(labelId);
    const carrier = s.carrierCode || 'unknown';
    const warehouseId = String(s.advancedOptions?.warehouseId || s.warehouseId || '');
    const pickupInfo = lookupPickup(bookedLabels, labelId, warehouseId, carrier);
    const age = daysSince(s.shipDate);
    const loc = WAREHOUSE_BY_SS_ID[warehouseId];

    const movement = classifyMovement(track, age);
    const pickupState = classifyPickup(pickupInfo, today);
    const action = suggestedAction(movement, pickupState, age);

    results.push({
      shipmentId: s.shipmentId,
      orderNumber: s.orderNumber,
      trackingNumber: s.trackingNumber,
      carrier: carrier.replace('_walleted', '').replace(/_/g, ' '),
      carrierCode: carrier, // raw, used by UI for booking
      shipDate: s.shipDate?.slice(0, 10),
      age,
      warehouseId,
      warehouseName: loc ? `${loc.city} (${loc.code})` : `Warehouse ${warehouseId}`,
      shipTo: s.shipTo?.name || '',
      shipToCity: s.shipTo?.city || '',
      movement,                                 // 'hanging' | 'in-transit' | 'delivered'
      pickupState,                              // 'none' | 'booked-future' | 'booked-past'
      suggestedAction: action,                  // 'book' | 'rebook' | 'monitor' | 'wait' | null
      latestEvent: track?.latestEvent || null,
      latestEventCode: track?.latestEventCode || null,
      latestEventAt: track?.latestEventAt || null,
      pickupId: pickupInfo?.pickupId || null,
      pickupDate: pickupInfo?.pickupDate || null,
      pickupConfirmation: pickupInfo?.confirmation || null,
    });
  }

  // Sort stuck-in-transit first (A-to-Z risk), then hanging by action priority, then age desc
  const actionOrder = { book: 0, rebook: 1, monitor: 2, wait: 3 };
  const movementOrder = { 'stuck-in-transit': 0, hanging: 1, 'in-transit': 2, delivered: 3 };
  results.sort((a, b) => {
    const m = (movementOrder[a.movement] ?? 9) - (movementOrder[b.movement] ?? 9);
    if (m !== 0) return m;
    if (a.movement === 'hanging') {
      const ad = (actionOrder[a.suggestedAction] ?? 9) - (actionOrder[b.suggestedAction] ?? 9);
      if (ad !== 0) return ad;
    }
    return b.age - a.age;
  });

  const summary = {
    total: results.length,
    hanging: results.filter(r => r.movement === 'hanging').length,
    inTransit: results.filter(r => r.movement === 'in-transit').length,
    stuckInTransit: results.filter(r => r.movement === 'stuck-in-transit').length,
    delivered: results.filter(r => r.movement === 'delivered').length,
    needBook: results.filter(r => r.suggestedAction === 'book').length,
    needRebook: results.filter(r => r.suggestedAction === 'rebook').length,
    monitor: results.filter(r => r.suggestedAction === 'monitor').length,
    wait: results.filter(r => r.suggestedAction === 'wait').length,
  };

  return { summary, shipments: results };
}

module.exports = { scanStaleShipments, STUCK_IN_TRANSIT_DAYS };
