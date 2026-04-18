/**
 * FBA Inbound orchestrator — walks steps 1-5 for a sent PO draft.
 *
 * Calls the existing CLI scripts programmatically by swapping process.argv
 * (same pattern as scripts/etl/run-all.js). Each step saves state to
 * data/fba/inbound-plans/<planKey>.json so between-step we can read
 * progress from disk.
 *
 * Steps walked:
 *   1. create-inbound            — creates + validates plan
 *   2. inbound-step2-packing     — picks cheapest packing option
 *   3. inbound-step3-placement   — picks cheapest placement option
 *   4. inbound-step4-transport   — generate transport + delivery window + confirm
 *   5. inbound-step5-labels      — create FNSKU labels + download + email vendor
 *
 * The flow is irreversible on Amazon's side once step 3 (placement) runs,
 * so we gate on a configurable pre-check: caller passes `confirm: true` to
 * actually run, else returns the plan that WOULD be created.
 */

const fs = require('fs');
const path = require('path');
const plans = require('./fba-inbound-plans');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts', 'fba');

async function runScript(scriptName, argv, onLog) {
  const modPath = path.join(SCRIPTS_DIR, scriptName);
  const prevArgv = process.argv;
  const prevLog = console.log;
  const prevErr = console.error;
  process.argv = [prevArgv[0], prevArgv[1], ...argv];
  const logs = [];
  console.log = (...a) => { const line = a.join(' '); logs.push(line); if (onLog) onLog(line); prevLog(...a); };
  console.error = (...a) => { const line = 'ERR: ' + a.join(' '); logs.push(line); if (onLog) onLog(line); prevErr(...a); };
  try {
    delete require.cache[require.resolve(modPath)];
    const mod = require(modPath);
    await mod.main();
    return { ok: true, logs };
  } catch (e) {
    return { ok: false, error: e.message, logs };
  } finally {
    process.argv = prevArgv;
    console.log = prevLog;
    console.error = prevErr;
  }
}

function planKeyFor(draftId, vendor) {
  return `${draftId}-${vendor}-inbound`;
}

/**
 * Orchestrate steps 1-5. onProgress(event, data) fires between steps so a
 * caller (HTTP endpoint) can stream progress to the client.
 *
 * @param {object} opts
 * @param {string} opts.draftId      — PO draft id (matches data/fba/po-drafts/sent/<id>.json)
 * @param {string} opts.vendor       — 'prosol' | 'treeco' | 'perfectlevel'
 * @param {string} [opts.source]     — source-address key, default per-vendor
 * @param {string} [opts.emailTo]    — vendor email to receive the FNSKU PDF
 * @param {string} [opts.emailCc]    — cc on the vendor email
 * @param {string} [opts.transportMode]  — 'partnered' (default) | 'own'
 * @param {string} [opts.pageType]   — FNSKU label page type; default 'Letter_30'
 * @param {boolean} [opts.skipEmail] — do everything but email
 * @param {boolean} [opts.confirm]   — required true to actually walk (safety)
 * @param {function} [opts.onProgress]
 */
