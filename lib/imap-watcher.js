/**
 * IMAP watcher for vendor replies. Polls mac@customfc.ca INBOX looking for
 * replies to our FBA PO-request emails (Kaitlyn at Prosol, Robyn at Treeco
 * — both reply-all so cc:mac@ lands here). Feeds each reply body into
 * lib/vendor-reply-parser and fires a callback (or directly transitions
 * state) based on mode.
 *
 * Modes (gated by env):
 *   FBA_IMAP_POLL=1          → watcher starts at server boot
 *   FBA_IMAP_AUTO_INGEST=1   → auto-advances state on high-confidence parse;
 *                              absent this, log-only: parse, write to audit,
 *                              Telegram debug notify, don't touch draft state.
 *
 * Watches for:
 *  - Dims replies → parseDims; transitions awaiting-dims → awaiting-labels-ack
 *    via the same confirm-dims path as the HTTP endpoint.
 *  - Ready-ack replies → parseReadyAck; transitions awaiting-labels-ack →
 *    awaiting-pickup. (Wait — actually ready-ack comes AFTER we send labels,
 *    so lines would be in awaiting-labels-ack. Correct.)
 *
 * Idempotency: we remember the last processed UID per mailbox in
 * data/imap-state.json. Restarting the watcher picks up where it left off.
 * No auto-flag / no-auto-delete; messages stay visible in the inbox.
 */

const fs = require('fs');
const path = require('path');
const parser = require('./vendor-reply-parser');
const poDrafts = require('./fba-po-drafts');
const audit = require('./audit');
const telegram = require('./telegram');

let ImapFlow;
try { ({ ImapFlow } = require('imapflow')); } catch { ImapFlow = null; }

const STATE_PATH = path.join(__dirname, '..', 'data', 'imap-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastSeenUid: 0, lastPolledAt: null }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function makeClient() {
  if (!ImapFlow) throw new Error('imapflow not installed (npm install imapflow)');
  const host = process.env.MAC_IMAP_HOST;
  const port = Number(process.env.MAC_IMAP_PORT || 993);
  const user = process.env.MAC_IMAP_USER;
  const pass = process.env.MAC_IMAP_PASSWORD;
  if (!host || !user || !pass) throw new Error('MAC_IMAP_HOST / MAC_IMAP_USER / MAC_IMAP_PASSWORD required');
  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,  // quiet; we log only events we care about
  });
}

// Extract plain-text body from an imapflow message source buffer. We prefer
// the text/plain part when available, fall back to HTML stripped down. Handles
// the common cases; for hairier MIME we'd pull in a parser, but vendor
// replies are simple prose.
function bodyText(msgSource) {
  const raw = msgSource.toString('utf8');
  // Find text/plain part if present
  const plainMatch = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|$)/i);
  if (plainMatch) return decodeQP(plainMatch[1]);
  const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|$)/i);
  if (htmlMatch) return stripHtml(decodeQP(htmlMatch[1]));
  // No MIME parts — treat whole body after headers as plain
  const bodyStart = raw.indexOf('\r\n\r\n');
  return bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;
}

