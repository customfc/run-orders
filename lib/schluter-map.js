/**
 * Schluter MAP loader + lookup.
 *
 * Reads data/fba/maps/schluter-map-YYYY-MM-DD.csv (Canadian MAP list).
 * Keys by normalized ITEM# (strips forward slashes, uppercase).
 *
 * Cross-reference:
 *   sku-map.json → entry.prosol_sku → Schluter ITEM# (after normalization)
 *
 * CSV columns:
 *   ITEM#, DESCRIPTION (EN), DESCRIPTION (FR), PRODUCT GROUP 1, Retail Price CAD,
 *   Minimum Advertised Price CAD, UPC, Notes
 */

const fs = require('fs');
const path = require('path');

const MAPS_DIR = path.join(__dirname, '..', 'data', 'fba', 'maps');

function normalizeItem(s) {
  return (s || '').toString().replace(/\s+/g, '').replace(/\//g, '').toUpperCase();
}

function parseCsvLine(line) {
  const out = [];
  let buf = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { buf += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (c === ',' && !inQ) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parsePrice(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function latestCsvPath() {
  if (!fs.existsSync(MAPS_DIR)) return null;
  const files = fs.readdirSync(MAPS_DIR)
    .filter((f) => f.startsWith('schluter-map-') && f.endsWith('.csv'))
    .sort();
  return files.length ? path.join(MAPS_DIR, files[files.length - 1]) : null;
}

function loadMap(csvPath) {
  const p = csvPath || latestCsvPath();
  if (!p) throw new Error('No Schluter MAP CSV found in data/fba/maps/');
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length);

  // Header spans rows 0 (title) and 1 (column names). Data starts row 2.
  const records = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length < 7) continue;
    const [item, descEn, descFr, group, retail, map, upc, notes = ''] = cells;
    if (!item || !item.trim()) continue;
    records.push({
      item: item.trim(),
      itemKey: normalizeItem(item),
      descEn: descEn.trim(),
      group: group.trim(),
      retailCad: parsePrice(retail),
      mapCad: parsePrice(map),
      upc: (upc || '').trim(),
      notes: notes.trim(),
    });
  }

  const byItemKey = new Map();
  const byUpc = new Map();
  for (const r of records) {
    byItemKey.set(r.itemKey, r);
    if (r.upc) byUpc.set(r.upc, r);
  }

  return { path: p, effectiveDate: p.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null, records, byItemKey, byUpc };
}

// Lookup helpers
function findByProsolSku(mapData, prosolSku) {
  if (!prosolSku) return null;
  return mapData.byItemKey.get(normalizeItem(prosolSku)) || null;
}

function findByUpc(mapData, upc) {
  if (!upc) return null;
  return mapData.byUpc.get(upc.trim()) || null;
}

module.exports = { loadMap, findByProsolSku, findByUpc, normalizeItem, latestCsvPath };
