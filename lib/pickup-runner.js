/**
 * Pickup runner (PICKUP-ZONES-PLAN.md section 3, Mac 2026-10-02): runs every pickup order end to end so nobody
 * handles them by hand.
 *
 *   coast   "Pickup at our Sechelt warehouse" / "... Powell River showroom": the Tue/Fri truck flow
 *           (lib/pickup-actions.js decides, lib/pickup-messages.js words it). Its mark_ready becomes our own
 *           ready_for_pickup email (native pickup is off, so Shopify's Ready email can't fire).
 *   branch  "Pickup at our <X> trade counter": PO email to Prosol marked CUSTOMER PICKUP with the branch copied
 *           (lib/branch-pickup.js buildPickupEmail), branch_ordered email to the customer, ready by Mac's one-tap
 *           (or a branch reply, later), reminders, picked up.
 *   split   chose shipping but holds full-length trims (the cart guard stops almost all of these): the customer gets
 *           split_choice (pick a counter or a refund); a refund, or no answer in 5 business days, refunds the trims.
 *
 * Picked up = the order is fulfilled in Shopify (staff tap Fulfill) or Mac's one-tap; we then send the thank-you.
 *
 * Modes (env PICKUP_RUNNER_LIVE): unset = SHADOW (plans everything, performs nothing, one digest email a day to Mac
 * listing what it would have done, with every customer email rendered); "coast" = coast orders live; "all" = all.
 * Every action has a stable key and is recorded in state.orders[name].done, so a rerun never repeats one.
 * State: data/pickup-state.json. plan() is pure; run() does the I/O through an injected io.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bp = require('./branch-pickup');
const pa = require('./pickup-actions');
const pm = require('./pickup-messages');
const cm = require('./pickup-counter-messages');
const eta = require('./pickup-eta');

const STATE_PATH = path.join(__dirname, '..', 'data', 'pickup-state.json');
const BRANCHES_PATH = path.join(__dirname, '..', 'data', 'trade', 'pickup-branches.json');
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const SITE = 'https://www.yourfloors.ca';
const SPLIT_DAYS = 5;
const secret = () => process.env.PICKUP_SECRET || process.env.PROZONE_APPROVE_SECRET || process.env.SKU_RESOLVER_SECRET || '';

const loadBranches = (file = BRANCHES_PATH) => JSON.parse(fs.readFileSync(file, 'utf8')).branches;
function loadState(file = STATE_PATH) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { orders: {}, shadow: {} }; } }
function saveState(s, file = STATE_PATH) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 1)); fs.renameSync(`${file}.tmp`, file); }

function mode() { const m = String(process.env.PICKUP_RUNNER_LIVE || '').trim().toLowerCase(); return m === 'all' || m === 'coast' ? m : 'shadow'; }
const liveFor = (kind, m = mode()) => m === 'all' || (m === 'coast' && kind === 'coast');

// ── signing (one-tap links for Mac, choice links for customers) ─────────────────────────────────────────────────
const sign = (what, s = secret()) => (s ? crypto.createHmac('sha256', s).update(`pickup|${what}`).digest('hex').slice(0, 32) : null);
function verify(what, t, s = secret()) { const w = sign(what, s); return !!w && !!t && w.length === String(t).length && crypto.timingSafeEqual(Buffer.from(w), Buffer.from(String(t))); }
const tapUrl = (action, name) => `${PUBLIC_BASE}/pickup/${action}?o=${encodeURIComponent(name)}&t=${sign(`${action}|${name}`)}`;
const choiceUrl = (name, code, label) => `${SITE}/pages/trim-pickup?o=${encodeURIComponent(name.replace(/^#/, ''))}&c=${encodeURIComponent(code)}&n=${encodeURIComponent(label || '')}&t=${sign(`choice|${name}|${code}`)}`;

// ── Shopify read ────────────────────────────────────────────────────────────────────────────────────────────────
const ORDER_FIELDS = `id name createdAt processedAt cancelledAt displayFinancialStatus displayFulfillmentStatus email
  customer { firstName lastName email }
  shippingAddress { firstName lastName city provinceCode zip }
  shippingLines(first: 5) { nodes { title } }
  customAttributes { key value }
  lineItems(first: 50) { nodes { id sku name quantity currentQuantity unfulfilledQuantity
    variant { product { productType metafield(namespace: "pickup", key: "mode") { value } } } } }
  fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType }
    lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } } } }`;

function normalize(o) {
  const lines = (o.lineItems.nodes || []).map((l) => {
    const prod = (l.variant && l.variant.product) || {};
    const pmode = (prod.metafield && prod.metafield.value) || (prod.productType === 'Schluter Profile' ? 'only' : null);
    return { id: l.id, sku: l.sku, name: l.name, quantity: l.quantity, current: l.currentQuantity, unfulfilled: l.unfulfilledQuantity, pickupMode: pmode };
  });
  return {
    id: o.id, name: o.name, paidAt: o.processedAt || o.createdAt, cancelledAt: o.cancelledAt,
    financial: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus,
    email: (o.customer && o.customer.email) || o.email || null,
    firstName: (o.customer && o.customer.firstName) || (o.shippingAddress && o.shippingAddress.firstName) || '',
    lastName: (o.customer && o.customer.lastName) || (o.shippingAddress && o.shippingAddress.lastName) || '',
    ship: o.shippingAddress || {},
    shippingLines: { nodes: (o.shippingLines.nodes || []).map((n) => ({ title: n.title })) },
    customAttributes: o.customAttributes || [],
    lines,
    fulfillmentOrders: (o.fulfillmentOrders.nodes || []).map((f) => ({ id: f.id, status: f.status, methodType: f.deliveryMethod && f.deliveryMethod.methodType,
      lines: (f.lineItems.nodes || []).map((x) => ({ id: x.id, remaining: x.remainingQuantity, lineItemId: x.lineItem.id })) })),
  };
}

async function collect(gql, { now = new Date(), days = 45 } = {}) {
  const since = new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  const out = [];
  let after = null;
  do {
    const r = await gql(`query($q: String!, $a: String) { orders(first: 25, after: $a, query: $q, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`, { q: `status:open AND (fulfillment_status:unshipped OR fulfillment_status:partial) AND created_at:>=${since}`, a: after });
    out.push(...r.orders.nodes.map(normalize));
    after = r.orders.pageInfo.hasNextPage ? r.orders.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function fetchOrder(gql, id) {
  const r = await gql(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id });
  return r.order ? normalize(r.order) : null;
}

// ── classification ──────────────────────────────────────────────────────────────────────────────────────────────
const COAST_LOC = { sechelt: 'sechelt', 'powell river': 'powell_river' };

function classify(order, branches) {
  const r = bp.resolvePickup(order, branches);
  if (r.kind) {
    if (r.hold) return { kind: 'hold', reason: r.hold };
    if (r.kind === 'coast_pickup') {
      const loc = COAST_LOC[String(r.city || '').toLowerCase()];
      return loc ? { kind: 'coast', location: loc } : { kind: 'hold', reason: `coast city ${r.city}` };
    }
    const row = branches.find((b) => b.code === r.branch || b.map_code === r.branch);
    return row ? { kind: 'branch', branch: row.code } : { kind: 'hold', reason: `branch ${r.branch} not in table` };
  }
  const trims = order.lines.filter((l) => l.pickupMode === 'only' && l.current > 0);
  if (trims.length) return { kind: 'split' };
  return { kind: null };
}

// ── places, distance ────────────────────────────────────────────────────────────────────────────────────────────
function placeFor(rec, branches, schedule = eta.DEFAULT_SCHEDULE) {
  if (rec.kind === 'coast') {
    const l = schedule.locations[rec.location];
    return { customer_name: l.customer_name, address: l.address, hours: l.hours, idNeeded: false };
  }
  const b = branches.find((x) => x.code === rec.branch);
  if (!b) throw new Error(`no branch ${rec.branch}`);
  const sat = b.hours && b.hours.sat && !/closed/i.test(b.hours.sat) ? `, Sat ${b.hours.sat}` : '';
  return { customer_name: b.customer_name || `our ${b.pickup_label} trade counter`, address: b.address_full, hours: `Mon to Fri ${b.hours.mon_fri}${sat}`.replace(/(\d):00/g, '$1').replace(/(\d)\s*(am|pm)/gi, '$1 $2').replace(/ - /g, ' to '), idNeeded: true };
}

const COAST_FSA = /^(V0N|V7Z|V8A)/i;
/** The counters to offer a split order: enabled ones in the buyer's province; Coast first for Coast postal codes. */
function choicesFor(order, branches) {
  const prov = String(order.ship.provinceCode || '').toUpperCase();
  const zip = String(order.ship.zip || '').replace(/\s/g, '');
  const rows = branches.filter((b) => b.enabled && b.province === prov);
  const coast = rows.filter((b) => b.coast);
  const hubs = rows.filter((b) => !b.coast);
  const ordered = COAST_FSA.test(zip) ? [...coast, ...hubs] : [...hubs, ...coast];
  return ordered.slice(0, 4);
}

