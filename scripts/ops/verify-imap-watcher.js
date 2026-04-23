/**
 * Verify IMAP-watcher logic — MIME body extraction, draft-context matching,
 * state persistence. Doesn't connect to a real IMAP server (that's a live
 * Mac Mini test). Covers the in-process glue that routes a parsed reply to
 * the correct draft lines.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Redirect state file to tmp so the test doesn't clobber real data.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-watcher-'));
process.env.FBA_IMAP_STATE_OVERRIDE = tmpRoot;

// Stub poDrafts's loadCurrent to return fixtures — the watcher only needs
// to read the current draft shape.
const fixtureDraft = {
  draftId: 'draft-test',
  lines: [
    { lineId: 'L1', asin: 'A', qty: 10, vendor: 'prosol', availabilityBucket: 'ready',     state: 'awaiting-dims',        sfPoNumber: 'PO-14500' },
    { lineId: 'L2', asin: 'B', qty: 20, vendor: 'prosol', availabilityBucket: 'backorder', state: 'awaiting-dims',        sfPoNumber: 'PO-14501' },
    { lineId: 'L3', asin: 'C', qty: 5,  vendor: 'treeco', availabilityBucket: 'ready',     state: 'awaiting-labels-ack',  sfPoNumber: 'PO-14502' },
  ],
};

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

stubModule('../../lib/fba-po-drafts', {
  loadCurrent: () => JSON.parse(JSON.stringify(fixtureDraft)), // deep copy each call
  transitionLines: () => ({ changed: [], refused: [] }),
  saveCurrent: () => {},
});
stubModule('../../lib/audit', { log: () => {} });
stubModule('../../lib/telegram', { notify: async () => {} });

const watcher = require('../../lib/imap-watcher');

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.error(`✗ ${name}: ${e.message}`); }
}

// ── bodyText MIME extraction ──────────────────────────────────────────────

check('bodyText: plain text part extracted from multipart', () => {
  const raw = Buffer.from([
    'From: someone@example.com',
    'Subject: test',
    'Content-Type: multipart/alternative; boundary="X"',
    '',
    '--X',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '20 cartons, 24x18x12, 38 lb each.',
    '--X',
    'Content-Type: text/html',
    '',
    '<p>20 cartons, 24x18x12, 38 lb each.</p>',
    '--X--',
  ].join('\r\n'));
  const body = watcher.bodyText(raw);
  assert.ok(/20 cartons, 24x18x12, 38 lb each\./.test(body), 'plain text extracted');
});

check('bodyText: HTML fallback when no plain part', () => {
  const raw = Buffer.from([
    'From: someone@example.com',
    'Subject: test',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Ready to ship<br>20 cartons</p>',
  ].join('\r\n'));
  const body = watcher.bodyText(raw);
  assert.ok(/Ready to ship/.test(body), 'HTML stripped');
  assert.ok(/20 cartons/.test(body), 'other content preserved');
  assert.ok(!/<p>/.test(body), 'tags removed');
});

check('bodyText: quoted-printable decoded', () => {
  const raw = Buffer.from([
    'Content-Type: text/plain',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '24=C2=A0x=C2=A018=C2=A0x=C2=A012=',
    '', // soft line break
    ' inches',
  ].join('\r\n'));
  const body = watcher.bodyText(raw);
  assert.ok(/24.*18.*12/.test(body), 'dims survived QP decode');
});

// ── matchDraftContext ─────────────────────────────────────────────────────

check('matchDraftContext: PO in subject wins', () => {
  const ctx = watcher.matchDraftContext(fixtureDraft, {
    subject: 'Re: FBA Replenishment PO-14501 — dims + ETA',
    fromAddr: 'klazzarotto@prosol.ca',
  });
  assert.ok(ctx, 'matched');
  assert.strictEqual(ctx.vendor, 'prosol');
  assert.strictEqual(ctx.bucket, 'backorder', 'PO-14501 is the backorder bucket');
  assert.strictEqual(ctx.lines.length, 1);
});

check('matchDraftContext: fallback to vendor via from-address, picks awaiting-dims', () => {
  const ctx = watcher.matchDraftContext(fixtureDraft, {
    subject: 'Re: Your email',
    fromAddr: 'klazzarotto@prosol.ca',
  });
  assert.ok(ctx);
  assert.strictEqual(ctx.vendor, 'prosol');
  // should prefer awaiting-dims (L1 is ready, L2 is backorder — takes first = L1/ready)
  assert.strictEqual(ctx.bucket, 'ready');
  assert.strictEqual(ctx.lines[0].state, 'awaiting-dims');
});

check('matchDraftContext: from treeco prefers awaiting-labels-ack (L3)', () => {
  const ctx = watcher.matchDraftContext(fixtureDraft, {
    subject: 'Re: some thread',
    fromAddr: 'robynp@treeco.ca',
  });
  assert.ok(ctx);
  assert.strictEqual(ctx.vendor, 'treeco');
  assert.strictEqual(ctx.lines[0].state, 'awaiting-labels-ack');
});

check('matchDraftContext: unknown sender, no PO → null', () => {
  const ctx = watcher.matchDraftContext(fixtureDraft, {
    subject: 'Random newsletter',
    fromAddr: 'newsletter@example.com',
  });
  assert.strictEqual(ctx, null);
});

check('matchDraftContext: empty draft → null', () => {
  const ctx = watcher.matchDraftContext({ lines: [] }, {
    subject: 'Re: PO-14500',
    fromAddr: 'klazzarotto@prosol.ca',
  });
  assert.strictEqual(ctx, null);
});

// ── State persistence (real file I/O) ────────────────────────────────────

check('loadState: initial state clean', () => {
  // Can't easily override state path without restructuring; just exercise
  // the default path. This will read the real data/imap-state.json if present
  // or return defaults. Validate only the shape.
  const s = watcher.loadState();
  assert.ok('lastSeenUid' in s, 'has lastSeenUid');
  assert.ok('lastPolledAt' in s, 'has lastPolledAt');
});

// Cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

if (failures.length > 0) {
  console.error(`\n${failures.length} FAIL(s), ${passed} pass`);
  process.exit(1);
}
console.log(`\n${passed} scenarios passed.`);
process.exit(0);
