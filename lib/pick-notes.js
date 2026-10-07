// Per-product pick instructions and routing spare (scripts/shipstation/pick-notes.json).
// Read per call so an edit on the Mini takes effect without a restart.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'scripts', 'shipstation', 'pick-notes.json');
const norm = (s) => String(s || '').replace(/[\s/_.-]/g, '').toUpperCase();

function load(file = FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).notes || []; } catch { return []; }
}

function find(code, notes = load()) {
  const c = norm(code);
  return c ? notes.find((n) => (n.codes || []).some((x) => norm(x) === c)) || null : null;
}

/** Unique notes for an order's items (items carry the Prosol/api code in `sku`). */
function notesForItems(items, notes = load()) {
  const out = [];
  for (const i of items || []) {
    const n = find(i && (i.sku || i.prosolSku || i.apiSku), notes);
    if (n && n.note && !out.includes(n.note)) out.push(n.note);
  }
  return out;
}

/** Units a branch must hold beyond the order quantity before routing prefers it. */
function spareFor(code, notes = load()) {
  const n = find(code, notes);
  return n && Number.isFinite(Number(n.min_spare)) ? Number(n.min_spare) : 1;
}

module.exports = { load, find, notesForItems, spareFor, FILE };
