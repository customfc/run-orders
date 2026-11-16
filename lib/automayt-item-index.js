'use strict';
/**
 * Every Automayt item, kept on disk, so a code Automayt's lookup can't see is
 * still found. Automayt's 11-02 import filed some products under another
 * vendor's code with the maker's code only in the description (Mapesil T Plus
 * under Dal-Tile 9999xxxxxx, #1468 → PRD-031853; #1473, #1475 on 11-16).
 * /items/batch-lookup matches vendor_code / item_number only, and auto-create
 * then hits "409 duplicate: An item already carries this code", so the PO was
 * left off. GET /items ignores every filter, so the only search is a full scan:
 * about 220 pages of 200, ~20 min, run nightly (scripts/automayt-item-index.js).
 *
 * findHidden(codes) → the live items whose description, sku, colour, aliases or
 * codes carry one of the codes as a whole word. The caller hands them to
 * automayt-settle.pickAmbiguous, which picks (alone, or by Opus among several),
 * checks the mapping guard against the order title, and pins the pick on the
 * sku-map entry so the next order never searches again.
 *
 * Fails open: no index, an unreadable index or a failed live read → [] and the
 * order flow does what it did before.
 */
const fs = require('fs');
const path = require('path');

const INDEX_FILE = process.env.AUTOMAYT_ITEM_INDEX_FILE || path.join(__dirname, '..', 'data', 'automayt-items-index.json');
const MAX_CANDIDATES = 5; // more than this and the code is too generic to trust

const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-/]/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let cache = { mtimeMs: 0, items: null };
function load() {
  let st;
  try { st = fs.statSync(INDEX_FILE); } catch { return null; }
  if (cache.items && cache.mtimeMs === st.mtimeMs) return cache.items;
  try {
    const items = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).items;
    if (!Array.isArray(items)) return null;
    cache = { mtimeMs: st.mtimeMs, items };
    return items;
  } catch (e) {
    console.warn(`[automayt-item-index] unreadable ${INDEX_FILE}: ${e.message}`);
    return null;
  }
}

/** The text a code can hide in. */
function haystack(item) {
  const aliases = (item.aliases || []).map((a) => (a && typeof a === 'object' ? (a.code || a.value || a.alias || '') : a));
  return [item.description, item.sku, item.color, item.vendor_code, item.item_number, ...aliases]
    .filter(Boolean).join(' ').toUpperCase();
}

/** True when text carries code as a whole word, as written or with its - / spaces dropped. */
function carries(text, code) {
  const raw = String(code || '').toUpperCase().trim();
  // A code, not a word: "REUSABLE" (a title-derived own-stock code) would match any description.
  if (raw.length < 4 || !/\d/.test(raw)) return false;
  if (new RegExp(`(^|[^A-Z0-9])${esc(raw)}($|[^A-Z0-9])`).test(text)) return true;
  const n = norm(raw);
  return text.split(/[\s,;()"]+/).some((tok) => norm(tok) === n);
}

/** Index rows carrying one of the codes: [{ row, code }], de-duplicated by item. */
function search(codes, items = load()) {
  if (!items) return [];
  const want = [...new Set((codes || []).filter(Boolean).map((c) => String(c).trim()))];
  const hits = new Map();
  for (const row of items) {
    if (!row || !row.id || row.active === false) continue;
    const text = haystack(row);
    const code = want.find((c) => carries(text, c));
    if (code && !hits.has(row.id)) hits.set(row.id, { row, code });
  }
  return [...hits.values()];
}

/**
 * Live Automayt items that carry one of the codes, read fresh (the index may be
 * a day old), inactive ones dropped. Returns { code, candidates } or null.
 */
async function findHidden(codes, { getItem = (id) => require('./automayt-erp').getItem(id), isInactive = (i) => require('./automayt-erp').isInactiveItem(i) } = {}) {
  const hits = search(codes);
  if (!hits.length) return null;
  if (hits.length > MAX_CANDIDATES) {
    console.warn(`[automayt-item-index] ${codes.join('/')} is carried by ${hits.length} items, too many to pick from`);
    return null;
  }
  const candidates = [];
  for (const h of hits) {
    try {
      const item = await getItem(h.row.id);
      if (item && !isInactive(item) && carries(haystack(item), h.code)) candidates.push(item);
    } catch (e) {
      console.warn(`[automayt-item-index] live read ${h.row.id} failed: ${e.message}`);
      return null;
    }
  }
  return candidates.length ? { code: hits[0].code, candidates } : null;
}

/** Full scan → index file. Read-only against Automayt. */
async function rebuild({ log = console.log } = {}) {
  const am = require('./automayt');
  const out = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await am.get(`/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const body = r.data || {};
    for (const i of body.data || []) {
      out.push({
        id: i.id, item_number: i.item_number, vendor_code: i.vendor_code, sku: i.sku,
        description: i.description, color: i.color, aliases: i.aliases, active: i.active,
        vendor: i.default_vendor && i.default_vendor.name, created_at: i.created_at,
      });
    }
    cursor = body.has_more ? body.next_cursor : null;
    if (++pages % 50 === 0) log(`[automayt-item-index] ${pages} pages, ${out.length} items`);
  } while (cursor);
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), items: out }));
  fs.renameSync(tmp, INDEX_FILE);
  return { items: out.length, pages };
}

module.exports = { findHidden, search, carries, rebuild, INDEX_FILE, _resetCache: () => { cache = { mtimeMs: 0, items: null }; } };
