/**
 * Meta Conversions API: the events Meta can bid toward.
 *
 * WHY (2026-10-21): the October ProZone campaign ran OUTCOME_TRAFFIC / LANDING_PAGE_VIEWS against a healthy pixel
 * and bought 454 of the cheapest clicks on the internet. Meta was never asked for an applicant, because no event
 * existed that meant "an applicant". This sends that event.
 *
 * Browser-side is not good enough for this one. Ad blockers eat it, the form POST navigates away mid-flight, and
 * the browser cannot tell a real application from a bot filling boxes. run-orders already sees every application
 * after the desk has classified it, so the server is both more reliable and more truthful.
 *
 * NOT for Purchase / AddToCart / ViewContent. Shopify's Facebook channel already sends those for yourfloors.ca,
 * server-side included (`dataSharingState: optimized`, `share_all_events` in the storefront's web-pixels config).
 * Sending them again from here would double-count every sale. Verified 2026-10-21: the pixel receives from
 * www.yourfloors.ca (5,148 events in a week) and customfc.ca (1,209), which is also why every audience built on
 * this pixel has to be filtered by host.
 *
 * Config (run-orders/.env on the Mini):
 *   META_PIXEL_ID      653240902060209   ("Custom Flooring Centres's Pixel", owned by act_2763408117281777)
 *   META_CAPI_TOKEN    a token with ads_management on that pixel
 *   META_CAPI_LIVE=1   off = build and log the payload, send nothing (the default, so a deploy never surprises)
 *   META_CAPI_TEST_CODE  optional TESTxxxxx from Events Manager: routes to Test Events, never enters the dataset
 */

'use strict';

const crypto = require('crypto');

const V = 'v21.0';

/** Meta wants every identifier lower-cased, trimmed and SHA-256'd. Never send a raw email. */
const hash = (v) => (v == null || v === '' ? undefined : crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex'));

/** Phones hash as digits only, with country code and no punctuation. Assume Canada for a bare 10-digit number. */
function hashPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return undefined;
  if (d.length === 10) d = `1${d}`;
  return hash(d);
}

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const last = (name) => String(name || '').trim().split(/\s+/).slice(1).join(' ') || '';

/**
 * Meta matches a server event back to the click that caused it through _fbc (the click id) and _fbp (the browser
 * id), both set as cookies by the pixel. Without them the event still lands but match quality is poor, which is
 * most of the reason server-side setups underperform. Our forms capture them in a hidden field.
 * _fbc can also be rebuilt from a raw fbclid: fb.1.<ms>.<fbclid>.
 */
function clickIds({ fbc, fbp, fbclid, now = Date.now() } = {}) {
  const out = {};
  if (fbc) out.fbc = String(fbc).slice(0, 255);
  else if (fbclid) out.fbc = `fb.1.${now}.${String(fbclid).slice(0, 180)}`;
  if (fbp) out.fbp = String(fbp).slice(0, 120);
  return out;
}

/** Everything Meta is allowed to know about the person, hashed. Undefined keys are dropped, never sent empty. */
function userData(p = {}) {
  const u = {
    em: hash(p.email),
    ph: hashPhone(p.phone),
    fn: hash(first(p.name || p.firstName)),
    ln: hash(p.lastName || last(p.name)),
    st: hash(p.province),
    country: hash(p.country || 'ca'),
    ...clickIds(p),
  };
  if (p.clientIp) u.client_ip_address = p.clientIp;
  if (p.userAgent) u.client_user_agent = p.userAgent;
  return Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * One event. `eventId` must be stable for the thing that happened (we use the application id), so a retry or a
 * second send is deduplicated by Meta instead of counted twice.
 */
function buildEvent({ eventName, eventId, sourceUrl, actionSource = 'website', when = new Date(), person = {}, custom }) {
  if (!eventName) throw new Error('meta-capi: eventName is required');
  const e = {
    event_name: eventName,
    event_time: Math.floor(when.getTime() / 1000),
    action_source: actionSource,
    user_data: userData(person),
  };
  if (eventId) e.event_id = String(eventId);
  if (sourceUrl) e.event_source_url = sourceUrl;
  if (custom && Object.keys(custom).length) e.custom_data = custom;
  return e;
}

const cfg = () => ({
  pixel: process.env.META_PIXEL_ID || '',
  token: process.env.META_CAPI_TOKEN || '',
  live: process.env.META_CAPI_LIVE === '1',
  testCode: process.env.META_CAPI_TEST_CODE || '',
});

/**
 * Send one or more events. Never throws at the caller: an application must be recorded and emailed to Mac whether
 * or not Meta is reachable, so the worst case here is a logged miss.
 * -> { sent, skipped, reason, received, fbtrace_id }
 */
async function sendEvents(events, { fetchImpl = fetch, log = console.log, ...over } = {}) {
  const c = { ...cfg(), ...over };
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (!list.length) return { sent: false, skipped: true, reason: 'no events' };
  if (!c.pixel || !c.token) return { sent: false, skipped: true, reason: 'META_PIXEL_ID / META_CAPI_TOKEN not set' };
  if (!c.live) {
    log(`[meta-capi] SHADOW (META_CAPI_LIVE is not 1), would send: ${list.map((e) => e.event_name).join(', ')}`);
    return { sent: false, skipped: true, reason: 'shadow' };
  }
  const body = { data: list, access_token: c.token };
  if (c.testCode) body.test_event_code = c.testCode;
  try {
    const r = await fetchImpl(`https://graph.facebook.com/${V}/${c.pixel}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) { log(`[meta-capi] rejected: ${j.error.message}`); return { sent: false, skipped: false, reason: j.error.message }; }
    log(`[meta-capi] sent ${list.map((e) => e.event_name).join(', ')} -> received ${j.events_received}`);
    return { sent: true, skipped: false, received: j.events_received, fbtrace_id: j.fbtrace_id };
  } catch (err) {
    log(`[meta-capi] failed: ${err.message}`);
    return { sent: false, skipped: false, reason: err.message };
  }
}

/**
 * A ProZone application. `Lead` is the standard event a custom conversion and an OUTCOME_LEADS campaign can be
 * pointed at. content_name separates national from Coast so one campaign never optimizes toward the other's
 * applicants.
 */
function prozoneLead(app, { id, sourceUrl, clientIp, userAgent, when } = {}) {
  return buildEvent({
    eventName: 'Lead',
    eventId: id,
    sourceUrl: sourceUrl || `https://www.yourfloors.ca/pages/${app && app.national === false ? 'prozone-sechelt' : 'prozone-apply'}`,
    when,
    person: {
      email: app && app.email,
      phone: app && app.phone,
      name: app && app.name,
      province: app && app.province,
      fbc: app && app.fbc,
      fbp: app && app.fbp,
      fbclid: app && app.fbclid,
      clientIp,
      userAgent,
    },
    custom: {
      content_name: app && app.national === false ? 'ProZone Coast application' : 'ProZone application',
      content_category: 'trade program',
    },
  });
}

module.exports = { hash, hashPhone, clickIds, userData, buildEvent, sendEvents, prozoneLead, cfg };
