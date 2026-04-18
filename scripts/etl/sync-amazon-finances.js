#!/usr/bin/env node
/**
 * Amazon Settlement Reports ETL — GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
 * → amazon_settlements + amazon_financial_events.
 *
 * Settlement reports are the source of truth for Amazon's per-transaction
 * fees, refunds, promotional discounts, and payout totals. One report per
 * payout cycle (~14 days). Retained ~2 years.
 *
 * Flat file v2 is tab-separated text. Columns include:
 *   settlement-id, settlement-start-date, settlement-end-date, deposit-date,
 *   total-amount, currency, transaction-type, order-id, merchant-order-id,
 *   shipment-id, marketplace-name, shipment-fee-type, shipment-fee-amount,
 *   order-fee-type, order-fee-amount, fulfillment-id, posted-date,
 *   posted-date-time, order-item-code, sku, quantity-purchased, price-type,
 *   price-amount, item-related-fee-type, item-related-fee-amount,
 *   misc-fee-amount, other-fee-amount, other-fee-reason-description,
 *   promotion-id, promotion-type, promotion-amount, direct-payment-type,
 *   direct-payment-amount, other-amount
 *
 * First row per settlement has a blank transaction-type and carries the
 * payout header (deposit-date, total-amount). Every subsequent row is one
 * data point (fee, refund, item charge, etc.) that we flatten into
 * amazon_financial_events.
 *
 * Modes:
 *   --backfill        — all settlements for the last 723 days
 *   --since <ISO>     — createdSince filter (manual delta)
 *   (default)         — uses etl_sync_state['amazon-finances'].cursor
 */

require('dotenv').config();
const sp = require('../../lib/sp-api');
const { open, setSyncState, getSyncState, tx } = require('../../lib/analytics-db');

const REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';

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

function isoAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

// Parse tab-separated flat file v2 settlement report into { header, rows }.
function parseSettlementFlatFile(csv) {
  // Split on any newline variant, drop empty trailing lines
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const rec = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = cells[i] ?? '';
    return rec;
  });
  return { header, rows };
}

// From a row, pick the most specific fee_type + amount. Settlement rows
// have up to ~8 fee columns; only one usually populated per row.
function pickFee(row) {
  const candidates = [
    ['item-related-fee-type', 'item-related-fee-amount'],
    ['shipment-fee-type', 'shipment-fee-amount'],
    ['order-fee-type', 'order-fee-amount'],
    ['misc-fee-amount', null],           // misc has no type, just "Misc"
    ['other-fee-reason-description', 'other-fee-amount'],
    ['promotion-type', 'promotion-amount'],
    ['direct-payment-type', 'direct-payment-amount'],
    [null, 'price-amount'],              // raw item price
    [null, 'other-amount'],
  ];
  for (const [typeKey, amtKey] of candidates) {
    const amt = num(row[amtKey]);
    if (amt === null || amt === 0) continue;
    const t = typeKey ? (row[typeKey] || null) : (amtKey === 'misc-fee-amount' ? 'Misc' : amtKey === 'price-amount' ? 'ItemPrice' : 'Other');
    return { feeType: t, amount: amt };
  }
  return null;
}

