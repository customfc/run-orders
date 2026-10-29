'use strict';
/**
 * Unmapped-SKU resolver.
 *
 * Why this exists: an order line whose SKU has no sku-map entry is rejected by
 * staging on every pass, and the only signal was one Telegram line. YourFloors
 * #1388 (one CBP notch trowel, SKU 9975) sat 14 days that way until the customer
 * chased it, though the answer was two lookups away: Shopify SKU 9975 is SF item
 * 9975, and Shopify showed 10 at Sechelt.
 *
 * Two tiers:
 *   1. EXACT (auto-applies). Shopify variant SKU == the order SKU (exactly one),
 *      SF PBSI item Name == the order SKU (exactly one), the order title shares a
 *      product word with the Shopify title, and Shopify shows Sechelt stock >= the
 *      quantity ordered. Then the SKU is mapped to Sechelt and ships on the same
 *      staging pass. No judgment involved, so no approval needed.
 *   1c. SELLER SKU (auto-applies). Amazon lines carry only the ASIN, but our
 *      listing's SellerSKU (from SP-API order items) is usually the Prosol code.
 *      When it is an exact, unambiguous Prosol storefront SKU with a vendor code
 *      and a cost, and the order title passes the mapping guard against Prosol's
 *      product name, map it. 702-3620151-6391423 (B07XQJNY76, seller SKU
 *      KDIF4GRKEBTD8) waited on Mac to look that up by hand, 2026-10-29.
 *   2. AI PROPOSAL. Everything else goes to Claude Opus with read-only lookups
 *      (Shopify, Salesforce, the sku-map) plus the Prosol candidates staging
 *      already found. It proposes a mapping with evidence and we email it with a
 *      one-tap approve link. A wrong mapping ships the wrong product to a
 *      customer, so a human says yes, with one exception:
 *   2b. TWIN (auto-applies). A high-confidence Prosol proposal whose api_sku AND
 *      prosol_sku both equal an existing verified sku-map entry, and whose order
 *      title passes the mapping guard (size + product words) against that entry,
 *      is the same item under a new key. #1435 (Shopify SKU PRMPSQT1) sat two
 *      days on an approve link though key 08526 already mapped PRMPSQT1. The
 *      staging mapping guard still checks the SF description before any buy.
 *
 * Every unresolved SKU emails (not Telegram: Mac triages email) and re-emails
 * once a day while the order is still waiting.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECHELT_WAREHOUSE_ID = 147654;
const SECHELT_LOCATION_NAME = 'Sechelt Warehouse';
const STATE_FILE = process.env.SKU_RESOLVER_STATE_FILE || path.join(__dirname, '..', 'data', 'sku-resolver-state.json');
const SKU_MAP_FILE = path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json');
const MODEL = 'claude-opus-5-5';
const MAX_AI_PER_PASS = Number(process.env.SKU_RESOLVER_AI_MAX_PER_PASS || 3);
const MAX_AI_TURNS = 12;
const REMIND_HOURS = Number(process.env.SKU_RESOLVER_REMIND_HOURS || 24);
const ASIN_RE = /^B0[0-9A-Z]{8}$/;
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const ALERT_TO = () => process.env.SKU_RESOLVER_EMAIL || process.env.MAC_CC_EMAIL || 'mac@customfc.ca';

// ── state ────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { skus: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── exact tier (pure decision + lookups) ─────────────────────────────────────

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'of', 'in', 'x', 'pack', 'each', 'inch', 'medium', 'large', 'small']);
function productWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}
function sharesProductWord(a, b) {
  const wb = new Set(productWords(b));
  return productWords(a).some((w) => wb.has(w));
}

/**
 * Decide whether an unmapped SKU can be mapped to Sechelt with no human.
 * variants: [{ sku, productTitle, variantTitle, inventory: { [locationName]: available } }]
 * sfItems:  [{ Name, PBSI__description__c, PBSI__Cost__c, PBSI__Vendor_Item_ID__c, vendorName }]
 * Returns { entry, summary } or { reason }.
 */
