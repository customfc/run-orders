/**
 * Automayt domain operations for run-orders — the Automayt side of what
 * lib/shopify-sf.js, lib/amazon-po.js and lib/fba-po-sender.js do in Salesforce.
 *
 * Fixed records (house customers, vendors, locations) are found through
 * external refs under system "run-orders", never hard-coded Automayt ids, so
 * the same code runs on beta1, staging and production. Map them once per
 * environment with scripts/automayt/map-refs.js.
 *
 * Every write derives its Idempotency-Key from run-orders' own ids, and a 409
 * `duplicate` is treated as "already done": the existing record is read back
 * and returned with `duplicate: true`. A failed dedupe read throws; it never
 * means "no match" (the 2026-07-24 duplicate-PO lesson).
 */

const am = require('./automayt');

const REF_SYSTEM = process.env.AUTOMAYT_REF_SYSTEM || 'run-orders';

const FIXED_REFS = {
  shopifyCustomer:   { entity: 'customer', path: '/customers', key: 'shopify-house' },
  amazonCustomer:    { entity: 'customer', path: '/customers', key: 'amazon-house' },
  prosolVendor:      { entity: 'vendor',   path: '/vendors',   key: 'prosol' },
  treecoVendor:      { entity: 'vendor',   path: '/vendors',   key: 'treeco' },
  secheltWarehouse:  { entity: 'location', path: '/locations', key: 'sechelt-warehouse' },
  amazonFulfillment: { entity: 'location', path: '/locations', key: 'amazon-fulfillment' },
};

const AMAZON_PERIOD_DAYS = 14;

// ── Fixed records ────────────────────────────────────────────────────────────

const refCache = new Map();

function refMatches(record, key) {
  return (record.external_refs || []).some((r) => r.system === REF_SYSTEM && r.external_id === key);
}

/** Automayt id of a fixed record, e.g. resolveRef('prosolVendor'). Throws when unmapped. */
async function resolveRef(name) {
  const def = FIXED_REFS[name];
  if (!def) throw new Error(`resolveRef: unknown ref ${name}`);
  if (refCache.has(name)) return refCache.get(name);

  let rows;
  if (def.entity === 'location') {
    // /locations has no external_ref filter; the list is short, so filter here.
    rows = (await am.listAll('/locations', {}, { max: 500 })).filter((l) => refMatches(l, def.key));
  } else {
    const { data } = await am.get(def.path, { external_ref: def.key, system: REF_SYSTEM });
    rows = (data && data.data) || [];
  }
  if (rows.length !== 1) {
    throw new Error(`Automayt ${def.entity} "${REF_SYSTEM}:${def.key}" resolved to ${rows.length} records; map it once with scripts/automayt/map-refs.js`);
  }
  refCache.set(name, rows[0].id);
  return rows[0].id;
}

/** Map a fixed record. Safe to repeat; refuses to re-point an existing mapping (409). */
async function mapRef(name, id) {
  const def = FIXED_REFS[name];
  if (!def) throw new Error(`mapRef: unknown ref ${name}`);
  const res = await am.put('/external-refs', { system: REF_SYSTEM, entity_type: def.entity, external_id: def.key, id }, `map-${REF_SYSTEM}-${def.entity}-${def.key}`);
  refCache.set(name, id);
  return res.data;
}

// ── Contacts ─────────────────────────────────────────────────────────────────

/**
 * Contact to put on an order, or null. Automayt refuses (422) a contact that
 * belongs to a different customer, and a missing contact must never block an
 * order, so only a contact with no customer or the order's own customer is
 * returned. Several matches → null rather than a guess.
 */
async function findOrderContact(email, customerId) {
  if (!email) return null;
  const { data } = await am.get('/contacts', { email });
  const usable = ((data && data.data) || []).filter((c) => !c.customer_id || c.customer_id === customerId);
  return usable.length === 1 ? usable[0] : null;
}

// ── Items ────────────────────────────────────────────────────────────────────

/**
 * Lookup candidates for one code, most-stripped first, mirroring the
 * Salesforce lookup order (project_prosol_sku_slashes). Automayt already
 * ignores case, spaces and dashes; slashes are tried both ways.
 */
function codeVariants(code) {
  const s = String(code || '').trim();
  if (!s) return [];
  return [...new Set([s.replace(/[\/-]/g, ''), s])];
}

/**
 * Resolve many items in one batch call (≤ 500 lookups).
 * entries: [{ key, vendorCodes: [...], itemNumbers: [...] }] in priority order.
 * Returns Map key → { status: 'matched'|'ambiguous'|'not_found', item, candidates }.
 * The first candidate that is not not_found decides; ambiguous is never resolved
 * by picking one, it is reported for a person to settle.
 */
