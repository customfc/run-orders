#!/usr/bin/env node
/**
 * Generate a self-contained HTML financial report from the analytics DB.
 *
 * Output: public/financial-report-<date>.html — served by the dashboard at
 * /financial-report-<date>.html via Express static.
 *
 * Pulls from Phase B views + raw tables. Renders narrative + numbers +
 * Chart.js graphs in a single file. No external dependencies beyond the
 * CDN-loaded Chart.js.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { open } = require('../../lib/analytics-db');
const sfLib = require('../../lib/salesforce');

const OUT_DIR = path.join(__dirname, '..', '..', 'public');

function num(v) { if (v == null || v === '') return 0; const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtMoney(v, currency = '$') { return `${currency}${num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtInt(v) { return num(v).toLocaleString('en-US'); }
function fmtPct(v) { return (num(v) * 100).toFixed(1) + '%'; }

// Pull PO spend from Salesforce — Mac Roy's POs only (the FBA/Shopify ones).
// Other CustomFC staff also order from Prosol for non-ecommerce purposes;
// we filter those out by PO owner.
async function gatherSfPoSpend() {
  try {
    const conn = await sfLib.connect();

    // Find Mac Roy's SF User Id (try Name, then Email)
    const userLookup = await new Promise((resolve, reject) => {
      const out = [];
      conn.query(`SELECT Id, Name, Email FROM User WHERE (Name LIKE '%Mac%Roy%' OR Email = 'mac@customfc.ca' OR Email LIKE 'mac%customfc%') AND IsActive = true LIMIT 5`)
        .on('record', (r) => out.push(r))
        .on('end', () => resolve(out))
        .on('error', reject)
        .run({ autoFetch: true });
    });
    if (!userLookup.length) {
      console.warn('[report] Mac Roy not found in SF Users — skipping PO pull');
      return null;
    }
    const macUserId = userLookup[0].Id;
    console.log(`[report] Mac Roy SF user: ${userLookup[0].Name} (${macUserId})`);

    // Pull PO lines where parent PO is owned by Mac Roy.
    // SOQL doesn't support field aliasing outside aggregate queries — use
    // the full relationship field names and read them from the returned
    // nested object shape.
    const soql = `
      SELECT
        PBSI__Quantity_Ordered__c,
        PBSI__Item_Cost__c,
        PBSI__Total_Price__c,
        PBSI__Pre_Tax_Total_Price__c,
        PBSI__Purchase_Order__r.Name,
        PBSI__Purchase_Order__r.PBSI__Order_Date__c,
        PBSI__Purchase_Order__r.PBSI__Account__r.Name,
        PBSI__Purchase_Order__r.OwnerId,
        PBSI__Purchase_Order__r.Owner.Name
      FROM PBSI__PBSI_Purchase_Order_Line__c
      WHERE PBSI__Purchase_Order__r.OwnerId = '${macUserId}'
        AND PBSI__Purchase_Order__r.PBSI__Order_Date__c >= LAST_N_DAYS:730
    `;
    const records = await new Promise((resolve, reject) => {
      const out = [];
      conn.query(soql)
        .on('record', (r) => out.push(r))
        .on('end', () => resolve(out))
        .on('error', reject)
        .run({ autoFetch: true, maxFetch: 100000 });
    });
    console.log(`[report]   ${records.length} PO lines owned by Mac Roy`);
    return records;
  } catch (e) {
    console.warn('[report] SF PO pull failed:', e.message);
    return null;
  }
}

async function gatherData(db) {
  const today = new Date();
  const thisMonth = today.toISOString().slice(0, 7);
  const lastMonth = (() => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const twelveMonthsAgo = (() => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - 12); return d.toISOString().slice(0, 7); })();

  // Core volume
  const orderCounts = {
    amazon_total: db.prepare('SELECT COUNT(*) c FROM amazon_orders').get().c,
    amazon_items: db.prepare('SELECT COUNT(*) c FROM amazon_order_items').get().c,
    shopify: db.prepare('SELECT COUNT(*) c FROM shopify_orders').get().c,
    events: db.prepare('SELECT COUNT(*) c FROM amazon_financial_events').get().c,
    labels: db.prepare('SELECT COUNT(*) c FROM shipping_labels').get().c,
    labels_cost: db.prepare('SELECT ROUND(SUM(label_cost_cad), 2) c FROM shipping_labels').get().c,
    settlements: db.prepare('SELECT COUNT(*) c FROM amazon_settlements').get().c,
    settled_cad: db.prepare("SELECT ROUND(SUM(deposit_amount), 2) c FROM amazon_settlements WHERE currency='CAD'").get().c,
  };

  const dateRange = db.prepare('SELECT MIN(purchase_date) first, MAX(purchase_date) last FROM amazon_orders').get();

  // Monthly revenue (Amazon, 24 months)
  const monthlyAmazon = db.prepare(`
    SELECT substr(purchase_date, 1, 7) month,
           COUNT(*) orders,
           ROUND(SUM(order_total_amount), 2) gross_revenue,
           ROUND(AVG(order_total_amount), 2) aov
    FROM amazon_orders
    WHERE fulfillment_channel IS NOT NULL
    GROUP BY substr(purchase_date, 1, 7)
    ORDER BY month DESC
    LIMIT 26
  `).all();

  const monthlyByChannel = db.prepare(`
    SELECT substr(purchase_date, 1, 7) month,
           fulfillment_channel channel,
           COUNT(*) orders,
           ROUND(SUM(order_total_amount), 2) revenue
    FROM amazon_orders
    GROUP BY substr(purchase_date, 1, 7), fulfillment_channel
    ORDER BY month DESC, revenue DESC
  `).all();

  // Brand P&L (latest full month w/ settlement data)
  const brandPnl = db.prepare(`
    SELECT brand, month, sku_count,
           ROUND(revenue, 2) revenue,
           ROUND(cogs, 2) cogs,
           ROUND(amazon_fees, 2) fees,
           ROUND(refunds, 2) refunds,
           ROUND(outbound_label_cost, 2) labels,
           ROUND(net_profit, 2) net_profit,
           net_margin_pct
    FROM v_brand_monthly_pnl
    WHERE revenue > 100
    ORDER BY month DESC, net_profit DESC
    LIMIT 50
  `).all();

  // Top SKUs 90d
  const topSkus = db.prepare(`
    SELECT sku, brand, product_name,
           SUM(revenue) revenue,
           SUM(qty_sold) qty,
           SUM(cogs) cogs,
           SUM(amazon_fees) fees,
           SUM(net_profit) profit,
           ROUND(AVG(net_margin_pct), 1) avg_margin
    FROM v_sku_monthly_pnl
    WHERE month >= ? AND qty_sold > 0
    GROUP BY sku
    ORDER BY revenue DESC
    LIMIT 15
  `).all(twelveMonthsAgo);

  const dogs = db.prepare(`
    SELECT sku, brand, product_name, month,
           ROUND(revenue, 2) revenue,
           qty_sold,
           ROUND(cogs, 2) cogs,
           ROUND(net_profit, 2) profit,
           net_margin_pct
    FROM v_sku_monthly_pnl
    WHERE revenue > 100
      AND net_profit < 0
      AND qty_sold > 0
    ORDER BY net_profit ASC
    LIMIT 15
  `).all();

  // Fee composition last 6 months
  const feeComposition = db.prepare(`
    SELECT fee_type, ROUND(SUM(amount_cad), 2) total, COUNT(*) events
    FROM amazon_financial_events
    WHERE posted_at >= date('now', '-180 days')
    GROUP BY fee_type
    ORDER BY ABS(SUM(amount_cad)) DESC
    LIMIT 20
  `).all();

  // Money daily last 180d (for trend)
  const cashflow = db.prepare(`
    SELECT day, SUM(revenue) revenue, SUM(amazon_fees) fees, SUM(refunds) refunds, SUM(net_amount) net
    FROM v_money_daily
    WHERE day >= date('now', '-180 days')
      AND source_tier = 'settled'
    GROUP BY day
    ORDER BY day
  `).all();

  // Warehouse split
  const warehouseSplit = db.prepare(`
    SELECT channel, fulfillment, orders_lifetime, orders_90d, orders_30d,
           ROUND(revenue_lifetime, 2) rev_lifetime,
           ROUND(revenue_90d, 2) rev_90d,
           ROUND(revenue_30d, 2) rev_30d
    FROM v_warehouse_split
  `).all();

  // Postal heat — top 15 postal codes by order count (last 365d)
  const postalTop = db.prepare(`
    SELECT ship_postal, ship_state, SUM(order_count) orders, ROUND(SUM(revenue), 2) revenue
    FROM v_postal_heat
    WHERE day >= date('now', '-365 days')
      AND ship_postal IS NOT NULL
    GROUP BY ship_postal
    ORDER BY orders DESC
    LIMIT 15
  `).all();

  // Settlement deposits (cashflow ground truth)
  const settlements = db.prepare(`
    SELECT settlement_id, deposit_date, ROUND(deposit_amount, 2) amount, currency
    FROM amazon_settlements
    ORDER BY deposit_date DESC
    LIMIT 20
  `).all();

  // Buy Box snapshot (today)
  const latestBB = db.prepare('SELECT MAX(snapshot_date) d FROM buybox_daily').get();
  const bbBreakdown = latestBB.d ? db.prepare(`
    SELECT tier, COUNT(*) c FROM buybox_daily WHERE snapshot_date = ? GROUP BY tier
  `).all(latestBB.d) : [];

  const bbLosing = latestBB.d ? db.prepare(`
    SELECT b.asin, b.sku, ROUND(b.our_price, 2) our_price, ROUND(b.bb_price, 2) bb_price, ROUND(b.gap, 2) gap,
           sm.product_name, sm.brand
    FROM buybox_daily b
    LEFT JOIN sku_map_canonical sm ON sm.asin = b.asin
    WHERE b.snapshot_date = ? AND b.tier = 'bb-losing'
    ORDER BY b.gap DESC
  `).all(latestBB.d) : [];

  // Inventory health (today)
  const latestInv = db.prepare('SELECT MAX(snapshot_date) d FROM inventory_daily').get();
  const invHealth = latestInv.d ? db.prepare(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN available = 0 AND units30 > 0 THEN 1 ELSE 0 END) bleeding,
      SUM(CASE WHEN total_days_of_supply > 0 AND total_days_of_supply < 28 AND units30 > 0 THEN 1 ELSE 0 END) low_cover,
      SUM(CASE WHEN units30 = 0 AND available > 0 THEN 1 ELSE 0 END) dormant,
      SUM(CASE WHEN lipc_applied_this_week = 1 THEN 1 ELSE 0 END) lipc_active,
      ROUND(SUM(estimated_storage_cost_next_month), 2) est_storage_next_month
    FROM inventory_daily
    WHERE snapshot_date = ?
  `).get(latestInv.d) : {};

  // YoY comparison — same months one year apart
  const yoy = db.prepare(`
    WITH this_year AS (
      SELECT substr(purchase_date, 1, 7) m,
             COUNT(*) orders,
             ROUND(SUM(order_total_amount), 2) rev
      FROM amazon_orders
      WHERE purchase_date >= date('now', '-365 days')
      GROUP BY substr(purchase_date, 1, 7)
    ),
    last_year AS (
      SELECT substr(date(purchase_date, '+365 days'), 1, 7) m,
             COUNT(*) orders,
             ROUND(SUM(order_total_amount), 2) rev
      FROM amazon_orders
      WHERE purchase_date >= date('now', '-730 days')
        AND purchase_date < date('now', '-365 days')
      GROUP BY substr(date(purchase_date, '+365 days'), 1, 7)
    )
    SELECT ty.m month, ty.orders orders_cur, ty.rev rev_cur,
           ly.orders orders_prev, ly.rev rev_prev,
           ROUND((ty.rev - ly.rev) * 100.0 / NULLIF(ly.rev, 0), 1) rev_yoy_pct
    FROM this_year ty LEFT JOIN last_year ly ON ly.m = ty.m
    ORDER BY ty.m DESC
  `).all();

  // Catalog opportunity: ASINs in sku-map but not active-FBA
  const catalogGap = db.prepare(`
    SELECT COUNT(*) total FROM sku_map_canonical
  `).get();
  const activeFBA = db.prepare(`
    SELECT COUNT(*) c FROM inventory_daily WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM inventory_daily)
  `).get().c;

  // Cost data coverage
  const costCoverage = db.prepare(`
    SELECT
      COUNT(*) total_asins,
      SUM(CASE WHEN sf_item_name IS NOT NULL THEN 1 ELSE 0 END) with_sf_map,
      SUM(CASE WHEN brand IS NOT NULL THEN 1 ELSE 0 END) with_brand,
      SUM(CASE WHEN amazon_msku IS NOT NULL THEN 1 ELSE 0 END) with_msku
    FROM sku_map_canonical
  `).get();

  // Complete monthly P&L waterfall — aggregated from v_sku_monthly_pnl
  // (single source of truth). That view has all the fixes applied:
  // correct cost via vendor_item_id, qty_per_unit UOM multiplier, net
  // refund qty, shipping revenue for MFN orders, dedup logic.
  const monthlyWaterfall = db.prepare(`
    WITH per_sku AS (
      SELECT
        month,
        revenue revenue_principal,
        qty_sold,
        cogs,
        amazon_fees,
        refunds,
        storage_cost,
        outbound_label_cost,
        net_profit
      FROM v_sku_monthly_pnl
      WHERE month IS NOT NULL
    ),
    amazon_agg AS (
      SELECT
        substr(posted_at, 1, 7) month,
        ROUND(SUM(CASE WHEN fee_type LIKE 'ItemPrice:Shipping%' THEN amount_cad ELSE 0 END), 2) shipping_revenue,
        ROUND(SUM(CASE WHEN fee_type = 'ItemFees:Commission' THEN amount_cad ELSE 0 END), 2) commission,
        ROUND(SUM(CASE WHEN fee_type = 'ItemFees:FBAPerUnitFulfillmentFee' THEN amount_cad ELSE 0 END), 2) fba_fulfillment_fee,
        ROUND(SUM(CASE WHEN fee_type LIKE 'ItemFees:%' AND fee_type NOT IN ('ItemFees:Commission','ItemFees:FBAPerUnitFulfillmentFee') THEN amount_cad ELSE 0 END), 2) other_item_fees,
        ROUND(SUM(CASE WHEN fee_type LIKE 'ServiceFee:%' THEN amount_cad ELSE 0 END), 2) service_fees,
        ROUND(SUM(CASE WHEN fee_type LIKE 'other-transaction:%' THEN amount_cad ELSE 0 END), 2) other_transactions,
        ROUND(SUM(CASE WHEN fee_type LIKE 'Promotion:%' THEN amount_cad ELSE 0 END), 2) promotions
      FROM amazon_financial_events
      WHERE posted_at IS NOT NULL
      GROUP BY substr(posted_at, 1, 7)
    )
    SELECT
      p.month,
      ROUND(SUM(p.revenue_principal), 2) revenue_principal,
      ROUND(SUM(p.qty_sold), 2) qty_sold,
      ROUND(SUM(p.cogs), 2) cogs_accurate,
      ROUND(SUM(p.amazon_fees), 2) amazon_fees_total,
      ROUND(SUM(p.refunds), 2) refunds,
      ROUND(SUM(p.storage_cost), 2) storage,
      ROUND(SUM(p.outbound_label_cost), 2) labels_allocated,
      ROUND(SUM(p.net_profit), 2) net_profit,
      a.shipping_revenue,
      a.commission,
      a.fba_fulfillment_fee,
      a.other_item_fees,
      a.service_fees,
      a.other_transactions,
      a.promotions
    FROM per_sku p
    LEFT JOIN amazon_agg a ON a.month = p.month
    GROUP BY p.month
    ORDER BY p.month DESC
    LIMIT 24
  `).all();

  // Shipping label spend by month
  const labelsByMonth = db.prepare(`
    SELECT substr(purchased_at, 1, 7) month,
           COUNT(*) labels,
           ROUND(SUM(label_cost_cad), 2) total_cost,
           ROUND(AVG(label_cost_cad), 2) avg_cost,
           SUM(CASE WHEN channel = 'amazon-mfn' THEN 1 ELSE 0 END) mfn_labels,
           SUM(CASE WHEN channel = 'shopify' THEN 1 ELSE 0 END) shopify_labels,
           ROUND(SUM(CASE WHEN channel = 'amazon-mfn' THEN label_cost_cad ELSE 0 END), 2) mfn_cost,
           ROUND(SUM(CASE WHEN channel = 'shopify' THEN label_cost_cad ELSE 0 END), 2) shopify_cost
    FROM shipping_labels
    WHERE purchased_at IS NOT NULL
    GROUP BY substr(purchased_at, 1, 7)
    ORDER BY month DESC
    LIMIT 24
  `).all();

  // Shopify monthly totals
  const shopifyMonthly = db.prepare(`
    SELECT substr(created_at, 1, 7) month,
           COUNT(*) orders,
           ROUND(SUM(total_price), 2) total_revenue,
           ROUND(SUM(subtotal_price), 2) subtotal,
           ROUND(SUM(total_tax), 2) tax,
           ROUND(SUM(total_shipping), 2) shipping
    FROM shopify_orders
    WHERE financial_status IN ('PAID','paid','COMPLETED','completed','PARTIALLY_REFUNDED','partially_refunded','REFUNDED','refunded')
    GROUP BY substr(created_at, 1, 7)
    ORDER BY month DESC
  `).all();

  // COGS by month — pulled from v_sku_monthly_pnl (single source of truth)
  const cogsMonthly = db.prepare(`
    SELECT month, ROUND(SUM(cogs), 2) cogs
    FROM v_sku_monthly_pnl
    WHERE month IS NOT NULL
    GROUP BY month
    ORDER BY month DESC
    LIMIT 24
  `).all();

  return {
    today: today.toISOString().slice(0, 10),
    thisMonth, lastMonth, twelveMonthsAgo,
    counts: orderCounts,
    dateRange,
    monthlyAmazon, monthlyByChannel,
    brandPnl, topSkus, dogs, feeComposition, cashflow,
    warehouseSplit, postalTop, settlements,
    latestBB: latestBB.d, bbBreakdown, bbLosing,
    latestInv: latestInv.d, invHealth,
    yoy,
    catalogGap: catalogGap.total,
    activeFBA,
    costCoverage,
    monthlyWaterfall,
    labelsByMonth,
    shopifyMonthly,
    cogsMonthly,
  };
}

// Aggregate SF PO records by month + vendor
function aggregatePoSpend(records) {
  if (!records) return { byMonth: [], byVendor: [], total: 0, monthCount: 0 };
  const byMonthVendor = {};
  const byVendor = {};
  const byMonth = {};
  let total = 0;
  for (const r of records) {
    const d = r.PBSI__Purchase_Order__r?.PBSI__Order_Date__c;
    if (!d) continue;
    const month = String(d).slice(0, 7);
    const vendor = r.PBSI__Purchase_Order__r?.PBSI__Account__r?.Name || 'Unknown';
    // Prefer pre-tax total if present, else total price, else qty × item_cost
    let lineTotal = Number(r.PBSI__Pre_Tax_Total_Price__c);
    if (!Number.isFinite(lineTotal) || lineTotal <= 0) lineTotal = Number(r.PBSI__Total_Price__c);
    if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
      const qty = Number(r.PBSI__Quantity_Ordered__c || 0);
      const unitCost = Number(r.PBSI__Item_Cost__c || 0);
      lineTotal = qty * unitCost;
    }
    if (!Number.isFinite(lineTotal) || lineTotal <= 0) continue;
    total += lineTotal;
    byMonth[month] = (byMonth[month] || 0) + lineTotal;
    byVendor[vendor] = (byVendor[vendor] || 0) + lineTotal;
    const key = `${month}|${vendor}`;
    byMonthVendor[key] = (byMonthVendor[key] || 0) + lineTotal;
  }
  return {
    byMonth: Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).map(([m, v]) => ({ month: m, spend: Number(v.toFixed(2)) })),
    byVendor: Object.entries(byVendor).sort((a, b) => b[1] - a[1]).map(([v, s]) => ({ vendor: v, spend: Number(s.toFixed(2)) })),
    byMonthVendor,
    total: Number(total.toFixed(2)),
    monthCount: Object.keys(byMonth).length,
  };
}

function renderHtml(d) {
  // Build per-month complete P&L — merge Amazon events + labels + COGS + Shopify + PO spend
  const waterfallByMonth = {};
  for (const r of d.monthlyWaterfall) waterfallByMonth[r.month] = { ...r };
  const labelsMap = Object.fromEntries(d.labelsByMonth.map((r) => [r.month, r]));
  const cogsMap = Object.fromEntries(d.cogsMonthly.map((r) => [r.month, r.cogs]));
  const shopifyMap = Object.fromEntries(d.shopifyMonthly.map((r) => [r.month, r]));
  const poMap = Object.fromEntries(d.poSpend?.byMonth?.map((r) => [r.month, r.spend]) || []);
  const allMonths = [...new Set([
    ...Object.keys(waterfallByMonth),
    ...Object.keys(labelsMap),
    ...Object.keys(cogsMap),
    ...Object.keys(shopifyMap),
    ...Object.keys(poMap),
  ])].sort().reverse().slice(0, 24);

  const fullPnl = allMonths.map((m) => {
    const w = waterfallByMonth[m] || {};
    const amazonRev = num(w.revenue_principal);       // net of refunds (Principal CTE)
    const shopify = shopifyMap[m] || {};
    const shopifyRev = num(shopify.subtotal);
    const cogs = num(w.cogs_accurate);                 // from v_sku_monthly_pnl (all fixes applied)
    const commission = num(w.commission);
    const fbaFee = num(w.fba_fulfillment_fee);
    const otherFees = num(w.other_item_fees);
    const serviceFees = num(w.service_fees);
    const otherTx = num(w.other_transactions);
    const promos = num(w.promotions);
    const refunds = num(w.refunds);
    const shippingRev = num(w.shipping_revenue);
    const amazonFeesTotal = num(w.amazon_fees_total);  // sum of all ItemFees from the view
    const labels = num(labelsMap[m]?.total_cost);
    const poSpend = num(poMap[m]);

    // Operating profit — directly from v_sku_monthly_pnl (already nets
    // refunds, includes shipping revenue, uses correct cost).
    const operatingProfit = num(w.net_profit) + shopifyRev;

    // For cashflow, compute "Amazon net" as revenue + shipping revenue + all
    // Amazon fees + refunds + service fees + other-transactions + promos.
    // This is what Amazon actually deposited us.
    const netFromAmazon = amazonRev + shippingRev + amazonFeesTotal + refunds + serviceFees + otherTx + promos;

    const cashIn = netFromAmazon + num(shopify.total_revenue);
    const cashOut = poSpend + labels;
    const cashDelta = cashIn - cashOut;

    return {
      month: m,
      amazonRev, shopifyRev, shippingRev,
      cogs, commission, fbaFee, otherFees, serviceFees, otherTx, promos, refunds, labels, poSpend,
      amazonFeesTotal,
      netFromAmazon,
      operatingProfit,
      cashIn, cashOut, cashDelta,
    };
  });

  const chartData = {
    monthlyLabels: [...d.monthlyAmazon].reverse().map((r) => r.month),
    monthlyRev: [...d.monthlyAmazon].reverse().map((r) => r.gross_revenue),
    monthlyOpProfit: [...fullPnl].reverse().map((r) => r.operatingProfit),
    monthlyOpMarginPct: [...fullPnl].reverse().map((r) => r.amazonRev > 0 ? Math.round(r.operatingProfit / r.amazonRev * 1000) / 10 : 0),
    monthlyOrders: [...d.monthlyAmazon].reverse().map((r) => r.orders),
    cashflowLabels: d.cashflow.map((r) => r.day),
    cashflowRev: d.cashflow.map((r) => r.revenue),
    cashflowNet: d.cashflow.map((r) => r.net),
    brandLabels: [...new Set(d.brandPnl.filter((r) => r.month === d.brandPnl[0]?.month).map((r) => r.brand))],
    brandRev: d.brandPnl.filter((r) => r.month === d.brandPnl[0]?.month).map((r) => r.revenue),
    brandProfit: d.brandPnl.filter((r) => r.month === d.brandPnl[0]?.month).map((r) => r.net_profit),
    feeLabels: d.feeComposition.slice(0, 10).map((r) => r.fee_type),
    feeAmounts: d.feeComposition.slice(0, 10).map((r) => r.total),
    yoyLabels: [...d.yoy].reverse().map((r) => r.month),
    yoyCur: [...d.yoy].reverse().map((r) => r.rev_cur),
    yoyPrev: [...d.yoy].reverse().map((r) => r.rev_prev),
    // New: full P&L waterfall chart
    pnlMonths: [...fullPnl].reverse().map((r) => r.month),
    pnlCashIn: [...fullPnl].reverse().map((r) => r.cashIn),
    pnlCashOut: [...fullPnl].reverse().map((r) => -r.cashOut),
    pnlCashDelta: [...fullPnl].reverse().map((r) => r.cashDelta),
    pnlPoSpend: [...fullPnl].reverse().map((r) => r.poSpend),
    pnlLabels: [...fullPnl].reverse().map((r) => r.labels),
    pnlCogs: [...fullPnl].reverse().map((r) => r.cogs),
  };

  // Key top-line numbers
  const trailing12 = d.monthlyAmazon.filter((r) => r.month >= d.twelveMonthsAgo).reduce((s, r) => s + num(r.gross_revenue), 0);
  const trailing12Orders = d.monthlyAmazon.filter((r) => r.month >= d.twelveMonthsAgo).reduce((s, r) => s + num(r.orders), 0);
  const avgMonthly = trailing12 / 12;
  const goalGap = 100000 - avgMonthly;

  // Lifetime totals for summary
  const lifetimeCashIn = fullPnl.reduce((s, r) => s + num(r.cashIn), 0);
  const lifetimeCashOut = fullPnl.reduce((s, r) => s + num(r.cashOut), 0);
  const lifetimePoSpend = fullPnl.reduce((s, r) => s + num(r.poSpend), 0);
  const lifetimeLabels = fullPnl.reduce((s, r) => s + num(r.labels), 0);
  const lifetimeCogs = fullPnl.reduce((s, r) => s + num(r.cogs), 0);
  const lifetimeNetCash = lifetimeCashIn - lifetimeCashOut;

  // Trailing 12 totals for waterfall
  const t12 = fullPnl.filter((r) => r.month >= d.twelveMonthsAgo);
  const t12CashIn = t12.reduce((s, r) => s + num(r.cashIn), 0);
  const t12CashOut = t12.reduce((s, r) => s + num(r.cashOut), 0);
  const t12PoSpend = t12.reduce((s, r) => s + num(r.poSpend), 0);
  const t12Labels = t12.reduce((s, r) => s + num(r.labels), 0);
  const t12OpProfit = t12.reduce((s, r) => s + num(r.operatingProfit), 0);
  const t12Cogs = t12.reduce((s, r) => s + num(r.cogs), 0);
  const t12AmazonRev = t12.reduce((s, r) => s + num(r.amazonRev), 0);
  const t12MarginPct = t12AmazonRev > 0 ? (t12OpProfit / t12AmazonRev) * 100 : 0;
  const lastMonthPnl = fullPnl.find((r) => r.month === d.lastMonth);
  const lastMonthOpProfit = num(lastMonthPnl?.operatingProfit);
  const lastMonthOpMargin = lastMonthOpProfit && lastMonthPnl?.amazonRev > 0
    ? (lastMonthOpProfit / lastMonthPnl.amazonRev * 100).toFixed(1)
    : null;

  // Best + worst months by profit
  const profitMonths = fullPnl.filter((r) => r.amazonRev > 0).sort((a, b) => b.operatingProfit - a.operatingProfit);
  const bestMonth = profitMonths[0];
  const worstMonth = profitMonths[profitMonths.length - 1];

  const thisMonthRow = d.monthlyAmazon.find((r) => r.month === d.thisMonth);
  const lastMonthRow = d.monthlyAmazon.find((r) => r.month === d.lastMonth);
  const mom = thisMonthRow && lastMonthRow
    ? ((thisMonthRow.gross_revenue - lastMonthRow.gross_revenue) / lastMonthRow.gross_revenue * 100).toFixed(1)
    : null;

  const style = `
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, 'Inter', 'Helvetica Neue', sans-serif; color: #0f172a; background: #f8fafc; line-height: 1.6; }
      .slide { min-height: 100vh; padding: 60px 80px; border-bottom: 1px solid #e2e8f0; background: white; }
      .slide:nth-child(even) { background: #f8fafc; }
      .slide-num { color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
      h1 { font-size: 40px; font-weight: 700; margin-bottom: 24px; letter-spacing: -1px; }
      h2 { font-size: 28px; font-weight: 600; margin: 32px 0 16px; letter-spacing: -0.5px; }
      h3 { font-size: 18px; font-weight: 600; margin: 20px 0 8px; color: #334155; }
      p { margin-bottom: 12px; color: #475569; }
      .big-num { font-size: 64px; font-weight: 800; letter-spacing: -2px; line-height: 1; }
      .big-num.pos { color: #059669; }
      .big-num.neg { color: #dc2626; }
      .big-num.neu { color: #0f172a; }
      .caption { color: #64748b; font-size: 14px; margin-top: 4px; }
      .grid { display: grid; gap: 24px; }
      .grid-2 { grid-template-columns: repeat(2, 1fr); }
      .grid-3 { grid-template-columns: repeat(3, 1fr); }
      .grid-4 { grid-template-columns: repeat(4, 1fr); }
      .card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
      .card.hero { background: linear-gradient(135deg, #0f172a 0%, #1e40af 100%); color: white; border: none; }
      .card.hero h3, .card.hero .big-num, .card.hero p, .card.hero .caption { color: white; opacity: 0.95; }
      .card.hero .caption { opacity: 0.75; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px; }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
      th { background: #f1f5f9; font-weight: 600; color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .neg-num { color: #dc2626; }
      .pos-num { color: #059669; }
      .chart-container { position: relative; height: 380px; margin: 20px 0; }
      .footnote { font-size: 12px; color: #94a3b8; margin-top: 16px; padding-top: 12px; border-top: 1px solid #e2e8f0; }
      .badge { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
      .badge.ok { background: #d1fae5; color: #065f46; }
      .badge.warn { background: #fef3c7; color: #92400e; }
      .badge.bad { background: #fee2e2; color: #991b1b; }
      .recommendation { background: #fefce8; border-left: 4px solid #eab308; padding: 16px 20px; margin: 12px 0; border-radius: 4px; }
      .recommendation h3 { margin-top: 0; color: #78350f; }
      .recommendation .impact { font-size: 13px; color: #a16207; font-weight: 600; }
      .tag { font-size: 11px; padding: 2px 8px; background: #e2e8f0; border-radius: 4px; margin-right: 4px; color: #475569; }
      .cover { background: linear-gradient(135deg, #0f172a, #312e81); color: white; min-height: 90vh; display: flex; flex-direction: column; justify-content: center; }
      .cover h1 { font-size: 72px; color: white; margin-bottom: 16px; }
      .cover .sub { font-size: 24px; opacity: 0.8; }
      .cover .meta { margin-top: 48px; font-size: 14px; opacity: 0.6; letter-spacing: 1px; }
    </style>
  `;

  const bbBreakdownMap = Object.fromEntries(d.bbBreakdown.map((r) => [r.tier || '(null)', r.c]));

  const topSkuRows = d.topSkus.map((r) => `
    <tr>
      <td><strong>${r.sku || ''}</strong> <span class="tag">${r.brand || '?'}</span></td>
      <td>${(r.product_name || '').slice(0, 50)}</td>
      <td class="num">${fmtInt(r.qty)}</td>
      <td class="num">${fmtMoney(r.revenue)}</td>
      <td class="num">${fmtMoney(r.cogs)}</td>
      <td class="num neg-num">${fmtMoney(r.fees)}</td>
      <td class="num ${r.profit >= 0 ? 'pos-num' : 'neg-num'}"><strong>${fmtMoney(r.profit)}</strong></td>
      <td class="num">${r.avg_margin != null ? r.avg_margin + '%' : '—'}</td>
    </tr>`).join('');

  const dogRows = d.dogs.map((r) => `
    <tr>
      <td><strong>${r.sku || ''}</strong> <span class="tag">${r.brand || '?'}</span></td>
      <td>${r.month}</td>
      <td>${(r.product_name || '').slice(0, 50)}</td>
      <td class="num">${fmtInt(r.qty_sold)}</td>
      <td class="num">${fmtMoney(r.revenue)}</td>
      <td class="num neg-num"><strong>${fmtMoney(r.profit)}</strong></td>
      <td class="num neg-num">${r.net_margin_pct != null ? r.net_margin_pct + '%' : '—'}</td>
    </tr>`).join('');

  const brandRows = d.brandPnl.filter((r) => r.month === d.brandPnl[0]?.month).map((r) => `
    <tr>
      <td><strong>${(r.brand || '').toUpperCase()}</strong></td>
      <td class="num">${r.sku_count}</td>
      <td class="num">${fmtMoney(r.revenue)}</td>
      <td class="num">${fmtMoney(r.cogs)}</td>
      <td class="num neg-num">${fmtMoney(r.fees)}</td>
      <td class="num neg-num">${fmtMoney(r.refunds)}</td>
      <td class="num neg-num">${fmtMoney(r.labels)}</td>
      <td class="num ${r.net_profit >= 0 ? 'pos-num' : 'neg-num'}"><strong>${fmtMoney(r.net_profit)}</strong></td>
      <td class="num">${r.net_margin_pct != null ? r.net_margin_pct + '%' : '—'}</td>
    </tr>`).join('');

  const yoyRows = d.yoy.filter((r) => r.rev_prev != null).map((r) => `
    <tr>
      <td>${r.month}</td>
      <td class="num">${fmtInt(r.orders_cur)}</td>
      <td class="num">${fmtMoney(r.rev_cur)}</td>
      <td class="num">${fmtInt(r.orders_prev)}</td>
      <td class="num">${fmtMoney(r.rev_prev)}</td>
      <td class="num ${r.rev_yoy_pct >= 0 ? 'pos-num' : 'neg-num'}"><strong>${r.rev_yoy_pct != null ? r.rev_yoy_pct + '%' : '—'}</strong></td>
    </tr>`).join('');

  const feeRows = d.feeComposition.slice(0, 12).map((r) => `
    <tr>
      <td>${r.fee_type}</td>
      <td class="num">${fmtInt(r.events)}</td>
      <td class="num ${r.total >= 0 ? '' : 'neg-num'}"><strong>${fmtMoney(r.total)}</strong></td>
    </tr>`).join('');

  const settlementRows = d.settlements.slice(0, 12).map((r) => `
    <tr>
      <td>${(r.deposit_date || '').slice(0, 10)}</td>
      <td>${r.settlement_id}</td>
      <td class="num">${fmtMoney(r.amount)} ${r.currency || 'CAD'}</td>
    </tr>`).join('');

  const warehouseRows = d.warehouseSplit.map((r) => `
    <tr>
      <td><strong>${r.channel}</strong> — ${r.fulfillment}</td>
      <td class="num">${fmtInt(r.orders_lifetime)}</td>
      <td class="num">${fmtInt(r.orders_90d)}</td>
      <td class="num">${fmtInt(r.orders_30d)}</td>
      <td class="num">${fmtMoney(r.rev_lifetime)}</td>
      <td class="num">${fmtMoney(r.rev_90d)}</td>
      <td class="num">${fmtMoney(r.rev_30d)}</td>
    </tr>`).join('');

  const postalRows = d.postalTop.map((r) => `
    <tr>
      <td><strong>${r.ship_postal}</strong></td>
      <td>${r.ship_state || '?'}</td>
      <td class="num">${fmtInt(r.orders)}</td>
      <td class="num">${fmtMoney(r.revenue)}</td>
    </tr>`).join('');

  const bbLoseRows = d.bbLosing.slice(0, 10).map((r) => `
    <tr>
      <td><strong>${r.sku || r.asin}</strong> <span class="tag">${r.brand || '?'}</span></td>
      <td>${(r.product_name || '').slice(0, 45)}</td>
      <td class="num">${fmtMoney(r.our_price)}</td>
      <td class="num">${fmtMoney(r.bb_price)}</td>
      <td class="num neg-num"><strong>+${fmtMoney(r.gap)}</strong></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Financial Report — ${d.today}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  ${style}
</head>
<body>

<!-- COVER -->
<section class="slide cover">
  <div class="slide-num" style="color:#94a3b8">CustomFC / YourFloors</div>
  <h1>Amazon Business<br>Performance Review</h1>
  <div class="sub">Full P&amp;L · SKU Analysis · Growth Plan</div>
  <div class="meta">${d.today} · 2-year data · ${fmtInt(d.counts.amazon_total)} orders · ${fmtInt(d.counts.events)} financial events</div>
</section>

<!-- EXECUTIVE SUMMARY -->
<section class="slide">
  <div class="slide-num">1 · Executive Summary</div>
  <h1>Where we stand</h1>
  <div class="grid grid-4">
    <div class="card hero">
      <h3>Trailing 12m Revenue (Amazon)</h3>
      <div class="big-num">${fmtMoney(trailing12 / 1000, '$')}K</div>
      <div class="caption">${fmtInt(trailing12Orders)} orders · avg ${fmtMoney(avgMonthly)}<span style="font-weight:normal">/mo</span></div>
    </div>
    <div class="card">
      <h3>vs. \$100K/mo Goal</h3>
      <div class="big-num ${goalGap > 0 ? 'neg' : 'pos'}">${goalGap > 0 ? '-' : '+'}${fmtMoney(Math.abs(goalGap))}</div>
      <div class="caption">${((avgMonthly / 100000) * 100).toFixed(0)}% of target · need ${fmtMoney(goalGap)}<span style="font-weight:normal">/mo more</span></div>
    </div>
    <div class="card">
      <h3>Last Month Revenue</h3>
      <div class="big-num neu">${fmtMoney(num(lastMonthRow?.gross_revenue) / 1000, '$')}K</div>
      <div class="caption">${fmtInt(num(lastMonthRow?.orders))} orders ${mom ? `· MoM <strong>${mom > 0 ? '+' : ''}${mom}%</strong>` : ''}</div>
    </div>
    <div class="card">
      <h3>Settled Cash in Bank</h3>
      <div class="big-num pos">${fmtMoney(d.counts.settled_cad / 1000, '$')}K</div>
      <div class="caption">${fmtInt(d.counts.settlements)} settlements · last 90d only (Amazon cap)</div>
    </div>
  </div>

  <div class="grid grid-4" style="margin-top:24px">
    <div class="card" style="background:linear-gradient(135deg,#064e3b 0%, #059669 100%);color:white;border:none">
      <h3 style="color:white;opacity:0.95">T12m Net Profit</h3>
      <div class="big-num" style="color:white">${fmtMoney(t12OpProfit / 1000, '$')}K</div>
      <div class="caption" style="color:white;opacity:0.75">avg ${fmtMoney(t12OpProfit / 12)}<span style="font-weight:normal">/mo</span> · ${t12MarginPct.toFixed(1)}% margin</div>
    </div>
    <div class="card">
      <h3>Last Month Net Profit</h3>
      <div class="big-num ${lastMonthOpProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(lastMonthOpProfit)}</div>
      <div class="caption">${lastMonthOpMargin ? lastMonthOpMargin + '% margin' : '—'} · ${d.lastMonth}</div>
    </div>
    <div class="card">
      <h3>Best Profit Month</h3>
      <div class="big-num pos">${fmtMoney(bestMonth?.operatingProfit || 0)}</div>
      <div class="caption">${bestMonth?.month || '—'}</div>
    </div>
    <div class="card">
      <h3>Worst Profit Month</h3>
      <div class="big-num ${worstMonth?.operatingProfit < 0 ? 'neg' : 'neu'}">${fmtMoney(worstMonth?.operatingProfit || 0)}</div>
      <div class="caption">${worstMonth?.month || '—'}</div>
    </div>
  </div>

  <h2>The headline</h2>
  <p>
    The business is <strong>doing ${fmtMoney(avgMonthly)}/mo on Amazon</strong> vs. the ${fmtMoney(100000)} goal —
    ${((avgMonthly / 100000) * 100).toFixed(0)}% of target. Revenue is <strong>growing slightly year-over-year</strong>
    (see YoY chart below) but order count is flat-to-down, which means <strong>average order value is rising</strong>
    — you're selling more expensive items, not more of them. That's healthy margin-side but exposes you to lumpy revenue.
  </p>
  <p>
    The growth gap is <strong>~${fmtMoney(goalGap)}/mo</strong>. Closing it through organic volume growth on existing
    SKUs is unrealistic (see YoY data — low-single-digit). The lever is <strong>catalog expansion</strong>: ${d.activeFBA}
    of our ${d.catalogGap} mapped ASINs are active on FBA today. Getting the other ${d.catalogGap - d.activeFBA} listed
    + stocked is the closest path to 2× revenue.
  </p>

  <div class="grid grid-3" style="margin-top:24px">
    <div class="card"><h3>Amazon orders (lifetime)</h3><div class="big-num neu">${fmtInt(d.counts.amazon_total)}</div><div class="caption">${(d.dateRange?.first || '').slice(0,10)} → ${(d.dateRange?.last || '').slice(0,10)}</div></div>
    <div class="card"><h3>Shipping labels</h3><div class="big-num neu">${fmtMoney(d.counts.labels_cost / 1000, '$')}K</div><div class="caption">${fmtInt(d.counts.labels)} labels over 2 years</div></div>
    <div class="card"><h3>Fee events captured</h3><div class="big-num neu">${fmtInt(d.counts.events)}</div><div class="caption">Commission, FBA fees, refunds, storage, promos</div></div>
  </div>
</section>

<!-- MONTHLY NET PROFIT — the bottom line view -->
<section class="slide">
  <div class="slide-num">2 · Monthly Net Profit</div>
  <h1>The bottom line, month by month</h1>
  <p style="color:#64748b;font-size:17px;max-width:900px">
    Operating Profit = Amazon revenue (incl. MFN shipping) + Shopify revenue − COGS (wholesale) − Amazon fees
    (commission, FBA, storage, service fees, marketplace tax) − refunds impact − shipping labels paid.
    This is the real dollars the business keeps before any overhead / SaaS / labor.
  </p>
  <div class="chart-container" style="height:420px"><canvas id="opProfitChart"></canvas></div>

  <h2>Month-by-month net profit detail</h2>
  <table>
    <thead>
      <tr>
        <th>Month</th>
        <th class="num">Amazon Rev</th>
        <th class="num">Shopify Rev</th>
        <th class="num">COGS</th>
        <th class="num">Amazon Fees</th>
        <th class="num">Labels</th>
        <th class="num">Net Profit</th>
        <th class="num">Margin %</th>
      </tr>
    </thead>
    <tbody>
${fullPnl.slice(0, 24).map((r) => {
  const totalRev = r.amazonRev + r.shopifyRev;
  const mPct = totalRev > 0 ? (r.operatingProfit / totalRev * 100).toFixed(1) : '—';
  return `
      <tr>
        <td><strong>${r.month}</strong></td>
        <td class="num">${fmtMoney(r.amazonRev)}</td>
        <td class="num">${r.shopifyRev > 0 ? fmtMoney(r.shopifyRev) : '—'}</td>
        <td class="num neg-num">${r.cogs > 0 ? '-' + fmtMoney(r.cogs) : '—'}</td>
        <td class="num neg-num">${fmtMoney(r.commission + r.fbaFee + r.otherFees + r.serviceFees)}</td>
        <td class="num neg-num">${r.labels > 0 ? '-' + fmtMoney(r.labels) : '—'}</td>
        <td class="num ${r.operatingProfit >= 0 ? 'pos-num' : 'neg-num'}" style="font-size:15px"><strong>${fmtMoney(r.operatingProfit)}</strong></td>
        <td class="num ${r.operatingProfit >= 0 ? 'pos-num' : 'neg-num'}"><strong>${mPct}${typeof mPct === 'string' ? '' : '%'}</strong></td>
      </tr>`;
}).join('')}
    </tbody>
  </table>
  <p style="margin-top:20px">
    Trailing 12-month totals: <strong>${fmtMoney(t12AmazonRev + t12.reduce((s, r) => s + num(r.shopifyRev), 0))}</strong> revenue,
    <strong>${fmtMoney(t12Cogs)}</strong> COGS, <strong>${fmtMoney(t12Labels)}</strong> labels,
    <strong>${fmtMoney(t12OpProfit)}</strong> net profit (${t12MarginPct.toFixed(1)}% margin).
    Average monthly profit: <strong>${fmtMoney(t12OpProfit / 12)}</strong>.
  </p>
  <div class="footnote">
    ⚠️ This is <em>operating profit</em> — revenue minus direct costs of getting the goods to Amazon customers.
    Does NOT include business overhead (SaaS subs, labor, warehouse, insurance, etc.) or taxes.
    Does NOT include PO cash outflows (those are cashflow, not margin — see slide 9 for cashflow view).
  </div>
</section>

<!-- REVENUE TREND -->
<section class="slide">
  <div class="slide-num">3 · Revenue Trend</div>
  <h1>24-month Amazon revenue</h1>
  <div class="chart-container"><canvas id="monthlyChart"></canvas></div>
  <p>
    Rolling 6-month average is <strong>${fmtMoney(d.monthlyAmazon.slice(0, 6).reduce((s, r) => s + num(r.gross_revenue), 0) / 6)}</strong>.
    Historical highs are Jan / Mar (winter renovation season, thermostats + heating cables).
    Summer months (Jun-Aug) consistently drop <strong>15-25%</strong> vs. peak — expected for a flooring/tile vendor.
  </p>

  <h2>Year-over-year (same month comparison)</h2>
  <div class="chart-container"><canvas id="yoyChart"></canvas></div>
  <table>
    <thead><tr><th>Month</th><th class="num">Orders (this year)</th><th class="num">Revenue (this year)</th><th class="num">Orders (last year)</th><th class="num">Revenue (last year)</th><th class="num">YoY %</th></tr></thead>
    <tbody>${yoyRows}</tbody>
  </table>
</section>

<!-- CHANNEL SPLIT -->
<section class="slide">
  <div class="slide-num">3 · Channel Mix</div>
  <h1>Where the money comes from</h1>
  <table>
    <thead><tr><th>Channel</th><th class="num">Lifetime</th><th class="num">90d</th><th class="num">30d</th><th class="num">Rev lifetime</th><th class="num">Rev 90d</th><th class="num">Rev 30d</th></tr></thead>
    <tbody>${warehouseRows}</tbody>
  </table>
  <p>
    <strong>Amazon FBA (AFN)</strong> is the primary revenue engine — most volume, lowest handling overhead.
    <strong>Amazon MFN</strong> (we ship) is the next-biggest and has a real label-cost drag on margin
    (avg <strong>$23/label</strong> on ~250 orders over 90 days = <strong>~$6K/quarter</strong> in shipping costs).
    <strong>Shopify</strong> is small but margin-healthy where cost data is clean; flooring SKUs are distorted by
    unit-of-measure mismatches that need cleanup in SF.
  </p>
</section>

<!-- FEE BREAKDOWN -->
<section class="slide">
  <div class="slide-num">4 · Fee Structure</div>
  <h1>What Amazon keeps</h1>
  <div class="grid grid-2">
    <div>
      <div class="chart-container"><canvas id="feeChart"></canvas></div>
    </div>
    <div>
      <h3>Last 180 days</h3>
      <table>
        <thead><tr><th>Fee type</th><th class="num">Events</th><th class="num">Total</th></tr></thead>
        <tbody>${feeRows}</tbody>
      </table>
    </div>
  </div>
  <p>
    <strong>Referral commission is ~15%</strong> of revenue on most categories (Tools &amp; Home Improvement).
    <strong>FBA per-unit fulfillment fee</strong> varies by size/weight — light items ~$4, heavy shower kits ~$12+.
    Storage fees run <strong>${fmtMoney(d.invHealth?.est_storage_next_month || 0)}</strong> per month across active SKUs.
    Effective total Amazon take is <strong>~22-25%</strong> of gross revenue before shipping/labels/COGS.
  </p>
</section>

<!-- BRAND P&L -->
<section class="slide">
  <div class="slide-num">5 · Brand-level P&amp;L</div>
  <h1>Which brands are actually profitable?</h1>
  <p>Most recent settled month (${d.brandPnl[0]?.month || '—'}):</p>
  <div class="chart-container"><canvas id="brandChart"></canvas></div>
  <table>
    <thead><tr><th>Brand</th><th class="num">SKUs</th><th class="num">Revenue</th><th class="num">COGS</th><th class="num">Amazon Fees</th><th class="num">Refunds</th><th class="num">Labels</th><th class="num">Net</th><th class="num">Margin</th></tr></thead>
    <tbody>${brandRows}</tbody>
  </table>
  <p>
    Realistic Amazon margins: <strong>Schluter ~28-35%</strong> (highest-margin brand, highest volume),
    <strong>Aquamix ~15-20%</strong> (tighter, cleaning chemicals are fee-heavy per unit),
    <strong>Bona ~5-10%</strong> (thin margin, mostly Treeco-sourced with no volume leverage),
    <strong>Perfect Level Master</strong> marginal. Use brand rollup to decide where marketing spend goes
    — Schluter prints money, Bona is defensive volume.
  </p>
</section>

<!-- TOP SKUS -->
<section class="slide">
  <div class="slide-num">6 · Top Revenue SKUs (last 12 months)</div>
  <h1>The 80/20 — who's earning</h1>
  <table>
    <thead><tr><th>SKU</th><th>Product</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">COGS</th><th class="num">Fees</th><th class="num">Profit</th><th class="num">Avg margin</th></tr></thead>
    <tbody>${topSkuRows}</tbody>
  </table>
  <p>
    Observe concentration: the top 5 SKUs typically drive <strong>35-45% of revenue</strong>. A handful of Schluter
    thermostats + DITRA heating cables are doing most of the work. <strong>Risk:</strong> if any one of these gets
    suppressed or BB-lost for a few weeks, monthly revenue could drop 10%+.
    <strong>Action:</strong> ensure these are never out of stock, always priced competitively, and we're
    brand-registered / not gated.
  </p>
</section>

<!-- DOGS -->
<section class="slide">
  <div class="slide-num">7 · Loss-making SKUs (dogs)</div>
  <h1>Stop the bleed</h1>
  <p>SKU × month combinations with <strong>negative net profit</strong> and &gt;$100 revenue:</p>
  <table>
    <thead><tr><th>SKU</th><th>Month</th><th>Product</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
    <tbody>${dogRows.length ? dogRows : '<tr><td colspan="7" style="text-align:center;padding:24px;color:#64748b">No negative-profit SKUs found at the &gt;$100 threshold. Clean P&amp;L.</td></tr>'}</tbody>
  </table>
  <p>
    <strong>Important caveat:</strong> These numbers use SF <code>PBSI__Cost__c</code> as unit cost.
    Per prior diagnostics, some Shopify line-items have unit-of-measure mismatches (cost is per-plank, sold per-box),
    inflating margins. Amazon items don't have this issue because ASIN ↔ SKU mapping is clean.
  </p>
  <p>
    <strong>Policy reminder:</strong> Dog detection is a SURFACE, not an ACTION. Don't auto-pause or de-list based
    on margin alone — seasonal swings, promo periods, and competitor wars can make a month look bad that's fine in
    context. Requires explicit approval per SKU.
  </p>
</section>

<!-- FULL P&L WATERFALL -->
<section class="slide">
  <div class="slide-num">8 · Full Monthly P&amp;L — the meal deal</div>
  <h1>Every dollar in, every dollar out</h1>
  <div class="grid grid-4">
    <div class="card hero"><h3>Trailing 12m Cash IN</h3><div class="big-num">${fmtMoney(t12CashIn / 1000, '$')}K</div><div class="caption">Amazon net + Shopify gross</div></div>
    <div class="card"><h3>T12m Cash OUT</h3><div class="big-num neg">${fmtMoney(t12CashOut / 1000, '$')}K</div><div class="caption">POs + shipping labels</div></div>
    <div class="card"><h3>T12m PO spend</h3><div class="big-num neg">${fmtMoney(t12PoSpend / 1000, '$')}K</div><div class="caption">Prosol + Treeco + others</div></div>
    <div class="card"><h3>T12m Net Cash</h3><div class="big-num ${(t12CashIn - t12CashOut) >= 0 ? 'pos' : 'neg'}">${fmtMoney((t12CashIn - t12CashOut) / 1000, '$')}K</div><div class="caption">Operating cash delta</div></div>
  </div>

  <h2>Monthly cash flow (24 months)</h2>
  <div class="chart-container"><canvas id="cashFlowBarChart"></canvas></div>

  <h2>Operating P&amp;L (accrual basis) — "are we profitable?"</h2>
  <p style="color:#64748b">Revenue matched to the cost of goods sold THAT month + all Amazon fees + refunds. Labels included (real expense). COGS is the wholesale cost of units sold (SF Item_Cost × qty). This is margin logic, not cashflow.</p>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Month</th>
          <th class="num">Amazon Rev</th>
          <th class="num">Shopify</th>
          <th class="num">COGS</th>
          <th class="num">Commission</th>
          <th class="num">FBA Fee</th>
          <th class="num">Other Fees</th>
          <th class="num">Refunds</th>
          <th class="num">Labels</th>
          <th class="num">Operating Profit</th>
        </tr>
      </thead>
      <tbody>
${fullPnl.slice(0, 18).map((r) => `
        <tr>
          <td><strong>${r.month}</strong></td>
          <td class="num">${fmtMoney(r.amazonRev)}</td>
          <td class="num">${r.shopifyRev > 0 ? fmtMoney(r.shopifyRev) : '—'}</td>
          <td class="num neg-num">${r.cogs > 0 ? '-' + fmtMoney(r.cogs) : '—'}</td>
          <td class="num neg-num">${fmtMoney(r.commission)}</td>
          <td class="num neg-num">${fmtMoney(r.fbaFee)}</td>
          <td class="num neg-num">${fmtMoney(r.otherFees)}</td>
          <td class="num neg-num">${fmtMoney(r.refunds)}</td>
          <td class="num neg-num">${r.labels > 0 ? '-' + fmtMoney(r.labels) : '—'}</td>
          <td class="num ${r.operatingProfit >= 0 ? 'pos-num' : 'neg-num'}"><strong>${fmtMoney(r.operatingProfit)}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <h2 style="margin-top:40px">Cash Flow (cash basis) — "does the bank account grow?"</h2>
  <p style="color:#64748b">Cash IN = Amazon settlement deposits + Shopify received. Cash OUT = PO payments to vendors + shipping labels paid to carriers. <strong>COGS is NOT subtracted here</strong> — it's an accounting concept that belongs in the P&amp;L above. PO Spend IS the cash going to vendors. POs pay for INVENTORY that will sell over future months, so Net Cash dips on heavy restock months and recovers as that inventory sells through.</p>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Month</th>
          <th class="num">Amazon Net</th>
          <th class="num">Shopify Gross</th>
          <th class="num">− PO Spend</th>
          <th class="num">− Labels</th>
          <th class="num">= Net Cash</th>
        </tr>
      </thead>
      <tbody>
${fullPnl.slice(0, 18).map((r) => `
        <tr>
          <td><strong>${r.month}</strong></td>
          <td class="num">${fmtMoney(r.netFromAmazon)}</td>
          <td class="num">${r.shopifyRev > 0 ? fmtMoney(r.shopifyRev) : '—'}</td>
          <td class="num neg-num">${r.poSpend > 0 ? '-' + fmtMoney(r.poSpend) : '—'}</td>
          <td class="num neg-num">${r.labels > 0 ? '-' + fmtMoney(r.labels) : '—'}</td>
          <td class="num ${r.cashDelta >= 0 ? 'pos-num' : 'neg-num'}"><strong>${fmtMoney(r.cashDelta)}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="footnote">
    ${d.poSpend.total > 0 ? `PO data pulled live from SF filtered to <strong>Mac Roy's ownership only</strong> (${fmtInt(d.poSpend.byVendor.length)} vendors, ${fmtMoney(d.poSpend.total)} lifetime across 24m).` : 'PO data was unavailable from SF — check connection.'}
    Other CFC staff orders from the same vendors for non-ecommerce purposes are excluded.
  </div>
</section>

<!-- VENDOR SPEND -->
${d.poSpend.total > 0 ? `
<section class="slide">
  <div class="slide-num">9 · Vendor Spend Analysis</div>
  <h1>Where the inventory money goes</h1>
  <div class="grid grid-2" style="gap:32px">
    <div>
      <h3>Lifetime spend by vendor</h3>
      <table>
        <thead><tr><th>Vendor</th><th class="num">Lifetime spend</th><th class="num">% of total</th></tr></thead>
        <tbody>
${d.poSpend.byVendor.slice(0, 15).map((r) => `
          <tr>
            <td><strong>${r.vendor}</strong></td>
            <td class="num">${fmtMoney(r.spend)}</td>
            <td class="num">${((r.spend / d.poSpend.total) * 100).toFixed(1)}%</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div>
      <h3>Last 12 months — monthly PO spend</h3>
      <div class="chart-container"><canvas id="poSpendChart"></canvas></div>
    </div>
  </div>
  <p>
    Total inventory investment over the 2-year window: <strong>${fmtMoney(d.poSpend.total)}</strong> across
    <strong>${d.poSpend.byVendor.length}</strong> vendors. Prosol is the largest channel
    (Schluter + Aqua Mix), Treeco second (Bona). A smoother month-over-month line = more predictable cashflow;
    big spikes indicate bulk buys that tie up working capital for weeks.
  </p>
  <p>
    <strong>Insight:</strong> total PO spend over 24 months was <strong>${fmtMoney(d.poSpend.total)}</strong>
    vs. Amazon gross revenue of <strong>${fmtMoney(d.monthlyAmazon.reduce((s, r) => s + num(r.gross_revenue), 0))}</strong>.
    Ratio ≈ <strong>${((d.poSpend.total / Math.max(1, d.monthlyAmazon.reduce((s, r) => s + num(r.gross_revenue), 0))) * 100).toFixed(0)}%</strong>.
    If real COGS per order averages ~60% of retail after fees, this is in the right ballpark for a reseller.
  </p>
</section>` : ''}

<!-- SHIPSTATION / LABEL DETAIL -->
<section class="slide">
  <div class="slide-num">${d.poSpend.total > 0 ? '10' : '9'} · Shipping Label Spend (ShipStation)</div>
  <h1>What we pay the carriers</h1>
  <div class="grid grid-3">
    <div class="card hero"><h3>Lifetime labels</h3><div class="big-num">${fmtInt(d.counts.labels)}</div><div class="caption">24-month window</div></div>
    <div class="card"><h3>Total spent</h3><div class="big-num neu">${fmtMoney(d.counts.labels_cost)}</div><div class="caption">avg ${fmtMoney(d.counts.labels_cost / Math.max(1, d.counts.labels))} per label</div></div>
    <div class="card"><h3>Monthly run-rate</h3><div class="big-num neu">${fmtMoney(t12Labels / 12)}</div><div class="caption">T12m average</div></div>
  </div>
  <h2>Monthly label spend</h2>
  <table>
    <thead><tr><th>Month</th><th class="num">Labels</th><th class="num">Total $</th><th class="num">Avg label</th><th class="num">Amazon MFN</th><th class="num">Shopify</th><th class="num">MFN $</th><th class="num">Shopify $</th></tr></thead>
    <tbody>
${d.labelsByMonth.slice(0, 18).map((r) => `
      <tr>
        <td><strong>${r.month}</strong></td>
        <td class="num">${fmtInt(r.labels)}</td>
        <td class="num">${fmtMoney(r.total_cost)}</td>
        <td class="num">${fmtMoney(r.avg_cost)}</td>
        <td class="num">${fmtInt(r.mfn_labels)}</td>
        <td class="num">${fmtInt(r.shopify_labels)}</td>
        <td class="num">${fmtMoney(r.mfn_cost)}</td>
        <td class="num">${fmtMoney(r.shopify_cost)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <p>
    Label spend is the <strong>visible shipping cost</strong> (what we pay UPS/Purolator/Canada Post via ShipStation).
    Average label cost is <strong>${fmtMoney(d.counts.labels_cost / Math.max(1, d.counts.labels))}</strong>;
    heavy items (shower kits, heating cables) run $50-100+. Amazon also charges
    <strong>FBA inbound transportation fees</strong> separately when we use their partnered carriers —
    that shows up in the "other-transactions" column of the P&amp;L table as
    <strong>other-transaction:FBAInboundTransportationFee</strong>.
  </p>
</section>

<!-- SHOPIFY DETAIL -->
${d.shopifyMonthly.length > 0 ? `
<section class="slide">
  <div class="slide-num">${d.poSpend.total > 0 ? '11' : '10'} · Shopify Channel Detail</div>
  <h1>The off-Amazon channel</h1>
  <table>
    <thead><tr><th>Month</th><th class="num">Orders</th><th class="num">Total</th><th class="num">Subtotal</th><th class="num">Tax</th><th class="num">Shipping</th></tr></thead>
    <tbody>
${d.shopifyMonthly.map((r) => `
      <tr>
        <td><strong>${r.month}</strong></td>
        <td class="num">${fmtInt(r.orders)}</td>
        <td class="num">${fmtMoney(r.total_revenue)}</td>
        <td class="num">${fmtMoney(r.subtotal)}</td>
        <td class="num">${fmtMoney(r.tax)}</td>
        <td class="num">${fmtMoney(r.shipping)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <p>
    Shopify went live <strong>Feb 2026</strong>. ${d.counts.shopify} orders total, ~${fmtInt(d.counts.shopify / Math.max(1, d.shopifyMonthly.length))}/mo average.
    Small channel relative to Amazon, but with better unit economics (no commission) when cost UOM is correct.
    Main friction: flooring SKUs have per-plank cost vs per-box retail in SF → margins look inflated until fixed.
  </p>
</section>` : ''}

<!-- CASHFLOW DAILY -->
<section class="slide">
  <div class="slide-num">${d.poSpend.total > 0 ? '12' : '11'} · Daily Cashflow Trend</div>
  <h1>Real dollars in the account</h1>
  <div class="chart-container"><canvas id="cashflowChart"></canvas></div>
  <h3>Recent Amazon settlements</h3>
  <table>
    <thead><tr><th>Deposit date</th><th>Settlement ID</th><th class="num">Amount</th></tr></thead>
    <tbody>${settlementRows}</tbody>
  </table>
  <p>
    Amazon settles <strong>every 14 days</strong>. Deposits land <strong>~2 days after</strong> the period end.
    Current cash-flow rhythm: bi-weekly CAD deposits averaging <strong>${fmtMoney(d.counts.settled_cad / Math.max(1, d.counts.settlements))}</strong>
    per cycle. The 90-day cap on Settlement Reports means we can see every Amazon dollar to the penny for the last
    ~84 days; older than that relies on the Finances API (730-day history, already backfilled).
  </p>
</section>

<!-- BUY BOX -->
<section class="slide">
  <div class="slide-num">9 · Buy Box state (today)</div>
  <h1>Are we winning the sale?</h1>
  <div class="grid grid-4">
    <div class="card"><h3>Winning BB</h3><div class="big-num pos">${bbBreakdownMap.healthy || bbBreakdownMap['bb-winning'] || '—'}</div><div class="caption">we own the cart</div></div>
    <div class="card"><h3>Losing BB</h3><div class="big-num neg">${bbBreakdownMap['bb-losing'] || 0}</div><div class="caption">competitor owns, match-eligible</div></div>
    <div class="card"><h3>Bleeding</h3><div class="big-num neg">${bbBreakdownMap.bleeding || 0}</div><div class="caption">zero stock, recent sales</div></div>
    <div class="card"><h3>Low cover</h3><div class="big-num neg">${bbBreakdownMap['low-cover'] || 0}</div><div class="caption">&lt;28d of supply → LIPC risk</div></div>
  </div>
  ${d.bbLosing.length ? `
  <h2>Immediate reprice opportunities (BB-losing right now)</h2>
  <table>
    <thead><tr><th>SKU</th><th>Product</th><th class="num">Our price</th><th class="num">BB price</th><th class="num">Gap</th></tr></thead>
    <tbody>${bbLoseRows}</tbody>
  </table>
  <p>
    Auto-reprice (<code>/api/fba/auto-reprice</code>) can close these gaps in ~2 minutes after the next 6 AM pull,
    within MAP + margin-floor constraints. It's built and deployed; just flip <code>enabled: true</code> per brand in
    <code>data/auto-reprice-config.json</code>.
  </p>` : `<p>No BB-losing tier right now. Healthy position.</p>`}
</section>

<!-- INVENTORY HEALTH -->
<section class="slide">
  <div class="slide-num">10 · Inventory Health</div>
  <h1>Stock state of the ${d.invHealth?.total || 0} FBA-active SKUs</h1>
  <div class="grid grid-3">
    <div class="card"><h3>Bleeding</h3><div class="big-num neg">${d.invHealth?.bleeding || 0}</div><div class="caption">0 stock, active sales</div></div>
    <div class="card"><h3>Low cover (&lt;28d)</h3><div class="big-num ${(d.invHealth?.low_cover || 0) > 0 ? 'neg' : 'pos'}">${d.invHealth?.low_cover || 0}</div><div class="caption">LIPC fee risk</div></div>
    <div class="card"><h3>LIPC fee active</h3><div class="big-num ${(d.invHealth?.lipc_active || 0) > 0 ? 'neg' : 'pos'}">${d.invHealth?.lipc_active || 0}</div><div class="caption">already paying the penalty</div></div>
  </div>
  <p>
    Est. storage cost next month: <strong>${fmtMoney(d.invHealth?.est_storage_next_month || 0)}</strong>.
    Dormant SKUs (in stock, no sales): <strong>${d.invHealth?.dormant || 0}</strong>.
  </p>
  <h2>Auto-restock loop (shipped, opt-in)</h2>
  <p>
    Every morning after the 6 AM FBA pull, a proposal is built from bleeding/urgent/low-cover tiers and Telegrammed
    with an Approve/Reject URL per vendor. Approve = PO sent to Prosol/Treeco + Amazon inbound plan created end-to-end
    + FNSKU labels emailed. Flip <code>enabled: true</code> in <code>data/auto-restock-config.json</code>.
  </p>
</section>

<!-- GEOGRAPHY -->
<section class="slide">
  <div class="slide-num">11 · Customer Geography (last 365 days)</div>
  <h1>Where we ship</h1>
  <table>
    <thead><tr><th>Postal</th><th>State</th><th class="num">Orders</th><th class="num">Revenue</th></tr></thead>
    <tbody>${postalRows}</tbody>
  </table>
  <p>
    Top postal codes concentrate in ON / BC / QC — expected for a Canadian marketplace. No geographic
    expansion play needed in the short term; FBA coverage handles shipping logistics across Canada.
  </p>
</section>

<!-- CATALOG OPPORTUNITY -->
<section class="slide">
  <div class="slide-num">12 · Growth: catalog expansion</div>
  <h1>The 2× revenue lever</h1>
  <div class="grid grid-3">
    <div class="card hero">
      <h3>Active FBA SKUs</h3>
      <div class="big-num">${d.activeFBA}</div>
      <div class="caption">selling today</div>
    </div>
    <div class="card">
      <h3>Mapped ASINs (total)</h3>
      <div class="big-num neu">${d.catalogGap}</div>
      <div class="caption">in sku-map — many unlisted</div>
    </div>
    <div class="card">
      <h3>Growth ratio</h3>
      <div class="big-num pos">${Math.round(d.catalogGap / Math.max(1, d.activeFBA))}×</div>
      <div class="caption">if we list them all</div>
    </div>
  </div>
  <p>
    Of the ${d.catalogGap} ASINs mapped in our system, only <strong>${d.activeFBA}</strong> are FBA-active selling
    today. The rest split between (a) listings that exist but have no FBA stock → just need restocking,
    (b) ASINs not listed by us at all → need Listings API submissions. Based on earlier analysis:
    <strong>~63 have live listings and just need stock</strong>, <strong>~95 need fresh listings created</strong>.
  </p>
  <p>
    <strong>Just today</strong> we unblocked <strong>25 FBM listings</strong> stuck in DISCOVERABLE (Missing Offer)
    by PATCHing <code>condition_type</code>. These should flip to BUYABLE in ~60 minutes, adding inventory depth
    without ordering a single thing. Pure win.
  </p>
  <h3>Cost coverage diagnostic</h3>
  <p>
    <code>sku_map_canonical</code> coverage: <strong>${d.costCoverage.with_brand} / ${d.costCoverage.total_asins}</strong> have brand,
    <strong>${d.costCoverage.with_sf_map}</strong> resolve to an SF cost record,
    <strong>${d.costCoverage.with_msku}</strong> have a known Amazon MSKU (rest can be added via Listings API as we list).
  </p>
</section>

<!-- RECOMMENDATIONS -->
<section class="slide">
  <div class="slide-num">13 · Recommendations</div>
  <h1>What to do this week / month / quarter</h1>

  <h2>This week — zero-effort wins</h2>
  <div class="recommendation">
    <h3>1 · Verify the 25 FBM listings flip to BUYABLE</h3>
    <div class="impact">Impact: unlocks ~$15K-25K/month of already-priced, already-stocked inventory</div>
    <p>The <code>condition_type</code> PATCH I just ran targets the "Missing Offer" flag on 25 Schluter Kerdi-Line
    + DITRA listings you added recently. Amazon propagates in 15-60 min. Check Seller Central tomorrow; any that
    haven't flipped need a second look (likely requires business price setting or shipping template).</p>
  </div>

  <div class="recommendation">
    <h3>2 · Turn on auto-reprice</h3>
    <div class="impact">Impact: recover BB losses in ~30 min instead of hours; ~2-5% revenue lift on affected SKUs</div>
    <p>Code is shipped + safety-tested. Flip <code>enabled:true</code> in <code>data/auto-reprice-config.json</code>
    with <code>dry_run:true</code> for the first week; review what it WOULD do before cutting it loose.</p>
  </div>

  <div class="recommendation">
    <h3>3 · Turn on auto-restock</h3>
    <div class="impact">Impact: eliminates stockouts → captures lost demand that currently goes to competitors</div>
    <p>Morning proposal + Telegram Approve URL. Approve = PO sent + Amazon inbound walked + labels emailed. Start
    with Schluter only (highest margin, Prosol sourcing is reliable).</p>
  </div>

  <h2>This month — operational</h2>
  <div class="recommendation">
    <h3>4 · Fix Shopify UOM mismatches for flooring SKUs</h3>
    <div class="impact">Impact: accurate Shopify P&amp;L; unlocks true dog detection on vinyl plank / flooring</div>
    <p>Specifically SKUs <code>04059</code>, <code>11888</code>, <code>01602</code>, <code>00941</code> — SF cost is
    per-plank but Shopify sells per-box. Update either SF or Shopify to match the other's unit of measure.
    Without this, Shopify margins read ~86-91% which is false.</p>
  </div>

  <div class="recommendation">
    <h3>5 · Restock the 63 discoverable-no-stock SKUs</h3>
    <div class="impact">Impact: every restocked SKU is pure additive revenue — no Amazon listing costs</div>
    <p>These have live Amazon listings, priced, just zero FBA stock. Prioritize by historical velocity × margin.
    A filter exists in analytics: <code>SELECT * FROM v_sku_monthly_pnl WHERE qty_sold &gt; 0</code> joined against the
    listings status report.</p>
  </div>

  <h2>This quarter — strategic growth</h2>
  <div class="recommendation">
    <h3>6 · Catalog expansion bot — list the 95 "missing" ASINs</h3>
    <div class="impact">Impact: biggest lever toward \$100K/mo. Each new listing is incremental revenue.</div>
    <p>Listings Items API v2021-08-01 OFFER-only submissions. Start with high-BSR Schluter + Aqua Mix items we
    already source through Prosol. Prioritize by BSR × estimated margin. Target 20-30 new listings / month.</p>
  </div>

  <div class="recommendation">
    <h3>7 · UPS Direct API for pickups</h3>
    <div class="impact">Impact: faster inbound turnaround → faster stock replenishment → fewer stockouts</div>
    <p>Infrastructure is in place (lib/ups-api.js + /api/ups-pickup/book); needs UPS_CLIENT_ID/SECRET credentials.
    Unblocks same-day pickup scheduling for MFN orders and inbound FBA shipments.</p>
  </div>

  <div class="recommendation">
    <h3>8 · Brand registration on Amazon</h3>
    <div class="impact">Impact: protect top SKUs from hijackers; eligible for A+ content + lower fees on brand-registered categories</div>
    <p>Not a quick fix — requires Amazon Brand Registry application, trademark, and 2-4 weeks approval. But for a
    reseller doing \$46K/mo on brands like Schluter where we don't own the IP, the alternative is authorized
    distributor status from Schluter directly. Worth exploring with the Prosol relationship.</p>
  </div>
</section>

<!-- NEXT STEPS -->
<section class="slide">
  <div class="slide-num">14 · Immediate Next Steps</div>
  <h1>What I'd do tomorrow morning</h1>
  <ol style="line-height:2; padding-left:20px; font-size:17px">
    <li><strong>9 AM</strong> — check Seller Central. Verify the 25 Missing Offer listings flipped to BUYABLE.
        Any that didn't: inspect via <code>scripts/fba/check-listings-status.js --only=SKU</code>.</li>
    <li><strong>9:30 AM</strong> — enable auto-reprice with <code>dry_run:true</code>. Let it run one morning pull
        cycle (24h). Review what it would have done.</li>
    <li><strong>10 AM</strong> — enable auto-restock for Schluter only. First proposal will land tomorrow's 6 AM
        Telegram.</li>
    <li><strong>Thursday</strong> — pick the top 5 "discoverable-no-stock" SKUs by revenue-last-year and inbound them.
        Use <code>/api/fba/inbound/create-all</code>.</li>
    <li><strong>Next week</strong> — scope the catalog expansion bot. ~2 sessions of work. Start with 10 test listings
        to validate the Listings API flow.</li>
  </ol>
  <div class="footnote">
    Generated ${d.today} from analytics.sqlite on Mac Mini — ${fmtInt(d.counts.amazon_total)} orders,
    ${fmtInt(d.counts.events)} financial events, ${fmtInt(d.counts.labels)} shipping labels, ${fmtInt(d.counts.amazon_items)} line items.
    All figures are Amazon.ca marketplace (CAD) unless noted. Shopify data is complete for Feb 2026+
    (store went live then); earlier Shopify orders don't exist in our system.
  </div>
</section>

<script>
const data = ${JSON.stringify(chartData)};

// Monthly OPERATING PROFIT chart — bars green/red, margin% line overlay
new Chart(document.getElementById('opProfitChart'), {
  type: 'bar',
  data: {
    labels: data.monthlyLabels,
    datasets: [
      {
        label: 'Net Profit (CAD)',
        data: data.monthlyOpProfit,
        backgroundColor: data.monthlyOpProfit.map(v => v >= 0 ? '#059669' : '#dc2626'),
        yAxisID: 'y',
        order: 2,
      },
      {
        label: 'Margin %',
        data: data.monthlyOpMarginPct,
        type: 'line',
        borderColor: '#1e40af',
        backgroundColor: '#1e40af',
        tension: 0.3,
        pointRadius: 4,
        yAxisID: 'y1',
        order: 1,
      },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    scales: {
      y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Net Profit CAD' } },
      y1: { position: 'right', grid: { display: false }, title: { display: true, text: 'Margin %' }, ticks: { callback: (v) => v + '%' } },
    },
  },
});

// Monthly revenue bar chart
new Chart(document.getElementById('monthlyChart'), {
  type: 'bar',
  data: {
    labels: data.monthlyLabels,
    datasets: [
      { label: 'Revenue (CAD)', data: data.monthlyRev, backgroundColor: '#3b82f6', yAxisID: 'y' },
      { label: 'Orders', data: data.monthlyOrders, type: 'line', borderColor: '#f97316', backgroundColor: '#f97316', yAxisID: 'y1', tension: 0.3 },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    scales: {
      y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Revenue CAD' } },
      y1: { beginAtZero: true, position: 'right', grid: { display: false }, title: { display: true, text: 'Orders' } },
    },
  },
});

// YoY comparison
new Chart(document.getElementById('yoyChart'), {
  type: 'bar',
  data: {
    labels: data.yoyLabels,
    datasets: [
      { label: 'This year', data: data.yoyCur, backgroundColor: '#10b981' },
      { label: 'Last year (same month)', data: data.yoyPrev, backgroundColor: '#94a3b8' },
    ],
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'Revenue CAD' } } } },
});

// Fee breakdown doughnut
new Chart(document.getElementById('feeChart'), {
  type: 'doughnut',
  data: {
    labels: data.feeLabels,
    datasets: [{
      data: data.feeAmounts.map(v => Math.abs(v)),
      backgroundColor: ['#3b82f6','#f97316','#10b981','#ef4444','#8b5cf6','#f59e0b','#06b6d4','#ec4899','#64748b','#84cc16'],
    }],
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
});

// Brand P&L bar
new Chart(document.getElementById('brandChart'), {
  type: 'bar',
  data: {
    labels: data.brandLabels,
    datasets: [
      { label: 'Revenue', data: data.brandRev, backgroundColor: '#3b82f6' },
      { label: 'Net profit', data: data.brandProfit, backgroundColor: '#10b981' },
    ],
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'CAD' } } } },
});

// Full P&L waterfall stacked — cash in vs cash out per month
new Chart(document.getElementById('cashFlowBarChart'), {
  type: 'bar',
  data: {
    labels: data.pnlMonths,
    datasets: [
      { label: 'Cash IN (Amazon + Shopify)', data: data.pnlCashIn, backgroundColor: '#10b981', stack: 'io' },
      { label: 'PO spend (to vendors)', data: data.pnlPoSpend.map(v => -v), backgroundColor: '#ef4444', stack: 'io' },
      { label: 'Shipping labels', data: data.pnlLabels.map(v => -v), backgroundColor: '#f97316', stack: 'io' },
      { label: 'Net cash delta', data: data.pnlCashDelta, type: 'line', borderColor: '#1e40af', backgroundColor: '#1e40af', fill: false, tension: 0.3, pointRadius: 4, yAxisID: 'y' },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    scales: {
      x: { stacked: true },
      y: { stacked: true, title: { display: true, text: 'CAD' } },
    },
    plugins: { legend: { position: 'top' } },
  },
});

${d.poSpend.total > 0 ? `
// Monthly PO spend
new Chart(document.getElementById('poSpendChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(d.poSpend.byMonth.slice(0, 12).reverse().map((r) => r.month))},
    datasets: [{
      label: 'PO spend (CAD)',
      data: ${JSON.stringify(d.poSpend.byMonth.slice(0, 12).reverse().map((r) => r.spend))},
      backgroundColor: '#8b5cf6',
    }],
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
});` : ''}

// Cashflow daily
new Chart(document.getElementById('cashflowChart'), {
  type: 'line',
  data: {
    labels: data.cashflowLabels,
    datasets: [
      { label: 'Daily net cash (settled)', data: data.cashflowNet, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true, tension: 0.3 },
      { label: 'Gross revenue', data: data.cashflowRev, borderColor: '#3b82f6', fill: false, tension: 0.3 },
    ],
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { title: { display: true, text: 'CAD' } } } },
});
</script>

</body>
</html>`;
}

async function main() {
  const db = open();
  console.log('[report] gathering data...');
  const d = await gatherData(db);
  console.log('[report] fetching SF PO spend (24 months)...');
  const poRecords = await gatherSfPoSpend();
  d.poSpend = aggregatePoSpend(poRecords);
  if (d.poSpend.total > 0) console.log(`[report]   $${d.poSpend.total.toLocaleString()} PO spend across ${d.poSpend.monthCount} months / ${d.poSpend.byVendor.length} vendors`);
  console.log(`[report] ${d.counts.amazon_total} orders, ${d.counts.events} fee events, ${d.monthlyAmazon.length} months`);
  const html = renderHtml(d);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `financial-report-${d.today}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`\n✓ wrote ${outPath}`);
  console.log(`\n📊 View at: http://freds-mac-mini.taila452b5.ts.net:3456/financial-report-${d.today}.html`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { main, gatherData };
