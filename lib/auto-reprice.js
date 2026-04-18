/**
 * Auto-reprice — runs after the 6 AM FBA morning pull.
 *
 * Takes the latest snapshot's bb-losing tier, filters to safely-matchable
 * rows (same rules as /api/fba/reprice/bulk), applies cooldown + circuit
 * breaker + brand opt-in, calls updateListingPrice per candidate, posts a
 * Telegram summary.
 *
 * Config: data/auto-reprice-config.json
 *   {
 *     "enabled": true,
 *     "enabled_brands": ["schluter", "aquamix"],  // [] or ["*"] = all
 *     "disabled_brands": [],
 *     "min_price_delta": 0.01,                    // ignore if adjustment < this
 *     "circuit_breaker_max_skus": 15,             // abort if more than this would reprice
 *     "cooldown_minutes": 60,                     // skip if repriced within this window
 *     "dry_run": false
 *   }
 *
 * State: data/auto-reprice-state.json
 *   { lastRepricedBySku: { sku: iso }, lastRunAt: iso, history: [...] }
 *
 * Safety guards shared with the per-row /reprice endpoint:
 *   - refuses override-allowed, violation-by-us, missing-map actions
 *   - never goes below mapDecision.recommendedPrice
 *   - rejects >50% fat-finger jumps
 */

const fs = require('fs');
const path = require('path');
const fbaSignals = require('./fba-signals');
const audit = require('./audit');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'auto-reprice-config.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'auto-reprice-state.json');

const DEFAULT_CONFIG = {
  enabled: false,           // default OFF — user opts in
  enabled_brands: ['*'],    // '*' means all brands
  disabled_brands: [],
  min_price_delta: 0.01,
  circuit_breaker_max_skus: 15,
  cooldown_minutes: 60,
  dry_run: false,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    return { ...DEFAULT_CONFIG, _loadError: e.message };
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastRepricedBySku: {}, lastRunAt: null, history: [] };
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastRepricedBySku: {}, lastRunAt: null, history: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function inCooldown(state, sku, cooldownMinutes) {
  const last = state.lastRepricedBySku[sku];
  if (!last) return false;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return false;
  return (Date.now() - lastMs) < cooldownMinutes * 60 * 1000;
}

function brandAllowed(brand, config) {
  if (!config.enabled) return false;
  const b = (brand || '').toLowerCase();
  if (config.disabled_brands?.map((x) => String(x).toLowerCase()).includes(b)) return false;
  const enabled = config.enabled_brands || [];
  if (enabled.includes('*')) return true;
  return enabled.map((x) => String(x).toLowerCase()).includes(b);
}

// Pick safe candidates from the snapshot — same logic as /reprice/bulk.
function pickCandidates(snap, config, state) {
  const out = [];
  const skipped = { cooldown: 0, brand: 0, tier: 0, action: 0, no_delta: 0, no_sku: 0 };
  for (const r of snap.rows) {
    if (!r.sku) { skipped.no_sku++; continue; }
    if (r.tier !== 'bb-losing') { skipped.tier++; continue; }
    const d = r.mapDecision;
    if (!d || !['match', 'hold-at-map', 'hold-at-floor'].includes(d.action)) { skipped.action++; continue; }
    if (d.recommendedPrice == null) { skipped.action++; continue; }
    const current = r.bb?.ourPrice;
    if (current == null) { skipped.action++; continue; }
    if (Math.abs(current - d.recommendedPrice) < config.min_price_delta) { skipped.no_delta++; continue; }
    if (!brandAllowed(r.brand, config)) { skipped.brand++; continue; }
    if (inCooldown(state, r.sku, config.cooldown_minutes)) { skipped.cooldown++; continue; }
    out.push({
      sku: r.sku,
      asin: r.asin,
      brand: r.brand,
      fromPrice: current,
      toPrice: d.recommendedPrice,
      bbPrice: r.bb?.buyBoxPrice,
      action: d.action,
    });
  }
  return { candidates: out, skipped };
}

/**
 * @returns {object} summary — { ran, config, candidates, results, skipped, aborted, reason }
 */
