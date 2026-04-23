/**
 * Budget guardrails for FBA replenishment sends.
 *
 * Added 2026-04-23 per the cashflow-conscious walkthrough — business is
 * ~$100K/mo revenue, reseller margins, growth + cashflow balance. The system
 * must not let an enthusiastic day of restock blow a month's cash.
 *
 * Tier 1 hard caps (block send without explicit override):
 *   - dailyCap      — total PO cost across all vendors per calendar day
 *   - weeklyCap     — rolling 7 days
 *   - openPoCap     — rough proxy for open-PO exposure (archived drafts in
 *                     last 30 days; SF-queried open exposure arrives in a
 *                     later commit once we wire that query)
 *   - perPoCap      — single-PO ceiling
 *
 * Exposure is computed from archived draft JSON under data/fba/po-drafts/sent/
 * Each archive preserves line.extCost; summing per archive in the date window
 * gives day / week totals. This is authoritative for our sends. Manual SF POs
 * outside our pipeline are not counted here — that's acceptable for a first
 * guard; dashboard surfaces the estimate so ops can mentally adjust.
 */

const fs = require('fs');
const path = require('path');

const SENT_DIR = path.join(__dirname, '..', 'data', 'fba', 'po-drafts', 'sent');
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'budget-config.json');

// Defaults sized for ~$100K/mo revenue target ($20K+ COGS/mo). Intentionally
// loose so the first live day doesn't block legitimate big restock bursts;
// user dials in via /budget or data/budget-config.json as real cadence emerges.
const DEFAULTS = {
  dailyCap: Number(process.env.FBA_DAILY_CAP || 15000),
  weeklyCap: Number(process.env.FBA_WEEKLY_CAP || 50000),
  openPoCap: Number(process.env.FBA_OPEN_PO_CAP || 75000),
  perPoCap: Number(process.env.FBA_PER_PO_CAP || 20000),
};

function loadConfig() {
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...fileCfg };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(patch) {
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function listArchives() {
  if (!fs.existsSync(SENT_DIR)) return [];
  return fs.readdirSync(SENT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(SENT_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// Draft cost = sum of line.extCost. Lines without extCost (unknown unit cost)
// are counted as $0 — this undercounts, but the alternative (fabricating a
// cost) violates the analytics-truth feedback memory. Bucket optional.
function draftCost(draft, { bucket } = {}) {
  return (draft.lines || [])
    .filter((l) => !bucket || l.availabilityBucket === bucket)
    .reduce((s, l) => s + (Number(l.extCost) || 0), 0);
}

function costInWindow({ fromMs, toMs }) {
  const archives = listArchives();
  let total = 0;
  for (const d of archives) {
    const t = Date.parse(d.archivedAt || d.updatedAt || d.createdAt || '');
    if (Number.isFinite(t) && t >= fromMs && t <= toMs) {
      total += draftCost(d);
    }
  }
  return Number(total.toFixed(2));
}

function computeExposure() {
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 24 * 3600_000;
  const thirtyAgo = now - 30 * 24 * 3600_000;
  return {
    today: costInWindow({ fromMs: dayStart.getTime(), toMs: now }),
    week: costInWindow({ fromMs: weekAgo, toMs: now }),
    openPoEstimate: costInWindow({ fromMs: thirtyAgo, toMs: now }),
  };
}

/**
 * Evaluate guards for a proposed send. Returns { blocks, warnings,
 * exposure, caps, pendingCost }.
 *
 *  - blocks  = array of human-readable Tier 1 violations. Non-empty → send
 *              MUST be rejected unless caller supplies `force: true`.
 *  - warnings = (reserved for Tier 2 in a later commit).
 *
 * Caller integrates like:
 *   const g = evaluateGuards({ draft, bucket, vendor });
 *   if (g.blocks.length && !req.body.force) return res.status(403).json({
 *     success: false, error: 'budget-block', guards: g });
 */
function evaluateGuards({ draft, bucket, vendor }) {
  const cfg = loadConfig();
  const exposure = computeExposure();

  const pendingLines = (draft.lines || []).filter((l) =>
    (!vendor || l.vendor === vendor) &&
    (!bucket || l.availabilityBucket === bucket) &&
    !l.sentAt);
  const pendingCost = Number(pendingLines.reduce((s, l) => s + (Number(l.extCost) || 0), 0).toFixed(2));

  const blocks = [];
  const warnings = [];

  if (pendingCost > cfg.perPoCap) {
    blocks.push(`Per-PO cap: this PO $${pendingCost.toFixed(2)} exceeds cap $${cfg.perPoCap.toFixed(2)} by $${(pendingCost - cfg.perPoCap).toFixed(2)}`);
  }
  if (exposure.today + pendingCost > cfg.dailyCap) {
    blocks.push(`Daily cap: today $${exposure.today.toFixed(2)} + pending $${pendingCost.toFixed(2)} = $${(exposure.today + pendingCost).toFixed(2)} exceeds cap $${cfg.dailyCap.toFixed(2)}`);
  }
  if (exposure.week + pendingCost > cfg.weeklyCap) {
    blocks.push(`Weekly cap: rolling-7d $${exposure.week.toFixed(2)} + pending $${pendingCost.toFixed(2)} = $${(exposure.week + pendingCost).toFixed(2)} exceeds cap $${cfg.weeklyCap.toFixed(2)}`);
  }
  if (exposure.openPoEstimate + pendingCost > cfg.openPoCap) {
    blocks.push(`Open-PO exposure cap: estimate $${exposure.openPoEstimate.toFixed(2)} + pending $${pendingCost.toFixed(2)} = $${(exposure.openPoEstimate + pendingCost).toFixed(2)} exceeds cap $${cfg.openPoCap.toFixed(2)}`);
  }

  // Edge case: pendingCost = 0 means no known unit costs on the lines. Warn
  // rather than block — analytics-truth memory says no fabricated costs.
  if (pendingCost === 0 && pendingLines.length > 0) {
    warnings.push(`${pendingLines.length} line(s) have no unit cost — budget check under-counts. Populate sku-map costs or accept the risk.`);
  }

  return {
    blocks,
    warnings,
    exposure,
    caps: cfg,
    pendingCost,
    capsRemaining: {
      daily: Number((cfg.dailyCap - exposure.today).toFixed(2)),
      weekly: Number((cfg.weeklyCap - exposure.week).toFixed(2)),
      openPo: Number((cfg.openPoCap - exposure.openPoEstimate).toFixed(2)),
    },
  };
}

module.exports = { evaluateGuards, computeExposure, loadConfig, saveConfig, draftCost, DEFAULTS };
