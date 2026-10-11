'use strict';
/**
 * Discontinued-at-Prosol desk.
 *
 * Why this exists: YourFloors #1412 (QEP Xtreme glass nipper, SKU 32014) failed staging on every pass from
 * 2026-10-07 with "No Prosol inventory result" and nobody heard. Prosol had dropped the product, the error only
 * reached the run log, and the order sat past its fulfil-by date. The answer was already knowable: Prosol had an
 * in-stock substitute two searches away. So this proposes an action instead of raising an alert.
 *
 *   1. Staging tags the failure (manualReview row `prosolGone`) when a mapped Prosol SKU gets no catalog hit.
 *   2. handleStageResult confirms it in its own Prosol session: both codes, with and without slashes, and the
 *      pinned product id. Still listed = a lookup blip; only if it keeps failing for BLIP_HOURS does Mac hear.
 *   3. Gone: Opus looks for a substitute with read-only Prosol tools, and code re-checks its stock, cost and list
 *      price (a cheaper, lesser item is not a fair swap).
 *   4. One email to Mac with taps. Shopify: Offer the swap / Refund. Amazon (no substitutes allowed): Mark
 *      discontinued. Offer and refund also HALT the SKU in sku-map and set the Shopify product to DRAFT.
 *   5. Daily reminder while the customer decides, carrying Ship the swap / Refund. Ship the swap records a per-order
 *      swap that staging, the Prosol email and the Salesforce PO all apply (applySwaps), so the next pass ships it.
 *      A refund of one line out of several records a per-order drop the same way, so the rest ships.
 *
 * Every customer email and refund waits for Mac's tap. Taps are HMAC links (SKU_RESOLVER_SECRET) to a confirm page;
 * the GET never changes anything (mail scanners pre-open links), the button POSTs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = process.env.DISCONTINUED_STATE_FILE || path.join(__dirname, '..', 'data', 'discontinued-state.json');
const MODEL = 'claude-opus-5-5';
const MAX_AI_PER_PASS = Number(process.env.DISCONTINUED_AI_MAX_PER_PASS || 2);
const MAX_AI_TURNS = 14;
const REMIND_HOURS = Number(process.env.DISCONTINUED_REMIND_HOURS || 24);
const OFFER_REMIND_HOURS = 72; // waiting on the customer: the taps went out with the offer, so nudge rarely
const BLIP_HOURS = 3;          // a lookup that misses but finds the product again is ignored for this long
const MIN_FAIR_PRICE = 0.8;    // substitute list price must be at least this share of what the customer paid
const PROSOL_GAP_MS = 1500;    // spacing between Prosol calls (shared account)
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const ALERT_TO = () => process.env.DISCONTINUED_EMAIL || process.env.SKU_RESOLVER_EMAIL || process.env.MAC_CC_EMAIL || 'mac@customfc.ca';
const SECRET = () => process.env.DISCONTINUED_SECRET || process.env.SKU_RESOLVER_SECRET;

const OPEN = new Set(['proposed', 'offered', 'lookup-broken']);
const PROVINCES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'the Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

// ── state ────────────────────────────────────────────────────────────────────

function loadState(file = STATE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    s.orders = s.orders || {};
    return s;
  } catch { return { orders: {} }; }
}
function saveState(s, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

const normOrder = (n) => String(n || '').replace(/^#/, '').trim();
const money = (n) => `$${Number(n).toFixed(2)}`;
const hoursSince = (iso, now = new Date()) => (iso ? (now - new Date(iso)) / 36e5 : Infinity);
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'America/Vancouver' });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ── per-order swaps (read by staging, the Prosol email and the Salesforce PO) ─

let swapCache = { mtimeMs: -1, file: null, swaps: {} };
function loadSwaps(file = STATE_FILE) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return {}; }
  if (swapCache.file === file && swapCache.mtimeMs === mtimeMs) return swapCache.swaps;
  const swaps = {};
  for (const [n, rec] of Object.entries(loadState(file).orders)) {
    if (rec.status === 'swap-approved' && rec.substitute) {
      swaps[n] = { fromSku: rec.sku, toSku: rec.substitute.sku, toName: rec.substitute.name };
    } else if (rec.status === 'refunded' && rec.lineRefund) {
      swaps[n] = { fromSku: rec.sku, drop: true };
    }
  }
  swapCache = { mtimeMs, file, swaps };
  return swaps;
}

/**
 * The order's items with any approved swap applied: the discontinued line becomes the substitute (sku and every
 * name field), or is dropped when only that line was refunded. Anything else passes through untouched.
 */
function applySwaps(orderNumber, items, { file } = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const s = loadSwaps(file)[normOrder(orderNumber)];
  if (!s) return items;
  const out = [];
  for (const it of items) {
    if (String(it.sku || '') !== s.fromSku) { out.push(it); continue; }
    if (s.drop) continue;
    const swapped = { ...it, sku: s.toSku };
    for (const f of ['name', 'title', 'displayName']) if (f in it) swapped[f] = s.toName;
    if (!('name' in it) && !('title' in it)) swapped.name = s.toName;
    out.push(swapped);
  }
  return out;
}

// ── Prosol lookups ───────────────────────────────────────────────────────────

const LOCATION_MAP = () => require('../scripts/shipstation/prosol-location-map.json');

function prosolName(p) {
  return typeof p.name === 'object' && p.name ? (p.name.en || p.name.fr || '') : String(p.name || '');
}
function codeForms(code) {
  if (!code) return [];
  const c = String(code).trim();
  return [...new Set([c, c.replace(/[/]/g, ''), c.replace(/[/-]/g, '')])].filter(Boolean);
}
/** Pinned Prosol product id: the entry's field, else "product id 82685" in its note. */
function productIdFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.prosol_product_id) return Number(entry.prosol_product_id);
  const m = /product id (\d+)/i.exec(entry.note || '');
  return m ? Number(m[1]) : null;
}

