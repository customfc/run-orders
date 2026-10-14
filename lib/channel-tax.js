/**
 * Channel tax: what Shopify and Amazon actually charged, by tax code, in the
 * shape Automayt books (`tax_charged` on a sales order line). Replaces
 * Lynnae's hand process: Shopify order PDFs plus an "Adj for fees, taxes and
 * freight" line per order, and the Seller Central Date Range CSV autosum plus
 * the "PST remitted by Amazon" file per Amazon payout period.
 *
 * Pure functions only; Shopify, SP-API, SQLite and file IO live in
 * lib/channel-tax-io.js.
 *
 * Who owes what (verified 2026-10-14 against live data):
 * - Shopify: CFC charges GST/HST everywhere plus BC PST on BC deliveries and
 *   remits all of it. Automayt must book what Shopify charged, never compute
 *   it from ship_to_region (it would add QST/SK PST/MB RST CFC doesn't charge).
 * - Amazon.ca: Amazon withholds and remits the provincial part as marketplace
 *   facilitator in BC (PST 7%), SK (PST 6%), MB (RST 7%) and QC (QST 9.975%),
 *   and US sales tax in full. It withholds nothing in the HST provinces. The
 *   rest (GST, or HST) is CFC's: collected minus withheld.
 */

const { amazonPeriod } = require('./automayt-erp');

const CODE_ORDER = ['GST', 'HST', 'PST', 'QST', 'RST', 'SALES_TAX'];
const HST_PROVINCES = new Set(['ON', 'NS', 'NB', 'NL', 'PE']);
// Amazon's marketplace-facilitator withholding by province, in Automayt codes.
const WITHHELD_CODE = { BC: 'PST', SK: 'PST', MB: 'RST', QC: 'QST' };

const PROVINCE_NAMES = {
  'BRITISH COLUMBIA': 'BC', ALBERTA: 'AB', SASKATCHEWAN: 'SK', MANITOBA: 'MB', ONTARIO: 'ON',
  QUEBEC: 'QC', 'QUÉBEC': 'QC', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', 'PRINCE EDWARD ISLAND': 'PE',
  NEWFOUNDLAND: 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL', YUKON: 'YT', 'NORTHWEST TERRITORIES': 'NT', NUNAVUT: 'NU',
};
const PROVINCE_CODES = new Set(Object.values(PROVINCE_NAMES));

/** 'Ontario' / 'ontario' / 'ON' / 'Québec' → 'ON' / 'QC'; anything else → null. */
function provinceCode(s) {
  const t = String(s || '').trim().toUpperCase().replace(/\.$/, '');
  if (!t) return null;
  if (PROVINCE_CODES.has(t)) return t;
  if (t === 'PEI') return 'PE';
  return PROVINCE_NAMES[t] || null;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);
const fix2 = (n) => round2(n).toFixed(2);
const amt = (set) => (set && set.shopMoney ? Number(set.shopMoney.amount) : Number((set && set.amount) || 0)) || 0;

// ── Tax codes ────────────────────────────────────────────────────────────────

/** Shopify tax line title → Automayt code. */
function shopifyTaxCode(title) {
  const t = String(title || '').toUpperCase();
  if (/HST|HARMONI[SZ]ED/.test(t)) return 'HST';
  if (/QST|TVQ/.test(t)) return 'QST';
  if (/RST|RETAIL SALES/.test(t)) return 'RST';
  if (/PST|PROVINCIAL/.test(t)) return 'PST';
  if (/GST|TPS|GOODS AND SERVICES/.test(t)) return 'GST';
  return 'SALES_TAX';
}

/** [{code, amount}] summed by code in a fixed order, zero codes dropped, amounts as 2dp strings. */
function byCode(entries) {
  const sums = new Map();
  for (const e of entries || []) {
    if (!e || !e.code) continue;
    sums.set(e.code, (sums.get(e.code) || 0) + cents(e.amount));
  }
  return CODE_ORDER.filter((c) => sums.get(c)).map((code) => ({ code, amount: (sums.get(code) / 100).toFixed(2) }))
    .concat([...sums.keys()].filter((c) => !CODE_ORDER.includes(c) && sums.get(c)).map((code) => ({ code, amount: (sums.get(code) / 100).toFixed(2) })));
}

const sumCodes = (list) => round2((list || []).reduce((s, e) => s + Number(e.amount), 0));

