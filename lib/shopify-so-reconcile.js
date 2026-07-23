'use strict';

// ── Shopify → Salesforce Sales-Order reconciliation sweep ────────────────────
//
// WHY THIS EXISTS
// The pipeline's per-order SO creation (lib/pipeline.js phasePos) only fires for
// Shopify labels bought in the CURRENT day's run-state
// (`state.phases.buy.labels`, source='shopify'). Any fulfilled order whose label
// was bought manually, on a prior day (state rolls daily), or on a day the pos
// phase didn't run, ships WITHOUT an SF Sales Order — and nothing back-fills it.
// Audit 2026-07-23 found 8 such orders over 60 days (1274-1279, 1283, 1317),
// i.e. unrecorded revenue/COGS in Salesforce.
//
// This sweep decouples SO creation from the daily buy-state: it enumerates
// recent FULFILLED + PAID + non-cancelled Shopify orders, checks each has an SF
// SO (by Customer PO = order number), and creates the missing ones via the same
// createShopifySoPo path — so a gap self-heals on the next pipeline run.
//
// SHADOW by default (mirrors orphan-email-sweep / auto-rebooker): set
// SHOPIFY_SO_RECONCILE_LIVE=1 to actually create. Backfilled SOs are stamped
// with the Shopify order's own date (orderDateOverride) so month-end close isn't
// scrambled. createShopifySoPo carries its own skip-if-exists guard, so the
// sweep is idempotent — safe to run every pipeline pass.
//
// SKIP rules (never auto-create an SO for these):
//   - not fulfilled (unfulfilled/partial) — hasn't shipped, SO not due yet
//   - cancelled_at set — order was cancelled/refunded
//   - financial_status != 'paid' — not a completed sale
//   - tags reference an existing SO (/SO-\d+/) or an add-on (/addon/) — the
//     order was consolidated onto a PARENT order's SO (e.g. #1298 → SO-024725,
//     tags "order-1293, SO-024725, underlay-addon"); creating a fresh SO would
//     double-book the revenue.

const sf = require('./salesforce');
const { fetchShopifyOrder, listShopifyOrders, createShopifySoPo } = require('./shopify-sf');

const SHOPIFY_ACCOUNT_ID = '0014x000023jkuDAAQ';
const LOOKBACK_DAYS = 45;

const isLive = () => process.env.SHOPIFY_SO_RECONCILE_LIVE === '1';

// Is this a fulfilled, paid, non-cancelled order that isn't a consolidated
// add-on? Returns { eligible:true } or { eligible:false, reason }.
function classify(order) {
  if (order.cancelled_at) return { eligible: false, reason: 'cancelled' };
  if (order.financial_status !== 'paid') return { eligible: false, reason: `financial=${order.financial_status}` };
  if (order.fulfillment_status !== 'fulfilled') return { eligible: false, reason: `fulfillment=${order.fulfillment_status || 'unfulfilled'}` };
  const tags = String(order.tags || '');
  if (/SO-\d{3,}/i.test(tags)) return { eligible: false, reason: `consolidated (tags: ${tags})` };
  if (/\baddon\b|add-on/i.test(tags)) return { eligible: false, reason: `add-on (tags: ${tags})` };
  return { eligible: true };
}

async function reconcileShopifySOs({ days = LOOKBACK_DAYS, live = isLive(), onProgress = () => {} } = {}) {
  const report = { live, days, scanned: 0, eligible: 0, missing: [], created: [], skipped: [], errors: [] };
  const conn = await sf.connect();

  const orders = await listShopifyOrders({ days });
  report.scanned = orders.length;

  // Which Customer POs already have an SF SO? Widen the SO window past the order
  // window so an order placed near the edge whose SO was created later still
  // counts as present.
  const sos = await sf.query(conn,
    `SELECT PBSI__Customer_Purchase_Order__c FROM PBSI__PBSI_Sales_Order__c
     WHERE PBSI__Customer__c = '${SHOPIFY_ACCOUNT_ID}' AND CreatedDate = LAST_N_DAYS:${days + 20}`);
  const have = new Set(sos.map(r => String(r.PBSI__Customer_Purchase_Order__c || '').replace(/^#/, '').trim()).filter(Boolean));

  for (const o of orders) {
    const num = String(o.order_number);
    const cls = classify(o);
    if (!cls.eligible) { report.skipped.push({ order: num, reason: cls.reason }); continue; }
    report.eligible++;
    if (have.has(num)) continue; // already has an SO — nothing to do
    report.missing.push({ order: num, created_at: (o.created_at || '').slice(0, 10) });
  }

  if (!live) {
    onProgress({ type: 'status', message: `[so-reconcile] SHADOW — ${report.missing.length} order(s) missing SF SO: ${report.missing.map(m => m.order).join(', ') || 'none'}` });
    return report;
  }

  for (const m of report.missing) {
    try {
      onProgress({ type: 'status', message: `[so-reconcile] creating SO for Shopify ${m.order}...` });
      const full = await fetchShopifyOrder(m.order);
      const r = await createShopifySoPo({ shopifyOrder: full, orderDateOverride: m.created_at });
      if (r.skipped) {
        report.skipped.push({ order: m.order, reason: `skip-if-exists: ${r.skipReason}` });
      } else {
        report.created.push({
          order: m.order,
          so: r.soNumber || null,
          po: r.poNumber || null,
          poSkipped: !!r.poSkipped,
          errors: (r.errors || []).map(e => e.error || String(e)),
        });
      }
    } catch (err) {
      report.errors.push({ order: m.order, error: err.message });
    }
  }
  return report;
}

function formatReport(r) {
  const L = [`Shopify→SF SO reconcile (${r.live ? 'LIVE' : 'SHADOW'}, ${r.days}d): scanned ${r.scanned}, eligible ${r.eligible}`];
  if (r.missing.length) L.push(`missing SO: ${r.missing.map(m => m.order).join(', ')}`);
  if (r.created.length) L.push(`created: ${r.created.map(c => `${c.order}→${c.so}${c.poSkipped ? ' (SO-only)' : c.po ? '/' + c.po : ''}`).join(', ')}`);
  if (r.errors.length) L.push(`errors: ${r.errors.map(e => `${e.order}: ${e.error}`).join('; ')}`);
  return L.join('\n');
}

module.exports = { reconcileShopifySOs, formatReport, classify, LOOKBACK_DAYS };
