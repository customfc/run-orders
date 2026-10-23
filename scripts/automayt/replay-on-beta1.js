#!/usr/bin/env node
/**
 * Replay real run-orders traffic through the Automayt flows (ERP_BACKEND=automayt)
 * on beta1 or staging. Refuses production.
 *
 *   Amazon   the most recent real multi-package Amazon order in data/ops-state
 *            (read-only), buyer details replaced with placeholders.
 *   Shopify  a fixture order built from real sku-map rows: a Prosol item that
 *            auto-creates, a tool, and an own-stock Sechelt item that stays off the PO.
 *   FBA      a one-line Prosol restock draft.
 *
 * --day=YYYY-MM-DD replays one real day instead: every Amazon parcel and Shopify
 * order the pipeline bought a label for that day (data/ops-state/<day>.json),
 * through the same reads the live flow makes. Amazon parcels come from
 * ShipStation with what Amazon charged (item prices, buyer shipping); Shopify
 * orders and what Shopify charged come from Shopify. All reads, nothing is
 * written anywhere but Automayt. Run it after beta1-e2e.js, which sets up the
 * rehearsal house customers. --real-codes (staging only, after the catalogue
 * load) looks items up by their real codes instead of ROTEST- ones.
 *
 * Every flow runs twice; the second pass must create nothing. Order numbers,
 * tracking codes and vendor codes are ROTEST-prefixed so nothing collides with
 * CFC's real data when it is loaded into the environment. Buyer names,
 * addresses and emails are replaced with placeholders.
 *
 * Usage: node scripts/automayt/replay-on-beta1.js [--ops-state=<dir>] [--run=<id>]
 *        node scripts/automayt/replay-on-beta1.js --day=2026-10-22 [--real-codes]
 * Report: data/automayt-e2e/replay-<run>.json (replay-day-<day>-<run>.json)
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const RUN = arg('run') || new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
const DAY = arg('day');
const REAL_CODES = process.argv.includes('--real-codes');
if (DAY && !/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error(`--day must be YYYY-MM-DD, not "${DAY}"`);
if (REAL_CODES && !DAY) throw new Error('--real-codes is for the --day sample only');
// A day's file has to be where lib/ops-state reads it too: amazon-po resolves
// multi-package parcels through it.
const OPS_STATE_DIR = arg('ops-state')
  || (DAY ? path.join(__dirname, '..', '..', 'data', 'ops-state') : path.join(__dirname, '..', '..', '..', 'run-orders', 'data', 'ops-state'));

// Set before the Automayt modules load.
process.env.ERP_BACKEND = 'automayt';
process.env.AUTOMAYT_REF_SYSTEM = process.env.AUTOMAYT_E2E_REF_SYSTEM || 'run-orders-test';
if (!REAL_CODES) process.env.AUTOMAYT_TEST_CODE_PREFIX = 'ROTEST-';
// The day sample keeps the real 14-day cadence; the fixture replay its old anchor.
if (!DAY) process.env.AMAZON_PERIOD_ANCHOR = process.env.AMAZON_PERIOD_ANCHOR || '2026-09-18';

const am = require('../../lib/automayt');
const erp = require('../../lib/automayt-erp');
const erpBackend = require('../../lib/erp-backend');
const { loadSkuMap, fetchShopifyOrder } = require('../../lib/shopify-sf');
const { fetchShippedOrdersForPO } = require('../../lib/amazon-po');
const channelTaxIo = require('../../lib/channel-tax-io');

const report = { run: RUN, startedAt: new Date().toISOString(), standIns: [], flows: [], requests: [] };
am.setRequestLogger((e) => report.requests.push(e));

/** Most recent ops-state day holding a multi-package Amazon label. */
function realAmazonOrder() {
  if (!fs.existsSync(OPS_STATE_DIR)) return null;
  const files = fs.readdirSync(OPS_STATE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  for (const f of files) {
    let st;
    try { st = JSON.parse(fs.readFileSync(path.join(OPS_STATE_DIR, f), 'utf8')); } catch { continue; }
    for (const lbl of Object.values((st.phases && st.phases.buy && st.phases.buy.labels) || {})) {
      if (lbl.source === 'amazon_ca' && (lbl.packages || []).length) return { day: f.slice(0, 10), lbl };
    }
  }
  return null;
}

/** ShipStation-shaped shipments for one order, PII replaced and refs prefixed. */
function amazonShipments(found) {
  const skuMap = loadSkuMap();
  const order = `ROTEST-${RUN}-${found.lbl.orderNumber.slice(-7)}`;
  return found.lbl.packages.map((pkg, i) => ({
    orderNumber: order,
    trackingNumber: `ROTEST${RUN}A${i + 1}`,
    carrierCode: found.lbl.carrierCode,
    shipDate: (found.lbl.at || found.day).slice(0, 10),
    shipTo: { name: 'Rehearsal Buyer', city: 'Sechelt', postalCode: 'V0N 3A0' },
    items: (pkg.items || []).map((it) => ({
      sku: it.sku,
      name: it.name,
      quantity: it.quantity || 1,
      unitPrice: skuMap[it.sku] && skuMap[it.sku].retail_cad != null ? Number(skuMap[it.sku].retail_cad) : null,
    })),
  }));
}

function shopifyFixture() {
  return {
    orderNumber: `#ROTEST-${RUN}-S`,
    email: null,
    customer: { firstName: 'Rehearsal', lastName: 'Buyer' },
    createdAt: new Date().toISOString().slice(0, 10),
    items: [
      { id: 1, sku: '4172', title: 'Schluter KERDI-FIX Bright White 290ml', quantity: 2, price: '37.96' },
      { id: 2, sku: '11510', title: 'Schluter KERDI-TROWEL 1/8 x 1/8', quantity: 1, price: '39.34' },
      { id: 3, sku: '71', title: 'Bona Professional Microfiber Cleaning Pad', quantity: 1, price: '14.99' },
    ],
  };
}

// What Shopify charged on the fixture: a BC delivery, GST 5% + PST 7% per line and on freight.
function shopifyFixtureMoney(order) {
  const t = (g, p) => [{ code: 'GST', amount: g }, { code: 'PST', amount: p }];
  return {
    orderNumber: order.orderNumber, province: 'BC', subtotal: 130.25, shipping: 12.99, total: 160.43, fee: 4.95, feeUnknown: false, paidVia: ['shopify_payments'],
    tax: t('7.17', '10.02'), refunds: [], refunded: 0,
    lines: [
      { id: '1', sku: '4172', quantity: 2, total: 75.92, taxCharged: t('3.80', '5.31') },
      { id: '2', sku: '11510', quantity: 1, total: 39.34, taxCharged: t('1.97', '2.75') },
      { id: '3', sku: '71', quantity: 1, total: 14.99, taxCharged: t('0.75', '1.05') },
    ],
    shippingLines: [{ title: 'Standard', total: 12.99, taxCharged: t('0.65', '0.91') }],
  };
}

async function ensureCustomer(refName, name) {
  try { return await erp.resolveRef(refName); } catch { /* not mapped under the test system yet */ }
  const { data } = await am.command('/customers', { name, type: 'commercial', duplicate_check: 'skip', notes: 'run-orders house account (rehearsal)' }, `customer-${process.env.AUTOMAYT_REF_SYSTEM}-${refName}`);
  await erp.mapRef(refName, data.id);
  report.created.push({ customer: name, id: data.id, mappedAs: `${process.env.AUTOMAYT_REF_SYSTEM}:${refName}` });
  return data.id;
}

async function setUp() {
  const { base } = am.config();
  if (/app\.automayt\.com/.test(base)) throw new Error('replay-on-beta1 refuses to run against production');
  if (REAL_CODES && !/staging\.automayt\.dev/.test(base)) throw new Error('--real-codes runs on staging only (beta1 never gets real codes)');
  report.base = base;

  // Vendors and locations are Automayt's records: use the real one if present,
  // else a demo stand-in, passed by id (never mapped).
  const vendors = await am.listAll('/vendors', {}, { max: 2000 });
  const locations = await am.listAll('/locations', {}, { max: 500 });
  const byName = (rows, re) => rows.find((r) => re.test(r.name)) || null;
  const warehouse = locations.find((l) => l.primary && l.type !== 'showroom');
  const pick = (ref, real, standIn) => {
    if (real) return real.id;
    report.standIns.push({ ref, standIn: standIn.name });
    return standIn.id;
  };
  // CFC's tenant has an "Amazon Fulfillment" warehouse that isn't flagged virtual (2026-10-23).
  const amazonFc = locations.find((l) => l.is_virtual && /amazon/i.test(l.name)) || byName(locations, /^amazon fulfil/i);
  if (amazonFc && !amazonFc.is_virtual) report.notes = [...(report.notes || []), `location "${amazonFc.name}" (${amazonFc.id}) is used for Amazon Fulfillment but isn't flagged virtual`];
  const overrides = {
    prosolVendor: pick('prosolVendor', byName(vendors, /prosol/i), byName(vendors, /Pacific Tile/i)),
    treecoVendor: pick('treecoVendor', byName(vendors, /^treeco/i), byName(vendors, /Bruce/i)),
    amazonFulfillment: pick('amazonFulfillment', amazonFc, warehouse),
  };
  process.env.AUTOMAYT_REF_OVERRIDES = JSON.stringify(overrides);
  report.fixed = { prosolVendor: overrides.prosolVendor, treecoVendor: overrides.treecoVendor, amazonFulfillment: overrides.amazonFulfillment };
  // Rehearsal house customers under the test ref system, the same way
  // beta1-e2e.js sets them up (same name, idempotency key and mapping).
  report.created = [];
  await ensureCustomer('shopifyCustomer', 'Shopify (yourfloors.ca web store) [rehearsal]');
  await ensureCustomer('amazonCustomer', 'Amazon.ca [rehearsal]');
  if (DAY) return;

  // Salesforce stocks DITRA-PS per square foot (lib/pbsi-uom.js); seed the same
  // so the replay proves the roll → sqft conversion. Own-stock Bona pad is a
  // Sechelt item found by its legacy item number.
  await erp.createItem({ vendorCode: 'DITRAPS25M', itemNumber: 'DITRAPS25M', description: 'Schluter DITRA-PS Uncoupling Membrane Peel & Stick Roll (269 sqft)', category: 'Underlayment', unit: 'sqft', cost: '1.7192', retail: '3.0160', vendorId: overrides.prosolVendor, manufacturer: 'Schluter' });
  await erp.createItem({ vendorCode: 'BONA-PAD-71', itemNumber: '71', description: 'Bona Professional Microfiber Cleaning Pad', category: 'Supplies', unit: 'each', cost: '6.00', retail: '14.99', manufacturer: 'Bona' });
}

async function flow(name, fn, check, meta = {}) {
  const first = report.requests.length;
  const t0 = Date.now();
  let result;
  let error = null;
  try {
    result = await fn();
  } catch (err) {
    error = `${err.message}${err.requestId ? ` [${err.requestId}]` : ''}`;
  }
  const verdict = error ? { ok: false, note: error } : check(result);
  const reqs = report.requests.slice(first);
  report.flows.push({ name, ...meta, ok: verdict.ok, note: verdict.note, ms: Date.now() - t0, writes: reqs.filter((r) => r.method !== 'GET').length, requestIds: reqs.map((r) => r.requestId).filter(Boolean), errors: reqs.filter((r) => r.code).map((r) => ({ path: r.path, code: r.code, requestId: r.requestId })), result });
  console.log(`  ${verdict.ok ? '✓' : '✗'} ${name} — ${verdict.note}`);
  return result;
}

async function replayFixtures() {
  const found = realAmazonOrder();
  if (found) {
    const prefetched = { shipments: amazonShipments(found), unresolved: [] };
    report.amazonSource = { day: found.day, packages: found.lbl.packages.length, skus: [...new Set(found.lbl.packages.flatMap((p) => (p.items || []).map((i) => i.sku)))] };
    await flow(`Amazon: real ${found.day} order, ${prefetched.shipments.length} parcels`, () => erpBackend.createAmazonPOs({ prefetched }), (r) => {
      const created = r.orders.filter((o) => o.status === 'created');
      const bad = r.orders.filter((o) => o.status !== 'created');
      return {
        ok: !r.errors.length && !bad.length && created.length === prefetched.shipments.length && created.every((o) => o.received),
        note: `${created.length}/${prefetched.shipments.length} POs ${created.map((o) => o.poNumber).join(', ')} on ${r.soNames.join(', ')}, qty/parcel ${created.map((o) => o.items.map((i) => i.qty).join('+')).join(', ')}${bad.length ? `; problems: ${JSON.stringify(bad.map((o) => o.errors))}` : ''}${r.errors.length ? `; errors ${JSON.stringify(r.errors)}` : ''}`,
      };
    });
    await flow('Amazon: same parcels again create nothing', () => erpBackend.createAmazonPOs({ prefetched }), (r) => ({
      ok: !r.errors.length && r.orders.every((o) => o.status === 'skipped'),
      note: r.orders.map((o) => `${o.trackingNumber} ${o.status}`).join(', '),
    }));
  } else {
    console.log('  (no Amazon order in local ops-state; Amazon replay skipped)');
  }

  const order = shopifyFixture();
  const money = shopifyFixtureMoney(order);
  const tracking = `ROTEST${RUN}S1`;
  let shopSo = null;
  await flow('Shopify: SO with all lines at paid prices, freight, tax as charged; Prosol PO without the own-stock line', () => erpBackend.createShopifySoPo({ shopifyOrder: order, money, trackingNumber: tracking, carrierCode: 'purolator_walleted' }), (r) => {
    shopSo = r.soId;
    return {
      ok: !r.errors.length && !!r.soNumber && !!r.poNumber && r.moneyCheck && r.moneyCheck.diff === 0,
      note: `${r.soNumber} / ${r.poNumber}; total ${r.moneyCheck && r.moneyCheck.soTotal} vs Shopify ${money.total}; auto-created ${r.steps.filter((s) => s.step === 'auto-create-item').map((s) => s.itemNumber).join(', ') || 'none'}${r.errors.length ? `; errors ${JSON.stringify(r.errors)}` : ''}`,
    };
  });
  await flow('Shopify: Automayt booked exactly the tax Shopify charged', async () => (await am.get(`/sales-orders/${shopSo}`)).data, (so) => ({
    ok: so.subtotal === '143.24' && so.tax_total === '17.19' && so.total === '160.43' && JSON.stringify(so.tax_lines.map((l) => [l.code, l.amount])) === JSON.stringify([['GST', '7.17'], ['PST', '10.02']]),
    note: `subtotal ${so.subtotal}, tax ${so.tax_total} (${so.tax_lines.map((l) => `${l.code} ${l.amount}`).join(', ')}), total ${so.total}`,
  }));
  await flow('Shopify: same order again is a skip', () => erpBackend.createShopifySoPo({ shopifyOrder: order, money, trackingNumber: tracking, carrierCode: 'purolator_walleted' }), (r) => ({
    ok: r.skipped === true && !r.errors.length,
    note: `${r.skipReason}; candidates ${(r.existingCandidates || []).join(', ')}`,
  }));

  const draft = { draftId: `ROTEST-${RUN}-draft`, createdAt: new Date().toISOString() };
  const fbaLines = () => [{ asin: 'B07QBD5Q86', qty: 4, product: 'Schluter SHELF quadrilateral corner', vendor: 'prosol' }];
  const noSalesforce = async () => { throw new Error('Salesforce must not be called with ERP_BACKEND=automayt'); };
  let firstPo = null;
  await flow('FBA: stock PO into Amazon Fulfillment', () => erpBackend.createFbaPO({ vendor: 'prosol', draft, lines: fbaLines(), bucket: 'instock' }, noSalesforce), (r) => {
    firstPo = r.poNumber;
    return { ok: r.created && !r.errors.length, note: `${r.poNumber}, ${r.lineCount} line(s), total ${r.totalCost}${r.errors.length ? `; errors ${JSON.stringify(r.errors)}` : ''}` };
  });
  await flow('FBA: same send again returns the same PO', () => erpBackend.createFbaPO({ vendor: 'prosol', draft, lines: fbaLines(), bucket: 'instock' }, noSalesforce), (r) => ({
    ok: r.poNumber === firstPo,
    note: `${r.poNumber}${r.duplicate ? ' (409 duplicate → existing)' : ' (idempotent replay)'}`,
  }));
}

// ── One real day (--day) ─────────────────────────────────────────────────────

const PLACEHOLDER = { name: 'Rehearsal Buyer', city: 'Sechelt', postalCode: 'V0N 3A0' };
const round2 = (n) => Math.round(n * 100) / 100;

function dayLabels(day) {
  const file = path.join(OPS_STATE_DIR, `${day}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no pipeline state for ${day} at ${file}; copy it from the Mini first: scp fred@freds-mac-mini.taila452b5.ts.net:run-orders/data/ops-state/${day}.json data/ops-state/`);
  }
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.values((st.phases && st.phases.buy && st.phases.buy.labels) || {});
}