// ── plan (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────
const bcDate = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(0, 10);
const bizDaysAfter = (iso, n, schedule) => eta.addBusinessDays(bcDate(Date.parse(iso)), n, schedule);

/**
 * -> { actions: [{ key, type, ... }], patch }   patch = fields to set on the record once the actions are done.
 * Action types: customer_email { template, message, ctx, to } | branch_po { branch, email } | mac_email { subject, html }
 *               | refund_trims { lines } | fulfill { fulfillmentOrderIds }
 */
function plan({ order, rec, now, branches, schedule = eta.DEFAULT_SCHEDULE }) {
  const name = order.name;
  const done = rec.done || {};
  const todo = [];
  const add = (a) => { if (!done[a.key]) todo.push(a); };
  const nowIso = typeof now === 'string' ? now : now.toISOString();
  const today = bcDate(Date.parse(nowIso));
  const to = order.email;
  const first = order.firstName;

  if (order.cancelledAt) {
    if (rec.kind === 'branch' && ['PO_SENT', 'READY'].includes(rec.status)) {
      add({ key: `${name}:cancel_branch`, type: 'mac_email', subject: `Cancelled pickup ${name}: tell the branch`, html: `<p>Order ${name} was cancelled after its pickup PO went to ${rec.branch}. Ask the branch to release it.</p>` });
    }
    return { actions: todo, patch: { status: 'CANCELLED' } };
  }
  const fulfilled = order.fulfillment === 'FULFILLED';

  if (rec.kind === 'coast') {
    const p = pa.planActions({ order: { name, paidAt: order.paidAt, location: rec.location, lines: order.lines.filter((l) => l.current > 0).map(() => 'order_in'), firstName: first, pickedUpAt: rec.pickedUpAt || (fulfilled ? nowIso : null) },
      state: { done, markedReadyAt: rec.markedReadyAt || null, partialReadyAt: rec.partialReadyAt || null, pickedUpAt: rec.pickedUpAt || (fulfilled ? nowIso : null) }, now: nowIso }, schedule);
    for (const a of p.actions) {
      if (a.type === 'send_customer') add({ key: a.key, type: 'customer_email', template: 'coast', message: a.message, ctx: a, to });
      else if (a.type === 'mark_ready') add({ key: a.key, type: 'customer_email', template: 'counter', message: 'ready_for_pickup', ctx: { orderName: name, firstName: first, place: placeFor(rec, branches, schedule) }, to, marks: { markedReadyAt: nowIso } });
      else if (a.type === 'supplier_confirm_request') add({ key: a.key, type: 'mac_email', subject: `Pickup ${name}: confirm it makes the next truck`, html: `<p>${name} was paid after the 2 pm cutoff. Check it can still go on the next run to Sechelt.</p>` });
      else if (a.type === 'escalate') add({ key: a.key, type: 'mac_email', subject: `Pickup ${name} needs you`, html: `<p>${name}: ${a.reason || 'not picked up after 10 business days'}.</p>` });
    }
    if (fulfilled) return { actions: todo, patch: { status: 'PICKED_UP', pickedUpAt: rec.pickedUpAt || nowIso } };
    return { actions: todo, patch: { status: p.status } };
  }

  if (rec.kind === 'branch') {
    const place = placeFor(rec, branches, schedule);
    const lines = order.lines.filter((l) => l.current > 0);
    const status = rec.status || 'NEW';
    if (fulfilled || rec.pickedUpAt) {
      if (!fulfilled) add({ key: `${name}:fulfill`, type: 'fulfill', fulfillmentOrderIds: order.fulfillmentOrders.filter((f) => f.status !== 'CLOSED' && f.status !== 'CANCELLED').map((f) => f.id) });
      add({ key: `${name}:picked_up`, type: 'customer_email', template: 'counter', message: 'counter_picked_up', ctx: { orderName: name, firstName: first }, to });
      return { actions: todo, patch: { status: 'PICKED_UP', pickedUpAt: rec.pickedUpAt || nowIso } };
    }
    if (status === 'NEW') {
      const b = branches.find((x) => x.code === rec.branch);
      const email = bp.buildPickupEmail({ order: { name, customer: { firstName: first, lastName: order.lastName } }, branch: { code: b.code, city: b.pickup_label }, lines: lines.map((l) => ({ sku: l.sku, quantity: l.current })) });
      add({ key: `${name}:branch_po`, type: 'branch_po', branch: b.code, cc: b.email, email });
      add({ key: `${name}:branch_ordered`, type: 'customer_email', template: 'counter', message: 'branch_ordered', ctx: { orderName: name, firstName: first, place }, to });
      return { actions: todo, patch: { status: 'PO_SENT', poSentAt: rec.poSentAt || nowIso } };
    }
    if (status === 'PO_SENT') {
      if (rec.readyAt) {
        add({ key: `${name}:ready`, type: 'customer_email', template: 'counter', message: 'ready_for_pickup', ctx: { orderName: name, firstName: first, place }, to });
        return { actions: todo, patch: { status: 'READY' } };
      }
      if (rec.poSentAt && today >= bizDaysAfter(rec.poSentAt, 3, schedule)) {
        add({ key: `${name}:mac_check`, type: 'mac_email', subject: `Pickup ${name} at ${rec.branch}: is it ready?`,
          html: `<p>No ready reply yet for ${name} (${first} ${order.lastName}) at ${place.customer_name}, PO sent ${bcDate(Date.parse(rec.poSentAt))}.</p>
<p><a href="${tapUrl('ready', name)}">Mark ready (emails the customer)</a></p><p><a href="${tapUrl('nudge', name)}">Re-send the pickup email to the branch</a></p><p><a href="${tapUrl('picked-up', name)}">Already picked up</a></p>` });
      }
      return { actions: todo, patch: {} };
    }
    if (status === 'READY') {
      const readyDay = bcDate(Date.parse(rec.readyAt));
      if (today >= eta.addBusinessDays(readyDay, 3, schedule)) add({ key: `${name}:reminder_1`, type: 'customer_email', template: 'counter', message: 'counter_reminder', ctx: { orderName: name, firstName: first, place }, to });
      if (today >= eta.addBusinessDays(readyDay, 7, schedule)) add({ key: `${name}:reminder_2`, type: 'customer_email', template: 'counter', message: 'counter_reminder', ctx: { orderName: name, firstName: first, place }, to });
      if (today >= eta.addBusinessDays(readyDay, 10, schedule)) add({ key: `${name}:escalate`, type: 'mac_email', subject: `Pickup ${name} not collected after 10 business days`, html: `<p>${name} has been ready at ${place.customer_name} since ${readyDay}.</p><p><a href="${tapUrl('picked-up', name)}">It was picked up</a></p>` });
      return { actions: todo, patch: {} };
    }
    return { actions: todo, patch: {} };
  }

  if (rec.kind === 'split') {
    const trims = order.lines.filter((l) => l.pickupMode === 'only' && l.current > 0);
    if (!trims.length) return { actions: todo, patch: { status: 'DONE' } };
    if (rec.choice === 'REFUND' || (!rec.choice && rec.deadline && today > rec.deadline)) {
      const reason = rec.choice === 'REFUND' ? 'asked' : 'no_answer';
      add({ key: `${name}:refund_trims`, type: 'refund_trims', lines: trims.map((l) => ({ lineItemId: l.id, quantity: l.current, name: l.name })), reason,
        then: { to, ctx: { orderName: name, firstName: first, trimItems: trims.map((l) => (l.current > 1 ? `${l.name} (${l.current})` : l.name)), reason } } });
      return { actions: todo, patch: { status: 'REFUNDED' } };
    }
    if (rec.choice && rec.choice !== 'REFUND') {
      // Pickup chosen for the trims: they become a counter/coast pickup; the rest of the order still has to ship
      // without them, which the pipeline can't do yet (it refuses the whole order on a pickup-only line).
      add({ key: `${name}:split_ship_rest`, type: 'mac_email', subject: `Split order ${name}: trims at ${rec.choice}, ship the rest`,
        html: `<p>${name}: the customer chose pickup at ${rec.choice} for the trims. The rest of the order needs to ship without them (automatic split of the shipping part isn't built yet).</p>` });
      return { actions: todo, patch: { status: 'CHOSE_PICKUP' } };
    }
    const choices = choicesFor(order, branches).map((b) => ({ code: b.code, label: b.pickup_label, customer_name: b.customer_name, address: b.address_full, url: choiceUrl(name, b.code, b.pickup_label) }));
    const deadline = rec.deadline || eta.addBusinessDays(today, SPLIT_DAYS, schedule);
    if (!choices.length) {
      add({ key: `${name}:split_no_counter`, type: 'mac_email', subject: `Split order ${name}: no counter in ${order.ship.provinceCode}`, html: `<p>${name} holds full-length trims and ships to ${order.ship.provinceCode}, which has no counter. The trims will be refunded on ${deadline}.</p>` });
    } else {
      add({ key: `${name}:split_choice`, type: 'customer_email', template: 'counter', message: 'split_choice', to,
        ctx: { orderName: name, firstName: first, trimItems: trims.map((l) => l.name), choices, refundUrl: choiceUrl(name, 'REFUND', 'refund'), deadline } });
    }
    return { actions: todo, patch: { status: 'ASKED', deadline } };
  }

  if (rec.kind === 'hold') {
    add({ key: `${name}:hold`, type: 'mac_email', subject: `Pickup ${name} needs a look`, html: `<p>${name} looks like a pickup but couldn't be matched to a counter (${rec.reason}).</p>` });
  }
  return { actions: todo, patch: {} };
}

