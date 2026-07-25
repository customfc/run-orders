#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const https = require('https');
const fs = require('fs');
const path = require('path');
const { ProsolClientV2 } = require('./prosol-client-v2');
const cableSku = require('../../lib/cable-sku');
const { planPackages } = require('../../lib/package-split');
const { validateMapping } = require('../../lib/mapping-guard');

// Airtight mapping guard: before staging an order, confirm the Prosol code we
// resolved is the same product/size the customer actually ordered — comparing
// the SF item description for the prosol_sku against the order line's name.
// Returns a HALT reason on a genuine mismatch, else null. Fail-safe: any SF
// error returns null so a transient issue never blocks the whole run. Built
// after order 701-1443245 shipped a Quart of "Grout Haze Remover" for a Pint of
// "Grout Haze Clean-Up" (sku-map mislabeled). See lib/mapping-guard.js.
const _guardSfCache = new Map();
async function checkMappingGuard(resolvedItems) {
  try {
    const sf = require('../../lib/salesforce');
    let conn = null;
    for (const item of resolvedItems) {
      const code = String(item.prosolSku || '').trim();
      if (!code) continue;
      if (!_guardSfCache.has(code)) {
        conn = conn || await sf.connect();
        const recs = await sf.query(conn, `SELECT PBSI__description__c FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '${code.replace(/'/g, '')}' LIMIT 1`);
        _guardSfCache.set(code, recs[0] ? recs[0].PBSI__description__c : null);
      }
      const sfProduct = _guardSfCache.get(code);
      if (!sfProduct) continue; // code not stocked in SF — can't verify here (Prosol-API pass covers these); don't block
      const v = validateMapping(item.name, sfProduct);
      if (!v.ok) return `Mapping guard HALT — ordered "${item.name}" but ${code} is "${sfProduct}": ${v.reason}`;
    }
    return null;
  } catch (e) {
    return null; // never block staging on a guard/SF error
  }
}

const SS_KEY = process.env.SHIPSTATION_API_KEY;
const SS_SECRET = process.env.SHIPSTATION_API_SECRET;

if (!SS_KEY || !SS_SECRET) {
  throw new Error('Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET');
}
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
const SS_HOST = 'ssapi.shipstation.com';

const SKU_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'sku-map.json'), 'utf8'));
const SKU_MAPPINGS = SKU_MAP.mappings || {};
const LOCATION_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'prosol-location-map.json'), 'utf8'));

const NON_PROSOL_MARKERS = new Set(['NON_PROSOL', 'SKIP']);
const PERFECT_LEVEL_RE = /perfect\s+level/i;
// DEPRECATED 2026-06-30: MAIN_HUBS / DEPRIORITIZED_LOCS / REGION_TIER_OVERRIDES /
// effectiveRegionForOrder no longer drive routing. determineWarehouse now ranks
// branches by distance to the delivery postal (postalLatLng) and picks the
// nearest in-stock one. Kept for reference/rollback; safe to remove later.
const MAIN_HUBS = {
  BC: [10010, 10003, 10054, 10007, 10022, 10023, 10026, 10031, 10034, 10038, 10044, 10045, 10055],
  AB: [10054, 10010, 10003, 10049, 10011, 10018, 10019, 10036],
  SK: [10054, 10049, 10010, 10037, 10039],
  MB: [10049, 10054, 10010],
  ON: [10001, 10028, 10013, 10024, 10027, 10032, 10043, 10017, 10021, 10025, 10040, 10041, 10048, 10052],
  QC: [10004, 10001, 10028, 10032, 10027, 10013, 10024, 10043, 10014, 10035, 10051],
  NB: [10004, 10001, 10032, 10027, 10029],
  NS: [10004, 10001, 10032, 10027, 10016],
  PE: [10004, 10001, 10032, 10027, 10016, 10029],
  NL: [10004, 10001, 10032, 10027, 10016],
  YT: [10010, 10003, 10054],
  NT: [10054, 10010, 10003, 10049],
  NU: [10049, 10054, 10001],
};
// Vancouver Island region inherits BC's hub membership; tier classification
// is rewritten via REGION_TIER_OVERRIDES below.
MAIN_HUBS.BCI = MAIN_HUBS.BC;

// B-tier hubs: technically preferred for the province but operationally slow
// (poor pack-turnaround, repeated phantom-pickup bindings, retail-style
// outlets that route through Kaitlyn at Concord rather than direct, etc).
// Considered only after every A-tier hub fails the stock check, and pushed
// to the bottom of the distance-fallback ranking.
//   10004 = WGRF (Saint-Laurent) — chronically slow turnaround.
//   10007–10055 (excl. main hubs) = Prosol retail-style outlets newly
//     wired into routing 2026-05-06; default B-tier until proven reliable.
const DEPRIORITIZED_LOCS = new Set([
  10004,
  // BC retail outlets
  10007, 10022, 10023, 10026, 10031, 10034, 10038, 10044, 10045, 10055,
  // AB retail outlets
  10011, 10018, 10019, 10036,
  // SK retail outlets
  10037, 10039,
  // ON retail outlets
  10017, 10021, 10025, 10040, 10041, 10048, 10052,
  // QC retail outlets
  10014, 10035, 10051,
  // Atlantic retail outlets
  10016, 10029,
]);

// Region-specific tier overrides. Lets a hub be A-tier in one shipping
// region and B-tier in another (e.g. NANA/VICT are global-B-tier "retail
// outlets" but for Vancouver Island shipping they're the preferred hubs;
// BURN/COQL/WCAS are flipped to B-tier so the picker only ferries to the
// mainland when the island is dry).
const REGION_TIER_OVERRIDES = {
  BCI: {
    promote: new Set([10031, 10045]),         // NANA, VICT → A-tier on the island
    demote:  new Set([10010, 10003, 10054]),  // BURN, COQL, WCAS → B-tier (mainland fallback)
  },
};

// Vancouver Island FSAs (as of 2026):
//   V8L–V8Z (Greater Victoria, excluding mainland V8A/V8B/V8C/V8E/V8G/V8J)
//   V9A–V9Y (mid + north island: Esquimalt, Duncan, Nanaimo, Comox, Campbell River, Port Alberni)
//   V0R, V0S (north + west island: Tofino, Ucluelet, Port Hardy)
const VANCOUVER_ISLAND_FSA_RE = /^V(?:8[KLMNPRSTVWXYZ]|9[A-Y]|0[RS])/;

function effectiveRegionForOrder(province, postalCode) {
  if (province === 'BC') {
    const p = String(postalCode || '').replace(/\s/g, '').toUpperCase();
    if (VANCOUVER_ISLAND_FSA_RE.test(p)) return 'BCI';
  }
  return province;
}

// CP-hint regex: forces canada_post_walleted carrier when the address signals
// a postal-only delivery point. Original was PO Box only; extended 2026-05-22
// after order #1259 was misrouted to Purolator with "Canada Post box number"
// in address2 (customer ended up chasing the package at a Purolator depot).
const CP_HINT_RE = /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box|canada\s+post|postal\s+(?:box|outlet)|rpo|bo[iî]te\s+postale)\b/i;

