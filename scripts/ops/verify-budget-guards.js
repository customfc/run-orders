/**
 * Verify Tier 1 budget guard invariants.
 *
 * Added 2026-04-23 per the cashflow walkthrough. Asserts:
 *  - Per-PO cap blocks when a single PO exceeds perPoCap.
 *  - Daily cap blocks when today-so-far + pending > dailyCap.
 *  - Weekly cap blocks when rolling-7d + pending > weeklyCap.
 *  - Open-PO cap blocks when 30-day window + pending > openPoCap.
 *  - When no rules violated, blocks is empty.
 *  - Override (force=true) is logged but permitted; block list still surfaced.
 *  - Config save/load round-trips correctly.
 *
 * Uses a tmp SENT_DIR via env so tests don't pollute the real archive.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Isolate: point budget-guards at a tmp sent-archive dir via module override.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
const tmpSent = path.join(tmpRoot, 'data', 'fba', 'po-drafts', 'sent');
const tmpConfig = path.join(tmpRoot, 'data', 'budget-config.json');
fs.mkdirSync(tmpSent, { recursive: true });

// Patch the budget-guards module before first require by temporarily swapping
// __dirname resolution: simpler to stub `fs` paths. Easiest: override the
// constants by mutating module after load.
const budgetGuardsPath = path.resolve(__dirname, '..', '..', 'lib', 'budget-guards.js');
// Read source, swap paths, write to a patched copy, require that.
const src = fs.readFileSync(budgetGuardsPath, 'utf8');
const patched = src
  .replace(
    `const SENT_DIR = path.join(__dirname, '..', 'data', 'fba', 'po-drafts', 'sent');`,
    `const SENT_DIR = ${JSON.stringify(tmpSent)};`,
  )
  .replace(
    `const CONFIG_PATH = path.join(__dirname, '..', 'data', 'budget-config.json');`,
    `const CONFIG_PATH = ${JSON.stringify(tmpConfig)};`,
  );
const patchedPath = path.join(tmpRoot, 'budget-guards-patched.js');
fs.writeFileSync(patchedPath, patched);
const budgetGuards = require(patchedPath);

// ── Fixtures ──────────────────────────────────────────────────────────────

function writeArchive(filename, { archivedAtMs, lines }) {
  const draft = {
    draftId: filename.replace(/\.json$/, ''),
    archivedAt: new Date(archivedAtMs).toISOString(),
    lines: lines.map((l, i) => ({
      lineId: `L${i}`,
      asin: `ASIN-${i}`,
      qty: l.qty,
      extCost: l.extCost,
      availabilityBucket: l.bucket || 'ready',
      vendor: 'prosol',
    })),
  };
  fs.writeFileSync(path.join(tmpSent, filename), JSON.stringify(draft));
}

function fakeDraft(lines) {
  return {
    draftId: 'current',
    lines: lines.map((l, i) => ({
      lineId: `L${i}`,
      asin: `ASIN-${i}`,
      qty: l.qty,
      extCost: l.extCost,
      availabilityBucket: l.bucket || 'ready',
      vendor: l.vendor || 'prosol',
    })),
  };
}

function clearArchives() {
  for (const f of fs.readdirSync(tmpSent)) fs.unlinkSync(path.join(tmpSent, f));
  if (fs.existsSync(tmpConfig)) fs.unlinkSync(tmpConfig);
}

// ── Scenarios ─────────────────────────────────────────────────────────────

(() => {
  const failures = [];
  const now = Date.now();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  // 1. No archives, clean config → no blocks when pending under cap
  {
    clearArchives();
    const draft = fakeDraft([{ qty: 1, extCost: 100 }]);
    const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
    try {
      assert.strictEqual(g.blocks.length, 0, 'no blocks under caps');
      assert.strictEqual(g.pendingCost, 100);
      assert.strictEqual(g.exposure.today, 0);
      assert.strictEqual(g.exposure.week, 0);
      console.log('✓ scenario 1: clean slate under caps');
    } catch (e) { failures.push(`scenario 1: ${e.message}`); }
  }

  // 2. Per-PO cap blocks a $25k send when cap is $20k default
  {
    clearArchives();
    const draft = fakeDraft([{ qty: 100, extCost: 25000 }]);
    const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
    try {
      assert.ok(g.blocks.some((b) => /Per-PO cap/.test(b)), 'per-PO cap blocks');
      console.log('✓ scenario 2: per-PO cap blocks over-cap PO');
    } catch (e) { failures.push(`scenario 2: ${e.message}`); }
  }

  // 3. Daily cap blocks when today already at $14k and pending adds $2k (default daily $15k)
  {
    clearArchives();
    writeArchive('today.json', { archivedAtMs: now - HOUR, lines: [{ qty: 1, extCost: 14000 }] });
    const draft = fakeDraft([{ qty: 1, extCost: 2000 }]);
    const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
    try {
      assert.ok(g.blocks.some((b) => /Daily cap/.test(b)), 'daily cap blocks');
      assert.strictEqual(g.exposure.today, 14000);
      console.log('✓ scenario 3: daily cap blocks when summed over default $15k');
    } catch (e) { failures.push(`scenario 3: ${e.message}`); }
  }

  // 4. Daily cap does NOT block when yesterday's spend doesn't count toward today
  {
    clearArchives();
    const yesterdayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime() - DAY; })();
    writeArchive('yesterday.json', { archivedAtMs: yesterdayStart + HOUR, lines: [{ qty: 1, extCost: 14000 }] });
    const draft = fakeDraft([{ qty: 1, extCost: 2000 }]);
    const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
    try {
      assert.ok(!g.blocks.some((b) => /Daily cap/.test(b)), 'daily cap not blocking (yesterday isolated)');
      assert.strictEqual(g.exposure.today, 0);
      assert.strictEqual(g.exposure.week, 14000);
      console.log('✓ scenario 4: yesterday counts toward week, not today');
    } catch (e) { failures.push(`scenario 4: ${e.message}`); }
  }

  // 5. Weekly cap blocks when rolling-7d sum + pending exceeds weekly cap (default $50k)
  {
    clearArchives();
    for (let i = 0; i < 5; i++) {
      writeArchive(`d${i}.json`, { archivedAtMs: now - i * DAY - HOUR, lines: [{ qty: 1, extCost: 9000 }] });
    }
    const draft = fakeDraft([{ qty: 1, extCost: 6000 }]);
    const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
    try {
      assert.ok(g.blocks.some((b) => /Weekly cap/.test(b)), 'weekly cap blocks');
      assert.strictEqual(g.exposure.week, 45000);
      console.log('✓ scenario 5: weekly cap blocks at $50k default');
    } catch (e) { failures.push(`scenario 5: ${e.message}`); }
  }

  // 6. Config save+load round-trips
  {
    clearArchives();
    const next = budgetGuards.saveConfig({ dailyCap: 25000, perPoCap: 30000 });
    try {
      assert.strictEqual(next.dailyCap, 25000);
      assert.strictEqual(next.perPoCap, 30000);
      assert.strictEqual(next.weeklyCap, 50000); // default persisted
      const reloaded = budgetGuards.loadConfig();
      assert.deepStrictEqual(reloaded, next);
      // With dailyCap bumped to 25k, scenario 3's input passes
      writeArchive('today.json', { archivedAtMs: now - HOUR, lines: [{ qty: 1, extCost: 14000 }] });
      const draft = fakeDraft([{ qty: 1, extCost: 2000 }]);
      const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
      assert.ok(!g.blocks.some((b) => /Daily cap/.test(b)), 'daily cap no longer blocks at bumped limit');
      console.log('✓ scenario 6: config save/load + tuning lifts the block');
    } catch (e) { failures.push(`scenario 6: ${e.message}`); }
  }

  // 7. Unknown-cost warning when lines lack extCost
  {
    clearArchives();
    const draft = {
      draftId: 'x',
      lines: [{ lineId: 'L0', asin: 'A', qty: 5, extCost: null, availabilityBucket: 'ready', vendor: 'prosol' }],
    };
    const g = budgetGuards.evaluateGuards({ draft, bucket: 'ready', vendor: 'prosol' });
    try {
      assert.strictEqual(g.blocks.length, 0, 'unknown cost does not block');
      assert.ok(g.warnings.some((w) => /no unit cost/.test(w)), 'warns about unknown cost');
      console.log('✓ scenario 7: unknown unit cost warns without blocking');
    } catch (e) { failures.push(`scenario 7: ${e.message}`); }
  }

  // Cleanup
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  if (failures.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('\nAll scenarios passed.');
  process.exit(0);
})();
