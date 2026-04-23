/**
 * Microsoft Graph mail watcher — replaces lib/imap-watcher for tenants where
 * Basic Auth for IMAP is blocked (Custom Flooring Centres tenant, confirmed
 * 2026-04-23 via LogonDenied-BasicAuthBlocked response).
 *
 * Modern auth via OAuth2 authorization-code flow:
 *   1. User visits /api/fba/mail-oauth/login on the server (one-time setup;
 *      requires SSH port-forward 3456:localhost:3456 so the localhost
 *      redirect-URI Microsoft requires actually resolves).
 *   2. Microsoft consent screen → callback → server exchanges code for
 *      access_token (1h) + refresh_token (up to 90 days, renewable by use).
 *   3. refresh_token persisted to data/graph-tokens.json.
 *   4. Poll loop refreshes access_token on each cycle, reads inbox via
 *      Graph API, feeds bodies to lib/vendor-reply-parser.
 *
 * Exports the same interface as lib/imap-watcher (pollOnce, startPolling,
 * matchDraftContext, bodyText) so the server startup path doesn't care which
 * backend is wired.
 *
 * Also exposes sendMail + moveMessage — uses Mail.Send / Mail.ReadWrite for
 * future automation (auto-ack vendor replies, archive complete POs, etc.).
 */

const fs = require('fs');
const path = require('path');
const parser = require('./vendor-reply-parser');
const poDrafts = require('./fba-po-drafts');
const audit = require('./audit');
const telegram = require('./telegram');

const TOKEN_PATH = path.join(__dirname, '..', 'data', 'graph-tokens.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'mail-watcher-state.json');
const AUTHORITY = () => `https://login.microsoftonline.com/${process.env.MSGRAPH_TENANT_ID}`;
const CLIENT_ID = () => process.env.MSGRAPH_CLIENT_ID;
const CLIENT_SECRET = () => process.env.MSGRAPH_CLIENT_SECRET;
const REDIRECT_URI = () => process.env.MSGRAPH_REDIRECT_URI || 'http://localhost:3456/api/fba/mail-oauth/callback';
const SCOPES = 'offline_access Mail.ReadWrite Mail.Send User.Read';

// ── Token persistence ─────────────────────────────────────────────────────

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  // Restrictive perms — contains refresh_token which is as good as a password.
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastSeenAt: null, lastSeenIds: [], lastPolledAt: null }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── OAuth2 auth-code flow helpers ─────────────────────────────────────────

