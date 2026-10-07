/**
 * Has the buyer asked to cancel this Amazon order?
 *
 * Amazon puts the request on each ORDER ITEM
 * (`BuyerRequestedCancel: { IsBuyerRequestedCancel: "true", BuyerCancelReason }`).
 * The order-level `IsBuyerRequestedCancellation` the guards used to read is never
 * sent, so from April to October 2026 the cancel guard never fired once: 14 orders
 * the buyer had asked to cancel shipped anyway ($13,413), and two 1-star reviews
 * (701-9256755-2409059, 702-9992784-4802612) trace back to it.
 */

const truthy = (v) => v === true || String(v).toLowerCase() === 'true';

/** From order items (getOrderItems payload.OrderItems): { requested, reason }. */
function cancelRequestFromItems(items) {
  for (const i of items || []) {
    const c = i && i.BuyerRequestedCancel;
    if (c && truthy(c.IsBuyerRequestedCancel)) return { requested: true, reason: c.BuyerCancelReason || '(no reason given)' };
  }
  return { requested: false, reason: null };
}

/** Order-level fallback, in case Amazon ever does send it. */
function cancelRequestFromOrder(order) {
  if (order && truthy(order.IsBuyerRequestedCancellation)) return { requested: true, reason: order.BuyerCancelReason || order.BuyerRequestedCancelReason || '(no reason given)' };
  return { requested: false, reason: null };
}

/** Reads every item page. Throws on API failure: callers decide what "unknown" means. */
async function buyerRequestedCancel(orderId, sp = require('./sp-api')) {
  const items = [];
  let nextToken;
  do {
    const r = await sp.getOrderItems(orderId, { nextToken });
    const p = r && (r.payload || r);
    items.push(...((p && p.OrderItems) || []));
    nextToken = p && p.NextToken;
  } while (nextToken);
  return cancelRequestFromItems(items);
}

module.exports = { cancelRequestFromItems, cancelRequestFromOrder, buyerRequestedCancel };
