/**
 * Analytics alerts — daily checks over the Phase B views.
 *
 * Each check returns { title, lines } or null. The orchestrator
 * (scripts/alerts/daily-alerts.js) runs all checks, rolls the findings
 * into one Telegram message, and stays silent if everything's fine.
 *
 * Design principle: don't ping for things the morning digest already
 * surfaces (ghost exposure, ETL failures). Only ping for things that
 * require a decision today.
 */

const { open } = require('./analytics-db');

// ── Cost hikes (> threshold %) since last sync ─────────────────────────────

function checkCostHikes({ pctThreshold = 10 } = {}) {
  const db = open();
  const rows = db.prepare(`
    SELECT sku, cost_cad, previous_cost_cad, cost_source,
           ROUND((cost_cad - previous_cost_cad) / previous_cost_cad * 100, 1) pct,
           updated_at
    FROM item_costs
    WHERE previous_cost_cad IS NOT NULL
      AND previous_cost_cad > 0
      AND (cost_cad - previous_cost_cad) / previous_cost_cad > ?
      AND updated_at > datetime('now', '-36 hours')
    ORDER BY pct DESC
    LIMIT 20
  `).all(pctThreshold / 100);
  if (!rows.length) return null;
  const lines = rows.map((r) => `  ${r.sku}: $${r.previous_cost_cad} → $${r.cost_cad} (+${r.pct}%)`);
  return { title: `💰 ${rows.length} cost hike${rows.length > 1 ? 's' : ''} >${pctThreshold}%`, lines };
}

// ── BB lost 3+ consecutive days ────────────────────────────────────────────

function checkBbLosersPersistent({ daysThreshold = 3 } = {}) {
  const db = open();
  // For each ASIN, count consecutive most-recent days where tier='bb-losing'
  const rows = db.prepare(`
    WITH recent AS (
      SELECT snapshot_date, asin, sku, tier, bb_price, our_price
      FROM buybox_daily
      WHERE snapshot_date >= date('now', '-14 days')
    ),
    latest AS (
      SELECT asin, MAX(snapshot_date) latest_date FROM recent GROUP BY asin
    )
    SELECT r.asin, r.sku, r.bb_price, r.our_price,
           COUNT(*) FILTER (WHERE r.tier = 'bb-losing') AS days_losing,
           COUNT(*) AS total_days
    FROM recent r
    JOIN latest l ON l.asin = r.asin
    WHERE r.snapshot_date >= date(l.latest_date, '-6 days')
    GROUP BY r.asin, r.sku
    HAVING days_losing >= ?
    ORDER BY days_losing DESC
    LIMIT 20
  `).all(daysThreshold);
  if (!rows.length) return null;
  const lines = rows.map((r) => `  ${r.sku || r.asin}: ${r.days_losing}/${r.total_days}d losing · BB $${r.bb_price?.toFixed(2)} · us $${r.our_price?.toFixed(2)}`);
  return { title: `🥊 ${rows.length} SKU${rows.length > 1 ? 's' : ''} losing BB ${daysThreshold}+ days`, lines };
}

// ── Low cover crossed LIPC threshold today ─────────────────────────────────

function checkLowCoverCrossed({ threshold = 28 } = {}) {
  const db = open();
  // Today's snapshot < threshold AND yesterday's >= threshold → newly crossed
  const latest = db.prepare(`SELECT MAX(snapshot_date) d FROM inventory_daily`).get();
  if (!latest.d) return null;
  const rows = db.prepare(`
    SELECT today.sku, today.asin, today.total_days_of_supply today_dos,
           yesterday.total_days_of_supply yesterday_dos, today.units30
    FROM inventory_daily today
    LEFT JOIN inventory_daily yesterday
      ON yesterday.asin = today.asin
      AND yesterday.snapshot_date = date(today.snapshot_date, '-1 day')
    WHERE today.snapshot_date = ?
      AND today.total_days_of_supply > 0
      AND today.total_days_of_supply < ?
      AND today.units30 > 0
      AND (yesterday.total_days_of_supply IS NULL
           OR yesterday.total_days_of_supply >= ?)
    ORDER BY today.total_days_of_supply ASC
    LIMIT 20
  `).all(latest.d, threshold, threshold);
  if (!rows.length) return null;
  const lines = rows.map((r) => `  ${r.sku || r.asin}: ${r.today_dos?.toFixed(1)}d cover · ${r.units30}u/30d`);
  return { title: `📉 ${rows.length} SKU${rows.length > 1 ? 's' : ''} crossed LIPC threshold (< ${threshold}d cover)`, lines };
}

