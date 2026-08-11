#!/usr/bin/env node
/**
 * Amazon customer-returns sync.
 *
 * The P&L credits COGS back on every refunded unit, which assumes the goods
 * came back and can be sold again. Amazon's returns report says that is true
 * about half the time: over 2026-05..08, 55 FBA units came back, 30 were
 * SELLABLE, 23 were donated on arrival and 2 destroyed. The rest of the story
 * is worse — a refund with no return row at all is product that never came
 * back in any condition.
 *
 * This pulls the disposition per unit so v_refund_recovery can tell the
 * difference between a restock and a write-off instead of assuming.
 *
 * FBA:  GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA — has detailed-disposition.
 * MFN:  GET_XML_RETURNS_DATA_BY_RETURN_DATE — seller-fulfilled returns. The
 *       flat-file variant (GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE) is
 *       requested first because it parses cleanly; it returns FATAL on this
 *       account, so the XML form is the fallback. If both fail we record the
 *       failure and keep the FBA rows rather than aborting the whole sync —
 *       half the picture beats none, as long as the gap is visible.
 *
 * Usage:
 *   DISABLE_CRON=1 node scripts/etl/sync-amazon-returns.js
 *   DISABLE_CRON=1 node scripts/etl/sync-amazon-returns.js --backfill
 */

require('dotenv').config();
const { fetchReport } = require('../../lib/sp-api-reports');
const { open, setSyncState, tx } = require('../../lib/analytics-db');

const BACKFILL = process.argv.includes('--backfill');
// Returns lag the sale, so a short window misses late arrivals on old orders.
// Daily runs re-pull 60 days and rely on the unique index to dedupe.
const WINDOW_DAYS = BACKFILL ? 540 : 60;

