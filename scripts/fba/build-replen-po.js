#!/usr/bin/env node
/**
 * Build the weekly Schluter FBA replenishment PO proposal.
 *
 * Method is Mac-corrected and non-negotiable (project_fba_weekly_replenishment):
 *   - Rank by FBA-ONLY revenue: amazon_financial_events joined to orders that
 *     carry an FBAPerUnitFulfillmentFee. v_sku_monthly_pnl blends FBM+FBA and
 *     LIES for this purpose (it once proposed DHD810M, which never sold FBA).
 *   - Velocity = FBA units / months-with-FBA-sales.
 *   - Target 2.5 months cover MINUS on-hand MINUS inbound MINUS already-on-order.
 *     Never propose a line already sitting above 2.5 months of cover, whatever
 *     Amazon's rec says.
 *   - Amazon rec_ship_qty is the qty source for EMPTY listings only.
 *   - Group listings by physical prosol_sku, then apply a $2K floor per group.
 *   - Live Prosol stock check before anything gets sent.
 *
 * Open Prosol POs are read from Salesforce and counted as pipeline supply, so a
 * SKU sitting on an unfulfilled PO never gets re-ordered.
 *
 * Prints a proposal. Sends nothing — vendor email needs a per-email green-light.
 *
 * Usage:
 *   node scripts/fba/build-replen-po.js
 *   node scripts/fba/build-replen-po.js --budget=10000 --cover=2.5 --floor=2000
 *   node scripts/fba/build-replen-po.js --no-sf     # skip the open-PO check
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sp = require('../../lib/sp-api');
const sfLib = require('../../lib/salesforce');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'analytics.sqlite');
const SKU_MAP = path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json');
const SNAPS = path.join(ROOT, 'data', 'fba', 'snapshots');
const OUT_DIR = path.join(ROOT, 'data', 'fba', 'po-drafts');

const args = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  args[k] = v === undefined ? true : v;
}
const BUDGET = Number(args.budget || 10000);
const COVER_MONTHS = Number(args.cover || 2.5);
const LINE_FLOOR = Number(args.floor || 2000);
const MONTHS_BACK = Number(args.months || 12);
const STALE_PO_DAYS = Number(args['stale-po-days'] || 120);

// ── Hard exclusions. Every entry cost real money to learn. ─────────────────
const EXCLUDE_SKU = [
  { re: /DHERT105/i, why: 'Mac has 40 on backorder (07-13)' },
  { re: /DHEHK/i, why: 'cables stay FBM-served while sell-through recovers' },
];
const EXCLUDE_NAME = [
  { re: /aqua\s*mix|sealers?\s*choice|enrich.?n.?seal|poultice|grout\s*deep\s*clean/i, why: 'CCCR chemical wall (Amazon 100390)' },
  { re: /ardex|feather\s*finish/i, why: 'CCCR chemical wall (Amazon 100390)' },
  { re: /\bbona\b/i, why: 'Treeco vendor order, not Prosol' },
];

const newest = (dir, prefix) => {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
};
const norm = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase();
const money = (n) => '$' + Math.round(n).toLocaleString();

/**
 * Amazon MSKUs are often opaque ("8D-MV2H-J3A4") or decorated
 * ("SES2D6MGS-11147", "KD4GRKEP-FBA", "11461-DHEHK24027"), and the settlement
 * feed carries no ASIN. Resolve through every path we have and report which
 * one won, so a silent mis-resolution can't quietly poison the ranking.
 */
