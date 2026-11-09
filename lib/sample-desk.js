'use strict';
/**
 * Sample desk: runs yourfloors.ca "Order a Sample" orders end to end, so nobody has to.
 *
 * Mac 2026-11-04 (order 1446): "i want the pipeline to handle these and automatically request the sample from
 * the vendor. and handle the back and forth". Before this, samples landed in manual review and waited on a human;
 * #1353 sat five weeks and burned three labels (see docs in lib/sample-watch.js, which stays as the safety net).
 *
 * One tick (server.js cron, or scripts/ops/sample-desk.js):
 *   1. INTAKE   every open ShipStation order whose lines are ALL samples, placed on/after SAMPLE_DESK_SINCE.
 *               Each line's product (the `_ref_handle` property) -> Shopify product vendor -> supplier.
 *               One "leg" per supplier. A line with no known supplier escalates the order to Mac.
 *   2. ASK      email the supplier's sample desk from hello@ (Graph), subject tagged [SAMPLE-<order>]:
 *                 label mode (Unifloor): pack one piece per colour, cut to ~30 cm, reply with weight + size,
 *                   we send a prepaid UPS label. Customer address is NOT sent (the label carries it).
 *                 vendor-ships mode (Biyork): ship straight to the customer, reply with tracking.
 *   3. READ     every vendor message in the thread (conversationId, or the tag in the subject). Opus reads it into
 *               parcels / tracking / discontinued / a question / just an acknowledgement.
 *   4. ACT      parcels   -> sanity checks -> UPS label from the supplier dock (weight = billable weight, never dims)
 *                            -> reply-all with the PDF -> UPS pickup at the dock next business day.
 *               tracking  -> recorded.
 *               a box over 48 in -> one automatic "please cut it down" reply.
 *               missing size -> one automatic "what's the box size" reply.
 *               discontinued, a question, a label over SAMPLE_DESK_LABEL_MAX, a weird box, anything Opus isn't sure
 *               of -> ONE email to Mac with the vendor's words; the leg waits for him.
 *   5. SHIP     each leg with tracking -> Shopify fulfillment of that leg's lines (customer gets Shopify's shipping
 *               email). All legs done -> ShipStation order marked shipped, order closed.
 *   6. CHASE    no vendor reply in 2 business days -> one chase in the thread; still nothing -> Mac.
 *
 * SAMPLE_DESK_LIVE=1 makes it act. Unset = shadow: it reads everything and logs what it would send/buy, sends
 * nothing, buys nothing and writes no order state. The pipeline keeps paging Mac about samples while shadowed.
 */

const fs = require('fs');
const path = require('path');

const LABEL_DIR = process.env.SAMPLE_DESK_LABEL_DIR || path.join(__dirname, '..', 'data', 'sample-desk', 'labels');
const STATE_FILE = process.env.SAMPLE_DESK_STATE_FILE || path.join(__dirname, '..', 'data', 'sample-desk-state.json');
const SINCE = process.env.SAMPLE_DESK_SINCE || '2026-11-04';
const LABEL_MAX = Number(process.env.SAMPLE_DESK_LABEL_MAX || 30);   // per label, CAD (feedback_label_cost_confirm)
const CHASE_BUSINESS_DAYS = Number(process.env.SAMPLE_DESK_CHASE_DAYS || 2);
const MAX_CHASES = 2;
const MAC = process.env.SAMPLE_DESK_EMAIL || 'mac@customfc.ca';
const HELLO = (process.env.CS_FROM_EMAIL || 'hello@yourfloors.ca').toLowerCase();
const MAC_LC = String(MAC).toLowerCase();
const MODEL = 'claude-opus-5-5';
const TZ = 'America/Vancouver';
const MAX_LONG_SIDE_CM = 122;       // 48 in: past this UPS adds Additional Handling (order 1400: $82 + $68 as packed)
const MAX_WEIGHT_LB = 50;           // feedback_no_box_over_50lb

// ── Suppliers ────────────────────────────────────────────────────────────────
// match runs against "<shopify vendor> <product title>". cc always carries Mac.
const SUPPLIERS = [
  {
    key: 'unifloor', name: 'Unifloor', mode: 'label',
    match: /unifloor|aquafix|ideal ?wood|\bec premium\b|euro essential/i,
    to: ['sample@unifloor.ca'], cc: ['paul@unifloor.ca', MAC],
    dock: 'Graybar Rd',
    shipFrom: {
      name: 'Unifloor Trading Inc', company: 'Unifloor Trading Inc',
      street1: 'Unit 170 - 6333 Graybar Rd', city: 'Richmond', state: 'BC',
      postalCode: 'V6W 0C4', country: 'CA', phone: '6042760833',
    },
    pickup: { province: 'BC', window: [11, 16], contactName: 'Unifloor Trading Inc', phone: '604-276-0833' },
  },
  {
    key: 'biyork', name: 'Biyork', mode: 'vendor-ships',
    match: /biyork|hydrogen/i,
    to: ['info@biyorkcanada.com'], cc: [MAC],
  },
];

function supplierFor(vendor, title) {
  const hay = `${vendor || ''} ${title || ''}`;
  return SUPPLIERS.find((s) => s.match.test(hay)) || null;
}

