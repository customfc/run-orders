/**
 * What should happen now for one Coast pickup order (Sechelt Warehouse, Powell River): which customer email goes
 * out, when the order is marked ready in Shopify, when to ask the supplier about an earlier run, when to tell Mac.
 * Mac 2026-09-28: "if we got the stock in sechelt come get it baby, if not, order tracking"; "automation brah"
 * (nobody taps Ready by hand).
 *
 * Pure and runner-agnostic: no network, no files at call time, no clock reads (the caller passes `now`), never
 * sends anything. Project 01's handler (lib/local-orders.js) is the runner: it polls Shopify, keeps `state` per
 * order, calls planActions, performs each returned action, records its key in state.done, and calls again at
 * nextCheckAt or as soon as the state changes (a HOLD, SHORT or release reply, a supplier answer, a pickup).
 * Dates come from lib/pickup-eta.js, customer copy from lib/pickup-messages.js (a send_customer action carries
 * the ctx fields buildPickupMessage needs), times of day from "automation" in data/trade/pickup-schedule.json.
 *
 * BC time is UTC-7 all year: fixed offset, never America/Vancouver (see lib/pickup-eta.js). Every `at` and
 * nextCheckAt is an ISO time in BC wall time with its offset ('2026-10-20T11:00:00-07:00').
 *
 *   planActions({ order, state, now }, schedule?) -> { actions, nextCheckAt, status, eta, readyAt, warnings }
 *     order: { name, paidAt, location, lines, firstName?, cancelled?, pickedUpAt? }   (lines as for pickupEta)
 *     state: { done: { <key>: iso }, holds: [{ at, by, note }], releasedAt, shorts: [{ truckDay, at }],
 *              supplierConfirmed: true | false | null, markedReadyAt, pickedUpAt }       (all optional)
 *     now:   ISO time (a wall time without a zone is BC time)
 *   Each action is { key, type, at, ...payload }. key is `${order.name}:<what>[:<date or reason>]`, the same on
 *   every call, so the runner is idempotent through state.done:
 *     send_customer             message: ordering_in | on_truck | delayed | reminder_1 | reminder_2 |
 *                               received_in_stock (only with schedule.notify.received_in_stock === true), plus
 *                               orderName, firstName, location and the dates the message needs
 *     supplier_confirm_request  paid after the confirm time on the cutoff day: can it still make the earlier run?
 *     mark_ready                runner calls fulfillmentOrderLineItemsPreparedForPickup (Shopify emails "Ready")
 *     escalate                  to Mac: ready and not collected after N business days, or SHORT on a shelf order
 *   Only due actions (at <= now) not in state.done are returned, again on every call until recorded.
 *   status (dashboards): awaiting_supplier_confirm, ordered_in, on_truck, delayed, preparing (on the shelf, not
 *   marked ready yet), held, ready, picked_up, cancelled.
 *   eta.shortDay is the day a SHORT reply is recorded against (state.shorts[].truckDay).
 *
 *   digestFor({ orders, states, date }, schedule?)  the warehouse's list for one business day, with plain text
 *
 * Rules (tested):
 *   - A hold (a holds[] entry with no releasedAt after it) stops everything for the order until released. A
 *     mark_ready that fell due while held becomes due at the release, moved into business hours.
 *   - A short recorded for the order's current truck day (or its supplier run day) moves the order to
 *     delayedEta(); the customer gets one delayed email per short that moves their date; repeated shorts chain.
 *   - Customer emails about the trip in are dropped once they are stale: ordering_in once on_truck is due,
 *     on_truck after its truck day, all of them once the order is due to be marked ready; reminder_1 once
 *     reminder_2 is due; a delayed email when a later short replaced it or the customer never got ordering_in.
 *   - Reminders and the pickup escalation count from the day the order was really marked ready.
 */

'use strict';

const eta = require('./pickup-eta');

