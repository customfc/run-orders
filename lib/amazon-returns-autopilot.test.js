// Offline tests for the returns autopilot policy and state machine. Fake IO,
// temp state file; never loads credentials or touches Amazon/ShipStation/SF.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ap = require('./amazon-returns-autopilot');

const P = ap.policy({});
const NOW = new Date('2026-10-07T18:00:00Z');

function row(over = {}) {
  return {
    'Order ID': '702-0000000-0000001', 'Order Item ID': '11111111111111', 'Merchant SKU': 'O0-WYB0-8Z4R', ASIN: 'B000UOJGME',
    'Item Name': 'Aqua Mix Sealers Choice Gold - Quart', 'Return quantity': '1', 'Return Reason': 'CR-SWITCHEROO',
    'Return request status': 'Approved', 'A-to-Z Claim': 'N', 'Label to be paid by': 'Seller', 'Amazon RMA ID': 'DxRMA1',
    'Tracking ID': ' ', 'Return delivery date': ' ', 'Return request date': '05-Oct-2026', 'Return type': 'C-Returns', ...over,
  };
}

function fakeIo({ rows, totals = {}, quote = { cents: 1800, branch: 'Prosol Burnaby', warehouseId: 1374417 }, refundError, previewError, track = { status: 'AC', scanned: false, delivered: false } } = {}) {
  const calls = { commit: [], email: [], label: [], branch: [], sf: [], mac: [], preview: [], quote: 0 };
  const io = {
    fetchReturns: async () => rows,
    previewRefund: async ({ order, items }) => {
      calls.preview.push(order);
      if (previewError) throw new Error(previewError);
      return { totalCents: totals[order] ?? 9519, full: true, ordered: Object.fromEntries(items.map((i) => [i.id, i.quantity])) };
    },
    commitRefund: async (a) => { if (refundError) throw new Error(refundError); calls.commit.push(a); return { feedId: `F${calls.commit.length}` }; },
    quoteLabel: async () => { calls.quote++; return quote; },
    buyLabel: async (ret) => { calls.label.push(ret.order); return { tracking: '3350000000', labelId: 'se-1', cents: quote.cents, pdf: Buffer.from('%PDF') }; },
    trackLabel: async () => track,
    emailBuyer: async (kind, ret) => { calls.email.push([kind, ret.order]); return { to: 'x@marketplace.amazon.ca' }; },
    notifyBranch: async (ret) => { calls.branch.push(ret.order); return { to: 'kaitlyn' }; },
    logSalesforce: async (ret) => { calls.sf.push(ret.order); return { created: ['Case 1'] }; },
    notifyMac: async (m) => { calls.mac.push(m); },
  };
  return { io, calls };
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'returns-ap-')), 'state.json');

test('cheap consumable: refund without return, tell buyer, log Salesforce', async () => {
  const stateFile = tmpState();
  const { io, calls } = fakeIo({ rows: [row()] });
  const out = await ap.run({ io, live: true, now: NOW, P, stateFile });
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.commit[0].expectedCents, 9519);
  assert.match(calls.commit[0].evidence, /returns-autopilot/);
  assert.deepEqual(calls.email, [['returnless', '702-0000000-0000001']]);
  assert.equal(calls.label.length, 0);
  assert.equal(calls.sf.length, 1);
  assert.equal(ap.loadState(stateFile).orders['702-0000000-0000001'].stage, 'done');
  assert.equal(out.actions[0].do, 'refund');
  // Second run: nothing happens again.
  const again = fakeIo({ rows: [row()] });
  await ap.run({ io: again.io, live: true, now: NOW, P, stateFile });
  assert.equal(again.calls.commit.length + again.calls.preview.length, 0);
});

test('SHADOW changes nothing and writes no state', async () => {
  const stateFile = tmpState();
  const { io, calls } = fakeIo({ rows: [row()] });
  const out = await ap.run({ io, live: false, now: NOW, P, stateFile });
  assert.equal(calls.commit.length + calls.email.length + calls.sf.length + calls.mac.length, 0);
  assert.equal(out.actions[0].shadow, true);
  assert.equal(fs.existsSync(stateFile), false);
});

