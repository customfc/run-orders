#!/usr/bin/env node
/*
 * scripts/trade/pickup-messages-draft.js: prints the Coast pickup customer messages as a review draft (markdown on
 * stdout), built from lib/pickup-messages.js and lib/pickup-eta.js with example orders, so the draft Mac reads is
 * exactly what the code would send. Sends nothing, reads nothing but data/trade/pickup-schedule.json.
 *
 *   node scripts/trade/pickup-messages-draft.js > ../cfc-projects/02-yf-schluter-trade/drafts/pickup-messages.md
 */

'use strict';

const path = require('path');
const eta = require(path.join(__dirname, '..', '..', 'lib', 'pickup-eta'));
const msg = require(path.join(__dirname, '..', '..', 'lib', 'pickup-messages'));

const S = eta.DEFAULT_SCHEDULE;
const d = (x) => eta.formatCustomerDate(x);
const example = { orderName: '#1500', firstName: 'Sam', location: 'sechelt' };
const out = [];
const p = (...lines) => out.push(...lines);

function scenario(label, paidAt, lines, location = 'sechelt') {
  const r = eta.pickupEta({ paidAt, location, lines });
  const where = location === 'sechelt' ? 'Sechelt' : 'Powell River';
  let what = r.kind === 'ready_now' ? `ready ${d(r.readyBy)}` : `${location === 'sechelt' ? 'rides' : 'supplier run ' + d(r.supplierRunDay || r.truckDay) + ', then the Powell River truck'} ${location === 'sechelt' ? 'the ' + d(r.truckDay) + ' truck' : d(r.truckDay)}, ready ${d(r.readyBy)}`;
  if (r.needsConfirm) what += ` (promised; if the supplier confirms the earlier run: ready ${d(r.readyByIfConfirmed)})`;
  p(`- ${label} (${where}): ${what}`);
}

function message(title, when, type, ctx) {
  const m = msg.buildPickupMessage(type, ctx);
  p(`## ${title}`, '', `When: ${when}`, `From: ${m.from}   Reply-to: ${m.replyTo}`, '', `Subject: ${m.subject}`, '', m.text.trimEnd(), '');
}

const ready = eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: ['on_shelf'] });
const ordered = eta.pickupEta({ paidAt: '2026-10-19T10:00', location: 'sechelt', lines: ['on_shelf', 'order_in'] });
const late = eta.delayedEta({ missedTruckDay: ordered.truckDay, location: 'sechelt' });
const rem = eta.reminderDates(ordered.readyBy);
const tpl = msg.shopifyReadyForPickupTemplate();
const placeholders = new Set(tpl.placeholders);
for (const type of msg.TYPES) msg.buildPickupMessage(type, { ...example, readyBy: '2026-10-21', truckDay: '2026-10-20', readySince: '2026-10-21', missedTruckDay: '2026-10-20', today: '2026-10-19' }).placeholders.forEach((x) => placeholders.add(x));

p(
  '# Coast pickup messages: drafts for Mac',
  '',
  `Generated ${new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10)} (BC) by run-orders scripts/trade/pickup-messages-draft.js from lib/pickup-messages.js and`,
  'lib/pickup-eta.js (branch trade/02). Nothing here is sent. Change the copy in lib/pickup-messages.js, the rules in',
  'data/trade/pickup-schedule.json, then rerun the script so this file matches the code.',
  '',
  'Anything in [MAC: ...] is yours to fill. The code refuses to send a message that still has one.',
  'Every message: from YourFloors Support <hello@yourfloors.ca>, replies to hello@yourfloors.ca, signed "The YourFloors team".',
  'The supplier is never named. The customer is told to wait for the "ready for pickup" email before coming in.',
  '',
  '# How the dates work',
  '',
  `- In stock at the pickup location: ready the same business day if paid before ${S.store.same_day_cutoff}, else the next business morning.`,
  `- Anything to order in rides our ${S.truck.run_days.map((x) => ({ tue: 'Tuesday', fri: 'Friday' }[x] || x)).join(' and ')} supplier run. It goes to the supplier any time the business day before the run (confirmed). Sent after ${S.truck.confirm_after_time} that day, the supplier must confirm it can still make the truck: the customer is promised the next run, and gets it sooner if they confirm (confirmed).`,
  '- The truck is back in Sechelt that evening; the order is ready the next business morning (confirmed).',
  `- Powell River: goods go over on the Thursday truck (confirmed). They must be ready at Sechelt the business day before, and are ready in Powell River the next business morning, Friday [MAC: or Thursday afternoon?]. Items already on the Sechelt shelf just need the Thursday truck.`,
  '- One item to order in holds the whole order, so it is all ready together.',
  `- Business days: Monday to Friday [MAC: Saturday half day?]. Holidays close the store and cancel a truck on that day: ${S.holidays.map((h) => `${h.name} (${d(h.date)})`).join(', ')}.`,
  `- Reminders: ${S.reminders.first_after_business_days} and ${S.reminders.second_after_business_days} business days after the order is ready, if not picked up.`,
  '',
  'Examples (BC time):',
);
scenario('In stock, paid Monday 10:00', '2026-10-19T10:00', ['on_shelf']);
scenario('In stock, paid Monday 4:00 pm', '2026-10-19T16:00', ['on_shelf']);
scenario('Order in, paid Monday 10:00', '2026-10-19T10:00', ['order_in']);
scenario('Order in, paid Tuesday 3:00 pm', '2026-10-20T15:00', ['order_in']);
scenario('Order in, paid Monday 4:00 pm (after 2 pm the day before)', '2026-10-19T16:00', ['order_in']);
scenario('Order in, paid Thursday 4:00 pm (after 2 pm the day before)', '2026-10-22T16:00', ['order_in']);
scenario('Order in, paid Friday 5:00 pm', '2026-10-23T17:00', ['order_in']);
scenario('Order in, paid Monday Sep 28 10:00 (Sep 30 holiday)', '2026-09-28T10:00', ['order_in']);
scenario('In stock, paid Tuesday Sep 29 4:00 pm (Sep 30 holiday)', '2026-09-29T16:00', ['on_shelf']);
scenario('Order in, paid Wednesday Dec 23 (no truck on Christmas)', '2026-12-23T10:00', ['order_in']);
scenario('Order in, paid Monday 10:00', '2026-10-19T10:00', ['order_in'], 'powell_river');
scenario('Order in, paid Wednesday 10:00', '2026-10-21T10:00', ['order_in'], 'powell_river');
scenario('On the Sechelt shelf, paid Wednesday 10:00', '2026-10-21T10:00', ['at_sechelt'], 'powell_river');
scenario('On the Powell River shelf, paid Monday 10:00', '2026-10-19T10:00', ['on_shelf'], 'powell_river');
p(
  '',
  `The messages below use order #1500 for Sam, paid Monday, October 19 at 10:00. In stock: ready ${d(ready.readyBy)}.`,
  `With one item to order in: truck ${d(ordered.truckDay)}, ready ${d(ordered.readyBy)}; if that truck misses it, the next is ${d(late.truckDay)}, ready ${d(late.readyBy)}.`,
  '',
);