async function syncOneReport(db, report) {
  const reportId = report.reportId;
  // Skip if we've already fully ingested this report
  const existing = db.prepare('SELECT settlement_id FROM amazon_settlements WHERE settlement_id = ?').get(reportId);
  if (existing && !process.env.FORCE_REINGEST) {
    return { settlementId: reportId, skipped: true, rowCount: 0 };
  }

  const doc = await sp.getReportDocument(report.reportDocumentId);
  const body = await sp.fetchReportDocumentBody(doc);
  const { rows } = parseSettlementFlatFile(body);
  if (!rows.length) return { settlementId: reportId, skipped: false, rowCount: 0 };

  // First row carries the settlement header — transaction-type blank,
  // settlement-start/end-date + deposit-date + total-amount populated.
  const header = rows.find((r) => !r['transaction-type'] && r['settlement-id']) || rows[0];
  const settlementId = header['settlement-id'] || reportId;

  tx(() => {
    db.prepare(`
      INSERT INTO amazon_settlements (
        settlement_id, start_date, end_date, deposit_date, deposit_amount, currency, raw, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(settlement_id) DO UPDATE SET
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        deposit_date = excluded.deposit_date,
        deposit_amount = excluded.deposit_amount,
        currency = excluded.currency,
        raw = excluded.raw,
        ingested_at = excluded.ingested_at
    `).run(
      settlementId,
      header['settlement-start-date'] || null,
      header['settlement-end-date'] || null,
      header['deposit-date'] || null,
      num(header['total-amount']),
      header['currency'] || null,
      JSON.stringify({ reportId, reportDocumentId: report.reportDocumentId, headerRow: header }),
      new Date().toISOString(),
    );

    // Pre-delete financial events for this settlement so re-ingest is idempotent
    db.prepare('DELETE FROM amazon_financial_events WHERE settlement_id = ?').run(settlementId);

    const insEvent = db.prepare(`
      INSERT INTO amazon_financial_events (
        settlement_id, posted_at, transaction_type, amazon_order_id,
        asin, seller_sku, fee_type, amount_cad, currency, description, raw, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let eventRows = 0;
    for (const r of rows) {
      if (!r['transaction-type']) continue; // skip header + blank rows
      const postedAt = r['posted-date-time'] || r['posted-date'] || header['deposit-date'] || null;
      if (!postedAt) continue;

      const fee = pickFee(r);
      if (!fee) continue;

      // `price-amount` rows represent gross item revenue not a fee — still
      // worth capturing with fee_type='ItemPrice' so the P&L view can sum
      // revenue directly from the ledger without re-querying orders.
      const desc = r['other-fee-reason-description'] || null;
      insEvent.run(
        settlementId,
        postedAt,
        r['transaction-type'] || null,
        r['order-id'] || null,
        null, // ASIN not in settlement reports — resolve via order items
        r['sku'] || null,
        fee.feeType,
        fee.amount,
        r['currency'] || header['currency'] || null,
        desc,
        JSON.stringify(r),
        new Date().toISOString(),
      );
      eventRows++;
    }
    return eventRows;
  });

  const eventCount = db.prepare('SELECT COUNT(*) c FROM amazon_financial_events WHERE settlement_id = ?').get(settlementId).c;
  return { settlementId, skipped: false, rowCount: eventCount };
}

async function main() {
  const args = parseArgs();

  // Amazon caps listReports createdSince at 90 days. Anything older has to
  // come from the Finances API (/finances/v0/financialEvents) — not wired
  // yet. For now, clamp to 89d max.
  const MAX_AGO_DAYS = 89;
  const maxAgoIso = isoAgo(MAX_AGO_DAYS);
  let createdSince = null;
  if (args.backfill) {
    createdSince = maxAgoIso;
  } else if (args.since) {
    createdSince = args.since < maxAgoIso ? maxAgoIso : args.since;
  } else {
    const state = getSyncState('amazon-finances');
    const cursor = state?.cursor;
    createdSince = (!cursor || cursor < maxAgoIso) ? maxAgoIso : cursor;
  }

  console.log(`[amazon-finances] listing settlement reports createdSince=${createdSince} (capped at ${MAX_AGO_DAYS}d)`);
  const db = open();

  let nextToken = null;
  let totalReports = 0;
  let totalEvents = 0;
  let maxCreated = createdSince;

  try {
    do {
      const data = await sp.listReports({
        reportTypes: REPORT_TYPE,
        processingStatuses: ['DONE'],
        createdSince,
        pageSize: 100,
        nextToken,
      });
      const reports = data.reports || [];
      nextToken = data.nextToken || null;
      console.log(`[amazon-finances] page: ${reports.length} report(s)`);

      for (const r of reports) {
        try {
          const result = await syncOneReport(db, r);
          if (result.skipped) {
            console.log(`  · ${result.settlementId} (already ingested)`);
          } else {
            console.log(`  · ${result.settlementId} — ${result.rowCount} events`);
            totalEvents += result.rowCount;
          }
          totalReports++;
          if (r.createdTime && r.createdTime > maxCreated) maxCreated = r.createdTime;
          // Small sleep — Reports doc API is generous but don't hammer
          await new Promise((x) => setTimeout(x, 300));
        } catch (e) {
          console.warn(`  ✗ ${r.reportId}: ${e.message}`);
        }
      }
    } while (nextToken);

    setSyncState('amazon-finances', {
      cursor: maxCreated,
      rowsLastRun: totalEvents,
      status: 'ok',
    });
    console.log(`[amazon-finances] ✓ ${totalReports} report(s), ${totalEvents} events. cursor=${maxCreated}`);
  } catch (e) {
    setSyncState('amazon-finances', { cursor: maxCreated, rowsLastRun: totalEvents, status: 'error', errorMessage: e.message.slice(0, 500) });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[amazon-finances] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
