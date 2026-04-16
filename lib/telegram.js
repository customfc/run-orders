/**
 * Telegram ops alerts.
 * Single outbound notify() helper; failed sends spool to data/telegram-outbox.jsonl
 * for later retry by drainOutbox() (called periodically from server.js).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OUTBOX = path.join(__dirname, '..', 'data', 'telegram-outbox.jsonl');

const SEVERITY = {
  halt:   { prefix: '🚨 [HALT]' },
  attn:   { prefix: '⚠️ [ATTN]' },
  ok:     { prefix: '✅ [OK]' },
  debug:  { prefix: '🔧 [DEBUG]' },
};

function send({ token, chatId, text }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          resolve({ ok: !!parsed.ok, status: res.statusCode, body: parsed });
        } catch {
          resolve({ ok: false, status: res.statusCode, body: d });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function spool(entry) {
  try {
    const dir = path.dirname(OUTBOX);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(OUTBOX, JSON.stringify(entry) + '\n');
  } catch {}
}

/**
 * Send an ops alert. Non-throwing — failures spool to disk.
 * @param {'halt'|'attn'|'ok'|'debug'} severity
 * @param {string} subject  - one-line headline, shown in bold on Telegram
 * @param {string} body     - free-form markdown-safe body
 */
async function notify(severity, subject, body = '') {
  if (!TOKEN || !CHAT_ID) {
    // Missing creds — always spool so we don't silently lose alerts
    spool({ ts: new Date().toISOString(), severity, subject, body, reason: 'no_creds' });
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' };
  }
  const meta = SEVERITY[severity] || SEVERITY.debug;
  const text = [
    `${meta.prefix} ${subject}`,
    body ? '' : null,
    body || null,
  ].filter((x) => x !== null).join('\n');

  const res = await send({ token: TOKEN, chatId: CHAT_ID, text });
  if (!res.ok) {
    spool({ ts: new Date().toISOString(), severity, subject, body, text, send_error: res.error || res.body });
  }
  return res;
}

/**
 * Try to re-deliver anything in the outbox. Safe to call periodically.
 * Rewrites the outbox file with only the still-failing entries.
 */
async function drainOutbox() {
  if (!TOKEN || !CHAT_ID) return { attempted: 0, sent: 0, remaining: 0 };
  if (!fs.existsSync(OUTBOX)) return { attempted: 0, sent: 0, remaining: 0 };

  let lines;
  try { lines = fs.readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean); } catch { return { attempted: 0, sent: 0, remaining: 0 }; }
  if (!lines.length) return { attempted: 0, sent: 0, remaining: 0 };

  const still = [];
  let sent = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const text = entry.text || `${SEVERITY[entry.severity]?.prefix || '🔧'} ${entry.subject}${entry.body ? '\n\n' + entry.body : ''}`;
    const res = await send({ token: TOKEN, chatId: CHAT_ID, text });
    if (res.ok) sent++;
    else still.push(line);
  }
  fs.writeFileSync(OUTBOX, still.length ? still.join('\n') + '\n' : '');
  return { attempted: lines.length, sent, remaining: still.length };
}

// ── Incoming command poller ──────────────────────────────────────────────────
//
// Polls getUpdates every POLL_MS seconds. Dispatches text messages from the
// allowed chat_id to the provided onCommand handler. Persists last update_id
// so restarts don't re-process old messages.

const STATE_FILE = path.join(__dirname, '..', 'data', 'telegram-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastUpdateId: 0 }; }
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function getUpdates(token, offset) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/getUpdates?timeout=25&offset=${offset}`,
      method: 'GET',
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ ok: false, body: d }); }
      });
    });
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

/**
 * Start a long-poll loop against getUpdates.
 * @param {object} opts
 * @param {string|number} opts.allowedChatId  only messages from this chat are dispatched
 * @param {(command: string, args: string[], msg: object) => Promise<string|void>} opts.onCommand
 *        handler returns a reply string (auto-sent) or void
 */
function startPolling({ allowedChatId, onCommand }) {
  if (!TOKEN || !CHAT_ID) {
    console.log('[telegram] polling disabled — no TOKEN/CHAT_ID');
    return { stop: () => {} };
  }
  const allowed = String(allowedChatId || CHAT_ID);
  let state = loadState();
  let running = true;

  async function loop() {
    while (running) {
      const res = await getUpdates(TOKEN, state.lastUpdateId + 1);
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of (res.result || [])) {
        state.lastUpdateId = Math.max(state.lastUpdateId, u.update_id);
        saveState(state);
        const msg = u.message || u.edited_message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat?.id) !== allowed) {
          // ignore messages from other chats; don't reveal bot behavior
          continue;
        }
        const raw = msg.text.trim();
        const parts = raw.split(/\s+/);
        const command = parts[0].replace(/^\//, '').toLowerCase();
        const args = parts.slice(1);
        try {
          const reply = await onCommand(command, args, msg);
          if (reply) await send({ token: TOKEN, chatId: CHAT_ID, text: reply });
        } catch (err) {
          await notify('attn', `Command /${command} failed`, String(err.message || err));
        }
      }
    }
  }
  loop().catch(() => {});
  console.log('[telegram] command polling started (chat_id=' + allowed + ')');
  return { stop: () => { running = false; } };
}

/**
 * Send a plain text message (no severity prefix). For conversational replies.
 */
async function reply(text) {
  if (!TOKEN || !CHAT_ID) return { ok: false, error: 'no creds' };
  return send({ token: TOKEN, chatId: CHAT_ID, text });
}

module.exports = { notify, reply, drainOutbox, startPolling };
