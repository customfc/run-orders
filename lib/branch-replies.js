/**
 * Prosol branch replies to the daily "Order - <Branch> (<CODE>)" emails. Runbook: docs/BRANCH-REPLIES.md.
 *
 * Every weekday the pipeline emails each branch's orders to Kaitlyn from hello@ (lib/pipeline.js phaseEmail, audit
 * `pipeline-email-prosol`); she relays to the branch and the branch staff reply-all. Nothing read those replies: on
 * 2026-11-06 Concord wrote "we dont have KP27-01 available; inventory adjusted" and #1449 sat unshipped for 4 days;
 * on 2026-11-04 Kaitlyn asked "@mac please advise ... 1 box?" and nobody answered. The yourfloors-cs desk ignores all
 * @prosol.ca mail by design, so this is the only reader.
 *
 * Each new reply from @prosol.ca in one of those threads is classified by Opus (ack / cant_ship / question / other,
 * with a code guard that never lets stock words or a question to us pass as an ack), tied to the orders in that
 * day's send (audit + ops-state, narrowed by any order ref, PO, tracking or SKU the thread names), then:
 *   ack        audit line `branch-reply` only, no email
 *   cant_ship  live Prosol stock per branch, an alternative branch (>= qty, prefer >= 2, nearest the customer), a
 *              drafted reply TO KAITLYN ONLY (CC Mac) in the same thread asking to ship from there on the same label,
 *              a card to Mac with a Send link, and a vendor-error line (not_shipped) once per order + SKU
 *   question / other  a card with their words, the tied orders and an Opus-drafted short answer to Kaitlyn
 * Nothing goes to Prosol without Mac's tap (`/branch-replies/send`). No autosend in this version.
 *
 * Mail, Prosol, ShipStation and Claude are injected (scripts/ops/branch-replies.js wires the real ones), so the
 * parsing, tie, branch choice, wording and the send's recipient checks are testable offline.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = path.join(__dirname, '..', 'data', 'branch-replies-state.json');
const OPS_STATE_DIR = path.join(__dirname, '..', 'data', 'ops-state');
const MODEL = 'claude-opus-5-5';
const KAITLYN = () => process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca';
const MAC = () => process.env.MAC_CC_EMAIL || 'mac@customfc.ca';
const KINDS = ['ack', 'cant_ship', 'question', 'other'];
const MAX_ATTEMPTS = 3;

// ── Parsing ─────────────────────────────────────────────────────────────────

const SUBJECT_RE = /Order\s*-\s*(.+?)\s*\(([A-Z0-9]{3,5})\)/i;

/** "Re: Order - Concord (WCON)" / "[Prosol Inc] Re: Re: Order - ..." -> { branch, code, warehouse } or null. */
function parseSubject(subject) {
  const m = String(subject || '').match(SUBJECT_RE);
  if (!m) return null;
  const branch = m[1].replace(/^.*Order\s*-\s*/i, '').trim();
  const code = m[2].toUpperCase();
  return { branch, code, warehouse: `${branch} (${code})` };
}

const fromAddr = (msg) => String(msg?.from?.emailAddress?.address || '').toLowerCase();

/** A reply from Prosol in one of our branch order threads. */
function isBranchReply(msg) {
  return /@prosol\.ca$/.test(fromAddr(msg)) && !!parseSubject(msg.subject) && !msg.isDraft;
}

// Outlook puts "________________________________" then "From:" above the quoted thread; Gmail/Apple use
// "On ... wrote:"; French Outlook uses "De :". Everything from the first marker down is the old thread.
const QUOTE_MARKERS = [
  /^\s*_{10,}\s*$/m,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*From:\s/m,
  /^\s*De\s?:\s/m,
  /^\s*On .{5,200}wrote:\s*$/m,
  /^\s*Le .{5,200}a écrit\s?:\s*$/m,
  /^\s*Sent from my /m,
];

/** Just the new words of a reply: cut at the first quote marker, drop "> " lines, collapse whitespace. */
function stripQuote(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  // Prosol's Zendesk form ("[Prosol Inc] Re: Re: Order - ..."): header, then comments newest first, each as
  // "[avatar link]" / name / "Oct 13, 2026, 15:50 EDT" / text. Keep only the newest comment's text.
  if (/##- Please type your reply above this line -##/.test(s)) {
    s = s.replace(/^[\s\S]*?reply to this email\.[ \t]*\n/i, '');
    const parts = s.split(/^[ \t]*\[https?:\/\/[^\]\s]*zendesk[^\]\s]*\][ \t]*$/im).map((x) => x.trim()).filter(Boolean);
    if (parts.length) s = parts[0].replace(/^[^\n]*\n\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, \d{4}, \d{1,2}:\d{2}[^\n]*\n/, '');
  }
  let cut = s.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  s = s.slice(0, cut);
  s = s.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  // Signature links ("letsignit.com/...?p=...") carry a "?" the guard would read as a question; "@Order Kelowna<mailto:...>".
  s = s.replace(/<(?:https?|mailto):[^>\s]*>/gi, '').replace(/\[?https?:\/\/\S+\]?/gi, '').replace(/[​‌‍﻿]/g, '');
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
}

// ── The code-side guard ─────────────────────────────────────────────────────