function decideExact({ sku, itemName, qty, variants, sfItems, now = new Date() }) {
  if (!sku || sku === 'UNKNOWN') return { reason: 'no SKU on the line' };
  if (ASIN_RE.test(sku)) return { reason: 'Amazon ASIN, needs a product match, not an identity match' };
  const v = (variants || []).filter((x) => x.sku === sku);
  if (v.length !== 1) return { reason: `Shopify has ${v.length} variants with SKU ${sku}` };
  const sf = (sfItems || []).filter((x) => x.Name === sku);
  if (sf.length !== 1) return { reason: `Salesforce has ${sf.length} items named ${sku}` };
  const variant = v[0];
  const item = sf[0];
  const title = variant.variantTitle && variant.variantTitle !== 'Default Title'
    ? `${variant.productTitle} - ${variant.variantTitle}` : variant.productTitle;
  if (itemName && !sharesProductWord(itemName, title)) {
    return { reason: `order title "${itemName}" shares no product word with Shopify "${title}"` };
  }
  const atSechelt = Number(variant.inventory?.[SECHELT_LOCATION_NAME] ?? 0);
  if (!(atSechelt >= (Number(qty) || 1))) return { reason: `Shopify shows ${atSechelt} at Sechelt, order needs ${qty}` };
  const day = now.toISOString().slice(0, 10);
  const entry = {
    api_sku: 'NON_PROSOL',
    prosol_sku: 'NON_PROSOL',
    product: title,
    note: `Auto-mapped ${day} by sku-resolver: Shopify SKU ${sku} = SF item ${item.Name}${item.vendorName ? ` (vendor ${item.vendorName}${item.PBSI__Vendor_Item_ID__c ? ` ${item.PBSI__Vendor_Item_ID__c}` : ''})` : ''}; Shopify showed ${atSechelt} at Sechelt.`,
    source: 'SECHELT_OR_FBA',
    route_to: 'CFC_SECHELT',
    shipstation_warehouse_id: SECHELT_WAREHOUSE_ID,
    verified: true,
    auto_discovered: true,
    discovered_by: 'sku-resolver-exact',
    ...(item.PBSI__Cost__c != null ? { cost_cad: item.PBSI__Cost__c } : {}),
    sf_item: item.Name,
  };
  return { entry, summary: `${title}: Shopify SKU = SF item ${item.Name}, ${atSechelt} at Sechelt` };
}

function soqlString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function shopifyVariants(queryText, first = 10) {
  const { graphql } = require('./shopify-graphql');
  const q = `query($q:String!,$n:Int!){ productVariants(first:$n, query:$q){ nodes{ sku title price
    product{ title status vendor productType }
    inventoryItem{ inventoryLevels(first:10){ nodes{ location{ name } quantities(names:["available"]){ quantity } } } } } } }`;
  const r = await graphql(q, { q: queryText, n: first });
  return (r.data?.productVariants?.nodes || []).map((n) => ({
    sku: n.sku,
    productTitle: n.product?.title,
    variantTitle: n.title,
    status: n.product?.status,
    vendor: n.product?.vendor,
    price: n.price,
    inventory: Object.fromEntries((n.inventoryItem?.inventoryLevels?.nodes || [])
      .map((l) => [l.location?.name, l.quantities?.[0]?.quantity ?? 0])),
  }));
}

const SF_ITEM_FIELDS = 'Id, Name, PBSI__description__c, PBSI__Vendor_Item_ID__c, PBSI__Quantity_on_Hand__c, PBSI__Available_to_Promise__c, PBSI__Cost__c, PBSI__salesprice__c, PBSI__Default_Vendor__r.Name';
function flattenSfItem(x) {
  return {
    Name: x.Name,
    PBSI__description__c: x.PBSI__description__c,
    PBSI__Vendor_Item_ID__c: x.PBSI__Vendor_Item_ID__c,
    onHand: x.PBSI__Quantity_on_Hand__c,
    atp: x.PBSI__Available_to_Promise__c,
    PBSI__Cost__c: x.PBSI__Cost__c,
    salesPrice: x.PBSI__salesprice__c,
    vendorName: x.PBSI__Default_Vendor__r?.Name || null,
  };
}

async function sfItemsByName(sku) {
  const sf = require('./salesforce');
  const conn = await sf.connect();
  const rows = await sf.query(conn, `SELECT ${SF_ITEM_FIELDS} FROM PBSI__PBSI_Item__c WHERE Name = '${soqlString(sku)}' LIMIT 5`);
  return rows.map(flattenSfItem);
}

async function tryExact({ sku, itemName, qty }) {
  if (!sku || sku === 'UNKNOWN' || ASIN_RE.test(sku)) return decideExact({ sku, itemName, qty });
  const [variants, sfItems] = await Promise.all([shopifyVariants(`sku:${sku}`, 5), sfItemsByName(sku)]);
  return decideExact({ sku, itemName, qty, variants, sfItems });
}