const AUTOMATION_DEFAULTS = Object.freeze({
  on_truck_time: '11:00',
  ready_time: '09:00',
  ready_now_delay_minutes: 120,
  business_hours: Object.freeze({ open: '08:00', close: '16:00' }),
  reminder_time: '10:00',
  escalate_after_business_days: 10,
});
const STATUSES = ['awaiting_supplier_confirm', 'ordered_in', 'on_truck', 'delayed', 'preparing', 'held', 'ready', 'picked_up', 'cancelled'];
const TYPE_ORDER = ['escalate', 'supplier_confirm_request', 'send_customer', 'mark_ready'];
const MIN_MS = 6e4;
const HOUR_MS = 3600e3;
const DAY_MS = 864e5;

const pad = (n) => String(n).padStart(2, '0');

function hhmm(s, what) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`pickup automation: ${what} must be HH:MM, got ${JSON.stringify(s)}`);
  return +m[1] * 60 + +m[2];
}

/** The automation settings with defaults filled, times as minutes after midnight BC. Throws on a bad value. */
function automationSettings(schedule = eta.DEFAULT_SCHEDULE) {
  const a = { ...AUTOMATION_DEFAULTS, ...((schedule && schedule.automation) || {}) };
  const bh = { ...AUTOMATION_DEFAULTS.business_hours, ...(a.business_hours || {}) };
  const s = {
    onTruck: hhmm(a.on_truck_time, 'automation.on_truck_time'),
    ready: hhmm(a.ready_time, 'automation.ready_time'),
    reminder: hhmm(a.reminder_time, 'automation.reminder_time'),
    open: hhmm(bh.open, 'automation.business_hours.open'),
    close: hhmm(bh.close, 'automation.business_hours.close'),
    readyNowDelay: a.ready_now_delay_minutes,
    escalateAfter: a.escalate_after_business_days,
    notifyReceivedInStock: !!(schedule && schedule.notify && schedule.notify.received_in_stock === true),
  };
  if (!Number.isInteger(s.readyNowDelay) || s.readyNowDelay < 0) throw new Error('pickup automation: ready_now_delay_minutes must be a whole number >= 0');
  if (!Number.isInteger(s.escalateAfter) || s.escalateAfter < 1) throw new Error('pickup automation: escalate_after_business_days must be a whole number >= 1');
  if (s.open >= s.close) throw new Error('pickup automation: business_hours.open must be before close');
  return s;
}

// ---- time: epoch ms inside, BC wall time (fixed offset) outside ----

/** Epoch ms of an ISO time with a zone, a BC wall time without one ('2026-10-19T10:00'), a Date or epoch ms. */
function toMs(input, off, what) {
  let ms = NaN;
  if (input instanceof Date) ms = input.getTime();
  else if (typeof input === 'number') ms = input;
  else if (typeof input === 'string') {
    const s = input.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`) {
      ms = m[5] ? Date.parse(s.replace(' ', 'T')) : Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}Z`) - off * HOUR_MS;
    }
  }
  if (!Number.isFinite(ms)) throw new Error(`${what} must be a time with a date and a time of day, got ${JSON.stringify(input)}`);
  return ms;
}

/** BC wall time of a moment: { date: 'YYYY-MM-DD', minutes, msOfDay }. */
function wall(ms, off) {
  const local = ms + off * HOUR_MS;
  const msOfDay = ((local % DAY_MS) + DAY_MS) % DAY_MS;
  return { date: new Date(local).toISOString().slice(0, 10), minutes: Math.floor(msOfDay / MIN_MS), msOfDay };
}

/** '2026-10-20T11:00:00-07:00' */
function bcIso(ms, off) {
  const zone = `${off < 0 ? '-' : '+'}${pad(Math.abs(off))}:00`;
  return `${new Date(ms + off * HOUR_MS).toISOString().slice(0, 19)}${zone}`;
}

/** Epoch ms of a BC date at minutes after midnight. */
const atBc = (date, minutes, off) => Date.parse(`${date}T00:00:00Z`) + minutes * MIN_MS - off * HOUR_MS;

