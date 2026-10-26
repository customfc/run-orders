"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { planPackages } = require("../../lib/package-split");

// Deterministic sku-map override so tests do not depend on the live map.
const MAP = { mappings: { HEAVY: { package_shape: "solo" } } };

test("discount/promo line (no sku, no weight) is dropped and adds no weight", () => {
  const items = [
    { sku: "HEAVY", quantity: 1, weight: { value: 22700, units: "grams" } }, // 50 lb
    { sku: "SMALL", quantity: 1, weight: { value: 454, units: "grams" } },   // 1 lb
    { sku: "", quantity: 1, weight: null, name: "WELCOME10" },               // discount
  ];
  const pkgs = planPackages(items, { value: 23154, units: "grams" }, MAP);
  assert.strictEqual(pkgs.length, 2, "expected solo heavy + default small");
  const def = pkgs.find((p) => p.shape === null);
  // Default box must contain ONLY the real small item, and weigh ~1 lb — not
  // ~13 lb as when the WELCOME10 line got a phantom fallback weight.
  assert.strictEqual(def.items.length, 1);
  assert.strictEqual(def.items[0].sku, "SMALL");
  assert.ok(def.totalWeight.value < 2, "default box should be ~1 lb, got " + def.totalWeight.value);
});

test("real items with weights combine into one default box (regression)", () => {
  const items = [
    { sku: "A", quantity: 2, weight: { value: 1000, units: "grams" } },
    { sku: "B", quantity: 1, weight: { value: 500, units: "grams" } },
  ];
  const pkgs = planPackages(items, { value: 2500, units: "grams" }, {});
  assert.strictEqual(pkgs.length, 1);
  assert.ok(Math.abs(pkgs[0].totalWeight.value - 5.51) < 0.1);
});

test("order that is only a discount line does not crash", () => {
  const pkgs = planPackages([{ sku: "", quantity: 1, weight: null, name: "PROMO" }], { value: 1, units: "pounds" }, {});
  assert.strictEqual(pkgs.length, 1);
});

test("item with a sku but no weight is kept (uses fallback weight)", () => {
  const items = [{ sku: "REAL", quantity: 1, weight: null }];
  const pkgs = planPackages(items, { value: 5, units: "pounds" }, {});
  assert.strictEqual(pkgs.length, 1);
  assert.strictEqual(pkgs[0].items[0].sku, "REAL");
});

test("no default box over 50 lb: two 38 lb pails ship as two boxes (#1432)", () => {
  const items = [{ sku: "1945616", quantity: 2, weight: { value: 17395, units: "grams" } }];
  const pkgs = planPackages(items, { value: 34790, units: "grams" }, {});
  assert.strictEqual(pkgs.length, 2);
  for (const p of pkgs) {
    assert.strictEqual(p.items[0].quantity, 1);
    assert.ok(Math.abs(p.totalWeight.value - 38.35) < 0.1, "got " + p.totalWeight.value);
  }
});

test("default items pack first-fit up to 50 lb; light items fill the gaps", () => {
  const items = [
    { sku: "PAIL", quantity: 3, weight: { value: 20, units: "pounds" } },
    { sku: "TROWEL", quantity: 2, weight: { value: 2, units: "pounds" } },
  ];
  const pkgs = planPackages(items, { value: 64, units: "pounds" }, {});
  assert.strictEqual(pkgs.length, 2);
  assert.ok(pkgs.every((p) => p.totalWeight.value <= 50));
  assert.strictEqual(pkgs.reduce((s, p) => s + p.totalWeight.value, 0), 64);
});

test("a single unit over 50 lb still gets one box of its own", () => {
  const items = [
    { sku: "CUTTER", quantity: 1, weight: { value: 60, units: "pounds" } },
    { sku: "TROWEL", quantity: 1, weight: { value: 2, units: "pounds" } },
  ];
  const pkgs = planPackages(items, { value: 62, units: "pounds" }, {});
  assert.strictEqual(pkgs.length, 2);
  assert.deepStrictEqual(pkgs.map((p) => p.totalWeight.value).sort((a, b) => a - b), [2, 60]);
});

test("solo multiples with max_per_pkg stop at 50 lb unless the sku sets its own cap", () => {
  const map = { mappings: { CH: { package_shape: "solo", max_per_pkg: 3 } } };
  const items = [{ sku: "CH", quantity: 3, weight: { value: 20, units: "pounds" } }];
  const pkgs = planPackages(items, { value: 60, units: "pounds" }, map);
  assert.strictEqual(pkgs.length, 2);
  assert.ok(pkgs.every((p) => p.totalWeight.value <= 50));
});
