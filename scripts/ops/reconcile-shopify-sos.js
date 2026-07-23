#!/usr/bin/env node
// Reconcile Shopify orders → Salesforce Sales Orders: find fulfilled orders with
// no SF SO and (optionally) back-fill them.
//
//   node scripts/ops/reconcile-shopify-sos.js            # dry / SHADOW (report only)
//   node scripts/ops/reconcile-shopify-sos.js --create   # LIVE — create missing SOs
//   node scripts/ops/reconcile-shopify-sos.js --days 90   # widen the window
//
// See lib/shopify-so-reconcile.js for the SKIP rules (cancelled, unfulfilled,
// consolidated add-ons). Backfilled SOs are dated to the Shopify order date.
require('dotenv').config();
const { reconcileShopifySOs, formatReport } = require('../../lib/shopify-so-reconcile');

const args = process.argv.slice(2);
const live = args.includes('--create');
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;

(async () => {
  const report = await reconcileShopifySOs({
    live,
    ...(days ? { days } : {}),
    onProgress: (ev) => ev.message && console.log(ev.message),
  });
  console.log('\n' + formatReport(report));
  console.log('\nFULL:', JSON.stringify(report, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
