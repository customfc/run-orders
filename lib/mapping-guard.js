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
 * If the size or the product differ, HALT to manual review before we buy/PO.
 *
 * Sizes are compared in canonical units, NOT as raw text — Amazon titles say
 * "32 oz" where Prosol says "1 Quart (946ml)" for the same jug, and "10.1 oz"
 * where Prosol says "299 mL". Bare "oz" is ambiguous (fluid vs weight), so it
 * resolves against whatever unit the OTHER side used: vs ml/L/pint/quart/gallon
 * it's fluid oz; vs lb/kg it's weight oz. Volume-vs-weight pairs stay a HALT —
 * we can't verify equivalence, and unverified is how 701-1443245 happened.
 */

const OZ_TO_ML = 29.5735; // US fluid ounce
const OZ_TO_LB = 1 / 16;  // avoirdupois ounce

// Parse a size mention into a comparable measure:
//   { kind: 'volume', ml }  |  { kind: 'weight', lb }  |  { kind: 'oz', oz }
// null = no size found — don't block on it.
function parseSize(s) {
  s = String(s || '').toLowerCase();
  if (/\bpint\b/.test(s)) return { kind: 'volume', ml: 473 };
  if (/\bquart\b/.test(s)) return { kind: 'volume', ml: 946 };
  if (/\bgal(lon)?\b/.test(s)) return { kind: 'volume', ml: 3785 };
  const ml = s.match(/(\d{2,4}(?:\.\d+)?)\s*m\s*l\b/); if (ml) return { kind: 'volume', ml: Number(ml[1]) };
  const L = s.match(/(\d+(?:\.\d+)?)\s*l(?:iter|itre)?s?\b/); if (L) return { kind: 'volume', ml: Number(L[1]) * 1000 };
  const lb = s.match(/(\d+(?:\.\d+)?)\s*(?:lb|pound)s?\b/); if (lb) return { kind: 'weight', lb: Number(lb[1]) };
  const kg = s.match(/(\d+(?:\.\d+)?)\s*kg\b/); if (kg) return { kind: 'weight', lb: Number(kg[1]) * 2.20462 };
  const oz = s.match(/(\d+(?:\.\d+)?)\s*oz\b/); if (oz) return { kind: 'oz', oz: Number(oz[1]) };
  return null;
}

function describeSize(p) {
  if (!p) return '?';
  if (p.kind === 'volume') return `${Math.round(p.ml)}ml`;
  if (p.kind === 'weight') return `${Math.round(p.lb * 10) / 10}lb`;
  return `${p.oz}oz`;
}

// true = same size, false = different size, null = incomparable (volume vs weight).
// Tolerance is 6% relative (label rounding families: 450ml "pint", 3.78L "gallon")
// or a small absolute slack (237 vs 236ml style).
function sizesMatch(a, b) {
  const rel = (x, y) => Math.abs(x - y) / Math.max(x, y);
  if (a.kind === 'oz' && b.kind === 'oz') return rel(a.oz, b.oz) <= 0.06;
  if (a.kind !== 'weight' && b.kind !== 'weight') {
    const volA = a.kind === 'volume' ? a.ml : a.oz * OZ_TO_ML;
    const volB = b.kind === 'volume' ? b.ml : b.oz * OZ_TO_ML;
    return rel(volA, volB) <= 0.06 || Math.abs(volA - volB) <= 30;
  }
  if (a.kind !== 'volume' && b.kind !== 'volume') {
    const wA = a.kind === 'weight' ? a.lb : a.oz * OZ_TO_LB;
    const wB = b.kind === 'weight' ? b.lb : b.oz * OZ_TO_LB;
    return rel(wA, wB) <= 0.06 || Math.abs(wA - wB) <= 0.1;
  }
  return null; // one side volume, other weight — can't verify equivalence
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

  const so = parseSize(orderItemName), sc = parseSize(codeProduct);
  if (so && sc) {
    const match = sizesMatch(so, sc);
    if (match === false) return { ok: false, verified: true, reason: `size mismatch — ordered ${describeSize(so)}, code is ${describeSize(sc)}` };
    if (match === null) return { ok: false, verified: true, reason: `size units incomparable — ordered ${describeSize(so)}, code is ${describeSize(sc)}` };
  }

  const A = productTokens(orderItemName), B = productTokens(codeProduct);
  if (A.size && B.size) {
    const inter = [...A].filter((x) => B.has(x)).length;
    const overlap = inter / Math.min(A.size, B.size);
    if (overlap < 0.34) return { ok: false, verified: true, reason: `product mismatch — "${orderItemName}" vs code "${codeProduct}" (overlap ${overlap.toFixed(2)})` };
  }
  return { ok: true, verified: true, reason: 'match' };
}

module.exports = { validateMapping, parseSize, sizesMatch, productTokens };
