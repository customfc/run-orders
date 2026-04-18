#!/usr/bin/env node
/**
 * Daily analytics alerts — runs after the 6 AM FBA morning pull on weekdays.
 *
 * Checks run on the Phase B views (no new data sources). If any check fires,
 * all findings roll into one Telegram 'attn' message. Silent when nothing
 * to say — no spam.
 *
 * Trigger:
 *   weekday 07:15 ET (after morning pull at 06:00 + analytics ETL at 03:00,
 *   both of which have had time to finish)
 *   manual: node scripts/alerts/daily-alerts.js
 */

require('dotenv').config();
const telegram = require('../../lib/telegram');
const { runAllChecks } = require('../../lib/analytics-alerts');

async function main() {
  const findings = await runAllChecks();
  if (!findings.length) {
    console.log('[daily-alerts] no findings — staying quiet');
    return;
  }

  const subject = findings.length === 1
    ? findings[0].title
    : `Daily alerts — ${findings.length} category${findings.length > 1 ? 'ies' : 'y'}`;
  const body = findings.map((f) => [f.title, ...f.lines].join('\n')).join('\n\n');

  console.log('[daily-alerts] firing:', subject);
  for (const f of findings) console.log('  ' + f.title);
  await telegram.notify('attn', subject, body);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[daily-alerts] ERROR:', e.message);
    telegram.notify('attn', 'Daily alerts check crashed', e.message).catch(() => {});
    process.exit(1);
  });
}

module.exports = { main };
