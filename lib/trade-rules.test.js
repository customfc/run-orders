// ProZone tier and price rules. The Coast pair must match Shopify exactly: the
// high tier needs an eligible subtotal strictly over $1,000 (Shopify minimum
// 1000.01), and only eligible variants at pre-discount price count toward it
// (plan F3). Run: `npm test`.
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./trade-rules');

// Same numbers as the PROPOSED config, inline so these tests don't move when
// Mac changes a rate.
const cfg = rules.normalizeConfig({
  status: 'PROPOSED',
  national: { percent: 10 },
  coast: { low_percent: 20, high_percent: 25, threshold: 1000 },
  client_code: { percent: 5, prefix: 'PRO-' },
  earn: { percent: 5 },
  floor: { min_net_margin_percent: 5 },
  excluded_tags: ['take-all-lot', 'prozone-exclude'],
  eligible_variants: { as_of: '2026-09-28', ids: ['gid://shopify/ProductVariant/111', '222', 333] },
});

const EXCLUDED = 'gid://shopify/ProductVariant/999';
const line = (variantId, price, quantity = 1) => ({ variantId, price, quantity });

test('the config file on disk loads, is marked PROPOSED and holds no customer data', () => {
  const c = rules.loadConfig();
  assert.equal(c.status, 'PROPOSED');
  assert.equal(c.national.percent, 10);
  assert.deepEqual([c.coast.lowPercent, c.coast.highPercent, c.coast.thresholdCents], [20, 25, 100000]);
  assert.equal(c.clientCode.percent, 5);
  assert.equal(c.earn.percent, 5);
  assert.equal(c.floor.minNetMarginPercent, 5);
  const text = fs.readFileSync(rules.CONFIG_FILE, 'utf8');
  assert.match(text, /Z1/, 'the comment says the rates await Mac (Z1 to Z3)');
  assert.doesNotMatch(text, /@|Customer\/\d|\+1\d{10}/, 'no emails, customer IDs or phone numbers');
  assert.doesNotMatch(text, /\u2014/, 'no em dashes');
});

test('coast: $999.99 is the low tier', () => {
  assert.equal(rules.tierFor('coast', 999.99, cfg).percent, 20);
  assert.equal(rules.tierFor('coast', '999.99', cfg).tier, 'coast_low');
});

test('coast: exactly $1,000.00 is still the low tier (Shopify minimum is 1000.01)', () => {
  assert.equal(rules.tierFor('coast', 1000, cfg).percent, 20);
  assert.equal(rules.tierFor('coast', '1,000.00', cfg).tier, 'coast_low');
});

test('coast: $1,000.01 is the high tier', () => {
  assert.equal(rules.tierFor('coast', 1000.01, cfg).percent, 25);
  assert.equal(rules.tierFor('coast', '$1,000.01', cfg).tier, 'coast_high');
});

test('eligibility is by variant ID; gid and numeric forms are the same variant', () => {
  assert.equal(rules.isEligible('gid://shopify/ProductVariant/111', cfg), true);
  assert.equal(rules.isEligible('111', cfg), true);
  assert.equal(rules.isEligible(222, cfg), true);
  assert.equal(rules.isEligible('gid://shopify/ProductVariant/333', cfg), true);
  assert.equal(rules.isEligible(EXCLUDED, cfg), false);
  assert.equal(rules.isEligible('', cfg), false);
  assert.equal(rules.isEligible(null, cfg), false);
});

test('an excluded variant gets no discount and does not count toward the tier', () => {
  const r = rules.priceCart('coast', [line('111', 500), line(EXCLUDED, 800)], { cfg });
  assert.equal(r.eligibleSubtotal, 500);
  assert.equal(r.excludedSubtotal, 800);
  assert.equal(r.percent, 20, '$1,300 cart but only $500 eligible');
  const ex = r.lines.find((l) => l.variantId === EXCLUDED);
  assert.equal(ex.eligible, false);
  assert.equal(ex.discountCents, 0);
  assert.equal(r.discountTotal, 100);
  assert.equal(r.total, 1200);
});

