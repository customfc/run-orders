/**
 * The Shopify writes the pickup runner needs (lib/pickup-runner.js io). Kept small and separate so the runner stays
 * pure and testable.
 *
 *   fulfill(gql, fulfillmentOrderIds)   mark picked-up orders fulfilled, no Shopify email (we send our own thanks)
 *   refundTrims(gql, order, lines)      refund just the trim lines (Mac 2026-10-02 "2. yes ok"): Shopify's own
 *                                       suggestedRefund works out the amount and tax, then refundCreate on the
 *                                       original payment, no restock, no Shopify email (we send trims_refunded).
 *                                       The order stays open (never cancel a paid order).
 */

'use strict';

async function fulfill(gql, ids) {
  if (!ids || !ids.length) throw new Error('fulfill: no open fulfillment orders');
  const r = await gql(`mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
    { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: ids.map((fulfillmentOrderId) => ({ fulfillmentOrderId })) } });
  const d = r.data.fulfillmentCreate;
  if (d.userErrors.length) throw new Error(`fulfillmentCreate: ${JSON.stringify(d.userErrors)}`);
  return d.fulfillment;
}

async function refundTrims(gql, order, lines) {
  if (!lines || !lines.length) throw new Error('refundTrims: no lines');
  const refundLineItems = lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity, restockType: 'NO_RESTOCK' }));
  const s = await gql(`query($id: ID!, $li: [RefundLineItemInput!]) { order(id: $id) { suggestedRefund(refundLineItems: $li, suggestFullRefund: false) {
    amountSet { shopMoney { amount currencyCode } }
    suggestedTransactions { gateway kind amountSet { shopMoney { amount } } parentTransaction { id } } } } }`, { id: order.id, li: refundLineItems });
  const sr = s.data.order.suggestedRefund;
  const amount = Number(sr.amountSet.shopMoney.amount);
  if (!(amount > 0)) throw new Error(`refundTrims: Shopify suggests ${amount} for ${order.name}`);
  const transactions = sr.suggestedTransactions.filter((t) => t.parentTransaction).map((t) => ({
    orderId: order.id, parentId: t.parentTransaction.id, amount: t.amountSet.shopMoney.amount, gateway: t.gateway, kind: 'REFUND',
  }));
  if (!transactions.length) throw new Error(`refundTrims: no refundable payment on ${order.name}`);
  const r = await gql(`mutation($i: RefundInput!) { refundCreate(input: $i) { refund { id totalRefundedSet { shopMoney { amount } } } userErrors { field message } } }`,
    { i: { orderId: order.id, notify: false, note: 'Full-length trims: pickup only (pickup runner)', refundLineItems, transactions } });
  const d = r.data.refundCreate;
  if (d.userErrors.length) throw new Error(`refundCreate: ${JSON.stringify(d.userErrors)}`);
  return { id: d.refund.id, amount: Number(d.refund.totalRefundedSet.shopMoney.amount) };
}

module.exports = { fulfill, refundTrims };
