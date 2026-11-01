'use strict';
/**
 * Opus settles two Automayt item problems inside the order flows, so the order
 * ships with no one clicking. Mac, 2026-11-01: "I don't want to click to
 * approve, unless u truly can't figure it out." Runs only under
 * ERP_BACKEND=automayt; Salesforce and the automayt-shadow mirror keep today's
 * errors. Reuses lib/sku-resolver.js's Opus loop (askOpus) and read-only tools.
 *
 * 1. Same-code twins. automayt-erp.resolveItems answers "ambiguous" when one code
 *    finds several Automayt items (a migrated Salesforce item and its Prosol
 *    catalogue twin, two pack sizes). pickAmbiguous asks Opus once which
 *    candidate the order line is: sku, title, qty and unit price against each
 *    item's description, stocking unit, cost and price, vendor and dates. A pick
 *    at AUTO_CONFIDENCE whose description passes the mapping guard against the
 *    order title is used, and pinned on the line's sku-map entry
 *    (automayt_item_id, automayt_item_for = the code it settles) through the
 *    live write path. pinnedItem honours a pin before any lookup and drops it
 *    when the item is gone or inactive. "Can't tell" keeps today's error.
 * 2. Missing cost. autoCreateItem refuses an item with no Prosol cost. Before it
 *    does, fixMissingCost asks Opus to find the product in Prosol under its right
 *    storefront SKU. Code then reads Prosol for that SKU itself: one product,
 *    the vendor code the item is created under, a cost, and the order title
 *    passing the guard against Prosol's product name. Only then are the sku-map
 *    entry's api_sku and cost corrected and that cost used. The cost is always
 *    Prosol's own number, never Opus's.
 *
 * Opus calls are capped (SKU_RESOLVER_SETTLE_MAX_PER_PASS per hour, about one
 * pipeline pass) and every answer is kept in data/sku-resolver-state.json
 * (itemPicks, costFixes): a pick is reused, and a "can't tell" or "not found"
 * is asked again only after a day.
 */
const erpMode = require('./erp-mode');
const resolver = require('./sku-resolver');
const { validateMapping } = require('./mapping-guard');

const MAX_PER_PASS = Number(process.env.SKU_RESOLVER_SETTLE_MAX_PER_PASS || 5);
const PASS_MS = 60 * 60 * 1000;
const RETRY_HOURS = 24;
const OFF = 'auto-settle runs only under ERP_BACKEND=automayt';

// Everything with a side effect or a network call, swappable in tests.
const deps = {
  ai: (args) => resolver.askOpus(args),
  prosol: () => resolver.openProsol(),
  prosolSearch: (client, q) => require('../scripts/shipstation/run-orders').suggestProsolCandidates(client, q),
  readEntry: (key) => {
    const e = (require('./sku-map-file').readSkuMap().mappings || {})[key];
    return e && typeof e === 'object' ? e : null;
  },
  write: (key, entry) => require('../scripts/shipstation/run-orders').liveSetMapping(key, entry),
  getItem: (id) => require('./automayt-erp').getItem(id),
  audit: (rec) => require('./audit').log(rec),
  now: () => new Date(),
};

const enabled = () => erpMode.automaytOnly();
const norm = (code) => String(code || '').toUpperCase().replace(/[\s\-/]/g, '');
const erp = () => require('./automayt-erp');
const label = (item) => item.item_number || item.vendor_code || item.id;

function audit(rec) {
  try { deps.audit(rec); } catch { /* audit is best-effort */ }
}

// ── budget + memory ──────────────────────────────────────────────────────────

let pass = { start: 0, used: 0 };
function takeBudget(now) {
  if (+now - pass.start >= PASS_MS) pass = { start: +now, used: 0 };
  if (pass.used >= MAX_PER_PASS) return false;
  pass.used++;
  return true;
}

