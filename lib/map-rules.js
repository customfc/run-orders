/**
 * MAP-aware pricing rule engine.
 *
 * Given an ASIN's Buy Box state + our offer + the MAP floor, returns the
 * correct action. Never auto-recommends pricing below MAP for any brand
 * where map_enforced is true.
 *
 * Current coverage:
 *   schluter — strict MAP (CAD floor list, effective 2025-10-01). Breaking it
 *              risks Prosol distributor relationship, not just Amazon warnings.
 *   (other brands — not yet modeled; returns 'no-map-rule')
 *
 * Action codes returned:
 *   match              — safe to reprice down to BB – $0.01 (above MAP, above margin floor)
 *   hold-at-map        — BB competitor is below our MAP; holding at MAP, BB loss accepted
 *   hold-at-floor      — BB is below our margin floor; holding at floor
 *   violation-by-us    — our current price is below MAP (informational — repricer will not act)
 *   competitor-below-map — a competitor is below MAP; flagged for reporting to Schluter
 *   override-allowed   — SKU flagged for manual override (thermostats); repricer stays out
 *   sole-offer         — we're the only offer; no action needed
 *   no-competition     — no Buy Box being contested
 *   missing-map        — brand is MAP-enforced but we don't have a MAP record for this ASIN
 *   no-map-rule        — brand not MAP-enforced (or unknown brand)
 */

// ── Brand rule config ───────────────────────────────────────────────────────

const BRAND_RULES = {
  schluter: {
    map_enforced: true,
    strictness: 'high',
    notes: 'Breaking MAP risks Prosol distributor relationship. Report competitor violators to Schluter.',
    violation_reporting_email: 'imap@schluter.ca', // user to confirm / update
  },
  bona: { map_enforced: false, notes: 'Not modeled yet — treat as no-map-rule' },
  aquamix: { map_enforced: false, notes: 'Not modeled yet' },
  'perfect level master': { map_enforced: false },
};

function getBrandRule(brand) {
  if (!brand) return null;
  return BRAND_RULES[brand.toLowerCase()] || null;
}

// ── Margin floor helper ─────────────────────────────────────────────────────
//
// Cost-based floor. If unit_cost isn't set, we fall back to a conservative
// heuristic (0.6 × MAP) until the optimizer has real cost data in sku-map.json.

function marginFloor(skuEntry, mapEntry, opts = {}) {
  const targetMarginPct = opts.targetMarginPct ?? 0.10; // 10% minimum margin
  const unitCost = Number(skuEntry?.unit_cost || 0);
  if (unitCost > 0) {
    // Rough: cost × (1 + referral_pct + fba_fee_fraction + margin)
    const referralPct = Number(skuEntry?.referral_pct || 0.15);
    const fbaFee = Number(skuEntry?.fba_fulfillment_fee || 3);
    return Number(((unitCost + fbaFee) / (1 - referralPct - targetMarginPct)).toFixed(2));
  }
  // Fallback: 60% of MAP is our absolute floor when cost unknown
  if (mapEntry && mapEntry.mapCad) return Number((mapEntry.mapCad * 0.6).toFixed(2));
  return null;
}

// ── Core evaluator ──────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.asin
 * @param {object} args.skuEntry       – entry from sku-map.json (may include map_cad, map_override_allowed, brand, unit_cost, etc.)
 * @param {object} args.buyBoxSummary  – summarizeOffers() output (buyBoxPrice, buyBoxSellerId, buyBoxIsUs, ourPrice, …)
 * @returns {object}                   – { action, reason, recommendedPrice, floor, gap, violationDetails }
 */
