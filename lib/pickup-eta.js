/**
 * Pickup ETA for Coast pickup orders (Sechelt Warehouse, Powell River): is it ready now, or does it ride the
 * supplier truck, and on which day will it be ready?
 *
 * Pure: no network, no files at call time, no clock reads (the caller passes the paid time). The default
 * schedule is data/trade/pickup-schedule.json (static data, required once); pass another as the last argument.
 * Built for project 01's pickup handler (lib/local-orders.js) to import; it decides nothing about labels or POs.
 *
 * BC time is UTC-7 all year (permanent daylight time from 2026-03-08). Every date here is plain calendar math on
 * 'YYYY-MM-DD' strings in UTC with a fixed -7 offset, so a stale tz database (laptop 2026a, Mini 2025c, both still
 * falling back on 2026-11-01) cannot shift a date. Never America/Vancouver.
 *
 *   pickupEta({ paidAt, location, lines })   -> { kind, readyBy, truckDay, cutoff, reason, ... }
 *       paidAt: ISO with a zone ('2026-10-19T17:00:00Z', '...-07:00'), an ISO wall time without a zone (taken as
 *               BC time), a Date or epoch ms
 *       location: 'sechelt' | 'powell_river'
 *       lines: availability per line at that location: 'on_shelf' | 'order_in', or { availability } objects.
 *              Any order_in line makes the whole order order_in.
 *   delayedEta({ missedTruckDay, location })  the run did not bring it: the next run and the new readyBy
 *   reminderDates(readyBy)                    { first, second } business days after the ready date
 *   formatCustomerDate('2026-10-02')          'Friday, October 2'
 */

'use strict';

const DEFAULT_SCHEDULE = require('../data/trade/pickup-schedule.json');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AVAILABILITY = ['on_shelf', 'order_in'];
const DAY_MS = 864e5;
const SEARCH_DAYS = 60;

