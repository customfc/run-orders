/**
 * ProZone applications with a one-tap approve (02, Mac 2026-10-02: "i want the automatic one tap email").
 *
 * The Coast page's join form is a Shopify contact form, which lands in hello@yourfloors.ca. The YourFloors CS agent
 * (~/yourfloors-cs on the Mini) spots it and POSTs it to /api/prozone/applications here (loopback only). We record it
 * and email Mac the applicant with a Review and approve button (HMAC-signed link on the Tailscale URL, the same
 * pattern as the sku-resolver approve link). The link opens a page with the applicant and the welcome email; tapping
 * Approve turns their pricing on (lib/trade-accounts.js) and sends the welcome email from hello@yourfloors.ca. Mac's
 * tap is the go for that one email. The link itself never changes anything (mail scanners open links).
 *
 * State: data/trade-applications-state.json, one record per applicant email.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_PATH = path.join(__dirname, '..', 'data', 'trade-applications-state.json');
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const secret = () => process.env.PROZONE_APPROVE_SECRET || process.env.SKU_RESOLVER_SECRET || '';

const LABELS = {
  'name': 'name', 'email': 'email', 'phone': 'phone', 'mobile': 'phone', 'business name': 'business',
  'town': 'area', 'area': 'area', 'where you work': 'area', 'gst/hst number': 'gst', 'ok to send prozone offers': 'optIn',
  'form': 'form', 'body': 'notes', 'trade': 'trade', 'province': 'province', 'website or licence': 'website',
};

// Shopify title-cases labels and splits camel case ("Ok To Send Pro Zone Offers"), so match without spaces.
const LABEL_KEYS = Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k.replace(/\s+/g, ''), v]));

/** Shopify's contact-form email: "Label: value" lines, or the label on one line and the value on the next. */
function parseApplication(text, replyTo = null) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][A-Za-z /]{1,40}?):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = LABEL_KEYS[m[1].replace(/\s+/g, '').toLowerCase()];
    if (!key || out[key]) continue;
    let val = m[2].trim();
    if (!val) { let j = i + 1; while (j < lines.length && !lines[j]) j++; if (j < lines.length && !/^[A-Za-z][A-Za-z /]{1,40}:/.test(lines[j])) val = lines[j]; }
    if (val) out[key] = val.slice(0, 300);
  }
  if (!out.email && replyTo) out.email = replyTo;
  out.email = String(out.email || '').trim().toLowerCase();
  const [firstName, ...rest] = String(out.name || '').split(/\s+/).filter(Boolean);
  return {
    email: out.email, firstName: firstName || '', lastName: rest.join(' '), name: out.name || '',
    business: out.business || '', phone: out.phone || '', area: out.area || '', gst: out.gst || '',
    optIn: /^y/i.test(out.optIn || ''), notes: out.notes || '', form: out.form || '',
  };
}

function isProZoneApplication(text) { return /ProZone application/i.test(String(text || '')); }

const idFor = (email) => 'pz-' + crypto.createHash('sha1').update(String(email).toLowerCase()).digest('hex').slice(0, 12);
function token(id, s = secret()) { return s ? crypto.createHmac('sha256', s).update(`prozone|${id}`).digest('hex').slice(0, 32) : null; }
function verify(id, t, s = secret()) {
  const want = token(id, s);
  if (!want || !t || want.length !== String(t).length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(t)));
}
const reviewUrl = (id) => { const t = token(id); return t ? `${PUBLIC_BASE}/prozone/approve?id=${id}&t=${t}` : null; };

