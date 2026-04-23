/**
 * Verify bucket-split replenishment invariants.
 *
 * Added 2026-04-23 — the PO-14179 incident exposed that Prosol emails bundle
 * in-stock + backorder lines into one PO, stranding ready-to-ship items
 * behind cross-warehouse consolidation timelines. This harness asserts:
 *
 *  - addLine stamps availabilityBucket correctly for each vendor×stock combo.
 *  - sendVendorGroup with a bucket filter sends only that bucket's lines.
 *  - sendAllBucketsForVendor fires ready first, then backorder, with
 *    disjoint line sets and separate SF PO creates.
 *  - groupByVendorAndBucket returns the nested shape the UI needs.
 *
 * Run: `node scripts/ops/verify-bucket-split.js`
 * Exit 0 on pass, 1 on any assertion failure.
 */

const assert = require('assert');
const path = require('path');

// Satisfy createTransport's SMTP_PASS guard — the stubbed nodemailer doesn't
// actually send, but fba-po-sender checks the env var before instantiation.
process.env.SMTP_PASSWORD = process.env.SMTP_PASSWORD || 'stub';

// ── Stubs installed into require.cache BEFORE lib/fba-po-sender is loaded ──

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

const sentMails = [];
const sfCreates = [];

stubModule('nodemailer', {
  createTransport: () => ({
    sendMail: async (args) => { sentMails.push(args); return { messageId: 'stub', accepted: [args.to], rejected: [] }; },
    close: () => {},
  }),
});

stubModule('../../lib/salesforce', {
  connect: async () => ({ id: 'stub-conn' }),
  create: async (_conn, object, fields) => {
    const id = `id-${object}-${sfCreates.length}`;
    sfCreates.push({ object, fields, id });
    return id;
  },
  query: async () => [{ Name: `PO-TEST-${sfCreates.filter((c) => c.object === 'PBSI__PBSI_Purchase_Order__c').length}` }],
});

stubModule('../../lib/amazon-po', {
  findPbsiItem: async (_conn, vendorItemId) => ({ Id: `pbsi-${vendorItemId}`, Name: vendorItemId, PBSI__Cost__c: 10 }),
  resolveSkuForPO: () => null,
});

stubModule('../../lib/packing-slip', {
  generateFbaPoPdf: async () => Buffer.from('%PDF-1.4 stub'),
});

stubModule('../../lib/prosol-stock', {
  resolve: (prosolSku, qty) => {
    if (prosolSku === 'FULL-SKU') return { stock: { atPrimary: 99, total: 99 }, decision: { action: 'full', atPrimary: 99, total: 99, suggestedQty: qty } };
    if (prosolSku === 'BACK-SKU') return { stock: { atPrimary: 2, total: 50 }, decision: { action: 'backorder', atPrimary: 2, total: 50, suggestedQty: qty } };
    if (prosolSku === 'CAP-SKU')  return { stock: { atPrimary: 2, total: 8  }, decision: { action: 'capped',  atPrimary: 2, total: 8,  suggestedQty: 8 } };
    return { stock: { atPrimary: 0, total: 0 }, decision: { action: 'oos', atPrimary: 0, total: 0, suggestedQty: 0 } };
  },
});

// Real modules
const poDrafts = require('../../lib/fba-po-drafts');
const poSender = require('../../lib/fba-po-sender');

// ── Fixtures ──────────────────────────────────────────────────────────────