function recall(section, key) {
  return (resolver.loadState()[section] || {})[key] || null;
}
function remember(section, key, rec) {
  resolver.updateState((s) => { s[section] = { ...(s[section] || {}), [key]: rec }; });
}
/** A remembered no that is still fresh: don't ask Opus again yet. */
function freshNo(prior, now) {
  return prior && prior.outcome !== 'picked' && prior.outcome !== 'fixed' && resolver.hoursSince(prior.at, now) < RETRY_HOURS;
}

// ── sku-map entry ────────────────────────────────────────────────────────────

/** The entry's own codes: a pin or a cost fix may only touch an entry for one of these. */
function ownCodes(key, entry) {
  return new Set([key, entry.api_sku, entry.prosol_sku, entry.sf_item_name, entry.sf_item].filter(Boolean).map(norm));
}
/**
 * A single-item entry this module may change for this code: not a bundle, the
 * cable resolver, a placeholder or a HALT, and the code is the entry's own (a
 * bundle component's or a title-derived code never pins the listing's entry).
 */
function correctable(key, entry, code) {
  if (!key || !entry || typeof entry !== 'object' || entry.bundle) return false;
  if (/^(UNMAPPED|HALT|SKIP)/i.test(String(entry.api_sku || '')) || /^HALT/i.test(String(entry.prosol_sku || ''))) return false;
  return ownCodes(key, entry).has(norm(code));
}
/** Re-read the entry from disk, change it, write it through the live path (memory + disk). */
function rewrite(key, change) {
  const cur = deps.readEntry(key);
  if (!cur) throw new Error(`sku-map has no entry ${key}`);
  const next = change({ ...cur });
  deps.write(key, next);
  return next;
}

/** A Prosol session opened on first use, for one Opus task. */
function prosolSession() {
  let client = null;
  let failed = null;
  const get = async () => {
    if (failed) throw failed;
    if (!client) { try { client = await deps.prosol(); } catch (e) { failed = e; throw e; } }
    return client;
  };
  return {
    lookup: async (code) => (await get()).getMappingInfo(code),
    search: async (q) => (await deps.prosolSearch(await get(), q)).slice(0, 8),
    close: async () => { if (client) await client.close().catch(() => {}); },
  };
}

const noAnswer = (err) => (err ? `Opus failed: ${String(err.message || err).slice(0, 120)}`
  : process.env.ANTHROPIC_API_KEY ? 'Opus gave no answer' : 'ANTHROPIC_API_KEY not set');

// ── 1. same-code twins ───────────────────────────────────────────────────────

/**
 * The pinned item for this line, or null. The pin counts only for a code the
 * line still looks up; a pinned item that is gone or inactive loses its pin
 * (the caller then resolves as usual). A failed read leaves the pin alone.
 */
async function pinnedItem({ key, entry, codes }) {
  if (!enabled() || !entry || typeof entry !== 'object' || !entry.automayt_item_id) return null;
  const want = new Set((codes || []).filter(Boolean).map(norm));
  if (!want.has(norm(entry.automayt_item_for))) return null;
  let item;
  try { item = await deps.getItem(entry.automayt_item_id); } catch (e) {
    console.warn(`[automayt-settle] pin ${key} → ${entry.automayt_item_id} not checked: ${e.message}`);
    return null;
  }
  if (item && !erp().isInactiveItem(item)) return item;
  const why = item ? 'is inactive' : 'no longer exists';
  try {
    rewrite(key, (e) => { delete e.automayt_item_id; delete e.automayt_item_for; return e; });
    audit({ action: 'automayt-pin-dropped', key, itemId: entry.automayt_item_id, why });
  } catch (e) { console.warn(`[automayt-settle] could not drop stale pin ${key}: ${e.message}`); }
  return null;
}

const SUBMIT_PICK = {
  name: 'submit_pick',
  description: 'Submit your answer. Call exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['pick', 'cannot_tell'] },
      item_id: { type: 'string', description: 'The id of the candidate this order line is; "" when cannot_tell' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', description: 'One or two plain sentences: what tells the candidates apart and why this one, or what is missing' },
    },
    required: ['decision', 'item_id', 'confidence', 'reason'],
    additionalProperties: false,
  },
};

