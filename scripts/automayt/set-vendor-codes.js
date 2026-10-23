#!/usr/bin/env node
/**
 * Put vendor codes on the items Automayt loaded from the Salesforce item
 * master (PRD-xxxx, no vendor_code), so the order flows and the Prosol
 * catalogue import find them by code. Aaron, 2026-10-23: Prosol code, else the
 * Salesforce Vendor Item ID. beta1 (the test bed) is fixed through
 * PATCH /items/{id}. Production is a separate database loaded by Automayt's
 * Salesforce migration (no PRD ids there), so the deliverable for it is a
 * crosswalk keyed by Salesforce item plus a held list for their review, both
 * written to cfc-projects/06-salesforce-exit/drafts. Rules:
 * lib/automayt-vendor-codes.js.
 *
 *   node scripts/automayt/set-vendor-codes.js                 # dry run: report + CSVs, writes nothing
 *   node scripts/automayt/set-vendor-codes.js --cached        # same, from the last pull in the folder
 *   node scripts/automayt/set-vendor-codes.js --apply         # PATCH the matches (beta1 / staging)
 *   node scripts/automayt/set-vendor-codes.js --apply --only=PRD-2377,PRD-2502   # just these items
 *   node scripts/automayt/set-vendor-codes.js --cached --reconcile   # bring the live items in line with the rules:
 *       match on the pre-change pull (items.json), read the live items, write what's missing or different,
 *       and take back a code this script wrote that the rules now hold
 *
 * Reads: every Automayt item, the Salesforce item master (read-only SOQL), the
 * QOH crosswalk CSVs (cfc-projects/06-salesforce-exit/drafts), the Prosol
 * catalogue snapshot. Writes data/automayt-vendor-codes/<date>/: items.json,
 * sf-items-full.json, report.json, matched.csv, held.csv, unmatched.csv,
 * automayt-import.csv (Item Number, Vendor SKU, Barcode, for Automayt's
 * Products import), sample.txt, and apply-<env>.jsonl with --apply (resumable:
 * an item already done, or already carrying its code, is skipped). In the
 * drafts folder: automayt-vendor-codes-crosswalk-<date>.csv and
 * automayt-vendor-codes-held-<date>.csv. Never production: app.automayt.com is refused.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const am = require('../../lib/automayt');
const erp = require('../../lib/automayt-erp');
const { matchVendorCodes, salesforceCrosswalk, patchBody, codeKey } = require('../../lib/automayt-vendor-codes');
const { envName } = require('./prosol-catalog-import');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const DATE = args.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
const DIR = path.join(__dirname, '..', '..', 'data', 'automayt-vendor-codes', DATE);
const DRAFTS = args.drafts || path.join(__dirname, '..', '..', '..', 'cfc-projects', '06-salesforce-exit', 'drafts');
const CATALOG = args.catalog || path.join(__dirname, '..', '..', 'data', 'prosol-catalog', '2026-10-14', 'catalog.json');
const WRITES_PER_MIN = 55;

function guard() {
  const { base } = am.config();
  const env = envName(base);
  // Production is loaded by Automayt's migration from the crosswalk, never patched from here.
  if (env === 'production') throw new Error('refusing production: its vendor codes go in through Automayt\'s migration (the crosswalk CSV)');
  // Real codes, never ROTEST-: these are CFC's own items.
  if (process.env.AUTOMAYT_TEST_CODE_PREFIX) throw new Error('unset AUTOMAYT_TEST_CODE_PREFIX: vendor codes here are real');
  return env;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [h, ...body] = rows;
  return body.map((c) => Object.fromEntries(h.map((k, i) => [k.trim(), (c[i] || '').trim()])));
}
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const writeCsv = (file, header, rows) => fs.writeFileSync(file, [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n');

async function loadItems() {
  const file = path.join(DIR, 'items.json');
  if (args.cached && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = await am.listAll('/items', { limit: '200' }, { max: 50_000 });
  fs.writeFileSync(file, JSON.stringify(items));
  return items;
}

async function loadSalesforceItems() {
  const file = path.join(DIR, 'sf-items-full.json');
  if (fs.existsSync(file) && (args.cached || args['cached-sf'])) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const sf = require('../../lib/salesforce');
  const conn = await sf.connect();
  const soql = 'SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c, Manufacturer__c, Original_Style_Name__c, Color__c, Size__c, PBSI__UPC__c, PBSI__UPC_Code__c, PBSI__salesprice__c, PBSI__Cost__c, PBSI__Quantity_on_Hand__c, PBSI__defaultunitofmeasure__c, PBSI__Item_Status__c, PBSI__description__c FROM PBSI__PBSI_Item__c';
  const rows = [];
  let r = await conn.query(soql);
  rows.push(...r.records);
  while (!r.done) { r = await conn.queryMore(r.nextRecordsUrl); rows.push(...r.records); }
  for (const x of rows) delete x.attributes;
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

function loadProsolCodes() {
  const out = new Map();
  for (const p of JSON.parse(fs.readFileSync(CATALOG, 'utf8')).records) {
    for (const k of [p.sku, p.prosol_sku, p.external_id]) {
      const c = codeKey(k);
      if (c && !out.has(c)) out.set(c, p.name);
    }
  }
  return out;
}

/** Deterministic pseudo-random sample (same pick on every run of the same data). */
function sample(rows, n) {
  const scored = rows.map((r) => ({ r, h: require('crypto').createHash('md5').update(r.item.id).digest('hex') }));
  return scored.sort((a, b) => a.h.localeCompare(b.h)).slice(0, n).map((x) => x.r);
}