function buildResolver({ db, skuMap, prosolBySku, liveAsinBySku = {} }) {
  const canonical = db.prepare(`
    SELECT amazon_msku, asin, api_sku, prosol_sku, brand, product_name
    FROM sku_map_canonical WHERE amazon_msku IS NOT NULL AND amazon_msku <> ''
  `).all();
  const byMsku = {};
  for (const r of canonical) byMsku[norm(r.amazon_msku)] = r;

  let invBySku = {};
  try {
    const latest = db.prepare('SELECT MAX(snapshot_date) d FROM inventory_daily').get().d;
    for (const r of db.prepare('SELECT sku, asin FROM inventory_daily WHERE snapshot_date = ?').all(latest)) {
      if (r.sku) invBySku[norm(r.sku)] = r.asin;
    }
  } catch { invBySku = {}; }

  const asinEntries = {};
  for (const [k, v] of Object.entries(skuMap)) {
    if (v && typeof v === 'object' && /^B0[A-Z0-9]{8}$/i.test(k)) asinEntries[k] = v;
  }
  // Every Prosol-ish token we know, so a decorated MSKU can be matched by substring.
  const tokens = [];
  for (const v of Object.values(skuMap)) {
    if (!v || typeof v !== 'object') continue;
    for (const f of ['prosol_sku', 'api_sku', 'schluter_item']) {
      if (v[f] && v[f] !== 'NON_PROSOL' && !String(v[f]).startsWith('UNMAPPED')) tokens.push({ tok: norm(v[f]), entry: v, raw: v[f] });
    }
  }
  tokens.sort((a, b) => b.tok.length - a.tok.length);   // longest match wins
  const prosolKeysByLength = Object.keys(prosolBySku).sort((a, b) => b.length - a.length);

  return function resolve(sku) {
    const n = norm(sku);

    const c = byMsku[n];
    if (c && (c.prosol_sku || c.api_sku)) {
      return { how: 'canonical', asin: c.asin, prosol_sku: c.prosol_sku || c.api_sku, brand: c.brand, name: c.product_name };
    }
    // Live FBA inventory first — it carries the ASIN for every FBA SKU and is
    // fresher than the inventory_daily snapshot table.
    const asin = liveAsinBySku[n] || invBySku[n] || (c && c.asin);
    if (asin && asinEntries[asin]) {
      const e = asinEntries[asin];
      return { how: liveAsinBySku[n] ? 'live-fba→asin' : 'inventory→asin', asin, prosol_sku: e.prosol_sku || e.api_sku || e.schluter_item, brand: e.brand, name: e.product };
    }
    const t = tokens.find((x) => x.tok.length >= 4 && n.includes(x.tok));
    if (t) {
      return { how: 'sku-token', asin: null, prosol_sku: t.entry.prosol_sku || t.entry.api_sku || t.raw, brand: t.entry.brand, name: t.entry.product };
    }
    // The vendor catalog itself is a mapping source — a SKU can be a real
    // Schluter part number that simply never got a sku-map entry.
    const direct = prosolBySku[n];
    if (direct) {
      return { how: 'prosol-catalog', asin: null, prosol_sku: direct.prosol_sku || direct.sku, brand: 'schluter', name: (direct.name && (direct.name.en || direct.name.fr)) || '' };
    }
    const pKey = prosolKeysByLength.find((k) => k.length >= 5 && n.includes(k));
    if (pKey) {
      const p = prosolBySku[pKey];
      return { how: 'prosol-substr', asin: null, prosol_sku: p.prosol_sku || p.sku, brand: 'schluter', name: (p.name && (p.name.en || p.name.fr)) || '' };
    }
    return { how: 'unresolved', asin: asin || null, prosol_sku: null, brand: null, name: null };
  };
}

