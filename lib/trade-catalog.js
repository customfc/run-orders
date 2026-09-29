/**
 * Schluter profile catalogue: the pure builder behind scripts/trade/build-schluter-catalog.js (02 task S3,
 * research/2026-09-28-prozone-build/catalog.md sections 2, 3 and 5).
 *
 * No I/O and no network here. The script reads products.csv, variants.csv (S1) and the Prosol refresh JSONL (S2),
 * hands the rows in, and writes what comes back. This file builds Shopify productSet inputs (Admin API 2026-01),
 * runs the QA checks, renders QA.md, and plans the create-or-update for --apply. Nothing in it can call Shopify.
 *
 * Rules (catalog.md section 2, task S3):
 *   - One payload per product handle and wave. Wave 1 products are created with only their wave-1 variants; the
 *     wave-2a payload for the same handle carries the FULL variant list (wave 1 + 2a), because productSet replaces
 *     the whole variant list and --apply updates it keeping the variant IDs.
 *   - SKU = MAP code verbatim (slashes kept), price = MAP, barcode = UPC as a string, CONTINUE selling, inventory
 *     tracked, cost = refreshed Prosol cost, weight in lb. Status DRAFT.
 *   - Never collections, metafields, files or media in the input: productSet replaces those lists, and they are
 *     added separately (collectionAddProductsV2, metafieldsSet, productVariantAppendMedia).
 *   - A variant builds only with exactly one Prosol product for its code and a cost. Prosol-discontinued codes stay
 *     out too (G6) unless keepProsolDiscontinued.
 *   - Customer-facing text never names the distributor and never uses an en or em dash. The Prosol-Dropship tag is
 *     the exception the task asks for (tags are not shown by the theme).
 */

'use strict';

const API_VERSION = '2026-01';
const VENDOR = 'Schluter';
const TYPE_LENGTH = 'Schluter Profile';
const TYPE_ACCESSORY = 'Schluter Profile Accessory';
const MAX_VARIANTS = 250; // theme Liquid product.variants cap (sticky ATC, quick-order list), not Shopify's 2,048
const MAX_OPTIONS = 3;
const WAVES = ['1', '2a'];
const FLOOR_MARGIN = 0.05; // Mac's floor at the deepest tier
const DEEPEST_DISCOUNT = 0.25; // Coast 25% tier
const FORBIDDEN_INPUT_KEYS = ['collections', 'metafields', 'files', 'media', 'images', 'collectionsToJoin'];
const DEFAULT_OPTION = { optionName: 'Title', name: 'Default Title' };
const STORE = 'custom-flooring-centres.myshopify.com';

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const kept = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!kept.length) return [];
  const [head, ...body] = kept;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

function parseJsonl(text) {
  return String(text).split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`JSONL line ${i + 1}: ${e.message}`); }
  });
}

