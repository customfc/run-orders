'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseOrderKey, classifyLocal, classifyRefund, localVerdict, localSignalFor, renderLocalOrderEmail } = require('./local-fulfillment');

const sig = (fos, extra = {}) => ({
  orderName: '#1400', methodType: fos[0] ? fos[0].methodType : null, location: fos[0] ? fos[0].location : null,
  tags: [], customAttributes: [], shippingLines: [], fulfillmentOrders: fos, ...extra,
});
const fo = (methodType, location = 'Sechelt Warehouse', status = 'OPEN') => ({ methodType, location, status });

test('parseOrderKey: ShipStation yourfloors keys', () => {
  assert.deepStrictEqual(parseOrderKey('6999206527143-8056405917863'), { shopifyOrderId: '6999206527143', fulfillmentOrderId: '8056405917863' });
  assert.strictEqual(parseOrderKey('702-1234567-1234567'), null);
  assert.strictEqual(parseOrderKey(''), null);
  assert.strictEqual(parseOrderKey(undefined), null);
});

test('classifyLocal: shipping order ships', () => {
  assert.strictEqual(classifyLocal(sig([fo('SHIPPING', 'Vancouver Warehouse')])).action, 'ship');
});

test('classifyLocal: pickup at Sechelt and Powell River is local', () => {
  const s = classifyLocal(sig([fo('PICK_UP')]));
  assert.strictEqual(s.action, 'local');
  assert.strictEqual(s.kind, 'PICK_UP');
  assert.match(s.reason, /Pickup at Sechelt Warehouse/);
  assert.strictEqual(classifyLocal(sig([fo('PICK_UP', 'Powell River Showroom & Warehouse')])).location, 'Powell River Showroom & Warehouse');
});

test('classifyLocal: local delivery is local', () => {
  const s = classifyLocal(sig([fo('LOCAL')]));
  assert.strictEqual(s.action, 'local');
  assert.strictEqual(s.kind, 'LOCAL');
});

test('classifyLocal: closed fulfillment orders fall back to the looked-up one (#1288 shape)', () => {
  const s = classifyLocal(sig([fo('LOCAL', 'Sechelt Warehouse', 'CLOSED')]));
  assert.strictEqual(s.kind, 'LOCAL');
});

test('classifyLocal: texted-cart markers on a SHIPPING order count as pickup', () => {
  for (const extra of [
    { shippingLines: ['Pickup: Sechelt Warehouse'] },
    { shippingLines: ['pick-up Powell River'] },
    { customAttributes: [{ key: 'pickup_location', value: 'Sechelt' }] },
    { tags: ['ProZone', 'pickup'] },
  ]) {
    const s = classifyLocal(sig([fo('SHIPPING')], extra));
    assert.strictEqual(s.action, 'local', JSON.stringify(extra));
    assert.strictEqual(s.kind, 'MARKER');
  }
  assert.strictEqual(classifyLocal(sig([fo('SHIPPING')], { shippingLines: ['Standard Shipping'], tags: ['pickups-later'] })).action, 'ship');
});

test('classifyLocal: mixed shipping + pickup is held', () => {
  const s = classifyLocal(sig([fo('SHIPPING', 'Vancouver Warehouse'), fo('PICK_UP')]));
  assert.strictEqual(s.action, 'hold');
  assert.strictEqual(s.kind, 'MIXED');
});

test('classifyLocal: a cancelled pickup FO does not make a shipping order mixed', () => {
  assert.strictEqual(classifyLocal(sig([fo('SHIPPING', 'Vancouver Warehouse'), fo('PICK_UP', 'Sechelt Warehouse', 'CANCELLED')])).action, 'ship');
});

test('classifyLocal: unknown method is held', () => {
  const s = classifyLocal(sig([fo('NONE')]));
  assert.strictEqual(s.action, 'hold');
  assert.strictEqual(s.kind, 'UNKNOWN');
  assert.strictEqual(classifyLocal(sig([])).action, 'hold');
});

