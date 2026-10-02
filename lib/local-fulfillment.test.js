'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseOrderKey, classifyLocal, localVerdict, localSignalFor, renderLocalOrderEmail } = require('./local-fulfillment');

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

test('renderLocalOrderEmail: plain prose, escaped, lists the lines', () => {
  const html = renderLocalOrderEmail(
    { orderNumber: '1403', customerEmail: 'a@b.ca', shipTo: { name: 'Sam <Tile>', phone: '604-555-1234' }, items: [{ sku: 'J100AE', name: 'JOLLY 10 mm', quantity: 2 }] },
    { kind: 'PICK_UP', location: 'Sechelt Warehouse', reason: 'Pickup at Sechelt Warehouse: no courier label' });
  assert.match(html, /pickup order at Sechelt Warehouse/);
  assert.match(html, /2 x J100AE, JOLLY 10 mm/);
  assert.match(html, /Sam &lt;Tile&gt;/);
  assert.doesNotMatch(html, /→|\[/);
});
