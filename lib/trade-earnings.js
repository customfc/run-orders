/**
 * ProZone client-code earnings (pure: no I/O, no Shopify calls). Build plan A
 * "Earnings", PROZONE-SCOPE Z3/Z5/Z6, prozone-mechanics G6/G7, run-orders D.1.
 *
 * A contractor's clients type the contractor's code (PRO-NAME). When the
 * client's order is delivered or picked up, the contractor earns store credit:
 * rate x base, rounded to the cent. The rate is PROPOSED (Z3, 5%) and is passed
 * in by the caller (from data/trade/trade-config.json via trade-rules.earnRate).
 *
 *   attribution  order discount codes, case-insensitive, against a provided
 *                code -> contractor customer table. Only ONE client code counts
 *                per order (the first one on the order that is in the table).
 *   self-referral a contractor's own order never earns on their own code (Z6):
 *                skipped when order.customer.id is the contractor. A guest order
 *                (customer null) is not a self-referral.
 *   base         currentSubtotal (after discounts and refunds, before tax and
 *                shipping; verified on #1396, #1314, #1282) minus lines tagged
 *                take-all-lot or prozone-exclude (G7).
 *   refunds      the target is recomputed from the current subtotal. If it drops
 *                below what was already settled, the difference is clawed back:
 *                debited up to the store credit balance (a balance can't go below
 *                zero), and the rest carried as owed on the contractor. Owed is
 *                paid off first out of the contractor's next earnings.
 *
 * Ledger entry per order (the caller stores it as an order metafield, written
 * compare-and-set, under a lock). States:
 *
 *   pending -> crediting -> credited            normal path
 *   credited -> debiting -> credited            clawback after a refund
 *   pending -> void                             cancelled or refunded before it earned
 *
 * crediting / debiting mean "about to call Shopify, or called and the result is
 * unknown". storeCreditAccountCredit/Debit have no idempotency key, so an entry
 * found in one of those states must be recovered (check the account's
 * transactions for the amount since inflight.at), never retried blind.
 *
 * nextAction(order, entry, account, opts) decides ONE step. The caller performs
 * it, writes the returned entry and account, and calls again until the action is
 * 'wait' or 'none'. Process one contractor's orders one at a time.
 */

const { toCents, gidNumber } = require('./trade-rules');

const DEFAULT_EXCLUDED_TAGS = ['take-all-lot', 'prozone-exclude'];
const DEFAULT_PREFIX = 'PRO-';
const DEFAULT_SHIPPED_HOLD_DAYS = 7;
const IN_FLIGHT = ['crediting', 'debiting'];
const FINAL = ['void'];

/** GraphQL list shapes: [], { nodes: [] } or { edges: [{ node }] }. */
function nodes(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.nodes)) return x.nodes;
  if (Array.isArray(x.edges)) return x.edges.map((e) => e.node);
  return [];
}

/**
 * Code -> contractor table. Accepts a Map, a plain object { code: customerId }
 * or an array of { code, customerId }. Codes are upper-cased; customer IDs are
 * reduced to their number. A code pointing at two customers is refused.
 */
function normalizeCodeTable(table) {
  const out = new Map();
  const add = (code, customerId) => {
    const k = String(code || '').trim().toUpperCase();
    const v = gidNumber(customerId);
    if (!k || !v) throw new Error(`code table: bad row ${code} -> ${customerId}`);
    if (out.has(k) && out.get(k) !== v) throw new Error(`code table: ${k} maps to two customers`);
    out.set(k, v);
  };
  if (table instanceof Map) for (const [k, v] of table) add(k, v);
  else if (Array.isArray(table)) for (const r of table) add(r.code, r.customerId);
  else if (table && typeof table === 'object') for (const [k, v] of Object.entries(table)) add(k, v);
  return out;
}

function orderCodes(order) {
  const direct = (order.discountCodes || []).map(String);
  if (direct.length) return direct;
  return nodes(order.discountApplications).map((a) => a && a.code).filter(Boolean).map(String);
}

/**
 * Which contractor, if any, this order earns for.
 * Returns { code, contractorId, flags } or { code: null, reason, flags }.
 */
