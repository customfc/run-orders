/**
 * Automayt twins of run-orders' three Salesforce write flows. Each returns the
 * same result shape as its Salesforce original, so the callers (lib/pipeline.js,
 * server.js, lib/shopify-so-reconcile.js, lib/fba-po-sender.js) don't change.
 * Pick the backend with ERP_BACKEND through lib/erp-backend.js, never directly.
 *
 *   createShopifySoPo  ↔ lib/shopify-sf.js      createShopifySoPo
 *   createAmazonPOs    ↔ lib/amazon-po.js       createAmazonPOs
 *   createFbaPO        ↔ lib/fba-po-sender.js   createSalesforceFbaPO
 *
 * Deliberate differences from the Salesforce flows, each toward safety:
 * - No fuzzy item match (title LIKE, code prefix LIKE). Automayt treats a
 *   description match as never authoritative, so a miss auto-creates from the
 *   sku-map (as today) or goes to manual review.
 * - A vendor code shared by two items stops that line for a person to settle;
 *   Salesforce silently took the first row.
 * - PO lines carry the item's cost. The Salesforce Shopify flow wrote the sale
 *   price there.
 * - SO + lines and PO + lines are each one transaction, so there is no
 *   half-built order to clean up.
 * Idempotency keys come from our own ids and every request body is
 * deterministic (dates come from the order, shipment or draft, never "now"),
 * so a retry replays the original instead of tripping idempotency_key_reused.
 */

const crypto = require('crypto');
const am = require('./automayt');
const erp = require('./automayt-erp');
const { resolveLineQty } = require('./pbsi-uom');
const { loadSkuMap, deriveItemFields, resolveItemCost } = require('./shopify-sf');
const { fetchShippedOrdersForPO, resolveSkuForPO } = require('./amazon-po');
const tax = require('./channel-tax');
const channelTaxIo = require('./channel-tax-io');

// Book tax exactly as Shopify charged it (per-line tax_charged), never let
// Automayt compute it from ship_to_region. 0 falls back to an exempt order
// with the tax kept in run-orders' record (data/channel-tax/), for an
// Automayt environment without tax_charged.
const taxAsCharged = () => process.env.AUTOMAYT_TAX_AS_CHARGED !== '0';
const SHOPIFY_TAX_RECORDED = {
  gst_exempt: true,
  pst_exempt: true,
  gst_exempt_id: 'Tax as charged: run-orders record',
  pst_exempt_id: 'Tax as charged: run-orders record',
};

const SKIP_API_SKUS = new Set(['UNMAPPED_CABLE', 'UNMAPPED', 'UNMAPPED_GROUT', 'SKIP', 'NON_PROSOL']);

// sku-map category → Automayt product category for auto-created items. The
// Salesforce item groups were Grout, Adhesive and Accessories (catch-all), see
// ITEM_GROUP_IDS in lib/shopify-sf.js; Automayt's migrated catalogue has a
// Grout and an Adhesive category (beta1, 2026-10-27).
function categoryFor(entry) {
  const grout = process.env.AUTOMAYT_CATEGORY_GROUT || 'Grout';
  const adhesive = process.env.AUTOMAYT_CATEGORY_ADHESIVE || 'Adhesive';
  const fallback = process.env.AUTOMAYT_CATEGORY_DEFAULT || 'Accessories';
  const table = {
    'grout / sealant': grout,
    'flooring adhesive': adhesive,
    adhesive,
  };
  const cat = ((entry && entry.category) || '').trim().toLowerCase();
  return table[cat] || fallback;
}

const stripSku = (s) => String(s || '').trim().replace(/[\/-]/g, '');