// ---- calendar math on 'YYYY-MM-DD' strings (UTC, so the machine's tz database never matters) ----

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${s}`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (new Date(ms).toISOString().slice(0, 10) !== s) throw new Error(`not a real date: ${s}`);
  return ms;
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => ymd(parseYmd(s) + n * DAY_MS);
const weekday = (s) => new Date(parseYmd(s)).getUTCDay();

function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`not an HH:MM time: ${s}`);
  return +m[1] * 60 + +m[2];
}
const pad = (n) => String(n).padStart(2, '0');
const clock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/**
 * BC wall time of a moment: { date: 'YYYY-MM-DD', minutes, label: 'YYYY-MM-DD HH:MM' }.
 * An ISO string with Z or an offset is an instant; one without a zone is already BC wall time.
 */
function toBc(input, offsetHours = -7) {
  if (typeof input === 'string') {
    const wall = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(input.trim());
    if (wall) {
      parseYmd(wall[1]);
      const minutes = hhmm(`${wall[2]}:${wall[3]}`);
      return { date: wall[1], minutes, label: `${wall[1]} ${clock(minutes)}` };
    }
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(input.trim())) throw new Error(`paid time needs a date and a time: ${input}`);
  }
  const ms = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) throw new Error(`not a time: ${input}`);
  const local = new Date(ms + offsetHours * 3600e3);
  const date = local.toISOString().slice(0, 10);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return { date, minutes, label: `${date} ${clock(minutes)}` };
}

/** 'Friday, October 2' (opts.year adds ', 2026'). */
function formatCustomerDate(s, { year = false } = {}) {
  const d = new Date(parseYmd(s));
  return `${DAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ''}`;
}

/** 'Tue 2026-10-20': internal reasons only. */
const shortDay = (s) => `${DAY_NAMES[weekday(s)].slice(0, 3)} ${s}`;

// ---- schedule ----

/** Problems with a schedule document ([] when usable). */
function validateSchedule(doc) {
  const errs = [];
  const t = (doc && doc.truck) || {};
  const st = (doc && doc.store) || {};
  const isDays = (a) => Array.isArray(a) && a.length > 0 && a.every((d) => DAY_KEYS.includes(d));
  if (!doc || typeof doc !== 'object') return ['schedule missing'];
  if (doc.utc_offset_hours !== -7) errs.push('utc_offset_hours must be -7 (BC, permanent daylight time)');
  if (!isDays(t.run_days)) errs.push('truck.run_days must be day keys (mon..sun)');
  if (!isDays(st.business_days)) errs.push('store.business_days must be day keys (mon..sun)');
  for (const [k, v] of [['truck.cutoff_time', t.cutoff_time], ['store.same_day_cutoff', st.same_day_cutoff]]) {
    try { hhmm(v); } catch (e) { errs.push(`${k}: ${e.message}`); }
  }
  for (const k of ['cutoff_business_days_before', 'ready_business_days_after_run']) {
    if (!Number.isInteger(t[k]) || t[k] < 0) errs.push(`truck.${k} must be a whole number >= 0`);
  }
  const locs = doc.locations || {};
  if (!Object.keys(locs).length) errs.push('no locations');
  for (const [k, l] of Object.entries(locs)) {
    if (!l.name || !l.address || !l.customer_name) errs.push(`locations.${k}: name, customer_name and address are required`);
    if (!Number.isInteger(l.order_in_extra_business_days || 0) || (l.order_in_extra_business_days || 0) < 0) errs.push(`locations.${k}.order_in_extra_business_days must be a whole number >= 0`);
  }
  const seen = new Set();
  for (const h of doc.holidays || []) {
    try { parseYmd(h.date); } catch (e) { errs.push(`holiday: ${e.message}`); }
    if (seen.has(h.date)) errs.push(`holiday ${h.date} listed twice`);
    seen.add(h.date);
  }
  try { parseYmd(doc.holidays_cover_through); } catch (e) { errs.push(`holidays_cover_through: ${e.message}`); }
  return errs;
}

function calendar(schedule) {
  const errs = validateSchedule(schedule);
  if (errs.length) throw new Error(`pickup schedule is invalid: ${errs.join('; ')}`);
  const holidays = new Map((schedule.holidays || []).map((h) => [h.date, h]));
  const business = new Set(schedule.store.business_days);
  const runs = new Set(schedule.truck.run_days);
  const holiday = (d) => holidays.get(d) || null;
  const isBusinessDay = (d) => business.has(DAY_KEYS[weekday(d)]) && !(holiday(d) && holiday(d).store_open !== true);
  const nextBusinessDay = (d) => {
    let x = d;
    for (let i = 0; i < SEARCH_DAYS; i++) { x = addDays(x, 1); if (isBusinessDay(x)) return x; }
    throw new Error(`no business day within ${SEARCH_DAYS} days after ${d}`);
  };
  const prevBusinessDay = (d) => {
    let x = d;
    for (let i = 0; i < SEARCH_DAYS; i++) { x = addDays(x, -1); if (isBusinessDay(x)) return x; }
    throw new Error(`no business day within ${SEARCH_DAYS} days before ${d}`);
  };
  const addBusinessDays = (d, n) => { let x = d; for (let i = 0; i < n; i++) x = nextBusinessDay(x); return x; };
  const isRunWeekday = (d) => runs.has(DAY_KEYS[weekday(d)]);
  const runCancelled = (d) => !!(holiday(d) && holiday(d).truck_runs !== true);
  return { holiday, isBusinessDay, nextBusinessDay, prevBusinessDay, addBusinessDays, isRunWeekday, runCancelled };
}

function locationOf(schedule, location) {
  const loc = (schedule.locations || {})[location];
  if (!loc) throw new Error(`unknown pickup location "${location}" (expected ${Object.keys(schedule.locations || {}).join(' or ')})`);
  return loc;
}

function normalizeLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('pickupEta: at least one line is required');
  return lines.map((l, i) => {
    const a = typeof l === 'string' ? l : l && l.availability;
    if (!AVAILABILITY.includes(a)) throw new Error(`pickupEta: line ${i + 1} availability must be on_shelf or order_in, got ${JSON.stringify(a)}`);
    return a;
  });
}

function coverageWarnings(schedule, dates) {
  const through = schedule.holidays_cover_through;
  const late = dates.filter((d) => d && d > through);
  return late.length ? [`${late.sort().pop()} is past the holiday list (covers through ${through}): add the next year's holidays to data/trade/pickup-schedule.json [MAC]`] : [];
}