const num = (x) => (x === null || x === undefined || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
// Cents via toPrecision first, so 22.15 x 0.9 = 19.934999... rounds to 19.94 like the price list does.
const round2 = (x) => Math.round(Number((x * 100).toPrecision(12))) / 100;
const money = (x) => (num(x) === null ? null : round2(num(x)).toFixed(2));
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uniq = (a) => [...new Set(a)];
const normSku = (s) => String(s || '').replace(/[\s/\-.]/g, '').toUpperCase();

/** EAN-13 / UPC-A / GTIN-14 / EAN-8 check digit. */
function gtinValid(code) {
  const s = String(code || '');
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return false;
  const d = s.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/** Customer-facing text rules: never the distributor's name, no en or em dash. */
function textProblems(s) {
  const out = [];
  if (/[–—]/.test(String(s))) out.push('en or em dash');
  if (/prosol/i.test(String(s))) out.push('names the distributor');
  return out;
}

function sortByOrder(values, order) {
  const idx = (v) => { const i = order.indexOf(v); return i === -1 ? order.length : i; };
  return [...values].sort((a, b) => idx(a) - idx(b));
}

// ---------------------------------------------------------------------------------------------------------------
// Per-variant decision and input

/**
 * Decide whether a catalogue variant builds. `v` is a variants.csv row, `r` its refresh JSONL row (or undefined).
 * Returns { include, reason, reasons, stage }: stage 'catalog' for S1 exclusions, 'refresh' for the S2 ones.
 */
function decideVariant(v, r, { keepProsolDiscontinued = false } = {}) {
  if (v.excluded_reason) return { include: false, reason: `catalog:${v.excluded_reason}`, reasons: [`catalog:${v.excluded_reason}`], stage: 'catalog' };
  const reasons = [];
  if (!r) reasons.push('not_in_refresh');
  else {
    if (r.match !== 'exact' || !r.prosol_code) reasons.push('no_exact_prosol_match');
    if (!(num(r.cost_cad) > 0)) reasons.push('no_cost');
    if (r.discontinued && !keepProsolDiscontinued) reasons.push('prosol_discontinued');
  }
  return reasons.length ? { include: false, reason: reasons[0], reasons, stage: 'refresh' } : { include: true, reason: null, reasons: [], stage: null };
}

function optionNames(p) {
  return [p.option1_name, p.option2_name, p.option3_name].filter(Boolean);
}

function optionOrders(p) {
  return [1, 2, 3].map((i) => (p[`option${i}_values`] ? p[`option${i}_values`].split(' | ') : []));
}

function variantOptionValues(p, v) {
  const names = optionNames(p);
  if (!names.length) return [{ ...DEFAULT_OPTION }];
  return names.map((n, i) => ({ optionName: n, name: v[`option${i + 1}_value`] }));
}

/** ProductVariantSetInput for one variant. */
function buildVariantInput(p, v, r) {
  const inventoryItem = { tracked: true, cost: money(r && r.cost_cad) };
  const w = num(v.weight_lb);
  if (w !== null && w > 0) inventoryItem.measurement = { weight: { value: w, unit: 'POUNDS' } };
  return {
    optionValues: variantOptionValues(p, v),
    sku: v.sku,
    price: money(v.map_price),
    barcode: String(v.upc || ''),
    inventoryPolicy: 'CONTINUE',
    inventoryItem,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Product-level text

/** "Schluter® JOLLY Edge Trim, Color-Coated Aluminum" -> { name: 'JOLLY Edge Trim', material: 'Color-Coated Aluminum' } */
function splitTitle(title) {
  const t = String(title).replace(/^Schluter®\s*/, '');
  const i = t.lastIndexOf(', ');
  return i === -1 ? { name: t, material: null } : { name: t.slice(0, i), material: t.slice(i + 2) };
}

const PLURAL = { Piece: 'Pieces', Finish: 'Finishes', Height: 'Heights', Width: 'Widths', 'Gap Width': 'Gap widths', Adjustment: 'Adjustments', Size: 'Sizes', Length: 'Lengths' };

/**
 * Short, factual descriptionHtml from the catalogue fields (which come from the MAP text and the item codes).
 * No claims beyond what the rows say, no distributor name, no en or em dash.
 */
function describe(p, vs) {
  const { name, material } = splitTitle(p.title);
  const orders = optionOrders(p);
  const names = optionNames(p);
  const orderFor = (label) => { const i = names.indexOf(label); return i === -1 ? [] : orders[i]; };
  const attrs = [];
  const add = (label, values) => {
    const vals = sortByOrder(uniq(values.filter(Boolean)), orderFor(label));
    if (vals.length) attrs.push([vals.length > 1 ? (PLURAL[label] || label) : label, vals.join(', ')]);
  };
  const isLength = p.piece_type === 'length';
  if (!isLength) add('Piece', vs.map((v) => v.piece).filter((x) => x && !name.toLowerCase().includes(String(x).toLowerCase())));
  if (material) attrs.push(['Material', material]);
  add('Finish', vs.map((v) => v.finish_name));
  add('Height', vs.map((v) => v.height));
  const extras = uniq(vs.map((v) => v.extra_option).filter(Boolean));
  for (const ex of extras) add(ex, vs.filter((v) => v.extra_option === ex).map((v) => v.extra_value));
  const lengths = isLength ? sortByOrder(uniq(vs.map((v) => v.length).filter(Boolean)), orderFor('Length')) : [];
  if (lengths.length) attrs.push([lengths.length > 1 ? 'Lengths' : 'Length', lengths.join(', ')]);

  const lead = `Schluter® ${name}${material ? ` in ${material}` : ''}.`;
  const lengthLine = lengths.length === 1 ? ` Each length is ${lengths[0]}.` : (lengths.length > 1 ? ` Available in lengths of ${lengths.join(' and ')}.` : '');
  const parts = [`<p>${escHtml(lead + lengthLine)}</p>`];
  if (attrs.length) parts.push(`<ul>${attrs.map(([k, val]) => `<li>${escHtml(k)}: ${escHtml(val)}</li>`).join('')}</ul>`);
  parts.push(`<p>${escHtml(vs.length > 1 ? 'The SKU of each option is its Schluter item number.' : 'The SKU is the Schluter item number.')}</p>`);
  return parts.join('');
}

function tagsFor(p) {
  const t = ['schluter', 'profile', `family:${String(p.family).toLowerCase()}`];
  if (p.piece_type === 'length') t.push('pickup-only');
  t.push('Prosol-Dropship');
  return t;
}

function productTypeFor(p) {
  return p.piece_type === 'length' ? TYPE_LENGTH : TYPE_ACCESSORY;
}

// ---------------------------------------------------------------------------------------------------------------
// Product input and waves

/** ProductSetInput for one product from its included rows [{ v, r }]. */
function buildProductInput(p, rows) {
  const names = optionNames(p);
  const orders = optionOrders(p);
  const sorted = [...rows].sort((a, b) => {
    for (let i = 0; i < names.length; i++) {
      const o = orders[i];
      const d = o.indexOf(a.v[`option${i + 1}_value`]) - o.indexOf(b.v[`option${i + 1}_value`]);
      if (d) return d;
    }
    return a.v.sku < b.v.sku ? -1 : (a.v.sku > b.v.sku ? 1 : 0);
  });
  const productOptions = names.length
    ? names.map((n, i) => ({
      name: n,
      position: i + 1,
      values: sortByOrder(uniq(sorted.map((x) => x.v[`option${i + 1}_value`])), orders[i]).map((name) => ({ name })),
    }))
    : [{ name: DEFAULT_OPTION.optionName, position: 1, values: [{ name: DEFAULT_OPTION.name }] }];
  return {
    title: p.title,
    handle: p.handle,
    vendor: VENDOR,
    productType: productTypeFor(p),
    status: 'DRAFT',
    tags: tagsFor(p),
    descriptionHtml: describe(p, sorted.map((x) => x.v)),
    productOptions,
    variants: sorted.map((x) => buildVariantInput(p, x.v, x.r)),
  };
}

/**
 * Build every payload. products/variants are the S1 CSV rows, refresh the S2 JSONL rows.
 * Returns { payloads, excluded, catalogExcludedByReason, emptyProducts, variantIndex, errors }.
 */
function buildCatalog({ products, variants, refresh, keepProsolDiscontinued = false }) {
  const errors = [];
  const refreshBySku = new Map();
  for (const r of refresh) {
    if (refreshBySku.has(r.sku)) errors.push(`refresh has ${r.sku} twice`);
    refreshBySku.set(r.sku, r);
  }
  const prodByHandle = new Map(products.map((p) => [p.handle, p]));
  const included = new Map();
  const excluded = [];
  const catalogExcludedByReason = {};
  const wave1Codes = [];
  for (const v of variants) {
    if (v.wave === '1') wave1Codes.push(v.sku);
    const r = refreshBySku.get(v.sku);
    const d = decideVariant(v, r, { keepProsolDiscontinued });
    if (!d.include) {
      if (d.stage === 'catalog') {
        catalogExcludedByReason[v.excluded_reason] = (catalogExcludedByReason[v.excluded_reason] || 0) + 1;
        if (v.wave === '1') excluded.push({ sku: v.sku, wave: v.wave, handle: v.product_handle || '', stage: 'catalog', reason: d.reason, reasons: d.reasons, map_text: v.map_text });
      } else {
        excluded.push({
          sku: v.sku, wave: v.wave, handle: v.product_handle, stage: 'refresh', reason: d.reason, reasons: d.reasons, map_text: v.map_text,
          prosol_match: r ? r.match : null, prosol_code: r ? r.prosol_code || null : null, cost: r ? num(r.cost_cad) : null,
          stock_status: r ? r.stock_status || null : null, discontinued: r ? !!r.discontinued : null,
        });
      }
      continue;
    }
    if (!prodByHandle.has(v.product_handle)) { errors.push(`${v.sku}: product ${v.product_handle} is not in products.csv`); continue; }
    if (r.product_handle && r.product_handle !== v.product_handle) errors.push(`${v.sku}: refresh says ${r.product_handle}, variants.csv says ${v.product_handle}`);
    if (!included.has(v.product_handle)) included.set(v.product_handle, []);
    included.get(v.product_handle).push({ v, r });
  }

  const payloads = [];
  const emptyProducts = [];
  for (const p of products) {
    const rows = included.get(p.handle) || [];
    if (!rows.length) { emptyProducts.push(p.handle); continue; }
    const w1 = rows.filter((x) => x.v.wave === '1');
    if (p.wave === '1') {
      if (w1.length) payloads.push({ wave: '1', handle: p.handle, product: p, extendsWave1: false, rows: w1, newInWave: w1.length });
      if (rows.length > w1.length) payloads.push({ wave: '2a', handle: p.handle, product: p, extendsWave1: w1.length > 0, rows, newInWave: rows.length - w1.length });
    } else {
      if (w1.length) errors.push(`${p.handle}: wave-2a product holds wave-1 codes ${w1.map((x) => x.v.sku).join(', ')}`);
      payloads.push({ wave: '2a', handle: p.handle, product: p, extendsWave1: false, rows, newInWave: rows.length });
    }
  }
  for (const pl of payloads) pl.input = buildProductInput(pl.product, pl.rows);

  const variantIndex = [];
  for (const [handle, rows] of included) {
    for (const { v, r } of rows) {
      variantIndex.push({
        sku: v.sku, handle, wave: v.wave, map_price: num(v.map_price), cost: num(r.cost_cad), upc: v.upc,
        prosol_code: r.prosol_code, po_code: r.po_code || null, prosol_product_id: r.product_id || null,
        prosol_code_jul29: v.prosol_code || null, stock_status: r.stock_status || null,
        network_qty: Array.isArray(r.inventory) ? r.inventory.reduce((n, b) => n + (num(b.net_available) || 0), 0) : null,
        delivery: v.delivery, special_order: v.special_order === '1', bundles_of_10: v.sold_in_bundles_of_10 === '1',
        name_check: v.name_check,
      });
    }
  }
  return { payloads, excluded, catalogExcludedByReason, emptyProducts, variantIndex, wave1Codes, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// QA

/**
 * Checks per payload and across payloads. mapLookup(sku) -> { mapCad, upc } | null (the MAP list, exact code).
 * liveRows: [{ sku, handle, status, vendor, variant_id }] from a read-only store read, or null when not read.
 * Returns { checks: [{ id, level, wave, handle, sku, msg }], waves: {...}, finalState }.
 */
function runQa({ build, mapLookup, liveRows }) {
  const checks = [];
  const add = (level, id, o, msg) => checks.push({ level, id, wave: o.wave || null, handle: o.handle || null, sku: o.sku || null, msg });
  const variantMeta = new Map(build.variantIndex.map((x) => [x.sku, x]));
  const rowsBySku = new Map();
  for (const pl of build.payloads) for (const x of pl.rows) rowsBySku.set(x.v.sku, x);

  for (const pl of build.payloads) {
    const inp = pl.input;
    const o = { wave: pl.wave, handle: pl.handle };
    for (const k of FORBIDDEN_INPUT_KEYS) if (k in inp) add('error', 'forbidden-field', o, `input has ${k} (productSet would replace that list)`);
    if (inp.status !== 'DRAFT') add('error', 'status', o, `status ${inp.status}, expected DRAFT`);
    if (inp.vendor !== VENDOR) add('error', 'vendor', o, `vendor ${inp.vendor}`);
    if (pl.product.product_type && pl.product.product_type !== inp.productType) add('warn', 'product-type', o, `products.csv says ${pl.product.product_type}, payload ${inp.productType}`);
    if (inp.variants.length > MAX_VARIANTS) add('error', 'variants-over-250', o, `${inp.variants.length} variants (cap ${MAX_VARIANTS})`);
    if (!inp.variants.length) add('error', 'no-variants', o, 'no variants');
    if (inp.productOptions.length > MAX_OPTIONS) add('error', 'options-over-3', o, `${inp.productOptions.length} options`);
    const optNames = inp.productOptions.map((x) => x.name);
    if (new Set(optNames).size !== optNames.length) add('error', 'option-names', o, `duplicate option names ${optNames.join(', ')}`);
    const declared = new Map(inp.productOptions.map((x) => [x.name, new Set(x.values.map((y) => y.name))]));
    const used = new Map(optNames.map((n) => [n, new Set()]));
    const combos = new Map();
    for (const va of inp.variants) {
      const vo = { ...o, sku: va.sku };
      const names = va.optionValues.map((x) => x.optionName);
      if (names.join('|') !== optNames.join('|')) add('error', 'option-shape', vo, `variant options ${names.join('/')} vs product ${optNames.join('/')}`);
      for (const ov of va.optionValues) {
        if (!ov.name) add('error', 'option-value-empty', vo, `empty ${ov.optionName}`);
        else if (!declared.has(ov.optionName) || !declared.get(ov.optionName).has(ov.name)) add('error', 'option-value-undeclared', vo, `${ov.optionName}: ${ov.name} not in productOptions`);
        if (used.has(ov.optionName)) used.get(ov.optionName).add(ov.name);
      }
      const key = va.optionValues.map((x) => x.name).join(' / ');
      if (combos.has(key)) add('error', 'duplicate-combination', vo, `same options as ${combos.get(key)}: ${key}`);
      combos.set(key, va.sku);

      const x = rowsBySku.get(va.sku);
      const mapRow = mapLookup ? mapLookup(va.sku) : null;
      if (!mapRow) add('error', 'price-not-map', vo, 'code not found on the MAP list');
      else if (money(mapRow.mapCad) !== va.price) add('error', 'price-not-map', vo, `price ${va.price} vs MAP ${money(mapRow.mapCad)}`);
      if (x && money(x.v.map_price) !== va.price) add('error', 'price-not-map', vo, `price ${va.price} vs variants.csv map_price ${x.v.map_price}`);
      if (x && num(x.v.schluter_retail_2026) !== null && money(round2(num(x.v.schluter_retail_2026) * 0.9)) !== va.price) add('warn', 'price-vs-2026-list', vo, `price ${va.price} vs round(2026 retail ${x.v.schluter_retail_2026} x 0.9) ${money(round2(num(x.v.schluter_retail_2026) * 0.9))}`);
      const cost = num(va.inventoryItem && va.inventoryItem.cost);
      if (!(cost > 0)) add('error', 'missing-cost', vo, 'no cost');
      else {
        const net = num(va.price) * (1 - DEEPEST_DISCOUNT);
        if ((net - cost) / net < FLOOR_MARGIN) add('error', 'margin-floor', vo, `margin at ${DEEPEST_DISCOUNT * 100}% off is ${(100 * (net - cost) / net).toFixed(1)}% (floor ${FLOOR_MARGIN * 100}%)`);
      }
      if (!va.barcode) add('error', 'missing-barcode', vo, 'no barcode');
      else {
        if (!gtinValid(va.barcode)) add('warn', 'barcode-invalid-gtin', vo, `barcode ${va.barcode} fails the GTIN check digit`);
        if (mapRow && mapRow.upc && mapRow.upc !== va.barcode) add('warn', 'barcode-vs-map', vo, `barcode ${va.barcode} vs MAP UPC ${mapRow.upc}`);
        if (x && x.r && x.r.barcode && String(x.r.barcode) !== va.barcode) add('warn', 'barcode-vs-distributor', vo, `barcode ${va.barcode} vs distributor barcode ${x.r.barcode}`);
      }
      const w = va.inventoryItem && va.inventoryItem.measurement ? va.inventoryItem.measurement.weight.value : null;
      if (!(w > 0)) add('error', 'missing-weight', vo, 'no weight');
      else if (pl.product.piece_type === 'length' && w < 0.15) add('warn', 'weight-suspect', vo, `${w} lb for a full length`);
      if (va.inventoryPolicy !== 'CONTINUE') add('error', 'inventory-policy', vo, va.inventoryPolicy);
      if (!va.inventoryItem || va.inventoryItem.tracked !== true) add('error', 'not-tracked', vo, 'inventory not tracked');
      for (const ov of va.optionValues) for (const t of textProblems(ov.name)) add('error', 'text', vo, `option value "${ov.name}": ${t}`);
    }
    for (const [n, set] of declared) if (used.has(n) && [...set].some((val) => !used.get(n).has(val))) add('error', 'option-value-unused', o, `${n} declares values no variant uses`);
    for (const [field, val] of [['title', inp.title], ['descriptionHtml', inp.descriptionHtml], ...inp.productOptions.map((x) => [`option ${x.name}`, x.name])]) {
      for (const t of textProblems(val)) add('error', 'text', o, `${field}: ${t}`);
    }
    if (pl.product.piece_type === 'length' && !inp.tags.includes('pickup-only')) add('error', 'pickup-tag', o, 'length without pickup-only tag');
    if (pl.product.piece_type !== 'length' && inp.tags.includes('pickup-only')) add('error', 'pickup-tag', o, 'accessory tagged pickup-only');
  }

  // Duplicate SKUs across products: within each wave's payload set, and in the final state (the newest payload per handle).
  const dupCheck = (label, pls) => {
    const seen = new Map();
    for (const pl of pls) for (const va of pl.input.variants) {
      if (!seen.has(va.sku)) seen.set(va.sku, new Set());
      seen.get(va.sku).add(pl.handle);
    }
    for (const [sku, hs] of seen) if (hs.size > 1) add('error', 'duplicate-sku', { wave: label, sku }, `on ${[...hs].join(', ')}`);
    return seen;
  };
  for (const w of WAVES) dupCheck(w, build.payloads.filter((pl) => pl.wave === w));
  const finalByHandle = new Map();
  for (const pl of build.payloads) finalByHandle.set(pl.handle, pl); // 2a comes after 1 for the same handle
  const finalSkus = dupCheck('final', [...finalByHandle.values()]);
  const finalNorm = new Map();
  for (const [sku, hs] of finalSkus) {
    const k = normSku(sku);
    if (!finalNorm.has(k)) finalNorm.set(k, []);
    finalNorm.get(k).push({ sku, handle: [...hs][0] });
  }
  for (const [k, list] of finalNorm) if (list.length > 1) add('warn', 'near-duplicate-sku', { wave: 'final', sku: list.map((x) => x.sku).join(' ~ ') }, `codes differ only by slash, dash, space or case (${k})`);

  // Against the live store (read-only snapshot).
  let live = { checked: false };
  if (liveRows) {
    live = { checked: true, variants: liveRows.length, exact: 0, near: 0, handleCollisions: 0 };
    const liveBySku = new Map();
    const liveByNorm = new Map();
    const liveHandles = new Map();
    for (const lr of liveRows) {
      if (lr.sku) {
        if (!liveBySku.has(lr.sku)) liveBySku.set(lr.sku, []);
        liveBySku.get(lr.sku).push(lr);
        const k = normSku(lr.sku);
        if (!liveByNorm.has(k)) liveByNorm.set(k, []);
        liveByNorm.get(k).push(lr);
      }
      if (!liveHandles.has(lr.handle)) liveHandles.set(lr.handle, lr);
    }
    for (const [handle, pl] of finalByHandle) {
      const lh = liveHandles.get(handle);
      if (lh) {
        live.handleCollisions++;
        add(lh.vendor === VENDOR ? 'warn' : 'error', 'handle-exists-live', { wave: pl.wave, handle }, `live product with this handle (${lh.status}, vendor ${lh.vendor}); --apply will update it, not create`);
      }
      for (const va of pl.input.variants) {
        const ex = (liveBySku.get(va.sku) || []).filter((lr) => lr.handle !== handle);
        if (ex.length) { live.exact++; add('error', 'duplicate-sku-live', { wave: pl.wave, handle, sku: va.sku }, `live on ${ex.map((lr) => `${lr.handle} (${lr.status})`).join(', ')}`); continue; }
        const nr = (liveByNorm.get(normSku(va.sku)) || []).filter((lr) => lr.handle !== handle);
        if (nr.length) { live.near++; add('warn', 'near-duplicate-sku-live', { wave: pl.wave, handle, sku: va.sku }, `live ${nr.map((lr) => `${lr.sku} on ${lr.handle} (${lr.status})`).join(', ')}`); }
      }
    }
  } else add('warn', 'live-not-checked', {}, 'no live SKU snapshot given: duplicate SKUs against yourfloors.ca not checked');

  for (const e of build.errors) add('error', 'build', {}, e);
  if (build.emptyProducts.length) add('warn', 'empty-product', {}, `no buildable variants: ${build.emptyProducts.join(', ')}`);

  const waves = {};
  for (const w of WAVES) {
    const pls = build.payloads.filter((pl) => pl.wave === w);
    const vs = pls.flatMap((pl) => pl.rows);
    const newRows = pls.flatMap((pl) => (pl.extendsWave1 ? pl.rows.filter((x) => x.v.wave !== '1') : pl.rows));
    const prices = vs.map((x) => num(x.v.map_price));
    waves[w] = {
      payloads: pls.length,
      newProducts: pls.filter((pl) => !pl.extendsWave1).length,
      extendsWave1: pls.filter((pl) => pl.extendsWave1).length,
      variantsInPayloads: vs.length,
      newVariants: newRows.length,
      lengths: newRows.filter((x) => x.v.piece_type === 'length').length,
      accessories: newRows.filter((x) => x.v.piece_type !== 'length').length,
      available: newRows.filter((x) => x.r.stock_status === 'available').length,
      backorder: newRows.filter((x) => x.r.stock_status === 'backorder').length,
      specialOrder: newRows.filter((x) => (variantMeta.get(x.v.sku) || {}).special_order).length,
      excluded: build.excluded.filter((e) => e.wave === w).length,
      maxVariants: Math.max(0, ...pls.map((pl) => pl.input.variants.length)),
      maxOptions: Math.max(0, ...pls.map((pl) => pl.input.productOptions.length)),
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      errors: checks.filter((c) => c.level === 'error' && c.wave === w).length,
    };
  }
  const finalState = { products: finalByHandle.size, variants: [...finalByHandle.values()].reduce((n, pl) => n + pl.input.variants.length, 0) };
  return { checks, waves, finalState, live };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function summarizePayload(pl) {
  const inp = pl.input;
  const prices = inp.variants.map((v) => num(v.price));
  const costs = inp.variants.map((v) => num(v.inventoryItem.cost));
  const weights = inp.variants.map((v) => (v.inventoryItem.measurement ? v.inventoryItem.measurement.weight.value : null)).filter((x) => x !== null);
  const range = (a, f = (x) => x) => (a.length ? (Math.min(...a) === Math.max(...a) ? f(Math.min(...a)) : `${f(Math.min(...a))} to ${f(Math.max(...a))}`) : 'n/a');
  const text = inp.descriptionHtml.replace(/<\/li>/g, '\n').replace(/<\/p>/g, '\n').replace(/<li>/g, '- ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const lines = [
    `### \`${pl.handle}\` (wave ${pl.wave}${pl.extendsWave1 ? ', full list for the wave-1 product' : ''})`,
    '',
    `- Title: ${inp.title}`,
    `- Type: ${inp.productType}; vendor ${inp.vendor}; status ${inp.status}`,
    `- Tags: ${inp.tags.join(', ')}`,
    `- Options: ${inp.productOptions.map((o) => `${o.name} (${o.values.length}: ${o.values.map((v) => v.name).join(', ')})`).join('; ')}`,
    `- Variants: ${inp.variants.length} (${pl.newInWave} new in this wave); price $${range(prices, (x) => x.toFixed(2))}; cost $${range(costs, (x) => x.toFixed(2))}; weight ${range(weights)} lb`,
    '- First variants:',
    '',
    '| SKU | Options | Price | Cost | Barcode | Weight lb |',
    '|---|---|---:|---:|---|---:|',
    ...inp.variants.slice(0, 3).map((v) => `| \`${v.sku}\` | ${v.optionValues.map((x) => x.name).join(' / ')} | ${v.price} | ${v.inventoryItem.cost} | ${v.barcode} | ${v.inventoryItem.measurement ? v.inventoryItem.measurement.weight.value : ''} |`),
    '',
    'Description as rendered:',
    '',
    ...text.split('\n').map((l) => `> ${l}`),
    '',
  ];
  return lines.join('\n');
}

/** Pick 5 varied examples: wave 1, the largest, a 3-option length, the no-option product, a wave-2a extension. */
function pickExamples(payloads) {
  const out = [];
  const push = (pl) => { if (pl && !out.includes(pl)) out.push(pl); };
  push(payloads.find((pl) => pl.wave === '1' && pl.input.variants.length > 1));
  push([...payloads].sort((a, b) => b.input.variants.length - a.input.variants.length)[0]);
  push(payloads.find((pl) => pl.product.piece_type === 'length' && pl.input.productOptions.length === 3));
  push(payloads.find((pl) => pl.input.productOptions[0].name === 'Title'));
  push(payloads.find((pl) => pl.extendsWave1));
  for (const pl of payloads) { if (out.length >= 5) break; push(pl); }
  return out.slice(0, 5);
}

function renderQa({ build, qa, meta }) {
  const L = [];
  const errs = qa.checks.filter((c) => c.level === 'error');
  const warns = qa.checks.filter((c) => c.level === 'warn');
  const byId = (list) => { const m = new Map(); for (const c of list) { if (!m.has(c.id)) m.set(c.id, []); m.get(c.id).push(c); } return m; };
  const count = (id) => qa.checks.filter((c) => c.id === id).length;
  const w1 = qa.waves['1'];
  const w2 = qa.waves['2a'];

  L.push('# Schluter profile catalogue: productSet payload QA (S3, dry run)', '');
  L.push(`Generated ${meta.generatedBc} BC by \`run-orders/scripts/trade/build-schluter-catalog.js\` (branch trade/02). Dry run: nothing was written to Shopify. Payloads are Admin API ${API_VERSION} \`productSet\` inputs, one file per product handle and wave, in \`payloads/<wave>/<handle>.json\`; \`manifest.json\` lists them with their sha256.`, '');
  L.push('Inputs:');
  for (const i of meta.inputs) L.push(`- ${i.label}: \`${i.path}\`${i.sha256 ? ` (sha256 ${i.sha256.slice(0, 12)})` : ''}${i.note ? `, ${i.note}` : ''}`);
  L.push('');
  L.push('## Bottom line', '');
  L.push(`- **${errs.length ? `${errs.length} blocking errors` : 'No blocking errors'}**, ${warns.length} warnings. \`--apply\` refuses a wave that has any error.`);
  L.push(`- **Wave 1:** ${w1.payloads} products, ${w1.newVariants} variants (${w1.lengths} pickup-only lengths, ${w1.accessories} accessories).`);
  L.push(`- **Wave 2a:** ${w2.newProducts} new products and the full variant lists for ${w2.extendsWave1} wave-1 products: ${w2.newVariants} new variants (${w2.lengths} lengths, ${w2.accessories} accessories), ${w2.variantsInPayloads} variants across its payloads.`);
  L.push(`- **After both waves:** ${qa.finalState.products} products, ${qa.finalState.variants} variants. Largest product ${Math.max(w1.maxVariants, w2.maxVariants)} variants (cap ${MAX_VARIANTS}); at most ${Math.max(w1.maxOptions, w2.maxOptions)} options (cap ${MAX_OPTIONS}).`);
  L.push(`- **Left out at build time:** ${build.excluded.filter((e) => e.stage === 'refresh').length} variants the catalogue had included (no exact distributor match, no cost, or flagged discontinued), listed below.`);
  L.push(`- Live store: ${qa.live.checked ? `${qa.live.variants} live variants read (read-only snapshot); ${qa.live.exact} exact SKU clashes with other products, ${qa.live.near} near clashes, ${qa.live.handleCollisions} handles already live` : 'NOT checked'}.`);
  L.push('');

  L.push('## Per wave', '');
  L.push('| Wave | Payloads | New products | Extends wave-1 products | Variants in payloads | New variants | Pickup-only lengths | Accessories (ship) | In stock at the distributor | Backorder | Special order | Left out | MAP range | Errors |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|');
  for (const w of WAVES) {
    const s = qa.waves[w];
    L.push(`| ${w} | ${s.payloads} | ${s.newProducts} | ${s.extendsWave1} | ${s.variantsInPayloads} | ${s.newVariants} | ${s.lengths} | ${s.accessories} | ${s.available} | ${s.backorder} | ${s.specialOrder} | ${s.excluded} | $${s.priceMin === null ? '' : s.priceMin.toFixed(2)} to $${s.priceMax === null ? '' : s.priceMax.toFixed(2)} | ${s.errors} |`);
  }
  L.push('');
  L.push('Wave 1 creates its products with only the wave-1 variants. The wave-2a payload for the same handle carries the full list (wave 1 + 2a), because `productSet` replaces the whole variant list; `--apply` looks the product up and sends the existing variant IDs, so wave-1 variant IDs (and the discount scopes built on them) survive.', '');

  L.push('## Variants left out', '');
  const ref = build.excluded.filter((e) => e.stage === 'refresh');
  if (ref.length) {
    L.push('| SKU | Wave | Product | Reason | All reasons | Distributor code | Cost | Stock | MAP text |');
    L.push('|---|---|---|---|---|---|---:|---|---|');
    for (const e of ref) L.push(`| \`${e.sku}\` | ${e.wave} | \`${e.handle}\` | ${e.reason} | ${e.reasons.join(', ')} | ${e.prosol_code ? `\`${e.prosol_code}\`` : 'none'} | ${e.cost === null ? '' : e.cost.toFixed(2)} | ${e.stock_status || ''} | ${e.map_text} |`);
  } else L.push('None.');
  L.push('');
  const w1cat = build.excluded.filter((e) => e.stage === 'catalog');
  if (w1cat.length) L.push(`Wave-1 codes already left out by the S1 catalogue: ${w1cat.map((e) => `\`${e.sku}\` (${e.reason.replace('catalog:', '')})`).join(', ')}.`, '');
  L.push(`S1 catalogue exclusions (not built, unchanged here): ${Object.entries(build.catalogExcludedByReason).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  L.push(`Rule: a variant builds only with exactly one active distributor product for its code and a cost. Codes the distributor flags discontinued stay out too (G6)${meta.keepProsolDiscontinued ? ' EXCEPT in this run (--keep-prosol-discontinued)' : '; `--keep-prosol-discontinued` puts them back'}.`, '');

  L.push('## Checks', '');
  L.push('| Check | Result |');
  L.push('|---|---|');
  const row = (label, ids) => {
    const n = ids.reduce((a, id) => a + count(id), 0);
    const ex = qa.checks.filter((c) => ids.includes(c.id)).slice(0, 4).map((c) => `${c.sku ? `\`${c.sku}\`` : `\`${c.handle || c.wave || ''}\``} ${c.msg}`).join('; ');
    L.push(`| ${label} | ${n ? `**${n}**: ${ex}${n > 4 ? '; ...' : ''}` : 'PASS (0)'} |`);
  };
  row('Products over 250 variants', ['variants-over-250']);
  row('Products over 3 options', ['options-over-3']);
  row('Option structure (shape, undeclared, unused or empty values, duplicate combinations)', ['option-shape', 'option-value-undeclared', 'option-value-unused', 'option-value-empty', 'duplicate-combination', 'option-names']);
  row('Price not equal to MAP (MAP list Oct 1, 2025 and variants.csv)', ['price-not-map']);
  row('Price vs round(2026 retail x 0.9)', ['price-vs-2026-list']);
  row('Missing cost', ['missing-cost']);
  row(`Margin under ${FLOOR_MARGIN * 100}% at ${DEEPEST_DISCOUNT * 100}% off`, ['margin-floor']);
  row('Missing barcode', ['missing-barcode']);
  row('Barcode fails the GTIN check digit', ['barcode-invalid-gtin']);
  row('Barcode differs from the MAP UPC or the distributor barcode', ['barcode-vs-map', 'barcode-vs-distributor']);
  row('Missing weight', ['missing-weight']);
  row('Suspect weight (full length under 0.15 lb)', ['weight-suspect']);
  row('Duplicate SKUs across products (per wave and final state)', ['duplicate-sku']);
  row('Near-duplicate SKUs across products (slash, dash, space, case)', ['near-duplicate-sku']);
  row('SKU already live on another yourfloors.ca product', ['duplicate-sku-live']);
  row('Near-duplicate of a live SKU on another product', ['near-duplicate-sku-live']);
  row('Handle already live', ['handle-exists-live']);
  row('Forbidden productSet fields (collections, metafields, files, media)', ['forbidden-field']);
  row('Status DRAFT, vendor Schluter, CONTINUE, tracked', ['status', 'vendor', 'inventory-policy', 'not-tracked']);
  row('Tags (pickup-only on lengths only)', ['pickup-tag']);
  row('Text: no distributor name, no en or em dash (title, description, options)', ['text']);
  row('Product type matches products.csv', ['product-type']);
  row('Build consistency', ['build', 'empty-product', 'live-not-checked']);
  L.push('');
  const other = byId(qa.checks.filter((c) => c.level === 'error'));
  if (other.size) {
    L.push('### All errors', '');
    for (const [id, list] of other) for (const c of list) L.push(`- ${id} ${c.wave ? `[${c.wave}]` : ''} ${c.handle ? `\`${c.handle}\`` : ''} ${c.sku ? `\`${c.sku}\`` : ''}: ${c.msg}`);
    L.push('');
  }

  L.push('## Carried forward (not blocking the payloads)', '');
  for (const n of meta.notes) L.push(`- ${n}`);
  L.push('');

  L.push('## Five example payloads', '');
  for (const pl of pickExamples(build.payloads)) L.push(summarizePayload(pl));

  L.push('## Applying (not run; needs Mac\'s go)', '');
  L.push('```');
  L.push('node scripts/trade/build-schluter-catalog.js                      # dry run: payloads, manifest, this report');
  L.push('node scripts/trade/build-schluter-catalog.js --apply --i-have-macs-go --wave=1 [--handle=h1,h2]');
  L.push('```');
  L.push('`--apply` refuses without `--i-have-macs-go` and `--wave`, refuses a wave with QA errors or a payload whose sha256 no longer matches the manifest, and then goes one product at a time: look up the handle; create as DRAFT if absent; otherwise update with the full variant list keeping variant IDs (it refuses if the live product has variants the payload would delete, keeps the live status, merges live tags, and leaves the description alone unless `--refresh-description`). Every step is logged to `data/catalog/apply-log.jsonl`. It stops at the first problem.', '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// --apply planning (pure; the script does the calls)

/** The --apply gate. args: argv array. Returns { ok, wave, handles, refreshDescription, reason }. */
function applyGate(args) {
  const has = (f) => args.includes(`--${f}`);
  const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  if (!has('apply')) return { ok: false, reason: 'not an apply run' };
  if (!has('i-have-macs-go')) return { ok: false, reason: 'REFUSED: --apply needs --i-have-macs-go (Mac\'s explicit go for this wave). Nothing was sent.' };
  const wave = opt('wave');
  if (!WAVES.includes(wave)) return { ok: false, reason: `REFUSED: --apply needs --wave=${WAVES.join('|')}. Nothing was sent.` };
  const handles = opt('handle') ? opt('handle').split(',').map((s) => s.trim()).filter(Boolean) : null;
  return { ok: true, wave, handles, refreshDescription: has('refresh-description'), reason: null };
}

/**
 * Plan one product. live = null (absent) or { id, handle, vendor, status, tags, variantsCount, hasMoreVariants,
 * variants: [{ id, sku, selectedOptions }] }. Returns { action: 'create'|'update'|'refuse', identifier, input,
 * kept, created, errors }.
 */
function planApply(payloadInput, live, { refreshDescription = false } = {}) {
  const input = JSON.parse(JSON.stringify(payloadInput));
  for (const k of FORBIDDEN_INPUT_KEYS) delete input[k];
  if (!live) {
    input.status = 'DRAFT';
    return { action: 'create', identifier: { handle: input.handle }, input, kept: 0, created: input.variants.length, errors: [] };
  }
  const errors = [];
  if (live.vendor !== VENDOR) errors.push(`live product ${live.id} has vendor ${live.vendor}, not ${VENDOR}`);
  if (live.hasMoreVariants || (live.variantsCount || 0) > MAX_VARIANTS) errors.push(`live product has ${live.variantsCount} variants (over ${MAX_VARIANTS}); refusing`);
  const liveBySku = new Map();
  for (const lv of live.variants || []) {
    if (!lv.sku) { errors.push(`live variant ${lv.id} has no SKU`); continue; }
    if (liveBySku.has(lv.sku)) errors.push(`live SKU ${lv.sku} is on two variants`);
    liveBySku.set(lv.sku, lv);
  }
  const payloadSkus = new Set(input.variants.map((v) => v.sku));
  const wouldDelete = [...liveBySku.keys()].filter((s) => !payloadSkus.has(s));
  if (wouldDelete.length) errors.push(`payload would delete ${wouldDelete.length} live variants (${wouldDelete.slice(0, 5).join(', ')}${wouldDelete.length > 5 ? ', ...' : ''}); refusing`);
  let kept = 0;
  for (const v of input.variants) {
    const lv = liveBySku.get(v.sku);
    if (lv) { v.id = lv.id; kept++; }
  }
  delete input.status; // never change a live product's status from here
  input.tags = uniq([...input.tags, ...(live.tags || [])]);
  if (!refreshDescription) delete input.descriptionHtml;
  if (errors.length) return { action: 'refuse', identifier: null, input: null, kept, created: 0, errors };
  return { action: 'update', identifier: { id: live.id }, input, kept, created: input.variants.length - kept, errors };
}

/** Compare the product read back after productSet with what was sent. Returns a list of problems. */
function verifyApplied(sentInput, after, { action }) {
  const out = [];
  if (!after) return ['product not found after productSet'];
  if (after.handle !== sentInput.handle) out.push(`handle is ${after.handle}, expected ${sentInput.handle}`);
  if (action === 'create' && after.status !== 'DRAFT') out.push(`status ${after.status}, expected DRAFT`);
  const liveBySku = new Map((after.variants || []).map((v) => [v.sku, v]));
  if ((after.variants || []).length !== sentInput.variants.length) out.push(`${(after.variants || []).length} variants live, ${sentInput.variants.length} sent`);
  for (const v of sentInput.variants) {
    const lv = liveBySku.get(v.sku);
    if (!lv) { out.push(`${v.sku} missing after productSet`); continue; }
    if (v.id && lv.id !== v.id) out.push(`${v.sku} variant id changed ${v.id} -> ${lv.id}`);
    if (money(lv.price) !== v.price) out.push(`${v.sku} price ${lv.price}, sent ${v.price}`);
    if (lv.barcode !== v.barcode) out.push(`${v.sku} barcode ${lv.barcode}, sent ${v.barcode}`);
    const cost = lv.inventoryItem && lv.inventoryItem.unitCost ? money(lv.inventoryItem.unitCost.amount) : null;
    if (cost !== v.inventoryItem.cost) out.push(`${v.sku} cost ${cost}, sent ${v.inventoryItem.cost}`);
  }
  return out;
}

module.exports = {
  API_VERSION, VENDOR, TYPE_LENGTH, TYPE_ACCESSORY, MAX_VARIANTS, MAX_OPTIONS, WAVES, FLOOR_MARGIN, DEEPEST_DISCOUNT,
  FORBIDDEN_INPUT_KEYS, STORE,
  parseCsv, parseJsonl, money, gtinValid, textProblems, normSku,
  decideVariant, buildVariantInput, buildProductInput, describe, tagsFor, productTypeFor, splitTitle,
  buildCatalog, runQa, renderQa, summarizePayload, pickExamples,
  applyGate, planApply, verifyApplied,
};
