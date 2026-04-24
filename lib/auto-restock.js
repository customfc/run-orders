/**
 * Auto-restock — morning-pull triggered, Telegram-gated approval.
 *
 * After the 6 AM FBA morning pull, this runs over the latest snapshot and
 * builds a proposed restock draft (separate from the user's manual
 * current.json so there's no stomping). It posts a per-vendor Telegram
 * message with Approve / Reject URLs. The user clicks approve → system
 * sends the PO (emails vendor + creates SF PO) AND walks the inbound
 * orchestrator end-to-end (labels saved + emailed).
 *
 * Config: data/auto-restock-config.json
 *   {
 *     "enabled": false,
 *     "enabled_vendors": ["prosol", "treeco"],  // [] or ["*"] = all
 *     "tiers": ["bleeding", "urgent", "low-cover"],
 *     "max_lines_per_vendor": 25,
 *     "label_email_default": "mac@customfc.ca",  // where FNSKU PDFs go
 *     "dry_run": false,
 *     "token_ttl_hours": 24
 *   }
 *
 * State: data/auto-restock-pending.json (array of pending approvals)
 *        data/auto-restock-state.json   (last run, history)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fbaSignals = require('./fba-signals');
const poDrafts = require('./fba-po-drafts');
const audit = require('./audit');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'auto-restock-config.json');
const PENDING_PATH = path.join(DATA_DIR, 'auto-restock-pending.json');
const STATE_PATH = path.join(DATA_DIR, 'auto-restock-state.json');
const DRAFTS_DIR = path.join(DATA_DIR, 'fba', 'po-drafts');

const DEFAULT_CONFIG = {
  enabled: false,
  enabled_vendors: ['*'],
  tiers: ['bleeding', 'urgent', 'low-cover'],
  max_lines_per_vendor: 25,
  label_email_default: 'mac@customfc.ca',
  dry_run: false,
  token_ttl_hours: 24,
};

// ── Config / state helpers ─────────────────────────────────────────────────

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    return { ...DEFAULT_CONFIG, _loadError: e.message };
  }
}

function loadPending() {
  try {
    if (!fs.existsSync(PENDING_PATH)) return [];
    return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  } catch { return []; }
}

function savePending(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(rows, null, 2));
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastRunAt: null, history: [] };
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch { return { lastRunAt: null, history: [] }; }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Draft file helpers ─────────────────────────────────────────────────────

function draftPathFor(draftId) {
  return path.join(DRAFTS_DIR, `${draftId}.json`);
}

function loadAutoDraft(draftId) {
  const p = draftPathFor(draftId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveAutoDraft(draft) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.writeFileSync(draftPathFor(draft.draftId), JSON.stringify(draft, null, 2));
}

// ── Token helpers ───────────────────────────────────────────────────────────

function genToken() { return crypto.randomBytes(16).toString('hex'); }

function findPending(token) {
  const pending = loadPending();
  return pending.find((p) => p.token === token) || null;
}

function updatePending(token, updates) {
  const pending = loadPending();
  const idx = pending.findIndex((p) => p.token === token);
  if (idx === -1) return null;
  pending[idx] = { ...pending[idx], ...updates };
  savePending(pending);
  return pending[idx];
}

function pruneExpired() {
  const now = Date.now();
  const pending = loadPending().filter((p) =>
    p.status !== 'expired' && Date.parse(p.expiresAt) > now || ['approved', 'rejected', 'completed'].includes(p.status)
  );
  savePending(pending);
}

// ── Build proposal from snapshot ───────────────────────────────────────────

function buildProposal({ config, snap }) {
  const draftId = `auto-restock-${new Date().toISOString().slice(0, 10)}-${genToken().slice(0, 6)}`;
  const draft = {
    draftId,
    createdAt: new Date().toISOString(),
    source: 'auto-restock',
    status: 'draft',
    lines: [],
  };

  const byVendor = {};
  const enabledVendors = config.enabled_vendors.includes('*')
    ? null
    : new Set(config.enabled_vendors.map((v) => v.toLowerCase()));

  // Rank order: bleeding > urgent > low-cover. Iterate rows in rankForToday
  // order so bleeding SKUs get priority within the per-vendor cap.
  const rows = fbaSignals.rankForToday(snap.rows).filter((r) =>
    r.sku && config.tiers.includes(r.tier) && r.recShipQty > 0
  );

  const skipped = { vendor: 0, tier: 0, no_qty: 0, cap: 0, prosol_oos: 0, added: 0 };

  for (const r of rows) {
    try {
      const line = poDrafts.addLine(draft, {
        asin: r.asin,
        sku: r.sku,
        product: r.productName,
        qty: r.recShipQty,
        recQty: r.recShipQty,
        addedFromTier: `auto-${r.tier}`,
        mapCad: r.mapCad,
        ourPrice: r.bb?.ourPrice ?? r.yourPrice,
        buyBoxPrice: r.bb?.buyBoxPrice,
      });
      const v = (line.vendor || 'unknown').toLowerCase();
      if (enabledVendors && !enabledVendors.has(v)) {
        // Roll back: remove the line we just added
        draft.lines = draft.lines.filter((l) => l.lineId !== line.lineId);
        skipped.vendor++;
        continue;
      }
      byVendor[v] = byVendor[v] || { lines: [], totalUnits: 0 };
      if (byVendor[v].lines.length >= config.max_lines_per_vendor) {
        draft.lines = draft.lines.filter((l) => l.lineId !== line.lineId);
        skipped.cap++;
        continue;
      }
      byVendor[v].lines.push(line);
      byVendor[v].totalUnits += line.qty;
      skipped.added++;
    } catch (e) {
      if (e.code === 'PROSOL_OOS') { skipped.prosol_oos++; continue; }
      // other errors: skip silently (could be unknown vendor, mapping issue)
    }
  }

  return { draft, byVendor, skipped };
}

// ── Main orchestrator ──────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.source
 * @param {object} [opts.config]  — overrides
 */