message('(a) Order received, all in stock (optional)', 'when the order is paid and everything is on the shelf. Optional: Shopify\'s own order confirmation may be enough.', 'received_in_stock', { ...example, readyBy: ready.readyBy, today: '2026-10-19' });
message("(b) We're bringing it in", 'when the order is paid and something has to be ordered in', 'ordering_in', { ...example, readyBy: ordered.readyBy, truckDay: ordered.truckDay, partial: true });
p('Variant when the whole order is ordered in: the second paragraph reads', '', msg.buildPickupMessage('ordering_in', { ...example, readyBy: ordered.readyBy, truckDay: ordered.truckDay }).text.split('\n')[2], '', 'and the "We keep your order together" line is left out.', '');
message('(c) On the truck today', `the morning of the truck day (${d(ordered.truckDay)} in the example)`, 'on_truck', { ...example, readyBy: ordered.readyBy });

p(
  '## (d) Ready for pickup (Shopify\'s own email)',
  '',
  'When: someone presses "Mark as ready for pickup" on the order in Shopify. Shopify sends this, not run-orders.',
  'Where: Shopify admin, Settings, Notifications, "Ready for pickup". Replace the intro text only and keep Shopify\'s',
  'order summary. The location lines depend on a `location` variable that is not verified in this template: check the',
  'preview there. If it shows the generic line for both stores, delete the two location lines and rely on the pickup',
  'instructions below, which Shopify shows per location.',
  '',
  `Subject: ${tpl.subject}`,
  '',
  tpl.body.trimEnd(),
  '',
  'Pickup instructions for each location (Shopify pickup settings, 01 task A7):',
  '',
  `Sechelt Warehouse: ${msg.pickupInstructions('sechelt')}`,
  '',
  `Powell River Showroom & Warehouse: ${msg.pickupInstructions('powell_river')}`,
  '',
);

message('(e) Reminder after 3 business days', `${S.reminders.first_after_business_days} business days after it was marked ready, if not picked up (${d(rem.first)} in the example)`, 'reminder_1', { ...example, readySince: ordered.readyBy });
message('(f) Second reminder after 7 business days', `${S.reminders.second_after_business_days} business days after it was marked ready, if not picked up (${d(rem.second)} in the example)`, 'reminder_2', { ...example, readySince: ordered.readyBy });
message('(g) Delayed', 'the truck came back without it: the next truck day and new ready date', 'delayed', { ...example, missedTruckDay: late.missedTruckDay, truckDay: late.truckDay, readyBy: late.readyBy });
message('(h) Picked up, thanks', 'when the order is marked picked up (Shopify also has an optional "Picked up" email; use one of the two, not both)', 'picked_up', example);

p('# Still to fill [MAC]', '', ...[...placeholders].sort().map((x) => `- ${x}`), '');
p(
  '# Questions for Mac',
  '',
  '- Order cutoff for a truck: the business day before at 2:00 pm? (Tuesday truck: Monday 2 pm. Friday truck: Thursday 2 pm.)',
  '- Is the truck back in Sechelt the same evening, ready the next morning?',
  '- Powell River: one business day after Sechelt, or Powell River\'s own order day?',
  '- Same-day ready for in-stock orders paid before 2:00 pm: right?',
  '- Saturday pickups at Sechelt (half day)?',
  '- Hours for each location, and how long a ready order is held.',
  '- Is the warehouse closed on each holiday listed? Is Monday, December 28 a day off?',
  '- Send (a), or leave it to Shopify\'s order confirmation?',
  '- (h): our email or Shopify\'s "Picked up" email?',
  '- Mixed orders wait for the ordered-in item. Offer to let people take the in-stock part early? (Not offered in the copy.)',
  '',
);

process.stdout.write(`${out.join('\n')}`);
