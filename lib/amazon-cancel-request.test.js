const test = require('node:test');
const assert = require('node:assert');
const { cancelRequestFromItems, cancelRequestFromOrder, buyerRequestedCancel } = require('./amazon-cancel-request');

test('item-level request is found (string "true", as Amazon sends it)', () => {
  const r = cancelRequestFromItems([{ BuyerRequestedCancel: { IsBuyerRequestedCancel: 'false' } }, { BuyerRequestedCancel: { IsBuyerRequestedCancel: 'true', BuyerCancelReason: 'Order Created By Mistake' } }]);
  assert.deepEqual(r, { requested: true, reason: 'Order Created By Mistake' });
});

test('no request, or no field at all, is not a cancel', () => {
  assert.equal(cancelRequestFromItems([{ BuyerRequestedCancel: { IsBuyerRequestedCancel: 'false' } }]).requested, false);
  assert.equal(cancelRequestFromItems([{}]).requested, false);
  assert.equal(cancelRequestFromOrder({ OrderStatus: 'Unshipped' }).requested, false);
});

test('reads every item page', async () => {
  const pages = [{ payload: { OrderItems: [{}], NextToken: 'n2' } }, { payload: { OrderItems: [{ BuyerRequestedCancel: { IsBuyerRequestedCancel: 'true' } }] } }];
  const sp = { getOrderItems: async () => pages.shift() };
  assert.equal((await buyerRequestedCancel('702-0000000-0000001', sp)).requested, true);
});
