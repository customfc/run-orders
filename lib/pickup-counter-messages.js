/**
 * Customer emails for counter pickups and split orders (PICKUP-ZONES-PLAN.md 3.3 and 2.6). Pure: builds subject,
 * text and html; never sends. Same copy rules and sender as lib/pickup-messages.js (Coast truck messages): from
 * hello@yourfloors.ca, signed "The YourFloors team", the distributor never named, no dashes, no "Hi there".
 *
 *   branch_ordered    at order time for a counter pickup: where, usually ready in 2 to 4 business days, wait for the
 *                     ready email                                          (Mac 2026-10-02 D2: standing OK)
 *   ready_for_pickup  it's ready: where, hours, bring the order number     (D2: standing OK; replaces Shopify's
 *                                                                          native Ready email, which needs native
 *                                                                          pickup)
 *   counter_reminder  ready but not collected (3 and 7 business days)      (same class as the Coast reminders)
 *   counter_picked_up thanks, after pickup                                 (same class as the Coast picked_up)
 *   split_choice      an order that chose shipping but holds full-length trims: pick a counter or a refund
 *                                                                          (Mac 2026-10-02: "1. ok")
 *   trims_refunded    the trims were refunded (they asked, or no answer by the deadline)
 *                                                                          (Mac 2026-10-02: "2. yes ok")
 *
 * place: { customer_name: 'our Calgary South trade counter', address, hours, idNeeded }.
 */

'use strict';

const { FROM, REPLY_TO, SIGN_OFF, customerTextProblems, placeholdersIn } = require('./pickup-messages');
const eta = require('./pickup-eta');

const TYPES = ['branch_ordered', 'ready_for_pickup', 'counter_reminder', 'counter_picked_up', 'split_choice', 'trims_refunded'];
// Mac's standing OK for these exact templates (2026-10-02); a new type or changed wording needs a new OK.
const STANDING_OK = Object.freeze(TYPES.slice());

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const orderLabel = (n) => { const s = String(n == null ? '' : n).trim(); if (!s) throw new Error('orderName required'); return s.startsWith('#') ? s : `#${s}`; };
const greeting = (first) => { const n = String(first || '').trim().split(/\s+/)[0]; return n ? `Hi ${n},` : 'Hi,'; };
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const list = (items) => { const a = (items || []).map((x) => String(x).trim()).filter(Boolean); return a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; };

function placeLines(p) {
  if (!p || !p.customer_name || !p.address) throw new Error('place with customer_name and address required');
  return [`Pickup: ${p.customer_name}, ${p.address}`, ...(p.hours ? [`Hours: ${p.hours}`] : [])];
}
const bring = (p) => (p && p.idNeeded ? 'Bring your order number and photo ID.' : 'Bring your order number.');

