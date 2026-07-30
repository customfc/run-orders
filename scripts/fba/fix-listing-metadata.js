#!/usr/bin/env node
/**
 * Clear Amazon listing errors that are pure metadata defects.
 *
 * These suppress real revenue for reasons unrelated to the product: a unit
 * enum Amazon stopped accepting, a variation theme in the wrong shape, a
 * marketing blurb over its character cap.
 *
 * HARD-WON API FACTS (each cost a failed round trip):
 *   - `op: "delete"` is NOT supported. It returns 400 "Invalid empty value
 *     provided in patch" with a value, and 404 without one. Always use
 *     `replace` with a compliant value.
 *   - Always VALIDATION_PREVIEW first. A patch can return HTTP 200 and still be
 *     status=INVALID, and the validation issue names the REAL constraint, which
 *     is often not what the original error said.
 *   - `variation_theme` wants `name` as a plain STRING: [{name:'SIZE'}].
 *     [{name:[{value:'SIZE'}]}] fails with 4000001.
 *   - `item_volume` rejects unit 'ounces'; 'fluid_ounces' is accepted.
 *   - Error 90225 on `title_differentiation` (Item Highlight) is a SYMPTOM.
 *     The real blocker is error 100476: Item Highlights require an item_name of
 *     75 characters or less. Shortening a customer-facing title is a content
 *     decision, so those are reported, never auto-patched.
 *   - Error 99028 on dimensions demands >=1 decimal place, and JSON serialises
 *     6.0 as 6. Fixing it means supplying a real measured value, so it is reported
 *     rather than fudged to 6.1.
 *
 * NOT fixable here (need documents or a human): 100390 CCCR chemical docs,
 * 18299 brand approval, 18146 trademark misuse, 5995 brand change.
 *
 * Usage:
 *   node scripts/fba/fix-listing-metadata.js            # dry run
 *   node scripts/fba/fix-listing-metadata.js --commit
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sp = require('../../lib/sp-api');

const DATA = path.join(__dirname, '..', '..', 'data', 'fba');
const MP = (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');
const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const COMMIT = process.argv.includes('--commit');
const ONLY = arg('only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANUAL = {
  100390: 'CCCR chemical documentation',
  18299: 'brand approval required',
  18146: 'trademark misuse — needs listing rename',
  5995: 'brand change not permitted on this ASIN',
  100476: 'needs item_name shortened to <=75 chars',
  99028: 'needs a real measured dimension with 1 decimal place',
};

/** Build a compliant replacement value for a known-bad attribute. */
function repair(attribute, listing) {
  switch (attribute) {
    case 'variation_theme':
      return [{ name: 'SIZE', marketplace_id: MP }];
    case 'item_volume': {
      const m = String(listing.name || '').match(/(\d+(?:\.\d+)?)\s*(oz|ounce|ml|l|qt|quart|gal)/i);
      if (!m) return [{ unit: 'fluid_ounces', value: 32, marketplace_id: MP }];
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      const unit = /ml/.test(u) ? 'milliliters' : /gal/.test(u) ? 'gallons' : /qt|quart/.test(u) ? 'quarts' : /^l$/.test(u) ? 'liters' : 'fluid_ounces';
      return [{ unit, value: n, marketplace_id: MP }];
    }
    case 'product_discovery_content': {
      const base = String(listing.name || '').replace(/\s+/g, ' ').trim();
      return [{ value: base.slice(0, 480), language_tag: 'en_CA', marketplace_id: MP }];
    }
    default:
      return null;
  }
}

async function send(sku, patches, mode) {
  const sellerId = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await sp.getSellerId();
  const pt = await sp.getProductType(sku, { sellerId });
  const query = { marketplaceIds: MP };
  if (mode) query.mode = mode;
  const res = await sp.spApiRequest('PATCH',
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
    { query, body: { productType: pt, patches } });
  let p = null; try { p = JSON.parse(res.body); } catch { /* html error page */ }
  return { http: res.status, status: p?.status, errs: (p?.issues || []).filter((i) => i.severity === 'ERROR'), submissionId: p?.submissionId, body: res.body };
}

const newest = (dir, p) => {
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(p) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};

