#!/usr/bin/env node
/**
 * Deep financial backfill via SP-API Finances v0 (730-day retention).
 *
 * Complements sync-amazon-finances.js (Settlement Reports — capped at 90d
 * by Amazon's listReports.createdSince limit). This script iterates
 * daily PostedAfter/PostedBefore windows backwards, extracts every event
 * Amazon has posted (shipments, refunds, service fees, adjustments,
 * storage, etc.) and flattens them into amazon_financial_events with
 * settlement_id='finances-api' so queries can distinguish the two sources.
 *
 * Dedup strategy: settlement reports remain source of truth for the last
 * 90d (higher fidelity). Views should prefer settlement rows and exclude
 * finances-api rows whose (posted_at, amazon_order_id, fee_type) has a
 * matching settlement row. Within the finances-api corpus, each daily
 * window is pre-deleted before re-inserting, so re-runs are idempotent.
 *
 * Rate limit: 0.5 req/s sustained, burst 30. Script sleeps 2.1s between
 * calls. 730 daily windows + pagination ≈ 25-45 min for a cold backfill.
 *
 * Usage:
 *   --backfill           all 723 days
 *   --since <date>       PostedAfter >= date (YYYY-MM-DD)
 *   --from <date> --to <date>   explicit window
 *   (default)            last 30 days (safe for nightly top-up)
 */

require('dotenv').config();
const sp = require('../../lib/sp-api');
const { open, setSyncState, getSyncState, tx } = require('../../lib/analytics-db');

const SOURCE_ID = 'finances-api';

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (v !== undefined) { args[k.slice(2)] = v; continue; }
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k.slice(2)] = true;
      else { args[k.slice(2)] = next; i++; }
    }
  }
  return args;
}

function dayIso(d) {
  return d.toISOString().slice(0, 10);
}
function startOfDayIso(dateStr) { return `${dateStr}T00:00:00Z`; }
function endOfDayIso(dateStr) { return `${dateStr}T23:59:59Z`; }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return dayIso(d);
}
function todayIso() { return dayIso(new Date()); }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null ? null : String(v); }

// Event flatteners — each returns an array of row objects for
// amazon_financial_events. Row shape: {postedAt, transactionType,
// amazonOrderId, sku, feeType, amountCad, currency, description, raw}.

function flattenShipmentEvent(ev, isRefund = false) {
  const out = [];
  const postedAt = ev.PostedDate || null;
  const orderId = ev.AmazonOrderId || null;
  const marketplace = ev.MarketplaceName || null;
  const transactionType = isRefund ? 'Refund' : 'Shipment';

  const itemLists = [
    ...(ev.ShipmentItemList || []),
    ...(ev.ShipmentItemAdjustmentList || []),
  ];
  for (const item of itemLists) {
    const sku = item.SellerSKU || null;
    for (const charge of item.ItemChargeList || []) {
      const amt = num(charge.ChargeAmount?.CurrencyAmount);
      if (amt === null || amt === 0) continue;
      out.push({
        postedAt, transactionType, amazonOrderId: orderId, sku,
        feeType: `ItemPrice:${charge.ChargeType}`,
        amountCad: amt,
        currency: charge.ChargeAmount?.CurrencyCode || null,
        description: marketplace,
        raw: item,
      });
    }
    for (const fee of item.ItemFeeList || []) {
      const amt = num(fee.FeeAmount?.CurrencyAmount);
      if (amt === null || amt === 0) continue;
      out.push({
        postedAt, transactionType, amazonOrderId: orderId, sku,
        feeType: `ItemFees:${fee.FeeType}`,
        amountCad: amt,
        currency: fee.FeeAmount?.CurrencyCode || null,
        description: marketplace,
        raw: item,
      });
    }
    for (const promo of item.PromotionList || []) {
      const amt = num(promo.PromotionAmount?.CurrencyAmount);
      if (amt === null || amt === 0) continue;
      out.push({
        postedAt, transactionType, amazonOrderId: orderId, sku,
        feeType: `Promotion:${promo.PromotionType || promo.PromotionId || 'Unknown'}`,
        amountCad: amt,
        currency: promo.PromotionAmount?.CurrencyCode || null,
        description: marketplace,
        raw: item,
      });
    }
    for (const wt of item.ItemTaxWithheldList || []) {
      for (const tw of (wt.TaxesWithheld || [])) {
        const amt = num(tw.ChargeAmount?.CurrencyAmount);
        if (amt === null || amt === 0) continue;
        out.push({
          postedAt, transactionType, amazonOrderId: orderId, sku,
          feeType: `ItemWithheldTax:${tw.ChargeType}`,
          amountCad: amt,
          currency: tw.ChargeAmount?.CurrencyCode || null,
          description: marketplace,
          raw: item,
        });
      }
    }
  }
  return out;
}

