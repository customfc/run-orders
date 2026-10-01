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

const SKIP_API_SKUS = new Set(['UNMAPPED_CABLE', 'UNMAPPED', 'UNMAPPED_GROUT', 'SKIP', 'NON_PROSOL']);

// sku-map category → Automayt product category for auto-created items. The
// Salesforce item groups were Grout, Adhesive and Accessories (catch-all), see
// ITEM_GROUP_IDS in lib/shopify-sf.js. Automayt's catalogue has no grout or
// adhesive category yet, so both map to one configurable category.
function categoryFor(entry) {
  const groutAdhesive = process.env.AUTOMAYT_CATEGORY_GROUT_ADHESIVE || 'Supplies';
  const fallback = process.env.AUTOMAYT_CATEGORY_DEFAULT || 'Accessories';
  const table = {
    'grout / sealant': groutAdhesive,
    'flooring adhesive': groutAdhesive,
    adhesive: groutAdhesive,
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

function poNumbersOf(so) {
  return ((so && so.purchase_orders) || []).map((p) => p.number || p.id).filter(Boolean);
}

async function createShopifySoPo({ shopifyOrder, onProgress = () => {}, trackingNumber = null, carrierCode = null, orderDateOverride = null } = {}) {
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
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
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
    });
    results.steps.push({ step: 'find-item', success: true, sku: item.sku, automaytItemId: amItem.id, itemNumber: itemLabel(amItem) });
  }

  if (!resolvedItems.length) {
    results.errors.push({ step: 'validation', error: 'No items could be resolved in Automayt. Cannot create SO/PO.' });
    return results;
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
      // run-orders writes GST/PST not-exempt on Shopify orders (shopify-sf.js:725).
      taxTreatment: { gst_exempt: false, pst_exempt: false },
      lines: resolvedItems.map((it) => ({
        item_id: it.automaytItemId,
        qty: String(it.quantity),
        unit_price: String(parseFloat(it.price) || it.salesPrice || 0),
        line_type: 'material',
        external_line_ref: it.lineRef,
      })),
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
    results.poSkipReason = 'all items NON_PROSOL (CFC own stock / Sechelt) — no Prosol PO needed';
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

async function createAmazonPOs({ days = 7, onProgress = () => {}, prefetched = null } = {}) {
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
      // Expand bundles and cables, then resolve every component in one batch.
      const comps = [];
      let allItemsNonProsol = true;
      for (const item of shipment.items || []) {
        const entry = mappedEntry(SKU_MAP, item.sku);
        const isNonProsol = entry && (entry.api_sku === 'NON_PROSOL' || entry.api_sku === 'SKIP');
        const resolved = resolveSkuForPO(item.sku, item.quantity, item.name);
        if (!resolved) {
          if (!isNonProsol) orderResult.errors.push(`No prosol_sku for ShipStation SKU ${item.sku} (${item.name})`);
          continue;
        }
        allItemsNonProsol = false;
        for (const comp of resolved) comps.push({ item, entry, comp });
      }
      const verdicts = comps.length
        ? await erp.resolveItems(comps.map((c, i) => ({ key: i, candidates: amazonCandidates(c.comp.prosolSku) })))
        : new Map();

      const resolvedItems = [];
      for (let i = 0; i < comps.length; i++) {
        const { item, entry, comp } = comps[i];
        const verdict = verdicts.get(i);
        if (verdict.status === 'ambiguous') {
          orderResult.errors.push(`prosol_sku ${comp.prosolSku} (SS SKU: ${item.sku}): ${ambiguityText(comp.prosolSku, verdict)}`);
          continue;
        }
        let amItem = verdict.item;
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
          // Same price order as Salesforce: the item's list price, then the Amazon price.
          salePrice: Number(amItem.retail_price) || item.unitPrice || 0,
          costPrice: itemCost(amItem),
          lineRef: `${parcelKey}:${resolvedItems.length + 1}`,
        });
      }

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

      // Lines onto the 14-day period SO covering the ship date.
      let soLineByRef;
      try {
        const sel = await erp.addToAmazonPeriodSo(shipDate, parcelKey, resolvedItems.map((it) => ({
          item_id: it.automaytItemId,
          qty: String(it.quantity),
          unit_price: String(it.salePrice),
          line_type: 'material',
          external_line_ref: it.lineRef,
        })), soCache);
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
      if (poRes.duplicate) {
        orderResult.status = 'skipped';
        orderResult.reason = `PO ${poRes.po.number} already exists for this tracking number`;
        orderResult.poId = poRes.po.id;
        orderResult.poNumber = poRes.po.number;
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
  createAmazonPOs,
  createFbaPO,
  // exported for tests
  categoryFor,
  itemCost,
  shopifyCandidates,
  amazonCandidates,
  amazonReceivedAt,
  fbaExternalRef,
};
