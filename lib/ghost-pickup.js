/**
 * Ghost pickup — trigger a carrier visit to a fringe warehouse without
 * a real shippable package. Buy a minimal label, book a pickup with it
 * attached, then void the label after the pickup window closes so the
 * wallet is refunded. Net cost: $0.
 *
 * Use case: a stuck label at a fringe warehouse (e.g. LOND) where V2 says
 * the prior pickup is "already completed" and won't let us re-attach the
 * stuck label to a new pickup. By booking a fresh pickup with a ghost
 * label, UPS/Purolator dispatches a driver to the warehouse, and per
 * Mac's ops reality ("driver grabs everything at the desk") the stuck
 * physical package rides along.
 *
 * Only UPS and Purolator need this trick. Canada Post pickups are
 * location-based (no label_ids required), so a fresh CP pickup booking
 * at the warehouse trivially solves the same problem.
 */

const fs = require('fs');
const path = require('path');
const audit = require('./audit');
const telegram = require('./telegram');
const { v1Request, bookPickup, CARRIER_IDS } = require('./shipstation-v2');
const { scanShippedLabels } = require('./pickups');

const LOCATION_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'), 'utf8')
);

const PENDING_VOIDS = path.join(__dirname, '..', 'data', 'ghost-voids.json');

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_VOIDS, 'utf8')); } catch { return []; }
}
function savePending(list) {
  const dir = path.dirname(PENDING_VOIDS);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PENDING_VOIDS, JSON.stringify(list, null, 2));
}

function findWarehouse(code) {
  for (const loc of Object.values(LOCATION_MAP)) {
    if (loc.code === code) return loc;
  }
  return null;
}

function getGhostShipTo() {
  return {
    name: process.env.GHOST_SHIP_TO_NAME || 'Mac Roy',
    street1: process.env.GHOST_SHIP_TO_STREET1,
    street2: process.env.GHOST_SHIP_TO_STREET2 || '',
    city: process.env.GHOST_SHIP_TO_CITY,
    state: process.env.GHOST_SHIP_TO_STATE,
    postalCode: (process.env.GHOST_SHIP_TO_POSTAL || '').replace(/\s/g, ''),
    country: process.env.GHOST_SHIP_TO_COUNTRY || 'CA',
    phone: process.env.GHOST_SHIP_TO_PHONE || '6048853582',
    residential: true,
  };
}

