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
 * Every flow runs twice; the second pass must create nothing. Order numbers,
 * tracking codes and vendor codes are ROTEST-prefixed so nothing collides with
 * CFC's real data when it is loaded into the environment.
 *
 * Usage: node scripts/automayt/replay-on-beta1.js [--ops-state=<dir>] [--run=<id>]
 * Report: data/automayt-e2e/replay-<run>.json
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const RUN = (process.argv.find((a) => a.startsWith('--run=')) || '').slice(6)
  || new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
const OPS_STATE_DIR = (process.argv.find((a) => a.startsWith('--ops-state=')) || '').slice(12)
  || path.join(__dirname, '..', '..', '..', 'run-orders', 'data', 'ops-state');

// Set before the Automayt modules load.
process.env.ERP_BACKEND = 'automayt';
process.env.AUTOMAYT_REF_SYSTEM = process.env.AUTOMAYT_E2E_REF_SYSTEM || 'run-orders-test';
process.env.AUTOMAYT_TEST_CODE_PREFIX = 'ROTEST-';
process.env.AMAZON_PERIOD_ANCHOR = process.env.AMAZON_PERIOD_ANCHOR || '2026-09-18';

const am = require('../../lib/automayt');
const erp = require('../../lib/automayt-erp');
const erpBackend = require('../../lib/erp-backend');
const { loadSkuMap } = require('../../lib/shopify-sf');

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
      { sku: '4172', title: 'Schluter KERDI-FIX Bright White 290ml', quantity: 2, price: '37.96' },
      { sku: '11510', title: 'Schluter KERDI-TROWEL 1/8 x 1/8', quantity: 1, price: '39.34' },
      { sku: '71', title: 'Bona Professional Microfiber Cleaning Pad', quantity: 1, price: '14.99' },
    ],
  };
}

async function setUp() {
  const { base } = am.config();
  if (/app\.automayt\.com/.test(base)) throw new Error('replay-on-beta1 refuses to run against production');
  report.base = base;

  // Vendors and locations can't be created through the API: use the real one if
  // present, else a demo stand-in, passed by id (never mapped).
  const vendors = await am.listAll('/vendors', {}, { max: 2000 });
  const locations = await am.listAll('/locations', {}, { max: 500 });
  const byName = (rows, re) => rows.find((r) => re.test(r.name)) || null;
  const warehouse = locations.find((l) => l.primary && l.type !== 'showroom');
  const pick = (ref, real, standIn) => {
    if (real) return real.id;
    report.standIns.push({ ref, standIn: standIn.name });
    return standIn.id;
  };
  const overrides = {
    prosolVendor: pick('prosolVendor', byName(vendors, /^prosol/i), byName(vendors, /Pacific Tile/i)),
    treecoVendor: pick('treecoVendor', byName(vendors, /^treeco/i), byName(vendors, /Bruce/i)),
    amazonFulfillment: pick('amazonFulfillment', locations.find((l) => l.is_virtual && /amazon/i.test(l.name)), warehouse),
  };
  process.env.AUTOMAYT_REF_OVERRIDES = JSON.stringify(overrides);

  // Salesforce stocks DITRA-PS per square foot (lib/pbsi-uom.js); seed the same
  // so the replay proves the roll → sqft conversion. Own-stock Bona pad is a
  // Sechelt item found by its legacy item number.
  await erp.createItem({ vendorCode: 'DITRAPS25M', itemNumber: 'DITRAPS25M', description: 'Schluter DITRA-PS Uncoupling Membrane Peel & Stick Roll (269 sqft)', category: 'Underlayment', unit: 'sqft', cost: '1.7192', retail: '3.0160', vendorId: overrides.prosolVendor, manufacturer: 'Schluter' });
  await erp.createItem({ vendorCode: 'BONA-PAD-71', itemNumber: '71', description: 'Bona Professional Microfiber Cleaning Pad', category: 'Supplies', unit: 'each', cost: '6.00', retail: '14.99', manufacturer: 'Bona' });
}

async function flow(name, fn, check) {
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
  report.flows.push({ name, ok: verdict.ok, note: verdict.note, ms: Date.now() - t0, writes: reqs.filter((r) => r.method !== 'GET').length, requestIds: reqs.map((r) => r.requestId).filter(Boolean), errors: reqs.filter((r) => r.code).map((r) => ({ path: r.path, code: r.code, requestId: r.requestId })), result });
  console.log(`  ${verdict.ok ? '✓' : '✗'} ${name} — ${verdict.note}`);
  return result;
}

async function main() {
  console.log(`Automayt replay ${RUN} (ERP_BACKEND=automayt, refs ${process.env.AUTOMAYT_REF_SYSTEM}, codes ROTEST-)\n`);
  await setUp();
  console.log(`  stand-ins: ${report.standIns.map((s) => `${s.ref}→${s.standIn}`).join(', ') || 'none'}\n`);

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
  const tracking = `ROTEST${RUN}S1`;
  await flow('Shopify: SO with all lines, Prosol PO without the own-stock line', () => erpBackend.createShopifySoPo({ shopifyOrder: order, trackingNumber: tracking, carrierCode: 'purolator_walleted' }), (r) => ({
    ok: !r.errors.length && !!r.soNumber && !!r.poNumber,
    note: `${r.soNumber} / ${r.poNumber}; auto-created ${r.steps.filter((s) => s.step === 'auto-create-item').map((s) => s.itemNumber).join(', ') || 'none'}${r.errors.length ? `; errors ${JSON.stringify(r.errors)}` : ''}`,
  }));
  await flow('Shopify: same order again is a skip', () => erpBackend.createShopifySoPo({ shopifyOrder: order, trackingNumber: tracking, carrierCode: 'purolator_walleted' }), (r) => ({
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

  report.finishedAt = new Date().toISOString();
  const failed = report.flows.filter((f) => !f.ok).length;
  fs.mkdirSync(path.join(__dirname, '..', '..', 'data', 'automayt-e2e'), { recursive: true });
  const out = path.join(__dirname, '..', '..', 'data', 'automayt-e2e', `replay-${RUN}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n${failed ? `${failed} flow(s) failed` : 'All flows passed'} — ${report.requests.length} requests. Report: ${out}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}${err.requestId ? ` [${err.requestId}]` : ''}`);
  process.exit(2);
});
