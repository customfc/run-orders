/**
 * Amazon.ca MFN returns autopilot. Policy and runbook: docs/RETURNS.md.
 *
 * Every open return request gets one outcome without anyone opening Seller
 * Central:
 *   returnless  cheap or consumable (an Aqua Mix pint, a tube of silicone, a
 *               flange kit): refund now and tell the buyer to keep it.
 *   label       worth getting back: buy a prepaid Purolator return label to the
 *               branch that shipped it, email it to the buyer, tell Prosol it is
 *               coming, refund on the carrier's first scan (on delivery above
 *               deliveredRefundAbove).
 *   held        A-to-Z claim, unauthorised purchase, over a money cap, no branch
 *               to send it to: Mac gets one email with a one-tap approve link.
 *
 * Why: the last three seller ratings (2026-09-28 to 10-05) were all 1 star and
 * all about returns. Amazon.ca hands MFN buyers an UNPAID label, so they paid
 * $21-$25 to mail back a $50-$100 bottle of sealer and then waited on us.
 *
 * Refunds go through scripts/ops/issue-refund.js run(): item-level, amount
 * pinned to the preview, refuses an order that already has a refund, A-to-z or
 * chargeback, locks per order. This module never builds its own feed.
 *
 * All network/IO is injected (lib/amazon-returns-io.js in production) so the
 * policy is testable offline. SHADOW unless opts.live: SHADOW reads, previews
 * and rates, and changes nothing (no state, no email, no spend).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = path.join(__dirname, '..', 'data', 'returns-autopilot.json');

function policy(env = process.env) {
  const n = (k, d) => (env[k] != null && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    returnlessMax: n('RETURNS_RETURNLESS_MAX', 60),        // any item: refund without return at or under this (CAD, refund total)
    consumableMax: n('RETURNS_CONSUMABLE_MAX', 150),       // sealers, cleaners, grout, silicone: same, at or under this
    autoRefundMax: n('RETURNS_AUTO_REFUND_MAX', 600),      // one refund above this waits for Mac's tap
    dailyRefundCap: n('RETURNS_DAILY_REFUND_CAP', 1000),   // total automatic refunds per calendar day (BC)
    labelMax: n('RETURNS_LABEL_MAX', 30),                  // feedback_label_cost_confirm: labels over $30 need Mac
    labelShareMax: n('RETURNS_LABEL_SHARE_MAX', 0.35),     // label >= 35% of the refund: cheaper to let them keep it
    deliveredRefundAbove: n('RETURNS_DELIVERED_REFUND_ABOVE', 300), // above this, refund when the branch has it, not on first scan
    windowDays: n('RETURNS_WINDOW_DAYS', 45),
    maxRefundsPerRun: n('RETURNS_MAX_REFUNDS_PER_RUN', 6),
    staleLabelDays: n('RETURNS_STALE_LABEL_DAYS', 14),    // older requests may already be in the mail: Mac taps before a label goes
    unusedLabelDays: n('RETURNS_UNUSED_LABEL_DAYS', 21),   // label never scanned: tell Mac once
  };
}

// Products a branch can't put back on the shelf once they've been in a
// customer's garage, and that cost more to ship back than they're worth.
const CONSUMABLE = /aqua ?mix|sealer|\bseal\b|enrich|cleaner|clean-?up|haze|enhancer|grout|polyblend|prism|caulk|silicone|mapesil|sealant|coating|thinset|mortar|adhesive|primer|stone ?tech|miracle/i;
const CLOSED = /^(closed|rejected|cancel)/i;

const money = (c) => `$${((Number(c) || 0) / 100).toFixed(2)}`;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()] != null) return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])));
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}
const g = (r, ...ks) => { for (const k of ks) { const v = r[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; };

/** One Amazon returns-report row → the fields this module uses. */
function normaliseRow(r) {
  return {
    order: g(r, 'Order ID', 'order-id'),
    itemId: g(r, 'Order Item ID', 'order-item-id'),
    sku: g(r, 'Merchant SKU', 'sku'),
    asin: g(r, 'ASIN', 'asin'),
    itemName: g(r, 'Item Name', 'item-name'),
    qty: Math.max(1, Number(g(r, 'Return quantity', 'quantity')) || 1),
    reason: g(r, 'Return Reason', 'Return reason', 'reason').toUpperCase(),
    status: g(r, 'Return request status', 'status'),
    atoz: g(r, 'A-to-Z Claim').toUpperCase() === 'Y',
    payer: g(r, 'Label to be paid by'),
    rmaId: g(r, 'Amazon RMA ID'),
    buyerTracking: g(r, 'Tracking ID'),
    returnDelivered: g(r, 'Return delivery date'),
    requestDate: parseDate(g(r, 'Return request date', 'return-date')),
    returnType: g(r, 'Return type'),
  };
}