const PICK_SYSTEM = `You settle a stuck order line for Custom Flooring Centres (CFC) / YourFloors, a Canadian flooring and tile-supplies retailer. Our ERP, Automayt, has several items that answer the same product code, so the order can't be put on its sales order and Prosol purchase order until one is chosen.

Usual causes: an item migrated from Salesforce and the same product imported from the Prosol catalogue (true duplicates), two pack sizes or colours sharing a code, or a per square foot item next to a per carton/each item.

Compare the order line (SKU, title, quantity, the unit price the customer paid) with each candidate (description, stocking unit, cost, retail price, vendor, dates). The unit price is per order unit: compare it with each candidate's retail price per stocking unit (box_quantity is the coverage of a per sq ft item).

Rules:
- Pick only when the evidence says which item this order line is: same product, size, colour and pack, in the unit the customer bought.
- When candidates are the same product (true duplicates), either is right: pick the one with a cost from the vendor we buy it from (Prosol for a Prosol code), most recently updated.
- If you can't tell, answer cannot_tell and say what is missing. A wrong pick puts the wrong item on the purchase order.
- Your tools only read. A few targeted lookups at most, then submit_pick.`;

function pickContent({ code, line, candidates }) {
  return [
    `Order line: SKU ${line.sku || '(none)'}, title "${line.title || ''}", quantity ${line.qty}${line.unitPrice != null ? `, unit price paid ${line.unitPrice}` : ''}.`,
    `Code ${code} matches ${candidates.length} Automayt items:`,
    ...candidates.map((c) => JSON.stringify(erp().itemSummary(c))),
  ].join('\n');
}

/**
 * Pick one of the items a code matches. line: { sku, title, qty, unitPrice }.
 * key/entry: the line's sku-map entry, pinned on success when code is its own.
 * Returns { item, reason, pinned } or { reason } (the line stays stuck).
 */
async function pickAmbiguous({ key, entry, code, line, candidates }) {
  if (!enabled()) return { reason: OFF, off: true };
  const now = deps.now();
  const live = (candidates || []).filter((c) => c && c.id && !erp().isInactiveItem(c));
  if (!live.length) return { reason: 'every candidate is inactive' };
  const qkey = `${norm(code)}|${live.map((c) => c.id).sort().join(',')}`;
  const prior = recall('itemPicks', qkey);
  let pick;
  if (prior && prior.outcome === 'picked' && live.some((c) => c.id === prior.itemId)) {
    pick = prior;
  } else if (freshNo(prior, now)) {
    return { reason: prior.reason };
  } else if (live.length === 1) {
    pick = { itemId: live[0].id, confidence: 'high', reason: `the only active item of the ${candidates.length}` };
  } else {
    if (!takeBudget(now)) return { reason: 'Opus budget for this pass is used up; next pass' };
    const session = prosolSession();
    let ans = null;
    let err = null;
    try {
      ans = await deps.ai({
        system: PICK_SYSTEM,
        tools: ['prosol_lookup', 'skumap_search', 'shopify_search'],
        extraTools: [SUBMIT_PICK],
        submit: 'submit_pick',
        content: pickContent({ code, line, candidates: live }),
        ctx: { prosolLookup: session.lookup },
      });
    } catch (e) { err = e; } finally { await session.close(); }
    if (!ans) return { reason: noAnswer(err) }; // not remembered: asked again next pass
    const base = { at: now.toISOString(), code, key: key || null, title: line.title || null, confidence: ans.confidence, reason: ans.reason };
    if (ans.decision !== 'pick' || !live.some((c) => c.id === ans.item_id)) {
      const rec = { ...base, outcome: 'cannot_tell', reason: `Opus can't tell: ${ans.reason}` };
      remember('itemPicks', qkey, rec);
      return { reason: rec.reason };
    }
    if (!resolver.AUTO_CONFIDENCE.has(ans.confidence)) {
      const rec = { ...base, outcome: 'low_confidence', itemId: ans.item_id, reason: `Opus leans to ${ans.item_id} with ${ans.confidence} confidence only: ${ans.reason}` };
      remember('itemPicks', qkey, rec);
      return { reason: rec.reason };
    }
    pick = { ...base, outcome: 'picked', itemId: ans.item_id };
    remember('itemPicks', qkey, pick);
  }
  const item = live.find((c) => c.id === pick.itemId);
  const g = validateMapping(line.title, item.description);
  if (!g.ok || !g.verified) return { reason: `pick ${label(item)} failed the mapping guard: ${g.reason}` };
  let pinned = false;
  if (correctable(key, entry, code) && entry.automayt_item_id !== item.id) {
    try {
      rewrite(key, (e) => ({ ...e, automayt_item_id: item.id, automayt_item_for: code }));
      pinned = true;
      audit({ action: 'automayt-twin-pinned', key, code, itemId: item.id, item: label(item), confidence: pick.confidence, reason: pick.reason });
    } catch (e) { console.warn(`[automayt-settle] could not pin ${key} → ${item.id}: ${e.message}`); }
  }
  return { item, reason: pick.reason, pinned };
}

