#!/usr/bin/env node
/**
 * Issue return shipping labels to Amazon buyers.
 *
 * Amazon.ca does not supply prepaid return labels for merchant-fulfilled
 * orders — the seller must provide one, and until it arrives the return sits
 * and ages into an A-to-Z.
 *
 * Returns go back to the branch that shipped them, since that branch holds the
 * stock and can put the unit straight back on the shelf. The original
 * shipment's ShipStation warehouseId maps to the branch via
 * prosol-location-map.json, and the label carries a reference the branch can
 * match against.
 *
 * WHO PAYS IS AMAZON'S CALL, NOT OURS. The returns report carries "Label to be
 * paid by", set from the return reason: seller-fault codes (DEFECTIVE,
 * SWITCHEROO, MISSING_PARTS, MISSED_ESTIMATED_DELIVERY) bill the seller;
 * remorse codes (UNWANTED_ITEM, NOT_COMPATIBLE, QUALITY_UNACCEPTABLE) bill the
 * customer. On the current queue that is 4 seller vs 12 customer.
 *
 * We only owe a label on the SELLER-pays ones. Buying labels for customer-pays
 * returns would be paying freight the buyer already owes — so payer is the
 * gate, ahead of any triage bucket or economics.
 *
 * Even inside seller-pays, recovery still has to be worth it: a return can cost
 * more than the goods (one here is 207% of item value), and a never-received
 * parcel has nothing to send back at all.
 *
 * Data note: SP-API redacts what this needs (order address returns city and
 * postal only, buyerInfo is empty, messaging permits no actions). ShipStation
 * retained the full ship-to and the buyer's @marketplace.amazon.ca relay
 * address from order import, so that is the source for both.
 *
 * Rates before it buys, so the cost cap is checked against a real number.
 * Never issues a second label for a return that already has one.
 *
 * Usage:
 *   node scripts/ops/returns-label.js                 # dry run: rate + decide
 *   node scripts/ops/returns-label.js --commit        # buy labels
 *   node scripts/ops/returns-label.js --commit --email  # ...and send to buyer
 *   node scripts/ops/returns-label.js --max-pct=40 --max-abs=45
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ss = require('../../lib/shipstation-v2');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'returns-label-state.json');
const LOC = require(path.join(ROOT, 'scripts', 'shipstation', 'prosol-location-map.json'));

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const COMMIT = process.argv.includes('--commit');
const SEND_EMAIL = process.argv.includes('--email');
// A label is worth buying only if it is small against what we recover. Both
// caps apply; whichever is tighter wins.
const MAX_PCT = Number(arg('max-pct', 40));
const MAX_ABS = Number(arg('max-abs', 45));
// Never worth shipping back regardless of who pays.
const NO_ITEM_TO_RETURN = new Set(['REFUND_NOW_NO_RETURN', 'ALREADY_REFUNDED']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
// v2Request hands back {status, headers, body} with body as a RAW STRING.
// Reading fields straight off the envelope silently yields undefined, which is
// how a working rate call looked like "no rates returned".
const unwrap = (res) => {
  if (res && typeof res.body === 'string') { try { return JSON.parse(res.body); } catch { return null; } }
  return res;
};

const byWarehouse = {};
for (const b of Object.values(LOC)) if (b.shipstation_warehouse_id) byWarehouse[b.shipstation_warehouse_id] = b;

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { issued: {} }; } };
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

function triage() {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'returns-triage.js'), '--json'], { encoding: 'utf8', maxBuffer: 32e6 });
  return JSON.parse(out);
}

function originBranch(orderNumber) {
  // The outbound label records which warehouse shipped it.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA, 'analytics.sqlite'), { readonly: true });
  const row = db.prepare('SELECT warehouse_id, tracking_number FROM shipping_labels WHERE order_number = ? ORDER BY purchased_at DESC LIMIT 1').get(orderNumber);
  db.close();
  if (!row || !row.warehouse_id) return null;
  return { branch: byWarehouse[row.warehouse_id] || null, warehouseId: row.warehouse_id, outboundTracking: row.tracking_number };
}

async function rateReturn({ from, to, weightLb, reference }) {
  const body = {
    rate_options: { carrier_ids: [ss.CARRIER_IDS.purolator_walleted] },
    shipment: {
      ship_from: to,          // return label: origin is the CUSTOMER
      ship_to: from,          // destination is the BRANCH
      packages: [{ weight: { value: Math.max(1, weightLb || 2), unit: 'pound' } }],
      confirmation: 'none',
    },
  };
  const res = unwrap(await ss.v2Request('POST', '/v2/rates', body));
  const rates = (res && res.rate_response && res.rate_response.rates) || [];
  if (!rates.length) return { error: (res?.rate_response?.errors || []).map((e) => e.message).join('; ') || 'no rates returned' };
  // Surcharges bill on top of shipping_amount, so compare on landed cost.
  const landed = (x) => Number(x.shipping_amount?.amount || 0) + Number(x.other_amount?.amount || 0) + Number(x.confirmation_amount?.amount || 0);
  rates.sort((a, b) => landed(a) - landed(b));
  const best = rates[0];
  return { cost: landed(best), base: Number(best.shipping_amount?.amount || 0), surcharge: Number(best.other_amount?.amount || 0), serviceCode: best.service_code, rateId: best.rate_id, carrierId: best.carrier_id };
}

(async () => {
  const state = loadState();
  const all = triage();
  const sellerPays = all.filter((r) => /seller/i.test(r.payer || ''));
  const rows = sellerPays.filter((r) => !NO_ITEM_TO_RETURN.has(r.bucket));
  console.log(`open returns: ${all.length}  ·  seller-pays: ${sellerPays.length}  ·  customer-pays (Amazon's label, not our cost): ${all.length - sellerPays.length}`);
  console.log(`eligible for a label from us: ${rows.length}  (caps: <=${MAX_PCT}% of value, <=${money(MAX_ABS)})\n`);
  for (const r of sellerPays.filter((r) => NO_ITEM_TO_RETURN.has(r.bucket))) {
    console.log(`  ⏭  ${r.order}  seller-pays but nothing to ship back (${r.bucket}) — refund only`);
  }

  const results = [];
  for (const r of rows) {
    const key = `${r.order}|${r.sku}`;
    if (state.issued[key]) { console.log(`  ⏭  ${r.order}  label already issued ${state.issued[key].at.slice(0, 10)} (${state.issued[key].tracking})`); continue; }

    const origin = originBranch(r.order);
    if (!origin || !origin.branch) { console.log(`  ✗  ${r.order}  cannot resolve originating branch (warehouse ${origin?.warehouseId ?? '?'})`); results.push({ ...r, ok: false, why: 'no branch' }); continue; }

    const so = await ss.findOrderByAmazonOrderId(r.order);
    if (!so || !so.shipTo?.street1) { console.log(`  ✗  ${r.order}  no customer address in ShipStation`); results.push({ ...r, ok: false, why: 'no address' }); continue; }

    const b = origin.branch;
    const to = {
      name: `Prosol ${b.city} — CFC RETURN`,
      phone: (b.contact_phone || [])[0] || '',
      address_line1: b.address,
      city_locality: b.city,
      state_province: b.province,
      postal_code: b.postal_code,
      country_code: 'CA',
      address_residential_indicator: 'no',
    };
    const from = {
      name: so.shipTo.name,
      phone: so.shipTo.phone || '',
      address_line1: so.shipTo.street1,
      address_line2: so.shipTo.street2 || '',
      city_locality: so.shipTo.city,
      state_province: ss.normalizeProvinceCode(so.shipTo.state),
      postal_code: so.shipTo.postalCode,
      country_code: 'CA',
      address_residential_indicator: 'yes',
    };
    // What the branch matches the box against when it lands on their dock.
    const reference = `CFC RETURN ${r.order}`;

    const weight = Number(so.weight?.value) || 2;
    const rate = await rateReturn({ from: to, to: from, weightLb: weight, reference });
    await sleep(500);
    if (rate.error) { console.log(`  ✗  ${r.order}  rating failed: ${String(rate.error).slice(0, 90)}`); results.push({ ...r, ok: false, why: rate.error }); continue; }

    const pct = r.value ? (rate.cost / r.value) * 100 : 999;
    const overCap = rate.cost > MAX_ABS || pct > MAX_PCT;
    console.log(`  ${overCap ? '⚠' : '✓'}  ${r.order}  ${String(r.sku).slice(0, 16).padEnd(17)} ${money(rate.cost).padStart(8)} (base ${money(rate.base)} + ${money(rate.surcharge)} surcharge, ${pct.toFixed(0)}% of ${money(r.value)})  → Prosol ${b.city}${overCap ? '   OVER CAP — needs you' : ''}`);
    if (overCap) { results.push({ ...r, ok: false, why: `label ${money(rate.cost)} over cap`, rate }); continue; }
    if (!COMMIT) { results.push({ ...r, ok: true, dryRun: true, rate, branch: b.city }); continue; }

    const buy = unwrap(await ss.v2Request('POST', `/v2/labels/rates/${rate.rateId}`, {
      validate_address: 'no_validation',
      label_layout: '4x6',
      label_format: 'pdf',
      label_download_type: 'url',
      is_return_label: true,
      label_messages: { reference1: reference, reference2: r.sku, reference3: (r.item || '').slice(0, 35) },
    }));
    const tracking = buy?.tracking_number;
    const url = buy?.label_download?.pdf || buy?.label_download?.href;
    if (!tracking) { console.log(`     ✗ buy failed: ${JSON.stringify(buy).slice(0, 160)}`); results.push({ ...r, ok: false, why: 'buy failed' }); continue; }

    console.log(`     ✓ label ${tracking}  ${money(buy?.shipment_cost?.amount)}  ${url ? 'pdf ready' : 'no pdf url'}`);
    state.issued[key] = { at: new Date().toISOString(), tracking, cost: Number(buy?.shipment_cost?.amount || 0), branch: b.city, url, emailed: false };
    saveState(state);
    results.push({ ...r, ok: true, tracking, url, branch: b.city, cost: Number(buy?.shipment_cost?.amount || 0) });

    if (SEND_EMAIL && so.customerEmail) {
      // Buyer relay address, order-related communication only.
      console.log(`     → would email ${so.customerEmail} (sending not wired yet — see note)`);
    }
    await sleep(900);
  }

  const issued = results.filter((r) => r.ok && !r.dryRun);
  const capped = results.filter((r) => !r.ok && /over cap/.test(r.why || ''));
  console.log(`\n${COMMIT ? 'issued' : 'would issue'}: ${results.filter((r) => r.ok).length}  ·  over cap (need you): ${capped.length}  ·  failed: ${results.filter((r) => !r.ok && !/over cap/.test(r.why || '')).length}`);
  if (issued.length) console.log(`label spend: ${money(issued.reduce((s, r) => s + (r.cost || 0), 0))}`);
  if (!COMMIT) console.log('\nDRY RUN — rated only, nothing bought. Re-run with --commit.');
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
