'use strict';
/**
 * Sample-order watchdog.
 *
 * Why this exists: sample lines carry no SKU, so the router drops them into
 * manual review and nothing downstream ever looks at them again. Order 1353 sat
 * five weeks and had a label bought three separate times without one reaching a
 * vendor. Nobody was alerted, because every existing watchdog keys off a label
 * or a warehouse and a sample order has neither.
 *
 * So this watches the ORDER, not the parcel, and asks one question: has this
 * moved since we last looked? It follows lib/stale-digest.js — name what is new,
 * collapse what is known to a count, go quiet when nothing changed, but never
 * fully silent (escalation marks + a reminder floor).
 *
 * Alerts go to email, not Telegram (Mac triages email). Prose, not glyph tables:
 * the import-watchdog's arrows and bracketed keys landed in Gmail spam 2026-09-22.
 *
 * It also closes the loop after shipping: a sample is a sales lead, so once UPS
 * shows a sample order delivered FOLLOWUP_DAYS ago, the same digest names the
 * customer to follow up with, once (Mac 2026-09-29 on #1400: "we'll have to be ON
 * this customer"). Deliveries older than FOLLOWUP_WINDOW_DAYS are logged, not
 * chased, so the first run doesn't dump every old sample on the desk.
 */
const fs = require('fs');
const path = require('path');
const { v1Request, v2Request } = require('./shipstation-v2');
const { isSampleItem, sampleOf } = require('./sample-item');

const STATE_FILE = path.join(__dirname, '..', 'data', 'sample-watch-state.json');
const ESCALATION_MARKS = [7, 14, 30];
const QUIET_REMINDER_HOURS = Number(process.env.SAMPLE_WATCH_QUIET_HOURS || 72);
// A sample with no vendor ask on record after this long is the 1353 failure.
const NO_ASK_DAYS = Number(process.env.SAMPLE_WATCH_NO_ASK_DAYS || 2);
// Vendor was asked but nothing has been bought since.
const NO_REPLY_DAYS = Number(process.env.SAMPLE_WATCH_NO_REPLY_DAYS || 4);
// Label exists but the carrier has never scanned the parcel.
const LABEL_IDLE_DAYS = Number(process.env.SAMPLE_WATCH_LABEL_IDLE_DAYS || 4);
// Every label is moving but the order is still open this long after pickup:
// nobody marked it shipped, or a second vendor's half has no tracking (#1374,
// Biyork, 2026-10-05).
const OPEN_AFTER_PICKUP_DAYS = Number(process.env.SAMPLE_WATCH_OPEN_AFTER_PICKUP_DAYS || 5);
// Follow up this many days after UPS shows the samples delivered...
const FOLLOWUP_DAYS = Number(process.env.SAMPLE_WATCH_FOLLOWUP_DAYS || 3);
// ...but not for deliveries older than this; those are recorded as skipped.
const FOLLOWUP_WINDOW_DAYS = Number(process.env.SAMPLE_WATCH_FOLLOWUP_WINDOW_DAYS || 14);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: {}, ledger: {}, followups: {}, lastSentAt: null }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

/** Record that a vendor was asked. Called by the ops scripts that send. */
function recordVendorAsk(orderNumbers, vendor, when = new Date()) {
  const s = loadState();
  for (const n of [].concat(orderNumbers)) {
    const e = (s.ledger[n] ||= {});
    (e.asks ||= []).push({ vendor, at: when.toISOString() });
  }
  saveState(s);
  return s;
}

const daysSince = (d, now = Date.now()) => Math.floor((new Date(now).getTime() - new Date(d).getTime()) / 86400000);
const shortDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver', month: 'short', day: 'numeric' });

// One shipments sweep for the last N days. Sample labels are standalone (no
// ShipStation order behind them), so callers match them to orders by surname.
async function recentShipments(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let page = 1, shipments = [];
  while (page <= 10) {
    const sr = await v1Request('GET', `/shipments?createDateStart=${since}&pageSize=500&page=${page}`);
    const sj = JSON.parse(sr.body);
    shipments = shipments.concat(sj.shipments || []);
    if (page >= (sj.pages || 1)) break;
    page++;
  }
  return shipments;
}