test('localSignalFor: reads the fulfillment order named by the orderKey', async () => {
  let asked = null;
  const gql = async (q, v) => {
    asked = v;
    return { data: { node: { deliveryMethod: { methodType: 'PICK_UP' }, assignedLocation: { name: 'Sechelt Warehouse' }, status: 'OPEN',
      order: { id: 'gid://shopify/Order/1', name: '#1400', tags: [], customAttributes: [], shippingLines: { nodes: [{ title: 'Sechelt Warehouse' }] },
        fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'PICK_UP' }, assignedLocation: { name: 'Sechelt Warehouse' }, status: 'OPEN' }] } } } } };
  };
  const s = await localSignalFor({ orderKey: '111-222', orderNumber: '1400' }, gql);
  assert.strictEqual(asked.id, 'gid://shopify/FulfillmentOrder/222');
  assert.strictEqual(s.methodType, 'PICK_UP');
  assert.strictEqual(classifyLocal(s).kind, 'PICK_UP');
});

test('localSignalFor: falls back to the order name when the key does not parse', async () => {
  const gql = async (q, v) => {
    assert.strictEqual(v.q, 'name:#1401');
    return { data: { orders: { nodes: [{ id: 'x', name: '#1401', tags: [], customAttributes: [], shippingLines: { nodes: [] },
      fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'SHIPPING' }, assignedLocation: { name: 'Vancouver Warehouse' }, status: 'OPEN' }] } }] } } };
  };
  const s = await localSignalFor({ orderKey: 'weird', orderNumber: '1401' }, gql);
  assert.strictEqual(classifyLocal(s).action, 'ship');
});

test('localVerdict: fails closed when Shopify cannot be read', async () => {
  const v = await localVerdict({ orderKey: '1-2', orderNumber: '1402' }, async () => { throw new Error('timeout'); });
  assert.strictEqual(v.action, 'hold');
  assert.strictEqual(v.kind, 'LOOKUP_FAILED');
  const v2 = await localVerdict({ orderKey: '1-2', orderNumber: '' }, async () => ({ data: { node: null } }));
  assert.strictEqual(v2.action, 'hold');
});

const tx = (kind, status, amount) => ({ kind, status, amount });
const paidSig = (transactions, lineItems = [{ quantity: 1, currentQuantity: 1 }], extra = {}) =>
  sig([fo('SHIPPING', 'Sechelt Warehouse')], { transactions, lineItems, lineItemsComplete: true, cancelledAt: null, ...extra });

test('classifyRefund: a paid order with no refund carries on', () => {
  assert.strictEqual(classifyRefund(paidSig([tx('SALE', 'SUCCESS', '34.63')])), null);
  assert.strictEqual(classifyRefund(sig([fo('SHIPPING')])), null);
});

test('classifyRefund: a full refund holds, and a PENDING one counts (#1407 shape)', () => {
  const v = classifyRefund(paidSig([tx('SALE', 'SUCCESS', '34.63'), tx('REFUND', 'PENDING', '34.63')], [{ quantity: 1, currentQuantity: 0 }]));
  assert.strictEqual(v.action, 'hold');
  assert.strictEqual(v.kind, 'REFUNDED');
  assert.match(v.reason, /\$34\.63 of \$34\.63, refund still pending/);
  const settled = classifyRefund(paidSig([tx('SALE', 'SUCCESS', '34.63'), tx('REFUND', 'SUCCESS', '34.63')]));
  assert.strictEqual(settled.kind, 'REFUNDED');
  assert.doesNotMatch(settled.reason, /pending/);
});

test('classifyRefund: an authorize + capture order refunded across two refunds holds', () => {
  const v = classifyRefund(paidSig([tx('AUTHORIZATION', 'SUCCESS', '199.95'), tx('CAPTURE', 'SUCCESS', '199.95'), tx('REFUND', 'SUCCESS', '100.00'), tx('REFUND', 'PENDING', '99.95')]));
  assert.strictEqual(v.kind, 'REFUNDED');
});

test('classifyRefund: a partial refund still ships (trim lines, goodwill amount)', () => {
  assert.strictEqual(classifyRefund(paidSig([tx('SALE', 'SUCCESS', '242.19'), tx('REFUND', 'SUCCESS', '41.20')],
    [{ quantity: 2, currentQuantity: 2 }, { quantity: 1, currentQuantity: 0 }])), null);
  assert.strictEqual(classifyRefund(paidSig([tx('SALE', 'SUCCESS', '242.19'), tx('REFUND', 'SUCCESS', '12.99')])), null);
});

