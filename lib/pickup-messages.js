/**
 * Customer messages for Coast pickup orders (Sechelt Warehouse, Powell River). Pure: builds subject, plain text
 * and simple HTML; never sends. Dates come from lib/pickup-eta.js, places and hours from
 * data/trade/pickup-schedule.json.
 *
 * Copy rules (tested): From YourFloors Support <hello@yourfloors.ca>, reply-to hello@yourfloors.ca, signed
 * "The YourFloors team"; the distributor is never named; no em or en dashes; no "Hi there"; no hint that a
 * message is automated. Anything Mac has not decided yet shows as a [MAC: ...] placeholder, listed in
 * `placeholders`: readyToSend() is false until there are none, so a sender must refuse such a message.
 *
 *   buildPickupMessage(type, ctx)       one message for one order. Types:
 *     received_in_stock  (a) at order time, everything on the shelf (optional: Shopify's confirmation may do)
 *     ordering_in        (b) at order time, something is ordered in: the truck day and the expected ready date
 *     on_truck           (c) on the truck day
 *     reminder_1         (e) ready but not collected after 3 business days
 *     reminder_2         (f) after 7 business days
 *     delayed            (g) the run did not bring it: the new truck day and ready date (pickupEta.delayedEta)
 *     picked_up          (h) after pickup
 *   shopifyReadyForPickupTemplate()     (d) Liquid for Shopify's native "Ready for pickup" notification
 *   pickupInstructions(location)        the per-location text for locationLocalPickupEnable(instructions)
 *   messageTimeline(eta)                which message goes out when, for one pickupEta() result
 *   STANDING_OK, autoSendAllowed(type, message)
 *                                       Mac's standing OK (2026-09-28) for these templates: a runner may send a
 *                                       listed type without a per-email send-it once readyToSend() is true
 *
 * ctx: { orderName, firstName, location: 'sechelt' | 'powell_river', readyBy, truckDay, readySince,
 *        missedTruckDay, today, partial }. Dates are BC 'YYYY-MM-DD'. partial is pickupEta().partial
 *        ({ lineIndexes, readyBy }: the in-stock part the customer may pick up early) or null.
 */

'use strict';

const eta = require('./pickup-eta');

const FROM = 'YourFloors Support <hello@yourfloors.ca>';
const REPLY_TO = 'hello@yourfloors.ca';
const SIGN_OFF = 'The YourFloors team';
const TYPES = ['received_in_stock', 'ordering_in', 'on_truck', 'reminder_1', 'reminder_2', 'delayed', 'picked_up'];
const PLACEHOLDER = /\[MAC:[^\]]*\]/g;