function flattenServiceFee(ev) {
  const out = [];
  const postedAt = ev.PostedDate || null;
  const orderId = ev.AmazonOrderId || null;
  const sku = ev.SellerSKU || null;
  const reason = ev.FeeReason || null;
  for (const fee of ev.FeeList || []) {
    const amt = num(fee.FeeAmount?.CurrencyAmount);
    if (amt === null || amt === 0) continue;
    out.push({
      postedAt,
      transactionType: 'ServiceFee',
      amazonOrderId: orderId,
      sku,
      feeType: `ServiceFee:${fee.FeeType}`,
      amountCad: amt,
      currency: fee.FeeAmount?.CurrencyCode || null,
      description: reason,
      raw: ev,
    });
  }
  return out;
}

function flattenAdjustment(ev) {
  const out = [];
  const postedAt = ev.PostedDate || null;
  const reason = ev.AdjustmentType || null;
  const items = ev.AdjustmentItemList || [];
  if (!items.length) {
    const amt = num(ev.AdjustmentAmount?.CurrencyAmount);
    if (amt !== null && amt !== 0) {
      out.push({
        postedAt, transactionType: 'Adjustment', amazonOrderId: null, sku: null,
        feeType: `Adjustment:${reason || 'Unknown'}`,
        amountCad: amt,
        currency: ev.AdjustmentAmount?.CurrencyCode || null,
        description: reason,
        raw: ev,
      });
    }
    return out;
  }
  for (const item of items) {
    const amt = num(item.PerUnitAmount?.CurrencyAmount);
    const qty = num(item.Quantity) || 1;
    if (amt === null || amt === 0) continue;
    out.push({
      postedAt, transactionType: 'Adjustment', amazonOrderId: null,
      sku: item.SellerSKU || null,
      feeType: `Adjustment:${reason || 'Unknown'}`,
      amountCad: amt * qty,
      currency: item.PerUnitAmount?.CurrencyCode || null,
      description: reason,
      raw: item,
    });
  }
  return out;
}

// Walk a FinancialEvents payload and return all flattened rows.
function flattenAll(events) {
  const out = [];
  for (const ev of events.ShipmentEventList || []) out.push(...flattenShipmentEvent(ev, false));
  for (const ev of events.RefundEventList || []) out.push(...flattenShipmentEvent(ev, true));
  for (const ev of events.ServiceFeeEventList || []) out.push(...flattenServiceFee(ev));
  for (const ev of events.AdjustmentEventList || []) out.push(...flattenAdjustment(ev));
  // ProductAdsPaymentEvent, RentalTransactionEvent, etc. — skip (not common
  // for reseller use case); raw JSON is preserved in settlement reports
  // for back-reference if ever needed.
  return out;
}

