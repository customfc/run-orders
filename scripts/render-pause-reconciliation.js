// Render a human-readable reconciliation summary from the day's pipeline state.
// Usage: node scripts/render-pause-reconciliation.js 2026-04-27 > /tmp/recon.md

const fs = require('fs');
const path = require('path');

const date = process.argv[2] || new Date().toISOString().split('T')[0];
const file = path.join(__dirname, '..', 'data', 'pause-reconciliation', `${date}.json`);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

const state = raw.state;
const summary = raw.summary || {};
const labels = state.phases?.buy?.labels || {};
const errors = state.errors || [];
const posByTracking = state.phases?.pos?.byTracking || {};
const emailByOrder = state.phases?.email?.byOrder || {};
const pickupsByGroup = state.phases?.pickups?.byGroup || {};

let out = '';
const p = (s) => { out += s + '\n'; };

p(`# Pipeline Pause Reconciliation — ${date}`);
p('');
p(`**Pipeline started:** ${state.startedAt}`);
p(`**Reason for pause:** Salesforce outage — labels were still printing but SOs/POs cannot be written until SF recovers.`);
p('');
p('---');
p('## Top-line counters');
p('');
p(`| metric | value |`);
p(`|---|---:|`);
p(`| Staged | ${summary.staged ?? 0} |`);
p(`| Labels bought | ${summary.labelsBought ?? 0} |`);
p(`| Total label cost | $${(summary.totalLabelCost ?? 0).toFixed(2)} |`);
p(`| POs created | ${summary.posCreated ?? 0} |`);
p(`| Emails sent | ${summary.emailsSent ?? 0} |`);
p(`| Pickups booked | ${summary.pickupsBooked ?? 0} |`);
p(`| Errors | ${summary.errorCount ?? 0} |`);
p('');
p('---');
p('## Labels printed without SF SOs (need reconciliation)');
p('');
const labelEntries = Object.entries(labels);
if (!labelEntries.length) p('_None_');
else {
  p(`These ${labelEntries.length} shipments printed today. Each one needs a corresponding Salesforce SO + PO created when SF is back. The pos phase should auto-pick these up on resume — verify by counting created SO records against this list.`);
  p('');
  p(`| Order # | Order ID | Tracking | Carrier | Cost | SKU(s) |`);
  p(`|---|---|---|---|---:|---|`);
  for (const [orderId, lbl] of labelEntries) {
    const skus = (lbl.packages || []).flatMap((pk) => pk.items || []).map((it) => it.sku).join(', ');
    p(`| ${lbl.orderNumber} | ${orderId} | \`${lbl.trackingNumber}\` | ${lbl.carrierCode} | $${lbl.labelCost?.toFixed(2)} | ${skus} |`);
  }
}
p('');
p('---');
p('## Errors blocking labels (orders that did NOT ship)');
p('');
if (!errors.length) p('_None_');
else {
  for (const e of errors) {
    const ctx = e.context || {};
    const reasonShort = (e.reason || '').match(/ExceptionMessage":"([^"]+)"/)?.[1] || e.reason?.slice(0, 200);
    p(`- **${ctx.orderNumber || ctx.orderId || '(unknown order)'}** — ${e.phase} phase @ ${e.at}`);
    p(`  - Cause: ${reasonShort}`);
  }
}
p('');
p('---');
p('## POs / SF records pending (will be created on resume)');
p('');
const posCount = Object.keys(posByTracking).length;
p(`POs already created: **${posCount}**`);
p('');
if (summary.poNumbers?.length) {
  p('PO numbers:');
  for (const n of summary.poNumbers) p(`- \`${n}\``);
}
p('');
p(`Outstanding: every printed-label entry above without a corresponding entry in \`state.phases.pos.byTracking\` is a pending SF SO+PO write. As of snapshot, that's all ${labelEntries.length} labels.`);
p('');
p('---');
p('## Vendor emails pending');
p('');
const emailCount = Object.keys(emailByOrder).length;
p(`Emails sent: **${emailCount}**`);
p('');
p(`Outstanding: any orders whose POs would go out via the FBA PO sender (cron at 14:00 PT) — currently nothing has fired today. After resume, the next 14:00 cron will catch any unsent vendor emails.`);
p('');
p('---');
p('## Pickups pending');
p('');
const pickupCount = Object.keys(pickupsByGroup).length;
p(`Pickup groups booked: **${pickupCount}**`);
p('');
p(`Outstanding: pickups would normally book at 14:30 PT for today's labeled shipments. After resume, the next 14:30 cron handles this.`);
p('');
p('---');
p('## Order-of-operations on resume');
p('');
p('1. Confirm Salesforce login works (manual probe via dashboard or `sf-login` test).');
p('2. Send `/resume` to Telegram bot.');
p('3. Next scheduled cron picks up where things left off:');
p('   - `pos` phase reads `state.phases.buy.labels` and creates SF SOs/POs only for entries not in `state.phases.pos.byTracking`. Verify count matches the labels-printed table above.');
p('   - `email` phase fires at 14:00 PT (or sooner via manual trigger) for FBA POs.');
p('   - `pickups` phase fires at 14:30 PT for printed labels.');
p('4. Manually retry the 4 errored orders:');
p(`   - 3 × insufficient-funds: top up ShipStation, then retry the staged-but-unlabeled orders.`);
p(`   - 1 × UPS state code error: fix the destination address on order 702-7794489-8149801, then retry.`);
p('');
p('---');
p('Snapshot raw JSON: `data/pause-reconciliation/' + date + '.json`');

console.log(out);
