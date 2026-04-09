#!/usr/bin/env node
/**
 * book-cp-pickup.js — Book a Canada Post on-demand pickup at a Prosol warehouse
 *
 * Address is ALWAYS pulled from prosol-location-map.json — never hardcoded.
 * This prevents the wrong-address bug that happened 2026-04-01.
 *
 * Usage:
 *   node book-cp-pickup.js --location WGRF --date 2026-04-02 --boxes 3
 *   node book-cp-pickup.js --location WCON --date 2026-04-02 --boxes 2
 *   node book-cp-pickup.js --list        # show all locations with CP support
 *
 * Defaults:
 *   --date      today (or tomorrow if past 14:00 ET)
 *   --boxes     1
 *   --preferred 12:00
 *   --closing   17:00
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config from env ─────────────────────────────────────────────────────────

const CP_CUSTOMER = process.env.CANADA_POST_CUSTOMER_NUMBER;
const CP_KEY = process.env.CANADA_POST_API_KEY;
const CP_SECRET = process.env.CANADA_POST_API_SECRET;

if (!CP_CUSTOMER || !CP_KEY || !CP_SECRET) {
  throw new Error('Missing CANADA_POST_CUSTOMER_NUMBER, CANADA_POST_API_KEY, or CANADA_POST_API_SECRET');
}

const CP_AUTH = Buffer.from(`${CP_KEY}:${CP_SECRET}`).toString('base64');
const CP_BASE = 'soa-gw.canadapost.ca';
const CONTACT_EMAIL = 'mac@customfc.ca';

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'prosol-location-map.json'), 'utf8')
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocationByCode(code) {
  return Object.values(LOCATION_MAP).find(
    l => l.code?.toUpperCase() === code?.toUpperCase()
  );
}

function formatPostal(p) {
  return (p || '').replace(/\s/g, '').toUpperCase();
}

function cpRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CP_BASE,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Basic ${CP_AUTH}`,
        'Accept': 'application/vnd.cpc.pickuprequest+xml',
        'Accept-language': 'en-CA',
      },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/vnd.cpc.pickuprequest+xml';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildXml(loc, date, boxes, preferred, closing) {
  const addr = (loc.address || '').replace('rue', 'St').trim();
  const addressLine = addr.replace(/^(\d+)\s+rue\s+/i, '$1 ').replace(/^(\d+)\s+Rue\s+/i, '$1 ');
  const postal = formatPostal(loc.postal_code);
  const province = loc.province || 'QC';
  const city = loc.city;
  const company = `Prosol ${city}`;
  const phone = (Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone) || '514-745-1212';
  const contactName = `Prosol ${city}`;
  const volumeStr = `${boxes} BOX`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<pickup-request-details xmlns="http://www.canadapost.ca/ws/pickuprequest">
  <pickup-type>OnDemand</pickup-type>
  <pickup-location>
    <business-address-flag>false</business-address-flag>
    <alternate-address>
      <company>${company}</company>
      <address-line-1>${addressLine}</address-line-1>
      <city>${city}</city>
      <province>${province}</province>
      <postal-code>${postal}</postal-code>
    </alternate-address>
  </pickup-location>
  <contact-info>
    <contact-name>${contactName}</contact-name>
    <email>${CONTACT_EMAIL}</email>
    <contact-phone>${phone}</contact-phone>
    <receive-email-updates-flag>true</receive-email-updates-flag>
  </contact-info>
  <location-details>
    <pickup-instructions>Please pick up parcels at front desk</pickup-instructions>
  </location-details>
  <pickup-volume>${volumeStr}</pickup-volume>
  <pickup-times>
    <on-demand-pickup-time>
      <date>${date}</date>
      <preferred-time>${preferred}</preferred-time>
      <closing-time>${closing}</closing-time>
    </on-demand-pickup-time>
  </pickup-times>
</pickup-request-details>`;
}

function nextBusinessDay() {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const useToday = etNow.getHours() < 14;
  const d = useToday ? etNow : new Date(etNow.getTime() + 86400000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Core exported function ───────────────────────────────────────────────────

async function bookCpPickup({ locationCode, date, boxes = 1, preferred = '12:00', closing = '17:00' } = {}) {
  if (!locationCode) throw new Error('locationCode is required');

  const loc = getLocationByCode(locationCode);
  if (!loc) throw new Error(`Location "${locationCode}" not found in prosol-location-map.json`);

  if (!date) date = nextBusinessDay();

  const xml = buildXml(loc, date, boxes, preferred, closing);
  const res = await cpRequest('POST', `/enab/${CP_CUSTOMER}/pickuprequest`, xml);

  if (res.status === 201 || res.status === 200) {
    const idMatch = res.body.match(/<request-id>(\d+)<\/request-id>/);
    const statusMatch = res.body.match(/<request-status>([^<]+)<\/request-status>/);
    const costMatch = res.body.match(/<due-amount>([^<]+)<\/due-amount>/);
    return {
      success: true,
      pickupId: idMatch?.[1] || null,
      status: statusMatch?.[1] || 'Unknown',
      cost: costMatch?.[1] ? `$${costMatch[1]}` : null,
      location: { code: loc.code, city: loc.city, province: loc.province },
      date,
      boxes,
    };
  }

  return {
    success: false,
    error: `HTTP ${res.status}`,
    body: res.body,
    location: { code: loc.code, city: loc.city, province: loc.province },
    date,
    boxes,
  };
}

function listLocations() {
  return Object.values(LOCATION_MAP)
    .filter(loc => loc.shipstation_warehouse_id)
    .map(loc => ({
      code: loc.code,
      city: loc.city,
      province: loc.province,
      address: `${loc.address}, ${loc.postal_code}`,
      shipstationWarehouseId: loc.shipstation_warehouse_id,
    }));
}

// ── CLI mode ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('\nProsol locations with ShipStation warehouse mapping:\n');
    console.log('  Code   City                  Province  Address');
    console.log('  ─────  ────────────────────  ────────  ──────────────────────────────');
    for (const loc of listLocations()) {
      console.log(`  ${(loc.code||'').padEnd(6)} ${(loc.city||'').padEnd(22)} ${(loc.province||'').padEnd(8)}  ${loc.address}`);
    }
    console.log();
    process.exit(0);
  }

  const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const locationCode = getArg('--location');
  if (!locationCode) {
    console.error('Usage: node book-cp-pickup.js --location <CODE> [--date YYYY-MM-DD] [--boxes N] [--preferred HH:MM] [--closing HH:MM]');
    console.error('       node book-cp-pickup.js --list');
    process.exit(1);
  }

  bookCpPickup({
    locationCode,
    date: getArg('--date'),
    boxes: parseInt(getArg('--boxes') || '1', 10),
    preferred: getArg('--preferred') || '12:00',
    closing: getArg('--closing') || '17:00',
  }).then(result => {
    if (result.success) {
      console.log(`\nPickup booked!`);
      console.log(`   Location:   ${result.location.code} — ${result.location.city}, ${result.location.province}`);
      console.log(`   Request ID: ${result.pickupId}`);
      console.log(`   Status:     ${result.status}`);
      if (result.cost) console.log(`   Cost:       ${result.cost}`);
    } else {
      console.error(`\nBooking failed: ${result.error}`);
      console.error(result.body);
      process.exit(1);
    }
  }).catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { bookCpPickup, listLocations };