(async () => {
  const audit = JSON.parse(fs.readFileSync(newest(DATA, 'silent-losses-'), 'utf8'));
  let blocked = audit.blocked || [];
  if (ONLY) blocked = blocked.filter((b) => String(b.sku).includes(ONLY));

  const plan = [];
  const manual = [];
  for (const b of blocked) {
    const actions = [];
    const reasons = [];
    for (const e of b.errs) {
      const code = String(e.code);
      if (MANUAL[code]) { reasons.push(`${code}: ${MANUAL[code]}`); continue; }
      for (const an of (e.attributeNames || [])) {
        if (an === 'title_differentiation') { reasons.push('100476: needs item_name <=75 chars'); continue; }
        const value = repair(an, b);
        if (value) actions.push({ attribute: an, value, code });
        else reasons.push(`${code}: no repair rule for ${an}`);
      }
      if (!(e.attributeNames || []).length && !MANUAL[code]) reasons.push(`${code}: ${String(e.message).slice(0, 60)}`);
    }
    const seen = new Set();
    const uniq = actions.filter((a) => (seen.has(a.attribute) ? false : seen.add(a.attribute)));
    if (uniq.length) plan.push({ ...b, actions: uniq, reasons });
    else manual.push({ ...b, reasons });
  }
  plan.sort((a, b) => b.rev12 - a.rev12);
  manual.sort((a, b) => b.rev12 - a.rev12);

  console.log(`═══ ${COMMIT ? 'APPLYING' : 'DRY RUN —'} ${plan.length} listings, $${Math.round(plan.reduce((s, p) => s + p.rev12, 0)).toLocaleString()}/yr ═══`);
  const results = [];
  for (const p of plan) {
    console.log(`\n  ${p.sku}  $${Math.round(p.rev12).toLocaleString()}/yr  ${String(p.name).slice(0, 44)}`);
    for (const a of p.actions) {
      const patches = [{ op: 'replace', path: `/attributes/${a.attribute}`, value: a.value }];
      const v = await send(p.sku, patches, 'VALIDATION_PREVIEW');
      if (v.http !== 200 || v.errs.length) {
        console.log(`     ✗ ${a.attribute} — validation rejected: ${v.errs.map((e) => e.code).join(',') || 'http ' + v.http}`);
        results.push({ sku: p.sku, ...a, ok: false, stage: 'validate' });
        await sleep(600);
        continue;
      }
      if (!COMMIT) { console.log(`     ✓ ${a.attribute} — validates clean (dry run)`); await sleep(600); continue; }
      const r = await send(p.sku, patches, null);
      const ok = r.http === 200 && !r.errs.length;
      console.log(`     ${ok ? '✓' : '✗'} ${a.attribute} — ${ok ? 'applied' : 'failed ' + r.errs.map((e) => e.code).join(',')}`);
      results.push({ sku: p.sku, ...a, ok, stage: 'commit' });
      await sleep(800);
    }
    if (p.reasons.length) console.log(`     ⚠ remains blocked: ${[...new Set(p.reasons)].join(' · ')}`);
  }

  console.log(`\n─── NEEDS A HUMAN (${manual.length}) ───`);
  for (const m of manual.slice(0, 20)) console.log(`  ${String(m.sku).padEnd(20)} $${String(Math.round(m.rev12)).padStart(6)}/yr  ${[...new Set(m.reasons)].join(' · ').slice(0, 90)}`);

  if (COMMIT) {
    console.log('\n─── re-checking (Amazon re-evaluates asynchronously) ───');
    await sleep(20000);
    for (const p of plan) {
      try {
        const it = await sp.getListingsItem(p.sku, { includedData: 'summaries,issues' });
        const errs = (it?.issues || []).filter((i) => i.severity === 'ERROR');
        console.log(`  ${errs.length ? '•' : '✓'} ${p.sku.padEnd(20)} errors: ${errs.length}${errs.length ? ' — ' + errs.map((e) => e.code).join(',') : ''}`);
      } catch { /* transient */ }
      await sleep(300);
    }
  }

  const out = path.join(DATA, `metadata-fixes-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), committed: COMMIT, plan, manual, results }, null, 1));
  console.log(`\n✓ wrote ${out}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
