/**
 * Pipeline orchestrator — runs the five ops phases end-to-end:
 *   stage → buy → pos → email → pickups
 *
 * Each phase:
 *  - Reads idempotency state from lib/ops-state (skip what's done today)
 *  - Streams progress via onProgress callback
 *  - Logs to audit
 *  - On failure: decides tier (halt vs. skip-and-continue) per the spec in
 *    ~/.claude/plans/dapper-spinning-pike.md
 *
 * Callers: /api/pipeline/run (SSE), /api/pipeline/run-phase (single phase),
 * or any node-cron job.
 */

const path = require('path');
const audit = require('./audit');
const opsState = require('./ops-state');
const telegram = require('./telegram');
const { runOrders } = require('../scripts/shipstation/run-orders');
const { v1Request, fetchShippedShipments, downloadLabelPdf } = require('./shipstation-v2');
const { createAmazonPOs } = require('./amazon-po');
const { scanStaleShipments } = require('./stale-tracker');
const { bookPickupForBucket } = require('./pickups');
const { generatePackingSlipPdf } = require('./packing-slip');
const { sendWarehouseEmail } = require('./emailer');
const { planPackages } = require('./package-split');

const UI_URL = 'http://localhost:3456';

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function nextBusinessDay(fromDate) {
  const d = fromDate ? new Date(fromDate) : new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function progress(onProgress, event) {
  try { onProgress && onProgress(event); } catch {}
}

// Retry an async op with backoff; shouldRetry(err) decides. Returns last result.
async function withRetry(fn, { tries = 3, delaysMs = [30000, 60000, 120000], shouldRetry = () => true, onAttempt } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fn(i);
      return res;
    } catch (err) {
      lastErr = err;
      if (onAttempt) onAttempt(i, err);
      if (i === tries - 1 || !shouldRetry(err)) throw err;
      await sleep(delaysMs[Math.min(i, delaysMs.length - 1)]);
    }
  }
  throw lastErr;
}

// ── Phase 1: STAGE ───────────────────────────────────────────────────────────

async function phaseStage({ state, dryRun, onProgress }) {
  progress(onProgress, { phase: 'stage', type: 'status', message: 'Staging orders...' });

  const result = await runOrders({
    dryRun,
    onProgress: (ev) => progress(onProgress, { phase: 'stage', ...ev }),
  });

  opsState.recordStageRun(state, {
    count: result.assignments.length,
    errors: result.errors.length,
  });

  audit.log({
    action: 'pipeline-stage', dryRun,
    success: result.errors.length === 0,
    assignmentCount: result.assignments.length,
    manualReviewCount: result.manualReview.length,
    errorCount: result.errors.length,
  });

  return {
    phase: 'stage',
    halted: false,
    assignments: result.assignments,
    manualReview: result.manualReview,
    errors: result.errors,
    summary: result.summary,
  };
}

// ── Phase 2: BUY LABELS ──────────────────────────────────────────────────────

function isShipToError(errMsg) {
  return /request\.shipTo/i.test(String(errMsg || ''));
}

// Build the ShipFrom block for /shipments/createlabel (needed when we bypass
// /orders/createlabelfororder for multi-package). Pulled from the location map.
function shipFromForWarehouseId(warehouseId) {
  const LOCATION_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'));
  const loc = Object.values(LOCATION_MAP).find((l) => String(l.shipstation_warehouse_id) === String(warehouseId));
  if (!loc) return null;
  return {
    name: `${loc.vendor || 'Prosol'} ${loc.city}`,
    company: loc.vendor || 'Prosol Inc.',
    street1: loc.address,
    city: loc.city,
    state: loc.province,
    postalCode: String(loc.postal_code || '').replace(/\s/g, ''),
    country: 'CA',
    phone: (Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone) || '',
  };
}

