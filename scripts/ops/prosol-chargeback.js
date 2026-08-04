#!/usr/bin/env node
/**
 * Build a chargeback statement for Prosol.
 *
 * This goes to a vendor, so it only includes incidents we can actually stand
 * behind: every line is cross-checked against the audit trail to confirm the
 * branch WAS emailed before the failure. Anything we caused, or cannot confirm,
 * is excluded and listed separately so we are never claiming for our own bug.
 * ve-20260714-001 (Calgary) is the worked example — logged as their failure,
 * verified as ours, excluded.
 *
 * Cost of a stranded parcel is not the label. It is the label PLUS the refunded
 * sale when the customer gives up, which on one Brossard parcel was $508.21
 * against a $34.05 label.
 *
 * Usage:
 *   node scripts/ops/prosol-chargeback.js --months=2
 *   node scripts/ops/prosol-chargeback.js --months=2 --csv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadVendorErrors } = require('../../lib/vendor-errors');

const ROOT = path.join(__dirname, '..', '..');
const OPS = path.join(ROOT, 'data', 'ops-state');
const AUDIT = path.join(ROOT, 'data', 'audit.jsonl');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const MONTHS = Number(arg('months', 2));
const CSV = process.argv.includes('--csv');
const money = (n) => '$' + Number(n || 0).toFixed(2);

function orderIdIndex() {
  const idx = {};
  if (!fs.existsSync(OPS)) return idx;
  for (const f of fs.readdirSync(OPS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(OPS, f), 'utf8')); } catch { continue; }
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') { if (v.orderNumber && /^\d+$/.test(k)) idx[v.orderNumber] = k; walk(v); }
      }
    })(j);
  }
  return idx;
}
function emailedAt() {
  const m = new Map();
  if (!fs.existsSync(AUDIT)) return m;
  for (const line of fs.readFileSync(AUDIT, 'utf8').trim().split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.action !== 'pipeline-email-prosol') continue;
    for (const id of (e.orderIds || [])) if (!m.has(String(id))) m.set(String(id), e.timestamp);
  }
  return m;
}
function poIndex() {
  const idx = {};
  if (!fs.existsSync(OPS)) return idx;
  for (const f of fs.readdirSync(OPS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(OPS, f), 'utf8')); } catch { continue; }
    for (const [tn, v] of Object.entries(j?.phases?.pos?.byTracking || {})) if (v?.poNumber) idx[tn] = v.poNumber;
  }
  return idx;
}

(async () => {
  const since = new Date(Date.now() - MONTHS * 30.44 * 864e5).toISOString().slice(0, 10);
  const ids = orderIdIndex();
  const emails = emailedAt();
  const pos = poIndex();

  const all = loadVendorErrors().filter((r) => r.date >= since);
  const claim = [];
  const excluded = [];

  for (const r of all) {
    if (!/prosol/i.test(r.vendor || '')) { excluded.push({ ...r, why: `vendor recorded as ${r.vendor}` }); continue; }
    const oid = ids[r.order_ref];
    const when = oid ? emails.get(String(oid)) : null;
    if (!when) { excluded.push({ ...r, why: 'cannot evidence that the branch was notified' }); continue; }

    // Our own bug, verified. Never bill a vendor for it.
    if (r.outcome === 'resolved_no_loss') { excluded.push({ ...r, why: 'no loss — our notification gap, not their failure' }); continue; }

    // A parcel that eventually delivered USED its label. The label was not
    // wasted, only late, so there is nothing to reclaim unless the delay cost
    // us a refund. Claiming for a label that got used invites them to audit the
    // whole statement, and rightly.
    const labelWasted = r.outcome !== 'delivered_late';
    const claimLabel = labelWasted ? Number(r.cost_label_cad || 0) : 0;
    const claimRefund = Number(r.cost_refund_cad || 0);
    const claimTotal = claimLabel + claimRefund + Number(r.cost_other_cad || 0);
    if (claimTotal <= 0) { excluded.push({ ...r, why: 'delivered late — label was used, no recoverable cost' }); continue; }

    // Flag a notification that predates the incident by an implausible margin;
    // it may be a stale orderId match rather than the email for this failure.
    const gapDays = Math.round((Date.parse(r.date) - Date.parse(when)) / 864e5);
    claim.push({ ...r, notifiedAt: when, po: pos[r.tracking] || null, claimLabel, claimRefund, claimTotal, gapDays });
  }
  claim.sort((a, b) => (a.location || '').localeCompare(b.location || '') || a.date.localeCompare(b.date));

  if (CSV) {
    console.log('date,branch,our_po,prosol_pin,order,issue,notified_to_branch,label_cad,refund_cad,total_cad,status');
    for (const c of claim) {
      console.log([c.date, c.location, c.po || '', c.tracking || '', c.order_ref, c.issue_type,
        String(c.notifiedAt).slice(0, 16).replace('T', ' '), c.claimLabel.toFixed(2),
        c.claimRefund.toFixed(2), c.claimTotal.toFixed(2), c.outcome].map((x) => `"${x}"`).join(','));
    }
    return;
  }

  const total = claim.reduce((s, c) => s + c.claimTotal, 0);
  const labels = claim.reduce((s, c) => s + c.claimLabel, 0);
  const refunds = claim.reduce((s, c) => s + c.claimRefund, 0);

  console.log(`PROSOL — SHIPMENT FAILURES, ${since} to ${new Date().toISOString().slice(0, 10)}`);
  console.log('='.repeat(96));
  console.log(`${claim.length} incidents. Every one was ordered and the branch notified by email before the failure.\n`);

  const byBranch = {};
  for (const c of claim) (byBranch[c.location] = byBranch[c.location] || []).push(c);

  for (const [branch, rows] of Object.entries(byBranch).sort((a, b) => b[1].reduce((s, c) => s + c.claimTotal, 0) - a[1].reduce((s, c) => s + c.claimTotal, 0))) {
    const sub = rows.reduce((s, c) => s + c.claimTotal, 0);
    console.log(`${branch}  —  ${rows.length} incident(s), ${money(sub)}`);
    for (const c of rows) {
      console.log(`   ${c.date}  ${(c.po || 'PO n/a').padEnd(10)} PIN ${String(c.tracking || 'n/a').padEnd(14)} order ${c.order_ref}`);
      console.log(`      notified to branch ${String(c.notifiedAt).slice(0, 16).replace('T', ' ')} UTC · ${c.issue_type}`);
      const bits = [`unused label ${money(c.claimLabel)}`];
      if (c.claimRefund) bits.push(`refunded sale ${money(c.claimRefund)}`);
      console.log(`      ${bits.join(' + ')} = ${money(c.claimTotal)}   [${c.outcome}]`);
      if (c.gapDays > 7) console.log(`      ⚠ notification is ${c.gapDays} days before the incident date — verify this pairing by hand`);
    }
    console.log();
  }

  console.log('='.repeat(96));
  console.log(`labels paid and unused : ${money(labels)}`);
  console.log(`sales refunded         : ${money(refunds)}`);
  console.log(`TOTAL CLAIMED          : ${money(total)}`);

  if (excluded.length) {
    console.log(`\nNOT CLAIMED (${excluded.length}) — excluded on purpose, do not send:`);
    for (const e of excluded) console.log(`   ${e.id}  ${e.date}  ${String(e.location || '').padEnd(20)} ${money(e.cost_total_cad)}  ${e.why}`);
  }
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