/**
 * Group open return rows by order. Two lines of one order refund in ONE feed:
 * issue-refund refuses a second refund on an order that already has one.
 */
function openReturnsByOrder(rows, now, windowDays) {
  const cutoff = now.getTime() - windowDays * 864e5;
  const byOrder = new Map();
  for (const raw of rows) {
    const r = normaliseRow(raw);
    if (!/^\d{3}-\d{7}-\d{7}$/.test(r.order) || !/^\d+$/.test(r.itemId)) continue;
    if (CLOSED.test(r.status)) continue;
    if (r.requestDate && r.requestDate.getTime() < cutoff) continue;
    if (!byOrder.has(r.order)) byOrder.set(r.order, new Map());
    // The report repeats a line when the request is updated; the last copy wins.
    byOrder.get(r.order).set(r.itemId, r);
  }
  return [...byOrder.entries()].map(([order, items]) => ({ order, items: [...items.values()] }));
}

/** Pre-money gates: things no amount rule should ever auto-settle. */
function gate(ret) {
  if (ret.items.some((i) => i.atoz)) return { hold: 'A-to-Z claim filed on this order' };
  if (ret.items.some((i) => i.reason === 'CR-UNAUTHORIZED_PURCHASE')) return { hold: 'buyer says the purchase was unauthorised (fraud/chargeback shape)' };
  return null;
}

/**
 * Pure decision once the exact refund total is known.
 * Returns { action: 'returnless'|'label'|'held', why, buyerShipped? }.
 */
function decide(ret, totalCents, P, now = new Date()) {
  const total = totalCents / 100;
  const consumable = ret.items.every((i) => CONSUMABLE.test(i.itemName));
  const buyerShipped = ret.items.some((i) => i.buyerTracking || i.returnDelivered);
  if (buyerShipped) {
    // They already mailed it on Amazon's unpaid label. A label from us is moot;
    // the refund is what they're waiting on.
    if (total > P.autoRefundMax) return { action: 'held', why: `buyer already shipped it back; ${money(totalCents)} is over the ${money(P.autoRefundMax * 100)} auto-refund cap`, wanted: 'returnless' };
    return { action: 'returnless', why: 'buyer already shipped it back on their own label: refund now', buyerShipped: true };
  }
  if (total <= P.returnlessMax) return { action: 'returnless', why: `${money(totalCents)} is at or under the ${money(P.returnlessMax * 100)} no-return line` };
  if (consumable && total <= P.consumableMax) return { action: 'returnless', why: `consumable (sealer/cleaner/grout/silicone) at ${money(totalCents)}: not worth return freight` };
  // A request that has sat for weeks may already be in the mail on Amazon's
  // label; a fresh label then just delays their refund. Mac taps first.
  const oldest = Math.min(...ret.items.map((i) => (i.requestDate ? new Date(i.requestDate).getTime() : now.getTime())));
  const age = Math.floor((now.getTime() - oldest) / 864e5);
  if (age > P.staleLabelDays) return { action: 'held', wanted: 'label', why: `return requested ${age} days ago with no tracking: they may have mailed it already. Approve to send a prepaid label anyway, or refund in Seller Central` };
  return { action: 'label', why: `${money(totalCents)} is worth getting back` };
}

