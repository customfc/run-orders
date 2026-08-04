#!/usr/bin/env node
/**
 * Verify that a delayed-shipment case is actually the branch's fault.
 *
 * A stranded parcel has two very different causes that look identical from the
 * outside: the branch was told and didn't tender (chargeable to Prosol), or the
 * branch was never told (our bug, not chargeable). ve-20260714-001 was logged
 * as the former and turned out to be the latter, so this checks rather than
 * assumes — you cannot bill a vendor for a parcel you never announced.
 *
 * Method: pipeline-email-prosol audit events record numeric ShipStation
 * orderIds, NOT Amazon order numbers. Searching the audit log for
 * "701-5518826-4465017" can never match and makes every case look un-emailed.
 * Resolve orderNumber -> orderId through ops-state first, then look for that id
 * in an email event.
 *
 * Read-only unless --fix, which reattributes confirmed notification gaps to
 * CFC so they cannot be charged to Prosol by mistake.
 *
 * Usage:
 *   node scripts/ops/verify-vendor-fault.js
 *   node scripts/ops/verify-vendor-fault.js --fix
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadVendorErrors, updateVendorError } = require('../../lib/vendor-errors');

const ROOT = path.join(__dirname, '..', '..');
const OPS = path.join(ROOT, 'data', 'ops-state');
const AUDIT = path.join(ROOT, 'data', 'audit.jsonl');
const FIX = process.argv.includes('--fix');

// orderNumber -> ShipStation orderId, harvested from every ops-state day file.
function orderIdIndex() {
  const idx = {};
  if (!fs.existsSync(OPS)) return idx;
  for (const f of fs.readdirSync(OPS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(OPS, f), 'utf8')); } catch { continue; }
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') {
          if (v.orderNumber && /^\d+$/.test(k)) idx[v.orderNumber] = k;
          walk(v);
        }
      }
    })(j);
  }
  return idx;
}

function emailedOrderIds() {
  const ids = new Map();   // orderId -> [timestamps]
  if (!fs.existsSync(AUDIT)) return ids;
  for (const line of fs.readFileSync(AUDIT, 'utf8').trim().split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.action !== 'pipeline-email-prosol') continue;
    for (const id of (e.orderIds || [])) {
      const k = String(id);
      if (!ids.has(k)) ids.set(k, []);
      ids.get(k).push(e.timestamp);
    }
  }
  return ids;
}

(async () => {
  const idx = orderIdIndex();
  const emailed = emailedOrderIds();
  console.log(`ops-state order mappings: ${Object.keys(idx).length}  ·  orderIds seen in prosol emails: ${emailed.size}\n`);

  const cases = loadVendorErrors().filter((r) => r.issue_type === 'delayed_shipment');
  const verdicts = { chargeable: [], ours: [], unknown: [] };

  for (const c of cases) {
    const id = idx[c.order_ref];
    let verdict, detail;
    if (!id) { verdict = 'unknown'; detail = 'order never reached ops-state — cannot confirm an email was sent'; }
    else if (emailed.has(id)) { verdict = 'chargeable'; detail = `emailed ${emailed.get(id)[0]}`; }
    else { verdict = 'ours'; detail = `orderId ${id} appears in NO prosol email`; }
    verdicts[verdict].push({ ...c, ssOrderId: id, detail });
  }

  for (const [k, label] of [
    ['chargeable', 'CHARGEABLE TO PROSOL — branch was emailed and did not tender'],
    ['ours', 'OURS — branch was never told (do NOT charge Prosol)'],
    ['unknown', 'CANNOT CONFIRM — treat as ours until proven otherwise'],
  ]) {
    const set = verdicts[k];
    console.log(`═══ ${label} (${set.length}) ═══`);
    for (const c of set) {
      console.log(`  ${String(c.id).padEnd(16)} ${String(c.date)}  ${String(c.location).padEnd(22)} ${String(c.order_ref).padEnd(21)} $${String(c.cost_label_cad).padStart(6)}  [${c.vendor}]`);
      console.log(`      ${c.detail}`);
    }
    console.log();
  }

  const spend = (s) => s.reduce((a, c) => a + Number(c.cost_label_cad || 0), 0).toFixed(2);
  console.log('────────────────────────────────────────');
  console.log(`genuinely chargeable to Prosol : $${spend(verdicts.chargeable)} across ${verdicts.chargeable.length}`);
  console.log(`our own notification failures  : $${spend(verdicts.ours)} across ${verdicts.ours.length}`);
  console.log(`unconfirmed                    : $${spend(verdicts.unknown)} across ${verdicts.unknown.length}`);

  if (!FIX) { console.log('\nRead-only. Re-run with --fix to reattribute the non-chargeable ones.'); return; }

  let fixed = 0;
  for (const c of [...verdicts.ours, ...verdicts.unknown]) {
    if (/^CFC/i.test(c.vendor || '')) continue;      // already reattributed
    updateVendorError(c.id, { vendor: 'CFC (pipeline)' },
      `Attribution verified 2026-08-04: ${c.detail}. Not chargeable to Prosol.`);
    console.log(`  reattributed ${c.id} → CFC (pipeline)`);
    fixed++;
  }
  console.log(`\n${fixed} case(s) reattributed.`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