async function run({ source = 'manual', config: configOverride = {} } = {}) {
  const config = { ...loadConfig(), ...configOverride };
  const startedAt = new Date().toISOString();

  if (!config.enabled) {
    return { ran: false, reason: 'auto-restock disabled in config', source };
  }

  const snap = fbaSignals.loadLatestSnapshot();
  if (!snap) return { ran: false, reason: 'no FBA snapshot', source };

  // Freshness guard — don't restock off stale data
  const snapAgeHours = snap.pulledAt
    ? (Date.now() - Date.parse(snap.pulledAt)) / 3600_000
    : Infinity;
  if (snapAgeHours > 24) {
    return { ran: false, reason: `snapshot stale (${snapAgeHours.toFixed(1)}h old)`, source };
  }

  const { draft, byVendor, skipped } = buildProposal({ config, snap });
  const vendorKeys = Object.keys(byVendor);

  if (!vendorKeys.length) {
    const state = loadState();
    state.lastRunAt = startedAt;
    state.history = [{ at: startedAt, source, vendors: 0, lines: 0, reason: 'no eligible SKUs' }, ...(state.history || []).slice(0, 49)];
    saveState(state);
    return { ran: true, source, proposals: [], skipped, reason: 'no eligible SKUs after filters' };
  }

  // Save the draft + create pending tokens per vendor
  saveAutoDraft(draft);
  const expiresAt = new Date(Date.now() + config.token_ttl_hours * 3600_000).toISOString();

  const proposals = vendorKeys.map((vendor) => {
    const token = genToken();
    const group = byVendor[vendor];
    return {
      token,
      vendor,
      draftId: draft.draftId,
      lineIds: group.lines.map((l) => l.lineId),
      totalLines: group.lines.length,
      totalUnits: group.totalUnits,
      createdAt: startedAt,
      expiresAt,
      status: 'pending',
      source,
      dry_run: !!config.dry_run,
      label_email: config.label_email_default,
    };
  });

  const existing = loadPending().filter((p) => Date.parse(p.expiresAt) > Date.now() && p.status === 'pending');
  savePending([...existing, ...proposals]);

  const state = loadState();
  state.lastRunAt = startedAt;
  state.history = [
    { at: startedAt, source, vendors: vendorKeys.length, lines: draft.lines.length, draftId: draft.draftId, dry_run: !!config.dry_run },
    ...(state.history || []).slice(0, 49),
  ];
  saveState(state);

  audit.log({ action: 'auto-restock-proposed', source, draftId: draft.draftId, vendorCount: vendorKeys.length, lineCount: draft.lines.length });

  return { ran: true, source, draft, proposals, byVendor, skipped, config };
}

// ── Approve / reject ───────────────────────────────────────────────────────