async function buyOneLabel({ assignment }) {
  // Decide the physical package plan from items + sku-map tags. Returns >=1 packages.
  const packages = planPackages(assignment.items || [], assignment.weight);
  const shipDate = new Date().toISOString().slice(0, 10);

  // Fast path: single package → /orders/createlabelfororder (unchanged behavior).
  if (packages.length === 1) {
    const payload = {
      orderId: assignment.orderId,
      carrierCode: assignment.carrierCode,
      serviceCode: assignment.serviceCode,
      packageCode: assignment.packageCode || 'package',
      confirmation: 'none',
      shipDate,
      weight: assignment.weight || packages[0].totalWeight || { value: 1, units: 'pounds' },
    };
    const res = await v1Request('POST', '/orders/createlabelfororder', payload);
    if (res.status !== 200) {
      const err = new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      err.httpStatus = res.status;
      err.body = res.body;
      throw err;
    }
    const data = JSON.parse(res.body);
    return {
      shipmentId: data.shipmentId,
      trackingNumber: data.trackingNumber,
      labelCost: data.shipmentCost,
      costWarning: assignment.shipmentCost && data.shipmentCost > assignment.shipmentCost * 1.5,
      packages: [{
        shipmentId: data.shipmentId,
        trackingNumber: data.trackingNumber,
        labelCost: data.shipmentCost,
        weight: payload.weight,
        shape: packages[0].shape,
        items: packages[0].items,
      }],
    };
  }

  // Multi-package path: order has a roll/sheet/solo split. Call
  // /shipments/createlabel per package, linked back to the SS order via orderId.
  const orderRes = await v1Request('GET', `/orders/${assignment.orderId}`);
  if (orderRes.status !== 200) throw new Error(`GET /orders/${assignment.orderId} failed: ${orderRes.status}`);
  const order = JSON.parse(orderRes.body);
  const shipFrom = shipFromForWarehouseId(assignment.warehouseId);
  if (!shipFrom) throw new Error(`Cannot resolve shipFrom — unknown warehouseId ${assignment.warehouseId}`);

  const bought = [];
  let totalCost = 0;
  try {
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      const payload = {
        orderId: assignment.orderId,
        carrierCode: assignment.carrierCode,
        serviceCode: assignment.serviceCode,
        packageCode: assignment.packageCode || 'package',
        confirmation: 'none',
        shipDate,
        weight: pkg.totalWeight,
        shipFrom,
        shipTo: order.shipTo,
        testLabel: false,
      };
      const res = await v1Request('POST', '/shipments/createlabel', payload);
      if (res.status !== 200) {
        const err = new Error(`HTTP ${res.status} on pkg ${i + 1}/${packages.length}: ${res.body.slice(0, 200)}`);
        err.httpStatus = res.status;
        err.body = res.body;
        throw err;
      }
      const data = JSON.parse(res.body);
      bought.push({
        shipmentId: data.shipmentId,
        trackingNumber: data.trackingNumber,
        labelCost: data.shipmentCost,
        weight: pkg.totalWeight,
        shape: pkg.shape,
        items: pkg.items,
      });
      totalCost += Number(data.shipmentCost) || 0;
    }
  } catch (err) {
    // Partial failure: void whatever we already bought so the order isn't stuck
    // half-shipped and we don't eat orphan label charges. Then rethrow.
    for (const b of bought) {
      try { await v1Request('POST', '/shipments/voidlabel', { shipmentId: b.shipmentId }); } catch {}
    }
    err.message = `${err.message} (voided ${bought.length} partial label(s))`;
    throw err;
  }

  return {
    shipmentId: bought[0].shipmentId,
    trackingNumber: bought[0].trackingNumber,
    labelCost: Number(totalCost.toFixed(2)),
    costWarning: assignment.shipmentCost && totalCost > assignment.shipmentCost * 1.5,
    packages: bought,
  };
}

