'use strict';
/**
 * Customer-requested cancel of a YourFloors Shopify order, run by the hello@ ticket desk
 * (yourfloors-cs/desk.js, DESK_AUTOCANCEL_LIVE) through scripts/ops/order-autocancel.js.
 *
 * Rules Mac approved 2026-11-04 (after #1444 Jesse Morwood sat held while Mac missed the approval email), extended the
 * same day to shipping orders up to the FIRST CARRIER SCAN:
 *   auto only when ONE Shopify order is identified, the sender is the order's email, it is PAID, not cancelled,
 *   not refunded (a PENDING refund counts), total <= $500, and nothing physically moved. Buying a label marks the
 *   ShipStation order shipped and creates a Shopify fulfillment; that is still "unmoved" when every tracking number on
 *   every live Shopify fulfillment is a label we bought (ops-state / ShipStation) and every one of our live labels has
 *   only "electronically submitted" / "created a label" events. A pickup fulfillment, a fulfillment with no or unknown
 *   tracking, any scan, or more than one branch is a hold. Anything else, or any doubt, is a hold for Mac.
 * Order of operations (goods first, money last, so a failed refund never leaves a refunded order in the buy queue):
 *   void each live label (scan re-checked right before each void), pull it from ops-state (backed up), mark the pickup
 *   CANCELLED, email Kaitlyn + the branch order desk when the branch was already told, re-open an archived order,
 *   cancel the Shopify fulfillment(s), take the order out of ShipStation, cancel the Automayt PO(s) and SO, then
 *   re-check every label's scans and refund in full with refundCreate (computed fresh, unfulfilled lines restocked
 *   CANCEL; order left OPEN, notify false).
 *
 * evaluate() is pure (tests: lib/order-autocancel.test.js). gather() only reads. execute() writes, step by step,
 * with a journal (data/order-autocancel/<n>.json) so a re-run never repeats a done step.
 */

const fs = require('fs');
const path = require('path');

const MAX_TOTAL = 500;
const RECENT_DAYS = 30; // "the sender's open orders" when no number is given
const KAITLYN = () => process.env.KAITLYN_EMAIL || 'KLazzarotto@prosol.ca';
const MAC_CC = () => process.env.MAC_CC_EMAIL || 'mac@customfc.ca';
const DATA = path.join(__dirname, '..', 'data');
const JOURNAL_DIR = path.join(DATA, 'order-autocancel');
const OPS_DIR = path.join(DATA, 'ops-state');
const OPS_LOOKBACK_DAYS = 14;
const MOVED_CODES = new Set(['IT', 'AT', 'DE', 'EX', 'SP']);
// Label-only events: the carrier has the shipment data, nobody has touched the box. "Picked up by Purolator" also
// arrives with status_code AC (seen on #1441), which is why events are judged by their words, not their code.
const LABEL_ONLY = /electronic|created a label|label created|shipment information received/i;
// Shopify fulfillment display states that say nothing about movement (a bought label shows FULFILLED forever).
const QUIET_DISPLAY = new Set(['FULFILLED', 'CONFIRMED', 'LABEL_PRINTED', 'LABEL_PURCHASED', 'MARKED_AS_FULFILLED', 'SUCCESS']);

const money = (n) => `$${Number(n).toFixed(2)}`;
const cents = (n) => Math.round(Number(n) * 100);
const orderNum = (name) => String(name || '').replace(/[^0-9]/g, '');

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A label is unmoved only when the carrier has nothing but label-only events on it. Anything else, an unknown
 * shape included, counts as moved (fail closed).
 */
function labelUnmoved(track) {
  if (!track || typeof track !== 'object') return false;
  const status = String(track.status_code || '').toUpperCase();
  if (MOVED_CODES.has(status)) return false;
  const events = Array.isArray(track.events) ? track.events : [];
  return events.every((e) => LABEL_ONLY.test(`${e.description || ''} ${e.carrier_status_description || ''}`)
    && !/picked up|drop(ped)? ?off|depot|arrived|departed|in transit|out for delivery|deliver/i.test(`${e.description || ''} ${e.carrier_status_description || ''}`)
    && !MOVED_CODES.has(String(e.status_code || '').toUpperCase()));
}

/** "Burnaby (BURN)" -> "BURN" */
function branchCodeOf(warehouseName) {
  const m = /\(([A-Z]{3,5})\)\s*$/.exec(String(warehouseName || ''));
  return m ? m[1] : null;
}

function carrierName(code) {
  const c = String(code || '').toLowerCase();
  if (c.startsWith('purolator')) return 'Purolator';
  if (c.startsWith('ups')) return 'UPS';
  if (c.startsWith('canada_post')) return 'Canada Post';
  if (c.startsWith('fedex')) return 'FedEx';
  return 'the carrier';
}

/** Email to Kaitlyn + the branch order desk. With labels: the box may already be packed, so "pull the box". */
function branchEmail({ orderName, poNumbers, vendorRefs, branch, voidedTracking, carriers = [] }) {
  const pos = poNumbers.join(' and ');
  const yours = vendorRefs.length ? ` (your order ${vendorRefs.join(', ')})` : '';
  const team = `Hi Kaitlyn and ${branch.pickup_label || branch.label || branch.code} team,`;
  const sign = ['', 'Please reply to confirm.', '', 'Thanks,', 'Mac'];
  if (voidedTracking.length) {
    const who = [...new Set(carriers.map(carrierName))];
    const carrier = who.length === 1 ? who[0] : 'the carrier';
    const labels = voidedTracking.length === 1 ? `The label (${voidedTracking[0]}) has been voided.` : `The labels (${voidedTracking.join(', ')}) have been voided.`;
    const text = [team, '', `Please pull the box${voidedTracking.length > 1 ? 'es' : ''} for ${pos}${yours}, YourFloors order ${orderName}, and don't hand ${voidedTracking.length > 1 ? 'them' : 'it'} to ${carrier}. The customer cancelled. ${labels} The contents can go back to stock.`, ...sign].join('\n');
    return { to: [KAITLYN(), branch.email], cc: MAC_CC(), subject: `Please pull ${pos} (YourFloors ${orderName}), cancelled`, text };
  }
  const text = [team, '', `Please cancel ${pos}${yours}, YourFloors order ${orderName}. The customer won't need it. If it has already been pulled, it can go back to stock.`, ...sign].join('\n');
  return { to: [KAITLYN(), branch.email], cc: MAC_CC(), subject: `Please cancel ${pos} (YourFloors ${orderName})`, text };
}