function writeOutputs(result, prosolCodes) {
  const label = (it) => [it.item_number, it.default_vendor && it.default_vendor.name, it.manufacturer, it.style, it.color].map((x) => x || '').join(' | ');
  writeCsv(path.join(DIR, 'matched.csv'), ['item_number', 'item_id', 'vendor', 'manufacturer', 'style', 'color', 'retail', 'vendor_code', 'code_source', 'rule', 'sf_item', 'sf_vendor_item_id', 'sf_description', 'clear_barcode'],
    result.matched.map((m) => [m.item.item_number, m.item.id, m.item.default_vendor && m.item.default_vendor.name, m.item.manufacturer, m.item.style, m.item.color, m.item.retail_price, m.code, m.source, m.rule, m.sf.Name, m.sf.PBSI__Vendor_Item_ID__c, m.sf.PBSI__description__c, m.clearUpc ? m.item.upc : '']));
  writeCsv(path.join(DIR, 'held.csv'), ['item_number', 'item_id', 'vendor', 'manufacturer', 'style', 'color', 'proposed_code', 'sf_item', 'reason'],
    result.held.map((h) => [h.item.item_number, h.item.id, h.item.default_vendor && h.item.default_vendor.name, h.item.manufacturer, h.item.style, h.item.color, h.code || '', h.sf ? h.sf.Name : '', h.reason]));
  writeCsv(path.join(DIR, 'unmatched.csv'), ['item_number', 'item_id', 'vendor', 'manufacturer', 'style', 'color', 'retail', 'reason', 'candidates'],
    result.unmatched.map((u) => [u.item.item_number, u.item.id, u.item.default_vendor && u.item.default_vendor.name, u.item.manufacturer, u.item.style, u.item.color, u.item.retail_price, u.reason,
      u.candidates.slice(0, 6).map((s) => `${s.Name} ${s.PBSI__Vendor_Item_ID__c} $${s.PBSI__salesprice__c} (${s.PBSI__description__c || ''})`).join(' ; ')]));
  // Automayt's Products import (Company Settings > Data Import): update in place by item number.
  writeCsv(path.join(DIR, 'automayt-import.csv'), ['Item Number', 'Vendor SKU', 'Barcode'],
    result.matched.map((m) => [m.item.item_number, m.code, m.clearUpc ? '' : (m.item.upc || '')]));
  const lines = sample(result.matched, Number(args.sample || 30)).map((m) => {
    const prosol = m.source === 'prosol' ? `\n      Prosol:     ${prosolCodes.get(m.code.toUpperCase()) || '(not in snapshot)'}` : '';
    return `${m.rule.padEnd(11)} ${m.code}\n      Automayt:   ${label(m.item)}  $${m.item.retail_price}\n      Salesforce: ${m.sf.Name} ${m.sf.PBSI__Vendor_Item_ID__c} | ${m.sf.PBSI__Default_Vendor_Name__c} | ${m.sf.PBSI__description__c || ''}  $${m.sf.PBSI__salesprice__c}${prosol}`;
  });
  fs.writeFileSync(path.join(DIR, 'sample.txt'), lines.join('\n\n') + '\n');
}

const DECIDE = [
  [/same code on/, 'Pick the one Salesforce item that keeps this vendor code (or merge them); the others get none.'],
  [/barcode of another/, 'Clear the other item\'s barcode if it is not a real UPC/EAN; then this code can go on.'],
  [/also a Prosol code/, 'Leave the vendor code empty, unless this is the same product Prosol sells under that code.'],
  [/do NOT match/i, 'Different product from Prosol\'s item with this code: leave the vendor code empty.'],
  [/no usable Vendor Item ID/, 'Salesforce has no code: add the vendor\'s code if this item is still ordered, else leave it empty.'],
];
const decideFor = (issue) => (DECIDE.find(([re]) => re.test(issue)) || [null, ''])[1];