test('classifyRefund: a failed refund does not count', () => {
  assert.strictEqual(classifyRefund(paidSig([tx('SALE', 'SUCCESS', '34.63'), tx('REFUND', 'FAILURE', '34.63')])), null);
});

test('classifyRefund: an order with no payment taken (terms, draft) is not "refunded"', () => {
  assert.strictEqual(classifyRefund(paidSig([])), null);
  assert.strictEqual(classifyRefund(paidSig([tx('SALE', 'FAILURE', '50.00')])), null);
});

test('classifyRefund: cancelled in Shopify holds', () => {
  const v = classifyRefund(paidSig([tx('SALE', 'SUCCESS', '34.63')], undefined, { cancelledAt: '2026-09-22T17:01:00Z' }));
  assert.strictEqual(v.kind, 'CANCELLED');
  assert.match(v.reason, /2026-09-22/);
});

test('classifyRefund: every line removed holds, but not on a truncated line list', () => {
  const gone = [{ quantity: 1, currentQuantity: 0 }, { quantity: 3, currentQuantity: 0 }];
  assert.strictEqual(classifyRefund(paidSig([], gone)).kind, 'REMOVED');
  assert.strictEqual(classifyRefund(paidSig([], gone, { lineItemsComplete: false })), null);
});

test('localVerdict: a refunded order is held before the pickup check, so a refunded pickup sends no pickup email', async () => {
  const order = (methodType) => ({ data: { node: { deliveryMethod: { methodType }, assignedLocation: { name: 'Sechelt Warehouse' }, status: 'CLOSED',
    order: { id: 'gid://shopify/Order/7309684474023', name: '#1407', tags: [], customAttributes: [], shippingLines: { nodes: [{ title: 'Standard' }] },
      cancelledAt: null, lineItems: { nodes: [{ quantity: 1, currentQuantity: 0 }], pageInfo: { hasNextPage: false } },
      transactions: [{ kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '34.63' } } }, { kind: 'REFUND', status: 'PENDING', amountSet: { shopMoney: { amount: '34.63' } } }],
      fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType }, assignedLocation: { name: 'Sechelt Warehouse' }, status: 'CLOSED' }] } } } } });
  for (const methodType of ['SHIPPING', 'PICK_UP']) {
    const v = await localVerdict({ orderKey: '7309684474023-8399069282471', orderNumber: '1407' }, async () => order(methodType));
    assert.strictEqual(v.action, 'hold', methodType);
    assert.strictEqual(v.kind, 'REFUNDED', methodType);
    assert.strictEqual(v.orderName, '#1407');
  }
});

test('localVerdict: an order Shopify answers without money fields (older shape) still classifies', async () => {
  const gql = async () => ({ data: { node: { deliveryMethod: { methodType: 'SHIPPING' }, assignedLocation: { name: 'Vancouver Warehouse' }, status: 'OPEN',
    order: { id: 'x', name: '#1404', tags: [], customAttributes: [], shippingLines: { nodes: [] },
      fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: 'SHIPPING' }, assignedLocation: { name: 'Vancouver Warehouse' }, status: 'OPEN' }] } } } } });
  assert.strictEqual((await localVerdict({ orderKey: '1-2', orderNumber: '1404' }, gql)).action, 'ship');
});

test('renderLocalOrderEmail: plain prose, escaped, lists the lines', () => {
  const html = renderLocalOrderEmail(
    { orderNumber: '1403', customerEmail: 'a@b.ca', shipTo: { name: 'Sam <Tile>', phone: '604-555-1234' }, items: [{ sku: 'J100AE', name: 'JOLLY 10 mm', quantity: 2 }] },
    { kind: 'PICK_UP', location: 'Sechelt Warehouse', reason: 'Pickup at Sechelt Warehouse: no courier label' });
  assert.match(html, /pickup order at Sechelt Warehouse/);
  assert.match(html, /2 x J100AE, JOLLY 10 mm/);
  assert.match(html, /Sam &lt;Tile&gt;/);
  assert.doesNotMatch(html, /→|\[/);
});