const MARKETPLACE = (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');

function isoDaysAgo(days, now) {
  return new Date(now.getTime() - days * 86400000).toISOString();
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/**
 * Amazon returns two different date formats depending on the report: FBA gives
 * ISO ("2026-06-13T23:38:44+00:00"), MFN gives "01-Aug-2026". Stored side by
 * side in one column they sort and compare as nonsense, which silently breaks
 * every window filter over the table. Normalise to ISO on the way in.
 */
function toIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}T00:00:00Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Amazon's column names differ per report; normalise to our schema. */
function normaliseFba(r) {
  return {
    channel: 'fba',
    return_date: toIso(r['return-date']),
    amazon_order_id: r['order-id'] || null,
    seller_sku: r['sku'] || null,
    asin: r['asin'] || null,
    fnsku: r['fnsku'] || null,
    product_name: r['product-name'] || null,
    quantity: Number(r['quantity'] || 1) || 1,
    fulfillment_center: r['fulfillment-center-id'] || null,
    detailed_disposition: r['detailed-disposition'] || r['disposition'] || null,
    reason: r['reason'] || null,
    status: r['status'] || null,
    license_plate: r['license-plate-number'] || null,
    customer_comments: r['customer-comments'] || null,
    raw: JSON.stringify(r),
  };
}

function normaliseMfn(r) {
  // MFN rows carry no disposition — the buyer ships back to us and nobody
  // grades it. Leave detailed_disposition NULL rather than inventing
  // 'SELLABLE': an unknown is not a recovery, and v_refund_recovery counts it
  // as unknown so the gap stays visible instead of flattering the margin.
  return {
    channel: 'mfn',
    return_date: toIso(r['return-date'] || r['Return request date'] || r['order-date']),
    amazon_order_id: r['order-id'] || r['Order ID'] || null,
    seller_sku: r['sku'] || r['Merchant SKU'] || null,
    asin: r['asin'] || r['ASIN'] || null,
    fnsku: null,
    product_name: r['item-name'] || r['Item Name'] || null,
    quantity: Number(r['quantity'] || r['Return quantity'] || 1) || 1,
    fulfillment_center: null,
    detailed_disposition: null,
    reason: r['reason'] || r['Return reason'] || null,
    status: r['status'] || r['Return request status'] || null,
    license_plate: null,
    customer_comments: r['customer-comments'] || r['Customer comments'] || null,
    raw: JSON.stringify(r),
  };
}

async function pullFba(now) {
  const { rows } = await fetchReport({
    reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
    marketplaceIds: [MARKETPLACE],
    dataStartTime: isoDaysAgo(WINDOW_DAYS, now),
    dataEndTime: now.toISOString(),
    onProgress: () => {},
  });
  return (rows || []).map(normaliseFba);
}

async function pullMfn(now) {
  const attempts = [
    'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE',
    'GET_XML_RETURNS_DATA_BY_RETURN_DATE',
  ];
  const errors = [];
  for (const reportType of attempts) {
    try {
      const { rows } = await fetchReport({
        reportType,
        marketplaceIds: [MARKETPLACE],
        dataStartTime: isoDaysAgo(Math.min(WINDOW_DAYS, 60), now),
        dataEndTime: now.toISOString(),
        parse: reportType.startsWith('GET_XML') ? 'raw' : 'tsv',
        onProgress: () => {},
      });
      if (Array.isArray(rows) && rows.length) return { rows: rows.map(normaliseMfn), reportType };
      errors.push(`${reportType}: 0 rows`);
    } catch (e) {
      errors.push(`${reportType}: ${e.message.slice(0, 120)}`);
    }
  }
  return { rows: [], reportType: null, errors };
}

async function main() {
  if (!MARKETPLACE) throw new Error('AMAZON_SP_MARKETPLACE_ID is not set');
  const now = new Date();
  const db = open();

  const ins = db.prepare(`
    INSERT OR IGNORE INTO amazon_returns
      (channel, return_date, amazon_order_id, seller_sku, asin, fnsku, product_name, quantity,
       fulfillment_center, detailed_disposition, reason, status, license_plate, customer_comments,
       raw, ingested_at)
    VALUES
      (@channel, @return_date, @amazon_order_id, @seller_sku, @asin, @fnsku, @product_name, @quantity,
       @fulfillment_center, @detailed_disposition, @reason, @status, @license_plate, @customer_comments,
       @raw, @ingested_at)`);

  try {
    // Self-heal rows written before return_date was normalised. Mixed formats
    // in one column are not merely untidy: v_refund_recovery's coverage guard
    // compares a refund date against MIN(return_date), and a single legacy
    // '01-Aug-2026' string sorts below every ISO date, pinning the floor at a
    // bogus value and silently disabling the guard.
    const legacy = db.prepare("SELECT id, return_date FROM amazon_returns WHERE return_date NOT LIKE '____-__-__%'").all();
    if (legacy.length) {
      const upd = db.prepare('UPDATE amazon_returns SET return_date = ? WHERE id = ?');
      let fixed = 0;
      tx(() => { for (const r of legacy) { const iso = toIso(r.return_date); if (iso) { upd.run(iso, r.id); fixed++; } } });
      console.log(`[returns] normalised ${fixed} legacy date(s) to ISO`);
    }

    const fba = await pullFba(now);
    const mfn = await pullMfn(now);
    const all = [...fba, ...mfn.rows].filter((r) => r.return_date && r.seller_sku);
    const stamped = all.map((r) => ({ ...r, ingested_at: now.toISOString() }));

    const before = db.prepare('SELECT COUNT(*) n FROM amazon_returns').get().n;
    tx(() => { for (const r of stamped) ins.run(r); });
    const after = db.prepare('SELECT COUNT(*) n FROM amazon_returns').get().n;

    console.log(`[returns] fba ${fba.length} rows, mfn ${mfn.rows.length} rows (${mfn.reportType || 'unavailable'})`);
    console.log(`[returns] inserted ${after - before} new, ${stamped.length - (after - before)} already present`);
    if (!mfn.rows.length) {
      console.log(`[returns] ⚠ MFN returns unavailable — the write-off rate below covers FBA only. ${(mfn.errors || []).join(' | ')}`);
    }

    const disp = db.prepare(`
      SELECT COALESCE(detailed_disposition, 'UNKNOWN (mfn)') d, SUM(quantity) units
      FROM amazon_returns WHERE return_date >= ? GROUP BY d ORDER BY units DESC`).all(isoDaysAgo(90, now));
    const total = disp.reduce((s, r) => s + r.units, 0);
    if (total) {
      console.log('[returns] last 90 days by disposition:');
      for (const r of disp) console.log(`  ${String(r.d).padEnd(22)} ${String(r.units).padStart(4)}  ${(100 * r.units / total).toFixed(1)}%`);
    }

    setSyncState('amazon-returns', {
      status: 'ok',
      rowsLastRun: after - before,
      // Surfaced as an error message deliberately: a half-covered returns
      // table produces a write-off rate that reads as the whole business.
      errorMessage: mfn.rows.length ? null : 'MFN returns unavailable — FBA only',
    });
  } catch (e) {
    setSyncState('amazon-returns', { status: 'error', errorMessage: e.message.slice(0, 500) });
    throw e;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[returns] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