function attribute(order, codeTable, { prefix = DEFAULT_PREFIX } = {}) {
  const table = codeTable instanceof Map ? codeTable : normalizeCodeTable(codeTable);
  const flags = [];
  const matched = [];
  for (const raw of orderCodes(order)) {
    const code = raw.trim().toUpperCase();
    if (table.has(code)) { if (!matched.includes(code)) matched.push(code); }
    else if (prefix && code.startsWith(prefix.toUpperCase())) flags.push('unknown_client_code');
  }
  if (matched.length > 1) flags.push('multiple_client_codes');
  if (!matched.length) return { code: null, reason: 'no_client_code', flags };
  return { code: matched[0], contractorId: table.get(matched[0]), flags };
}

function lineTags(line) {
  const raw = line.tags != null ? line.tags : line.product && line.product.tags;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return list.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

function lineCurrentCents(line) {
  const unit = line.discountedUnitPriceAfterAllDiscountsSet != null ? line.discountedUnitPriceAfterAllDiscountsSet
    : line.discountedUnitPriceAfterAllDiscounts != null ? line.discountedUnitPriceAfterAllDiscounts
      : line.discountedUnitPrice != null ? line.discountedUnitPrice
        : line.price;
  const qty = Number(line.currentQuantity != null ? line.currentQuantity : line.quantity) || 0;
  return toCents(unit) * qty;
}

function isExcludedLine(line, excludedTags) {
  const type = String(line.productType || (line.product && line.product.productType) || '').trim().toLowerCase();
  if (type === 'take-all lot') return true;
  const tags = lineTags(line);
  return excludedTags.some((t) => tags.includes(t));
}

/** Earnings base in cents: current subtotal minus excluded lines, never below 0. */
function earningBase(order, { excludedTags = DEFAULT_EXCLUDED_TAGS } = {}) {
  const tags = excludedTags.map((t) => String(t).toLowerCase());
  const sub = order.currentSubtotalPriceSet != null ? order.currentSubtotalPriceSet
    : order.currentSubtotalPrice != null ? order.currentSubtotalPrice
      : order.currentSubtotal;
  const subtotalCents = toCents(sub);
  let excludedCents = 0;
  const excludedLines = [];
  for (const l of nodes(order.lineItems)) {
    if (!isExcludedLine(l, tags)) continue;
    excludedCents += lineCurrentCents(l);
    excludedLines.push(l.id || l.sku || l.variantId || null);
  }
  return { baseCents: Math.max(0, subtotalCents - excludedCents), subtotalCents, excludedCents, excludedLines };
}

/** rate x base in cents, half-up, integer math (rate 0.05 = 500 basis points). */
function earnCents(baseCents, rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0 || r > 1) throw new Error(`earn rate must be a fraction 0-1, got ${rate}`);
  const bp = Math.round(r * 10000);
  return Math.floor((Math.max(0, baseCents) * bp + 5000) / 10000);
}

/**
 * Full earnings view of one order. targetCents is what the order should have
 * earned as of now (0 once cancelled, lower after a refund).
 */
function computeEarning(order, { codeTable, rate, excludedTags = DEFAULT_EXCLUDED_TAGS, prefix = DEFAULT_PREFIX } = {}) {
  if (rate == null) throw new Error('computeEarning: rate is required (trade-rules.earnRate())');
  const attr = attribute(order, codeTable, { prefix });
  const base = earningBase(order, { excludedTags });
  const cancelled = !!order.cancelledAt;
  const targetCents = cancelled || order.test ? 0 : earnCents(base.baseCents, rate);
  const out = { ...attr, ...base, targetCents, cancelled };
  if (order.test) return { ...out, attributable: false, reason: 'test_order' };
  if (!attr.code) return { ...out, attributable: false };
  const buyer = order.customer ? gidNumber(order.customer.id) : '';
  if (buyer && buyer === attr.contractorId) return { ...out, attributable: false, reason: 'self_referral' };
  return { ...out, attributable: true, reason: null };
}