// ── Dates (Pacific business days) ────────────────────────────────────────────
// Days the docks are shut. BC stats + the Christmas week days they close. Extend each year.
const HOLIDAYS = new Set([
  '2026-11-11', '2026-12-25', '2026-12-28', '2027-01-01', '2027-02-15', '2027-03-26', '2027-05-24',
  '2027-07-01', '2027-08-02', '2027-09-06', '2027-09-30', '2027-10-11', '2027-11-11', '2027-12-27', '2027-12-28',
]);
const ptDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function isBusinessDay(ymd) {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(ymd);
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function nextBusinessDay(ymd) { let d = addDays(ymd, 1); while (!isBusinessDay(d)) d = addDays(d, 1); return d; }
/** Business days strictly after `fromIso`'s PT date, up to and including `now`'s PT date. */
function businessDaysSince(fromIso, now = new Date()) {
  let d = ptDate(new Date(fromIso)); const end = ptDate(now); let n = 0;
  while (d < end) { d = addDays(d, 1); if (isBusinessDay(d)) n++; }
  return n;
}
const niceDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

// ── Parcels ──────────────────────────────────────────────────────────────────
/** UPS bills max(actual, L*W*H cm / 5000 kg). Weight-only labels understate long boxes, so we declare billable. */
function billableLb(p) {
  const actual = Number(p.weight_lb) || 0;
  const dims = [p.length_cm, p.width_cm, p.height_cm].map(Number);
  if (dims.some((x) => !(x > 0))) return Math.max(1, Math.ceil(actual));
  const dimLb = (dims[0] * dims[1] * dims[2]) / 5000 * 2.20462;
  return Math.max(1, Math.ceil(Math.max(actual, dimLb)));
}

/**
 * Pure verdict on what a vendor said about parcels.
 * Returns { ok, action: 'buy'|'ask-cut'|'ask-size'|'escalate', why }.
 */
function judgeParcels(parcels, { cutAsked = false, sizeAsked = false } = {}) {
  if (!Array.isArray(parcels) || !parcels.length) return { ok: false, action: 'escalate', why: 'no parcels in the reply' };
  for (const p of parcels) {
    const w = Number(p.weight_lb);
    if (!(w > 0)) return { ok: false, action: sizeAsked ? 'escalate' : 'ask-size', why: 'no box weight given' };
    if (w > MAX_WEIGHT_LB) return { ok: false, action: 'escalate', why: `a box weighs ${w} lb, over our ${MAX_WEIGHT_LB} lb limit` };
    const dims = [p.length_cm, p.width_cm, p.height_cm].map(Number);
    if (dims.some((x) => !(x > 0))) return { ok: false, action: sizeAsked ? 'escalate' : 'ask-size', why: 'no box size given' };
    const long = Math.max(...dims);
    if (long > MAX_LONG_SIDE_CM) return { ok: false, action: cutAsked ? 'escalate' : 'ask-cut', why: `a box is ${Math.round(long)} cm long (UPS oversize past 122 cm)` };
    const kgPerM3 = (w / 2.20462) / ((dims[0] * dims[1] * dims[2]) / 1e6);
    if (kgPerM3 < 20 || kgPerM3 > 3000) return { ok: false, action: 'escalate', why: `box size and weight don't add up (${Math.round(kgPerM3)} kg/m3): ${w} lb in ${dims.join('x')} cm` };
  }
  return { ok: true, action: 'buy', why: null };
}

/**
 * Pure: what to do with Opus's reading of a vendor message for a leg.
 * Returns { action, why }. Actions: 'escalate' | 'parcels' | 'tracking' | 'wait'.
 */
function decide(reading, leg) {
  if (!reading || reading.confident === false) return { action: 'escalate', why: "couldn't read the supplier's reply with confidence" };
  if ((reading.discontinued || []).length) return { action: 'escalate', why: `supplier says discontinued or out: ${reading.discontinued.join(', ')}` };
  if (reading.question) return { action: 'escalate', why: `supplier asked: ${reading.question}` };
  if ((reading.tracking || []).length) return { action: 'tracking', why: null };
  if ((reading.parcels || []).length) {
    if (leg.mode !== 'label') return { action: 'escalate', why: 'supplier sent box sizes but normally ships samples on their own freight' };
    return { action: 'parcels', why: null };
  }
  return { action: 'wait', why: null };
}

// ── State ────────────────────────────────────────────────────────────────────
function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); s.orders = s.orders || {}; s.pickups = s.pickups || {}; return s; }
  catch { return { orders: {}, pickups: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── Shopify ──────────────────────────────────────────────────────────────────
const defaultGql = () => require('./shopify-graphql').graphql;

/** The order's sample lines with each product's vendor, by order number. */
async function shopifySampleOrder(orderNumber, gql = defaultGql()) {
  const r = await gql(`query($q: String!) { orders(first: 1, query: $q) { nodes {
      id name cancelledAt displayFulfillmentStatus email
      shippingAddress { name address1 address2 city provinceCode zip phone company }
      lineItems(first: 50) { nodes { id title quantity customAttributes { key value } } } } } }`, { q: `name:#${orderNumber}` });
  const o = r.data?.orders?.nodes?.[0];
  if (!o) return null;
  const { sampleOf, sampleRefHandle } = require('./sample-item');
  const lines = [];
  for (const li of o.lineItems.nodes) {
    const item = { properties: li.customAttributes.map((a) => ({ name: a.key, value: a.value })), name: li.title };
    const of = sampleOf(item);
    const handle = sampleRefHandle(item);
    let vendor = null; let title = of;
    if (handle) {
      const p = await gql('query($h: String!) { productByHandle(handle: $h) { title vendor } }', { h: handle });
      vendor = p.data?.productByHandle?.vendor || null;
      title = p.data?.productByHandle?.title || of;
    }
    lines.push({ lineItemId: li.id, qty: li.quantity, name: displayName(title || li.title), handle, vendor, isSample: Boolean(of) || /^order a sample$/i.test(li.title) });
  }
  return { gid: o.id, name: o.name, cancelled: Boolean(o.cancelledAt), fulfillment: o.displayFulfillmentStatus, email: o.email, address: o.shippingAddress, lines };
}

// "AquaFix SPC Grand Cru — Romanée" -> "AquaFix SPC Grand Cru Romanée" (no em dashes in Mac's voice)
const displayName = (s) => String(s || '').replace(/\s*[—–]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

/** Fulfil one leg's lines with its tracking. Shopify emails the customer. */
async function fulfilLeg(orderGid, leg, gql = defaultGql()) {
  const r = await gql(`query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status
      lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } } } } } }`, { id: orderGid });
  const want = new Set(leg.lines.map((l) => l.lineItemId));
  const groups = [];
  for (const fo of r.data.order.fulfillmentOrders.nodes) {
    if (!['OPEN', 'IN_PROGRESS'].includes(fo.status)) continue;
    const items = fo.lineItems.nodes.filter((x) => want.has(x.lineItem.id) && x.remainingQuantity > 0).map((x) => ({ id: x.id, quantity: x.remainingQuantity }));
    if (items.length) groups.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: items });
  }
  if (!groups.length) return { skipped: 'nothing left to fulfil' };
  const company = carrierCompany(leg.tracking[0].carrier);
  const m = await gql(`mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`, {
    f: { lineItemsByFulfillmentOrder: groups, notifyCustomer: true, trackingInfo: { company, numbers: leg.tracking.map((t) => t.number) } },
  });
  const errs = m.data?.fulfillmentCreate?.userErrors || [];
  if (errs.length) throw new Error(`Shopify fulfillmentCreate: ${errs.map((e) => e.message).join('; ')}`);
  return { fulfillmentId: m.data.fulfillmentCreate.fulfillment.id };
}
function carrierCompany(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('ups')) return 'UPS';
  if (s.includes('fedex')) return 'FedEx';
  if (s.includes('purolator')) return 'Purolator';
  if (s.includes('canpar')) return 'Canpar';
  if (s.includes('canada post') || s.includes('postes')) return 'Canada Post';
  if (s.includes('loomis')) return 'Loomis Express';
  return c || 'Other';
}