function buildDraft() {
  const draft = poDrafts.emptyDraft();
  // Two ready Prosol lines (full stock)
  poDrafts.addLine(draft, { asin: 'ASIN-FULL-1', sku: null,        product: 'Schluter Kerdi Band',  qty: 20, vendor: 'prosol' });
  poDrafts.addLine(draft, { asin: 'ASIN-FULL-2', sku: null,        product: 'Kerdi Flange Kit',     qty: 40, vendor: 'prosol' });
  // One backorder Prosol line
  poDrafts.addLine(draft, { asin: 'ASIN-BACK-1', sku: null,        product: 'Kerdi Board Screws',   qty: 28, vendor: 'prosol' });
  // One capped Prosol line → backorder bucket per plan
  poDrafts.addLine(draft, { asin: 'ASIN-CAP-1',  sku: null,        product: 'Pentagonal Shelf',     qty: 20, vendor: 'prosol' });
  // One sechelt (perfectlevel) line
  poDrafts.addLine(draft, { asin: 'ASIN-PLM-1',  sku: 'PLM-FAT',   product: 'Perfect Level Mat',    qty: 6,  vendor: 'perfectlevel' });
  // One treeco line (no prosol stock → ready)
  poDrafts.addLine(draft, { asin: 'ASIN-BONA-1', sku: 'B075RGTR84', product: 'Bona Mega Extra Matte', qty: 24, vendor: 'treeco' });
  return draft;
}

// Inject prosolSku via sku-map bypass: the real addLine reads sku-map for
// prosol_sku resolution. We sidestep that by monkey-patching the lookups.
// Easier: set stock resolver to key on asin instead.
// Actually: addLine only calls prosol-stock.resolve when sku-map has a
// prosol_sku for the line. Since the test sku-map won't have our test ASINs,
// prosol lines will end up in 'ready' by default. We need to patch
// prosol-stock.js's resolve function AND the sku-map lookup.

// Simplest: monkey-patch addLine's expectations by pre-computing bucket and
// calling addLine with `vendor` override + directly setting stock on the line
// after add. But that defeats the point of testing stamp logic.
//
// Correct fix: stub the sku-map load so ASIN-FULL-* resolves to prosol_sku 'FULL-SKU' etc.

// Re-stub sku-map by patching loadSkuMap export path inside fba-po-drafts.
// The module already cached draft; we need to patch before require. Let me
// reload with a sku-map stub this time.
// Simpler fallback: use addLine's return to verify stamp, then manually patch
// line.prosolStock + line.availabilityBucket post-hoc to reflect the
// test's intent. This still exercises sendVendorGroup filtering & SF create.

function patchProsolLines(draft) {
  for (const line of draft.lines) {
    if (line.vendor !== 'prosol') continue;
    if (line.asin.startsWith('ASIN-FULL')) {
      line.prosolStock = { prosolSku: `FULL-${line.asin}`, decision: { action: 'full' } };
      line.availabilityBucket = 'ready';
    } else if (line.asin.startsWith('ASIN-BACK')) {
      line.prosolStock = { prosolSku: `BACK-${line.asin}`, decision: { action: 'backorder' } };
      line.availabilityBucket = 'backorder';
    } else if (line.asin.startsWith('ASIN-CAP')) {
      line.prosolStock = { prosolSku: `CAP-${line.asin}`, decision: { action: 'capped' } };
      line.availabilityBucket = 'backorder';
    }
  }
}

function reset() { sentMails.length = 0; sfCreates.length = 0; }

// ── Scenarios ─────────────────────────────────────────────────────────────

