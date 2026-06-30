/**
 * Vendor-feed adapter registry. Routes a raw feed to the right parser and
 * returns normalized rows: [{ vendor_sku, qty, description, status, unit }].
 *
 * Vendor registry lives at data/vendor-feeds/vendors.json:
 *   { "biyork": { name, sf_vendor_name, format, full, columns: {...}, delimiter? } }
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = process.env.VENDOR_REGISTRY_PATH
  || path.join(__dirname, '..', '..', 'data', 'vendor-feeds', 'vendors.json');

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { return {}; }
}
function vendorConfig(vendorKey) {
  const reg = loadRegistry();
  return reg[vendorKey] || null;
}

const TEXT_FORMATS = new Set(['csv', 'tsv', 'edi846']);

/**
 * @param {string} filePath
 * @param {string} format   csv | tsv | edi846 | xlsx | pdf
 * @param {object} vendorCfg
 * @returns {Promise<Array>} normalized rows
 */
async function parseFeed(filePath, format, vendorCfg = {}) {
  const fmt = (format || vendorCfg.format || '').toLowerCase();
  if (!fmt) throw new Error('parseFeed: format required (csv|tsv|edi846|xlsx|pdf)');
  if (TEXT_FORMATS.has(fmt)) {
    const text = fs.readFileSync(filePath, 'utf8');
    if (fmt === 'edi846') return require('./edi846').parse(text);
    return require('./csv').parse(text, vendorCfg); // csv + tsv (delimiter auto/cfg)
  }
  const buf = fs.readFileSync(filePath);
  if (fmt === 'xlsx') return require('./xlsx').parse(buf, vendorCfg);
  if (fmt === 'pdf') return require('./pdf').parse(buf, vendorCfg);
  throw new Error(`Unknown feed format: ${fmt}`);
}

module.exports = { parseFeed, loadRegistry, vendorConfig, REGISTRY_PATH };