async function resolveItems(entries) {
  const lookups = [];
  const plan = entries.map((e) => {
    const idx = [];
    for (const vc of (e.vendorCodes || []).flatMap(codeVariants)) {
      idx.push(lookups.push({ vendor_code: vc }) - 1);
    }
    for (const n of e.itemNumbers || []) {
      if (n) idx.push(lookups.push({ item_number: String(n) }) - 1);
    }
    return { key: e.key, idx };
  });
  if (lookups.length > 500) throw new Error(`resolveItems: ${lookups.length} lookups exceeds the 500 batch limit`);

  const results = lookups.length ? (await am.post('/items/batch-lookup', { lookups })).data.results : [];
  const out = new Map();
  for (const { key, idx } of plan) {
    let verdict = { status: 'not_found', item: null, candidates: [] };
    for (const i of idx) {
      const r = results[i];
      if (!r || r.status === 'not_found') continue;
      verdict = r.status === 'matched'
        ? { status: 'matched', item: r.items[0], candidates: r.items, via: r.input }
        : { status: 'ambiguous', item: null, candidates: r.items || [], via: r.input };
      break;
    }
    out.set(key, verdict);
  }
  return out;
}

let categoryCache = null;
async function categoryIdByName(name) {
  if (!categoryCache) categoryCache = await am.listAll('/product-categories', {}, { max: 500 });
  const hit = categoryCache.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
  if (!hit) throw new Error(`Automayt has no product category "${name}"`);
  return hit.id;
}

/**
 * Create a catalog item (the createPbsiItem equivalent). A 409 duplicate means
 * the vendor code already resolves; that item is returned instead.
 */
async function createItem({ vendorCode, itemNumber, description, category, unit = 'each', cost, retail, vendorId, manufacturer, style, color, size, upc }) {
  if (!vendorCode) throw new Error('createItem: vendorCode is required');
  if (cost == null || !(Number(cost) >= 0)) throw new Error(`createItem: no cost for ${vendorCode}`);
  const body = {
    vendor_id: vendorId || null,
    vendor_code: vendorCode,
    item_number: itemNumber || null,
    description: description || null,
    category_id: await categoryIdByName(category),
    unit,
    cost: String(cost),
    retail_price: retail != null ? String(retail) : null,
    taxable: true,
    manufacturer: manufacturer || null,
    style: style || null,
    color: color || null,
    size: size || null,
    upc: upc && /^\d{8,14}$/.test(String(upc)) ? String(upc) : null,
    stock_status: 'Special Order',
  };
  try {
    const { data } = await am.command('/items', body, `item-${vendorCode}`);
    return { item: data, created: true };
  } catch (err) {
    if (am.isDuplicate(err) && err.existingId) {
      const { data } = await am.get(`/items/${err.existingId}`);
      return { item: data, created: false, duplicate: true };
    }
    throw err;
  }
}

// ── Sales orders ─────────────────────────────────────────────────────────────

async function findSalesOrder(channel, externalRef) {
  const { data } = await am.get('/sales-orders', { channel, external_ref: externalRef });
  const rows = (data && data.data) || [];
  if (rows.length > 1) throw new Error(`Automayt has ${rows.length} sales orders for ${channel}:${externalRef}`);
  return rows[0] || null;
}

/**
 * Create a sales order with all its lines in one transaction. Always
 * procurement_mode external: run-orders buys and fulfils itself, so Automayt
 * must not raise POs or reserve stock (CFC decision 3, 2026-09-24).
 */
async function createSalesOrder({ channel, externalRef, customerId, contactId, orderDate, lines, taxTreatment, notes, deliveryInstructions }) {
  const body = {
    customer_id: customerId,
    contact_id: contactId || null,
    procurement_mode: 'external',
    type: 'supply',
    channel,
    external_ref: externalRef,
    order_date: orderDate || null,
    notes: notes || null,
    delivery_instructions: deliveryInstructions || null,
    tax_treatment: taxTreatment || null,
    lines,
  };
  try {
    const { data, requestId, replayed } = await am.command('/sales-orders', body, `${channel}-${externalRef}-so`);
    return { so: data, created: !replayed, replayed, requestId };
  } catch (err) {
    if (am.isDuplicate(err) && err.existingId) {
      const { data } = await am.get(`/sales-orders/${err.existingId}`);
      return { so: data, created: false, duplicate: true };
    }
    throw err;
  }
}

/** Add lines to an open order; lines whose external_line_ref is already there are skipped. */
async function addSalesOrderLines(soId, lines, idempotencyKey, { taxTreatment } = {}) {
  const body = { lines };
  if (taxTreatment) body.tax_treatment = taxTreatment;
  const { data } = await am.command(`/sales-orders/${soId}/lines`, body, idempotencyKey);
  return data;
}