async function prosolProducts(client, query) {
  const res = await client.apiGet(`/api/storefront/products?${query}&append=prosol_sku`);
  if (!res || res.status !== 200) throw new Error(`Prosol products ${query}: HTTP ${res && res.status}`);
  const d = JSON.parse(res.body);
  const arr = d.data || d;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Is the product really gone from Prosol's catalog? Checks every code form and the pinned product id. Any HTTP
 * failure throws (a broken session is not evidence). Returns { gone, found?, evidence[] }.
 */
async function confirmGone(client, { apiSku, prosolSku, productId }, { gap = PROSOL_GAP_MS, sleep = sleepMs } = {}) {
  const evidence = [];
  const codes = [...new Set([...codeForms(apiSku), ...codeForms(prosolSku)])].filter((c) => !c.startsWith('HALT_'));
  for (const code of codes) {
    // Any hit counts as still listed (staging's own lookup accepts any filter[sku] hit), so a near-miss code
    // reads as a broken lookup for Mac to look at, never as a product to replace.
    const hits = await prosolProducts(client, `filter[sku]=${encodeURIComponent(code)}&limit=5`);
    if (hits.length) return { gone: false, found: { id: hits[0].id, sku: hits[0].sku, name: prosolName(hits[0]) }, evidence };
    evidence.push(`no Prosol product with SKU ${code}`);
    await sleep(gap);
  }
  if (productId) {
    const hits = await prosolProducts(client, `filter[id]=${productId}`);
    if (hits.length) return { gone: false, found: { id: hits[0].id, sku: hits[0].sku, name: prosolName(hits[0]) }, evidence };
    evidence.push(`Prosol product ${productId} no longer exists`);
  }
  return { gone: true, evidence };
}

/** One product with our cost, list price and stock at the branches the pipeline can ship from. */
async function productDetails(client, productId, { gap = PROSOL_GAP_MS, sleep = sleepMs } = {}) {
  const hits = await prosolProducts(client, `filter[id]=${Number(productId)}`);
  const p = hits[0];
  if (!p) return null;
  await sleep(gap);
  const inv = (await client.getInventoryByLocation(p.id)) || [];
  await sleep(gap);
  const offer = await client.getOfferPrice(p.id);
  const locs = LOCATION_MAP();
  const stock = inv
    .map((l) => ({ l, loc: locs[String(l.locationId)] }))
    .filter(({ l, loc }) => loc && loc.active && !loc.non_prosol && loc.shipstation_warehouse_id && Number(l.quantity) > 0)
    .map(({ l, loc }) => ({ code: loc.code, city: loc.city, province: loc.province, qty: Number(l.quantity) }))
    .sort((a, b) => b.qty - a.qty);
  return {
    productId: p.id,
    sku: String(p.sku || ''),
    prosolSku: String(p.prosol_sku || p.external_id || p.sku || ''),
    name: prosolName(p),
    active: p.active !== false,
    cost: offer ? offer.cost_cad : null,
    list: offer ? offer.retail_cad : null,
    stock,
    total: stock.reduce((n, s) => n + s.qty, 0),
  };
}

/** Code's own check on whatever Opus picked. Returns null when fine, else the reason it isn't offered. */
function substituteProblem(d, { qty = 1, paidUnit = null } = {}) {
  if (!d) return 'Prosol has no such product';
  if (!d.active) return `${d.name} is not active at Prosol`;
  if (!d.sku) return `${d.name} has no Prosol SKU`;
  if (!(d.total >= qty)) return `${d.name}: only ${d.total} in stock at our Prosol branches, the order needs ${qty}`;
  if (d.cost == null) return `${d.name}: Prosol shows no price for us`;
  if (paidUnit && d.list != null && d.list < paidUnit * MIN_FAIR_PRICE) {
    return `${d.name} lists at ${money(d.list)}, well under the ${money(paidUnit)} the customer paid, so it is not a fair swap`;
  }
  return null;
}

// ── Opus: find a substitute ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'prosol_search',
    description: 'Search the Prosol catalog by words (brand, product type, model). Returns up to 20 active products with product_id, SKU, name and stock status.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'prosol_product',
    description: 'Details for one Prosol product: our cost, list price, and stock at each branch we ship from.',
    input_schema: { type: 'object', properties: { product_id: { type: 'integer' } }, required: ['product_id'], additionalProperties: false },
  },
  {
    name: 'submit_substitute',
    description: 'Submit your final answer. Call exactly once, at the end.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['substitute', 'none'] },
        product_id: { type: 'integer', description: 'Prosol product_id of the substitute; 0 when none' },
        display_name: { type: 'string', description: 'How we name it to the customer: brand + product, no SKU (e.g. "Rubi Nipper for Glass Mosaic"); "" when none' },
        kind: { type: 'string', description: 'Plain lowercase noun for what it is (e.g. "glass nipper"); "" when none' },
        reply_word: { type: 'string', description: 'One word the customer can reply with to accept, usually the brand (e.g. "Rubi"); "" when none' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        why: { type: 'string', description: 'Two or three plain sentences for the owner: why this is a fair swap, or why nothing fits' },
      },
      required: ['decision', 'product_id', 'display_name', 'kind', 'reply_word', 'confidence', 'why'],
      additionalProperties: false,
    },
  },
];