/** Into business hours: before open moves to open, at or after close (or a closed day) to the next business day at open. */
function clipToHours(ms, auto, schedule) {
  const off = schedule.utc_offset_hours;
  const w = wall(ms, off);
  if (!eta.isBusinessDay(w.date, schedule) || w.msOfDay >= auto.close * MIN_MS) return atBc(eta.addBusinessDays(w.date, 1, schedule), auto.open, off);
  if (w.msOfDay < auto.open * MIN_MS) return atBc(w.date, auto.open, off);
  return ms;
}

/** Business days after `from` up to and including `to`. */
function businessDaysBetween(from, to, schedule) {
  let n = 0;
  for (let d = from; d < to && n < 366;) {
    d = eta.addBusinessDays(d, 1, schedule);
    if (d <= to) n++;
  }
  return n;
}

const clock12 = (minutes) => {
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}:${pad(minutes % 60)} ${h < 12 ? 'am' : 'pm'}`;
};

// ---- state ----

/** { active, latest, releasedMs }: a hold is active when no release came after the latest hold. */
function holdOf(st, off) {
  const holds = (Array.isArray(st.holds) ? st.holds : []).filter(Boolean)
    .map((h) => ({ ...h, atMs: h.at ? toMs(h.at, off, 'state.holds[].at') : 0 }));
  const releasedMs = st.releasedAt ? toMs(st.releasedAt, off, 'state.releasedAt') : null;
  if (!holds.length) return { active: false, latest: null, releasedMs };
  const latest = holds.reduce((a, b) => (b.atMs >= a.atMs ? b : a));
  return { active: releasedMs == null || latest.atMs > releasedMs, latest, releasedMs };
}

const availabilityOf = (l) => (typeof l === 'string' ? l : l && l.availability);

/**
 * The dates the order runs on now: promised by pickupEta, earlier if the supplier confirmed the tentative run,
 * later for every short recorded against the current truck day or supplier run day (chained).
 */
function effectiveEta(base, order, st, markedMs, off, schedule, warnings) {
  const loc = schedule.locations[order.location];
  let cur = { truckDay: base.truckDay, readyBy: base.readyBy, supplierRunDay: base.supplierRunDay || null };
  let confirm = null;
  if (base.needsConfirm) {
    // The supplier run the confirmation is about. For Powell River pickupEta reports the Thursday truck, so ask
    // the same question for the Sechelt leg.
    const src = loc.via
      ? eta.pickupEta({ paidAt: order.paidAt, location: loc.via.from, lines: order.lines.map((l) => (availabilityOf(l) === 'order_in' ? 'order_in' : 'on_shelf')) }, schedule)
      : base;
    const answer = st.supplierConfirmed === true ? true : st.supplierConfirmed === false ? false : null;
    confirm = {
      runDay: src.tentativeTruckDay,
      promisedRunDay: base.supplierRunDay,
      truckDay: base.tentativeTruckDay,
      readyBy: base.readyByIfConfirmed,
      // Powell River paid Thursday after 14:00: the earlier run still misses the Thursday truck, nothing to gain.
      worthAsking: !!base.readyByIfConfirmed,
      answer,
    };
    if (answer === true) cur = { truckDay: base.tentativeTruckDay || base.truckDay, readyBy: base.readyByIfConfirmed || base.readyBy, supplierRunDay: src.tentativeTruckDay };
  }

  const shorts = (Array.isArray(st.shorts) ? st.shorts : []).filter(Boolean).map((s, i) => ({
    i, truckDay: s.truckDay, atMs: s.at ? toMs(s.at, off, 'state.shorts[].at') : atBc(s.truckDay, 0, off),
  }));
  const used = new Set();
  const steps = [];
  for (const s of shorts) {
    if (markedMs != null && s.atMs >= markedMs) {
      used.add(s.i);
      warnings.push(`SHORT for ${s.truckDay} was recorded after ${order.name} was marked ready; ignored, handle it by hand [MAC]`);
    }
  }
  for (let n = 0; n <= shorts.length; n++) {
    const s = shorts.find((x) => !used.has(x.i) && (x.truckDay === cur.truckDay || (cur.supplierRunDay && x.truckDay === cur.supplierRunDay)));
    if (!s) break;
    used.add(s.i);
    const d = eta.delayedEta({ missedTruckDay: s.truckDay, location: order.location }, schedule);
    warnings.push(...d.warnings);
    const changed = d.readyBy > cur.readyBy;
    steps.push({ missedTruckDay: cur.truckDay, missedRunDay: s.truckDay, truckDay: changed ? d.truckDay : cur.truckDay, readyBy: changed ? d.readyBy : cur.readyBy, atMs: s.atMs, changed });
    cur = changed ? { truckDay: d.truckDay, readyBy: d.readyBy, supplierRunDay: d.supplierRunDay } : { ...cur, supplierRunDay: d.supplierRunDay };
  }
  for (const s of shorts) {
    if (!used.has(s.i)) warnings.push(`SHORT for ${s.truckDay} does not match ${order.name}'s truck day ${cur.truckDay}${cur.supplierRunDay && cur.supplierRunDay !== cur.truckDay ? ` or supplier run ${cur.supplierRunDay}` : ''}; ignored`);
  }
  return { cur, confirm, steps };
}