async function phaseBuy({ state, assignments, onProgress }) {
  const results = { phase: 'buy', halted: false, bought: [], skipped: [], failed: [] };
  if (!assignments || !assignments.length) {
    progress(onProgress, { phase: 'buy', type: 'status', message: 'No staged orders — skipping.' });
    return results;
  }

  progress(onProgress, { phase: 'buy', type: 'status', message: `Buying ${assignments.length} label(s)...` });

  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];
    if (opsState.alreadyBought(state, a.orderId)) {
      const existing = state.phases.buy.labels[String(a.orderId)];
      results.skipped.push({ orderId: a.orderId, orderNumber: a.orderNumber, reason: 'already bought today', shipmentId: existing.shipmentId, trackingNumber: existing.trackingNumber });
      progress(onProgress, { phase: 'buy', type: 'skip', orderNumber: a.orderNumber, message: `skip ${a.orderNumber} (already bought today)` });
      continue;
    }

    try {
      const bought = await withRetry(() => buyOneLabel({ assignment: a }), {
        tries: 3,
        delaysMs: [30000, 60000, 120000],
        shouldRetry: (err) => isShipToError(err?.body),
        onAttempt: (idx, err) => {
          if (isShipToError(err?.body)) {
            progress(onProgress, { phase: 'buy', type: 'retry', orderNumber: a.orderNumber, attempt: idx + 1, message: `shipTo error on ${a.orderNumber}, retry ${idx + 1}/3` });
          }
        },
      });
      opsState.recordLabelBought(state, {
        orderId: a.orderId,
        orderNumber: a.orderNumber,
        carrierCode: a.carrierCode,
        serviceCode: a.serviceCode,
        estimatedCost: a.shipmentCost,
        warehouseId: a.warehouseId,
        ...bought,
      });
      results.bought.push({ orderId: a.orderId, orderNumber: a.orderNumber, ...bought });
      audit.log({
        action: 'pipeline-buy-label',
        orderId: a.orderId,
        orderNumber: a.orderNumber,
        carrierCode: a.carrierCode,
        serviceCode: a.serviceCode,
        estimatedCost: a.shipmentCost,
        warehouseId: a.warehouseId,
        success: true,
        ...bought,
      });
      const pkgCount = Array.isArray(bought.packages) ? bought.packages.length : 1;
      const msg = pkgCount > 1
        ? `✓ ${a.orderNumber} → ${pkgCount} pkgs, ${bought.packages.map((p) => p.trackingNumber).join(' + ')} ($${bought.labelCost})`
        : `✓ ${a.orderNumber} → ${bought.trackingNumber} ($${bought.labelCost})`;
      progress(onProgress, { phase: 'buy', type: 'bought', orderNumber: a.orderNumber, trackingNumber: bought.trackingNumber, labelCost: bought.labelCost, packages: bought.packages, message: msg });
    } catch (err) {
      results.failed.push({ orderId: a.orderId, orderNumber: a.orderNumber, error: err.message });
      opsState.recordError(state, { phase: 'buy', reason: err.message, context: { orderId: a.orderId, orderNumber: a.orderNumber } });
      audit.log({ action: 'pipeline-buy-label', orderId: a.orderId, success: false, error: err.message });
      progress(onProgress, { phase: 'buy', type: 'error', orderNumber: a.orderNumber, error: err.message, message: `✗ ${a.orderNumber}: ${err.message}` });
    }

    // 4s pause between label purchases (polite to ShipStation, mirrors UI)
    if (i < assignments.length - 1) await sleep(4000);
  }
  return results;
}

// ── Phase 3: CREATE POs ──────────────────────────────────────────────────────

async function phasePos({ state, onProgress }) {
  progress(onProgress, { phase: 'pos', type: 'status', message: 'Creating Amazon POs...' });

  const result = await createAmazonPOs({
    days: 2,
    onProgress: (ev) => progress(onProgress, { phase: 'pos', ...ev }),
  });

  for (const o of (result.orders || [])) {
    if (o.poNumber && o.trackingNumber) {
      opsState.recordPo(state, { trackingNumber: o.trackingNumber, poNumber: o.poNumber, poId: o.poId });
    }
  }

  audit.log({
    action: 'pipeline-pos',
    success: result.errors.length === 0,
    soName: result.soName,
    soCreated: result.soCreated,
    posCreated: result.orders.filter((o) => o.status === 'created').length,
    posSkipped: result.orders.filter((o) => o.status === 'skipped').length,
    posErrored: result.orders.filter((o) => o.status === 'error' || o.status === 'partial').length,
    errors: result.errors,
  });

  const halted = result.errors.some((e) => e.step === 'sf-login' || e.step === 'amazon-so');
  return { phase: 'pos', halted, soName: result.soName, soCreated: result.soCreated, orders: result.orders, errors: result.errors };
}

// ── Phase 4: EMAIL KAITLYN ───────────────────────────────────────────────────

