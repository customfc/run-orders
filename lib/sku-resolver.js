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
 * Two tiers. Every auto-apply below writes the entry live, records it in the
 * state and the audit trail (`sku-resolver-auto-applied`, by auto-seller-sku,
 * auto-twin or opus-auto) and sends no email: Mac, 2026-11-01, wants no FYI
 * emails, only the stuck case.
 *
 * NOTHING here routes a SKU to Sechelt without Mac. Mac, 2026-11-02: "we prefer
 * not to ship anything from sechelt, unless i say so." A Sechelt mapping is only
 * ever written by his tap on the approve link (/sku-resolver/approve). The
 * Sechelt counts in Shopify also stopped updating under ERP_BACKEND=automayt
 * (Oct 31), so the stock check below reads frozen numbers.
 *   1. EXACT (evidence only, never maps). Shopify variant SKU == the order SKU
 *      (exactly one), the ERP item number == the order SKU (exactly one: the SF
 *      PBSI item Name, or under ERP_BACKEND=automayt the Automayt item_number),
 *      the order title shares a product word with the Shopify title, and Shopify
 *      shows Sechelt stock >= the quantity ordered. Until 2026-11-02 that mapped
 *      the SKU to Sechelt during staging (4657 on 2026-10-05). Now it is the
 *      line's `exactReason` ("... Sechelt has N, needs Mac's OK"), which Opus
 *      and Mac's email see, and the line goes on to the AI tier.
 *   1c. SELLER SKU (auto-applies). Amazon lines carry only the ASIN, but our
 *      listing's SellerSKU (from SP-API order items) is usually the Prosol code.
 *      When it is an exact, unambiguous Prosol storefront SKU with a vendor code
 *      and a cost, and the order title passes the mapping guard against Prosol's
 *      product name, map it. 702-3620151-6391423 (B07XQJNY76, seller SKU
 *      KDIF4GRKEBTD8) waited on Mac to look that up by hand, 2026-10-29.
 *   2. AI PROPOSAL. Everything else goes to Claude Opus with read-only lookups
 *      (Shopify, the ERP: Salesforce, or Automayt under ERP_BACKEND=automayt,
 *      the sku-map, an exact Prosol lookup) plus the Prosol candidates staging
 *      already found. It proposes a mapping with evidence.
 *   2b. TWIN (auto-applies). A high-confidence Prosol proposal whose api_sku AND
 *      prosol_sku both equal an existing verified sku-map entry, and whose order
 *      title passes the mapping guard (size + product words) against that entry,
 *      is the same item under a new key. #1435 (Shopify SKU PRMPSQT1) sat two
 *      days on an approve link though key 08526 already mapped PRMPSQT1.
 *   2c. OPUS AUTO (auto-applies). Mac, 2026-11-01: "I don't want to
 *      click to approve, unless u truly can't figure it out." A map proposal at
 *      AUTO_CONFIDENCE (high or medium: all 11 map proposals Mac saw from
 *      2026-10-19 to 10-29, 9 high and 2 medium, were the right mapping and none
 *      was later changed) is applied like the approve link applies it
 *      (liveAddMapping, state applied by 'opus-auto') when code re-checks it:
 *      route prosol = Prosol has exactly that api_sku, with that vendor code and
 *      a cost, and the order title passes the mapping guard against Prosol's own
 *      product name. A route sechelt proposal is never auto-applied: it always
 *      goes to Mac on the approve-link email, with the ERP-description guard and
 *      Sechelt stock results in the email. The order ships on the next staging
 *      pass and the staging mapping guard still checks the ERP description
 *      before a buy.
 *
 * Only what code can't settle emails Mac (not Telegram: Mac triages email), with
 * a one-tap approve link when there is a proposal: no proposal, low confidence,
 * any Sechelt route, or a failed re-check (guard, Prosol). Those re-email once a
 * day while the order waits.
 *
 * lib/automayt-settle.js reuses this module's Opus loop and tools to settle two
 * Automayt item problems in the order flows (same-code twins, a missing cost).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const erpMode = require('./erp-mode');

