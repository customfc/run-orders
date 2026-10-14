#!/usr/bin/env node
/**
 * Import the Prosol catalogue into Automayt as items: ONE import of every
 * product that passes the rule (Mac, 2026-10-14). Automayt does not migrate
 * the Salesforce item master, only quantities on hand, and its QOH load matches
 * onto these items by vendor code. Whichever of the two runs second must match
 * by vendor code and never create a duplicate; on our side that is the
 * batch-lookup below plus createItem's 409 handling.
 *
 *   node scripts/automayt/prosol-catalog-import.js                       # dry run: what would be created
 *   node scripts/automayt/prosol-catalog-import.js --apply --limit=200   # beta1/staging rehearsal (needs AUTOMAYT_TEST_CODE_PREFIX)
 *   node scripts/automayt/prosol-catalog-import.js --apply --production  # production: live key + this flag, nothing else
 *   node scripts/automayt/prosol-catalog-import.js --sync [--apply]      # re-check imported items against a newer snapshot
 *
 * Options: --date=YYYY-MM-DD (snapshot, default newest), --min-locations=2,
 *          --include-discontinued, --limit=N, --writes-per-minute=N (default:
 *          the key's write_per_minute from /whoami, minus a margin).
 *
 * Selection: the product has stock at --min-locations or more Prosol locations
 * (Mac, 2026-10-14) and is not discontinued at Prosol, and its cost was pulled
 * (createItem refuses an item without cost). For each one: batch-lookup every
 * code it may already be filed under (Prosol code, maker code, leading-zero
 * form, each also slash-stripped); matched = already in Automayt (auto-created
 * by an order, seeded, or loaded before us), ambiguous = left for a person,
 * not found = created with Idempotency-Key item-<vendorCode>.
 *
 * Progress: data/prosol-catalog/<date>/import-<env>.jsonl, one line per product
 * outcome; a re-run skips products already created/existing and retries the rest.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const am = require('../../lib/automayt');
const erp = require('../../lib/automayt-erp');
const pc = require('../../lib/prosol-catalog');

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const ROOT = path.join(__dirname, '..', '..', 'data', 'prosol-catalog');
const DONE = new Set(['created', 'exists', 'duplicate']);

function envName(base) {
  if (/\/\/app\.automayt\.com\//.test(base + '/')) return 'production';
  const m = base.match(/\/\/([a-z0-9-]+)\.automayt\.dev/);
  return m ? m[1] : 'other';
}

function newestSnapshot() {
  const dirs = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(ROOT, d, 'catalog.json'))).sort() : [];
  if (!dirs.length) throw new Error(`no snapshot with catalog.json under ${ROOT}; run prosol-catalog-pull.js first`);
  return dirs[dirs.length - 1];
}

/** Latest cost line per product id. */
function loadCosts(snapDir) {
  const out = new Map();
  for (const line of pc.readJsonl(path.join(snapDir, 'costs.jsonl'))) {
    if (line.cost != null || !out.has(line.id)) out.set(line.id, line);
  }
  return out;
}

/**
 * Refuse anything that could write to production by accident: production needs
 * --production AND a live key (config() already refuses a key/base mismatch),
 * and test-only settings are refused there by testSettings().
 */
function guard(args) {
  const { base, key } = am.config();
  const env = envName(base);
  erp.testSettings();
  if (env === 'production') {
    if (!args.production) throw new Error('refusing production: pass --production');
    if (!key.startsWith('amk_live_')) throw new Error('refusing production without a live key');
  } else if (args.production) {
    throw new Error(`--production given but AUTOMAYT_API_BASE is ${base}`);
  }
  if (args.apply && env !== 'production' && !process.env.AUTOMAYT_TEST_CODE_PREFIX) {
    throw new Error(`refusing to write the real catalogue into ${env}: set AUTOMAYT_TEST_CODE_PREFIX (e.g. ROTEST-) for a rehearsal`);
  }
  return { base, env };
}

/** Pace writes to the key's per-minute budget; also back off when a response says the window is spent. */
function makePacer(perMinute) {
  const gap = Math.ceil(60_000 / perMinute);
  let next = 0;
  let windowResetAt = null;
  am.setRequestLogger((e) => {
    if (e.method !== 'GET' && e.rateLimit && e.rateLimit.remaining <= 1 && e.rateLimit.resetAt) windowResetAt = e.rateLimit.resetAt;
  });
  return async function pace() {
    const now = Date.now();
    if (windowResetAt && windowResetAt > now) { await sleep(windowResetAt - now + 250); windowResetAt = null; }
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    next = Date.now() + gap;
  };
}

async function lookupChunk(records) {
  // Vendor codes first, then the same codes as item numbers (an item loaded under a legacy
  // number), never a short number: that is CFC's own item numbering (lib/prosol-catalog.js isShortNumeric).
  const entries = records.map((r) => {
    const { vendorCodes, itemNumbers } = pc.lookupCodes(r);
    return { key: r.id, candidates: [...vendorCodes.map((vendorCode) => ({ vendorCode })), ...itemNumbers.map((itemNumber) => ({ itemNumber }))] };
  });
  return erp.resolveItems(entries);
}