const SYSTEM = `You find a substitute for a product that our distributor Prosol no longer carries, for a customer order that cannot ship.

We are YourFloors, a Canadian flooring and tile-supplies retailer (yourfloors.ca). The customer will be offered the substitute at no extra cost, or a full refund. Mac, the owner, approves every offer before it goes out.

A fair substitute:
- does the same job, at the same or a better grade, in a comparable size or capacity;
- is in stock at our Prosol branches for the quantity ordered;
- lists at roughly the price the customer paid or more. A cheaper, lesser item is not a fair swap.
Prefer the same brand when it has one. A different brand is fine when it is the closest match.

If nothing fits, submit "none" and say why. That is a good answer: Mac then offers a refund.
Your tools only read. Be efficient: a few searches, check the one or two best with prosol_product, then submit_substitute.`;

function substituteContext(rec, entry) {
  return [
    `Discontinued product: ${rec.itemName || entry?.product || rec.sku}`,
    entry?.product && entry.product !== rec.itemName ? `Our catalog name: ${entry.product}` : null,
    `Our SKU ${rec.sku}; Prosol code ${rec.apiSku}${rec.prosolSku && rec.prosolSku !== rec.apiSku ? ` / ${rec.prosolSku}` : ''}`,
    `Quantity ordered: ${rec.qty}`,
    rec.paidUnit ? `Customer paid ${money(rec.paidUnit)} each` : null,
    entry?.cost_cad ? `Our old cost ${money(entry.cost_cad)}${entry.retail_cad ? `, old list price ${money(entry.retail_cad)}` : ''}` : null,
    rec.customer?.province ? `Customer is in ${rec.customer.city || ''} ${rec.customer.province}`.trim() : null,
  ].filter(Boolean).join('\n');
}

async function runTool(name, input, client) {
  try {
    if (name === 'prosol_search') {
      const q = String(input.query || '').trim().slice(0, 80);
      if (!q) return '[]';
      const hits = await prosolProducts(client, `search=${encodeURIComponent(q)}&limit=20`);
      const seen = new Set();
      return JSON.stringify(hits.filter((p) => p.active !== false && !seen.has(p.id) && seen.add(p.id))
        .map((p) => ({ product_id: p.id, sku: p.sku, name: prosolName(p), stock_status: p.stock_status })));
    }
    if (name === 'prosol_product') {
      const d = await productDetails(client, input.product_id);
      return JSON.stringify(d ? {
        product_id: d.productId, sku: d.sku, name: d.name, our_cost: d.cost, list_price: d.list,
        stock: d.stock.map((s) => `${s.city} ${s.province}: ${s.qty}`), total_stock: d.total,
      } : { error: 'no such product' });
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

/** Ask Opus for a substitute. Returns the submit_substitute input, or null. */
async function proposeSubstitute(rec, { client, entry, anthropic, sleep = sleepMs } = {}) {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  }
  const messages = [{ role: 'user', content: substituteContext(rec, entry) }];
  let nudged = false;
  for (let turn = 0; turn < MAX_AI_TURNS; turn++) {
    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const submit = uses.find((b) => b.name === 'submit_substitute');
    if (submit) return submit.input;
    if (!uses.length) {
      if (nudged) return null;
      nudged = true;
      messages.push({ role: 'user', content: 'Call submit_substitute with your answer now.' });
      continue;
    }
    const results = [];
    for (const u of uses) { // one at a time: shared Prosol account
      results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(u.name, u.input, client) });
      await sleep(PROSOL_GAP_MS);
    }
    messages.push({ role: 'user', content: results });
  }
  return null;
}

// ── Shopify ──────────────────────────────────────────────────────────────────

const defaultGql = () => require('./shopify-graphql').graphql;

/** The facts the desk needs about a Shopify order, by its number. */
async function shopifyFacts(orderNumber, sku, gql = defaultGql()) {
  const r = await gql(`query($q: String!) { orders(first: 1, query: $q) { nodes {
    id name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
    totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
    customer { firstName lastName }
    shippingAddress { firstName lastName city provinceCode }
    lineItems(first: 50) { nodes { id sku title quantity currentQuantity
      discountedUnitPriceSet { shopMoney { amount } }
      variant { product { id status } } } } } } }`, { q: `name:#${normOrder(orderNumber)}` });
  const o = r.data?.orders?.nodes?.[0];
  if (!o) throw new Error(`Shopify order #${normOrder(orderNumber)} not found`);
  const lines = o.lineItems.nodes;
  const line = lines.find((l) => String(l.sku || '') === String(sku));
  const total = Number(o.totalPriceSet.shopMoney.amount);
  const refunded = Number(o.totalRefundedSet.shopMoney.amount);
  return {
    id: o.id,
    name: o.name,
    email: o.email,
    createdAt: o.createdAt,
    total,
    refunded,
    closedReason: o.cancelledAt ? 'cancelled in Shopify'
      : refunded > 0 && refunded >= total ? 'refunded in full in Shopify'
        : o.displayFulfillmentStatus === 'FULFILLED' ? 'fulfilled in Shopify'
          : line && (line.currentQuantity ?? line.quantity) === 0 ? `the ${sku} line was already refunded or removed in Shopify` : null,
    firstName: o.customer?.firstName || o.shippingAddress?.firstName || null,
    fullName: [o.shippingAddress?.firstName, o.shippingAddress?.lastName].filter(Boolean).join(' ') || null,
    city: o.shippingAddress?.city || null,
    province: o.shippingAddress?.provinceCode || null,
    line: line ? {
      id: line.id, title: line.title, qty: line.currentQuantity ?? line.quantity,
      unit: Number(line.discountedUnitPriceSet.shopMoney.amount),
      productId: line.variant?.product?.id || null, productStatus: line.variant?.product?.status || null,
    } : null,
    otherLines: lines.filter((l) => l !== line && (l.currentQuantity ?? l.quantity) > 0).length,
  };
}