function writeMigrationFiles(sfx) {
  const crosswalkFile = path.join(DRAFTS, `automayt-vendor-codes-crosswalk-${DATE}.csv`);
  const heldFile = path.join(DRAFTS, `automayt-vendor-codes-held-${DATE}.csv`);
  const prdCell = (links) => links.map((l) => l.itemNumber).join(' ');
  writeCsv(crosswalkFile, ['sf_item_id', 'sf_item_number', 'sf_vendor', 'sf_vendor_item_id', 'sf_description', 'vendor_code', 'code_source', 'barcode_to_clear', 'beta1_item_number', 'beta1_match_rule'],
    sfx.rows.map((r) => [r.sf.Id, r.sf.Name, r.sf.PBSI__Default_Vendor_Name__c, r.sf.PBSI__Vendor_Item_ID__c, String(r.sf.PBSI__description__c || '').trim(), r.code,
      r.source === 'prosol' ? 'Prosol code' : r.source === 'none' ? 'none (no real Vendor Item ID in Salesforce)' : 'Salesforce Vendor Item ID', r.clearBarcode, prdCell(r.beta1), r.beta1.map((l) => l.rule).join(' ')]));
  writeCsv(heldFile, ['issue', 'what_to_decide', 'sf_item_id', 'sf_item_number', 'sf_vendor', 'sf_vendor_item_id', 'sf_description', 'sf_status', 'proposed_vendor_code', 'other_sf_items', 'beta1_item_number'],
    sfx.held.map((h) => [h.issue, decideFor(h.issue), h.sf.Id, h.sf.Name, h.sf.PBSI__Default_Vendor_Name__c, h.sf.PBSI__Vendor_Item_ID__c, String(h.sf.PBSI__description__c || '').trim(),
      h.sf.PBSI__Item_Status__c || '', h.code || '', h.others.join(' ; '), prdCell(h.beta1)]));
  return { crosswalkFile, heldFile };
}

const tally = (rows, f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
const reasonKind = (r) => r.replace(/^.*has no usable Vendor Item ID.*$/, 'no usable Vendor Item ID').replace(/^same code on \d+ Salesforce items.*$/, 'same code on several Salesforce items').replace(/^.* code \S+ is also a Prosol code .*$/, "another vendor's code is also a Prosol code").replace(/Salesforce item \S+/g, 'Salesforce item #').replace(/code \S+/g, 'code #').replace(/\(.*\)/g, '(…)').replace(/\d+/g, 'n');

async function apply(result, env) {
  const log = path.join(DIR, `apply-${env}.jsonl`);
  const done = new Set();
  if (fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.ok) done.add(e.itemId);
    }
  }
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const todo = result.matched.filter((m) => !done.has(m.item.id) && m.item.vendor_code !== m.code && (!only || only.has(m.item.item_number)));
  const limit = args.limit ? Number(args.limit) : todo.length;
  console.log(`apply on ${env}: ${todo.length} to write (${done.size} already done), writing ${Math.min(limit, todo.length)}`);
  let ok = 0;
  let failed = 0;
  const gap = Math.ceil(60_000 / WRITES_PER_MIN);
  for (const m of todo.slice(0, limit)) {
    const t0 = Date.now();
    const body = patchBody(m);
    const { expected_version: version, ...fields } = body;
    const entry = { at: new Date().toISOString(), itemId: m.item.id, itemNumber: m.item.item_number, code: m.code, clearUpc: m.clearUpc };
    try {
      const after = await erp.updateItem(m.item.id, fields, { expectedVersion: version });
      const got = after && (after.vendor_code || (after.data && after.data.vendor_code));
      entry.ok = got === m.code;
      if (!entry.ok) entry.error = `vendor_code after PATCH is ${JSON.stringify(got)}`;
    } catch (err) {
      entry.ok = false;
      entry.error = String(err.message).slice(0, 300);
      entry.code409 = err.status === 409 ? err.code : undefined;
      entry.requestId = err.requestId || err.request_id;
    }
    entry.ok ? ok++ : failed++;
    fs.appendFileSync(log, JSON.stringify(entry) + '\n');
    if ((ok + failed) % 100 === 0) console.log(`  ${ok + failed}: ${ok} ok, ${failed} failed`);
    const wait = gap - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`done: ${ok} ok, ${failed} failed. Log: ${log}`);
  return { ok, failed };
}