test('worth recovering: label, buyer email, Prosol heads-up, refund on first scan', async () => {
  const stateFile = tmpState();
  const r = row({ 'Order ID': '702-0000000-0000002', 'Item Name': 'Schluter Kerdi-Line Frameless Grate', 'Merchant SKU': 'KL1DRE90-FBM' });
  const first = fakeIo({ rows: [r], totals: { '702-0000000-0000002': 24457 } });
  await ap.run({ io: first.io, live: true, now: NOW, P, stateFile });
  assert.deepEqual(first.calls.label, ['702-0000000-0000002']);
  assert.deepEqual(first.calls.email, [['label', '702-0000000-0000002']]);
  assert.deepEqual(first.calls.branch, ['702-0000000-0000002']);
  assert.equal(first.calls.commit.length, 0, 'no refund before the carrier has it');
  // Not scanned yet: still waiting.
  const waiting = fakeIo({ rows: [r] });
  await ap.run({ io: waiting.io, live: true, now: NOW, P, stateFile });
  assert.equal(waiting.calls.commit.length, 0);
  // Scanned, and the request has dropped off the report: still refunds.
  const scanned = fakeIo({ rows: [], track: { status: 'IT', scanned: true, delivered: false } });
  await ap.run({ io: scanned.io, live: true, now: NOW, P, stateFile });
  assert.equal(scanned.calls.commit.length, 1);
  assert.equal(scanned.calls.commit[0].expectedCents, 24457);
  assert.equal(scanned.calls.email.length, 0, 'label buyers are not told to keep it');
  assert.equal(scanned.calls.sf.length, 1);
});

test('over $300 waits for delivery, not first scan', async () => {
  const stateFile = tmpState();
  const r = row({ 'Order ID': '702-0000000-0000003', 'Item Name': 'Schluter Kerdi-Line Channel Body 40in' });
  const q = { cents: 2600, branch: 'Prosol Burnaby', warehouseId: 1374417 };
  await ap.run({ io: fakeIo({ rows: [r], totals: { '702-0000000-0000003': 41253 }, quote: q }).io, live: true, now: NOW, P, stateFile });
  const scanned = fakeIo({ rows: [r], track: { status: 'IT', scanned: true, delivered: false } });
  await ap.run({ io: scanned.io, live: true, now: NOW, P, stateFile });
  assert.equal(scanned.calls.commit.length, 0);
  const delivered = fakeIo({ rows: [r], track: { status: 'DE', scanned: true, delivered: true } });
  await ap.run({ io: delivered.io, live: true, now: NOW, P, stateFile });
  assert.equal(delivered.calls.commit.length, 1);
});

test('A-to-Z is held, Mac told once, never refunded', async () => {
  const stateFile = tmpState();
  const r = row({ 'A-to-Z Claim': 'Y' });
  const first = fakeIo({ rows: [r] });
  const out = await ap.run({ io: first.io, live: true, now: NOW, P, stateFile });
  assert.equal(first.calls.commit.length + first.calls.preview.length, 0);
  assert.equal(out.held.length, 1);
  assert.equal(first.calls.mac.length, 1);
  const second = fakeIo({ rows: [r] });
  await ap.run({ io: second.io, live: true, now: NOW, P, stateFile });
  assert.equal(second.calls.mac.length, 0, 'no repeat email for the same hold');
});

test('already refunded in Amazon: settled, no refund', async () => {
  const stateFile = tmpState();
  const { io, calls } = fakeIo({ rows: [row()], previewError: 'RefundEventList already exists; refusing another refund' });
  const out = await ap.run({ io, live: true, now: NOW, P, stateFile });
  assert.equal(calls.commit.length, 0);
  assert.equal(out.settled.length, 1);
  assert.equal(ap.loadState(stateFile).orders['702-0000000-0000001'].stage, 'already_refunded');
});

test('over the $600 auto cap: held with a decision; Mac approves; next run refunds', async () => {
  const stateFile = tmpState();
  const r = row({ 'Order ID': '702-0000000-0000004', 'Item Name': 'Mapei Mapesil T Plus Silicone (case)' });
  const first = fakeIo({ rows: [r], totals: { '702-0000000-0000004': 108460 }, quote: { cents: 2500, branch: 'Prosol Burnaby', warehouseId: 1374417 } });
  const out = await ap.run({ io: first.io, live: true, now: NOW, P, stateFile });
  assert.equal(first.calls.commit.length, 0);
  assert.match(out.held[0].why, /auto cap/);
  ap.approve('702-0000000-0000004', { stateFile, now: NOW });
  const second = fakeIo({ rows: [r], totals: { '702-0000000-0000004': 108460 } });
  await ap.run({ io: second.io, live: true, now: NOW, P, stateFile });
  assert.equal(second.calls.commit.length + second.calls.label.length, 1);
});

test('label economics: over $30 holds, over 35% of refund goes returnless', () => {
  assert.equal(ap.decideLabel(30000, 3500, P).action, 'held');
  assert.equal(ap.decideLabel(9000, 3200, P).action, 'returnless');
  assert.equal(ap.decideLabel(30000, 1800, P).action, 'label');
});

