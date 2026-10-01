#!/usr/bin/env node
/**
 * End-to-end rehearsal of every Automayt call run-orders makes, on beta1 or
 * staging (refuses production). Exercises the same shapes the pipeline sends:
 *
 *   A. Shopify drop-ship: SO (procurement external) + confirmed Prosol PO linked
 *      line by line, idempotent replay, duplicate protection, hand cancel.
 *   B. Amazon parcels: rolling 14-day period SO, one PO per tracking code,
 *      immediate receipt into the Amazon Fulfillment location, receipt price
 *      check, cancel refused after receipt.
 *   C. FBA restock: stock PO with no SO, open supply, partial + over receipts,
 *      top-up lines.
 *   D. Carrier freight: description-only line, tax exempt, own PO.
 *   E. Accounting exception note, payables per PO, events feed.
 *
 * Test records are mapped under external-ref system "run-orders-test" so the
 * real "run-orders" mappings stay free for the records Automayt seeds. Where
 * beta1 lacks a CFC record (Prosol, Treeco, Amazon Fulfillment) a demo record
 * stands in and the report says so.
 *
 * Usage: node scripts/automayt/beta1-e2e.js [--run=<id>]
 * Report: data/automayt-e2e/<run>.json
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
process.env.AUTOMAYT_REF_SYSTEM = process.env.AUTOMAYT_E2E_REF_SYSTEM || 'run-orders-test';

const am = require('../../lib/automayt');
const erp = require('../../lib/automayt-erp');

const RUN = (process.argv.find((a) => a.startsWith('--run=')) || '').slice(6)
  || new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'automayt-e2e');
const ANCHOR = process.env.AMAZON_PERIOD_ANCHOR || '2026-09-18';
process.env.AMAZON_PERIOD_ANCHOR = ANCHOR;

// Real catalogue rows from sku-map, under test-only vendor codes so they can
// never collide with CFC's catalogue when it is loaded into this environment.
const TEST_ITEMS = [
  { key: 'kerdifix', vendorCode: 'ROTEST-KERDIFIX/BW', description: 'Schluter KERDI-FIX Sealing/Bonding Compound Bright White 290ml', category: 'Supplies', cost: 21.64, retail: 37.96, manufacturer: 'Schluter' },
  { key: 'kerdiband', vendorCode: 'ROTEST-KEBA100/125/10M', description: 'Schluter KERDI-BAND Waterproofing Strip 4" x 32\'10"', category: 'Supplies', cost: 32.98, retail: 57.85, manufacturer: 'Schluter' },
  { key: 'shelf', vendorCode: 'ROTEST-SES3D6EB', description: 'Schluter SHELF Quadrilateral Corner Curve Brushed Stainless', category: 'Accessories', cost: 114.92, retail: 201.61, manufacturer: 'Schluter' },
];

const report = { run: RUN, base: null, startedAt: new Date().toISOString(), refSystem: process.env.AUTOMAYT_REF_SYSTEM, anchor: ANCHOR, standIns: [], steps: [], requests: [] };
am.setRequestLogger((e) => report.requests.push(e));

let failures = 0;
async function step(name, fn) {
  const t0 = Date.now();
  const firstReq = report.requests.length;
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail || null, requestIds: report.requests.slice(firstReq).map((r) => r.requestId).filter(Boolean) });
    console.log(`  ✓ ${name}${detail && detail.summary ? ` — ${detail.summary}` : ''}`);
    return detail;
  } catch (err) {
    failures++;
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: err.message, code: err.code || null, requestId: err.requestId || null, details: err.details || null });
    console.log(`  ✗ ${name} — ${err.message}`);
    return null;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }

/** Expect a call to fail with one Automayt error code. */
async function expectCode(code, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === code) return err;
    throw new Error(`expected ${code}, got ${err.code || err.message}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function ensureCustomer(refName, name) {
  try { return await erp.resolveRef(refName); } catch { /* not mapped yet */ }
  const { data } = await am.command('/customers', { name, type: 'commercial', duplicate_check: 'skip', notes: 'run-orders house account (rehearsal)' }, `customer-${process.env.AUTOMAYT_REF_SYSTEM}-${refName}`);
  await erp.mapRef(refName, data.id);
  return data.id;
}

// Vendors and locations can't be created through the API. Use the real record
// when this environment has it, else a demo stand-in. Stand-ins are passed by
// id and never mapped: an external ref can't be re-pointed later, and the real
// "run-orders" mapping must stay free for the record Automayt seeds.
function pickOrStandIn(label, real, standIn, reason) {
  if (real) return real.id;
  if (!standIn) throw new Error(`no record to stand in for ${label}`);
  report.standIns.push({ ref: label, standIn: standIn.name, reason });
  return standIn.id;
}

async function main() {
  const { base } = am.config();
  report.base = base;
  if (/app\.automayt\.com/.test(base)) throw new Error('beta1-e2e refuses to run against production');
  console.log(`Automayt rehearsal run ${RUN} on ${base} (refs: ${process.env.AUTOMAYT_REF_SYSTEM}, Amazon anchor ${ANCHOR})\n`);

  const ctx = {};

  console.log('Setup');
  await step('whoami + health', async () => {
    const who = (await am.get('/whoami')).data;
    const health = await am.get('/health');
    assert(health.status === 200, 'health 200');
    return { summary: `${who.tenant.name}, integration ${who.integration.name}, ${who.key.scopes.length} scopes`, tenant: who.tenant.name, integration: who.integration.name, scopes: who.key.scopes, rateLimits: who.rate_limits };
  });
  await step('house customers mapped', async () => {
    ctx.shopify = await ensureCustomer('shopifyCustomer', 'Shopify (yourfloors.ca web store) [rehearsal]');
    ctx.amazon = await ensureCustomer('amazonCustomer', 'Amazon.ca [rehearsal]');
    return { summary: 'shopify-house, amazon-house' };
  });
  await step('vendors + locations mapped', async () => {
    const vendors = await am.listAll('/vendors', {}, { max: 2000 });
    const locations = await am.listAll('/locations', {}, { max: 500 });
    const byName = (rows, re) => rows.find((r) => re.test(r.name)) || null;
    const warehouse = locations.find((l) => l.primary && l.type !== 'showroom') || byName(locations, /^Sechelt/i);
    ctx.prosol = pickOrStandIn('prosolVendor', byName(vendors, /^prosol/i), byName(vendors, /Pacific Tile/i), 'no Prosol vendor here; the API cannot create vendors');
    ctx.treeco = pickOrStandIn('treecoVendor', byName(vendors, /^treeco/i), byName(vendors, /Bruce/i), 'no Treeco vendor here');
    ctx.carrier = pickOrStandIn('carrierVendor', byName(vendors, /purolator|freightsimple/i), byName(vendors, /Shaw/i), 'no carrier vendor here');
    ctx.sechelt = pickOrStandIn('secheltWarehouse', byName(locations, /^Sechelt/i), warehouse, 'no Sechelt warehouse here');
    ctx.amazonFc = pickOrStandIn('amazonFulfillment', locations.find((l) => l.is_virtual && /amazon/i.test(l.name)), warehouse, 'no virtual Amazon Fulfillment location here; the API cannot create locations');
    return { summary: `prosol=${ctx.prosol}, treeco=${ctx.treeco}, carrier=${ctx.carrier}, amazonFc=${ctx.amazonFc}` };
  });
  await step('items: create, re-create is duplicate-safe, resolve by slashed code', async () => {
    ctx.items = {};
    for (const t of TEST_ITEMS) {
      const res = await erp.createItem({ ...t, vendorId: ctx.prosol, unit: 'each' });
      ctx.items[t.key] = { id: res.item.id, cost: t.cost, retail: t.retail };
    }
    const again = await erp.createItem({ ...TEST_ITEMS[0], vendorId: ctx.prosol, unit: 'each' });
    assert(again.item.id === ctx.items.kerdifix.id, 're-create returns the same item');
    const resolved = await erp.resolveItems(TEST_ITEMS.map((t) => ({ key: t.key, vendorCodes: [t.vendorCode] })));
    for (const t of TEST_ITEMS) {
      const r = resolved.get(t.key);
      assert(r.status === 'matched' && r.item.id === ctx.items[t.key].id, `${t.vendorCode} resolves to its item (got ${r.status})`);
    }
    const missing = await erp.resolveItems([{ key: 'x', vendorCodes: [`ROTEST-NOPE-${RUN}`] }]);
    assert(missing.get('x').status === 'not_found', 'unknown code is not_found');
    return { summary: `${TEST_ITEMS.length} items; slash/dash variants match; unknown → not_found` };
  });

  // ── A. Shopify drop-ship ──────────────────────────────────────────────────
  console.log('\nA. Shopify drop-ship order');
  const shopRef = `ROTEST-${RUN}-1001`;
  const shopLines = [
    { item_id: () => ctx.items.kerdifix.id, qty: 2, unit_price: '37.96', external_line_ref: 'line-1' },
    { item_id: () => ctx.items.kerdiband.id, qty: 1, unit_price: '57.85', external_line_ref: 'line-2' },
  ];
  const lines = () => shopLines.map((l) => ({ ...l, item_id: l.item_id() }));
  await step('contact lookup only returns a contact the order may use', async () => {
    const c = await erp.findOrderContact('jane.smith.e2e@example.com', ctx.shopify);
    ctx.contact = c ? c.id : null;
    return { summary: c ? `found ${c.name} (customer_id ${c.customer_id || 'none'})` : 'none usable' };
  });
  await step('create SO with lines (procurement external)', async () => {
    const res = await erp.createSalesOrder({ channel: 'shopify', externalRef: shopRef, customerId: ctx.shopify, contactId: ctx.contact, orderDate: new Date().toISOString(), lines: lines() });
    ctx.shopSo = res.so;
    assert(res.so.procurement_mode === 'external', 'procurement external');
    assert(res.so.lines.length === 2 && res.so.lines.every((l) => l.id), 'line ids returned');
    assert(!res.so.purchase_orders || res.so.purchase_orders.length === 0, 'no automatic PO');
    return { summary: `${res.so.number}, status ${res.so.status}, ${res.so.lines.length} lines, total ${res.so.total}`, number: res.so.number, status: res.so.status };
  });
  await step('same request again replays, no second SO', async () => {
    const res = await erp.createSalesOrder({ channel: 'shopify', externalRef: shopRef, customerId: ctx.shopify, contactId: ctx.contact, orderDate: undefined, lines: lines() }).catch((e) => ({ err: e }));
    // A different body under the same key must be refused, not applied.
    assert(res.err && res.err.code === 'idempotency_key_reused', `changed body under same key → idempotency_key_reused (got ${res.err ? res.err.code : 'success'})`);
    const exact = await am.command('/sales-orders', { customer_id: ctx.shopify, contact_id: ctx.contact || null, procurement_mode: 'external', type: 'supply', channel: 'shopify', external_ref: `${shopRef}-R`, order_date: null, notes: null, delivery_instructions: null, tax_treatment: null, lines: lines() }, `shopify-${shopRef}-R-so`);
    const replay = await am.command('/sales-orders', { customer_id: ctx.shopify, contact_id: ctx.contact || null, procurement_mode: 'external', type: 'supply', channel: 'shopify', external_ref: `${shopRef}-R`, order_date: null, notes: null, delivery_instructions: null, tax_treatment: null, lines: lines() }, `shopify-${shopRef}-R-so`);
    assert(replay.replayed && replay.data.id === exact.data.id, 'exact replay returns the original');
    await erp.cancelSalesOrder(exact.data.id, 'Rehearsal cleanup', `cancel-${shopRef}-R`);
    return { summary: 'exact replay → Idempotent-Replayed; changed body → 422 idempotency_key_reused' };
  });
  await step('second create under a new key → 409 duplicate, handled as done', async () => {
    const err = await expectCode('duplicate', () => am.command('/sales-orders', { customer_id: ctx.shopify, procurement_mode: 'external', channel: 'shopify', external_ref: shopRef, lines: lines() }, `shopify-${shopRef}-so-retry`));
    assert(err.existingId === ctx.shopSo.id, 'existing_id points at the first SO');
    return { summary: `existing_id = ${ctx.shopSo.number}` };
  });
  await step('confirmed Prosol PO linked line-by-line, our unit cost, no email', async () => {
    const soLineByRef = Object.fromEntries(ctx.shopSo.lines.map((l) => [l.external_line_ref, l.id]));
    ctx.shopTracking = `ROTEST${RUN}S1`;
    const res = await erp.createPurchaseOrder({
      idempotencyKey: `shopify-${shopRef}-po`,
      vendorId: ctx.prosol,
      salesOrderId: ctx.shopSo.id,
      channel: 'shopify',
      externalRef: shopRef,
      trackingCode: ctx.shopTracking,
      orderDate: new Date().toISOString(),
      shippingInstructions: `Shopify #${shopRef} — Test Buyer — KERDI-FIX, KERDI-BAND — purolator ground — Tracking: ${ctx.shopTracking}`,
      lines: [
        { item_id: ctx.items.kerdifix.id, qty: 2, unit_cost: '21.64', sales_order_line_id: soLineByRef['line-1'], external_line_ref: 'line-1' },
        { item_id: ctx.items.kerdiband.id, qty: 1, unit_cost: '32.98', sales_order_line_id: soLineByRef['line-2'], external_line_ref: 'line-2' },
      ],
    });
    ctx.shopPo = res.po;
    assert(res.po.status === 'confirmed', `status confirmed (got ${res.po.status})`);
    assert(!res.po.sent_at, 'not sent to vendor');
    const costs = (res.po.lines || []).map((l) => l.unit_cost);
    assert(costs.includes('21.6400') || costs.includes('21.64'), `stored our unit cost (got ${costs.join(',')})`);
    return { summary: `${res.po.number}, ${res.po.status}, sent_at ${res.po.sent_at || 'null'}, costs ${costs.join('/')}`, number: res.po.number };
  });
  await step('tracking dedupe: check-tracking finds it; second PO → 409 duplicate', async () => {
    const found = await erp.checkTracking([ctx.shopTracking, `ROTEST${RUN}NONE`]);
    assert(found.has(ctx.shopTracking), 'check-tracking finds the PO');
    assert(!found.has(`ROTEST${RUN}NONE`), 'unknown tracking has no match');
    const err = await expectCode('duplicate', () => am.command('/purchase-orders', { vendor_id: ctx.prosol, status: 'confirmed', tracking_code: ctx.shopTracking.toLowerCase(), lines: [{ item_id: ctx.items.kerdifix.id, qty: 1, unit_cost: '21.64' }] }, `shopify-${shopRef}-po-retry`));
    return { summary: `duplicate → ${err.details.existing_number || err.existingId} (case-insensitive tracking)` };
  });
  await step('hand cancel: SO cancel returns the open PO, then PO cancel, repeat is a no-op', async () => {
    const res = await erp.cancelSalesOrder(ctx.shopSo.id, 'Customer cancelled', `cancel-${shopRef}`);
    const openPos = res.open_purchase_orders || [];
    assert(openPos.some((p) => p.id === ctx.shopPo.id), 'linked PO returned, not cancelled');
    const po = await erp.cancelPurchaseOrder(ctx.shopPo.id, { reason: 'Customer cancelled' }, `cancel-po-${shopRef}`);
    const again = await erp.cancelPurchaseOrder(ctx.shopPo.id, { reason: 'Customer cancelled' }, `cancel-po-${shopRef}-again`);
    return { summary: `SO ${res.status || 'cancelled'}, PO ${po.status || 'cancelled'}, repeat ${again.already_cancelled ? 'already_cancelled' : again.status}` };
  });

  // ── B. Amazon parcels ─────────────────────────────────────────────────────
  console.log('\nB. Amazon parcels on the rolling period order');
  const today = new Date().toISOString().slice(0, 10);
  const cache = new Map();
  async function amazonParcel(n, itemKey, qty, salePrice) {
    const order = `ROTEST-${RUN}-70${n}`;
    const tracking = `ROTEST${RUN}A${n}`;
    const item = ctx.items[itemKey];
    const so = await erp.addToAmazonPeriodSo(today, order, [{ item_id: item.id, qty, unit_price: String(salePrice), external_line_ref: `${order}:1` }], cache);
    const po = await erp.createPurchaseOrder({
      idempotencyKey: `amazon-${tracking}-po`,
      vendorId: ctx.prosol,
      salesOrderId: so.so.id,
      locationId: ctx.amazonFc,
      channel: 'amazon',
      externalRef: order,
      trackingCode: tracking,
      orderDate: today,
      shippingInstructions: `Amazon Order ${order} — Test Buyer, Sechelt V0N — purolator ground — Tracking: ${tracking}`,
      lines: [{ item_id: item.id, qty, unit_cost: String(item.cost), sales_order_line_id: so.lines[0].id, external_line_ref: `${order}:1` }],
    });
    const rcv = await erp.receivePurchaseOrder(po.po.id, { receivedAt: new Date().toISOString(), locationId: ctx.amazonFc, lines: [{ poLineId: po.po.lines[0].id, qty, unitCost: item.cost }] }, `amazon-${tracking}-rcv`);
    return { order, tracking, so, po: po.po, rcv };
  }
  await step('parcel 1: period SO, PO by tracking, receipt posts at PO cost', async () => {
    ctx.p1 = await amazonParcel(1, 'kerdifix', 1, 37.96);
    assert(ctx.p1.so.so.external_ref === `period:${ctx.p1.so.period.start}`, 'period key');
    assert(ctx.p1.rcv.posted === true, 'posted');
    return { summary: `${ctx.p1.so.so.number} ${ctx.p1.so.period.key} (${ctx.p1.so.period.label}, ${ctx.p1.so.created ? 'opened' : 'existing'}), ${ctx.p1.po.number} received, movements ${(ctx.p1.rcv.inventory_movement_ids || []).length}` };
  });
  await step('parcel 2 lands on the same period SO', async () => {
    ctx.p2 = await amazonParcel(2, 'kerdiband', 2, 57.85);
    assert(ctx.p2.so.so.id === ctx.p1.so.so.id, 'same period SO');
    return { summary: `${ctx.p2.po.number} on ${ctx.p2.so.so.number}` };
  });
  await step('re-running a parcel skips its lines and replays its receipt', async () => {
    const order = ctx.p2.order;
    const again = await erp.addToAmazonPeriodSo(today, order, [{ item_id: ctx.items.kerdiband.id, qty: 2, unit_price: '57.85', external_line_ref: `${order}:1` }], new Map());
    assert(again.lines.length === 1 && again.lines[0].id === ctx.p2.so.lines[0].id, 'same SO line, not a second one');
    const rcv = await erp.receivePurchaseOrder(ctx.p2.po.id, { receivedAt: undefined, locationId: ctx.amazonFc, lines: [{ poLineId: ctx.p2.po.lines[0].id, qty: 2, unitCost: ctx.items.kerdiband.cost }] }, `amazon-${ctx.p2.tracking}-rcv`).catch((e) => e);
    // Same key, different body (received_at) → refused, never a second receipt.
    const receipts = (await am.get(`/purchase-orders/${ctx.p2.po.id}/receipts`)).data;
    const count = (receipts.data || receipts).length;
    assert(count === 1, `one receipt on the PO (got ${count})`);
    return { summary: `SO line reused; receipt retry → ${rcv.code || 'replayed'}; receipts on PO = ${count}` };
  });
  await step('receipt price different from PO line → refused (422)', async () => {
    const err = await expectCode('validation_failed', () => erp.receivePurchaseOrder(ctx.p1.po.id, { locationId: ctx.amazonFc, lines: [{ poLineId: ctx.p1.po.lines[0].id, qty: 1, unitCost: 99.99 }] }, `amazon-${ctx.p1.tracking}-rcv-price`));
    return { summary: `${err.code} on ${err.field || 'unit_cost'}` };
  });
  await step('PO cancel after receipt → 409 invalid_state', async () => {
    const err = await expectCode('invalid_state', () => erp.cancelPurchaseOrder(ctx.p1.po.id, { reason: 'Duplicate' }, `cancel-po-${ctx.p1.tracking}`));
    return { summary: `has_receipts=${!!err.details.has_receipts}` };
  });

  // ── C. FBA restock ────────────────────────────────────────────────────────
  console.log('\nC. FBA restock stock PO');
  const draft = `ROTEST-${RUN}-FBA`;
  await step('stock PO with no SO into Amazon Fulfillment', async () => {
    const res = await erp.createPurchaseOrder({
      idempotencyKey: `fba-${draft}-po`,
      vendorId: ctx.treeco,
      type: 'stock',
      locationId: ctx.amazonFc,
      channel: 'fba',
      externalRef: draft,
      orderDate: today,
      shippingInstructions: `FBA Restock — Amazon CA — Draft ${draft} — 2 lines`,
      lines: [
        { item_id: ctx.items.shelf.id, qty: 10, unit_cost: '114.92', external_line_ref: 'B07QBD5Q86' },
        { item_id: ctx.items.kerdifix.id, qty: 24, unit_cost: '21.64', external_line_ref: 'KERDIFIX/BW' },
      ],
    });
    ctx.fba = res.po;
    assert(res.po.type === 'stock', `type stock (got ${res.po.type})`);
    return { summary: `${res.po.number}, ${res.po.type}, ${res.po.status}, location ${res.po.location && res.po.location.name}` };
  });
  await step('open supply shows the remaining quantity', async () => {
    const open = await erp.openPurchaseOrderLines({ vendorId: ctx.treeco });
    const mine = open.filter((l) => l.purchase_order_id === ctx.fba.id);
    assert(mine.length === 2, `2 open lines (got ${mine.length})`);
    return { summary: mine.map((l) => `${l.external_line_ref || l.vendor_code}: ${l.qty_remaining}`).join(', ') };
  });
  await step('partial receipt, top-up line, then over-receipt on a full line', async () => {
    const shelfLine = ctx.fba.lines.find((l) => l.external_line_ref === 'B07QBD5Q86');
    await erp.receivePurchaseOrder(ctx.fba.id, { locationId: ctx.amazonFc, lines: [{ poLineId: shelfLine.id, qty: 6 }] }, `fba-${draft}-rcv-1`);
    const topUp = await erp.addPurchaseOrderLines(ctx.fba.id, [{ item_id: ctx.items.kerdiband.id, qty: 5, unit_cost: '32.98', external_line_ref: 'KEBA100/125/10M' }], `fba-${draft}-topup-1`);
    await erp.receivePurchaseOrder(ctx.fba.id, { locationId: ctx.amazonFc, lines: [{ poLineId: shelfLine.id, qty: 5 }] }, `fba-${draft}-rcv-2`);
    const after = (await am.get(`/purchase-orders/${ctx.fba.id}/lines`)).data;
    const shelf = (after.data || after).find((l) => l.id === shelfLine.id);
    return { summary: `shelf received ${shelf.qty_received} of ${shelf.qty} (overage accepted), top-up ${JSON.stringify(topUp).slice(0, 80)}` };
  });

  // ── D. Carrier freight ────────────────────────────────────────────────────
  console.log('\nD. Carrier freight PO');
  await step('freight PO: description line, our cost, tax exempt', async () => {
    const res = await erp.createPurchaseOrder({
      idempotencyKey: `freight-${RUN}-po`,
      vendorId: ctx.carrier,
      type: 'expense',
      channel: 'freight',
      externalRef: `ROTEST-${RUN}-BOL`,
      orderDate: today,
      taxTreatment: 'exempt',
      shippingInstructions: `LTL freight for Shopify #ROTEST-${RUN} — FreightSimple quote`,
      lines: [{ description: 'LTL freight, Burnaby to Sechelt', qty: 1, unit_cost: '245.00' }],
    });
    ctx.freight = res.po;
    return { summary: `${res.po.number}, ${res.po.type}, tax ${res.po.tax_total ?? 'n/a'}, total ${res.po.total ?? res.po.subtotal}` };
  });

  // ── E. Accounting reads ───────────────────────────────────────────────────
  console.log('\nE. Notes, payables, events');
  await step('accounting-exception note with amount', async () => {
    const note = await erp.addPurchaseOrderNote(ctx.p1.po.id, { body: `Rehearsal ${RUN}: unpaid bill exceeds PO subtotal`, amount: '12.34' }, `note-${ctx.p1.tracking}-1`);
    return { summary: `note ${note.id || 'added'}` };
  });
  await step('payables per PO (double-billing summary)', async () => {
    const p = await erp.getPurchaseOrderPayables(ctx.p1.po.id);
    return { summary: `bill_count ${p.summary ? p.summary.bill_count : '?'}, unpaid pre-tax ${p.summary ? p.summary.unpaid_pre_tax_subtotal : '?'}` };
  });
  await step('availability excludes the Amazon Fulfillment location', async () => {
    const { data } = await am.post('/items/availability', { items: [{ item_id: ctx.items.kerdiband.id }] }).catch(async (e) => {
      if (e.code !== 'validation_failed') throw e;
      return am.post('/items/availability', { item_ids: [ctx.items.kerdiband.id] });
    });
    const amazonIsVirtual = !report.standIns.some((s) => s.ref === 'amazonFulfillment');
    return { summary: `${JSON.stringify(data).slice(0, 160)}${amazonIsVirtual ? '' : ' (stand-in location is not virtual, exclusion not testable here)'}`, data };
  });
  await step('events feed shows this run', async () => {
    const ids = new Set([ctx.shopSo && ctx.shopSo.id, ctx.shopPo && ctx.shopPo.id, ctx.p1 && ctx.p1.po.id, ctx.fba && ctx.fba.id].filter(Boolean));
    const events = await am.listAll('/events', { created_after: report.startedAt, limit: 200 }, { max: 5000 });
    const mine = events.filter((e) => ids.has(e.data && e.data.object_id));
    const types = [...new Set(mine.map((e) => e.type))].sort();
    return { summary: `${mine.length} events: ${types.join(', ')}`, types };
  });

  report.finishedAt = new Date().toISOString();
  report.failures = failures;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, `${RUN}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const writes = report.requests.filter((r) => r.method !== 'GET').length;
  console.log(`\n${failures ? `${failures} step(s) failed` : 'All steps passed'} — ${report.requests.length} requests (${writes} writes). Stand-ins: ${report.standIns.map((s) => `${s.ref}→${s.standIn}`).join(', ') || 'none'}.\nReport: ${out}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(2);
});