async function phaseEmail({ state, onProgress }) {
  const results = { phase: 'email', halted: false, sent: [], skipped: [], failed: [] };

  // Read bought labels + POs from ops-state so the phase runs correctly standalone
  // (e.g. from the 2:00 PM email-only cron tick).
  const boughtLabels = Object.entries(state.phases.buy.labels || {})
    .map(([orderId, info]) => ({ orderId: Number(orderId), ...info }));
  const posByTracking = state.phases.pos.byTracking || {};

  // Need the ShipStation order for each label (warehouseName, shipTo, items)
  // Fetch from V1 by orderId
  const orderRecords = [];
  for (const b of boughtLabels) {
    try {
      const r = await v1Request('GET', `/orders/${b.orderId}`);
      if (r.status === 200) orderRecords.push({ b, order: JSON.parse(r.body) });
    } catch {}
  }

  // Group by warehouseName (matching the existing emailer convention)
  const whMap = {};
  const LOCATION_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'));
  const SKU_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'));
  const SKU_MAPPINGS = SKU_MAP.mappings || {};
  const WHBY = {};
  for (const loc of Object.values(LOCATION_MAP)) {
    if (loc.shipstation_warehouse_id) WHBY[String(loc.shipstation_warehouse_id)] = loc;
  }

  // An item is "NON_PROSOL" if the sku-map classifies it that way (Perfect
  // Level Master, Bona Mega, Bona Traffic, Armstrong Shinekeeper, etc.).
  // These must never appear in Kaitlyn's email — Prosol doesn't carry them.
  const isNonProsolItem = (sku) => {
    const e = SKU_MAPPINGS[String(sku || '')];
    return e && typeof e !== 'string' && e.api_sku === 'NON_PROSOL';
  };

  // Per-warehouse recipient routing:
  //  - Prosol warehouses → Kaitlyn (emailer default)
  //  - cfc_sechelt (SECH, SS 147654) → warehouse@customfc.ca
  //  - Other non_prosol warehouses (Biyork, TORLYS, TREECO, JSON, PCW) → skip,
  //    those are separate vendors that handle their own fulfillment comms.
  //  - Unmapped warehouse → skip LOUDLY. We never default to Kaitlyn for an
  //    unknown warehouse — every Prosol warehouse must be explicitly in
  //    prosol-location-map.json. Silent default risks emailing Prosol about
  //    an order they have nothing to do with.
  const classifyRecipient = (loc) => {
    if (!loc) {
      // escalate: true → surface as a failure in the pipeline summary so Mac
      // sees "Attention: N email failure(s)" and can add the SS warehouse ID
      // to prosol-location-map.json before the next run.
      return { skip: true, escalate: true, reason: 'unmapped warehouse — add to prosol-location-map.json' };
    }
    if (loc.non_prosol === true) {
      if (loc.code === 'SECH') {
        return {
          to: process.env.WAREHOUSE_EMAIL || 'warehouse@customfc.ca',
          greeting: 'Hi team,',
        };
      }
      return { skip: true, reason: `non-Prosol vendor (${loc.vendor || loc.code})` };
    }
    return {}; // default → Kaitlyn (known Prosol warehouse)
  };

  for (const { b, order } of orderRecords) {
    const whId = String(order.advancedOptions?.warehouseId || '');
    const loc = WHBY[whId];
    const whName = loc ? `${loc.city} (${loc.code})` : `Warehouse ${whId}`;

    const recipient = classifyRecipient(loc);
    if (recipient.skip) {
      if (recipient.escalate) {
        // Unmapped warehouse — add to results.failed so the Attention line in
        // the Telegram summary flags it, and audit-log for traceability.
        results.failed.push({ warehouse: whName, error: recipient.reason, orderId: b.orderId, ssWarehouseId: whId });
        opsState.recordError(state, { phase: 'email', reason: recipient.reason, context: { warehouse: whName, ssWarehouseId: whId, orderId: b.orderId } });
        audit.log({ action: 'pipeline-email-unmapped-warehouse', ssWarehouseId: whId, orderId: b.orderId, orderNumber: order.orderNumber });
        progress(onProgress, { phase: 'email', type: 'error', warehouse: whName, error: recipient.reason, message: `✗ ${whName} (ss_id=${whId}) — ${recipient.reason}` });
      } else {
        progress(onProgress, { phase: 'email', type: 'skip', warehouse: whName, message: `skip ${whName} — ${recipient.reason}` });
      }
      continue;
    }

    // For Prosol warehouses, strip NON_PROSOL line items out of the email.
    // Sechelt (non_prosol) keeps everything — it's our own warehouse.
    const rawItems = order.items || [];
    const droppedNonProsol = loc?.non_prosol ? [] : rawItems.filter((i) => isNonProsolItem(i.sku));
    const items = loc?.non_prosol ? rawItems : rawItems.filter((i) => !isNonProsolItem(i.sku));
    // Routing anomaly: a NON_PROSOL item (Perfect Level Master, Bona Mega etc.)
    // ended up at a Prosol warehouse when it should have routed to Sechelt. We
    // dropped it from Kaitlyn's email — but we must NOT silently disappear it.
    // Record as a phase failure so the Telegram "Attention:" line flags it and
    // Mac can rescue manually (split the shipment, re-ship from Sechelt, etc.).
    if (droppedNonProsol.length) {
      const summary = droppedNonProsol.map((i) => `${i.quantity}× ${i.sku} (${i.name || '?'})`).join('; ');
      const reason = `NON_PROSOL item(s) routed to Prosol warehouse ${whName} — should have gone to Sechelt: ${summary}`;
      results.failed.push({ warehouse: whName, orderNumber: order.orderNumber, orderId: b.orderId, error: reason, droppedItems: droppedNonProsol });
      opsState.recordError(state, { phase: 'email', reason, context: { warehouse: whName, orderId: b.orderId, orderNumber: order.orderNumber, items: droppedNonProsol.map((i) => ({ sku: i.sku, quantity: i.quantity })) } });
      audit.log({ action: 'pipeline-email-nonprosol-at-prosol-wh', orderId: b.orderId, orderNumber: order.orderNumber, warehouse: whName, droppedItems: droppedNonProsol.map((i) => ({ sku: i.sku, quantity: i.quantity })) });
      progress(onProgress, { phase: 'email', type: 'error', warehouse: whName, orderNumber: order.orderNumber, error: reason, message: `⚠ ${order.orderNumber} @ ${whName}: ${summary} — dropped from Kaitlyn's email, needs manual rescue` });
    }
    if (items.length === 0) {
      const reason = rawItems.length === 0 ? 'no items' : 'all items NON_PROSOL';
      progress(onProgress, { phase: 'email', type: 'skip', warehouse: whName, message: `skip order ${order.orderNumber} — ${reason}` });
      continue;
    }

    const po = posByTracking[b.trackingNumber];
    if (!whMap[whName]) whMap[whName] = { loc, recipient, orders: [] };
    whMap[whName].orders.push({
      orderNumber: order.orderNumber,
      shipmentId: b.shipmentId,
      trackingNumber: b.trackingNumber,
      packages: Array.isArray(b.packages) ? b.packages : null,
      poNumber: po?.poNumber || null,
      carrier: (order.carrierCode || '').replace('_walleted', '').replace(/_/g, ' '),
      shipTo: order.shipTo,
      items: items.map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })),
    });
  }

  const entries = Object.entries(whMap);
  if (!entries.length) {
    progress(onProgress, { phase: 'email', type: 'status', message: 'Nothing to email.' });
    return results;
  }
  progress(onProgress, { phase: 'email', type: 'status', message: `Sending ${entries.length} warehouse email(s)...` });

  for (let i = 0; i < entries.length; i++) {
    const [warehouse, { recipient, orders: whOrders }] = entries[i];
    if (opsState.emailAlreadySent(state, warehouse)) {
      results.skipped.push({ warehouse, reason: 'already sent today' });
      progress(onProgress, { phase: 'email', type: 'skip', warehouse, message: `skip ${warehouse} (already sent today)` });
      continue;
    }

    try {
      const attachments = [];
      for (const o of whOrders) {
        // Multi-package orders have N shipmentIds under o.packages. Attach every
        // label PDF. Single-package orders fall back to the top-level shipmentId.
        const pkgShipmentIds = Array.isArray(o.packages) && o.packages.length > 1
          ? o.packages.map((p) => p.shipmentId).filter(Boolean)
          : (o.shipmentId ? [o.shipmentId] : []);
        for (let p = 0; p < pkgShipmentIds.length; p++) {
          const sid = pkgShipmentIds[p];
          try {
            const labelPdf = await downloadLabelPdf(sid);
            if (labelPdf) {
              const suffix = pkgShipmentIds.length > 1 ? `-pkg${p + 1}of${pkgShipmentIds.length}` : '';
              attachments.push({ filename: `Label-${o.orderNumber}${suffix}.pdf`, content: labelPdf });
            }
          } catch {}
        }
        if (o.poNumber) {
          try {
            const slipPdf = await generatePackingSlipPdf({
              poNumber: o.poNumber,
              date: new Date().toISOString().slice(0, 10),
              vendor: 'Prosol Inc.',
              orderNumber: o.orderNumber,
              tracking: o.trackingNumber,
              carrier: o.carrier,
              shipTo: o.shipTo,
              items: o.items || [],
            });
            if (slipPdf) attachments.push({ filename: `PackingSlip-${o.poNumber}.pdf`, content: slipPdf });
          } catch {}
        }
      }
      await sendWarehouseEmail({
        warehouse,
        orders: whOrders.map((o) => ({
          orderNumber: o.orderNumber,
          poNumber: o.poNumber || 'N/A',
          shipTo: o.shipTo ? `${o.shipTo.name}, ${o.shipTo.city} ${o.shipTo.postalCode}` : 'N/A',
          carrier: o.carrier,
          tracking: o.trackingNumber,
        })),
        attachments,
        ...recipient,
      });
      opsState.recordEmailSent(state, { warehouseKey: warehouse, orderCount: whOrders.length });
      results.sent.push({ warehouse, orderCount: whOrders.length });
      audit.log({ action: 'pipeline-email-prosol', warehouse, orderCount: whOrders.length, success: true });
      progress(onProgress, { phase: 'email', type: 'sent', warehouse, message: `✓ emailed ${warehouse} (${whOrders.length} orders)` });
    } catch (err) {
      results.failed.push({ warehouse, error: err.message });
      opsState.recordError(state, { phase: 'email', reason: err.message, context: { warehouse } });
      audit.log({ action: 'pipeline-email-prosol', warehouse, success: false, error: err.message });
      progress(onProgress, { phase: 'email', type: 'error', warehouse, error: err.message, message: `✗ ${warehouse}: ${err.message}` });
      // SMTP auth / quarantine should halt the phase (Tier 1)
      if (/auth|quarantine|5\.7|invalid login/i.test(err.message)) {
        results.halted = true;
        break;
      }
    }

    // 60s gap between warehouse emails (per emailer.js comment — March 20 quarantine)
    if (i < entries.length - 1) await sleep(60000);
  }
  return results;
}

