// Tests for the large-order release store. Uses a throwaway file so a test can
// never approve a real held order. Run: `npm test`.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.LARGE_ORDER_RELEASES_FILE = path.join(os.tmpdir(), `large-order-releases-test-${process.pid}.json`);
process.env.LARGE_ORDER_RELEASE_TTL_DAYS = '14';

const test = require('node:test');
const assert = require('node:assert/strict');
const releases = require('./large-order-releases');

test.after(() => { try { fs.unlinkSync(process.env.LARGE_ORDER_RELEASES_FILE); } catch {} });

test('an order is held until released; release records who, when and the optional branch pin', () => {
  assert.equal(releases.isReleased('701-2214531-7431400'), false);
  const e = releases.release('#701-2214531-7431400', { by: 'Mac', warehouseCode: 'wcas', note: 'DITRA x6 Golden' });
  assert.equal(e.orderNumber, '701-2214531-7431400', 'leading # is stripped');
  assert.equal(e.warehouseCode, 'WCAS', 'branch code is upper-cased');
  assert.equal(releases.isReleased('701-2214531-7431400'), true);
  assert.equal(releases.pinnedWarehouse('701-2214531-7431400'), 'WCAS');
  assert.equal(releases.list().length, 1);
});

test('a release without a pin leaves routing to the nearest-branch rule', () => {
  releases.release('1399', { by: 'Mac' });
  assert.equal(releases.pinnedWarehouse('1399'), null);
  assert.equal(releases.isReleased('1399'), true);
  assert.equal(releases.remove('1399'), true);
  assert.equal(releases.isReleased('1399'), false);
});

test('a stale approval expires: it must never ship a re-imported order weeks later', () => {
  const file = process.env.LARGE_ORDER_RELEASES_FILE;
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  map['0001'] = { orderNumber: '0001', at: new Date(Date.now() - 20 * 86400000).toISOString(), by: 'Mac', warehouseCode: null, note: null };
  fs.writeFileSync(file, JSON.stringify(map));
  assert.equal(releases.isReleased('0001'), false, 'older than the TTL');
  assert.equal(releases.isReleased('701-2214531-7431400'), true, 'a fresh one still stands');
});