/** Ready date for goods arriving on a run: the next business morning(s), plus the location's extra days. */
function readyFromRun(truckDay, loc, schedule, cal) {
  const atSechelt = cal.addBusinessDays(truckDay, schedule.truck.ready_business_days_after_run);
  return cal.addBusinessDays(atSechelt, loc.order_in_extra_business_days || 0);
}

/**
 * The next run a newly ordered-in line can make: on or after the paid date, not cancelled by a holiday, and
 * paid before its cutoff (strictly before: paid at exactly 14:00 has missed a 14:00 cutoff).
 */
function nextRun(paid, schedule, cal) {
  const cutoffMin = hhmm(schedule.truck.cutoff_time);
  const skipped = [];
  let d = paid.date;
  for (let i = 0; i < SEARCH_DAYS; i++, d = addDays(d, 1)) {
    if (!cal.isRunWeekday(d)) continue;
    if (cal.runCancelled(d)) { skipped.push({ date: d, why: `no run: ${cal.holiday(d).name}` }); continue; }
    let cutoffDate = d;
    for (let k = 0; k < schedule.truck.cutoff_business_days_before; k++) cutoffDate = cal.prevBusinessDay(cutoffDate);
    const inTime = paid.date < cutoffDate || (paid.date === cutoffDate && paid.minutes < cutoffMin);
    const cutoff = { date: cutoffDate, time: clock(cutoffMin), label: `${cutoffDate} ${clock(cutoffMin)}` };
    if (inTime) return { truckDay: d, cutoff, skipped };
    skipped.push({ date: d, why: `order cutoff ${shortDay(cutoffDate)} ${clock(cutoffMin)} passed` });
  }
  throw new Error(`no truck run within ${SEARCH_DAYS} days of ${paid.date}`);
}

/**
 * The pickup ETA for one order.
 * Returns { kind: 'ready_now' | 'order_in', readyBy, truckDay, cutoff, location, paidBc, reason, skippedRuns, warnings }.
 * readyBy and truckDay are BC dates ('YYYY-MM-DD'); truckDay and cutoff are null for ready_now.
 */
function pickupEta({ paidAt, location, lines } = {}, schedule = DEFAULT_SCHEDULE) {
  const cal = calendar(schedule);
  const loc = locationOf(schedule, location);
  const avail = normalizeLines(lines);
  const paid = toBc(paidAt, schedule.utc_offset_hours);

  if (avail.every((a) => a === 'on_shelf')) {
    const sameDayCut = hhmm(schedule.store.same_day_cutoff);
    const hol = cal.holiday(paid.date);
    let readyBy;
    let reason;
    if (cal.isBusinessDay(paid.date) && paid.minutes < sameDayCut) {
      readyBy = paid.date;
      reason = `All ${avail.length} line(s) on the shelf at ${loc.name}; paid ${shortDay(paid.date)} ${clock(paid.minutes)} BC, before the ${clock(sameDayCut)} same-day cutoff: ready today.`;
    } else {
      readyBy = cal.nextBusinessDay(paid.date);
      const why = !cal.isBusinessDay(paid.date)
        ? (hol ? `${shortDay(paid.date)} is ${hol.name}` : `${shortDay(paid.date)} is not a business day`)
        : `paid ${clock(paid.minutes)} BC, after the ${clock(sameDayCut)} same-day cutoff`;
      reason = `All ${avail.length} line(s) on the shelf at ${loc.name}; ${why}: ready the next business morning, ${shortDay(readyBy)}.`;
    }
    return {
      kind: 'ready_now', readyBy, truckDay: null, cutoff: null, location, paidBc: paid.label,
      reason, skippedRuns: [], warnings: coverageWarnings(schedule, [readyBy]),
    };
  }

  const run = nextRun(paid, schedule, cal);
  const readyBy = readyFromRun(run.truckDay, loc, schedule, cal);
  const extra = loc.order_in_extra_business_days || 0;
  const orderIn = avail.filter((a) => a === 'order_in').length;
  const skippedTxt = run.skipped.length ? ` Skipped: ${run.skipped.map((s) => `${shortDay(s.date)} (${s.why})`).join(', ')}.` : '';
  const reason = `${orderIn} of ${avail.length} line(s) ordered in, so the whole order waits. Paid ${shortDay(paid.date)} ${clock(paid.minutes)} BC; rides the ${shortDay(run.truckDay)} run (order cutoff ${shortDay(run.cutoff.date)} ${run.cutoff.time}).${skippedTxt} In Sechelt that evening, ready ${extra ? `at ${loc.name} ${extra} business day(s) after Sechelt, ` : ''}${shortDay(readyBy)}.`;
  return {
    kind: 'order_in', readyBy, truckDay: run.truckDay, cutoff: run.cutoff, location, paidBc: paid.label,
    reason, skippedRuns: run.skipped, warnings: coverageWarnings(schedule, [run.truckDay, readyBy]),
  };
}