/** Shopify taxLines → [{code, amount}] (the `tax_charged` value). */
function taxChargedFromShopify(taxLines) {
  return byCode((taxLines || []).map((t) => ({ code: shopifyTaxCode(t.title), amount: amt(t.priceSet) })));
}

/**
 * Split a refunded tax total across the codes of the original charge in
 * proportion, so a BC refund comes back as GST + PST. Cents are exact: the
 * rounding remainder lands on the largest code.
 */
function prorateTax(total, charged) {
  const totalC = cents(total);
  const base = (charged || []).map((e) => ({ code: e.code, c: cents(e.amount) }));
  const baseC = base.reduce((s, e) => s + e.c, 0);
  if (!totalC) return [];
  if (!baseC) return [{ code: 'SALES_TAX', amount: (totalC / 100).toFixed(2) }];
  const parts = base.map((e) => ({ code: e.code, c: Math.trunc((totalC * e.c) / baseC) }));
  const rest = totalC - parts.reduce((s, e) => s + e.c, 0);
  const big = parts.reduce((m, e, i) => (Math.abs(base[i].c) > Math.abs(base[m].c) ? i : m), 0);
  parts[big].c += rest;
  return byCode(parts.map((e) => ({ code: e.code, amount: e.c / 100 })));
}

// ── Shopify ──────────────────────────────────────────────────────────────────