const STOCK_RE = /\b(?:don'?t|dont|do not|does not|doesn'?t) have\b|out of stock|not (?:available|in stock)|\bunavailable\b|no stock|\bback\s?-?order|\bshort\b|\bshortage\b|discontinued|cannot be allocated|can'?t be allocated|\b0 available\b|inventory adjusted/i;
// "Please advise that orders for next day delivery must be submitted by 2:00 PM" is Hamilton's signature, not a question.
const ASK_RE = /\?|please advise(?!\s+that\b)|willing to wait|@\s?mac\b|let (?:us|me) know (?:if|whether|how)/i;

/** Which guard words the new text carries ({ stock, ask }). */
function guardHits(text) {
  const s = String(text || '');
  return { stock: STOCK_RE.test(s), ask: ASK_RE.test(s) };
}

/** Opus's kind after the guard: stock words or a question to us never stay `ack` (upgraded to `other`). */
function applyGuard(kind, text) {
  const k = KINDS.includes(kind) ? kind : 'other';
  const g = guardHits(text);
  if (k === 'ack' && (g.stock || g.ask)) return { kind: 'other', guarded: g.stock ? 'stock words' : 'a question to us' };
  return { kind: k, guarded: null };
}

// ── Tie to orders ───────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const poNum = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');

/** Order refs the thread itself names: "Ref: 1449", "#1449", PO numbers, carrier tracking numbers. */
function threadRefs(text) {
  const s = String(text || '');
  const orderNumbers = new Set();
  for (const m of s.matchAll(/\bRef:\s*#?([A-Z0-9-]{3,25})/gi)) orderNumbers.add(m[1].toUpperCase());
  for (const m of s.matchAll(/(?:^|[\s(])#(\d{3,5})\b/g)) orderNumbers.add(m[1]);
  for (const m of s.matchAll(/\b(\d{3}-\d{7}-\d{7})\b/g)) orderNumbers.add(m[1]);
  const pos = new Set([...s.matchAll(/\bPO-?\s?(\d{4,7})\b/gi)].map((m) => poNum(m[1])));
  const trackings = new Set([...s.matchAll(/\b(\d{12}|1Z[0-9A-Z]{16})\b/g)].map((m) => m[1]));
  return { orderNumbers: [...orderNumbers], pos: [...pos], trackings: [...trackings] };
}
const hasRefs = (r) => !!(r.orderNumbers.length || r.pos.length || r.trackings.length);

function orderMatchesRefs(o, r) {
  if (r.orderNumbers.some((n) => norm(n) === norm(o.orderNumber))) return true;
  const trk = new Set((o.packages || []).map((p) => p.tracking).concat(o.tracking || []).filter(Boolean));
  if (r.trackings.some((t) => trk.has(t))) return true;
  const pos = new Set((o.packages || []).map((p) => p.po).concat(o.po || []).filter(Boolean).map(poNum));
  return r.pos.some((p) => pos.has(p));
}

/** Does this order item carry the code the branch named (channel SKU, api_sku or prosol_sku, any punctuation)? */
const itemHasCode = (item, code) => (item.codes || [item.sku]).some((c) => c && norm(c) === norm(code));
const orderHasCode = (o, code) => (o.items || []).some((i) => itemHasCode(i, code));

const SEND_SLACK_MS = 15 * 60e3; // the audit line is written just after the SMTP send returns

/**
 * Tie a reply to the orders of the send it answers.
 *   warehouse code, thread start (earliest message in the conversation; else the reply's own time), the
 *   `pipeline-email-prosol` audit entries, and factsFor(orderId, sentAtIso) -> order facts (see opsStateOrder).
 * The send = the most recent audit entry for that branch at or before the thread start. Order refs the thread names
 * narrow it (or find an earlier send that has them); SKUs the reply names narrow it again. Anything doubtful goes
 * in `reasons` and `sure` is false: the card says so, nothing is guessed silently.
 */
async function tieOrders({ code, threadStart, receivedAt, emails, refs, skuCodes = [], factsFor, lookbackDays = 21 }) {
  const reasons = [];
  const anchorIso = threadStart || receivedAt;
  if (!threadStart) reasons.push('thread start unknown, matched on the reply time');
  const anchor = Date.parse(anchorIso) + SEND_SLACK_MS;
  const sends = (emails || [])
    .filter((e) => e && e.success !== false && Array.isArray(e.orderIds) && e.orderIds.length && String(e.warehouse || '').toUpperCase().endsWith(`(${code})`))
    .filter((e) => Date.parse(e.timestamp) <= anchor && Date.parse(e.timestamp) >= anchor - lookbackDays * 864e5)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  if (!sends.length) return { sure: false, reasons: [...reasons, `no order email to ${code} found in the ${lookbackDays} days before this thread`], sentAt: null, orders: [] };

  const load = async (e) => (await Promise.all(e.orderIds.map((id) => factsFor(id, e.timestamp)))).map((o, i) => o || { orderId: e.orderIds[i], orderNumber: null, items: [], packages: [], missing: true });
  let send = sends[0];
  let orders = await load(send);
  if (orders.some((o) => o.missing)) reasons.push(`no ops-state record for ShipStation order ${orders.filter((o) => o.missing).map((o) => o.orderId).join(', ')}`);

  if (refs && hasRefs(refs)) {
    const hit = orders.filter((o) => orderMatchesRefs(o, refs));
    if (hit.length) {
      orders = hit;
    } else {
      let found = null;
      for (const e of sends.slice(1)) {
        const os = (await load(e)).filter((o) => orderMatchesRefs(o, refs));
        if (os.length) { found = { e, os }; break; }
      }
      if (found) {
        reasons.push(`matched on the order refs quoted in the thread (send of ${found.e.timestamp.slice(0, 10)}), not the newest send to ${code}`);
        send = found.e; orders = found.os;
      } else {
        reasons.push(`the thread names ${[...refs.orderNumbers.map((n) => `#${n}`), ...refs.pos.map((p) => `PO-${p}`), ...refs.trackings].join(', ')} but none is in the ${send.timestamp.slice(0, 10)} send`);
      }
    }
  }

  const codes = skuCodes.map((s) => (typeof s === 'string' ? s : s.code)).filter(Boolean);
  if (codes.length) {
    const withSku = orders.filter((o) => codes.some((c) => orderHasCode(o, c)));
    if (withSku.length) orders = withSku;
    else reasons.push(`no tied order carries ${codes.join(', ')}`);
  }
  return { sure: reasons.length === 0 && orders.length > 0, reasons, sentAt: send.timestamp, orders };
}

/** The ShipStation order as the pipeline recorded it (ops-state labels + POs), from the send's day back `days`. */
function opsStateOrder(orderId, atIso, { dir = OPS_STATE_DIR, days = 10, readMap = () => ({}) } = {}) {
  const at = new Date(atIso || Date.now());
  let label = null;
  const poByTracking = {};
  for (let d = 0; d <= days; d++) {
    const date = new Date(at - d * 864e5).toLocaleString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
    let st;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), 'utf8')); } catch { continue; }
    Object.assign(poByTracking, st.phases?.pos?.byTracking || {});
    if (!label && st.phases?.buy?.labels?.[String(orderId)]) label = st.phases.buy.labels[String(orderId)];
  }
  if (!label) return null;
  const map = readMap() || {};
  const codesFor = (sku) => { const e = map[sku] || {}; return [...new Set([sku, e.api_sku, e.prosol_sku].filter(Boolean))]; };
  const pkgs = (label.packages && label.packages.length ? label.packages : [{ trackingNumber: label.trackingNumber, items: [] }]);
  const packages = pkgs.map((p) => ({
    tracking: p.trackingNumber || null,
    po: poByTracking[p.trackingNumber]?.poNumber || null,
    items: (p.items || []).map((i) => ({ sku: i.sku, name: i.name, qty: Number(i.quantity) || 1, codes: codesFor(i.sku), prosolSku: (map[i.sku] || {}).prosol_sku || null })),
  }));
  const items = [];
  for (const p of packages) for (const i of p.items) {
    const have = items.find((x) => x.sku === i.sku);
    if (have) have.qty += i.qty; else items.push({ ...i });
  }
  return {
    orderId: Number(orderId), orderNumber: String(label.orderNumber), source: label.source || null,
    carrier: label.carrierCode || null, tracking: label.trackingNumber || packages[0]?.tracking || null,
    po: poByTracking[label.trackingNumber]?.poNumber || packages.find((p) => p.po)?.po || null,
    warehouseId: label.warehouseId || null, packages, items,
  };
}

// ── Alternative branch ──────────────────────────────────────────────────────

// Rough population centres, so "nearest the customer" means nearest where the parcels go in that province.
const PROVINCE_CENTRE = {
  BC: [49.3, -123.0], AB: [52.0, -113.8], SK: [51.5, -106.0], MB: [49.9, -97.1], ON: [43.9, -79.5], QC: [46.0, -73.0],
  NB: [46.1, -65.5], NS: [44.9, -63.5], PE: [46.3, -63.1], NL: [47.6, -52.9], YT: [60.7, -135.0], NT: [62.4, -114.4], NU: [63.7, -68.5],
};
function km(a, b) {
  if (!a || !b || a[0] == null || b[0] == null) return Infinity;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b[0] - a[0]); const dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Where else the order can come from. stock = [{ code, city, province, lat, lng, qty }] (live Prosol, shippable
 * branches only). Never the branch that said no. Must hold >= need; >= max(2, need) first (thin-stock rule: a
 * branch showing 1 is often 0 on the shelf); then the customer's province; then distance from the customer's
 * province (or the original branch when the province is unknown); then most stock.
 */
function chooseAltBranch({ stock, need = 1, exclude, province = null, origin = null }) {
  const prov = String(province || '').toUpperCase();
  const ref = PROVINCE_CENTRE[prov] || origin || null;
  const ranked = (stock || [])
    .filter((s) => s && s.code !== exclude && Number(s.qty) >= need)
    .map((s) => ({ ...s, thin: Number(s.qty) < Math.max(2, need), sameProvince: !!prov && s.province === prov, km: Math.round(km(ref, [s.lat, s.lng])) }))
    .sort((a, b) => (a.thin - b.thin) || (b.sameProvince - a.sameProvince) || (a.km - b.km) || (b.qty - a.qty));
  return { pick: ranked[0] || null, ranked };
}

// ── Wording ─────────────────────────────────────────────────────────────────

const orderRef = (n) => (/^\d+$/.test(String(n)) ? `#${n}` : `order ${n}`);
const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const tidyName = (s) => String(s || '').replace(/\s+[/|-]\s+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
const noDash = (s) => String(s || '').replace(/\s*—\s*/g, ', ').replace(/–/g, '-');

/**
 * Reply to Kaitlyn for a branch that can't ship (Mac approved this wording 2026-11-10):
 * "Concord let us know they don't have KP27-01. Could you send #1449 (1x KP27-01 ...) from Ottawa instead? They show
 * 7 in stock. Same Purolator label, tracking 520861603352, PO-017709." The carrier label is reused: Prosol moves the
 * source branch internally; we never relabel or void.
 */
function cantShipDraft({ branch, lines }) {
  const ok = (lines || []).filter((l) => l.alt && l.order);
  if (!ok.length) return null;
  const carrierName = require('./emailer').carrierName;
  const skus = [...new Set(ok.map((l) => l.sku))];
  const asks = ok.map((l) => {
    const label = [carrierName(l.carrier) ? `Same ${carrierName(l.carrier)} label` : 'Same label', l.tracking ? `tracking ${l.tracking}` : null, l.po || null].filter(Boolean).join(', ');
    return `Could you send ${orderRef(l.order)} (${l.qty}x ${l.sku}${l.name ? ` ${tidyName(l.name)}` : ''}) from ${l.alt.city} instead? They show ${l.alt.qty} in stock. ${label}.`;
  });
  return noDash(`Hi Kaitlyn,\n\n${branch} let us know they don't have ${andList(skus)}. ${asks.join('\n\n')}\n\nThanks,\nMac`);
}

/** The tied orders as plain lines (card + Opus context). */
function ordersText(tie) {
  if (!tie || !tie.orders.length) return 'No orders tied.';
  const carrierName = require('./emailer').carrierName;
  return tie.orders.map((o) => {
    if (o.missing) return `ShipStation order ${o.orderId}: no record found`;
    const items = (o.items || []).map((i) => `${i.qty}x ${i.prosolSku || i.sku} ${tidyName(i.name)}`).join('; ');
    const pk = (o.packages || []).map((p) => [p.tracking ? `${carrierName(o.carrier) || o.carrier || ''} ${p.tracking}`.trim() : null, p.po].filter(Boolean).join(', ')).filter(Boolean).join(' / ');
    return `${orderRef(o.orderNumber)}: ${items || '(no items recorded)'}${pk ? `. ${pk}` : ''}`;
  }).join('\n');
}

const pacific = (iso) => (iso ? new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Vancouver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '?');

/** Card subject + plain-text body for Mac. */
function cardText(e, link) {
  const L = [];
  const what = e.kind === 'cant_ship' ? `can't ship ${andList((e.skus || []).map((s) => s.code))}`.trim()
    : e.kind === 'question' ? 'has a question' : e.kind === 'error' ? 'reply I could not process' : 'replied';
  const refs = [...new Set((e.tie?.orders || []).filter((o) => o.orderNumber).map((o) => orderRef(o.orderNumber)))];
  const subject = `Branch reply: ${e.warehouse} ${what}${refs.length ? ` (${refs.join(', ')})` : ''}`;
  L.push(`${e.warehouse}, ${e.from}, ${pacific(e.receivedAt)}:`, `"${e.said || '(empty)'}"`, '');
  if (e.guarded) L.push(`(Opus read this as an ack; it has ${e.guarded}, so it is carded.)`, '');
  if (e.error) L.push(`Error: ${e.error}`, '');
  L.push(`Orders on this thread${e.tie?.sentAt ? ` (sent ${pacific(e.tie.sentAt)})` : ''}:`, ordersText(e.tie));
  if (e.tie && !e.tie.sure) L.push(`NOT SURE of this tie: ${e.tie.reasons.join('; ') || 'no orders found'}.`);
  L.push('');
  for (const l of e.lines || []) {
    const st = l.stock ? (l.stock.length ? l.stock.slice(0, 8).map((s) => `${s.city} ${s.qty}`).join(', ') : 'none') : `lookup failed${l.stockError ? `: ${l.stockError}` : ''}`;
    L.push(`${l.sku}${l.order ? ` on ${orderRef(l.order)}` : ''}: Prosol stock now: ${st}.`);
    if (l.alt) L.push(`  Pick: ${l.alt.city} (${l.alt.code}, ${l.alt.qty} in stock${l.alt.thin ? ', thin' : ''}${l.province ? `; customer in ${l.province}` : ''}).`);
    else L.push(`  ${l.reason || 'No branch has stock for this.'}`);
  }
  if ((e.lines || []).length) L.push('');
  if (e.note) L.push(`Check: ${e.note}`, '');
  if (e.draft) {
    L.push('Draft to Kaitlyn (CC you), in this thread:', '', e.draft, '');
    if (link) L.push(`Send (or edit first): ${link}`);
    L.push('Or reply from your own mail.');
  } else if (e.kind === 'cant_ship') {
    L.push('No branch can take it, so there is no draft. Decide with Kaitlyn (refund, wait, or substitute).');
  }
  return { subject, text: L.join('\n') };
}

// ── Opus ────────────────────────────────────────────────────────────────────

function anthropic(client) {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic();
}

async function askTool(client, { system, user, tool, effort = 'low' }) {
  const messages = [{ role: 'user', content: user }];
  for (let turn = 0; turn < 2; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL, max_tokens: 4000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort }, system, tools: [tool], messages,
    });
    const use = (res.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (use) return use.input || {};
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: `Call ${tool.name} now.` });
  }
  throw new Error(`no ${tool.name} result`);
}

