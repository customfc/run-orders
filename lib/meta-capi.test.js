'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const capi = require('./meta-capi');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('hash: lower-cases and trims before hashing, and leaves blanks alone', () => {
  assert.strictEqual(capi.hash('  Dale@BurkeTile.CA '), sha('dale@burketile.ca'));
  assert.strictEqual(capi.hash(''), undefined);
  assert.strictEqual(capi.hash(null), undefined);
});

test('hashPhone: digits only, Canadian country code added to a bare 10-digit number', () => {
  assert.strictEqual(capi.hashPhone('(604) 555-0101'), sha('16045550101'));
  assert.strictEqual(capi.hashPhone('16045550101'), sha('16045550101'));
  assert.strictEqual(capi.hashPhone(''), undefined);
});

test('clickIds: _fbc passes through, a bare fbclid is rebuilt into one, missing is missing', () => {
  assert.deepStrictEqual(capi.clickIds({ fbc: 'fb.1.111.AbC', fbp: 'fb.1.222.333' }), { fbc: 'fb.1.111.AbC', fbp: 'fb.1.222.333' });
  assert.deepStrictEqual(capi.clickIds({ fbclid: 'AbC', now: 999 }), { fbc: 'fb.1.999.AbC' });
  assert.deepStrictEqual(capi.clickIds({}), {});
});

test('userData: never sends a raw identifier, and drops what it does not have', () => {
  const u = capi.userData({ email: 'Dale@BurkeTile.ca', name: 'Dale Burke', province: 'ON', phone: '' });
  assert.strictEqual(u.em, sha('dale@burketile.ca'));
  assert.strictEqual(u.fn, sha('dale'));
  assert.strictEqual(u.ln, sha('burke'));
  assert.strictEqual(u.country, sha('ca'));
  assert.ok(!('ph' in u), 'no blank phone key');
  assert.ok(!JSON.stringify(u).includes('BurkeTile'), 'raw email must never appear in the payload');
  assert.ok(!JSON.stringify(u).includes('Dale'), 'raw name must never appear in the payload');
});

test('prozoneLead: the application id is the event id, so a resend deduplicates', () => {
  const e = capi.prozoneLead({ email: 'a@b.ca', national: true }, { id: 'pz-abc123' });
  assert.strictEqual(e.event_name, 'Lead');
  assert.strictEqual(e.event_id, 'pz-abc123');
  assert.strictEqual(e.custom_data.content_name, 'ProZone application');
  assert.match(e.event_source_url, /prozone-apply/);
});

test('prozoneLead: a Coast application is tagged and sourced separately', () => {
  const e = capi.prozoneLead({ email: 'a@b.ca', national: false }, { id: 'pz-coast' });
  assert.strictEqual(e.custom_data.content_name, 'ProZone Coast application');
  assert.match(e.event_source_url, /prozone-sechelt/);
});

test('sendEvents: stays shadow unless META_CAPI_LIVE is 1', async () => {
  let called = false;
  const r = await capi.sendEvents(capi.prozoneLead({ email: 'a@b.ca' }, { id: 'x' }), {
    fetchImpl: async () => { called = true; }, log: () => {}, pixel: '1', token: 't', live: false,
  });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'shadow');
  assert.strictEqual(called, false, 'shadow must not call Meta');
});

test('sendEvents: skips quietly when it is not configured', async () => {
  const r = await capi.sendEvents(capi.prozoneLead({ email: 'a@b.ca' }, { id: 'x' }), {
    fetchImpl: async () => { throw new Error('should not be called'); }, log: () => {}, pixel: '', token: '', live: true,
  });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /not set/);
});

test('sendEvents: posts to the pixel and reports what Meta received', async () => {
  let url = null; let body = null;
  const r = await capi.sendEvents(capi.prozoneLead({ email: 'a@b.ca' }, { id: 'pz-1' }), {
    fetchImpl: async (u, i) => { url = u; body = JSON.parse(i.body); return { json: async () => ({ events_received: 1, fbtrace_id: 'tr' }) }; },
    log: () => {}, pixel: '653240902060209', token: 'tok', live: true,
  });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.received, 1);
  assert.match(url, /653240902060209\/events$/);
  assert.strictEqual(body.data[0].event_name, 'Lead');
  assert.strictEqual(body.access_token, 'tok');
  assert.ok(!('test_event_code' in body), 'no test code unless one is configured');
});

test('sendEvents: a Meta error is reported, never thrown at the caller', async () => {
  const r = await capi.sendEvents(capi.prozoneLead({ email: 'a@b.ca' }, { id: 'pz-1' }), {
    fetchImpl: async () => ({ json: async () => ({ error: { message: 'Invalid parameter' } }) }),
    log: () => {}, pixel: 'p', token: 't', live: true,
  });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /Invalid parameter/);
});

test('sendEvents: a network failure is reported, never thrown at the caller', async () => {
  const r = await capi.sendEvents(capi.prozoneLead({ email: 'a@b.ca' }, { id: 'pz-1' }), {
    fetchImpl: async () => { throw new Error('ECONNRESET'); }, log: () => {}, pixel: 'p', token: 't', live: true,
  });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /ECONNRESET/);
});
