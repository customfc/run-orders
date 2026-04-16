#!/usr/bin/env node
/**
 * Rescue an orphan ghost label — add it to data/ghost-voids.json so it auto-voids on schedule.
 *
 * Usage:
 *   node scripts/shipstation/track-orphan-ghost.js <trackingNumber> [WH_CODE] [--dry-run]
 *
 * Examples:
 *   node scripts/shipstation/track-orphan-ghost.js 520490621205
 *   node scripts/shipstation/track-orphan-ghost.js 520490621205 NANA
 *   node scripts/shipstation/track-orphan-ghost.js 520490621205 --dry-run
 *
 * Pass --dry-run to see what would be written without touching ghost-voids.json.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { trackOrphanGhost } = require('../../lib/ghost-pickup');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [trackingNumber, warehouseCode] = positional;

  if (!trackingNumber) {
    console.error('Usage: node scripts/shipstation/track-orphan-ghost.js <trackingNumber> [WH_CODE] [--dry-run]');
    process.exit(1);
  }

  const r = await trackOrphanGhost({
    trackingNumber,
    warehouseCode: warehouseCode ? warehouseCode.toUpperCase() : null,
    dryRun,
  });

  if (!r.success) {
    console.error(`❌ ${r.error || 'failed'}`);
    if (r.action === 'not-a-ghost') {
      console.error(`\nShipment ${r.shipmentId} looks like a real customer label:`);
      console.error(`  shipTo: ${JSON.stringify(r.shipTo, null, 2)}`);
    }
    process.exit(2);
  }

  if (r.action === 'already-pending') {
    console.log(`ℹ️  Tracking ${trackingNumber} is already in the ghost-voids ledger. No action taken.`);
    process.exit(0);
  }

  const e = r.entry;
  console.log(`${dryRun ? '[DRY RUN] Would add' : '✅ Added'} orphan ghost to ledger:`);
  console.log(JSON.stringify(e, null, 2));
  if (dryRun) console.log('\nRe-run without --dry-run to actually add to data/ghost-voids.json.');
}

main().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