function evaluate({ asin, skuEntry, buyBoxSummary }) {
  const brand = (skuEntry?.brand || '').toLowerCase();
  const rule = getBrandRule(brand);
  const map = skuEntry?.map_cad ? { mapCad: Number(skuEntry.map_cad) } : null;
  const floor = marginFloor(skuEntry, map);
  const out = {
    asin,
    brand: brand || null,
    mapCad: map?.mapCad ?? null,
    marginFloor: floor,
    ourPrice: buyBoxSummary?.ourPrice ?? null,
    buyBoxPrice: buyBoxSummary?.buyBoxPrice ?? null,
    buyBoxIsUs: buyBoxSummary?.buyBoxIsUs ?? false,
    buyBoxSellerId: buyBoxSummary?.buyBoxSellerId ?? null,
    action: null,
    reason: null,
    recommendedPrice: null,
    gap: null,
    violationDetails: null,
  };

  // Sole-offer / no-competition
  if (!buyBoxSummary || buyBoxSummary.offerCount <= 1) {
    out.action = 'sole-offer';
    out.reason = 'We are the only offer';
    return out;
  }
  if (!buyBoxSummary.buyBoxSellerId) {
    out.action = 'no-competition';
    out.reason = 'No Buy Box winner';
    return out;
  }
  if (buyBoxSummary.buyBoxIsUs) {
    out.action = 'sole-offer';
    out.reason = 'We already own the Buy Box';
    return out;
  }

  // We have a competitor owning BB. Now apply brand rules.
  if (!rule || !rule.map_enforced) {
    // Free-to-reprice territory (modulo margin floor)
    const target = Math.max(floor || 0, (buyBoxSummary.buyBoxPrice || 0) - 0.01);
    if (floor && target <= floor + 0.0001) {
      out.action = 'hold-at-floor';
      out.reason = 'Buy Box is at or below our margin floor';
      out.recommendedPrice = floor;
    } else {
      out.action = 'match';
      out.reason = 'No MAP enforced for this brand';
      out.recommendedPrice = Number(target.toFixed(2));
      out.gap = buyBoxSummary.ourPrice != null ? Number((buyBoxSummary.ourPrice - target).toFixed(2)) : null;
    }
    return out;
  }

  // Brand is MAP-enforced. Need MAP data.
  if (!map) {
    out.action = 'missing-map';
    out.reason = `Brand ${brand} is MAP-enforced but no map_cad for this ASIN`;
    return out;
  }

  // Override flag — user has flagged this SKU for manual handling (e.g. thermostats)
  if (skuEntry.map_override_allowed) {
    out.action = 'override-allowed';
    out.reason = skuEntry.map_override_reason || 'Manual override — repricer stays out';
    return out;
  }

  // Are WE violating MAP right now?
  if (buyBoxSummary.ourPrice != null && buyBoxSummary.ourPrice < map.mapCad - 0.01) {
    out.action = 'violation-by-us';
    out.reason = `Our price $${buyBoxSummary.ourPrice.toFixed(2)} is below MAP $${map.mapCad.toFixed(2)}`;
    out.recommendedPrice = map.mapCad;
    return out;
  }

  // Is the BB winner violating MAP?
  if (buyBoxSummary.buyBoxPrice != null && buyBoxSummary.buyBoxPrice < map.mapCad - 0.01) {
    out.action = 'competitor-below-map';
    out.reason = `Competitor ${buyBoxSummary.buyBoxSellerId} at $${buyBoxSummary.buyBoxPrice.toFixed(2)} is $${(map.mapCad - buyBoxSummary.buyBoxPrice).toFixed(2)} below MAP`;
    out.recommendedPrice = map.mapCad; // hold at MAP
    out.violationDetails = {
      sellerId: buyBoxSummary.buyBoxSellerId,
      observedPrice: buyBoxSummary.buyBoxPrice,
      mapPrice: map.mapCad,
      amountBelow: Number((map.mapCad - buyBoxSummary.buyBoxPrice).toFixed(2)),
      asin,
      brand,
      reportingEmail: rule.violation_reporting_email,
      observedAt: new Date().toISOString(),
    };
    return out;
  }

  // BB is at or above MAP — safe to match.
  const candidate = Math.max(map.mapCad, (buyBoxSummary.buyBoxPrice || 0) - 0.01);
  if (floor && candidate < floor) {
    out.action = 'hold-at-floor';
    out.reason = 'Match price would be below margin floor';
    out.recommendedPrice = floor;
  } else {
    out.action = 'match';
    out.reason = 'Safe to match — above MAP and margin floor';
    out.recommendedPrice = Number(candidate.toFixed(2));
  }
  out.gap = buyBoxSummary.ourPrice != null ? Number((buyBoxSummary.ourPrice - candidate).toFixed(2)) : null;
  return out;
}

// ── Batch evaluate all rows in a snapshot ───────────────────────────────────

function evaluateSnapshot(rows) {
  return rows.map((row) => {
    const decision = evaluate({
      asin: row.asin,
      skuEntry: row._skuEntry || row, // rows may carry skuEntry fields inline
      buyBoxSummary: row.bb,
    });
    return { ...row, mapDecision: decision };
  });
}

module.exports = { evaluate, evaluateSnapshot, getBrandRule, BRAND_RULES, marginFloor };
