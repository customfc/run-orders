// Shared Schluter DITRA-HEAT-E-HK cable SKU resolver.
//
// Cable model varies by order (voltage + length), so several sku-map entries
// are flagged `UNMAPPED_CABLE` and resolved from the order title at runtime —
// both the cable-only listings and the cable component inside kit bundles
// (e.g. B010MQ7L9O). This logic used to live only in run-orders.js; it now
// also backs the PO path (lib/amazon-po.js) so a shipped kit doesn't push a
// bogus `UNMAPPED_CABLE` line onto a Prosol PO.

// Pull the Schluter cable model straight out of the item title. Amazon titles
// reliably END with the model number (e.g. "…240V, 339.4 Feet - DHEHK240103").
// This is more reliable than sqft parsing since Amazon frequently prints
// "N Feet" (linear cable length) instead of "N sqft" (coverage area).
function extractDhehkSkuFromName(name) {
  const m = String(name || '').match(/\bDHEHK(120|240)(\d{2,3})\b/i);
  if (!m) return null;
  return `DHEHK${m[1]}${m[2]}`;
}

// Resolve a cable SKU from a title. Prefer the explicit model number; fall
// back to a voltage + sqft lookup against the sku-map's `cable_lookup` table.
function extractCableSku(name, cableLookup = {}) {
  const text = String(name || '');
  const direct = extractDhehkSkuFromName(text);
  if (direct) return direct;
  const voltageMatch = text.match(/\b(120|240)\s*v\b/i);
  const sqftMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|square\s*feet|sqft)/i);
  if (!voltageMatch || !sqftMatch) return null;
  const voltage = voltageMatch[1];
  const sqft = sqftMatch[1];
  const table = voltage === '120'
    ? (cableLookup.sqft_to_sku_120v || {})
    : (cableLookup.sqft_to_sku_240v || {});
  return table[sqft] || null;
}

module.exports = { extractDhehkSkuFromName, extractCableSku };
