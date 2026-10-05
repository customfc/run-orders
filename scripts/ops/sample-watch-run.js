/**
 * Sample-order watchdog runner. Read-only scan + digest.
 *   node scripts/ops/sample-watch-run.js            # preview, no email, no state write
 *   node scripts/ops/sample-watch-run.js --commit   # send + persist state
 */
'use strict';
require('dotenv').config();
const { scanSamples, scanFollowUps, buildSampleDigest, loadState, saveState } = require('../../lib/sample-watch');

const ALERT_TO = process.env.SAMPLE_WATCH_EMAIL || 'mac@customfc.ca';

(async () => {
  const commit = process.argv.includes('--commit');
  const state = loadState();
  const scan = await scanSamples({ state });
  console.log(`open sample orders: ${scan.orders.length}`);
  for (const o of scan.orders) console.log(`  #${o.order} ${String(o.age).padStart(2)}d  ${o.stage.padEnd(17)} ${o.customer} — ${o.detail || 'moving normally'}`);

  const now = new Date();
  const { followUps } = await scanFollowUps({ state, now });
  for (const f of followUps) console.log(`  follow-up #${f.order} ${f.customer}: delivered ${f.deliveredAt}${f.stale ? ' (past the window, will be skipped)' : ''}`);
  const d = buildSampleDigest({ scan, followUps, state, now });
  console.log(`\nshouldSend=${d.shouldSend}${d.counts ? `  new=${d.counts.new} escalated=${d.counts.escalated} known=${d.counts.known} followUp=${d.counts.followUp}` : ''}`);
  if (!d.shouldSend) { if (commit) saveState(d.state); console.log('(quiet — nothing changed)'); return; }

  console.log(`\nSUBJECT: ${d.subject}\n${'-'.repeat(60)}\n${d.body}`);
  if (!commit) { console.log('(dry run — add --commit to send)'); return; }
  const { sendEmail } = require('../../lib/emailer');
  const r = await sendEmail({ to: ALERT_TO, subject: d.subject, text: d.body });
  saveState(d.state);
  console.log(`sent to ${ALERT_TO} messageId=${r.messageId}`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
