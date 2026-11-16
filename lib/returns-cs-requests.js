/**
 * Return requests that reach us only through Amazon customer service, never as a return in Seller Central.
 *
 * Amazon CS writes "Return requested: No ... Send free shipping prepaid return label ... process the full refund"
 * (Rick, 701-3219418-6121847, 2026-11-13). With no return request the returns report has no row, so the returns
 * autopilot never saw it and the inbox card sat unanswered past Amazon's 48 h. The inbox handler (lib/amazon-inbox.js)
 * records the request here; the autopilot (lib/amazon-returns-autopilot.js) settles it under the same policy as a
 * report row (refund without return, prepaid label, or a hold for Mac), then the inbox drafts the reply from what
 * actually happened.
 *
 * File: data/returns-cs-requests.json  { orders: { "<order>": { at, inboxKey, said } } }
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'returns-cs-requests.json');

function load(file = DEFAULT_FILE) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.orders ||= {}; return s; } catch { return { orders: {} }; }
}

function save(state, file = DEFAULT_FILE) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

/** Record one request (first one per order wins); drops requests older than keepDays. */
function add(order, { at, inboxKey, said } = {}, { file = DEFAULT_FILE, now = new Date(), keepDays = 60 } = {}) {
  const s = load(file);
  for (const [o, r] of Object.entries(s.orders)) if ((now - new Date(r.at)) / 864e5 > keepDays) delete s.orders[o];
  if (!s.orders[order]) s.orders[order] = { at: at || now.toISOString(), inboxKey: inboxKey || null, said: String(said || '').slice(0, 500) };
  save(s, file);
  return s.orders[order];
}

module.exports = { load, save, add, DEFAULT_FILE };