/** Copy problems in customer-facing text ([] when clean). Placeholders are not problems; see placeholdersIn. */
function customerTextProblems(text) {
  const t = String(text || '');
  const out = [];
  if (/[—]/.test(t)) out.push('em dash');
  if (/[–]/.test(t)) out.push('en dash');
  if (/prosol/i.test(t)) out.push('names the distributor');
  if (/\b(hi|hey|hello) there\b/i.test(t)) out.push('generic greeting');
  if (/real person|a human|automated|do not reply|don't reply|no-?reply/i.test(t)) out.push('sounds automated');
  return out;
}

const placeholdersIn = (text) => [...new Set(String(text || '').match(PLACEHOLDER) || [])];

function orderLabel(orderName) {
  const s = String(orderName == null ? '' : orderName).trim();
  if (!s) throw new Error('pickup message: orderName is required');
  return s.startsWith('#') ? s : `#${s}`;
}

function greeting(firstName) {
  const n = String(firstName || '').trim().split(/\s+/)[0] || '';
  return n ? `Hi ${n},` : 'Hi,';
}

function place(location, schedule) {
  const loc = (schedule.locations || {})[location];
  if (!loc) throw new Error(`pickup message: unknown location "${location}"`);
  const town = location === 'powell_river' ? 'Powell River' : 'Sechelt';
  return { ...loc, town };
}

const day = (d, label) => {
  if (!d) throw new Error(`pickup message: ${label} is required`);
  return eta.formatCustomerDate(d);
};

const whereLines = (p, orderLbl) => [
  `Pickup: ${p.customer_name}, ${p.address}`,
  `Hours: ${p.hours}`,
  ...(orderLbl ? [`Bring your order number, ${orderLbl}.`] : []),
];

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text to simple HTML: blank-line paragraphs, "- " lines as a list, other line breaks kept. */
function textToHtml(text) {
  const blocks = String(text).split(/\n{2,}/);
  const html = blocks.map((b) => {
    const lines = b.split('\n');
    const head = lines[0].startsWith('- ') ? null : lines[0];
    const items = head === null ? lines : lines.slice(1);
    if (items.length && items.every((l) => l.startsWith('- '))) {
      const intro = head === null ? '' : `<p style="margin:0 0 6px">${escapeHtml(head)}</p>`;
      return `${intro}<ul style="margin:0 0 14px;padding-left:20px">${items.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 14px">${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('\n');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">\n${html}\n</div>`;
}

const BODIES = {
  received_in_stock(c, p, o) {
    const when = c.today && c.today === c.readyBy ? 'later today' : `by ${day(c.readyBy, 'readyBy')}`;
    return {
      subject: `Order ${o}: in stock for pickup`,
      lines: [
        greeting(c.firstName), '',
        `Thanks for your order ${o}. Everything is in stock at ${p.customer_name}.`, '',
        `We'll have it ready for pickup ${when}. We'll email you as soon as it's ready, so please wait for that email before you come in.`, '',
        ...whereLines(p), '',
        'Questions? Reply to this email.',
      ],
    };
  },
  ordering_in(c, p, o) {
    const truck = day(c.truckDay, 'truckDay');
    if (c.partial) {
      // Mac 2026-09-28: "let them take in-stock part early if they want".
      if (typeof c.partial !== 'object' || !c.partial.readyBy) throw new Error('pickup message: partial.readyBy is required (pickupEta().partial)');
      const early = c.today && c.today === c.partial.readyBy ? 'later today' : `on ${day(c.partial.readyBy, 'partial.readyBy')}`;
      return {
        subject: `Order ${o}: we're bringing it in`,
        lines: [
          greeting(c.firstName), '',
          `Thanks for your order ${o}. Some of it is in stock at ${p.customer_name}, and we're bringing the rest in on our ${truck} truck.`, '',
          `If you'd like the in-stock items early, they'll be ready for pickup ${early}. We'll email you when that part is ready.`, '',
          `Everything else is expected ready for pickup ${day(c.readyBy, 'readyBy')}, at ${p.customer_name}, ${p.address}.`, '',
          'You can come in once for everything, or twice: once for the in-stock items and again for the rest.', '',
          'What happens next:',
          `- On ${truck} we'll email you when the rest of your order is on the truck.`,
          "- When it's here and packed, you'll get a \"ready for pickup\" email for it. Please wait for that email before you come in for those items.",
          '',
          'Questions? Reply to this email.',
        ],
      };
    }
    return {
      subject: `Order ${o}: we're bringing it in`,
      lines: [
        greeting(c.firstName), '',
        `Thanks for your order ${o}. We're bringing it in on our ${truck} truck.`, '',
        `Expected ready for pickup: ${day(c.readyBy, 'readyBy')}, at ${p.customer_name}, ${p.address}.`, '',
        'What happens next:',
        `- On ${truck} we'll email you when your order is on the truck.`,
        "- When it's here and packed, you'll get a \"ready for pickup\" email. Please wait for that email before you come in.",
        '',
        'Questions? Reply to this email.',
      ],
    };
  },
  on_truck(c, p, o) {
    return {
      subject: `Order ${o} is on the truck today`,
      lines: [
        greeting(c.firstName), '',
        `Your order ${o} is coming over on our truck today. We expect it ready for pickup ${day(c.readyBy, 'readyBy')}, at ${p.customer_name}.`, '',
        "We'll email you as soon as it's ready. Please wait for that email before you come in.",
      ],
    };
  },
  reminder_1(c, p, o) {
    return {
      subject: `Reminder: order ${o} is ready for pickup`,
      lines: [
        greeting(c.firstName), '',
        `Just a reminder that your order ${o} has been ready for pickup since ${day(c.readySince, 'readySince')}.`, '',
        ...whereLines(p, o), '',
        "Can't make it in? Reply to this email and we'll work it out.",
      ],
    };
  },
  reminder_2(c, p, o, s) {
    return {
      subject: `Order ${o} is still waiting for you`,
      lines: [
        greeting(c.firstName), '',
        `Your order ${o} is still waiting for pickup at ${p.customer_name}. It has been ready since ${day(c.readySince, 'readySince')}.`, '',
        (s.reminders && s.reminders.hold_policy) || '[MAC: how long we hold a ready order, and what happens after]', '',
        ...whereLines(p, o), '',
        "If your plans have changed, reply to this email and we'll sort it out.",
      ],
    };
  },
  delayed(c, p, o) {
    return {
      subject: `Order ${o}: new pickup date`,
      lines: [
        greeting(c.firstName), '',
        `Some of the items in your order ${o} didn't come in on our ${day(c.missedTruckDay, 'missedTruckDay')} truck. They're now coming on ${day(c.truckDay, 'truckDay')}, and we expect your order ready for pickup ${day(c.readyBy, 'readyBy')}.`, '',
        "We'll email you as soon as it's ready. Sorry for the wait.",
      ],
    };
  },
  picked_up(c, p, o) {
    return {
      subject: `Thanks for picking up order ${o}`,
      lines: [
        greeting(c.firstName), '',
        `Thanks for picking up your order ${o}.`, '',
        "If anything is missing or not right, reply to this email and we'll sort it out.",
      ],
    };
  },
};

/**
 * Build one message. Returns { type, from, replyTo, subject, text, html, placeholders }.
 * Throws on a copy problem (never returns text that names the distributor or carries a dash).
 */
function buildPickupMessage(type, ctx = {}, schedule = eta.DEFAULT_SCHEDULE) {
  if (!TYPES.includes(type)) throw new Error(`pickup message: unknown type "${type}" (one of ${TYPES.join(', ')})`);
  const o = orderLabel(ctx.orderName);
  const p = place(ctx.location, schedule);
  const { subject, lines } = BODIES[type](ctx, p, o, schedule);
  const text = [...lines, '', SIGN_OFF, ''].join('\n');
  const problems = customerTextProblems(`${subject}\n${text}`);
  if (problems.length) throw new Error(`pickup message ${type}: ${problems.join(', ')}`);
  return {
    type,
    from: FROM,
    replyTo: REPLY_TO,
    subject,
    text,
    html: textToHtml(text),
    placeholders: placeholdersIn(`${subject}\n${text}`),
  };
}

/** A message may go out only with no copy problems and no [MAC: ...] placeholder left. */
function readyToSend(msg) {
  return !!msg && !placeholdersIn(`${msg.subject}\n${msg.text}\n${msg.html}`).length && !customerTextProblems(`${msg.subject}\n${msg.text}`).length;
}

/**
 * Mac's standing OK (2026-09-28) for the pickup notification templates. run-orders CLAUDE.md otherwise needs a
 * per-email "send it" for every customer email. received_in_stock is not listed (off by default).
 */
const STANDING_OK = Object.freeze({
  types: Object.freeze(['ordering_in', 'on_truck', 'delayed', 'reminder_1', 'reminder_2', 'picked_up']),
  shopifyReadyTemplate: true,
  grantedBy: 'Mac',
  date: '2026-09-28',
  note: 'Standing OK for these pickup notification templates only; any new template or other customer email still needs a per-email send-it (run-orders CLAUDE.md).',
});

/**
 * True only when `type` is under the standing OK, `message` was built for that type, and it is ready to send
 * (no [MAC: ...] placeholder, no copy problem). Anything else needs a per-email send-it.
 */
function autoSendAllowed(type, message) {
  return STANDING_OK.types.includes(type) && !!message && message.type === type && readyToSend(message);
}

/** Per-location pickup instructions for Shopify's pickup settings (01 task A7, `instructions`). */
function pickupInstructions(location, schedule = eta.DEFAULT_SCHEDULE) {
  const p = place(location, schedule);
  const text = `Pick up at ${p.customer_name}, ${p.address}. Hours: ${p.hours}. Please wait for our "ready for pickup" email, then bring your order number.`;
  const problems = customerTextProblems(text);
  if (problems.length) throw new Error(`pickup instructions: ${problems.join(', ')}`);
  return text;
}

/**
 * (d) Liquid for Shopify's native "Ready for pickup" notification (Settings, Notifications). Replaces the intro
 * text only; keep Shopify's own order summary. `name` is the order name and `customer.first_name` the buyer's
 * first name (standard order notification variables). The `location` branch is unverified in this template:
 * check it in the template editor's preview; if `location` is empty there, the generic line shows instead.
 */
function shopifyReadyForPickupTemplate(schedule = eta.DEFAULT_SCHEDULE) {
  const s = place('sechelt', schedule);
  const pr = place('powell_river', schedule);
  const hold = (schedule.reminders && schedule.reminders.hold_policy) || '[MAC: how long we hold a ready order, and what happens after]';
  const subject = 'Your order {{ name }} is ready for pickup';
  const body = [
    'Hi{% if customer.first_name != blank %} {{ customer.first_name }}{% endif %},',
    '',
    'Your order {{ name }} is ready for pickup.',
    '',
    `{% if location.city contains 'Powell River' %}Pick it up at ${pr.customer_name}, ${pr.address}.`,
    `Hours: ${pr.hours}{% elsif location.city contains 'Sechelt' %}Pick it up at ${s.customer_name}, ${s.address}.`,
    `Hours: ${s.hours}{% else %}Pick it up at the location you chose at checkout.{% endif %}`,
    '',
    'Bring your order number, {{ name }}.',
    '',
    hold,
    '',
    "Can't make it in? Reply to this email and we'll work it out.",
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  const problems = customerTextProblems(`${subject}\n${body}`);
  if (problems.length) throw new Error(`ready for pickup template: ${problems.join(', ')}`);
  return { subject, body, placeholders: placeholdersIn(body) };
}

/**
 * Which message goes out when, for one pickupEta() result. `on` is a BC date, or an event name for the steps
 * a person or Shopify triggers.
 */
function messageTimeline(result, schedule = eta.DEFAULT_SCHEDULE) {
  if (!result || !['ready_now', 'order_in'].includes(result.kind)) throw new Error('messageTimeline: pass a pickupEta() result');
  const r = eta.reminderDates(result.readyBy, schedule);
  const steps = result.kind === 'ready_now'
    ? [{ type: 'received_in_stock', on: 'paid', optional: true }]
    : [
      { type: 'ordering_in', on: 'paid' },
      ...(result.partial ? [{ type: 'ready_for_pickup', on: `in-stock part marked ready in Shopify (expected ${result.partial.readyBy})`, sentBy: 'Shopify', partial: true }] : []),
      { type: 'on_truck', on: result.truckDay },
      { type: 'delayed', on: 'the run did not bring it', conditional: true },
    ];
  return [
    ...steps,
    { type: 'ready_for_pickup', on: `marked ready in Shopify (expected ${result.readyBy})`, sentBy: 'Shopify' },
    // Reminder dates count from the expected ready date; once the order is really marked ready, recount with
    // reminderDates(<that BC date>).
    { type: 'reminder_1', on: r.first, ifNotPickedUp: true },
    { type: 'reminder_2', on: r.second, ifNotPickedUp: true },
    { type: 'picked_up', on: 'marked picked up' },
  ];
}

module.exports = {
  FROM,
  REPLY_TO,
  SIGN_OFF,
  TYPES,
  customerTextProblems,
  placeholdersIn,
  STANDING_OK,
  buildPickupMessage,
  readyToSend,
  autoSendAllowed,
  pickupInstructions,
  shopifyReadyForPickupTemplate,
  messageTimeline,
  textToHtml,
};
