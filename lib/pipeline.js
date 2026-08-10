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
const fs = require('fs');
const audit = require('./audit');
const opsState = require('./ops-state');
const telegram = require('./telegram');
const { runOrders } = require('../scripts/shipstation/run-orders');
const { v1Request, fetchShippedShipments, downloadLabelPdf, ensureValidShipTo } = require('./shipstation-v2');
const { createAmazonPOs, resolveSkuForPO } = require('./amazon-po');
const { fetchShopifyOrder, createShopifySoPo } = require('./shopify-sf');
const { reconcileShopifySOs, formatReport: formatSoReconcile } = require('./shopify-so-reconcile');
const { scanStaleShipments } = require('./stale-tracker');
const emailer = require('./emailer');
const { bookPickupForBucket } = require('./pickups');
const { generatePackingSlipPdf } = require('./packing-slip');
const { sendWarehouseEmail, PROSOL_CARRIER_PICKUP_LINE, prosolCarrierPickupShipTo } = require('./emailer');
const { planPackages } = require('./package-split');
const heldRebuys = require('./held-rebuys');

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'), 'utf8')
);
const KNOWN_WAREHOUSE_IDS = new Set(
  Object.values(LOCATION_MAP)
    .map((l) => l.shipstation_warehouse_id ? String(l.shipstation_warehouse_id) : null)
    .filter(Boolean)
);

// `<warehouseId>::<carrier>` combos where the warehouse crew hand-drops
// parcels at a local depot, so there is no on-demand carrier pickup to book.
// Skipped like orphan warehouses (recorded as `skipped`, not `failed`) so a
// permanently-unbookable group doesn't spam the daily error counter. Sechelt
// (147654) staff drop Purolator parcels locally; their UPS pickup still books.
const MANUAL_DROPOFF_GROUPS = new Set([
  '147654::purolator',
]);

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

