/**
 * Mapping guard — airtight, per-order check that the Prosol code we're about to
 * order matches what the customer actually ordered.
 *
 * The sku-map can be mislabeled (it caused order 701-1443245 to ship a Quart of
 * "Grout Haze Remover" when the customer bought a Pint of "Grout Haze Clean-Up").
 * So we do NOT trust the sku-map's own `product` label. Instead, at staging we
 * compare two independent facts:
 *   - what the customer ordered  = the order line's item name (the channel's title)
 *   - what the mapped code IS     = the SF item description for that prosol_sku
 * If the size BUCKET (pint/quart/gallon/…) or the product differ, HALT to manual
 * review before we buy/PO. Rounding-tolerant so 237ml vs 236ml does NOT trip.
 */

// Coarse size bucket. Named units first (pint/quart/gallon), else volume bucketed
// to the nearest 25ml / 0.1L / 0.1lb so label rounding (237 vs 236) collapses.
function sizeBucket(s) {
  s = String(s || '').toLowerCase();
  if (/\bpint\b|\b4[5-9]\d\s*m?l\b/.test(s)) return 'pint';     // 473ml family
  if (/\bquart\b|\b9[2-5]\d\s*m?l\b/.test(s)) return 'quart';   // 946ml family
  if (/\bgal(lon)?\b|\b3\.7\d\s*l\b|\b378\d\s*ml\b/.test(s)) return 'gallon';
  const ml = s.match(/(\d{2,4})\s*ml\b/); if (ml) return 'ml' + Math.round(Number(ml[1]) / 25) * 25;
  const L = s.match(/(\d+(?:\.\d+)?)\s*l\b/); if (L) return 'L' + (Math.round(Number(L[1]) * 10) / 10);
  const lb = s.match(/(\d+(?:\.\d+)?)\s*lb\b/); if (lb) return 'lb' + (Math.round(Number(lb[1]) * 10) / 10);
  const oz = s.match(/(\d+(?:\.\d+)?)\s*oz\b/); if (oz) return 'oz' + Math.round(Number(oz[1]));
  return null; // size unknown — don't block on it
}

// Significant product words, brand/size noise stripped.
function productTokens(s) {
  return new Set(String(s || '').toLowerCase()
    .replace(/custom building products|aqua\s*mix|mapei|schluter|bostik'?s?|\bthe\b|\bea\b|\bpint\b|\bquart\b|\bgal(lon)?\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 3));
}

/**
 * @returns {{ok:boolean, verified:boolean, reason:string}}
 *   ok=false  -> genuine mismatch, HALT to manual review
 *   verified=false -> couldn't check (missing SF product); allow but flag
 */
function validateMapping(orderItemName, codeProduct) {
  if (!orderItemName || !codeProduct) return { ok: true, verified: false, reason: 'no SF product to verify against' };

  const so = sizeBucket(orderItemName), sc = sizeBucket(codeProduct);
  if (so && sc && so !== sc) return { ok: false, verified: true, reason: `size mismatch — ordered ${so}, code is ${sc}` };

  const A = productTokens(orderItemName), B = productTokens(codeProduct);
  if (A.size && B.size) {
    const inter = [...A].filter((x) => B.has(x)).length;
    const overlap = inter / Math.min(A.size, B.size);
    if (overlap < 0.34) return { ok: false, verified: true, reason: `product mismatch — "${orderItemName}" vs code "${codeProduct}" (overlap ${overlap.toFixed(2)})` };
  }
  return { ok: true, verified: true, reason: 'match' };
}

module.exports = { validateMapping, sizeBucket, productTokens };
