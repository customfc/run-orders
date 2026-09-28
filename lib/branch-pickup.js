/**
 * Branch pickup planner (pure: no I/O, no Prosol, no Shopify). Build plan B;
 * research run-orders.md A.4, shopify-pickup.md section 2.
 *
 * National ProZone pickup is a $0 shipping rate per approved Prosol branch,
 * titled "Pickup: <City> trade counter (ready in 2-4 business days)". Staff-built
 * carts may carry a pickup_location=<CODE> attribute instead. Coast pickups
 * (Sechelt, Powell River) come off our own shelf and need no Prosol PO; branch
 * pickups DO need a PO to that branch, placed as a customer pickup.
 *
 * This module decides, it never acts:
 *   resolvePickup(order, branches)   kind coast_pickup | branch_pickup | null, and the branch
 *   checkStock(lines, code, stock)   READY | NEEDS_TRANSFER | HOLD, per line and overall
 *   planPickup(...)                  both, plus the next step
 *   buildPickupEmail(...)            PO email: customer first and last name and our
 *                                    order number only. No address, phone or email.
 *                                    "CUSTOMER PICKUP (will call)", never carrier
 *                                    wording (that tripped Tecsys once).
 *   transition(record, to)           NEW -> PO_SENT -> READY -> PICKED_UP, or CANCELLED
 *
 * Any pickup signal that can't be resolved to exactly one branch still returns a
 * non-null kind with a hold reason: it is a pickup, so it must never reach the
 * label path, and a human picks the branch.
 *
 * Branch table: the prosol-location-map.json shape (object keyed by id, or an
 * array) of { code, city, province, contact_email, active, non_prosol }, or
 * { branches: [...] } rows with pickup_label, rate_title and enabled
 * (data/trade/pickup-branches.json). Titles match the exact rate title first,
 * then the pickup label, then the city; two hits is a hold, never a guess.
 * Vendor warehouses (non_prosol) are never pickup branches; enabled:false
 * branches (Prosol hasn't agreed yet) are held. Stock: { CODE: { sku: qty } }
 * where qty is a number or { qty } (never Prosol's boolean `available`).
 */

const COAST_CITIES = ['sechelt', 'powell river'];
const KINDS = ['coast_pickup', 'branch_pickup'];
const STATES = ['NEW', 'PO_SENT', 'READY', 'PICKED_UP', 'CANCELLED'];
const TRANSITIONS = {
  NEW: ['PO_SENT', 'CANCELLED'],
  PO_SENT: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: [],
  CANCELLED: [],
};

/** "St. Catharines", "St-Catharines", "ST CATHARINES" -> "st catharines"; accents dropped. */
function normCity(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.\-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const normCode = (s) => String(s || '').trim().toUpperCase();

function nodes(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.nodes)) return x.nodes;
  if (Array.isArray(x.edges)) return x.edges.map((e) => e.node);
  return [];
}

function pushTo(map, key, entry) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  if (!map.get(key).includes(entry)) map.get(key).push(entry);
}

/**
 * Index a branch table by code, by exact rate title, by pickup label and by city.
 * Accepts prosol-location-map.json (object keyed by id), an array, or
 * { branches: [...] } (data/trade/pickup-branches.json: pickup_label,
 * rate_title, enabled). Inactive rows are dropped; enabled:false rows are kept
 * so an order naming one is held, not guessed.
 */
function indexBranches(table) {
  if (table && table.byCode instanceof Map) return table;
  const rows = Array.isArray(table) ? table
    : table && Array.isArray(table.branches) ? table.branches
      : Object.values(table || {});
  const byCode = new Map();
  const byTitle = new Map();
  const byLabel = new Map();
  const byCity = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.active === false || !r.code) continue;
    const code = normCode(r.code);
    if (byCode.has(code)) continue; // legacy duplicate rows (old_*) share a code
    const city = normCity(r.pickup_city || r.city);
    const label = normCity(r.pickup_label);
    const emails = Array.isArray(r.contact_email) ? r.contact_email : [r.contact_email || r.email].filter(Boolean);
    const entry = {
      code,
      city: r.pickup_label || r.city || null,
      province: r.province || null,
      emails,
      coast: r.coast === true || COAST_CITIES.includes(city) || COAST_CITIES.includes(label),
      vendor: !!r.non_prosol,
      enabled: r.enabled !== false,
    };
    byCode.set(code, entry);
    if (r.rate_title) pushTo(byTitle, normCity(r.rate_title), entry);
    pushTo(byLabel, label, entry);
    pushTo(byCity, city, entry);
  }
  return { byCode, byTitle, byLabel, byCity };
}

