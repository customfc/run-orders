/**
 * Verify the bucket-aware inbound-plan orchestration + labels email shape.
 *
 * Scope is intentionally narrow — the SP-API orchestration path is
 * IRREVERSIBLE at Amazon's side (step 3 placement locks a destination FC
 * and you pay fees), so we exercise:
 *
 *   - runForBucket(confirm:false) returns a dry-run plan without calling
 *     Amazon. Asserts the shape + that cartonDims roundtrips.
 *   - renderLabelsBody produces HTML with the FC ship-to block, FNSKU
 *     instructions, carton-dims note, and "ready to ship" ask.
 *   - sendLabelsEmail attaches both PDFs when both paths exist, subject line
 *     names the FC, only-FNSKU when transport path is null.
 *
 * Live SP-API verification is a manual step the user does on a real PO
 * after these commits deploy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.SMTP_PASSWORD = process.env.SMTP_PASSWORD || 'stub';

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

const sentMails = [];
stubModule('nodemailer', {
  createTransport: () => ({
    sendMail: async (args) => { sentMails.push(args); return { messageId: 'stub', accepted: [args.to], rejected: [] }; },
    close: () => {},
  }),
});

const orchestrator = require('../../lib/fba-inbound-orchestrator');
const poSender = require('../../lib/fba-po-sender');

// ── Scenarios ─────────────────────────────────────────────────────────────

(async () => {
  const failures = [];

  // 1. runForBucket dry-run returns shape without firing SP-API
  {
    try {
      const r = await orchestrator.runForBucket({
        draftId: 'draft-test',
        vendor: 'prosol',
        bucket: 'ready',
        cartonDims: { count: 20, L: 24, W: 18, H: 12, weightLb: 38 },
        confirm: false,
      });
      assert.strictEqual(r.dryRun, true, 'dryRun flag set');
      assert.strictEqual(r.planKey, 'draft-test-prosol-ready-inbound', 'planKey includes bucket');
      assert.ok(Array.isArray(r.wouldRun) && r.wouldRun.length === 5, '5 steps listed');
      assert.strictEqual(r.cartonDims.count, 20, 'cartonDims roundtrip');
      console.log('✓ scenario 1: runForBucket dry-run shape');
    } catch (e) { failures.push(`scenario 1: ${e.message}`); }
  }

  // 2. runForBucket validation — missing bucket throws
  {
    try {
      let threw = false;
      try {
        await orchestrator.runForBucket({ draftId: 'd', vendor: 'prosol' });
      } catch (e) {
        threw = /bucket required/.test(e.message);
      }
      assert.strictEqual(threw, true, 'missing bucket throws');
      console.log('✓ scenario 2: required args validated');
    } catch (e) { failures.push(`scenario 2: ${e.message}`); }
  }

  // 3. renderLabelsBody produces the expected HTML shape
  {
    try {
      const html = poSender.renderLabelsBody({
        vendor: 'prosol',
        lines: [{ qty: 12, product: 'Kerdi Band', prosolStock: { prosolSku: 'KEBA1001855M' } }],
        bucket: 'ready',
        fcCode: 'YYZ9',
        fcAddress: { name: 'Amazon Fulfillment', addressLine1: '2750 Peddie Rd', city: 'Milton', stateOrProvinceCode: 'ON', postalCode: 'L9T 6Y9', countryCode: 'CA' },
        poNumber: 'PO-14500',
        shipmentConfirmationId: 'FBA15ABC123',
        amazonReferenceId: 'FBA15ABC123Z',
        cartonDims: { count: 20, L: 24, W: 18, H: 12, weightLb: 38 },
      });
      assert.ok(/Hi Kaitlyn/.test(html), 'greets Kaitlyn');
      assert.ok(/YYZ9/.test(html), 'FC code in block');
      assert.ok(/2750 Peddie Rd/.test(html), 'FC address rendered');
      assert.ok(/Amazon Fulfillment Center/.test(html), 'ship-to block labeled');
      assert.ok(/FBA15ABC123/.test(html), 'shipment confirmation ID shown');
      assert.ok(/FBA15ABC123Z/.test(html), 'amazon reference ID shown');
      assert.ok(/FNSKU labels/.test(html) && /one per unit/.test(html), 'FNSKU instructions');
      assert.ok(/Transport \/ carton labels/.test(html), 'carton label instructions');
      assert.ok(/20 cartons @ 24×18×12 in, 38 lb/.test(html), 'dims echoed');
      assert.ok(/ready to ship/.test(html), 'ready ask present');
      assert.ok(/Max 50 lb \/ carton/.test(html), 'Amazon constraint surfaced');
      console.log('✓ scenario 3: renderLabelsBody shape');
    } catch (e) { failures.push(`scenario 3: ${e.message}`); }
  }

  // 4. sendLabelsEmail attaches both PDFs when paths exist
  {
    sentMails.length = 0;
    try {
      const tmpFnsku = path.join(os.tmpdir(), `fnsku-${Date.now()}.pdf`);
      const tmpTransport = path.join(os.tmpdir(), `transport-${Date.now()}.pdf`);
      fs.writeFileSync(tmpFnsku, '%PDF-1.4 fnsku-stub');
      fs.writeFileSync(tmpTransport, '%PDF-1.4 transport-stub');

      const r = await poSender.sendLabelsEmail({
        vendor: 'prosol',
        bucket: 'ready',
        lines: [{ qty: 12 }],
        poNumber: 'PO-14500',
        fcCode: 'YYZ9',
        fcAddress: { addressLine1: '2750 Peddie Rd', city: 'Milton' },
        cartonDims: { count: 20, L: 24, W: 18, H: 12, weightLb: 38 },
        fnskuPdfPath: tmpFnsku,
        transportPdfPath: tmpTransport,
      });
      assert.strictEqual(sentMails.length, 1, 'one email sent');
      assert.ok(/FBA Labels ready/.test(sentMails[0].subject), 'subject says labels ready');
      assert.ok(/YYZ9/.test(sentMails[0].subject), 'subject names FC');
      assert.strictEqual(sentMails[0].attachments.length, 2, 'two PDFs attached');
      assert.ok(r.fnskuAttached && r.transportAttached, 'result reports both attachments');

      fs.unlinkSync(tmpFnsku);
      fs.unlinkSync(tmpTransport);
      console.log('✓ scenario 4: sendLabelsEmail attaches both PDFs');
    } catch (e) { failures.push(`scenario 4: ${e.message}`); }
  }

  // 5. sendLabelsEmail tolerates missing transport PDF (v2024-03-20 reality)
  {
    sentMails.length = 0;
    try {
      const tmpFnsku = path.join(os.tmpdir(), `fnsku-only-${Date.now()}.pdf`);
      fs.writeFileSync(tmpFnsku, '%PDF-1.4 fnsku-only');

      const r = await poSender.sendLabelsEmail({
        vendor: 'prosol',
        bucket: 'ready',
        lines: [{ qty: 5 }],
        poNumber: 'PO-14501',
        fcCode: 'YHM1',
        fcAddress: { addressLine1: '4050 Mainway', city: 'Hamilton' },
        cartonDims: null,
        fnskuPdfPath: tmpFnsku,
        transportPdfPath: null,
      });
      assert.strictEqual(sentMails[0].attachments.length, 1, 'only FNSKU attached');
      assert.ok(r.fnskuAttached && !r.transportAttached, 'transport absent');

      fs.unlinkSync(tmpFnsku);
      console.log('✓ scenario 5: sendLabelsEmail handles transport-PDF absence');
    } catch (e) { failures.push(`scenario 5: ${e.message}`); }
  }

  if (failures.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('\nAll scenarios passed.');
  process.exit(0);
})();