function nextBusinessDay(from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Service codes known to exist + cheap for ghosts
const GHOST_SERVICE = {
  ups:       { v1Carrier: 'ups_walleted',       serviceCode: 'ups_standard' },
  purolator: { v1Carrier: 'purolator_walleted', serviceCode: 'purolator_ground ' }, // SS V1 returns Purolator service codes with a trailing space; the API rejects the trimmed form
};

/**
 * Create a ghost pickup for a fringe warehouse.
 * @param {Object} opts
 * @param {string} opts.warehouseCode
 * @param {string} opts.carrier            'ups' or 'purolator'
 * @param {boolean} [opts.force=false]     bypass the "real shipments exist" guard
 * @returns {Promise<{success:bool, pickupId?, confirmation?, trackingNumber?, pickupDate?, voidAfter?, labelCost?, error?, existingShipments?}>}
 */
async function createGhostPickup({ warehouseCode, carrier, force = false }) {
  const loc = findWarehouse(warehouseCode);
  if (!loc) return { success: false, error: `Unknown warehouse code: ${warehouseCode}` };
  const svc = GHOST_SERVICE[carrier];
  if (!svc) return { success: false, error: `Ghost pickup not supported for ${carrier} (try ups or purolator)` };

  const shipTo = getGhostShipTo();
  if (!shipTo.street1 || !shipTo.city || !shipTo.state || !shipTo.postalCode) {
    return { success: false, error: 'GHOST_SHIP_TO_* env vars not set' };
  }

  // Guard: don't buy a ghost label if real shipments already exist at this
  // warehouse+carrier awaiting pickup — those could carry the pickup without
  // the $10-15 ghost cost. Bypass with `force: true`.
  if (!force) {
    try {
      const buckets = await scanShippedLabels({ days: 14 });
      const carrierKey = svc.v1Carrier; // 'ups_walleted' / 'purolator_walleted'
      const match = buckets.find((b) => b.warehouseCode === warehouseCode && b.carrier === carrierKey);
      if (match && match.shipments.length > 0) {
        return {
          success: false,
          step: 'guard',
          error: `${match.shipments.length} real shipment(s) at ${warehouseCode}/${carrier} already awaiting pickup — book against those via /pickups instead, or pass --force to create ghost anyway.`,
          existingShipments: match.shipments,
        };
      }
    } catch (err) {
      // If the scan itself fails, fall through and proceed — don't block the ghost
      // on a scanner outage. Audit will show the ghost-pickup-create regardless.
      audit.log({ action: 'ghost-pickup-guard-scan-failed', warehouseCode, carrier, error: err.message });
    }
  }

  const shipFrom = {
    name: `Prosol ${loc.city}`,
    company: 'Prosol Inc.',
    street1: loc.address,
    city: loc.city,
    state: loc.province,
    postalCode: (loc.postal_code || '').replace(/\s/g, ''),
    country: 'CA',
    phone: (Array.isArray(loc.contact_phone) ? loc.contact_phone[0] : loc.contact_phone) || '514-745-1212',
  };

  const pickupDate = nextBusinessDay();

  // Step 1: create the minimal label
  const labelPayload = {
    carrierCode: svc.v1Carrier,
    serviceCode: svc.serviceCode,
    packageCode: 'package',
    confirmation: 'none',
    shipDate: new Date().toISOString().slice(0, 10),
    weight: { value: 1, units: 'pounds' },
    shipFrom,
    shipTo,
    testLabel: false,
  };
  const labelRes = await v1Request('POST', '/shipments/createlabel', labelPayload);
  if (labelRes.status !== 200) {
    return { success: false, step: 'create-label', error: `HTTP ${labelRes.status}: ${labelRes.body.slice(0, 250)}` };
  }
  const labelData = JSON.parse(labelRes.body);
  const ghostShipmentId = labelData.shipmentId;
  const ghostTracking = labelData.trackingNumber;
  const labelCost = labelData.shipmentCost;

  // Step 2: book the pickup with the ghost label attached
  const carrierId = CARRIER_IDS[svc.v1Carrier];
  const purolatorAddress = carrier === 'purolator' ? {
    name: shipFrom.name,
    phone: shipFrom.phone,
    company_name: 'Prosol Inc.',
    address_line1: shipFrom.street1,
    city_locality: shipFrom.city,
    state_province: shipFrom.state,
    postal_code: shipFrom.postalCode,
    country_code: 'CA',
    address_residential_indicator: 'no',
  } : null;

  const pickupRes = await bookPickup({
    carrierId,
    labelIds: [`se-${ghostShipmentId}`],
    pickupDate,
    warehouseAddress: purolatorAddress,
    warehouseProvince: loc.province,
    contactName: `Prosol ${loc.city}`,
    pickupNotes: carrier === 'purolator' ? 'FrontDesk' : null,
    pickupWindow: loc.pickup_window,
  });

  if (!pickupRes.success) {
    // Undo label purchase — void immediately to refund
    await v1Request('POST', '/shipments/voidlabel', { shipmentId: ghostShipmentId });
    return { success: false, step: 'book-pickup', error: pickupRes.error || pickupRes.body?.slice(0, 250), refunded: true };
  }

  // Step 3: record for later auto-void (after pickup window closes so UPS doesn't cancel the pickup)
  const voidAfter = new Date();
  voidAfter.setDate(voidAfter.getDate() + 2); // void on day after pickup
  voidAfter.setHours(12, 0, 0, 0);

  const pending = loadPending();
  pending.push({
    shipmentId: ghostShipmentId,
    labelId: `se-${ghostShipmentId}`,
    trackingNumber: ghostTracking,
    pickupId: pickupRes.pickupId,
    confirmation: pickupRes.confirmation,
    warehouseCode,
    carrier,
    pickupDate,
    labelCost,
    voidAfter: voidAfter.toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
  });
  savePending(pending);

  audit.log({
    action: 'ghost-pickup-create',
    warehouseCode, carrier,
    pickupId: pickupRes.pickupId,
    shipmentId: ghostShipmentId,
    trackingNumber: ghostTracking,
    labelCost,
    pickupDate,
    voidAfter: voidAfter.toISOString(),
    success: true,
  });

  return {
    success: true,
    pickupId: pickupRes.pickupId,
    confirmation: pickupRes.confirmation,
    trackingNumber: ghostTracking,
    pickupDate,
    voidAfter: voidAfter.toISOString(),
    labelCost,
  };
}

/**
 * Rescue an orphan ghost — a Mac-Roy-addressed label that exists in ShipStation
 * but isn't in the pending-voids ledger. Looks up the shipment by tracking
 * number, validates it's a ghost (shipTo.name matches GHOST_SHIP_TO_NAME),
 * and injects it into ghost-voids.json so it auto-voids on schedule.
 *
 * Use when `reconcileGhostLedger` can't see the orphan because there's no
 * `ghost-pickup-create` entry in audit.jsonl to correlate against.
 *
 * @param {Object} opts
 * @param {string} opts.trackingNumber     tracking # from ShipStation
 * @param {string} [opts.warehouseCode]    optional — if set, overrides auto-detection from shipFrom
 * @param {boolean} [opts.dryRun=false]    if true, return what would be written without writing
 * @returns {Promise<{success:bool, action:'added'|'already-pending'|'already-voided'|'not-a-ghost', ...}>}
 */
async function trackOrphanGhost({ trackingNumber, warehouseCode: overrideWh, dryRun = false } = {}) {
  if (!trackingNumber) return { success: false, error: 'trackingNumber required' };

  // Dedupe against existing pending
  const pending = loadPending();
  if (pending.find((p) => p.trackingNumber === trackingNumber && p.status === 'pending')) {
    return { success: true, action: 'already-pending', trackingNumber };
  }

  // Look up in SS V1 by tracking. V1 /shipments respects the tracking filter
  // (unlike V2 — per memory). Sort by create so we get the most recent if dupes.
  const res = await v1Request('GET', `/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}&sortBy=CreateDate&sortDir=DESC&pageSize=5`);
  if (res.status !== 200) return { success: false, error: `V1 lookup failed: HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  const data = JSON.parse(res.body);
  const shipments = (data.shipments || []).filter((s) => !s.voided);
  if (!shipments.length) return { success: false, error: `No non-voided shipment found for tracking ${trackingNumber}` };
  const s = shipments[0];

  // Validate it's actually a ghost (ship-to matches the ghost address)
  const ghostName = process.env.GHOST_SHIP_TO_NAME || 'Mac Roy';
  const shipToName = String(s.shipTo?.name || '').trim();
  if (shipToName.toLowerCase() !== ghostName.toLowerCase()) {
    return {
      success: false,
      action: 'not-a-ghost',
      error: `Tracking ${trackingNumber} is NOT a ghost (shipTo = "${shipToName}", expected "${ghostName}")`,
      shipTo: s.shipTo,
      shipmentId: s.shipmentId,
    };
  }

  // Resolve warehouse from override or ship-from address
  let warehouseCode = overrideWh || null;
  if (!warehouseCode) {
    const shipFromCity = String(s.shipFrom?.city || '').toLowerCase();
    const shipFromPostal = String(s.shipFrom?.postalCode || '').replace(/\s/g, '').toUpperCase();
    const loc = Object.values(LOCATION_MAP).find((l) =>
      (String(l.city || '').toLowerCase() === shipFromCity) ||
      (String(l.postal_code || '').replace(/\s/g, '').toUpperCase() === shipFromPostal)
    );
    warehouseCode = loc?.code || null;
  }

  // Normalize carrier: strip '_walleted'
  const carrier = String(s.carrierCode || '').replace(/_walleted$/, '') || 'unknown';

  // voidAfter: day after shipDate at 12:00 UTC (matches the pattern in
  // createGhostPickup). If shipDate missing, assume today + 2d.
  const shipDate = s.shipDate ? new Date(s.shipDate) : new Date();
  const voidAfter = new Date(shipDate);
  voidAfter.setDate(voidAfter.getDate() + 2);
  voidAfter.setUTCHours(12, 0, 0, 0);

  const entry = {
    shipmentId: s.shipmentId,
    labelId: `se-${s.shipmentId}`,
    trackingNumber: s.trackingNumber,
    pickupId: null,                 // unknown — we weren't there when the pickup was booked
    confirmation: null,
    warehouseCode,
    carrier,
    pickupDate: s.shipDate ? String(s.shipDate).slice(0, 10) : null,
    labelCost: Number(s.shipmentCost) || 0,
    voidAfter: voidAfter.toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    reconstructed: true,
    reconstructedAt: new Date().toISOString(),
  };

  if (dryRun) return { success: true, action: 'added', dryRun: true, entry };

  pending.push(entry);
  savePending(pending);

  audit.log({
    action: 'ghost-pickup-track-orphan',
    warehouseCode: entry.warehouseCode,
    carrier: entry.carrier,
    shipmentId: entry.shipmentId,
    trackingNumber: entry.trackingNumber,
    labelCost: entry.labelCost,
    voidAfter: entry.voidAfter,
    success: true,
    reconstructed: true,
  });

  return { success: true, action: 'added', entry };
}

/**
 * Walk the pending voids file; for any entry whose voidAfter <= now, attempt
 * to void via V1 voidlabel. On success, mark as voided (remove from file).
 * Called by daily cron.
 */
async function processPendingVoids() {
  const pending = loadPending();
  if (!pending.length) return { attempted: 0, voided: 0, remaining: 0, failures: 0 };
  const now = new Date();
  const still = [];
  const failures = [];
  let voided = 0;
  let attempted = 0;
  for (const entry of pending) {
    if (entry.status !== 'pending') continue;
    if (new Date(entry.voidAfter) > now) {
      still.push(entry);
      continue;
    }
    attempted++;
    try {
      const res = await v1Request('POST', '/shipments/voidlabel', { shipmentId: entry.shipmentId });
      const data = res.status === 200 ? JSON.parse(res.body) : null;
      if (data?.approved) {
        voided++;
        audit.log({ action: 'ghost-pickup-void', shipmentId: entry.shipmentId, trackingNumber: entry.trackingNumber, success: true, refundedCost: entry.labelCost });
      } else {
        // Keep in file; try again next day
        still.push(entry);
        const errMsg = data?.message || `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
        failures.push({ entry, error: errMsg });
        audit.log({ action: 'ghost-pickup-void', shipmentId: entry.shipmentId, success: false, error: errMsg });
      }
    } catch (err) {
      still.push(entry);
      failures.push({ entry, error: err.message });
      audit.log({ action: 'ghost-pickup-void', shipmentId: entry.shipmentId, success: false, error: err.message });
    }
  }
  savePending(still);

  if (voided > 0) {
    const refunded = pending.filter((e) => !still.find((s) => s.shipmentId === e.shipmentId)).reduce((sum, e) => sum + (Number(e.labelCost) || 0), 0);
    await telegram.notify('ok', `Ghost labels voided: ${voided}`, `Refunded ~$${refunded.toFixed(2)} to the wallet.`);
  }

  // Financial-risk alert: any void that failed today. Silent-retry is the enemy.
  if (failures.length > 0) {
    const withAge = failures.map((f) => {
      const due = new Date(f.entry.voidAfter);
      const daysOverdue = Math.max(0, Math.floor((now - due) / 86400000));
      return { ...f, daysOverdue };
    });
    const maxAge = withAge.reduce((m, f) => Math.max(m, f.daysOverdue), 0);
    const exposure = withAge.reduce((s, f) => s + (Number(f.entry.labelCost) || 0), 0);
    const sev = maxAge > 7 ? 'halt' : 'attn';
    const title = sev === 'halt'
      ? `🚨 Ghost void failing ${maxAge}d — $${exposure.toFixed(2)} at risk`
      : `Ghost void failures: ${failures.length} ($${exposure.toFixed(2)} at risk)`;
    const lines = withAge.map((f) => {
      const e = f.entry;
      return `• ${e.warehouseCode || '?'} ${e.carrier || '?'} — ship ${e.shipmentId} / track ${e.trackingNumber} — $${Number(e.labelCost || 0).toFixed(2)} — ${f.daysOverdue}d overdue\n  ${String(f.error).slice(0, 180)}`;
    });
    const body = lines.join('\n') + `\n\nTotal at-risk: $${exposure.toFixed(2)} across ${failures.length} label(s).`;
    await telegram.notify(sev, title, body);
  }

  return { attempted, voided, remaining: still.length, failures: failures.length };
}