/** "Pickup: Calgary North trade counter (ready in 2-4 business days)" -> "Calgary North". Not a pickup title -> null. */
function parsePickupTitle(title) {
  const m = String(title || '').match(/^\s*pick\s?-?up\s*:\s*(.*)$/i);
  if (!m) return null;
  const city = m[1]
    .split(/\btrade counter\b/i)[0]
    .split('(')[0]
    .split(/\s+-\s+/)[0]
    .trim();
  return { city };
}

/** Every pickup_location code on the order (custom attributes, note attributes, or a note line). */
function pickupAttributeCodes(order) {
  const out = [];
  const add = (v) => { const c = normCode(v); if (c && !out.includes(c)) out.push(c); };
  const pairs = [
    ...nodes(order.customAttributes).map((a) => [a.key, a.value]),
    ...nodes(order.noteAttributes || order.note_attributes).map((a) => [a.name || a.key, a.value]),
  ];
  for (const [k, v] of pairs) {
    if (String(k || '').trim().toLowerCase() === 'pickup_location') add(v);
    else {
      const m = String(v || '').match(/pickup_location\s*=\s*([A-Za-z0-9_]+)/i);
      if (m) add(m[1]);
    }
  }
  for (const m of String(order.note || '').matchAll(/pickup_location\s*=\s*([A-Za-z0-9_]+)/gi)) add(m[1]);
  return out;
}

function shippingTitles(order) {
  const lines = [order.shippingLine, ...nodes(order.shippingLines), ...nodes(order.shipping_lines)].filter(Boolean);
  return lines.map((l) => l.title || '').filter(Boolean);
}

function branchResult(e, source) {
  if (e.coast) return { kind: 'coast_pickup', branch: e.code, city: e.city, source };
  if (e.vendor) return { kind: 'branch_pickup', branch: null, city: e.city, source, hold: 'not_a_pickup_branch', code: e.code };
  if (!e.enabled) return { kind: 'branch_pickup', branch: null, city: e.city, source, hold: 'branch_not_enabled', code: e.code };
  return { kind: 'branch_pickup', branch: e.code, city: e.city, source };
}

/** A "Pickup:" title: exact rate title first, then the pickup label, then the city. */
function fromTitle(title, city, idx, source) {
  const key = normCity(city);
  if (COAST_CITIES.includes(key)) {
    const coastRow = [...(idx.byLabel.get(key) || []), ...(idx.byCity.get(key) || [])].find((e) => e.coast);
    return { kind: 'coast_pickup', branch: coastRow ? coastRow.code : null, city, source };
  }
  const usable = (list) => (list || []).filter((e) => !e.vendor && !e.coast);
  for (const hits of [usable(idx.byTitle.get(normCity(title))), usable(idx.byLabel.get(key)), usable(idx.byCity.get(key))]) {
    if (hits.length === 1) return branchResult(hits[0], source);
    if (hits.length > 1) return { kind: 'branch_pickup', branch: null, city, source, hold: 'ambiguous_branch' };
  }
  return { kind: 'branch_pickup', branch: null, city, source, hold: 'unknown_branch' };
}

function fromCode(code, idx, source) {
  const e = idx.byCode.get(code);
  if (!e) return { kind: 'branch_pickup', branch: null, city: null, source, hold: 'unknown_branch', code };
  return branchResult(e, source);
}

/**
 * Classify an order and find its pickup branch.
 * Returns { kind, branch, city, source, hold }. kind null means not a pickup.
 */
function resolvePickup(order, branches) {
  const idx = indexBranches(branches);
  const signals = [];
  for (const t of shippingTitles(order)) {
    const p = parsePickupTitle(t);
    if (p) signals.push(fromTitle(t, p.city, idx, 'shipping_line'));
  }
  for (const c of pickupAttributeCodes(order)) signals.push(fromCode(c, idx, 'attribute'));
  if (!signals.length) {
    // Native checkout pickup: the fulfillment order's method is PICK_UP.
    const fo = nodes(order.fulfillmentOrders).find((f) => f && f.deliveryMethod && f.deliveryMethod.methodType === 'PICK_UP');
    if (fo) {
      const loc = fo.assignedLocation || {};
      const city = (loc.location && loc.location.address && loc.location.address.city) || (loc.address && loc.address.city) || loc.city || '';
      signals.push(fromTitle('', city, idx, 'fulfillment_order'));
    }
  }
  if (!signals.length) return { kind: null, branch: null, city: null, source: null, hold: null };

  const first = signals[0];
  const conflict = signals.some((s) => s.kind !== first.kind || (s.branch || null) !== (first.branch || null));
  if (conflict) return { kind: first.kind, branch: null, city: null, source: 'multiple', hold: 'conflict', signals };
  return {
    kind: first.kind,
    branch: first.branch,
    city: first.city,
    source: first.source,
    hold: first.hold || null,
    ...(first.code ? { code: first.code } : {}),
  };
}

