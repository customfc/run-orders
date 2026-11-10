#!/usr/bin/env node
/**
 * Prosol branch replies (lib/branch-replies.js, docs/BRANCH-REPLIES.md).
 *
 *   node scripts/ops/branch-replies.js --since=2026-10-10T00:00:00Z --dry [--out=file.json]
 *                                                   # replay: classify, tie, draft; writes and sends NOTHING
 *   node scripts/ops/branch-replies.js --shadow     # what the cron runs without BRANCH_REPLIES_LIVE=1: state + audit, no cards
 *   node scripts/ops/branch-replies.js --live       # state + audit + cards to Mac + vendor-error lines
 *   node scripts/ops/branch-replies.js --send=KEY [--text-b64=...]   # Mac's Send tap (the /branch-replies/send route runs this)
 *   node scripts/ops/branch-replies.js --state
 *   node scripts/ops/branch-replies.js --read-test="we dont have KP27-01"   # classify one text (Opus + guard)
 *
 * hello@yourfloors.ca is read and answered through the yourfloors-cs mailbox login (Graph, MS delegated OAuth), the
 * same client the Amazon inbox and the pickup runner use; YF_CS_DIR points at it (default /Users/fred/yourfloors-cs).
 * Runs on the Mac Mini.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const br = require('../../lib/branch-replies');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const has = (k) => process.argv.includes(`--${k}`);
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const ROOT = path.join(__dirname, '..', '..');
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

let graphMod = null;
function graph() {
  if (graphMod) return graphMod;
  const YF = process.env.YF_CS_DIR || '/Users/fred/yourfloors-cs';
  require(path.join(YF, 'lib', 'env.js')); // Graph client settings; never overrides run-orders' own env
  graphMod = require(path.join(YF, 'lib', 'graph-mail.js'));
  return graphMod;
}
const gjson = async (p, opts) => (await graph().graphFetch(p, opts)).json();

async function listMessages(sinceIso) {
  const out = [];
  // All folders (not just Inbox): a desk rule that files Prosol mail elsewhere must not hide a reply.
  let next = `/me/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}&$orderby=${encodeURIComponent('receivedDateTime asc')}&$top=100&$select=id,subject,from,receivedDateTime,conversationId,isDraft`;
  for (let page = 0; next && page < 300; page++) {
    const r = await gjson(next);
    out.push(...(r.value || []));
    next = r['@odata.nextLink'] ? r['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return out;
}

async function body(graphId) {
  const r = await gjson(`/me/messages/${encodeURIComponent(graphId)}?$select=body`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
  return graph().bodyText(r.body);
}

async function threadStart(conversationId) {
  if (!conversationId) return null;
  const r = await gjson(`/me/messages?$filter=${encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)}&$select=sentDateTime,receivedDateTime&$top=50`);
  const ts = (r.value || []).map((m) => m.sentDateTime || m.receivedDateTime).filter(Boolean).sort();
  return ts[0] || null;
}

function emails() {
  const out = [];
  let txt = '';
  try { txt = fs.readFileSync(path.join(ROOT, 'data', 'audit.jsonl'), 'utf8'); } catch { return out; }
  for (const line of txt.split('\n')) {
    if (!line.includes('"pipeline-email-prosol"')) continue;
    try { const e = JSON.parse(line); if (e.action === 'pipeline-email-prosol' && e.success) out.push(e); } catch { /* skip */ }
  }
  return out;
}

const skuMap = () => require('../../lib/sku-map-file').readSkuMap().mappings || {};
const locations = () => Object.values(require('../shipstation/prosol-location-map.json'));

let prosol = null;
async function prosolClient() {
  if (prosol) return prosol;
  const { ProsolClientV2 } = require('../shipstation/prosol-client-v2');
  const c = new ProsolClientV2();
  await c.init();
  prosol = c;
  return c;
}

/** Live Prosol stock per shippable branch for one order item (same filter as lib/discontinued.js productDetails). */
async function stock(item) {
  const e = skuMap()[item.sku] || {};
  const c = await prosolClient();
  let productId = e.prosol_product_id || null;
  if (!productId) {
    const info = await c.getMappingInfo(e.api_sku || item.sku);
    if (!info) throw new Error(`Prosol has no product for ${e.api_sku || item.sku}`);
    if (info.ambiguous) throw new Error(`${info.count} Prosol products answer ${e.api_sku || item.sku}`);
    productId = info.productId;
  }
  const inv = (await c.getInventoryByLocation(productId)) || [];
  const map = require('../shipstation/prosol-location-map.json');
  return inv
    .map((l) => ({ l, loc: map[String(l.locationId)] }))
    .filter(({ l, loc }) => loc && loc.active && !loc.non_prosol && loc.shipstation_warehouse_id && Number(l.quantity) > 0)
    .map(({ l, loc }) => ({ code: loc.code, city: loc.city, province: loc.province, lat: loc.lat, lng: loc.lng, qty: Number(l.quantity) }))
    .sort((a, b) => b.qty - a.qty);
}

async function province(order) {
  const r = await require('../../lib/shipstation-v2').v1Request('GET', `/orders/${Number(order.orderId)}`);
  try { return String(JSON.parse(r.body)?.shipTo?.state || '').toUpperCase() || null; } catch { return null; }
}

