#!/usr/bin/env node
/**
 * Daily Amazon unshipped check (lib/amazon-unshipped.js).
 *
 *   node scripts/ops/amazon-unshipped.js          # dry run: print what it would confirm and report, change nothing
 *   node scripts/ops/amazon-unshipped.js --live   # send missing tracking to Amazon, email Mac if anything's there
 *
 * server.js runs it --live at 08:30 BC every day.
 */
require('dotenv').config();
const unshipped = require('../../lib/amazon-unshipped');
const sp = require('../../lib/sp-api');
const ss = require('../../lib/shipstation-v2');
const kerdi = require('../../lib/kerdi-check');
const audit = require('../../lib/audit');

const has = (k) => process.argv.includes(`--${k}`);
const j = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ssList(kind, orderNumber) {
  const r = await ss.v1Request('GET', `/${kind}?orderNumber=${encodeURIComponent(orderNumber)}&pageSize=100`);
  if (r.status !== 200) throw new Error(`ShipStation ${kind} ${r.status}`);
  // orderNumber is a prefix match; split children carry the parent number plus a suffix.
  return (j(r)?.[kind] || []).filter((x) => String(x.orderNumber || '').startsWith(orderNumber));
}

const io = {
  listUnshipped: async ({ createdAfter }) => {
    const all = [];
    for await (const page of sp.iterateOrders({ createdAfter, orderStatuses: ['Unshipped', 'PartiallyShipped'] })) all.push(...page);
    return all;
  },
  orderItems: async (id) => {
    const out = [];
    let nextToken = null;
    do {
      const r = await sp.getOrderItems(id, { nextToken });
      out.push(...(r.payload?.OrderItems || []));
      nextToken = r.payload?.NextToken || null;
      if (nextToken) await sleep(2000);
    } while (nextToken);
    return out;
  },
  ssOrders: (n) => ssList('orders', n),
  ssShipments: async (n) => (await ssList('shipments', n)).map((s) => ({ trackingNumber: s.trackingNumber, carrierCode: s.carrierCode, shipDate: s.shipDate, voided: !!s.voided })),
  confirm: async (id, pkg) => {
    const r = await sp.confirmShipment(id, pkg);
    audit.log({ action: 'amazon-unshipped-confirm', order: id, tracking: pkg.trackingNumber, carrier: pkg.carrierCode, ok: r.ok, status: r.status, error: r.error || null });
    await sleep(1000);
    return r;
  },
  kerdi: (id) => kerdi.loadState().orders?.[id] || null,
  notify: async (out) => require('../../lib/emailer').sendEmail({
    to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca',
    subject: unshipped.emailSubject(out),
    text: unshipped.emailText(out),
  }),
};

(async () => {
  const live = has('live');
  const out = await unshipped.run({ io, live });
  const counts = Object.fromEntries(['confirmed', 'wouldConfirm', 'rejected', 'stillUnshipped', 'late', 'dueToday', 'errors'].map((k) => [k, out[k].length]));
  if (live) { audit.log({ action: 'amazon-unshipped-check', ...counts }); console.log(JSON.stringify(counts)); return; }
  console.log(unshipped.emailText(out) || 'Nothing unshipped past ship-by, nothing to confirm.');
  for (const w of out.wouldConfirm) console.log(`would confirm ${w.order}: ${JSON.stringify(w.packageDetail)}`);
  console.log(JSON.stringify(counts));
})().catch((e) => { console.error(e.message); process.exit(1); });
