#!/usr/bin/env node
/**
 * Manual run of the stale-parcel reminder.
 *
 *   node scripts/ops/stale-parcel-reminder.js            # shadow, prints what it would send
 *   node scripts/ops/stale-parcel-reminder.js --preview  # shadow + the full email body
 *
 * Live sending is controlled ONLY by STALE_REMINDER_LIVE=1 in .env — there is no
 * --live flag, so a vendor email can never go out from a stray command.
 */
require('dotenv').config();
const { runReminderSweep, buildBranchEmail, TRIGGER_BIZ_DAYS, ESCALATE_BIZ_DAYS } = require('../../lib/stale-parcel-reminder');

(async () => {
  const preview = process.argv.includes('--preview');
  const live = process.env.STALE_REMINDER_LIVE === '1';
  console.log(`stale-parcel reminder — ${live ? 'LIVE' : 'SHADOW'} · Purolator only · trigger ${TRIGGER_BIZ_DAYS} business days · escalate at ${ESCALATE_BIZ_DAYS}\n`);
  const r = await runReminderSweep({ notify: async () => {} });
  console.log(r.report);
  console.log(`\nskipped: ${JSON.stringify(r.skipped)}`);
  if (preview) {
    for (const g of r.byBranch) {
      const { subject, text } = buildBranchEmail(g);
      console.log(`\n${'─'.repeat(72)}\nTO: klazzarotto@prosol.ca   CC: ${g.email || '(no branch desk)'}, mac@customfc.ca`);
      console.log(`SUBJECT: ${subject}\n\n${text}`);
    }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