async function fetchDayEvents(day) {
  const postedAfter = startOfDayIso(day);
  // Amazon rejects PostedBefore > (now - 2 min). For today's window, clamp
  // to 3 minutes ago; past days get 23:59:59 as usual.
  const today = todayIso();
  let postedBefore;
  if (day === today) {
    const now = new Date();
    now.setUTCMinutes(now.getUTCMinutes() - 3);
    postedBefore = now.toISOString().replace(/\.\d+Z$/, 'Z');
  } else {
    postedBefore = endOfDayIso(day);
  }
  const allRows = [];
  let nextToken = null;
  do {
    let data;
    try {
      data = await sp.listFinancialEvents({ postedAfter, postedBefore, nextToken, maxResultsPerPage: 100 });
    } catch (e) {
      if (e.retryable) {
        await new Promise((r) => setTimeout(r, 30_000));
        data = await sp.listFinancialEvents({ postedAfter, postedBefore, nextToken, maxResultsPerPage: 100 });
      } else throw e;
    }
    const events = data.payload?.FinancialEvents || {};
    const rows = flattenAll(events);
    allRows.push(...rows);
    nextToken = data.payload?.NextToken || null;
    // Finances API sustained = 0.5 req/s
    await new Promise((r) => setTimeout(r, 2100));
  } while (nextToken);
  return allRows;
}

function ingestDay(db, day, rows) {
  tx(() => {
    // Pre-delete this day's finances-api rows for idempotency
    db.prepare(`
      DELETE FROM amazon_financial_events
      WHERE settlement_id = ? AND substr(posted_at, 1, 10) = ?
    `).run(SOURCE_ID, day);

    const ins = db.prepare(`
      INSERT INTO amazon_financial_events (
        settlement_id, posted_at, transaction_type, amazon_order_id,
        asin, seller_sku, fee_type, amount_cad, currency, description,
        raw, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const r of rows) {
      if (!r.postedAt || !r.feeType) continue;
      ins.run(
        SOURCE_ID,
        r.postedAt,
        r.transactionType || null,
        r.amazonOrderId,
        null, // ASIN not in Finances API
        r.sku,
        r.feeType,
        r.amountCad,
        r.currency,
        r.description,
        JSON.stringify(r.raw),
        now,
      );
    }
  });
}

async function main() {
  const args = parseArgs();
  const today = todayIso();

  let fromDay, toDay;
  if (args.backfill) {
    // 723 days back, leaving a 7-day buffer from Amazon's 730d ceiling
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 723);
    fromDay = dayIso(start);
    toDay = today;
  } else if (args.from || args.to) {
    fromDay = args.from || addDays(today, -30);
    toDay = args.to || today;
  } else if (args.since) {
    fromDay = args.since;
    toDay = today;
  } else {
    const state = getSyncState('amazon-finances-deep');
    if (state?.cursor) {
      fromDay = state.cursor;
    } else {
      fromDay = addDays(today, -30);
    }
    toDay = today;
  }

  console.log(`[finances-deep] iterating daily windows ${fromDay} → ${toDay}`);
  const db = open();

  let day = toDay;
  let totalRows = 0;
  let daysDone = 0;

  try {
    while (day >= fromDay) {
      const t0 = Date.now();
      const rows = await fetchDayEvents(day);
      ingestDay(db, day, rows);
      totalRows += rows.length;
      daysDone++;
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      if (rows.length > 0 || daysDone % 10 === 0) {
        console.log(`[finances-deep] ${day}: ${rows.length} events (${dur}s) — running total ${totalRows}`);
      }

      // Checkpoint every 20 days so long backfills can resume
      if (daysDone % 20 === 0) {
        setSyncState('amazon-finances-deep', {
          cursor: day,
          rowsLastRun: totalRows,
          status: 'ok',
        });
      }

      day = addDays(day, -1);
    }

    setSyncState('amazon-finances-deep', {
      cursor: toDay, // forward marker for next delta run
      rowsLastRun: totalRows,
      status: 'ok',
    });
    console.log(`[finances-deep] ✓ ${daysDone} days, ${totalRows} events`);
  } catch (e) {
    setSyncState('amazon-finances-deep', { cursor: day, rowsLastRun: totalRows, status: 'error', errorMessage: e.message.slice(0, 500) });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[finances-deep] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