/**
 * The day's Amazon parcels exactly as the live flow fetches them (ShipStation,
 * read-only, with what Amazon charged), grouped by order, refs and buyer replaced.
 */
async function dayAmazonOrders(day, labels) {
  const wanted = new Map(); // real tracking → real order number
  for (const l of labels.filter((x) => x.source === 'amazon_ca')) {
    for (const t of [l.trackingNumber, ...(l.packages || []).map((p) => p.trackingNumber)]) if (t) wanted.set(String(t), l.orderNumber);
  }
  if (!wanted.size) return { orders: [], missing: [] };
  // ShipStation lists shipments from a ship date onward: reach back past the day.
  const days = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(day)) / 86400000) + 2;
  const fetched = await fetchShippedOrdersForPO({ days });
  const byOrder = new Map();
  let n = 0;
  for (const s of fetched.shipments.filter((x) => wanted.has(String(x.trackingNumber)))) {
    if (!byOrder.has(s.orderNumber)) byOrder.set(s.orderNumber, { real: s.orderNumber, test: `ROTEST-${RUN}-${String(s.orderNumber).slice(-7)}`, parcels: [], realTracking: [] });
    const o = byOrder.get(s.orderNumber);
    n += 1;
    o.realTracking.push(s.trackingNumber);
    o.parcels.push({ ...s, shipmentId: null, orderId: null, orderNumber: o.test, trackingNumber: `ROTEST${RUN}A${n}`, shipTo: { ...PLACEHOLDER } });
  }
  const seen = new Set(fetched.shipments.map((s) => String(s.trackingNumber)));
  const unresolved = new Set((fetched.unresolved || []).map((u) => String(u.trackingNumber)));
  const missing = [...wanted].filter(([t]) => !seen.has(t)).map(([t, order]) => ({ trackingNumber: t, orderNumber: order, unresolved: unresolved.has(t) }));
  return { orders: [...byOrder.values()], missing };
}