/**
 * facts: see gather(). opts.ignoreCancelState: dry-run harness only (what would it have done before the order was
 * cancelled by hand): refunds, a CANCELLED pickup record and cancelled ERP records are read as their earlier state.
 * opts.ignoreScans: dry-run harness only: carrier scans on our labels are read as unmoved.
 * Returns { eligible, holds: [why...], plan: [step...], summary }.
 */
function evaluate(facts, opts = {}) {
  const asBefore = !!opts.ignoreCancelState;
  const noScans = !!opts.ignoreScans;
  const holds = [];
  const hold = (why) => { holds.push(why); };
  const plan = [];
  const f = facts || {};

  // 1. which order
  const lk = f.lookup || {};
  if (lk.error) hold(`could not look the order up: ${lk.error}`);
  if ((lk.numbers || []).length > 1) hold(`the message names ${lk.numbers.length} order numbers (${lk.numbers.join(', ')})`);
  else if ((lk.numbers || []).length === 1 && !f.order) hold(`order #${lk.numbers[0]} was not found in Shopify`);
  else if (!(lk.numbers || []).length && (lk.openOrders || []).length !== 1) hold(`no order number in the message and the sender has ${(lk.openOrders || []).length} open orders`);
  const o = f.order;
  if (!o) return { eligible: false, holds: holds.length ? holds : ['no order identified'], plan: [], summary: 'no order' };

  // 2. who, money state
  if (!f.sender || String(o.email || '').toLowerCase() !== String(f.sender).toLowerCase()) hold(`sender ${f.sender || '?'} is not the order's email (${o.email || 'none'})`);
  if (o.cancelledAt) hold(`order is already cancelled in Shopify (${String(o.cancelledAt).slice(0, 10)})`);
  const refunded = (o.refundCount || 0) > 0 || (o.transactions || []).some((t) => t.kind === 'REFUND');
  if (refunded && !asBefore) hold('order already has a refund on file (a PENDING refund counts; never refund twice)');
  if (o.financial !== 'PAID' && !(asBefore && refunded)) hold(`order is ${o.financial}, not PAID`);
  if (!(Number(o.total) > 0)) hold('order total is zero or unknown');
  if (Number(o.total) > MAX_TOTAL) hold(`order total ${money(o.total)} is over the ${money(MAX_TOTAL)} auto limit`);
  const sales = (o.transactions || []).filter((t) => ['SALE', 'CAPTURE'].includes(t.kind) && t.status === 'SUCCESS');
  if (!sales.length) hold('no successful payment on the order');

  // 3. our labels: every live one must be unmoved
  const ss = f.shipstation || {};
  if (ss.error) hold(`ShipStation check failed: ${ss.error}`);
  const liveLabels = (ss.labels || []).filter((l) => !l.voided);
  for (const l of liveLabels) {
    if (l.trackError) hold(`could not read tracking for label ${l.trackingNumber || l.shipmentId}: ${l.trackError}`);
    else if (!l.unmoved && !noScans) hold(`label ${l.trackingNumber || l.shipmentId} has a carrier scan (${l.trackStatus || 'moved'}${l.events && l.events.length ? `: ${l.events[0]}` : ''})`);
  }
  const warehouses = new Set(liveLabels.map((l) => l.warehouseId).filter(Boolean).map(String));
  if (warehouses.size > 1) hold(`the labels are at more than one warehouse (${[...warehouses].join(', ')})`);
  const ourTracking = new Set(liveLabels.filter((l) => l.trackingNumber).map((l) => String(l.trackingNumber).replace(/\s/g, '')));

  // 4. Shopify fulfillments: only ours, unmoved, shipping
  const pk = f.pickup || {};
  const liveFulfillments = (o.fulfillments || []).filter((x) => !['CANCELLED', 'ERROR', 'FAILURE'].includes(String(x.status || '').toUpperCase()));
  for (const fl of liveFulfillments) {
    const nums = (fl.tracking || []).map((t) => String(t || '').replace(/\s/g, '')).filter(Boolean);
    const methods = fl.methods || [];
    if (pk.kind || methods.some((m) => m && m !== 'SHIPPING')) { hold(`order has a ${pk.kind ? 'pickup' : methods.join('/').toLowerCase()} fulfillment in Shopify (collected or handed over)`); continue; }
    if (!nums.length) { hold(`Shopify fulfillment ${fl.id} has no tracking number (fulfilled outside our labels)`); continue; }
    const foreign = nums.filter((n) => !ourTracking.has(n));
    if (foreign.length) { hold(`Shopify fulfillment tracking ${foreign.join(', ')} is not a live label we bought`); continue; }
    if (fl.inTransitAt || fl.deliveredAt) hold(`Shopify shows fulfillment ${fl.id} ${fl.deliveredAt ? 'delivered' : 'in transit'}`);
    else if (fl.displayStatus && !QUIET_DISPLAY.has(fl.displayStatus)) hold(`Shopify fulfillment ${fl.id} is ${fl.displayStatus}`);
  }
  const okStatuses = ['UNFULFILLED', 'SCHEDULED', 'ON_HOLD', 'IN_PROGRESS', 'PENDING_FULFILLMENT', 'OPEN', 'FULFILLED', 'PARTIALLY_FULFILLED'];
  if (o.fulfillmentStatus && !okStatuses.includes(o.fulfillmentStatus)) hold(`fulfillment status is ${o.fulfillmentStatus}`);
  if (['FULFILLED', 'PARTIALLY_FULFILLED'].includes(o.fulfillmentStatus) && !liveFulfillments.length) hold(`order reads ${o.fulfillmentStatus} but no fulfillment was found`);
  for (const so of ss.orders || []) {
    if (so.orderStatus === 'shipped' && !liveLabels.length) hold(`ShipStation order ${so.orderId} is marked shipped but has no live label we know of`);
    if (!['awaiting_payment', 'awaiting_shipment', 'on_hold', 'pending_fulfillment', 'shipped', 'cancelled'].includes(so.orderStatus)) hold(`ShipStation order ${so.orderId} is ${so.orderStatus}`);
  }

  // 5. pickups
  if (pk.error) hold(`pickup check failed: ${pk.error}`);
  if (pk.kind && pk.kind !== 'branch') hold(`it is a ${pk.kind} pickup${pk.reason ? ` (${pk.reason})` : ''}; only Prosol counter pickups are automatic`);
  const rec = pk.rec || null;
  let recStatus = rec ? rec.status : null;
  if (asBefore && recStatus === 'CANCELLED') recStatus = rec.poSentAt ? 'PO_SENT' : 'NEW';
  if (rec && ['PICKED_UP', 'DONE', 'REFUNDED'].includes(recStatus)) hold(`pickup is ${recStatus}`);
  if (rec && recStatus === 'CANCELLED') hold('pickup is already marked CANCELLED (handled by hand)');
  if (rec && rec.pickedUpAt) hold(`pickup was collected ${String(rec.pickedUpAt).slice(0, 10)}`);
  if (pk.kind && liveLabels.length) hold('a pickup order with a shipping label');

  // 6. ERP
  const erp = f.erp || {};
  if (erp.error) hold(`Automayt check failed: ${erp.error}`);
  const openSo = erp.so && (asBefore || erp.so.status !== 'cancelled') ? erp.so : null;
  const pos = (erp.pos || []).filter((p) => asBefore || p.status !== 'cancelled');
  for (const p of pos) if (Number(p.qtyReceived || 0) > 0) hold(`${p.number} shows ${p.qtyReceived} received`);

  // 7. was the branch told?
  const opsLabels = (f.opsState && f.opsState.labels) || [];
  const emailed = (f.opsState && f.opsState.emailed) || [];
  const branchTold = emailed.length > 0 || (rec && (['PO_SENT', 'READY'].includes(recStatus) || !!(rec.done || {})[`${o.name}:branch_po`]));
  let branch = null;
  if (branchTold) {
    const code = rec && rec.branch ? rec.branch : branchCodeOf(emailed[0] && emailed[0].warehouse);
    const codes = new Set([...(rec && rec.branch ? [rec.branch] : []), ...emailed.map((e) => branchCodeOf(e.warehouse))]);
    branch = (f.branches || []).find((b) => b.code === code) || null;
    if (codes.size > 1) hold(`the order went to more than one branch (${[...codes].join(', ')})`);
    else if (!branch || !branch.email) hold(`branch ${code || '?'} has no order desk email on file`);
  }
  const poNumbers = [...new Set([...pos.map((p) => p.number), ...(rec && rec.poNumber && !pos.length ? [rec.poNumber] : [])])].filter(Boolean);
  if (branchTold && !poNumbers.length) hold('the branch was told but no PO number was found to cancel');
  if (opsLabels.some((x) => x.error)) hold(`ops-state read failed: ${opsLabels.find((x) => x.error).error}`);

  // 8. refund maths (amount only; the executor recomputes the restock after the fulfillments are cancelled)
  const r = f.refund || {};
  let refundAmount = Number(o.total);
  if (!asBefore) {
    if (r.error) hold(`refund preview failed: ${r.error}`);
    else {
      if (cents(r.amount) !== cents(o.total)) hold(`Shopify suggests refunding ${money(r.amount || 0)}, not the full ${money(o.total)}`);
      const saleIds = new Set(sales.map((t) => t.id));
      if (!(r.transactions || []).length || (r.transactions || []).some((t) => !t.parentId || !saleIds.has(t.parentId))) hold('the suggested refund is not against the original payment');
      if (cents((r.transactions || []).reduce((a, t) => a + Number(t.amount), 0)) !== cents(o.total)) hold('the suggested refund transactions do not add up to the order total');
      refundAmount = Number(r.amount);
    }
  }

  // ── plan, in order: goods first, money last ──
  const voidedTracking = [];
  for (const l of liveLabels) { plan.push({ key: `void:${l.shipmentId}`, type: 'void_label', shipmentId: l.shipmentId, trackingNumber: l.trackingNumber || null }); voidedTracking.push(l.trackingNumber || String(l.shipmentId)); }
  for (const x of opsLabels.filter((y) => !y.error)) plan.push({ key: `ops:${x.date}:${x.ssOrderId}`, type: 'ops_state_remove', date: x.date, ssOrderId: x.ssOrderId });
  if (pk.kind === 'branch') plan.push({ key: 'pickup', type: 'pickup_cancel', name: o.name, create: !rec, rec: rec ? null : { id: o.id, kind: 'branch', branch: pk.branch || null } });
  if (branchTold && branch && branch.email && poNumbers.length) {
    plan.push({ key: 'branch_email', type: 'branch_email', branch: branch.code,
      ...branchEmail({ orderName: o.name, poNumbers, vendorRefs: pos.map((p) => p.vendorRef).filter(Boolean), branch, voidedTracking, carriers: liveLabels.map((l) => l.carrierCode) }) });
  }
  if (liveFulfillments.length && o.closed) plan.push({ key: 'order_open', type: 'order_open', orderId: o.id });
  for (const fl of liveFulfillments) plan.push({ key: `fulfillment:${fl.id}`, type: 'fulfillment_cancel', fulfillmentId: fl.id, tracking: fl.tracking || [] });
  for (const so of (ss.orders || []).filter((y) => y.orderStatus !== 'cancelled')) plan.push({ key: `ss:${so.orderId}`, type: 'ss_remove', orderId: so.orderId, orderNumber: so.orderNumber });
  for (const p of pos) plan.push({ key: `erp_po:${p.id}`, type: 'erp_cancel_po', id: p.id, number: p.number });
  if (openSo) plan.push({ key: `erp_so:${openSo.id}`, type: 'erp_cancel_so', id: openSo.id, number: openSo.number, processingFees: openSo.processingFees || null });
  plan.push({ key: 'refund', type: 'refund', orderId: o.id, amount: refundAmount, currency: o.currency || 'CAD',
    saleIds: sales.map((t) => t.id), recheckShipmentIds: liveLabels.map((l) => l.shipmentId),
    ...(asBefore ? { note: 'amount from the order total (the real refund already exists, so Shopify cannot preview it now)' } : {}) });

  const what = [
    liveLabels.length ? `void ${liveLabels.length} label(s)` : null,
    opsLabels.length ? 'pull it from the buy queue' : null,
    pk.kind === 'branch' ? 'mark the pickup cancelled' : null,
    branchTold && branch ? `email Kaitlyn + ${branch.email} to ${liveLabels.length ? 'pull the box for' : 'cancel'} ${poNumbers.join(', ')}` : null,
    liveFulfillments.length ? `cancel ${liveFulfillments.length} Shopify fulfillment(s)` : null,
    (ss.orders || []).some((y) => y.orderStatus !== 'cancelled') ? 'take it out of ShipStation' : null,
    pos.length || openSo ? `cancel ${[...pos.map((p) => p.number), ...(openSo ? [openSo.number] : [])].join(' + ')} in Automayt` : null,
    `refund ${money(refundAmount)} in full`,
  ].filter(Boolean).join(', ');
  return { eligible: holds.length === 0, holds, plan, summary: `${o.name} ${money(o.total)}: ${what}`, order: { name: o.name, total: Number(o.total), firstName: o.firstName || '', email: o.email } };
}