// UPS routing kill-switch (Mac, 2026-07-06): UPS-from-ShipStation pickups have
// been dead since 2026-06-19 (UPS billing error 9500782 on every booking —
// ShipStation case open), so every UPS label strands at the Prosol branch
// until someone books a pickup manually on ups.com. Route everything Purolator
// until the wallet is fixed or we have our own UPS account for pickups.
// UPS remains the fallback ONLY when Purolator returns no rate at all.
const UPS_ROUTING_DISABLED = true;

// Canada Post price-override threshold (Mac, 2026-07-24). CP is PO-box-only by
// default (unreliable depot pickups), but when Purolator/UPS beat CP by less
// than nothing — i.e. CP is this many dollars CHEAPER — the rural-surcharge gap
// is too big to ignore and we route CP despite the manual-handoff cost. Tune here.
const CP_PRICE_OVERRIDE_GAP = 20;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function httpsRequest(options, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${options.method || 'GET'} ${options.path}`));
    });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function ssRequest(method, endpoint, body = null) {
  const res = await httpsRequest({
    hostname: SS_HOST,
    path: endpoint,
    method,
    headers: {
      Authorization: `Basic ${SS_AUTH}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  }, body);

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
    await sleep(retryAfter * 1000);
    return ssRequest(method, endpoint, body);
  }
  return res;
}

async function fetchAwaitingOrders() {
  const orders = [];
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const res = await ssRequest('GET', `/orders?orderStatus=awaiting_shipment&pageSize=100&page=${page}`);
    if (res.status !== 200) throw new Error(`ShipStation orders fetch failed: ${res.status} ${res.body.slice(0, 300)}`);
    const data = JSON.parse(res.body);
    orders.push(...(data.orders || []));
    pages = data.pages || 1;
    page += 1;
  }
  return orders;
}

function normalizeProvince(raw) {
  const value = String(raw || '').trim().toUpperCase();
  const map = {
    'BRITISH COLUMBIA': 'BC', BC: 'BC',
    'ALBERTA': 'AB', AB: 'AB',
    'SASKATCHEWAN': 'SK', SK: 'SK',
    'MANITOBA': 'MB', MB: 'MB',
    'ONTARIO': 'ON', ON: 'ON',
    'QUEBEC': 'QC', 'QUÉBEC': 'QC', QC: 'QC', PQ: 'QC',
    'NEW BRUNSWICK': 'NB', NB: 'NB',
    'NOVA SCOTIA': 'NS', NS: 'NS',
    'PRINCE EDWARD ISLAND': 'PE', PE: 'PE',
    'NEWFOUNDLAND AND LABRADOR': 'NL', 'NEWFOUNDLAND': 'NL', NL: 'NL',
    'YUKON': 'YT', YT: 'YT',
    'NORTHWEST TERRITORIES': 'NT', NT: 'NT',
    'NUNAVUT': 'NU', NU: 'NU',
  };
  return map[value] || null;
}

function normalizeShipTo(shipTo) {
  if (!shipTo) return shipTo;
  const normalized = normalizeProvince(shipTo.state);
  return normalized ? { ...shipTo, state: normalized } : shipTo;
}

function toLb(weight) {
  if (!weight || !Number.isFinite(Number(weight.value))) return 1;
  const value = Number(weight.value);
  const units = String(weight.units || '').toLowerCase();
  if (units.startsWith('gram')) return value / 453.59237;
  if (units.startsWith('kil')) return value * 2.2046226218;
  if (units.startsWith('ounce')) return value / 16;
  return value;
}

function formatMoney(value) {
  return value == null ? '—' : `$${Number(value).toFixed(2)}`;
}

function orderDestination(order) {
  const shipTo = order.shipTo || {};
  return [shipTo.name, shipTo.city, normalizeProvince(shipTo.state) || shipTo.state, (shipTo.postalCode || '').trim()].filter(Boolean).join(', ');
}

function isAmazonOrder(order) {
  return order.advancedOptions?.source === 'amazon_ca';
}

// yourfloors.ca ShipStation store id. Any order with this storeId is a Shopify
// order regardless of `advancedOptions.source` value.
const YOURFLOORS_STORE_ID = 798860;

function isShopifyOrder(order) {
  // ShipStation stamps `advancedOptions.source` with the Shopify channel id:
  // "web" for the main storefront, but a numeric channel id for other channels
  // (mobile apps, draft orders, custom integrations). Match by storeId too —
  // fixed 2026-05-22 after yourfloors #1264 (source="3890849") sat in
  // awaiting_shipment for 2 days because the "web"-only check filtered it out.
  return order.advancedOptions?.source === 'web'
    || order.advancedOptions?.storeId === YOURFLOORS_STORE_ID;
}

function orderSource(order) {
  if (isAmazonOrder(order)) return 'amazon_ca';
  if (isShopifyOrder(order)) return 'shopify';
  return order.advancedOptions?.source || 'unknown';
}

// Orders the pipeline will process. Amazon CA + Shopify/web.
function isInScope(order) {
  return isAmazonOrder(order) || isShopifyOrder(order);
}

function isClearlyOutOfScope(itemName = '') {
  const name = itemName.toLowerCase();
  return /(click\s+vinyl|luxury\s+vinyl|laminate\s+floor|hardwood\s+floor|engineered\s+hardwood|sheet\s+vinyl|floor\s+protection)/i.test(name);
}

function resolveMappedEntry(rawSku) {
  return SKU_MAPPINGS[rawSku];
}