/** The item's own cost (the PBSI__Cost__c equivalent), or null. */
function itemCost(item) {
  const c = item && item.cost;
  const v = c && (c.real_cost ?? c.vendor_cost ?? c.landed_cost);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function itemLabel(item) {
  return item.item_number || item.sku || item.vendor_code || item.id;
}

function ambiguityText(code, verdict) {
  const names = verdict.candidates.map(itemLabel).join(', ');
  return `vendor code ${code} matches ${verdict.candidates.length} Automayt items (${names}); a person must pick one`;
}

// BC is UTC-7 all year (reference_bc_permanent_daylight_time).
function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function ymd(input) {
  const s = String(input || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Create a missing item from its sku-map entry, the createPbsiItem twin: same
 * stripped vendor code, same Prosol cost chain (refuse when no cost), same
 * derived manufacturer/style/colour/size. Automayt suffixes a clashing sku
 * itself, so there is no MFG- prefix.
 */
async function autoCreateItem({ mfgSku, prosolSku, productName, title, entry, vendorId }) {
  const vendorItemId = stripSku(prosolSku || mfgSku);
  if (!vendorItemId) throw new Error('autoCreateItem: need at least one of prosolSku / mfgSku');
  const itemNumber = stripSku(mfgSku || prosolSku || vendorItemId);
  const skuMap = loadSkuMap();
  const resolvedEntry = entry || (mfgSku && skuMap[mfgSku]) || (prosolSku && skuMap[prosolSku]) || null;
  const derived = deriveItemFields(resolvedEntry, prosolSku || mfgSku);

  const { cost, retail: liveRetail, source } = await resolveItemCost(prosolSku, mfgSku, resolvedEntry);
  if (cost === null) {
    throw new Error(`no Prosol cost for ${prosolSku || mfgSku} (sku-map cost_cad empty, live Prosol + mirror miss) — add cost via /map`);
  }
  let retail = resolvedEntry && resolvedEntry.retail_cad ? Number(resolvedEntry.retail_cad) : null;
  if (retail === null && liveRetail != null) retail = liveRetail;

  const res = await erp.createItem({
    vendorCode: vendorItemId,
    itemNumber,
    description: (resolvedEntry && resolvedEntry.product) || productName || title || itemNumber,
    category: categoryFor(resolvedEntry),
    unit: 'each',
    cost,
    retail,
    vendorId,
    manufacturer: derived.Manufacturer__c,
    style: derived.Original_Style_Name__c,
    color: derived.Color__c,
    size: derived.Size__c,
    upc: resolvedEntry && resolvedEntry.barcode,
  });
  return { item: res.item, created: !!res.created, costSource: source };
}

function mappedEntry(skuMap, sku) {
  const m = skuMap[String(sku || '')];
  return m && typeof m === 'object' ? m : null;
}

// ── Shopify ──────────────────────────────────────────────────────────────────

/** Lookup order mirrors findItemBySku: the Shopify SKU, then api_sku, then prosol_sku, each as vendor code then legacy item number. */
function shopifyCandidates(sku, mapped) {
  const out = [];
  const codes = [sku];
  if (mapped) {
    for (const c of [mapped.api_sku, mapped.prosol_sku]) {
      if (c && c !== sku && !SKIP_API_SKUS.has(String(c)) && !codes.includes(c)) codes.push(c);
    }
  }
  for (const c of codes) {
    if (!c) continue;
    out.push({ vendorCode: String(c) }, { itemNumber: String(c) });
  }
  return out;
}

/** The Shopify money line for a REST order item: by line id, else a unique SKU + qty, else the same position. */
function matchMoneyLine(item, i, items, money) {
  if (item.id != null) {
    const hit = money.lines.find((l) => l.id === String(item.id));
    if (hit) return hit;
  }
  const same = money.lines.filter((l) => (l.sku || '') === (item.sku || '') && l.quantity === Number(item.quantity));
  if (same.length === 1) return same[0];
  if (money.lines.length === items.length && (money.lines[i].sku || '') === (item.sku || '')) return money.lines[i];
  return null;
}

const isSampleLine = (item, moneyLine) => !!item.sampleOf || (!item.sku && moneyLine && moneyLine.total === 0);

function moneyNote(m) {
  const taxes = m.tax.map((t) => `${t.code} ${t.amount}`).join(' + ') || 'no tax';
  const fee = m.feeUnknown
    ? `processing fee not reported by ${m.paidVia.join('/')}`
    : `Shopify Payments fee ${m.fee.toFixed(2)}`;
  return `Shopify ${m.orderNumber}: subtotal ${m.subtotal.toFixed(2)}, shipping ${m.shipping.toFixed(2)}, ${taxes}, total ${m.total.toFixed(2)}. ${fee} (booking of the fee is open with the accountant).`;
}

function poNumbersOf(so) {
  return ((so && so.purchase_orders) || []).map((p) => p.number || p.id).filter(Boolean);
}

async function createShopifySoPo({ shopifyOrder, onProgress = () => {}, trackingNumber = null, carrierCode = null, orderDateOverride = null, money = null } = {}) {
  if (!shopifyOrder) throw new Error('shopifyOrder is required');

  const results = {
    shopifyOrder: shopifyOrder.orderNumber,
    steps: [],
    soId: null,
    soNumber: null,
    poId: null,
    poNumber: null,
    skipped: false,
    errors: [],
    backend: 'automayt',
  };
  const externalRef = String(shopifyOrder.orderNumber || '').replace(/^#/, '').trim();
  if (!externalRef) {
    results.errors.push({ step: 'validation', error: 'Shopify order has no order number' });
    return results;
  }

  // 1. Fixed records
  onProgress({ step: 'automayt-refs', message: 'Resolving Automayt house customer + Prosol...' });
  let customerId;
  let prosolId;
  try {
    customerId = await erp.resolveRef('shopifyCustomer');
    prosolId = await erp.resolveRef('prosolVendor');
    results.steps.push({ step: 'automayt-refs', success: true });
  } catch (err) {
    results.errors.push({ step: 'automayt-refs', error: err.message });
    return results;
  }

  // 1a. Skip-if-exists guard, fail closed like the Salesforce twin: a missing
  // SO costs one tick, a duplicate costs a reconciliation (2026-07-24).
  onProgress({ step: 'skip-check', message: 'Checking Automayt for an existing SO/PO...' });
  try {
    if (trackingNumber) {
      const found = await erp.checkTracking([trackingNumber]);
      const matches = found.get(String(trackingNumber)) || [];
      if (matches.length) {
        const numbers = matches.map((m) => m.number || m.id);
        results.skipped = true;
        results.skipReason = `PO ${numbers[0]} exists for tracking ${trackingNumber}`;
        results.existingCandidates = numbers;
        results.steps.push({ step: 'skip-check', success: true, skipped: true, reason: results.skipReason });
        return results;
      }
    }
    const existing = await erp.findSalesOrder('shopify', externalRef);
    if (existing) {
      results.skipped = true;
      results.skipReason = `SO ${existing.number} exists for shopify:${externalRef}`;
      results.existingCandidates = [...poNumbersOf(existing), existing.number];
      results.steps.push({ step: 'skip-check', success: true, skipped: true, reason: results.skipReason });
      return results;
    }
    results.steps.push({ step: 'skip-check', success: true, skipped: false });
  } catch (err) {
    results.errors.push({
      step: 'skip-check',
      error: `duplicate guard failed, SO/PO creation aborted for ${shopifyOrder.orderNumber} (nothing created): ${err.message || err}`,
    });
    results.steps.push({ step: 'skip-check', success: false, error: err.message, note: 'aborted — duplicate guard unavailable' });
    return results;
  }

  // 1b. What the customer paid: line totals after discounts, freight, tax by
  // code as charged, the processing fee. Fail closed: an SO priced from the
  // catalogue is exactly the hand adjustment this replaces.
  let orderMoney = money;
  if (!orderMoney) {
    try {
      orderMoney = await channelTaxIo.fetchShopifyOrderMoney(externalRef);
    } catch (err) {
      results.errors.push({ step: 'shopify-money', error: `could not read what Shopify charged, SO not created (nothing written): ${err.message}` });
      return results;
    }
  }
  results.money = {
    subtotal: orderMoney.subtotal, shipping: orderMoney.shipping, tax: orderMoney.tax, total: orderMoney.total,
    fee: orderMoney.fee, feeUnknown: !!orderMoney.feeUnknown, paidVia: orderMoney.paidVia || [], province: orderMoney.province,
  };
  results.steps.push({ step: 'shopify-money', success: true, total: orderMoney.total, tax: orderMoney.tax });

  // 2. Contact: only one with no customer or the house customer (Q21); a miss never blocks.
  let contactId = null;
  try {
    const contact = await erp.findOrderContact(shopifyOrder.email || (shopifyOrder.customer && shopifyOrder.customer.email), customerId);
    contactId = contact ? contact.id : null;
    results.steps.push({ step: 'find-contact', success: true, contactId, note: contact ? undefined : 'No usable contact — SO will be created without contact link' });
  } catch (err) {
    results.steps.push({ step: 'find-contact', success: false, error: err.message });
  }

  // 3. Resolve items in one batch, auto-create sku-mapped misses, convert area units.
  const SKU_MAP = loadSkuMap();
  const items = shopifyOrder.items || [];
  let verdicts;
  try {
    verdicts = await erp.resolveItems(items.map((item, i) => ({ key: i, candidates: shopifyCandidates(item.sku, mappedEntry(SKU_MAP, item.sku)) })));
  } catch (err) {
    results.errors.push({ step: 'find-item', error: `Item lookup failed: ${err.message}` });
    return results;
  }

  const resolvedItems = [];
  const sampleLines = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const moneyLine = matchMoneyLine(item, i, items, orderMoney);
    if (!moneyLine) {
      results.errors.push({ step: 'shopify-money', error: `Shopify line ${item.sku || item.title} has no matching priced line; left off the SO` });
      continue;
    }
    // Samples carry no SKU and no price; they stay on the SO as a description
    // line (no item, no PO) so the order's freight still lands somewhere.
    if (isSampleLine(item, moneyLine)) {
      sampleLines.push({ item, moneyLine, lineRef: `sample-${sampleLines.length + 1}` });
      continue;
    }
    const mapped = mappedEntry(SKU_MAP, item.sku);
    const verdict = verdicts.get(i);
    let amItem = verdict.status === 'matched' ? verdict.item : null;

    if (verdict.status === 'ambiguous') {
      results.errors.push({ step: 'find-item', error: `Item ${item.sku}: ${ambiguityText(item.sku, verdict)}` });
      continue;
    }
    if (!amItem) {
      const prosolSku = mapped ? mapped.prosol_sku : null;
      const apiSku = mapped ? mapped.api_sku : null;
      const haveValidMapping = mapped && prosolSku && !SKIP_API_SKUS.has(String(prosolSku)) && !SKIP_API_SKUS.has(String(apiSku || ''));
      if (haveValidMapping) {
        try {
          const created = await autoCreateItem({ mfgSku: item.sku, prosolSku, productName: mapped.product, title: item.title, vendorId: prosolId });
          amItem = created.item;
          results.steps.push({ step: 'auto-create-item', success: true, sku: item.sku, automaytItemId: amItem.id, itemNumber: itemLabel(amItem), costSource: created.costSource });
        } catch (err) {
          results.errors.push({ step: 'auto-create-item', error: `Auto-create failed for ${item.sku}: ${err.message}` });
        }
      }
    }
    if (!amItem) {
      results.errors.push({ step: 'find-item', error: `Item not found in Automayt: SKU=${item.sku}, title=${item.title}` });
      continue;
    }

    const qtyRes = resolveLineQty({
      uom: amItem.stocking_unit,
      description: amItem.description,
      orderQty: item.quantity,
      coverageOverride: mapped ? mapped.coverage_sqft : null,
    });
    if (qtyRes.error) {
      results.errors.push({ step: 'find-item', error: `Area-UoM coverage unresolved for ${itemLabel(amItem)} (SKU=${item.sku}): ${qtyRes.error}` });
      continue;
    }
    if (qtyRes.isArea) {
      results.steps.push({ step: 'area-qty', success: true, sku: item.sku, itemNumber: itemLabel(amItem), rolls: item.quantity, coverage: qtyRes.coverage, qty: qtyRes.qty });
    }
    resolvedItems.push({
      ...item,
      quantity: qtyRes.qty,
      orderRolls: item.quantity,
      coverageSqft: qtyRes.isArea ? qtyRes.coverage : null,
      automaytItemId: amItem.id,
      itemNumber: itemLabel(amItem),
      salesPrice: amItem.retail_price != null ? Number(amItem.retail_price) : null,
      costPrice: itemCost(amItem),
      lineRef: `line-${i + 1}`,
      moneyLine,
    });
    results.steps.push({ step: 'find-item', success: true, sku: item.sku, automaytItemId: amItem.id, itemNumber: itemLabel(amItem) });
  }

  if (!resolvedItems.length && !sampleLines.length) {
    results.errors.push({ step: 'validation', error: 'No items could be resolved in Automayt. Cannot create SO/PO.' });
    return results;
  }

  // Lines carry what the customer paid (an area item's Shopify line total over
  // its converted sqft), freight is its own line, and with tax as charged
  // every line says its tax so Automayt computes none.
  const withTax = taxAsCharged();
  const taxed = (charged) => (withTax ? { tax_charged: charged } : {});
  const soLines = [
    ...resolvedItems.map((it) => ({
      item_id: it.automaytItemId,
      qty: String(it.quantity),
      unit_price: tax.unitPriceFor(it.moneyLine.total, it.quantity),
      line_type: 'material',
      external_line_ref: it.lineRef,
      ...taxed(it.moneyLine.taxCharged),
    })),
    ...sampleLines.map((s) => ({
      description: `Sample: ${s.item.title || s.item.sampleOf || 'flooring sample'}`.slice(0, 500),
      qty: String(Number(s.item.quantity) || 1),
      unit_price: tax.unitPriceFor(s.moneyLine.total, Number(s.item.quantity) || 1),
      line_type: 'material',
      external_line_ref: s.lineRef,
      ...taxed(s.moneyLine.taxCharged),
    })),
    ...orderMoney.shippingLines.map((sl, i) => ({
      description: `Shipping: ${sl.title}`.slice(0, 500),
      qty: '1',
      unit_price: sl.total.toFixed(2),
      line_type: 'freight',
      external_line_ref: `freight-${i + 1}`,
      ...taxed(sl.taxCharged),
    })),
  ];
  const soSubtotal = tax.round2(soLines.reduce((s, l) => s + Number(l.unit_price) * Number(l.qty), 0));
  const soTax = withTax ? tax.round2(soLines.reduce((s, l) => s + tax.sumCodes(l.tax_charged), 0)) : 0;
  results.moneyCheck = { shopifyTotal: orderMoney.total, soSubtotal, soTax, soTotal: tax.round2(soSubtotal + soTax), diff: tax.round2(soSubtotal + soTax - orderMoney.total) };
  if (results.moneyCheck.diff && withTax) {
    results.steps.push({ step: 'money-check', success: false, note: `SO total ${results.moneyCheck.soTotal} vs Shopify ${orderMoney.total} (a line was left off)` });
  }

  // 4. Sales order with every line, one transaction.
  onProgress({ step: 'create-so', message: 'Creating Automayt Sales Order...' });
  const orderDate = ymd(orderDateOverride) || ymd(shopifyOrder.createdAt);
  let so;
  try {
    const res = await erp.createSalesOrder({
      channel: 'shopify',
      externalRef,
      customerId,
      contactId,
      orderDate,
      taxTreatment: withTax ? null : SHOPIFY_TAX_RECORDED,
      shipToRegion: orderMoney.province,
      notes: moneyNote(orderMoney),
      lines: soLines,
    });
    so = res.so;
    if (res.duplicate) {
      // Another process created it between the guard and this call.
      results.skipped = true;
      results.skipReason = `SO ${so.number} exists for shopify:${externalRef}`;
      results.existingCandidates = [...poNumbersOf(so), so.number];
      results.steps.push({ step: 'create-so', success: true, skipped: true, reason: results.skipReason });
      return results;
    }
    results.soId = so.id;
    results.soNumber = so.number;
    results.steps.push({ step: 'create-so', success: true, soId: so.id, replayed: !!res.replayed });
    for (const l of so.lines || []) results.steps.push({ step: 'create-so-line', success: true, lineRef: l.external_line_ref, lineId: l.id });
    onProgress({ step: 'create-so', message: `Created ${so.number}` });
  } catch (err) {
    results.errors.push({ step: 'create-so', error: err.message });
    return results;
  }

  // 5. NON_PROSOL / SKIP lines (CFC's own Sechelt stock) stay on the SO, never on the Prosol PO.
  const isNonProsolSku = (sku) => {
    const e = mappedEntry(SKU_MAP, sku);
    return !!(e && (e.api_sku === 'NON_PROSOL' || e.api_sku === 'SKIP'));
  };
  const poItems = resolvedItems.filter((i) => !isNonProsolSku(i.sku));
  if (!poItems.length) {
    results.poSkipped = true;
    results.poSkipReason = resolvedItems.length
      ? 'all items NON_PROSOL (CFC own stock / Sechelt) — no Prosol PO needed'
      : 'samples only — no Prosol PO needed';
    results.steps.push({ step: 'create-po', success: true, skipped: true, reason: results.poSkipReason });
    onProgress({ step: 'create-po', message: `Skipped PO — ${results.poSkipReason}` });
    return results;
  }

  // 6. Confirmed Prosol PO, linked line by line to the SO.
  onProgress({ step: 'create-po', message: 'Creating Automayt Purchase Order...' });
  const soLineByRef = new Map((so.lines || []).map((l) => [l.external_line_ref, l.id]));
  const customerName = shopifyOrder.customer
    ? `${shopifyOrder.customer.firstName || ''} ${shopifyOrder.customer.lastName || ''}`.trim()
    : (shopifyOrder.shippingAddress && shopifyOrder.shippingAddress.name) || 'Unknown';
  const itemDesc = poItems.map((i) => i.title || i.sku).join(', ');
  const carrierPart = carrierCode ? ` — ${String(carrierCode).replace(/_walleted$/, '').replace(/_/g, ' ')}` : '';
  const trackingPart = trackingNumber ? ` — Tracking: ${trackingNumber}` : '';
  try {
    const res = await erp.createPurchaseOrder({
      idempotencyKey: `shopify-${externalRef}-po`,
      vendorId: prosolId,
      salesOrderId: so.id,
      channel: 'shopify',
      externalRef,
      trackingCode: trackingNumber || null,
      orderDate,
      shippingInstructions: `Shopify ${shopifyOrder.orderNumber} — ${customerName} — ${itemDesc}${carrierPart}${trackingPart}`.slice(0, 255),
      lines: poItems.map((it) => ({
        item_id: it.automaytItemId,
        qty: String(it.quantity),
        ...(it.costPrice != null ? { unit_cost: String(it.costPrice) } : {}),
        sales_order_line_id: soLineByRef.get(it.lineRef),
        external_line_ref: it.lineRef,
      })),
    });
    results.poId = res.po.id;
    results.poNumber = res.po.number;
    results.steps.push({ step: 'create-po', success: true, poId: res.po.id, duplicate: !!res.duplicate, replayed: !!res.replayed });
    onProgress({ step: 'create-po', message: `Created ${res.po.number}` });
  } catch (err) {
    results.errors.push({ step: 'create-po', error: err.message });
  }
  return results;
}

/**
 * Bring a refunded or cancelled Shopify order's Automayt SO in line. A full
 * refund cancels the SO (Automayt voids its open invoice or credits a paid
 * one). A partial refund becomes one credit note per Shopify refund on the
 * SO's posted invoice: the refunded lines by quantity, tax as Shopify refunded
 * it, the refund id in the note so a re-run skips it. A refund that can't be
 * credited by line (a partial shipping refund, money beyond the lines) or an
 * SO not yet invoiced is reported and left alone. Dry run unless apply is true.
 */
async function reconcileShopifyRefund({ orderNumber, money = null, apply = false } = {}) {
  const ref = String(orderNumber || '').replace(/^#/, '').trim();
  if (!ref) throw new Error('reconcileShopifyRefund: orderNumber required');
  const m = money || await channelTaxIo.fetchShopifyOrderMoney(ref);
  const found = await erp.findSalesOrder('shopify', ref);
  const so = found && !found.invoices ? await erp.getSalesOrder(found.id) : found;
  const plan = tax.shopifyRefundPlan(m, so);
  const out = { order: m.orderNumber, so: so ? so.number : null, action: plan.action, reason: plan.reason || null, feeNote: plan.feeNote || null, fee: m.fee, refunds: m.refunds, applied: false };
  if (plan.action === 'cancel' && apply) {
    await erp.cancelSalesOrder(so.id, `${plan.reason}; ${plan.feeNote || 'no processing fee'}`, `shopify-${ref}-cancel`);
    out.applied = true;
  }
  if (plan.action === 'credit-note-pending') Object.assign(out, await creditShopifyRefunds(ref, m, so, apply));
  return out;
}

const POSTED_INVOICE = new Set(['posted', 'sent', 'partial', 'paid']);
const creditNoteTag = (refundId) => `Shopify refund ${refundId}`;

async function creditShopifyRefunds(ref, m, so, apply) {
  const invoices = (so.invoices || []).filter((inv) => inv.type !== 'credit-note' && POSTED_INVOICE.has(inv.status));
  if (!invoices.length) return { action: 'credit-note-pending', reason: 'partial refund: the SO has no posted invoice to credit yet' };

  // Which posted invoice bills each SO line, and the refunds already credited.
  const invoiceOfLine = new Map();
  const done = new Set();
  for (const inv of invoices) {
    const full = await erp.getInvoice(inv.id);
    for (const l of full.lines || []) if (l.sales_order_line_id) invoiceOfLine.set(l.sales_order_line_id, inv.id);
    for (const cn of await erp.listCreditNotes(inv.id)) {
      for (const r of m.refunds) if (String(cn.notes || '').includes(creditNoteTag(r.id))) done.add(r.id);
    }
  }
  const soLines = await erp.listSalesOrderLines(so.id);

  const creditNotes = [];
  for (const refund of m.refunds) {
    const entry = { refundId: refund.id, total: refund.total, status: 'pending', lines: [], problems: [] };
    creditNotes.push(entry);
    if (done.has(refund.id)) {
      entry.status = 'done';
      continue;
    }
    const planned = tax.shopifyCreditNoteLines(m, refund, soLines);
    entry.lines = planned.lines;
    entry.problems = planned.problems;
    const unbilled = planned.lines.filter((l) => !invoiceOfLine.has(l.soLineId));
    if (unbilled.length) entry.problems.push(`not on a posted invoice: ${unbilled.map((l) => l.ref).join(', ')}`);
    if (entry.problems.length) continue;
    entry.status = 'ready';
    if (!apply) continue;

    const byInvoice = new Map();
    for (const l of planned.lines) {
      const id = invoiceOfLine.get(l.soLineId);
      if (!byInvoice.has(id)) byInvoice.set(id, []);
      byInvoice.get(id).push(l);
    }
    try {
      entry.creditNotes = [];
      for (const [invoiceId, lines] of byInvoice) {
        const cn = await erp.createCreditNote(invoiceId, {
          reason: 'other',
          notes: `${creditNoteTag(refund.id)}, ${String(refund.createdAt || '').slice(0, 10)}, order ${m.orderNumber}`,
          lines,
        }, `shopify-${ref}-refund-${refund.id}-cn-${invoiceId}`);
        entry.creditNotes.push({ id: cn.id, number: cn.number, total: cn.total });
      }
      entry.status = 'done';
    } catch (err) {
      entry.status = 'error';
      entry.problems.push(err.message);
    }
  }

  const open = creditNotes.filter((c) => c.status !== 'done');
  const out = {
    creditNotes,
    action: open.length ? (apply || open.some((c) => c.status !== 'ready') ? 'credit-note-pending' : 'credit-note') : 'credited',
    reason: open.filter((c) => c.problems.length).map((c) => `refund ${c.refundId}: ${c.problems.join('; ')}`).join(' | ') || null,
  };
  if (apply) out.applied = creditNotes.some((c) => c.creditNotes && c.creditNotes.length);
  return out;
}

// ── Amazon ───────────────────────────────────────────────────────────────────

/** findPbsiItem order: the vendor code (variants come from codeVariants), then the leading-zero fuzzy form (C100978-01 → C100978-1). */
function amazonCandidates(prosolSku) {
  const out = [{ vendorCode: prosolSku }];
  const m = String(prosolSku).match(/^(.+)-0*(\d+)$/);
  if (m && `${m[1]}-${m[2]}` !== prosolSku) out.push({ vendorCode: `${m[1]}-${m[2]}` });
  return out;
}

/** received_at for an Amazon parcel: its ship date at noon Pacific, or omitted (server "now") when that is today or later. */
function amazonReceivedAt(shipDate) {
  const d = ymd(shipDate);
  return d && d < todayPacific() ? `${d}T12:00:00-07:00` : null;
}

/**
 * Set salePrice (a string unit price) on each resolved line from what Amazon
 * charged: the ShipStation item's unitPrice x quantity, split across a
 * bundle's components by catalogue value (cost, then equal shares when
 * neither is known), cents exact, then spread over the line's stocking qty
 * (sq ft for area items). An item with no Amazon price falls back to the
 * catalogue price, and the note says so.
 */
function priceAmazonLines(items, resolvedItems) {
  const missing = [];
  const byItem = new Map();
  for (const it of resolvedItems) {
    if (!byItem.has(it.itemIdx)) byItem.set(it.itemIdx, []);
    byItem.get(it.itemIdx).push(it);
  }
  for (const [idx, lines] of byItem) {
    const src = items[idx] || {};
    const unit = Number(src.unitPrice);
    if (!(unit > 0)) {
      missing.push(src.sku);
      for (const it of lines) it.salePrice = String(it.catalogPrice);
      continue;
    }
    const total = tax.round2(unit * (Number(src.quantity) || 1));
    const weightOf = (it) => (it.catalogPrice || 0) * it.quantity || (it.costPrice || 0) * it.quantity;
    const weights = lines.every((it) => weightOf(it) > 0) ? lines.map(weightOf) : lines.map(() => 1);
    const wsum = weights.reduce((a, b) => a + b, 0);
    let left = Math.round(total * 100);
    lines.forEach((it, i) => {
      const cents = i === lines.length - 1 ? left : Math.round((total * 100 * weights[i]) / wsum);
      left -= cents;
      it.salePrice = tax.unitPriceFor(cents / 100, it.quantity);
    });
  }
  return missing.length ? `no Amazon price in ShipStation for ${missing.join(', ')}: catalogue price used` : null;
}

/**
 * Expand an Amazon parcel's items (bundles, cables) through the sku-map and
 * find, or auto-create, each component in Automayt, with quantities in the
 * item's stocking unit. Problems go on orderResult.errors; lineRef(n) names the
 * n-th resolved line (1-based) for its external_line_ref.
 */
async function resolveAmazonItems(items, { skuMap, prosolId, orderResult, lineRef }) {
  const comps = [];
  let allItemsNonProsol = true;
  for (const [itemIdx, item] of items.entries()) {
    const entry = mappedEntry(skuMap, item.sku);
    const isNonProsol = entry && (entry.api_sku === 'NON_PROSOL' || entry.api_sku === 'SKIP');
    // An FBA listing missing from the sku-map can name its Prosol code itself
    // (vendorCode); such a line is matched, never auto-created.
    const resolved = resolveSkuForPO(item.sku, item.quantity, item.name)
      || (!entry && item.vendorCode ? [{ prosolSku: item.vendorCode, qty: item.quantity, product: item.name, noCreate: true }] : null);
    if (!resolved) {
      if (!isNonProsol) orderResult.errors.push(`No prosol_sku for ShipStation SKU ${item.sku} (${item.name})`);
      continue;
    }
    allItemsNonProsol = false;
    for (const comp of resolved) comps.push({ item, itemIdx, entry, comp });
  }
  const verdicts = comps.length
    ? await erp.resolveItems(comps.map((c, i) => ({ key: i, candidates: amazonCandidates(c.comp.prosolSku) })))
    : new Map();

  const resolvedItems = [];
  for (let i = 0; i < comps.length; i++) {
    const { item, itemIdx, entry, comp } = comps[i];
    const verdict = verdicts.get(i);
    if (verdict.status === 'ambiguous') {
      orderResult.errors.push(`prosol_sku ${comp.prosolSku} (SS SKU: ${item.sku}): ${ambiguityText(comp.prosolSku, verdict)}`);
      continue;
    }
    let amItem = verdict.item;
    if (!amItem && comp.noCreate) {
      orderResult.errors.push(`${comp.prosolSku} (SKU ${item.sku}) is not in the sku-map and not in Automayt: map it, then re-run`);
      continue;
    }
    if (!amItem) {
      try {
        const created = await autoCreateItem({
          mfgSku: (entry && entry.api_sku) || item.sku,
          prosolSku: comp.prosolSku,
          productName: comp.product,
          title: item.name,
          entry,
          vendorId: prosolId,
        });
        amItem = created.item;
        if (!orderResult.autoCreated) orderResult.autoCreated = [];
        orderResult.autoCreated.push({ automaytItemId: amItem.id, itemNumber: itemLabel(amItem), prosolSku: comp.prosolSku, sourceSku: item.sku });
      } catch (err) {
        orderResult.errors.push(`Automayt auto-create failed for prosol_sku ${comp.prosolSku} (SS SKU: ${item.sku}): ${err.message}`);
        continue;
      }
    }
    const qtyRes = resolveLineQty({
      uom: amItem.stocking_unit,
      description: amItem.description,
      orderQty: comp.qty,
      coverageOverride: entry ? entry.coverage_sqft : null,
    });
    if (qtyRes.error) {
      orderResult.errors.push(`Area-UoM coverage unresolved for ${itemLabel(amItem)} (${comp.prosolSku}): ${qtyRes.error}`);
      continue;
    }
    resolvedItems.push({
      sku: item.sku,
      name: comp.product || item.name,
      quantity: qtyRes.qty,
      orderRolls: comp.qty,
      coverageSqft: qtyRes.isArea ? qtyRes.coverage : null,
      unitPrice: item.unitPrice,
      prosolSku: comp.prosolSku,
      automaytItemId: amItem.id,
      itemNumber: itemLabel(amItem),
      itemIdx,
      catalogPrice: Number(amItem.retail_price) || 0,
      costPrice: itemCost(amItem),
      lineRef: lineRef(resolvedItems.length + 1),
    });
  }
  return { resolvedItems, allItemsNonProsol };
}

async function createAmazonParcelPOs({ days = 7, onProgress = () => {}, prefetched = null } = {}) {
  const results = { soName: null, soCreated: false, orders: [], errors: [], soNames: [], backend: 'automayt' };

  onProgress({ step: 'automayt-refs', message: 'Resolving Automayt Prosol + Amazon Fulfillment...' });
  let prosolId;
  let amazonFcId;
  try {
    prosolId = await erp.resolveRef('prosolVendor');
    amazonFcId = await erp.resolveRef('amazonFulfillment');
  } catch (err) {
    results.errors.push({ step: 'automayt-refs', error: err.message });
    return results;
  }

  onProgress({ step: 'fetch-shipments', message: 'Fetching shipped Amazon orders...' });
  let shipments;
  try {
    const fetched = prefetched || await fetchShippedOrdersForPO({ days });
    shipments = fetched.shipments;
    for (const u of fetched.unresolved || []) {
      results.orders.push({
        orderNumber: u.orderNumber || `(shipment ${u.shipmentId})`,
        trackingNumber: u.trackingNumber,
        status: 'error',
        errors: [`shipment ${u.shipmentId} (trk ${u.trackingNumber}) has no fetchable ShipStation order and no ops-state package record — PO NOT created`],
      });
    }
    onProgress({ step: 'fetch-shipments', message: `Found ${shipments.length} shipped Amazon orders` });
  } catch (err) {
    results.errors.push({ step: 'fetch-shipments', error: err.message });
    return results;
  }

  // Duplicate guard, fail closed: no answer means no POs this run.
  let existing;
  try {
    existing = await erp.checkTracking(shipments.map((s) => s.trackingNumber).filter(Boolean));
  } catch (err) {
    results.errors.push({ step: 'check-existing', error: `duplicate guard failed, PO creation aborted (no POs created this run): ${err.message}` });
    return results;
  }
  const needsPO = shipments.filter((s) => !existing.has(s.trackingNumber));
  for (const s of shipments.filter((x) => existing.has(x.trackingNumber))) {
    results.orders.push({ orderNumber: s.orderNumber, trackingNumber: s.trackingNumber, status: 'skipped', reason: 'PO already exists for this tracking number' });
  }
  onProgress({ step: 'filter', message: `${needsPO.length} need POs, ${shipments.length - needsPO.length} already have POs` });

  const SKU_MAP = loadSkuMap();
  const soCache = new Map();
  for (const shipment of needsPO) {
    const orderResult = {
      orderNumber: shipment.orderNumber,
      trackingNumber: shipment.trackingNumber,
      items: [],
      soLineIds: [],
      poId: null,
      poNumber: null,
      status: 'pending',
      errors: [],
    };
    // One parcel = one PO; a multi-package order has several, so lines key on the tracking code.
    const parcelKey = shipment.trackingNumber || shipment.orderNumber;
    const shipDate = ymd(shipment.shipDate) || todayPacific();
    onProgress({ step: 'create-po', message: `Processing ${shipment.orderNumber}...` });

    try {
      const { resolvedItems, allItemsNonProsol } = await resolveAmazonItems(shipment.items || [], {
        skuMap: SKU_MAP,
        prosolId,
        orderResult,
        lineRef: (n) => `${parcelKey}:${n}`,
      });

      if (!resolvedItems.length) {
        if (allItemsNonProsol && !orderResult.errors.length) {
          orderResult.status = 'skipped';
          orderResult.reason = 'Non-Prosol item — no PO needed';
        } else {
          orderResult.status = 'error';
          if (!orderResult.errors.length) orderResult.errors.push('No items could be resolved in Automayt');
          onProgress({ step: 'create-po', message: `✗ ${shipment.orderNumber}: ${orderResult.errors.join('; ')}` });
        }
        results.orders.push(orderResult);
        continue;
      }

      // Amazon's actual sale price (Melanie 2026-10-19), not the catalogue's.
      const priceNote = priceAmazonLines(shipment.items || [], resolvedItems);
      if (priceNote) orderResult.warnings = [priceNote];
      const soLines = resolvedItems.map((it) => ({
        item_id: it.automaytItemId,
        qty: String(it.quantity),
        unit_price: it.salePrice,
        line_type: 'material',
        external_line_ref: it.lineRef,
      }));
      // Shipping the buyer paid, once per Amazon order: every parcel of a
      // multi-package order sends the same ref and the period order skips repeats.
      if (Number(shipment.orderShipping) > 0) {
        soLines.push({
          description: `Amazon shipping, order ${shipment.orderNumber}`,
          qty: '1',
          unit_price: Number(shipment.orderShipping).toFixed(2),
          line_type: 'delivery',
          external_line_ref: `${shipment.orderNumber}:ship`,
        });
      }

      // Lines onto the 14-day period SO covering the ship date.
      let soLineByRef;
      let periodLines = [];
      try {
        const sel = await erp.addToAmazonPeriodSo(shipDate, parcelKey, soLines, soCache);
        periodLines = sel.lines;
        orderResult.soName = sel.so.number;
        orderResult.soId = sel.so.id;
        if (sel.created) results.soCreated = true;
        if (!results.soNames.includes(sel.so.number)) results.soNames.push(sel.so.number);
        soLineByRef = new Map(sel.lines.map((l) => [l.external_line_ref, l.id]));
        for (const it of resolvedItems) {
          orderResult.soLineIds.push({ itemId: it.automaytItemId, soLineId: soLineByRef.get(it.lineRef) });
          orderResult.items.push({ sku: it.sku, pbsiItem: it.itemNumber, qty: it.quantity, salePrice: it.salePrice, costPrice: it.costPrice });
        }
      } catch (err) {
        orderResult.status = 'error';
        orderResult.errors.push(`SO selection failed: ${err.message}`);
        results.orders.push(orderResult);
        continue;
      }

      // One confirmed PO per parcel, destination Amazon Fulfillment.
      const shipTo = shipment.shipTo || {};
      const carrierDisplay = (shipment.carrierCode || '').replace('_walleted', '').replace(/_/g, ' ');
      const poRes = await erp.createPurchaseOrder({
        idempotencyKey: `amazon-${parcelKey}-po`,
        vendorId: prosolId,
        salesOrderId: orderResult.soId,
        locationId: amazonFcId,
        channel: 'amazon',
        externalRef: shipment.orderNumber,
        trackingCode: shipment.trackingNumber || null,
        orderDate: shipDate,
        shippingInstructions: `Amazon Order ${shipment.orderNumber} — ${shipTo.name || 'Unknown'}, ${shipTo.city || ''} ${(shipTo.postalCode || '').trim()} — ${carrierDisplay} — Tracking: ${shipment.trackingNumber}`.slice(0, 255),
        lines: resolvedItems.map((it) => ({
          item_id: it.automaytItemId,
          qty: String(it.quantity),
          ...(it.costPrice != null ? { unit_cost: String(it.costPrice) } : {}),
          sales_order_line_id: soLineByRef.get(it.lineRef),
          external_line_ref: it.lineRef,
        })),
      });
      const parcelRefs = resolvedItems.map((it) => it.lineRef);
      const shipOpts = { soId: orderResult.soId, soLines: periodLines, refs: parcelRefs, locationId: amazonFcId, shippedAt: amazonReceivedAt(shipment.shipDate), reference: shipment.trackingNumber || shipment.orderNumber, key: `amazon-${parcelKey}-ship` };
      if (poRes.duplicate) {
        orderResult.status = 'skipped';
        orderResult.reason = `PO ${poRes.po.number} already exists for this tracking number`;
        orderResult.poId = poRes.po.id;
        orderResult.poNumber = poRes.po.number;
        // A run that stopped between the receipt and the shipment finishes it here.
        await shipFromAmazonFc(shipOpts, orderResult);
        if (orderResult.errors.length) orderResult.status = 'partial';
        results.orders.push(orderResult);
        continue;
      }
      orderResult.poId = poRes.po.id;
      orderResult.poNumber = poRes.po.number;

      // Receive into Amazon Fulfillment now, at the PO line cost (no unit_cost
      // sent, so it can't disagree). Stock, cost layer and GL post together.
      try {
        const rcv = await erp.receivePurchaseOrder(poRes.po.id, {
          receivedAt: amazonReceivedAt(shipment.shipDate),
          locationId: amazonFcId,
          lines: (poRes.po.lines || []).map((l) => ({ poLineId: l.id, qty: l.qty })),
        }, `amazon-${parcelKey}-rcv`);
        orderResult.receipts = (poRes.po.lines || []).map((l) => ({ itemId: l.item_id, qty: l.qty, receiptId: rcv.id || null }));
        orderResult.received = true;
        orderResult.inventoryMovementIds = rcv.inventory_movement_ids || [];
      } catch (err) {
        orderResult.errors.push(`Receive at Amazon Fulfillment for ${poRes.po.number}: ${err.message}`);
      }

      // The parcel went straight to the buyer: ship it back out of Amazon
      // Fulfillment so the receipt's units don't sit there forever.
      if (orderResult.received) await shipFromAmazonFc(shipOpts, orderResult);

      orderResult.status = orderResult.errors.length ? 'partial' : 'created';
      onProgress({ step: 'po-created', message: `${orderResult.poNumber} for ${shipment.orderNumber}` });
    } catch (err) {
      orderResult.status = 'error';
      orderResult.errors.push(err.message);
    }
    results.orders.push(orderResult);
  }

  results.soName = results.soNames[0] || null;
  return results;
}

const shipFromAmazonEnabled = () => process.env.AUTOMAYT_SHIP_FROM_AMAZON !== '0';

/**
 * Ship an Amazon sale's item lines out of Amazon Fulfillment (parcels after
 * their receipt, FBA sales from the stock sent ahead), so on-hand there goes
 * down and COGS posts. Lines already shipped are left alone, so a re-run is a
 * no-op. A failure goes on orderResult.errors (the sale itself stands); off
 * with AUTOMAYT_SHIP_FROM_AMAZON=0.
 */
async function shipFromAmazonFc({ soId, soLines, refs, locationId, shippedAt, reference, key }, orderResult) {
  if (!shipFromAmazonEnabled()) return;
  const lines = erp.linesToShip(soLines, refs);
  if (!lines.length) {
    orderResult.shipment = { shipped: false, reason: 'already shipped' };
    return;
  }
  try {
    // The day is in the key: a retry on a later day sends a dated shipped_at
    // (a changed body), and exceeds_remaining already stops a double ship.
    const res = await erp.shipSalesOrderLines(soId, { locationId, shippedAt, reference, lines }, `${key}-${shippedAt ? shippedAt.slice(0, 10) : todayPacific()}`);
    orderResult.shipment = res.shipped
      ? { shipped: true, id: res.shipment.id, lines: lines.map((l) => ({ ref: l.ref, qty: l.qty })) }
      : { shipped: false, reason: res.reason };
  } catch (err) {
    orderResult.errors.push(`Ship out of Amazon Fulfillment: ${err.message}`);
  }
}

// ── Amazon FBA sales ─────────────────────────────────────────────────────────
//
// Amazon ships FBA orders from stock we sent ahead, so they never reach
// ShipStation or the parcel flow above. They come from the Finances API
// (2024-06-19 listTransactions), counted the way the period tax close and
// Seller Central's Date Range report count them: a Shipment transaction whose
// items are AFN, on the Pacific day it posted. A deferred original posts when
// Amazon ships; its later release is never counted again. Each one lands on
// the period order like a parcel (no PO: the stock went in with the FBA
// restock PO), at what Amazon charged, plus the shipping the buyer paid.
// Refunds and promotional rebates stay off the order, as for parcels.

const fbaSalesEnabled = () => process.env.AUTOMAYT_FBA_SALES !== '0';
const fbaLookbackDays = () => Math.max(1, Number(process.env.AMAZON_FBA_LOOKBACK_DAYS) || 7);

const txRelatedId = (tx, name) => ((tx.relatedIdentifiers || []).find((r) => r.relatedIdentifierName === name) || {}).relatedIdentifierValue || null;
const amountOf = (b) => Number(b && b.breakdownAmount && b.breakdownAmount.currencyAmount) || 0;
const sumBreakdowns = (breakdowns, type) => (breakdowns || []).filter((b) => b.breakdownType === type).reduce((t, b) => t + amountOf(b), 0);

/** The shipping discount inside an item's PromoRebates (negative), so shipping nets to what the buyer paid. */
function shippingDiscountOf(breakdowns) {
  return (breakdowns || [])
    .filter((b) => b.breakdownType === 'PromoRebates')
    .reduce((t, b) => t + sumBreakdowns(b.breakdowns, 'ShippingDiscount'), 0);
}

/** YYYY-MM-DD of an instant in tz. */
function localDay(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * FBA sales in a list of Finances transactions: one entry per counted
 * Shipment transaction with AFN items, oldest first. unitPrice is Amazon's
 * principal over the quantity shipped (unrounded, so price x qty gives the
 * principal back to the cent); shipping is shipping charged less any
 * shipping discount.
 */
function fbaSalesFromTransactions(transactions, { tz = tax.AMAZON_REPORT_TZ, marketplaceId = tax.AMAZON_CA } = {}) {
  const sales = [];
  for (const tx of transactions || []) {
    if (tx.transactionType !== 'Shipment' || !tax.countsLikeDateRange(tx)) continue;
    const mp = (tx.marketplaceDetails && tx.marketplaceDetails.marketplaceId) || (tx.sellingPartnerMetadata && tx.sellingPartnerMetadata.marketplaceId) || marketplaceId;
    const orderId = txRelatedId(tx, 'ORDER_ID');
    if (mp !== marketplaceId || !orderId) continue;
    const items = [];
    let shipping = 0;
    for (const it of tx.items || []) {
      const ctx = (it.contexts || []).find((c) => c.contextType === 'ProductContext') || {};
      const qty = Number(ctx.quantityShipped) || 0;
      if (ctx.fulfillmentNetwork !== 'AFN' || !(qty > 0)) continue;
      items.push({ asin: ctx.asin || null, sellerSku: ctx.sku || null, quantity: qty, unitPrice: sumBreakdowns(it.breakdowns, 'ProductCharges') / qty, name: it.description || ctx.sku || ctx.asin });
      shipping += sumBreakdowns(it.breakdowns, 'Shipping') + shippingDiscountOf(it.breakdowns);
    }
    if (!items.length) continue;
    sales.push({
      orderId,
      shipmentId: txRelatedId(tx, 'SHIPMENT_ID') || tx.transactionId,
      transactionId: tx.transactionId,
      postedDate: tx.postedDate,
      day: localDay(tx.postedDate, tz),
      items,
      shipping: Math.max(0, tax.round2(shipping)),
    });
  }
  return sales.sort((a, b) => String(a.postedDate).localeCompare(String(b.postedDate)) || a.orderId.localeCompare(b.orderId));
}

/** FBA sales posted in the last `days` days (the API wants postedBefore at least 2 minutes back). */
async function fetchFbaSales({ days = fbaLookbackDays(), now = Date.now() } = {}) {
  const postedBefore = new Date(now - 3 * 60_000).toISOString();
  const postedAfter = new Date(now - days * 86_400_000).toISOString();
  return fbaSalesFromTransactions(await channelTaxIo.fetchAmazonTransactions({ postedAfter, postedBefore }));
}

/** The sku-map key for an FBA item: its ASIN, then the seller SKU with and without -FBA; else the bare code to match on. */
function fbaItemFor(item, skuMap) {
  const bare = item.sellerSku ? item.sellerSku.replace(/-FBA$/i, '') : null;
  const key = [item.asin, item.sellerSku, bare].find((k) => k && mappedEntry(skuMap, k));
  return { sku: key || item.sellerSku || item.asin, quantity: item.quantity, name: item.name, unitPrice: item.unitPrice, vendorCode: key ? null : bare };
}

/**
 * Put FBA sales on the period orders. All of a sale or none of it: a sale
 * with any item that won't resolve sends nothing and is reported, so its
 * idempotency key is only ever used with the complete body. A sale whose
 * first line is already on its period's order is skipped without a write.
 * sales: from fetchFbaSales / fbaSalesFromTransactions (fetched when null).
 */
async function addFbaSales({ days = fbaLookbackDays(), sales = null, skuMap = null, prosolId = null, onProgress = () => {} } = {}) {
  const out = { orders: [], errors: [], soNames: [], soCreated: false };
  try {
    if (!sales) sales = await fetchFbaSales({ days });
  } catch (err) {
    out.errors.push({ step: 'fba-sales', error: `FBA sales fetch failed, none added this run: ${err.message}` });
    return out;
  }
  if (!sales.length) return out;
  let amazonFcId;
  try {
    if (!prosolId) prosolId = await erp.resolveRef('prosolVendor');
    amazonFcId = await erp.resolveRef('amazonFulfillment');
  } catch (err) {
    out.errors.push({ step: 'fba-sales', error: err.message });
    return out;
  }
  skuMap = skuMap || loadSkuMap();
  const cutover = erp.amazonCutoverDate();
  const anchor = erp.amazonPeriodAnchor();
  const refsByPeriod = new Map();
  const soCache = new Map();

  for (const sale of sales) {
    const parcelKey = `fba:${sale.orderId}:${sale.shipmentId}`;
    const r = { orderNumber: sale.orderId, fulfillment: 'fba', shipDate: sale.day, items: [], status: 'pending', errors: [] };
    out.orders.push(r);
    if (erp.isProduction() && sale.day < cutover) {
      r.status = 'skipped';
      r.reason = `shipped ${sale.day}, before the ${cutover} cutover (Salesforce period)`;
      continue;
    }
    try {
      const period = erp.amazonPeriod(sale.day, anchor);
      if (!refsByPeriod.has(period.key)) refsByPeriod.set(period.key, await erp.amazonPeriodLines(period.key));
      const have = refsByPeriod.get(period.key);
      const shipOpts = (soId, soLines) => ({
        soId,
        soLines,
        refs: soLines.map((l) => l.external_line_ref).filter((ref) => ref && ref.startsWith(`${parcelKey}:`) && ref !== `${parcelKey}:ship`),
        locationId: amazonFcId,
        shippedAt: sale.postedDate,
        reference: `${sale.orderId} ${sale.shipmentId}`,
        key: `fba-${parcelKey}-ship`,
      });
      if (have.has(`${parcelKey}:1`)) {
        r.status = 'skipped';
        r.reason = `already on the ${period.label} order`;
        // On the order but not shipped out (a run that stopped in between): finish it.
        const onOrder = [...have.values()];
        if (erp.linesToShip(onOrder, shipOpts(null, onOrder).refs).length) {
          await shipFromAmazonFc(shipOpts(have.get(`${parcelKey}:1`).sales_order_id, onOrder), r);
          if (r.errors.length) r.status = 'error';
        }
        continue;
      }

      const items = sale.items.map((it) => fbaItemFor(it, skuMap));
      const { resolvedItems } = await resolveAmazonItems(items, { skuMap, prosolId, orderResult: r, lineRef: (n) => `${parcelKey}:${n}` });
      const unresolved = items.filter((_, idx) => !resolvedItems.some((it) => it.itemIdx === idx));
      if (unresolved.length && !r.errors.length) r.errors.push(`no Automayt item for ${unresolved.map((it) => it.sku).join(', ')}`);
      if (r.errors.length) {
        r.status = 'error';
        continue;
      }

      priceAmazonLines(items, resolvedItems);
      // A $0 principal (a replacement) is a $0 sale, never the catalogue price.
      for (const it of resolvedItems) if (Number(items[it.itemIdx].unitPrice) === 0) it.salePrice = '0';
      const soLines = resolvedItems.map((it) => ({
        item_id: it.automaytItemId,
        qty: String(it.quantity),
        unit_price: it.salePrice,
        line_type: 'material',
        external_line_ref: it.lineRef,
      }));
      if (sale.shipping > 0) {
        soLines.push({
          description: `Amazon shipping, FBA order ${sale.orderId}`,
          qty: '1',
          unit_price: sale.shipping.toFixed(2),
          line_type: 'delivery',
          external_line_ref: `${parcelKey}:ship`,
        });
      }

      const sel = await erp.addToAmazonPeriodSo(sale.day, parcelKey, soLines, soCache);
      for (const l of sel.lines) have.set(l.external_line_ref, { ...l, sales_order_id: sel.so.id });
      r.soName = sel.so.number;
      r.soId = sel.so.id;
      if (sel.created) out.soCreated = true;
      if (!out.soNames.includes(sel.so.number)) out.soNames.push(sel.so.number);
      for (const it of resolvedItems) r.items.push({ sku: it.sku, item: it.itemNumber, qty: it.quantity, salePrice: it.salePrice });
      if (sale.shipping > 0) r.shipping = sale.shipping;
      await shipFromAmazonFc(shipOpts(sel.so.id, sel.lines), r);
      r.status = r.errors.length ? 'partial' : 'created';
      onProgress({ step: 'fba-sale', message: `FBA ${sale.orderId} on ${sel.so.number}` });
    } catch (err) {
      r.status = 'error';
      r.errors.push(err.message);
    }
  }
  for (const r of out.orders.filter((o) => o.errors.length)) {
    out.errors.push({ step: 'fba-sales', error: `${r.orderNumber}: ${r.errors.join('; ')}` });
  }
  return out;
}

/**
 * The Amazon pass: shipped parcels (POs, receipts, period lines), then FBA
 * sales onto the same period orders unless AUTOMAYT_FBA_SALES=0 or fba:false.
 * FBA results sit in result.fba so the PO counts stay POs; FBA errors also go
 * on result.errors (step fba-sales) so they surface, without halting a run.
 * prefetched.fbaSales hands in the sales instead of fetching them.
 */
async function createAmazonPOs(args = {}) {
  const results = await createAmazonParcelPOs(args);
  if (args.fba === false || !fbaSalesEnabled()) return results;
  const { days = 7, onProgress = () => {}, prefetched = null } = args;
  onProgress({ step: 'fba-sales', message: 'Adding FBA sales to the Amazon period order...' });
  const fba = await addFbaSales({ days: Math.max(days, fbaLookbackDays()), sales: (prefetched && prefetched.fbaSales) || null, onProgress });
  results.fba = {
    orders: fba.orders,
    created: fba.orders.filter((o) => o.status === 'created').length,
    skipped: fba.orders.filter((o) => o.status === 'skipped').length,
    errored: fba.orders.filter((o) => o.status === 'error').length,
    partial: fba.orders.filter((o) => o.status === 'partial').length,
    shipped: fba.orders.filter((o) => o.shipment && o.shipment.shipped).length,
  };
  results.errors.push(...fba.errors);
  for (const n of fba.soNames) if (!results.soNames.includes(n)) results.soNames.push(n);
  if (fba.soCreated) results.soCreated = true;
  results.soName = results.soNames[0] || null;
  return results;
}

// ── FBA restock ──────────────────────────────────────────────────────────────

const FBA_VENDOR_REFS = { prosol: 'prosolVendor', treeco: 'treecoVendor' };

/** Channel reference for one FBA send. A combined Prosol send makes one PO per line, so the lines are part of the key. */
function fbaExternalRef(draft, bucket, lines) {
  const asins = lines.map((l) => l.asin).sort().join(',');
  const digest = crypto.createHash('sha1').update(asins).digest('hex').slice(0, 10);
  return `${draft.draftId}:${bucket || 'all'}:${digest}`;
}

async function createFbaPO({ vendor, draft, lines, bucket }) {
  const refName = FBA_VENDOR_REFS[vendor];
  if (!refName) return { skipped: true, reason: `Automayt PO skipped — no vendor mapping for '${vendor}'` };

  const vendorId = await erp.resolveRef(refName);
  const locationId = await erp.resolveRef('amazonFulfillment');
  const skuMap = loadSkuMap();
  const errors = [];

  const wanted = [];
  for (const line of lines) {
    let vendorItemId = null;
    let source = null;
    if (vendor === 'prosol') {
      vendorItemId = (line.prosolStock && line.prosolStock.prosolSku) || (skuMap[line.asin] && skuMap[line.asin].prosol_sku) || null;
      source = 'prosol_sku';
    } else if (vendor === 'treeco') {
      vendorItemId = (skuMap[line.asin] && skuMap[line.asin].treeco_sku) || null;
      source = 'treeco_sku';
    }
    if (!vendorItemId) {
      errors.push(`No ${source} mapped for ${line.asin} (${(line.product || '').slice(0, 40)})`);
      continue;
    }
    wanted.push({ line, vendorItemId });
  }

  const verdicts = wanted.length
    ? await erp.resolveItems(wanted.map((w, i) => ({ key: i, candidates: amazonCandidates(w.vendorItemId) })))
    : new Map();
  const resolvedLines = [];
  wanted.forEach((w, i) => {
    const v = verdicts.get(i);
    if (v.status === 'ambiguous') errors.push(`${w.vendorItemId} (${w.line.asin}): ${ambiguityText(w.vendorItemId, v)}`);
    else if (!v.item) errors.push(`Automayt item not found for ${w.vendorItemId} (${w.line.asin})`);
    else resolvedLines.push({ ...w, item: v.item, costPrice: itemCost(v.item) || 0, lineRef: `${resolvedLines.length + 1}:${w.line.asin}` });
  });

  if (!resolvedLines.length) {
    return { skipped: false, created: false, errors, reason: 'No Automayt items resolved — nothing to create' };
  }

  const externalRef = fbaExternalRef(draft, bucket, resolvedLines.map((r) => r.line));
  const bucketTag = bucket ? ` — ${bucket.toUpperCase()}` : '';
  const res = await erp.createPurchaseOrder({
    idempotencyKey: `fba-${externalRef}-po`,
    vendorId,
    type: 'stock',
    locationId,
    channel: 'fba',
    externalRef,
    orderDate: ymd(draft.createdAt),
    shippingInstructions: `FBA Restock — Amazon CA${bucketTag} — Draft ${draft.draftId} — ${resolvedLines.length} lines`.slice(0, 255),
    lines: resolvedLines.map((r) => ({
      item_id: r.item.id,
      qty: String(r.line.qty),
      ...(r.costPrice > 0 ? { unit_cost: String(r.costPrice) } : {}),
      external_line_ref: r.lineRef,
    })),
  });
  const po = res.po;
  const poLineByRef = new Map((po.lines || []).map((l) => [l.external_line_ref, l]));

  const createdLines = [];
  for (const r of resolvedLines) {
    const poLine = poLineByRef.get(r.lineRef);
    if (!poLine) {
      errors.push(`PO line missing from ${po.number} for ${r.vendorItemId}`);
      continue;
    }
    const costPrice = poLine.unit_cost != null ? Number(poLine.unit_cost) : r.costPrice;
    createdLines.push({ asin: r.line.asin, prosolSku: r.vendorItemId, pbsiItemName: itemLabel(r.item), qty: r.line.qty, costPrice, poLineId: poLine.id });
    r.line.automaytPoId = po.id;
    r.line.automaytPoNumber = po.number;
    r.line.automaytPoLineId = poLine.id;
  }

  return {
    skipped: false,
    created: true,
    duplicate: !!res.duplicate,
    poId: po.id,
    poNumber: po.number,
    lineCount: createdLines.length,
    totalCost: Number(createdLines.reduce((s, l) => s + (l.costPrice * l.qty), 0).toFixed(2)),
    lines: createdLines,
    errors,
    backend: 'automayt',
  };
}

module.exports = {
  createShopifySoPo,
  reconcileShopifyRefund,
  matchMoneyLine,
  createAmazonPOs,
  createFbaPO,
  // exported for tests
  categoryFor,
  itemCost,
  shopifyCandidates,
  amazonCandidates,
  amazonReceivedAt,
  fbaExternalRef,
  priceAmazonLines,
  fbaSalesFromTransactions,
  fetchFbaSales,
  addFbaSales,
};