async function cancelSalesOrder(soId, reason, idempotencyKey) {
  const { data: so } = await am.get(`/sales-orders/${soId}`);
  const { data } = await am.command(`/sales-orders/${soId}/cancel`, { reason, expected_version: so.version || null }, idempotencyKey);
  return data;
}

// ── Amazon rolling sales order ───────────────────────────────────────────────
// Salesforce keeps one Amazon SO per 14-day payout period, named by an English
// date range ("Sep 25 - Oct 8"). In Automayt the period is the order's
// external_ref, "period:<start YYYY-MM-DD>", so lookup is exact. Windows are
// anchor + 14n: the anchor is AMAZON_PERIOD_ANCHOR (the start date of the
// Salesforce period open at cutover) or, once periods exist, the newest one.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** { start, end, key, label } of the 14-day window holding refDate. */
function amazonPeriod(refDate, anchor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) throw new Error(`amazonPeriod: bad anchor ${anchor}`);
  const ref = String(refDate).slice(0, 10);
  const n = Math.floor(dayDiff(ref, anchor) / AMAZON_PERIOD_DAYS);
  const start = addDays(anchor, n * AMAZON_PERIOD_DAYS);
  const end = addDays(start, AMAZON_PERIOD_DAYS - 1);
  const [sm, sd] = [Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10))];
  const [em, ed] = [Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10))];
  const label = sm === em ? `${MONTHS[sm]} ${sd} - ${ed}` : `${MONTHS[sm]} ${sd} - ${MONTHS[em]} ${ed}`;
  return { start, end, key: `period:${start}`, label };
}

async function amazonPeriodAnchor() {
  if (process.env.AMAZON_PERIOD_ANCHOR) return process.env.AMAZON_PERIOD_ANCHOR;
  const customerId = await resolveRef('amazonCustomer');
  const { data } = await am.get('/sales-orders', { customer_id: customerId, channel: 'amazon', sort: '-created_at', limit: 20 });
  const hit = ((data && data.data) || []).map((s) => /^period:(\d{4}-\d{2}-\d{2})$/.exec(s.external_ref || '')).find(Boolean);
  if (!hit) throw new Error('No AMAZON_PERIOD_ANCHOR and no Amazon period order in Automayt; set the anchor to the start of the Salesforce period open at cutover');
  return hit[1];
}

const AMAZON_TAX_TREATMENT = {
  gst_exempt: true,
  pst_exempt: true,
  gst_exempt_id: 'Third Party Amazon',
  pst_exempt_id: 'Third Party Amazon',
};

/**
 * Add one parcel's lines to the period order covering refDate, creating the
 * order with them if this is the period's first parcel. Each line needs an
 * external_line_ref unique to the parcel (e.g. `<amazonOrder>:1`), so a re-run
 * skips lines already there instead of doubling them.
 * Returns { so, period, created, lines } where lines are this parcel's SO
 * lines (with ids) in the order given. cache: Map period key → so id.
 */
async function addToAmazonPeriodSo(refDate, parcelKey, lines, cache = new Map()) {
  const period = amazonPeriod(refDate, await amazonPeriodAnchor());
  const wanted = new Set(lines.map((l) => l.external_line_ref));
  let soId = cache.get(period.key) || null;
  if (!soId) {
    const existing = await findSalesOrder('amazon', period.key);
    soId = existing ? existing.id : null;
  }

  let created = false;
  if (!soId) {
    // The key carries the parcel so a second parcel racing to open the same
    // period gets 409 duplicate (handled as "add to it") rather than
    // 422 idempotency_key_reused.
    const res = await am.command('/sales-orders', {
      customer_id: await resolveRef('amazonCustomer'),
      procurement_mode: 'external',
      type: 'supply',
      channel: 'amazon',
      external_ref: period.key,
      order_date: period.start,
      notes: `Amazon.ca payout period ${period.label} (${period.start} to ${period.end})`,
      tax_treatment: AMAZON_TAX_TREATMENT,
      lines,
    }, `amazon-${period.key}-open-${parcelKey}`).then((r) => ({ so: r.data, replayed: r.replayed }), (err) => {
      if (am.isDuplicate(err) && err.existingId) return { duplicateId: err.existingId };
      throw err;
    });
    if (res.so) {
      cache.set(period.key, res.so.id);
      created = !res.replayed;
      return { so: res.so, period, created, lines: res.so.lines.filter((l) => wanted.has(l.external_line_ref)) };
    }
    soId = res.duplicateId;
  }

  cache.set(period.key, soId);
  await addSalesOrderLines(soId, lines, `amazon-${period.key}-${parcelKey}-lines`);
  // Read the lines back so skipped (already-present) lines come with ids too.
  const all = await am.listAll(`/sales-orders/${soId}/lines`, { limit: 200 });
  const { data: so } = await am.get(`/sales-orders/${soId}`);
  return { so, period, created, lines: all.filter((l) => wanted.has(l.external_line_ref)) };
}

