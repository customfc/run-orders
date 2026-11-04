'use strict';
/**
 * Customer-requested cancel of a YourFloors Shopify order, run by the hello@ ticket desk
 * (yourfloors-cs/desk.js, DESK_AUTOCANCEL_LIVE) through scripts/ops/order-autocancel.js.
 *
 * Rules Mac approved 2026-11-04 (after #1444 Jesse Morwood sat held while Mac missed the approval email):
 *   auto only when ONE Shopify order is identified, the sender is the order's email, it is PAID, not cancelled,
 *   not refunded (a PENDING refund counts), total <= $500, and nothing physically moved (no Shopify fulfillment,
 *   no carrier scan on any label: only "electronically submitted" events count as unmoved, pickup not collected).
 *   Anything else, or any doubt, is a hold for Mac.
 * Order of operations (goods first, money last, so a failed refund never leaves a refunded order in the buy queue):
 *   void each live label, pull it from ops-state (backed up), take the order out of ShipStation,
 *   mark the pickup CANCELLED, email Kaitlyn + the branch order desk when the branch was already told,
 *   cancel the Automayt PO(s) and SO, then refund in full with refundCreate (order left OPEN, notify false).
 *
 * evaluate() is pure (tests: lib/order-autocancel.test.js). gather() only reads. execute() writes, step by step,
 * with a journal (data/order-autocancel/<n>.json) so a re-run never repeats a done step.
 */

const fs = require('fs');
const path = require('path');

const MAX_TOTAL = 500;
const KAITLYN = () => process.env.KAITLYN_EMAIL || 'KLazzarotto@prosol.ca';
const MAC_CC = () => process.env.MAC_CC_EMAIL || 'mac@customfc.ca';
const DATA = path.join(__dirname, '..', 'data');
const JOURNAL_DIR = path.join(DATA, 'order-autocancel');
const OPS_DIR = path.join(DATA, 'ops-state');
const OPS_LOOKBACK_DAYS = 14;
const MOVED_CODES = new Set(['IT', 'AT', 'DE', 'EX', 'SP']);

const money = (n) => `$${Number(n).toFixed(2)}`;
const cents = (n) => Math.round(Number(n) * 100);
const orderNum = (name) => String(name || '').replace(/[^0-9]/g, '');

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A label is unmoved only when the carrier has nothing but an electronic submission on it. Anything else, an
 * unknown shape included, counts as moved (fail closed).
 */
function labelUnmoved(track) {
  if (!track || typeof track !== 'object') return false;
  const status = String(track.status_code || '').toUpperCase();
  if (MOVED_CODES.has(status)) return false;
  const events = Array.isArray(track.events) ? track.events : [];
  return events.every((e) => /electronic/i.test(`${e.description || ''} ${e.carrier_status_description || ''}`) && !MOVED_CODES.has(String(e.status_code || '').toUpperCase()));
}

/** "Burnaby (BURN)" -> "BURN" */
function branchCodeOf(warehouseName) {
  const m = /\(([A-Z]{3,5})\)\s*$/.exec(String(warehouseName || ''));
  return m ? m[1] : null;
}

function branchEmail({ orderName, poNumbers, vendorRefs, branch, voidedTracking, firstName }) {
  const pos = poNumbers.join(' and ');
  const yours = vendorRefs.length ? ` (your order ${vendorRefs.join(', ')})` : '';
  const label = voidedTracking.length ? ` The shipping label on it (${voidedTracking.join(', ')}) has been voided, so please don't send it out.` : '';
  const text = [
    `Hi Kaitlyn and ${branch.label} team,`,
    '',
    `Please cancel ${pos}${yours}, YourFloors order ${orderName}. The customer won't need it.${label} If it has already been pulled, it can go back to stock.`,
    '',
    'Please reply to confirm.',
    '',
    'Thanks,',
    'Mac',
  ].join('\n');
  return { to: [KAITLYN(), branch.email], cc: MAC_CC(), subject: `Please cancel ${pos} (YourFloors ${orderName})`, text, firstName };
}