function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s) {
  return s
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

// Given a parsed reply and the current draft, find which (vendor, bucket)
// it's responding to. Match by PO number in subject first, fall back to the
// most-recently-sent matching state. Returns null if no match.
function matchDraftContext(draft, { subject, fromAddr }) {
  if (!draft || !draft.lines?.length) return null;
  const poRef = parser.matchPoFromSubject(subject);
  if (poRef) {
    const lines = draft.lines.filter((l) => l.sfPoNumber === poRef);
    if (lines.length) {
      return { vendor: lines[0].vendor, bucket: lines[0].availabilityBucket, lines };
    }
  }
  // Fall back: match by vendor via from-address
  let vendor = null;
  if (/prosol\.ca/i.test(fromAddr)) vendor = 'prosol';
  else if (/treeco\.ca/i.test(fromAddr)) vendor = 'treeco';
  if (!vendor) return null;
  // Prefer lines in awaiting-dims (they're waiting on this reply) over
  // awaiting-labels-ack (also valid for ready-ack replies).
  const awaiting = draft.lines.filter((l) => l.vendor === vendor && l.state === 'awaiting-dims');
  if (awaiting.length) {
    return { vendor, bucket: awaiting[0].availabilityBucket, lines: awaiting };
  }
  const ack = draft.lines.filter((l) => l.vendor === vendor && l.state === 'awaiting-labels-ack');
  if (ack.length) {
    return { vendor, bucket: ack[0].availabilityBucket, lines: ack };
  }
  return null;
}

// One poll cycle: fetch messages since lastSeenUid, parse, dispatch.
async function pollOnce({ autoIngest } = {}) {
  const client = makeClient();
  const state = loadState();
  const summary = { seen: 0, parsed: 0, applied: 0, skipped: 0, errors: [] };

  try {
    await client.connect();
  } catch (e) {
    // imapflow surfaces M365 auth failures as a generic "Command failed"
    // with a .responseText or .response on the error. Bubble both.
    const detail = [e.message, e.response, e.responseText, e.authenticationFailed ? 'AUTHENTICATION FAILED' : null].filter(Boolean).join(' | ');
    summary.errors.push(`connect: ${detail}`);
    audit.log({ action: 'imap-poll', success: false, step: 'connect', error: detail });
    try { await client.logout(); } catch {}
    return summary;
  }
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Fetch all UIDs greater than lastSeen (first boot: fetch last 48h only
      // to avoid chewing through months of inbox on day one).
      const searchCriteria = state.lastSeenUid > 0
        ? { uid: `${state.lastSeenUid + 1}:*` }
        : { since: new Date(Date.now() - 48 * 3600_000) };

      for await (const msg of client.fetch(searchCriteria, { source: true, envelope: true, uid: true })) {
        summary.seen++;
        state.lastSeenUid = Math.max(state.lastSeenUid, msg.uid);

        const subject = msg.envelope?.subject || '';
        const fromAddr = msg.envelope?.from?.[0]?.address || '';

        // Only interested in replies referencing a FBA PO we sent.
        const poRef = parser.matchPoFromSubject(subject);
        const looksLikeVendor = /prosol\.ca|treeco\.ca/i.test(fromAddr);
        if (!poRef && !looksLikeVendor) { summary.skipped++; continue; }

        const body = bodyText(msg.source);
        const dims = parser.parseDims(body);
        const ack = parser.parseReadyAck(body);

        summary.parsed++;

        const draft = poDrafts.loadCurrent();
        const ctx = matchDraftContext(draft, { subject, fromAddr });

        const event = {
          at: new Date().toISOString(),
          uid: msg.uid,
          from: fromAddr,
          subject,
          matchedPo: poRef,
          matchedContext: ctx ? { vendor: ctx.vendor, bucket: ctx.bucket, lineCount: ctx.lines.length, firstState: ctx.lines[0].state } : null,
          parsedDims: dims ? { count: dims.count, L: dims.L, W: dims.W, H: dims.H, weightLb: dims.weightLb, parseConfidence: dims.parseConfidence } : null,
          parsedAck: ack.ready ? { matchedPhrase: ack.matchedPhrase, parseConfidence: ack.parseConfidence } : null,
        };
        audit.log({ action: 'imap-reply-parsed', ...event });

        // Telegram debug notification — visible to user regardless of mode.
        try {
          const bits = [];
          if (event.matchedContext) bits.push(`${event.matchedContext.vendor}/${event.matchedContext.bucket} (${event.matchedContext.firstState})`);
          if (dims && dims.parseConfidence >= 0.6) bits.push(`dims: ${dims.count} × ${dims.L}×${dims.W}×${dims.H} @ ${dims.weightLb}lb (conf ${dims.parseConfidence.toFixed(2)})`);
          if (ack.ready) bits.push(`READY ack (conf ${ack.parseConfidence.toFixed(2)})`);
          if (bits.length) {
            await telegram.notify('debug', `IMAP reply — ${poRef || fromAddr}`, bits.join('\n') + `\n\n${autoIngest ? 'AUTO-INGEST ON' : 'log-only mode'}`);
          }
        } catch {}

        // Auto-ingest gated: only apply state transitions when explicitly opted in.
        if (!autoIngest || !ctx) { continue; }
        if (ctx.lines[0].state === 'awaiting-dims' && dims && dims.parseConfidence >= 0.8 && dims.count && dims.L && dims.W && dims.H && dims.weightLb) {
          const { transitionLines } = poDrafts;
          const { changed } = transitionLines(
            draft,
            ctx.lines.map((l) => l.lineId),
            'awaiting-labels-ack',
            { patch: { cartonDims: { ...dims, recordedAt: new Date().toISOString(), source: 'imap-auto' } } },
          );
          if (changed.length) {
            poDrafts.saveCurrent(draft);
            audit.log({ action: 'imap-auto-ingest-dims', po: poRef, vendor: ctx.vendor, bucket: ctx.bucket, lineCount: changed.length });
            summary.applied++;
          }
        } else if (ctx.lines[0].state === 'awaiting-labels-ack' && ack.ready && ack.parseConfidence >= 0.8) {
          const { transitionLines } = poDrafts;
          const { changed } = transitionLines(
            draft,
            ctx.lines.map((l) => l.lineId),
            'awaiting-pickup',
          );
          if (changed.length) {
            poDrafts.saveCurrent(draft);
            audit.log({ action: 'imap-auto-ingest-ready-ack', po: poRef, vendor: ctx.vendor, bucket: ctx.bucket, lineCount: changed.length });
            summary.applied++;
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    summary.errors.push(e.message);
    audit.log({ action: 'imap-poll', success: false, error: e.message });
  } finally {
    try { await client.logout(); } catch {}
  }
  state.lastPolledAt = new Date().toISOString();
  saveState(state);
  return summary;
}

// Long-running poll loop (every 5 min). Started from server.js when
// FBA_IMAP_POLL=1.
function startPolling({ intervalMs = 5 * 60 * 1000, autoIngest = false } = {}) {
  if (!ImapFlow) {
    console.warn('[imap-watcher] imapflow not installed — watcher disabled');
    return { stop: () => {} };
  }
  if (!process.env.MAC_IMAP_USER || !process.env.MAC_IMAP_PASSWORD) {
    console.warn('[imap-watcher] MAC_IMAP_USER/PASSWORD missing — watcher disabled');
    return { stop: () => {} };
  }
  console.log(`[imap-watcher] polling ${process.env.MAC_IMAP_USER} every ${Math.round(intervalMs/1000)}s · auto-ingest=${autoIngest ? 'ON' : 'OFF (log-only)'}`);
  let running = true;
  const tick = async () => {
    if (!running) return;
    try {
      const s = await pollOnce({ autoIngest });
      if (s.seen) console.log(`[imap-watcher] poll: seen=${s.seen} parsed=${s.parsed} applied=${s.applied} skipped=${s.skipped}`);
    } catch (e) {
      console.error('[imap-watcher] poll error:', e.message);
    } finally {
      if (running) setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 5000); // small startup delay so server fully boots first
  return { stop: () => { running = false; } };
}

module.exports = { pollOnce, startPolling, matchDraftContext, bodyText, loadState, saveState };