// ── IO: read-only facts ─────────────────────────────────────────────────────────────────────────────────────────

const ORDER_FIELDS = `id legacyResourceId name email createdAt cancelledAt closed displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName } shippingAddress { firstName } billingAddress { firstName }
  lineItems(first: 50) { nodes { id refundableQuantity } }
  transactions { id kind status gateway amountSet { shopMoney { amount } } }
  fulfillments { id status displayStatus inTransitAt deliveredAt trackingInfo { number company } fulfillmentOrders(first: 5) { nodes { deliveryMethod { methodType } } } }
  fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType } assignedLocation { location { id } } } }
  refunds { id }`;

function shapeOrder(n) {
  return {
    id: n.id, legacyId: String(n.legacyResourceId), name: n.name, email: n.email, createdAt: n.createdAt, cancelledAt: n.cancelledAt, closed: n.closed,
    financial: n.displayFinancialStatus, fulfillmentStatus: n.displayFulfillmentStatus,
    total: n.totalPriceSet.shopMoney.amount, currency: n.totalPriceSet.shopMoney.currencyCode,
    firstName: (n.customer && n.customer.firstName) || (n.shippingAddress && n.shippingAddress.firstName) || (n.billingAddress && n.billingAddress.firstName) || '',
    lineItems: n.lineItems.nodes,
    fulfillments: (n.fulfillments || []).map((x) => ({ id: x.id, status: x.status, displayStatus: x.displayStatus || null, inTransitAt: x.inTransitAt || null, deliveredAt: x.deliveredAt || null,
      tracking: (x.trackingInfo || []).map((t) => t.number).filter(Boolean),
      methods: ((x.fulfillmentOrders && x.fulfillmentOrders.nodes) || []).map((fo) => fo.deliveryMethod && fo.deliveryMethod.methodType).filter(Boolean) })),
    fulfillmentOrders: n.fulfillmentOrders.nodes.map((x) => ({ id: x.id, status: x.status, method: x.deliveryMethod && x.deliveryMethod.methodType, locationId: x.assignedLocation && x.assignedLocation.location && x.assignedLocation.location.id })),
    transactions: n.transactions.map((t) => ({ id: t.id, kind: t.kind, status: t.status, gateway: t.gateway, amount: t.amountSet.shopMoney.amount })),
    refundCount: (n.refunds || []).length,
  };
}

