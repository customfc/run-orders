'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('./amazon-unshipped');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amz-unshipped-')), 's.json');
const NOW = new Date('2026-11-02T15:30:00Z'); // 08:30 BC
const order = (id, o = {}) => ({ AmazonOrderId: id, FulfillmentChannel: 'MFN', OrderStatus: 'Unshipped', PurchaseDate: '2026-10-20T17:53:00Z', LatestShipDate: '2026-10-23T06:59:59Z', OrderTotal: { Amount: '38.74' }, ...o });

function fakeIo({ orders, shipments = {}, ssOrders = {}, kerdi = {}, confirm = { ok: true, status: 204 } }) {
  const calls = { confirm: [], notify: [] };
  return {
    calls,
    io: {
      listUnshipped: async () => orders,
      orderItems: async () => [{ OrderItemId: '172919722301681', QuantityOrdered: 1, QuantityShipped: 0 }],
      ssShipments: async (n) => shipments[n] || [],
      ssOrders: async (n) => ssOrders[n] || [],
      confirm: async (id, pkg) => { calls.confirm.push({ id, pkg }); return confirm; },
      kerdi: (id) => kerdi[id] || null,
      notify: async (o) => calls.notify.push(o),
    },
  };
}

test('a delivered order Amazon never took gets its tracking sent, once', async () => {
  const stateFile = tmp();
  const a = fakeIo({
    orders: [order('702-0613008-0134632')],
    shipments: { '702-0613008-0134632': [{ trackingNumber: '520814794001', carrierCode: 'purolator_walleted', shipDate: '2026-10-21', voided: false }] },
  });
  const out = await u.run({ io: a.io, live: true, now: NOW, stateFile });
  assert.equal(out.confirmed.length, 1);
  assert.deepEqual(a.calls.confirm[0].pkg, {
    packageReferenceId: '1', carrierCode: 'Purolator', trackingNumber: '520814794001', shipDate: '2026-10-21T20:00:00.000Z',
    orderItems: [{ orderItemId: '172919722301681', quantity: 1 }],
  });
  assert.equal(a.calls.notify.length, 1);
  assert.match(u.emailSubject(out), /1 tracking sent/);

  // Next morning Amazon still says unshipped: no second confirm, Mac is told to do it by hand.
  const b = fakeIo({ orders: [order('702-0613008-0134632')], shipments: { '702-0613008-0134632': [{ trackingNumber: '520814794001', carrierCode: 'purolator_walleted', shipDate: '2026-10-21' }] } });
  const next = await u.run({ io: b.io, live: true, now: new Date(NOW.getTime() + 864e5), stateFile });
  assert.equal(b.calls.confirm.length, 0);
  assert.equal(next.stillUnshipped.length, 1);
});

test('a label made today is left to ShipStation; a voided label is not a label', async () => {
  const a = fakeIo({
    orders: [order('A', { LatestShipDate: '2026-11-05T06:59:59Z' }), order('B', { LatestShipDate: '2026-11-05T06:59:59Z' })],
    shipments: {
      A: [{ trackingNumber: 'T1', carrierCode: 'ups', shipDate: '2026-11-02' }],
      B: [{ trackingNumber: 'T2', carrierCode: 'ups', shipDate: '2026-10-30', voided: true }],
    },
  });
  const out = await u.run({ io: a.io, live: true, now: NOW, stateFile: tmp() });
  assert.equal(a.calls.confirm.length, 0);
  assert.equal(out.late.length + out.dueToday.length, 0, 'ship-by is days away');
  assert.equal(a.calls.notify.length, 0, 'no email when there is nothing in it');
});

test('a rejection comes back to Mac with Amazon\'s words, and an unknown carrier is never guessed', async () => {
  const a = fakeIo({
    orders: [order('A'), order('B')],
    shipments: { A: [{ trackingNumber: 'T1', carrierCode: 'purolator', shipDate: '2026-10-21' }], B: [{ trackingNumber: 'T2', carrierCode: 'loomis', shipDate: '2026-10-21' }] },
    confirm: { ok: false, status: 400, error: 'InvalidInput: bad tracking' },
  });
  const out = await u.run({ io: a.io, live: true, now: NOW, stateFile: tmp() });
  assert.equal(a.calls.confirm.length, 1, 'only the Purolator one is sent');
  assert.equal(out.rejected.length, 2);
  assert.match(u.emailText(out), /InvalidInput: bad tracking/);
  assert.match(u.emailText(out), /no Amazon carrier name for ShipStation carrier loomis/);
});

test('no label past ship-by says why: a Kerdi hold waiting on Mac, a skipped order', async () => {
  const a = fakeIo({
    orders: [order('702-7794141-0120221', { LatestShipDate: '2026-10-30T06:59:59Z', OrderTotal: { Amount: '418.97' } }), order('C', { LatestShipDate: '2026-11-03T06:59:59Z' }), order('D', { LatestShipDate: '2026-11-04T06:59:59Z' })],
    ssOrders: { '702-7794141-0120221': [{ orderStatus: 'awaiting_shipment' }], C: [{ orderStatus: 'awaiting_shipment' }] },
    kerdi: { '702-7794141-0120221': { askedAt: '2026-10-28T11:00:27Z', replyAt: '2026-10-28T13:33:24Z' } },
  });
  const out = await u.run({ io: a.io, live: true, now: NOW, stateFile: tmp() });
  assert.equal(out.late.length, 1);
  assert.match(out.late[0].why, /Kerdi-Line hold: the buyer replied 2026-10-28/);
  assert.equal(out.dueToday.length, 1, 'C ships by end of today BC; D is tomorrow and not listed');
  assert.match(out.dueToday[0].why, /no label yet/);
  assert.match(u.emailSubject(out), /1 past ship-by, 1 due today/);
});

test('a dry run confirms nothing and saves nothing', async () => {
  const stateFile = tmp();
  const a = fakeIo({ orders: [order('A')], shipments: { A: [{ trackingNumber: 'T1', carrierCode: 'purolator', shipDate: '2026-10-21' }] } });
  const out = await u.run({ io: a.io, live: false, now: NOW, stateFile });
  assert.equal(out.wouldConfirm.length, 1);
  assert.equal(a.calls.confirm.length + a.calls.notify.length, 0);
  assert.equal(fs.existsSync(stateFile), false);
});

test('ship time sits after the order and never in the future', () => {
  assert.equal(u.shipTime('2026-10-21', '2026-10-20T17:53:00Z', NOW), '2026-10-21T20:00:00.000Z');
  assert.equal(u.shipTime('2026-10-21', '2026-10-21T22:00:00Z', NOW), '2026-10-21T23:00:00.000Z');
  assert.equal(u.shipTime('2026-11-02', '2026-11-01T10:00:00Z', NOW), NOW.toISOString());
});