function getAuthUrl(state = 'x') {
  if (!CLIENT_ID() || !process.env.MSGRAPH_TENANT_ID) throw new Error('MSGRAPH_CLIENT_ID / MSGRAPH_TENANT_ID missing');
  const url = new URL(`${AUTHORITY()}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', CLIENT_ID());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI());
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  // prompt=select_account ensures the user can confirm they're signing in as
  // mac@customfc.ca even if their browser has a different M365 session cached.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    redirect_uri: REDIRECT_URI(),
    grant_type: 'authorization_code',
    scope: SCOPES,
  });
  const res = await fetch(`${AUTHORITY()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await res.json();
  if (!res.ok) {
    const err = new Error(`token exchange failed: ${payload.error} — ${payload.error_description || 'unknown'}`);
    err.payload = payload;
    throw err;
  }
  const tokens = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + (payload.expires_in * 1000) - 60_000, // 1min buffer
    scope: payload.scope,
    obtained_at: new Date().toISOString(),
  };
  saveTokens(tokens);
  return tokens;
}

async function getAccessToken() {
  const t = loadTokens();
  if (!t || !t.refresh_token) {
    throw new Error('no refresh token — visit /api/fba/mail-oauth/login to authorize');
  }
  if (t.access_token && t.expires_at && Date.now() < t.expires_at) {
    return t.access_token;
  }
  // Refresh
  const body = new URLSearchParams({
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token',
    scope: SCOPES,
  });
  const res = await fetch(`${AUTHORITY()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await res.json();
  if (!res.ok) {
    const err = new Error(`token refresh failed: ${payload.error} — ${payload.error_description || 'unknown'}. May need to re-authorize via /api/fba/mail-oauth/login.`);
    err.payload = payload;
    throw err;
  }
  const next = {
    access_token: payload.access_token,
    // Microsoft rotates refresh tokens on each use; fall back to the old one if not rotated.
    refresh_token: payload.refresh_token || t.refresh_token,
    expires_at: Date.now() + (payload.expires_in * 1000) - 60_000,
    scope: payload.scope || t.scope,
    obtained_at: t.obtained_at,
    refreshed_at: new Date().toISOString(),
  };
  saveTokens(next);
  return next.access_token;
}

// ── Graph API wrapper ─────────────────────────────────────────────────────

async function graphFetch(graphPath, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok && res.status !== 202 /* sendMail accepts */) {
    const txt = await res.text();
    const err = new Error(`graph ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    err.bodyText = txt;
    throw err;
  }
  return res;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Expose bodyText under the same name as imap-watcher. For Graph, message
// body already comes structured on the message object, so callers pass
// msg.body (an object with {contentType, content}) or a raw string.
function bodyText(msgBody) {
  if (!msgBody) return '';
  if (typeof msgBody === 'string') return msgBody;
  if (msgBody.contentType && msgBody.contentType.toLowerCase() === 'html') return stripHtml(msgBody.content || '');
  return msgBody.content || '';
}

// ── Draft context matching (same shape as imap-watcher) ──────────────────

function matchDraftContext(draft, { subject, fromAddr }) {
  if (!draft || !draft.lines?.length) return null;
  const poRef = parser.matchPoFromSubject(subject);
  if (poRef) {
    const lines = draft.lines.filter((l) => l.sfPoNumber === poRef);
    if (lines.length) return { vendor: lines[0].vendor, bucket: lines[0].availabilityBucket, lines };
  }
  let vendor = null;
  if (/prosol\.ca/i.test(fromAddr)) vendor = 'prosol';
  else if (/treeco\.ca/i.test(fromAddr)) vendor = 'treeco';
  if (!vendor) return null;
  const awaiting = draft.lines.filter((l) => l.vendor === vendor && l.state === 'awaiting-dims');
  if (awaiting.length) return { vendor, bucket: awaiting[0].availabilityBucket, lines: awaiting };
  const ack = draft.lines.filter((l) => l.vendor === vendor && l.state === 'awaiting-labels-ack');
  if (ack.length) return { vendor, bucket: ack[0].availabilityBucket, lines: ack };
  return null;
}

// ── One poll cycle ────────────────────────────────────────────────────────

async function pollOnce({ autoIngest } = {}) {
  const state = loadState();
  const summary = { seen: 0, parsed: 0, applied: 0, skipped: 0, errors: [] };

  try {
    // Filter by receivedDateTime > lastSeenAt when we have one; else fetch
    // the most recent 50 messages (first run) so we don't walk forever.
    const filterClause = state.lastSeenAt ? `&$filter=receivedDateTime gt ${encodeURIComponent(state.lastSeenAt)}` : '';
    const res = await graphFetch(
      `/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc${filterClause}&$select=id,internetMessageId,subject,from,receivedDateTime,body,conversationId`,
    );
    const payload = await res.json();
    const messages = payload.value || [];
    // Graph returns newest-first; process oldest-first so state.lastSeenAt
    // advances monotonically.
    messages.reverse();

    for (const msg of messages) {
      summary.seen++;
      const recv = msg.receivedDateTime;
      if (!state.lastSeenAt || recv > state.lastSeenAt) state.lastSeenAt = recv;
      if (state.lastSeenIds.includes(msg.id)) { summary.skipped++; continue; }
      state.lastSeenIds.push(msg.id);

      const subject = msg.subject || '';
      const fromAddr = msg.from?.emailAddress?.address || '';
      const poRef = parser.matchPoFromSubject(subject);
      const looksLikeVendor = /prosol\.ca|treeco\.ca/i.test(fromAddr);
      if (!poRef && !looksLikeVendor) { summary.skipped++; continue; }

      const body = bodyText(msg.body);
      const dims = parser.parseDims(body);
      const ack = parser.parseReadyAck(body);
      summary.parsed++;

      const draft = poDrafts.loadCurrent();
      const ctx = matchDraftContext(draft, { subject, fromAddr });

      const event = {
        at: new Date().toISOString(),
        graphId: msg.id,
        internetMessageId: msg.internetMessageId,
        from: fromAddr,
        subject,
        matchedPo: poRef,
        matchedContext: ctx ? { vendor: ctx.vendor, bucket: ctx.bucket, lineCount: ctx.lines.length, firstState: ctx.lines[0].state } : null,
        parsedDims: dims ? { count: dims.count, L: dims.L, W: dims.W, H: dims.H, weightLb: dims.weightLb, parseConfidence: dims.parseConfidence } : null,
        parsedAck: ack.ready ? { matchedPhrase: ack.matchedPhrase, parseConfidence: ack.parseConfidence } : null,
      };
      audit.log({ action: 'graph-reply-parsed', ...event });

      try {
        const bits = [];
        if (event.matchedContext) bits.push(`${event.matchedContext.vendor}/${event.matchedContext.bucket} (${event.matchedContext.firstState})`);
        if (dims && dims.parseConfidence >= 0.6) bits.push(`dims: ${dims.count} × ${dims.L}×${dims.W}×${dims.H} @ ${dims.weightLb}lb (conf ${dims.parseConfidence.toFixed(2)})`);
        if (ack.ready) bits.push(`READY ack (conf ${ack.parseConfidence.toFixed(2)})`);
        if (bits.length) {
          await telegram.notify('debug', `Mail reply — ${poRef || fromAddr}`, bits.join('\n') + `\n\n${autoIngest ? 'AUTO-INGEST ON' : 'log-only'}`);
        }
      } catch {}

      if (!autoIngest || !ctx) continue;

      if (ctx.lines[0].state === 'awaiting-dims' && dims && dims.parseConfidence >= 0.8 && dims.count && dims.L && dims.W && dims.H && dims.weightLb) {
        const { changed } = poDrafts.transitionLines(
          draft,
          ctx.lines.map((l) => l.lineId),
          'awaiting-labels-ack',
          { patch: { cartonDims: { ...dims, recordedAt: new Date().toISOString(), source: 'graph-auto' } } },
        );
        if (changed.length) {
          poDrafts.saveCurrent(draft);
          audit.log({ action: 'graph-auto-ingest-dims', po: poRef, vendor: ctx.vendor, bucket: ctx.bucket, lineCount: changed.length });
          summary.applied++;
        }
      } else if (ctx.lines[0].state === 'awaiting-labels-ack' && ack.ready && ack.parseConfidence >= 0.8) {
        const { changed } = poDrafts.transitionLines(
          draft,
          ctx.lines.map((l) => l.lineId),
          'awaiting-pickup',
        );
        if (changed.length) {
          poDrafts.saveCurrent(draft);
          audit.log({ action: 'graph-auto-ingest-ready-ack', po: poRef, vendor: ctx.vendor, bucket: ctx.bucket, lineCount: changed.length });
          summary.applied++;
        }
      }
    }

    // Bound the dedupe set
    if (state.lastSeenIds.length > 300) state.lastSeenIds = state.lastSeenIds.slice(-300);
  } catch (e) {
    summary.errors.push(e.message);
    audit.log({ action: 'graph-poll', success: false, error: e.message });
  }
  state.lastPolledAt = new Date().toISOString();
  saveState(state);
  return summary;
}

// ── Poll loop (boot-time) ────────────────────────────────────────────────

function startPolling({ intervalMs = 5 * 60 * 1000, autoIngest = false } = {}) {
  if (!CLIENT_ID() || !process.env.MSGRAPH_TENANT_ID) {
    console.warn('[mail-watcher] MSGRAPH env not configured — watcher disabled');
    return { stop: () => {} };
  }
  if (!loadTokens()) {
    console.warn('[mail-watcher] no refresh token yet — visit /api/fba/mail-oauth/login to authorize (watcher idle until then)');
  } else {
    console.log(`[mail-watcher] polling mac@customfc.ca every ${Math.round(intervalMs/1000)}s · auto-ingest=${autoIngest ? 'ON' : 'OFF (log-only)'}`);
  }
  let running = true;
  const tick = async () => {
    if (!running) return;
    // Skip if no tokens — user hasn't authorized yet.
    if (!loadTokens()) { if (running) setTimeout(tick, intervalMs); return; }
    try {
      const s = await pollOnce({ autoIngest });
      if (s.seen) console.log(`[mail-watcher] poll: seen=${s.seen} parsed=${s.parsed} applied=${s.applied} skipped=${s.skipped}`);
    } catch (e) {
      console.error('[mail-watcher] poll error:', e.message);
    } finally {
      if (running) setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 5000);
  return { stop: () => { running = false; } };
}

// ── Send + move helpers (Mail.Send / Mail.ReadWrite) ──────────────────────

async function sendMail({ to, cc, bcc, subject, html, text, inReplyTo, references, saveToSentItems = true }) {
  const message = {
    subject,
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients: (Array.isArray(to) ? to : [to]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } })),
    ccRecipients: cc ? (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } })) : [],
    bccRecipients: bcc ? (Array.isArray(bcc) ? bcc : [bcc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } })) : [],
  };
  if (inReplyTo) {
    message.internetMessageHeaders = [
      { name: 'In-Reply-To', value: inReplyTo },
      { name: 'References', value: references || inReplyTo },
    ];
  }
  await graphFetch('/me/sendMail', { method: 'POST', body: JSON.stringify({ message, saveToSentItems }) });
  audit.log({ action: 'graph-send-mail', to, subject, inReplyTo: !!inReplyTo });
  return { ok: true };
}

async function moveMessage(graphId, destFolder = 'archive') {
  // destFolder: well-known ('archive', 'deleteditems', 'junkemail') or folder ID.
  const res = await graphFetch(`/me/messages/${encodeURIComponent(graphId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destFolder }),
  });
  const data = await res.json();
  audit.log({ action: 'graph-move-mail', graphId, destFolder, newId: data.id });
  return data;
}

module.exports = {
  // OAuth
  getAuthUrl,
  exchangeCodeForTokens,
  getAccessToken,
  loadTokens,
  saveTokens,
  // Watcher
  pollOnce,
  startPolling,
  loadState,
  saveState,
  // Internals useful for tests/integration
  matchDraftContext,
  bodyText,
  stripHtml,
  graphFetch,
  // Send + cleanup helpers
  sendMail,
  moveMessage,
};