const CLASSIFY_SYSTEM = `You read replies from Prosol (our warehouse supplier) to our daily order emails. Each weekday we (YourFloors, Mac) email Kaitlyn at Prosol head office the orders one branch must ship, with our prepaid carrier labels. Kaitlyn relays to the branch; branch staff and Kaitlyn reply-all. You get only the new text of one reply.

Classify it:
- ack: confirms progress and needs nothing from us: packed, ready, printed, shipped, picked up, "will ship tonight", order confirmation attached, Kaitlyn relaying to the branch ("@Order Kingston please see the waybills attached").
- cant_ship: the branch cannot ship some item: not in stock, short, backordered, damaged, discontinued. List every product code they name with the quantity if stated. A "are you willing to wait?" about a missing item is still cant_ship.
- question: asks us (Mac / YourFloors) to decide or answer: "please advise", one box vs separate waybills, address problem, "can we ...?".
- other: anything else that is not a plain ack.
Product codes look like KP27-01, KL1V60E90, 3BU003891, DHPS512M. Do not list Prosol order numbers (7 digits like 7002740), PO numbers or tracking numbers as codes.`;

const CLASSIFY_TOOL = {
  name: 'submit_classification',
  description: 'Submit the classification of the reply.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS },
      skus: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, qty: { type: ['integer', 'null'] } }, required: ['code'] }, description: 'Product codes named as not shippable (cant_ship) or asked about. Empty if none.' },
      summary: { type: 'string', description: 'One short line: what they said.' },
    },
    required: ['kind', 'skus', 'summary'],
  },
};

