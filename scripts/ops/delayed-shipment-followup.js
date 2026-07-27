#!/usr/bin/env node
/**
 * Delayed-shipment accountability tracker.
 *
 * Every open `delayed_shipment` case in the vendor-error ledger gets its live
 * carrier status re-checked, so a case that turns into a lost sale is caught and
 * costed instead of quietly ageing out. This is the evidence trail for charging
 * Prosol back.
 *
 * Read-only by default — it reports and proposes, it never books a cost on its
 * own (a refund is Mac's call, not a script's).
 *
 *   node scripts/ops/delayed-shipment-followup.js
 *   node scripts/ops/delayed-shipment-followup.js --json
 *
 * Closing a case (writes to the ledger, one case at a time, deliberate):
 *   node scripts/ops/delayed-shipment-followup.js --close ve-20260721-001 \
 *     --outcome refunded --refund 178.78 --note "customer cancelled, refunded in full"
 *
 * Outcomes: open | delivered_late | refunded | returned | written_off | resolved_no_loss
 */
require('dotenv').config();
const https = require('https');
const { loadVendorErrors, updateVendorError, OUTCOMES } = require('../../lib/vendor-errors');

const V2_KEY = process.env.SHIPSTATION_V2_API_KEY;
const V1_KEY = process.env.SHIPSTATION_API_KEY;
const V1_SECRET = process.env.SHIPSTATION_API_SECRET;

const CODE = {
  NY: 'label created, no scan', AC: 'label accepted, no scan', UN: 'unknown',
  IT: 'in transit', AT: 'delivery attempted', DE: 'delivered', EX: 'exception',
};