function isPickupOrder(order) {
  if (nodes(order.fulfillmentOrders).some((fo) => fo && fo.deliveryMethod && fo.deliveryMethod.methodType === 'PICK_UP')) return true;
  const lines = [order.shippingLine, ...nodes(order.shippingLines)].filter(Boolean);
  return lines.some((s) => /^\s*pickup\s*:/i.test(s.title || ''));
}

function fulfillmentOk(f) {
  if (!f) return false;
  const s = String(f.status || '').toUpperCase();
  const d = String(f.displayStatus || '').toUpperCase();
  if (s === 'CANCELLED' || s === 'FAILURE' || s === 'ERROR' || d === 'CANCELED' || d === 'CANCELLED') return false;
  return s === 'SUCCESS' || ['FULFILLED', 'DELIVERED', 'PICKED_UP'].includes(d);
}

/**
 * When the order earned (Z5, G6), as an ISO string, or null if not yet.
 * Pickup: when it was picked up (the pickup fulfillment). Shipped: deliveredAt,
 * or the fulfillment date plus shippedHoldDays when the carrier gives no
 * delivery date (Shopify shows none on these Purolator orders). Every
 * fulfillment must have earned; a cancelled order never earns.
 */
function earnedAt(order, { now = new Date(), shippedHoldDays = DEFAULT_SHIPPED_HOLD_DAYS } = {}) {
  if (order.cancelledAt) return null;
  if (order.displayFulfillmentStatus && String(order.displayFulfillmentStatus).toUpperCase() !== 'FULFILLED') return null;
  const done = nodes(order.fulfillments).filter(fulfillmentOk);
  if (!done.length) return null;
  const pickup = isPickupOrder(order);
  const nowMs = new Date(now).getTime();
  let latest = 0;
  for (const f of done) {
    let at;
    if (pickup) at = Date.parse(f.createdAt);
    else if (f.deliveredAt) at = Date.parse(f.deliveredAt);
    else {
      const due = Date.parse(f.createdAt) + shippedHoldDays * 86400000;
      if (!(due <= nowMs)) return null;
      at = due;
    }
    if (!Number.isFinite(at)) return null;
    if (at > latest) latest = at;
  }
  return new Date(latest).toISOString();
}

function iso(now) { return new Date(now || Date.now()).toISOString(); }

function newEntry(order, calc, now) {
  return {
    orderId: order.id || null,
    orderName: order.name || null,
    code: calc.code,
    contractorId: calc.contractorId,
    status: 'pending',
    targetCents: calc.targetCents,
    settledCents: 0,
    inflight: null,
    txIds: [],
    flags: calc.flags || [],
    updatedAt: iso(now),
  };
}

function acct(account) {
  return {
    balanceCents: Math.max(0, Math.round(Number(account && account.balanceCents) || 0)),
    owedCents: Math.max(0, Math.round(Number(account && account.owedCents) || 0)),
  };
}

/**
 * Decide the next step for one order. account = { balanceCents, owedCents } for
 * the entry's contractor (balance from storeCreditAccounts, owed from our own
 * record). Returns { action, ... }:
 *
 *   none        nothing to do (reason says why)
 *   record      create this pending entry
 *   update      pending entry's target changed before it earned; write it
 *   wait        not delivered / picked up yet
 *   void        cancelled or refunded to 0 before anything settled
 *   credit      write entry (crediting), then storeCreditAccountCredit(amountCents)
 *   debit       write entry (debiting), then storeCreditAccountDebit(amountCents)
 *   apply_owed  the whole earning pays off owed; write entry and account, no Shopify call
 *   carry_owed  clawback with a zero balance; write entry and account, no Shopify call
 *   recover     entry is mid-flight; check the account's transactions, then settleInflight()
 */