function labelsFor(order, shipments) {
  const surname = String(order.shipTo?.name || '').trim().split(/\s+/).pop().toLowerCase();
  if (surname.length <= 2) return [];
  return shipments.filter((s) => String(s.shipTo?.name || '').toLowerCase().includes(surname));
}

const carrierName = (code) => /canada_post/i.test(code) ? 'Canada Post'
  : /purolator/i.test(code) ? 'Purolator' : /ups/i.test(code) ? 'UPS' : 'the carrier';

// A scan means the parcel is physically with the carrier. UPS files its "Pickup
// Scan" under AC, the same code as "label created", so the code alone misses
// the pickup and the description has to settle it.
const SCAN_CODES = new Set(['IT', 'AT', 'DE', 'EX', 'SP']);
const SCAN_RE = /pickup scan|picked up|origin scan|dropped off|drop-off/i;

/** Read a V2 label track body: first scan and first delivery. Pure. */
function readTrack(j) {
  if (!j?.status_code) return { known: false, scanned: false, scannedAt: null, deliveredAt: null };
  const events = j.events || [];
  const code = (e) => String(e.status_code || '').toUpperCase();
  const first = (pred) => events.filter(pred).map((e) => e.occurred_at).filter(Boolean).sort()[0] || null;
  const top = String(j.status_code).toUpperCase();
  const deliveredAt = first((e) => code(e) === 'DE') || (top === 'DE' ? (j.actual_delivery_date || null) : null);
  const scannedAt = first((e) => SCAN_CODES.has(code(e)) || SCAN_RE.test(String(e.description || ''))) || deliveredAt;
  return { known: true, scanned: Boolean(scannedAt) || SCAN_CODES.has(top), scannedAt, deliveredAt };
}

/**
 * One label's carrier history. known:false means the lookup failed, which is
 * "we don't know", never "not picked up" (lib/stale-parcel-reminder.js learned
 * that from the 2026-09-29 Scarborough false alarm).
 */
async function trackLabel(shipmentId) {
  try {
    const t = await v2Request('GET', `/v2/labels/se-${shipmentId}/track`);
    return readTrack(t.status === 200 ? JSON.parse(t.body || '{}') : null);
  } catch { return readTrack(null); }
}

/**
 * Where one open sample order is stuck. Pure, so the rules are testable.
 * labels are the order's live labels, each carrying `track` from trackLabel().
 */
function stageFor({ age, asks = [], labels = [], now = Date.now() }) {
  const lastAsk = asks.length ? asks[asks.length - 1].at : null;
  if (!asks.length && age >= NO_ASK_DAYS) {
    return { stage: 'no-ask', detail: `no vendor has been asked, ${age} days after the order` };
  }
  // Idle means the carrier never touched it. A scanned label is moving, however
  // old it is; #1374's UPS half read "still not shipped" while in transit.
  const idle = labels.find((l) => !l.track?.scanned && daysSince(l.createDate, now) >= LABEL_IDLE_DAYS);
  if (idle) {
    const why = idle.track?.known ? `${carrierName(idle.carrierCode)} has not picked it up` : 'its tracking could not be read';
    return { stage: 'label-idle', detail: `label ${idle.trackingNumber} bought ${daysSince(idle.createDate, now)} days ago, and ${why}` };
  }
  if (labels.length && labels.every((l) => l.track?.scanned)) {
    const first = labels.map((l) => ({ l, at: l.track.scannedAt || l.createDate }))
      .sort((a, b) => new Date(a.at) - new Date(b.at))[0];
    if (daysSince(first.at, now) >= OPEN_AFTER_PICKUP_DAYS) {
      return { stage: 'open-after-pickup', detail: `${carrierName(first.l.carrierCode)} picked up ${first.l.trackingNumber} on ${shortDate(first.at)} but the order is still open. Mark it shipped, or chase whichever vendor still holds the rest` };
    }
  }
  if (asks.length && !labels.length && daysSince(lastAsk, now) >= NO_REPLY_DAYS) {
    return { stage: 'no-reply', detail: `vendor asked ${daysSince(lastAsk, now)} days ago, nothing bought since` };
  }
  return { stage: 'ok', detail: null };
}

