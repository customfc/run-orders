/**
 * Auto-rebooker — rescues genuinely-stuck shipments by cancelling the spent
 * carrier pickup binding and booking a fresh pickup (zero-spend, no ghost label).
 * Customers expect delivery within ~7 days, so we act on packages unmoved 5+ days.
 *
 * SAFETY (this can mutate real customer shipments in an unattended cron):
 *  - Order-aware guard: never act on a shipment whose ORDER already has a
 *    DELIVERED sibling label. Prevents rescuing phantom/leftover labels — the
 *    2026-06-03 WGRF incident, where a delivered order still carried 3 stale
 *    zero-item labels the scan reported as "stuck".
 *  - Item guard: never act on a 0-item label. It carries no product, so a pickup
 *    accomplishes nothing — and it may be a phantom OR a package-split child that
 *    its parent's pickup already covers via warehouse-coverage.
 *  - SHADOW mode (DEFAULT): computes and reports what it WOULD do, executes
 *    nothing. Our V2 tracking signal has been caught disagreeing with the carrier
 *    ("hanging" here vs. "entered network" at the carrier), so the logic must be
 *    validated against reality before it acts. Set AUTO_REBOOK_LIVE=1 to go live.
 *  - cancel-rebook of an EXISTING label cannot create a duplicate-to-customer:
 *    if the box already moved, the warehouse has nothing to hand the new driver;
 *    the worst case of a wrong action is one wasted pickup booking.
 */

const { scanStaleShipments } = require('./stale-tracker');
const { v1Request, v2Request } = require('./shipstation-v2');
const { bookPickupForBucket } = require('./pickups');
const { isManualDropoff, groupKey } = require('./manual-dropoff');

const REBOOK_AGE_DAYS = 5;
const ALREADY_SCHEDULED_RE = /already scheduled for pickup/i;
const isLive = () => process.env.AUTO_REBOOK_LIVE === '1';
const itemsOf = (s) => (s.shipmentItems || []).reduce((a, i) => a + (i.quantity || 0), 0);

// Per-order classification: is any sibling label delivered, and how many items
// does each label carry? Used to skip phantom/leftover labels on fulfilled orders.
async function classifyOrder(orderNumber) {
  if (!orderNumber || !orderNumber.trim()) return { unknown: true };
  const r = await v1Request('GET', `/shipments?orderNumber=${encodeURIComponent(orderNumber)}&pageSize=30&includeShipmentItems=true`);
  if (r.status !== 200) return { unknown: true };
  let d = {};
  try { d = JSON.parse(r.body); } catch { return { unknown: true }; }
  const ships = (d.shipments || []).filter((s) => !s.voided);
  let delivered = false;
  for (const s of ships) {
    try {
      const t = await v2Request('GET', `/v2/labels/se-${s.shipmentId}/track`);
      if (t.status === 200) {
        const td = JSON.parse(t.body);
        if ((td.events || []).some((e) => e.status_code === 'DE') || td.status_code === 'DE') { delivered = true; break; }
      }
    } catch { /* tracking lookup failed — treat as not-confirmed-delivered */ }
  }
  const itemsById = {};
  for (const s of ships) itemsById[String(s.shipmentId)] = itemsOf(s);
  return { delivered, itemsById };
}

const describe = (g) => ({
  warehouseName: g.warehouseName,
  carrier: g.carrier,
  count: g.shipments.length,
  oldest: Math.max(...g.shipments.map((s) => s.age || 0)),
  orders: g.shipments.map((s) => s.orderNumber),
});

/**
 * Group genuine candidates by warehouse+carrier (one fresh pickup covers a
 * group). Manual drop-off groups (Sechelt Purolator) come back separately as
 * `dropOff`: no carrier pickup exists there, so booking one only fails (Purolator
 * 4100702), but an undropped box strands, so they are reported, never skipped.
 */
function groupCandidates(genuine) {
  const groups = {};
  const drop = {};
  for (const s of genuine) {
    const key = groupKey(s.warehouseId, s.carrierCode);
    const bucket = isManualDropoff(s.warehouseId, s.carrierCode) ? drop : groups;
    if (!bucket[key]) bucket[key] = { warehouseId: s.warehouseId, warehouseName: s.warehouseName, carrier: key.split('::')[1], shipments: [] };
    bucket[key].shipments.push(s);
  }
  return {
    groups,
    dropOff: Object.values(drop).map((g) => ({ ...describe(g), trackings: g.shipments.map((s) => s.trackingNumber) })),
  };
}

