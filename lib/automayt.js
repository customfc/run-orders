/**
 * Automayt Open API client — the transport that replaces lib/salesforce.js.
 *
 * One bearer key per environment (beta1 / staging / production), no login
 * session. Contract: GET {base}/openapi.json. Behaviour this module owns:
 *
 * - Every create or command carries an Idempotency-Key. Callers derive it from
 *   their own ids (e.g. `shopify-1001-so`) so a retry after a timeout replays
 *   the original response instead of creating a second record.
 * - Retries keep the same key: network errors and timeouts (only when the call
 *   is a read or carries a key), 429 (waits Retry-After), 409
 *   request_in_progress, 5xx and anything the server marks retryable.
 * - At most 8 requests in flight per process, the server's per-key ceiling.
 * - Errors throw AutomaytError with the server's stable `code` and the
 *   `request_id` Automayt asks us to quote. Branch on code, never on message.
 * - A 409 `duplicate` is "already done": callers use err.existingId.
 *
 * Env: AUTOMAYT_API_BASE (default beta1), AUTOMAYT_API_KEY.
 */

const DEFAULT_BASE = 'https://beta1.automayt.dev/api/v1';
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 30_000;
const BACKOFF_MS = [1_000, 4_000, 15_000];
const MAX_RETRY_AFTER_MS = 60_000;
const USER_AGENT = 'run-orders/1.0 (+customfc)';

class AutomaytError extends Error {
  constructor({ status, code, message, field, details, requestId, retryable, method, path }) {
    super(`Automayt ${method} ${path} → ${status} ${code}: ${message}${field ? ` (field ${field})` : ''}${requestId ? ` [${requestId}]` : ''}`);
    this.name = 'AutomaytError';
    this.status = status;
    this.code = code;
    this.field = field || null;
    this.details = details || {};
    this.requestId = requestId || null;
    this.retryable = !!retryable;
    this.existingId = (details && (details.existing_id || (Array.isArray(details.existing_ids) && details.existing_ids[0]))) || null;
  }
}

function isDuplicate(err) {
  return err instanceof AutomaytError && err.code === 'duplicate';
}

function config() {
  const base = (process.env.AUTOMAYT_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const key = process.env.AUTOMAYT_API_KEY;
  if (!key) throw new Error('Missing AUTOMAYT_API_KEY');
  // A test key only works on beta1/staging and a live key only on production.
  // Catch the mismatch here instead of as a 401 mid-pipeline.
  const live = key.startsWith('amk_live_');
  const prodBase = /\/\/app\.automayt\.com\//.test(base + '/');
  if (live !== prodBase) {
    throw new Error(`AUTOMAYT_API_KEY (${live ? 'live' : 'test'}) does not match AUTOMAYT_API_BASE ${base}`);
  }
  return { base, key };
}

// ── Concurrency gate ─────────────────────────────────────────────────────────
// A released slot is handed straight to the next waiter, so a new caller can
// never slip in between the release and the waiter's wake-up.
let inFlight = 0;
const waiters = [];
async function acquire() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return; }
  await new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next(); else inFlight--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional observer for every finished call (audit log, test reports). It gets
// { method, path, status, code, requestId, replayed, ms } and must not throw.
let requestLogger = null;
function setRequestLogger(fn) { requestLogger = typeof fn === 'function' ? fn : null; }
function logRequest(entry) {
  if (!requestLogger) return;
  try { requestLogger(entry); } catch { /* a logger must never break a call */ }
}

function buildUrl(base, path, query) {
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

function retryAfterMs(res, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, MAX_RETRY_AFTER_MS);
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/**
 * request(method, path, { query, body, idempotencyKey })
 * Resolves { status, data, requestId, replayed }. Throws AutomaytError on any
 * non-2xx after retries, or a plain Error on a transport failure.
 */
async function request(method, path, { query, body, idempotencyKey, fetchImpl = fetch } = {}) {
  const { base, key } = config();
  const url = buildUrl(base, path, query);
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);
  // Retrying a write without a key could create it twice; only reads and
  // keyed writes are safe to resend after a lost response.
  const safeToResend = method === 'GET' || !!idempotencyKey;

  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    await acquire();
    let res;
    let transportErr = null;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      transportErr = e;
    } finally {
      release();
    }

    if (transportErr) {
      if (safeToResend && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt++]);
        continue;
      }
      throw new Error(`Automayt ${method} ${path} transport failure: ${transportErr.message}`);
    }

    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    if (res.ok) {
      const replayed = res.headers.get('idempotent-replayed') === 'true';
      logRequest({ method, path, status: res.status, code: null, requestId, replayed, ms: Date.now() - startedAt });
      return { status: res.status, data, requestId, replayed };
    }

    const e = (data && data.error) || {};
    const err = new AutomaytError({
      status: res.status,
      code: e.code || `http_${res.status}`,
      message: e.message || text.slice(0, 200) || res.statusText,
      field: e.field,
      details: e.details,
      requestId: e.request_id || requestId,
      retryable: e.retryable,
      method,
      path,
    });

    const transient = res.status === 429
      || err.code === 'request_in_progress'
      || res.status >= 500
      || err.retryable;
    if (transient && safeToResend && attempt < BACKOFF_MS.length) {
      await sleep(retryAfterMs(res, attempt++));
      continue;
    }
    logRequest({ method, path, status: res.status, code: err.code, requestId: err.requestId, replayed: false, ms: Date.now() - startedAt });
    throw err;
  }
}

const get = (path, query) => request('GET', path, { query });

function requireKey(idempotencyKey, what) {
  if (!idempotencyKey) throw new Error(`${what}: Idempotency-Key is required`);
  return idempotencyKey;
}
const post = (path, body, idempotencyKey) => request('POST', path, { body, idempotencyKey });
const command = async (path, body, idempotencyKey) => request('POST', path, { body, idempotencyKey: requireKey(idempotencyKey, `POST ${path}`) });
const put = async (path, body, idempotencyKey) => request('PUT', path, { body, idempotencyKey: requireKey(idempotencyKey, `PUT ${path}`) });

/** Async iterator over every row of a cursor-paged list. */
async function* paginate(path, query = {}) {
  let cursor = null;
  do {
    const { data } = await get(path, { ...query, cursor });
    for (const row of (data && data.data) || []) yield row;
    cursor = data && data.has_more ? data.next_cursor : null;
  } while (cursor);
}

async function listAll(path, query = {}, { max = 10_000 } = {}) {
  const rows = [];
  for await (const row of paginate(path, query)) {
    rows.push(row);
    if (rows.length >= max) throw new Error(`Automayt ${path}: more than ${max} rows, refusing to load them all`);
  }
  return rows;
}

module.exports = {
  AutomaytError,
  isDuplicate,
  config,
  request,
  get,
  post,
  command,
  put,
  paginate,
  listAll,
  setRequestLogger,
};
