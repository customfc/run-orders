/**
 * ProZone client-code earnings: the runner around lib/trade-earnings.js (02 PROZONE-BUILD-PLAN.md section 4 item 1;
 * Mac 2026-10-08: "agreed on all counts", Z16: Mac OKs each week's credits before they go out).
 *
 * The national page promises: a client who uses a member's PRO- code saves 5%, and the member gets 5% of the order
 * (before tax and shipping) as yourfloors.ca store credit once it is delivered or picked up; a refund takes it back.
 *
 *   propose  weekly (Mini crontab, scripts/trade/earnings.js --propose). Finds the orders that carry a member's code
 *            and every order already in the ledger, keeps the per-order ledger up to date (record, update, void,
 *            owed bookkeeping: no money), and collects the money moves (credit, debit, recover) into one batch.
 *            Emails Mac the batch with a signed Review link when it isn't empty. Moves no money.
 *   apply    Mac's tap (POST /prozone/earnings, or the CLI --apply). For each batch item, re-reads the order and the
 *            account and re-runs nextAction: only an identical move (same kind, same amount) goes ahead; anything
 *            else waits for next week. The entry is written in flight BEFORE the Shopify call, then settled. A call
 *            whose result is unknown stays in flight and is recovered from the account's transactions, never retried.
 *
 * State: data/trade-earnings-state.json (gitignored): { orders: { <order gid>: entry }, accounts: { <customer number>:
 * { owedCents } }, batch }. Log: logs/trade-earnings.jsonl. One run at a time (logs/trade-earnings.lock).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./trade-earnings');
const { toCents, gidNumber } = require('./trade-rules');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'trade-earnings-state.json');
const LOCK_PATH = path.join(ROOT, 'logs', 'trade-earnings.lock');
const LOG_PATH = path.join(ROOT, 'logs', 'trade-earnings.jsonl');
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const CLIENT_DISCOUNT = 'ProZone client';
const RECOVER_GRACE_MS = 10 * 60 * 1000;

const money = (cents) => (Math.round(cents) / 100).toFixed(2);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const customerGid = (num) => `gid://shopify/Customer/${gidNumber(num)}`;

// ---------------------------------------------------------------------------------------------------------------
// State, lock, log

function loadState(file = STATE_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { orders: s.orders || {}, accounts: s.accounts || {}, batch: s.batch || null };
  } catch (e) {
    if (e.code === 'ENOENT') return { orders: {}, accounts: {}, batch: null };
    throw e; // a corrupt ledger must stop everything, never start over silently
  }
}

function saveState(state, file = STATE_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

function logEvent(o, file = LOG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`);
}

async function withLock(fn, file = LOCK_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < 30 * 60 * 1000) throw new Error('another earnings run is in progress');
    fs.unlinkSync(file); // a lock older than 30 minutes is a crashed run
    fd = fs.openSync(file, 'wx');
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return await fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signed review link (same HMAC pattern as the application approve link)

const secret = () => process.env.PROZONE_APPROVE_SECRET || process.env.SKU_RESOLVER_SECRET || '';
function token(batchId, s = secret()) { return s ? crypto.createHmac('sha256', s).update(`earnings|${batchId}`).digest('hex').slice(0, 32) : null; }
function verify(batchId, t, s = secret()) {
  const want = token(batchId, s);
  if (!want || !t || want.length !== String(t).length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(t)));
}
const reviewUrl = (batchId) => { const t = token(batchId); return t ? `${PUBLIC_BASE}/prozone/earnings?b=${encodeURIComponent(batchId)}&t=${t}` : null; };

// ---------------------------------------------------------------------------------------------------------------
// Shopify reads

const ORDER_FIELDS = `id name test cancelledAt discountCodes customer { id }
  currentSubtotalPriceSet { shopMoney { amount } } displayFulfillmentStatus shippingLine { title }
  fulfillments(first: 20) { status displayStatus createdAt deliveredAt }
  fulfillmentOrders(first: 10) { nodes { deliveryMethod { methodType } } }
  lineItems(first: 250) { nodes { id sku currentQuantity discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
    product { productType tags } } }`;

/** code -> contractor customer number, from the approved members' trade.code, limited to codes live on the discount. */
async function loadCodeTable(gql) {
  const r = await gql(`{ discountNodes(first: 20, query: "title:ProZone*") { nodes { discount { __typename
    ... on DiscountAutomaticBasic { title context { ... on DiscountCustomers { customers { id } } } }
    ... on DiscountCodeBasic { title codes(first: 250) { nodes { code } } } } } } }`);
  const members = new Set();
  const liveCodes = new Set();
  for (const n of r.data.discountNodes.nodes) {
    const d = n.discount;
    if (d.__typename === 'DiscountAutomaticBasic') for (const c of ((d.context && d.context.customers) || [])) members.add(c.id);
    if (d.__typename === 'DiscountCodeBasic' && d.title === CLIENT_DISCOUNT) for (const c of d.codes.nodes) liveCodes.add(c.code.toUpperCase());
  }
  const table = {};
  const people = {};
  for (const id of members) {
    const c = (await gql(`query($id: ID!) { customer(id: $id) { id displayName email code: metafield(namespace: "trade", key: "code") { value }
      business: metafield(namespace: "trade", key: "business") { value } } }`, { id })).data.customer;
    if (!c) continue;
    people[gidNumber(c.id)] = { name: c.displayName, email: c.email, business: c.business ? c.business.value : null };
    const code = c.code && c.code.value ? c.code.value.trim().toUpperCase() : '';
    if (code && liveCodes.has(code)) table[code] = gidNumber(c.id);
  }
  return { table, people, liveCodes: [...liveCodes] };
}

