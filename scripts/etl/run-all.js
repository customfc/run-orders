#!/usr/bin/env node
/**
 * Analytics ETL orchestrator — runs all sync scripts in sequence.
 *
 * Invoked by the 3 AM Toronto cron in server.js. Each step is isolated —
 * a failure in one doesn't prevent the others from running. At the end,
 * posts a Telegram summary:
 *   - severity 'ok' if all steps succeeded
 *   - 'attn' if any step failed (so ops gets paged)
 *
 * Order matters only loosely:
 *   1. amazon-orders  — populates order headers
 *   2. amazon-finances — populates fee ledger (independent)
 *   3. shopify        — Shopify orders (independent)
 *   4. item-costs     — SF cost refresh (independent, quick)
 *   5. snapshots      — FBA JSON → DB (reads latest morning-pull output)
 *
 * Usage:
 *   node scripts/etl/run-all.js                    # all steps
 *   node scripts/etl/run-all.js --only <step>      # one step, e.g. --only shopify
 *   node scripts/etl/run-all.js --backfill         # pass --backfill to steps that accept it
 */

require('dotenv').config();
const telegram = require('../../lib/telegram');

const STEPS = [
  { name: 'amazon-orders',         mod: './sync-amazon-orders',         supportsBackfill: true },
  { name: 'amazon-finances',       mod: './sync-amazon-finances',       supportsBackfill: true },
  { name: 'amazon-finances-deep',  mod: './sync-amazon-finances-deep',  supportsBackfill: false }, // daily top-up only; use manual --backfill for cold start
  { name: 'shopify',               mod: './sync-shopify',               supportsBackfill: true },
  { name: 'item-costs',            mod: './sync-item-costs',            supportsBackfill: false },
  { name: 'sku-map-canonical',     mod: './sync-sku-map',               supportsBackfill: false },
  { name: 'shipping-labels',       mod: './sync-shipping-labels',       supportsBackfill: false },
  { name: 'snapshots',             mod: './sync-snapshots',             supportsBackfill: false },
];

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

async function runStep(step, args) {
  const startedAt = Date.now();
  const prevArgv = process.argv;
  // Fake argv for the step — pass --backfill if requested and supported
  const fakeArgv = [process.argv[0], process.argv[1]];
  if (args.backfill && step.supportsBackfill) fakeArgv.push('--backfill');
  process.argv = fakeArgv;

  let result;
  try {
    // Fresh require so each step's module-level state is independent
    const resolved = require.resolve(step.mod, { paths: [__dirname] });
    delete require.cache[resolved];
    const mod = require(step.mod);
    await mod.main();
    result = { ok: true, durationMs: Date.now() - startedAt };
  } catch (e) {
    result = { ok: false, durationMs: Date.now() - startedAt, error: e.message };
  } finally {
    process.argv = prevArgv;
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const only = args.only ? String(args.only).split(',') : null;

  const startedAt = new Date().toISOString();
  console.log(`\n═══ ETL run-all started ${startedAt} ═══`);

  const results = [];
  for (const step of STEPS) {
    if (only && !only.includes(step.name)) continue;
    console.log(`\n── [${step.name}] ──`);
    const r = await runStep(step, args);
    results.push({ step: step.name, ...r });
    const durSec = (r.durationMs / 1000).toFixed(1);
    if (r.ok) console.log(`  ✓ ${step.name} (${durSec}s)`);
    else console.log(`  ✗ ${step.name} (${durSec}s) — ${r.error}`);
  }

  const failed = results.filter((r) => !r.ok);
  const total = (results.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1);
  console.log(`\n═══ ETL run-all done in ${total}s — ${results.length - failed.length}/${results.length} ok ═══`);

  // Telegram summary
  const severity = failed.length ? 'attn' : 'ok';
  const subject = failed.length
    ? `Analytics ETL — ${failed.length}/${results.length} step(s) failed`
    : `Analytics ETL — all ${results.length} step(s) ok (${total}s)`;
  const body = results.map((r) => {
    const dur = (r.durationMs / 1000).toFixed(1);
    const tag = r.ok ? '✓' : '✗';
    return `${tag} ${r.step} (${dur}s)${r.error ? ` — ${r.error.slice(0, 150)}` : ''}`;
  }).join('\n');
  try { await telegram.notify(severity, subject, body); } catch {}

  process.exitCode = failed.length ? 1 : 0;
}

if (require.main === module) {
  main().catch((e) => { console.error('[run-all] ERROR:', e.message); process.exit(1); });
}

module.exports = { main };
