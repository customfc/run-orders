'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { middleware } = require('./tap-log');

function run(req, { status = 200, locals = {} } = {}) {
  const lines = [];
  const res = Object.assign(new EventEmitter(), { statusCode: status, locals });
  let nexted = false;
  let t = 1000;
  middleware((r) => lines.push(r), { now: () => (t += 250) })(
    { socket: { remoteAddress: '::ffff:100.101.102.103' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)' }, query: {}, ...req },
    res,
    () => { nexted = true; },
  );
  res.emit('finish');
  return { lines, nexted };
}

test('opening an Amazon card logs the open with the card key, device and result, never the token', () => {
  const { lines, nexted } = run({ method: 'GET', path: '/amazon-inbox/send', query: { k: 'abfdf9d7b5ee7394', t: 'secret-token' } });
  assert.ok(nexted);
  assert.deepStrictEqual(lines, [{
    action: 'tap-open', path: '/amazon-inbox/send', k: 'abfdf9d7b5ee7394', status: 200, ms: 250,
    ip: '100.101.102.103', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)',
  }]);
  assert.ok(!JSON.stringify(lines).includes('secret-token'));
});

test('pressing the button logs a press with the failure, and leaves the reply text out', () => {
  const { lines } = run({ method: 'POST', path: '/amazon-inbox/send', body: { k: 'abfdf9d7b5ee7394', t: 'secret-token', text: 'Hi, ...' } },
    { status: 500, locals: { tapError: 'Graph 401: token expired' } });
  assert.strictEqual(lines[0].action, 'tap-press');
  assert.strictEqual(lines[0].status, 500);
  assert.strictEqual(lines[0].error, 'Graph 401: token expired');
  assert.ok(!('text' in lines[0]) && !('t' in lines[0]));
});

test('every tap route is covered; tokens in the path are redacted; other routes are not logged', () => {
  for (const p of ['/sku-resolver/approve', '/discontinued/act', '/returns/approve', '/prozone/approve', '/prozone/decline', '/prozone/earnings', '/pickup/collected']) {
    assert.strictEqual(run({ method: 'GET', path: p }).lines.length, 1, p);
  }
  const fba = run({ method: 'GET', path: '/api/fba/auto-restock/approve/abc123secret' }).lines[0];
  assert.strictEqual(fba.path, '/api/fba/auto-restock/approve/:token');
  for (const p of ['/api/health', '/api/scheduled-run', '/', '/amazon-inbox/sendx']) {
    const r = run({ method: 'GET', path: p });
    assert.strictEqual(r.lines.length, 0, p);
    assert.ok(r.nexted);
  }
});

test('a broken audit log never breaks the page', () => {
  const res = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} });
  middleware(() => { throw new Error('disk full'); })({ method: 'GET', path: '/returns/approve', query: {}, headers: {}, socket: {} }, res, () => {});
  assert.doesNotThrow(() => res.emit('finish'));
});
