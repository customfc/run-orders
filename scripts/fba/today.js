#!/usr/bin/env node
/**
 * FBA Today — the morning-coffee report.
 *
 * Reads the latest inventory-planning snapshot, normalizes, ranks,
 * and prints what needs action today, grouped by tier.
 *
 * Pulls a fresh snapshot if one doesn't exist for today.
 *
 * Usage:
 *   node scripts/fba/today.js            # use today's snapshot (pull if missing)
 *   node scripts/fba/today.js --cached   # use latest snapshot even if stale
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadLatestSnapshot, rankForToday } = require('../../lib/fba-signals');
const { main: pullInventoryPlanning } = require('./pull-inventory-planning');

const TODAY = new Date().toISOString().slice(0, 10);
const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'fba', 'snapshots');
const TODAYS_SNAPSHOT = path.join(SNAP_DIR, `inventory-planning-${TODAY}.json`);

async function ensureTodaySnapshot(useCached) {
  if (useCached) return;
  if (fs.existsSync(TODAYS_SNAPSHOT)) {
    console.log(`  using today's snapshot (${TODAY})`);
    return;
  }
  console.log('  no snapshot for today — pulling fresh...\n');
  await pullInventoryPlanning();
  console.log('');
}

function bar(label, count, total, width = 20) {
  const filled = Math.round((count / Math.max(total, 1)) * width);
  return `${label.padEnd(14)} ${'█'.repeat(filled).padEnd(width, '░')}  ${count}`;
}

function fmt$(n) { return n ? `$${n.toFixed(2)}` : '—'; }
function fmtD(n) { return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n}d`; }

function printTier(title, icon, rows, { showAll = false } = {}) {
  if (rows.length === 0) return;
  console.log(`\n${icon}  ${title}  (${rows.length})`);
  console.log('  ' + '─'.repeat(115));
  console.log(
    '  ' +
    'Product'.padEnd(52) +
    ' │ ' + 'Avail'.padStart(5) +
    ' │ ' + 'DoS'.padStart(4) +
    ' │ ' + 'v30'.padStart(4) +
    ' │ ' + 'Ship'.padStart(4) +
    ' │ ' + 'In'.padStart(5) +
    ' │ ' + 'BBox'.padStart(7) +
    ' │ ' + 'Your'.padStart(7)
  );
  console.log('  ' + '─'.repeat(115));
  const toPrint = showAll ? rows : rows.slice(0, 12);
  for (const r of toPrint) {
    const name = (r.productName || r.sku).slice(0, 52);
    const bbWin = r.yourPrice > 0 && r.featuredOfferPrice > 0
      ? (Math.abs(r.yourPrice - r.featuredOfferPrice) < 0.01 ? '✓' : ' ')
      : ' ';
    console.log(
      '  ' +
      name.padEnd(52) +
      ' │ ' + String(r.available).padStart(5) +
      ' │ ' + String(r.totalDaysOfSupply).padStart(4) +
      ' │ ' + String(r.units30).padStart(4) +
      ' │ ' + String(r.recShipQty).padStart(4) +
      ' │ ' + fmtD(r.daysUntilShip).padStart(5) +
      ' │ ' + (fmt$(r.featuredOfferPrice) + bbWin).padStart(7) +
      ' │ ' + fmt$(r.yourPrice).padStart(7)
    );
  }
  if (!showAll && rows.length > 12) console.log(`  … ${rows.length - 12} more`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const useCached = args.has('--cached');

  console.log('── FBA Today ────────────────────────────────────────────────────────────');
  console.log(`  ${new Date().toString()}`);

  await ensureTodaySnapshot(useCached);

  const snap = loadLatestSnapshot();
  if (!snap) {
    console.error('No snapshot available.');
    process.exit(1);
  }

  const rows = rankForToday(snap.rows);
  const byTier = {};
  for (const r of rows) (byTier[r.tier] ||= []).push(r);

  // Top-line summary
  const total = rows.length;
  console.log('\n── Overview ────────────────────────────────────────────────────────────');
  console.log('  Snapshot:', path.basename(snap.path));
  console.log('  Pulled at:', snap.pulledAt);
  console.log(`  Total SKUs tracked: ${total}`);
  console.log('');
  for (const tier of ['bleeding', 'urgent', 'lipc-active', 'low-cover', 'upcoming', 'other', 'dormant', 'healthy']) {
    if (byTier[tier]?.length) console.log('  ' + bar(tier, byTier[tier].length, total));
  }

  // Actionable money-at-risk summary
  const bleedingVelocity = (byTier.bleeding || []).reduce((s, r) => s + r.dailyVelocity * (r.featuredOfferPrice || r.yourPrice || 0), 0);
  const lipcCount = (byTier['lipc-active'] || []).length;
  const recUnitsTotal = rows.reduce((s, r) => s + (r.recShipQty || 0), 0);
  console.log('\n── Money at risk ──────────────────────────────────────────────────────');
  console.log(`  Daily revenue bleeding from stockouts:  ~$${bleedingVelocity.toFixed(2)}`);
  console.log(`  SKUs paying Low-Inventory-Level fee:    ${lipcCount}`);
  console.log(`  Total units Amazon recommends shipping: ${recUnitsTotal}`);

  // Tier details
  printTier('BLEEDING — zero stock on moving SKUs, shipping NOW', '🚨', byTier.bleeding || []);
  printTier('URGENT — Amazon says ship within 3 days', '⚡', byTier.urgent || []);
  printTier('LIPC FEE ACTIVE — paying Amazon\'s low-inventory penalty this week', '💸', byTier['lipc-active'] || []);
  printTier('LOW COVER — under 28 days of supply, LIPC risk', '⚠️ ', byTier['low-cover'] || []);
  printTier('UPCOMING — ship within 14 days per Amazon', '📅', byTier.upcoming || []);
  printTier('DORMANT — no sales in 30d but sitting on stock', '💤', byTier.dormant || [], { showAll: false });

  console.log('\n──────────────────────────────────────────────────────────────────────────\n');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