function loadState(file = STATE_PATH) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { apps: {} }; } }
function saveState(state, file = STATE_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Record an application. -> { rec, isNew }. A repeat from the same email updates the details but never re-approves. */
function recordApplication(app, { state = loadState(), now = new Date(), file = STATE_PATH } = {}) {
  if (!app.email) throw new Error('application has no email');
  const id = idFor(app.email);
  const prev = state.apps[id];
  const rec = prev ? { ...prev, app: { ...prev.app, ...app }, lastReceivedAt: now.toISOString() }
    : { id, status: 'pending', app, receivedAt: now.toISOString(), lastReceivedAt: now.toISOString() };
  state.apps[id] = rec;
  saveState(state, file);
  return { rec, isNew: !prev };
}

function setStatus(id, patch, { file = STATE_PATH } = {}) {
  const state = loadState(file);
  if (!state.apps[id]) throw new Error(`no application ${id}`);
  state.apps[id] = { ...state.apps[id], ...patch };
  saveState(state, file);
  return state.apps[id];
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function detailsHtml(a) {
  const row = (k, v) => (v ? `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>` : '');
  return `${verifyHtml(a.verify)}<table style="border-collapse:collapse;font-size:15px">${row('Name', a.name)}${row('Business', a.business)}${row('Email', a.email)}${row('Mobile', a.phone)}${row('Area', a.area)}${row('GST/HST', a.gst || 'not given')}${row('Offers OK', a.optIn ? 'Yes' : 'No')}${row('Notes', a.notes)}</table>`;
}

const VERIFY_LABEL = { verified: ['#0a744a', 'Verified business'], name_found: ['#0a744a', 'Business name found'], number_only: ['#8a5a00', 'Not in the BC registry'], inactive: ['#c4301c', 'Registry says NOT active'], invalid: ['#c4301c', 'Fake or mistyped GST number'], lookup_failed: ['#8a5a00', 'Registry check failed'] };
function verifyHtml(v) {
  if (!v) return '';
  const [color, label] = VERIFY_LABEL[v.level] || ['#666', v.level];
  return `<p style="margin:0 0 12px;padding:10px 14px;border-radius:8px;border:1px solid ${color};color:${color}"><b>${esc(label)}.</b> ${esc(v.summary)}</p>`;
}

/** Email to Mac for a new application. */
function macEmail(rec) {
  const a = rec.app;
  const url = reviewUrl(rec.id);
  const flag = a.verify && a.verify.level === 'invalid' ? ' [fake GST]' : a.verify && a.verify.level === 'verified' ? ' [verified]' : '';
  const subject = `ProZone application: ${a.business || a.name || a.email}${a.area ? ` (${a.area})` : ''}${flag}`;
  const html = `<p>New ProZone application from the Coast page.</p>${detailsHtml(a)}
<p style="margin:24px 0">${url ? `<a href="${esc(url)}" style="background:#000;color:#fff;padding:14px 26px;border-radius:100px;text-decoration:none;font-weight:700;display:inline-block">Review and approve</a>` : '<b>No approve link: PROZONE_APPROVE_SECRET / SKU_RESOLVER_SECRET is not set on the Mini.</b>'}</p>
${a.business ? '' : `<p style="color:#a00">Some fields didn't parse. The form as received:</p><pre style="white-space:pre-wrap;font-size:13px">${esc(a.raw || '')}</pre>`}
<p style="color:#666;font-size:13px">The button opens a page with the welcome email. Approve there turns on their pricing and client code and sends it. Opening the link changes nothing. The link works on Tailscale.</p>`;
  return { subject, html };
}

/** The welcome email the installer gets when Mac approves. */
function welcomeEmail(app, result, { clientCodesLive = process.env.PROZONE_CLIENT_CODES_LIVE === '1' } = {}) {
  const first = app.firstName || '';
  const lines = [
    `Hi${first ? ` ${first}` : ''},`,
    '',
    `You're approved for ProZone. Sign in at www.yourfloors.ca with ${app.email} and your pricing comes off in the cart automatically:`,
    '- 20% off Schluter on orders up to $1,000',
    '- 25% off Schluter on orders over $1,000',
    '- 10% off Schluter trims and profiles',
    '',
    "Choose pickup at Sechelt Warehouse or Powell River at checkout and we'll email you when it's ready.",
    ...(clientCodesLive && result && result.code ? ['', `Your client code is ${result.code}. Clients save 5% on everything at yourfloors.ca with it, and you get 5% of what they spend as store credit in your yourfloors account.`] : []),
    '',
    'Any questions, just reply to this email.',
    '',
    'YourFloors',
  ];
  const text = lines.join('\n');
  const html = lines.map((l) => (l ? `<p style="margin:0 0 4px">${esc(l)}</p>` : '<p style="margin:0 0 10px"></p>')).join('\n');
  return { subject: "You're approved for ProZone", text, html };
}

module.exports = {
  STATE_PATH, parseApplication, isProZoneApplication, idFor, token, verify, reviewUrl, loadState, saveState,
  recordApplication, setStatus, macEmail, welcomeEmail, detailsHtml, verifyHtml, esc,
};