/**
 * Snapshot of current outstanding ghost labels — count, exposure, oldest, per-entry detail.
 * Drives the daily digest line and the /ghosts Telegram command.
 */
function ghostStatus() {
  const pending = loadPending().filter((e) => e.status === 'pending');
  const now = Date.now();
  const entries = pending.map((e) => {
    const createdAt = e.createdAt || e.voidAfter || null;
    const voidAfter = e.voidAfter || null;
    const overdue = voidAfter ? Math.max(0, Math.floor((now - new Date(voidAfter).getTime()) / 86400000)) : 0;
    return {
      warehouseCode: e.warehouseCode || null,
      carrier: e.carrier || null,
      shipmentId: e.shipmentId,
      trackingNumber: e.trackingNumber,
      labelCost: Number(e.labelCost) || 0,
      pickupDate: e.pickupDate || null,
      createdAt,
      voidAfter,
      daysOverdue: overdue,
    };
  });
  entries.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const exposure = entries.reduce((s, e) => s + e.labelCost, 0);
  const oldest = entries[0] || null;
  const maxOverdue = entries.reduce((m, e) => Math.max(m, e.daysOverdue), 0);
  return {
    count: entries.length,
    exposure: Number(exposure.toFixed(2)),
    oldest,
    maxOverdue,
    entries,
  };
}