/** Label economics: run after a real Purolator quote. */
function decideLabel(totalCents, labelCents, P) {
  const pct = Math.round((100 * labelCents) / totalCents);
  if (labelCents >= P.labelShareMax * totalCents) {
    if (totalCents / 100 > P.autoRefundMax) return { action: 'held', why: `label ${money(labelCents)} is ${pct}% of the refund and the refund is over the auto cap`, wanted: 'returnless' };
    return { action: 'returnless', why: `label ${money(labelCents)} is ${pct}% of the ${money(totalCents)} refund: cheaper to let them keep it` };
  }
  if (labelCents > P.labelMax * 100) return { action: 'held', why: `return label quotes ${money(labelCents)}, over the ${money(P.labelMax * 100)} label cap`, wanted: 'label' };
  return { action: 'label', why: `label ${money(labelCents)} (${pct}% of the refund)` };
}

// ── State ────────────────────────────────────────────────────────────────────

function loadState(file = DEFAULT_STATE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { orders: {}, daily: {} }; }
}
function saveState(state, file = DEFAULT_STATE) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

function approveToken(order, secret = process.env.RETURNS_APPROVE_SECRET || process.env.SKU_RESOLVER_SECRET) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`returns|${order}`).digest('hex').slice(0, 32);
}
function verifyApprove(order, token, secret) {
  const t = approveToken(order, secret);
  return !!t && typeof token === 'string' && token.length === t.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
}