/**
 * Pull every open sample order and work out where each one is stuck.
 * Live sources only, except the vendor-ask ledger which nothing else records.
 */
async function scanSamples({ state = loadState() } = {}) {
  const r = await v1Request('GET', '/orders?orderStatus=awaiting_shipment&pageSize=200');
  const orders = (JSON.parse(r.body).orders || []).filter((o) => (o.items || []).some(isSampleItem));
  if (!orders.length) return { orders: [] };

  const shipments = await recentShipments(90);

  const out = [];
  for (const o of orders) {
    // Same-surname labels from before this order belong to someone else's order.
    const labels = labelsFor(o, shipments).filter((s) => new Date(s.createDate) >= new Date(o.orderDate));
    const live = labels.filter((s) => !s.voided);
    const tracked = [];
    for (const s of live) tracked.push({ ...s, track: await trackLabel(s.shipmentId) });
    const asks = state.ledger?.[o.orderNumber]?.asks || [];
    const age = daysSince(o.orderDate);
    const { stage, detail } = stageFor({ age, asks, labels: tracked });

    out.push({
      order: o.orderNumber, orderId: o.orderId, age, stage, detail,
      customer: o.shipTo?.name, city: o.shipTo?.city, province: o.shipTo?.state,
      pieces: (o.items || []).filter(isSampleItem).map((i) => sampleOf(i) || 'unnamed sample'),
      voidedLabels: labels.length - live.length,
    });
  }
  return { orders: out };
}

/**
 * Shipped sample orders whose samples UPS shows delivered, not yet followed up.
 * Returns { followUps: [{ order, customer, email, ..., deliveredAt, stale }] }:
 * ready ones are FOLLOWUP_DAYS+ past delivery; stale ones are past the window.
 */
async function scanFollowUps({ state = loadState(), now = new Date() } = {}) {
  const since = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const r = await v1Request('GET', `/orders?orderStatus=shipped&modifyDateStart=${since}&pageSize=200`);
  const done = state.followups || {};
  const orders = (JSON.parse(r.body).orders || [])
    .filter((o) => (o.items || []).some(isSampleItem) && !done[o.orderNumber]);
  if (!orders.length) return { followUps: [] };

  const shipments = await recentShipments(45);
  const out = [];
  for (const o of orders) {
    const live = labelsFor(o, shipments).filter((s) => !s.voided && new Date(s.createDate) >= new Date(o.orderDate));
    let first = null;
    for (const s of live) {
      const d = (await trackLabel(s.shipmentId)).deliveredAt;
      if (d && (!first || d < first.at)) first = { at: d, tracking: s.trackingNumber };
    }
    if (!first) continue;
    const age = daysSince(first.at, now);
    if (age < FOLLOWUP_DAYS) continue;
    out.push({
      order: o.orderNumber, customer: o.shipTo?.name, email: o.customerEmail || null,
      city: o.shipTo?.city, province: o.shipTo?.state,
      pieces: (o.items || []).filter(isSampleItem).map((i) => sampleOf(i) || 'unnamed sample'),
      deliveredAt: first.at, tracking: first.tracking, stale: age > FOLLOWUP_WINDOW_DAYS,
    });
  }
  return { followUps: out };
}

