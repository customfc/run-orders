'use strict';
/**
 * Tap-link log: every page Mac opens from an emailed tap link, and every button he presses on one, gets an audit
 * line (tap-open / tap-press) with the record it was for, the HTTP result, any error, and the device (Tailscale IP
 * and browser).
 *
 * Why: the Amazon card for 702-3174407-2710644 (2026-10-08) was "clicked" and nothing sent, and there was no way to
 * tell whether the page never loaded or loaded and the button wasn't pressed. The links only resolve on the
 * tailnet, so mail scanners can't reach them: a tap-open line means Mac's device loaded the page, and NO line
 * means it never got here (phone off Tailscale, or NordVPN on). Tokens and reply text are never logged.
 *
 *   grep '"action":"tap-' data/audit.jsonl | tail
 */

const TAP_RE = /^\/(sku-resolver\/approve|discontinued\/act|returns\/approve|amazon-inbox\/send|prozone\/(approve|decline|earnings)|pickup\/[\w-]+|api\/fba\/auto-restock\/(approve|reject)\/[^/]+)\/?$/;
const KEYS = ['o', 'a', 'sku', 'k', 'order', 'id', 'b'];

function tapRecord(req, res, ms) {
  const src = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const keys = {};
  for (const k of KEYS) if (src[k] != null && src[k] !== '') keys[k] = String(src[k]).slice(0, 80);
  const error = res.locals && res.locals.tapError;
  return {
    action: req.method === 'POST' ? 'tap-press' : 'tap-open',
    path: req.path.replace(/\/(approve|reject)\/[^/]+\/?$/, '/$1/:token'),
    ...keys,
    status: res.statusCode,
    ms,
    ...(error ? { error: String(error).slice(0, 300) } : {}),
    ip: String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''),
    ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 160),
  };
}

/** Express middleware; `log` is audit.log. Logging never affects the response. */
function middleware(log, { now = () => Date.now() } = {}) {
  return (req, res, next) => {
    if (!TAP_RE.test(req.path)) return next();
    const started = now();
    res.on('finish', () => {
      try { log(tapRecord(req, res, now() - started)); } catch { /* audit is best-effort */ }
    });
    next();
  };
}

module.exports = { middleware, tapRecord, TAP_RE };