// ── ShipStation ──────────────────────────────────────────────────────────────
const ss = () => require('./shipstation-v2');
const jbody = (r) => { try { return JSON.parse(r.body); } catch { return null; } };

async function openSampleOrders() {
  const { isSampleItem } = require('./sample-item');
  const out = [];
  for (let page = 1; page < 20; page++) {
    const r = jbody(await ss().v1Request('GET', `/orders?orderStatus=awaiting_shipment&pageSize=500&page=${page}`));
    if (!r) throw new Error('ShipStation orders read failed');
    for (const o of r.orders || []) {
      const items = o.items || [];
      if (items.length && items.every(isSampleItem)) out.push(o);
    }
    if (page >= (r.pages || 1)) break;
  }
  return out;
}

async function ssOrderStatus(orderId) {
  const r = jbody(await ss().v1Request('GET', `/orders/${orderId}`));
  return r?.orderStatus || null;
}

/** UPS Standard quote, weight only. Returns cost (CAD, incl. other charges) or null. */
async function quoteUps(shipFrom, shipTo, weightLb) {
  const r = await ss().v1Request('POST', '/shipments/getrates', {
    carrierCode: 'ups_walleted', serviceCode: 'ups_standard', packageCode: 'package',
    fromPostalCode: shipFrom.postalCode.replace(/\s/g, ''), fromCity: shipFrom.city, fromState: shipFrom.state,
    toState: shipTo.state, toCountry: 'CA', toPostalCode: shipTo.postalCode.replace(/\s/g, ''), toCity: shipTo.city,
    weight: { value: weightLb, units: 'pounds' }, confirmation: 'none', residential: true,
  });
  const rates = jbody(r);
  if (!Array.isArray(rates)) return null;
  const std = rates.find((x) => x.serviceCode === 'ups_standard') || rates[0];
  return std ? Number(std.shipmentCost || 0) + Number(std.otherCost || 0) : null;
}

async function buyLabel(shipFrom, shipTo, weightLb, shipDate) {
  const r = await ss().v1Request('POST', '/shipments/createlabel', {
    carrierCode: 'ups_walleted', serviceCode: 'ups_standard', packageCode: 'package', confirmation: 'none',
    shipDate, weight: { value: weightLb, units: 'pounds' },   // NEVER pass dimensions (docs/ORDER-PREP.md)
    shipFrom, shipTo, testLabel: false,
  });
  const j = jbody(r);
  if (!j?.trackingNumber) throw new Error(`createlabel failed: ${String(r.body).slice(0, 300)}`);
  return { trackingNumber: j.trackingNumber, shipmentId: j.shipmentId, cost: Number(j.shipmentCost || 0) + Number(j.insuranceCost || 0), pdfB64: j.labelData };
}

function shipToFrom(order) {
  const t = order.shipTo || {};
  return {
    name: t.name, company: t.company || undefined, street1: t.street1, street2: t.street2 || undefined,
    city: t.city, state: t.state, postalCode: t.postalCode, country: t.country || 'CA',
    phone: t.phone || '', residential: t.residential !== false,
  };
}

// ── hello@ mail (Graph, through the yourfloors-cs login) ─────────────────────
function graph() {
  const YF = process.env.YF_CS_DIR || '/Users/fred/yourfloors-cs';
  require(path.join(YF, 'lib', 'env.js'));
  return require(path.join(YF, 'lib', 'graph-mail.js'));
}
const addr = (list) => list.map((a) => ({ emailAddress: { address: a } }));
async function gjson(g, p, opts) { const r = await g.graphFetch(p, opts); const t = await r.text(); try { return JSON.parse(t); } catch { return {}; } }