function stockQty(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'object' && v.qty != null) return Number(v.qty) || 0;
  return 0;
}

/**
 * Check order lines against one branch's stock. Lines: { sku, prosolSku?,
 * quantity, nonProsol? }; the Prosol code (prosolSku) is what is looked up.
 * Quantities of the same code on several lines are added up first.
 *   READY           the branch has it all
 *   NEEDS_TRANSFER  short at the branch, the other branches in the map cover the shortfall
 *   HOLD            unmapped, not a Prosol item, no stock data for the branch, or short everywhere
 */
function checkStock(lines, branchCode, stockByBranch) {
  const code = normCode(branchCode);
  const stock = stockByBranch || {};
  const here = code ? stock[code] : null;
  if (!lines || !lines.length) return { status: 'HOLD', reason: 'no_lines', lines: [] };

  const need = new Map();
  for (const l of lines) {
    const k = normCode(l.prosolSku || l.sku);
    if (k && !l.nonProsol) need.set(k, (need.get(k) || 0) + (Number(l.quantity) || 0));
  }
  const byKey = new Map();
  for (const [k, qty] of need) {
    if (!code || !here) { byKey.set(k, { status: 'HOLD', reason: code ? 'no_stock_data' : 'no_branch', have: null }); continue; }
    const have = stockQty(here[k]);
    if (have >= qty) { byKey.set(k, { status: 'READY', have }); continue; }
    const short = qty - have;
    const from = Object.keys(stock)
      .filter((b) => normCode(b) !== code)
      .map((b) => ({ code: normCode(b), qty: stockQty((stock[b] || {})[k]) }))
      .filter((b) => b.qty > 0)
      .sort((a, b) => b.qty - a.qty || a.code.localeCompare(b.code));
    const elsewhere = from.reduce((s, b) => s + b.qty, 0);
    if (elsewhere >= short) byKey.set(k, { status: 'NEEDS_TRANSFER', have, short, transferFrom: from });
    else byKey.set(k, { status: 'HOLD', reason: 'short_in_network', have, short, transferFrom: from });
  }

  const out = lines.map((l) => {
    const k = normCode(l.prosolSku || l.sku);
    const base = { sku: l.sku || null, prosolSku: k || null, quantity: Number(l.quantity) || 0 };
    if (!k) return { ...base, status: 'HOLD', reason: 'unmapped' };
    if (l.nonProsol) return { ...base, status: 'HOLD', reason: 'non_prosol' };
    return { ...base, needTotal: need.get(k), ...byKey.get(k) };
  });
  const status = out.some((l) => l.status === 'HOLD') ? 'HOLD'
    : out.some((l) => l.status === 'NEEDS_TRANSFER') ? 'NEEDS_TRANSFER'
      : 'READY';
  return { status, branch: code || null, lines: out };
}

/**
 * The whole decision for one order. next:
 *   not_pickup   ship as usual
 *   coast        Coast pickup off our shelf: no Prosol PO (project 01's path)
 *   hold         a human decides (hold reason, or stock HOLD)
 *   send_po      PO to the branch as a customer pickup (transfer=true: ask for a transfer in)
 */
function planPickup(order, { branches, lines, stock } = {}) {
  const pick = resolvePickup(order, branches);
  if (!pick.kind) return { next: 'not_pickup', pickup: pick };
  if (pick.kind === 'coast_pickup') return { next: pick.hold ? 'hold' : 'coast', reason: pick.hold || null, pickup: pick };
  if (pick.hold) return { next: 'hold', reason: pick.hold, pickup: pick };
  const s = checkStock(lines, pick.branch, stock);
  if (s.status === 'HOLD') return { next: 'hold', reason: 'stock', pickup: pick, stock: s };
  return { next: 'send_po', transfer: s.status === 'NEEDS_TRANSFER', pickup: pick, stock: s };
}

function customerName(order) {
  const c = order.customer || {};
  const b = order.billingAddress || {};
  const first = String(c.firstName || b.firstName || '').trim();
  const last = String(c.lastName || b.lastName || '').trim();
  return [first, last].filter(Boolean).join(' ');
}

