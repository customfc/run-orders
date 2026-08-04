/**
 * Stale-parcel reminder — asks a Prosol branch to confirm a parcel that has a
 * paid label but still shows no carrier scan.
 *
 * PUROLATOR ONLY, deliberately:
 *   • Purolator collects from every Prosol branch DAILY, so a Purolator parcel
 *     sitting 4 business days had four separate trucks it could have gone on.
 *     The branch is unambiguously the blocker, which is what makes the reminder
 *     fair to send. (Mac, 2026-07-27.)
 *   • Canada Post reports ZERO tracking events through ShipStation at any age
 *     (0/16 vs 96% Purolator) — every CP parcel would trip this forever.
 *   • The walleted UPS account has been dead since 2026-06-19; those parcels are
 *     our problem, not the branch's.
 *
 * Evidence behind the 4-business-day trigger: across 1 May – 28 July 2026 the
 * median tender time was 1 business day and p90 was 4. So this fires on roughly
 * the slowest 10%, about 15 parcels a month — rare enough that a branch reads it.
 *
 * Escalation, not nagging: a parcel is raised to the branch ONCE. If it is still
 * unscanned at ESCALATE_BIZ_DAYS it goes to Mac instead. A vendor who receives
 * the same reminder four times stops reading them.
 *
 * SHADOW by default — set STALE_REMINDER_LIVE=1 to actually send. Mirrors the
 * orphan sweep's gate and [[feedback_never_email_vendors_unprompted]].
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const audit = require('./audit');
const telegram = require('./telegram');
const { v1Request } = require('./shipstation-v2');

const STATE_FILE = path.join(__dirname, '..', 'data', 'stale-reminder-state.json');
const CARRIER = 'purolator_walleted';
const TRIGGER_BIZ_DAYS = Number(process.env.STALE_REMINDER_DAYS || 4);
const ESCALATE_BIZ_DAYS = Number(process.env.STALE_REMINDER_ESCALATE_DAYS || 8);
const LOOKBACK_DAYS = Number(process.env.STALE_REMINDER_LOOKBACK_DAYS || 30);
const isLive = () => process.env.STALE_REMINDER_LIVE === '1';

const LOCATION_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-location-map.json'));
const WH = {};
for (const l of Object.values(LOCATION_MAP)) if (l && l.shipstation_warehouse_id) WH[String(l.shipstation_warehouse_id)] = l;

const V2_KEY = process.env.SHIPSTATION_V2_API_KEY;
const PHYSICAL_RE = /picked up|in transit|on vehicle|out for delivery|arrived|departed|sort facility|depot|delivered|customs/i;

function v2(p) {
  return new Promise((res) => {
    https.request({ hostname: 'api.shipstation.com', path: p, method: 'GET', headers: { 'API-Key': V2_KEY, Accept: 'application/json' } },
      (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } }); })
      .on('error', () => res({})).end();
  });
}

/** Business days between two dates — a Friday label seen Monday is 1, not 3. */
function bizDaysBetween(from, to = new Date()) {
  const a = new Date(from); const b = new Date(to);
  if (isNaN(a) || isNaN(b)) return null;
  a.setUTCHours(0, 0, 0, 0); b.setUTCHours(0, 0, 0, 0);
  let n = 0;
  while (a < b) { a.setUTCDate(a.getUTCDate() + 1); const w = a.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

async function hasPhysicalScan(trackingNumber) {
  const lr = await v2(`/v2/labels?tracking_number=${encodeURIComponent(trackingNumber)}&page_size=5`);
  const lab = (lr.labels || []).find((l) => !l.voided) || (lr.labels || [])[0];
  if (!lab) return { known: false, scanned: false };
  const tr = await v2(`/v2/labels/${lab.label_id}/track`);
  const events = tr.events || [];
  const scanned = events.some((e) => PHYSICAL_RE.test(String(e.description || '')))
    || ['IT', 'AT', 'DE', 'EX'].includes(tr.status_code);
  return { known: true, scanned };
}

async function fetchShipments(fromISO, toISO) {
  const out = [];
  for (let page = 1; page <= 6; page++) {
    const r = await v1Request('GET', `/shipments?shipDateStart=${fromISO}&shipDateEnd=${toISO}&pageSize=200&page=${page}`);
    if (r.status !== 200) break;
    const j = JSON.parse(r.body);
    out.push(...(j.shipments || []));
    if (page >= (j.pages || 1)) break;
  }
  return out;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { reminded: {}, escalated: {} }; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

/**
 * Find Purolator parcels at Prosol branches with a paid label and no scan.
 * All I/O injectable so this is testable without network.
 */
async function findStale({
  now = new Date(),
  listShipments = fetchShipments,
  checkScan = hasPhysicalScan,
  state = loadState(),
} = {}) {
  const to = new Date(now); to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(now); from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
  const shipments = await listShipments(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));

  const due = [];       // ready to remind the branch
  const escalate = [];  // already reminded, still nothing — Mac's problem now
  const skipped = { voided: 0, otherCarrier: 0, notProsol: 0, tooRecent: 0, scanned: 0, alreadyReminded: 0, unknown: 0, openReturn: 0 };

  // Never chase a branch to ship a parcel the buyer has already opened a return
  // on. If the branch tenders it after we refund, we lose the goods AND the
  // money — and "I never received it" is the most common reason a stranded
  // parcel gets a return in the first place, so the overlap is not rare.
  const returnOrders = new Set();
  try {
    const rf = fs.readdirSync(path.join(__dirname, '..', 'data'))
      .filter((f) => f.startsWith('returns-') && f.endsWith('.json')).sort().pop();
    if (rf) {
      for (const row of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', rf), 'utf8'))) {
        const id = String(row['Order ID'] || '').trim();
        if (id) returnOrders.add(id);
      }
    }
  } catch { /* no returns file — fall through, do not block the sweep */ }

  for (const s of shipments) {
    if (s.voided) { skipped.voided++; continue; }
    if (s.carrierCode !== CARRIER) { skipped.otherCarrier++; continue; }
    const loc = WH[String(s.warehouseId)];
    if (!loc || loc.non_prosol) { skipped.notProsol++; continue; }
    const age = bizDaysBetween(s.shipDate, now);
    if (age == null || age < TRIGGER_BIZ_DAYS) { skipped.tooRecent++; continue; }

    if (s.orderNumber && returnOrders.has(String(s.orderNumber).trim())) { skipped.openReturn++; continue; }

    const r = await checkScan(s.trackingNumber);
    if (!r.known) { skipped.unknown++; continue; }   // can't confirm — never accuse
    if (r.scanned) { skipped.scanned++; continue; }

    const rec = {
      tracking: s.trackingNumber,
      order: s.orderNumber || null,
      branch: `${loc.city} (${loc.code})`,
      branchEmail: (loc.contact_email || [])[0] || null,
      warehouseId: s.warehouseId,
      shipDate: String(s.shipDate).slice(0, 10),
      bizDays: age,
      cost: Number(s.shipmentCost || 0),
      to: `${s.shipTo?.city || ''}, ${s.shipTo?.state || ''}`.replace(/^, /, ''),
    };

    const wasReminded = Boolean(state.reminded?.[rec.tracking]);
    if (wasReminded) {
      if (age >= ESCALATE_BIZ_DAYS && !state.escalated?.[rec.tracking]) escalate.push(rec);
      else skipped.alreadyReminded++;
      continue;
    }
    due.push(rec);
  }

  // one group per branch — never one email per parcel
  const byBranch = {};
  for (const d of due) (byBranch[d.branch] = byBranch[d.branch] || { branch: d.branch, email: d.branchEmail, parcels: [] }).parcels.push(d);

  return { due, escalate, byBranch: Object.values(byBranch), skipped };
}

/** Deliberately a question, not a chase: a third of these turn out to be ours. */
function buildBranchEmail(group) {
  const lines = group.parcels
    .sort((a, b) => b.bizDays - a.bizDays)
    .map((p) => `  ${p.tracking}   ${p.order ? `order ${p.order}` : 'no order ref'}   label ${p.shipDate}   ${p.bizDays} business days`);
  const text = [
    'Hi,',
    '',
    `Can you confirm whether ${group.parcels.length === 1 ? 'this parcel is' : `these ${group.parcels.length} parcels are`} still at ${group.branch}?`,
    '',
    'Purolator has the labels registered but has never scanned them, so as far as',
    'tracking is concerned they have not been collected:',
    '',
    ...lines,
    '',
    'If they are still on your floor, please put them on the next Purolator pickup.',
    'If they have already gone, let me know and I will chase Purolator instead.',
    '',
    'Thanks,',
    'Mac',
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#111">
<p>Hi,</p>
<p>Can you confirm whether ${group.parcels.length === 1 ? 'this parcel is' : `these <strong>${group.parcels.length} parcels</strong> are`} still at <strong>${group.branch}</strong>?</p>
<p>Purolator has the labels registered but has never scanned them, so as far as tracking is concerned they have not been collected:</p>
<table style="border-collapse:collapse;font-size:13px;margin:10px 0">
<tr><th align="left" style="padding:4px 14px 4px 0">Tracking</th><th align="left" style="padding:4px 14px 4px 0">Order</th><th align="left" style="padding:4px 14px 4px 0">Label date</th><th align="left" style="padding:4px 0">Waiting</th></tr>
${group.parcels.map((p) => `<tr><td style="padding:4px 14px 4px 0"><strong>${p.tracking}</strong></td><td style="padding:4px 14px 4px 0">${p.order || '—'}</td><td style="padding:4px 14px 4px 0">${p.shipDate}</td><td style="padding:4px 0">${p.bizDays} business days</td></tr>`).join('\n')}
</table>
<p>If they are still on your floor, please put them on the next Purolator pickup. If they have already gone, let me know and I will chase Purolator instead.</p>
<p>Thanks,<br>Mac</p></div>`;
  const subject = `Still at ${group.branch}? ${group.parcels.length} parcel${group.parcels.length === 1 ? '' : 's'} with no Purolator scan`;
  return { subject, text, html };
}

function formatReport(r, live) {
  const L = [];
  if (r.byBranch.length) {
    const n = r.due.length;
    L.push(`${live ? '📧 Sent' : '🟡 SHADOW — would send'} ${r.byBranch.length} branch email(s) covering ${n} parcel(s):`);
    for (const g of r.byBranch) L.push(`   • ${g.branch} — ${g.parcels.map((p) => `${p.order || p.tracking} (${p.bizDays}d)`).join(', ')}`);
  }
  if (r.escalate.length) {
    L.push(`🚨 ${r.escalate.length} parcel(s) still unscanned after ${ESCALATE_BIZ_DAYS} business days — branch already asked once, needs you:`);
    for (const p of r.escalate) L.push(`   • ${p.order || p.tracking} @ ${p.branch}, ${p.bizDays} business days, ${'$' + p.cost.toFixed(2)}`);
  }
  if (!L.length) L.push(`✅ No Purolator parcels sitting ${TRIGGER_BIZ_DAYS}+ business days without a scan.`);
  return L.join('\n');
}

async function runReminderSweep({
  live = isLive(),
  sendMail = null,
  notify = (lvl, t, b) => telegram.notify(lvl, t, b),
  auditLog = (e) => audit.log(e),
  persist = saveState,
  ...findOpts
} = {}) {
  const state = findOpts.state || loadState();
  const r = await findStale({ ...findOpts, state });
  r.live = live;

  if (live && r.byBranch.length) {
    const { sendEmail } = require('./emailer');
    const send = sendMail || sendEmail;
    for (const g of r.byBranch) {
      const { subject, text, html } = buildBranchEmail(g);
      await send({
        to: process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca',
        cc: [g.email, process.env.MAC_CC_EMAIL || 'mac@customfc.ca'].filter(Boolean).join(', '),
        subject, text, html,
      });
      for (const p of g.parcels) state.reminded[p.tracking] = { at: new Date().toISOString(), branch: g.branch };
      auditLog({ action: 'stale-parcel-reminder-sent', branch: g.branch, parcels: g.parcels.map((p) => p.tracking) });
    }
    for (const p of r.escalate) state.escalated[p.tracking] = { at: new Date().toISOString() };
    persist(state);
  }

  const body = formatReport(r, live);
  if (r.byBranch.length || r.escalate.length) {
    await notify(r.escalate.length ? 'attn' : 'ok', `Stale-parcel reminder${live ? '' : ' (SHADOW)'}`, body).catch(() => {});
  }
  r.report = body;
  return r;
}

module.exports = {
  findStale, buildBranchEmail, formatReport, runReminderSweep, bizDaysBetween,
  TRIGGER_BIZ_DAYS, ESCALATE_BIZ_DAYS, CARRIER,
};
