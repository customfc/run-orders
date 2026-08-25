'use strict';
// Sample line items ("Order a Sample" on yourfloors.ca) are one generic $0
// product; the thing actually requested lives in the line-item properties
// (Shopify `properties[]`, mirrored to ShipStation as `options[]`):
//   { name: 'Sample of', value: 'AquaFix SPC Harmony Evolved — Lily' }
//   { name: '_ref_handle' | ' ref handle', value: 'aquafix-spc-...-lily' }
// Anywhere we print an item name we need to surface that, otherwise the
// dashboard / Telegram / SO just say "Order a Sample" (order 1353, 2026-08-25).

function optionValue(item, wanted) {
  const lists = [item?.options, item?.properties].filter(Array.isArray);
  for (const list of lists) {
    for (const o of list) {
      const name = String(o?.name || '').replace(/[\s_]+/g, ' ').trim().toLowerCase();
      if (name === wanted && o?.value != null && String(o.value).trim()) return String(o.value).trim();
    }
  }
  return null;
}

// Value of the "Sample of" property, or null when the line isn't a sample.
function sampleOf(item) {
  return optionValue(item, 'sample of');
}

// Handle of the product the sample refers to (best effort).
function sampleRefHandle(item) {
  return optionValue(item, 'ref handle');
}

function isSampleItem(item) {
  return Boolean(sampleOf(item)) || /^order a sample$/i.test(String(item?.name || item?.title || '').trim());
}

// Human label for any line: "Sample of X" for samples, else the plain name.
function itemDisplayName(item, fallback) {
  const s = sampleOf(item);
  if (s) return `Sample of ${s}`;
  return item?.name || item?.title || fallback || item?.sku || '?';
}

module.exports = { sampleOf, sampleRefHandle, isSampleItem, itemDisplayName };