(async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const since = new Date(Date.now() - MONTHS_BACK * 30.44 * 864e5).toISOString().slice(0, 10);

  // ── 1. FBA-only revenue per seller_sku ───────────────────────────────────
  const rows = db.prepare(`
    WITH fba_keys AS (
      SELECT DISTINCT amazon_order_id, seller_sku
      FROM amazon_financial_events
      WHERE fee_type LIKE '%FBAPerUnitFulfillmentFee%' AND posted_at >= ?
    ),
    principal AS (
      SELECT e.seller_sku,
             substr(e.posted_at,1,7)      AS month,
             SUM(e.amount_cad)            AS revenue,
             SUM(COALESCE(e.quantity,0))  AS units
      FROM amazon_financial_events e
      JOIN fba_keys k
        ON k.amazon_order_id = e.amazon_order_id AND k.seller_sku = e.seller_sku
      WHERE e.posted_at >= ? AND e.fee_type = 'ItemPrice:Principal'
      GROUP BY e.seller_sku, month
    )
    SELECT seller_sku,
           ROUND(SUM(revenue))   AS rev12,
           SUM(units)            AS units12,
           COUNT(DISTINCT month) AS months_active
    FROM principal GROUP BY seller_sku HAVING rev12 > 0 ORDER BY rev12 DESC
  `).all(since, since);
  console.log(`FBA-only revenue rows (last ${MONTHS_BACK}mo): ${rows.length}`);

  // ── 2. Live FBA on-hand ──────────────────────────────────────────────────
  const inv = await sp.getAllFbaInventory();
  const invRows = Array.isArray(inv) ? inv : (inv.inventorySummaries || []);
  const onHand = {};
  const liveAsinBySku = {};
  for (const r of invRows) {
    const d = r.inventoryDetails || {};
    onHand[norm(r.sellerSku)] = { fulfillable: d.fulfillableQuantity || 0, inbound: d.inboundShippedQuantity || 0 };
    if (r.asin) liveAsinBySku[norm(r.sellerSku)] = r.asin;
  }
  console.log(`FBA inventory SKUs: ${invRows.length}`);

  // ── 3. Prosol catalog + Amazon recs + costs ──────────────────────────────
  const skuMap = JSON.parse(fs.readFileSync(SKU_MAP, 'utf8')).mappings;
  const catPath = newest(SNAPS, 'prosol-catalog-10008-');
  const prosolBySku = {};
  if (catPath) {
    for (const p of JSON.parse(fs.readFileSync(catPath, 'utf8')).products) {
      for (const k of [p.prosol_sku, p.sku, p.external_id]) if (k) prosolBySku[norm(k)] = p;
    }
  }
  console.log(`Prosol Schluter catalog: ${Object.keys(prosolBySku).length} keys${catPath ? '' : ' (MISSING — run pull-prosol-catalog.js)'}`);

  const costBySku = {};
  for (const r of db.prepare('SELECT sku, cost_cad, prosol_sku FROM item_costs').all()) {
    if (r.prosol_sku) costBySku[norm(r.prosol_sku)] = r.cost_cad;
    if (r.sku) costBySku[norm(r.sku)] = r.cost_cad;
  }
  for (const v of Object.values(skuMap)) {
    if (v && typeof v === 'object' && v.cost_cad != null) {
      for (const f of ['prosol_sku', 'api_sku']) if (v[f]) costBySku[norm(v[f])] ??= Number(v.cost_cad);
    }
  }

  const recPath = newest(SNAPS, 'restock-recs-');
  const recBySku = {};
  if (recPath) {
    const doc = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    const list = doc.items || doc.recs || doc.rows || (Array.isArray(doc) ? doc : []);
    for (const r of list) {
      const k = r.sku || r.msku || r.sellerSku;
      if (k) recBySku[norm(k)] = Number(r.recShipQty ?? r.rec_ship_qty ?? 0) || 0;
    }
  }

  // ── 4. Already on order (open Prosol POs) ────────────────────────────────
  const onOrder = {};
  if (!args['no-sf']) {
    try {
      const conn = await sfLib.connect();
      const openLines = await sfLib.query(conn, `
        SELECT PBSI__Vendor_Item_ID__c, PBSI__Quantity_Left_To_Receive__c,
               PBSI__Purchase_Order__r.Name, PBSI__Purchase_Order__r.PBSI__Status__c,
               PBSI__Purchase_Order__r.CreatedDate
        FROM PBSI__PBSI_Purchase_Order_Line__c
        WHERE PBSI__Purchase_Order__r.PBSI__Account__r.Name LIKE '%rosol%'
          AND PBSI__Purchase_Order__r.PBSI__Status__c IN ('Open','Partially Complete')
          AND PBSI__Quantity_Left_To_Receive__c > 0`);

      // A PO left Open for months is abandoned paperwork, not inbound stock.
      // Counting it as supply silently suppresses restock lines that need to be
      // ordered, so age it out — and print what got aged out, because a stale
      // open PO is itself an ops problem worth seeing.
      const cutoff = Date.now() - STALE_PO_DAYS * 864e5;
      const fresh = [];
      const stale = [];
      for (const l of openLines) {
        const created = Date.parse(l.PBSI__Purchase_Order__r?.CreatedDate || '') || 0;
        (created >= cutoff ? fresh : stale).push(l);
      }
      for (const l of fresh) {
        const k = norm(l.PBSI__Vendor_Item_ID__c);
        if (!k) continue;
        onOrder[k] = (onOrder[k] || 0) + Number(l.PBSI__Quantity_Left_To_Receive__c || 0);
      }
      console.log(`Open Prosol PO lines: ${openLines.length} — counting ${fresh.length} as pipeline supply (PO newer than ${STALE_PO_DAYS}d), ignoring ${stale.length} stale`);
      for (const l of fresh) {
        console.log(`   ${String(l.PBSI__Purchase_Order__r?.Name).padEnd(10)} ${String(l.PBSI__Vendor_Item_ID__c).padEnd(18)} ${String(l.PBSI__Quantity_Left_To_Receive__c).padStart(6)} outstanding  (${String(l.PBSI__Purchase_Order__r?.CreatedDate || '').slice(0, 10)})`);
      }
      if (stale.length) {
        console.log(`\n   ⚠ ${stale.length} stale open Prosol PO lines IGNORED — these should probably be closed out:`);
        for (const l of stale.slice(0, 20)) {
          console.log(`     ${String(l.PBSI__Purchase_Order__r?.Name).padEnd(10)} ${String(l.PBSI__Vendor_Item_ID__c).padEnd(18)} ${String(l.PBSI__Quantity_Left_To_Receive__c).padStart(6)} outstanding  (${String(l.PBSI__Purchase_Order__r?.CreatedDate || '').slice(0, 10)})`);
        }
        if (stale.length > 20) console.log(`     …and ${stale.length - 20} more`);
      }
    } catch (e) {
      console.log(`⚠ Salesforce open-PO check FAILED (${e.message}) — proceeding WITHOUT dedupe. Verify by hand before sending.`);
    }
  }

  const resolve = buildResolver({ db, skuMap, prosolBySku, liveAsinBySku });
  db.close();

  // ── 5. Candidate lines ───────────────────────────────────────────────────
  const skipped = [];
  const cands = [];
  const howTally = {};
  for (const r of rows) {
    const res = resolve(r.seller_sku);
    howTally[res.how] = (howTally[res.how] || 0) + 1;
    const name = res.name || '';
    const ps = res.prosol_sku;

    const ex = EXCLUDE_SKU.find((x) => x.re.test(r.seller_sku) || (ps && x.re.test(ps)))
            || EXCLUDE_NAME.find((x) => x.re.test(name) || x.re.test(r.seller_sku));
    if (ex) { skipped.push({ sku: r.seller_sku, name, rev12: r.rev12, why: ex.why }); continue; }

    if (!ps) {
      skipped.push({ sku: r.seller_sku, name, rev12: r.rev12, asin: res.asin,
        why: `UNRESOLVED${res.asin ? ` (asin ${res.asin})` : ' (no asin either)'} — needs a sku-map entry` });
      continue;
    }

    const pc = prosolBySku[norm(ps)];
    // Presence in the Schluter manufacturer catalog is a harder signal than the
    // brand field, which is blank on plenty of sku-map entries.
    const isSchluter = !!pc || (res.brand || '').toLowerCase() === 'schluter';
    if (!isSchluter) { skipped.push({ sku: r.seller_sku, name, rev12: r.rev12, why: `not Schluter/Prosol (${ps})` }); continue; }

    const oh = onHand[norm(r.seller_sku)] || { fulfillable: 0, inbound: 0 };
    const pipeline = oh.fulfillable + oh.inbound + (onOrder[norm(ps)] || 0);
    const monthsActive = Math.max(1, r.months_active);

    // The settlement quantity column is sparse. When units come back 0 against
    // real revenue, dividing by zero velocity yields infinite cover and silently
    // drops a SKU that may be genuinely empty — so estimate units from revenue
    // and unit price instead of trusting the zero.
    let units = r.units12;
    let unitsSource = 'settlement';
    if (!units || units <= 0) {
      const unitPrice = Number(pc?.msrp_price) / 100 || null;
      if (unitPrice > 0) { units = Math.max(1, Math.round(r.rev12 / unitPrice)); unitsSource = 'rev÷msrp'; }
    }
    const velocity = units > 0 ? units / monthsActive : 0;
    const coverNow = velocity > 0 ? pipeline / velocity : (pipeline > 0 ? Infinity : 0);
    if (velocity <= 0) {
      skipped.push({ sku: r.seller_sku, name: name || ps, rev12: r.rev12, why: 'no unit count and no price to estimate one — needs a manual qty' });
      continue;
    }

    if (coverNow > COVER_MONTHS) {
      skipped.push({ sku: r.seller_sku, name: name || ps, rev12: r.rev12, why: `${coverNow === Infinity ? '∞' : coverNow.toFixed(1)}mo cover already (on-hand ${oh.fulfillable}, inbound ${oh.inbound}, on-order ${onOrder[norm(ps)] || 0})` });
      continue;
    }

    const target = Math.ceil(velocity * COVER_MONTHS);
    const amzRec = recBySku[norm(r.seller_sku)] || 0;
    const useRec = pipeline === 0 && amzRec > 0;
    const qty = Math.max(0, (useRec ? Math.min(amzRec, target) : target) - pipeline);
    if (qty <= 0) { skipped.push({ sku: r.seller_sku, name: name || ps, rev12: r.rev12, why: 'computed qty 0' }); continue; }

    cands.push({
      sku: r.seller_sku, resolved_via: res.how, prosol_sku: ps,
      name: name || (pc && (pc.name.en || pc.name.fr)) || '',
      rev12: r.rev12, units12: units, units_source: unitsSource, months_active: monthsActive,
      velocity: +velocity.toFixed(2), on_hand: oh.fulfillable, inbound: oh.inbound,
      on_order: onOrder[norm(ps)] || 0, cover_now: coverNow === Infinity ? null : +coverNow.toFixed(1),
      qty, cost_cad: costBySku[norm(ps)] ?? null,
      prosol_qty: pc ? pc.available_quantity : null,
      prosol_status: pc ? pc.stock_status : 'not-in-catalog',
      amazon_rec: amzRec || null, qty_source: useRec ? 'amazon-rec' : 'velocity',
    });
  }
  console.log(`\nSKU resolution: ${JSON.stringify(howTally)}`);

  // ── 6. Group by physical prosol_sku, then floor + budget ─────────────────
  const groups = {};
  for (const c of cands) {
    const k = norm(c.prosol_sku);
    const g = (groups[k] = groups[k] || { prosol_sku: c.prosol_sku, name: c.name, qty: 0, rev12: 0, cost_cad: c.cost_cad, prosol_qty: c.prosol_qty, prosol_status: c.prosol_status, skus: [] });
    g.qty += c.qty; g.rev12 += c.rev12;
    g.velocity = (g.velocity || 0) + c.velocity;
    g.on_hand = (g.on_hand || 0) + c.on_hand;
    g.on_order = c.on_order;          // per physical SKU, not additive across listings
    g.skus.push({ sku: c.sku, qty: c.qty, on_hand: c.on_hand, on_order: c.on_order, velocity: c.velocity, units12: c.units12, units_source: c.units_source, rev12: c.rev12, qty_source: c.qty_source });
    if (g.cost_cad == null) g.cost_cad = c.cost_cad;
    if (!g.name) g.name = c.name;
  }
  const lines = Object.values(groups)
    .map((g) => ({ ...g, ext_cost: g.cost_cad != null ? +(g.cost_cad * g.qty).toFixed(2) : null }))
    .sort((a, b) => b.rev12 - a.rev12);

  console.log('\n═══ CANDIDATES (ranked by FBA-only 12mo revenue) ═══');
  console.log('prosol_sku'.padEnd(18), 'qty'.padStart(5), 'cost'.padStart(9), 'ext'.padStart(10), 'rev12'.padStart(9),
    'vel/mo'.padStart(7), 'hand'.padStart(5), 'oord'.padStart(5), 'stk'.padStart(6), 'units'.padStart(10), ' product');
  for (const l of lines) {
    console.log(
      String(l.prosol_sku).slice(0, 17).padEnd(18), String(l.qty).padStart(5),
      (l.cost_cad != null ? '$' + Number(l.cost_cad).toFixed(2) : 'NO COST').padStart(9),
      (l.ext_cost != null ? money(l.ext_cost) : '—').padStart(10),
      money(l.rev12).padStart(9), l.velocity.toFixed(1).padStart(7),
      String(l.on_hand).padStart(5), String(l.on_order).padStart(5),
      String(l.prosol_qty ?? '—').padStart(6),
      String(l.skus[0].units_source).padStart(10), ' ' + String(l.name).slice(0, 40)
    );
  }

  const priced = lines.filter((l) => l.ext_cost != null);
  const noCost = lines.filter((l) => l.ext_cost == null);
  const overFloor = priced.filter((l) => l.ext_cost >= LINE_FLOOR);
  const underFloor = priced.filter((l) => l.ext_cost < LINE_FLOOR);

  let running = 0;
  const chosen = [];
  for (const l of overFloor) {
    if (running + l.ext_cost > BUDGET * 1.15) continue;
    chosen.push(l); running += l.ext_cost;
  }
  // Top up toward budget with the best sub-floor lines rather than leaving money unspent.
  for (const l of underFloor) {
    if (running >= BUDGET * 0.95) break;
    if (Number(l.prosol_qty) < l.qty) continue;
    chosen.push({ ...l, note: 'below floor — budget top-up' }); running += l.ext_cost;
  }

  console.log(`\n═══ PROPOSED PO — ${money(running)} across ${chosen.length} lines ═══`);
  console.log(`(budget ${money(BUDGET)} · ${COVER_MONTHS}mo cover · ${money(LINE_FLOOR)} line floor)`);
  for (const l of chosen) {
    const short = Number(l.prosol_qty) < l.qty ? `  ⚠ Prosol has only ${l.prosol_qty}` : '';
    console.log('  ', String(l.prosol_sku).padEnd(18), String(l.qty).padStart(4), '×', ('$' + Number(l.cost_cad).toFixed(2)).padStart(8), '=', money(l.ext_cost).padStart(9), ' ', String(l.name).slice(0, 40), (l.note ? `[${l.note}]` : ''), short);
  }

  if (noCost.length) {
    console.log('\n─── NO COST RESOLVED (cannot price — fix before including) ───');
    for (const l of noCost) console.log('  ', String(l.prosol_sku).padEnd(18), String(l.qty).padStart(4), money(l.rev12).padStart(9), ' ', String(l.name).slice(0, 44));
  }

  console.log('\n─── EXCLUDED (all, with reason) ───');
  skipped.sort((a, b) => b.rev12 - a.rev12);
  for (const s of skipped) {
    console.log('  ', String(s.sku).slice(0, 20).padEnd(21), money(s.rev12).padStart(9), ' ', s.why, s.name ? ` — ${String(s.name).slice(0, 30)}` : '');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `replen-proposal-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    params: { BUDGET, COVER_MONTHS, LINE_FLOOR, MONTHS_BACK, since },
    onOrder, proposedTotal: running, proposed: chosen,
    allCandidates: lines, noCost, excluded: skipped,
  }, null, 1));
  console.log(`\n✓ wrote ${out}`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