const BODIES = {
  branch_ordered: (c, o) => ({
    subject: `Your order ${o} is being prepared for pickup`,
    lines: [greeting(c.firstName), '', `Thanks for your order ${o}. We're getting it ready at ${c.place.customer_name}.`, '',
      `It's usually ready in ${c.readyIn || '2 to 4 business days'}. We'll email you as soon as it's ready, so please wait for that email before you head over.`, '',
      ...placeLines(c.place), bring(c.place)],
  }),
  ready_for_pickup: (c, o) => ({
    subject: `Your order ${o} is ready for pickup`,
    lines: [greeting(c.firstName), '', `Your order ${o} is ready at ${c.place.customer_name}.`, '', ...placeLines(c.place), bring(c.place)],
  }),
  counter_reminder: (c, o) => ({
    subject: `Your order ${o} is waiting for you`,
    lines: [greeting(c.firstName), '', `Just a reminder that your order ${o} is ready at ${c.place.customer_name}.`, '', ...placeLines(c.place), bring(c.place), '',
      "If you can't make it, reply to this email and we'll sort it out."],
  }),
  counter_picked_up: (c, o) => ({
    subject: `Thanks for picking up order ${o}`,
    lines: [greeting(c.firstName), '', `Thanks for picking up your order ${o}. Any questions about it, just reply to this email.`],
  }),
  split_choice: (c, o) => {
    if (!c.choices || !c.choices.length) throw new Error('split_choice needs counter choices');
    if (!c.refundUrl) throw new Error('split_choice needs refundUrl');
    if (!c.deadline) throw new Error('split_choice needs a deadline');
    return {
      subject: `Your order ${o}: how would you like your trims?`,
      lines: [greeting(c.firstName), '',
        `Thanks for your order ${o}. The ${list(c.trimItems)} ${(c.trimItems || []).length > 1 ? 'are' : 'is'} full length (8 ft or longer), too long for couriers, so ${(c.trimItems || []).length > 1 ? 'they' : 'it'} can't ship with the rest of your order. Everything else ships as usual.`, '',
        'Choose one:', '',
        ...c.choices.map((ch) => `Pick up at ${ch.customer_name}, ${ch.address}: ${ch.url}`), '',
        `Refund the trims: ${c.refundUrl}`, '',
        `If we don't hear from you by ${eta.formatCustomerDate(c.deadline)}, we'll refund the trims.`],
      buttons: [...c.choices.map((ch) => ({ label: `Pick up at ${ch.label}`, sub: ch.address, url: ch.url })), { label: 'Refund the trims', url: c.refundUrl, secondary: true }],
    };
  },
  trims_refunded: (c, o) => ({
    subject: `Refund for the trims on order ${o}`,
    lines: [greeting(c.firstName), '',
      `We've refunded ${money(c.amount)} for the full-length trims on order ${o} (${list(c.trimItems)})${c.reason === 'no_answer' ? ", since we didn't hear back about pickup" : ', as you asked'}. It goes back to your card in a few business days.`, '',
      "If you'd still like them, order them on their own at www.yourfloors.ca and choose pickup at a counter near you."],
  }),
};

function textToHtml(lines, buttons) {
  const body = lines.filter((l) => !(buttons && /: https?:\/\//.test(l) && /^(Pick up at|Refund the trims)/.test(l)))
    .map((l) => (l ? `<p style="margin:0 0 4px">${esc(l)}</p>` : '<p style="margin:0 0 10px"></p>')).join('\n');
  if (!buttons) return body;
  const btns = buttons.map((b) => `<p style="margin:10px 0"><a href="${esc(b.url)}" style="display:inline-block;padding:12px 20px;border-radius:100px;text-decoration:none;font-weight:700;${b.secondary ? 'background:#fff;color:#111;border:1px solid #bbb' : 'background:#111;color:#fff'}">${esc(b.label)}</a>${b.sub ? `<br><span style="font-size:13px;color:#666">${esc(b.sub)}</span>` : ''}</p>`).join('\n');
  const i = body.indexOf('Choose one:');
  if (i < 0) return `${body}\n${btns}`;
  const end = body.indexOf('</p>', i) + 4;
  return `${body.slice(0, end)}\n${btns}\n${body.slice(end)}`;
}

function buildCounterMessage(type, ctx = {}) {
  if (!TYPES.includes(type)) throw new Error(`counter message: unknown type "${type}"`);
  const o = orderLabel(ctx.orderName);
  const { subject, lines, buttons } = BODIES[type](ctx, o);
  const all = [...lines, '', SIGN_OFF, ''];
  const text = all.join('\n');
  const problems = customerTextProblems(`${subject}\n${text}`);
  if (problems.length) throw new Error(`counter message ${type}: ${problems.join(', ')}`);
  return { type, from: FROM, replyTo: REPLY_TO, subject, text, html: textToHtml(all, buttons), placeholders: placeholdersIn(`${subject}\n${text}`) };
}

const autoSendAllowed = (type, msg) => STANDING_OK.includes(type) && !!msg && !msg.placeholders.length;

module.exports = { TYPES, STANDING_OK, buildCounterMessage, autoSendAllowed };
