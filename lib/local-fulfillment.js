/**
 * Local fulfillment guard (01 task A1-A3, built 2026-10-01 when Mac turned on Coast pickup).
 *
 * A Shopify order the customer picks up (Sechelt Warehouse, Powell River) or that CFC's truck delivers must never get
 * a courier label or a Prosol PO from the pipeline. ShipStation imports those orders like any other, so before staging
 * a Shopify order we ask Shopify how it is delivered:
 *   - every open fulfillment order SHIPPING, no pickup marker  -> ship (pipeline as before)
 *   - PICK_UP                                                -> no label; Mac gets one email per order
 *   - LOCAL (local delivery)                                 -> no label; same email
 *   - SHIPPING with a pickup marker (texted cart: a "Pickup" shipping line, a pickup_location attribute or a pickup
 *     tag)                                                   -> treated as pickup
 *   - SHIPPING mixed with PICK_UP/LOCAL on one order          -> held for Mac (one SO/PO would carry every line)
 *   - anything else, or a lookup that fails                  -> held this pass (fail closed; the next run retries)
 * ShipStation's orderKey for a yourfloors order is "<shopifyOrderId>-<fulfillmentOrderId>" (25/25 checked 2026-10-01).
 */

'use strict';

const { graphql } = require('./shopify-graphql');

const FO_FIELDS = `deliveryMethod { methodType } assignedLocation { name } status`;
const ORDER_FIELDS = `id name tags customAttributes { key value } shippingLines(first: 5) { nodes { title } }
  fulfillmentOrders(first: 10) { nodes { ${FO_FIELDS} } }`;

function parseOrderKey(orderKey) {
  const m = /^(\d+)-(\d+)$/.exec(String(orderKey || '').trim());
  return m ? { shopifyOrderId: m[1], fulfillmentOrderId: m[2] } : null;
}

/** Shopify's view of how an order is delivered. gql(query, vars) -> { data }. Throws on lookup failure. */
async function localSignalFor(order, gql = graphql) {
  const key = parseOrderKey(order && order.orderKey);
  let fo = null;
  let o = null;
  if (key) {
    const r = await gql(`query($id: ID!) { node(id: $id) { ... on FulfillmentOrder { ${FO_FIELDS} order { ${ORDER_FIELDS} } } } }`,
      { id: `gid://shopify/FulfillmentOrder/${key.fulfillmentOrderId}` });
    fo = r && r.data && r.data.node;
    o = fo && fo.order;
  }
  if (!o) {
    const name = String((order && order.orderNumber) || '').replace(/^#/, '');
    if (!name) throw new Error('no orderKey or order number to look up');
    const r = await gql(`query($q: String!) { orders(first: 2, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:#${name}` });
    const hits = ((r && r.data && r.data.orders && r.data.orders.nodes) || []).filter((n) => n.name === `#${name}`);
    if (hits.length !== 1) throw new Error(`Shopify order #${name} not found (${hits.length} matches)`);
    o = hits[0];
  }
  return {
    orderName: o.name,
    methodType: fo && fo.deliveryMethod ? fo.deliveryMethod.methodType : null,
    location: fo && fo.assignedLocation ? fo.assignedLocation.name : null,
    tags: o.tags || [],
    customAttributes: o.customAttributes || [],
    shippingLines: ((o.shippingLines && o.shippingLines.nodes) || []).map((n) => n.title || ''),
    fulfillmentOrders: ((o.fulfillmentOrders && o.fulfillmentOrders.nodes) || []).map((n) => ({
      methodType: n.deliveryMethod ? n.deliveryMethod.methodType : null,
      location: n.assignedLocation ? n.assignedLocation.name : null,
      status: n.status,
    })),
  };
}

const LOCAL_TYPES = new Set(['PICK_UP', 'LOCAL']);
const DEAD = new Set(['CANCELLED', 'CLOSED']);

function pickupMarker(sig) {
  if ((sig.shippingLines || []).some((t) => /^\s*pick\s*-?\s*up\b/i.test(t))) return 'a "Pickup" shipping line';
  if ((sig.customAttributes || []).some((a) => String(a.key).toLowerCase() === 'pickup_location' && a.value)) return 'a pickup_location attribute';
  if ((sig.tags || []).some((t) => String(t).toLowerCase() === 'pickup')) return 'a pickup tag';
  return null;
}