/**
 * Reconcile audit.jsonl against ghost-voids.json. Catches two disasters:
 *   - Orphans: audit records a ghost-pickup-create that never resolved to a
 *     successful void AND isn't in the pending file (state-file wipe/corruption).
 *   - Stale:   pending file still carries entries that audit says were
 *     already successfully voided (inconsistent save/crash window).
 * Called at server startup; alerts loudly via Telegram on mismatch.
 */
async function reconcileGhostLedger() {
  const auditPath = path.join(__dirname, '..', 'data', 'audit.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean); }
  catch { return { orphans: [], stale: [], outstanding: 0 }; }

  const created = new Map();            // trackingNumber → create entry (last wins if duplicate)
  const voidedTracking = new Set();     // trackingNumber that reached success
  const voidedShipment = new Set();     // shipmentId that reached success (older entries lacked tracking)
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.action) continue;
    if (e.action === 'ghost-pickup-create' && e.success) {
      const key = e.trackingNumber || (e.shipmentId ? `ship:${e.shipmentId}` : null);
      if (key) created.set(key, e);
    } else if (e.action === 'ghost-pickup-void' && e.success) {
      if (e.trackingNumber) voidedTracking.add(e.trackingNumber);
      if (e.shipmentId) voidedShipment.add(String(e.shipmentId));
    }
  }

  const pending = loadPending().filter((p) => p.status === 'pending');
  const pendingByTracking = new Set(pending.map((p) => p.trackingNumber));
  const pendingByShipment = new Set(pending.map((p) => String(p.shipmentId)));

  // Orphans: created, not voided, not in pending — state likely wiped.
  const orphans = [];
  for (const [key, entry] of created) {
    const tracking = entry.trackingNumber || null;
    const shipment = entry.shipmentId ? String(entry.shipmentId) : null;
    if (tracking && voidedTracking.has(tracking)) continue;
    if (shipment && voidedShipment.has(shipment)) continue;
    if (tracking && pendingByTracking.has(tracking)) continue;
    if (shipment && pendingByShipment.has(shipment)) continue;
    orphans.push({
      trackingNumber: tracking,
      shipmentId: entry.shipmentId || null,
      warehouseCode: entry.warehouseCode || null,
      carrier: entry.carrier || null,
      labelCost: Number(entry.labelCost) || 0,
      createdAt: entry.timestamp,
      voidAfter: entry.voidAfter || null,
    });
  }

  // Stale: pending says still-open, audit says voided — pending file out of sync.
  const stale = pending.filter((p) => voidedTracking.has(p.trackingNumber) || voidedShipment.has(String(p.shipmentId)));

  const result = { orphans, stale, outstanding: pending.length };

  if (orphans.length > 0 || stale.length > 0) {
    const exposure = orphans.reduce((s, o) => s + (o.labelCost || 0), 0);
    const titleBits = [];
    if (orphans.length) titleBits.push(`${orphans.length} orphan${orphans.length > 1 ? 's' : ''} ($${exposure.toFixed(2)})`);
    if (stale.length) titleBits.push(`${stale.length} stale`);
    const body = [];
    if (orphans.length) {
      body.push(`🚨 ORPHANS (ghost-pickup-create with no void, not in pending — likely wiped state file):`);
      for (const o of orphans.slice(0, 10)) {
        body.push(`  • ${o.warehouseCode || '?'}/${o.carrier || '?'} — ship ${o.shipmentId} / track ${o.trackingNumber} — $${o.labelCost.toFixed(2)} — created ${String(o.createdAt).slice(0, 10)}`);
      }
      if (orphans.length > 10) body.push(`  … and ${orphans.length - 10} more`);
    }
    if (stale.length) {
      body.push(`\nSTALE PENDING (audit says voided, pending file still has them):`);
      for (const s of stale.slice(0, 10)) body.push(`  • track ${s.trackingNumber} / ship ${s.shipmentId}`);
      if (stale.length > 10) body.push(`  … and ${stale.length - 10} more`);
    }
    await telegram.notify('halt', `Ghost ledger reconcile: ${titleBits.join(', ')}`, body.join('\n'));
  }

  return result;
}

module.exports = { createGhostPickup, trackOrphanGhost, processPendingVoids, loadPending, ghostStatus, reconcileGhostLedger };
