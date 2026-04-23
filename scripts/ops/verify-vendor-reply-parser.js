/**
 * Verify regex parsing of vendor dims + ready-ack replies.
 *
 * Fixtures cover the realistic shapes Kaitlyn / Robyn send — mixed formal
 * and informal prose, with and without units, imperial + metric, various
 * labellings. When a fixture fails, the dashboard fallback is manual entry
 * (no blocker), but we want high regex coverage so users don't see manual
 * entry often.
 *
 * Run: `node scripts/ops/verify-vendor-reply-parser.js`
 */

const assert = require('assert');
const parser = require('../../lib/vendor-reply-parser');

const failures = [];
let passed = 0;

function check(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.error(`✗ ${name}: ${e.message}`); }
}

// ── parseDims scenarios ───────────────────────────────────────────────────

check('dims: full formal reply — labelled L/W/H + lb + carton count', () => {
  const body = `Hi Mac,\n\nConfirmed stock, will be ready tomorrow. 20 cartons total. L: 24 W: 18 H: 12, 38 lb each.\n\nKaitlyn`;
  const r = parser.parseDims(body);
  assert.deepStrictEqual(
    { count: r.count, L: r.L, W: r.W, H: r.H, weightLb: r.weightLb },
    { count: 20, L: 24, W: 18, H: 12, weightLb: 38 },
  );
  assert.strictEqual(r.parseConfidence, 1);
});

check('dims: × separator + inches quote', () => {
  const body = `Ready Wed. 15 boxes, 24" × 18" × 12", ~42 lbs per box.`;
  const r = parser.parseDims(body);
  assert.strictEqual(r.count, 15);
  assert.strictEqual(r.L, 24);
  assert.strictEqual(r.W, 18);
  assert.strictEqual(r.H, 12);
  assert.strictEqual(r.weightLb, 42);
});

check('dims: lowercase x + "pcs" + "pounds"', () => {
  const body = `all good. 8 pcs at 30x24x18, 55 pounds each`;
  const r = parser.parseDims(body);
  assert.strictEqual(r.count, 8);
  assert.strictEqual(r.L, 30);
  assert.strictEqual(r.weightLb, 55);
});

check('dims: metric — cm and kg conversion', () => {
  const body = `Ready. 20 cartons, 61 × 46 × 30 cm, 17 kg each.`;
  const r = parser.parseDims(body);
  assert.strictEqual(r.count, 20);
  // 61 cm = 24.02 in, 46 cm = 18.11 in, 30 cm = 11.81 in
  assert.ok(Math.abs(r.L - 24.02) < 0.1);
  assert.ok(Math.abs(r.W - 18.11) < 0.1);
  assert.ok(Math.abs(r.H - 11.81) < 0.1);
  // 17 kg = 37.48 lb
  assert.ok(Math.abs(r.weightLb - 37.48) < 0.1);
  assert.strictEqual(r.dimsOriginalUnit, 'cm');
  assert.strictEqual(r.weightOriginalUnit, 'kg');
});

check('dims: partial — only dims, no count or weight → lower confidence', () => {
  const body = `Dims are 24×18×12.`;
  const r = parser.parseDims(body);
  assert.strictEqual(r.L, 24);
  assert.strictEqual(r.count, null);
  assert.strictEqual(r.weightLb, null);
  assert.ok(r.parseConfidence < 0.8, 'partial → sub-0.8 confidence');
});

check('dims: nothing parseable → null', () => {
  const body = `Hi Mac, working on it. I'll get back to you tomorrow.`;
  const r = parser.parseDims(body);
  assert.strictEqual(r, null);
});

check('dims: total + of cartons phrasing', () => {
  const body = `Total of 12 cartons. Each 20x14x10, 25 lb.`;
  const r = parser.parseDims(body);
  assert.strictEqual(r.count, 12);
  assert.strictEqual(r.L, 20);
});

// ── parseReadyAck scenarios ───────────────────────────────────────────────

check('ack: "ready to ship" strong match', () => {
  const body = `All packed and ready to ship.`;
  const r = parser.parseReadyAck(body);
  assert.strictEqual(r.ready, true);
  assert.ok(r.parseConfidence >= 0.9);
});

check('ack: "order is ready"', () => {
  const body = `Order is ready whenever you want to book pickup.`;
  const r = parser.parseReadyAck(body);
  assert.strictEqual(r.ready, true);
  assert.ok(r.parseConfidence >= 0.9);
});

check('ack: bare "ready" in a short reply', () => {
  const body = `ready`;
  const r = parser.parseReadyAck(body);
  assert.strictEqual(r.ready, true);
});

check('ack: future tense — explicitly NOT ready', () => {
  const body = `Will be ready Thursday.`;
  const r = parser.parseReadyAck(body);
  assert.strictEqual(r.ready, false);
});

check('ack: "not ready yet" → false', () => {
  const body = `Not yet ready, Thursday AM.`;
  const r = parser.parseReadyAck(body);
  assert.strictEqual(r.ready, false);
});

check('ack: dims reply — not a ready-ack yet', () => {
  const body = `20 cartons, 24x18x12, 38 lb. Should be ready Thurs.`;
  const r = parser.parseReadyAck(body);
  assert.strictEqual(r.ready, false, '"should be ready Thurs" is future-tense');
});

// ── matchPoFromSubject ─────────────────────────────────────────────────────

check('subject match: PO in FBA subject', () => {
  assert.strictEqual(parser.matchPoFromSubject('Re: FBA Replenishment PO-14502 — dims + ETA'), 'PO-14502');
});

check('subject match: no PO → null', () => {
  assert.strictEqual(parser.matchPoFromSubject('Re: an unrelated email'), null);
});

// ── Summary ──────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} FAIL(s), ${passed} pass`);
  process.exit(1);
}
console.log(`\n${passed} scenarios passed.`);
process.exit(0);