// ── render (for sending and for the shadow digest) ──────────────────────────────────────────────────────────────
function renderCustomer(a) {
  if (a.template === 'coast') return pm.buildPickupMessage(a.message, a.ctx);
  return cm.buildCounterMessage(a.message, a.ctx);
}
const allowedToSend = (a, msg) => (a.template === 'coast' ? pm.autoSendAllowed(a.message, msg) : cm.autoSendAllowed(a.message, msg));

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * io: { gql, sendEmail({ to, cc, subject, html, text }), refundTrims(order, lines), fulfill(ids), log(o) }
 * Returns { orders, performed, shadowed, errors }.
 */
async function run({ io, now = new Date(), file = STATE_PATH, branches = loadBranches(), m = mode() } = {}) {
  const state = loadState(file);
  state.orders = state.orders || {};
  state.shadow = state.shadow || {};
  const out = { orders: 0, performed: [], shadowed: [], errors: [] };
  const seen = new Set();
  const orders = await collect(io.gql, { now });
  for (const id of Object.values(state.orders).filter((r) => r.id && !['PICKED_UP', 'CANCELLED', 'DONE', 'REFUNDED'].includes(r.status)).map((r) => r.id)) {
    if (!orders.some((o) => o.id === id)) { const o = await fetchOrder(io.gql, id); if (o) orders.push(o); }
  }
  for (const order of orders) {
    if (seen.has(order.name)) continue;
    seen.add(order.name);
    let rec = state.orders[order.name];
    if (!rec) {
      const c = classify(order, branches);
      if (!c.kind) continue;
      rec = { id: order.id, kind: c.kind, ...(c.location ? { location: c.location } : {}), ...(c.branch ? { branch: c.branch } : {}), ...(c.reason ? { reason: c.reason } : {}), status: 'NEW', firstSeenAt: now.toISOString(), done: {} };
      state.orders[order.name] = rec;
    }
    out.orders++;
    let p;
    try { p = plan({ order, rec, now, branches }); } catch (e) { out.errors.push({ order: order.name, error: e.message }); continue; }
    const live = liveFor(rec.kind, m);
    let allDone = true;
    for (const a of p.actions) {
      try {
        const msg = a.type === 'customer_email' ? renderCustomer(a) : null;
        if (msg && msg.placeholders.length) throw new Error(`placeholder left in ${a.message}: ${msg.placeholders.join(', ')}`);
        if (!live) {
          const day = bcDate(now.getTime());
          state.shadow[day] = state.shadow[day] || [];
          if (!state.shadow[day].some((x) => x.key === a.key)) state.shadow[day].push({ key: a.key, order: order.name, kind: rec.kind, type: a.type, ...(msg ? { to: a.to, subject: msg.subject, text: msg.text } : {}), ...(a.subject ? { subject: a.subject } : {}), ...(a.email ? { to: 'Prosol order desk', cc: a.cc, subject: a.email.subject, text: a.email.body } : {}) });
          out.shadowed.push(a.key);
          allDone = false;
          continue;
        }
        await perform(a, msg, order, io);
        rec.done[a.key] = now.toISOString();
        if (a.marks) Object.assign(rec, a.marks);
        out.performed.push(a.key);
        io.log && io.log({ action: 'pickup-runner', key: a.key, type: a.type });
      } catch (e) {
        allDone = false;
        out.errors.push({ order: order.name, key: a.key, error: e.message });
      }
    }
    if (live && allDone) Object.assign(rec, p.patch);
  }
  saveState(state, file);
  return out;
}