test('$950 eligible plus $300 excluded is the LOW tier (the $1,250 cart does not qualify)', () => {
  const lines = [line('111', 475, 2), line(EXCLUDED, 300)];
  assert.equal(rules.eligibleSubtotalCents(lines, cfg), 95000);
  const r = rules.priceCart('coast', lines, { cfg });
  assert.equal(r.tier, 'coast_low');
  assert.equal(r.percent, 20);
  assert.equal(r.discountTotal, 190);
});

test('the tier uses the pre-discount price, not a price already discounted', () => {
  // $1,000.01 at list. If the builder used a discounted price it would drop to 20%.
  const r = rules.priceCart('coast', [{ variantId: '111', originalUnitPrice: '1000.01', price: '750.01', quantity: 1 }], { cfg });
  assert.equal(r.eligibleSubtotal, 1000.01);
  assert.equal(r.percent, 25);
});

test('national vs coast: national is flat, coast depends on the eligible subtotal', () => {
  const small = [line('111', 200)];
  const big = [line('111', 600), line('222', 600)];
  assert.equal(rules.priceCart('national', small, { cfg }).percent, 10);
  assert.equal(rules.priceCart('national', big, { cfg }).percent, 10);
  assert.equal(rules.priceCart('coast', small, { cfg }).percent, 20);
  assert.equal(rules.priceCart('coast', big, { cfg }).percent, 25);
  assert.equal(rules.priceCart('national', big, { cfg }).discountTotal, 120);
  assert.equal(rules.priceCart('coast', big, { cfg }).discountTotal, 300);
});

test('an explicit eligible list overrides the config list', () => {
  const r = rules.priceCart('national', [line(EXCLUDED, 100), line('111', 100)], { cfg, eligible: [EXCLUDED] });
  assert.equal(r.eligibleSubtotal, 100);
  assert.equal(r.lines.find((l) => l.variantId === '111').eligible, false);
});

test('an unknown program is refused', () => {
  assert.throws(() => rules.tierFor('vip', 5000, cfg), /unknown trade program/);
});

test('floor: a line clears only if the net margin after the discount is at least 5%', () => {
  // $100 at 25% off = $75 net. Cost $70 is 6.7% net: clears. Cost $72 is 4%: does not.
  assert.equal(rules.clearsFloor({ price: 100, cost: 70, percent: 25 }, cfg), true);
  assert.equal(rules.clearsFloor({ price: 100, cost: 72, percent: 25 }, cfg), false);
  assert.equal(rules.clearsFloor({ price: 100, cost: null, percent: 20 }, cfg), false, 'unknown cost never clears');
  assert.equal(rules.clearsFloor({ price: 100, cost: 0, percent: 20 }, cfg), false, 'zero cost is missing data');
});

test('bad configs are refused', () => {
  const base = { national: { percent: 10 }, coast: { low_percent: 20, high_percent: 25, threshold: 1000 }, client_code: { percent: 5 }, earn: { percent: 5 }, floor: { min_net_margin_percent: 5 } };
  assert.throws(() => rules.normalizeConfig({ ...base, coast: { low_percent: 25, high_percent: 20, threshold: 1000 } }), /below/);
  assert.throws(() => rules.normalizeConfig({ ...base, coast: { low_percent: 20, high_percent: 25, threshold: 0 } }), /threshold/);
  assert.throws(() => rules.normalizeConfig({ ...base, national: { percent: 110 } }), /percent/);
  assert.throws(() => rules.normalizeConfig({ ...base, earn: {} }), /earn.percent/);
});

test('money parsing handles Shopify MoneyBag shapes and rejects junk', () => {
  assert.equal(rules.toCents({ shopMoney: { amount: '1000.01' } }), 100001);
  assert.equal(rules.toCents({ amount: '4.35' }), 435);
  assert.equal(rules.toCents('$1,234.56'), 123456);
  assert.throws(() => rules.toCents('abc'), /money/);
  assert.equal(rules.earnRate(cfg), 0.05);
});
