/**
 * Daily Amazon unshipped check: Amazon's own list of unshipped seller-fulfilled orders, held against ours.
 *
 * 2026-11-01: 702-0613008-0134632 and 702-7400461-1158611 (Aqua Mix, Prosol Sudbury and Calgary North) were
 * labelled 10-21 and DELIVERED, and ShipStation recorded marketplaceNotified: true on both, but Amazon never took
 * the tracking. Seller Central called them late for eleven days, nothing here noticed (every check looked at our
 * side: labels, scans), and Mac cancelled them on the auto-cancel deadline: the buyers kept the goods and were never
 * charged. The same morning a Kerdi-Line channel ($418.97) sat held past ship-by on a card nobody tapped.
 *
 * Each morning:
 *   - Amazon says unshipped and ShipStation has a live label: send the tracking to Amazon ourselves (Orders API
 *     confirmShipment, synchronous, so a rejection comes back as text instead of a "notified" flag). A label made
 *     today is left to ShipStation's own notify. A confirm Amazon accepted that still shows unshipped the next
 *     morning goes to Mac.
 *   - No label and ship-by is today or gone: listed for Mac with why (Kerdi-Line hold, ShipStation status).
 * One email, only when there's something in it. State: data/amazon-unshipped.json.
 *
 * io:
 *   listUnshipped({ createdAfter }) → Amazon orders (Unshipped + PartiallyShipped)
 *   orderItems(amazonOrderId) → Amazon order items
 *   ssOrders(orderNumber) → ShipStation orders for it (split children included)
 *   ssShipments(orderNumber) → ShipStation shipments { trackingNumber, carrierCode, shipDate, voided }
 *   confirm(amazonOrderId, packageDetail) → { ok, status, error }
 *   kerdi(amazonOrderId) → Kerdi-Line check state for the order, or null
 *   notify(out) → void
 */

const fs = require('fs');
const path = require('path');
const { CARRIER_NAMES } = require('./amazon-fulfillment');

const DEFAULT_STATE = path.join(__dirname, '..', 'data', 'amazon-unshipped.json');
// BC is UTC-7 year-round (see the counter-stock schedule in server.js).
const pacificDate = (d) => new Date(new Date(d).getTime() - 7 * 3600e3).toISOString().slice(0, 10);
const endOfPacificDay = (d) => new Date(`${pacificDate(d)}T23:59:59-07:00`);

function loadState(file = DEFAULT_STATE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { confirms: {} }; }
}
function saveState(state, file = DEFAULT_STATE) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

/** Why an order with no label hasn't shipped, in Mac's words. */
function whyNotShipped(ssOrders, kerdi) {
  if (kerdi && !kerdi.releasedAt && kerdi.replyAt) return `Kerdi-Line hold: the buyer replied ${pacificDate(kerdi.replyAt)} and it waits on your Send in the "Amazon messages" email`;
  if (kerdi && !kerdi.releasedAt && kerdi.askedAt && !kerdi.askFailedAt) return `Kerdi-Line hold: buyer asked ${pacificDate(kerdi.askedAt)}`;
  if (!ssOrders.length) return 'not in ShipStation';
  const statuses = [...new Set(ssOrders.map((o) => o.orderStatus))];
  if (statuses.includes('on_hold')) return 'on hold in ShipStation';
  if (statuses.includes('awaiting_shipment')) return 'in ShipStation with no label yet (skipped by the pipeline?)';
  if (statuses.every((s) => s === 'shipped')) return 'ShipStation says shipped but has no label on it (shipped outside ShipStation?)';
  if (statuses.every((s) => s === 'cancelled')) return 'cancelled in ShipStation but still open on Amazon';
  return `ShipStation: ${statuses.join(', ')}`;
}

/** Amazon wants a ship time after the order and not in the future; ShipStation only gives a date. */
function shipTime(shipDate, purchaseDate, now) {
  const t = Math.min(now.getTime(), new Date(`${String(shipDate).slice(0, 10)}T20:00:00Z`).getTime() || now.getTime());
  return new Date(Math.max(t, new Date(purchaseDate).getTime() + 3600e3)).toISOString();
}