function ymdBack(days, now = new Date()) {
  const out = [];
  for (let i = 0; i <= days; i++) out.push(new Date(now.getTime() - i * 864e5).toISOString().slice(0, 10));
  return out;
}

/** Ops-state rows for these ShipStation order ids (or this order number) over the last two weeks. */
function opsStateFor(ssOrderIds, orderNumber, { dir = OPS_DIR, now = new Date() } = {}) {
  const labels = [], emailed = [];
  const ids = new Set(ssOrderIds.map(String));
  for (const date of ymdBack(OPS_LOOKBACK_DAYS, now)) {
    const file = path.join(dir, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    let s; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { labels.push({ date, error: `${date}.json: ${e.message}` }); continue; }
    const buy = (s.phases && s.phases.buy && s.phases.buy.labels) || {};
    for (const [key, l] of Object.entries(buy)) {
      if (!ids.has(String(key)) && String(l.orderNumber) !== String(orderNumber)) continue;
      const packages = (l.packages && l.packages.length ? l.packages : [{ shipmentId: l.shipmentId, trackingNumber: l.trackingNumber }])
        .filter((p) => p.shipmentId).map((p) => ({ shipmentId: Number(p.shipmentId), trackingNumber: p.trackingNumber || null }));
      if (l.shipmentId && !packages.some((p) => p.shipmentId === Number(l.shipmentId))) packages.unshift({ shipmentId: Number(l.shipmentId), trackingNumber: l.trackingNumber || null });
      labels.push({ date, ssOrderId: key, packages, shipmentIds: packages.map((p) => p.shipmentId), trackingNumber: l.trackingNumber, warehouseId: l.warehouseId, carrierCode: l.carrierCode });
      ids.add(String(key));
    }
    const byOrder = (s.phases && s.phases.email && s.phases.email.byOrder) || {};
    for (const [key, e] of Object.entries(byOrder)) if (ids.has(String(key))) emailed.push({ date, ssOrderId: key, warehouse: e.warehouse, at: e.at });
  }
  return { labels, emailed };
}

async function trackOf(ssV2, shipmentId) {
  const t = await ssV2('GET', `/v2/labels/se-${shipmentId}/track`);
  if (t.status !== 200) throw new Error(`track HTTP ${t.status}`);
  return JSON.parse(t.body);
}

/**
 * deps: { gql(q, v) -> data, ssV1(method, path, body) -> {status, body}, ssV2(method, path) -> {status, body},
 *         erp, am, pickupRunner, branches, opsDir, erpBackend, now }
 */
async function gather({ orderNumbers = [], sender }, deps) {
  const facts = { sender, lookup: { numbers: [...new Set(orderNumbers.map(orderNum).filter(Boolean))] }, branches: deps.branches };
  // Shopify
  try {
    if (facts.lookup.numbers.length === 1) {
      const d = await deps.gql(`query($q: String!) { orders(first: 5, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:#${facts.lookup.numbers[0]}` });
      const hit = d.orders.nodes.find((n) => orderNum(n.name) === facts.lookup.numbers[0]);
      if (hit) facts.order = shapeOrder(hit);
    } else if (!facts.lookup.numbers.length && sender) {
      const d = await deps.gql(`query($q: String!) { orders(first: 20, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`, { q: `email:${JSON.stringify(sender)}` });
      const mine = d.orders.nodes.filter((n) => String(n.email || '').toLowerCase() === String(sender).toLowerCase()).map(shapeOrder);
      const since = (deps.now ? deps.now.getTime() : Date.now()) - RECENT_DAYS * 864e5;
      // A bought label fulfils and archives the order, so "open" = recent, not cancelled, not refunded, not delivered.
      facts.lookup.openOrders = mine.filter((x) => !x.cancelledAt && !x.refundCount && Date.parse(x.createdAt) >= since
        && !x.fulfillments.some((fl) => fl.deliveredAt)).map((x) => x.name);
      if (facts.lookup.openOrders.length === 1) facts.order = mine.find((x) => x.name === facts.lookup.openOrders[0]);
    }
  } catch (e) { facts.lookup.error = e.message; }
  const o = facts.order;
  if (!o) return facts;
  const num = orderNum(o.name);

  // ShipStation: orders under this number that belong to this Shopify order, their labels and tracking
  facts.shipstation = { orders: [], labels: [] };
  try {
    const r = await deps.ssV1('GET', `/orders?orderNumber=${encodeURIComponent(num)}`);
    if (r.status !== 200) throw new Error(`orders list HTTP ${r.status}`);
    const all = JSON.parse(r.body).orders || [];
    facts.shipstation.orders = all.filter((x) => String(x.orderKey || '').split('-')[0] === o.legacyId)
      .map((x) => ({ orderId: x.orderId, orderNumber: x.orderNumber, orderStatus: x.orderStatus, warehouseId: x.advancedOptions && x.advancedOptions.warehouseId }));
  } catch (e) { facts.shipstation.error = e.message; }
  facts.opsState = opsStateFor(facts.shipstation.orders.map((x) => x.orderId), num, { dir: deps.opsDir || OPS_DIR, now: deps.now });
  try {
    const labels = new Map();
    for (const so of facts.shipstation.orders) {
      const r = await deps.ssV1('GET', `/shipments?orderId=${so.orderId}&includeShipmentItems=false`);
      if (r.status !== 200) throw new Error(`shipments HTTP ${r.status}`);
      for (const s of JSON.parse(r.body).shipments || []) labels.set(Number(s.shipmentId), { shipmentId: Number(s.shipmentId), trackingNumber: s.trackingNumber, voided: !!s.voided, carrierCode: s.carrierCode || null, warehouseId: s.warehouseId || so.warehouseId || null });
    }
    // Labels bought through V2 do not show in the V1 shipments list (#1443, #1432): ops-state carries every package.
    for (const l of facts.opsState.labels) for (const p of l.packages || []) {
      if (!labels.has(p.shipmentId)) labels.set(p.shipmentId, { shipmentId: p.shipmentId, trackingNumber: p.trackingNumber || null, voided: null, carrierCode: l.carrierCode || null, warehouseId: l.warehouseId || null });
      else { const x = labels.get(p.shipmentId); x.warehouseId = x.warehouseId || l.warehouseId || null; x.carrierCode = x.carrierCode || l.carrierCode || null; }
    }
    for (const lab of labels.values()) {
      if (lab.voided === null) { // known only from ops-state: ask ShipStation whether it is voided
        const r = await deps.ssV2('GET', `/v2/labels/se-${lab.shipmentId}`);
        if (r.status !== 200) throw new Error(`label se-${lab.shipmentId} HTTP ${r.status}`);
        const j = JSON.parse(r.body); lab.voided = j.status === 'voided' || !!j.voided; lab.trackingNumber = lab.trackingNumber || j.tracking_number || null;
      }
      if (!lab.voided) {
        try {
          const j = await trackOf(deps.ssV2, lab.shipmentId);
          lab.trackStatus = j.status_code || null; lab.unmoved = labelUnmoved(j);
          lab.events = (j.events || []).map((e) => `${e.status_code || ''} ${e.description || ''}`.trim()).slice(0, 6);
        } catch (e) { lab.trackError = e.message; }
      }
      facts.shipstation.labels.push(lab);
    }
  } catch (e) { facts.shipstation.error = facts.shipstation.error || e.message; }

  // Pickup runner record and kind
  facts.pickup = {};
  try {
    const state = deps.pickupRunner.loadState();
    facts.pickup.rec = (state.orders || {})[o.name] || null;
    const full = await deps.pickupRunner.fetchOrder(deps.gql, o.id);
    const c = full ? deps.pickupRunner.classify(full, deps.branches) : { kind: null };
    facts.pickup.kind = (facts.pickup.rec && facts.pickup.rec.kind) || c.kind || null;
    facts.pickup.branch = (facts.pickup.rec && facts.pickup.rec.branch) || c.branch || null;
    if (c.reason) facts.pickup.reason = c.reason;
  } catch (e) { facts.pickup.error = e.message; }

  // Automayt
  facts.erp = { pos: [] };
  try {
    if (deps.erpBackend !== 'automayt') throw new Error(`ERP_BACKEND is ${deps.erpBackend || 'unset'}, not automayt`);
    const so = await deps.erp.findSalesOrder('shopify', num);
    if (so) facts.erp.so = { id: so.id, number: so.number, status: so.status, processingFees: so.processing_fees || null };
    const ids = new Set(((so && so.purchase_orders) || []).map((p) => p.id));
    const pickupPo = facts.pickup.rec && facts.pickup.rec.poNumber;
    if (pickupPo) {
      const { data } = await deps.am.get('/purchase-orders', { number: pickupPo });
      for (const p of (data && (data.data || data)) || []) if (p.number === pickupPo) ids.add(p.id);
    }
    for (const id of ids) {
      const { data: p } = await deps.am.get(`/purchase-orders/${id}`);
      facts.erp.pos.push({ id: p.id, number: p.number, status: p.status, vendorRef: p.vendor_ref || null, qtyReceived: Number((p.receipt_summary && p.receipt_summary.qty_received) || 0) });
    }
  } catch (e) { facts.erp.error = e.message; }

  // Refund preview (read-only, amount only): every refundable line + shipping. NO_RESTOCK here because fulfilled lines
  // cannot be previewed as CANCEL; the executor recomputes with CANCEL once the fulfillments are cancelled.
  facts.refund = {};
  try {
    const li = o.lineItems.filter((l) => l.refundableQuantity > 0);
    if (!li.length) throw new Error('no refundable line items');
    const lineItems = li.map((l) => ({ lineItemId: l.id, quantity: l.refundableQuantity, restockType: 'NO_RESTOCK' }));
    const d = await deps.gql(`query($id: ID!, $li: [RefundLineItemInput!]) { order(id: $id) { suggestedRefund(refundLineItems: $li, refundShipping: true) {
      amountSet { shopMoney { amount } } suggestedTransactions { gateway amountSet { shopMoney { amount } } parentTransaction { id } } } } }`, { id: o.id, li: lineItems });
    const sr = d.order.suggestedRefund;
    facts.refund = { amount: sr.amountSet.shopMoney.amount,
      transactions: sr.suggestedTransactions.map((t) => ({ parentId: t.parentTransaction && t.parentTransaction.id, amount: t.amountSet.shopMoney.amount, gateway: t.gateway })) };
  } catch (e) { facts.refund = { error: e.message }; }
  return facts;
}