async function classifyWithClaude({ text, branch, from, subject }, { client } = {}) {
  const i = await askTool(anthropic(client), {
    system: CLASSIFY_SYSTEM,
    tool: CLASSIFY_TOOL,
    user: `Branch thread: ${subject}\nFrom: ${from}${branch ? ` (branch ${branch})` : ''}\n\nNew text of the reply:\n${text || '(empty)'}`,
  });
  return {
    kind: KINDS.includes(i.kind) ? i.kind : 'other',
    skus: (Array.isArray(i.skus) ? i.skus : []).filter((s) => s && s.code).map((s) => ({ code: String(s.code).trim(), qty: Number.isInteger(s.qty) && s.qty > 0 ? s.qty : null })),
    summary: String(i.summary || '').slice(0, 300),
  };
}

const DRAFT_SYSTEM = `You draft Mac's reply to Kaitlyn at Prosol (our warehouse supplier), in the thread where a Prosol branch or Kaitlyn wrote to us about orders we sent them. Mac reads it before it sends and may edit it.
Rules:
- Plain text. Start "Hi Kaitlyn," and end exactly "Thanks,\\nMac".
- One to three short sentences. Action only: say what to do, with the order number, SKU, quantity and PO or tracking when it helps. No pleasantries beyond the greeting, no apology, no em dashes.
- Answer what they asked with the most sensible choice for a small online store shipping on our own prepaid labels: e.g. everything in one box is fine when it fits; keep the labels we sent.
- Never ask them to make, void or change a shipping label, never promise payment, refunds or credits, never invent facts not in the orders list.
- If the right answer depends on something only Mac knows, write the most likely answer and set needs_mac_note to what he should check.`;

const DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Submit the drafted reply.',
  input_schema: { type: 'object', properties: { reply: { type: 'string' }, needs_mac_note: { type: 'string' } }, required: ['reply'] },
};

async function draftWithClaude({ entry }, { client } = {}) {
  const i = await askTool(anthropic(client), {
    system: DRAFT_SYSTEM, tool: DRAFT_TOOL, effort: 'medium',
    user: `Thread: ${entry.subject}\nFrom: ${entry.from} (branch ${entry.warehouse})\n\nThey wrote:\n${entry.said}\n\nOrders on this thread:\n${ordersText(entry.tie)}${entry.tie && !entry.tie.sure ? `\n(Tie not certain: ${entry.tie.reasons.join('; ')})` : ''}`,
  });
  return { reply: noDash(String(i.reply || '').trim()), note: String(i.needs_mac_note || '').trim() };
}

// ── State + links ───────────────────────────────────────────────────────────

function loadState(file = DEFAULT_STATE) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.messages ||= {}; s.vendorErrors ||= {}; return s; } catch { return { lastSeenAt: null, messages: {}, vendorErrors: {} }; }
}
function saveState(state, file = DEFAULT_STATE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}
/** Load fresh, mutate, save: the cron run and a Send tap are separate processes, so never save a stale copy. */
function updateState(file, fn) {
  const s = loadState(file);
  const r = fn(s);
  saveState(s, file);
  return r;
}
const keyOf = (graphId) => crypto.createHash('sha256').update(String(graphId)).digest('hex').slice(0, 16);
function sendToken(key, secret = process.env.RETURNS_APPROVE_SECRET || process.env.SKU_RESOLVER_SECRET) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`branch-replies|${key}`).digest('hex').slice(0, 32);
}
function verifySend(key, token, secret) {
  const t = sendToken(key, secret);
  return !!t && typeof token === 'string' && token.length === t.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
}

// ── Run ─────────────────────────────────────────────────────────────────────