/** One of the day's Shopify orders and what Shopify charged, read the way the live flow reads them, buyer replaced. */
async function dayShopifyOrder(lbl, i) {
  const real = String(lbl.orderNumber).replace(/^#/, '');
  const order = await fetchShopifyOrder(real);
  const money = await channelTaxIo.fetchShopifyOrderMoney(real);
  const test = `#ROTEST-${RUN}-${real}`;
  return {
    real,
    test,
    tracking: `ROTEST${RUN}S${i + 1}`,
    carrierCode: lbl.carrierCode || null,
    shopifyOrder: {
      ...order,
      id: null,
      orderNumber: test,
      email: null,
      customer: { firstName: 'Rehearsal', lastName: 'Buyer' },
      shippingAddress: order.shippingAddress ? { name: PLACEHOLDER.name, city: PLACEHOLDER.city, province: order.shippingAddress.province, zip: PLACEHOLDER.postalCode } : null,
    },
    money: { ...money, orderNumber: test },
  };
}

/** What Amazon charged for the parcels that made it onto the period order: item prices plus each order's shipping once. */
function amazonCharged(orders, createdTracking) {
  let total = 0;
  let priced = true;
  for (const o of orders) {
    const parcels = o.parcels.filter((p) => createdTracking.has(p.trackingNumber));
    for (const p of parcels) {
      for (const it of p.items || []) {
        if (!(Number(it.unitPrice) > 0)) priced = false;
        total += Number(it.unitPrice || 0) * (Number(it.quantity) || 1);
      }
    }
    if (parcels.length) total += Number(parcels[0].orderShipping) || 0;
  }
  return { total: round2(total), priced };
}

async function replayDay(day) {
  const labels = dayLabels(day);
  report.day = { date: day, labels: labels.length, bySource: labels.reduce((m, l) => ({ ...m, [l.source]: (m[l.source] || 0) + 1 }), {}) };
  console.log(`  ${day}: ${labels.length} label(s) ${JSON.stringify(report.day.bySource)}\n`);

  // Amazon: each order through the live flow, then the whole day again.
  const amazon = await dayAmazonOrders(day, labels);
  const periodSos = new Map();
  const createdTracking = new Set();
  for (const o of amazon.orders) {
    const meta = { channel: 'amazon', sourceOrder: o.real, testOrder: o.test, parcels: o.parcels.length };
    await flow(`Amazon ${o.real} → ${o.test}: ${o.parcels.length} parcel(s), Amazon charged ${o.parcels.flatMap((p) => p.items.map((i) => `${i.sku} x${i.quantity} @ ${i.unitPrice}`)).join(', ')} + shipping ${o.parcels[0].orderShipping}`, () => erpBackend.createAmazonPOs({ prefetched: { shipments: o.parcels, unresolved: [] } }), (r) => {
      const created = r.orders.filter((x) => x.status === 'created');
      const bad = r.orders.filter((x) => x.status !== 'created');
      for (const x of created) {
        createdTracking.add(x.trackingNumber);
        if (x.soId) periodSos.set(x.soId, x.soName);
      }
      const warnings = r.orders.flatMap((x) => x.warnings || []);
      const autoCreated = r.orders.flatMap((x) => (x.autoCreated || []).map((a) => a.itemNumber));
      return {
        ok: !r.errors.length && !bad.length && created.length === o.parcels.length && created.every((x) => x.received),
        note: `${r.soNames.join(', ')}: ${created.map((x) => `${x.poNumber} received, ${x.items.map((i) => `${i.pbsiItem} ${i.qty} @ ${i.salePrice}`).join(' + ')}`).join('; ')}`
          + `; auto-created ${autoCreated.join(', ') || 'none'}`
          + `${warnings.length ? `; warnings ${warnings.join('; ')}` : ''}${bad.length ? `; problems: ${JSON.stringify(bad.map((x) => ({ status: x.status, reason: x.reason, errors: x.errors })))}` : ''}${r.errors.length ? `; errors ${JSON.stringify(r.errors)}` : ''}`,
      };
    }, meta);
  }
  for (const m of amazon.missing) {
    const note = m.unresolved
      ? 'ShipStation has the parcel but not its order and the day file did not resolve it: the live flow would report an error too'
      : 'not in ShipStation\'s shipments (voided or relabelled): the live flow would not see it either';
    report.flows.push({ name: `Amazon ${m.orderNumber}: parcel ${m.trackingNumber}`, channel: 'amazon', sourceOrder: m.orderNumber, ok: !m.unresolved, note, writes: 0, requestIds: [], errors: [] });
    console.log(`  ${m.unresolved ? '✗' : '–'} Amazon ${m.orderNumber}: parcel ${m.trackingNumber} ${note}`);
  }

  const parcels = amazon.orders.flatMap((o) => o.parcels);
  if (periodSos.size) {
    await flow('Amazon: the period order carries exactly what Amazon charged', async () => {
      const lines = [];
      for (const id of periodSos.keys()) lines.push(...(((await am.get(`/sales-orders/${id}`)).data || {}).lines || []));
      return lines.filter((l) => String(l.external_line_ref || '').startsWith(`ROTEST${RUN}A`) || String(l.external_line_ref || '').startsWith(`ROTEST-${RUN}-`));
    }, (lines) => {
      const booked = round2(lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price), 0));
      const want = amazonCharged(amazon.orders, createdTracking);
      return {
        ok: !want.priced || booked === want.total,
        note: `${[...periodSos.values()].join(', ')}: ${lines.length} line(s) from this day, ${booked.toFixed(2)} vs Amazon ${want.total.toFixed(2)}${want.priced ? '' : ' (an item had no Amazon price, so the catalogue price was used)'}`,
      };
    }, { channel: 'amazon' });
  }
  if (parcels.length) {
    await flow(`Amazon: the day's ${parcels.length} parcel(s) again create nothing`, () => erpBackend.createAmazonPOs({ prefetched: { shipments: parcels, unresolved: [] } }), (r) => ({
      ok: !r.errors.length && r.orders.length === parcels.length && r.orders.every((x) => x.status === 'skipped'),
      note: r.orders.map((x) => `${x.trackingNumber} ${x.status}`).join(', '),
    }), { channel: 'amazon', pass: 2 });
  }

  // Shopify: each order, its booked total, then the same order again.
  const shopLabels = labels.filter((l) => l.source === 'shopify');
  for (const [i, lbl] of shopLabels.entries()) {
    let s;
    try {
      s = await dayShopifyOrder(lbl, i);
    } catch (err) {
      report.flows.push({ name: `Shopify ${lbl.orderNumber}: read from Shopify`, channel: 'shopify', sourceOrder: lbl.orderNumber, ok: false, note: err.message, writes: 0, requestIds: [], errors: [] });
      console.log(`  ✗ Shopify ${lbl.orderNumber}: read from Shopify — ${err.message}`);
      continue;
    }
    const meta = { channel: 'shopify', sourceOrder: s.real, testOrder: s.test };
    const args = { shopifyOrder: s.shopifyOrder, money: s.money, trackingNumber: s.tracking, carrierCode: s.carrierCode };
    let soId = null;
    await flow(`Shopify ${s.real} → ${s.test}: ${s.shopifyOrder.items.map((it) => `${it.sku || it.title} x${it.quantity}`).join(', ')}`, () => erpBackend.createShopifySoPo(args), (r) => {
      soId = r.soId;
      return {
        ok: !r.errors.length && !!r.soNumber && (!!r.poNumber || !!r.poSkipped) && (!r.moneyCheck || r.moneyCheck.diff === 0),
        note: `${r.soNumber} / ${r.poNumber || `no PO (${r.poSkipReason})`}; total ${r.moneyCheck && r.moneyCheck.soTotal} vs Shopify ${s.money.total}; auto-created ${r.steps.filter((x) => x.step === 'auto-create-item').map((x) => x.itemNumber).join(', ') || 'none'}${r.errors.length ? `; errors ${JSON.stringify(r.errors)}` : ''}`,
      };
    }, meta);
    if (!soId) continue;
    await flow(`Shopify ${s.real}: Automayt booked what Shopify charged`, async () => (await am.get(`/sales-orders/${soId}`)).data, (so) => ({
      ok: Number(so.total) === s.money.total,
      note: `subtotal ${so.subtotal}, tax ${so.tax_total} (${(so.tax_lines || []).map((l) => `${l.code} ${l.amount}`).join(', ')}), total ${so.total} vs Shopify ${s.money.total}`,
    }), meta);
    await flow(`Shopify ${s.real}: same order again is a skip`, () => erpBackend.createShopifySoPo(args), (r) => ({
      ok: r.skipped === true && !r.errors.length,
      note: `${r.skipReason}; candidates ${(r.existingCandidates || []).join(', ')}`,
    }), { ...meta, pass: 2 });
  }
}

async function main() {
  console.log(`Automayt replay ${RUN}${DAY ? ` of ${DAY}` : ''} (ERP_BACKEND=automayt, refs ${process.env.AUTOMAYT_REF_SYSTEM}, codes ${REAL_CODES ? 'real' : 'ROTEST-'})\n`);
  await setUp();
  console.log(`  stand-ins: ${report.standIns.map((s) => `${s.ref}→${s.standIn}`).join(', ') || 'none'}\n`);
  if (DAY) await replayDay(DAY);
  else await replayFixtures();

  report.finishedAt = new Date().toISOString();
  const failed = report.flows.filter((f) => !f.ok).length;
  fs.mkdirSync(path.join(__dirname, '..', '..', 'data', 'automayt-e2e'), { recursive: true });
  const out = path.join(__dirname, '..', '..', 'data', 'automayt-e2e', DAY ? `replay-day-${DAY}-${RUN}.json` : `replay-${RUN}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n${failed ? `${failed} flow(s) failed` : 'All flows passed'} — ${report.requests.length} requests. Report: ${out}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}${err.requestId ? ` [${err.requestId}]` : ''}`);
  process.exit(2);
});
