/**
 * Sample desk CLI (lib/sample-desk.js).
 *   node scripts/ops/sample-desk.js                    # shadow pass: reads everything, sends/buys nothing
 *   node scripts/ops/sample-desk.js --order=1446       # one order, shadow
 *   node scripts/ops/sample-desk.js --live [--order=N] # act: email vendors, buy labels, fulfil (what the cron does)
 *   node scripts/ops/sample-desk.js --status           # what the desk is holding
 *   node scripts/ops/sample-desk.js --read-test "<vendor reply text>"   # what Opus reads from a reply, no state
 * Runs on the Mac Mini (hello@ is read through the yourfloors-cs login there). Don't run --live while the server's
 * cron is live: two passes would race on the same state file.
 */
'use strict';
require('dotenv').config();
const desk = require('../../lib/sample-desk');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const has = (k) => process.argv.includes(`--${k}`);

(async () => {
  if (has('status')) {
    const s = desk.loadState();
    for (const [n, r] of Object.entries(s.orders)) {
      console.log(`#${n} ${r.customer}${r.done ? ` DONE (${r.closedWhy})` : ''}`);
      for (const l of Object.values(r.legs)) console.log(`   ${l.supplierName.padEnd(9)} ${l.status.padEnd(10)} chases=${l.chases} ${l.tracking.map((t) => t.number).join(', ')}`);
      for (const e of r.escalations || []) console.log(`   ! ${e.at.slice(0, 16)} ${e.why}`);
    }
    return;
  }
  if (has('read-test')) {
    const i = process.argv.indexOf('--read-test');
    const text = process.argv[i + 1] || '';
    const leg = { supplierName: 'Unifloor', mode: 'label', lines: [{ qty: 1, name: 'AquaFix SPC Grand Cru Romanée' }] };
    const newest = { id: 'x', at: new Date().toISOString(), from: 'vendor@example.com', fromName: 'Vendor', subject: `RE: [SAMPLE-${arg('order') || '1446'}] Sample request`, text };
    const r = await desk.readReply({ order: arg('order') || '1446', leg, thread: [newest], newest });
    console.log(JSON.stringify(r, null, 2));
    console.log('decision:', JSON.stringify(desk.decide(r, leg)), r?.parcels?.length ? JSON.stringify(desk.judgeParcels(r.parcels)) : '');
    return;
  }
  const live = has('live');
  console.log(live ? '*** LIVE ***' : '*** SHADOW: nothing is sent or bought ***');
  await desk.tick({ live, only: arg('order') });
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