async function approve({ token, baseUrl, labelEmail, skipInbound }) {
  const p = findPending(token);
  if (!p) throw new Error('Token not found');
  if (p.status !== 'pending') throw new Error(`Token already ${p.status}`);
  if (Date.parse(p.expiresAt) < Date.now()) {
    updatePending(token, { status: 'expired' });
    throw new Error('Token expired');
  }

  const draft = loadAutoDraft(p.draftId);
  if (!draft) throw new Error(`Auto-restock draft ${p.draftId} missing on disk`);

  // Guard: must have unsent lines for this vendor
  const vendorLines = draft.lines.filter((l) => l.vendor === p.vendor && !l.sentAt);
  if (!vendorLines.length) {
    updatePending(token, { status: 'rejected', reason: 'no unsent lines' });
    throw new Error(`No unsent lines for vendor ${p.vendor} in draft ${p.draftId}`);
  }

  if (p.dry_run) {
    updatePending(token, { status: 'approved-dry-run', approvedAt: new Date().toISOString() });
    return { ok: true, vendor: p.vendor, dryRun: true, vendorLines };
  }

  // Step 1: send the PO (creates SF PO + emails vendor + marks lines sentAt)
  const poSender = require('./fba-po-sender');
  const sendResult = await poSender.sendVendorGroup({ draft, vendor: p.vendor });
  saveAutoDraft(draft);
  audit.log({
    action: 'auto-restock-po-sent',
    token, vendor: p.vendor, draftId: p.draftId,
    to: sendResult.to, lineCount: sendResult.lineCount, totalUnits: sendResult.totalUnits,
    poNumber: sendResult.sfPo?.poNumber,
  });

  let inboundResult = null;
  if (!skipInbound) {
    // Step 2: walk inbound orchestrator
    const orchestrator = require('./fba-inbound-orchestrator');
    try {
      inboundResult = await orchestrator.runAll({
        draftId: p.draftId,
        vendor: p.vendor,
        emailTo: labelEmail || p.label_email,
        onProgress: () => {}, // no stream for this call; logs captured in audit
      });
      audit.log({
        action: 'auto-restock-inbound-done', token, vendor: p.vendor, draftId: p.draftId,
        ok: inboundResult.ok, failedAt: inboundResult.failedAt,
        shipmentConfirmationIds: inboundResult.shipmentConfirmationIds,
      });
    } catch (e) {
      inboundResult = { ok: false, error: e.message };
      audit.log({ action: 'auto-restock-inbound-failed', token, vendor: p.vendor, error: e.message });
    }
  }

  updatePending(token, {
    status: inboundResult && inboundResult.ok ? 'completed' : 'po-sent',
    approvedAt: new Date().toISOString(),
    poResult: { to: sendResult.to, lineCount: sendResult.lineCount, totalUnits: sendResult.totalUnits, poNumber: sendResult.sfPo?.poNumber },
    inboundResult: inboundResult ? {
      ok: inboundResult.ok,
      failedAt: inboundResult.failedAt,
      error: inboundResult.error,
      planKey: inboundResult.planKey,
      shipmentConfirmationIds: inboundResult.shipmentConfirmationIds,
    } : null,
  });

  return { ok: true, vendor: p.vendor, sendResult, inboundResult };
}

function reject({ token, reason }) {
  const p = findPending(token);
  if (!p) throw new Error('Token not found');
  if (p.status !== 'pending') throw new Error(`Token already ${p.status}`);
  updatePending(token, { status: 'rejected', rejectedAt: new Date().toISOString(), reason: reason || 'user rejected' });
  audit.log({ action: 'auto-restock-rejected', token, vendor: p.vendor, draftId: p.draftId, reason });
  return { ok: true, vendor: p.vendor };
}

// ── Telegram message composer ──────────────────────────────────────────────

function formatTelegramSummary(summary, { baseUrl }) {
  if (!summary.ran) return null;
  if (!summary.proposals || !summary.proposals.length) return null;
  const lines = ['🛒 Auto-restock proposed (click to approve):', ''];
  for (const p of summary.proposals) {
    const group = summary.byVendor[p.vendor];
    const sample = group.lines.slice(0, 3).map((l) => `     • ${l.product?.slice(0, 45)} × ${l.qty}`).join('\n');
    const more = group.lines.length > 3 ? `\n     + ${group.lines.length - 3} more` : '';
    lines.push(`${p.vendor.toUpperCase()} — ${p.totalLines} SKUs / ${p.totalUnits} units`);
    lines.push(sample + more);
    lines.push(`  Approve: ${baseUrl}/api/fba/auto-restock/approve/${p.token}`);
    lines.push(`  Reject:  ${baseUrl}/api/fba/auto-restock/reject/${p.token}`);
    lines.push('');
  }
  lines.push(`Expires ${summary.proposals[0].expiresAt}`);
  if (summary.config?.dry_run) lines.push('⚠️ DRY-RUN — approve will record but not send PO or create inbound');
  return {
    severity: 'attn',
    title: `🛒 Auto-restock — ${summary.proposals.length} vendor${summary.proposals.length > 1 ? 's' : ''}`,
    body: lines.join('\n'),
  };
}

module.exports = {
  run, approve, reject,
  buildProposal,
  loadConfig, loadState, loadPending, pruneExpired,
  formatTelegramSummary,
  DEFAULT_CONFIG,
};
