/**
 * The Shopify writes the pickup runner needs (lib/pickup-runner.js io). Kept small and separate so the runner stays
 * pure and testable.
 *
 *   fulfill(gql, fulfillmentOrderIds)   mark picked-up orders fulfilled, no Shopify email (we send our own thanks)
 *   refundTrims(gql, order, lines)      refund just the trim lines (Mac 2026-10-02 "2. yes ok"): Shopify's own
 *                                       suggestedRefund works out the amount and tax, then refundCreate on the
 *                                       original payment, no restock, no Shopify email (we send trims_refunded).
 *                                       The order stays open (never cancel a paid order).
 *   branchStock(client, lines, code, branches)
 *                                       live Prosol stock for each line at every location, { CODE: { prosolSku: qty } }
 *                                       (CODE from the branch table's map_key, other locations LOC<id>); the pickup
 *                                       branch is always present, 0 when Prosol lists no stock there
 *   ensurePo(orderName, ssf, sf)        our Salesforce SO + Prosol PO for a counter pickup, made the same way the
 *                                       pipeline's SO reconcile makes them; if the SO already exists, its PO
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

async function branchStock(client, lines, code, branches) {
  const byId = new Map((branches || []).filter((b) => b.map_key).map((b) => [String(b.map_key), b.map_code || b.code]));
  const out = { [code]: {} };
  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.prosolSku)) continue;
    seen.add(l.prosolSku);
    let inv = await client.checkInventory(l.apiSku || l.prosolSku);
    if (!inv && l.apiSku && l.prosolSku !== l.apiSku) inv = await client.checkInventory(l.prosolSku);
    if (!inv) throw new Error(`Prosol stock lookup failed for ${l.apiSku || l.prosolSku}`);
    out[code][l.prosolSku] = 0;
    for (const [id, v] of Object.entries(inv.locationStock || {})) {
      const c = byId.get(String(id)) || `LOC${id}`;
      out[c] = out[c] || {};
      out[c][l.prosolSku] = Number(v.quantity) || 0;
    }
  }
  return out;
}

async function ensurePo(orderName, ssf, sf) {
  const r = await ssf.createShopifySoPo({ shopifyOrder: await ssf.fetchShopifyOrder(orderName) });
  if (r.poNumber) return r.poNumber;
  const errs = (r.errors || []).map((e) => e.error || String(e));
  if (!r.skipped) throw new Error(`SO/PO for ${orderName}: ${errs.join('; ') || r.poSkipReason || 'no PO made'}`);
  const so = String((r.existingCandidates || [])[0] || '').match(/SO-\d+/);
  if (!so) throw new Error(`SO for ${orderName} exists (${r.skipReason}) but its number isn't known`);
  const conn = await sf.connect();
  const rows = await sf.query(conn, `SELECT PBSI__Purchase_Order__r.Name FROM PBSI__PBSI_Purchase_Order_Line__c WHERE PBSI__Sales_Order__r.Name = '${so[0]}' LIMIT 5`);
  const po = rows.map((x) => x.PBSI__Purchase_Order__r && x.PBSI__Purchase_Order__r.Name).find(Boolean);
  if (!po) throw new Error(`${so[0]} exists for ${orderName} but has no Prosol PO`);
  return po;
}

module.exports = { fulfill, refundTrims, branchStock, ensurePo };