/** Turn a scan into one digest. Pure: takes state and now, returns next state. */
function buildSampleDigest({ scan, followUps = [], state = loadState(), now = new Date() }) {
  const flagged = (scan.orders || []).filter((o) => o.stage !== 'ok');
  const ready = followUps.filter((f) => !f.stale);
  const followups = { ...(state.followups || {}) };
  for (const f of followUps) {
    followups[f.order] = f.stale
      ? { skipped: 'delivered before the follow-up window', deliveredAt: f.deliveredAt }
      : { sentAt: now.toISOString(), deliveredAt: f.deliveredAt };
  }
  const seen = { ...(state.seen || {}) };
  const isNew = [], escalated = [], known = [];

  for (const o of flagged) {
    const prev = seen[o.order];
    // Seed with the marks this order has ALREADY passed. Without this, an order
    // first seen at 34 days immediately "escalates" past 7/14/30 on the very next
    // run and alerts again an hour later, which is the wallpaper this avoids.
    const passed = ESCALATION_MARKS.filter((m) => o.age >= m);
    if (!prev) { isNew.push(o); seen[o.order] = { firstSeen: now.toISOString(), stage: o.stage, marks: passed }; continue; }
    if (prev.stage !== o.stage) { isNew.push(o); seen[o.order] = { ...prev, stage: o.stage, marks: passed }; continue; }
    const mark = ESCALATION_MARKS.filter((m) => o.age >= m).pop();
    if (mark && !prev.marks.includes(mark)) {
      escalated.push(o);
      seen[o.order] = { ...prev, marks: [...prev.marks, mark] };
    } else known.push(o);
  }
  for (const k of Object.keys(seen)) if (!flagged.some((o) => o.order === k)) delete seen[k];

  const hoursQuiet = state.lastSentAt ? (now - new Date(state.lastSentAt)) / 3600000 : Infinity;
  const shouldSend = Boolean(ready.length || isNew.length || escalated.length || (known.length && hoursQuiet >= QUIET_REMINDER_HOURS));
  const nextState = { ...state, seen, followups, ledger: state.ledger || {}, lastSentAt: shouldSend ? now.toISOString() : state.lastSentAt };
  if (!shouldSend) return { shouldSend: false, state: nextState };

  const line = (o) => {
    const what = o.pieces.length === 1 ? o.pieces[0] : `${o.pieces.length} samples`;
    return `Order ${o.order}, ${o.customer} in ${o.city} ${o.province}, ${what}. ${o.detail}.`
         + (o.voidedLabels ? ` ${o.voidedLabels} voided label${o.voidedLabels > 1 ? 's' : ''} already on this order.` : '');
  };

  const followLine = (f) => {
    const what = f.pieces.length === 1 ? `the ${f.pieces[0]} sample` : `${f.pieces.length} samples`;
    return `Order ${f.order}, ${f.customer} in ${f.city} ${f.province}${f.email ? ` (${f.email})` : ''}: ${what} delivered ${shortDate(f.deliveredAt)}. `
         + `Ask which ones they liked and whether they want a quote.`;
  };

  const parts = [];
  if (ready.length) parts.push(`Ready for a follow-up:\n\n${ready.map(followLine).join('\n\n')}`);
  if (isNew.length) parts.push(`Newly stuck:\n\n${isNew.map(line).join('\n\n')}`);
  if (escalated.length) parts.push(`Still stuck and now older:\n\n${escalated.map(line).join('\n\n')}`);
  if (known.length) parts.push(`${known.length} other sample order${known.length > 1 ? 's are' : ' is'} still waiting, unchanged since the last note.`);

  const stuck = isNew.length ? `${isNew.length} sample order${isNew.length > 1 ? 's need' : ' needs'} attention`
    : escalated.length ? `${escalated.length} sample order${escalated.length > 1 ? 's have' : ' has'} been waiting too long`
    : known.length ? `${known.length} sample order${known.length > 1 ? 's' : ''} still waiting` : '';
  const follow = ready.length ? `${ready.length} sample customer${ready.length > 1 ? 's' : ''} ready for a follow-up` : '';
  const headline = [follow, stuck].filter(Boolean).join(', ');
  const footer = flagged.length ? '\n\nStuck orders do not move on their own. Samples have no SKU, so the pipeline never picks them up.' : '';

  return {
    shouldSend: true,
    subject: `Sample orders: ${headline}`,
    body: `${parts.join('\n\n')}${footer}\n`,
    state: nextState,
    counts: { new: isNew.length, escalated: escalated.length, known: known.length, followUp: ready.length },
  };
}

module.exports = { scanSamples, scanFollowUps, buildSampleDigest, stageFor, readTrack, loadState, saveState, recordVendorAsk, ESCALATION_MARKS, QUIET_REMINDER_HOURS, FOLLOWUP_DAYS, FOLLOWUP_WINDOW_DAYS, OPEN_AFTER_PICKUP_DAYS };
