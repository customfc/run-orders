/**
 * Verify mail-watcher internals that don't require live Graph API access:
 *   - getAuthUrl shape (all required params, encoded scopes, redirect URI)
 *   - bodyText handles { contentType, content } objects (HTML + text)
 *   - matchDraftContext same logic as imap-watcher
 *   - stripHtml basic behavior
 *
 * Live OAuth + Graph exercise is manual: hit /api/fba/mail-oauth/login from
 * a port-forwarded browser, then /api/fba/mail-poll to pull a real reply.
 */

const assert = require('assert');

// Set fake env so getAuthUrl works. Secret not strictly needed for this test.
process.env.MSGRAPH_CLIENT_ID = 'test-client';
process.env.MSGRAPH_TENANT_ID = 'test-tenant';
process.env.MSGRAPH_CLIENT_SECRET = 'test-secret';
process.env.MSGRAPH_REDIRECT_URI = 'http://localhost:3456/api/fba/mail-oauth/callback';

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}
stubModule('../../lib/fba-po-drafts', {
  loadCurrent: () => ({ draftId: 'test', lines: [
    { lineId: 'L1', vendor: 'prosol', availabilityBucket: 'ready',     state: 'awaiting-dims',       sfPoNumber: 'PO-9001' },
    { lineId: 'L2', vendor: 'treeco', availabilityBucket: 'ready',     state: 'awaiting-labels-ack', sfPoNumber: 'PO-9002' },
  ] }),
  transitionLines: () => ({ changed: [], refused: [] }),
  saveCurrent: () => {},
});
stubModule('../../lib/audit', { log: () => {} });
stubModule('../../lib/telegram', { notify: async () => {} });

const mw = require('../../lib/mail-watcher');

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.error(`✗ ${name}: ${e.message}`); }
}

// ── getAuthUrl ────────────────────────────────────────────────────────────

check('getAuthUrl: includes all required OAuth params', () => {
  const url = new URL(mw.getAuthUrl('state123'));
  assert.strictEqual(url.origin + url.pathname, 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/authorize');
  assert.strictEqual(url.searchParams.get('client_id'), 'test-client');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://localhost:3456/api/fba/mail-oauth/callback');
  assert.strictEqual(url.searchParams.get('response_mode'), 'query');
  assert.ok(url.searchParams.get('scope').includes('Mail.ReadWrite'));
  assert.ok(url.searchParams.get('scope').includes('Mail.Send'));
  assert.ok(url.searchParams.get('scope').includes('offline_access'));
  assert.strictEqual(url.searchParams.get('state'), 'state123');
  assert.strictEqual(url.searchParams.get('prompt'), 'select_account');
});

check('getAuthUrl: throws when MSGRAPH_CLIENT_ID missing', () => {
  const prev = process.env.MSGRAPH_CLIENT_ID;
  delete process.env.MSGRAPH_CLIENT_ID;
  let threw = false;
  try { mw.getAuthUrl(); } catch (e) { threw = /MSGRAPH_CLIENT_ID/.test(e.message); }
  process.env.MSGRAPH_CLIENT_ID = prev;
  assert.strictEqual(threw, true);
});

// ── bodyText ──────────────────────────────────────────────────────────────

check('bodyText: plain text passes through', () => {
  const body = mw.bodyText({ contentType: 'text', content: 'hello world' });
  assert.strictEqual(body, 'hello world');
});

check('bodyText: HTML stripped', () => {
  const body = mw.bodyText({ contentType: 'HTML', content: '<p>hello <strong>world</strong></p>' });
  assert.ok(/hello world/.test(body));
  assert.ok(!/<p>/.test(body));
});

check('bodyText: raw string passthrough', () => {
  assert.strictEqual(mw.bodyText('just a string'), 'just a string');
});

check('bodyText: null/undefined safe', () => {
  assert.strictEqual(mw.bodyText(null), '');
  assert.strictEqual(mw.bodyText(undefined), '');
});

// ── matchDraftContext ─────────────────────────────────────────────────────

check('matchDraftContext: PO subject match wins', () => {
  const draft = { lines: [
    { lineId: 'L1', vendor: 'prosol', availabilityBucket: 'ready',     state: 'awaiting-dims',       sfPoNumber: 'PO-9001' },
    { lineId: 'L2', vendor: 'treeco', availabilityBucket: 'ready',     state: 'awaiting-labels-ack', sfPoNumber: 'PO-9002' },
  ] };
  const ctx = mw.matchDraftContext(draft, { subject: 'Re: PO-9002 — ready', fromAddr: 'robynp@treeco.ca' });
  assert.strictEqual(ctx.vendor, 'treeco');
  assert.strictEqual(ctx.lines[0].lineId, 'L2');
});

check('matchDraftContext: vendor fallback via from-address', () => {
  const draft = { lines: [
    { lineId: 'L1', vendor: 'prosol', availabilityBucket: 'ready', state: 'awaiting-dims', sfPoNumber: 'PO-9001' },
  ] };
  const ctx = mw.matchDraftContext(draft, { subject: 'Re: unrelated thread', fromAddr: 'klazzarotto@prosol.ca' });
  assert.strictEqual(ctx.vendor, 'prosol');
  assert.strictEqual(ctx.bucket, 'ready');
});

check('matchDraftContext: no match', () => {
  const draft = { lines: [] };
  assert.strictEqual(mw.matchDraftContext(draft, { subject: 'hi', fromAddr: 'a@b' }), null);
});

// ── stripHtml ─────────────────────────────────────────────────────────────

check('stripHtml: entities decoded', () => {
  const s = mw.stripHtml('<p>Tom &amp; Jerry &lt;rocks&gt;</p>');
  assert.strictEqual(s, 'Tom & Jerry <rocks>');
});

check('stripHtml: <br> → newline', () => {
  const s = mw.stripHtml('line1<br>line2<br/>line3');
  assert.ok(/line1\nline2\nline3/.test(s));
});

// ── Summary ──────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} FAIL(s), ${passed} pass`);
  process.exit(1);
}
console.log(`\n${passed} scenarios passed.`);
process.exit(0);