// ── New dogs — SKUs with negative margin in latest complete settled month ──

function checkNewDogs({ minRevenue = 200 } = {}) {
  const db = open();
  // Latest complete settlement is typically 2 weeks ago. Use the last full
  // month we have settlement data for (look back 2 months from today).
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);
  const lastCompleteMonth = twoMonthsAgo.toISOString().slice(0, 7);

  const rows = db.prepare(`
    SELECT sku, brand, month, ROUND(revenue, 2) rev, qty_sold,
           ROUND(net_profit, 2) profit, net_margin_pct
    FROM v_sku_monthly_pnl
    WHERE month = ?
      AND revenue >= ?
      AND net_profit < 0
      AND qty_sold > 0
    ORDER BY net_profit ASC
    LIMIT 10
  `).all(lastCompleteMonth, minRevenue);
  if (!rows.length) return null;
  const lines = rows.map((r) => `  ${r.sku} (${r.brand || 'nobrand'}): $${r.rev} rev · $${r.profit} profit (${r.net_margin_pct}%)`);
  return { title: `🐕 ${rows.length} dog${rows.length > 1 ? 's' : ''} in ${lastCompleteMonth} (settled, negative margin)`, lines };
}

// ── Brand margin MoM drop ───────────────────────────────────────────────────

function checkMarginDrop({ pctDropThreshold = 5 } = {}) {
  const db = open();
  const now = new Date();
  const lastMonth = new Date(now); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const prevMonth = new Date(now); prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 2);
  const lastIso = lastMonth.toISOString().slice(0, 7);
  const prevIso = prevMonth.toISOString().slice(0, 7);

  const rows = db.prepare(`
    WITH last AS (
      SELECT brand, net_margin_pct, revenue
      FROM v_brand_monthly_pnl WHERE month = ?
    ),
    prev AS (
      SELECT brand, net_margin_pct, revenue
      FROM v_brand_monthly_pnl WHERE month = ?
    )
    SELECT last.brand,
           last.revenue last_rev,
           last.net_margin_pct last_margin,
           prev.net_margin_pct prev_margin,
           ROUND(last.net_margin_pct - prev.net_margin_pct, 1) delta
    FROM last
    JOIN prev ON prev.brand = last.brand
    WHERE last.net_margin_pct IS NOT NULL
      AND prev.net_margin_pct IS NOT NULL
      AND last.revenue > 500
      AND (last.net_margin_pct - prev.net_margin_pct) < ?
    ORDER BY delta ASC
  `).all(lastIso, prevIso, -pctDropThreshold);
  if (!rows.length) return null;
  const lines = rows.map((r) => `  ${r.brand}: ${r.prev_margin}% → ${r.last_margin}% (${r.delta}pts, $${r.last_rev} rev)`);
  return { title: `📊 ${rows.length} brand${rows.length > 1 ? 's' : ''} margin dropped >${pctDropThreshold}pts MoM`, lines };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

async function runAllChecks() {
  const findings = [];
  for (const fn of [checkCostHikes, checkBbLosersPersistent, checkLowCoverCrossed, checkNewDogs, checkMarginDrop]) {
    try {
      const r = fn();
      if (r) findings.push(r);
    } catch (e) {
      findings.push({ title: `⚠️ check ${fn.name} errored`, lines: [`  ${e.message}`] });
    }
  }
  return findings;
}

module.exports = {
  runAllChecks,
  checkCostHikes,
  checkBbLosersPersistent,
  checkLowCoverCrossed,
  checkNewDogs,
  checkMarginDrop,
};