async function runAll(opts) {
  const { draftId, vendor, source, emailTo, emailCc, transportMode, pageType, skipEmail, onProgress } = opts;
  if (!draftId) throw new Error('draftId required');
  if (!vendor) throw new Error('vendor required');
  const progress = onProgress || (() => {});

  const planKey = planKeyFor(draftId, vendor);
  const existing = plans.load(planKey);
  const results = [];

  const emit = (event, data) => {
    progress(event, data);
  };
  const timed = async (label, fn) => {
    const t0 = Date.now();
    emit('step-start', { label });
    const r = await fn();
    const ms = Date.now() - t0;
    emit('step-done', { label, ok: r.ok, ms, error: r.error, logsTail: (r.logs || []).slice(-6) });
    results.push({ label, ms, ...r });
    return r;
  };

  // Step 1 — create-inbound (idempotent only if the plan doesn't exist)
  if (!existing || !existing.inboundPlanId) {
    const args1 = [`--draft=${draftId}`, `--vendor=${vendor}`];
    if (source) args1.push(`--source=${source}`);
    const r1 = await timed('1. create-inbound', () => runScript('create-inbound.js', args1, (l) => emit('log', { step: 1, line: l })));
    if (!r1.ok) return { ok: false, failedAt: 1, planKey, results };
  } else {
    emit('step-skip', { label: '1. create-inbound', reason: 'plan already exists', status: existing.status });
    results.push({ label: '1. create-inbound', ok: true, skipped: true });
  }

  // Ensure plan exists going forward
  let state = plans.load(planKey);
  if (!state?.inboundPlanId) {
    return { ok: false, failedAt: 1, planKey, results, error: 'plan state missing after step 1' };
  }

  // Step 2 — packing
  if (!state.packingOptionId) {
    const r2 = await timed('2. packing', () => runScript('inbound-step2-packing.js', [`--plan=${planKey}`], (l) => emit('log', { step: 2, line: l })));
    if (!r2.ok) return { ok: false, failedAt: 2, planKey, results };
    state = plans.load(planKey);
  } else {
    emit('step-skip', { label: '2. packing', reason: 'already confirmed' });
    results.push({ label: '2. packing', ok: true, skipped: true });
  }

  // Step 3 — placement (IRREVERSIBLE: locks destination FC)
  if (!state.placementOptionId) {
    const r3 = await timed('3. placement', () => runScript('inbound-step3-placement.js', [`--plan=${planKey}`], (l) => emit('log', { step: 3, line: l })));
    if (!r3.ok) return { ok: false, failedAt: 3, planKey, results };
    state = plans.load(planKey);
  } else {
    emit('step-skip', { label: '3. placement', reason: 'already confirmed' });
    results.push({ label: '3. placement', ok: true, skipped: true });
  }

  // Step 4 — transport + delivery window
  if (state.status !== 'transportation-confirmed' && state.status !== 'labels-ready') {
    const args4 = [`--plan=${planKey}`];
    if (transportMode === 'own') args4.push('--mode=own');
    const r4 = await timed('4. transport', () => runScript('inbound-step4-transport.js', args4, (l) => emit('log', { step: 4, line: l })));
    if (!r4.ok) return { ok: false, failedAt: 4, planKey, results };
    state = plans.load(planKey);
  } else {
    emit('step-skip', { label: '4. transport', reason: 'already confirmed' });
    results.push({ label: '4. transport', ok: true, skipped: true });
  }

  // Step 5 — labels + download + email vendor
  const args5 = [`--plan=${planKey}`, '--download'];
  if (pageType) args5.push(`--pageType=${pageType}`);
  if (emailTo && !skipEmail) args5.push(`--email=${emailTo}`);
  if (emailCc && !skipEmail) args5.push(`--email-cc=${emailCc}`);
  const r5 = await timed('5. labels', () => runScript('inbound-step5-labels.js', args5, (l) => emit('log', { step: 5, line: l })));
  if (!r5.ok) return { ok: false, failedAt: 5, planKey, results };
  state = plans.load(planKey);

  emit('complete', {
    planKey,
    inboundPlanId: state.inboundPlanId,
    shipmentConfirmationIds: (state.shipmentDetails || []).map((s) => s.shipmentConfirmationId).filter(Boolean),
    amazonReferenceIds: (state.shipmentDetails || []).map((s) => s.amazonReferenceId).filter(Boolean),
    itemLabelsPdfPath: state.labels?.itemLabelsPdfPath || null,
    emailedTo: state.labels?.emailedTo || null,
  });

  return {
    ok: true,
    planKey,
    state,
    results,
    inboundPlanId: state.inboundPlanId,
    shipmentConfirmationIds: (state.shipmentDetails || []).map((s) => s.shipmentConfirmationId).filter(Boolean),
    amazonReferenceIds: (state.shipmentDetails || []).map((s) => s.amazonReferenceId).filter(Boolean),
    itemLabelsPdfPath: state.labels?.itemLabelsPdfPath || null,
    emailedTo: state.labels?.emailedTo || null,
  };
}

module.exports = { runAll, planKeyFor };
