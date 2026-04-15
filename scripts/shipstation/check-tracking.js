#!/usr/bin/env node
/**
 * One-off: look up a list of tracking numbers in ShipStation and
 * print the latest carrier event for each.
 *
 * Usage: node scripts/shipstation/check-tracking.js <tracknum> [tracknum...]
 *
 * Auth modes (auto-detected):
 *   - V1+V2 (preferred when available): uses V1 /shipments?trackingNumber=...
 *     to resolve shipment, V2 /v2/labels/se-<id>/track for events.
 *   - V2-only: uses V2 /v2/shipments?tracking_number=... then V2 track.
 *     Useful for tenants where we only have a V2 API key (e.g. Orion).
 *
 * Env vars read:
 *   SHIPSTATION_API_KEY + SHIPSTATION_API_SECRET  (V1 pair, optional)
 *   SHIPSTATION_V2_API_KEY                         (V2 key, required)
 */

require('dotenv').config();
const https = require('https');

const V2_KEY = process.env.SHIPSTATION_V2_API_KEY;
const V1_KEY = process.env.SHIPSTATION_API_KEY;
const V1_SECRET = process.env.SHIPSTATION_API_SECRET;
const HAS_V1 = Boolean(V1_KEY && V1_SECRET);

if (!V2_KEY) { console.error('Missing SHIPSTATION_V2_API_KEY'); process.exit(1); }

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function v2Request(method, endpoint) {
  return httpsRequest({
    hostname: 'api.shipstation.com',
    path: endpoint,
    method,
    headers: { 'API-Key': V2_KEY, 'Accept': 'application/json' },
  });
}