/** What Shopify would refund: the whole order (with shipping) when the line is all there is, else just the line. */
async function suggestRefund(facts, gql = defaultGql()) {
  const full = !facts.otherLines;
  const r = full
    ? await gql(`query($id: ID!) { order(id: $id) { suggestedRefund(suggestFullRefund: true, refundShipping: true) {
        amountSet { shopMoney { amount } } refundLineItems { lineItem { id } quantity }
        suggestedTransactions { gateway kind amountSet { shopMoney { amount } } parentTransaction { id } } } } }`, { id: facts.id })
    : await gql(`query($id: ID!, $li: [RefundLineItemInput!]) { order(id: $id) { suggestedRefund(refundLineItems: $li) {
        amountSet { shopMoney { amount } } refundLineItems { lineItem { id } quantity }
        suggestedTransactions { gateway kind amountSet { shopMoney { amount } } parentTransaction { id } } } } }`,
    { id: facts.id, li: [{ lineItemId: facts.line.id, quantity: facts.line.qty, restockType: 'NO_RESTOCK' }] });
  const sr = r.data?.order?.suggestedRefund;
  if (!sr) throw new Error(`suggestedRefund failed: ${JSON.stringify(r.errors || r)}`);
  return { full, amount: Number(sr.amountSet.shopMoney.amount), sr };
}

async function refundOrder(facts, note, gql = defaultGql()) {
  const { full, amount, sr } = await suggestRefund(facts, gql);
  if (!(amount > 0)) throw new Error(`Shopify suggests refunding ${amount} on ${facts.name}`);
  const transactions = sr.suggestedTransactions.filter((t) => t.parentTransaction).map((t) => ({
    orderId: facts.id, parentId: t.parentTransaction.id, amount: t.amountSet.shopMoney.amount, gateway: t.gateway, kind: 'REFUND',
  }));
  if (!transactions.length) throw new Error(`no refundable payment on ${facts.name}`);
  const refundLineItems = sr.refundLineItems.map((l) => ({ lineItemId: l.lineItem.id, quantity: l.quantity, restockType: 'NO_RESTOCK' }));
  const r = await gql(`mutation($i: RefundInput!) { refundCreate(input: $i) { refund { id totalRefundedSet { shopMoney { amount } } } userErrors { field message } } }`,
    { i: { orderId: facts.id, notify: false, note, refundLineItems, transactions, ...(full ? { shipping: { fullRefund: true } } : {}) } });
  const d = r.data?.refundCreate;
  if (!d || d.userErrors.length) throw new Error(`refundCreate: ${JSON.stringify(d ? d.userErrors : r.errors)}`);
  return { full, id: d.refund.id, amount: Number(d.refund.totalRefundedSet.shopMoney.amount) };
}

async function draftProduct(productId, gql = defaultGql()) {
  const b = await gql(`query($id: ID!) { product(id: $id) { status } }`, { id: productId });
  const before = b.data?.product?.status;
  if (!before) throw new Error(`product ${productId} not found`);
  if (before === 'DRAFT') return { before, after: 'DRAFT' };
  const r = await gql(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { status } userErrors { field message } } }`,
    { p: { id: productId, status: 'DRAFT' } });
  const d = r.data?.productUpdate;
  if (!d || d.userErrors.length) throw new Error(`productUpdate: ${JSON.stringify(d ? d.userErrors : r.errors)}`);
  return { before, after: d.product.status };
}

// ── customer emails (Mac's approved #1412 wording) ───────────────────────────

function firstName(rec) {
  return rec.customer?.firstName || String(rec.customer?.name || '').trim().split(/\s+/)[0] || 'there';
}

function itemPhrase(rec) {
  return rec.qty > 1 ? `${rec.qty} x ${rec.lineTitle || rec.itemName}` : `the ${rec.lineTitle || rec.itemName}`;
}

function offerEmail(rec) {
  const s = rec.substitute;
  const where = s.inCustomerProvince && PROVINCES[rec.customer?.province] ? ` in ${PROVINCES[rec.customer.province]}` : '';
  const refundWhat = rec.refund?.full ? `a full refund of ${money(rec.refund.amount)}` : `a refund of ${money(rec.refund.amount)} for it`;
  return {
    subject: `Your YourFloors order #${rec.orderNumber}`,
    text: `Hi ${firstName(rec)},

Thanks for your order of ${itemPhrase(rec)}. Our supplier no longer carries it, so we can't ship that exact product.

We have the ${s.displayName} in stock${where}, a comparable ${s.kind}, and we can send it at no extra cost.

Reply "${s.replyWord}" and we'll ship it right away. If you'd rather have ${refundWhat}, reply "refund" and we'll process it the same day.

Looking forward to getting you set up.

Mac
YourFloors
`,
  };
}

function refundEmail(rec, amount, full) {
  const opener = rec.status === 'offered'
    ? `As you asked, we've refunded ${full ? 'your order in full' : `the ${rec.lineTitle || rec.itemName}`} (${money(amount)}) to your original payment method.`
    : `Our supplier no longer carries the ${rec.lineTitle || rec.itemName}, so we've refunded ${full ? 'your order in full' : 'it'} (${money(amount)}) to your original payment method.`;
  return {
    subject: `Your YourFloors order #${rec.orderNumber}`,
    text: `Hi ${firstName(rec)},

${opener} It can take a few business days to show on your statement.${full ? '' : ' The rest of your order ships as normal.'}

Thanks for shopping with YourFloors, and we hope to help with your next project.

Mac
YourFloors
`,
  };
}