// ── 2. missing cost ──────────────────────────────────────────────────────────

const SUBMIT_COST = {
  name: 'submit_prosol_sku',
  description: 'Submit your answer. Call exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['found', 'not_found'] },
      api_sku: { type: 'string', description: 'The Prosol storefront SKU, exactly as prosol_lookup takes it; "" when not_found' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', description: 'One or two plain sentences: which lookup found it and why it is the same product, or what is missing' },
    },
    required: ['decision', 'api_sku', 'confidence', 'reason'],
    additionalProperties: false,
  },
};

const COST_SYSTEM = `You fix a sku-map entry for Custom Flooring Centres (CFC) / YourFloors, a Canadian flooring and tile-supplies retailer that drop-ships from its distributor Prosol.

An order line's product is mapped to Prosol, but looking it up in Prosol by the mapped code returned no product, so we have no cost and can't create the item in our ERP. Usually the entry carries the wrong storefront SKU: Prosol's storefront SKU (api_sku) and its vendor code (prosol_sku) often differ (Sigma 4EN is vendor code SIGMA4EN; Aqua Mix C030882-4 is vendor code C030882-01), or a slash or leading zero was lost.

Find the Prosol storefront SKU of this exact product: prosol_lookup takes a storefront SKU and returns its vendor code, name and cost; prosol_search finds products by words. Answer found only when prosol_lookup on your api_sku returns one product whose prosol_sku is the vendor code given and whose name is the product the order line names (same size, colour and pack). Otherwise answer not_found and say what is missing.

Never estimate or suggest a cost: code reads the cost from Prosol by your api_sku after you answer. Your tools only read. A few targeted lookups, then submit_prosol_sku.`;

/** Pure re-check of Opus's answer against Prosol's own record. Returns { info } or { reason }. */
function decideCostFix({ code, title, apiSku, info }) {
  if (!info) return { reason: `Prosol has no product with SKU ${apiSku}` };
  if (info.ambiguous) return { reason: `Prosol has ${info.count} products with SKU ${apiSku}` };
  if (info.sku !== apiSku) return { reason: `Prosol answered ${info.sku} for ${apiSku}` };
  if (!info.prosol_sku || norm(info.prosol_sku) !== norm(code)) return { reason: `Prosol's vendor code for ${apiSku} is ${info.prosol_sku || 'missing'}, the item is ${code}` };
  if (!(Number(info.cost_cad) > 0)) return { reason: `Prosol gave no cost for ${apiSku}` };
  const g = validateMapping(title, info.name);
  if (!g.ok || !g.verified) return { reason: `order title vs Prosol "${info.name}": ${g.reason}` };
  return { info };
}

/**
 * Find the Prosol cost an item is missing. key/entry: the sku-map entry the
 * item is created from; code: the Prosol vendor code it is created under;
 * title: the order line title (falls back to the entry's product).
 * Returns { cost, retail, source } or { reason } (the caller refuses as today).
 */