function branchLabel(branch) {
  if (!branch) return '';
  if (typeof branch === 'string') return normCode(branch);
  return branch.city ? `${branch.city} (${normCode(branch.code)})` : normCode(branch.code);
}

/**
 * The customer-pickup PO email to the branch. Only the customer's first and last
 * name and our order number leave this function: the order's address, phone and
 * email are never read. branch: { code, city } or a code. stock: checkStock()
 * result, to ask for a transfer on short lines.
 */
function buildPickupEmail({ order, branch, lines, poNumber = null, stock = null }) {
  const name = customerName(order || {});
  if (!name) throw new Error('buildPickupEmail: a customer pickup needs the customer first and last name');
  const orderName = String((order && order.name) || '').trim();
  if (!orderName) throw new Error('buildPickupEmail: order number required');
  const where = branchLabel(branch);
  if (!where) throw new Error('buildPickupEmail: branch required');
  const items = (lines || []).map((l) => `  ${normCode(l.prosolSku || l.sku)} x ${Number(l.quantity) || 0}`);

  const body = [
    `CUSTOMER PICKUP (will call) at ${where}`,
    '',
    `Customer: ${name}`,
    `Our order: ${orderName}`,
    ...(poNumber ? [`Our PO: ${poNumber}`] : []),
    '',
    'Items:',
    ...items,
  ];
  const short = stock && stock.lines ? stock.lines.filter((l) => l.status === 'NEEDS_TRANSFER') : [];
  if (short.length) {
    body.push('', 'Short at this branch, please transfer in before the customer comes:');
    const seen = new Set();
    for (const l of short) {
      if (seen.has(l.prosolSku)) continue;
      seen.add(l.prosolSku);
      body.push(`  ${l.prosolSku}: need ${l.needTotal}, branch shows ${l.have}`);
    }
  }
  body.push(
    '',
    'Please hold this order for the customer named above to collect at your counter. Do not ship it.',
    `Please email us with ${poNumber ? 'our PO number' : 'our order number'} when it is ready for pickup, and again once it has been picked up.`,
  );
  return {
    subject: `CUSTOMER PICKUP (will call) at ${where}: order ${orderName}${poNumber ? `, PO ${poNumber}` : ''}`,
    body: body.join('\n'),
  };
}

function canTransition(from, to) {
  return !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function newPickupRecord({ orderId = null, orderName = null, kind = 'branch_pickup', branch = null } = {}, at = new Date()) {
  if (!KINDS.includes(kind)) throw new Error(`unknown pickup kind: ${kind}`);
  return { orderId, orderName, kind, branch: branch ? normCode(branch) : null, state: 'NEW', history: [{ to: 'NEW', at: new Date(at).toISOString() }] };
}

/** Move a pickup record to a new state. Illegal moves throw; the record is not mutated. */
function transition(record, to, { at = new Date(), note = null } = {}) {
  if (!record || !STATES.includes(record.state)) throw new Error('transition: not a pickup record');
  if (!canTransition(record.state, to)) throw new Error(`transition: ${record.state} -> ${to} is not allowed`);
  const step = { from: record.state, to, at: new Date(at).toISOString(), ...(note ? { note } : {}) };
  return { ...record, state: to, history: [...(record.history || []), step] };
}

/**
 * Shopify cancelled the order. What now?
 *   NEW               cancel, nothing went to Prosol
 *   PO_SENT / READY   cancel, and email Mac to cancel with the branch and cancel the PO
 *   PICKED_UP         no state change; the goods are gone, Mac handles the refund
 *   CANCELLED         nothing
 */
function cancelPlan(record) {
  switch (record && record.state) {
    case 'NEW': return { to: 'CANCELLED', emailMac: false, reason: 'cancelled before the PO' };
    case 'PO_SENT':
    case 'READY': return { to: 'CANCELLED', emailMac: true, reason: 'cancel with the branch and cancel the PO' };
    case 'PICKED_UP': return { to: null, emailMac: true, reason: 'cancelled after pickup' };
    default: return { to: null, emailMac: false, reason: 'already cancelled' };
  }
}

module.exports = {
  COAST_CITIES,
  KINDS,
  STATES,
  TRANSITIONS,
  normCity,
  indexBranches,
  parsePickupTitle,
  pickupAttributeCodes,
  resolvePickup,
  checkStock,
  planPickup,
  buildPickupEmail,
  canTransition,
  newPickupRecord,
  transition,
  cancelPlan,
};