const SECHELT_WAREHOUSE_ID = 147654;
const SECHELT_LOCATION_NAME = 'Sechelt Warehouse';
const SECHELT_NEEDS_MAC = "Sechelt route needs Mac's OK (policy 2026-11-02)";
const STATE_FILE = process.env.SKU_RESOLVER_STATE_FILE || path.join(__dirname, '..', 'data', 'sku-resolver-state.json');
const SKU_MAP_FILE = path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json');
const MODEL = 'claude-opus-5-5';
const MAX_AI_PER_PASS = Number(process.env.SKU_RESOLVER_AI_MAX_PER_PASS || 3);
const MAX_AI_TURNS = 12;
const REMIND_HOURS = Number(process.env.SKU_RESOLVER_REMIND_HOURS || 24);
// Opus confidence levels code may act on without Mac, once its re-check passes.
// History on the Mini (2026-10-19 to 10-29): 9 high + 2 medium map proposals,
// every one the mapping Mac kept. Low always goes to Mac.
const AUTO_CONFIDENCE = new Set(['high', 'medium']);
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
/** Read, change and write the state in one synchronous step, so writers in other passes never clobber each other. */
function updateState(fn) {
  const s = loadState();
  const out = fn(s);
  saveState(s);
  return out;
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
 * The EXACT tier's stock proof: exactly one Shopify variant carries the order
 * SKU and Shopify shows Sechelt Warehouse stock >= the quantity ordered.
 * Returns { variant, atSechelt } or { reason }. Tier 2c uses it for Sechelt routes.
 */
function secheltVariant({ sku, variants }) {
  const v = (variants || []).filter((x) => x.sku === sku);
  if (v.length !== 1) return { reason: `Shopify has ${v.length} variants with SKU ${sku}` };
  return { variant: v[0], atSechelt: Number(v[0].inventory?.[SECHELT_LOCATION_NAME] ?? 0) };
}
function secheltCovers({ atSechelt, qty }) {
  return atSechelt >= (Number(qty) || 1) ? null : `Shopify shows ${atSechelt} at Sechelt, order needs ${qty}`;
}

/**
 * The exact identity check: is this unmapped SKU provably our own Sechelt item?
 * It never maps (Mac 2026-11-02, Sechelt only on his OK): a match comes back as
 * a reason that says so, for Opus and Mac's email. Always returns { reason },
 * plus `secheltMatch` (the would-be entry and summary) when every check passed.
 * variants: [{ sku, productTitle, variantTitle, inventory: { [locationName]: available } }]
 * sfItems:  [{ Name, PBSI__description__c, PBSI__Cost__c, PBSI__Vendor_Item_ID__c, vendorName }]
 *           (Automayt items in the same shape under ERP_BACKEND=automayt; erp names the system)
 * Returns { reason, secheltMatch? }.
 */
function decideExact({ sku, itemName, qty, variants, sfItems, erp = 'Salesforce', now = new Date() }) {
  if (!sku || sku === 'UNKNOWN') return { reason: 'no SKU on the line' };
  if (ASIN_RE.test(sku)) return { reason: 'Amazon ASIN, needs a product match, not an identity match' };
  const sv = secheltVariant({ sku, variants });
  if (sv.reason) return { reason: sv.reason };
  const sf = (sfItems || []).filter((x) => x.Name === sku);
  if (sf.length !== 1) return { reason: `${erp} has ${sf.length} items named ${sku}` };
  const erpItem = erp === 'Salesforce' ? 'SF item' : `${erp} item`;
  const { variant, atSechelt } = sv;
  const item = sf[0];
  const title = variant.variantTitle && variant.variantTitle !== 'Default Title'
    ? `${variant.productTitle} - ${variant.variantTitle}` : variant.productTitle;
  if (itemName && !sharesProductWord(itemName, title)) {
    return { reason: `order title "${itemName}" shares no product word with Shopify "${title}"` };
  }
  const short = secheltCovers({ atSechelt, qty });
  if (short) return { reason: short };
  const day = now.toISOString().slice(0, 10);
  const entry = {
    api_sku: 'NON_PROSOL',
    prosol_sku: 'NON_PROSOL',
    product: title,
    note: `Auto-mapped ${day} by sku-resolver: Shopify SKU ${sku} = ${erpItem} ${item.Name}${item.vendorName ? ` (vendor ${item.vendorName}${item.PBSI__Vendor_Item_ID__c ? ` ${item.PBSI__Vendor_Item_ID__c}` : ''})` : ''}; Shopify showed ${atSechelt} at Sechelt.`,
    source: 'SECHELT_OR_FBA',
    route_to: 'CFC_SECHELT',
    shipstation_warehouse_id: SECHELT_WAREHOUSE_ID,
    verified: true,
    auto_discovered: true,
    discovered_by: 'sku-resolver-exact',
    ...(item.PBSI__Cost__c != null ? { cost_cad: item.PBSI__Cost__c } : {}),
    sf_item: item.Name,
  };
  const summary = `${title}: Shopify SKU = ${erpItem} ${item.Name}, ${atSechelt} at Sechelt`;
  return {
    reason: `Shopify SKU ${sku} = ${erpItem} ${item.Name}${item.PBSI__description__c ? ` "${item.PBSI__description__c}"` : ''}; Sechelt has ${atSechelt}, needs Mac's OK (policy 2026-11-02: no Sechelt route without Mac)`,
    secheltMatch: { entry, summary },
  };
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

/**
 * Automayt items for one exact code, through the order flows' own batch lookup
 * (automayt-erp.resolveItems): as vendor code (the Prosol code) and as item
 * number (the old Salesforce item Name, usually the Shopify SKU), reported apart.
 */
async function automaytItemsByCode(code) {
  const erp = require('./automayt-erp');
  const v = await erp.resolveItems([{ key: 'vc', vendorCodes: [code] }, { key: 'in', itemNumbers: [code] }]);
  const list = (k) => ((v.get(k) || {}).candidates || []).map(erp.itemSummary);
  return { by_vendor_code: list('vc'), by_item_number: list('in') };
}

/** The tryExact item list from Automayt: items whose item_number is the SKU, in decideExact's shape. */
async function automaytItemsByName(sku) {
  const { by_item_number: items } = await automaytItemsByCode(sku);
  return items.map((it) => ({
    Name: it.item_number,
    PBSI__description__c: it.description,
    PBSI__Vendor_Item_ID__c: it.vendor_code,
    PBSI__Cost__c: it.cost != null && Number(it.cost) > 0 ? Number(it.cost) : null,
    vendorName: null,
  }));
}

async function tryExact({ sku, itemName, qty }) {
  if (!sku || sku === 'UNKNOWN' || ASIN_RE.test(sku)) return decideExact({ sku, itemName, qty });
  // The identity proof is an ERP item of the same name: the Salesforce item
  // Name, or with Salesforce off the Automayt item_number (Salesforce Names
  // carried over as item numbers in the migration).
  if (erpMode.automaytOnly()) {
    const [variants, sfItems] = await Promise.all([shopifyVariants(`sku:${sku}`, 5), automaytItemsByName(sku)]);
    return decideExact({ sku, itemName, qty, variants, sfItems, erp: 'Automayt' });
  }
  const [variants, sfItems] = await Promise.all([shopifyVariants(`sku:${sku}`, 5), sfItemsByName(sku)]);
  return decideExact({ sku, itemName, qty, variants, sfItems });
}

/**
 * The ERP's description of the item named `code` (one exact item, else null):
 * Automayt under ERP_BACKEND=automayt, else Salesforce. What the opus-auto
 * re-check guards a Sechelt proposal against.
 */
async function erpDescription(code) {
  if (!code) return null;
  if (erpMode.automaytOnly()) {
    const { by_item_number: byNum, by_vendor_code: byCode } = await automaytItemsByCode(code);
    const hits = byNum.length ? byNum : byCode;
    return hits.length === 1 ? hits[0].description || null : null;
  }
  const rows = await sfItemsByName(code);
  return rows.length === 1 ? rows[0].PBSI__description__c || null : null;
}

// ── AI tier ──────────────────────────────────────────────────────────────────

function readSkuMap() {
  try { return JSON.parse(fs.readFileSync(SKU_MAP_FILE, 'utf8')).mappings || {}; } catch { return {}; }
}

// Read-only lookups any Opus task here can be given (askOpus), plus each task's
// own submit tool. lib/automayt-settle.js picks from the same set.
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
    name: 'automayt_item_lookup',
    description: 'Look up items in Automayt (our ERP, which replaced Salesforce) by ONE exact code, tried as vendor code (the Prosol code for Prosol items) and as item number (our old Salesforce item Name, often the Shopify SKU). Case, spaces and dashes are ignored; no keyword search. Returns each matching item: id, item number, vendor code, description, stocking unit, cost, retail price, vendor and stock status.',
    input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
  },
  {
    name: 'prosol_search',
    description: 'Keyword search of the Prosol storefront catalogue (brand, product line, colour, model words; up to 8 results). Returns each product\'s storefront SKU (api_sku), Prosol vendor code (prosol_sku), name and stock status. Confirm any result with prosol_lookup before using it.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
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
- route "prosol" (the default): drop-shipped by our distributor Prosol. Right whenever Prosol carries the exact product, even when Shopify also shows stock at "Sechelt Warehouse": the owner does not ship from Sechelt unless he says so. Mapping: api_sku = the Prosol storefront SKU, prosol_sku = the Prosol vendor code (they often differ; never copy one into the other without evidence). In Salesforce, items whose vendor is Prosol carry the Prosol code in the vendor item ID.
- route "sechelt": from our own warehouse in Sechelt, BC. Propose it only when Prosol does not carry the product at all (you searched and confirmed). It is never applied without the owner's approval. Mapping: api_sku "NON_PROSOL", prosol_sku "NON_PROSOL".

A numeric Shopify SKU (like 11564) is our own ERP item number, not a Prosol code: look the item up, take its vendor item ID / vendor code and description, and find the Prosol product from those (11564 Sealer's Choice Gold pint = Prosol storefront SKU C030881, vendor code C030881-05). Do not route it to Sechelt because the number is ours.

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
      if (erpMode.automaytOnly()) return JSON.stringify({ error: 'Salesforce is off (ERP_BACKEND=automayt)' });
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
    if (name === 'prosol_search') {
      if (!ctx.prosolSearch) return JSON.stringify({ error: 'Prosol search not available on this pass' });
      const q = String(input.query || '').trim().slice(0, 80);
      return q ? JSON.stringify(await ctx.prosolSearch(q)) : '[]';
    }
    if (name === 'automayt_item_lookup') {
      if (!erpMode.automaytOnly()) return JSON.stringify({ error: 'Automayt lookup is only on under ERP_BACKEND=automayt' });
      const code = String(input.code || '').trim().slice(0, 40);
      return code ? JSON.stringify(await (ctx.automaytLookup || automaytItemsByCode)(code)) : '{}';
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

function lineContext({ sku, itemName, qty, orders, prosolCandidates, sellerSku, sellerSkuReason, exactReason }) {
  return [
    `Unmapped SKU: ${sku}`,
    ...(exactReason ? [`Exact ERP/Shopify identity check: ${exactReason}`] : []),
    ...(sellerSku ? [`Our Amazon listing's seller SKU for this ASIN: ${sellerSku} (automatic match failed: ${sellerSkuReason || 'unknown'})`] : []),
    `Order line title: ${itemName || '(none)'}`,
    `Quantity waiting: ${qty}`,
    `Orders waiting on it: ${orders.join(', ')}`,
    prosolCandidates ? `Prosol catalog search already run by staging:\n${prosolCandidates}` : 'Prosol catalog search: not available for this line.',
  ].join('\n');
}

/**
 * One Opus task with read-only tools: loop until it calls the `submit` tool.
 * tools: names from TOOLS (lookups this task may use) plus extra full tool
 * definitions (its submit tool). ctx carries the lookups (prosolLookup,
 * prosolSearch, automaytLookup). Returns the submit input, or null when there
 * is no key, a refusal, or no answer.
 */
async function askOpus({ system, tools, extraTools = [], submit, content, ctx = {}, client }) {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  const toolDefs = [...TOOLS.filter((t) => tools.includes(t.name)), ...extraTools];
  const messages = [{ role: 'user', content }];
  let nudged = false;
  for (let turn = 0; turn < MAX_AI_TURNS; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system,
      tools: toolDefs,
      messages,
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const done = uses.find((b) => b.name === submit);
    if (done) return done.input;
    if (!uses.length) {
      if (nudged) return null;
      nudged = true;
      messages.push({ role: 'user', content: `Call ${submit} with your answer now.` });
      continue;
    }
    const results = await Promise.all(uses.map(async (u) => ({
      type: 'tool_result', tool_use_id: u.id, content: await runTool(u.name, u.input, ctx),
    })));
    messages.push({ role: 'user', content: results });
  }
  return null;
}

/** Ask Opus for a mapping proposal. Returns the submit_proposal input, or null. */
async function proposeWithAi(line, { client, prosolLookup, automaytLookup } = {}) {
  const automayt = erpMode.automaytOnly();
  return askOpus({
    system: automayt
      ? `${SYSTEM}\n\nSalesforce is retired: there is no Salesforce lookup. Our ERP is Automayt: automayt_item_lookup finds its items by exact code (item numbers are the old Salesforce item Names, vendor codes are Prosol codes). Put the Automayt item number in sf_item when you found one, else "".`
      : SYSTEM,
    tools: automayt
      ? ['shopify_search', 'skumap_search', 'prosol_lookup', 'automayt_item_lookup', 'submit_proposal']
      : ['shopify_search', 'salesforce_item_search', 'skumap_search', 'prosol_lookup', 'submit_proposal'],
    submit: 'submit_proposal',
    content: lineContext(line),
    ctx: { prosolLookup, automaytLookup },
    client,
  });
}

/**
 * Turn an AI proposal into a sku-map entry, or null if it isn't a usable map.
 * auto: the re-check that passed, when code applies it with no approval.
 */
function entryFromProposal(p, { now = new Date(), auto = null } = {}) {
  if (!p || p.decision !== 'map') return null;
  const day = now.toISOString().slice(0, 10);
  const note = (auto
    ? `Auto-applied ${day} by sku-resolver (Opus, ${p.confidence} confidence; ${auto}): ${p.explanation}`
    : `Proposed ${day} by sku-resolver (Opus, ${p.confidence} confidence), approved by Mac: ${p.explanation}`).slice(0, 600);
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

/**
 * Tier 2c: may this proposal be applied with no approval? Pure: the caller
 * fetched `info` (Prosol getMappingInfo(p.api_sku), route prosol), or for
 * route sechelt `erpText` (the ERP item's description) and `variants` (Shopify
 * variants for the order SKU: Sechelt must cover `qty`, the EXACT tier's check).
 * Returns { entry, summary } or { reason }.
 */
function decideAutoApply({ sku, itemName, qty, proposal: p, info, erpText, variants, now = new Date() }) {
  if (!p || p.decision !== 'map') return { reason: 'no map proposal' };
  if (!AUTO_CONFIDENCE.has(p.confidence)) return { reason: `confidence ${p.confidence}, needs ${[...AUTO_CONFIDENCE].join(' or ')}` };
  if (!itemName) return { reason: 'the order line has no title to check against' };
  const guard = (against, label) => {
    const g = require('./mapping-guard').validateMapping(itemName, against);
    return g.ok && g.verified ? null : `order title vs ${label} "${against || ''}": ${g.reason}`;
  };
  if (p.route === 'prosol') {
    if (!p.api_sku || !p.prosol_sku || p.api_sku === 'NON_PROSOL') return { reason: 'proposal has no Prosol codes' };
    if (!info) return { reason: `Prosol has no product with SKU ${p.api_sku}` };
    if (info.ambiguous) return { reason: `Prosol has ${info.count} products with SKU ${p.api_sku}` };
    if (info.sku !== p.api_sku) return { reason: `Prosol answered ${info.sku} for ${p.api_sku}` };
    if (info.prosol_sku !== p.prosol_sku) return { reason: `Prosol's vendor code for ${p.api_sku} is ${info.prosol_sku || 'missing'}, the proposal says ${p.prosol_sku}` };
    if (!(Number(info.cost_cad) > 0)) return { reason: `Prosol gave no cost for ${p.api_sku}` };
    const bad = guard(info.name, 'Prosol');
    if (bad) return { reason: bad };
    const base = entryFromProposal(p, { now, auto: `Prosol ${info.sku} "${info.name}" passed the mapping guard` });
    const entry = {
      cost_cad: info.cost_cad,
      ...(info.retail_cad != null ? { retail_cad: info.retail_cad } : {}),
      cost_source: 'prosol-offers-loc10010',
      ...base,
      auto_discovered: true,
    };
    return { entry, summary: `Prosol ${info.prosol_sku}, ${info.name}` };
  }
  if (p.route === 'sechelt') {
    // Never auto-applied (Mac 2026-11-02). The checks still run so the email
    // says what Mac is approving.
    const checks = [];
    if (!erpText) checks.push(`no single ERP item${p.sf_item ? ` ${p.sf_item}` : ''} to check the order title against`);
    else checks.push(guard(erpText, 'ERP item') || `ERP item "${erpText}" passes the mapping guard`);
    const sv = secheltVariant({ sku, variants });
    if (sv.reason) checks.push(`Sechelt stock unproven: ${sv.reason}`);
    else checks.push(secheltCovers({ atSechelt: sv.atSechelt, qty }) || `Shopify shows ${sv.atSechelt} at Sechelt`);
    return { reason: `${SECHELT_NEEDS_MAC} (${checks.join('; ')})` };
  }
  return { reason: `route ${p.route} is not a mapping` };
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
  if (rec.exactReason) lines.push(`Exact check: ${rec.exactReason}.`);
  if (rec.sellerSkuReason) lines.push(`Seller SKU check${rec.sellerSku ? ` (${rec.sellerSku})` : ''}: ${rec.sellerSkuReason}.`);
  if (rec.twinReason) lines.push(`Not mapped as a twin of an existing entry: ${rec.twinReason}.`);
  if (rec.autoReason) lines.push(`Not applied automatically: ${rec.autoReason}.`);
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
 * After a (non-dry) staging pass: audit what the exact tier auto-mapped, ask
 * Opus about new unmapped SKUs (capped per pass), and re-email anything still
 * waiting after REMIND_HOURS. Fire-and-forget from phaseStage; never throws.
 */
async function handleStageResult(result, {
  now = new Date(), send, ai = proposeWithAi, exact = tryExact, auditLog, mappings, apply,
  sellerSku = sellerSkuFor, prosol = openProsol, erpText = erpDescription,
  variantsFor = (sku) => shopifyVariants(`sku:${sku}`, 5),
} = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const sendEmail = send || require('./emailer').sendEmail;
  const audit = (rec) => { try { (auditLog || require('./audit').log)(rec); } catch { /* audit is best-effort */ } };
  const out = { proposed: 0, reminded: 0, errors: [] };
  // One Prosol session per pass, opened only if a line needs it.
  let client = null;
  let prosolFailed = null;
  const prosolLookup = async (code) => {
    if (prosolFailed) throw prosolFailed;
    if (!client) { try { client = await prosol(); } catch (e) { prosolFailed = e; throw e; } }
    return client.getMappingInfo(code);
  };
  // Map with no approval: write the entry live, record it in the state and the
  // audit trail. No email (Mac, 2026-11-01: no FYI emails, only the stuck case).
  const autoApply = (line, fresh, entry, by, summary) => {
    (apply || require('../scripts/shipstation/run-orders').liveAddMapping)(line.sku, entry);
    Object.assign(fresh, { entry, status: 'applied', appliedAt: now.toISOString(), appliedBy: by });
    state.skus[line.sku] = fresh;
    audit({ action: 'sku-resolver-auto-applied', by, sku: line.sku, entry, orders: line.orders, summary });
  };
  let state;
  try {
    state = loadState();
    state.skus = state.skus || {};

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
            autoApply(line, fresh, ss.entry, 'auto-seller-sku', `seller SKU ${fresh.sellerSku} = ${ss.summary}`);
            out.sellerSkuMapped = (out.sellerSkuMapped || 0) + 1;
          } catch (e) { out.errors.push(`seller-sku ${line.sku}: ${e.message}`); }
          if (fresh.status === 'applied') continue;
        }
      }
      try {
        fresh.proposal = await ai({ sku: line.sku, itemName: line.itemName, qty: line.qty, orders: line.orders, prosolCandidates: line.prosolCandidates, sellerSku: fresh.sellerSku, sellerSkuReason: fresh.sellerSkuReason, exactReason: fresh.exactReason }, { prosolLookup });
        if (!fresh.proposal) fresh.aiError = process.env.ANTHROPIC_API_KEY ? 'no answer' : 'ANTHROPIC_API_KEY not set';
      } catch (e) { fresh.aiError = e.message.slice(0, 200); }
      fresh.entry = entryFromProposal(fresh.proposal, { now });
      let tw = { reason: 'no proposal' };
      try {
        if (fresh.entry) tw = decideTwin({ sku: line.sku, itemName: line.itemName, proposal: fresh.proposal, mappings: (mappings || readSkuMap)(), now });
      } catch (e) { tw = { reason: `twin check failed: ${e.message}` }; }
      if (tw.entry) {
        try {
          autoApply(line, fresh, tw.entry, 'auto-twin', tw.summary);
          out.twinMapped = (out.twinMapped || 0) + 1;
        } catch (e) { out.errors.push(`twin ${line.sku}: ${e.message}`); }
        if (fresh.status === 'applied') continue;
      }
      fresh.twinReason = tw.reason || null;
      // Tier 2c: a confident proposal that code re-checks is applied the way the
      // approve link applies it, with no email.
      let au = { reason: null };
      try {
        if (fresh.entry) {
          const p = fresh.proposal;
          const recheck = !AUTO_CONFIDENCE.has(p.confidence) ? {}
            : p.route === 'prosol' ? { info: await prosolLookup(p.api_sku) }
              : p.route === 'sechelt' ? await (async () => {
                const t = await erpText(p.sf_item || line.sku);
                return { erpText: t, variants: t ? await variantsFor(line.sku) : [] };
              })() : {};
          au = decideAutoApply({ sku: line.sku, itemName: line.itemName, qty: line.qty, proposal: p, ...recheck, now });
        }
      } catch (e) { au = { reason: `re-check failed: ${e.message.slice(0, 160)}` }; }
      if (au.entry) {
        try {
          if ((mappings || readSkuMap)()[line.sku]) {
            Object.assign(fresh, { status: 'applied', appliedAt: now.toISOString(), appliedBy: 'opus-auto (already mapped)' });
          } else {
            autoApply(line, fresh, au.entry, 'opus-auto', au.summary);
            out.opusApplied = (out.opusApplied || 0) + 1;
          }
          state.skus[line.sku] = fresh;
          continue;
        } catch (e) {
          out.errors.push(`opus-auto ${line.sku}: ${e.message}`);
          au = { reason: `writing the mapping failed: ${e.message.slice(0, 160)}` };
        }
      }
      fresh.autoReason = au.reason || null;
      const mail = proposalEmail(line.sku, fresh, { now });
      try {
        await sendEmail({ to: ALERT_TO(), subject: mail.subject, text: mail.text, priority: 'high' });
        fresh.lastEmailAt = now.toISOString();
      } catch (e) { out.errors.push(`proposal email ${line.sku}: ${e.message}`); }
      state.skus[line.sku] = fresh;
      out.proposed++;
    }
    // Keep what other writers (approve link, lib/automayt-settle.js) saved
    // while this pass was talking to Opus: only `skus` is this pass's.
    updateState((latest) => {
      const merged = { ...(latest.skus || {}) };
      for (const [k, v] of Object.entries(state.skus)) {
        if (merged[k] && merged[k].status === 'applied' && v.status !== 'applied') continue; // approved meanwhile
        merged[k] = v;
      }
      latest.skus = merged;
    });
  } catch (e) {
    out.errors.push(e.message);
  } finally {
    running = false;
    if (client) await client.close().catch(() => {});
  }
  audit({ action: 'sku-resolver', ...out });
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
  decideExact, decideTwin, decideSellerSku, decideAutoApply, sellerSkuFor, tryExact, erpDescription, sharesProductWord, proposeWithAi, entryFromProposal, collectUnmapped,
  handleStageResult, proposalEmail, approveToken, verifyApprove, approveUrl, markApplied, loadState, updateState,
  askOpus, openProsol, hoursSince,
  SECHELT_WAREHOUSE_ID, MODEL, AUTO_CONFIDENCE,
};