// Persist a new mapping into sku-map.json by inserting it at the top of
// "mappings" as a new key — preserves the file's existing key order and \u
// escaping (a full re-serialize would reorder numeric keys). Validates before write.
function persistMappingToFile(key, entry) {
  const MAP_PATH = path.join(__dirname, 'sku-map.json');
  const raw = fs.readFileSync(MAP_PATH, 'utf8');
  const anchor = '  "mappings": {\n';
  const at = raw.indexOf(anchor);
  if (at < 0) throw new Error('mappings anchor not found in sku-map.json');
  const indented = JSON.stringify(entry, null, 2).split('\n').map((l, i) => (i === 0 ? l : '    ' + l)).join('\n');
  let block = `    ${JSON.stringify(key)}: ${indented},\n`;
  block = block.replace(/[-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const out = raw.slice(0, at + anchor.length) + block + raw.slice(at + anchor.length);
  JSON.parse(out); // throws if the insert produced invalid JSON — never write a broken map
  fs.writeFileSync(MAP_PATH, out);
}

// Add a mapping LIVE: mutate the in-memory map (next staging run sees it without
// a restart) AND persist to disk (survives restart). Used by /map + (future) auto-map.
function liveAddMapping(key, entry) {
  SKU_MAPPINGS[key] = entry;
  persistMappingToFile(key, entry);
}

// Pull a SKU-shaped trailing token from an Amazon listing title.
// Many Schluter / Mapei listings end with " - <SKU>" where SKU is the canonical
// product code (e.g. "... - KL1V60E60", "... - DHEHK24043"). When present this
// is the ground truth — more reliable than ASIN→prosol_sku lookups, which have
// historically been mis-curated (see /docs incident 2026-04-29 KL1V60E60→KL1DRE60
// where a $400 channel body was shipped as a $166 grate). Returns null when no
// trailing SKU is detectable so callers fall back to the map.
function extractTrailingSku(name) {
  const text = String(name || '').trim();
  const m = text.match(/[\s\-,]\s*([A-Z][A-Z0-9/\-]{4,30})\s*$/);
  if (!m) return null;
  const sku = m[1].replace(/[\-/]$/, '');
  if (sku.length < 5) return null;
  if (!/[A-Z]/.test(sku) || !/\d/.test(sku)) return null;
  return sku;
}

function normalizeSkuForCompare(s) {
  return String(s || '').toUpperCase().replace(/[\s\-/]/g, '');
}

// Returns a string reason if the title's trailing SKU clearly differs from the
// mapped prosol/api SKU; null when they match or when the title has no SKU
// suffix to validate against.
function titleSkuMismatchReason(itemName, mappedSku) {
  const extracted = extractTrailingSku(itemName);
  if (!extracted) return null;
  const a = normalizeSkuForCompare(extracted);
  const b = normalizeSkuForCompare(mappedSku);
  if (!a || !b) return null;
  if (a === b) return null;
  // Substring match handles formatting variants: "KEBA100/125/10M" vs
  // "KEBA10012510M", "DHERT102/BW" vs "DHERT102BW", "KL1V60E60" vs "KL1V60E60-FBA".
  if (a.includes(b) || b.includes(a)) return null;
  return `title says "${extracted}" but sku-map points to "${mappedSku}"`;
}

// ── Prosol SUGGEST-only candidate search ─────────────────────────────────────
// When staging can't resolve a SKU, search Prosol's catalog by the product
// title and surface the top matches (api_sku + prosol_sku + name-with-size +
// stock) in the manualReview alert, so a human resolves the sku-map entry in
// one tap instead of logging into Prosol. This NEVER writes the sku-map and
// NEVER feeds the buy/PO path — the human always picks, so a wrong size/variant
// candidate can never become a wrong PO. Size is not a structured field on the
// storefront endpoint (it lives in the product name tail, e.g. "... - 946 mL"),
// so we surface the full name and tell the human to confirm size against title.
const SUGGEST_MAX_CANDIDATES = 5;

function prosolProductName(p) {
  return typeof p.name === 'object' ? (p.name?.en || p.name?.fr || '') : (p.name || '');
}

// Trailing SKU in the title is ground truth (often a direct hit); else a
// CLEANED title — the raw Amazon title (parentheticals, sizes, marketing words)
// produces poor fuzzy results, so strip size/unit tokens + parentheticals and
// cap to the first few significant words (brand + product line + variant).
// Never search the seller SKU (ASIN/Shopify id) — it isn't in Prosol's catalog.
const SUGGEST_SIZE_TOKEN_RE = /\b\d+(?:\.\d+)?\s?(?:ml|mL|l|litre|liter|oz|fl\s?oz|qt|quart|gal|gallon|lb|lbs|kg|g|mm|cm|sq\s?ft|sqft|ft|in|")\b/gi;
function buildSuggestQuery({ name, sku } = {}) {
  const trailing = extractTrailingSku(name);
  if (trailing) return trailing;
  let q = String(name || '').trim();
  if (q) {
    q = q.replace(/\([^)]*\)/g, ' ')          // drop parentheticals
         .replace(SUGGEST_SIZE_TOKEN_RE, ' ') // drop size/unit tokens
         .replace(/[®™]/g, ' ')
         .replace(/\s*[-–]\s*/g, ' ')         // separators → space
         .replace(/\s+/g, ' ').trim();
    const words = q.split(' ').filter(Boolean).slice(0, 6); // brand + line + variant
    if (words.length) return words.join(' ');
  }
  return sku && sku !== 'UNKNOWN' ? sku : null;
}

// One Prosol search → up to N candidate lines. Returns [] on any miss/garbage.
// Caller spaces calls (shared Prosol account). Ranks SKU/name token hits to the
// top but NEVER collapses to one — the human decides.
async function suggestProsolCandidates(client, query) {
  if (!query) return [];
  const res = await client.apiGet(`/api/storefront/products?search=${encodeURIComponent(query)}&limit=20`);
  if (!res || res.status !== 200) return [];
  let products;
  try { const d = JSON.parse(res.body); products = d.data || d; } catch { return []; }
  if (!Array.isArray(products) || !products.length) return [];
  const seen = new Set();
  const qNorm = normalizeSkuForCompare(query);
  // Rank by query-word overlap with the candidate name (so the model number,
  // variant/color word, etc. float the right product to the top), with a strong
  // bonus for an exact SKU token hit. Convenience only — never collapses to one.
  const qWords = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = products
    .filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; }) // de-dupe EN/FR by id
    .map((p) => {
      const name = prosolProductName(p);
      const lname = name.toLowerCase();
      const overlap = qWords.reduce((n, w) => n + (lname.includes(w) ? 1 : 0), 0);
      const skuHit = qNorm && (normalizeSkuForCompare(p.sku).includes(qNorm)
        || normalizeSkuForCompare(p.prosol_sku).includes(qNorm)
        || normalizeSkuForCompare(name).includes(qNorm));
      return { p, name, score: (skuHit ? 100 : 0) + overlap };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, SUGGEST_MAX_CANDIDATES).map(({ p, name }) => ({
    apiSku: p.sku || null,
    prosolSku: p.prosol_sku || null,
    name,
    stock: p.stock_status || 'unknown',
  }));
}

function renderSuggestLines(query, candidates) {
  if (!candidates.length) return `\n\nProsol search ("${query}"): no candidates — map manually.`;
  const lines = candidates.map((c, i) =>
    `  ${i + 1}. ${c.name || '(no name)'}\n     api_sku=${c.apiSku || '?'}  prosol_sku=${c.prosolSku || '?'}  [${c.stock}]`);
  return `\n\nProsol candidates for "${query}" (confirm SIZE/variant against the title before adding to sku-map):\n${lines.join('\n')}`;
}

// Schluter DITRA-HEAT cable resolution now lives in lib/cable-sku.js so the
// PO path shares it. These thin wrappers bind the sku-map's cable_lookup table.
const extractDhehkSkuFromName = cableSku.extractDhehkSkuFromName;
const extractCableSku = (name) => cableSku.extractCableSku(name, SKU_MAP.cable_lookup);

function resolveOrderItems(order) {
  const resolved = [];
  const fixedWarehouseItems = [];
  const failures = [];
  // Structured subset of `failures`, for the Prosol suggest-step: only the
  // SKU-bearing cases where a Prosol catalog search by title can surface the
  // correct SKU. Each { sku, name } feeds buildSuggestQuery. Province/routing/
  // mixed/HALT/bundle/cable failures are intentionally NOT collected here.
  const failureItems = [];
  for (const item of (order.items || [])) {
    const sku = item.sku || 'UNKNOWN';
    const mapped = resolveMappedEntry(sku);
    const base = { sku, name: item.name || sku, qty: item.quantity || 1, original: item };
    const displayName = item.name || mapped?.product || sku;

    if (!mapped) {
      // Unknown ASIN — try to recover a Schluter cable SKU from the title
      // before giving up. Catches new cable-kit ASINs that haven't been
      // added to the map yet.
      const dhehkSku = extractDhehkSkuFromName(item.name);
      if (dhehkSku) {
        resolved.push({ ...base, kind: 'prosol', apiSku: dhehkSku, label: `${item.name || sku} → ${dhehkSku}` });
        continue;
      }
      failures.push(`No sku-map entry for ${sku} (${item.name || 'unnamed item'})`);
      failureItems.push({ sku, name: item.name || null });
      continue;
    }

    if (typeof mapped === 'string') {
      if (mapped === 'SKIP') continue;
      if (PERFECT_LEVEL_RE.test(displayName)) {
        failures.push(`Perfect Level requires explicit non-Prosol routing before automation (${displayName})`);
        continue;
      }
      resolved.push({ ...base, kind: 'prosol', apiSku: mapped, label: item.name || sku });
      continue;
    }

    if (mapped.api_sku === 'SKIP') continue;

    // HALT_* sentinel — sku-map explicitly flags this ASIN as unsourceable
    // (e.g. customer-facing SKU not stocked at any Prosol location). Forces
    // human decision before we accidentally ship the wrong product.
    const apiHalt = typeof mapped.api_sku === 'string' && mapped.api_sku.startsWith('HALT_');
    const proHalt = typeof mapped.prosol_sku === 'string' && mapped.prosol_sku.startsWith('HALT_');
    if (apiHalt || proHalt) {
      failures.push(`${sku} flagged HALT (${mapped.api_sku}/${mapped.prosol_sku}) — ${mapped.note || 'manual review required before shipping'}`);
      continue;
    }

    if (mapped.api_sku === 'UNMAPPED' || mapped.api_sku === 'UNMAPPED_GROUT') {
      failures.push(`Manual lookup required for ${sku} (${mapped.product || item.name || sku})`);
      failureItems.push({ sku, name: mapped.product || item.name || null });
      continue;
    }

    if (mapped.api_sku === 'UNMAPPED_CABLE') {
      const cableModel = extractCableSku(item.name);
      if (!cableModel) {
        failures.push(`Cable SKU unresolved from title for ${sku} (${item.name || sku})`);
        continue;
      }
      resolved.push({ ...base, kind: 'prosol', apiSku: cableModel, label: `${mapped.product || item.name} → ${cableModel}` });
      continue;
    }

    if (mapped.bundle) {
      if (!Array.isArray(mapped.components) || mapped.components.length === 0) {
        failures.push(`Bundle mapping malformed for ${sku}`);
        continue;
      }
      for (const comp of mapped.components) {
        let compSku = comp.api_sku;
        let compProduct = comp.product;
        // A kit's cable component is variant-specific (model varies by order),
        // so it's flagged UNMAPPED_CABLE. Resolve it from the order title the
        // same way the standalone cable listing does — the Amazon title ends
        // with the DHEHK model number.
        if (compSku === 'UNMAPPED_CABLE') {
          const cableModel = extractCableSku(item.name);
          if (!cableModel) {
            failures.push(`Bundle cable unresolved from title for ${sku} (${item.name || sku})`);
            continue;
          }
          compSku = cableModel;
          compProduct = `Schluter cable ${cableModel}`;
        }
        if (!compSku || String(compSku).startsWith('UNMAPPED')) {
          failures.push(`Bundle component unresolved for ${sku} (${comp.product || comp.api_sku || 'unknown'})`);
          continue;
        }
        // comp.qty is a per-bundle multiplier (e.g. a 2-pack bundle needs 2x the
        // component per unit ordered) — matches resolveSkuForPO's qty handling
        // in lib/amazon-po.js so PO quantity and Prosol inventory/routing agree.
        const compQty = (Number(comp.qty) || 1) * (Number(base.qty) || 1);
        resolved.push({ ...base, kind: 'prosol', apiSku: compSku, qty: compQty, label: `${mapped.product || item.name} / ${compProduct || compSku}` });
      }
      continue;
    }

    if (NON_PROSOL_MARKERS.has(mapped.api_sku)) {
      if (mapped.shipstation_warehouse_id) {
        fixedWarehouseItems.push({
          ...base,
          kind: 'fixed-warehouse',
          warehouseId: Number(mapped.shipstation_warehouse_id),
          routeTo: mapped.route_to || null,
          label: mapped.product || item.name || sku,
        });
      } else {
        failures.push(`Non-Prosol item has no deterministic warehouse route: ${mapped.product || item.name || sku}`);
      }
      continue;
    }

    if (PERFECT_LEVEL_RE.test(mapped.product || displayName)) {
      failures.push(`Perfect Level requires explicit non-Prosol routing before automation (${mapped.product || displayName})`);
      continue;
    }

    // Title-vs-map sanity check: if the order's product name carries an
    // explicit trailing SKU (e.g. "... - KL1V60E60"), that's the ground
    // truth. Refuse to ship if the mapped prosol_sku is a different family.
    // This catches mis-curated mappings before they cost money.
    const finalSku = mapped.prosol_sku || mapped.api_sku;
    const mismatch = titleSkuMismatchReason(item.name, finalSku);
    if (mismatch) {
      failures.push(`${sku} title-vs-map mismatch: ${mismatch}`);
      failureItems.push({ sku, name: item.name || null });
      continue;
    }

    resolved.push({ ...base, kind: 'prosol', apiSku: mapped.api_sku, prosolSku: mapped.prosol_sku || mapped.api_sku, label: mapped.product || item.name || sku });
  }
  return { resolved, fixedWarehouseItems, failures, failureItems };
}

// Province centroids for distance-based fallback sorting
const PROVINCE_LAT_LNG = {
  BC: [49.28, -123.12], AB: [51.05, -114.07], SK: [50.45, -104.62], MB: [49.90, -97.14],
  ON: [43.65, -79.38], QC: [46.81, -71.21], NB: [46.09, -66.66], NS: [44.65, -63.57],
  PE: [46.24, -63.13], NL: [47.56, -52.71], YT: [60.72, -135.05], NT: [62.45, -114.37], NU: [63.75, -68.52],
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Approx lat/lng by postal FSA (forward-sortation area). 2-char prefix wins over
// 1-char; falls back to the province centroid. ShipStation doesn't geocode, so
// this lets routing rank branches by distance to the actual delivery address.
const FSA_LATLNG = {
  A:[47.56,-52.71], B:[44.65,-63.60], C:[46.25,-63.13], E:[46.09,-64.77],
  G:[46.81,-71.21], G4:[48.83,-64.49], G5:[48.45,-68.52], G7:[48.43,-71.07], G8:[48.43,-71.07],
  H:[45.51,-73.59],
  J:[45.55,-73.45], J1:[45.40,-71.89], J6:[45.78,-73.43], J7:[45.70,-73.95], J8:[45.48,-75.70], J9:[45.48,-75.70],
  K:[45.42,-75.70], L:[43.50,-79.70], M:[43.70,-79.40], N:[43.00,-81.25], P:[46.50,-81.00],
  R:[49.90,-97.14], S:[50.45,-104.62], S7:[52.13,-106.67],
  T:[51.05,-114.07], T5:[53.55,-113.49], T6:[53.55,-113.49], T7:[53.55,-113.49], T8:[53.55,-113.49], T9:[53.55,-113.49],
  V:[49.25,-123.10], X:[62.45,-114.37], Y:[60.72,-135.06],
};
function postalLatLng(postalCode, province) {
  const p = String(postalCode || '').replace(/\s/g, '').toUpperCase();
  return FSA_LATLNG[p.slice(0, 2)] || FSA_LATLNG[p[0]] || PROVINCE_LAT_LNG[province] || [45, -75];
}

// Units this order needs per SKU, keyed exactly like inventoryBySku
// (cacheKey = api_sku || prosol_sku). Summed across line items and bundle
// components so multi-line and multi-qty orders count correctly.
function requiredQtyBySku(order) {
  const req = {};
  for (const item of (order.resolvedItems || [])) {
    const key = item.apiSku || item.prosolSku;
    if (!key) continue;
    req[key] = (req[key] || 0) + (Number(item.qty) || 1);
  }
  return req;
}

// Quantity-aware branch scoring. Returns the branch's SURPLUS beyond what the
// order needs (min over SKUs of have - need), or -Infinity if the branch can't
// fully cover any single SKU's required qty. surplus >= 0 => branch can fulfill
// the whole order; higher = more headroom.
//
// Before 2026-07-09 this only checked qty >= 2 (then >= 1) and ignored the order
// quantity entirely, so a 5-roll order routed to the nearest branch holding a
// single unit (order 701-2156847 -> Richmond). The old qty>=2 "phantom last
// unit" guard (added for the 2026-04-21 702-7750339 -> Burnaby incident) was
// necessary but insufficient: it never scaled with order size.
function scoreWarehouseAgainstOrder(locId, inventoryBySku, requiredBySku) {
  let minSurplus = Infinity;
  for (const [key, entry] of Object.entries(inventoryBySku)) {
    const need = requiredBySku[key] || 0;
    const stock = entry.locationStock?.[locId];
    const have = (stock && stock.available) ? (Number(stock.quantity) || 0) : 0;
    if (have < need) return -Infinity; // can't cover this SKU's full quantity
    const surplus = have - need;
    if (surplus < minSurplus) minSurplus = surplus;
  }
  return minSurplus === Infinity ? 0 : minSurplus;
}

// Human-readable coverage summary, surfaced in the planning error when no single
// branch can fulfill the whole order so a person can split or source manually.
function summarizeCoverage(order, inventoryBySku) {
  const req = requiredQtyBySku(order);
  return Object.entries(req).map(([key, need]) => {
    const entry = inventoryBySku[key];
    let best = 0, total = 0;
    for (const s of Object.values(entry?.locationStock || {})) {
      const q = (s && s.available) ? (Number(s.quantity) || 0) : 0;
      total += q; if (q > best) best = q;
    }
    return `${key}: need ${need}, best branch ${best}, total ${total}`;
  }).join('; ');
}

// Customer-proximity routing (2026-06-30): rank every active Prosol branch by
// distance to the delivery postal and pick the nearest one that can fulfill the
// ENTIRE order. Replaces the province-centroid + A/B-tier scheme, which funneled
// the whole east to Ottawa. Quantity-aware since 2026-07-09: pass 1 wants the
// nearest branch that covers every SKU's required qty plus a 1-unit buffer (the
// phantom-last-unit guard, now scaled to order size); pass 2 falls back to exact
// coverage. If no single branch can cover the full quantity, returns null and the
// caller surfaces it for manual split/sourcing rather than mis-routing to a
// branch that is short. NOTE: the legacy MAIN_HUBS / DEPRIORITIZED_LOCS /
// REGION_TIER_OVERRIDES / effectiveRegionForOrder tables above are retained for
// reference but NO LONGER drive routing.
function determineWarehouse(order, inventoryBySku) {
  const requiredBySku = requiredQtyBySku(order);
  const [lat, lng] = postalLatLng(order.shipTo?.postalCode, order.normalizedProvince);
  // Active Prosol branches only (numeric ids; excludes non_prosol + the old_*
  // deleted-warehouse duplicates), ranked nearest-first to the delivery address.
  const branches = Object.entries(LOCATION_MAP)
    .filter(([id, loc]) => /^\d+$/.test(id) && loc.active && !loc.non_prosol && loc.lat && loc.shipstation_warehouse_id)
    .map(([id, loc]) => ({ prosolLocId: Number(id), location: loc, km: haversineKm(lat, lng, loc.lat, loc.lng) }))
    .sort((a, b) => a.km - b.km);

  // Pass 1: nearest branch that covers the whole order with >= 1 spare per SKU
  // (phantom-last-unit guard, scaled to the order quantity).
  for (const b of branches) {
    if (scoreWarehouseAgainstOrder(b.prosolLocId, inventoryBySku, requiredBySku) >= 1) {
      return { prosolLocId: b.prosolLocId, location: b.location };
    }
  }
  // Pass 2: nearest branch that exactly covers the whole order.
  for (const b of branches) {
    if (scoreWarehouseAgainstOrder(b.prosolLocId, inventoryBySku, requiredBySku) >= 0) {
      return { prosolLocId: b.prosolLocId, location: b.location };
    }
  }
  return null;
}

async function getRates(order, fromPostalCode) {
  const bodyBase = {
    packageCode: 'package',
    fromPostalCode: fromPostalCode.replace(/\s/g, ''),
    toPostalCode: String(order.shipTo?.postalCode || '').replace(/\s/g, ''),
    toState: normalizeProvince(order.shipTo?.state) || order.shipTo?.state,
    toCountry: order.shipTo?.country || 'CA',
    toCity: order.shipTo?.city,
    weight: { value: Math.max(0.1, Number(toLb(order.weight).toFixed(2))), units: 'pounds' },
    confirmation: 'none',
    residential: !!order.shipTo?.residential,
  };

  async function one(carrierCode) {
    const res = await ssRequest('POST', '/shipments/getrates', { ...bodyBase, carrierCode });
    if (res.status !== 200) return null;
    const rates = JSON.parse(res.body);
    if (!Array.isArray(rates) || !rates.length) return null;
    // ShipStation actually charges shipmentCost + otherCost (fuel surcharge, accessorials).
    // Sort and report by the all-in total so the displayed estimate matches what hits the wallet.
    const best = rates
      .filter((r) => Number.isFinite(Number(r.shipmentCost)) && r.serviceCode)
      .map((r) => ({ ...r, totalCost: Number(r.shipmentCost) + Number(r.otherCost || 0) }))
      .sort((a, b) => a.totalCost - b.totalCost)[0];
    if (!best) return null;
    return {
      carrierCode,
      serviceCode: best.serviceCode,
      serviceName: best.serviceName || best.serviceCode,
      shipmentCost: best.totalCost,
    };
  }

  const street = `${order.shipTo?.street1 || ''} ${order.shipTo?.street2 || ''}`.trim();
  const cpHint = CP_HINT_RE.test(street);
  const [ups, purolator, canadaPost] = await Promise.all([
    one('ups_walleted'),
    one('purolator_walleted'),
    one('canada_post_walleted'),
  ]);

  if (cpHint) {
    if (!canadaPost) throw new Error('CP-hint address but Canada Post returned no rate');
    return { winner: canadaPost, note: 'CP-hint in address → Canada Post forced', compared: { ups, purolator, canadaPost } };
  }

  if (!ups && !purolator) throw new Error('No UPS or Purolator rate returned');

  // Prefer Purolator over UPS unless UPS is at least $4 cheaper.
  // Rationale: Purolator's domestic transit + pickup reliability beats UPS for
  // our Prosol lanes (busy depots run standing Purolator pickups; UPS has none
  // at most depots and shipments get stuck). The small price premium is worth
  // it — UPS only wins when the savings clearly justify it ($4+ cheaper).
  let bestNonCp;
  let nonCpNote = '';
  if (purolator && ups) {
    if (!UPS_ROUTING_DISABLED && (purolator.shipmentCost - ups.shipmentCost) >= 4) {
      bestNonCp = ups;
      nonCpNote = `UPS chosen — saves $${(purolator.shipmentCost - ups.shipmentCost).toFixed(2)} vs Purolator`;
    } else {
      bestNonCp = purolator;
    }
  } else {
    bestNonCp = purolator || ups;
    if (bestNonCp === ups && UPS_ROUTING_DISABLED) {
      nonCpNote = 'UPS fallback — no Purolator rate; UPS pickups are DOWN, needs manual ups.com pickup';
    }
  }
  // Canada Post price override for EGREGIOUS rural gouging (Mac 2026-07-24).
  // Normally CP is PO-box-only — CP pickups are unreliable at Prosol depots (no
  // standing pickups; Ottawa refused pickup and told us to use Purolator), so we
  // don't route to CP on price for routine orders. But rural extended-area
  // Purolator surcharges get absurd (Oak Bay NB: Puro $50 vs CP $5 for the same
  // 3 lb box). When the gap is this large the savings clearly justify the manual
  // CP handoff, so route CP. High threshold ($20) keeps it to the egregious
  // cases only; flagged via cpPriceOverride so the warehouse hands it off.
  if (canadaPost && bestNonCp && (bestNonCp.shipmentCost - canadaPost.shipmentCost) >= CP_PRICE_OVERRIDE_GAP) {
    return {
      winner: canadaPost,
      note: `Canada Post chosen on price — $${(bestNonCp.shipmentCost - canadaPost.shipmentCost).toFixed(2)} cheaper than ${formatCarrier(bestNonCp.carrierCode)} (rural surcharge). ⚠ needs manual CP handoff at the warehouse.`,
      compared: { ups, purolator, canadaPost },
      cpPriceOverride: true,
    };
  }
  return { winner: bestNonCp, note: nonCpNote, compared: { ups, purolator, canadaPost } };
}

const SHIPSTATION_WAREHOUSE_META = Object.fromEntries(
  Object.values(LOCATION_MAP)
    .filter((loc) => loc.shipstation_warehouse_id)
    .map((loc) => [String(loc.shipstation_warehouse_id), loc])
);

function formatCarrier(code) {
  return String(code || '—').replace('_walleted', '').replace(/_/g, ' ');
}

async function fetchOrder(orderId) {
  const res = await ssRequest('GET', `/orders/${orderId}`);
  if (res.status !== 200) throw new Error(`GET /orders/${orderId} failed: ${res.status} ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

function assignmentMatches(order, assignment) {
  return Number(order.advancedOptions?.warehouseId || 0) === Number(assignment.warehouseId)
    && String(order.carrierCode || '') === String(assignment.carrierCode || '')
    && String(order.serviceCode || '') === String(assignment.serviceCode || '')
    && String(order.packageCode || '') === String(assignment.packageCode || '');
}

function buildUpdatePayload(order, assignment) {
  const advancedOptions = { ...(order.advancedOptions || {}), warehouseId: assignment.warehouseId };
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderKey: order.orderKey,
    orderDate: order.orderDate,
    orderStatus: order.orderStatus,
    billTo: order.billTo,
    shipTo: normalizeShipTo(order.shipTo),
    items: order.items,
    advancedOptions,
    carrierCode: assignment.carrierCode,
    serviceCode: assignment.serviceCode,
    packageCode: assignment.packageCode,
  };
}

async function stageAssignment(orderSummary, assignment) {
  const liveOrder = await fetchOrder(orderSummary.orderId);
  if (assignmentMatches(liveOrder, assignment)) {
    return { status: 'already-correct', order: liveOrder };
  }

  const res = await ssRequest('POST', '/orders/createorders', [buildUpdatePayload(liveOrder, assignment)]);
  if (res.status !== 200) {
    throw new Error(`ShipStation update failed: ${res.status} ${res.body.slice(0, 300)}`);
  }

  await sleep(1200);
  const verified = await fetchOrder(orderSummary.orderId);
  if (!assignmentMatches(verified, assignment)) {
    throw new Error(
      `Verification mismatch after update. Expected warehouse=${assignment.warehouseId}, carrier=${assignment.carrierCode}, service=${assignment.serviceCode}, package=${assignment.packageCode}; got warehouse=${verified.advancedOptions?.warehouseId || 'blank'}, carrier=${verified.carrierCode || 'blank'}, service=${verified.serviceCode || 'blank'}, package=${verified.packageCode || 'blank'}`
    );
  }

  return { status: 'updated', order: verified };
}

function renderTable(rows) {
  const headers = ['Order #', 'Item', 'To', 'From', 'Carrier', 'Cost', 'Notes'];
  const widths = headers.map((h) => h.length);
  const matrix = rows.map((row) => [row.orderNumber, row.item, row.to, row.from, row.carrier, row.cost, row.notes || '']);
  for (const cols of matrix) cols.forEach((v, i) => { widths[i] = Math.max(widths[i], String(v || '').length); });
  const line = (cols) => `| ${cols.map((v, i) => String(v || '').padEnd(widths[i])).join(' | ')} |`;
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...matrix.map(line)].join('\n');
}

// ── Core exported function ───────────────────────────────────────────────────

// ── Large-order review gate ──────────────────────────────────────────────────
// A high-value / heavy / many-box order is held for human review on purpose,
// before it ever hits the rate step, and pages Mac by URGENT email. Thresholds
// are env-tunable so Mac can adjust without a deploy. See lib/pipeline.js
// (phaseStage) for the email + project memory for the "I wasn't notified" fix.
const LARGE_ORDER_VALUE_CAD = Number(process.env.LARGE_ORDER_VALUE_CAD || 2500);
const LARGE_ORDER_WEIGHT_LB = Number(process.env.LARGE_ORDER_WEIGHT_LB || 150);
const LARGE_ORDER_PACKAGES  = Number(process.env.LARGE_ORDER_PACKAGES  || 5);

// Order $ value (orderTotal if ShipStation populated it, else sum of line
// unitPrice*qty), total weight in lb, and how many physical boxes it splits to.
function computeOrderProfile(order) {
  const items = order.items || [];
  const sumItems = items.reduce((s, i) => s + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0), 0);
  const valueCad = Number(order.orderTotal) > 0 ? Number(order.orderTotal) : sumItems;
  const weightLb = toLb(order.weight);
  let packages = 1;
  try { packages = planPackages(items, order.weight).length; } catch { packages = 1; }
  return { valueCad, weightLb, packages };
}

// Returns the list of threshold reasons an order trips, or [] if it's normal-sized.
function largeOrderReasons(profile) {
  const r = [];
  if (profile.valueCad >= LARGE_ORDER_VALUE_CAD) r.push(`$${Math.round(profile.valueCad).toLocaleString()} value`);
  if (profile.weightLb >= LARGE_ORDER_WEIGHT_LB) r.push(`${Math.round(profile.weightLb)} lb`);
  if (profile.packages >= LARGE_ORDER_PACKAGES)  r.push(`${profile.packages} boxes`);
  return r;
}

async function runOrders({ dryRun = false, filterOrderNumber = null, onProgress = () => {} } = {}) {
  onProgress({ type: 'status', message: filterOrderNumber ? `Fetching order ${filterOrderNumber}...` : 'Fetching awaiting_shipment orders from ShipStation...' });
  const allOrders = await fetchAwaitingOrders();
  let inScope = allOrders.filter(isInScope);
  if (filterOrderNumber) {
    inScope = inScope.filter(o => o.orderNumber === filterOrderNumber);
    if (!inScope.length) {
      return { dryRun, summary: { totalAwaiting: allOrders.length, amazonAwaiting: 0, plannable: 0, rejected: 0, errors: 1 }, assignments: [], manualReview: [{ orderNumber: filterOrderNumber, reason: 'Order not found in awaiting_shipment queue' }], errors: [] };
    }
  }
  const scopeOrders = [];
  const rejected = [];

  const amazonCount = inScope.filter(isAmazonOrder).length;
  const shopifyCount = inScope.filter(isShopifyOrder).length;
  onProgress({ type: 'status', message: `Found ${allOrders.length} total · ${amazonCount} Amazon · ${shopifyCount} Shopify. Filtering...` });

  for (const order of inScope) {
    const province = normalizeProvince(order.shipTo?.state);
    if (!province) {
      rejected.push({ orderNumber: order.orderNumber, reason: `Unsupported province/state: ${order.shipTo?.state || 'blank'}` });
      continue;
    }

    const { resolved, fixedWarehouseItems, failures, failureItems } = resolveOrderItems(order);
    if (failures.length) {
      rejected.push({ orderNumber: order.orderNumber, reason: failures.join('; '), _suggestInputs: failureItems });
      continue;
    }
    const fixedWarehouseIds = [...new Set(fixedWarehouseItems.map((item) => item.warehouseId))];
    if (fixedWarehouseIds.length > 1) {
      rejected.push({ orderNumber: order.orderNumber, reason: `Conflicting fixed-warehouse rules: ${fixedWarehouseIds.join(', ')}` });
      continue;
    }
    if (fixedWarehouseIds.length && resolved.length) {
      rejected.push({ orderNumber: order.orderNumber, reason: 'Mixed Prosol and fixed non-Prosol routing requires manual review' });
      continue;
    }
    if (!resolved.length && !fixedWarehouseIds.length) {
      rejected.push({ orderNumber: order.orderNumber, reason: 'No in-scope run-orders items after filtering' });
      continue;
    }
    if (resolved.some((item) => isClearlyOutOfScope(item.name))) {
      rejected.push({ orderNumber: order.orderNumber, reason: 'Contains flooring-style item outside Amazon/Prosol run scope' });
      continue;
    }
    const guardHalt = await checkMappingGuard(resolved);
    if (guardHalt) {
      rejected.push({ orderNumber: order.orderNumber, reason: guardHalt });
      continue;
    }

    // Large-order review gate: hold high-value/heavy/many-box orders for a human
    // and page Mac by URGENT email (lib/pipeline.js). Intentional — a big order
    // should be considered, not auto-shipped. Runs after mapping/routing checks
    // so a normal-sized order with a mapping issue still alerts on that instead.
    const profile = computeOrderProfile(order);
    const bigReasons = largeOrderReasons(profile);
    if (bigReasons.length) {
      rejected.push({
        orderNumber: order.orderNumber,
        reason: `Large order held for review (${bigReasons.join(', ')})`,
        large: true,
        profile: {
          valueCad: profile.valueCad,
          weightLb: profile.weightLb,
          packages: profile.packages,
          customer: order.shipTo?.name || '',
          destination: `${order.shipTo?.city || ''}, ${normalizeProvince(order.shipTo?.state) || order.shipTo?.state || ''}`.replace(/^, /, ''),
          orderDate: order.orderDate || null,
          source: orderSource(order),
        },
      });
      continue;
    }

    scopeOrders.push({
      ...order,
      source: orderSource(order),
      normalizedProvince: province,
      resolvedItems: resolved,
      fixedWarehouseId: fixedWarehouseIds[0] || null,
      fixedWarehouseItems,
    });
  }

  onProgress({ type: 'status', message: `${scopeOrders.length} orders in scope, ${rejected.length} flagged. Logging into Prosol...` });

  const client = new ProsolClientV2();
  await client.init();
  onProgress({ type: 'status', message: 'Prosol session ready. Checking inventory and rates...' });

  try {
    const inventoryCache = new Map();
    const plannedAssignments = [];
    const planningErrors = [];
    const stagingErrors = [];

    for (const order of scopeOrders) {
      try {
        let warehouseId;
        let warehouseLabel;
        let fromPostalCode;
        // The exact Prosol branch (product_inventory_location_id) the router
        // chose by stock — the branch the goods ship from, the label origin, and
        // (for direct ordering) the branch the Prosol order is created at. Kept
        // explicitly so direct-order placement can't drift from label/pickup.
        let prosolLocId;
        const itemPool = order.resolvedItems.length ? order.resolvedItems : order.fixedWarehouseItems;

        if (order.fixedWarehouseId) {
          const fixedWarehouse = SHIPSTATION_WAREHOUSE_META[String(order.fixedWarehouseId)];
          if (!fixedWarehouse) throw new Error(`Fixed warehouse ${order.fixedWarehouseId} is not in the ShipStation warehouse map`);
          warehouseId = Number(order.fixedWarehouseId);
          warehouseLabel = `${fixedWarehouse.city} (${fixedWarehouse.code})`;
          fromPostalCode = fixedWarehouse.postal_code;
          prosolLocId = fixedWarehouse.id;
        } else {
          const inventoryBySku = {};
          // The Prosol storefront search API and the PO catalog use different
          // SKU formats depending on the product line:
          //   - Aqua Mix: api_sku='C030192-4' is the storefront key; prosol_sku='C030192-01' is PO-only
          //   - Schluter KD-STR: api_sku='13572' (SF id, no storefront hit); prosol_sku='KD-STR' is the storefront key
          // Try api_sku first; on miss, retry with prosol_sku before giving up.
          const skuPairs = [...new Map(
            order.resolvedItems.map((item) => {
              const primary = item.apiSku || item.prosolSku;
              const fallback = item.prosolSku && item.prosolSku !== primary ? item.prosolSku : null;
              return [primary, { primary, fallback }];
            })
          ).values()];
          for (const { primary, fallback } of skuPairs) {
            const cacheKey = primary;
            if (!inventoryCache.has(cacheKey)) {
              onProgress({ type: 'inventory', message: `Checking Prosol stock: ${primary}`, orderNumber: order.orderNumber });
              let inv = await client.checkInventory(primary);
              if (!inv && fallback) {
                onProgress({ type: 'inventory', message: `Retry with prosol_sku: ${fallback}`, orderNumber: order.orderNumber });
                inv = await client.checkInventory(fallback);
              }
              inventoryCache.set(cacheKey, inv);
              await sleep(5000);
            }
            const inv = inventoryCache.get(cacheKey);
            if (!inv) throw new Error(`No Prosol inventory result for ${primary}${fallback ? ` (also tried ${fallback})` : ''}`);
            inventoryBySku[cacheKey] = inv;
          }

          const warehouse = determineWarehouse(order, inventoryBySku);
          if (!warehouse) throw new Error(`No single Prosol branch can fulfill the full order quantity (${summarizeCoverage(order, inventoryBySku)}) — needs manual split or alternate sourcing`);
          warehouseId = Number(warehouse.location.shipstation_warehouse_id);
          warehouseLabel = `${warehouse.location.city} (${warehouse.location.code})`;
          fromPostalCode = warehouse.location.postal_code;
          prosolLocId = warehouse.prosolLocId;
        }

        onProgress({ type: 'rates', message: `Rate shopping for ${order.orderNumber}...`, orderNumber: order.orderNumber });
        const rate = await getRates(order, fromPostalCode);
        const itemSummary = itemPool.map((item) => `${item.qty}x ${item.label}`).join('; ');

        const assignment = {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          source: order.source || orderSource(order),
          itemSummary,
          destination: orderDestination(order),
          warehouseId,
          warehouseLabel,
          prosolLocId,
          carrierCode: rate.winner.carrierCode,
          serviceCode: rate.winner.serviceCode,
          packageCode: 'package',
          serviceName: rate.winner.serviceName,
          shipmentCost: rate.winner.shipmentCost,
          rateNote: rate.note,
          compared: rate.compared,
        };
        plannedAssignments.push(assignment);
        onProgress({ type: 'order-planned', orderNumber: order.orderNumber, warehouse: warehouseLabel, carrier: formatCarrier(rate.winner.carrierCode), cost: formatMoney(rate.winner.shipmentCost) });
      } catch (error) {
        planningErrors.push({ orderNumber: order.orderNumber, reason: error.message });
        onProgress({ type: 'order-error', orderNumber: order.orderNumber, reason: error.message });
      }
    }

    plannedAssignments.sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber)));

    const assignments = [];
    if (!dryRun) {
      onProgress({ type: 'status', message: 'Staging assignments in ShipStation...' });
    }

    for (const assignment of plannedAssignments) {
      try {
        const staged = dryRun
          ? { status: 'planned', order: await fetchOrder(assignment.orderId) }
          : await stageAssignment(assignment, assignment);
        const actualWarehouse = SHIPSTATION_WAREHOUSE_META[String(staged.order.advancedOptions?.warehouseId || '')];

        const row = {
          // Display fields
          orderNumber: assignment.orderNumber,
          item: assignment.itemSummary,
          to: assignment.destination,
          from: dryRun ? assignment.warehouseLabel : (actualWarehouse ? `${actualWarehouse.city} (${actualWarehouse.code})` : assignment.warehouseLabel),
          carrier: dryRun
            ? `${formatCarrier(assignment.carrierCode)} / ${assignment.serviceCode}`
            : `${formatCarrier(staged.order.carrierCode || assignment.carrierCode)} / ${staged.order.serviceCode || assignment.serviceCode}`,
          cost: formatMoney(assignment.shipmentCost),
          notes: [
            dryRun ? 'DRY RUN' : (staged.status === 'already-correct' ? 'Already staged' : 'Staged'),
            assignment.rateNote,
          ].filter(Boolean).join('; '),
          status: dryRun ? 'dry-run' : staged.status,
          compared: assignment.compared,
          // Machine-readable fields for pipeline (label buying, POs, email)
          orderId: assignment.orderId,
          warehouseId: assignment.warehouseId,
          carrierCode: assignment.carrierCode,
          serviceCode: assignment.serviceCode,
          packageCode: assignment.packageCode,
          shipmentCost: assignment.shipmentCost,
          weight: { value: Math.max(0.1, Number(toLb(staged.order.weight).toFixed(2))), units: 'pounds' },
          shipTo: staged.order.shipTo,
          items: staged.order.items,
          // 'amazon_ca' | 'shopify' — drives phasePos routing (Amazon goes to
          // the rotating 14-day SO; Shopify per-order calls createShopifySoPo
          // to create an SF Sales Order + PO under the Shopify account). Was
          // silently dropped from the row for a long time, which is why
          // Shopify orders shipped without SF SOs getting created.
          source: assignment.source || null,
        };
        assignments.push(row);

        if (!dryRun) {
          onProgress({ type: 'order-staged', orderNumber: assignment.orderNumber, status: staged.status });
        }
      } catch (error) {
        stagingErrors.push({ orderNumber: assignment.orderNumber, reason: error.message });
        onProgress({ type: 'order-error', orderNumber: assignment.orderNumber, reason: error.message });
      }
    }

    assignments.sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber)));

    // ── SUGGEST-only: enrich SKU-bearing rejections with Prosol candidates ──
    // Best-effort, reuses the already-authenticated `client` (still open here;
    // closed in finally). Sequential with 5s spacing (shared Prosol account —
    // protect it). Every failure is swallowed so the original rejection reason
    // ships unchanged; staging/buying of good orders is never affected. Writes
    // nothing and never feeds the buy/PO path.
    try {
      for (const row of rejected) {
        if (!Array.isArray(row._suggestInputs) || !row._suggestInputs.length) continue;
        const seenQueries = new Set();
        for (const fi of row._suggestInputs) {
          try {
            const query = buildSuggestQuery(fi);
            if (!query || seenQueries.has(query)) continue;
            seenQueries.add(query);
            onProgress({ type: 'status', message: `Prosol suggest search: ${query}` });
            const candidates = await suggestProsolCandidates(client, query);
            row.reason += renderSuggestLines(query, candidates);
            await sleep(5000);
          } catch (e) {
            console.error(`[suggest] ${row.orderNumber} (${fi && fi.sku}): ${e.message}`);
          }
        }
        delete row._suggestInputs;
      }
    } catch (e) {
      console.error(`[suggest] pass failed, shipping original reasons: ${e.message}`);
    }

    return {
      dryRun,
      summary: {
        totalAwaiting: allOrders.length,
        amazonAwaiting: amazonCount,
        shopifyAwaiting: shopifyCount,
        plannable: assignments.length,
        rejected: rejected.length,
        errors: planningErrors.length + stagingErrors.length,
      },
      assignments,
      manualReview: [...rejected, ...planningErrors].sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber))),
      errors: stagingErrors,
    };
  } finally {
    await client.close();
  }
}

// ── CLI mode ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run') || args.has('--plan');

  runOrders({
    dryRun,
    onProgress: (ev) => {
      if (ev.type === 'status') console.log(ev.message);
      else if (ev.type === 'inventory') console.log(`  ${ev.message}`);
      else if (ev.type === 'order-planned') console.log(`  Planned: ${ev.orderNumber} → ${ev.warehouse} via ${ev.carrier} (${ev.cost})`);
      else if (ev.type === 'order-staged') console.log(`  Staged: ${ev.orderNumber} (${ev.status})`);
      else if (ev.type === 'order-error') console.log(`  ERROR: ${ev.orderNumber} — ${ev.reason}`);
    },
  }).then((result) => {
    console.log(`\nRun-Orders ${dryRun ? 'planning snapshot (dry run)' : 'staging snapshot'}`);
    console.log(`Awaiting shipment total: ${result.summary.totalAwaiting}`);
    console.log(`Amazon awaiting shipment: ${result.summary.amazonAwaiting}`);
    console.log(`Plannable run-orders: ${result.summary.plannable}`);
    console.log('');
    if (result.assignments.length) console.log(renderTable(result.assignments));
    else console.log('No plannable run-orders found.');
    if (result.manualReview.length) {
      console.log('\nFlags / manual review');
      for (const row of result.manualReview) console.log(`- ${row.orderNumber}: ${row.reason}`);
    }
    process.exit(result.errors.length ? 2 : 0);
  }).catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runOrders, normalizeProvince, normalizeShipTo, orderSource, buildSuggestQuery, suggestProsolCandidates, renderSuggestLines, liveAddMapping, resolveMappedEntry, resolveOrderItems, requiredQtyBySku, scoreWarehouseAgainstOrder, determineWarehouse, summarizeCoverage };