// ---- the plan ----

/** Everything planActions and digestFor need: every candidate action (due or not), the dates, the status. */
function plan({ order, state, now } = {}, schedule = eta.DEFAULT_SCHEDULE) {
  if (!order || typeof order !== 'object') throw new Error('planActions: order is required');
  const name = String(order.name == null ? '' : order.name).trim();
  if (!name) throw new Error('planActions: order.name is required');
  const errs = eta.validateSchedule(schedule);
  if (errs.length) throw new Error(`pickup schedule is invalid: ${errs.join('; ')}`);
  const auto = automationSettings(schedule);
  const off = schedule.utc_offset_hours;
  const nowMs = toMs(now, off, 'now');
  const today = wall(nowMs, off).date;
  const st = state && typeof state === 'object' ? state : {};
  const done = st.done && typeof st.done === 'object' ? st.done : {};
  const key = (what, qualifier) => `${name}:${what}${qualifier ? `:${qualifier}` : ''}`;
  const p = {
    name, order, schedule, off, nowMs, today, done, entries: [], status: null, eff: null, hold: holdOf(st, off),
    markedMs: null, readyDate: null, markEntry: null, shelfShort: null, warnings: [],
  };
  if (order.cancelled || order.cancelledAt) { p.status = 'cancelled'; return p; }
  if (order.pickedUpAt || st.pickedUpAt) { p.status = 'picked_up'; return p; }

  const base = eta.pickupEta({ paidAt: order.paidAt, location: order.location, lines: order.lines }, schedule);
  p.warnings.push(...base.warnings);
  const loc = schedule.locations[order.location];
  const paidMs = toMs(order.paidAt, off, 'order.paidAt');
  const markKey = key('mark_ready');
  const markedRaw = st.markedReadyAt || done[markKey] || null;
  const markedMs = markedRaw ? toMs(markedRaw, off, 'state.markedReadyAt') : null;
  p.markedMs = markedMs;
  const hold = p.hold;
  const ctx = { orderName: name, ...(order.firstName ? { firstName: order.firstName } : {}), location: order.location };
  const add = (e) => { p.entries.push(e); return e; };
  // A mark_ready that fell due while the order was held becomes due at the release (in business hours).
  const afterRelease = (ms) => (hold.latest && !hold.active && hold.releasedMs > ms ? clipToHours(hold.releasedMs, auto, schedule) : ms);
  const markPayload = (readyBy) => ({ location: order.location, shopifyLocationId: loc.shopify_location_id || null, readyBy });

  if (base.kind === 'ready_now') {
    p.eff = { kind: 'ready_now', readyBy: base.readyBy, truckDay: null, supplierRunDay: null, promisedReadyBy: base.readyBy, promisedTruckDay: null, confirm: null, steps: [] };
    const shorts = (Array.isArray(st.shorts) ? st.shorts : []).filter(Boolean)
      .map((s) => ({ ...s, atMs: s.at ? toMs(s.at, off, 'state.shorts[].at') : paidMs }))
      .filter((s) => markedMs == null || s.atMs < markedMs)
      .sort((a, b) => a.atMs - b.atMs);
    if (markedMs == null && shorts.length) {
      // Sold off the shelf but the warehouse says it is not there: no Ready email, Mac decides.
      p.shelfShort = { atMs: shorts[0].atMs };
      p.eff.readyBy = null;
      add({
        key: key('escalate', 'shelf_short'), type: 'escalate', atMs: shorts[0].atMs,
        payload: { to: 'mac', reason: 'shelf_short', location: order.location, note: `Order ${name} was sold as on the shelf at ${loc.name}, but the warehouse replied SHORT. It is not marked ready and the customer has not been told anything yet.` },
      });
    } else if (markedMs == null) {
      const scheduled = Math.max(clipToHours(paidMs + auto.readyNowDelay * MIN_MS, auto, schedule), atBc(base.readyBy, auto.open, off));
      const at = afterRelease(scheduled);
      const readyBy = wall(at, off).date;
      if (readyBy > base.readyBy) p.warnings.push(`ready ${readyBy} by the automation hours, later than pickupEta's ${base.readyBy}: align store.same_day_cutoff with automation.business_hours [MAC]`);
      p.eff.readyBy = readyBy;
      if (auto.notifyReceivedInStock) {
        add({ key: key('received_in_stock'), type: 'send_customer', message: 'received_in_stock', atMs: paidMs, dropped: nowMs >= at, payload: { ...ctx, readyBy, today: wall(paidMs, off).date } });
      }
      p.markEntry = add({ key: markKey, type: 'mark_ready', atMs: at, payload: markPayload(readyBy) });
    }
  } else {
    const e = effectiveEta(base, order, st, markedMs, off, schedule, p.warnings);
    const cur = e.cur;
    p.eff = { kind: 'order_in', ...cur, promisedReadyBy: base.readyBy, promisedTruckDay: base.truckDay, confirm: e.confirm, steps: e.steps };
    if (markedMs == null) {
      const onTruckAt = atBc(cur.truckDay, auto.onTruck, off);
      const markAt = afterRelease(atBc(cur.readyBy, auto.ready, off));
      const readyDue = nowMs >= markAt;
      const hereOnShelf = (a) => a === 'on_shelf' || (a === 'at_sechelt' && !loc.via);
      const orderingKey = key('ordering_in');
      add({
        key: orderingKey, type: 'send_customer', message: 'ordering_in', atMs: paidMs, dropped: readyDue || nowMs >= onTruckAt,
        payload: { ...ctx, truckDay: cur.truckDay, readyBy: cur.readyBy, partial: order.lines.some((l) => hereOnShelf(availabilityOf(l))) },
      });
      if (e.confirm && e.confirm.worthAsking) {
        const c = e.confirm;
        const fmt = eta.formatCustomerDate;
        add({
          key: key('supplier_confirm_request'), type: 'supplier_confirm_request', atMs: paidMs,
          dropped: c.answer !== null || today > c.runDay || readyDue,
          payload: {
            location: order.location, supplierRunDay: c.runDay, promisedRunDay: c.promisedRunDay,
            truckDayIfConfirmed: c.truckDay, readyByIfConfirmed: c.readyBy, promisedReadyBy: base.readyBy,
            note: `Order ${name} was paid after ${schedule.truck.confirm_after_time} on the cutoff day. Ask the supplier whether it can still make the ${fmt(c.runDay)} run. If yes, it is ready ${fmt(c.readyBy)} at ${loc.name}; if not, ${fmt(base.readyBy)} as promised.`,
          },
        });
      }
      const moved = e.steps.filter((s) => s.changed);
      moved.forEach((s, i) => add({
        key: key('delayed', s.missedTruckDay), type: 'send_customer', message: 'delayed', atMs: s.atMs,
        dropped: readyDue || i < moved.length - 1 || !done[orderingKey],
        payload: { ...ctx, missedTruckDay: s.missedTruckDay, truckDay: s.truckDay, readyBy: s.readyBy },
      }));
      add({
        key: key('on_truck', cur.truckDay), type: 'send_customer', message: 'on_truck', atMs: onTruckAt,
        dropped: today > cur.truckDay || readyDue, payload: { ...ctx, truckDay: cur.truckDay, readyBy: cur.readyBy },
      });
      p.markEntry = add({ key: markKey, type: 'mark_ready', atMs: markAt, payload: markPayload(cur.readyBy) });
    }
  }

  if (markedMs != null) {
    const readyDate = wall(markedMs, off).date;
    p.readyDate = readyDate;
    const r = eta.reminderDates(readyDate, schedule);
    const r2At = atBc(r.second, auto.reminder, off);
    add({ key: key('reminder_1'), type: 'send_customer', message: 'reminder_1', atMs: atBc(r.first, auto.reminder, off), dropped: nowMs >= r2At || !!done[key('reminder_2')], payload: { ...ctx, readySince: readyDate } });
    add({ key: key('reminder_2'), type: 'send_customer', message: 'reminder_2', atMs: r2At, payload: { ...ctx, readySince: readyDate } });
    const escDay = eta.addBusinessDays(readyDate, auto.escalateAfter, schedule);
    add({
      key: key('escalate', 'not_picked_up'), type: 'escalate', atMs: atBc(escDay, auto.reminder, off),
      payload: {
        to: 'mac', reason: 'not_picked_up', location: order.location, readySince: readyDate, businessDays: auto.escalateAfter,
        note: `Order ${name} has been ready for pickup at ${loc.name} since ${eta.formatCustomerDate(readyDate)} and has not been picked up after ${auto.escalateAfter} business days.`,
      },
    });
  }

  const eff = p.eff;
  const c = eff.confirm;
  if (hold.active) p.status = 'held';
  else if (markedMs != null) p.status = 'ready';
  else if (p.shelfShort) p.status = 'held';
  else if (eff.kind === 'ready_now') p.status = 'preparing';
  else if (c && c.worthAsking && c.answer === null && !eff.steps.length && today <= c.runDay) p.status = 'awaiting_supplier_confirm';
  else if (eff.steps.some((s) => s.changed) && today < eff.truckDay) p.status = 'delayed';
  else if (today >= eff.truckDay) p.status = 'on_truck';
  else p.status = 'ordered_in';
  return p;
}