// Errors issue-refund raises that settle the question rather than fail it.
function classifyRefundError(msg) {
  if (/RefundEventList already exists|Refund already submitted/i.test(msg)) return { stage: 'already_refunded', why: 'Amazon already shows a refund on this order' };
  if (/GuaranteeClaimEventList/i.test(msg)) return { stage: 'held', why: 'A-to-Z claim money is already on this order' };
  if (/ChargebackEventList/i.test(msg)) return { stage: 'held', why: 'chargeback on this order' };
  if (/local refund attempt exists/i.test(msg)) return { stage: 'held', why: 'a refund attempt for this order is on file and unreconciled (data/refund-attempts)' };
  return null;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * io (lib/amazon-returns-io.js):
 *   fetchReturns() → raw report rows
 *   previewRefund({ order, items:[{id,quantity}] }) → { totalCents, full }
 *   commitRefund({ order, items, full, expectedCents, evidence }) → { feedId }
 *   quoteLabel(ret) → { cents, rateId, branch, warehouseId, ... } | { error }
 *   buyLabel(ret, quote) → { tracking, labelId, cents, pdf }
 *   trackLabel(labelId) → { scanned, delivered, status }
 *   emailBuyer(kind, ret, ctx) → { to }
 *   notifyBranch(ret, entry) → { to }             (optional)
 *   logSalesforce(ret, entry) → { created:[...] } | { planned }
 *   notifyMac({ held, errors, actions })           (LIVE only)
 */
async function run({ io, live = false, now = new Date(), P = policy(), stateFile = DEFAULT_STATE } = {}) {
  const state = loadState(stateFile);
  state.orders ||= {};
  state.daily ||= {};
  const today = dayKey(now);
  const out = { live, actions: [], held: [], errors: [], settled: [], skipped: 0 };
  let refundsThisRun = 0;

  const open = openReturnsByOrder(await io.fetchReturns(), now, P.windowDays);
  // A label already out (or a refund waiting on its Salesforce record, or an
  // approval) keeps going after Amazon closes the request or it ages out.
  const seen = new Set(open.map((r) => r.order));
  for (const [order, e] of Object.entries(state.orders)) {
    if (seen.has(order) || !['label_sent', 'refunded', 'approved'].includes(e.stage)) continue;
    open.push({ order, carried: true, items: (e.items || []).map((i) => ({ order, itemId: i.itemId, sku: i.sku, asin: i.asin, itemName: i.name || '', qty: i.qty, reason: i.reason, rmaId: i.rmaId, atoz: false })) });
  }
  const event = (e, msg) => { e.history = [...(e.history || []), { at: now.toISOString(), msg }].slice(-20); };
  const itemLines = (ret) => ret.items.map((i) => `${i.qty}x ${String(i.itemName || '').slice(0, 70)}`);

  function hold(ret, e, why, { sticky = false, manual = false } = {}) {
    if (e.why !== why || e.stage !== 'held') { e.notifiedAt = null; event(e, `held: ${why}`); }
    e.stage = 'held';
    e.why = why;
    e.sticky = sticky;
    e.manual = manual;
    out.held.push({ order: ret.order, why, cents: e.totalCents ?? null, decision: e.decision || null, manual, items: itemLines(ret), notified: !!e.notifiedAt });
  }

  async function refund(ret, e, why) {
    if (refundsThisRun >= P.maxRefundsPerRun) { out.skipped++; return false; }
    const spent = state.daily[today] || 0;
    if (!e.approvedAt && spent + e.totalCents > P.dailyRefundCap * 100) {
      hold(ret, e, `today's automatic refunds would pass the ${money(P.dailyRefundCap * 100)} daily cap (${money(spent)} so far)`);
      return false;
    }
    const evidence = `returns-autopilot (docs/RETURNS.md, Mac 2026-10-07 policy${e.approvedAt ? `, approved by Mac ${e.approvedAt}` : ''}): ${why}; Amazon RMA ${ret.items.map((i) => i.rmaId || '?').join('/')}; reasons ${ret.items.map((i) => i.reason).join('/')}`;
    if (!live) { out.actions.push({ order: ret.order, do: 'refund', cents: e.totalCents, why, items: itemLines(ret), shadow: true }); return false; }
    refundsThisRun++;
    try {
      const r = await io.commitRefund({ order: ret.order, items: e.refundItems, full: e.full, expectedCents: e.totalCents, evidence });
      e.refund = { at: now.toISOString(), cents: e.totalCents, feedId: r.feedId };
      state.daily[today] = spent + e.totalCents;
      event(e, `refunded ${money(e.totalCents)} (feed ${r.feedId})`);
      out.actions.push({ order: ret.order, do: 'refund', cents: e.totalCents, why, items: itemLines(ret), feedId: r.feedId });
      return true;
    } catch (err) {
      // issue-refund keeps its own lock on any unknown outcome; never retry blind.
      hold(ret, e, `refund did not confirm, check Seller Central before anything else: ${err.message.slice(0, 200)}`, { sticky: true, manual: true });
      out.errors.push({ order: ret.order, error: err.message });
      return false;
    }
  }

  async function finishSalesforce(ret, e) {
    if (!live || e.sf?.done) return;
    try {
      const r = await io.logSalesforce(ret, e);
      if (r?.created) { e.sf = { done: true, at: now.toISOString(), ...r }; event(e, `Salesforce ${r.created.join(', ')}`); }
      else if (r?.none) { e.sf = { done: true, none: r.none }; event(e, r.none); out.held.push({ order: ret.order, why: r.none, cents: e.totalCents, items: itemLines(ret), info: true }); }
      else e.sf = { done: false, planned: r?.planned || null };
    } catch (err) {
      const fails = (e.sf?.fails || 0) + 1;
      // Three strikes: stop retrying every 2 h and leave it to Lynnae, once.
      e.sf = { done: fails >= 3, fails, error: err.message.slice(0, 200) };
      if (fails >= 3) { event(e, `Salesforce gave up: ${e.sf.error}`); out.held.push({ order: ret.order, why: `Salesforce RMA not created after 3 tries: ${e.sf.error}`, cents: e.totalCents, items: itemLines(ret), info: true }); }
      else out.errors.push({ order: ret.order, error: `Salesforce: ${err.message}` });
    }
    if (e.sf?.done) e.stage = 'done';
  }

  async function afterRefund(ret, e, d) {
    e.stage = 'refunded';
    if (d.tellBuyer) {
      // neverShipped (set by hand on approval): the order never left the branch, so "keep it" would be wrong.
      const kind = e.neverShipped ? 'never_shipped' : 'returnless';
      try { const m = await io.emailBuyer(kind, ret, { cents: e.totalCents }); event(e, `buyer told: ${kind} (${m.to})`); }
      catch (err) { out.errors.push({ order: ret.order, error: `buyer email: ${err.message}` }); }
    }
    await finishSalesforce(ret, e);
  }

  for (const ret of open) {
    const e = state.orders[ret.order] ||= { stage: 'new', firstSeen: now.toISOString() };
    if (!ret.carried) e.items = ret.items.map((i) => ({ itemId: i.itemId, sku: i.sku, asin: i.asin, qty: i.qty, reason: i.reason, rmaId: i.rmaId, name: i.itemName }));
    try {
      if (['already_refunded', 'done'].includes(e.stage)) continue;
      if (e.stage === 'refunded') { await finishSalesforce(ret, e); continue; }

      // A label is out: wait for the carrier, then refund.
      if (e.stage === 'label_sent') {
        const t = await io.trackLabel(e.label.labelId);
        e.label.status = t.status;
        const ready = e.totalCents / 100 > P.deliveredRefundAbove ? t.delivered : (t.scanned || t.delivered);
        if (ready) {
          if (await refund(ret, e, `return parcel ${e.label.tracking} ${t.delivered ? 'delivered to' : 'scanned on its way to'} ${e.label.branch}`)) await afterRefund(ret, e, {});
        } else if (!e.label.unusedFlagged && (now - new Date(e.label.at)) / 864e5 >= P.unusedLabelDays) {
          e.label.unusedFlagged = now.toISOString();
          out.held.push({ order: ret.order, why: `return label ${e.label.tracking} went out ${e.label.at.slice(0, 10)} and has never been scanned`, cents: e.totalCents, items: itemLines(ret), info: true });
        }
        continue;
      }

      const blocked = gate(ret);
      if (blocked) { hold(ret, e, blocked.hold, { manual: true }); continue; }
      if (e.stage === 'held' && e.sticky && !e.approvedAt) { hold(ret, e, e.why, { sticky: true, manual: e.manual }); continue; }

      // Exact refund amount from Amazon's own order data (issue-refund preview).
      if (e.totalCents == null || e.stage === 'new') {
        const items = ret.items.map((i) => ({ id: i.itemId, quantity: i.qty }));
        let plan;
        try {
          plan = await io.previewRefund({ order: ret.order, items });
        } catch (err) {
          const settled = classifyRefundError(err.message);
          if (settled?.stage === 'already_refunded') { e.stage = 'already_refunded'; e.why = settled.why; event(e, settled.why); out.settled.push({ order: ret.order, why: settled.why }); continue; }
          hold(ret, e, settled ? settled.why : `the refund tool will not take this order automatically: ${err.message.slice(0, 160)}`, { sticky: true, manual: true });
          continue;
        }
        e.totalCents = plan.totalCents;
        e.full = plan.full;
        e.ordered = plan.ordered || null; // Salesforce scales area-item quantities by this
        e.refundItems = plan.full ? null : items;
      }

      let d;
      if (e.approvedAt) {
        d = { action: e.decision === 'label' ? 'label' : 'returnless', why: `approved by Mac ${e.approvedAt}` };
        // "Keep it" only where the policy itself would have refunded without a return.
        // An approved early refund on anything dearer (Cheryl's $171.61 niche, 2026-10-07)
        // still expects the item back, so the buyer gets Amazon's refund notice and nothing
        // from us, unless it never shipped.
        d.tellBuyer = d.action === 'returnless' && (!!e.neverShipped || decide(ret, e.totalCents, P, now).action === 'returnless');
        if (d.action === 'label' && !e.quote) {
          const q = await io.quoteLabel(ret);
          if (q.error) { hold(ret, e, `no return label: ${q.error}`, { sticky: true, manual: true }); continue; }
          e.quote = q;
        }
      } else {
        d = decide(ret, e.totalCents, P, now);
        d.tellBuyer = d.action === 'returnless' && !d.buyerShipped;
        if (d.action === 'label' || (d.action === 'held' && d.wanted === 'label')) {
          const stale = d.action === 'held' ? d : null;
          const q = await io.quoteLabel(ret);
          if (q.error) d = { action: 'held', why: `no return label: ${q.error}`, wanted: 'returnless' };
          else {
            e.quote = q;
            d = decideLabel(e.totalCents, q.cents, P);
            d.tellBuyer = d.action === 'returnless';
            // Label economics can still say "let them keep it"; otherwise an old request waits for Mac.
            if (stale && d.action === 'label') d = { ...stale, why: `${stale.why} (label ${money(q.cents)} to ${q.branch})` };
          }
        }
        if (d.action !== 'held' && e.totalCents / 100 > P.autoRefundMax) {
          d = { action: 'held', wanted: d.action, why: `${money(e.totalCents)} refund is over the ${money(P.autoRefundMax * 100)} auto cap (${d.action === 'label' ? `would send a ${money(e.quote.cents)} Purolator label to ${e.quote.branch}` : 'would refund without a return'})` };
        }
      }
      e.decision = d.wanted || d.action;
      if (d.action === 'held') { hold(ret, e, d.why); continue; }

      if (d.action === 'returnless') {
        if (await refund(ret, e, d.why)) await afterRefund(ret, e, d);
        continue;
      }

      // label
      if (!live) { out.actions.push({ order: ret.order, do: 'label', cents: e.quote.cents, branch: e.quote.branch, refundCents: e.totalCents, why: d.why, items: itemLines(ret), shadow: true }); continue; }
      const lab = await io.buyLabel(ret, e.quote);
      e.label = { at: now.toISOString(), tracking: lab.tracking, labelId: lab.labelId, cents: lab.cents, branch: e.quote.branch, warehouseId: e.quote.warehouseId };
      e.stage = 'label_sent';
      event(e, `label ${lab.tracking} ${money(lab.cents)} to ${e.quote.branch}`);
      out.actions.push({ order: ret.order, do: 'label', cents: lab.cents, tracking: lab.tracking, branch: e.quote.branch, refundCents: e.totalCents, why: d.why, items: itemLines(ret) });
      try {
        const m = await io.emailBuyer('label', ret, { cents: e.totalCents, pdf: lab.pdf, tracking: lab.tracking, refundOn: e.totalCents / 100 > P.deliveredRefundAbove ? 'delivered' : 'scan' });
        event(e, `label emailed to ${m.to}`);
      } catch (err) { e.label.emailError = err.message; out.errors.push({ order: ret.order, error: `label email: ${err.message}` }); }
      if (io.notifyBranch) {
        try { const m = await io.notifyBranch(ret, e); if (m?.to) event(e, `branch told (${m.to})`); }
        catch (err) { out.errors.push({ order: ret.order, error: `branch heads-up: ${err.message}` }); }
      }
    } catch (err) {
      out.errors.push({ order: ret.order, error: err.message });
    } finally {
      if (live) saveState(state, stateFile);
    }
  }

  // One email to Mac per run, only when something happened or needs him.
  // Already-notified holds stay quiet (feedback_no_noise_emails). SHADOW never emails.
  const fresh = out.held.filter((h) => !h.notified);
  if (live && (fresh.length || out.errors.length || out.actions.length) && io.notifyMac) {
    try {
      await io.notifyMac({ held: fresh, errors: out.errors, actions: out.actions });
      for (const h of fresh) if (state.orders[h.order]) state.orders[h.order].notifiedAt = now.toISOString();
    } catch (err) { out.errors.push({ order: '-', error: `notify Mac: ${err.message}` }); }
  }
  if (live) saveState(state, stateFile);
  return out;
}

/** Mac tapped approve: the next run settles it with the decision on file (returnless if none). */
function approve(order, { stateFile = DEFAULT_STATE, now = new Date() } = {}) {
  const state = loadState(stateFile);
  const e = state.orders?.[order];
  if (!e) throw new Error(`no return on file for ${order}`);
  if (['refunded', 'done', 'already_refunded', 'label_sent', 'approved'].includes(e.stage)) return e;
  e.approvedAt = now.toISOString();
  e.stage = 'approved';
  e.sticky = false;
  e.history = [...(e.history || []), { at: e.approvedAt, msg: `approved by Mac (${e.decision === 'label' ? 'send label' : 'refund without return'})` }];
  saveState(state, stateFile);
  return e;
}

module.exports = { policy, normaliseRow, openReturnsByOrder, gate, decide, decideLabel, run, approve, approveToken, verifyApprove, loadState, classifyRefundError, CONSUMABLE, money, DEFAULT_STATE };