// ── AI tier ──────────────────────────────────────────────────────────────────

function readSkuMap() {
  try { return JSON.parse(fs.readFileSync(SKU_MAP_FILE, 'utf8')).mappings || {}; } catch { return {}; }
}

const TOOLS = [
  {
    name: 'shopify_search',
    description: 'Search the YourFloors Shopify catalog. `query` uses Shopify search syntax: "sku:9975" for an exact SKU, or plain words to match titles. Returns variants with SKU, titles, vendor, price and available stock per location (Sechelt Warehouse is our own warehouse).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'salesforce_item_search',
    description: 'Search Salesforce inventory items (PBSI). Matches item Name or vendor item ID exactly, or the description containing the text. Returns Name, description, vendor, vendor item ID (the Prosol code when the vendor is Prosol), on hand, cost and sale price.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'skumap_search',
    description: 'Search existing sku-map entries by key or product text. Use it to see how similar products are already mapped (routing and code format).',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'prosol_lookup',
    description: 'Look up ONE exact Prosol storefront SKU (no keyword search). Returns the product id, storefront SKU, Prosol vendor code (prosol_sku), name and our cost, or null if Prosol has no product with exactly that SKU. Use it to confirm a code you found elsewhere (seller SKU, Salesforce vendor item ID).',
    input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
  },
  {
    name: 'submit_proposal',
    description: 'Submit your final answer. Call exactly once, at the end.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['map', 'cannot_resolve'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        route: { type: 'string', enum: ['sechelt', 'prosol', 'none'] },
        api_sku: { type: 'string', description: 'Prosol storefront SKU for route=prosol; "NON_PROSOL" for route=sechelt; "" when cannot_resolve' },
        prosol_sku: { type: 'string', description: 'Prosol vendor code for route=prosol (may differ from api_sku); "NON_PROSOL" for route=sechelt; "" when cannot_resolve' },
        product: { type: 'string', description: 'Exact product name including size/colour/variant' },
        sf_item: { type: 'string', description: 'Salesforce item Name if found, else ""' },
        explanation: { type: 'string', description: 'Two or three plain sentences for the owner: what the product is and why this mapping is right, or what is missing' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Each lookup result that supports the answer, quoted briefly' },
      },
      required: ['decision', 'confidence', 'route', 'api_sku', 'prosol_sku', 'product', 'sf_item', 'explanation', 'evidence'],
      additionalProperties: false,
    },
  },
];

const SYSTEM = `You resolve unmapped product SKUs for YourFloors / Custom Flooring Centres (CFC), a Canadian flooring and tile-supplies retailer selling on yourfloors.ca (Shopify) and Amazon.ca.

An order is stuck because its line SKU has no entry in our sku-map, the table that tells the shipping pipeline where an item ships from. Find out exactly what the product is and propose the mapping.

Two ways an item ships:
- route "sechelt": from our own warehouse in Sechelt, BC. Right when Shopify shows stock at "Sechelt Warehouse" for the same product. Mapping: api_sku "NON_PROSOL", prosol_sku "NON_PROSOL".
- route "prosol": drop-shipped by our distributor Prosol. Right when the product is a Prosol item and we do not stock it ourselves. Mapping: api_sku = the Prosol storefront SKU, prosol_sku = the Prosol vendor code (they often differ; never copy one into the other without evidence). In Salesforce, items whose vendor is Prosol carry the Prosol code in the vendor item ID.

Shopify SKUs are often our Salesforce item Name. Amazon order SKUs are ASINs; for those, match on the listing title, and when our listing's seller SKU is given, check it with prosol_lookup. Confirm any Prosol code with prosol_lookup before proposing it.

Rules:
- Propose "map" only when the evidence pins down the exact product, including size, colour, pack count and variant. A sibling size or colour is a different product.
- If you cannot pin it down, submit "cannot_resolve" and say in the explanation what is missing or ambiguous. That is a good answer; a wrong mapping ships the wrong product to a customer.
- Your tools only read. Be efficient: a few targeted lookups, then submit_proposal.`;