const byTimeThenType = (a, b) => a.atMs - b.atMs || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);

/**
 * The actions due now for one order, and when to look again. See the header for the shapes.
 */
function planActions(input = {}, schedule = eta.DEFAULT_SCHEDULE) {
  const p = plan(input, schedule);
  const off = p.off;
  const live = p.hold.active ? [] : p.entries.filter((e) => !p.done[e.key] && !e.dropped);
  const due = live.filter((e) => e.atMs <= p.nowMs).sort(byTimeThenType);
  const later = live.filter((e) => e.atMs > p.nowMs).map((e) => e.atMs);
  const eff = p.eff;
  return {
    actions: due.map((e) => ({ key: e.key, type: e.type, at: bcIso(e.atMs, off), ...(e.message ? { message: e.message } : {}), ...e.payload })),
    nextCheckAt: later.length ? bcIso(Math.min(...later), off) : null,
    status: p.status,
    eta: eff && {
      kind: eff.kind,
      readyBy: eff.readyBy,
      truckDay: eff.truckDay,
      supplierRunDay: eff.supplierRunDay,
      shortDay: eff.supplierRunDay || eff.truckDay,
      promisedReadyBy: eff.promisedReadyBy,
      promisedTruckDay: eff.promisedTruckDay,
      supplierConfirm: eff.confirm && eff.confirm.worthAsking
        ? { runDay: eff.confirm.runDay, readyByIfConfirmed: eff.confirm.readyBy, answer: eff.confirm.answer }
        : null,
      delays: eff.steps.filter((s) => s.changed).map((s) => ({ missedTruckDay: s.missedTruckDay, truckDay: s.truckDay, readyBy: s.readyBy, at: bcIso(s.atMs, off) })),
    },
    readyAt: p.markedMs != null ? bcIso(p.markedMs, off) : p.markEntry ? bcIso(p.markEntry.atMs, off) : null,
    warnings: p.warnings,
  };
}