/**
 * Pure. -> { action: 'ship' | 'local' | 'hold', kind, location, reason }.
 * 'local' and 'hold' both keep the order out of the label path; 'local' means Mac gets the pickup email.
 */
function classifyLocal(sig) {
  // Open fulfillment orders decide; if every one is closed or cancelled (an old order still awaiting in ShipStation),
  // fall back to all of them.
  const all = sig.fulfillmentOrders || [];
  const open = all.filter((f) => !DEAD.has(f.status));
  const live = open.length ? open : all;
  const types = new Set(live.map((f) => f.methodType));
  if (sig.methodType && !live.length) types.add(sig.methodType);
  const localFo = live.find((f) => LOCAL_TYPES.has(f.methodType))
    || (LOCAL_TYPES.has(sig.methodType) ? { methodType: sig.methodType, location: sig.location } : null);
  const marker = pickupMarker(sig);

  if (localFo && types.has('SHIPPING')) {
    return { action: 'hold', kind: 'MIXED', location: localFo.location, reason: `Mixed order: part ships, part is ${localFo.methodType === 'LOCAL' ? 'local delivery' : `pickup at ${localFo.location || 'a CFC location'}`}. No label bought; split or handle by hand.` };
  }
  if (localFo && localFo.methodType === 'PICK_UP') {
    return { action: 'local', kind: 'PICK_UP', location: localFo.location, reason: `Pickup at ${localFo.location || 'a CFC location'}: no courier label` };
  }
  if (localFo && localFo.methodType === 'LOCAL') {
    return { action: 'local', kind: 'LOCAL', location: localFo.location, reason: 'Local delivery by CFC truck: no courier label' };
  }
  if (types.size === 1 && types.has('SHIPPING')) {
    if (marker) return { action: 'local', kind: 'MARKER', location: null, reason: `Pickup (texted cart, ${marker}): no courier label` };
    return { action: 'ship', kind: 'SHIPPING', location: null, reason: null };
  }
  return { action: 'hold', kind: 'UNKNOWN', location: null, reason: `Delivery method ${[...types].join('+') || 'unknown'}: held for review, no label bought` };
}

/** Lookup + classify, failing closed. Never throws. */
async function localVerdict(order, gql = graphql) {
  try {
    const sig = await localSignalFor(order, gql);
    return { ...classifyLocal(sig), orderName: sig.orderName };
  } catch (err) {
    return { action: 'hold', kind: 'LOOKUP_FAILED', location: null, reason: `Pickup check failed (${err.message}): held this run, retried next run` };
  }
}

/** Plain-prose email to Mac for one local order (no arrows or bracketed keys: those pushed alerts to spam). */
function renderLocalOrderEmail(order, verdict) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const items = (order.items || []).filter((i) => i && i.sku)
    .map((i) => `<li>${esc(i.quantity || 1)} x ${esc(i.sku)}, ${esc(i.name || '')}</li>`).join('');
  const who = order.shipTo || order.billTo || {};
  const what = verdict.kind === 'LOCAL' ? 'a local delivery order' : verdict.kind === 'MIXED' ? 'a mixed pickup and shipping order' : `a pickup order${verdict.location ? ` at ${esc(verdict.location)}` : ''}`;
  return `<p>Order ${esc(order.orderNumber)} is ${what}. The pipeline did not buy a label or send a Prosol PO.</p>
<p>Customer: ${esc(who.name || '')}${who.phone ? `, ${esc(who.phone)}` : ''}${order.customerEmail ? `, ${esc(order.customerEmail)}` : ''}</p>
<ul>${items}</ul>
<p>Pull what's on the shelf, add the rest to the next Prosol run, then mark it ready for pickup in Shopify. Shopify sends the customer the ready email.</p>
<p>${esc(verdict.reason)}</p>`;
}

module.exports = { parseOrderKey, localSignalFor, classifyLocal, localVerdict, pickupMarker, renderLocalOrderEmail };
