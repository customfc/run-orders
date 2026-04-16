/**
 * Package splitter — decides how to split an order's line items into
 * physical packages before label-buying.
 *
 * Driven by `package_shape` tags in scripts/shipstation/sku-map.json:
 *  - "roll_kerdi":  KERDI waterproofing rolls, up to max_per_pkg (5) per box
 *  - "heat_sheet":  DITRA-HEAT / DUO / PS sheets, up to max_pkg_weight_lb (50) per box
 *  - "solo":        Ships alone — qty N → N separate packages
 *  - (default):     Combines with other default items into a single box
 *
 * Output: array of packages, each {items:[{sku,name,qty,unitWeight}], totalWeight}.
 * An order with no split-worthy items returns a single package containing all items.
 */

const path = require('path');

let SKU_MAP;
function loadSkuMap() {
  if (!SKU_MAP) SKU_MAP = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'));
  return SKU_MAP;
}

function shapeOf(sku, skuMap) {
  const mappings = (skuMap || loadSkuMap()).mappings || {};
  const entry = mappings[String(sku || '')];
  if (!entry || typeof entry === 'string') return null;
  return {
    shape: entry.package_shape || null,
    maxPerPkg: Number.isFinite(entry.max_per_pkg) ? entry.max_per_pkg : null,
    maxPkgWeightLb: Number.isFinite(entry.max_pkg_weight_lb) ? entry.max_pkg_weight_lb : null,
  };
}

// Normalize ShipStation item weight to pounds. Items use {value, units}.
function itemWeightLb(item) {
  const w = item && item.weight;
  if (!w || !Number.isFinite(Number(w.value))) return null;
  const v = Number(w.value);
  const u = String(w.units || '').toLowerCase();
  if (u === 'pounds' || u === 'lb' || u === 'lbs') return v;
  if (u === 'ounces' || u === 'oz') return v / 16;
  if (u === 'grams' || u === 'g') return v / 453.592;
  if (u === 'kilograms' || u === 'kg') return v * 2.20462;
  return v; // unknown unit — treat as pounds
}

/**
 * Split an order's items into shipment packages.
 *
 * @param {Array} items       ShipStation order items: [{sku,name,quantity,weight:{value,units}}]
 * @param {Object} [orderWeight] Fallback order weight {value,units} if items missing weight
 * @param {Object} [skuMap]   Override sku-map for tests
 * @returns {Array<{items:Array, totalWeight:{value,units}, shape:string|null}>}
 */
function planPackages(items, orderWeight, skuMap) {
  const map = skuMap || loadSkuMap();
  const rows = (items || []).filter((i) => i && Number(i.quantity) > 0);
  if (!rows.length) {
    return [{ items: [], totalWeight: orderWeight || { value: 1, units: 'pounds' }, shape: null }];
  }

  // Compute per-item unit weight (lb). Fallback: order weight / total qty.
  const totalQty = rows.reduce((s, i) => s + Number(i.quantity || 0), 0);
  const fallbackUnitLb = (() => {
    const total = orderWeight && Number.isFinite(Number(orderWeight.value)) ? itemWeightLb({ weight: orderWeight }) || 1 : 1;
    return totalQty > 0 ? total / totalQty : 1;
  })();

  // Expand each item into unit-level entries for bin-packing, annotated with shape.
  const units = [];
  for (const item of rows) {
    const unitLb = itemWeightLb(item) ?? fallbackUnitLb;
    const classification = shapeOf(item.sku, map) || { shape: null, maxPerPkg: null, maxPkgWeightLb: null };
    const qty = Math.floor(Number(item.quantity));
    for (let i = 0; i < qty; i++) {
      units.push({
        sku: item.sku,
        name: item.name,
        unitLb,
        shape: classification.shape,
        maxPerPkg: classification.maxPerPkg,
        maxPkgWeightLb: classification.maxPkgWeightLb,
      });
    }
  }

  const packages = [];

  // Solo: each unit its own package
  const solos = units.filter((u) => u.shape === 'solo');
  for (const u of solos) {
    packages.push({
      items: [{ sku: u.sku, name: u.name, quantity: 1 }],
      totalWeight: { value: Number(u.unitLb.toFixed(2)), units: 'pounds' },
      shape: 'solo',
    });
  }

  // roll_kerdi: group together up to max_per_pkg
  const kerdiRolls = units.filter((u) => u.shape === 'roll_kerdi');
  if (kerdiRolls.length) {
    const cap = kerdiRolls[0].maxPerPkg || 5;
    for (let i = 0; i < kerdiRolls.length; i += cap) {
      const batch = kerdiRolls.slice(i, i + cap);
      packages.push({
        items: aggregateItems(batch),
        totalWeight: { value: Number(batch.reduce((s, u) => s + u.unitLb, 0).toFixed(2)), units: 'pounds' },
        shape: 'roll_kerdi',
      });
    }
  }

  // heat_sheet: pack up to max_pkg_weight_lb per package (first-fit decreasing)
  const sheets = units.filter((u) => u.shape === 'heat_sheet').slice().sort((a, b) => b.unitLb - a.unitLb);
  if (sheets.length) {
    const cap = sheets[0].maxPkgWeightLb || 50;
    const bins = [];
    for (const u of sheets) {
      const bin = bins.find((b) => b.weight + u.unitLb <= cap);
      if (bin) {
        bin.units.push(u);
        bin.weight += u.unitLb;
      } else {
        bins.push({ units: [u], weight: u.unitLb });
      }
    }
    for (const bin of bins) {
      packages.push({
        items: aggregateItems(bin.units),
        totalWeight: { value: Number(bin.weight.toFixed(2)), units: 'pounds' },
        shape: 'heat_sheet',
      });
    }
  }

  // Default: everything else → single package
  const defaults = units.filter((u) => !u.shape);
  if (defaults.length) {
    packages.push({
      items: aggregateItems(defaults),
      totalWeight: { value: Math.max(0.1, Number(defaults.reduce((s, u) => s + u.unitLb, 0).toFixed(2))), units: 'pounds' },
      shape: null,
    });
  }

  // No items matched any category (shouldn't happen, but guard): return the original
  // order as a single package so we don't silently drop anything.
  if (!packages.length) {
    return [{
      items: rows.map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity })),
      totalWeight: orderWeight || { value: 1, units: 'pounds' },
      shape: null,
    }];
  }
  return packages;
}

function aggregateItems(units) {
  const bySku = {};
  for (const u of units) {
    if (!bySku[u.sku]) bySku[u.sku] = { sku: u.sku, name: u.name, quantity: 0 };
    bySku[u.sku].quantity += 1;
  }
  return Object.values(bySku);
}

module.exports = { planPackages, shapeOf, itemWeightLb };
