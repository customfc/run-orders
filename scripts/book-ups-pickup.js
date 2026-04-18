#!/usr/bin/env node
/**
 * Book a UPS pickup at an arbitrary address (not a ShipStation warehouse).
 *
 * Primary use case: Treeco Delta picking up an Amazon-generated FBA inbound
 * label. Those labels aren't in our ShipStation account, so ShipEngine's
 * pickup API can't handle them — we hit UPS Developer API directly.
 *
 * Presets available:
 *   --preset=treeco_delta     1230 Cliveden Ave, Delta BC
 *   --preset=treeco_calgary   5211 52 St SE, Calgary AB
 *
 * Usage:
 *   node scripts/book-ups-pickup.js --preset=treeco_delta \
 *     --date=2026-04-20 --ready=13:00 --close=16:00 \
 *     --boxes=6 --weight=252 --tracking=1ZXXXX
 */

require('dotenv').config();
const upsApi = require('../lib/ups-api');

const PRESETS = {
  treeco_delta: {
    companyName: 'Treeco',
    contactName: 'Robyn P.',
    phone: '604-523-2235',
    email: 'robynp@treeco.ca',
    address1: '1230 Cliveden Ave',
    city: 'Delta',
    stateProvince: 'BC',
    postalCode: 'V3M 6G4',
    countryCode: 'CA',
    residential: false,
  },
  treeco_calgary: {
    companyName: 'Treeco',
    contactName: 'Treeco Calgary',
    phone: '403-219-3303',
    email: 'robynp@treeco.ca',
    address1: '5211 52 St SE',
    city: 'Calgary',
    stateProvince: 'AB',
    postalCode: 'T2B 3T1',
    countryCode: 'CA',
    residential: false,
  },
  prosol_wcas: {
    companyName: 'Prosol Calgary',
    contactName: 'Prosol Calgary',
    phone: '403-253-2214',
    email: 'order.calgary@prosol.ca',
    address1: '5760 9 St SE #105',
    city: 'Calgary',
    stateProvince: 'AB',
    postalCode: 'T2H 1Z9',
    countryCode: 'CA',
    residential: false,
  },
};

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      args[k.slice(2)] = v !== undefined ? v : process.argv[++i];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const preset = args.preset ? PRESETS[args.preset] : null;
  if (args.preset && !preset) throw new Error(`Unknown preset '${args.preset}'. Options: ${Object.keys(PRESETS).join(', ')}`);

  const pickupAddress = preset || {
    companyName: args.company,
    contactName: args.contact || args.company,
    phone: args.phone,
    email: args.email,
    address1: args.address1,
    address2: args.address2,
    city: args.city,
    stateProvince: args.state,
    postalCode: args.postal,
    countryCode: args.country || 'CA',
    residential: args.residential === 'true',
  };
  if (!pickupAddress.city || !pickupAddress.postalCode) {
    throw new Error('pickupAddress incomplete (need preset OR --company/--address1/--city/--state/--postal/--phone)');
  }

  const pickupDate = args.date;
  const readyTime = args.ready || '13:00';
  const closeTime = args.close || '16:00';
  if (!pickupDate) throw new Error('--date=YYYY-MM-DD required');

  const boxes = {
    quantity: Number(args.boxes || 1),
    totalWeightLb: Number(args.weight || 10),
    serviceCode: args.service || '003',
    specialInstruction: args['instruction'] || '',
  };

  const trackingNumbers = args.tracking ? String(args.tracking).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const customerContext = args.ref || `CFC-${new Date().toISOString().slice(0, 10)}`;

  console.log('Booking UPS pickup:');
  console.log(`  ${pickupAddress.companyName} · ${pickupAddress.city}, ${pickupAddress.stateProvince} ${pickupAddress.postalCode}`);
  console.log(`  ${pickupDate} · ${readyTime}–${closeTime}`);
  console.log(`  ${boxes.quantity} box(es) · ${boxes.totalWeightLb} lb total · ServiceCode ${boxes.serviceCode}`);
  if (trackingNumbers) console.log(`  tracking: ${trackingNumbers.join(', ')}`);
  console.log('');

  const result = await upsApi.createPickup({
    pickupAddress,
    pickupDate,
    readyTime,
    closeTime,
    boxes,
    trackingNumbers,
    customerContext,
  });

  console.log('✓ UPS pickup booked');
  console.log(`  Pickup Request Number (PRN): ${result.pickupRequestNumber}`);
  if (result.rate) console.log(`  Rate: ${JSON.stringify(result.rate)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    if (e.body) console.error('body:', e.body.slice(0, 600));
    process.exit(1);
  });
}

module.exports = { main, PRESETS };