function req(opts) {
  return new Promise((resolve, reject) => {
    https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, j: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, j: {} }); } });
    }).on('error', reject).end();
  });
}
const v2 = (path) => req({ hostname: 'api.shipstation.com', path, method: 'GET', headers: { 'API-Key': V2_KEY, Accept: 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    out[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return out;
}

// A parcel can be physically collected while ShipStation's top-level status_code
// still reads AC — seen on 520644250356, which had a "Picked up by Purolator"
// event on Jul 27 and was still reporting AC. Trusting status_code alone keeps
// reporting tendered parcels as stranded, so the events are the truth.
const PHYSICAL_RE = /picked up|in transit|on vehicle|out for delivery|arrived|departed|sort facility|depot|delivered|customs/i;

function firstPhysicalScan(events) {
  return events.find((e) => PHYSICAL_RE.test(String(e.description || ''))) || null;
}

async function trackOne(tracking) {
  if (!tracking || !V2_KEY) return { code: '??', label: 'no tracking', events: 0, moved: false };
  const lr = await v2(`/v2/labels?tracking_number=${encodeURIComponent(tracking)}&page_size=5`);
  const lab = (lr.j.labels || []).find((l) => !l.voided) || (lr.j.labels || [])[0];
  if (!lab) return { code: '??', label: 'not found in ShipStation', events: 0, moved: false };
  const tr = await v2(`/v2/labels/${lab.label_id}/track`);
  const code = tr.j.status_code || '??';
  const events = (tr.j.events || []);
  const physical = firstPhysicalScan(events);
  const moved = Boolean(physical) || ['IT', 'AT', 'DE', 'EX'].includes(code);
  return {
    code,
    moved,
    tenderedAt: physical ? (physical.occurred_at || null) : null,
    label: moved && ['NY', 'AC'].includes(code)
      ? `moving (${(physical.description || 'scanned').toLowerCase()}) — ShipStation status still ${code}`
      : (CODE[code] || tr.j.status_description || code),
    events: events.length,
    lastEvent: events.length ? `${(events[events.length - 1].occurred_at || '').slice(0, 16).replace('T', ' ')} ${events[events.length - 1].description || ''}` : null,
  };
}

const days = (d) => Math.round((Date.now() - new Date(String(d).slice(0, 10) + 'T12:00:00Z')) / 86400000);
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

(async () => {
  const a = parseArgs(process.argv.slice(2));

  if (a.close) {
    if (!a.outcome) { console.error(`--outcome required. One of: ${OUTCOMES.join(', ')}`); process.exit(1); }
    const patch = { outcome: a.outcome };
    if (a.refund != null && a.refund !== true) patch.cost_refund_cad = Number(a.refund);
    if (a.other != null && a.other !== true) patch.cost_other_cad = Number(a.other);
    if (a.resolution) patch.resolution = a.resolution;
    const rec = updateVendorError(a.close, patch, a.note === true ? null : a.note);
    console.log(`${rec.id} -> ${rec.outcome}`);
    console.log(`  costs: label ${money(rec.cost_label_cad)} + refund ${money(rec.cost_refund_cad)} + other ${money(rec.cost_other_cad)} = ${money(rec.cost_total_cad)}`);
    if (rec.order_value_cad) console.log(`  order value was ${money(rec.order_value_cad)} (our product cost ${money(rec.product_cost_cad)})`);
    console.log(`  ${rec.updates.length} amendment(s) on record`);
    return;
  }

  const open = loadVendorErrors().filter((e) => e.issue_type === 'delayed_shipment' && (e.outcome || 'open') === 'open');
  const rows = [];
  for (const e of open) {
    rows.push({ e, t: await trackOne(e.tracking) });
    await sleep(120);
  }
  rows.sort((x, y) => days(y.e.date) - days(x.e.date));

  if (a.json) { console.log(JSON.stringify(rows.map(({ e, t }) => ({ id: e.id, order: e.order_ref, status: t.code, ...e })), null, 2)); return; }

  const moved = rows.filter(({ t }) => t.moved);
  const stuck = rows.filter(({ t }) => !t.moved);

  console.log(`\nOPEN DELAYED-SHIPMENT CASES: ${rows.length}\n${'='.repeat(96)}`);

  console.log(`\nSTILL NOT MOVING — ${stuck.length}   (vendor has not tendered; exposure is live)\n`);
  for (const { e, t } of stuck) {
    console.log(`  ${e.id}  ${String(days(e.date)).padStart(2)}d  ${String(e.location || '').padEnd(22)} ${String(e.order_ref || '').padEnd(22)}`);
    console.log(`      ${t.label.padEnd(26)} label ${money(e.cost_label_cad)} · order value ${money(e.order_value_cad)} · our cost ${money(e.product_cost_cad)}`);
  }

  if (moved.length) {
    console.log(`\nMOVED SINCE LOGGING — ${moved.length}   (close these: delivered_late, or refunded/returned if the sale was lost)\n`);
    for (const { e, t } of moved) {
      const dt = t.tenderedAt ? Math.round((new Date(t.tenderedAt) - new Date(String(e.date).slice(0,10)+'T12:00:00Z')) / 86400000) : null;
      console.log(`  ${e.id}  ${String(e.location || '').padEnd(22)} ${String(e.order_ref || '').padEnd(22)} ${t.label}`);
      if (dt != null) console.log(`      sat ${dt} day(s) before the vendor tendered it (first scan ${String(t.tenderedAt).slice(0,16).replace('T',' ')})`);
      if (t.lastEvent) console.log(`      last: ${t.lastEvent}`);
      console.log(`      close: node scripts/ops/delayed-shipment-followup.js --close ${e.id} --outcome delivered_late`);
    }
  }

  const atRisk = rows.reduce((n, { e }) => n + Number(e.order_value_cad || 0), 0);
  const ourCost = rows.reduce((n, { e }) => n + Number(e.product_cost_cad || 0), 0);
  const labels = rows.reduce((n, { e }) => n + Number(e.cost_label_cad || 0), 0);
  console.log(`\n${'='.repeat(96)}`);
  console.log(`EXPOSURE ON OPEN CASES`);
  console.log(`  customer order value at risk : ${money(atRisk)}`);
  console.log(`  our product cost in limbo    : ${money(ourCost)}`);
  console.log(`  labels already paid for      : ${money(labels)}`);

  const byLoc = {};
  for (const { e } of rows) {
    const k = e.location || 'unknown';
    byLoc[k] = byLoc[k] || { n: 0, value: 0 };
    byLoc[k].n += 1; byLoc[k].value += Number(e.order_value_cad || 0);
  }
  console.log(`\nBY BRANCH (what to put in front of Prosol)`);
  for (const [k, v] of Object.entries(byLoc).sort((x, y) => y[1].value - x[1].value))
    console.log(`  ${k.padEnd(24)} ${String(v.n).padStart(2)} case(s)  ${money(v.value)} at risk`);

  const closed = loadVendorErrors().filter((e) => e.issue_type === 'delayed_shipment' && (e.outcome || 'open') !== 'open');
  if (closed.length) {
    const lost = closed.filter((e) => ['refunded', 'returned', 'written_off'].includes(e.outcome));
    console.log(`\nCLOSED: ${closed.length}  ·  of those, sales actually lost: ${lost.length}, costing ${money(lost.reduce((n, e) => n + Number(e.cost_total_cad || 0), 0))}`);
  }
  console.log('');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