/**
 * The run did not bring it (the supplier was short). The order is already in, so no cutoff applies: it rides
 * the next run after the missed one that a holiday does not cancel.
 */
function delayedEta({ missedTruckDay, location } = {}, schedule = DEFAULT_SCHEDULE) {
  const cal = calendar(schedule);
  const loc = locationOf(schedule, location);
  parseYmd(missedTruckDay);
  const skipped = [];
  let d = missedTruckDay;
  for (let i = 0; i < SEARCH_DAYS; i++) {
    d = addDays(d, 1);
    if (!cal.isRunWeekday(d)) continue;
    if (cal.runCancelled(d)) { skipped.push({ date: d, why: `no run: ${cal.holiday(d).name}` }); continue; }
    const readyBy = readyFromRun(d, loc, schedule, cal);
    const skippedTxt = skipped.length ? ` Skipped: ${skipped.map((s) => `${shortDay(s.date)} (${s.why})`).join(', ')}.` : '';
    return {
      kind: 'order_in', readyBy, truckDay: d, cutoff: null, location, missedTruckDay,
      reason: `Not on the ${shortDay(missedTruckDay)} run; next run ${shortDay(d)}.${skippedTxt} Ready ${shortDay(readyBy)}.`,
      skippedRuns: skipped, warnings: coverageWarnings(schedule, [d, readyBy]),
    };
  }
  throw new Error(`no truck run within ${SEARCH_DAYS} days after ${missedTruckDay}`);
}

/** Reminder dates for a ready order that has not been picked up: business days after the ready date. */
function reminderDates(readyBy, schedule = DEFAULT_SCHEDULE) {
  const cal = calendar(schedule);
  parseYmd(readyBy);
  const r = schedule.reminders || {};
  return {
    first: cal.addBusinessDays(readyBy, r.first_after_business_days != null ? r.first_after_business_days : 3),
    second: cal.addBusinessDays(readyBy, r.second_after_business_days != null ? r.second_after_business_days : 7),
  };
}

/** Business-day helpers on the schedule's calendar, for callers (e.g. "is today a truck day?"). */
function isBusinessDay(date, schedule = DEFAULT_SCHEDULE) { return calendar(schedule).isBusinessDay(date); }
function addBusinessDays(date, n, schedule = DEFAULT_SCHEDULE) { return calendar(schedule).addBusinessDays(date, n); }
function isTruckDay(date, schedule = DEFAULT_SCHEDULE) {
  const cal = calendar(schedule);
  return cal.isRunWeekday(date) && !cal.runCancelled(date);
}

module.exports = {
  DEFAULT_SCHEDULE,
  AVAILABILITY,
  toBc,
  formatCustomerDate,
  validateSchedule,
  pickupEta,
  delayedEta,
  reminderDates,
  isBusinessDay,
  addBusinessDays,
  isTruckDay,
};