async function run({ io, live = false, now = new Date(), stateFile = DEFAULT_STATE, lookbackDays = 30, stillHours = 20 } = {}) {
  const state = loadState(stateFile);
  state.confirms ||= {};
  const out = { live, confirmed: [], wouldConfirm: [], rejected: [], stillUnshipped: [], late: [], dueToday: [], errors: [] };
  const orders = (await io.listUnshipped({ createdAfter: new Date(now - lookbackDays * 864e5).toISOString() }))
    .filter((o) => o.FulfillmentChannel === 'MFN');
  const today = pacificDate(now);

  for (const o of orders) {
    const id = o.AmazonOrderId;
    const base = { order: id, total: o.OrderTotal?.Amount ? Number(o.OrderTotal.Amount) : null, placed: pacificDate(o.PurchaseDate), shipBy: o.LatestShipDate ? pacificDate(o.LatestShipDate) : null };
    try {
      const labels = (await io.ssShipments(id)).filter((s) => !s.voided && s.trackingNumber)
        .sort((a, b) => String(b.shipDate).localeCompare(String(a.shipDate)));
      if (labels.length) {
        const prior = state.confirms[id];
        if (prior?.ok) {
          if ((now - new Date(prior.at)) / 36e5 >= stillHours) out.stillUnshipped.push({ ...base, tracking: prior.trackingNumber, sentAt: pacificDate(prior.at), why: 'Amazon accepted our tracking but still shows it unshipped' });
          continue;
        }
        if (o.OrderStatus === 'PartiallyShipped') {
          out.stillUnshipped.push({ ...base, tracking: labels.map((l) => l.trackingNumber).join(', '), why: 'partly confirmed on Amazon: confirm the rest by hand in Seller Central' });
          continue;
        }
        const label = labels[0];
        if (String(label.shipDate).slice(0, 10) >= today) continue; // ShipStation's own notify still has time
        const carrierCode = CARRIER_NAMES[label.carrierCode];
        const entry = { ...base, tracking: label.trackingNumber, carrier: carrierCode || label.carrierCode, shipped: String(label.shipDate).slice(0, 10), otherLabels: labels.slice(1).map((l) => l.trackingNumber) };
        if (!carrierCode) { out.rejected.push({ ...entry, error: `no Amazon carrier name for ShipStation carrier ${label.carrierCode}` }); continue; }
        // One package carries every unshipped unit, as ShipStation's own markasshipped does.
        const orderItems = (await io.orderItems(id))
          .map((i) => ({ orderItemId: String(i.OrderItemId), quantity: Number(i.QuantityOrdered || 0) - Number(i.QuantityShipped || 0) }))
          .filter((i) => i.quantity > 0);
        if (!orderItems.length) continue;
        const packageDetail = { packageReferenceId: '1', carrierCode, trackingNumber: label.trackingNumber, shipDate: shipTime(label.shipDate, o.PurchaseDate, now), orderItems };
        if (!live) { out.wouldConfirm.push({ ...entry, packageDetail }); continue; }
        const r = await io.confirm(id, packageDetail);
        state.confirms[id] = { at: now.toISOString(), ok: !!r.ok, trackingNumber: label.trackingNumber, carrier: carrierCode, error: r.error || null };
        saveState(state, stateFile);
        (r.ok ? out.confirmed : out.rejected).push({ ...entry, ...(r.ok ? {} : { error: r.error || `HTTP ${r.status}` }) });
        continue;
      }
      if (!o.LatestShipDate || new Date(o.LatestShipDate) > endOfPacificDay(now)) continue;
      const why = whyNotShipped(await io.ssOrders(id), io.kerdi(id));
      (new Date(o.LatestShipDate) < now ? out.late : out.dueToday).push({ ...base, why });
    } catch (err) {
      out.errors.push({ order: id, error: err.message });
    }
  }

  if (live) saveState(state, stateFile);
  if (live && io.notify && (out.confirmed.length || out.rejected.length || out.stillUnshipped.length || out.late.length || out.dueToday.length || out.errors.length)) {
    await io.notify(out);
  }
  return out;
}

const money = (n) => (n == null ? '' : ` $${n.toFixed(2)}`);

/** The email: one line per order, the ones that need Mac first. */
function emailText(out) {
  const L = [];
  const section = (title, rows, line) => { if (!rows.length) return; L.push(title); rows.forEach((r) => L.push(`  ${line(r)}`)); L.push(''); };
  section('Past ship-by, not shipped:', out.late, (r) => `${r.order}${money(r.total)}  placed ${r.placed}, ship-by ${r.shipBy}: ${r.why}`);
  section('Due to ship today, no label yet:', out.dueToday, (r) => `${r.order}${money(r.total)}  placed ${r.placed}: ${r.why}`);
  section('Amazon refused our tracking, confirm by hand in Seller Central (Orders, Confirm shipment):', out.rejected, (r) => `${r.order}${money(r.total)}  ${r.carrier} ${r.tracking}: ${r.error}`);
  section('Still unshipped on Amazon after we sent the tracking:', out.stillUnshipped, (r) => `${r.order}${money(r.total)}  ${r.tracking}${r.sentAt ? ` (sent ${r.sentAt})` : ''}: ${r.why}`);
  section('Tracking sent to Amazon (shipped, but Amazon still showed it unshipped):', out.confirmed, (r) => `${r.order}${money(r.total)}  ${r.carrier} ${r.tracking}, shipped ${r.shipped}${r.otherLabels.length ? ` (also on the order: ${r.otherLabels.join(', ')})` : ''}`);
  section('Errors:', out.errors, (r) => `${r.order}: ${r.error}`);
  return L.join('\n').trim();
}

function emailSubject(out) {
  const parts = [];
  if (out.late.length) parts.push(`${out.late.length} past ship-by`);
  if (out.dueToday.length) parts.push(`${out.dueToday.length} due today`);
  if (out.rejected.length + out.stillUnshipped.length) parts.push(`${out.rejected.length + out.stillUnshipped.length} need confirming by hand`);
  if (out.confirmed.length) parts.push(`${out.confirmed.length} tracking sent`);
  if (out.errors.length) parts.push(`${out.errors.length} error${out.errors.length === 1 ? '' : 's'}`);
  return `Amazon unshipped: ${parts.join(', ')}`;
}

module.exports = { run, emailText, emailSubject, whyNotShipped, shipTime, pacificDate, loadState, DEFAULT_STATE };