/**
 * facts: see gather(). opts.ignoreCancelState: dry-run harness only (what would it have done before the order was
 * cancelled by hand): refunds, a CANCELLED pickup record and cancelled ERP records are read as their earlier state.
 * Returns { eligible, holds: [why...], plan: [step...], summary }.
 */
function evaluate(facts, opts = {}) {
  const asBefore = !!opts.ignoreCancelState;
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

  // 3. nothing physically moved
  const liveFulfillments = (o.fulfillments || []).filter((x) => !['CANCELLED', 'ERROR', 'FAILURE'].includes(String(x.status || '').toUpperCase()));
  if (liveFulfillments.length) hold(`order has ${liveFulfillments.length} fulfillment(s) in Shopify (shipped or picked up)`);
  if (o.fulfillmentStatus && !['UNFULFILLED', 'SCHEDULED', 'ON_HOLD', 'IN_PROGRESS', 'PENDING_FULFILLMENT', 'OPEN'].includes(o.fulfillmentStatus)) hold(`fulfillment status is ${o.fulfillmentStatus}`);

  const ss = f.shipstation || {};
  if (ss.error) hold(`ShipStation check failed: ${ss.error}`);
  for (const so of ss.orders || []) if (so.orderStatus === 'shipped') hold(`ShipStation order ${so.orderId} is marked shipped`);
  const liveLabels = (ss.labels || []).filter((l) => !l.voided);
  for (const l of liveLabels) {
    if (l.trackError) hold(`could not read tracking for label ${l.trackingNumber || l.shipmentId}: ${l.trackError}`);
    else if (!l.unmoved) hold(`label ${l.trackingNumber || l.shipmentId} has a carrier scan (${l.trackStatus || 'moved'})`);
  }

  // 4. pickups
  const pk = f.pickup || {};
  if (pk.error) hold(`pickup check failed: ${pk.error}`);
  if (pk.kind && pk.kind !== 'branch') hold(`it is a ${pk.kind} pickup${pk.reason ? ` (${pk.reason})` : ''}; only Prosol counter pickups are automatic`);
  const rec = pk.rec || null;
  let recStatus = rec ? rec.status : null;
  if (asBefore && recStatus === 'CANCELLED') recStatus = rec.poSentAt ? 'PO_SENT' : 'NEW';
  if (rec && ['PICKED_UP', 'DONE', 'REFUNDED'].includes(recStatus)) hold(`pickup is ${recStatus}`);
  if (rec && recStatus === 'CANCELLED') hold('pickup is already marked CANCELLED (handled by hand)');
  if (rec && rec.pickedUpAt) hold(`pickup was collected ${String(rec.pickedUpAt).slice(0, 10)}`);

  // 5. ERP
  const erp = f.erp || {};
  if (erp.error) hold(`Automayt check failed: ${erp.error}`);
  const openSo = erp.so && (asBefore || erp.so.status !== 'cancelled') ? erp.so : null;
  const pos = (erp.pos || []).filter((p) => asBefore || p.status !== 'cancelled');
  for (const p of pos) if (Number(p.qtyReceived || 0) > 0) hold(`${p.number} shows ${p.qtyReceived} received`);

  // 6. was the branch told?
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

  // 7. refund maths
  const r = f.refund || {};
  let refundAmount = Number(o.total);
  if (!asBefore) {
    if (r.error) hold(`refund preview failed: ${r.error}`);
    else {
      if (cents(r.amount) !== cents(o.total)) hold(`Shopify suggests refunding ${money(r.amount || 0)}, not the full ${money(o.total)}`);
      const saleIds = new Set(sales.map((t) => t.id));
      if (!(r.transactions || []).length || (r.transactions || []).some((t) => !t.parentId || !saleIds.has(t.parentId))) hold('the suggested refund is not against the original payment');
      if (cents((r.transactions || []).reduce((a, t) => a + Number(t.amount), 0)) !== cents(o.total)) hold('the suggested refund transactions do not add up to the order total');
      if (!r.locationId) hold('no fulfillment location to restock to');
      refundAmount = Number(r.amount);
    }
  }

  // ── plan, in order: goods first, money last ──
  const voidedTracking = [];
  for (const l of liveLabels) { plan.push({ key: `void:${l.shipmentId}`, type: 'void_label', shipmentId: l.shipmentId, trackingNumber: l.trackingNumber || null }); voidedTracking.push(l.trackingNumber || String(l.shipmentId)); }
  for (const x of opsLabels.filter((y) => !y.error)) plan.push({ key: `ops:${x.date}:${x.ssOrderId}`, type: 'ops_state_remove', date: x.date, ssOrderId: x.ssOrderId });
  for (const so of (ss.orders || []).filter((y) => y.orderStatus !== 'cancelled')) plan.push({ key: `ss:${so.orderId}`, type: 'ss_remove', orderId: so.orderId, orderNumber: so.orderNumber });
  if (pk.kind === 'branch') plan.push({ key: 'pickup', type: 'pickup_cancel', name: o.name, create: !rec, rec: rec ? null : { id: o.id, kind: 'branch', branch: pk.branch || null } });
  if (branchTold && branch && branch.email && poNumbers.length) {
    plan.push({ key: 'branch_email', type: 'branch_email', branch: branch.code,
      ...branchEmail({ orderName: o.name, poNumbers, vendorRefs: pos.map((p) => p.vendorRef).filter(Boolean), branch, voidedTracking, firstName: o.firstName }) });
  }
  for (const p of pos) plan.push({ key: `erp_po:${p.id}`, type: 'erp_cancel_po', id: p.id, number: p.number });
  if (openSo) plan.push({ key: `erp_so:${openSo.id}`, type: 'erp_cancel_so', id: openSo.id, number: openSo.number, processingFees: openSo.processingFees || null });
  plan.push({ key: 'refund', type: 'refund', orderId: o.id, amount: refundAmount, currency: o.currency || 'CAD',
    ...(asBefore ? { note: 'amount from the order total (the real refund already exists, so Shopify cannot preview it now)' } : { lineItems: r.lineItems, locationId: r.locationId, transactions: r.transactions }) });

  const what = [
    liveLabels.length ? `void ${liveLabels.length} label(s)` : null,
    opsLabels.length ? 'pull it from the buy queue' : null,
    (ss.orders || []).some((y) => y.orderStatus !== 'cancelled') ? 'take it out of ShipStation' : null,
    pk.kind === 'branch' ? 'mark the pickup cancelled' : null,
    branchTold && branch ? `email Kaitlyn + ${branch.email} to cancel ${poNumbers.join(', ')}` : null,
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
  fulfillments { id status }
  fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType } assignedLocation { location { id } } } }
  refunds { id }`;

function shapeOrder(n) {
  return {
    id: n.id, legacyId: String(n.legacyResourceId), name: n.name, email: n.email, createdAt: n.createdAt, cancelledAt: n.cancelledAt, closed: n.closed,
    financial: n.displayFinancialStatus, fulfillmentStatus: n.displayFulfillmentStatus,
    total: n.totalPriceSet.shopMoney.amount, currency: n.totalPriceSet.shopMoney.currencyCode,
    firstName: (n.customer && n.customer.firstName) || (n.shippingAddress && n.shippingAddress.firstName) || (n.billingAddress && n.billingAddress.firstName) || '',
    lineItems: n.lineItems.nodes, fulfillments: n.fulfillments || [],
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
      labels.push({ date, ssOrderId: key, shipmentIds: [l.shipmentId, ...((l.packages || []).map((p) => p.shipmentId))].filter(Boolean).map(Number), trackingNumber: l.trackingNumber, warehouseId: l.warehouseId });
      ids.add(String(key));
    }
    const byOrder = (s.phases && s.phases.email && s.phases.email.byOrder) || {};
    for (const [key, e] of Object.entries(byOrder)) if (ids.has(String(key))) emailed.push({ date, ssOrderId: key, warehouse: e.warehouse, at: e.at });
  }
  return { labels, emailed };
}

/**
 * deps: { gql(q, v) -> data, ssV1(method, path, body) -> {status, body}, ssV2(method, path) -> {status, body},
 *         erp, am, pickupRunner, branches, opsDir, erpBackend }
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
      facts.lookup.openOrders = mine.filter((x) => !x.cancelledAt && !x.closed && x.fulfillmentStatus !== 'FULFILLED').map((x) => x.name);
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
  facts.opsState = opsStateFor(facts.shipstation.orders.map((x) => x.orderId), num, { dir: deps.opsDir || OPS_DIR });
  try {
    const shipmentIds = new Map();
    for (const so of facts.shipstation.orders) {
      const r = await deps.ssV1('GET', `/shipments?orderId=${so.orderId}&includeShipmentItems=false`);
      if (r.status !== 200) throw new Error(`shipments HTTP ${r.status}`);
      for (const s of JSON.parse(r.body).shipments || []) shipmentIds.set(Number(s.shipmentId), { shipmentId: Number(s.shipmentId), trackingNumber: s.trackingNumber, voided: !!s.voided });
    }
    for (const l of facts.opsState.labels) for (const id of l.shipmentIds || []) if (!shipmentIds.has(id)) shipmentIds.set(id, { shipmentId: id, trackingNumber: l.trackingNumber, voided: null });
    for (const lab of shipmentIds.values()) {
      if (lab.voided === null) { // known only from ops-state: ask ShipStation whether it is voided
        const r = await deps.ssV2('GET', `/v2/labels/se-${lab.shipmentId}`);
        if (r.status === 200) { const j = JSON.parse(r.body); lab.voided = j.status === 'voided'; lab.trackingNumber = lab.trackingNumber || j.tracking_number; } else lab.voided = false;
      }
      if (!lab.voided) {
        try {
          const t = await deps.ssV2('GET', `/v2/labels/se-${lab.shipmentId}/track`);
          if (t.status !== 200) throw new Error(`track HTTP ${t.status}`);
          const j = JSON.parse(t.body);
          lab.trackStatus = j.status_code || null; lab.unmoved = labelUnmoved(j);
          lab.events = (j.events || []).map((e) => `${e.status_code || ''} ${e.description || ''}`.trim()).slice(0, 5);
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

  // Refund preview (read-only): every refundable line, restocked as CANCEL at its fulfillment location, plus shipping
  facts.refund = {};
  try {
    const li = o.lineItems.filter((l) => l.refundableQuantity > 0);
    const fo = o.fulfillmentOrders.find((x) => x.status === 'OPEN') || o.fulfillmentOrders.find((x) => x.locationId);
    const locationId = fo && fo.locationId;
    if (!li.length) throw new Error('no refundable line items');
    const lineItems = li.map((l) => ({ lineItemId: l.id, quantity: l.refundableQuantity, restockType: 'CANCEL', ...(locationId ? { locationId } : {}) }));
    const d = await deps.gql(`query($id: ID!, $li: [RefundLineItemInput!]) { order(id: $id) { suggestedRefund(refundLineItems: $li, refundShipping: true) {
      amountSet { shopMoney { amount } } suggestedTransactions { gateway amountSet { shopMoney { amount } } parentTransaction { id } } } } }`, { id: o.id, li: lineItems });
    const sr = d.order.suggestedRefund;
    facts.refund = { amount: sr.amountSet.shopMoney.amount, locationId, lineItems,
      transactions: sr.suggestedTransactions.map((t) => ({ parentId: t.parentTransaction && t.parentTransaction.id, amount: t.amountSet.shopMoney.amount, gateway: t.gateway })) };
  } catch (e) { facts.refund = { error: e.message }; }
  return facts;
}

// ── IO: writes ──────────────────────────────────────────────────────────────────────────────────────────────────

function journalPath(orderName) { return path.join(JOURNAL_DIR, `${orderNum(orderName)}.json`); }
function loadJournal(orderName) { try { return JSON.parse(fs.readFileSync(journalPath(orderName), 'utf8')); } catch { return { order: orderName, done: {}, runs: [] }; } }
function saveJournal(j) { fs.mkdirSync(JOURNAL_DIR, { recursive: true }); fs.writeFileSync(journalPath(j.order), JSON.stringify(j, null, 1)); }

/**
 * Runs the plan in order. Stops at the first error. Returns { ok, done: [step keys done this run or before],
 * failed: { key, error } | null, refundId }.
 * deps adds: ssCancelOrder(id), ssGetOrder(id) -> order | null (404), emailer.sendEmail, audit.log, pickupRunner.saveState.
 */
async function execute(evaluation, ctx, deps) {
  const { requestNote, requestedAt } = ctx;
  const name = evaluation.order.name;
  const j = loadJournal(name);
  j.runs.push({ at: new Date().toISOString(), plan: evaluation.plan.map((s) => s.key) });
  const done = [];
  const mark = (key, info) => { j.done[key] = { at: new Date().toISOString(), ...(info || {}) }; done.push(key); saveJournal(j); deps.audit.log({ action: 'order-autocancel', order: name, step: key, ...(info || {}) }); };
  for (const s of evaluation.plan) {
    if (j.done[s.key]) { done.push(s.key); continue; }
    try {
      if (s.type === 'void_label') {
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
      } else if (s.type === 'ss_remove') {
        await deps.ssCancelOrder(s.orderId);
        await new Promise((r) => setTimeout(r, deps.settleMs == null ? 2500 : deps.settleMs));
        const so = await deps.ssGetOrder(s.orderId);
        if (so && so.orderStatus !== 'cancelled') throw new Error(`ShipStation order ${s.orderId} still ${so.orderStatus}`);
        mark(s.key);
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
      } else if (s.type === 'erp_cancel_po') {
        await deps.erp.cancelPurchaseOrder(s.id, { reason: 'Customer cancelled', note: `Customer asked to cancel ${name} by email; auto-cancelled by the YF desk.` }, `autocancel-${orderNum(name)}-po-${s.id}`);
        mark(s.key, { po: s.number });
      } else if (s.type === 'erp_cancel_so') {
        const fee = Number(s.processingFees) > 0 ? `; Shopify kept its ${Number(s.processingFees).toFixed(2)} processing fee` : '';
        await deps.erp.cancelSalesOrder(s.id, `Customer cancelled by email, Shopify ${name} refunded in full (${money(evaluation.order.total)})${fee}`, `autocancel-${orderNum(name)}-so-${s.id}`);
        mark(s.key, { so: s.number });
      } else if (s.type === 'refund') {
        // Last guard before money moves: re-read, never refund twice.
        const d = await deps.gql(`query($id: ID!) { order(id: $id) { cancelledAt refunds { id } transactions { kind status } } }`, { id: s.orderId });
        if (d.order.cancelledAt || d.order.refunds.length || d.order.transactions.some((t) => t.kind === 'REFUND')) throw new Error('a refund or cancel appeared on the order since the check; not refunding');
        const r = await deps.gql(`mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id } userErrors { field message } } }`, { input: {
          orderId: s.orderId, notify: false,
          note: `Customer asked to cancel by email ${requestedAt || ''}: "${String(requestNote || '').replace(/\s+/g, ' ').slice(0, 200)}". Auto-cancelled by the YF desk; refunded in full, order left open (accounting rule).`,
          refundLineItems: s.lineItems, shipping: { fullRefund: true },
          transactions: s.transactions.map((t) => ({ orderId: s.orderId, parentId: t.parentId, amount: t.amount, gateway: t.gateway, kind: 'REFUND' })),
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

module.exports = { MAX_TOTAL, labelUnmoved, branchCodeOf, branchEmail, evaluate, gather, execute, opsStateFor, shapeOrder, journalPath, loadJournal };
