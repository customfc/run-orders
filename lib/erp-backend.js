/**
 * Which system of record run-orders writes orders to, chosen by ERP_BACKEND:
 *
 *   salesforce       (default) today's Salesforce flows, untouched.
 *   automayt-shadow  Salesforce exactly as today, then the same order mirrored
 *                    to Automayt. The mirror can never fail or hold up the
 *                    Salesforce result: it starts only after Salesforce has
 *                    answered, every error is caught, and it is abandoned after
 *                    AUTOMAYT_SHADOW_TIMEOUT_MS (default 90 s). Its outcome is
 *                    written to data/audit.jsonl and returned on the result as
 *                    `automaytShadow: { ok, error, soNumber, poNumber, requestIds }`.
 *   automayt         Automayt only (after cutover).
 *
 * Callers use this module instead of shopify-sf / amazon-po / fba-po-sender
 * directly. Automayt modules load only when a non-default backend is chosen.
 */

const shopifySf = require('./shopify-sf');
const amazonPo = require('./amazon-po');
const audit = require('./audit');

const BACKENDS = ['salesforce', 'automayt-shadow', 'automayt'];

function backend() {
  const raw = (process.env.ERP_BACKEND || 'salesforce').trim().toLowerCase();
  if (!BACKENDS.includes(raw)) throw new Error(`ERP_BACKEND="${raw}" is not one of ${BACKENDS.join(', ')}`);
  return raw;
}

const automayt = () => require('./automayt-orders');

function shadowTimeoutMs() {
  const n = Number(process.env.AUTOMAYT_SHADOW_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

function errorList(errors) {
  return (errors || []).map((e) => (typeof e === 'string' ? e : `${e.step ? `${e.step}: ` : ''}${e.error || e.message || JSON.stringify(e)}`));
}

const SUMMARIES = {
  shopify: (r) => ({
    ok: !(r.errors || []).length,
    error: errorList(r.errors).join('; ') || null,
    soNumber: r.soNumber || null,
    poNumber: r.poNumber || null,
    skipped: !!r.skipped,
  }),
  amazon: (r) => {
    const bad = (r.orders || []).filter((o) => o.status === 'error' || o.status === 'partial');
    const errors = [...errorList(r.errors), ...bad.map((o) => `${o.orderNumber}: ${(o.errors || []).join('; ')}`)];
    return {
      ok: !errors.length,
      error: errors.join(' | ') || null,
      soNumber: (r.soNames || []).join(', ') || null,
      poNumber: (r.orders || []).map((o) => o.poNumber).filter(Boolean).join(', ') || null,
    };
  },
  fba: (r) => ({
    ok: !!r.created && !(r.errors || []).length,
    error: r.error || errorList(r.errors).join('; ') || (r.skipped ? r.reason : null),
    soNumber: null,
    poNumber: r.poNumber || null,
  }),
};

/**
 * Run one Automayt mirror. Never throws and never waits past the timeout; a
 * mirror still running at the timeout is left to finish on its own.
 */
async function mirror(kind, ref, fn) {
  const started = Date.now();
  let timer;
  let shadow;
  try {
    const timeoutMs = shadowTimeoutMs();
    const am = require('./automayt');
    const { value, requestIds } = await Promise.race([
      am.withRequestIds(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Automayt shadow timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    shadow = { ...SUMMARIES[kind](value), requestIds };
  } catch (err) {
    shadow = { ok: false, error: (err && err.message) || String(err), soNumber: null, poNumber: null, requestIds: (err && err.requestIds) || [] };
  } finally {
    clearTimeout(timer);
  }
  shadow.ms = Date.now() - started;
  try {
    audit.log({ type: 'automayt-shadow', kind, ref, ...shadow });
    if (!shadow.ok) console.warn(`[automayt-shadow] ${kind} ${ref}: ${shadow.error}`);
  } catch { /* logging must never break the Salesforce result */ }
  return shadow;
}

async function createShopifySoPo(args = {}) {
  const b = backend();
  if (b === 'automayt') return automayt().createShopifySoPo(args);
  const result = await shopifySf.createShopifySoPo(args);
  if (b === 'automayt-shadow' && result) {
    const ref = args.shopifyOrder && args.shopifyOrder.orderNumber;
    result.automaytShadow = await mirror('shopify', ref, () => automayt().createShopifySoPo({ ...args, onProgress: () => {} }));
  }
  return result;
}

async function createAmazonPOs(args = {}) {
  const b = backend();
  if (b === 'automayt') return automayt().createAmazonPOs(args);
  if (b !== 'automayt-shadow') return amazonPo.createAmazonPOs(args);

  // Fetch the shipped parcels once and hand the same list to both backends.
  // If the fetch fails, Salesforce fetches (and reports) on its own and there
  // is nothing to mirror.
  let prefetched = null;
  try { prefetched = await amazonPo.fetchShippedOrdersForPO({ days: args.days ?? 7 }); } catch { prefetched = null; }
  const result = await amazonPo.createAmazonPOs({ ...args, prefetched });
  if (result && prefetched) {
    result.automaytShadow = await mirror('amazon', `${(prefetched.shipments || []).length} shipments`, () => automayt().createAmazonPOs({ ...args, prefetched, onProgress: () => {} }));
  }
  return result;
}

/** sfCreate is fba-po-sender's own createSalesforceFbaPO (passed in to avoid a require cycle). */
async function createFbaPO(args, sfCreate) {
  const b = backend();
  if (b === 'automayt') return automayt().createFbaPO(args);
  const result = await sfCreate(args);
  if (b === 'automayt-shadow' && result && !result.skipped) {
    const ref = `${args.draft && args.draft.draftId}:${args.bucket || 'all'}`;
    result.automaytShadow = await mirror('fba', ref, () => automayt().createFbaPO(args));
  }
  return result;
}

module.exports = { BACKENDS, backend, createShopifySoPo, createAmazonPOs, createFbaPO, mirror };
