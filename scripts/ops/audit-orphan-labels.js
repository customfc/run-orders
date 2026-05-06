#!/usr/bin/env node
/**
 * Read-only audit: find shipments in ShipStation that exist in carrier-side
 * reality but are missing from our pipeline state — i.e. labels we paid for
 * that never produced a Salesforce SO/PO and never triggered the warehouse
 * email or pickup flow.
 *
 * Why this exists: prior to commit 43b8397, opsState helpers had a
 * read-modify-write race that let concurrent writers (cron pipeline +
 * dashboard /api/labels/buy) clobber each other's state. Some labels were
 * physically bought but never recorded in state.phases.buy.labels, so the
 * downstream pos/email/pickups phases never picked them up.
 *
 * This script does NOT mutate anything. It reads ShipStation + the local
 * ops-state files and prints a markdown table of suspect orphans for human
 * review. Per-order remediation (call vendor, decide whether to backfill the
 * PO) is intentionally manual — automating it risks double-billing.
 *
 * Usage: node scripts/ops/audit-orphan-labels.js [--days 14]
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { fetchShippedShipments } = require('../../lib/shipstation-v2');

const STATE_DIR = path.join(__dirname, '..', '..', 'data', 'ops-state');

function parseArgs() {
  const args = process.argv.slice(2);
  let days = 14;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) days = parseInt(args[i + 1], 10);
  }
  return { days };
}

// Walk every per-day state file and build two indexes:
//   bought:  trackingNumber → { date, orderNumber, source }   from phases.buy.labels
//   posed:   trackingNumber → { poNumber, soNumber, date }    from phases.pos.byTracking
function loadStateIndexes() {
  const bought = new Map();
  const posed = new Map();
  if (!fs.existsSync(STATE_DIR)) return { bought, posed };
  for (const f of fs.readdirSync(STATE_DIR).filter(n => n.endsWith('.json'))) {
    const date = f.replace(/\.json$/, '');
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); }
    catch { continue; }
    const labels = s?.phases?.buy?.labels || {};
    for (const lab of Object.values(labels)) {
      const tracks = [lab.trackingNumber, ...((lab.packages || []).map(p => p.trackingNumber))].filter(Boolean);
      for (const t of tracks) {
        bought.set(t, { date, orderNumber: lab.orderNumber, source: lab.source, labelCost: lab.labelCost });
      }
    }
    const byTracking = s?.phases?.pos?.byTracking || {};
    for (const [t, p] of Object.entries(byTracking)) {
      posed.set(t, { date, poNumber: p.poNumber, soNumber: p.soNumber });
    }
  }
  return { bought, posed };
}

function isLikelyAmazonMfn(orderNumber) {
  return /^\d{3}-\d{7}-\d{7}$/.test(String(orderNumber || ''));
}

async function main() {
  const { days } = parseArgs();
  console.log(`Auditing last ${days} days for orphan labels...\n`);

  const shipments = await fetchShippedShipments({ days });
  const { bought, posed } = loadStateIndexes();

  const orphans = [];
  for (const s of shipments) {
    if (s.voided) continue;
    if ((s.orderNumber || '').startsWith('SEAuto-')) continue;
    const t = s.trackingNumber;
    if (!t) continue;

    const inBought = bought.get(t);
    const inPosed = posed.get(t);

    // Two distinct orphan flavors:
    //   missing-from-state: paid label exists in ShipStation but no buy entry
    //     on any day's state. Most likely a dashboard/agent buy that lost the
    //     race or predated the pipeline-state era.
    //   missing-pos-only: buy entry exists but no PO got created. SF outage,
    //     or pos phase never ran for this tracking.
    if (!inBought) {
      orphans.push({
        kind: 'missing-from-state',
        orderNumber: s.orderNumber,
        tracking: t,
        carrier: s.carrierCode,
        cost: Number(s.shipmentCost || 0).toFixed(2),
        shipDate: (s.shipDate || '').slice(0, 10),
        warehouseId: s.advancedOptions?.warehouseId || s.warehouseId,
        items: (s.shipmentItems || []).map(it => `${it.sku} ×${it.quantity}`).join(', '),
        looksLikeAmazonMfn: isLikelyAmazonMfn(s.orderNumber),
      });
    } else if (!inPosed && isLikelyAmazonMfn(s.orderNumber)) {
      // Shopify orders go through a different pos path; skip them here unless
      // we also want to audit Shopify SO creation (separate concern).
      orphans.push({
        kind: 'missing-pos-only',
        orderNumber: s.orderNumber,
        tracking: t,
        carrier: s.carrierCode,
        cost: Number(s.shipmentCost || 0).toFixed(2),
        shipDate: (s.shipDate || '').slice(0, 10),
        warehouseId: s.advancedOptions?.warehouseId || s.warehouseId,
        items: (s.shipmentItems || []).map(it => `${it.sku} ×${it.quantity}`).join(', '),
        boughtOn: inBought.date,
      });
    }
  }

  console.log(`Scanned ${shipments.length} shipments.`);
  console.log(`Found ${orphans.length} suspect orphans.\n`);

  if (!orphans.length) {
    console.log('Clean — every Amazon-MFN shipment in the window has a state.phases.buy.labels entry and a state.phases.pos.byTracking entry.');
    return;
  }

  // Markdown summary
  const byKind = orphans.reduce((acc, o) => { (acc[o.kind] = acc[o.kind] || []).push(o); return acc; }, {});
  for (const kind of Object.keys(byKind)) {
    const rows = byKind[kind];
    console.log(`## ${kind} (${rows.length})`);
    console.log();
    console.log('| ship date | order # | tracking | carrier | cost | warehouse | items |');
    console.log('|---|---|---|---|---:|---|---|');
    for (const r of rows) {
      console.log(`| ${r.shipDate} | ${r.orderNumber || '?'} | \`${r.tracking}\` | ${r.carrier} | $${r.cost} | ${r.warehouseId} | ${r.items.slice(0, 80)} |`);
    }
    console.log();
  }

  console.log('Next step: per-order, decide whether to backfill the PO/email or write off.');
  console.log('Backfilling without checking with the vendor risks double-billing. Call Kaitlyn (Prosol) before any backfill on Schluter/Aqua Mix items.');
}

main().catch((e) => {
  console.error('audit failed:', e.message);
  process.exit(1);
});