// ── Phase 5: PICKUPS ─────────────────────────────────────────────────────────

async function phasePickups({ state, onProgress }) {
  const results = { phase: 'pickups', halted: false, booked: [], skipped: [], failed: [] };
  progress(onProgress, { phase: 'pickups', type: 'status', message: 'Scanning for hanging shipments...' });

  const scan = await scanStaleShipments({ days: 14 });
  const hanging = (scan.shipments || []).filter((s) => s.movement === 'hanging' && (s.suggestedAction === 'book' || s.suggestedAction === 'rebook'));
  progress(onProgress, { phase: 'pickups', type: 'status', message: `${hanging.length} hanging shipment(s) need pickup action.` });

  // Group by (warehouseId, carrierCode)
  const groups = {};
  for (const s of hanging) {
    const carrier = (s.carrierCode || '').replace(/_walleted$/, '');
    const key = `${s.warehouseId}::${carrier}`;
    if (!groups[key]) groups[key] = { key, warehouseId: s.warehouseId, warehouseName: s.warehouseName, carrier, shipments: [] };
    groups[key].shipments.push(s);
  }

  const pickupDate = nextBusinessDay();

  for (const g of Object.values(groups)) {
    const stateKey = `${g.key}::${pickupDate}`;
    if (opsState.pickupAlreadyBooked(state, stateKey)) {
      results.skipped.push({ group: g.key, reason: 'already booked today' });
      continue;
    }

    const shipmentIds = g.shipments.map((s) => s.shipmentId);
    try {
      const r = await bookPickupForBucket({
        warehouseId: g.warehouseId,
        carrier: g.carrier,
        pickupDate,
        shipmentIds,
      });
      if (r.success) {
        opsState.recordPickup(state, { groupKey: stateKey, pickupId: r.pickupId, confirmation: r.confirmation, labelCount: shipmentIds.length, pickupDate });
        results.booked.push({ group: g.key, warehouseName: g.warehouseName, carrier: g.carrier, labelCount: shipmentIds.length, pickupId: r.pickupId, confirmation: r.confirmation });
        audit.log({ action: 'pipeline-pickup', groupKey: stateKey, success: true, pickupId: r.pickupId, labelCount: shipmentIds.length });
        progress(onProgress, { phase: 'pickups', type: 'booked', group: g.key, message: `✓ ${g.warehouseName} ${g.carrier} (${shipmentIds.length}) → ${r.confirmation || r.pickupId}` });
      } else {
        // Prefer the parsed V2 error message over the generic HTTP code.
        // "HTTP 400" by itself is useless; "Cannot schedule pickup. Label
        // has been voided." is actionable.
        const humanMsg = r.errorMessage || r.error || (r.body || '').toString().slice(0, 300);
        const rawBody = (r.body || '').toString();
        // "already completed" family — pickup exists at carrier side but V2 won't re-attach labels
        if (/already been completed|already scheduled/i.test(rawBody) || r.errorCode === 'pickup_already_completed') {
          results.failed.push({
            group: g.key, warehouseName: g.warehouseName, carrier: g.carrier,
            error: 'UPS/carrier marked prior pickup completed; needs manual intervention or piggyback',
            errorCode: r.errorCode || null,
            httpBody: rawBody.slice(0, 300),
          });
          progress(onProgress, { phase: 'pickups', type: 'stuck', group: g.key, message: `⚠ ${g.warehouseName} ${g.carrier}: stuck — ${humanMsg.slice(0, 120)}` });
        } else {
          results.failed.push({
            group: g.key, warehouseName: g.warehouseName, carrier: g.carrier,
            error: humanMsg,
            errorCode: r.errorCode || null,
            errorLabelId: r.errorLabelId || null,
          });
          progress(onProgress, { phase: 'pickups', type: 'error', group: g.key, message: `✗ ${g.warehouseName} ${g.carrier}: ${humanMsg.slice(0, 120)}` });
        }
        opsState.recordError(state, { phase: 'pickups', reason: humanMsg, context: { group: g.key, errorCode: r.errorCode || null, errorLabelId: r.errorLabelId || null } });
        audit.log({
          action: 'pipeline-pickup',
          groupKey: stateKey,
          success: false,
          error: humanMsg,
          errorCode: r.errorCode || null,
          errorLabelId: r.errorLabelId || null,
          httpStatus: r.error || null,
          body: rawBody.slice(0, 500),
        });
      }
    } catch (err) {
      results.failed.push({ group: g.key, error: err.message });
      opsState.recordError(state, { phase: 'pickups', reason: err.message, context: { group: g.key } });
    }

    await sleep(500);
  }
  return results;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

const PHASES = ['stage', 'buy', 'pos', 'email', 'pickups'];

async function runPipeline({ phases = PHASES, dryRun = false, onProgress = () => {}, source = 'manual' } = {}) {
  if (opsState.isPaused()) {
    await telegram.notify('attn', 'Pipeline attempted while paused', `Source: ${source}\nNo phases ran.\nResume with /resume or remove data/ops-paused.flag.`);
    return { halted: 'paused', phases: {}, errors: [] };
  }
  if (dryRun) phases = phases.filter((p) => p === 'stage'); // dry-run only stages

  const state = opsState.load();
  const result = { startedAt: new Date().toISOString(), source, dryRun, phases: {}, halted: false, errors: [] };

  audit.log({ action: 'pipeline-start', source, dryRun, phases });
  progress(onProgress, { type: 'pipeline-start', message: `Starting pipeline (${source}, phases: ${phases.join(' → ')})` });

  try {
    // Phase 1: stage
    if (phases.includes('stage')) {
      const stage = await phaseStage({ state, dryRun, onProgress });
      result.phases.stage = stage;
      // If there are 0 assignments, skip buy/pos/email but still run pickups (may be hanging from prior days)
      if (!stage.assignments.length && !phases.includes('pickups')) {
        progress(onProgress, { type: 'pipeline-end', message: 'No orders to stage — done.' });
        audit.log({ action: 'pipeline-complete', source, halted: false, reason: 'no-orders' });
        return result;
      }
    }

    // Phase 2: buy labels
    if (phases.includes('buy')) {
      const assignments = result.phases.stage?.assignments || [];
      const buy = await phaseBuy({ state, assignments, onProgress });
      result.phases.buy = buy;
    }

    // Phase 3: POs
    if (phases.includes('pos')) {
      const pos = await phasePos({ state, onProgress });
      result.phases.pos = pos;
      if (pos.halted) {
        result.halted = 'pos';
        await telegram.notify('halt', `Pipeline halted at PO creation`, `Reason: ${pos.errors[0]?.error || 'unknown'}\n\n${UI_URL}`);
        return result;
      }
    }

    // Phase 4: email
    if (phases.includes('email')) {
      const email = await phaseEmail({ state, onProgress });
      result.phases.email = email;
      if (email.halted) {
        result.halted = 'email';
        await telegram.notify('halt', 'Pipeline halted at email — SMTP auth failure', `Check Office 365 quarantine.\n\n${UI_URL}`);
        return result;
      }
    }

    // Phase 5: pickups
    if (phases.includes('pickups')) {
      const pickups = await phasePickups({ state, onProgress });
      result.phases.pickups = pickups;
    }
  } catch (err) {
    result.halted = 'exception';
    result.exception = err.message;
    audit.log({ action: 'pipeline-exception', source, error: err.message });
    await telegram.notify('halt', 'Pipeline exception', `${err.message}\n\n${UI_URL}`);
    return result;
  }

  // Digest
  const summary = opsState.summarize(state);
  const attnLines = [];
  if (result.phases.buy?.failed?.length) attnLines.push(`${result.phases.buy.failed.length} label failure(s)`);
  if (result.phases.pos?.orders?.some((o) => o.status === 'error' || o.status === 'partial')) attnLines.push(`${result.phases.pos.orders.filter((o) => o.status === 'error' || o.status === 'partial').length} PO issue(s)`);
  if (result.phases.email?.failed?.length) attnLines.push(`${result.phases.email.failed.length} email failure(s)`);
  if (result.phases.pickups?.failed?.length) attnLines.push(`${result.phases.pickups.failed.length} pickup failure(s)`);

  // Per-carrier breakdown + cost-warning list, for visibility into label spend.
  const labels = Object.values(state.phases.buy.labels || {});
  const carrierTotals = {};
  for (const l of labels) {
    const key = l.carrierCode || 'unknown';
    if (!carrierTotals[key]) carrierTotals[key] = { count: 0, cost: 0, est: 0 };
    carrierTotals[key].count += 1;
    if (Number.isFinite(l.labelCost)) carrierTotals[key].cost += l.labelCost;
    if (Number.isFinite(l.estimatedCost)) carrierTotals[key].est += l.estimatedCost;
  }
  const carrierLines = Object.entries(carrierTotals)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([carrier, t]) => {
      const name = String(carrier).replace(/_walleted$/, '').replace(/_/g, ' ');
      const avg = t.count ? (t.cost / t.count).toFixed(2) : '0.00';
      const delta = t.est > 0 ? ` (${(((t.cost - t.est) / t.est) * 100).toFixed(0)}% vs est)` : '';
      return `  ${name} ×${t.count} $${t.cost.toFixed(2)} (avg $${avg})${delta}`;
    });

  const costWarnLines = labels
    .filter((l) => l.costWarning && Number.isFinite(l.labelCost) && Number.isFinite(l.estimatedCost))
    .map((l) => {
      const carrier = String(l.carrierCode || '').replace(/_walleted$/, '').replace(/_/g, ' ');
      const delta = l.estimatedCost > 0 ? ` (+${(((l.labelCost - l.estimatedCost) / l.estimatedCost) * 100).toFixed(0)}%)` : '';
      const ord = l.orderNumber || `#${l.trackingNumber || '?'}`;
      return `  ${ord} ${carrier}: $${l.labelCost.toFixed(2)} vs est $${l.estimatedCost.toFixed(2)}${delta}`;
    });

  const avgLabelCost = summary.labelsBought ? (summary.totalLabelCost / summary.labelsBought).toFixed(2) : null;
  const severity = attnLines.length ? 'attn' : 'ok';
  const body = [
    `Staged: ${summary.staged}`,
    `Labels: ${summary.labelsBought} ($${summary.totalLabelCost}${avgLabelCost ? `, avg $${avgLabelCost}` : ''}${summary.costWarnings ? `, ${summary.costWarnings} cost warn` : ''})`,
    ...(carrierLines.length ? carrierLines : []),
    `POs: ${summary.posCreated}`,
    `Emails: ${summary.emailsSent}`,
    `Pickups: ${summary.pickupsBooked} (${summary.totalPickedLabels} labels)`,
    costWarnLines.length ? '' : null,
    costWarnLines.length ? `Cost warnings:` : null,
    ...costWarnLines,
    attnLines.length ? '' : null,
    attnLines.length ? `Attention: ${attnLines.join('; ')}` : null,
    '',
    UI_URL,
  ].filter((x) => x !== null).join('\n');
  await telegram.notify(severity, `YourFloors ${summary.date} — ${source}${dryRun ? ' (dry run)' : ''}`, body);

  audit.log({ action: 'pipeline-complete', source, halted: false, summary });
  progress(onProgress, { type: 'pipeline-end', message: 'Pipeline complete.', summary });

  return result;
}

module.exports = { runPipeline, PHASES };
