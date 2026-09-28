/**
 * ProZone trade pricing rules (pure, no dependencies). Plan task 1.2, build plan A.
 *
 * Two programs:
 *   national  one flat percent on eligible Schluter (Z1, PROPOSED 10).
 *   coast     Doug's pair: the low percent up to the threshold, the high percent
 *             only when the eligible subtotal is strictly OVER it. Shopify's
 *             minimum on the high discount is 1000.01, so $1,000.00 is still the
 *             low tier.
 *
 * The subtotal that picks the tier counts ONLY eligible variants, at their
 * pre-discount price (plan F3: Shopify counts only the discounted products
 * toward an amount-off minimum). Excluded variants and non-Schluter lines never
 * count, so $950 eligible plus $300 excluded is the low tier. The texted-cart
 * builder must use this same base or it will quote a tier checkout won't give.
 *
 * Eligibility is by variant ID, never by SKU: nine KERDI-SHOWER tray SKUs sit on
 * two listings.
 *
 * Config: data/trade/trade-config.json. Static only (tiers, threshold, floor,
 * the eligible variant list). No customer data: approved accounts live in
 * Shopify. Every rate in it is PROPOSED until Mac answers Z1 to Z3.
 *
 * Money is handled in integer cents throughout.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.TRADE_CONFIG_FILE
  || path.join(__dirname, '..', 'data', 'trade', 'trade-config.json');

const PROGRAMS = ['national', 'coast'];

/** Dollars (number, "1,000.01", "$12", or a Shopify MoneyV2 / MoneyBag) to integer cents. */
function toCents(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'object') {
    if (v.shopMoney) return toCents(v.shopMoney.amount);
    if (Object.prototype.hasOwnProperty.call(v, 'amount')) return toCents(v.amount);
    throw new Error(`not a money amount: ${JSON.stringify(v)}`);
  }
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`not a money amount: ${v}`);
  return Math.round(n * 100);
}

const fromCents = (c) => Math.round(c) / 100;

/** "gid://shopify/ProductVariant/123", "123" or 123 all become "123". Anything else becomes "". */
function gidNumber(id) {
  if (id == null) return '';
  const m = String(id).trim().match(/(\d+)$/);
  return m ? m[1] : '';
}

function pct(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`trade-config: ${name} must be a percent 0-100, got ${v}`);
  return n;
}

/** Validate the raw JSON and return the normalized config the functions below use. */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('trade-config: not an object');
  const national = raw.national || {};
  const coast = raw.coast || {};
  const lowPercent = pct(coast.low_percent, 'coast.low_percent');
  const highPercent = pct(coast.high_percent, 'coast.high_percent');
  if (highPercent < lowPercent) throw new Error('trade-config: coast.high_percent is below coast.low_percent');
  const thresholdCents = toCents(coast.threshold);
  if (!(thresholdCents > 0)) throw new Error('trade-config: coast.threshold must be over 0');
  const ids = (raw.eligible_variants && raw.eligible_variants.ids) || [];
  return {
    status: raw.status || 'PROPOSED',
    national: { percent: pct(national.percent, 'national.percent') },
    coast: { lowPercent, highPercent, thresholdCents },
    clientCode: {
      percent: pct((raw.client_code || {}).percent, 'client_code.percent'),
      prefix: String((raw.client_code || {}).prefix || 'PRO-').toUpperCase(),
    },
    earn: { percent: pct((raw.earn || {}).percent, 'earn.percent') },
    floor: { minNetMarginPercent: pct((raw.floor || {}).min_net_margin_percent, 'floor.min_net_margin_percent') },
    excludedTags: (raw.excluded_tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
    eligibleIds: new Set(ids.map(gidNumber).filter(Boolean)),
    eligibleAsOf: (raw.eligible_variants && raw.eligible_variants.as_of) || null,
  };
}