// ── tap links ────────────────────────────────────────────────────────────────

const ACTIONS = ['offer', 'refund', 'ship', 'halt'];

function actionToken(orderNumber, action, rec, secret = SECRET()) {
  if (!secret) return null;
  const sub = rec.substitute ? rec.substitute.productId : 0;
  return crypto.createHmac('sha256', secret).update(`${normOrder(orderNumber)}|${action}|${rec.sku}|${sub}`).digest('hex').slice(0, 32);
}
function verifyAction(orderNumber, action, token, state = loadState(), secret = SECRET()) {
  const rec = state.orders[normOrder(orderNumber)];
  if (!rec || !ACTIONS.includes(action) || !secret || !token) return null;
  const want = actionToken(orderNumber, action, rec, secret);
  if (!want || want.length !== String(token).length) return null;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(token))) ? rec : null;
}
function actionUrl(rec, action) {
  const t = actionToken(rec.orderNumber, action, rec);
  return t ? `${PUBLIC_BASE}/discontinued/act?o=${encodeURIComponent(rec.orderNumber)}&a=${action}&t=${t}` : null;
}

/** Which taps make sense now. */
function availableActions(rec) {
  if (rec.channel !== 'shopify' || !rec.refund) return rec.status === 'proposed' ? ['halt'] : [];
  if (rec.status === 'proposed') return rec.substitute ? ['offer', 'refund'] : ['refund'];
  if (rec.status === 'offered') return ['ship', 'refund'];
  return [];
}

// ── Mac's email ──────────────────────────────────────────────────────────────

function substituteLines(rec) {
  const s = rec.substitute;
  if (!s) return [`No substitute: ${rec.substituteNote || 'none found'}.`];
  const margin = rec.paidUnit != null && s.cost != null ? ` That leaves ${money(rec.paidUnit - s.cost)} a unit before the label.` : '';
  return [
    `Substitute (Opus, ${s.confidence} confidence): ${s.name}, Prosol ${s.sku} (product ${s.productId}).`,
    `Our cost ${money(s.cost)}${s.list != null ? `, list ${money(s.list)}` : ''}.${margin}`,
    `In stock: ${s.stock.map((x) => `${x.city} ${x.qty}`).join(', ')}.`,
    s.why,
  ];
}

function linkLine(rec, action) {
  const url = actionUrl(rec, action);
  const what = {
    offer: `Offer the swap. Emails ${rec.customer?.firstName || 'the customer'} the swap-or-refund choice, takes the listing off yourfloors.ca and marks ${rec.sku} discontinued:`,
    refund: `Refund instead (${money(rec.refund?.amount || 0)}${rec.refund && !rec.refund.full ? ', just this line' : ''}). Refunds in Shopify, leaves the order open, emails the customer${rec.status === 'proposed' ? `, takes the listing off and marks ${rec.sku} discontinued` : ''}:`,
    ship: `They said yes: ship the swap. The next staging pass ships the ${rec.substitute?.name} from Prosol. No email:`,
    halt: `Mark ${rec.sku} discontinued, so staging stops it with the reason instead of failing the lookup:`,
  }[action];
  return `${what}\n${url || '(no link: SKU_RESOLVER_SECRET is not set on the server)'}`;
}