test('daily cap holds the refund that would pass it', async () => {
  const stateFile = tmpState();
  const rows = Array.from({ length: 4 }, (_, i) => row({ 'Order ID': `702-0000000-000001${i}`, 'Order Item ID': `2222222222222${i}` }));
  const totals = Object.fromEntries(rows.map((r) => [r['Order ID'], 14000]));
  const { io, calls } = fakeIo({ rows, totals });
  const out = await ap.run({ io, live: true, now: NOW, P: { ...P, dailyRefundCap: 300 }, stateFile });
  assert.equal(calls.commit.length, 2);
  assert.equal(out.held.filter((h) => /daily cap/.test(h.why)).length, 2);
});

test('a refund that does not confirm is held for Seller Central and never retried', async () => {
  const stateFile = tmpState();
  const first = fakeIo({ rows: [row()], refundError: 'Feed 123 still pending. Check that feed; do not resubmit.' });
  await ap.run({ io: first.io, live: true, now: NOW, P, stateFile });
  const e = ap.loadState(stateFile).orders['702-0000000-0000001'];
  assert.equal(e.stage, 'held');
  assert.equal(e.sticky, true);
  const second = fakeIo({ rows: [row()] });
  await ap.run({ io: second.io, live: true, now: NOW, P, stateFile });
  assert.equal(second.calls.commit.length + second.calls.preview.length, 0);
});

test('two returned lines on one order go in one refund', async () => {
  const stateFile = tmpState();
  const rows = [row(), row({ 'Order Item ID': '11111111111112', 'Merchant SKU': 'C10461', 'Item Name': 'Aqua Mix Grout Haze Clean-Up (Pint)' })];
  const { io, calls } = fakeIo({ rows, totals: { '702-0000000-0000001': 14200 } });
  await ap.run({ io, live: true, now: NOW, P, stateFile });
  assert.equal(calls.commit.length, 1);
});

test('buyer already shipped it on Amazon\'s label: refund, no keep-it email', async () => {
  const stateFile = tmpState();
  const r = row({ 'Item Name': 'Schluter Kerdi Board Niche', 'Tracking ID': '1Z999', 'Order ID': '702-0000000-0000005' });
  const { io, calls } = fakeIo({ rows: [r], totals: { '702-0000000-0000005': 13146 } });
  await ap.run({ io, live: true, now: NOW, P, stateFile });
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.email.length, 0);
  assert.equal(calls.label.length, 0);
});

test('a weeks-old request is held before a label goes out; approve sends it', async () => {
  const stateFile = tmpState();
  const r = row({ 'Order ID': '702-0000000-0000007', 'Item Name': 'Schluter KERDI-Board-SN Shower Niche', 'Return request date': '04-Sep-2026' });
  const first = fakeIo({ rows: [r], totals: { '702-0000000-0000007': 13146 }, quote: { cents: 1167, branch: 'Prosol Saint-Laurent', warehouseId: 1791765 } });
  const out = await ap.run({ io: first.io, live: true, now: NOW, P, stateFile });
  assert.equal(first.calls.label.length, 0);
  assert.match(out.held[0].why, /33 days ago.*label \$11\.67/);
  assert.equal(ap.loadState(stateFile).orders['702-0000000-0000007'].decision, 'label');
  ap.approve('702-0000000-0000007', { stateFile, now: NOW });
  const second = fakeIo({ rows: [r] });
  await ap.run({ io: second.io, live: true, now: NOW, P, stateFile });
  assert.deepEqual(second.calls.label, ['702-0000000-0000007']);
});

test('no Salesforce PO to reverse: noted once, not retried', async () => {
  const stateFile = tmpState();
  const { io, calls } = fakeIo({ rows: [row()] });
  io.logSalesforce = async () => { calls.sf.push('none'); return { none: 'no Salesforce PO' }; };
  await ap.run({ io, live: true, now: NOW, P, stateFile });
  assert.equal(ap.loadState(stateFile).orders['702-0000000-0000001'].stage, 'done');
  assert.equal(calls.mac.length, 1);
});

test('closed and out-of-window requests are ignored', () => {
  const rows = [row({ 'Return request status': 'Closed' }), row({ 'Order ID': '702-0000000-0000006', 'Return request date': '01-Jul-2026' })];
  assert.equal(ap.openReturnsByOrder(rows, NOW, 45).length, 0);
});

test('approve links are order-bound', () => {
  const t = ap.approveToken('702-0000000-0000001', 'secret');
  assert.ok(ap.verifyApprove('702-0000000-0000001', t, 'secret'));
  assert.ok(!ap.verifyApprove('702-0000000-0000002', t, 'secret'));
});

test('the three bottles behind the 1-star reviews all go returnless', () => {
  for (const [name, cents] of [['Aqua Mix Sealers Choice Gold - Quart', 9604], ['Aqua Mix Sealers Choice Gold - Quart', 9519], ["Aquamix Enrich'N'Seal 473ml (1pint)", 9973]]) {
    const ret = { items: [ap.normaliseRow(row({ 'Item Name': name }))] };
    assert.equal(ap.decide(ret, cents, P).action, 'returnless', name);
  }
});
