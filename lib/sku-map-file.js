'use strict';
/**
 * sku-map.json as it is on disk right now.
 *
 * require() and module-level reads freeze the map at server start, so a mapping
 * written mid-run (sku-resolver's auto-map, /map) stayed invisible to the PO
 * gates. SKU 4657 was auto-mapped to Sechelt at 07:03 ET and #1409 still got a
 * Prosol PO, because the gate treats an unknown SKU as Prosol-eligible
 * (PO-17244, 2026-10-05). The file is ~1.3 MB, so it is re-parsed only when its
 * mtime changes.
 */
const fs = require('fs');
const path = require('path');

const SKU_MAP_FILE = path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json');
const cache = new Map(); // file -> { mtimeMs, map }

function readSkuMap(file = SKU_MAP_FILE) {
  const { mtimeMs } = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.map;
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(file, { mtimeMs, map });
  return map;
}

module.exports = { readSkuMap, SKU_MAP_FILE };
