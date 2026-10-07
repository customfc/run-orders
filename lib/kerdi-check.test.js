const test = require('node:test');
const assert = require('node:assert');
const k = require('./kerdi-check');

test('parses channel bodies, grates (frameless and designer) and flange kits', () => {
  assert.deepEqual(k.parse('KL1V60E100'), { kind: 'channel', len: 100, offset: false });
  assert.deepEqual(k.parse('KL1VO60E70'), { kind: 'channel', len: 70, offset: true });
  assert.deepEqual(k.parse('KL1DRE90'), { kind: 'grate', len: 90, offset: false, frameless: true });
  assert.deepEqual(k.parse('KL1DROE70'), { kind: 'grate', len: 70, offset: true, frameless: true });
  for (const [c, len] of [['KL1B19EB80', 80], ['KL1B19MGS80', 80], ['KL1AR19MGS70', 70], ['KL1AR30EB70', 70], ['KL1IFE23EB70', 70], ['KL1B19EP100', 100]]) assert.equal(k.parse(c).len, len, c);
  assert.deepEqual(k.parse('KD3/ABS/FL'), { kind: 'flange', pipe: 'ABS' });
  assert.equal(k.parse('C030882-01'), null);
});

test('Robert: 36" grate then 40" channel is a size mismatch on either order', () => {
  assert.deepEqual(k.assess(['KL1V60E100'], ['KL1DRE90']).map((i) => i.type), ['size_mismatch']);
  assert.deepEqual(k.assess(['KL1DRE90'], ['KL1V60E100']).map((i) => i.type), ['size_mismatch']);
});

test('matching channel and grate in one order: nothing to ask', () => {
  assert.deepEqual(k.assess(['KL1V60E60', 'KL1DRE60']), []);
  assert.deepEqual(k.assess(['KL1V60E60', 'KL1B19EB60']), []);
});

test('channel alone, grate alone, offset vs centre, flange kit', () => {
  assert.equal(k.assess(['KL1V60E60'])[0].type, 'channel_only');
  assert.equal(k.assess(['KL1DRE120'])[0].type, 'grate_only');
  assert.equal(k.assess(['KL1VO60E70', 'KL1DRE70'])[0].type, 'outlet_mismatch');
  assert.equal(k.assess(['KD3ABSFL'])[0].type, 'flange_abs');
});

test('buyer email: plain, in inches, ships tomorrow if no reply', () => {
  const e = k.buyerEmail({ firstName: 'ROBERT', orderNumber: '701-3798231-4277066', issues: k.assess(['KL1V60E100'], ['KL1DRE90']) });
  assert.match(e.text, /^Hi Robert,/);
  assert.match(e.text, /channel body is 40" and your grate is 36"/);
  assert.match(e.text, /ships tomorrow/);
  assert.ok(!/—/.test(e.text), 'no em dashes');
});

test('decide: hold until asked + 24 h, never past ship-by, never after a failed ask', () => {
  const issues = [{ type: 'channel_only', len: 60 }];
  const now = new Date('2026-10-08T15:00:00Z');
  assert.equal(k.decide({ orderNumber: 'A', issues, now, state: { orders: {} } }).hold, true);
  assert.equal(k.decide({ orderNumber: 'A', issues, now, state: { orders: { A: { askedAt: '2026-10-08T03:00:00Z' } } } }).hold, true);
  assert.equal(k.decide({ orderNumber: 'A', issues, now, state: { orders: { A: { askedAt: '2026-10-07T14:00:00Z' } } } }).hold, false);
  assert.equal(k.decide({ orderNumber: 'A', issues, now, shipByDate: '2026-10-08T23:00:00Z', state: { orders: {} } }).hold, false);
  assert.equal(k.decide({ orderNumber: 'A', issues, now, state: { orders: { A: { askFailedAt: '2026-10-08T03:00:00Z' } } } }).hold, false);
  assert.equal(k.decide({ orderNumber: 'A', issues: [], now, state: { orders: {} } }).hold, false);
});

test('a buyer reply keeps the hold (even past 24 h and ship-by) until Mac releases it', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kerdi-')), 's.json');
  k.saveState({ orders: { A: { askedAt: '2026-10-07T14:00:00Z' } } }, file);
  assert.equal(k.noteReply('A', '2026-10-07T16:00:00Z', file), true);
  assert.equal(k.noteReply('B', '2026-10-07T16:00:00Z', file), false);
  const issues = [{ type: 'channel_only', len: 60 }];
  const now = new Date('2026-10-09T15:00:00Z');
  assert.equal(k.decide({ orderNumber: 'A', issues, now, shipByDate: '2026-10-09T16:00:00Z', state: k.loadState(file) }).hold, true);
  k.release('A', file);
  assert.equal(k.decide({ orderNumber: 'A', issues, now, state: k.loadState(file) }).hold, false);
});