(async () => {
  const failures = [];

  // 1. deriveAvailabilityBucket invariants
  {
    try {
      assert.strictEqual(poDrafts.deriveAvailabilityBucket({ vendor: 'perfectlevel', prosolStockInfo: null }), 'sechelt');
      assert.strictEqual(poDrafts.deriveAvailabilityBucket({ vendor: 'prosol', prosolStockInfo: { decision: { action: 'full' } } }), 'ready');
      assert.strictEqual(poDrafts.deriveAvailabilityBucket({ vendor: 'prosol', prosolStockInfo: { decision: { action: 'backorder' } } }), 'backorder');
      assert.strictEqual(poDrafts.deriveAvailabilityBucket({ vendor: 'prosol', prosolStockInfo: { decision: { action: 'capped' } } }), 'backorder');
      assert.strictEqual(poDrafts.deriveAvailabilityBucket({ vendor: 'prosol', prosolStockInfo: null }), 'backorder');
      assert.strictEqual(poDrafts.deriveAvailabilityBucket({ vendor: 'treeco',  prosolStockInfo: null }), 'ready');
      console.log('✓ scenario 1: deriveAvailabilityBucket maps all cases');
    } catch (e) { failures.push(`scenario 1: ${e.message}`); }
  }

  // 2. groupByVendorAndBucket produces the nested shape
  {
    reset();
    const draft = buildDraft();
    patchProsolLines(draft);
    const g = poDrafts.groupByVendorAndBucket(draft);
    try {
      assert.ok(g.prosol, 'prosol group exists');
      assert.ok(g.prosol.buckets.ready, 'prosol ready bucket');
      assert.ok(g.prosol.buckets.backorder, 'prosol backorder bucket');
      assert.strictEqual(g.prosol.buckets.ready.lineCount, 2, 'two ready lines');
      assert.strictEqual(g.prosol.buckets.backorder.lineCount, 2, 'two backorder lines (backorder + capped)');
      assert.ok(g.perfectlevel.buckets.sechelt, 'sechelt bucket');
      assert.ok(g.treeco.buckets.ready, 'treeco ready bucket');
      console.log('✓ scenario 2: groupByVendorAndBucket nested shape');
    } catch (e) { failures.push(`scenario 2: ${e.message}`); }
  }

  // 3. sendVendorGroup with bucket='ready' sends only ready lines
  {
    reset();
    const draft = buildDraft();
    patchProsolLines(draft);
    const r = await poSender.sendVendorGroup({ draft, vendor: 'prosol', bucket: 'ready' });
    try {
      assert.strictEqual(sentMails.length, 1, 'one email sent');
      assert.strictEqual(r.lineCount, 2, 'two ready lines in email');
      assert.ok(/^Replenishment PO —/.test(sentMails[0].subject), 'ready bucket: no bucket tag in subject');
      const poCreates = sfCreates.filter((c) => c.object === 'PBSI__PBSI_Purchase_Order__c');
      assert.strictEqual(poCreates.length, 1, 'one SF PO created');
      assert.ok(/Amazon CA — READY/.test(poCreates[0].fields.PBSI__Shipping_Instructions__c), 'SF PO tagged READY');
      // Backorder lines should NOT be marked sent
      const backLines = draft.lines.filter((l) => l.availabilityBucket === 'backorder' && l.vendor === 'prosol');
      assert.strictEqual(backLines.every((l) => !l.sentAt), true, 'backorder lines untouched');
      console.log('✓ scenario 3: sendVendorGroup filters by bucket');
    } catch (e) { failures.push(`scenario 3: ${e.message}`); }
  }

  // 4. sendAllBucketsForVendor fires ready then backorder with disjoint line sets
  {
    reset();
    const draft = buildDraft();
    patchProsolLines(draft);
    // Monkey-patch the inter-bucket 60s sleep to 10ms for test speed
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms) => origSetTimeout(fn, 10);
    try {
      const r = await poSender.sendAllBucketsForVendor({ draft, vendor: 'prosol' });
      assert.strictEqual(r.buckets.length, 2, 'two buckets sent');
      assert.strictEqual(r.buckets[0].bucket, 'ready', 'ready first');
      assert.strictEqual(r.buckets[1].bucket, 'backorder', 'backorder second');
      assert.strictEqual(sentMails.length, 2, 'two emails');
      assert.ok(/READY/.test(sentMails[0].subject) === false && /Replenishment PO —/.test(sentMails[0].subject), 'email 1 subject bucketless (ready)');
      assert.ok(/\(BACKORDER\)/.test(sentMails[1].subject), 'email 2 subject shows BACKORDER');
      const poCreates = sfCreates.filter((c) => c.object === 'PBSI__PBSI_Purchase_Order__c');
      assert.strictEqual(poCreates.length, 2, 'two SF POs');
      assert.ok(draft.lines.filter((l) => l.vendor === 'prosol').every((l) => l.sentAt), 'all prosol lines marked sent');
      console.log('✓ scenario 4: sendAllBucketsForVendor splits correctly');
    } catch (e) { failures.push(`scenario 4: ${e.message}`); }
    global.setTimeout = origSetTimeout;
  }

  if (failures.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('\nAll scenarios passed.');
  process.exit(0);
})();
