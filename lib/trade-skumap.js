/**
 * sku-map entries for the Schluter profile catalogue (02 task B.2, research/2026-09-28-prozone-build/run-orders.md).
 * Pure: the CLI is scripts/trade/premap-schluter.js.
 *
 * One entry per catalogue variant, keyed by the Shopify SKU (the Schluter code with its slashes):
 *   api_sku     Prosol's code as its stock lookup matched it (refresh JSONL prosol_code)
 *   prosol_sku  the PO code from Prosol's own record, never our SKU with the slashes stripped (about 1,045 differ)
 *   ship_mode   "pickup_only" for full lengths (lib/trade-pickup-only.js refuses a label), "ship" for accessories
 *   source      catalog-schluter-<date>: run-orders skips the Salesforce name guard for these (validated here)
 *
 * The entries live in one block at the END of "mappings", between two marker keys. /map inserts at the top, so the
 * block never collides with live edits, and a re-run replaces the block in place. A key that already exists outside
 * the block is never overwritten (curated entries win). The file is edited as text: a JSON rewrite would reorder the
 * integer-like keys.
 */

'use strict';

const CATALOG_SOURCE = 'catalog-schluter';
const START_KEY = '_section_schluter_profiles_catalog';
const END_KEY = '_section_schluter_profiles_catalog_end';

function isCatalogEntry(entry) {
  return !!entry && typeof entry === 'object' && typeof entry.source === 'string' && entry.source.startsWith(CATALOG_SOURCE);
}

/** Same pattern as run-orders.js extractTrailingSku: a title ending in a code-like token gets checked against the map. */
function trailingSku(name) {
  const m = String(name || '').trim().match(/[\s\-,]\s*([A-Z][A-Z0-9/\-]{4,30})\s*$/);
  if (!m) return null;
  const sku = m[1].replace(/[\-/]$/, '');
  return sku.length >= 5 && /[A-Z]/.test(sku) && /\d/.test(sku) ? sku : null;
}

/**
 * v: manifest variants[] row. meta: { mapText, date, mapEffective }. Returns { entry, problems }.
 */
function buildEntry(v, meta) {
  const problems = [];
  if (!v.prosol_code) problems.push('no Prosol code');
  if (!v.po_code) problems.push('no PO code');
  if (!(Number(v.cost) > 0)) problems.push('no cost');
  if (!(Number(v.map_price) > 0)) problems.push('no MAP price');
  if (!['pickup_only', 'ship'].includes(v.delivery)) problems.push(`delivery "${v.delivery}"`);
  const entry = {
    api_sku: v.prosol_code,
    prosol_sku: v.po_code,
    ...(v.prosol_product_id ? { prosol_product_id: v.prosol_product_id } : {}),
    product: `Schluter ${meta.mapText || v.sku}`.trim(),
    category: 'SCHLUTER-PROFILE',
    brand: 'schluter',
    schluter_item: v.sku,
    cost_cad: Number(v.cost),
    cost_source: 'prosol-offers-loc10010',
    map_cad: Number(v.map_price),
    ...(meta.mapEffective ? { map_effective: meta.mapEffective } : {}),
    ...(v.upc ? { barcode: String(v.upc) } : {}),
    ship_mode: v.delivery,
    shopify_handle: v.handle,
    source: `${CATALOG_SOURCE}-${meta.date}`,
    verified: true,
  };
  return { entry, problems };
}

/** JSON text with every non-ASCII character as a \u escape, like the rest of sku-map.json. */
function asciiJson(value, indent) {
  const json = JSON.stringify(value, null, 2).split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n');
  return json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The block text: the start marker, one entry per key, the end marker. No leading or trailing comma. */
function renderBlock(entries, note) {
  const lines = [`    ${JSON.stringify(START_KEY)}: ${asciiJson(note, '')}`];
  for (const [key, entry] of entries) lines.push(`    ${asciiJson(key, '')}: ${asciiJson(entry, '    ')}`);
  lines.push(`    ${JSON.stringify(END_KEY)}: "=== END SCHLUTER PROFILES CATALOGUE ==="`);
  return lines.join(',\n');
}

/** [start, end) of the existing block in raw, including the comma before it, or null. */
function findBlock(raw) {
  const start = raw.indexOf(`,\n    ${JSON.stringify(START_KEY)}: `);
  if (start === -1) return null;
  const endMarker = `    ${JSON.stringify(END_KEY)}: `;
  const endAt = raw.indexOf(endMarker, start);
  if (endAt === -1) throw new Error('catalogue block has a start marker but no end marker');
  const lineEnd = raw.indexOf('\n', endAt);
  return [start, lineEnd];
}

/**
 * Put the block into the raw sku-map text: replace the existing block, or append it at the end of "mappings".
 * entries: [[key, entry]]. Keys that exist outside the block are dropped and returned in `skipped`.
 * Returns { text, written: [keys], skipped: [keys] }. Throws if the result isn't valid JSON or anything outside the
 * block changed.
 */
function applyBlock(raw, entries, note) {
  const before = JSON.parse(raw);
  const existing = findBlock(raw);
  const outside = existing ? raw.slice(0, existing[0]) + raw.slice(existing[1]) : raw;
  const outsideKeys = new Set(Object.keys(JSON.parse(outside).mappings || {}));
  const keep = entries.filter(([k]) => !outsideKeys.has(k));
  const skipped = entries.filter(([k]) => outsideKeys.has(k)).map(([k]) => k);
  const block = `,\n${renderBlock(keep, note)}`;
  let text;
  if (existing) {
    text = raw.slice(0, existing[0]) + block + raw.slice(existing[1]);
  } else {
    const open = raw.indexOf('  "mappings": {\n');
    if (open === -1) throw new Error('mappings anchor not found');
    const close = raw.indexOf('\n  },\n  "', open);
    if (close === -1) throw new Error('end of mappings not found');
    text = raw.slice(0, close) + block + raw.slice(close);
  }
  const after = JSON.parse(text);
  for (const top of Object.keys(before)) {
    if (top !== 'mappings' && JSON.stringify(before[top]) !== JSON.stringify(after[top])) throw new Error(`top-level "${top}" changed`);
  }
  for (const [k, v] of Object.entries(before.mappings)) {
    if (!outsideKeys.has(k)) continue; // it was inside the old block: replaced or dropped on purpose
    if (JSON.stringify(after.mappings[k]) !== JSON.stringify(v)) throw new Error(`mapping "${k}" outside the block changed`);
  }
  if (Object.keys(after.mappings).length !== outsideKeys.size + keep.length + 2) throw new Error('unexpected key count after writing the block');
  for (const [k, v] of keep) {
    if (JSON.stringify(after.mappings[k]) !== JSON.stringify(v)) throw new Error(`entry "${k}" did not land as written`);
  }
  return { text, written: keep.map(([k]) => k), skipped };
}

module.exports = { CATALOG_SOURCE, START_KEY, END_KEY, isCatalogEntry, trailingSku, buildEntry, renderBlock, findBlock, applyBlock };
