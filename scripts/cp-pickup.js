#!/usr/bin/env node
/**
 * Book a Canada Post on-demand pickup at a Prosol warehouse.
 *
 * The CP own-API path is the only one that works for our walleted account:
 * ShipEngine refuses ("Schedule Pickup is not available for wallet Account").
 * Validated working 2026-05-21 (request-ids 5146605 + 5146668).
 *
 * Hidden gotchas (one-line each) — DO NOT regress these:
 *   1. Endpoint path is /enab/{customer-number}/pickuprequest — NOT the
 *      documented /enab/v1/customers/{customer-number}/... (which 400s).
 *   2. PickupTimeType regex (from karrio's published XSD copy):
 *           (12|13|14|15|16|17):(00|15|30|45)
 *      i.e. afternoon only, 15-minute slots, no morning pickups via API.
 *   3. pickup-instructions is tightly length-capped (~30 chars survives).
 *      Long strings → HTTP 500 "Pickup instruction ... is too long".
 *   4. business-address-flag must be `false` when picking up at a non-
 *      billing address (any Prosol warehouse — our CP account is for CFC,
 *      not Prosol).
 *   5. Phone must be hyphenated `NNN-NNN-NNNN`. Raw digits → schema reject.
 *   6. Customer number passes through as the zero-padded form from .env
 *      (e.g. 0007237598). Stripping leading zeros gives "Customer Number
 *      not valid".
 *
 * Usage:
 *   node scripts/cp-pickup.js <warehouseId> [--date YYYY-MM-DD] [--time HH:MM] [--close HH:MM] [--volume "up to 5"] [--note "<short>"]
 *   node scripts/cp-pickup.js --cancel <request-id>
 *   node scripts/cp-pickup.js --status <request-id>
 *
 * Example:
 *   node scripts/cp-pickup.js 1374417                 # Burnaby, tomorrow 13:00-17:00, "up to 5"
 *   node scripts/cp-pickup.js 1824506 --time 14:00    # Mississauga, narrower window
 *   node scripts/cp-pickup.js --cancel 5146688        # cancel a booked pickup
 *   node scripts/cp-pickup.js --status 5146605        # check current state
 *
 * Defaults:
 *   date    : next business day
 *   time    : 13:00
 *   close   : 17:00
 *   volume  : "up to 5"
 *   note    : "Front desk"
 *
 * Returns CP request-id on success. Pickup is created against our CFC
 * customer number; CP driver visits the Prosol warehouse address.
 *
 * Env vars (from run-orders .env):
 *   CANADA_POST_API_KEY
 *   CANADA_POST_API_SECRET
 *   CANADA_POST_CUSTOMER_NUMBER     (keep zero-padded form)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'shipstation', 'prosol-location-map.json'), 'utf8')
);

function whById(id) {
  for (const loc of Object.values(LOCATION_MAP)) {
    if (String(loc.shipstation_warehouse_id) === String(id)) return loc;
  }
  return null;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

function nextBusinessDay() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const PICKUP_TIME_RE = /^(12|13|14|15|16|17):(00|15|30|45)$/;
function assertValidTime(label, value) {
  if (!PICKUP_TIME_RE.test(value)) {
    throw new Error(
      `${label} must match (12-17):(00|15|30|45) — CP's PickupTimeType. Got "${value}". ` +
      `Use 12:00, 12:15, ..., 17:45 only. No morning slots via this API.`
    );
  }
}

function formatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildXml({ loc, date, time, close, volume, note }) {
  const phone = formatPhone(
    Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone
  ) || '514-745-1212'; // fall-back: Prosol main HQ
  return `<?xml version="1.0" encoding="utf-8"?>
<pickup-request-details xmlns="http://www.canadapost.ca/ws/pickuprequest">
  <customer-request-id>cfc-${loc.code || loc.shipstation_warehouse_id}-${Date.now()}</customer-request-id>
  <pickup-type>OnDemand</pickup-type>
  <pickup-location>
    <business-address-flag>false</business-address-flag>
    <alternate-address>
      <company>${esc('Prosol ' + (loc.city || ''))}</company>
      <address-line-1>${esc(loc.address)}</address-line-1>
      <city>${esc(loc.city)}</city>
      <province>${esc(loc.province)}</province>
      <postal-code>${String(loc.postal_code || '').replace(/\s/g, '')}</postal-code>
    </alternate-address>
  </pickup-location>
  <contact-info>
    <contact-name>${esc('Shipping ' + (loc.city || ''))}</contact-name>
    <email>mac@customfc.ca</email>
    <contact-phone>${phone}</contact-phone>
    <receive-email-updates-flag>true</receive-email-updates-flag>
  </contact-info>
  <location-details>
    <five-ton-flag>false</five-ton-flag>
    <loading-dock-flag>false</loading-dock-flag>
    <pickup-instructions>${esc(note || 'Front desk')}</pickup-instructions>
  </location-details>
  <items-characteristics>
    <pww-flag>false</pww-flag>
    <priority-flag>false</priority-flag>
    <returns-flag>false</returns-flag>
    <heavy-item-flag>false</heavy-item-flag>
  </items-characteristics>
  <pickup-volume>${esc(volume || 'up to 5')}</pickup-volume>
  <pickup-times>
    <on-demand-pickup-time>
      <date>${date}</date>
      <preferred-time>${time}</preferred-time>
      <closing-time>${close}</closing-time>
    </on-demand-pickup-time>
  </pickup-times>
</pickup-request-details>`;
}

function cpHttp(method, suffix, body) {
  const cust = process.env.CANADA_POST_CUSTOMER_NUMBER;
  if (!cust) throw new Error('CANADA_POST_CUSTOMER_NUMBER missing from env');
  const auth = Buffer.from(
    `${process.env.CANADA_POST_API_KEY}:${process.env.CANADA_POST_API_SECRET}`
  ).toString('base64');
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/vnd.cpc.pickuprequest+xml',
      'Accept-language': 'en-CA',
    };
    if (body) {
      headers['Content-Type'] = 'application/vnd.cpc.pickuprequest+xml';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      {
        hostname: 'soa-gw.canadapost.ca',
        path: `/enab/${cust}/pickuprequest${suffix || ''}`,
        method,
        headers,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('CP API timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

const cpRequest = (body) => cpHttp('POST', '', body);
const cpCancel  = (id)   => cpHttp('DELETE', `/${id}`);
const cpStatus  = (id)   => cpHttp('GET', `/${id}/details`);

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  // --cancel / --status modes
  if (flags.cancel) {
    const r = await cpCancel(flags.cancel);
    const err = (r.body.match(/<description>([^<]+)</) || [])[1];
    console.log(JSON.stringify({ ok: r.status >= 200 && r.status < 300, httpStatus: r.status, requestId: flags.cancel, error: err || null }, null, 2));
    process.exit(r.status >= 200 && r.status < 300 ? 0 : 1);
  }
  if (flags.status) {
    const r = await cpStatus(flags.status);
    const status = (r.body.match(/<request-status>([^<]+)</) || [])[1];
    const date   = (r.body.match(/<request-date>([^<]+)</) || [])[1];
    const due    = (r.body.match(/<due-amount>([^<]+)</) || [])[1];
    const err    = (r.body.match(/<description>([^<]+)</) || [])[1];
    console.log(JSON.stringify({ ok: r.status === 200, httpStatus: r.status, requestId: flags.status, status, date, cost: due ? parseFloat(due) : null, error: err || null }, null, 2));
    process.exit(r.status === 200 ? 0 : 1);
  }

  const whId = positional[0];
  if (!whId) {
    console.error('Usage:');
    console.error('  Book:    node scripts/cp-pickup.js <warehouseId> [--date YYYY-MM-DD] [--time HH:MM] [--close HH:MM] [--volume "up to 5"] [--note "<short>"]');
    console.error('  Cancel:  node scripts/cp-pickup.js --cancel <request-id>');
    console.error('  Status:  node scripts/cp-pickup.js --status <request-id>');
    process.exit(2);
  }
  const loc = whById(whId);
  if (!loc) {
    console.error(`No warehouse in prosol-location-map.json with shipstation_warehouse_id=${whId}`);
    process.exit(2);
  }

  const date = flags.date || nextBusinessDay();
  const time = flags.time || '13:00';
  const close = flags.close || '17:00';
  const volume = flags.volume || 'up to 5';
  const note = flags.note || 'Front desk';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('--date must be YYYY-MM-DD');
    process.exit(2);
  }
  assertValidTime('--time', time);
  assertValidTime('--close', close);
  if (note.length > 30) {
    console.error(`--note too long (${note.length} chars). CP rejects >~30. Shorten.`);
    process.exit(2);
  }

  const xml = buildXml({ loc, date, time, close, volume, note });
  console.error(`Booking CP pickup: ${loc.code || ''} ${loc.city} (whId=${whId}), ${date} ${time}-${close}, "${volume}", note="${note}"`);

  const r = await cpRequest(xml);
  if (r.status >= 200 && r.status < 300) {
    const reqId = (r.body.match(/<request-id>([^<]+)</) || [])[1];
    const status = (r.body.match(/<request-status>([^<]+)</) || [])[1];
    const due = (r.body.match(/<due-amount>([^<]+)</) || [])[1];
    console.log(JSON.stringify({
      ok: true,
      requestId: reqId || null,
      status: status || null,
      cost: due ? parseFloat(due) : null,
      warehouse: { code: loc.code, city: loc.city, address: loc.address, postalCode: loc.postal_code, whId: Number(whId) },
      pickup: { date, window: `${time}-${close}`, volume, note },
    }, null, 2));
    process.exit(0);
  }

  const err = (r.body.match(/<description>([^<]+)</) || [])[1];
  console.error(JSON.stringify({
    ok: false,
    httpStatus: r.status,
    error: err || r.body.slice(0, 500),
  }, null, 2));
  process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