/** The cant_ship plan: for each code they named, the tied order line, live stock, and the branch to ask. */
async function planCantShip(entry, cls, io, origin) {
  const lines = [];
  let codes = cls.skus.slice();
  if (!codes.length) {
    const all = entry.tie.orders.flatMap((o) => (o.items || []).map((i) => ({ o, i })));
    if (all.length === 1) { codes = [{ code: all[0].i.prosolSku || all[0].i.sku, qty: null }]; entry.note = 'The reply names no code; this is the only item on the tied order.'; }
  }
  const stockCache = new Map();
  for (const s of codes) {
    const hits = entry.tie.orders.flatMap((o) => (o.items || []).filter((i) => itemHasCode(i, s.code)).map((i) => ({ o, i })));
    if (!hits.length) { lines.push({ sku: s.code, order: null, reason: `No tied order carries ${s.code}, so there is nothing to reroute.` }); continue; }
    for (const { o, i } of hits) {
      const need = s.qty || i.qty || 1;
      const line = { sku: i.prosolSku || s.code, order: o.orderNumber, qty: need, name: i.name, carrier: o.carrier, ...packageFor(o, i) };
      const ck = norm(i.sku);
      try {
        if (!stockCache.has(ck)) stockCache.set(ck, await io.stock(i));
        line.stock = stockCache.get(ck);
      } catch (err) { line.stock = null; line.stockError = err.message; }
      if (line.stock) {
        let province = null;
        try { province = io.province ? await io.province(o) : null; } catch { province = null; }
        line.province = province;
        const c = chooseAltBranch({ stock: line.stock, need, exclude: entry.code, province, origin });
        line.alt = c.pick;
        if (!c.pick) line.reason = `No other branch has ${need} of ${line.sku}.`;
      } else {
        line.reason = 'Could not read Prosol stock, so no branch is suggested.';
      }
      lines.push(line);
    }
  }
  return lines;
}
function packageFor(o, item) {
  const p = (o.packages || []).find((x) => (x.items || []).some((i) => i.sku === item.sku)) || (o.packages || [])[0] || {};
  return { tracking: p.tracking || o.tracking || null, po: p.po || o.po || null };
}

/**
 * One pass. mode: 'live' (state + audit + cards + vendor errors), 'shadow' (state + audit only), 'dry' (nothing
 * written; replay with `since`).
 * io: listMessages(sinceIso) -> Graph messages (id, subject, from, receivedDateTime, conversationId, isDraft)
 *     body(graphId) -> full text body; threadStart(conversationId) -> ISO | null
 *     emails() -> pipeline-email-prosol audit entries; factsFor(orderId, sentAtIso) -> order facts | null
 *     stock(item) -> [{ code, city, province, lat, lng, qty }]; province(order) -> 'ON' | null; origin(code) -> [lat, lng]
 *     classify({ text, branch, from, subject }); draft({ entry }) -> { reply, note }
 *     notifyMac({ subject, text }); audit(obj); logVendorError(rec); vendorErrorExists(orderNumber, sku) -> bool
 *     link(key) -> Send URL | null
 */