// ── Purchase orders ──────────────────────────────────────────────────────────

/** Map tracking code → existing PO matches. Throws on failure, never returns "none" for an error. */
async function checkTracking(codes) {
  const unique = [...new Set(codes.filter(Boolean).map(String))];
  const found = new Map();
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await am.post('/purchase-orders/check-tracking', { tracking_codes: unique.slice(i, i + 200) });
    for (const r of data.results || []) {
      if (r.matches && r.matches.length) found.set(r.tracking_code, r.matches);
    }
  }
  return found;
}

/**
 * Create a PO with all lines. status confirmed by default: every run-orders PO
 * is already placed with the vendor when it is written (the label is bought
 * first). Automayt never emails the vendor on create; run-orders still does.
 */
async function createPurchaseOrder({ idempotencyKey, vendorId, status = 'confirmed', type, salesOrderId, locationId, channel, externalRef, trackingCode, orderDate, shippingInstructions, vendorRef, taxTreatment, lines }) {
  const body = {
    vendor_id: vendorId,
    status,
    type: type || undefined,
    sales_order_id: salesOrderId || null,
    location_id: locationId || null,
    channel: channel || null,
    external_ref: externalRef || null,
    tracking_code: trackingCode || null,
    order_date: orderDate || null,
    shipping_instructions: shippingInstructions ? String(shippingInstructions).slice(0, 2000) : null,
    vendor_ref: vendorRef || null,
    tax_treatment: taxTreatment || null,
    lines,
  };
  try {
    const { data, requestId, replayed } = await am.command('/purchase-orders', body, idempotencyKey);
    return { po: data, created: !replayed, replayed, requestId };
  } catch (err) {
    if (am.isDuplicate(err) && err.existingId) {
      const { data } = await am.get(`/purchase-orders/${err.existingId}`);
      return { po: data, created: false, duplicate: true };
    }
    throw err;
  }
}

/** Add lines to an existing PO (FBA top-ups, manual repair). A received PO returns to partial. */
async function addPurchaseOrderLines(poId, lines, idempotencyKey) {
  const { data } = await am.command(`/purchase-orders/${poId}/lines`, { lines }, idempotencyKey);
  return data;
}

/** Post a receipt: stock, cost layer and GL accrual together, or nothing. */
async function receivePurchaseOrder(poId, { receivedAt, locationId, notes, lines }, idempotencyKey) {
  const body = {
    received_at: receivedAt || null,
    location_id: locationId || null,
    notes: notes || null,
    lines: lines.map((l) => ({ po_line_id: l.poLineId, qty: String(l.qty), ...(l.unitCost != null ? { unit_cost: String(l.unitCost) } : {}) })),
  };
  const { data } = await am.command(`/purchase-orders/${poId}/receipts`, body, idempotencyKey);
  if (!data || data.posted !== true) throw new Error(`Automayt receipt on PO ${poId} did not post`);
  return data;
}

async function cancelPurchaseOrder(poId, { reason, note }, idempotencyKey) {
  const { data: po } = await am.get(`/purchase-orders/${poId}`);
  const { data } = await am.command(`/purchase-orders/${poId}/cancel`, { reason, note: note || null, expected_version: po.version || null }, idempotencyKey);
  return data;
}

async function addPurchaseOrderNote(poId, { body, amount, mentionUserIds }, idempotencyKey) {
  const payload = { body };
  if (amount != null) payload.amount = String(amount);
  if (mentionUserIds && mentionUserIds.length) payload.mention_user_ids = mentionUserIds;
  const { data } = await am.command(`/purchase-orders/${poId}/notes`, payload, idempotencyKey);
  return data;
}

async function getPurchaseOrderPayables(poId) {
  const { data } = await am.get(`/purchase-orders/${poId}/payables`);
  return data;
}

/** Open supply (qty_remaining > 0) for a vendor, every page. */
async function openPurchaseOrderLines({ vendorId, itemId } = {}) {
  return am.listAll('/purchase-order-lines', { vendor_id: vendorId, item_id: itemId, remaining_gt: 0, limit: 200 });
}

module.exports = {
  REF_SYSTEM,
  FIXED_REFS,
  resolveRef,
  mapRef,
  findOrderContact,
  codeVariants,
  resolveItems,
  categoryIdByName,
  createItem,
  findSalesOrder,
  createSalesOrder,
  addSalesOrderLines,
  cancelSalesOrder,
  amazonPeriod,
  addToAmazonPeriodSo,
  AMAZON_TAX_TREATMENT,
  checkTracking,
  createPurchaseOrder,
  addPurchaseOrderLines,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  addPurchaseOrderNote,
  getPurchaseOrderPayables,
  openPurchaseOrderLines,
};