async function runTool(name, input, ctx) {
  try {
    if (name === 'shopify_search') {
      return JSON.stringify(await shopifyVariants(String(input.query || ''), 10));
    }
    if (name === 'salesforce_item_search') {
      const sf = require('./salesforce');
      const conn = await sf.connect();
      const t = soqlString(String(input.text || '').trim().slice(0, 80));
      if (!t) return '[]';
      const rows = await sf.query(conn, `SELECT ${SF_ITEM_FIELDS} FROM PBSI__PBSI_Item__c WHERE Name = '${t}' OR PBSI__Vendor_Item_ID__c = '${t}' OR PBSI__description__c LIKE '%${t}%' LIMIT 15`);
      return JSON.stringify(rows.map(flattenSfItem));
    }
    if (name === 'prosol_lookup') {
      if (!ctx.prosolLookup) return JSON.stringify({ error: 'Prosol lookup not available on this pass' });
      const code = String(input.sku || '').trim().slice(0, 40);
      return code ? JSON.stringify(await ctx.prosolLookup(code)) : 'null';
    }
    if (name === 'skumap_search') {
      const t = String(input.text || '').toLowerCase().trim();
      if (!t) return '[]';
      const map = ctx.skuMap || (ctx.skuMap = readSkuMap());
      const hits = Object.entries(map)
        .filter(([k, v]) => k.toLowerCase().includes(t) || JSON.stringify(v || '').toLowerCase().includes(t))
        .slice(0, 15)
        .map(([k, v]) => (typeof v === 'string' ? { key: k, api_sku: v } : {
          key: k, api_sku: v.api_sku, prosol_sku: v.prosol_sku, product: v.product, route_to: v.route_to, shipstation_warehouse_id: v.shipstation_warehouse_id,
        }));
      return JSON.stringify(hits);
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function lineContext({ sku, itemName, qty, orders, prosolCandidates, sellerSku, sellerSkuReason }) {
  return [
    `Unmapped SKU: ${sku}`,
    ...(sellerSku ? [`Our Amazon listing's seller SKU for this ASIN: ${sellerSku} (automatic match failed: ${sellerSkuReason || 'unknown'})`] : []),
    `Order line title: ${itemName || '(none)'}`,
    `Quantity waiting: ${qty}`,
    `Orders waiting on it: ${orders.join(', ')}`,
    prosolCandidates ? `Prosol catalog search already run by staging:\n${prosolCandidates}` : 'Prosol catalog search: not available for this line.',
  ].join('\n');
}

/** Ask Opus for a mapping proposal. Returns the submit_proposal input, or null. */
async function proposeWithAi(line, { client, prosolLookup } = {}) {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  const ctx = { prosolLookup };
  const messages = [{ role: 'user', content: lineContext(line) }];
  let nudged = false;
  for (let turn = 0; turn < MAX_AI_TURNS; turn++) {
    const res = await client.beta.messages.create({
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
    const submit = uses.find((b) => b.name === 'submit_proposal');
    if (submit) return submit.input;
    if (!uses.length) {
      if (nudged) return null;
      nudged = true;
      messages.push({ role: 'user', content: 'Call submit_proposal with your answer now.' });
      continue;
    }
    const results = await Promise.all(uses.map(async (u) => ({
      type: 'tool_result', tool_use_id: u.id, content: await runTool(u.name, u.input, ctx),
    })));
    messages.push({ role: 'user', content: results });
  }
  return null;
}

/** Turn an AI proposal into a sku-map entry, or null if it isn't a usable map. */
function entryFromProposal(p, { now = new Date() } = {}) {
  if (!p || p.decision !== 'map') return null;
  const day = now.toISOString().slice(0, 10);
  const note = `Proposed ${day} by sku-resolver (Opus, ${p.confidence} confidence), approved by Mac: ${p.explanation}`.slice(0, 600);
  if (p.route === 'sechelt') {
    return {
      api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL', product: p.product, note,
      source: 'SECHELT_OR_FBA', route_to: 'CFC_SECHELT', shipstation_warehouse_id: SECHELT_WAREHOUSE_ID,
      verified: true, discovered_by: 'sku-resolver-ai', ...(p.sf_item ? { sf_item: p.sf_item } : {}),
    };
  }
  if (p.route === 'prosol' && p.api_sku && p.prosol_sku && p.api_sku !== 'NON_PROSOL') {
    return { api_sku: p.api_sku, prosol_sku: p.prosol_sku, product: p.product, note, verified: true, discovered_by: 'sku-resolver-ai' };
  }
  return null;
}

async function openProsol() {
  const { ProsolClientV2 } = require('../scripts/shipstation/prosol-client-v2');
  const c = new ProsolClientV2();
  await c.init();
  return c;
}

const AMAZON_ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;

/** Our SellerSKU for an ASIN line, from SP-API order items. null if none found. */
async function sellerSkuFor({ sku, orders }, sp = require('./sp-api')) {
  if (!ASIN_RE.test(sku || '')) return null;
  for (const o of (orders || []).filter((n) => AMAZON_ORDER_RE.test(n))) {
    const r = await sp.getOrderItems(o);
    const items = (r && (r.payload || r).OrderItems) || [];
    const hit = items.find((i) => i.ASIN === sku && i.SellerSKU && !ASIN_RE.test(i.SellerSKU));
    if (hit) return hit.SellerSKU;
  }
  return null;
}

/**
 * Tier 1c: map an ASIN line by its SellerSKU when Prosol knows that exact code.
 * info: ProsolClientV2.getMappingInfo(sellerSku). Returns { entry, summary } or { reason }.
 */
function decideSellerSku({ sku, itemName, sellerSku, info, now = new Date() }) {
  if (!sellerSku) return { reason: 'no seller SKU on the Amazon listing' };
  if (!info) return { reason: `Prosol has no product with SKU ${sellerSku}` };
  if (info.ambiguous) return { reason: `Prosol has ${info.count} products with SKU ${sellerSku}` };
  if (info.sku !== sellerSku) return { reason: `Prosol answered ${info.sku} for ${sellerSku}` };
  if (!info.prosol_sku) return { reason: `Prosol gave no vendor code for ${sellerSku}` };
  if (info.cost_cad == null) return { reason: `Prosol gave no cost for ${sellerSku}` };
  const g = require('./mapping-guard').validateMapping(itemName, info.name);
  if (!g.ok || !g.verified) return { reason: `order title vs Prosol "${info.name}": ${g.reason}` };
  const day = now.toISOString().slice(0, 10);
  const entry = {
    cost_cad: info.cost_cad,
    ...(info.retail_cad != null ? { retail_cad: info.retail_cad } : {}),
    cost_source: 'prosol-offers-loc10010',
    api_sku: info.sku,
    prosol_sku: info.prosol_sku,
    product: info.name,
    note: `Auto-mapped ${day} by sku-resolver: ASIN ${sku} is our listing with seller SKU ${sellerSku}, an exact Prosol storefront SKU (product ${info.productId}); order title "${itemName}" passed the mapping guard against "${info.name}".`.slice(0, 600),
    verified: true,
    auto_discovered: true,
    discovered_by: 'sku-resolver-seller-sku',
    seller_sku: sellerSku,
  };
  return { entry, summary: `seller SKU ${sellerSku} = Prosol ${info.prosol_sku}, ${info.name}` };
}

/**
 * Tier 2b: is this proposal the same Prosol item as an entry we already trust?
 * mappings: the sku-map `mappings` object. Returns { entry, twinKey, summary } or { reason }.
 */
function decideTwin({ sku, itemName, proposal: p, mappings, now = new Date() }) {
  if (!p || p.decision !== 'map' || p.route !== 'prosol') return { reason: 'not a Prosol map proposal' };
  if (p.confidence !== 'high') return { reason: `confidence ${p.confidence}, needs high` };
  if (!p.api_sku || !p.prosol_sku) return { reason: 'proposal has no Prosol codes' };
  const twins = Object.entries(mappings || {}).filter(([k, v]) => k !== sku && v && typeof v === 'object'
    && v.verified === true && v.api_sku === p.api_sku && v.prosol_sku === p.prosol_sku
    && !/^(HALT|UNMAPPED|NON_PROSOL)/.test(String(v.prosol_sku)) && v.discovered_by !== 'sku-resolver-twin');
  if (!twins.length) return { reason: `no verified entry already maps ${p.api_sku} / ${p.prosol_sku}` };
  const [twinKey, twin] = twins[0];
  const g = require('./mapping-guard').validateMapping(itemName, twin.product);
  if (!g.ok || !g.verified) return { reason: `order title vs ${twinKey}: ${g.reason}` };
  const day = now.toISOString().slice(0, 10);
  const { note: _note, ...rest } = twin;
  const entry = {
    ...rest,
    note: `Auto-mapped ${day} by sku-resolver: Opus (high confidence) proposed ${p.prosol_sku}, the same Prosol item already verified under key ${twinKey}; order title "${itemName}" passed the mapping guard.`.slice(0, 600),
    verified: true,
    auto_discovered: true,
    discovered_by: 'sku-resolver-twin',
  };
  return { entry, twinKey, summary: `same Prosol item as ${twinKey} (${twin.product})` };
}

// ── approve links ────────────────────────────────────────────────────────────

function approveToken(sku, entry, secret = process.env.SKU_RESOLVER_SECRET) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`${sku}|${JSON.stringify(entry)}`).digest('hex').slice(0, 32);
}
function verifyApprove(sku, token, state = loadState(), secret = process.env.SKU_RESOLVER_SECRET) {
  const rec = state.skus?.[sku];
  if (!rec?.entry || !secret || !token) return null;
  const want = approveToken(sku, rec.entry, secret);
  if (!want || want.length !== String(token).length) return null;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(token))) ? rec : null;
}
function approveUrl(sku, entry) {
  const t = approveToken(sku, entry);
  return t ? `${PUBLIC_BASE}/sku-resolver/approve?sku=${encodeURIComponent(sku)}&t=${t}` : null;
}

// ── emails (plain prose: glyph tables landed in spam 2026-09-22) ─────────────

function hoursSince(iso, now = new Date()) {
  return iso ? (now - new Date(iso)) / 36e5 : Infinity;
}

function proposalEmail(sku, rec, { reminder = false, now = new Date() } = {}) {
  const days = Math.max(1, Math.round(hoursSince(rec.firstSeenAt, now) / 24));
  const orders = rec.orders.join(', ');
  const p = rec.proposal;
  const lines = [];
  lines.push(reminder
    ? `Still not shipped: order ${orders} has waited about ${days} day${days === 1 ? '' : 's'} because SKU ${sku} has no sku-map entry.`
    : `Order ${orders} can't ship because SKU ${sku} has no sku-map entry.`);
  lines.push('');
  lines.push(`Order line: ${rec.itemName || '(no title)'}, quantity ${rec.qty}.`);
  if (rec.exactReason) lines.push(`Automatic match failed: ${rec.exactReason}.`);
  if (rec.sellerSkuReason) lines.push(`Seller SKU check${rec.sellerSku ? ` (${rec.sellerSku})` : ''}: ${rec.sellerSkuReason}.`);
  if (rec.twinReason) lines.push(`Not mapped as a twin of an existing entry: ${rec.twinReason}.`);
  lines.push('');
  if (p && rec.entry) {
    lines.push(`Opus proposes (${p.confidence} confidence): ${p.route === 'sechelt' ? 'ship from Sechelt' : `Prosol item ${p.api_sku} (vendor code ${p.prosol_sku})`}.`);
    lines.push(`Product: ${p.product}`);
    lines.push('');
    lines.push(p.explanation);
    if (p.evidence?.length) {
      lines.push('');
      lines.push('Evidence:');
      for (const e of p.evidence.slice(0, 8)) lines.push(`  ${e}`);
    }
    lines.push('');
    const url = approveUrl(sku, rec.entry);
    lines.push(url
      ? `Approve it here (on Tailscale), and the next staging pass ships the order:\n${url}`
      : 'No approve link is configured (SKU_RESOLVER_SECRET unset). Approve it in a Claude session.');
  } else if (p) {
    lines.push(`Opus could not resolve it (${p.confidence} confidence): ${p.explanation}`);
    lines.push('');
    lines.push('It needs a mapping by hand: Telegram /map for a Prosol SKU, or a Claude session.');
  } else {
    lines.push(`No AI proposal${rec.aiError ? ` (${rec.aiError})` : ''}. It needs a mapping by hand: Telegram /map for a Prosol SKU, or a Claude session.`);
  }
  if (rec.prosolCandidates) {
    lines.push('');
    lines.push(`What staging found in the Prosol catalog:\n${rec.prosolCandidates}`);
  }
  return {
    subject: `${reminder ? 'STILL NOT SHIPPED' : 'Not shipped'}: order ${orders} needs a mapping for SKU ${sku}`,
    text: lines.join('\n'),
  };
}

// ── stage hooks ──────────────────────────────────────────────────────────────

/**
 * Pull the unmapped lines out of staging's manualReview rows. Only rows staging
 * tagged with `unmappedItems` count (no sku-map entry, or an UNMAPPED* entry);
 * HALTs, title mismatches and samples are not this module's business.
 */
function collectUnmapped(manualReview) {
  const bySku = new Map();
  for (const row of manualReview || []) {
    for (const it of row.unmappedItems || []) {
      const cur = bySku.get(it.sku) || { sku: it.sku, itemName: it.name, qty: 0, orders: [], prosolCandidates: null };
      cur.qty += Number(it.qty) || 1;
      if (!cur.orders.includes(row.orderNumber)) cur.orders.push(row.orderNumber);
      const m = String(row.reason || '').match(/Prosol (?:candidates for|search) [\s\S]*$/);
      if (m && !cur.prosolCandidates) cur.prosolCandidates = m[0].slice(0, 2000);
      bySku.set(it.sku, cur);
    }
  }
  return [...bySku.values()];
}

let running = false;

/**
 * After a (non-dry) staging pass: FYI-email what the exact tier auto-mapped, ask
 * Opus about new unmapped SKUs (capped per pass), and re-email anything still
 * waiting after REMIND_HOURS. Fire-and-forget from phaseStage; never throws.
 */
async function handleStageResult(result, {
  now = new Date(), send, ai = proposeWithAi, exact = tryExact, auditLog, mappings, apply,
  sellerSku = sellerSkuFor, prosol = openProsol,
} = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const sendEmail = send || require('./emailer').sendEmail;
  const out = { autoMappedEmailed: 0, proposed: 0, reminded: 0, errors: [] };
  // One Prosol session per pass, opened only if a line needs it.
  let client = null;
  let prosolFailed = null;
  const prosolLookup = async (code) => {
    if (prosolFailed) throw prosolFailed;
    if (!client) { try { client = await prosol(); } catch (e) { prosolFailed = e; throw e; } }
    return client.getMappingInfo(code);
  };
  // Map with no approval: write the entry live, record it, FYI email.
  const autoApply = async (line, fresh, entry, by, subject, text) => {
    (apply || require('../scripts/shipstation/run-orders').liveAddMapping)(line.sku, entry);
    Object.assign(fresh, { entry, status: 'applied', appliedAt: now.toISOString(), appliedBy: by });
    state.skus[line.sku] = fresh;
    await sendEmail({ to: ALERT_TO(), subject, text: `${text}\n\nNo action needed. The entry is in sku-map.json with discovered_by "${entry.discovered_by}".` });
    fresh.lastEmailAt = now.toISOString();
  };
  let state;
  try {
    state = loadState();
    state.skus = state.skus || {};

    for (const a of result.autoMapped || []) {
      try {
        await sendEmail({
          to: ALERT_TO(),
          subject: `Auto-mapped SKU ${a.sku} to Sechelt: order ${a.orders.join(', ')} ships this pass`,
          text: `SKU ${a.sku} had no sku-map entry. The resolver matched it exactly (${a.summary}) and mapped it to Sechelt, so order ${a.orders.join(', ')} goes through on this staging pass.\n\nNo action needed. The entry is in sku-map.json with discovered_by "sku-resolver-exact".`,
        });
        out.autoMappedEmailed++;
      } catch (e) { out.errors.push(`automap email ${a.sku}: ${e.message}`); }
    }

    let aiBudget = MAX_AI_PER_PASS;
    for (const line of collectUnmapped(result.manualReview)) {
      const rec = state.skus[line.sku];
      if (rec && rec.status === 'applied') continue;
      if (rec) {
        rec.orders = [...new Set([...(rec.orders || []), ...line.orders])];
        rec.qty = line.qty;
        if (hoursSince(rec.lastEmailAt, now) < REMIND_HOURS) continue;
        const mail = proposalEmail(line.sku, rec, { reminder: true, now });
        try {
          await sendEmail({ to: ALERT_TO(), subject: mail.subject, text: mail.text, priority: 'high' });
          rec.lastEmailAt = now.toISOString();
          out.reminded++;
        } catch (e) { out.errors.push(`reminder ${line.sku}: ${e.message}`); }
        continue;
      }
      if (aiBudget <= 0) continue; // next pass picks it up
      aiBudget--;
      const fresh = {
        status: 'proposed', firstSeenAt: now.toISOString(), sku: line.sku, itemName: line.itemName, qty: line.qty,
        orders: line.orders, prosolCandidates: line.prosolCandidates, exactReason: line.exactReason || null,
      };
      try {
        if (!fresh.exactReason) {
          const ex = await exact({ sku: line.sku, itemName: line.itemName, qty: line.qty });
          fresh.exactReason = ex.reason || null;
        }
      } catch (e) { fresh.exactReason = `lookup failed: ${e.message}`; }
      if (ASIN_RE.test(line.sku)) {
        let ss = { reason: 'not checked' };
        try {
          fresh.sellerSku = await sellerSku(line);
          ss = decideSellerSku({ sku: line.sku, itemName: line.itemName, sellerSku: fresh.sellerSku, info: fresh.sellerSku ? await prosolLookup(fresh.sellerSku) : null, now });
        } catch (e) { ss = { reason: `seller SKU lookup failed: ${e.message.slice(0, 120)}` }; }
        fresh.sellerSkuReason = ss.reason || null;
        if (ss.entry) {
          try {
            await autoApply(line, fresh, ss.entry, 'auto-seller-sku',
              `Auto-mapped ${line.sku} to Prosol ${ss.entry.prosol_sku}: order ${line.orders.join(', ')} ships next pass`,
              `ASIN ${line.sku} had no sku-map entry. Our Amazon listing's seller SKU is ${fresh.sellerSku}, Prosol has exactly that SKU (${ss.entry.product}, vendor code ${ss.entry.prosol_sku}, cost $${ss.entry.cost_cad}), and the order title "${line.itemName}" passed the mapping guard against it. So it was mapped with no approval and order ${line.orders.join(', ')} goes through on the next staging pass.`);
            out.sellerSkuMapped = (out.sellerSkuMapped || 0) + 1;
          } catch (e) { out.errors.push(`seller-sku ${line.sku}: ${e.message}`); }
          if (fresh.status === 'applied') continue;
        }
      }
      try {
        fresh.proposal = await ai({ sku: line.sku, itemName: line.itemName, qty: line.qty, orders: line.orders, prosolCandidates: line.prosolCandidates, sellerSku: fresh.sellerSku, sellerSkuReason: fresh.sellerSkuReason }, { prosolLookup });
        if (!fresh.proposal) fresh.aiError = process.env.ANTHROPIC_API_KEY ? 'no answer' : 'ANTHROPIC_API_KEY not set';
      } catch (e) { fresh.aiError = e.message.slice(0, 200); }
      fresh.entry = entryFromProposal(fresh.proposal, { now });
      let tw = { reason: 'no proposal' };
      try {
        if (fresh.entry) tw = decideTwin({ sku: line.sku, itemName: line.itemName, proposal: fresh.proposal, mappings: (mappings || readSkuMap)(), now });
      } catch (e) { tw = { reason: `twin check failed: ${e.message}` }; }
      if (tw.entry) {
        try {
          await autoApply(line, fresh, tw.entry, 'auto-twin',
            `Auto-mapped SKU ${line.sku} (${tw.summary.slice(0, 60)}): order ${line.orders.join(', ')} ships next pass`,
            `SKU ${line.sku} had no sku-map entry. Opus proposed Prosol ${fresh.proposal.prosol_sku} with high confidence, and that is the same Prosol item already verified under key ${tw.twinKey}. The order title "${line.itemName}" passed the mapping guard against it, so it was mapped with no approval and order ${line.orders.join(', ')} goes through on the next staging pass.`);
          out.twinMapped = (out.twinMapped || 0) + 1;
        } catch (e) { out.errors.push(`twin ${line.sku}: ${e.message}`); }
        if (fresh.status === 'applied') continue;
      }
      fresh.twinReason = tw.reason || null;
      const mail = proposalEmail(line.sku, fresh, { now });
      try {
        await sendEmail({ to: ALERT_TO(), subject: mail.subject, text: mail.text, priority: 'high' });
        fresh.lastEmailAt = now.toISOString();
      } catch (e) { out.errors.push(`proposal email ${line.sku}: ${e.message}`); }
      state.skus[line.sku] = fresh;
      out.proposed++;
    }
    saveState(state);
  } catch (e) {
    out.errors.push(e.message);
  } finally {
    running = false;
    if (client) await client.close().catch(() => {});
  }
  try { (auditLog || require('./audit').log)({ action: 'sku-resolver', ...out }); } catch { /* audit is best-effort */ }
  return out;
}

/** Mark an approved proposal applied (called by the approve endpoint after liveAddMapping). */
function markApplied(sku, { now = new Date(), by = 'approve-link' } = {}) {
  const state = loadState();
  if (state.skus?.[sku]) {
    state.skus[sku].status = 'applied';
    state.skus[sku].appliedAt = now.toISOString();
    state.skus[sku].appliedBy = by;
    saveState(state);
  }
}

module.exports = {
  decideExact, decideTwin, decideSellerSku, sellerSkuFor, tryExact, sharesProductWord, proposeWithAi, entryFromProposal, collectUnmapped,
  handleStageResult, proposalEmail, approveToken, verifyApprove, approveUrl, markApplied, loadState,
  SECHELT_WAREHOUSE_ID, MODEL,
};