async function v1Request(method, endpoint) {
  const auth = Buffer.from(`${V1_KEY}:${V1_SECRET}`).toString('base64');
  const res = await httpsRequest({
    hostname: 'ssapi.shipstation.com',
    path: endpoint,
    method,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (res.status === 429) {
    const wait = parseInt(res.headers['retry-after'] || '30', 10);
    await new Promise(r => setTimeout(r, wait * 1000));
    return v1Request(method, endpoint);
  }
  return res;
}

const CODE_LABEL = {
  NY: 'Not Yet In System', AC: 'Accepted (label only)', UN: 'Unknown',
  IT: 'In Transit', AT: 'Attempted delivery', DE: 'Delivered', EX: 'Exception',
};

async function findShipmentV1(trackingNumber) {
  const res = await v1Request('GET', `/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}&pageSize=5`);
  if (res.status !== 200) return { err: `V1 ${res.status}` };
  const d = JSON.parse(res.body);
  const list = d.shipments || [];
  if (!list.length) return { err: 'not found' };
  const nonVoid = list.find(s => !s.voided) || list[0];
  return {
    shipment: {
      shipmentId: String(nonVoid.shipmentId),
      orderNumber: nonVoid.orderNumber || nonVoid.orderId,
      carrier: nonVoid.carrierCode || '?',
      shipDate: (nonVoid.shipDate || '').slice(0, 10),
      voided: Boolean(nonVoid.voided),
      shipTo: nonVoid.shipTo?.name || '',
      shipToCity: nonVoid.shipTo?.city || '',
    }
  };
}

async function findShipmentV2(trackingNumber) {
  // V2 /v2/shipments does NOT filter by tracking_number despite the param name.
  // /v2/labels DOES filter correctly — query there and prefer non-voided.
  const res = await v2Request('GET', `/v2/labels?tracking_number=${encodeURIComponent(trackingNumber)}&page_size=10`);
  if (res.status !== 200) return { err: `V2 ${res.status}` };
  const d = JSON.parse(res.body);
  const list = d.labels || [];
  if (!list.length) return { err: 'not found' };
  const nonVoid = list.find(l => !l.voided) || list[0];
  const labelId = String(nonVoid.label_id || '').replace(/^se-/, '');

  // Fetch the shipment for richer metadata (ship-to, order number, etc.)
  let shipMeta = {};
  if (nonVoid.shipment_id) {
    const sres = await v2Request('GET', `/v2/shipments/${nonVoid.shipment_id}`);
    if (sres.status === 200) {
      const s = JSON.parse(sres.body);
      shipMeta = {
        orderNumber: s.shipment_number || s.external_order_id || s.external_shipment_id || s.shipment_id,
        shipTo: s.ship_to?.name || '',
        shipToCity: s.ship_to?.city_locality || '',
      };
    }
  }

  return {
    shipment: {
      // Track endpoint expects the label_id (se-<id>), not the shipment_id.
      shipmentId: labelId,
      orderNumber: shipMeta.orderNumber || nonVoid.external_order_id || nonVoid.shipment_id,
      carrier: nonVoid.service_code || nonVoid.carrier_code || '?',
      shipDate: (nonVoid.ship_date || nonVoid.created_at || '').slice(0, 10),
      voided: Boolean(nonVoid.voided),
      trackingStatus: nonVoid.tracking_status || null,
      shipTo: shipMeta.shipTo || '',
      shipToCity: shipMeta.shipToCity || '',
    }
  };
}

async function fetchTrack(shipmentId) {
  const res = await v2Request('GET', `/v2/labels/se-${shipmentId}/track`);
  if (res.status !== 200) return { err: `V2 track ${res.status}` };
  const d = JSON.parse(res.body);
  const events = (d.events || []).map(e => ({
    code: e.status_code || '',
    at: e.occurred_at || '',
    desc: e.description || e.carrier_status_description || '',
    loc: [e.city_locality, e.state_province, e.country_code].filter(Boolean).join(', '),
  }));
  return { topCode: d.status_code || null, events };
}

// Also fetch tracking directly by carrier + tracking_number — works even if
// the shipment record has been archived/pruned.
async function fetchTrackByNumber(trackingNumber, carrierCodeHint) {
  // Try UPS first (our use case). ShipEngine expects carrier_code like 'ups'.
  const carriers = carrierCodeHint ? [carrierCodeHint] : ['ups', 'ups_walleted'];
  for (const c of carriers) {
    const res = await v2Request('GET', `/v2/tracking?carrier_code=${encodeURIComponent(c)}&tracking_number=${encodeURIComponent(trackingNumber)}`);
    if (res.status === 200) {
      const d = JSON.parse(res.body);
      const events = (d.events || []).map(e => ({
        code: e.status_code || '',
        at: e.occurred_at || '',
        desc: e.description || e.carrier_status_description || '',
        loc: [e.city_locality, e.state_province, e.country_code].filter(Boolean).join(', '),
      }));
      return { topCode: d.status_code || null, events, via: c };
    }
  }
  return { err: 'V2 /tracking lookup failed for all carrier codes' };
}

function fmtAt(at) { return at ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) : ''; }

async function main() {
  const nums = process.argv.slice(2);
  if (!nums.length) { console.error('usage: check-tracking.js <tracknum> ...'); process.exit(1); }

  console.log(`Mode: ${HAS_V1 ? 'V1+V2' : 'V2-only'}\n`);

  for (const t of nums) {
    let found = HAS_V1 ? await findShipmentV1(t) : await findShipmentV2(t);
    if (found.err && HAS_V1) {
      // V1 can miss older/archived shipments — try V2 shipments as fallback
      found = await findShipmentV2(t);
    }

    let shipment = found.shipment || null;
    let track;

    if (shipment) {
      track = await fetchTrack(shipment.shipmentId);
      // If label track gave nothing useful, try the by-number tracking endpoint
      if ((track.err || !track.events?.length)) {
        const byNum = await fetchTrackByNumber(t, shipment.carrier?.replace('_walleted', ''));
        if (!byNum.err) track = byNum;
      }
    } else {
      // No shipment record at all — still try V2 tracking by number
      track = await fetchTrackByNumber(t);
    }

    const voided = shipment?.voided ? ' [VOIDED]' : '';
    const meta = shipment
      ? `order=${shipment.orderNumber}  carrier=${shipment.carrier}  shipped=${shipment.shipDate}  to=${shipment.shipTo}${shipment.shipToCity ? ` (${shipment.shipToCity})` : ''}`
      : `(no shipment record)`;

    if (track.err) {
      console.log(`\n${t}${voided}  ${meta}\n  ✗ ${track.err}`);
      continue;
    }

    const topLabel = track.topCode ? `${track.topCode}${CODE_LABEL[track.topCode] ? ` (${CODE_LABEL[track.topCode]})` : ''}` : '—';
    console.log(`\n${t}${voided}  ${meta}`);
    console.log(`  top: ${topLabel}   events: ${track.events.length}${track.via ? `   via: ${track.via}` : ''}`);
    const toShow = track.events.slice(0, 3);
    toShow.forEach((e, i) => {
      const prefix = i === 0 ? '  latest:' : '         ';
      console.log(`${prefix} [${e.code || '--'}] ${fmtAt(e.at)}  ${e.desc}${e.loc ? `  @ ${e.loc}` : ''}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
