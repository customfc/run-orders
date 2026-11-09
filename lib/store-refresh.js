'use strict';

// Ask ShipStation to pull new orders from its marketplace stores (Shopify,
// Amazon) right before a stage pass reads the awaiting-shipment queue.
//
// Why (2026-11-09): ShipStation's own auto-import runs every 1 to 3 hours. That
// day YF #1461/#1462/#1463 (placed 10:00, 10:49, 10:55 BC) only landed in
// ShipStation at 11:30:39, nine seconds after the last stage pass (11:30 BC) had
// read the queue, and five Amazon orders from 09:14 on landed at 12:10. All eight
// sat until the next morning. A refresh call takes a few seconds and closes that gap.
//
// Fail open: if anything here errors, the stage pass runs exactly as it did
// before (it just sees whatever ShipStation already has). Never throws.

const DEFAULT_MAX_WAIT_MS = 90_000;
const DEFAULT_POLL_MS = 3_000;
const IDLE = 0; // getrefreshstatus refreshStatusId for "Store is idle"

function parse(res) {
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res ? res.status : '?'}${res && res.body ? `: ${String(res.body).slice(0, 160)}` : ''}`);
  }
  return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
}

// Stores worth refreshing: active marketplace stores that ShipStation already
// auto-imports from. Skips "Manual Orders", "Api Shipments", "Rate Browser".
function pickStores(stores) {
  return (stores || []).filter((s) => s && s.active && s.autoRefresh);
}

async function refreshStores({
  request,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  log = () => {},
} = {}) {
  if (!request) request = require('./shipstation-v2').v1Request;
  const started = now();
  const out = { ok: true, stores: [], waitedMs: 0, error: null };
  try {
    const stores = pickStores(parse(await request('GET', '/stores?showInactive=false')));
    const pending = new Map(); // storeId -> { name, before }
    for (const s of stores) {
      const entry = { storeId: s.storeId, name: s.storeName, done: false, error: null };
      out.stores.push(entry);
      try {
        const before = parse(await request('GET', `/stores/getrefreshstatus?storeId=${s.storeId}`)).lastRefreshAttempt || null;
        parse(await request('POST', `/stores/refreshstore?storeId=${s.storeId}`, {}));
        pending.set(s.storeId, { entry, before });
      } catch (e) {
        entry.error = e.message;
        out.ok = false;
      }
    }
    while (pending.size && now() - started < maxWaitMs) {
      await sleep(pollMs);
      for (const [id, p] of [...pending]) {
        try {
          const st = parse(await request('GET', `/stores/getrefreshstatus?storeId=${id}`));
          if (st.refreshStatusId === IDLE && st.lastRefreshAttempt && st.lastRefreshAttempt !== p.before) {
            p.entry.done = true;
            pending.delete(id);
          }
        } catch (e) {
          p.entry.error = e.message;
          out.ok = false;
          pending.delete(id);
        }
      }
    }
    if (pending.size) {
      out.ok = false;
      for (const p of pending.values()) p.entry.error = p.entry.error || `still importing after ${Math.round(maxWaitMs / 1000)}s`;
    }
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  out.waitedMs = now() - started;
  log(out);
  return out;
}

module.exports = { refreshStores, pickStores };