async function fixMissingCost({ key, entry, code, title }) {
  if (!enabled()) return { reason: OFF, off: true };
  if (!correctable(key, entry, code)) return { reason: 'no single sku-map entry for this code to correct' };
  const now = deps.now();
  const qkey = `${key}|${norm(code)}`;
  const prior = recall('costFixes', qkey);
  if (freshNo(prior, now)) return { reason: prior.reason };
  if (!takeBudget(now)) return { reason: 'Opus budget for this pass is used up; next pass' };
  const against = title || entry.product;
  const session = prosolSession();
  try {
    let ans = null;
    let err = null;
    try {
      ans = await deps.ai({
        system: COST_SYSTEM,
        tools: ['prosol_lookup', 'prosol_search', 'skumap_search'],
        extraTools: [SUBMIT_COST],
        submit: 'submit_prosol_sku',
        content: [
          `sku-map entry ${key}: api_sku ${entry.api_sku || '(none)'}, prosol_sku ${entry.prosol_sku || '(none)'}, product "${entry.product || ''}".`,
          `Order line title: ${against || '(none)'}`,
          `The item is created under Prosol vendor code ${code}; Prosol returned no product for that code.`,
        ].join('\n'),
        ctx: { prosolLookup: session.lookup, prosolSearch: session.search },
      });
    } catch (e) { err = e; }
    if (!ans) return { reason: noAnswer(err) };
    const base = { at: now.toISOString(), key, code, confidence: ans.confidence, apiSku: ans.api_sku || null };
    const no = (reason) => { remember('costFixes', qkey, { ...base, outcome: 'not_fixed', reason }); return { reason }; };
    if (ans.decision !== 'found' || !ans.api_sku) return no(`Opus could not find it in Prosol: ${ans.reason}`);
    if (!resolver.AUTO_CONFIDENCE.has(ans.confidence)) return no(`Opus found ${ans.api_sku} with ${ans.confidence} confidence only: ${ans.reason}`);
    let check;
    try {
      check = decideCostFix({ code, title: against, apiSku: ans.api_sku, info: await session.lookup(ans.api_sku) });
    } catch (e) { return { reason: `Prosol re-check failed: ${e.message.slice(0, 120)}` }; }
    if (check.reason) return no(check.reason);
    const { info } = check;
    const day = now.toISOString().slice(0, 10);
    let writeError = null;
    try {
      rewrite(key, (e) => ({
        ...e,
        api_sku: info.sku,
        cost_cad: info.cost_cad,
        ...(info.retail_cad != null ? { retail_cad: info.retail_cad } : {}),
        cost_source: 'prosol-offers-loc10010',
        note: `${e.note ? `${e.note} ` : ''}Cost fixed ${day} by sku-resolver (Opus, ${ans.confidence} confidence): Prosol lists it as ${info.sku} ("${info.name}", vendor code ${info.prosol_sku})${e.api_sku && e.api_sku !== info.sku ? `, was api_sku ${e.api_sku}` : ''}.`.slice(0, 1200),
      }));
    } catch (e) {
      // The cost is still Prosol's own; only the sku-map correction is lost.
      writeError = e.message;
      console.warn(`[automayt-settle] cost for ${key} found but the sku-map write failed: ${e.message}`);
    }
    remember('costFixes', qkey, { ...base, outcome: 'fixed', cost: info.cost_cad, reason: ans.reason, ...(writeError ? { writeError } : {}) });
    audit({ action: 'automayt-cost-fixed', key, code, apiSku: info.sku, was: entry.api_sku || null, cost: info.cost_cad });
    return { cost: Number(info.cost_cad), retail: info.retail_cad != null ? Number(info.retail_cad) : null, source: 'prosol-offers-loc10010' };
  } finally {
    await session.close();
  }
}

module.exports = {
  pinnedItem, pickAmbiguous, fixMissingCost, decideCostFix,
  deps, MAX_PER_PASS,
  _resetBudget: () => { pass = { start: 0, used: 0 }; },
};