// ---- the warehouse digest ----

/** Free text from a reply (a hold note) made safe for the digest: no dashes, arrows or the supplier's name. */
function cleanNote(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/\s*[—–]\s*/g, ', ').replace(/\s*(->|=>|→)\s*/g, ' to ')
    .replace(/prosol/gi, 'the supplier').replace(/[[\]<>]/g, '').trim();
}

/** Problems in the digest text ([] when clean). */
function digestTextProblems(text) {
  const t = String(text || '');
  const out = [];
  if (/[—–]/.test(t)) out.push('dash');
  if (/->|=>|→/.test(t)) out.push('arrow');
  if (/[[\]<>{}]/.test(t)) out.push('bracket');
  if (/prosol/i.test(t)) out.push('names the distributor');
  return out;
}

function renderDigest(d) {
  const fmt = eta.formatCustomerDate;
  const lines = [`Pickup orders for ${fmt(d.date)}.`];
  const section = (title, items, line) => {
    if (!items.length) return;
    lines.push('', title, ...items.map(line));
  };
  section('Marked ready automatically today. Shopify emails each customer when it happens.', d.autoReadyToday, (x) =>
    `${x.order} at ${x.locationName} ${x.done ? 'was' : 'is'} marked ready at ${x.time12}.`);
  section('On the truck today.', d.onTruckToday, (x) => (x.leg === 'transfer_truck'
    ? `${x.order} goes on today's truck to ${x.locationName}.`
    : `${x.order} for ${x.locationName} comes in on today's supplier run${x.truckDay !== d.date ? ` and goes on the ${fmt(x.truckDay)} truck` : ''}.`));
  section('Waiting for pickup.', d.waitingForPickup, (x) =>
    `${x.order} at ${x.locationName}: ready since ${fmt(x.readySince)}, waiting ${x.businessDaysWaiting} business day${x.businessDaysWaiting === 1 ? '' : 's'}.`);
  section('On hold. Nothing goes out for these until someone releases them.', d.held, (x) =>
    `${x.order} at ${x.locationName}, held${x.by ? ` by ${cleanNote(x.by)}` : ''} since ${fmt(x.sinceDate)}${x.note ? `: ${cleanNote(x.note).replace(/[.]$/, '')}` : ''}.`);
  section('Came up short.', d.shorted, (x) => (x.kind === 'shelf'
    ? `${x.order} at ${x.locationName} was not on the shelf. It is not marked ready and has gone to Mac.`
    : `${x.order} for ${x.locationName} did not come in for the ${fmt(x.missedTruckDay)} truck. It is now on the ${fmt(x.truckDay)} truck, ready ${fmt(x.readyBy)}.`));
  section('Waiting for the supplier to confirm an earlier run.', d.needsSupplierConfirm, (x) =>
    `${x.order} for ${x.locationName} can make the ${fmt(x.runDay)} run if the supplier confirms, and then it is ready ${fmt(x.readyByIfConfirmed)}. If not, it is ready ${fmt(x.promisedReadyBy)}.`);
  section('Could not be planned. These need a look.', d.errors, (x) => `${x.order || 'An order'} could not be planned automatically.`);

  const listed = ['autoReadyToday', 'onTruckToday', 'waitingForPickup', 'held', 'shorted', 'needsSupplierConfirm'].flatMap((k) => d[k]);
  if (!listed.length && !d.errors.length) return `${lines[0]}\n\nNothing needs anything today.\n`;
  const ex = (listed[0] && listed[0].order) || '#1500';
  lines.push(
    '',
    'All of this runs on its own. Replying HOLD or SHORT with an order number stops the automation for that order.',
    `HOLD, for example HOLD ${ex}, pauses it until someone releases it.`,
    `SHORT, for example SHORT ${ex}, means the truck did not bring it: the order moves to the next run and the customer gets the new date. For an order that was on the shelf, SHORT means it was not there, and it goes to Mac.`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The warehouse's list for one business day: marked ready automatically today, on the truck today, waiting for
 * pickup (with business days waiting), held, short, and waiting for a supplier confirmation. `states` is keyed
 * by order name, or an array in the same order as `orders`. `now` defaults to the start of the day (BC).
 * Returns the lists, a subject and plain text. An order that cannot be planned is listed under errors.
 */
function digestFor({ orders = [], states = {}, date, now } = {}, schedule = eta.DEFAULT_SCHEDULE) {
  const title = eta.formatCustomerDate(date); // throws on a bad date
  const off = schedule.utc_offset_hours;
  const at = now || `${date}T00:00`;
  const d = { date, subject: `Pickup orders for ${title}`, autoReadyToday: [], onTruckToday: [], waitingForPickup: [], held: [], shorted: [], needsSupplierConfirm: [], errors: [], text: '' };
  (orders || []).forEach((order, i) => {
    const state = Array.isArray(states) ? states[i] : (states || {})[order && order.name];
    let p;
    try {
      p = plan({ order, state, now: at }, schedule);
    } catch (e) {
      d.errors.push({ order: order && order.name ? String(order.name) : null, error: e.message });
      return;
    }
    if (p.status === 'cancelled' || p.status === 'picked_up') return;
    const loc = schedule.locations[order.location];
    const item = { order: p.name, location: order.location, locationName: loc.name, status: p.status };
    const eff = p.eff;

    if (p.status === 'held') {
      if (p.hold.active) {
        const h = p.hold.latest;
        d.held.push({ ...item, since: bcIso(h.atMs, off), sinceDate: wall(h.atMs, off).date, by: h.by || null, note: h.note || null });
      } else if (p.shelfShort) {
        d.shorted.push({ ...item, kind: 'shelf', at: bcIso(p.shelfShort.atMs, off) });
      }
      return;
    }
    const markMs = p.markedMs != null ? p.markedMs : p.markEntry ? p.markEntry.atMs : null;
    if (markMs != null && wall(markMs, off).date === date) {
      const w = wall(markMs, off);
      d.autoReadyToday.push({ ...item, at: bcIso(markMs, off), time: `${pad(Math.floor(w.minutes / 60))}:${pad(w.minutes % 60)}`, time12: clock12(w.minutes), done: p.markedMs != null });
    }
    if (p.status === 'ready' && p.readyDate < date) {
      d.waitingForPickup.push({ ...item, readySince: p.readyDate, businessDaysWaiting: businessDaysBetween(p.readyDate, date, schedule) });
    }
    if (eff && eff.kind === 'order_in' && p.status !== 'ready' && (eff.truckDay === date || eff.supplierRunDay === date)) {
      d.onTruckToday.push({ ...item, leg: loc.via && eff.truckDay === date ? 'transfer_truck' : 'supplier_run', truckDay: eff.truckDay, readyBy: eff.readyBy });
    }
    if (p.status === 'delayed') {
      const last = eff.steps.filter((s) => s.changed).pop();
      d.shorted.push({ ...item, kind: 'truck', missedTruckDay: last.missedTruckDay, truckDay: eff.truckDay, readyBy: eff.readyBy });
    }
    if (p.status === 'awaiting_supplier_confirm') {
      d.needsSupplierConfirm.push({ ...item, runDay: eff.confirm.runDay, readyByIfConfirmed: eff.confirm.readyBy, promisedReadyBy: eff.promisedReadyBy });
    }
  });
  d.autoReadyToday.sort((a, b) => a.at.localeCompare(b.at) || a.order.localeCompare(b.order));
  d.waitingForPickup.sort((a, b) => b.businessDaysWaiting - a.businessDaysWaiting || a.order.localeCompare(b.order));
  d.text = renderDigest(d);
  const problems = digestTextProblems(d.text);
  if (problems.length) throw new Error(`pickup digest text: ${problems.join(', ')}`);
  return d;
}

module.exports = {
  AUTOMATION_DEFAULTS,
  STATUSES,
  automationSettings,
  planActions,
  digestFor,
  digestTextProblems,
};
