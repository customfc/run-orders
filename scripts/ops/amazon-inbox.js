#!/usr/bin/env node
/**
 * Amazon buyer messages (lib/amazon-inbox.js, docs/AMAZON-INBOX.md).
 *
 *   node scripts/ops/amazon-inbox.js                 # dry run: draft every unanswered Amazon message, send nothing
 *   node scripts/ops/amazon-inbox.js --live          # record + email Mac the cards (AMAZON_INBOX_AUTOSEND=1 also auto-sends tracking answers)
 *   node scripts/ops/amazon-inbox.js --send=KEY [--text-b64=...]   # send a carded reply (what the Send link runs)
 *   node scripts/ops/amazon-inbox.js --state
 *
 * hello@yourfloors.ca is read and answered through the yourfloors-cs mailbox login
 * (Graph, MS delegated OAuth); YF_CS_DIR points at it (default /Users/fred/yourfloors-cs).
 * Runs on the Mac Mini.
 */
require('dotenv').config();
const path = require('path');

const YF = process.env.YF_CS_DIR || '/Users/fred/yourfloors-cs';
require(path.join(YF, 'lib', 'env.js')); // Graph client settings; never overrides run-orders' own env
const graph = require(path.join(YF, 'lib', 'graph-mail.js'));
const inbox = require('../../lib/amazon-inbox');
const sp = require('../../lib/sp-api');
const ss = require('../../lib/shipstation-v2');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const has = (k) => process.argv.includes(`--${k}`);
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const j = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphJson(p) { return (await graph.graphFetch(p)).json(); }

async function listMessages(sinceIso) {
  const out = [];
  let next = `/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}&$orderby=${encodeURIComponent('receivedDateTime asc')}&$top=100&$select=id,subject,from,receivedDateTime,conversationId,body,bodyPreview,isRead`;
  for (let page = 0; next && page < 20; page++) {
    const r = await graphJson(next);
    out.push(...(r.value || []));
    next = r['@odata.nextLink'] ? r['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return out;
}

async function repliedInConversation(conversationId, afterIso) {
  if (!conversationId) return false;
  const r = await graphJson(`/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)}&$select=sentDateTime&$top=20`);
  return (r.value || []).some((m) => m.sentDateTime && m.sentDateTime > afterIso);
}

async function facts(orderId) {
  const order = (await sp.getOrder(orderId))?.payload;
  if (!order) return null;
  const items = (await sp.getOrderItems(orderId))?.payload?.OrderItems || [];
  let refunds = 0, claims = 0;
  try {
    const fe = (await sp.listFinancialEventsByOrder(orderId))?.payload?.FinancialEvents || {};
    // Total refunded, from every charge adjustment on every refund event (amounts come back negative).
    const sum = (list) => -(list || []).reduce((t, ev) => t + (ev.ShipmentItemAdjustmentList || []).reduce((a, it) =>
      a + (it.ItemChargeAdjustmentList || []).reduce((b, c) => b + Number(c.ChargeAmount?.CurrencyAmount || 0), 0), 0), 0);
    refunds = (fe.RefundEventList || []).length ? `${(fe.RefundEventList || []).length} refund(s), $${sum(fe.RefundEventList).toFixed(2)} in total` : 0;
    claims = (fe.GuaranteeClaimEventList || []).length;
  } catch { /* facts stay partial; the card shows what we have */ }
  // ShipStation: shipments on every order carrying this number (split children
  // carry suffixes), plus the pipeline's own label log, because a deleted
  // ShipStation order leaves its labels with no order number at all (Slav,
  // 701-2953867-2160265: four delivered rolls that order-number search can't see).
  const found = new Map();
  const orders = (j(await ss.v1Request('GET', `/orders?orderNumber=${encodeURIComponent(orderId)}&pageSize=20`))?.orders) || [];
  for (const o of orders.filter((x) => String(x.orderNumber).includes(orderId))) {
    const sh = (j(await ss.v1Request('GET', `/shipments?orderId=${o.orderId}&pageSize=50`))?.shipments) || [];
    for (const s of sh.filter((x) => !x.voided && !x.isReturnLabel)) found.set(s.trackingNumber, s);
  }
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(__dirname, '..', '..', 'data', 'analytics.sqlite'), { readonly: true });
    const rows = db.prepare('SELECT DISTINCT tracking_number FROM shipping_labels WHERE order_number = ? AND tracking_number IS NOT NULL').all(orderId);
    db.close();
    for (const { tracking_number: trk } of rows) {
      if (found.has(trk)) continue;
      const s = ((j(await ss.v1Request('GET', `/shipments?trackingNumber=${encodeURIComponent(trk)}`))?.shipments) || []).find((x) => !x.voided);
      if (s) found.set(trk, s);
    }
  } catch { /* label log unavailable: ShipStation results stand */ }
  const shipments = [];
  for (const s of found.values()) {
    const t = j(await ss.v2Request('GET', `/v2/labels/se-${s.shipmentId}/track`)) || {};
    shipments.push({
      tracking: s.trackingNumber, carrier: String(s.carrierCode || '').replace(/_walleted$/, ''), shipDate: String(s.shipDate || '').slice(0, 10),
      status: t.status_code || '?', scanned: ['IT', 'AT', 'DE', 'EX'].includes(t.status_code), delivered: t.status_code === 'DE' ? String(t.actual_delivery_date || '').slice(0, 10) || 'yes' : null,
      lastEvent: (t.events || [])[0]?.description || null, // V2 events are newest-first
    });
    await sleep(300);
  }
  let returns = null;
  try {
    const e = require('../../lib/amazon-returns-autopilot').loadState().orders?.[orderId];
    if (e) {
      const last = (e.history || []).slice(-3).map((h) => h.msg).join('; ');
      returns = `${e.stage}${e.label ? `, return label ${e.label.tracking}` : ''}${e.refund ? `, refunded $${(e.refund.cents / 100).toFixed(2)} on ${e.refund.at.slice(0, 10)}` : ''}${last ? ` (${last})` : ''}`;
    }
  } catch { /* none */ }
  return {
    orderId, status: order.OrderStatus, placed: String(order.PurchaseDate || '').slice(0, 10), total: order.OrderTotal?.Amount,
    items: items.map((i) => ({ qty: i.QuantityOrdered, title: String(i.Title || '').slice(0, 90), shipped: i.QuantityShipped, cancelRequested: String(i.BuyerRequestedCancel?.IsBuyerRequestedCancel) === 'true' })),
    shipments, refunds, claims, returns,
  };
}