// ── IO: writes ──────────────────────────────────────────────────────────────────────────────────────────────────

function journalPath(orderName) { return path.join(JOURNAL_DIR, `${orderNum(orderName)}.json`); }
function loadJournal(orderName) { try { return JSON.parse(fs.readFileSync(journalPath(orderName), 'utf8')); } catch { return { order: orderName, done: {}, runs: [] }; } }
function saveJournal(j) { fs.mkdirSync(JOURNAL_DIR, { recursive: true }); fs.writeFileSync(journalPath(j.order), JSON.stringify(j, null, 1)); }

const REFUND_STATE_Q = `query($id: ID!) { order(id: $id) { cancelledAt displayFulfillmentStatus refunds { id } transactions { kind status }
  fulfillments { id status } lineItems(first: 50) { nodes { id refundableQuantity } }
  fulfillmentOrders(first: 10) { nodes { status assignedLocation { location { id } } } } } }`;

/** Builds the refund fresh, after the fulfillments are cancelled: unfulfilled lines restocked CANCEL at their location. */
async function buildRefund(s, gql) {
  const d = (await gql(REFUND_STATE_Q, { id: s.orderId })).order;
  if (d.cancelledAt || d.refunds.length || d.transactions.some((t) => t.kind === 'REFUND')) throw new Error('a refund or cancel appeared on the order since the check; not refunding');
  const live = d.fulfillments.filter((x) => !['CANCELLED', 'ERROR', 'FAILURE'].includes(String(x.status).toUpperCase()));
  if (live.length || !['UNFULFILLED', 'OPEN'].includes(d.displayFulfillmentStatus)) throw new Error(`order still reads ${d.displayFulfillmentStatus} with ${live.length} live fulfillment(s); not refunding`);
  const withLoc = d.fulfillmentOrders.nodes.filter((x) => x.assignedLocation && x.assignedLocation.location);
  const fo = withLoc.find((x) => x.status === 'OPEN') || withLoc.find((x) => ['IN_PROGRESS', 'SCHEDULED', 'ON_HOLD'].includes(x.status));
  if (!fo) throw new Error(`no open fulfillment order to restock to (${d.fulfillmentOrders.nodes.map((x) => x.status).join(', ') || 'none'})`);
  const locationId = fo.assignedLocation.location.id;
  const refundLineItems = d.lineItems.nodes.filter((l) => l.refundableQuantity > 0).map((l) => ({ lineItemId: l.id, quantity: l.refundableQuantity, restockType: 'CANCEL', locationId }));
  if (!refundLineItems.length) throw new Error('no refundable line items');
  const sr = (await gql(`query($id: ID!, $li: [RefundLineItemInput!]) { order(id: $id) { suggestedRefund(refundLineItems: $li, refundShipping: true) {
    amountSet { shopMoney { amount } } suggestedTransactions { gateway amountSet { shopMoney { amount } } parentTransaction { id } } } } }`, { id: s.orderId, li: refundLineItems })).order.suggestedRefund;
  if (cents(sr.amountSet.shopMoney.amount) !== cents(s.amount)) throw new Error(`Shopify now suggests ${money(sr.amountSet.shopMoney.amount)}, planned ${money(s.amount)}; not refunding`);
  const txs = sr.suggestedTransactions.map((t) => ({ parentId: t.parentTransaction && t.parentTransaction.id, amount: t.amountSet.shopMoney.amount, gateway: t.gateway }));
  if (!txs.length || txs.some((t) => !t.parentId || !(s.saleIds || []).includes(t.parentId))) throw new Error('suggested refund is not against the original payment; not refunding');
  if (cents(txs.reduce((a, t) => a + Number(t.amount), 0)) !== cents(s.amount)) throw new Error('suggested refund transactions do not add up; not refunding');
  return { refundLineItems, transactions: txs, locationId };
}