function macEmail(rec, { reminder = false, now = new Date() } = {}) {
  const lines = [];
  const who = [rec.customer?.name, [rec.customer?.city, rec.customer?.province].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const ordered = rec.orderDate ? `, ordered ${shortDate(rec.orderDate)}` : '';
  if (rec.status === 'lookup-broken') {
    lines.push(`Order ${rec.orderNumber} keeps failing staging on "No Prosol inventory result" for SKU ${rec.sku}, but Prosol still lists the product: ${rec.found.name} (product ${rec.found.id}, SKU ${rec.found.sku}).`);
    lines.push('');
    lines.push('So the lookup is what is broken, not the product. Check the sku-map codes for it.');
    return { subject: `${reminder ? 'STILL NOT SHIPPED' : 'Not shipped'}: order ${rec.orderNumber}, Prosol lookup failing for ${rec.sku}`, text: lines.join('\n') };
  }
  if (rec.status === 'offered') {
    lines.push(reminder
      ? `No answer yet from ${firstName(rec)} to the swap offer on order ${rec.orderNumber} (sent ${shortDate(rec.offeredAt)}). If it stays quiet, refunding is the clean finish.`
      : `Swap offered on order ${rec.orderNumber} (${shortDate(rec.offeredAt)}). Their reply comes into hello@; tap below when it does.`);
  } else {
    lines.push(`${reminder ? 'Still not shipped: order' : 'Order'} ${rec.orderNumber} can't ship. Prosol no longer carries SKU ${rec.sku} (${rec.itemName}).`);
    lines.push('');
    lines.push(`Checked: ${rec.gone.evidence.join('; ')}.`);
  }
  lines.push('');
  lines.push(`${rec.channel === 'shopify' ? 'Shopify' : 'Amazon'} order${ordered}. Customer: ${who || 'unknown'}.${rec.paidUnit != null ? ` Paid ${money(rec.paidUnit)} a unit, quantity ${rec.qty}.` : ''}`);
  lines.push('');
  lines.push(...substituteLines(rec));
  if (rec.channel !== 'shopify') {
    lines.push('');
    lines.push('Amazon order, so no substitute can be offered. Cancel it in Seller Central with reason "No inventory".');
  } else if (!rec.refund) {
    lines.push('');
    lines.push(`SKU ${rec.sku} is not a line on the Shopify order, so there are no swap or refund taps. Handle it in Shopify.`);
  }
  for (const a of availableActions(rec)) {
    lines.push('');
    lines.push(linkLine(rec, a));
  }
  if (rec.status === 'proposed' && rec.channel === 'shopify' && rec.substitute) {
    lines.push('');
    lines.push('The customer email you would be sending is on the confirm page before anything goes out.');
  }
  const subject = rec.status === 'offered'
    ? `Waiting on the customer: order ${rec.orderNumber}, swap offered`
    : `${reminder ? 'STILL NOT SHIPPED' : 'Not shipped'}: order ${rec.orderNumber}, Prosol no longer carries ${rec.sku}`;
  return { subject, text: lines.join('\n') };
}

// ── the stage hook ───────────────────────────────────────────────────────────

async function openProsol() {
  const { ProsolClientV2 } = require('../scripts/shipstation/prosol-client-v2');
  const c = new ProsolClientV2();
  await c.init();
  return c;
}

const readEntry = (sku) => require('./sku-map-file').readSkuMap().mappings[sku];

let running = false;

/**
 * After a (non-dry) staging pass: confirm and propose for new prosolGone rows, and re-email anything still waiting
 * after REMIND_HOURS. Fire-and-forget from phaseStage; never throws.
 */
async function handleStageResult(result, {
  now = new Date(), send, prosol = openProsol, ai = proposeSubstitute, facts = shopifyFacts, refundQuote = suggestRefund,
  details = productDetails, entryFor = readEntry, auditLog, sleep = sleepMs, file = STATE_FILE,
} = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const sendEmail = send || require('./emailer').sendEmail;
  const out = { proposed: 0, reminded: 0, closed: 0, blips: 0, errors: [] };
  let client = null;
  let prosolFailed = null;
  const getClient = async () => {
    if (client) return client;
    if (prosolFailed) throw prosolFailed;
    try { client = await prosol(); return client; } catch (e) { prosolFailed = e; throw e; }
  };
  const mail = async (rec, m) => {
    await sendEmail({ to: ALERT_TO(), subject: m.subject, text: m.text, priority: 'high' });
    rec.lastEmailAt = now.toISOString();
  };
  try {
    const state = loadState(file);
    const waiting = new Set((result.manualReview || []).map((r) => normOrder(r.orderNumber)));
    const goneBySku = new Map(); // one Prosol check and one Opus search per SKU per pass
    let aiBudget = MAX_AI_PER_PASS;

    for (const row of (result.manualReview || []).filter((r) => r.prosolGone)) {
      const g = row.prosolGone;
      const n = normOrder(row.orderNumber);
      let rec = state.orders[n];
      if (rec && rec.sku === g.sku && !['checking', 'blip', 'lookup-broken'].includes(rec.status)) continue;
      if (!rec || rec.sku !== g.sku) {
        rec = {
          orderNumber: n, sku: g.sku, itemName: g.itemName, qty: g.qty || 1, apiSku: g.apiSku, prosolSku: g.prosolSku,
          channel: g.channel === 'shopify' ? 'shopify' : 'amazon', orderDate: g.orderDate || null,
          paidUnit: g.unitPrice != null ? Number(g.unitPrice) : null,
          customer: { name: g.shipTo?.name || null, city: g.shipTo?.city || null, province: g.shipTo?.state || null },
          status: 'checking', firstSeenAt: now.toISOString(), attempts: 0, actions: [],
        };
        state.orders[n] = rec;
      }
      rec.attempts = (rec.attempts || 0) + 1;
      try {
        const entry = entryFor(g.sku);
        let gone = goneBySku.get(g.sku);
        if (!gone) {
          gone = await confirmGone(await getClient(), { apiSku: g.apiSku, prosolSku: g.prosolSku, productId: productIdFromEntry(entry) }, { sleep });
          goneBySku.set(g.sku, gone);
        }
        if (!gone.gone) {
          rec.found = gone.found;
          if (rec.status !== 'lookup-broken') {
            rec.status = 'blip';
            rec.firstBlipAt = rec.firstBlipAt || now.toISOString();
            out.blips++;
            if (hoursSince(rec.firstBlipAt, now) >= BLIP_HOURS) {
              rec.status = 'lookup-broken';
              await mail(rec, macEmail(rec, { now }));
            }
          }
          continue;
        }
        rec.gone = { checkedAt: now.toISOString(), evidence: gone.evidence };
        if (rec.channel === 'shopify') {
          const f = await facts(n, g.sku);
          if (f.closedReason) { rec.status = 'closed'; rec.closedReason = f.closedReason; out.closed++; continue; }
          Object.assign(rec, {
            shopify: { id: f.id, productId: f.line?.productId || null, lineId: f.line?.id || null },
            lineTitle: f.line?.title || rec.itemName,
            paidUnit: f.line ? f.line.unit : rec.paidUnit,
            qty: f.line ? f.line.qty : rec.qty,
            customer: { email: f.email, firstName: f.firstName, name: f.fullName || rec.customer.name, city: f.city, province: f.province },
            orderDate: f.createdAt || rec.orderDate,
          });
          if (f.line) {
            const q = await refundQuote(f);
            rec.refund = { full: q.full, amount: q.amount };
          }
        }
        if (!goneBySku.get(g.sku).substitute) {
          if (aiBudget <= 0) continue; // still 'checking': the next pass searches for it
          aiBudget--;
          let pick = null;
          try { pick = await ai(rec, { client: await getClient(), entry, sleep }); } catch (e) { goneBySku.get(g.sku).aiError = e.message.slice(0, 200); }
          goneBySku.get(g.sku).substitute = { pick };
        }
        const pick = goneBySku.get(g.sku).substitute?.pick || null;
        rec.substitute = null;
        if (!pick) rec.substituteNote = goneBySku.get(g.sku).aiError || (process.env.ANTHROPIC_API_KEY ? 'Opus gave no answer' : 'ANTHROPIC_API_KEY not set');
        else if (pick.decision !== 'substitute') rec.substituteNote = `Opus found none: ${pick.why}`;
        else {
          const d = await details(await getClient(), pick.product_id, { sleep });
          const problem = substituteProblem(d, { qty: rec.qty, paidUnit: rec.paidUnit });
          if (problem) rec.substituteNote = `Opus suggested one, but ${problem}`;
          else {
            rec.substitute = {
              ...d, displayName: pick.display_name || d.name, kind: pick.kind || 'replacement', replyWord: pick.reply_word || 'yes',
              confidence: pick.confidence, why: pick.why,
              inCustomerProvince: d.stock.some((s) => s.province === rec.customer?.province),
            };
          }
        }
        rec.status = 'proposed';
        await mail(rec, macEmail(rec, { now }));
        out.proposed++;
      } catch (e) {
        out.errors.push(`${n} ${g.sku}: ${e.message}`);
        if (rec.status === 'checking' && rec.attempts >= 3 && !rec.lastEmailAt) {
          try {
            await mail(rec, { subject: `Not shipped: order ${n}, Prosol has no result for ${g.sku}`, text: `Order ${n} fails staging with "No Prosol inventory result" for SKU ${g.sku} (${g.itemName || ''}), and the discontinued check could not reach Prosol on ${rec.attempts} passes: ${e.message}` });
          } catch (e2) { out.errors.push(`alert ${n}: ${e2.message}`); }
        }
      }
    }

    // Reminders for anything still open.
    for (const rec of Object.values(state.orders)) {
      const every = rec.status === 'offered' ? OFFER_REMIND_HOURS : REMIND_HOURS;
      if (!OPEN.has(rec.status) || hoursSince(rec.lastEmailAt, now) < every) continue;
      try {
        if (rec.channel === 'shopify' && rec.status !== 'lookup-broken') {
          const f = await facts(rec.orderNumber, rec.sku);
          if (f.closedReason) { rec.status = 'closed'; rec.closedReason = f.closedReason; out.closed++; continue; }
        } else if (!waiting.has(rec.orderNumber)) {
          rec.status = 'closed'; rec.closedReason = 'no longer waiting in staging'; out.closed++; continue;
        }
        await mail(rec, macEmail(rec, { reminder: true, now }));
        out.reminded++;
      } catch (e) { out.errors.push(`reminder ${rec.orderNumber}: ${e.message}`); }
    }
    saveState(state, file);
  } catch (e) {
    out.errors.push(e.message);
  } finally {
    running = false;
    if (client) await client.close().catch(() => {});
  }
  try { (auditLog || require('./audit').log)({ action: 'discontinued-desk', ...out }); } catch { /* best-effort */ }
  return out;
}

// ── taps ─────────────────────────────────────────────────────────────────────

/** HALT the order's SKU in sku-map (staging then stops it with the reason). No-op if already HALT. */
function haltEntry(entry, rec, now) {
  const day = now.toISOString().slice(0, 10);
  const was = `${entry.api_sku}/${entry.prosol_sku}`;
  return {
    ...entry,
    api_sku: `HALT_DISCONTINUED_${entry.api_sku}`,
    prosol_sku: `HALT_DISCONTINUED_${entry.prosol_sku || entry.api_sku}`,
    note: `DISCONTINUED. Prosol no longer lists it (checked ${day}, order ${rec.orderNumber}). Was ${was}. ${entry.note || ''}`.trim().slice(0, 700),
    source: 'DISCONTINUED',
    discontinued: day,
  };
}

function substituteEntry(rec, now) {
  const s = rec.substitute;
  return {
    api_sku: s.sku,
    prosol_sku: s.prosolSku || s.sku,
    prosol_product_id: s.productId,
    product: s.name,
    cost_cad: s.cost,
    ...(s.list != null ? { retail_cad: s.list } : {}),
    cost_source: 'prosol-offers-loc10010',
    note: `Added ${now.toISOString().slice(0, 10)} by the discontinued desk: substitute for ${rec.sku} on order ${rec.orderNumber}.`,
    verified: true,
    discovered_by: 'discontinued-desk',
  };
}

/** What a tap will do, for the confirm page. */
function describeAction(rec, action) {
  const steps = {
    offer: [`Email ${rec.customer?.email || 'the customer'} the offer below`, 'Set the Shopify product to DRAFT', `Mark ${rec.sku} discontinued in the sku-map`],
    refund: [`Refund ${money(rec.refund?.amount || 0)} in Shopify${rec.refund && !rec.refund.full ? ' (this line only; the rest ships)' : ''}, order left open`, `Email ${rec.customer?.email || 'the customer'} the note below`,
      ...(rec.status === 'proposed' ? ['Set the Shopify product to DRAFT', `Mark ${rec.sku} discontinued in the sku-map`] : [])],
    ship: [`Ship the ${rec.substitute?.name} in place of ${rec.sku} on the next staging pass`, 'No customer email'],
    halt: [`Mark ${rec.sku} discontinued in the sku-map`],
  }[action];
  let email = null;
  if (action === 'offer' && rec.substitute) email = offerEmail(rec);
  if (action === 'refund' && rec.refund) email = refundEmail(rec, rec.refund.amount, rec.refund.full);
  const blocked = availableActions(rec).includes(action) ? null : `Order ${rec.orderNumber} is "${rec.status}"; this tap no longer applies.`;
  return { steps, email, blocked };
}

/**
 * Do a tap. Re-checks the order first (a refund or fulfilment elsewhere stops it), then does the writes with the
 * customer email last, so a failure never leaves a customer told something that didn't happen.
 */
async function act(orderNumber, action, token, {
  now = new Date(), gql, send, setMapping, facts = shopifyFacts, file = STATE_FILE,
  readMap = () => require('./sku-map-file').readSkuMap().mappings,
} = {}) {
  gql = gql || defaultGql();
  const state = loadState(file);
  const rec = verifyAction(orderNumber, action, token, state);
  if (!rec) return { ok: false, status: 403, message: 'This link is not valid or has expired.' };
  const d = describeAction(rec, action);
  if (d.blocked) return { ok: false, status: 409, message: d.blocked };
  const sendEmail = send || require('./emailer').sendEmail;
  const set = setMapping || require('../scripts/shipstation/run-orders').liveSetMapping;
  const done = [];
  const markDiscontinued = async () => {
    const entry = readMap()[rec.sku];
    if (entry && typeof entry === 'object' && !String(entry.api_sku || '').startsWith('HALT_')) {
      set(rec.sku, haltEntry(entry, rec, now));
      done.push(`${rec.sku} marked discontinued in the sku-map`);
    }
    if (rec.channel === 'shopify' && rec.shopify?.productId) {
      const r = await draftProduct(rec.shopify.productId, gql);
      rec.listing = { ...r, at: now.toISOString() };
      done.push(r.before === 'DRAFT' ? 'listing was already DRAFT' : `listing set to DRAFT (was ${r.before})`);
    }
  };

  let f = null;
  if (rec.channel === 'shopify' && action !== 'halt') {
    f = await facts(rec.orderNumber, rec.sku);
    if (f.closedReason) {
      rec.status = 'closed'; rec.closedReason = f.closedReason; saveState(state, file);
      return { ok: false, status: 409, message: `Nothing done: order ${rec.orderNumber} was ${f.closedReason}.` };
    }
    rec.customer = { ...rec.customer, email: f.email, firstName: f.firstName || rec.customer?.firstName };
  }

  if (action === 'halt') {
    await markDiscontinued();
    rec.status = 'halted';
  } else if (action === 'offer') {
    await markDiscontinued();
    if (!readMap()[rec.substitute.sku]) { set(rec.substitute.sku, substituteEntry(rec, now)); done.push(`${rec.substitute.sku} added to the sku-map`); }
    const m = offerEmail(rec);
    const r = await sendEmail({ to: rec.customer.email, subject: m.subject, text: m.text, replyTo: 'hello@yourfloors.ca' });
    done.push(`offer emailed to ${rec.customer.email}`);
    rec.status = 'offered';
    rec.offeredAt = now.toISOString();
    rec.offerMessageId = r && r.messageId;
    try { // Mac's copy of the next taps, so they are in his inbox when the customer answers
      const mm = macEmail(rec, { now });
      await sendEmail({ to: ALERT_TO(), subject: mm.subject, text: mm.text });
      rec.lastEmailAt = now.toISOString();
    } catch (e) { done.push(`(your copy of the ship/refund links did not send: ${e.message})`); }
  } else if (action === 'refund') {
    const r = await refundOrder(f, `Prosol no longer carries ${rec.sku} (discontinued desk)`, gql);
    done.push(`refunded ${money(r.amount)} in Shopify (order left open)`);
    const m = refundEmail(rec, r.amount, r.full); // wording depends on whether a swap was offered first
    const wasProposed = rec.status === 'proposed';
    rec.refunded = { ...r, at: now.toISOString() };
    rec.lineRefund = !r.full;
    rec.status = 'refunded';
    saveState(state, file); // the money moved: record it before anything else can fail
    if (wasProposed) {
      try { await markDiscontinued(); } catch (e) { done.push(`NOT marked discontinued: ${e.message}`); }
    }
    try {
      await sendEmail({ to: rec.customer.email, subject: m.subject, text: m.text, replyTo: 'hello@yourfloors.ca' });
      done.push(`refund note emailed to ${rec.customer.email}`);
    } catch (e) { done.push(`REFUND NOTE NOT SENT: ${e.message}`); }
  } else if (action === 'ship') {
    if (!readMap()[rec.substitute.sku]) set(rec.substitute.sku, substituteEntry(rec, now));
    rec.status = 'swap-approved';
    done.push(`order ${rec.orderNumber} ships the ${rec.substitute.name} on the next staging pass`);
  }
  if (!done.length) done.push('nothing needed changing');
  rec.actions = [...(rec.actions || []), { action, at: now.toISOString(), done }];
  saveState(state, file);
  try { require('./audit').log({ action: `discontinued-${action}`, orderNumber: rec.orderNumber, sku: rec.sku, done }); } catch { /* best-effort */ }
  return { ok: true, message: done.join('. ') + '.', done };
}

module.exports = {
  applySwaps, confirmGone, productDetails, substituteProblem, productIdFromEntry, codeForms, proposeSubstitute,
  shopifyFacts, suggestRefund, refundOrder, draftProduct, offerEmail, refundEmail, macEmail, availableActions,
  actionToken, verifyAction, actionUrl, describeAction, haltEntry, substituteEntry, handleStageResult, act,
  loadState, saveState, normOrder, STATE_FILE, MODEL,
};
