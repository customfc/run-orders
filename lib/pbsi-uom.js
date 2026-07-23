'use strict';

// ── PBSI unit-of-measure → line-quantity conversion ──────────────────────────
//
// Some Schluter roll products (DITRA-HEAT membrane DH512M, DITRA-HEAT-PS
// DHPS512M, DITRA-PS DITRAPS25M, DITRA-HEAT-DUO rolls, …) are stocked, costed
// and priced in Salesforce/PBSI **per square foot**, NOT per roll. A single roll
// is e.g. 134.5 SqFt. Our order feeds (Amazon, Shopify) speak in *rolls*: an
// order for 1 roll arrives as quantity 1.
//
// If the pipeline writes that quantity (1) onto an SqFt-stocked item, PBSI
// records "1 SqFt" for an entire roll — the SO/PO/receipt come out ~134× too
// small in both quantity and dollar value, and inventory never posts correctly.
// Accounting flagged this 2026-07-23 (item 11503, PO-16000/PO-16070).
//
// Fix: when the resolved PBSI item's unit of measure is an AREA unit, convert
// the ordered roll/each count into square feet using the item's coverage
// (sqft per roll). Non-area items pass through unchanged. If an item is area-
// stocked but its coverage can't be resolved, we REFUSE (return an error) so the
// caller routes the order to manual review — we never silently default to qty 1.
//
// See project_area_product_coverage_multiplier.

// PBSI UoM strings that mean "priced/stocked per square foot".
const AREA_UOMS = new Set([
  'sqft', 'sq ft', 'sq. ft', 'sq.ft', 'sf', 'square feet', 'square foot',
]);

function isAreaUom(uom) {
  if (!uom) return false;
  return AREA_UOMS.has(String(uom).trim().toLowerCase());
}

// Parse coverage (sqft per roll/each) from a PBSI item description. Area-roll
// descriptions carry the coverage as "... - 134.5 SqFt" / "(269 sqft)" /
// "108 sq ft". We take the LAST "<number> sq ft" match, since dimension strings
// (e.g. 3' 2-5/8" x 41' 10-3/4") never carry the sq-ft unit and the coverage is
// stated last. Bare "SF" is intentionally NOT matched (too noisy) — an item that
// only says "SF" simply fails to resolve and routes to manual review.
function parseCoverageFromDescription(desc) {
  if (!desc) return null;
  const re = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*feet|square\s*foot)/gi;
  let m, last = null;
  while ((m = re.exec(desc)) !== null) last = m[1];
  if (last == null) return null;
  const n = parseFloat(String(last).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Resolve the quantity to write on SO/PO/receipt lines for one resolved item.
//   uom              — pbsiItem.Unit_of_Measure__c || pbsiItem.PBSI__defaultunitofmeasure__c
//   description      — pbsiItem.PBSI__description__c (coverage source of truth)
//   orderQty         — ordered roll/each count (already × bundle multiplier)
//   coverageOverride — optional explicit sqft/roll from sku-map (coverage_sqft)
//
// Returns:
//   { qty, isArea:false, coverage:1 }                 non-area item, unchanged
//   { qty, isArea:true,  coverage }                   area item, converted to sqft
//   { isArea:true, coverage:null, error }             area item, coverage unknown → caller must halt
function resolveLineQty({ uom, description, orderQty, coverageOverride } = {}) {
  const qty = Number(orderQty) || 0;
  if (!isAreaUom(uom)) return { qty, isArea: false, coverage: 1 };

  const override = Number(coverageOverride);
  const coverage = override > 0 ? override : parseCoverageFromDescription(description);
  if (!coverage) {
    return {
      isArea: true,
      coverage: null,
      error: `item is stocked per "${uom}" but coverage (sqft/roll) could not be resolved`
        + ` from its description — refusing to write qty ${qty} (that would mean ${qty} sqft, not ${qty} roll(s))`,
    };
  }
  return { qty: qty * coverage, isArea: true, coverage };
}

module.exports = { AREA_UOMS, isAreaUom, parseCoverageFromDescription, resolveLineQty };