/**
 * Runs the plan in order. Stops at the first error. Returns { ok, done: [step keys done this run or before],
 * failed: { key, error } | null, refundId }.
 * deps adds: ssCancelOrder(id), ssGetOrder(id) -> order | null (404), ssCreateOrder(order), emailer.sendEmail,
 * audit.log, pickupRunner.saveState, settleMs.
 */
async function execute(evaluation, ctx, deps) {
  const { requestNote, requestedAt } = ctx;
  const name = evaluation.order.name;
  const j = loadJournal(name);
  j.runs.push({ at: new Date().toISOString(), plan: evaluation.plan.map((s) => s.key) });
  const done = [];
  const settle = () => new Promise((r) => setTimeout(r, deps.settleMs == null ? 2500 : deps.settleMs));
  const mark = (key, info) => { j.done[key] = { at: new Date().toISOString(), ...(info || {}) }; done.push(key); saveJournal(j); deps.audit.log({ action: 'order-autocancel', order: name, step: key, ...(info || {}) }); };
  const scanCheck = async (shipmentId, when) => {
    const t = await trackOf(deps.ssV2, shipmentId);
    if (!labelUnmoved(t)) throw new Error(`label se-${shipmentId} has a carrier scan ${when} (${t.status_code || '?'}: ${((t.events || [])[0] || {}).description || ''}); stopped`);
  };
  for (const s of evaluation.plan) {
    if (j.done[s.key]) { done.push(s.key); continue; }
    try {
      if (s.type === 'void_label') {
        await scanCheck(s.shipmentId, 'just before the void');
        const r = await deps.ssV1('POST', '/shipments/voidlabel', { shipmentId: s.shipmentId });
        const b = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
        if (r.status !== 200 || b.approved !== true) throw new Error(`void ${s.shipmentId}: HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
        mark(s.key, { tracking: s.trackingNumber });
      } else if (s.type === 'ops_state_remove') {
        const file = path.join(deps.opsDir || OPS_DIR, `${s.date}.json`);
        const raw = fs.readFileSync(file, 'utf8');
        const bdir = path.join(JOURNAL_DIR, 'backups'); fs.mkdirSync(bdir, { recursive: true });
        const backup = path.join(bdir, `${s.date}.json.${Date.now()}.bak`);
        fs.writeFileSync(backup, raw);
        const st = JSON.parse(raw);
        delete st.phases.buy.labels[s.ssOrderId];
        fs.writeFileSync(file, JSON.stringify(st, null, 2));
        const check = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (check.phases.buy.labels[s.ssOrderId]) throw new Error(`ops-state ${s.date} still lists ${s.ssOrderId}`);
        mark(s.key, { backup });
      } else if (s.type === 'pickup_cancel') {
        const state = deps.pickupRunner.loadState();
        state.orders = state.orders || {};
        const rec = state.orders[s.name] || (state.orders[s.name] = { ...s.rec, firstSeenAt: new Date().toISOString(), done: {} });
        rec.status = 'CANCELLED'; rec.cancelledAutoAt = new Date().toISOString();
        rec.cancelNote = `Customer asked to cancel by email ${requestedAt || ''}; auto-cancelled by the YF desk (refund, order left open).`.replace('  ', ' ');
        deps.pickupRunner.saveState(state);
        mark(s.key);
      } else if (s.type === 'branch_email') {
        const r = await deps.emailer.sendEmail({ to: s.to.join(', '), cc: s.cc, subject: s.subject, text: s.text });
        if (r && r.rejected && r.rejected.length) throw new Error(`branch email rejected for ${r.rejected.join(', ')}`);
        mark(s.key, { to: s.to, subject: s.subject });
      } else if (s.type === 'order_open') {
        const r = await deps.gql(`mutation($input: OrderOpenInput!) { orderOpen(input: $input) { order { id closed } userErrors { field message } } }`, { input: { id: s.orderId } });
        const res = r.orderOpen;
        if (res.userErrors && res.userErrors.length) throw new Error('orderOpen: ' + res.userErrors.map((e) => e.message).join('; '));
        mark(s.key);
      } else if (s.type === 'fulfillment_cancel') {
        const cur = (await deps.gql(`query($id: ID!) { fulfillment(id: $id) { id status } }`, { id: s.fulfillmentId })).fulfillment;
        if (!cur) throw new Error(`fulfillment ${s.fulfillmentId} not found`);
        if (String(cur.status).toUpperCase() !== 'CANCELLED') {
          const r = await deps.gql(`mutation($id: ID!) { fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } } }`, { id: s.fulfillmentId });
          const res = r.fulfillmentCancel;
          if (res.userErrors && res.userErrors.length) throw new Error('fulfillmentCancel: ' + res.userErrors.map((e) => e.message).join('; '));
          if (!res.fulfillment || String(res.fulfillment.status).toUpperCase() !== 'CANCELLED') throw new Error(`fulfillment ${s.fulfillmentId} reads ${res.fulfillment && res.fulfillment.status} after the cancel`);
        }
        mark(s.key, { tracking: s.tracking });
      } else if (s.type === 'ss_remove') {
        let so = await deps.ssGetOrder(s.orderId);
        if (so && so.orderStatus !== 'cancelled') {
          await deps.ssCancelOrder(s.orderId).catch(() => {}); // DELETE soft-deletes; a shipped order may refuse it
          await settle();
          so = await deps.ssGetOrder(s.orderId);
        }
        if (so && so.orderStatus !== 'cancelled') { // fallback: the createorder route with status cancelled
          await deps.ssCreateOrder({ ...so, orderStatus: 'cancelled' });
          await settle();
          so = await deps.ssGetOrder(s.orderId);
        }
        if (so && so.orderStatus !== 'cancelled') throw new Error(`ShipStation order ${s.orderId} still ${so.orderStatus}`);
        mark(s.key, { result: so ? 'cancelled' : 'removed' });
      } else if (s.type === 'erp_cancel_po') {
        await deps.erp.cancelPurchaseOrder(s.id, { reason: 'Customer cancelled', note: `Customer asked to cancel ${name} by email; auto-cancelled by the YF desk.` }, `autocancel-${orderNum(name)}-po-${s.id}`);
        mark(s.key, { po: s.number });
      } else if (s.type === 'erp_cancel_so') {
        const fee = Number(s.processingFees) > 0 ? `; Shopify kept its ${Number(s.processingFees).toFixed(2)} processing fee` : '';
        await deps.erp.cancelSalesOrder(s.id, `Customer cancelled by email, Shopify ${name} refunded in full (${money(evaluation.order.total)})${fee}`, `autocancel-${orderNum(name)}-so-${s.id}`);
        mark(s.key, { so: s.number });
      } else if (s.type === 'refund') {
        // Last guards before money moves: no scan on any of our labels, no refund on the order, fulfillments gone.
        for (const id of s.recheckShipmentIds || []) await scanCheck(id, 'before the refund');
        const b = await buildRefund(s, deps.gql);
        const r = await deps.gql(`mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id } userErrors { field message } } }`, { input: {
          orderId: s.orderId, notify: false,
          note: `Customer asked to cancel by email ${requestedAt || ''}: "${String(requestNote || '').replace(/\s+/g, ' ').slice(0, 200)}". Auto-cancelled by the YF desk; refunded in full, order left open (accounting rule).`,
          refundLineItems: b.refundLineItems, shipping: { fullRefund: true },
          transactions: b.transactions.map((t) => ({ orderId: s.orderId, parentId: t.parentId, amount: t.amount, gateway: t.gateway, kind: 'REFUND' })),
        } });
        const res = r.refundCreate;
        if (res.userErrors && res.userErrors.length) throw new Error('refundCreate: ' + res.userErrors.map((e) => e.message).join('; '));
        mark(s.key, { refundId: res.refund.id, amount: s.amount });
      } else throw new Error(`unknown step ${s.type}`);
    } catch (e) {
      j.runs[j.runs.length - 1].failed = { key: s.key, error: e.message };
      saveJournal(j);
      deps.audit.log({ action: 'order-autocancel', order: name, step: s.key, error: e.message });
      return { ok: false, done, failed: { key: s.key, error: e.message }, journal: journalPath(name) };
    }
  }
  // Re-assert the stops in case a concurrent writer (pickup runner tick, pipeline pass) clobbered them.
  for (const s of evaluation.plan) {
    if (s.type === 'pickup_cancel') {
      const state = deps.pickupRunner.loadState();
      const rec = (state.orders || {})[s.name];
      if (rec && rec.status !== 'CANCELLED') { rec.status = 'CANCELLED'; deps.pickupRunner.saveState(state); deps.audit.log({ action: 'order-autocancel', order: name, step: 'pickup_cancel', note: 're-applied after a concurrent write' }); }
    }
    if (s.type === 'ops_state_remove') {
      const file = path.join(deps.opsDir || OPS_DIR, `${s.date}.json`);
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (st.phases.buy.labels[s.ssOrderId]) { delete st.phases.buy.labels[s.ssOrderId]; fs.writeFileSync(file, JSON.stringify(st, null, 2)); deps.audit.log({ action: 'order-autocancel', order: name, step: s.key, note: 're-applied after a concurrent write' }); }
    }
  }
  j.completedAt = new Date().toISOString(); saveJournal(j);
  return { ok: true, done, failed: null, refundId: (j.done.refund || {}).refundId || null, journal: journalPath(name) };
}

module.exports = { MAX_TOTAL, labelUnmoved, branchCodeOf, branchEmail, carrierName, evaluate, gather, execute, buildRefund, opsStateFor, shapeOrder, journalPath, loadJournal };