function nextAction(order, entry, account, opts = {}) {
  const now = opts.now || new Date();
  if (entry && IN_FLIGHT.includes(entry.status)) {
    return { action: 'recover', reason: `entry left in ${entry.status}`, entry };
  }
  if (entry && FINAL.includes(entry.status)) return { action: 'none', reason: entry.status };

  const calc = computeEarning(order, opts);
  if (!entry) {
    if (!calc.attributable) return { action: 'none', reason: calc.reason, flags: calc.flags };
    if (calc.cancelled) return { action: 'none', reason: 'cancelled', flags: calc.flags };
    return { action: 'record', entry: newEntry(order, calc, now) };
  }

  const a = acct(account);
  const target = calc.targetCents;
  const settled = Math.round(Number(entry.settledCents) || 0);

  if (entry.status === 'pending' && settled === 0) {
    const earned = earnedAt(order, { now, shippedHoldDays: opts.shippedHoldDays });
    if (target === 0 && (calc.cancelled || earned || order.test)) {
      return { action: 'void', entry: { ...entry, status: 'void', targetCents: 0, updatedAt: iso(now) } };
    }
    if (!earned) {
      if (target !== entry.targetCents) return { action: 'update', entry: { ...entry, targetCents: target, updatedAt: iso(now) } };
      return { action: 'wait', reason: 'not_delivered' };
    }
  }

  const delta = target - settled;
  const base = { ...entry, targetCents: target, updatedAt: iso(now) };
  if (delta === 0) {
    if (entry.status === 'pending') return { action: 'void', entry: { ...base, status: 'void' } };
    return { action: 'none', reason: 'settled' };
  }

  if (delta > 0) {
    const useOwed = Math.min(a.owedCents, delta);
    const credit = delta - useOwed;
    if (credit === 0) {
      return {
        action: 'apply_owed',
        entry: { ...base, status: 'credited', settledCents: settled + delta },
        account: { ...a, owedCents: a.owedCents - useOwed },
      };
    }
    return {
      action: 'credit',
      amountCents: credit,
      entry: {
        ...base,
        status: 'crediting',
        inflight: { kind: 'credit', from: entry.status, amountCents: credit, settleDeltaCents: delta, owedDeltaCents: -useOwed, at: iso(now) },
      },
    };
  }

  const claw = -delta;
  const debit = Math.min(claw, a.balanceCents);
  const owedAdd = claw - debit;
  if (debit === 0) {
    return {
      action: 'carry_owed',
      entry: { ...base, status: 'credited', settledCents: settled + delta },
      account: { ...a, owedCents: a.owedCents + owedAdd },
    };
  }
  return {
    action: 'debit',
    amountCents: debit,
    entry: {
      ...base,
      status: 'debiting',
      inflight: { kind: 'debit', from: entry.status, amountCents: debit, settleDeltaCents: delta, owedDeltaCents: owedAdd, at: iso(now) },
    },
  };
}

/**
 * Close a crediting / debiting entry once the caller knows whether the Shopify
 * transaction landed. landed=false puts the entry back where it was, so the next
 * nextAction() decides again from fresh data (for example after
 * INSUFFICIENT_FUNDS because the contractor spent the balance meanwhile).
 */
function settleInflight(entry, account, { landed, txId = null, now = new Date() } = {}) {
  if (!entry || !entry.inflight || !IN_FLIGHT.includes(entry.status)) throw new Error('settleInflight: entry is not in flight');
  const f = entry.inflight;
  const a = acct(account);
  if (!landed) {
    return { entry: { ...entry, status: f.from || 'pending', inflight: null, updatedAt: iso(now) }, account: a };
  }
  const sign = f.kind === 'credit' ? 1 : -1;
  return {
    entry: {
      ...entry,
      status: 'credited',
      settledCents: (Math.round(Number(entry.settledCents) || 0)) + f.settleDeltaCents,
      inflight: null,
      txIds: [...(entry.txIds || []), ...(txId ? [txId] : [])],
      updatedAt: iso(now),
    },
    account: {
      balanceCents: Math.max(0, a.balanceCents + sign * f.amountCents),
      owedCents: Math.max(0, a.owedCents + f.owedDeltaCents),
    },
  };
}

module.exports = {
  DEFAULT_EXCLUDED_TAGS,
  DEFAULT_PREFIX,
  DEFAULT_SHIPPED_HOLD_DAYS,
  normalizeCodeTable,
  attribute,
  earningBase,
  earnCents,
  computeEarning,
  isPickupOrder,
  earnedAt,
  nextAction,
  settleInflight,
};
