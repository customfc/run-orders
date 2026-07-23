#!/usr/bin/env node
// Reconcile Shopify orders → Salesforce Sales Orders: find fulfilled orders with
// no SF SO and (optionally) back-fill them.
//
//   node scripts/ops/reconcile-shopify-sos.js                    # dry / SHADOW (report only)
//   node scripts/ops/reconcile-shopify-sos.js --create           # LIVE — create current-month missing SOs
//   node scripts/ops/reconcile-shopify-sos.js --days 90          # widen the window
//   node scripts/ops/reconcile-shopify-sos.js --create --allow-prior --days 60
//        # DELIBERATE historical backfill — creates prior-month SOs too. Only run
//        # this with Lynnae's sign-off on dating (touches closed accounting months).
//
// By default the LIVE path refuses to create any SO dated before the 1st of the
// current month (prior accounting months are off-limits to the cron). SKIP rules
// (cancelled, unfulfilled, consolidated add-ons) live in lib/shopify-so-reconcile.js.
require('dotenv').config();
const { reconcileShopifySOs, formatReport } = require('../../lib/shopify-so-reconcile');

const args = process.argv.slice(2);
const live = args.includes('--create');
const allowPrior = args.includes('--allow-prior');
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;

(async () => {
  const report = await reconcileShopifySOs({
    live,
    ...(days ? { days } : {}),
    ...(allowPrior ? { minCreateDate: null } : {}),
    onProgress: (ev) => ev.message && console.log(ev.message),
  });
  console.log('\n' + formatReport(report));
  console.log('\nFULL:', JSON.stringify(report, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