async function run({ io, mode = 'shadow', since = null, now = new Date(), stateFile = DEFAULT_STATE, log = () => {} } = {}) {
  const write = mode !== 'dry';
  const st = loadState(stateFile);
  const out = { mode, firstRun: false, processed: [], skipped: 0, errors: [] };
  if (!since && !st.lastSeenAt) {
    // First run starts from now: the history is replayed by hand with --since --dry, never carded in bulk.
    if (write) updateState(stateFile, (s) => { s.lastSeenAt = now.toISOString(); s.startedAt = now.toISOString(); });
    out.firstRun = true;
    return out;
  }
  const from = since || new Date(Date.parse(st.lastSeenAt) - 15 * 60e3).toISOString();
  const msgs = (await io.listMessages(from)).filter(isBranchReply).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
  const emails = await io.emails();
  let newest = st.lastSeenAt;
  let oldestPending = null;

  for (const msg of msgs) {
    const key = keyOf(msg.id);
    const known = st.messages[key];
    if (write && known && known.status !== 'retry') { out.skipped++; continue; }
    const sub = parseSubject(msg.subject);
    const entry = { key, graphId: msg.id, conversationId: msg.conversationId, receivedAt: msg.receivedDateTime, from: fromAddr(msg), subject: msg.subject, ...sub, mode };
    try {
      const full = await io.body(msg.id);
      entry.said = stripQuote(full);
      const cls = await io.classify({ text: entry.said, branch: sub.branch, from: entry.from, subject: msg.subject });
      const g = applyGuard(cls.kind, entry.said);
      Object.assign(entry, { kind: g.kind, guarded: g.guarded, opusKind: cls.kind, skus: cls.skus, summary: cls.summary });
      const threadStart = await io.threadStart(msg.conversationId).catch(() => null);
      entry.tie = await tieOrders({ code: sub.code, threadStart, receivedAt: msg.receivedDateTime, emails, refs: threadRefs(full), skuCodes: cls.skus, factsFor: io.factsFor });

      if (entry.kind === 'cant_ship') {
        entry.lines = await planCantShip(entry, cls, io, io.origin ? io.origin(sub.code) : null);
        entry.draft = cantShipDraft({ branch: sub.branch, lines: entry.lines });
      } else if (entry.kind !== 'ack') {
        const d = await io.draft({ entry });
        entry.draft = d.reply || null;
        entry.note = d.note || null;
      }
      entry.status = entry.kind === 'ack' ? 'ack' : mode === 'live' ? 'carded' : mode;

      if (mode === 'live' && entry.kind !== 'ack') {
        await io.notifyMac(cardText(entry, entry.draft ? io.link(key) : null));
        entry.cardedAt = new Date().toISOString();
      }
      if (mode === 'live' && entry.kind === 'cant_ship') {
        for (const l of entry.lines || []) {
          if (!l.order) continue;
          const vk = `${l.order}|${norm(l.sku)}`;
          if (st.vendorErrors[vk] || loadState(stateFile).vendorErrors[vk]) continue;
          let id = 'already-in-ledger';
          if (!(await io.vendorErrorExists(l.order, l.sku))) {
            const rec = await io.logVendorError({
              vendor: 'Prosol', location: sub.warehouse, issue_type: 'not_shipped', order_ref: l.order, po_ref: l.po || null, sku: l.sku,
              qty_affected: l.qty, tracking: l.tracking || null, reported_by: 'branch-replies', source: 'pipeline_detected',
              description: `${sub.warehouse} replied ${String(msg.receivedDateTime).slice(0, 10)} (${entry.from}): "${entry.said.slice(0, 300)}"`,
              resolution: l.alt ? `Pending Mac: ask Kaitlyn to ship from ${l.alt.city} (${l.alt.qty} in stock) on the same label` : 'Pending Mac: no other branch had stock',
            });
            id = rec && rec.id;
          }
          st.vendorErrors[vk] = id;
          if (write) updateState(stateFile, (s) => { s.vendorErrors[vk] = id; });
        }
      }
      if (write) {
        io.audit({ action: 'branch-reply', mode, key, warehouse: sub.warehouse, from: entry.from, kind: entry.kind, opusKind: cls.kind, guarded: entry.guarded,
          orders: entry.tie.orders.map((o) => o.orderNumber || o.orderId), sure: entry.tie.sure, skus: cls.skus.map((s) => s.code), carded: !!entry.cardedAt });
        updateState(stateFile, (s) => { s.messages[key] = entry; });
      }
      out.processed.push(entry);
      if (!newest || msg.receivedDateTime > newest) newest = msg.receivedDateTime;
    } catch (err) {
      log(`${msg.subject}: ${err.message}`);
      const attempts = ((known && known.attempts) || 0) + 1;
      out.errors.push({ key, subject: msg.subject, from: entry.from, error: err.message, attempts });
      if (!write) continue;
      if (attempts >= MAX_ATTEMPTS) {
        Object.assign(entry, { kind: 'error', status: 'error', error: err.message, attempts, said: entry.said || '' });
        entry.tie ||= { sure: false, reasons: ['not tied'], orders: [] };
        if (mode === 'live') { try { await io.notifyMac(cardText(entry, null)); entry.cardedAt = new Date().toISOString(); } catch { /* next pass */ } }
        updateState(stateFile, (s) => { s.messages[key] = entry; });
        if (!newest || msg.receivedDateTime > newest) newest = msg.receivedDateTime;
      } else {
        updateState(stateFile, (s) => { s.messages[key] = { key, status: 'retry', attempts, error: err.message, receivedAt: msg.receivedDateTime, subject: msg.subject }; });
        if (!oldestPending || msg.receivedDateTime < oldestPending) oldestPending = msg.receivedDateTime;
      }
    }
  }
  if (write && !since) {
    // A reply that failed this pass keeps the marker behind it, so the next pass lists it again.
    let mark = newest;
    if (oldestPending) { const p = new Date(Date.parse(oldestPending) - 1000).toISOString(); if (!mark || p < mark) mark = p; }
    updateState(stateFile, (s) => {
      if (mark && (oldestPending || !s.lastSeenAt || mark > s.lastSeenAt)) s.lastSeenAt = mark;
      s.lastRunAt = now.toISOString();
    });
  }
  return out;
}

// ── Send (Mac's tap) ────────────────────────────────────────────────────────

