#!/usr/bin/env node
/**
 * ProZone client-code earnings (lib/trade-earnings-run.js).
 *
 *   --propose            weekly (Mini crontab, Mondays): updates the ledger, stores this week's batch and emails Mac the
 *                        Review and approve link when there is something to credit, take back or check. Moves no money.
 *   --propose --dry      the same, but saves nothing and emails nobody (prints the batch)
 *   --apply --batch=<id> issues the current batch, same as Mac's tap on the emailed link (fallback when the link fails)
 *   --status             the ledger: entries by status, owed amounts, the current batch
 *
 * Rate: data/trade/trade-config.json earn.percent (5). One run at a time (logs/trade-earnings.lock).
 */

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const er = require(path.join(ROOT, 'lib', 'trade-earnings-run'));
const { earnRate } = require(path.join(ROOT, 'lib', 'trade-rules'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const money = (c) => `$${(Math.round(c) / 100).toFixed(2)}`;

async function main() {
  const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
  const rate = earnRate();

  if (flag('status')) {
    const s = er.loadState();
    const by = {};
    for (const e of Object.values(s.orders)) by[e.status] = (by[e.status] || 0) + 1;
    console.log(`ledger: ${Object.keys(s.orders).length} orders ${JSON.stringify(by)}; owed ${JSON.stringify(s.accounts)}`);
    console.log(s.batch ? `batch ${s.batch.id}: ${s.batch.items.length} items, ${s.batch.appliedAt ? `applied ${s.batch.appliedAt}` : 'not applied'}` : 'no batch');
    return;
  }

  if (flag('propose')) {
    const dry = flag('dry');
    const { batch, counts } = await er.withLock(() => er.propose(graphql, { rate, ...(dry ? { save: () => {} } : {}) }));
    console.log(`earnings propose ${batch.id}${dry ? ' (dry)' : ''}: ${counts.orders} orders with a member code, ${counts.recorded} new in the ledger, ${counts.waiting} waiting for delivery or pickup, ${batch.items.length} moves`);
    for (const it of batch.items) console.log(`  ${it.kind} ${money(it.amountCents)} ${it.code} ${it.orderName}`);
    if (dry || !batch.items.length) return;
    const { subject, html } = er.macEmail(batch);
    await require(path.join(ROOT, 'lib', 'emailer')).sendEmail({ to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca', subject, html });
    er.logEvent({ event: 'proposed', batch: batch.id, items: batch.items.length, totals: er.totals(batch.items) });
    console.log(`  emailed Mac: ${subject}`);
    return;
  }

  if (flag('apply')) {
    const id = opt('batch');
    if (!id) throw new Error('--apply needs --batch=<id> (see --status)');
    const { results } = await er.withLock(() => er.apply(graphql, id, { rate }));
    for (const r of results) console.log(`  ${r.outcome} ${r.kind} ${money(r.amountCents || 0)} ${r.orderName} ${r.detail || ''}`);
    return;
  }

  console.log('usage: --propose [--dry] | --apply --batch=<id> | --status');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