// URGENT email body for a large order held for review. Mac's preferred
// escalation channel — a plain Telegram line got lost among routine alerts, so
// a $9,925 order sat 5 days unnoticed (see project memory: large-order notify).
function renderLargeOrderEmail(m) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const p = m.profile || {};
  const ageDays = p.orderDate ? Math.floor((Date.now() - new Date(p.orderDate).getTime()) / 86400000) : null;
  const rows = [
    ['Order', m.orderNumber],
    ['Value', p.valueCad != null ? `$${Math.round(p.valueCad).toLocaleString()} CAD` : 'n/a'],
    ['Weight', p.weightLb != null ? `${Math.round(p.weightLb)} lb` : 'n/a'],
    ['Boxes', p.packages != null ? String(p.packages) : 'n/a'],
    ['Customer', p.customer || 'n/a'],
    ['Destination', p.destination || 'n/a'],
    ['Age', ageDays != null ? `${ageDays} day(s) since order` : 'n/a'],
    ['Channel', p.source || 'n/a'],
    ['Why held', m.reason || ''],
  ];
  const trs = rows.map(([k, v]) => `<tr><td style="padding:5px 16px 5px 0;color:#777;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:5px 0;color:#15171c;font-weight:600">${esc(v)}</td></tr>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#15171c;line-height:1.5">`
    + `<p style="font-size:16px;font-weight:700;margin:0 0 4px">A large order is held for review. It will not ship until you action it.</p>`
    + `<table style="border-collapse:collapse;margin:14px 0">${trs}</table>`
    + (() => { const dash = process.env.PUBLIC_DASHBOARD_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456'; return `<p>Review and release it from the dashboard:<br><a href="${dash}">${dash}</a></p>`; })()
    + `<p style="color:#888;font-size:12px;margin-top:18px">Auto-sent because the order crossed the large-order review threshold (value, weight, or box count). Tune with LARGE_ORDER_VALUE_CAD / LARGE_ORDER_WEIGHT_LB / LARGE_ORDER_PACKAGES.</p>`
    + `</div>`;
}

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

  // Per-order Telegram alert for manualReview rejections (unsupported province,
  // out-of-scope, mixed routing, etc.). Without this, rejected orders only
  // appeared as a count in the daily summary and silently re-rejected on every
  // subsequent cron tick. shouldAlert/recordAlert dedup so we ping once per
  // orderNumber per hour, not every tick.
  if (!dryRun && result.manualReview.length) {
    // ONE consolidated alert listing every newly-rejected order — deduped per
    // order (shouldAlert) so a persistent reject doesn't re-ping every tick.
    // m.reason already carries the Prosol suggest (candidate SKU + cost).
    const toAlert = result.manualReview.filter((m) => {
      try { return opsState.shouldAlert(state, m.orderNumber); } catch { return false; }
    });
    if (toAlert.length) {
      const body = toAlert.map((m) => `• ${m.orderNumber} — ${String(m.reason || '').slice(0, 240)}`).join('\n\n');
      try {
        await telegram.notify('attn', `⚠️ ${toAlert.length} order${toAlert.length === 1 ? '' : 's'} NOT shipped — fix mapping/address`, `${body}\n\nResolve in ShipStation / sku-map; next cron re-tries.\n${UI_URL}`);
        for (const m of toAlert) opsState.recordAlert(state, m.orderNumber);
      } catch (e) {
        console.error('[phaseStage] consolidated reject alert failed:', e.message);
      }
    }
  }

  // URGENT email escalation for large orders held for review. Separate, louder
  // channel than the generic Telegram line above. Deduped ~once/day per order.
  if (!dryRun) {
    const largeHeld = result.manualReview.filter((m) => m.large);
    for (const m of largeHeld) {
      let due = false;
      try { due = opsState.shouldEmailLargeOrder(state, m.orderNumber); } catch { due = false; }
      if (!due) continue;
      try {
        await emailer.sendEmail({
          to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca',
          subject: `URGENT - large order held for review: ${m.orderNumber} ($${Math.round(m.profile?.valueCad || 0).toLocaleString()})`,
          html: renderLargeOrderEmail(m),
          priority: 'high',
        });
        opsState.recordEmailLargeOrder(state, m.orderNumber);
      } catch (e) {
        console.error('[phaseStage] large-order URGENT email failed:', e.message);
      }
    }
  }

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

// Map a raw buy-phase error into a (reason, action) pair for Telegram. Keep
// reasons short — long stack traces drown the actionable bit. New patterns
// land here as we encounter them; default falls back to the raw error.
function parseBuyErrorReason(err) {
  const msg = String(err?.message || err || '');
  const body = String(err?.body || '');
  const haystack = `${msg}\n${body}`;

  if (err?.code === 'BAD_ADDRESS_PROVINCE' || err?.code === 'BAD_ADDRESS_NOT_PERSISTED' || err?.code === 'BAD_ADDRESS_UPSERT_FAILED') {
    return { reason: msg, action: 'Edit shipTo in ShipStation UI → set state to a 2-letter province code → retry from dashboard.' };
  }
  if (/Insufficient funds/i.test(haystack)) {
    return { reason: 'ShipStation balance too low to buy label.', action: 'Top up ShipStation walleted funds, then retry the order.' };
  }
  if (/StateProvinceCode/i.test(haystack)) {
    return { reason: 'Carrier rejected ship-to province code.', action: 'Edit shipTo in ShipStation UI → set state to a 2-letter province code → retry.' };
  }
  if (/postal/i.test(haystack)) {
    return { reason: 'Carrier rejected postal code.', action: 'Verify shipTo.postalCode is in correct CA format (A1A 1A1) → retry.' };
  }
  if (/weight/i.test(haystack)) {
    return { reason: 'Carrier rejected package weight.', action: 'Check item weights/sku-map; retry once corrected.' };
  }
  return { reason: msg.slice(0, 200), action: 'Investigate via dashboard logs and retry once root cause is fixed.' };
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
    // Pre-buy guard: refuse to call the carrier if the stored shipTo can't be
    // normalized to a 2-letter province code. createlabelfororder uses the
    // order as-stored in ShipStation, so validating assignment.shipTo isn't
    // enough — we have to fix the source of truth or fail loud.
    // ensureValidShipTo also normalizes the order's stored dims cm→in, so
    // createlabelfororder rates them correctly (it uses stored dims, and ignores
    // any dimensions passed in this payload). See lib/shipstation-v2.js.
    await ensureValidShipTo(assignment.orderId, assignment.orderNumber);

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

  // Multi-package path — ShipStation V1 has no native "N packages, one
  // parent order" endpoint. `/shipments/createlabel` does NOT accept an
  // orderId parameter (docs: it creates orphan shipments by design, meant
  // for labels without a source order). So we:
  //   1. Create each package label via /shipments/createlabel (orphans).
  //   2. After all labels succeed, mark the parent order shipped via
  //      /orders/markasshipped with the PRIMARY tracking. That pushes the
  //      order out of Awaiting Shipment and notifies Amazon/channel with
  //      one tracking number. Secondary package labels remain valid in
  //      ShipStation as standalone shipments — the physical boxes ride
  //      the same warehouse pickup, carrier scans both.
  // Limitation: Amazon sales-channel confirmation only carries ONE
  // tracking number per order. The buyer sees the cable_kit tracking;
  // the membrane (or other solo-package) box arrives separately with no
  // pushed notification. Acceptable for 2-package, awkward for 3+. Full
  // multi-tracking support requires SS V2 /v2/labels (tracked in
  // memory/project_sku_map_refactor_deferred.md as a separate refactor).
  // Pre-buy guard: same as the single-package path. Fail loud now rather than
  // burn N partial labels and have to void them.
  await ensureValidShipTo(assignment.orderId, assignment.orderNumber);

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

  // Step 2: mark the parent order shipped so it leaves Awaiting Shipment
  // and the primary tracking pushes to the sales channel. Do NOT void
  // the labels on markasshipped failure — they're valid, packages will
  // ship physically. Just surface the failure loud and let ops recover.
  const primary = bought[0];
  const markRes = await v1Request('POST', '/orders/markasshipped', {
    orderId: assignment.orderId,
    carrierCode: assignment.carrierCode,
    shipDate,
    trackingNumber: primary.trackingNumber,
    notifyCustomer: true,
    notifySalesChannel: true,
  });
  if (markRes.status < 200 || markRes.status >= 300) {
    // Labels exist, packages will ship; only the ShipStation/Amazon sync
    // is broken. Callers can recover manually via /orders/markasshipped
    // with the trackingNumber in the thrown error's `recoveryTracking`.
    const err = new Error(`markasshipped HTTP ${markRes.status}: ${String(markRes.body).slice(0, 200)}`);
    err.orphanedLabels = bought.map((b) => ({ shipmentId: b.shipmentId, trackingNumber: b.trackingNumber }));
    err.recoveryTracking = primary.trackingNumber;
    err.recoveryOrderId = assignment.orderId;
    throw err;
  }

  return {
    shipmentId: primary.shipmentId,
    trackingNumber: primary.trackingNumber,
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

    // Belt-and-suspenders: even if local state says no, ask ShipStation
    // whether a label already exists for this orderNumber. Catches the rare
    // race where two pipelines overlap, or a warehouse operator manually
    // creates a label in the SS UI in the same window our cron is buying.
    // Dug up one 2026-04-17 occurrence (Carole Voss 701-4937930) — a 0.66s
    // gap duplicate that cost $11.82 of wasted postage plus warehouse
    // confusion. Cheap check, worth it.
    try {
      const preCheck = await v1Request('GET', `/shipments?orderNumber=${encodeURIComponent(a.orderNumber)}`);
      if (preCheck.status === 200) {
        const allShipments = JSON.parse(preCheck.body).shipments || [];
        const existingShipments = allShipments.filter((s) => !s.voidDate);
        if (existingShipments.length > 0) {
          const primary = existingShipments.sort((x, y) => x.shipmentId - y.shipmentId)[0];
          opsState.recordLabelBought(state, {
            orderId: a.orderId,
            orderNumber: a.orderNumber,
            source: a.source || null,
            carrierCode: primary.carrierCode,
            serviceCode: primary.serviceCode,
            estimatedCost: a.shipmentCost,
            warehouseId: a.warehouseId,
            shipmentId: primary.shipmentId,
            trackingNumber: primary.trackingNumber,
            labelCost: Number(primary.shipmentCost || 0),
            packages: existingShipments.map((s) => ({
              shipmentId: s.shipmentId,
              trackingNumber: s.trackingNumber,
              labelCost: Number(s.shipmentCost || 0),
              weight: s.weight,
              items: s.shipmentItems || [],
            })),
          });
          audit.log({
            action: 'pipeline-buy-skip-existing',
            orderId: a.orderId,
            orderNumber: a.orderNumber,
            existingShipmentIds: existingShipments.map((s) => s.shipmentId),
            reason: 'pre-buy check found existing non-voided label(s) in ShipStation — race avoided',
          });
          results.skipped.push({
            orderId: a.orderId,
            orderNumber: a.orderNumber,
            reason: 'label already exists in ShipStation (pre-buy check)',
            shipmentId: primary.shipmentId,
            trackingNumber: primary.trackingNumber,
          });
          progress(onProgress, { phase: 'buy', type: 'skip', orderNumber: a.orderNumber, message: `skip ${a.orderNumber} (pre-existing label ${primary.trackingNumber})` });
          continue;
        }

        // Void→rebuy guard. We're here because NO active label exists — but if a
        // VOIDED label does, this order previously shipped and was voided (e.g.
        // the warehouse couldn't fulfill and a stuck reship was cleaned up), then
        // re-entered awaiting-shipment. The per-day buy dedup doesn't remember
        // it, so the cron would silently buy ANOTHER label at whatever warehouse
        // has stock now — duplicate spend + a second warehouse shipping the same
        // goods (Mary Kraftscik RESHIP: Surrey voided 06-03 → auto-rebought
        // Kelowna 06-04). Policy: NEVER auto-rebuy after a void. Hold it durably,
        // alert once, require a one-tap /buy <orderId> to ship. Volume is ~0.1/day
        // (7d probe: 1 of 44 buys), so holding all of them is cheap and safe.
        const voidedShipments = allShipments.filter((s) => s.voidDate);
        if (voidedShipments.length > 0) {
          const latestVoid = voidedShipments.sort((x, y) => new Date(y.voidDate) - new Date(x.voidDate))[0];
          const isNew = heldRebuys.add({
            orderId: a.orderId,
            orderNumber: a.orderNumber,
            customer: (a.shipTo && a.shipTo.name) || null,
            assignment: {
              orderId: a.orderId, orderNumber: a.orderNumber,
              carrierCode: a.carrierCode, serviceCode: a.serviceCode,
              packageCode: a.packageCode || 'package', weight: a.weight || null,
              warehouseId: a.warehouseId || null, shipmentCost: a.shipmentCost || null,
              source: a.source || null,
            },
            priorVoidedTracking: latestVoid.trackingNumber,
            priorVoidedWarehouseId: latestVoid.warehouseId || null,
            voidedAt: latestVoid.voidDate,
          });
          audit.log({ action: 'pipeline-buy-held-rebuy', orderId: a.orderId, orderNumber: a.orderNumber, priorVoidedTracking: latestVoid.trackingNumber, voidedAt: latestVoid.voidDate, newHold: isNew });
          results.skipped.push({ orderId: a.orderId, orderNumber: a.orderNumber, reason: 'held — re-buy after void (needs /buy approval)' });
          progress(onProgress, { phase: 'buy', type: 'skip', orderNumber: a.orderNumber, message: `⏸️ hold ${a.orderNumber} — re-buy after void (prior ${latestVoid.trackingNumber} voided ${String(latestVoid.voidDate).slice(0, 10)})` });
          if (isNew) {
            try {
              await telegram.notify('attn', `⏸️ Held re-buy — ${a.orderNumber}`,
                `Prior label ${latestVoid.trackingNumber} voided ${String(latestVoid.voidDate).slice(0, 10)} — order re-entered awaiting-shipment. Auto-rebuy blocked (would be duplicate spend).\n\nApprove & ship: /buy ${a.orderId}\nManage: /held`);
            } catch {}
          }
          continue;
        }
      }
    } catch (e) {
      // Pre-check failure shouldn't block the buy — log and proceed. Worst case
      // we produce the same rare dupe we always have (no regression).
      console.warn(`[phaseBuy] pre-buy lookup failed for ${a.orderNumber}: ${e.message}`);
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
        source: a.source || null,
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

      // Per-order Telegram alert. Without this, buy failures previously
      // silently dead-ended (the daily summary just said "N label failure(s)"
      // with no per-order detail, and ops never knew which order needed what
      // fix). Dedup via opsState so retries within the same day don't spam.
      try {
        if (opsState.shouldAlert(state, a.orderId)) {
          const { reason, action } = parseBuyErrorReason(err);
          await telegram.notify(
            'attn',
            `Label buy failed — ${a.orderNumber}`,
            `${reason}\n\nAction: ${action}\n\n${UI_URL}`
          );
          opsState.recordAlert(state, a.orderId);
        }
      } catch (e) {
        console.error(`[phaseBuy] telegram.notify failed for ${a.orderNumber}:`, e.message);
      }
    }

    // 4s pause between label purchases (polite to ShipStation, mirrors UI)
    if (i < assignments.length - 1) await sleep(4000);
  }
  return results;
}

// ── Phase 3: CREATE POs ──────────────────────────────────────────────────────

async function phasePos({ state, onProgress }) {
  progress(onProgress, { phase: 'pos', type: 'status', message: 'Creating POs (Amazon + Shopify)...' });

  // Amazon branch — rotating 14-day SO, batches shipped orders
  const amzResult = await createAmazonPOs({
    days: 2,
    onProgress: (ev) => progress(onProgress, { phase: 'pos', ...ev }),
  });
  for (const o of (amzResult.orders || [])) {
    if (o.poNumber && o.trackingNumber) {
      opsState.recordPo(state, { trackingNumber: o.trackingNumber, poNumber: o.poNumber, poId: o.poId });
    }
  }

  // Shopify branch — per-order SO + PO. We look at today's bought labels
  // with source='shopify' and call createShopifySoPo(orderNumber) for each.
  const shopifyOrders = [];
  const shopifyErrors = [];
  const shopifyLabels = Object.values(state.phases.buy.labels || {}).filter((l) => l.source === 'shopify');
  if (shopifyLabels.length) {
    progress(onProgress, { phase: 'pos', type: 'status', message: `Creating ${shopifyLabels.length} Shopify SO/PO(s)...` });
    for (const lbl of shopifyLabels) {
      const trk = lbl.trackingNumber;
      // Skip if a PO was already created for this tracking (idempotent across reruns)
      if (trk && state.phases.pos.byTracking && state.phases.pos.byTracking[trk]) {
        shopifyOrders.push({ orderNumber: lbl.orderNumber, trackingNumber: trk, status: 'skipped', reason: 'PO already exists' });
        continue;
      }
      try {
        progress(onProgress, { phase: 'pos', type: 'status', message: `Processing Shopify ${lbl.orderNumber}...` });
        const shopifyOrder = await fetchShopifyOrder(lbl.orderNumber);
        const r = await createShopifySoPo({
          shopifyOrder,
          trackingNumber: trk,
          carrierCode: lbl.carrierCode || null,
        });
        const anyErrors = (r?.errors || []).length > 0;
        if (r?.skipped) {
          // Skip-if-exists guard fired — someone (Sechelt / Mac / another
          // process) already created an SO. Record the trk/poNumber if we
          // learned it so we don't re-try on next run.
          if (r.existingCandidates?.[0]?.startsWith('PO-') && trk) {
            opsState.recordPo(state, { trackingNumber: trk, poNumber: r.existingCandidates[0], poId: null });
          }
          shopifyOrders.push({
            orderNumber: lbl.orderNumber,
            trackingNumber: trk,
            status: 'skipped',
            reason: r.skipReason,
            existingCandidates: r.existingCandidates || [],
          });
          progress(onProgress, { phase: 'pos', type: 'skip', message: `⊘ Shopify ${lbl.orderNumber}: ${r.skipReason} (${(r.existingCandidates || []).join(', ')})` });
        } else {
          if (r && r.poNumber && trk) {
            opsState.recordPo(state, { trackingNumber: trk, poNumber: r.poNumber, poId: r.poId, soNumber: r.soNumber, soId: r.soId });
          }
          // poSkipped → SO created but no Prosol PO needed (NON_PROSOL / Sechelt
          // own-stock order). That's a success, not an error: status 'so-only'.
          shopifyOrders.push({
            orderNumber: lbl.orderNumber,
            trackingNumber: trk,
            soNumber: r?.soNumber || null,
            poNumber: r?.poNumber || null,
            poId: r?.poId || null,
            status: r?.poSkipped
              ? 'so-only'
              : ((r?.poNumber && r?.soNumber && !anyErrors) ? 'created' : (anyErrors ? 'partial' : 'error')),
            poSkipReason: r?.poSkipReason || null,
            errors: (r?.errors || []).map((e) => e.error || String(e)),
          });
          if (anyErrors) shopifyErrors.push(...(r.errors || []).map((e) => ({ orderNumber: lbl.orderNumber, step: e.step, error: e.error })));
          const poDisplay = r?.poSkipped ? `(no PO — ${r.poSkipReason || 'NON_PROSOL'})` : `PO ${r?.poNumber || '—'}`;
          progress(onProgress, { phase: 'pos', type: 'po-created', message: `${anyErrors ? '⚠' : '✓'} Shopify ${lbl.orderNumber} → SO ${r?.soNumber || '—'} / ${poDisplay}` });
        }
      } catch (err) {
        shopifyErrors.push({ orderNumber: lbl.orderNumber, error: err.message });
        shopifyOrders.push({ orderNumber: lbl.orderNumber, trackingNumber: trk, status: 'error', errors: [err.message] });
        progress(onProgress, { phase: 'pos', type: 'error', message: `✗ Shopify ${lbl.orderNumber}: ${err.message}` });
      }
    }
  }

  // Reconciliation sweep — catch fulfilled Shopify orders that never got an SF
  // SO because their label was bought outside today's run-state (manual buy,
  // prior day, or a day the pos phase didn't run). The per-order loop above only
  // covers TODAY's shopify labels; this decouples SO creation from the daily
  // buy-state so gaps self-heal. SHADOW unless SHOPIFY_SO_RECONCILE_LIVE=1.
  // Idempotent (createShopifySoPo skips if an SO already exists). See
  // lib/shopify-so-reconcile.js. Never let a sweep failure break the pos phase.
  let soReconcile = null;
  try {
    soReconcile = await reconcileShopifySOs({
      onProgress: (ev) => progress(onProgress, { phase: 'pos', ...ev }),
    });
    if (soReconcile.created.length || soReconcile.missing.length) {
      progress(onProgress, { phase: 'pos', type: 'status', message: formatSoReconcile(soReconcile) });
    }
  } catch (err) {
    progress(onProgress, { phase: 'pos', type: 'error', message: `[so-reconcile] sweep failed (non-fatal): ${err.message}` });
  }

  const orders = [...(amzResult.orders || []), ...shopifyOrders];
  const errors = [...(amzResult.errors || []), ...shopifyErrors];

  audit.log({
    action: 'pipeline-pos',
    soReconcileMissing: soReconcile ? soReconcile.missing.length : null,
    soReconcileCreated: soReconcile ? soReconcile.created.length : null,
    success: errors.length === 0,
    soName: amzResult.soName,
    soCreated: amzResult.soCreated,
    posCreated: orders.filter((o) => o.status === 'created').length,
    posSkipped: orders.filter((o) => o.status === 'skipped').length,
    posErrored: orders.filter((o) => o.status === 'error' || o.status === 'partial').length,
    shopifyCount: shopifyOrders.length,
    errors,
  });

  // 'check-existing' is the duplicate-PO guard. amazon-po now aborts the phase
  // rather than creating POs blind when it fails, so treat it like the other
  // hard stops: halt the run and Telegram it. Silence here is how 2026-07-24
  // produced 12 duplicate POs from a single swallowed query error.
  const HALT_STEPS = new Set(['sf-login', 'amazon-so', 'check-existing']);
  const halted = (amzResult.errors || []).some((e) => HALT_STEPS.has(e.step));
  return { phase: 'pos', halted, soName: amzResult.soName, soCreated: amzResult.soCreated, orders, errors, soReconcile };
}

// ── Phase 4: EMAIL KAITLYN ───────────────────────────────────────────────────

/**
 * @param labels    optional explicit {orderId: labelInfo} map, used INSTEAD of
 *   state.phases.buy.labels. The orphan sweep passes a set merged across several
 *   ops-state days so that warehouse grouping — and therefore the one-email-per-
 *   warehouse rule — still holds across days. Without this the sweep had to call
 *   phaseEmail once per day, which sent Kaitlyn one email per (warehouse, day)
 *   and broke the batching rule the moment two days shared a branch.
 * @param posByTracking  optional explicit PO map to match `labels`.
 * @param recordSent     optional (warehouseKey, orderIds) => void, overriding
 *   where the "emailed" record is written. The sweep uses it to write each
 *   record back to the order's ORIGINAL day, so the per-day idempotency check
 *   still sees it and can never re-send.
 */
async function phaseEmail({ state, onProgress, skipOrderIds = [], labels = null, posByTracking: posOverride = null, recordSent = null }) {
  const results = { phase: 'email', halted: false, sent: [], skipped: [], failed: [] };

  // Read bought labels + POs from ops-state so the phase runs correctly standalone
  // (e.g. from the 2:00 PM email-only cron tick).
  // Per-order idempotency: drop orderIds already emailed today. Replaces the
  // old warehouse-level check that silently dropped later-day labels whose
  // warehouse had been emailed earlier in the day.
  // skipOrderIds: caller-supplied exclusions (the orphan-sweep passes orders it
  // found cancelled or whose label is voided, so they're never emailed).
  const skip = new Set((skipOrderIds || []).map(Number));
  const sourceLabels = labels || state.phases.buy.labels || {};
  const boughtLabels = Object.entries(sourceLabels)
    .map(([orderId, info]) => ({ orderId: Number(orderId), ...info }))
    // an explicit label set is pre-filtered by the caller; only consult
    // ops-state idempotency when reading from ops-state
    .filter((l) => labels || !opsState.orderAlreadyEmailed(state, l.orderId))
    .filter((l) => !skip.has(l.orderId));
  const posByTracking = posOverride || state.phases.pos.byTracking || {};

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

    // Remap raw ShipStation items (ASIN / Shopify SKU + platform title) into
    // Prosol SKU + product name so the warehouse-facing packing slip lists
    // what Prosol actually stocks. Listing mix-ups (e.g. Shopify 9225 listed
    // as "ECO 560" but physical product is ECO 570) are surfaced correctly.
    const remapItems = (arr) => (arr || []).flatMap((i) => {
      const resolved = resolveSkuForPO(i.sku, i.quantity || 1, i.name);
      if (resolved) return resolved.map((r) => ({ sku: r.prosolSku, name: r.product, quantity: r.qty, unitPrice: i.unitPrice }));
      const mapEntry = SKU_MAPPINGS[String(i.sku || '')];
      if (mapEntry && typeof mapEntry !== 'string' && mapEntry.prosol_sku) {
        return [{ sku: mapEntry.prosol_sku, name: mapEntry.product || i.name, quantity: i.quantity, unitPrice: i.unitPrice }];
      }
      return [{ sku: i.sku, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice }];
    });

    // Also remap items inside each package so the multi-package per-box
    // breakdown in the packing slip shows Prosol SKUs/names, not the raw
    // Amazon ASIN / Shopify SKU that's in state.
    const remappedPackages = Array.isArray(b.packages)
      ? b.packages.map((p) => ({ ...p, items: remapItems(p.items) }))
      : null;

    whMap[whName].orders.push({
      orderId: b.orderId,
      orderNumber: order.orderNumber,
      shipmentId: b.shipmentId,
      trackingNumber: b.trackingNumber,
      packages: remappedPackages,
      poNumber: po?.poNumber || null,
      soNumber: po?.soNumber || null,
      carrier: (order.carrierCode || '').replace('_walleted', '').replace(/_/g, ' '),
      shipTo: order.shipTo,
      items: remapItems(items),
      // ops-state override (b.internalNotes) takes precedence over ShipStation's
      // field, since SS locks internalNotes once an order ships. Lets us set
      // packaging instructions on already-shipped orders by editing ops-state.
      internalNotes: b.internalNotes || order.internalNotes || null,
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
    // No warehouse-level skip check here — idempotency is applied per-order
    // when boughtLabels is built above, so whOrders contains only orders that
    // have never been emailed. An empty whOrders won't reach this loop.

    try {
      // Per-order partitioning: build attachments in an order-local buffer and
      // only merge into the warehouse batch on full success. If any PDF for an
      // order is missing (label OR packing slip), the order is held back for
      // the next tick — never email partial docs to a warehouse.
      // Invariant (2026-04-23 Prosol PO-14517 incident): the warehouse email
      // body prints tracking text even without the PDF attached, which caused
      // a real shipment to be blocked. Fix: hard-fail per-order.
      const attachments = [];
      const okOrders = [];
      const failedOrders = [];
      for (const o of whOrders) {
        const orderAttachments = [];
        const orderReasons = [];
        // Multi-package orders have N shipmentIds under o.packages. Attach every
        // label PDF. Single-package orders fall back to the top-level shipmentId.
        const pkgShipmentIds = Array.isArray(o.packages) && o.packages.length > 1
          ? o.packages.map((p) => p.shipmentId).filter(Boolean)
          : (o.shipmentId ? [o.shipmentId] : []);
        let labelOk = 0;
        for (let p = 0; p < pkgShipmentIds.length; p++) {
          const sid = pkgShipmentIds[p];
          try {
            const labelPdf = await downloadLabelPdf(sid);
            if (labelPdf) {
              const suffix = pkgShipmentIds.length > 1 ? `-pkg${p + 1}of${pkgShipmentIds.length}` : '';
              orderAttachments.push({ filename: `Label-${o.orderNumber}${suffix}.pdf`, content: labelPdf });
              labelOk++;
            } else {
              orderReasons.push(`label ${sid}: downloadLabelPdf returned null`);
            }
          } catch (e) {
            orderReasons.push(`label ${sid}: ${e.message}`);
          }
        }

        // Always generate our own packing slip. Previously gated on o.poNumber,
        // which meant customer MFN orders (no Salesforce PO) never got one —
        // leaving Kaitlyn with just the ShipStation-combined label PDF whose
        // embedded packing slip pulls from the orphan shipment's (empty) item
        // list. Our slip pulls from the parent order's items, and for multi-
        // package orders renders a per-box breakdown so the warehouse knows
        // which items belong in which box.
        try {
          const slipPdf = await generatePackingSlipPdf({
            poNumber: o.poNumber || null,
            date: new Date().toISOString().slice(0, 10),
            vendor: 'Prosol Inc.',
            orderNumber: o.orderNumber,
            soNumber: o.soNumber || null,
            tracking: o.trackingNumber,
            carrier: o.carrier,
            shipTo: prosolCarrierPickupShipTo(),
            items: o.items || [],
            packages: Array.isArray(o.packages) && o.packages.length > 1 ? o.packages : undefined,
            notes: o.internalNotes || null,
          });
          if (slipPdf) {
            const slipId = o.poNumber || o.orderNumber;
            orderAttachments.push({ filename: `PackingSlip-${slipId}.pdf`, content: slipPdf });
          } else {
            orderReasons.push('packing slip: generator returned null');
          }
        } catch (e) {
          orderReasons.push(`packing slip: ${e.message}`);
        }

        const labelComplete = labelOk === pkgShipmentIds.length && pkgShipmentIds.length > 0;
        if (!labelComplete || orderReasons.length > 0) {
          const msg = `Order ${o.orderNumber} held back (${labelOk}/${pkgShipmentIds.length} labels): ${orderReasons.join('; ')}`;
          console.error(`[phaseEmail] ${msg}`);
          audit.log({ action: 'pipeline-email-blocked-missing-pdf', warehouse, orderNumber: o.orderNumber, orderId: o.orderId, labelsOk: labelOk, labelsExpected: pkgShipmentIds.length, reasons: orderReasons });
          progress(onProgress, { phase: 'email', type: 'error', warehouse, orderNumber: o.orderNumber, error: 'missing pdf', message: `✗ ${o.orderNumber} @ ${warehouse}: ${msg}` });
          failedOrders.push({ orderId: o.orderId, orderNumber: o.orderNumber, reasons: orderReasons });
        } else {
          attachments.push(...orderAttachments);
          okOrders.push(o);
        }
      }

      if (okOrders.length > 0) {
        await sendWarehouseEmail({
          warehouse,
          orders: okOrders.map((o) => ({
            orderNumber: o.orderNumber,
            poNumber: o.poNumber || 'N/A',
            soNumber: o.soNumber || null,
            shipTo: PROSOL_CARRIER_PICKUP_LINE,
            carrier: o.carrier,
            tracking: o.trackingNumber,
          })),
          attachments,
          ...recipient,
        });
        const sentOrderIds = okOrders.map((o) => o.orderId).filter((id) => id != null);
        if (recordSent) {
          recordSent(warehouse, sentOrderIds);
        } else {
          opsState.recordEmailSent(state, { warehouseKey: warehouse, orderCount: okOrders.length, orderIds: sentOrderIds });
        }
        results.sent.push({ warehouse, orderCount: okOrders.length, orderIds: sentOrderIds });
        audit.log({ action: 'pipeline-email-prosol', warehouse, orderCount: okOrders.length, orderIds: okOrders.map((o) => o.orderId).filter((id) => id != null), success: true });
        progress(onProgress, { phase: 'email', type: 'sent', warehouse, message: `✓ emailed ${warehouse} (${okOrders.length} orders)` });
      }

      if (failedOrders.length > 0) {
        // Don't call recordEmailSent for these — next tick's orderAlreadyEmailed
        // filter (pipeline.js:495) will retry them using the already-purchased
        // shipmentId (alreadyBought short-circuits phaseBuy, so no duplicate
        // label spend).
        results.failed.push({ warehouse, error: `held back (missing pdf): ${failedOrders.map((f) => f.orderNumber).join(', ')}`, orders: failedOrders });
        const alertable = failedOrders.filter((f) => opsState.shouldAlert(state, f.orderId));
        if (alertable.length > 0) {
          const summary = alertable.map((f) => `${f.orderNumber}: ${f.reasons.join('; ')}`).join('\n');
          try {
            await telegram.notify(
              'attn',
              `Warehouse email held back — ${warehouse} (${alertable.length} order${alertable.length === 1 ? '' : 's'})`,
              `Missing label/packing-slip PDF. Will retry next tick.\n\n${summary}\n\n${UI_URL}`,
            );
          } catch (e) {
            console.error(`[phaseEmail] telegram.notify failed:`, e.message);
          }
          for (const f of alertable) opsState.recordAlert(state, f.orderId);
        }
      }
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
  // `stuck` is separate from `failed` — a stuck group is one where every
  // label is already bound to a carrier-side pickup we can't dislodge.
  // Counts against attention only if anything actually failed.
  const results = { phase: 'pickups', halted: false, booked: [], skipped: [], failed: [], stuck: [] };
  progress(onProgress, { phase: 'pickups', type: 'status', message: 'Scanning for hanging shipments...' });

  const scan = await scanStaleShipments({ days: 14 });
  const hanging = (scan.shipments || []).filter((s) => s.movement === 'hanging' && (s.suggestedAction === 'book' || s.suggestedAction === 'rebook'));
  progress(onProgress, { phase: 'pickups', type: 'status', message: `${hanging.length} hanging shipment(s) need pickup action.` });

  // Group by (warehouseId, carrierCode). Drop shipments whose warehouseId is
  // not in prosol-location-map.json — these are orphan labels from deleted
  // ShipStation warehouses (e.g. 1861506, 1869299) that can't be picked up
  // anywhere. Recording them as `failed` daily spams the error counter.
  const groups = {};
  for (const s of hanging) {
    if (!KNOWN_WAREHOUSE_IDS.has(String(s.warehouseId))) {
      results.skipped.push({ group: `${s.warehouseId}::${s.carrierCode || ''}`, reason: `unknown warehouse ${s.warehouseId} (orphan label)`, shipmentId: s.shipmentId });
      continue;
    }
    const carrier = (s.carrierCode || '').replace(/_walleted$/, '');
    const key = `${s.warehouseId}::${carrier}`;
    if (MANUAL_DROPOFF_GROUPS.has(key)) {
      results.skipped.push({ group: key, reason: 'manual drop-off (crew drops at local depot; no carrier pickup)', shipmentId: s.shipmentId });
      continue;
    }
    if (!groups[key]) groups[key] = { key, warehouseId: s.warehouseId, warehouseName: s.warehouseName, carrier, shipments: [] };
    groups[key].shipments.push(s);
  }

  const pickupDate = nextBusinessDay();

  // Book fresh + stale separately. Fresh labels (suggestedAction='book',
  // pickupState='none') can book cleanly. Stale ones (suggestedAction='rebook',
  // pickupState='booked-passed') usually fail with "already scheduled" because
  // the carrier hasn't released the old binding — we classify those as 'stuck'
  // so a fresh label in the same warehouse×carrier isn't blocked by a stuck one.
  for (const g of Object.values(groups)) {
    const freshShipments = g.shipments.filter((s) => s.suggestedAction === 'book');
    const staleShipments = g.shipments.filter((s) => s.suggestedAction === 'rebook');
    const attempts = [];
    if (freshShipments.length) attempts.push({ kind: 'fresh', shipments: freshShipments });
    if (staleShipments.length) attempts.push({ kind: 'stale', shipments: staleShipments });

    for (const attempt of attempts) {
      const stateKey = `${g.key}:${attempt.kind}::${pickupDate}`;
      if (opsState.pickupAlreadyBooked(state, stateKey)) {
        results.skipped.push({ group: g.key, kind: attempt.kind, reason: 'already booked today' });
        continue;
      }

      const shipmentIds = attempt.shipments.map((s) => s.shipmentId);
      try {
        const r = await bookPickupForBucket({
          warehouseId: g.warehouseId,
          carrier: g.carrier,
          pickupDate,
          shipmentIds,
        });
        if (r.success) {
          // Some labels may have been dropped from the request because the carrier
          // still holds them on a spent binding ("already scheduled"). The pickup
          // still covers them physically (address-based), but they stay flagged so
          // the order-aware auto-rebooker can release the dead binding.
          const dropped = Array.isArray(r.droppedLabelIds) ? r.droppedLabelIds : [];
          const bookedCount = shipmentIds.length - dropped.length;
          opsState.recordPickup(state, { groupKey: stateKey, pickupId: r.pickupId, confirmation: r.confirmation, labelCount: bookedCount, pickupDate });
          results.booked.push({ group: g.key, kind: attempt.kind, warehouseName: g.warehouseName, carrier: g.carrier, labelCount: bookedCount, pickupId: r.pickupId, confirmation: r.confirmation, droppedBoundLabels: dropped });
          audit.log({ action: 'pipeline-pickup', groupKey: stateKey, success: true, pickupId: r.pickupId, labelCount: bookedCount, droppedBoundLabels: dropped, kind: attempt.kind });
          progress(onProgress, { phase: 'pickups', type: 'booked', group: g.key, message: `✓ ${g.warehouseName} ${g.carrier} [${attempt.kind}] (${bookedCount})${dropped.length ? ` +${dropped.length} bound-riding` : ''} → ${r.confirmation || r.pickupId}` });
        } else {
          const humanMsg = r.errorMessage || r.error || (r.body || '').toString().slice(0, 300);
          const rawBody = (r.body || '').toString();
          const isStuck = /already been completed|already scheduled/i.test(rawBody) || r.errorCode === 'pickup_already_completed';
          // Benign: a STALE UPS rebook with no fresh label to anchor a free pickup
          // returns "cannot be billed" — those labels already used their free-pickup
          // eligibility. It can't book and doesn't need to: the boxes ride the next
          // eligible/standing UPS pickup (a carrier pickup is address-based). This
          // surfaced as a false "failure" starting 2026-06-19, when b97fb0f's retry
          // began clearing the prior "already scheduled" gate and reaching this one.
          // Genuinely-stranded long-tail UPS boxes are the auto-rebooker's job
          // (cancel the dead binding → label becomes eligible for a fresh free pickup).
          const isUpsIneligibleRebook = attempt.kind === 'stale'
            && g.carrier === 'ups'
            && /cannot be billed/i.test(rawBody);

          if (isStuck || isUpsIneligibleRebook) {
            // Not a real failure — either the carrier holds these labels on a prior
            // binding we can't release, or it's a stale UPS rebook that rides the
            // next pickup. Record as stuck; do NOT increment the attention counter.
            results.stuck.push({
              group: g.key, kind: attempt.kind, warehouseName: g.warehouseName, carrier: g.carrier,
              labelCount: shipmentIds.length,
              errorCode: r.errorCode || null,
              reason: isUpsIneligibleRebook ? 'stale UPS rebook, no fresh anchor — rides next pickup' : humanMsg.slice(0, 200),
            });
            audit.log({
              action: 'pipeline-pickup-stuck',
              groupKey: stateKey,
              kind: attempt.kind,
              labelCount: shipmentIds.length,
              errorCode: r.errorCode || null,
              benignUpsRebook: isUpsIneligibleRebook || undefined,
              body: rawBody.slice(0, 500),
            });
            progress(onProgress, { phase: 'pickups', type: 'stuck', group: g.key, message: isUpsIneligibleRebook
              ? `↻ ${g.warehouseName} UPS [stale]: no fresh anchor — rides next pickup`
              : `🔒 ${g.warehouseName} ${g.carrier} [${attempt.kind}]: stuck — carrier-side binding still held` });
          } else {
            results.failed.push({
              group: g.key, kind: attempt.kind, warehouseName: g.warehouseName, carrier: g.carrier,
              error: humanMsg,
              errorCode: r.errorCode || null,
              errorLabelId: r.errorLabelId || null,
            });
            opsState.recordError(state, { phase: 'pickups', reason: humanMsg, context: { group: g.key, kind: attempt.kind, errorCode: r.errorCode || null, errorLabelId: r.errorLabelId || null } });
            audit.log({
              action: 'pipeline-pickup',
              groupKey: stateKey,
              kind: attempt.kind,
              success: false,
              error: humanMsg,
              errorCode: r.errorCode || null,
              errorLabelId: r.errorLabelId || null,
              httpStatus: r.error || null,
              body: rawBody.slice(0, 500),
            });
            progress(onProgress, { phase: 'pickups', type: 'error', group: g.key, message: `✗ ${g.warehouseName} ${g.carrier} [${attempt.kind}]: ${humanMsg.slice(0, 120)}` });
          }
        }
      } catch (err) {
        results.failed.push({ group: g.key, kind: attempt.kind, error: err.message });
        opsState.recordError(state, { phase: 'pickups', reason: err.message, context: { group: g.key, kind: attempt.kind } });
      }

      await sleep(500);
    }
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
  // Stuck pickups = carrier-side bindings we can't release. Shown in digest body but
  // NOT counted toward attention — they're a daily baseline noise, not a new problem.
  const stuckCount = result.phases.pickups?.stuck?.length || 0;

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

  // Per-order detail lines — product, warehouse, carrier, cost
  const LOC_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'));
  const whById = {};
  for (const loc of Object.values(LOC_MAP)) {
    if (loc.shipstation_warehouse_id) whById[String(loc.shipstation_warehouse_id)] = loc;
  }
  const orderLines = labels.map((l) => {
    const carrier = String(l.carrierCode || '').replace(/_walleted$/, '').replace(/_/g, ' ');
    const wh = whById[String(l.warehouseId)];
    const whName = wh ? wh.code : `wh-${l.warehouseId}`;
    const items = (l.packages || []).flatMap((p) => (p.items || []));
    const itemStr = items.length
      ? items.map((i) => `${i.name || i.sku}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')
      : l.orderNumber || '?';
    // Truncate long product names for Telegram readability
    const itemShort = itemStr.length > 80 ? itemStr.slice(0, 77) + '...' : itemStr;
    return `  ${l.orderNumber || '?'} → ${whName} ${carrier} $${(l.labelCost || 0).toFixed(2)}\n    ${itemShort}`;
  });

  // Email detail
  const emailsByWh = state.phases.email.byWarehouse || {};
  const emailLines = Object.entries(emailsByWh).map(([wh, info]) => `  ${wh}: ${info.orderCount} order(s)`);

  // Pickup detail
  const pickupsByGroup = state.phases.pickups.byGroup || {};
  const pickupLines = Object.entries(pickupsByGroup).map(([key, info]) => {
    const [whId, carrier] = key.split('::');
    const wh = whById[whId];
    const whName = wh ? `${wh.city} (${wh.code})` : `wh-${whId}`;
    return `  ${whName} ${carrier}: ${info.labelCount} label(s), ${info.pickupDate}`;
  });

  // PO detail
  const posByTracking = state.phases.pos.byTracking || {};
  const poNumbers = [...new Set(Object.values(posByTracking).map((p) => p.poNumber))];

  const avgLabelCost = summary.labelsBought ? (summary.totalLabelCost / summary.labelsBought).toFixed(2) : null;
  const severity = attnLines.length ? 'attn' : 'ok';
  // Per-run is SILENT on a clean run — the 15:00 daily digest is the recap, and
  // mismap rejections are alerted (consolidated) in phaseStage. Only speak here
  // when a phase actually FAILED (labels/POs/emails/pickups), and keep it tight:
  // one line of counts + the cost warnings + what failed. No per-order dump.
  if (attnLines.length) {
    const body = [
      `Staged ${summary.staged} · ${summary.labelsBought} labels${summary.totalLabelCost ? ` $${summary.totalLabelCost}` : ''} · ${summary.posCreated} POs · ${summary.emailsSent} emails · ${summary.pickupsBooked} pickups`,
      stuckCount ? `🔒 ${stuckCount} stuck (carrier binding held)` : null,
      ...(costWarnLines.length ? ['', 'Cost warnings:', ...costWarnLines] : []),
      '',
      `⚠️ ${attnLines.join('; ')}`,
      UI_URL,
    ].filter((x) => x !== null).join('\n');
    await telegram.notify('attn', `${source}${dryRun ? ' (dry run)' : ''} — needs attention`, body);
  }

  audit.log({ action: 'pipeline-complete', source, halted: false, summary });
  progress(onProgress, { type: 'pipeline-end', message: 'Pipeline complete.', summary });

  return result;
}

module.exports = { runPipeline, PHASES, phaseEmail, renderLargeOrderEmail };
