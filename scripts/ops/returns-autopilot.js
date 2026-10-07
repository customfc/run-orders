#!/usr/bin/env node
/**
 * Amazon returns autopilot, by hand (docs/RETURNS.md). The server runs it on a
 * schedule; this is for dry runs, approvals and looking at state.
 *
 *   node scripts/ops/returns-autopilot.js              # SHADOW: decide, preview, rate; change nothing
 *   node scripts/ops/returns-autopilot.js --sf         # ...and show the Salesforce records each would get
 *   node scripts/ops/returns-autopilot.js --live       # act (refunds, labels, emails). Mac Mini only.
 *   node scripts/ops/returns-autopilot.js --approve=702-1234567-1234567
 *   node scripts/ops/returns-autopilot.js --state
 */
require('dotenv').config();
const ap = require('../../lib/amazon-returns-autopilot');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const has = (k) => process.argv.includes(`--${k}`);
const money = ap.money;

(async () => {
  if (has('state')) {
    const s = ap.loadState();
    for (const [order, e] of Object.entries(s.orders || {})) {
      console.log(`${order}  ${e.stage.padEnd(16)} ${e.totalCents != null ? money(e.totalCents).padStart(9) : ''}  ${e.why || ''}`);
      for (const h of (e.history || []).slice(-3)) console.log(`    ${h.at.slice(0, 16)}  ${h.msg}`);
    }
    console.log('daily auto refunds:', JSON.stringify(s.daily || {}));
    return;
  }
  const approveOrder = arg('approve');
  if (approveOrder) {
    const e = ap.approve(approveOrder);
    console.log(`${approveOrder}: ${e.stage} (${e.decision || 'returnless'}). The next run settles it.`);
    return;
  }

  const live = has('live');
  const io = require('../../lib/amazon-returns-io').createIo();
  const out = await ap.run({ io, live });
  const tag = live ? 'LIVE' : 'SHADOW';
  console.log(`\n${tag} run ${new Date().toISOString()}\n`);
  for (const a of out.actions) {
    console.log(a.do === 'refund'
      ? `${a.shadow ? 'WOULD ' : ''}REFUND  ${a.order}  ${money(a.cents)}  ${(a.items || []).join('; ')}\n        ${a.why}`
      : `${a.shadow ? 'WOULD ' : ''}LABEL   ${a.order}  ${money(a.cents)} Purolator to ${a.branch}, then refund ${money(a.refundCents)}  ${(a.items || []).join('; ')}\n        ${a.why}`);
  }
  for (const h of out.held) console.log(`${h.info ? 'FYI    ' : 'HOLD   '} ${h.order}  ${h.cents != null ? money(h.cents) : ''}  ${(h.items || []).join('; ')}\n        ${h.why}`);
  for (const s of out.settled) console.log(`DONE    ${s.order}  ${s.why}`);
  for (const e of out.errors) console.log(`ERROR   ${e.order}  ${e.error}`);
  if (out.skipped) console.log(`(${out.skipped} left for the next run: per-run refund limit)`);
  if (!out.actions.length && !out.held.length && !out.errors.length) console.log('Nothing open.');

  if (has('sf') && !live) {
    const { logReturn } = require('../../lib/amazon-return-sf');
    const byOrder = new Map();
    if (out.actions.length) {
      const rows = await io.fetchReturns().catch(() => []);
      for (const r of ap.openReturnsByOrder(rows, new Date(), ap.policy().windowDays)) byOrder.set(r.order, r);
    }
    for (const a of out.actions) {
      const ret = byOrder.get(a.order);
      if (!ret) continue;
      const entry = { totalCents: a.refundCents ?? a.cents, label: a.do === 'label' ? { tracking: '(on purchase)', branch: a.branch } : null };
      try {
        const { planned } = await logReturn(ret, entry, { live: false });
        if (!planned) { console.log(`\nSF ${a.order}: case already exists`); continue; }
        console.log(`\nSF ${a.order}: Case "${planned.customerCase.Subject}" (From Customer, PO ${planned.pos.join(', ')}) with ${planned.customerLines.length} RMA line(s): ${planned.customerLines.map((l) => `qty ${l.PBSI__Quantity__c} ${l.PBSI__Reason_RMA_Line__c}`).join('; ')}`);
        if (planned.vendorCase) console.log(`   + Case "${planned.vendorCase.Subject}" (To Vendor) with ${planned.vendorLines.length} line(s) on the PO`);
      } catch (err) { console.log(`\nSF ${a.order}: ${err.message}`); }
    }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