/** Live state vs the rules: write missing or different codes, take back codes we wrote that are now held. */
async function reconcile(result, env) {
  const log = path.join(DIR, `apply-${env}.jsonl`);
  const wrote = new Set();
  if (fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.ok || /after PATCH is/.test(e.error || '')) wrote.add(e.itemId);
    }
  }
  const live = new Map((await am.listAll('/items', { limit: '200' }, { max: 50_000 })).map((i) => [i.id, i]));
  fs.writeFileSync(path.join(DIR, 'items-live.json'), JSON.stringify([...live.values()]));
  const want = new Map(result.matched.map((m) => [m.item.id, m]));
  const changes = [];
  for (const [id, m] of want) {
    const cur = live.get(id);
    if (cur && codeKey(cur.vendor_code) !== codeKey(m.code)) changes.push({ item: cur, fields: { vendor_code: m.code, ...(m.clearUpc && cur.upc ? { upc: null } : {}) }, why: cur.vendor_code ? `differs (${cur.vendor_code})` : 'missing' });
  }
  for (const id of wrote) {
    const cur = live.get(id);
    if (cur && !want.has(id) && cur.vendor_code) changes.push({ item: cur, fields: { vendor_code: null }, why: 'held by the rules now' });
  }
  console.log(`reconcile on ${env}: ${changes.length} change(s)`);
  const gap = Math.ceil(60_000 / WRITES_PER_MIN);
  const out = [];
  for (const c of changes) {
    const t0 = Date.now();
    const entry = { at: new Date().toISOString(), itemId: c.item.id, itemNumber: c.item.item_number, from: c.item.vendor_code, to: c.fields.vendor_code, why: c.why };
    try {
      const after = await erp.updateItem(c.item.id, c.fields, { expectedVersion: c.item.version });
      const got = after && (after.vendor_code !== undefined ? after.vendor_code : after.data && after.data.vendor_code);
      entry.ok = codeKey(got) === codeKey(c.fields.vendor_code);
    } catch (err) {
      entry.ok = false;
      entry.error = String(err.message).slice(0, 300);
    }
    out.push(entry);
    fs.appendFileSync(path.join(DIR, `reconcile-${env}.jsonl`), JSON.stringify(entry) + '\n');
    const wait = gap - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return { changes: out.length, ok: out.filter((e) => e.ok).length, failed: out.filter((e) => !e.ok) };
}

async function main() {
  const env = guard();
  fs.mkdirSync(DIR, { recursive: true });
  const items = await loadItems();
  const sfItems = await loadSalesforceItems();
  const crosswalk = [...parseCsv(fs.readFileSync(path.join(DRAFTS, 'qoh-crosswalk.csv'), 'utf8')), ...parseCsv(fs.readFileSync(path.join(DRAFTS, 'qoh-exceptions-54.csv'), 'utf8'))];
  const prosolCodes = loadProsolCodes();
  const result = matchVendorCodes(items, sfItems, crosswalk, prosolCodes);
  writeOutputs(result, prosolCodes);
  const sfx = salesforceCrosswalk(sfItems, crosswalk, prosolCodes, result);
  const files = writeMigrationFiles(sfx);
  const report = {
    env, date: DATE, items: items.length, salesforceItems: sfItems.length,
    matched: result.matched.length, byRule: tally(result.matched, (m) => m.rule), bySource: tally(result.matched, (m) => m.source),
    barcodesCleared: result.matched.filter((m) => m.clearUpc).map((m) => ({ item: m.item.item_number, barcode: m.item.upc, code: m.code })),
    held: result.held.length, heldReasons: tally(result.held, (h) => reasonKind(h.reason)),
    unmatched: result.unmatched.length, unmatchedReasons: tally(result.unmatched, (u) => reasonKind(u.reason)),
    skipped: result.skipped.length,
    migration: {
      crosswalk: sfx.rows.length, crosswalkWithBeta1Item: sfx.rows.filter((r) => r.beta1.length).length,
      bySource: tally(sfx.rows, (r) => r.source), barcodesToClear: sfx.rows.filter((r) => r.clearBarcode).length,
      held: sfx.held.length, heldIssues: tally(sfx.held, (h) => reasonKind(h.issue)),
      heldWithBeta1Item: sfx.held.filter((h) => h.beta1.length).length, files,
    },
  };
  if (args.apply) report.apply = await apply(result, env);
  if (args.reconcile) report.reconcile = await reconcile(result, env);
  fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nFiles in ${DIR}`);
}

if (require.main === module) main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

module.exports = { parseCsv };