async function send(entry) {
  await graph.sendReply({ replyToGraphId: entry.graphId, text: entry.reply });
  require('../../lib/audit').log({ action: 'amazon-inbox-sent', order: entry.orderId, key: entry.key, category: entry.category });
}

async function notifyMac(out) {
  const L = [];
  const card = (e, label) => {
    const t = inbox.sendToken(e.key);
    L.push(`${label}${e.orderId || '(no order id)'}  ${e.name || ''}  ${e.receivedAt?.slice(0, 16).replace('T', ' ')} UTC`);
    L.push(`They wrote: ${e.said || e.subject}`);
    L.push('', e.facts, '');
    if (e.action) L.push(`Needs your OK: ${e.action}`);
    if (e.reply) L.push('Draft reply:', e.reply);
    if (t && e.reply) L.push('', `Send (or edit first): ${PUBLIC_BASE}/amazon-inbox/send?k=${e.key}&t=${t}`);
    else if (!e.reply) L.push('', 'Handle in Seller Central.');
    L.push('', '────────────────', '');
  };
  out.fresh.forEach((e) => card(e, ''));
  if (out.stale.length) { L.push('STILL UNANSWERED (Amazon wants a reply within 24 h):', ''); out.stale.forEach((e) => card(e, 'STILL WAITING ')); }
  if (out.auto.length) { L.push('Answered automatically (carrier facts):'); for (const e of out.auto) L.push(`  ${e.orderId}: ${e.reply.split('\n').slice(2, 3).join(' ')}`); L.push(''); }
  if (out.errors.length) { L.push('Errors:'); for (const e of out.errors) L.push(`  ${e.subject}: ${e.error}`); }
  const n = out.fresh.length + out.stale.length;
  await require('../../lib/emailer').sendEmail({
    to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca',
    subject: n ? `Amazon messages: ${n} to answer` : out.errors.length ? 'Amazon messages: error' : `Amazon messages: ${out.auto.length} answered`,
    text: L.join('\n'),
  });
}

const io = {
  listMessages, repliedInConversation, facts, send, notifyMac,
  bodyText: (m) => graph.bodyText(m.body),
  draft: (args) => inbox.draftWithClaude(args),
  markRead: (id) => graph.markRead(id),
};

(async () => {
  if (has('state')) {
    for (const e of Object.values(inbox.loadState().messages || {})) console.log(`${e.key}  ${String(e.status).padEnd(18)} ${e.orderId || ''}  ${String(e.subject || '').slice(0, 70)}`);
    return;
  }
  const key = arg('send');
  if (key) {
    const b64 = arg('text-b64');
    const e = await inbox.sendCarded(key, { io, text: b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined });
    console.log(JSON.stringify({ ok: true, order: e.orderId, status: e.status }));
    return;
  }
  const live = has('live');
  const out = await inbox.run({ io, live, autosend: process.env.AMAZON_INBOX_AUTOSEND === '1' });
  if (live) { console.log(JSON.stringify({ fresh: out.fresh.length, auto: out.auto.length, stale: out.stale.length, skipped: out.skipped.length, errors: out.errors.length })); return; }
  for (const e of out.fresh) {
    console.log(`\n=== ${e.orderId || '-'}  ${e.name || ''}  [${e.category}${e.needsMac ? ', needs Mac' : ''}]  ${e.receivedAt}`);
    console.log(`They wrote: ${e.said.slice(0, 300)}`);
    console.log(e.facts);
    if (e.action) console.log(`ACTION: ${e.action}`);
    console.log(`--- draft ---\n${e.reply || '(none)'}`);
  }
  for (const s of out.skipped) console.log(`skip: ${s.subject.slice(0, 80)} (${s.why})`);
  for (const e of out.errors) console.log(`ERROR: ${e.subject}: ${e.error}`);
  if (!out.fresh.length) console.log('No unanswered Amazon messages.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