async function gjson(g, p, opts) { const r = await g.graphFetch(p, opts); const t = await r.text(); try { return JSON.parse(t); } catch { return {}; } }
const addrs = (list) => (list || []).map((r) => String(r?.emailAddress?.address || '').toLowerCase());
const escapeOData = (s) => String(s).replace(/'/g, "''");

/** Our reply is in hello@ Sent Items: same conversation, sent at/after `sinceIso`, to Kaitlyn. */
async function findSent(g, conversationId, sinceIso, kaitlyn) {
  const r = await gjson(g, `/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`conversationId eq '${escapeOData(conversationId)}'`)}&$select=id,sentDateTime,toRecipients&$top=25`);
  const floor = Date.parse(sinceIso) - 60e3;
  return (r.value || []).find((m) => Date.parse(m.sentDateTime) >= floor && addrs(m.toRecipients).includes(kaitlyn)) || null;
}

/**
 * Reply in the branch's thread: createReplyAll on their message, then the body set to plain text and the recipients
 * forced to Kaitlyn only, CC Mac, no BCC; every attachment removed (createReplyAll copies inline signature images);
 * re-read and checked (same conversation, exactly one To = Kaitlyn, CC = Mac, no BCC, no attachments) before Send;
 * then confirmed in Sent Items. A check that fails deletes the draft and throws; nothing is sent.
 * Throws with err.phase 'pre-send' (safe to retry) or 'post-send' (it may have gone out).
 */
async function sendReply(g, entry, text, { kaitlyn = KAITLYN(), mac = MAC(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date() } = {}) {
  kaitlyn = kaitlyn.toLowerCase(); mac = mac.toLowerCase();
  const fail = (msg, phase = 'pre-send') => { const e = new Error(msg); e.phase = phase; return e; };
  const body = String(text || '').trim();
  if (!body) throw fail('empty reply');
  const draft = await gjson(g, `/me/messages/${encodeURIComponent(entry.graphId)}/createReplyAll`, { method: 'POST', body: '{}' });
  if (!draft.id) throw fail(`createReplyAll failed: ${JSON.stringify(draft).slice(0, 200)}`);
  const dpath = `/me/messages/${encodeURIComponent(draft.id)}`;
  const abort = async (msg) => { try { await g.graphFetch(dpath, { method: 'DELETE' }); } catch { /* leave it in Drafts */ } return fail(msg); };
  try {
    if (draft.conversationId && draft.conversationId !== entry.conversationId) throw await abort('the reply draft is not in the branch thread (conversationId differs); not sent');
    const quote = `\n\n________________________________\nFrom: ${entry.from}\nSent: ${pacific(entry.receivedAt)}\nSubject: ${entry.subject}\n\n${entry.said || ''}`;
    await g.graphFetch(dpath, { method: 'PATCH', body: JSON.stringify({
      body: { contentType: 'Text', content: `${noDash(body)}${quote}` },
      toRecipients: [{ emailAddress: { address: kaitlyn } }],
      ccRecipients: [{ emailAddress: { address: mac } }],
      bccRecipients: [],
    }) });
    const atts = await gjson(g, `${dpath}/attachments?$select=id`);
    for (const a of atts.value || []) await g.graphFetch(`${dpath}/attachments/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
    const chk = await gjson(g, `${dpath}?$select=conversationId,toRecipients,ccRecipients,bccRecipients,hasAttachments`);
    const left = await gjson(g, `${dpath}/attachments?$select=id`);
    const to = addrs(chk.toRecipients); const cc = addrs(chk.ccRecipients); const bcc = addrs(chk.bccRecipients);
    if (chk.conversationId !== entry.conversationId) throw await abort('the reply draft is not in the branch thread (conversationId differs); not sent');
    if (to.length !== 1 || to[0] !== kaitlyn) throw await abort(`To must be only ${kaitlyn}, draft has ${to.join(', ') || 'nobody'}; not sent`);
    if (cc.length !== 1 || cc[0] !== mac) throw await abort(`CC must be only ${mac}, draft has ${cc.join(', ') || 'nobody'}; not sent`);
    if (bcc.length) throw await abort('the draft has BCC recipients; not sent');
    if ((left.value || []).length) throw await abort('attachments could not be removed from the draft; not sent');
  } catch (err) {
    if (err.phase) throw err;
    throw await abort(`draft setup failed: ${err.message}`);
  }
  const startedAt = now().toISOString();
  try {
    await g.graphFetch(`${dpath}/send`, { method: 'POST', body: '{}' });
  } catch (err) {
    throw fail(`send call failed: ${err.message}`, 'post-send');
  }
  for (let i = 0; i < 6; i++) {
    const m = await findSent(g, entry.conversationId, startedAt, kaitlyn).catch(() => null);
    if (m) return { sentId: m.id, sentAt: m.sentDateTime };
    await sleep(3000);
  }
  throw fail('sent, but the reply is not in hello@ Sent Items yet; check Sent Items before tapping again', 'post-send');
}

/**
 * Mac tapped Send. One send per key: 'sent' returns as is; 'sending' (a tap whose send was not confirmed) is
 * resolved from Sent Items first and is only retried after 10 minutes with nothing there.
 */
async function sendCarded(key, { graph, text, stateFile = DEFAULT_STATE, now = new Date(), audit = () => {}, sendOpts = {} } = {}) {
  const e = loadState(stateFile).messages[key];
  if (!e || !e.graphId) throw new Error('message not found');
  if (e.status === 'sent') return e;
  const kaitlyn = (sendOpts.kaitlyn || KAITLYN()).toLowerCase();
  if (e.status === 'sending') {
    const m = await findSent(graph, e.conversationId, e.sendStartedAt, kaitlyn).catch(() => null);
    if (m) return updateState(stateFile, (s) => Object.assign(s.messages[key], { status: 'sent', sentAt: m.sentDateTime, sentId: m.id }));
    if (now - Date.parse(e.sendStartedAt) < 10 * 60e3) throw new Error(`A send started ${e.sendStartedAt} and is not in Sent Items yet. Check hello@ Sent Items; try again in 10 minutes if it is not there.`);
  }
  const reply = noDash(String(text ?? e.draft ?? '').trim());
  if (!reply) throw new Error('empty reply');
  const prev = e.status === 'sending' ? (e.prevStatus || 'carded') : e.status;
  updateState(stateFile, (s) => Object.assign(s.messages[key], { status: 'sending', prevStatus: prev, sendStartedAt: now.toISOString() }));
  try {
    const r = await sendReply(graph, e, reply, sendOpts);
    const done = updateState(stateFile, (s) => Object.assign(s.messages[key], { status: 'sent', sentAt: r.sentAt, sentId: r.sentId, sentText: reply, lastSendError: null }));
    audit({ action: 'branch-reply-sent', key, warehouse: e.warehouse, kind: e.kind, orders: (e.tie?.orders || []).map((o) => o.orderNumber || o.orderId), to: kaitlyn });
    return done;
  } catch (err) {
    updateState(stateFile, (s) => Object.assign(s.messages[key], err.phase === 'post-send'
      ? { lastSendError: err.message }
      : { status: prev, lastSendError: err.message }));
    throw err;
  }
}

module.exports = {
  parseSubject, isBranchReply, stripQuote, guardHits, applyGuard, threadRefs, tieOrders, opsStateOrder, chooseAltBranch,
  cantShipDraft, ordersText, cardText, classifyWithClaude, draftWithClaude, run, sendReply, sendCarded,
  loadState, saveState, keyOf, sendToken, verifySend, DEFAULT_STATE, KINDS, PROVINCE_CENTRE,
};
