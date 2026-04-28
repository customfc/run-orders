/**
 * Salesforce connection helper.
 * Caches one logged-in jsforce.Connection at module scope (TTL 90 min,
 * SF session is 2h) and serializes concurrent logins through an inflight
 * promise. Auth-terminal errors throw immediately and are NOT retried —
 * retrying these is what tripped SF's "OAuth token reuse" heuristic.
 */

let jsforce;
try {
  jsforce = require('jsforce');
} catch {
  jsforce = null;
}

const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN;
const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

const SESSION_TTL_MS = 90 * 60 * 1000;
const TRANSIENT_BACKOFF_MS = [0, 30_000, 60_000];

const AUTH_TERMINAL = /INVALID_LOGIN|LOGIN_MUST_USE_SECURITY_TOKEN|PASSWORD_LOCKOUT|INVALID_OPERATION_WITH_EXPIRED_PASSWORD|INVALID_AUTH_HEADER|AUTHENTICATION_FAILURE|LOCKED|FROZEN/i;

let cachedConn = null;
let cachedAt = 0;
let inflight = null;

async function connect() {
  if (!jsforce) throw new Error('jsforce is not installed. Run: npm install jsforce');
  if (!SF_USERNAME || !SF_PASSWORD || !SF_TOKEN) {
    throw new Error('Missing SALESFORCE_USERNAME, SALESFORCE_PASSWORD, or SALESFORCE_SECURITY_TOKEN');
  }

  if (cachedConn && Date.now() - cachedAt < SESSION_TTL_MS) return cachedConn;
  if (inflight) return inflight;

  inflight = (async () => {
    let lastErr;
    for (let i = 0; i < TRANSIENT_BACKOFF_MS.length; i++) {
      const delay = TRANSIENT_BACKOFF_MS[i];
      if (delay) await new Promise(r => setTimeout(r, delay));
      try {
        const conn = new jsforce.Connection({
          loginUrl: SF_LOGIN_URL,
          callOptions: { client: `run-orders/1.0.0/pid${process.pid}` },
        });
        await conn.login(SF_USERNAME, `${SF_PASSWORD}${SF_TOKEN}`);
        cachedConn = conn;
        cachedAt = Date.now();
        return conn;
      } catch (e) {
        lastErr = e;
        const tag = `${e.errorCode || ''} ${e.message || ''}`;
        if (AUTH_TERMINAL.test(tag)) throw e;
      }
    }
    throw lastErr;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function invalidateSession() {
  cachedConn = null;
  cachedAt = 0;
}

async function query(conn, soql) {
  const result = await conn.query(soql);
  return result.records || [];
}

async function create(conn, sobject, fields) {
  const result = await conn.sobject(sobject).create(fields);
  if (!result.success) {
    const errs = (result.errors || []).map(e => e.message || JSON.stringify(e)).join('; ');
    throw new Error(`SF create ${sobject} failed: ${errs}`);
  }
  return result.id;
}

module.exports = { connect, query, create, invalidateSession };