async function attachRaw(g, draftId, files) {
  for (const f of files || []) {
    await g.graphFetch(`/me/messages/${encodeURIComponent(draftId)}/attachments`, { method: 'POST', body: JSON.stringify({
      '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType || 'application/pdf', contentBytes: f.b64 }) });
  }
  if ((files || []).length) {
    const chk = await gjson(g, `/me/messages/${encodeURIComponent(draftId)}?$select=hasAttachments`);
    if (!chk.hasAttachments) throw new Error('attachment did not stick; not sent');
  }
}

/** New thread from hello@. Returns { conversationId }. */
async function sendNew(g, { to, cc, subject, text, files }) {
  const msg = await gjson(g, '/me/messages', { method: 'POST', body: JSON.stringify({
    subject, body: { contentType: 'Text', content: text }, toRecipients: addr(to), ccRecipients: addr(cc || []) }) });
  if (!msg.id) throw new Error('could not create message: ' + JSON.stringify(msg).slice(0, 200));
  await attachRaw(g, msg.id, files);
  await g.graphFetch(`/me/messages/${encodeURIComponent(msg.id)}/send`, { method: 'POST', body: '{}' });
  return { conversationId: msg.conversationId };
}

/** Reply in the thread to `graphId`, to the leg's addresses (+ whoever at the vendor last wrote). */
async function replyInThread(g, graphId, { to, cc, text, files }) {
  const draft = await gjson(g, `/me/messages/${encodeURIComponent(graphId)}/createReplyAll`, { method: 'POST', body: '{}' });
  if (!draft.id) throw new Error('createReplyAll failed: ' + JSON.stringify(draft).slice(0, 200));
  const quoted = draft.body?.content || '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(text)}</div><br>${quoted}`;
  await g.graphFetch(`/me/messages/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body: JSON.stringify({
    body: { contentType: 'HTML', content: html }, toRecipients: addr(to), ccRecipients: addr(cc || []) }) });
  await attachRaw(g, draft.id, files);
  await g.graphFetch(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST', body: '{}' });
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Every message in the leg's threads + anything tagged [SAMPLE-n], oldest first. */
async function threadMessages(g, leg, orderNumber) {
  const sel = '$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,conversationId,body,hasAttachments,isDraft';
  const seen = new Map();
  for (const cid of leg.conversationIds || []) {
    const r = await gjson(g, `/me/messages?$filter=${encodeURIComponent(`conversationId eq '${cid}'`)}&$top=50&${sel}`);
    for (const m of r.value || []) seen.set(m.id, m);
  }
  const s = await gjson(g, `/me/messages?$search=${encodeURIComponent(`"SAMPLE-${orderNumber}"`)}&$top=25&${sel}`);
  for (const m of s.value || []) if (String(m.subject || '').includes(`[SAMPLE-${orderNumber}]`)) seen.set(m.id, m);
  return [...seen.values()].filter((m) => !m.isDraft)
    .map((m) => ({
      id: m.id, subject: m.subject || '', conversationId: m.conversationId,
      // Mail sent from hello@ itself can carry the internal Exchange DN ("/o=ExchangeLabs/...") instead of the
      // address (#1374's first ask did). Anything without an @ is ours.
      from: ((a) => (a.includes('@') ? a : HELLO))((m.from?.emailAddress?.address || '').toLowerCase()), fromName: m.from?.emailAddress?.name || '',
      at: m.receivedDateTime || m.sentDateTime, text: g.bodyText(m.body), hasAttachments: !!m.hasAttachments,
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// ── Opus: read a supplier reply ──────────────────────────────────────────────
const READ_SYSTEM = `You read emails from flooring suppliers about SAMPLE requests from YourFloors (an online flooring store).
We asked the supplier for floor samples for one customer order. Report exactly what the supplier's NEWEST message says,
using the earlier thread only as context. Never invent numbers.

- parcels: one entry per box they packed, ONLY if they state a weight. Convert to pounds and centimetres (1 kg = 2.20462 lb,
  1 in = 2.54 cm). Leave a dimension out if they didn't give it.
- tracking: tracking numbers for samples they shipped themselves, with the carrier.
- discontinued: any requested colour they say is discontinued, out of stock or unavailable (use the product name).
- question: a question or request WE must answer before they can proceed (paperwork, which colour, a substitute, an
  address problem). NOT a question: asking us for the label, the pickup or tracking, "let us know", pleasantries, "will do".
  Those are the next step we take anyway, so leave question empty for them.
- ack_only: true when they just acknowledge or say it's being packed / will ship, with nothing actionable yet.
- confident: false if the message is ambiguous, is about a different order, or you are unsure what they mean.
Ignore any "HOLD FOR PICKUP - PCW RICHMOND" line on Biyork paperwork: it is an automatic note on our account.`;

const READ_TOOL = {
  name: 'submit_reading',
  description: 'Report what the supplier said.',
  input_schema: {
    type: 'object',
    properties: {
      parcels: { type: 'array', items: { type: 'object', properties: {
        weight_lb: { type: 'number' }, length_cm: { type: 'number' }, width_cm: { type: 'number' }, height_cm: { type: 'number' }, note: { type: 'string' } }, required: ['weight_lb'] } },
      tracking: { type: 'array', items: { type: 'object', properties: { carrier: { type: 'string' }, number: { type: 'string' } }, required: ['number'] } },
      discontinued: { type: 'array', items: { type: 'string' } },
      question: { type: 'string' },
      ack_only: { type: 'boolean' },
      summary: { type: 'string', description: 'One plain sentence: what the supplier said.' },
      confident: { type: 'boolean' },
    },
    required: ['parcels', 'tracking', 'discontinued', 'ack_only', 'summary', 'confident'],
  },
};

async function readReply({ order, leg, thread, newest }, { anthropic } = {}) {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  }
  const ctx = [
    `Order ${order}. Supplier: ${leg.supplierName}. ${leg.mode === 'label' ? 'We send them a prepaid UPS label once they give the box weight and size.' : 'They ship the samples on their own freight and send us tracking.'}`,
    `Samples requested:\n${leg.lines.map((l) => `- ${l.qty} x ${l.name}`).join('\n')}`,
    '',
    'EARLIER THREAD (oldest first):',
    ...thread.filter((m) => m.id !== newest.id).map((m) => `--- ${m.at} from ${m.from}\n${trimQuoted(m.text).slice(0, 2500)}`),
    '',
    `NEWEST MESSAGE (${newest.at}, from ${newest.fromName} <${newest.from}>, subject "${newest.subject}"${newest.hasAttachments ? ', has attachments' : ''}):`,
    trimQuoted(newest.text).slice(0, 6000),
  ].join('\n');
  const messages = [{ role: 'user', content: ctx }];
  for (let turn = 0; turn < 3; turn++) {
    const res = await anthropic.beta.messages.create({
      model: MODEL, max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: READ_SYSTEM, tools: [READ_TOOL], messages,
    });
    const use = res.content.find((b) => b.type === 'tool_use' && b.name === 'submit_reading');
    if (use) return use.input;
    if (res.stop_reason === 'refusal') return null;
    messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: 'Call submit_reading now.' });
  }
  return null;
}
// Cut the quoted history off a reply body so the model reads only what is new.
function trimQuoted(t) {
  const s = String(t || '');
  const cut = s.search(/\n\s*(From: .+\n\s*Sent: |On .+ wrote:|-----Original Message-----|________________)/);
  return (cut > 0 ? s.slice(0, cut) : s).trim();
}

// ── Email text ───────────────────────────────────────────────────────────────
const SIGN = 'Thanks,\nMac\nYourFloors';
function subjectFor(order, leg) {
  const first = leg.lines[0].name;
  const more = leg.lines.length > 1 ? ` + ${leg.lines.length - 1} more` : '';
  return `[SAMPLE-${order}] Sample request: ${first}${more}`;
}
function askText(order, leg, shipTo) {
  const list = leg.lines.map((l) => `${l.qty} x ${l.name}`).join('\n');
  if (leg.mode === 'label') {
    return `Hi team,\n\nPlease put together a sample for our customer, order ${order}:\n\n${list}\n\n`
      + `One piece per colour, cut down to about 30 cm (12 in) if it's a full plank, so it goes as a small parcel.\n\n`
      + `Could you also let us know your current stock count on ${leg.lines.length > 1 ? 'each colour' : 'this colour'}?\n\n`
      + `Once it's packed, reply with the box weight and size and we'll send a prepaid UPS label back and book the UPS pickup at ${leg.dock}. `
      + `If any colour is discontinued or out, just let us know.\n\n${SIGN}`;
  }
  const t = shipTo;
  const addrLines = [t.name, t.company, t.street1, t.street2, `${t.city} ${t.state} ${t.postalCode}`, t.phone ? `Phone ${t.phone}` : null].filter(Boolean).join('\n');
  return `Hi team,\n\nPlease ship a sample straight to our customer, order ${order}:\n\n${list}\n\nShip to:\n${addrLines}\n\n`
    + `Could you also let us know your current stock count on ${leg.lines.length > 1 ? 'each colour' : 'this colour'}?\n\n`
    + `Please reply with the tracking number once it's on its way. If any colour is discontinued or out, just let us know.\n\n${SIGN}`;
}
const labelText = (order, labels, pickupLine) => `Hi team,\n\nThanks! The prepaid UPS label${labels.length > 1 ? 's' : ''} for order ${order} ${labels.length > 1 ? 'are' : 'is'} attached `
  + `(${labels.map((l) => l.trackingNumber).join(', ')}). ${pickupLine}\n\n${SIGN}`;
const cutText = (order, why) => `Hi team,\n\nThanks for packing order ${order}. ${why.charAt(0).toUpperCase() + why.slice(1)}, which UPS charges as oversize. `
  + `Could you cut the piece down to about 30 cm (12 in) and send the new box weight and size? Then we'll send the label right over.\n\n${SIGN}`;
const sizeText = (order) => `Hi team,\n\nThanks for packing order ${order}. Could you send the box size (length x width x height) along with the weight? Then we'll send the label right over.\n\n${SIGN}`;
const chaseText = (order, leg) => leg.mode === 'label'
  ? `Hi team,\n\nJust checking in on the sample for order ${order}. Once it's packed, send the box weight and size and we'll get the UPS label over.\n\n${SIGN}`
  : `Hi team,\n\nJust checking in on the sample for order ${order}. Could you send the tracking number once it ships?\n\n${SIGN}`;

// ── Escalation to Mac ────────────────────────────────────────────────────────
async function escalate(ctx, orderRec, leg, why, extra = '') {
  const key = `${leg ? leg.supplierKey : 'order'}:${why}`;
  orderRec.escalations = orderRec.escalations || [];
  if (orderRec.escalations.some((e) => e.key === key)) return;   // once per reason
  const body = [
    `Sample order #${orderRec.orderNumber} (${orderRec.customer}) needs you.`,
    '',
    `Why: ${why}`,
    leg ? `Supplier: ${leg.supplierName}. Samples: ${leg.lines.map((l) => `${l.qty} x ${l.name}`).join(', ')}` : '',
    extra ? `\n${extra}` : '',
    '',
    `The sample desk has stopped on this ${leg ? `${leg.supplierName} request` : 'order'} until it's sorted. Reply in the [SAMPLE-${orderRec.orderNumber}] thread in hello@ (the desk reads it), or mark the order shipped in ShipStation and the desk closes it.`,
  ].filter((x) => x !== '').join('\n');
  ctx.log(`ESCALATE #${orderRec.orderNumber}: ${why}`);
  if (ctx.live) {
    const { sendEmail } = require('./emailer');
    await sendEmail({ to: MAC, subject: `Sample #${orderRec.orderNumber} needs you: ${why.slice(0, 90)}`, text: body });
  }
  orderRec.escalations.push({ key, why, at: new Date().toISOString() });
  if (leg) leg.status = 'escalated';
}

/**
 * Send one leg's ask. The leg is saved as 'sending' before the email and 'asked' right after it, and nothing that
 * can throw sits between the send and that save: a crash after the send leaves 'sending' (escalated, never resent),
 * a crash before it leaves 'sending' too, so the worst case is one email to Mac, never a duplicate to the vendor.
 */
async function askLeg(ctx, state, rec, leg, o, now) {
  const n = rec.orderNumber;
  const subject = subjectFor(n, leg);
  const text = askText(n, leg, shipToFrom(o));
  ctx.log(`#${n}: ASK ${leg.supplierName} -> ${leg.to.join(', ')} (cc ${leg.cc.join(', ')})\n  Subject: ${subject}\n${text.replace(/^/gm, '  | ')}`);
  if (!ctx.live) return;
  leg.status = 'sending'; saveState(state);
  const r = await sendNew(ctx.getG(), { to: leg.to, cc: leg.cc, subject, text });
  if (r.conversationId) leg.conversationIds.push(r.conversationId);
  leg.askedAt = now.toISOString(); leg.lastActivityAt = leg.askedAt; leg.status = 'asked';
  saveState(state);
  try { require('./sample-watch').recordVendorAsk([n], leg.supplierKey, now); } catch (e) { ctx.log(`#${n}: sample-watch ledger: ${e.message}`); }
  try { require('./audit').log({ action: 'sample-desk-asked', orderNumber: n, supplier: leg.supplierKey, to: leg.to }); } catch (e) { ctx.log(`#${n}: audit: ${e.message}`); }
}

// ── The tick ─────────────────────────────────────────────────────────────────
/**
 * One pass. opts: { live, only (order number), log, deps: { gql, anthropic, graph, now } }.
 * Returns a report. Never sends or buys unless live.
 */
async function tick(opts = {}) {
  const live = Boolean(opts.live);
  const lines = [];
  const ctx = { live, getG: null, log: (s) => { lines.push(s); (opts.log || console.log)(s); } };
  const now = opts.now || new Date();
  const gql = opts.gql || defaultGql();
  const state = loadState();
  const audit = require('./audit');
  let g = null;
  const getG = () => (g = g || opts.graph || graph());
  ctx.getG = getG;
  ctx.save = () => { if (live) saveState(state); };

  const open = await openSampleOrders();
  const openIds = new Set(open.map((o) => String(o.orderNumber)));

  // Close records whose ShipStation order left awaiting_shipment (cancelled, or shipped by hand).
  for (const [n, rec] of Object.entries(state.orders)) {
    if (rec.done || openIds.has(n)) continue;
    const st = await ssOrderStatus(rec.orderId).catch(() => null);
    if (st && st !== 'awaiting_shipment') { rec.done = true; rec.closedAt = now.toISOString(); rec.closedWhy = `ShipStation ${st}`; ctx.log(`#${n}: closed (ShipStation ${st})`); }
  }

  for (const o of open) {
    const n = String(o.orderNumber);
    if (opts.only && n !== String(opts.only)) continue;
    if (String(o.orderDate).slice(0, 10) < SINCE && !state.orders[n]) continue;   // pre-desk orders stay manual
    try {
      let rec = state.orders[n];
      // ── INTAKE + ASK
      if (!rec) {
        const sh = await shopifySampleOrder(n, gql);
        if (!sh || sh.cancelled) { ctx.log(`#${n}: ${sh ? 'cancelled in Shopify' : 'not found in Shopify'}, skipped`); continue; }
        rec = { orderNumber: n, orderId: o.orderId, orderGid: sh.gid, customer: o.shipTo?.name || '', createdAt: now.toISOString(), legs: {}, escalations: [] };
        const unknown = [];
        for (const l of sh.lines.filter((x) => x.isSample)) {
          const s = supplierFor(l.vendor, l.name);
          if (!s) { unknown.push(`${l.name} (vendor "${l.vendor || '?'}")`); continue; }
          const leg = rec.legs[s.key] || (rec.legs[s.key] = { supplierKey: s.key, supplierName: s.name, mode: s.mode, to: s.to, cc: s.cc, dock: s.dock, lines: [], status: 'new', conversationIds: [], seenIds: [], tracking: [], labels: [], chases: 0 });
          leg.lines.push({ lineItemId: l.lineItemId, qty: l.qty, name: l.name, handle: l.handle });
        }
        if (unknown.length) await escalate(ctx, rec, null, `no sample supplier on file for ${unknown.join(', ')}`);
        // Save the record before any email goes out: from here on a crash can never lead to a second ask (#1453
        // went to Biyork 3 times on 2026-11-06 because the send landed and a later line threw before the save).
        if (live) { state.orders[n] = rec; saveState(state); }
        for (const leg of Object.values(rec.legs)) await askLeg(ctx, state, rec, leg, o, now);
        continue;   // replies come on later ticks
      }
      if (rec.done) continue;

      // ── READ + ACT per leg
      for (const leg of Object.values(rec.legs)) {
        if (leg.status === 'shipped') continue;
        if (leg.status === 'new') { await askLeg(ctx, state, rec, leg, o, now); continue; }   // an earlier pass failed before this leg's ask
        if (leg.status === 'sending') { await escalate(ctx, rec, leg, 'a sample request may or may not have gone out (the desk stopped mid-send); check the [SAMPLE] thread and reply in it to resume'); continue; }
        if (leg.status === 'labelled') { if (live) await finishLabelled(ctx, rec, leg, state, gql); continue; }
        if (leg.status === 'tracked') { if (live) await shipLeg(ctx, rec, leg, gql); continue; }
        const thread = await threadMessages(getG(), leg, n);
        for (const m of thread) if (m.conversationId && !leg.conversationIds.includes(m.conversationId)) leg.conversationIds.push(m.conversationId);
        // Ours = hello@ or Mac from his own address (Mac 2026-11-09, #1446: he nudged Unifloor from mac@ in the
        // thread, and the desk would have read his nudge as the vendor's answer). Ours is never a vendor reply; Mac's
        // own nudge counts as activity, so the desk's chase waits 2 business days from it instead of piling on.
        const ours = (m) => m.from === HELLO || m.from === MAC_LC;
        const fresh = thread.filter((m) => !ours(m) && !leg.seenIds.includes(m.id));
        const macNudge = thread.filter((m) => m.from === MAC_LC && m.at && (!leg.lastActivityAt || m.at > leg.lastActivityAt)).map((m) => m.at).sort().pop();
        if (macNudge && leg.status !== 'escalated') leg.lastActivityAt = macNudge;
        // Mac answering in the thread from hello@ is how an escalation gets resolved: a hello@ message newer than
        // the escalation re-opens the leg so the next vendor reply is read again.
        if (leg.status === 'escalated') {
          const lastEsc = (rec.escalations || []).filter((e) => e.key.startsWith(`${leg.supplierKey}:`)).map((e) => e.at).sort().pop();
          const macSpoke = thread.some((m) => ours(m) && lastEsc && m.at > lastEsc);
          if (!macSpoke && !fresh.length) continue;
          if (macSpoke) { leg.status = 'asked'; leg.lastActivityAt = now.toISOString(); ctx.log(`#${n} ${leg.supplierName}: you replied in the thread, desk resumes`); }
          if (!fresh.length) continue;
        }
        if (!fresh.length) {
          // ── CHASE
          if (['asked', 'waiting'].includes(leg.status) && businessDaysSince(leg.lastActivityAt || leg.askedAt, now) >= CHASE_BUSINESS_DAYS) {
            if (leg.chases >= MAX_CHASES) { await escalate(ctx, rec, leg, `${leg.supplierName} hasn't answered after ${leg.chases} chases`); continue; }
            const last = thread[thread.length - 1];
            ctx.log(`#${n} ${leg.supplierName}: CHASE ${leg.chases + 1}`);
            if (live && last) {
              await replyInThread(getG(), last.id, { to: leg.to, cc: leg.cc, text: chaseText(n, leg) });
              leg.chases++; leg.lastActivityAt = now.toISOString();
              audit.log({ action: 'sample-desk-chased', orderNumber: n, supplier: leg.supplierKey, chases: leg.chases });
            }
          }
          continue;
        }
        const newest = fresh[fresh.length - 1];
        const reading = await readReply({ order: n, leg, thread, newest }, { anthropic: opts.anthropic });
        ctx.log(`#${n} ${leg.supplierName}: reply from ${newest.from}: ${reading ? reading.summary : '(unreadable)'}`);
        audit.log({ action: 'sample-desk-read', orderNumber: n, supplier: leg.supplierKey, from: newest.from, reading });
        leg.seenIds.push(...fresh.map((m) => m.id));
        leg.lastActivityAt = now.toISOString();
        leg.lastVendor = { id: newest.id, from: newest.from };
        const replyTo = [...new Set([...leg.to, newest.from].filter((a) => a && a !== HELLO))];
        const d = decide(reading, leg);
        const quote = `What ${newest.fromName || newest.from} wrote:\n${trimQuoted(newest.text).slice(0, 1500)}`;

        if (d.action === 'escalate') { await escalate(ctx, rec, leg, d.why, quote); continue; }
        if (d.action === 'wait') { leg.status = 'waiting'; continue; }
        if (d.action === 'tracking') {
          leg.tracking = reading.tracking.map((t) => ({ carrier: t.carrier || 'Other', number: String(t.number).replace(/\s/g, '') }));
          ctx.log(`#${n} ${leg.supplierName}: tracking ${leg.tracking.map((t) => `${t.carrier} ${t.number}`).join(', ')}`);
          leg.status = 'tracked'; ctx.save();
          if (live) await shipLeg(ctx, rec, leg, gql);
          continue;
        }
        // parcels
        const verdict = judgeParcels(reading.parcels, { cutAsked: leg.cutAsked, sizeAsked: leg.sizeAsked });
        if (verdict.action === 'ask-cut' || verdict.action === 'ask-size') {
          const text = verdict.action === 'ask-cut' ? cutText(n, verdict.why) : sizeText(n);
          ctx.log(`#${n} ${leg.supplierName}: ${verdict.action} (${verdict.why})\n${text.replace(/^/gm, '  | ')}`);
          if (live) {
            await replyInThread(getG(), newest.id, { to: replyTo, cc: leg.cc, text });
            if (verdict.action === 'ask-cut') leg.cutAsked = true; else leg.sizeAsked = true;
            leg.status = 'waiting';
          }
          continue;
        }
        if (verdict.action === 'escalate') { await escalate(ctx, rec, leg, verdict.why, quote); continue; }
        await labelLeg(ctx, rec, leg, reading.parcels, o, newest, replyTo, state, gql, now);
      }
      if (Object.values(rec.legs).length && Object.values(rec.legs).every((l) => l.status === 'shipped')) {
        await closeOrder(ctx, rec);
      }
      if (state.errors) delete state.errors[n];
      if (live) saveState(state);
    } catch (e) {
      ctx.log(`#${n}: ERROR ${e.message}`);
      audit.log({ action: 'sample-desk-error', orderNumber: n, error: String(e.message).slice(0, 500) });
      state.errors = state.errors || {};
      const cnt = (state.errors[n] = (state.errors[n] || 0) + 1);
      if (live && cnt === 3) {   // three passes in a row (~90 min): tell Mac once
        const { sendEmail } = require('./emailer');
        await sendEmail({ to: MAC, subject: `Sample #${n}: the sample desk keeps failing`, text: `The sample desk has failed on order #${n} three passes in a row.\n\nLast error: ${e.message}\n\nIt keeps retrying every 30 minutes.` }).catch(() => {});
      }
      if (live) saveState(state);
    }
  }
  return { lines, state };
}

async function labelLeg(ctx, rec, leg, parcels, ssOrder, newest, replyTo, state, gql, now) {
  const n = rec.orderNumber;
  const s = SUPPLIERS.find((x) => x.key === leg.supplierKey);
  const shipTo = shipToFrom(ssOrder);
  const plan = [];
  for (const p of parcels) {
    const lb = billableLb(p);
    const cost = await quoteUps(s.shipFrom, shipTo, lb);
    plan.push({ p, lb, cost });
  }
  const over = plan.find((x) => x.cost == null || x.cost > LABEL_MAX);
  const planTxt = plan.map((x) => `${x.p.weight_lb} lb ${[x.p.length_cm, x.p.width_cm, x.p.height_cm].join('x')} cm -> billed ${x.lb} lb, UPS Standard ${x.cost == null ? 'no quote' : `$${x.cost.toFixed(2)}`}`).join('\n');
  ctx.log(`#${n} ${leg.supplierName}: label plan\n${planTxt.replace(/^/gm, '  ')}`);
  if (over) { await escalate(ctx, rec, leg, over.cost == null ? 'UPS gave no quote for the sample box' : `UPS label quotes $${over.cost.toFixed(2)}, over the $${LABEL_MAX} sample limit`, planTxt); return; }
  if (!ctx.live) return;
  // Sanity: Shopify order still live before spending.
  const sh = await shopifySampleOrder(n, gql);
  if (!sh || sh.cancelled) { rec.done = true; rec.closedWhy = 'cancelled before label'; return; }
  const pickupDate = nextBusinessDay(ptDate(now));
  // Each step is saved as it lands, so a failed pass resumes (finishLabelled) instead of buying again.
  leg.labels = []; leg.pickupDate = pickupDate; leg.replyToId = newest.id; leg.replyTo = replyTo;
  for (const x of plan) {
    let l;
    try { l = await buyLabel(s.shipFrom, shipTo, x.lb, pickupDate); }
    catch (e) {
      if (!leg.labels.length) throw e;
      await escalate(ctx, rec, leg, `bought ${leg.labels.length} of ${plan.length} labels, then UPS refused the next: ${e.message.slice(0, 200)}`, planTxt);
      ctx.save(); return;
    }
    fs.mkdirSync(LABEL_DIR, { recursive: true });
    const file = path.join(LABEL_DIR, `${n}-${leg.supplierKey}-${l.trackingNumber}.pdf`);
    fs.writeFileSync(file, Buffer.from(l.pdfB64, 'base64'));
    leg.labels.push({ trackingNumber: l.trackingNumber, shipmentId: l.shipmentId, cost: l.cost, file });
    ctx.save();
    require('./audit').log({ action: 'sample-desk-label', orderNumber: n, supplier: leg.supplierKey, tracking: l.trackingNumber, cost: l.cost, lb: x.lb });
    await new Promise((r) => setTimeout(r, Number(process.env.SAMPLE_DESK_LABEL_GAP_MS || 4000)));   // one label at a time, 4 s apart
  }
  leg.tracking = leg.labels.map((l) => ({ carrier: 'UPS', number: l.trackingNumber }));
  leg.status = 'labelled';
  ctx.save();
  await finishLabelled(ctx, rec, leg, state, gql);
}

/** After the labels exist: pickup, label email, Shopify. Each step once, saved as it lands. */
async function finishLabelled(ctx, rec, leg, state, gql) {
  const n = rec.orderNumber;
  const s = SUPPLIERS.find((x) => x.key === leg.supplierKey);
  if (!leg.pickupLine) { leg.pickupLine = await bookDockPickup(ctx, s, leg, leg.pickupDate, state); ctx.save(); }
  if (!leg.labelEmailedAt) {
    const files = leg.labels.map((l) => ({ name: `UPS-label-order-${n}-${l.trackingNumber}.pdf`, b64: fs.readFileSync(l.file).toString('base64') }));
    await replyInThread(ctx.getG(), leg.replyToId, { to: leg.replyTo, cc: leg.cc, text: labelText(n, leg.labels, leg.pickupLine), files });
    leg.labelEmailedAt = new Date().toISOString(); ctx.save();
    ctx.log(`#${n} ${leg.supplierName}: label ${leg.labels.map((l) => `${l.trackingNumber} $${l.cost.toFixed(2)}`).join(', ')} sent; ${leg.pickupLine}`);
  }
  await shipLeg(ctx, rec, leg, gql);
}

/** One UPS pickup per dock per day: UPS pickups are address-based, later labels ride along. */
async function bookDockPickup(ctx, s, leg, pickupDate, state) {
  const key = `${s.key}:${pickupDate}`;
  const when = `${niceDate(pickupDate)}, ${s.pickup.window[0]}:00 to ${s.pickup.window[1] - 12}:00`;
  if (state.pickups[key]) {
    state.pickups[key].labelIds.push(...leg.labels.map((l) => `se-${l.shipmentId}`));
    leg.pickup = { ...state.pickups[key], shared: true };
    return `UPS is already booked to pick up at ${s.dock} ${when} (confirmation ${state.pickups[key].confirmation}).`;
  }
  const { bookPickup, CARRIER_IDS } = ss();
  const r = await bookPickup({
    carrierId: CARRIER_IDS.ups_walleted, labelIds: leg.labels.map((l) => `se-${l.shipmentId}`), pickupDate,
    warehouseProvince: s.pickup.province, contactName: s.pickup.contactName, contactPhone: s.pickup.phone, pickupWindow: s.pickup.window,
  });
  if (!r.success) {
    ctx.log(`pickup booking failed at ${s.dock}: ${r.error} ${String(r.body || '').slice(0, 200)}`);
    leg.pickupFailed = true;
    return `We couldn't book the UPS pickup automatically, so please hand it to your regular UPS driver or let us know and we'll sort it.`;
  }
  state.pickups[key] = { pickupId: r.pickupId, confirmation: r.confirmation, labelIds: leg.labels.map((l) => `se-${l.shipmentId}`), at: new Date().toISOString() };
  leg.pickup = state.pickups[key];
  require('./audit').log({ action: 'sample-desk-pickup', supplier: s.key, pickupDate, pickupId: r.pickupId, confirmation: r.confirmation });
  return `UPS pickup is booked at ${s.dock} for ${when} (confirmation ${r.confirmation}).`;
}

async function shipLeg(ctx, rec, leg, gql) {
  const f = await fulfilLeg(rec.orderGid, leg, gql);
  leg.status = 'shipped'; leg.shippedAt = new Date().toISOString(); leg.fulfillment = f;
  require('./audit').log({ action: 'sample-desk-fulfilled', orderNumber: rec.orderNumber, supplier: leg.supplierKey, tracking: leg.tracking, fulfillment: f });
  ctx.log(`#${rec.orderNumber} ${leg.supplierName}: Shopify fulfilled (${leg.tracking.map((t) => t.number).join(', ')}), customer emailed by Shopify`);
}

async function closeOrder(ctx, rec) {
  const first = Object.values(rec.legs).flatMap((l) => l.tracking)[0];
  if (ctx.live) {
    const carrierCode = /ups/i.test(first?.carrier || '') ? 'ups_walleted' : /fedex/i.test(first?.carrier || '') ? 'fedex' : 'other';
    const r = await ss().v1Request('POST', '/orders/markasshipped', {
      orderId: rec.orderId, carrierCode, shipDate: ptDate(), trackingNumber: first?.number || '', notifyCustomer: false, notifySalesChannel: false,
    });
    if (r.status >= 300 && !/already/i.test(String(r.body))) throw new Error(`markasshipped HTTP ${r.status}: ${String(r.body).slice(0, 200)}`);
    rec.done = true; rec.closedAt = new Date().toISOString(); rec.closedWhy = 'all samples shipped';
  }
  ctx.log(`#${rec.orderNumber}: all legs shipped, ShipStation marked shipped`);
}

module.exports = {
  tick, loadState, saveState, SUPPLIERS,
  // pure helpers, exported for tests
  supplierFor, judgeParcels, decide, billableLb, businessDaysSince, nextBusinessDay, isBusinessDay, ptDate,
  askText, subjectFor, displayName, trimQuoted, readReply, carrierCompany, threadMessages,
};