async function perform(a, msg, order, io) {
  if (a.type === 'customer_email') {
    if (!a.to) throw new Error('no customer email on the order');
    if (!allowedToSend(a, msg)) throw new Error(`${a.message} has no standing OK`);
    await io.sendEmail({ to: a.to, subject: msg.subject, html: msg.html, text: msg.text });
  } else if (a.type === 'branch_po') {
    await io.sendEmail({ to: process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca', cc: [a.cc, process.env.MAC_CC_EMAIL || 'mac@customfc.ca'].filter(Boolean).join(', '), subject: a.email.subject, text: a.email.body, html: `<pre style="font-family:Arial,sans-serif;font-size:14px">${a.email.body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>` });
  } else if (a.type === 'mac_email') {
    await io.sendEmail({ to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca', subject: a.subject, html: a.html });
  } else if (a.type === 'fulfill') {
    await io.fulfill(a.fulfillmentOrderIds);
  } else if (a.type === 'refund_trims') {
    const r = await io.refundTrims(order, a.lines);
    const m2 = cm.buildCounterMessage('trims_refunded', { ...a.then.ctx, amount: r.amount });
    await io.sendEmail({ to: a.then.to, subject: m2.subject, html: m2.html, text: m2.text });
  } else throw new Error(`unknown action ${a.type}`);
}

/** The shadow digest for one BC day (text + html), or null when nothing would have happened. */
function shadowDigest(state, day) {
  const items = (state.shadow || {})[day] || [];
  if (!items.length) return null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<p>Pickup runner is in test mode: nothing below was sent. This is what it would have done on ${day}.</p>` + items.map((x) => `<div style="margin:14px 0;padding:12px;border:1px solid #ddd;border-radius:8px"><b>${esc(x.order)}</b> (${esc(x.kind)}): ${esc(x.type)}${x.to ? ` to ${esc(x.to)}` : ''}${x.cc ? ` cc ${esc(x.cc)}` : ''}<br><b>${esc(x.subject || '')}</b>${x.text ? `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:13px">${esc(x.text)}</pre>` : ''}</div>`).join('');
  return { subject: `Pickup runner (test mode): ${items.length} action${items.length === 1 ? '' : 's'} on ${day}`, html };
}

/** Record a one-tap or a customer choice. -> the record, or null when the link doesn't verify. */
function applySignal({ action, name, token, code = null, now = new Date(), file = STATE_PATH }) {
  const what = action === 'choice' ? `choice|${name}|${code}` : `${action}|${name}`;
  if (!verify(what, token)) return null;
  const state = loadState(file);
  const rec = state.orders[name];
  if (!rec) return null;
  const at = now.toISOString();
  if (action === 'ready') rec.readyAt = rec.readyAt || at;
  else if (action === 'picked-up') rec.pickedUpAt = rec.pickedUpAt || at;
  else if (action === 'nudge') delete rec.done[`${name}:branch_po`];
  else if (action === 'choice' && rec.kind === 'split' && !rec.choice) { rec.choice = code; rec.choiceAt = at; }
  saveState(state, file);
  return rec;
}

module.exports = { STATE_PATH, mode, liveFor, sign, verify, tapUrl, choiceUrl, normalize, collect, classify, choicesFor, placeFor, plan, run, perform, shadowDigest, applySignal, loadState, saveState, loadBranches, renderCustomer };
