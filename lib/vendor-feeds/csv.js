/**
 * CSV / TSV adapter. Dependency-free parser (handles quotes, embedded commas,
 * CRLF). Column mapping comes from the vendor registry, e.g.:
 *   columns: { sku: "Item #", qty: "Available", description: "Description", status: "Status", unit: "UOM" }
 * Header matching is case-insensitive and whitespace-tolerant. If a column is a
 * number, it's treated as a 0-based index (for headerless vendor dumps).
 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  const pushF = () => { row.push(field); field = ''; };
  const pushR = () => { if (row.length || field.length) { pushF(); rows.push(row); row = []; } };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { pushF(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushR(); i++; continue; }
    field += c; i++;
  }
  pushR();
  return rows;
}

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function parse(content, vendorCfg = {}) {
  const delim = vendorCfg.delimiter || (content.includes('\t') && !content.includes(',') ? '\t' : ',');
  const grid = parseDelimited(content, delim).filter(r => r.some(c => String(c).trim() !== ''));
  if (!grid.length) return [];
  const cols = vendorCfg.columns || {};
  const skipHeader = vendorCfg.headerless !== true;
  const header = grid[0].map(norm);

  const resolveIdx = (spec) => {
    if (spec == null) return -1;
    if (typeof spec === 'number') return spec;             // explicit index
    const want = norm(spec);
    let idx = header.indexOf(want);
    if (idx === -1) idx = header.findIndex(h => h.includes(want)); // fuzzy contains
    return idx;
  };
  const idx = {
    sku: resolveIdx(cols.sku ?? 'sku'),
    qty: resolveIdx(cols.qty ?? 'qty'),
    description: resolveIdx(cols.description ?? 'description'),
    status: resolveIdx(cols.status),
    unit: resolveIdx(cols.unit),
  };
  if (idx.sku === -1) throw new Error(`CSV: could not find SKU column. Headers seen: ${header.join(' | ')}`);

  const dataRows = skipHeader && !vendorCfg.headerless ? grid.slice(1) : grid;
  const out = [];
  for (const r of dataRows) {
    const sku = r[idx.sku];
    if (!sku || !String(sku).trim()) continue;
    out.push({
      vendor_sku: String(sku).trim(),
      qty: idx.qty >= 0 ? r[idx.qty] : null,
      description: idx.description >= 0 ? r[idx.description] : null,
      status: idx.status >= 0 ? r[idx.status] : null,
      unit: idx.unit >= 0 ? r[idx.unit] : null,
    });
  }
  return out;
}

module.exports = { parse, parseDelimited };