function loadConfig(file = CONFIG_FILE) {
  return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

let cached = null;
function defaultConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Accepts a Set or array of variant IDs (gid or numeric), or a normalized config. */
function toIdSet(eligible) {
  if (eligible == null) return defaultConfig().eligibleIds;
  if (eligible.eligibleIds instanceof Set) return eligible.eligibleIds;
  const out = new Set();
  for (const id of eligible) { const k = gidNumber(id); if (k) out.add(k); }
  return out;
}

/** Is this variant on the eligible list? By variant ID only. */
function isEligible(variantId, eligible) {
  const k = gidNumber(variantId);
  return !!k && toIdSet(eligible).has(k);
}

/**
 * A line's value at its pre-discount (list) price, in cents.
 * Line: { variantId, quantity, price } where price is the pre-discount unit
 * price. originalUnitPrice / originalUnitPriceSet (Shopify names) also work.
 */
function lineListCents(line) {
  const unit = line.originalUnitPriceSet != null ? line.originalUnitPriceSet
    : line.originalUnitPrice != null ? line.originalUnitPrice
      : line.price;
  const qty = Number(line.quantity != null ? line.quantity : line.currentQuantity);
  if (!Number.isInteger(qty) || qty < 0) throw new Error(`bad quantity on line ${line.variantId}: ${qty}`);
  return toCents(unit) * qty;
}

/** Eligible subtotal in cents: eligible variants only, at pre-discount price (F3). */
function eligibleSubtotalCents(lines, eligible) {
  const ids = toIdSet(eligible);
  let sum = 0;
  for (const l of lines || []) if (ids.has(gidNumber(l.variantId))) sum += lineListCents(l);
  return sum;
}

/**
 * Tier for a program and an eligible subtotal (dollars, or { cents }).
 * Returns { program, tier, percent }. tier: national | coast_low | coast_high.
 */
function tierFor(program, eligibleSubtotal, cfg = defaultConfig()) {
  if (!PROGRAMS.includes(program)) throw new Error(`unknown trade program: ${program}`);
  if (program === 'national') return { program, tier: 'national', percent: cfg.national.percent };
  const cents = eligibleSubtotal && typeof eligibleSubtotal === 'object' && 'cents' in eligibleSubtotal
    ? eligibleSubtotal.cents
    : toCents(eligibleSubtotal);
  return cents > cfg.coast.thresholdCents
    ? { program, tier: 'coast_high', percent: cfg.coast.highPercent }
    : { program, tier: 'coast_low', percent: cfg.coast.lowPercent };
}

/**
 * Price a cart for one program. Discount goes on eligible lines only, rounded per
 * line (as Shopify allocates a percentage discount).
 */
function priceCart(program, lines, { eligible, cfg = defaultConfig() } = {}) {
  const ids = toIdSet(eligible == null ? cfg : eligible);
  let eligibleCents = 0;
  let excludedCents = 0;
  const priced = (lines || []).map((l) => {
    const listCents = lineListCents(l);
    const ok = ids.has(gidNumber(l.variantId));
    if (ok) eligibleCents += listCents; else excludedCents += listCents;
    return { variantId: l.variantId, quantity: Number(l.quantity != null ? l.quantity : l.currentQuantity), listCents, eligible: ok };
  });
  const t = tierFor(program, { cents: eligibleCents }, cfg);
  let discountCents = 0;
  for (const p of priced) {
    p.discountCents = p.eligible ? Math.round((p.listCents * t.percent) / 100) : 0;
    p.netCents = p.listCents - p.discountCents;
    discountCents += p.discountCents;
  }
  return {
    ...t,
    eligibleSubtotal: fromCents(eligibleCents),
    excludedSubtotal: fromCents(excludedCents),
    discountTotal: fromCents(discountCents),
    total: fromCents(eligibleCents + excludedCents - discountCents),
    lines: priced,
  };
}

/**
 * Does a line still clear the floor after the discount? Net margin on the
 * discounted price must be at least floor.min_net_margin_percent. An unknown or
 * zero cost never clears (use the most conservative cost: max of Shopify and
 * the last Prosol cost table).
 */
function clearsFloor({ price, cost, percent }, cfg = defaultConfig()) {
  const priceCents = toCents(price);
  const costCents = cost == null || cost === '' ? 0 : toCents(cost);
  if (!(priceCents > 0) || !(costCents > 0)) return false;
  const net = priceCents * (1 - Number(percent) / 100);
  if (!(net > 0)) return false;
  return ((net - costCents) / net) * 100 >= cfg.floor.minNetMarginPercent;
}

/** The contractor earn rate as a fraction (Z3, PROPOSED 5% = 0.05). */
function earnRate(cfg = defaultConfig()) { return cfg.earn.percent / 100; }

module.exports = {
  CONFIG_FILE,
  PROGRAMS,
  toCents,
  fromCents,
  gidNumber,
  normalizeConfig,
  loadConfig,
  isEligible,
  lineListCents,
  eligibleSubtotalCents,
  tierFor,
  priceCart,
  clearsFloor,
  earnRate,
};
