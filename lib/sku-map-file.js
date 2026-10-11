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

/** JSON text with every non-ASCII character as a \u escape, like the rest of sku-map.json. */
function asciiJson(value, indent) {
  const json = JSON.stringify(value, null, 2).split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n');
  return json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Index just past the JSON value that starts at s[i] (object, array, string or literal). */
function jsonValueEnd(s, i) {
  const c = s[i];
  if (c === '{' || c === '[') {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return j + 1; }
    }
    throw new Error('unterminated JSON value');
  }
  if (c === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  const m = /^[^,\n}\]]+/.exec(s.slice(i));
  if (!m) throw new Error(`no JSON value at ${i}`);
  return i + m[0].length;
}

/**
 * Insert or replace one entry of "mappings", leaving every other byte of the file alone. A new key goes at the top
 * of "mappings", where /map and the sku-resolver put theirs. Writes nothing and throws if the result is not valid
 * JSON or anything other than that one entry changed.
 */
function writeEntry(key, entry, file = SKU_MAP_FILE) {
  const raw = fs.readFileSync(file, 'utf8');
  const before = JSON.parse(raw);
  const anchor = '  "mappings": {\n';
  const open = raw.indexOf(anchor);
  if (open < 0) throw new Error('mappings anchor not found in sku-map.json');
  const objStart = open + anchor.length - 2; // the "{"
  const objEnd = jsonValueEnd(raw, objStart);
  const keyText = `\n    ${asciiJson(key, '')}: `;
  const exists = Object.prototype.hasOwnProperty.call(before.mappings || {}, key);
  const value = asciiJson(entry, '    ');
  let out;
  if (exists) {
    const at = raw.indexOf(keyText, objStart);
    if (at < 0 || at > objEnd) throw new Error(`could not find "${key}" at the top level of mappings`);
    const valStart = at + keyText.length;
    out = raw.slice(0, valStart) + value + raw.slice(jsonValueEnd(raw, valStart));
  } else {
    const insertAt = open + anchor.length;
    out = raw.slice(0, insertAt) + `    ${asciiJson(key, '')}: ${value},\n` + raw.slice(insertAt);
  }
  const after = JSON.parse(out);
  if (JSON.stringify(after.mappings[key]) !== JSON.stringify(entry)) throw new Error(`writeEntry: "${key}" did not round-trip`);
  const without = (o) => { const c = { ...o, mappings: { ...o.mappings } }; delete c.mappings[key]; return JSON.stringify(c); };
  if (without(before) !== without(after)) throw new Error(`writeEntry: writing "${key}" would change other entries`);
  fs.writeFileSync(file, out);
  cache.delete(file);
  return { replaced: exists };
}

module.exports = { readSkuMap, writeEntry, SKU_MAP_FILE };