/** The orders that carry a member's code, plus every order already in the ledger. -> Map(order gid -> order) */
async function candidateOrders(gql, codes, state) {
  const out = new Map();
  for (const code of codes) {
    let after = null;
    do {
      const r = await gql(`query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`, { q: `discount_code:${code}`, after });
      for (const o of r.data.orders.nodes) out.set(o.id, o);
      after = r.data.orders.pageInfo.hasNextPage ? r.data.orders.pageInfo.endCursor : null;
    } while (after);
  }
  const known = Object.keys(state.orders).filter((id) => !out.has(id));
  for (let i = 0; i < known.length; i += 50) {
    const r = await gql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`, { ids: known.slice(i, i + 50) });
    for (const o of r.data.nodes) if (o && o.id) out.set(o.id, o);
  }
  return out;
}

/** CAD store credit account of a customer: { accountId, balanceCents, transactions: [{ id, kind, cents, createdAt }] } */
async function readAccount(gql, customerNum) {
  const r = await gql(`query($id: ID!) { customer(id: $id) { storeCreditAccounts(first: 5) { nodes { id balance { amount currencyCode }
    transactions(first: 50, reverse: true) { nodes { __typename amount { amount } createdAt
      ... on StoreCreditAccountCreditTransaction { id } ... on StoreCreditAccountDebitTransaction { id } } } } } } }`, { id: customerGid(customerNum) });
  const c = r.data.customer;
  const acc = c && c.storeCreditAccounts.nodes.find((a) => a.balance.currencyCode === 'CAD');
  if (!acc) return { accountId: null, balanceCents: 0, transactions: [] };
  return {
    accountId: acc.id,
    balanceCents: toCents(acc.balance.amount),
    transactions: acc.transactions.nodes.map((t) => ({
      id: t.id || null,
      kind: /Debit/.test(t.__typename) ? 'debit' : (/Credit/.test(t.__typename) ? 'credit' : 'other'),
      cents: Math.abs(toCents(t.amount.amount)),
      createdAt: t.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

function accountView(state, customerNum, balanceCents) {
  return { balanceCents, owedCents: (state.accounts[customerNum] && state.accounts[customerNum].owedCents) || 0 };
}

function storeAccount(state, customerNum, account) {
  state.accounts[customerNum] = { owedCents: account.owedCents };
}

/**
 * Bookkeeping for one order: runs nextAction until it reaches a money move or rest. Writes record / update / void /
 * apply_owed / carry_owed into state (no Shopify call). -> { move } where move is the credit / debit / recover action
 * still to do, or null.
 */
function bookkeep(state, order, opts, balanceCentsFor) {
  for (let i = 0; i < 6; i++) {
    const entry = state.orders[order.id] || null;
    const contractor = entry ? entry.contractorId : null;
    const account = contractor ? accountView(state, contractor, balanceCentsFor(contractor)) : { balanceCents: 0, owedCents: 0 };
    const a = E.nextAction(order, entry, account, opts);
    if (a.action === 'none' || a.action === 'wait') return { move: null, last: a };
    if (['record', 'update', 'void'].includes(a.action)) { state.orders[order.id] = a.entry; continue; }
    if (['apply_owed', 'carry_owed'].includes(a.action)) {
      state.orders[order.id] = a.entry;
      storeAccount(state, a.entry.contractorId, a.account);
      continue;
    }
    return { move: a }; // credit, debit or recover
  }
  throw new Error(`earnings: ${order.name} did not settle in 6 steps`);
}

/**
 * Weekly proposal. -> { batch, counts }. The batch is stored in state; nothing moves money.
 * opts: { rate, now, shippedHoldDays }
 */
async function propose(gql, { rate, now = new Date(), state = loadState(), save = saveState } = {}) {
  if (rate == null) throw new Error('propose: rate is required');
  const { table, people } = await loadCodeTable(gql);
  const orders = await candidateOrders(gql, Object.keys(table), state);
  const balances = new Map();
  const balanceFor = async (num) => {
    if (!balances.has(num)) balances.set(num, (await readAccount(gql, num)).balanceCents);
    return balances.get(num);
  };
  // Balances are read up front for every contractor in play, so bookkeeping stays synchronous.
  const contractors = new Set([...Object.values(table), ...Object.values(state.orders).map((e) => e.contractorId).filter(Boolean)]);
  for (const num of contractors) await balanceFor(num);

  const items = [];
  const counts = { orders: orders.size, recorded: 0, waiting: 0 };
  const sorted = [...orders.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
  for (const order of sorted) {
    const before = state.orders[order.id] ? state.orders[order.id].status : null;
    const { move, last } = bookkeep(state, order, { codeTable: table, rate, now }, (num) => balances.get(num) || 0);
    if (!before && state.orders[order.id]) counts.recorded++;
    if (last && last.action === 'wait') counts.waiting++;
    if (!move) continue;
    const entry = move.entry || state.orders[order.id];
    items.push({
      orderId: order.id,
      orderName: order.name,
      contractorId: entry.contractorId,
      code: entry.code,
      kind: move.action,
      amountCents: move.amountCents || (entry.inflight ? entry.inflight.amountCents : 0),
      targetCents: entry.targetCents,
      settledCents: entry.settledCents,
      who: people[entry.contractorId] || null,
    });
  }
  const batch = { id: `eb-${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 13)}`, createdAt: new Date(now).toISOString(), items, appliedAt: null, results: null };
  state.batch = batch;
  save(state);
  return { batch, counts };
}

/**
 * Find an in-flight move in the account's transactions: same kind, same amount, made after the move started, and not
 * already claimed by another ledger entry. -> { landed, txId }, or null when it's too early to say.
 */
function findLanded(entry, account, nowMs, claimed = new Set()) {
  const f = entry.inflight;
  const since = Date.parse(f.at) - 60 * 1000;
  const hit = account.transactions.find((t) => t.kind === f.kind && t.cents === f.amountCents
    && Date.parse(t.createdAt) >= since && !(t.id && claimed.has(t.id)));
  if (hit) return { landed: true, txId: hit.id };
  if (nowMs - Date.parse(f.at) < RECOVER_GRACE_MS) return null;
  return { landed: false, txId: null };
}

const claimedTxIds = (state) => new Set(Object.values(state.orders).flatMap((e) => (e && e.txIds) || []));

/**
 * Mac's tap. -> { results: [{ orderName, kind, amountCents, outcome, detail }] }
 * outcome: credited | debited | recovered | skipped | failed | unknown
 */
async function apply(gql, batchId, { rate, now = new Date(), notify = true, state = loadState(), save = saveState } = {}) {
  if (rate == null) throw new Error('apply: rate is required');
  const batch = state.batch;
  if (!batch || batch.id !== batchId) throw new Error(`batch ${batchId} is not the current batch`);
  if (batch.appliedAt) throw new Error(`batch ${batchId} was already applied at ${batch.appliedAt}`);
  const { table } = await loadCodeTable(gql);
  const results = [];
  for (const item of batch.items) {
    const base = { orderName: item.orderName, kind: item.kind, amountCents: item.amountCents };
    try {
      const fresh = (await gql(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: item.orderId })).data.order;
      if (!fresh) { results.push({ ...base, outcome: 'skipped', detail: 'order not found' }); continue; }
      const entry = state.orders[item.orderId] || null;
      const acc = await readAccount(gql, item.contractorId);

      if (item.kind === 'recover' || (entry && entry.inflight)) {
        const found = findLanded(entry, acc, new Date(now).getTime(), claimedTxIds(state));
        if (!found) { results.push({ ...base, outcome: 'unknown', detail: 'still too early to tell, next week' }); continue; }
        const s = E.settleInflight(entry, accountView(state, entry.contractorId, acc.balanceCents), { ...found, now });
        state.orders[item.orderId] = s.entry;
        storeAccount(state, entry.contractorId, s.account);
        save(state);
        logEvent({ event: 'recovered', order: item.orderName, landed: found.landed, txId: found.txId });
        results.push({ ...base, outcome: 'recovered', detail: found.landed ? 'had landed' : 'had not landed; proposed again next week' });
        continue;
      }

      const a = E.nextAction(fresh, entry, accountView(state, item.contractorId, acc.balanceCents), { codeTable: table, rate, now });
      if (a.action !== item.kind || a.amountCents !== item.amountCents) {
        results.push({ ...base, outcome: 'skipped', detail: `changed since the proposal (now ${a.action}${a.amountCents ? ` $${money(a.amountCents)}` : ''}); next week` });
        continue;
      }
      state.orders[item.orderId] = a.entry; // in flight, written before the call
      save(state);
      const amount = { amount: money(a.amountCents), currencyCode: 'CAD' };
      let r;
      try {
        r = a.action === 'credit'
          ? (await gql(`mutation($id: ID!, $i: StoreCreditAccountCreditInput!) { storeCreditAccountCredit(id: $id, creditInput: $i) {
              storeCreditAccountTransaction { ... on StoreCreditAccountCreditTransaction { id } } userErrors { field message code } } }`,
            { id: customerGid(item.contractorId), i: { creditAmount: amount, notify } })).data.storeCreditAccountCredit
          : (await gql(`mutation($id: ID!, $i: StoreCreditAccountDebitInput!) { storeCreditAccountDebit(id: $id, debitInput: $i) {
              storeCreditAccountTransaction { ... on StoreCreditAccountDebitTransaction { id } } userErrors { field message code } } }`,
            { id: acc.accountId || customerGid(item.contractorId), i: { debitAmount: amount } })).data.storeCreditAccountDebit;
      } catch (err) {
        logEvent({ event: 'unknown', order: item.orderName, kind: a.action, cents: a.amountCents, error: err.message });
        results.push({ ...base, outcome: 'unknown', detail: `${err.message}; left in flight, checked against the account next run` });
        continue;
      }
      const landed = !r.userErrors.length;
      const txId = landed && r.storeCreditAccountTransaction ? r.storeCreditAccountTransaction.id || null : null;
      const s = E.settleInflight(a.entry, accountView(state, item.contractorId, acc.balanceCents), { landed, txId, now });
      state.orders[item.orderId] = s.entry;
      storeAccount(state, item.contractorId, s.account);
      save(state);
      logEvent({ event: landed ? a.action : 'refused', order: item.orderName, contractor: item.contractorId, cents: a.amountCents, txId, errors: r.userErrors });
      results.push({ ...base, outcome: landed ? (a.action === 'credit' ? 'credited' : 'debited') : 'failed', detail: landed ? '' : JSON.stringify(r.userErrors) });
    } catch (err) {
      results.push({ ...base, outcome: 'failed', detail: err.message });
    }
  }
  batch.appliedAt = new Date(now).toISOString();
  batch.results = results;
  save(state);
  return { results };
}

// ---------------------------------------------------------------------------------------------------------------
// Words

const who = (it) => (it.who ? `${it.who.business || it.who.name}${it.who.business && it.who.name ? ` (${it.who.name})` : ''}` : `customer ${it.contractorId}`);
const verb = { credit: 'Credit', debit: 'Take back', recover: 'Check' };

function itemRows(items) {
  return items.map((it) => `<tr><td style="padding:6px 10px">${esc(verb[it.kind] || it.kind)}</td><td style="padding:6px 10px">${it.kind === 'recover' ? '' : `$${money(it.amountCents)}`}</td><td style="padding:6px 10px">${esc(who(it))}</td><td style="padding:6px 10px">${esc(it.code)}</td><td style="padding:6px 10px">${esc(it.orderName)}</td></tr>`).join('');
}

function totals(items) {
  const credit = items.filter((i) => i.kind === 'credit').reduce((n, i) => n + i.amountCents, 0);
  const debit = items.filter((i) => i.kind === 'debit').reduce((n, i) => n + i.amountCents, 0);
  return { credit, debit };
}

/** Mac's weekly email. -> { subject, html } */
function macEmail(batch) {
  const t = totals(batch.items);
  const url = reviewUrl(batch.id);
  const subject = `ProZone earnings: ${batch.items.length} to approve ($${money(t.credit)} credit${t.debit ? `, $${money(t.debit)} back` : ''})`;
  const html = `<p>This week's ProZone client-code earnings. Members get 5% of their clients' orders as store credit once the order is delivered or picked up.</p>
<table style="border-collapse:collapse;font-size:14px"><tr style="text-align:left"><th style="padding:6px 10px">Move</th><th style="padding:6px 10px">Amount</th><th style="padding:6px 10px">Member</th><th style="padding:6px 10px">Code</th><th style="padding:6px 10px">Order</th></tr>${itemRows(batch.items)}</table>
<p style="margin:24px 0">${url ? `<a href="${esc(url)}" style="background:#000;color:#fff;padding:14px 26px;border-radius:100px;text-decoration:none;font-weight:700;display:inline-block">Review and approve</a>` : '<b>No review link: PROZONE_APPROVE_SECRET / SKU_RESOLVER_SECRET is not set on the Mini.</b>'}</p>
<p style="color:#666;font-size:13px">Opening the link changes nothing. Approve on that page issues the store credit (Shopify emails each member) and takes back credit on refunded orders. Anything that changed since this email waits for next week. The link works on Tailscale.</p>`;
  return { subject, html };
}

function reviewPage(batch, t) {
  const tt = totals(batch.items);
  if (batch.appliedAt) return `<h2>Already approved</h2><p>${esc(batch.appliedAt)}</p>${resultsTable(batch.results || [])}`;
  return `<h2>ProZone earnings ${esc(batch.id)}</h2>
<p>${batch.items.length} moves: $${money(tt.credit)} store credit to issue${tt.debit ? `, $${money(tt.debit)} to take back` : ''}.</p>
<table style="border-collapse:collapse;font-size:15px">${itemRows(batch.items)}</table>
<form method="post" action="/prozone/earnings" style="margin-top:24px"><input type="hidden" name="b" value="${esc(batch.id)}"><input type="hidden" name="t" value="${esc(t)}">
<button type="submit" style="background:#000;color:#fff;padding:14px 26px;border-radius:100px;border:0;font-weight:700;font-size:16px">Approve and issue</button></form>
<p style="color:#666;font-size:13px">Shopify emails each member when their credit lands.</p>`;
}

function resultsTable(results) {
  return `<table style="border-collapse:collapse;font-size:15px">${results.map((r) => `<tr><td style="padding:6px 10px">${esc(r.outcome)}</td><td style="padding:6px 10px">${esc(r.kind)}</td><td style="padding:6px 10px">$${money(r.amountCents || 0)}</td><td style="padding:6px 10px">${esc(r.orderName)}</td><td style="padding:6px 10px;color:#666">${esc(r.detail || '')}</td></tr>`).join('')}</table>`;
}

module.exports = {
  STATE_PATH, LOCK_PATH, LOG_PATH, CLIENT_DISCOUNT,
  loadState, saveState, withLock, logEvent,
  token, verify, reviewUrl,
  loadCodeTable, candidateOrders, readAccount,
  bookkeep, propose, apply, findLanded,
  macEmail, reviewPage, resultsTable, totals,
};