/** Split records into chunks whose expanded lookups stay ≤ 500 (resolveItems' batch limit). */
function chunkForLookup(records, max = 480) {
  const chunks = [];
  let cur = [];
  let n = 0;
  for (const r of records) {
    const { vendorCodes, itemNumbers } = pc.lookupCodes(r);
    const cost = vendorCodes.reduce((s, c) => s + erp.codeVariants(c).length, 0) + itemNumbers.length;
    if (n + cost > max && cur.length) { chunks.push(cur); cur = []; n = 0; }
    cur.push(r);
    n += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function importRun(args, snapDir, { env }) {
  const minLocations = Number(args['min-locations'] || 2);
  const catalog = JSON.parse(fs.readFileSync(path.join(snapDir, 'catalog.json'), 'utf8'));
  const costs = loadCosts(snapDir);
  const progressFile = path.join(snapDir, `import-${env}.jsonl`);
  const done = new Map(pc.readJsonl(progressFile).filter((l) => DONE.has(l.status)).map((l) => [l.id, l]));

  const selected = catalog.records.filter((r) => r.locations >= minLocations && (args['include-discontinued'] || !r.discontinued));
  const priced = [];
  const unpriced = [];
  for (const r of selected) {
    const c = costs.get(r.id);
    if (c && c.cost != null) priced.push({ rec: r, cost: c.cost, retail: c.retail }); else unpriced.push(r);
  }
  // Products sharing a Prosol code can't each get it as a vendor code; a person picks (see conflicts.csv).
  const collisions = pc.codeCollisions(selected);
  const colliding = new Set([...collisions.values()].flat());
  let todo = priced.filter((x) => !done.has(x.rec.id) && !colliding.has(x.rec.id));
  if (args.limit) todo = pc.spread(todo, Math.min(Number(args.limit), todo.length));
  log(`${env}: ${selected.length} pass the ${minLocations}-location rule, ${priced.length} priced, ${unpriced.length} still need a cost pull, ${colliding.size} share a Prosol code with another product (skipped); ${done.size} already done; this run ${todo.length}${args.apply ? '' : ' (DRY RUN)'}`);

  const who = (await am.get('/whoami')).data;
  const scopes = new Set((who.key && who.key.scopes) || []);
  for (const s of ['items:read', 'items:create']) if (!scopes.has(s)) throw new Error(`key lacks ${s}`);
  const perMinute = Number(args['writes-per-minute'] || Math.max(1, ((who.rate_limits && who.rate_limits.write_per_minute) || 60) - 5));
  const pace = makePacer(perMinute);
  const vendorId = await erp.resolveRef('prosolVendor');
  log(`tenant ${who.tenant && who.tenant.name}, integration ${who.integration && who.integration.name}; writes paced at ${perMinute}/min (about ${Math.ceil(todo.length / perMinute)} min if all are new)`);

  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const record = (line) => { if (args.apply) fs.appendFileSync(progressFile, JSON.stringify({ ...line, at: new Date().toISOString() }) + '\n'); };
  const samples = [];

  for (const chunk of chunkForLookup(todo.map((x) => x.rec))) {
    const verdicts = await lookupChunk(chunk);
    for (const rec of chunk) {
      const x = todo.find((t) => t.rec.id === rec.id);
      const v = verdicts.get(rec.id);
      const base = { id: rec.id, prosol_sku: rec.prosol_sku, sku: rec.sku, locations: rec.locations, stock_as_of: rec.stock_as_of };
      if (v.status === 'matched') {
        const viaCode = v.via && (v.via.vendor_code || v.via.item_number);
        const otherVendor = !!(v.item.default_vendor && v.item.default_vendor.id !== vendorId);
        if (otherVendor && pc.isShortNumeric(String(viaCode || '').replace(process.env.AUTOMAYT_TEST_CODE_PREFIX || '\u0000', ''))) {
          bump('conflict:code-taken'); record({ ...base, status: 'conflict', reason: 'short code on another vendor\'s item', automaytId: v.item.id, via: v.via }); continue;
        }
        bump(otherVendor ? 'exists-other-vendor' : 'exists');
        record({ ...base, status: 'exists', otherVendor, automaytId: v.item.id, via: v.via });
        continue;
      }
      if (v.status === 'ambiguous') { bump('ambiguous'); record({ ...base, status: 'ambiguous', candidates: v.candidates.map((c) => c.id), via: v.via }); continue; }
      const input = pc.toItemInput(rec, { cost: x.cost, retail: x.retail });
      if (input.skip) { bump(`skip:${input.skip}`); record({ ...base, status: 'skipped', reason: input.skip }); continue; }
      if (!args.apply) { bump('would-create'); if (samples.length < 5) samples.push(input); continue; }
      await pace();
      try {
        const res = await erp.createItem({ ...input, vendorId });
        const theirs = res.duplicate && res.item.default_vendor && res.item.default_vendor.id !== vendorId;
        if (theirs) {
          // The vendor code already belongs to another vendor's item: never link this product to it.
          bump('conflict:code-taken');
          record({ ...base, status: 'conflict', reason: 'vendor code belongs to another vendor\'s item', automaytId: res.item.id, vendorCode: input.vendorCode });
        } else {
          bump(res.created ? 'created' : 'duplicate');
          record({ ...base, status: res.created ? 'created' : 'duplicate', automaytId: res.item.id, vendorCode: input.vendorCode, cost: input.cost });
        }
      } catch (err) {
        bump(`error:${err.code || 'other'}`);
        record({ ...base, status: 'error', code: err.code || null, error: err.message.slice(0, 300), requestId: err.requestId || null });
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total % 50 === 0) log(`  ${total}/${todo.length} ${JSON.stringify(counts)}`);
    }
  }
  log(`done: ${JSON.stringify(counts)}`);
  if (samples.length) console.log('sample inputs:\n' + samples.map((s) => JSON.stringify(s)).join('\n'));
  const report = { env, at: new Date().toISOString(), apply: !!args.apply, minLocations, selected: selected.length, priced: priced.length, unpriced: unpriced.length, sharedProsolCode: colliding.size, alreadyDone: done.size, thisRun: todo.length, counts, writesPerMinute: perMinute };
  fs.writeFileSync(path.join(snapDir, `import-${env}-report${args.apply ? '' : '-dry'}.json`), JSON.stringify(report, null, 1));
  return report;
}

/**
 * Re-check items this importer created or found against the snapshot: cost
 * changes are PATCHed (with --apply); products now below the location rule or
 * discontinued at Prosol are only REPORTED (discontinuing in Automayt is a
 * person's call, and stock_status "Discontinued" runs Automayt's own steps).
 */
async function syncRun(args, snapDir, { env }) {
  const minLocations = Number(args['min-locations'] || 2);
  const catalog = JSON.parse(fs.readFileSync(path.join(snapDir, 'catalog.json'), 'utf8'));
  const byId = new Map(catalog.records.map((r) => [r.id, r]));
  const costs = loadCosts(snapDir);
  const imported = new Map();
  for (const d of fs.readdirSync(ROOT).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()) {
    for (const l of pc.readJsonl(path.join(ROOT, d, `import-${env}.jsonl`))) if (l.automaytId && DONE.has(l.status)) imported.set(l.id, l);
  }
  let list = [...imported.values()];
  if (args.limit) list = list.slice(0, Number(args.limit));
  log(`${env}: ${imported.size} imported items on record; checking ${list.length} against ${path.basename(snapDir)}${args.apply ? '' : ' (DRY RUN)'}`);
  const pace = makePacer(Number(args['writes-per-minute'] || 55));
  const out = { costChanged: [], belowRule: [], discontinued: [], missingFromSnapshot: [] };
  for (const l of list) {
    const rec = byId.get(l.id);
    if (!rec) { out.missingFromSnapshot.push(l.id); continue; }
    if (rec.discontinued) out.discontinued.push({ id: l.id, automaytId: l.automaytId, sku: rec.prosol_sku });
    else if (rec.locations < minLocations) out.belowRule.push({ id: l.id, automaytId: l.automaytId, sku: rec.prosol_sku, locations: rec.locations });
    const c = costs.get(l.id);
    if (!c || c.cost == null || l.status === 'exists') continue; // only items this importer created carry our cost
    const item = (await am.get(`/items/${l.automaytId}`)).data;
    const current = item && item.cost ? Number(item.cost.vendor_cost ?? item.cost.real_cost ?? NaN) : NaN;
    if (Number.isFinite(current) && Math.abs(current - c.cost) < 0.005) continue;
    out.costChanged.push({ id: l.id, automaytId: l.automaytId, sku: rec.prosol_sku, from: Number.isFinite(current) ? current : null, to: c.cost });
    if (args.apply) { await pace(); await erp.updateItem(l.automaytId, { cost: String(c.cost) }); }
  }
  const report = { env, at: new Date().toISOString(), apply: !!args.apply, snapshot: path.basename(snapDir), checked: list.length, costChanged: out.costChanged.length, belowRule: out.belowRule.length, discontinued: out.discontinued.length, missingFromSnapshot: out.missingFromSnapshot.length, detail: out };
  fs.writeFileSync(path.join(snapDir, `sync-${env}-report${args.apply ? '' : '-dry'}.json`), JSON.stringify(report, null, 1));
  log(`sync: ${JSON.stringify({ costChanged: report.costChanged, belowRule: report.belowRule, discontinued: report.discontinued, missingFromSnapshot: report.missingFromSnapshot })}`);
  return report;
}

async function main() {
  const args = parseArgs();
  const g = guard(args);
  const date = args.date || newestSnapshot();
  const snapDir = path.join(ROOT, date);
  log(`Automayt ${g.env} (${g.base}), snapshot ${date}`);
  if (args.sync) await syncRun(args, snapDir, g);
  else await importRun(args, snapDir, g);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { envName, chunkForLookup, guard };
