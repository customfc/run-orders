/**
 * Integration health monitor — catches SILENT pipe failures.
 *
 * The pipeline watches orders that flow THROUGH it; it never noticed when an
 * upstream connection died, because a broken pipe looks like "no orders today"
 * — silent absence, not an error. Three of these bit us in late May / early
 * June, each found by accident days/weeks later:
 *   - Shopify→ShipStation store sync 401'd (06-03) → Shopify orders stopped
 *     syncing in; 4 paid orders sat unfulfilled 5 days.
 *   - Salesforce/jsforce broke (~05-29) → PO creation silently stopped; ~66
 *     orders shipped with no vendor PO.
 *   - MS Graph token lapsed → the mail watcher went blind to vendor replies.
 *
 * This probes each pipe once a morning and Telegrams LOUD on any failure, so a
 * dead connection surfaces the day it breaks instead of by accident later.
 * Read-only — it mutates nothing, so it's safe to run live with no shadow.
 */

require('dotenv').config();
const https = require('https');
const opsState = require('./ops-state');
const telegram = require('./telegram');
const audit = require('./audit');

const SS_KEY = process.env.SHIPSTATION_API_KEY;
const SS_SECRET = process.env.SHIPSTATION_API_SECRET;
const STORE_STALE_HOURS = 24; // healthy auto-refresh stores sync ~hourly; 24h stale = broken (generous vs tz slop)

function ssGet(path) {
  const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'ssapi.shipstation.com', path, method: 'GET', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.end();
  });
}

// 1) ShipStation store syncs — an active auto-refresh store whose last successful
//    refresh is stale means its upstream connection (Shopify/Amazon) is down.
async function checkStoreSyncs() {
  const r = await ssGet('/stores?showInactive=false');
  const stores = Array.isArray(r) ? r : (r && r.stores) || [];
  const down = [];
  const now = Date.now();
  for (const s of stores) {
    if (!s.active || !s.autoRefresh || !s.refreshDate) continue;
    const ageH = (now - new Date(s.refreshDate).getTime()) / 3.6e6;
    if (ageH > STORE_STALE_HOURS) {
      down.push({ store: s.storeName, lastSync: String(s.refreshDate).slice(0, 16), ageHours: Math.round(ageH) });
    }
  }
  return { name: 'ShipStation store sync', ok: down.length === 0, down };
}

// 2) PO creation — the most recent day that had label buys should have produced
//    POs. Buys present + zero POs = Salesforce/jsforce PO path is broken.
function checkPOCreation() {
  const base = opsState.today();
  for (let i = 0; i <= 5; i++) {
    const d = new Date(`${base}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const st = opsState.load(date);
    const buys = Object.keys(st.phases?.buy?.labels || {}).length;
    const pos = Object.keys(st.phases?.pos?.byTracking || {}).length;
    if (buys >= 2) {
      // first (most recent) day with real buy volume decides it
      return { name: 'PO creation (Salesforce)', ok: pos > 0, down: pos > 0 ? [] : [{ date, buys, pos }] };
    }
  }
  return { name: 'PO creation (Salesforce)', ok: true, down: [] }; // no recent buys to judge
}

// 3) Mail watcher — Graph token must be live or it can't ingest vendor replies.
async function checkMailWatcher() {
  try {
    const { getAccessToken } = require('./mail-watcher');
    await getAccessToken();
    return { name: 'Mail watcher (MS Graph)', ok: true, down: [] };
  } catch (e) {
    return { name: 'Mail watcher (MS Graph)', ok: false, down: [{ error: e.message }] };
  }
}

async function runHealthCheck() {
  const checks = [];
  for (const fn of [checkStoreSyncs, checkPOCreation, checkMailWatcher]) {
    try { checks.push(await fn()); }
    catch (e) { checks.push({ name: fn.name, ok: false, down: [{ error: `check threw: ${e.message}` }] }); }
  }
  const downCount = checks.filter((c) => !c.ok).length;
  return { checks, downCount, allOk: downCount === 0 };
}

function formatHealth(report) {
  if (report.allOk) return '✅ All integrations healthy — store syncs, PO creation, mail watcher.';
  const lines = ['🚨🚨🚨  INTEGRATION DOWN  🚨🚨🚨', ''];
  for (const c of report.checks) {
    if (c.ok) { lines.push(`✅ ${c.name}`); continue; }
    lines.push(`❌ ${c.name}`);
    for (const d of c.down) {
      if (d.store) lines.push(`    └ ${d.store} — last synced ${d.ageHours}h ago (${d.lastSync}); reconnect in ShipStation`);
      else if (d.date) lines.push(`    └ ${d.date}: ${d.buys} labels bought, ${d.pos} POs — PO path is broken`);
      else if (d.error) lines.push(`    └ ${String(d.error).slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

// Cron entry: run + alert LOUD on any failure (quiet when all green).
async function healthCheckTick(source) {
  try {
    const report = await runHealthCheck();
    audit.log({ action: 'integration-health', source, downCount: report.downCount, checks: report.checks.map((c) => ({ name: c.name, ok: c.ok })) });
    if (!report.allOk) {
      await telegram.notify('halt', `🚨🚨 INTEGRATION FAILURE — ${report.downCount} pipe(s) down 🚨🚨`, `${formatHealth(report)}\n\n/health to re-check`);
    }
    return report;
  } catch (e) {
    audit.log({ action: 'integration-health-error', source, error: e.message });
    return { error: e.message };
  }
}

module.exports = { runHealthCheck, healthCheckTick, formatHealth, STORE_STALE_HOURS };