const numericId = (gid) => String(gid || '').replace(/^gid:\/\/shopify\/\w+\//, '');

/**
 * One Shopify order's money, from the GraphQL node fetched by
 * channel-tax-io.fetchShopifyOrderMoney. Line totals are after every discount
 * (line and order level), which is what the customer paid and what the tax was
 * charged on.
 */
function shopifyOrderMoney(o) {
  const lines = ((o.lineItems && o.lineItems.nodes) || []).map((li) => {
    const discount = (li.discountAllocations || []).reduce((s, d) => s + amt(d.allocatedAmountSet), 0);
    return {
      id: numericId(li.id),
      sku: li.sku || null,
      title: li.name || li.title || '',
      quantity: Number(li.quantity) || 0,
      currentQuantity: li.currentQuantity == null ? null : Number(li.currentQuantity),
      total: round2(amt(li.originalTotalSet) - discount),
      taxCharged: taxChargedFromShopify(li.taxLines),
    };
  });
  const shippingLines = ((o.shippingLines && o.shippingLines.nodes) || []).map((s) => ({
    title: s.title || 'Shipping',
    total: round2(amt(s.discountedPriceSet || s.originalPriceSet)),
    taxCharged: taxChargedFromShopify(s.taxLines),
  })).filter((s) => s.total || s.taxCharged.length);

  const fees = [];
  for (const t of o.transactions || []) {
    if (t.status && t.status !== 'SUCCESS') continue;
    for (const f of t.fees || []) fees.push({ kind: t.kind, type: f.type, amount: amt(f.amount), tax: amt(f.taxAmount) });
  }
  const fee = round2(fees.reduce((s, f) => s + f.amount + f.tax, 0));
  // PayPal (and any gateway but Shopify Payments) reports no fee to Shopify,
  // so the fee is unknown here, not zero (#1334, #1377 in Sep 2026).
  const paidVia = [...new Set((o.transactions || []).filter((t) => (!t.status || t.status === 'SUCCESS') && /SALE|CAPTURE/.test(t.kind || '')).map((t) => t.gateway).filter(Boolean))];
  const feeUnknown = paidVia.some((g) => g !== 'shopify_payments') && !fees.length;

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const shipCharged = byCode(shippingLines.flatMap((s) => s.taxCharged));
  const refunds = ((o.refunds || [])).map((r) => {
    const items = ((r.refundLineItems && r.refundLineItems.nodes) || []).map((n) => {
      const line = lineById.get(numericId(n.lineItem && n.lineItem.id)) || null;
      return {
        lineId: line ? line.id : numericId(n.lineItem && n.lineItem.id),
        sku: (n.lineItem && n.lineItem.sku) || (line && line.sku) || null,
        quantity: Number(n.quantity) || 0,
        subtotal: round2(amt(n.subtotalSet)),
        tax: prorateTax(amt(n.totalTaxSet), line ? line.taxCharged : []),
      };
    });
    const shipping = ((r.refundShippingLines && r.refundShippingLines.nodes) || []).map((n) => ({
      subtotal: round2(amt(n.subtotalAmountSet)),
      tax: prorateTax(amt(n.taxAmountSet), shipCharged),
    }));
    return {
      id: numericId(r.id),
      createdAt: r.createdAt,
      total: round2(amt(r.totalRefundedSet)),
      items,
      shipping,
      tax: byCode([...items.flatMap((i) => i.tax), ...shipping.flatMap((s) => s.tax)]),
    };
  });

  const subtotal = round2(amt(o.subtotalPriceSet));
  const shipping = round2(amt(o.totalShippingPriceSet));
  const tax = byCode([...lines.flatMap((l) => l.taxCharged), ...shippingLines.flatMap((s) => s.taxCharged)]);
  const total = round2(amt(o.totalPriceSet));
  const refunded = round2(amt(o.totalRefundedSet));
  return {
    orderNumber: o.name,
    id: numericId(o.id),
    createdAt: o.createdAt || null,
    cancelledAt: o.cancelledAt || null,
    financialStatus: o.displayFinancialStatus || null,
    province: provinceCode(o.shippingAddress && o.shippingAddress.provinceCode),
    country: (o.shippingAddress && o.shippingAddress.countryCodeV2) || null,
    subtotal,
    shipping,
    tax,
    taxTotal: sumCodes(tax),
    total,
    fee,
    fees,
    feeUnknown,
    paidVia,
    refunded,
    refunds,
    lines,
    shippingLines,
    // Lynnae's Salesforce figure: what the SO total was adjusted to (tax off,
    // Shopify's processing fee netted, freight in), before refunds.
    lynnaeNet: round2(subtotal + shipping - fee),
    fullyRefunded: refunded > 0 && cents(refunded) >= cents(total),
  };
}

/**
 * Unit price that reproduces a line total exactly at a given qty. Automayt
 * stores prices as sent (4 dp shown), so try the fewest decimals that land on
 * the cent; area items (rolls converted to sqft) need more than 2.
 */
function unitPriceFor(lineTotal, qty) {
  const q = Number(qty);
  const t = round2(lineTotal);
  if (!(q > 0)) throw new Error(`unitPriceFor: qty must be > 0 (got ${qty})`);
  for (let dp = 2; dp <= 8; dp++) {
    const p = (t / q).toFixed(dp);
    if (cents(Number(p) * q) === cents(t)) return String(Number(p));
  }
  return (t / q).toFixed(8);
}

/**
 * What a Shopify refund needs in Automayt, given the SO's state there.
 * Automayt's API (beta1 2026-10-14) refuses negative qty and negative price
 * and has no credit-note endpoint, so the only thing run-orders can post is a
 * cancel of a not-yet-invoiced order that was refunded in full. Everything
 * else is a credit note waiting on Automayt (open item with Aaron).
 */
function shopifyRefundPlan(money, so) {
  if (!money.refunds.length && !money.cancelledAt) return { action: 'none' };
  const soStatus = so ? String(so.status || '').toLowerCase() : null;
  const invoiced = !!so && (/invoic|closed|complete/.test(soStatus) || (so.invoices && so.invoices.length > 0));
  const feeNote = money.fee ? `Shopify kept its ${fix2(money.fee)} processing fee` : null;
  if (!so) return { action: 'no-so', reason: 'no Automayt sales order for this Shopify order', feeNote };
  if (soStatus === 'cancelled') return { action: 'none', reason: 'already cancelled', feeNote };
  if (money.fullyRefunded && !invoiced) {
    return { action: 'cancel', reason: `Shopify ${money.orderNumber} ${money.cancelledAt ? 'cancelled and ' : ''}refunded in full (${fix2(money.refunded)})`, feeNote };
  }
  return {
    action: 'credit-note-pending',
    reason: invoiced ? 'refund after invoicing needs a credit note' : 'partial refund needs a credit note or a line reduction',
    refunds: money.refunds,
    feeNote,
  };
}

// ── Amazon ───────────────────────────────────────────────────────────────────

/** UTC instant of local midnight starting ymd in tz (DST-safe). */
function zonedMidnightUtc(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    const offset = asUtc - guess;
    const next = Date.UTC(y, m - 1, d, 0, 0, 0) - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString().replace('.000Z', 'Z');
}

function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Seller Central's Date Range report is "indexed by posted date" in Pacific
// time (rows read PDT), so period windows are Pacific days. US Pacific falls
// back to PST on Nov 1, 2026 while BC stays at UTC-7; which one Amazon.ca
// follows shows in the first November report (amazon-compare). If its rows stay
// at UTC-7, set AMAZON_REPORT_TZ=Etc/GMT+7.
const AMAZON_REPORT_TZ = process.env.AMAZON_REPORT_TZ || 'America/Los_Angeles';

/** { postedAfter, postedBefore } covering local days start..end inclusive. */
function amazonWindow({ start, end }, tz = AMAZON_REPORT_TZ) {
  return { postedAfter: zonedMidnightUtc(start, tz), postedBefore: zonedMidnightUtc(addDaysYmd(end, 1), tz) };
}

/** Every period from the one holding `from` to the one holding `to`, on the anchor's 14-day schedule. */
function periodsBetween(anchor, from, to) {
  const out = [];
  let p = amazonPeriod(from, anchor);
  while (p.start <= to) {
    out.push(p);
    p = amazonPeriod(addDaysYmd(p.end, 1), anchor);
  }
  return out;
}

const AMAZON_CA = 'A2EUQ1WTGCTBG2';

const relatedId = (tx, name) => ((tx.relatedIdentifiers || []).find((r) => r.relatedIdentifierName === name) || {}).relatedIdentifierValue || null;

/**
 * Does a Finances API (2024-06-19) transaction count the way Seller Central's
 * Date Range report counts it? Since 2025 Amazon defers order money until
 * delivery; the deferred transaction keeps the original posted date
 * (DEFERRED, later DEFERRED_RELEASED) and its release is a second RELEASED
 * transaction carrying DEFERRED_TRANSACTION_ID, posted on the release date.
 * The report counts the first, never the release. Verified to the cent
 * against Lynnae's Sep 10-23 2026 CSV (every column).
 */
function countsLikeDateRange(tx) {
  const s = String(tx.transactionStatus || '');
  if (s.startsWith('DEFERRED')) return true;
  if (s === 'RELEASED') return !relatedId(tx, 'DEFERRED_TRANSACTION_ID');
  return false;
}

/**
 * Leaf amounts of one transaction's item breakdowns, sorted into the Date
 * Range report's columns. Tax on Amazon's own fees (Commission > Tax) is an
 * input tax credit, not tax collected, so only the item's top-level Tax
 * breakdown (and tax on promotional rebates) counts as collected.
 */
// Fee transactions (advertising, FBA service fees, subscriptions) carry their
// own Base/Tax breakdowns: GST/HST CFC paid on Amazon's fees, not tax it
// collected. Counting ProductAdsPayment > Tax put Sep 10-23 off by $60.06.
const FEE_TRANSACTION = /ProductAds|ServiceFee|Fee|Subscription|Transfer|Reimbursement/i;

function transactionColumns(tx) {
  const col = { principal: 0, shipping: 0, giftWrap: 0, promotions: 0, collected: 0, withheld: 0 };
  if (FEE_TRANSACTION.test(String(tx.transactionType || ''))) return col;
  const leaves = (list, fn, path = []) => {
    for (const b of list || []) {
      const p = [...path, b.breakdownType];
      if (b.breakdowns && b.breakdowns.length) leaves(b.breakdowns, fn, p);
      else fn(p, Number(b.breakdownAmount && b.breakdownAmount.currencyAmount) || 0);
    }
  };
  for (const item of tx.items || []) {
    leaves(item.breakdowns, (p, v) => {
      const top = p[0];
      const leaf = p[p.length - 1];
      if (/^MarketplaceFacilitatorTax/i.test(leaf)) col.withheld += v;
      else if (top === 'Tax') col.collected += v;
      else if (top === 'ProductCharges') col.principal += v;
      else if (top === 'Shipping') col.shipping += v;
      else if (top === 'GiftWrap') col.giftWrap += v;
      else if (top === 'PromoRebates') { if (/Tax$/.test(leaf)) col.collected += v; else col.promotions += v; }
    });
  }
  for (const k of Object.keys(col)) col[k] = round2(col[k]);
  return col;
}

/** CFC's code for the tax Amazon left with CFC, by province, or by the effective rate when the province is unknown. */
function cfcTaxCode(province, { base, collected, withheld }) {
  if (province) return HST_PROVINCES.has(province) ? 'HST' : 'GST';
  if (withheld) return 'GST';
  const rate = base ? Math.abs(collected / base) : 0;
  return rate > 0.09 ? 'HST' : 'GST';
}

function withheldTaxCode(province, { base, withheld }) {
  if (province) return WITHHELD_CODE[province] || 'SALES_TAX';
  const rate = base ? Math.abs(withheld / base) : 0;
  if (Math.abs(rate - 0.09975) < 0.004) return 'QST';
  return 'PST';
}

/**
 * Tax summary of a set of Finances API transactions, the way Lynnae's
 * autosum works: collected (product + shipping + gift wrap + promo tax),
 * withheld by Amazon, CFC's share (collected + withheld, withheld negative),
 * split by province and code. `provinceOf(orderId)` → 'ON' | null.
 * `netExTax` is the figure Lynnae adjusts the Salesforce period SO to:
 * report total without transfers, minus every tax column.
 */
function amazonTaxSummary(transactions, { provinceOf = () => null, marketplaceId = AMAZON_CA } = {}) {
  // Another marketplace (Amazon.com US sold under the same account in 2026)
  // is US sales tax Amazon withholds in full: flagged, never folded in.
  const otherMarketplace = [];
  const counted = transactions.filter(countsLikeDateRange).filter((tx) => {
    const mp = (tx.marketplaceDetails && tx.marketplaceDetails.marketplaceId) || (tx.sellingPartnerMetadata && tx.sellingPartnerMetadata.marketplaceId) || marketplaceId;
    if (mp === marketplaceId) return true;
    const c = transactionColumns(tx);
    otherMarketplace.push({ transactionId: tx.transactionId, orderId: relatedId(tx, 'ORDER_ID'), marketplace: (tx.marketplaceDetails && tx.marketplaceDetails.marketplaceName) || mp, collected: c.collected, withheld: c.withheld, total: Number(tx.totalAmount && tx.totalAmount.currencyAmount) || 0 });
    return false;
  });
  const sum = { principal: 0, shipping: 0, giftWrap: 0, promotions: 0, collected: 0, withheld: 0 };
  const split = { orders: { collected: 0, withheld: 0 }, refunds: { collected: 0, withheld: 0 } };
  const prov = new Map();
  const cfc = [];
  const withheldBy = [];
  const inferred = [];
  let totalNoTransfers = 0;
  const types = {};

  for (const tx of counted) {
    types[tx.transactionType] = (types[tx.transactionType] || 0) + 1;
    if (tx.transactionType !== 'Transfer') totalNoTransfers += Number(tx.totalAmount && tx.totalAmount.currencyAmount) || 0;
    const c = transactionColumns(tx);
    for (const k of Object.keys(sum)) sum[k] += c[k];
    const bucket = tx.transactionType === 'Refund' ? split.refunds : split.orders;
    bucket.collected += c.collected;
    bucket.withheld += c.withheld;
    if (!c.collected && !c.withheld) continue;

    const orderId = relatedId(tx, 'ORDER_ID');
    const province = provinceCode(provinceOf(orderId));
    const base = c.principal + c.shipping + c.giftWrap + c.promotions;
    const cfcCode = cfcTaxCode(province, { base, collected: c.collected, withheld: c.withheld });
    const whCode = c.withheld ? withheldTaxCode(province, { base, withheld: c.withheld }) : null;
    if (!province) {
      // Unknown province: code from the effective rate, flagged for a look. A
      // fully withheld row is the US pattern, so it is called out on its own.
      const fullyWithheld = c.collected && cents(c.collected + c.withheld) === 0;
      inferred.push({ orderId, transactionId: tx.transactionId, cfcCode, withheldCode: whCode, collected: c.collected, withheld: c.withheld, fullyWithheld });
    }
    const key = province || 'unknown';
    const row = prov.get(key) || { province: key, transactions: 0, principal: 0, shipping: 0, collected: 0, withheld: 0, cfc: 0, cfcCode, withheldCode: whCode };
    row.transactions += 1;
    row.principal += c.principal;
    row.shipping += c.shipping;
    row.collected += c.collected;
    row.withheld += c.withheld;
    row.cfc += c.collected + c.withheld;
    if (whCode) row.withheldCode = whCode;
    prov.set(key, row);
    cfc.push({ code: cfcCode, amount: round2(c.collected + c.withheld) });
    if (whCode) withheldBy.push({ code: whCode, amount: round2(-c.withheld) });
  }

  for (const k of Object.keys(sum)) sum[k] = round2(sum[k]);
  const byProvince = [...prov.values()].map((r) => ({
    ...r, principal: round2(r.principal), shipping: round2(r.shipping), collected: round2(r.collected), withheld: round2(r.withheld), cfc: round2(r.cfc),
  })).sort((a, b) => b.collected - a.collected);
  return {
    transactions: { fetched: transactions.length, counted: counted.length, byType: types },
    sales: { principal: sum.principal, shipping: sum.shipping, giftWrap: sum.giftWrap, promotions: sum.promotions },
    tax: {
      collected: sum.collected,
      collectedOnOrders: round2(split.orders.collected),
      refundedOnRefunds: round2(split.refunds.collected),
      withheld: sum.withheld,
      withheldOnOrders: round2(split.orders.withheld),
      withheldBackOnRefunds: round2(split.refunds.withheld),
      cfc: round2(sum.collected + sum.withheld),
    },
    cfcByCode: byCode(cfc),
    withheldByCode: byCode(withheldBy),
    byProvince,
    inferredProvince: inferred,
    otherMarketplace,
    netExTax: round2(totalNoTransfers - sum.collected - sum.withheld),
    totalWithoutTransfers: round2(totalNoTransfers),
  };
}

/**
 * The Automayt line that books CFC's Amazon GST/HST for a period on the
 * period order: a tax-only line (qty 1, price 0) whose tax_charged is CFC's
 * share by code. Automayt books tax_charged even on the order's exempt lines
 * (beta1 2026-10-14). Withheld provincial tax is Amazon's to remit and is
 * never posted. The external_line_ref makes a re-post a skip.
 */
function amazonTaxLine(summary, period) {
  return {
    description: `Amazon.ca GST/HST collected, ${period.label} (${period.start} to ${period.end}); Amazon remitted the provincial tax`,
    qty: '1',
    unit_price: '0',
    external_line_ref: `tax:${period.start}`,
    tax_charged: summary.cfcByCode,
  };
}

// ── Seller Central Date Range CSV (Lynnae's file) ────────────────────────────

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Column totals of a Seller Central Date Range "CustomTransaction" CSV, the
 * same autosum Lynnae does (header block skipped, a hand-added total row
 * ignored), so a downloaded report can be checked against the API.
 */
function dateRangeCsvTotals(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const h = lines.findIndex((l) => /^"?date\/time"?,"?settlement/i.test(l));
  if (h < 0) throw new Error('not a Date Range CustomTransaction CSV (no date/time,settlement header)');
  const header = parseCsvLine(lines[h]).map((s) => s.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const num = (v) => {
    const s = String(v || '').replace(/[,$]/g, '').trim();
    const n = Number(s.startsWith('(') ? `-${s.slice(1, -1)}` : s);
    return Number.isFinite(n) ? n : 0;
  };
  const cols = ['product sales', 'product sales tax', 'shipping credits', 'shipping credits tax', 'gift wrap credits', 'gift wrap credits tax',
    'promotional rebates', 'promotional rebates tax', 'marketplace withheld tax', 'selling fees', 'fba fees', 'other transaction fees', 'other', 'total'];
  const t = Object.fromEntries(cols.map((c) => [c, 0]));
  let rows = 0;
  let transfers = 0;
  for (const line of lines.slice(h + 1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!String(cells[0] || '').trim()) continue; // hand-added autosum row
    rows += 1;
    const isTransfer = String(cells[idx('type')] || '').trim() === 'Transfer';
    for (const c of cols) {
      if (idx(c) < 0) continue;
      if (isTransfer && c === 'total') transfers += num(cells[idx(c)]);
      t[c] += num(cells[idx(c)]);
    }
  }
  for (const c of cols) t[c] = round2(t[c]);
  const collected = round2(t['product sales tax'] + t['shipping credits tax'] + t['gift wrap credits tax'] + t['promotional rebates tax']);
  return {
    rows,
    columns: t,
    collected,
    withheld: t['marketplace withheld tax'],
    cfc: round2(collected + t['marketplace withheld tax']),
    totalWithoutTransfers: round2(t.total - transfers),
    netExTax: round2(t.total - transfers - collected - t['marketplace withheld tax']),
  };
}

// ── Records ──────────────────────────────────────────────────────────────────

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label || c.key)).join(','), ...rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','))].join('\n') + '\n';
}

module.exports = {
  AMAZON_CA,
  CODE_ORDER,
  HST_PROVINCES,
  WITHHELD_CODE,
  AMAZON_REPORT_TZ,
  provinceCode,
  round2,
  shopifyTaxCode,
  byCode,
  sumCodes,
  taxChargedFromShopify,
  prorateTax,
  shopifyOrderMoney,
  unitPriceFor,
  shopifyRefundPlan,
  zonedMidnightUtc,
  addDaysYmd,
  amazonWindow,
  periodsBetween,
  countsLikeDateRange,
  transactionColumns,
  amazonTaxSummary,
  amazonTaxLine,
  dateRangeCsvTotals,
  toCsv,
};