/**
 * Scan for shipments hanging >= REBOOK_AGE_DAYS, filter to GENUINE ones
 * (undelivered order, real items), then per warehouse+carrier cancel the dead
 * pickup binding and rebook a fresh pickup. Returns a structured action report.
 * In shadow mode (default) nothing is mutated — `wouldRebook` is populated instead.
 */
async function runAutoRebooker() {
  const live = isLive();
  const scan = await scanStaleShipments({ days: 30 });
  const candidates = (scan.shipments || []).filter((s) =>
    s.movement === 'hanging'
    && (s.age || 0) >= REBOOK_AGE_DAYS
    && (s.suggestedAction === 'rebook' || s.suggestedAction === 'book'),
  );

  const orderCache = {};
  const genuine = [];
  const skipped = [];
  for (const s of candidates) {
    if (orderCache[s.orderNumber] === undefined) orderCache[s.orderNumber] = await classifyOrder(s.orderNumber);
    const oi = orderCache[s.orderNumber];
    if (oi.unknown) { skipped.push({ order: s.orderNumber || '(blank)', tracking: s.trackingNumber, age: s.age, reason: 'no order number / lookup failed' }); continue; }
    if (oi.delivered) { skipped.push({ order: s.orderNumber, tracking: s.trackingNumber, age: s.age, reason: 'order already delivered (phantom/leftover label)' }); continue; }
    const items = oi.itemsById[String(s.shipmentId)];
    if (items === 0) { skipped.push({ order: s.orderNumber, tracking: s.trackingNumber, age: s.age, reason: '0-item label (phantom or split-child)' }); continue; }
    genuine.push(s);
  }

  const { groups, dropOff } = groupCandidates(genuine);
  const report = { live, wouldRebook: [], rebooked: [], locked: [], failed: [], skipped, dropOff };
  for (const g of Object.values(groups)) {
    const desc = describe(g);
    if (!live) { report.wouldRebook.push(desc); continue; }
    try {
      // State-aware cancel. A pickup can only be cancelled while the carrier still
      // has it Scheduled/Dispatched (e.g. Purolator error 4100742 "Only Scheduled
      // or Dispatched pickup can be modified or voided"); once it's closed/missed,
      // DELETE 400s and the label stays bound. So we try to release each binding
      // and partition the group into freeable (no binding, or binding released)
      // vs locked. Dedupe cancels by pickup id.
      const cancelResult = {};
      const freeable = [];
      let lockedCount = 0;
      for (const s of g.shipments) {
        const pid = s.pickupId && /^pik_/.test(s.pickupId) ? s.pickupId : null;
        if (!pid) { freeable.push(s); continue; }
        if (cancelResult[pid] === undefined) {
          try { const del = await v2Request('DELETE', `/v2/pickups/${pid}`); cancelResult[pid] = del.status >= 200 && del.status < 300; }
          catch { cancelResult[pid] = false; }
        }
        if (cancelResult[pid]) freeable.push(s); else lockedCount++;
      }
      if (!freeable.length) {
        // Every binding is carrier-locked (closed pickup) — there's no anchor label
        // to hang a fresh pickup on, so cancel-rebook can't help. Surface it for a
        // warehouse-level visit (the locked packages ride any driver that comes) or
        // a ghost — never auto-spend. Don't attempt a doomed "already scheduled" book.
        report.locked.push({ ...desc, reason: 'all bindings carrier-locked (closed pickup) — needs warehouse-level pickup' });
        continue;
      }
      // Book one fresh pickup for the freeable labels; any locked ones in the group
      // ride along on that driver visit via warehouse-coverage (grabs everything staged).
      const r = await bookPickupForBucket({ warehouseId: g.warehouseId, carrier: g.carrier, shipmentIds: freeable.map((s) => s.shipmentId) });
      if (r.success) report.rebooked.push({ ...desc, booked: freeable.length, lockedRiding: lockedCount, pickupId: r.pickupId, confirmation: r.confirmation });
      else if (ALREADY_SCHEDULED_RE.test(String(r.errorMessage || r.error || ''))) {
        // The carrier says these labels already sit on a pickup we can't see (no
        // pik_ id on our side, e.g. booked by phone or web) and so can't cancel.
        // Same remedy as a carrier-locked binding, so report it as locked, not
        // as a failure (Regina, 2026-10-02).
        report.locked.push({ ...desc, reason: 'carrier says already on a pickup we cannot see or cancel; needs a warehouse-level pickup' });
      } else report.failed.push({ ...desc, error: r.errorMessage || r.error });
    } catch (e) {
      report.failed.push({ ...desc, error: e.message });
    }
  }
  return report;
}

module.exports = { runAutoRebooker, groupCandidates, REBOOK_AGE_DAYS, ALREADY_SCHEDULED_RE };