function origin(code) {
  const l = locations().find((x) => x.code === code);
  return l && l.lat != null ? [l.lat, l.lng] : null;
}

function vendorErrorExists(order, sku) {
  return require('../../lib/vendor-errors').loadVendorErrors().some((r) => r.vendor === 'Prosol'
    && String(r.order_ref) === String(order) && norm(r.sku) === norm(sku) && ['not_shipped', 'short_ship'].includes(r.issue_type));
}

async function notifyMac({ subject, text }) {
  await require('../../lib/emailer').sendEmail({ to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca', subject, text });
}

const io = {
  listMessages, body, threadStart, emails, stock, province, origin, vendorErrorExists, notifyMac,
  factsFor: async (orderId, at) => br.opsStateOrder(orderId, at, { readMap: skuMap }),
  classify: (a) => br.classifyWithClaude(a),
  draft: (a) => br.draftWithClaude(a),
  audit: (o) => require('../../lib/audit').log(o),
  logVendorError: (rec) => require('../../lib/vendor-errors').logVendorError(rec),
  link: (key) => { const t = br.sendToken(key); return t ? `${PUBLIC_BASE}/branch-replies/send?k=${key}&t=${t}` : null; },
};

function print(e) {
  const kind = `${e.kind}${e.opusKind && e.opusKind !== e.kind ? ` (Opus: ${e.opusKind}, guard: ${e.guarded})` : ''}`;
  console.log(`\n=== ${e.receivedAt}  ${e.warehouse}  ${e.from}  [${kind}]`);
  console.log(`They wrote: ${String(e.said || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  if (e.skus && e.skus.length) console.log(`Codes: ${e.skus.map((s) => `${s.code}${s.qty ? ` x${s.qty}` : ''}`).join(', ')}`);
  if (e.tie) {
    console.log(`Tie${e.tie.sure ? '' : ' (NOT SURE)'}: sent ${e.tie.sentAt || '?'}`);
    console.log(br.ordersText(e.tie).split('\n').map((l) => `  ${l}`).join('\n'));
    if (e.tie.reasons.length) console.log(`  why unsure: ${e.tie.reasons.join('; ')}`);
  }
  for (const l of e.lines || []) console.log(`  ${l.sku} ${l.order ? `#${l.order}` : ''}: ${l.alt ? `-> ${l.alt.city} (${l.alt.qty})` : l.reason}`);
  if (e.draft) console.log(`--- draft ---\n${e.draft}`);
  if (e.note) console.log(`(note for Mac: ${e.note})`);
}

(async () => {
  if (has('state')) {
    const s = br.loadState();
    console.log(`lastSeenAt ${s.lastSeenAt}  lastRunAt ${s.lastRunAt || '-'}`);
    for (const e of Object.values(s.messages)) console.log(`${e.key}  ${String(e.status).padEnd(8)} ${String(e.kind || '').padEnd(10)} ${String(e.receivedAt || '').slice(0, 16)}  ${String(e.subject || '').slice(0, 60)}`);
    return;
  }
  const rt = arg('read-test');
  if (rt) {
    const cls = await br.classifyWithClaude({ text: br.stripQuote(rt), branch: '', from: 'test@prosol.ca', subject: 'Re: Order - Test (TEST)' });
    console.log(JSON.stringify({ ...cls, afterGuard: br.applyGuard(cls.kind, br.stripQuote(rt)) }, null, 1));
    return;
  }
  const key = arg('send');
  if (key) {
    const b64 = arg('text-b64');
    const e = await br.sendCarded(key, { graph: graph(), text: b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined, audit: io.audit });
    console.log(JSON.stringify({ ok: true, key, status: e.status, sentAt: e.sentAt }));
    return;
  }
  const mode = has('live') ? 'live' : has('shadow') ? 'shadow' : 'dry';
  let since = arg('since');
  if (mode === 'dry' && !since) since = br.loadState().lastSeenAt || new Date(Date.now() - 864e5).toISOString();
  if (mode !== 'dry' && since) throw new Error('--since is for --dry replays only');
  const out = await br.run({ io, mode, since, log: (s) => console.error(`[branch-replies] ${s}`) });
  if (prosol) { try { await prosol.close(); } catch { /* ignore */ } }
  if (mode !== 'dry') {
    const by = {};
    for (const e of out.processed) by[e.kind] = (by[e.kind] || 0) + 1;
    console.log(JSON.stringify({ mode, firstRun: out.firstRun, processed: out.processed.length, by, skipped: out.skipped, errors: out.errors }));
    if (out.errors.length) process.exitCode = 2;
    return;
  }
  out.processed.forEach(print);
  for (const e of out.errors) console.log(`ERROR: ${e.subject} (${e.from}): ${e.error}`);
  const by = {};
  for (const e of out.processed) by[e.kind] = (by[e.kind] || 0) + 1;
  console.log(`\n${out.processed.length} replies since ${since}: ${JSON.stringify(by)}; ${out.processed.filter((e) => e.tie && !e.tie.sure).length} with an unsure tie; ${out.errors.length} errors. Nothing was written or sent.`);
  const file = arg('out');
  if (file) { fs.writeFileSync(file, JSON.stringify(out, null, 1)); console.log(`Written: ${file}`); }
})().catch((e) => { console.error('FAILED:', e.message); if (prosol) prosol.close().catch(() => {}); process.exit(1); });