async function run({ source = 'manual', config: configOverride } = {}) {
  const config = configOverride ? { ...loadConfig(), ...configOverride } : loadConfig();
  const state = loadState();
  const startedAt = new Date().toISOString();

  if (!config.enabled) {
    return { ran: false, reason: 'auto-reprice disabled in config', config, source };
  }

  const snap = fbaSignals.loadLatestSnapshot();
  if (!snap) {
    return { ran: false, reason: 'no FBA snapshot available', source };
  }

  // Snapshot freshness guard — don't act on stale data
  const snapAgeHours = snap.buyboxPulledAt
    ? (Date.now() - Date.parse(snap.buyboxPulledAt)) / 3600_000
    : Infinity;
  if (snapAgeHours > 6) {
    return { ran: false, reason: `BB snapshot stale (${snapAgeHours.toFixed(1)}h old)`, source };
  }

  const { candidates, skipped } = pickCandidates(snap, config, state);

  if (!candidates.length) {
    state.lastRunAt = startedAt;
    saveState(state);
    return { ran: true, candidates: [], results: [], skipped, aborted: false, reason: 'no candidates', source, config };
  }

  if (candidates.length > config.circuit_breaker_max_skus) {
    audit.log({
      action: 'auto-reprice', source, success: false,
      reason: 'circuit-breaker', candidateCount: candidates.length, max: config.circuit_breaker_max_skus,
    });
    return {
      ran: false,
      aborted: true,
      reason: `circuit breaker tripped (${candidates.length} > ${config.circuit_breaker_max_skus}) — investigate before enabling`,
      candidates,
      skipped,
      source,
      config,
    };
  }

  const sp = require('./sp-api');
  const results = [];
  for (const c of candidates) {
    if (config.dry_run) {
      results.push({ ...c, ok: true, dryRun: true });
      continue;
    }
    try {
      const r = await sp.updateListingPrice(c.sku, c.toPrice);
      const result = { ...c, ok: true, submissionId: r.submissionId };
      results.push(result);
      state.lastRepricedBySku[c.sku] = new Date().toISOString();
      audit.log({
        action: 'auto-reprice', source,
        sku: c.sku, asin: c.asin, brand: c.brand,
        fromPrice: c.fromPrice, toPrice: c.toPrice, bbPrice: c.bbPrice,
        decisionAction: c.action,
        submissionId: r.submissionId,
      });
    } catch (e) {
      const result = { ...c, ok: false, error: e.message };
      results.push(result);
      audit.log({
        action: 'auto-reprice', source, success: false,
        sku: c.sku, asin: c.asin, error: e.message,
      });
    }
  }

  state.lastRunAt = startedAt;
  state.history = [
    { at: startedAt, source, candidates: candidates.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, dryRun: config.dry_run },
    ...(state.history || []).slice(0, 49),
  ];
  saveState(state);

  return { ran: true, candidates, results, skipped, aborted: false, source, config };
}

function formatTelegramSummary(summary) {
  const { ran, aborted, reason, candidates = [], results = [], skipped = {}, config } = summary;
  if (!ran && reason) return null; // silent when disabled / stale / no snapshot
  if (aborted) {
    return {
      severity: 'attn',
      title: `🚨 Auto-reprice circuit breaker tripped`,
      body: [
        reason,
        '',
        'Candidate SKUs:',
        ...candidates.slice(0, 10).map((c) => `  ${c.sku} (${c.brand || '?'}): $${c.fromPrice?.toFixed(2)} → $${c.toPrice.toFixed(2)}`),
        candidates.length > 10 ? `  … ${candidates.length - 10} more` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  if (!candidates.length) return null; // silent when nothing to do
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const sev = failed.length ? 'attn' : 'ok';
  const title = config?.dry_run
    ? `🧪 Auto-reprice dry-run — ${candidates.length} candidate${candidates.length > 1 ? 's' : ''}`
    : `🎯 Auto-reprice — ${ok.length}/${candidates.length} applied`;
  const body = [
    ...results.map((r) => {
      const tag = r.dryRun ? '[dry]' : r.ok ? '✓' : '✗';
      const delta = (r.toPrice - (r.fromPrice || 0)).toFixed(2);
      return `${tag} ${r.sku} (${r.brand || '?'}): $${(r.fromPrice || 0).toFixed(2)} → $${r.toPrice.toFixed(2)} (${delta})${r.error ? ' — ' + r.error.slice(0, 100) : ''}`;
    }),
  ].join('\n');
  return { severity: sev, title, body };
}

module.exports = { run, loadConfig, loadState, saveState, formatTelegramSummary, DEFAULT_CONFIG };
