/**
 * Amazon PO creation flow.
 *
 * After labels are bought in ShipStation, this creates the Salesforce SO lines + POs
 * that Kaitlyn needs to receive and ship inventory at Prosol.
 *
 * Amazon SO rotation:
 *   - 14-day periods matching Amazon payout schedule
 *   - Account: Amazon.ca (0014x00001P1SiHAAV)
 *   - Customer PO field: date range string, e.g. "Apr 9 - 22"
 *   - GST/PST exempt = true (Third Party Amazon)
 *   - If current period SO doesn't exist, auto-create it
 *
 * PO creation per order:
 *   1. Look up PBSI Item via prosol_sku → PBSI__Vendor_Item_ID__c
 *   2. Create SO Line (qty from order, price = sale price)
 *   3. Create PO (Prosol vendor, shipping instructions with tracking)
 *   4. Create PO Line (cost from PBSI__Cost__c, linked to SO + SO Line)
 */

const fs = require('fs');
const path = require('path');
const sf = require('./salesforce');
const { v1Request } = require('./shipstation-v2');
const { createPbsiItem } = require('./shopify-sf');

const SKU_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8'));
const SKU_MAPPINGS = SKU_MAP.mappings || {};

const AMAZON_ACCOUNT_ID = '0014x00001P1SiHAAV';
const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';
const TAX_CODE_ID = 'a1S4x000002pMUhEAM';
const PERIOD_DAYS = 14;

// Virtual "Amazon Fulfillment" PBSI Location — every Amazon order is received
// here in Salesforce on the same pass that creates the PO line, so SF inventory
// reflects the move from Prosol → Amazon-channel without manual entry. Mac
// directive 2026-05-26: must happen for every shipped Amazon order.
const AMAZON_FULFILLMENT_LOCATION_ID = 'a0v4x000005kF5ZAAU';
const AMAZON_FULFILLMENT_LOCATION_NAME = 'Amazon Fulfillment';

// ── Auto-receive via PBSI managed action ─────────────────────────────────────
//
// The 2026-05-26 implementation receiving directly via
// `sf.create('PBSI__Received_Purchase_Order_Line__c', …)` was found on
// 2026-05-28 to skip every managed-package side effect that makes a receipt
// actually post: no PBSI__Movement_Journal__c, no Movement Lines, no QB sync,
// and the PO's CFC custom fields stayed blank. Net effect: inventory at the
// Amazon Fulfillment virtual location accumulated as Qoh without ever being
// packable, and vendor invoices couldn't be posted.
//
// The manual Receive Form invokes the same path under the hood as the
// invocable PBSI__ReceivedPOLinesCreateAction (callable via the REST Actions
// API): take a populated PBSI__Received_Purchase_Order_Line__c, return the
// created record id, AND trigger MJ + Movement Lines creation atomically.
// Switching to this path also fixes invoice posting — the PO ends at status
// 'Received' (not 'Closed') so the natural Vendor Invoiced → Paid flow can
// proceed and payables can match.
async function invokeReceivedPOLineAction(conn, receivedPOLine) {
  const v = conn.version || '42.0';
  const url = `/services/data/v${v}/actions/custom/apex/PBSI__ReceivedPOLinesCreateAction`;
  const body = {
    inputs: [{
      receivedRequests: [{ receivedPOLine }],
    }],
  };
  // The Actions REST endpoint returns 200 with per-input result envelopes
  // (an array). Per-input failures surface inside the envelope as
  // isSuccess:false + errors[], not as an HTTP error.
  //
  // Use requestPost (NOT request): jsforce 1.x's conn.request({...,body}) passes
  // the body object to the transport unserialized with no content-type, throwing
  // "Argument error, options.body" + a "chunk must be string, received Object"
  // stream error — silently breaking PO creation since 2026-05-28 (commit
  // 0546fe2). requestPost does JSON.stringify(body) + content-type: application/json.
  const res = await conn.requestPost(url, body);
  const result = Array.isArray(res) ? res[0] : res;
  if (!result || result.isSuccess === false) {
    const errMsg = (result && result.errors && result.errors[0] && result.errors[0].message)
      || (result && result.outputValues && result.outputValues.message)
      || 'unknown action failure';
    throw new Error(`PBSI__ReceivedPOLinesCreateAction failed: ${errMsg}`);
  }
  return {
    receivedPOLineId: result.outputValues && result.outputValues.receivedPOLineId,
    message: result.outputValues && result.outputValues.message,
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseISODate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: parseInt(m[1]), mo: parseInt(m[2]) - 1, d: parseInt(m[3]) };
}

function formatDateRange(startDate, endDate) {
  const s = parseISODate(startDate);
  const e = parseISODate(endDate);
  if (!s || !e) return `${startDate} - ${endDate}`;
  const sMonth = MONTHS_SHORT[s.mo];
  const eMonth = MONTHS_SHORT[e.mo];
  if (sMonth === eMonth) return `${sMonth} ${s.d} - ${e.d}`;
  return `${sMonth} ${s.d} - ${eMonth} ${e.d}`;
}

function addDays(dateStr, days) {
  const p = parseISODate(dateStr);
  if (!p) return dateStr;
  const d = new Date(Date.UTC(p.y, p.mo, p.d));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseEndDate(customerPO, anchorDateStr = null) {
  // Parse date ranges like "March 26 - Apr 8", "FEB.26 - MAR 11", "Feb 12 - 25".
  // anchorDateStr (optional, ISO YYYY-MM-DD) gives the year reliably — pass the
  // SO's PBSI__Order_Date__c when available. The day on that field may have
  // been mis-set by old code, but the year is trustworthy.
  if (!customerPO) return null;
  const text = customerPO.trim();

  const monthMap = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  function parseMonth(s) { return monthMap[s.replace(/\./g, '').toLowerCase()]; }

  const match = text.match(/^(\w+\.?)\s+(\d+)\s*-\s*(?:(\w+\.?)\s+)?(\d+)$/i);
  if (!match) return null;

  const startMonth = parseMonth(match[1]);
  const endMonth = match[3] ? parseMonth(match[3]) : startMonth;
  const endDay = parseInt(match[4]);
  if (startMonth == null || endMonth == null) return null;

  // Determine the start year. Prefer anchor (SO's order date — its year is
  // reliable). Fall back to "now" with a heuristic for early-year lookups
  // against late-year ranges.
  let startYear = null;
  if (anchorDateStr) {
    const m = String(anchorDateStr).match(/^(\d{4})-/);
    if (m) startYear = parseInt(m[1]);
  }
  if (startYear == null) {
    const now = new Date();
    startYear = now.getFullYear();
    // E.g. running on Jan 5 against a "Dec 25 - Jan 7" range → start was last year
    if (now.getMonth() <= 1 && startMonth >= 10) startYear -= 1;
  }

  // End year is the same as start year unless the range crosses Dec → Jan
  const endYear = (endMonth < startMonth) ? startYear + 1 : startYear;
  // Date.UTC avoids local-timezone drift in toISOString
  return new Date(Date.UTC(endYear, endMonth, endDay)).toISOString().slice(0, 10);
}

// ── Amazon SO management ─────────────────────────────────────────────────────

async function findRecentAmazonSOs(conn, limit = 10) {
  const records = await sf.query(conn, `
    SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
    FROM PBSI__PBSI_Sales_Order__c
    WHERE PBSI__Customer__c = '${AMAZON_ACCOUNT_ID}'
    ORDER BY Name DESC
    LIMIT ${Math.max(1, limit)}
  `);
  return records;
}

async function clearAccountHold(conn, accountId) {
  try {
    await conn.sobject('Account').update({ Id: accountId, mm_On_Hold__c: false });
  } catch { /* ignore — hold field may not block all accounts */ }
}

function normalizeDate(input) {
  if (!input) return null;
  const s = String(input).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function todayPacific() {
  // YYYY-MM-DD in Pacific time, regardless of process timezone.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

/**
 * Find or create the Amazon SO whose 14-day window contains refDate.
 * refDate: 'YYYY-MM-DD' (typically the shipment's ship date).
 * cache: Array<{ so, startDate, endDate }> shared across a batch — pass {} or [].
 *
 * Goal: each shipment lands on the SO whose date range actually matches its
 * ship date, not whichever SO happens to be active when the cron runs.
 * Replaces the old today-based matching that caused accounting reconciliation
 * issues when orders processed late slipped into the next period's SO.
 */
async function getOrCreateAmazonSOForDate(conn, refDate, cache) {
  if (!Array.isArray(cache)) cache = [];
  const ref = normalizeDate(refDate) || todayPacific();

  // Cache hit — same window covers this ref date
  for (const entry of cache) {
    if (entry.startDate <= ref && ref <= entry.endDate) {
      return { so: entry.so, created: false, cached: true };
    }
  }

  await clearAccountHold(conn, AMAZON_ACCOUNT_ID);

  const recent = await findRecentAmazonSOs(conn, 10);

  // Walk recent SOs, find one whose end date >= ref AND start <= ref.
  // Start date is derived as (endDate - 13) — the canonical 14-day window
  // the date-range string represents. We deliberately don't trust
  // PBSI__Order_Date__c on the SO record because the old code set it to
  // whenever-the-cron-ran-that-day, which can be a few days off.
  for (const rec of recent) {
    const endDate = parseEndDate(rec.PBSI__Customer_Purchase_Order__c, rec.PBSI__Order_Date__c);
    if (!endDate) continue;
    const startDate = addDays(endDate, -(PERIOD_DAYS - 1));
    if (startDate <= ref && ref <= endDate) {
      cache.push({ so: rec, startDate, endDate });
      return { so: rec, created: false, cached: false };
    }
  }

  // No existing SO covers refDate. Decide what to create.
  const mostRecent = recent[0] || null;
  const mostRecentEnd = mostRecent ? parseEndDate(mostRecent.PBSI__Customer_Purchase_Order__c, mostRecent.PBSI__Order_Date__c) : null;

  let startDate;
  if (mostRecentEnd && ref > mostRecentEnd) {
    // Forward-fill: ref is past the last known SO's window — start the next period the day after.
    startDate = addDays(mostRecentEnd, 1);
  } else if (mostRecentEnd && ref < mostRecentEnd) {
    // Ref is older than every SO we fetched (rare — backfill of very old shipment).
    // Fall back to using the most recent SO and warn loudly so accounting can move it manually.
    const oldest = recent[recent.length - 1];
    console.warn(`[amazon-po] ship date ${ref} is older than oldest known SO (ends ${parseEndDate(oldest?.PBSI__Customer_Purchase_Order__c, oldest?.PBSI__Order_Date__c)}); using most recent SO ${mostRecent.Name}`);
    const endDate = mostRecentEnd;
    const fallbackStart = addDays(endDate, -(PERIOD_DAYS - 1));
    cache.push({ so: mostRecent, startDate: fallbackStart, endDate });
    return { so: mostRecent, created: false, cached: false };
  } else {
    // No prior SO at all — start the period at refDate.
    startDate = ref;
  }

  const endDate = addDays(startDate, PERIOD_DAYS - 1);
  const dateRange = formatDateRange(startDate, endDate);

  const soId = await sf.create(conn, 'PBSI__PBSI_Sales_Order__c', {
    PBSI__Customer__c: AMAZON_ACCOUNT_ID,
    PBSI__Status__c: 'Open',
    PBSI__Order_Date__c: startDate,
    PBSI__Customer_Purchase_Order__c: dateRange,
    PBSI__Tax_Code__c: TAX_CODE_ID,
    mm_Exempt_GST__c: true,
    mm_Exempt_PST__c: true,
    mm_Exempt_GST_ID__c: 'Third Party Amazon',
    mm_Exempt_PST_ID__c: 'Third Party Amazon',
    PBSI__BOL_Description__c: 'None',
  });

  const fetched = await sf.query(conn, `
    SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
    FROM PBSI__PBSI_Sales_Order__c WHERE Id = '${soId}'
  `);
  const so = fetched[0] || { Id: soId, Name: soId, PBSI__Customer_Purchase_Order__c: dateRange, PBSI__Order_Date__c: startDate };
  cache.push({ so, startDate, endDate });
  return { so, created: true, cached: false };
}

// ── PBSI Item lookup ─────────────────────────────────────────────────────────

async function findPbsiItem(conn, prosolSku) {
  if (!prosolSku) return null;

  // Build the variant list. Salesforce historically stored Schluter Vendor
  // IDs without separators (KERDIFIXBW, DitraDRAIN25M, DHERT103BW) while
  // sku-map carries the slashed Prosol-storefront form (project_prosol_sku_slashes).
  // We try MOST-STRIPPED first so when both legacy and auto-created dupes
  // exist, the canonical legacy row wins and the dupe (created before this
  // fix landed) becomes orphaned for future lookups.
  const stripped = prosolSku.replace(/[\/-]/g, '');
  const noSlash = prosolSku.replace(/\//g, '');
  const noHyphen = prosolSku.replace(/-/g, '');
  const variants = [];
  for (const v of [stripped, noSlash, noHyphen, prosolSku]) {
    if (v && !variants.includes(v)) variants.push(v);
  }

  for (const v of variants) {
    const records = await sf.query(conn, `
      SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c
      FROM PBSI__PBSI_Item__c
      WHERE PBSI__Vendor_Item_ID__c = '${v.replace(/'/g, "\\'")}'
      LIMIT 1
    `);
    if (records.length) return records[0];
  }

  // Fuzzy: try stripping leading zeros from suffix (C100978-01 → C100978-1)
  const dashMatch = prosolSku.match(/^(.+)-0*(\d+)$/);
  if (dashMatch) {
    const fuzzy = `${dashMatch[1]}-${dashMatch[2]}`;
    if (fuzzy !== prosolSku) {
      const records = await sf.query(conn, `
        SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c
        FROM PBSI__PBSI_Item__c
        WHERE PBSI__Vendor_Item_ID__c = '${fuzzy.replace(/'/g, "\\'")}'
        LIMIT 1
      `);
      if (records.length) return records[0];
    }
  }

  // Last resort: LIKE with base code
  const baseCode = prosolSku.replace(/-\d+$/, '');
  if (baseCode !== prosolSku) {
    const records = await sf.query(conn, `
      SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c
      FROM PBSI__PBSI_Item__c
      WHERE PBSI__Vendor_Item_ID__c LIKE '${baseCode.replace(/'/g, "\\'")}%'
      LIMIT 1
    `);
    if (records.length) return records[0];
  }

  return null;
}

// ── Get prosol_sku from sku-map ──────────────────────────────────────────────

/**
 * Resolve a ShipStation SKU to one or more { prosol_sku, qty } entries.
 * Returns array — bundles expand to multiple components.
 */
function resolveSkuForPO(shipstationSku, orderQty = 1) {
  const entry = SKU_MAPPINGS[shipstationSku];
  if (!entry) return null;
  if (typeof entry === 'string') return null; // Section headers

  // Bundle — expand components
  if (entry.bundle && Array.isArray(entry.components)) {
    const results = [];
    for (const comp of entry.components) {
      const sku = comp.prosol_sku || comp.api_sku;
      if (!sku || ['NON_PROSOL', 'SKIP', 'UNMAPPED'].includes(sku)) continue;
      results.push({ prosolSku: sku, qty: (comp.qty || 1) * orderQty, product: comp.product });
    }
    return results.length ? results : null;
  }

  // Non-Prosol / skip
  if (['NON_PROSOL', 'SKIP', 'UNMAPPED', 'UNMAPPED_GROUT', 'UNMAPPED_CABLE'].includes(entry.api_sku)) return null;

  const sku = entry.prosol_sku && entry.prosol_sku !== 'NON_PROSOL' ? entry.prosol_sku : entry.api_sku;
  if (!sku) return null;
  return [{ prosolSku: sku, qty: orderQty, product: entry.product }];
}

// ── Fetch shipped orders needing POs ─────────────────────────────────────────

async function fetchShippedOrdersForPO({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const shipments = [];
  let page = 1;
  let pages = 1;

  while (page <= pages) {
    const res = await v1Request('GET', `/shipments?shipDateStart=${since}&pageSize=100&page=${page}`);
    if (res.status !== 200) throw new Error(`Shipments fetch failed: ${res.status}`);
    const data = JSON.parse(res.body);
    shipments.push(...(data.shipments || []));
    pages = data.pages || 1;
    page++;
  }

  // We need order details (items) — shipments don't include them
  // Fetch the corresponding orders
  const orderIds = [...new Set(shipments.map(s => s.orderId).filter(Boolean))];
  const orders = {};
  for (const orderId of orderIds) {
    const res = await v1Request('GET', `/orders/${orderId}`);
    if (res.status === 200) {
      const order = JSON.parse(res.body);
      orders[orderId] = order;
    }
  }

  return shipments
    .filter(s => s.orderId && orders[s.orderId])
    .map(s => {
      const order = orders[s.orderId];
      return {
        shipmentId: s.shipmentId,
        orderId: s.orderId,
        orderNumber: order.orderNumber || s.orderNumber,
        trackingNumber: s.trackingNumber,
        carrierCode: s.carrierCode,
        serviceCode: s.serviceCode,
        shipDate: s.shipDate,
        source: order.advancedOptions?.source || '',
        shipTo: order.shipTo,
        items: (order.items || []).map(i => ({
          sku: i.sku,
          name: i.name,
          quantity: i.quantity || 1,
          unitPrice: i.unitPrice,
        })),
      };
    })
    .filter(s => s.source === 'amazon_ca'); // Amazon only
}

// ── Check which orders already have POs ──────────────────────────────────────

async function findExistingPOsByTracking(conn, trackingNumbers) {
  if (!trackingNumbers.length) return new Set();
  const chunks = [];
  for (let i = 0; i < trackingNumbers.length; i += 50) {
    chunks.push(trackingNumbers.slice(i, i + 50));
  }
  const existing = new Set();
  for (const chunk of chunks) {
    const inClause = chunk.map(t => `'${t}'`).join(',');
    const records = await sf.query(conn, `
      SELECT PBSI__Tracking_Code__c FROM PBSI__PBSI_Purchase_Order__c
      WHERE PBSI__Tracking_Code__c IN (${inClause})
    `);
    for (const r of records) {
      if (r.PBSI__Tracking_Code__c) existing.add(r.PBSI__Tracking_Code__c);
    }
  }
  return existing;
}

// ── Main: create POs for shipped Amazon orders ───────────────────────────────

async function createAmazonPOs({ days = 7, onProgress = () => {} } = {}) {
  const results = {
    soName: null,
    soCreated: false,
    orders: [],
    errors: [],
  };

  // 1. Connect to Salesforce
  onProgress({ step: 'sf-login', message: 'Logging into Salesforce...' });
  let conn;
  try {
    conn = await sf.connect();
  } catch (err) {
    results.errors.push({ step: 'sf-login', error: err.message });
    return results;
  }

  // 2. SO selection moved into the per-shipment loop so each shipment lands on
  //    the SO whose 14-day window contains its ship date (not whichever SO is
  //    "current" when the cron happens to run). soCache is shared across the
  //    batch so the SF query for each window only happens once.
  const soCache = [];
  results.soNames = [];
  results.soCreated = false;

  // 3. Fetch shipped orders
  onProgress({ step: 'fetch-shipments', message: 'Fetching shipped Amazon orders...' });
  let shipments;
  try {
    shipments = await fetchShippedOrdersForPO({ days });
    onProgress({ step: 'fetch-shipments', message: `Found ${shipments.length} shipped Amazon orders` });
  } catch (err) {
    results.errors.push({ step: 'fetch-shipments', error: err.message });
    return results;
  }

  // 4. Filter out orders that already have POs
  const trackingNumbers = shipments.map(s => s.trackingNumber).filter(Boolean);
  let existingPOs;
  try {
    existingPOs = await findExistingPOsByTracking(conn, trackingNumbers);
  } catch (err) {
    results.errors.push({ step: 'check-existing', error: err.message });
    existingPOs = new Set();
  }

  const needsPO = shipments.filter(s => !existingPOs.has(s.trackingNumber));
  const skipped = shipments.filter(s => existingPOs.has(s.trackingNumber));

  onProgress({ step: 'filter', message: `${needsPO.length} need POs, ${skipped.length} already have POs` });

  for (const s of skipped) {
    results.orders.push({
      orderNumber: s.orderNumber,
      trackingNumber: s.trackingNumber,
      status: 'skipped',
      reason: 'PO already exists for this tracking number',
    });
  }

  // 5. Create POs for each order
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

    onProgress({ step: 'create-po', message: `Processing ${shipment.orderNumber}...` });

    let soId, soName;
    try {
      // Pick the SO whose 14-day window covers this shipment's ship date.
      // Cached per-window so multiple shipments in the same period reuse the lookup.
      const sel = await getOrCreateAmazonSOForDate(conn, shipment.shipDate, soCache);
      soId = sel.so.Id;
      soName = sel.so.Name;
      orderResult.soName = soName;
      if (sel.created) results.soCreated = true;
      if (!results.soNames.includes(soName)) results.soNames.push(soName);
    } catch (err) {
      orderResult.status = 'error';
      orderResult.errors.push(`SO selection failed: ${err.message}`);
      results.orders.push(orderResult);
      continue;
    }

    try {
      // Resolve items to PBSI (handles bundles)
      const resolvedItems = [];
      let allItemsNonProsol = true;
      for (const item of shipment.items) {
        const entry = SKU_MAPPINGS[item.sku];
        const isNonProsol = entry && (entry.api_sku === 'NON_PROSOL' || entry.api_sku === 'SKIP');
        const resolved = resolveSkuForPO(item.sku, item.quantity);
        if (!resolved) {
          if (!isNonProsol) {
            orderResult.errors.push(`No prosol_sku for ShipStation SKU ${item.sku} (${item.name})`);
          }
          continue;
        }
        allItemsNonProsol = false;

        for (const comp of resolved) {
          let pbsiItem = await findPbsiItem(conn, comp.prosolSku);
          // Lazy auto-create — mirror the Shopify path (lib/shopify-sf.js:347).
          // 2026-05-25: Mac asked for this everywhere. Previously only Shopify
          // orders auto-created; Amazon orders errored when PBSI items were
          // missing (e.g. Mapei Moonbeam B0CS3W22YC). Now both paths create on
          // miss so a stale Salesforce catalog never blocks a PO.
          if (!pbsiItem) {
            const entry = SKU_MAPPINGS[item.sku];
            const apiSku = entry && typeof entry === 'object' ? entry.api_sku : null;
            try {
              pbsiItem = await createPbsiItem(conn, {
                mfgSku: apiSku || item.sku,
                prosolSku: comp.prosolSku,
                productName: comp.product,
                title: item.name,
                entry,
              });
              if (!orderResult.autoCreated) orderResult.autoCreated = [];
              orderResult.autoCreated.push({ pbsiItemId: pbsiItem.Id, pbsiItemName: pbsiItem.Name, prosolSku: comp.prosolSku, sourceSku: item.sku });
              console.log(`[amazon-po] auto-created PBSI item ${pbsiItem.Name} (id=${pbsiItem.Id}) for prosol_sku=${comp.prosolSku} sourceSku=${item.sku} cost=${pbsiItem.PBSI__Cost__c || 'TBD'} retail=${pbsiItem.PBSI__salesprice__c || 'TBD'}`);
            } catch (err) {
              orderResult.errors.push(`PBSI auto-create failed for prosol_sku ${comp.prosolSku} (SS SKU: ${item.sku}): ${err.message}`);
              continue;
            }
          }

          resolvedItems.push({
            sku: item.sku,
            name: comp.product || item.name,
            quantity: comp.qty,
            unitPrice: item.unitPrice,
            prosolSku: comp.prosolSku,
            pbsiItemId: pbsiItem.Id,
            pbsiItemName: pbsiItem.Name,
            salePrice: pbsiItem.PBSI__salesprice__c || item.unitPrice || 0,
            costPrice: pbsiItem.PBSI__Cost__c || 0,
          });
        }
      }

      if (!resolvedItems.length) {
        if (allItemsNonProsol) {
          orderResult.status = 'skipped';
          orderResult.reason = 'Non-Prosol item — no PO needed';
        } else {
          orderResult.status = 'error';
          orderResult.errors.push('No items could be resolved to PBSI');
        }
        results.orders.push(orderResult);
        continue;
      }

      // Create SO lines
      for (const item of resolvedItems) {
        try {
          const soLineId = await sf.create(conn, 'PBSI__PBSI_Sales_Order_Line__c', {
            PBSI__Sales_Order__c: soId,
            PBSI__Item__c: item.pbsiItemId,
            PBSI__Quantity__c: item.quantity,
            PBSI__Quantity_Needed__c: item.quantity,
            PBSI__Price__c: item.salePrice,
          });
          orderResult.soLineIds.push({ itemId: item.pbsiItemId, soLineId });
          orderResult.items.push({
            sku: item.sku,
            pbsiItem: item.pbsiItemName,
            qty: item.quantity,
            salePrice: item.salePrice,
            costPrice: item.costPrice,
          });
        } catch (err) {
          orderResult.errors.push(`SO line for ${item.pbsiItemName}: ${err.message}`);
        }
      }

      if (!orderResult.soLineIds.length) {
        orderResult.status = 'error';
        results.orders.push(orderResult);
        continue;
      }

      // Create PO
      const customerName = shipment.shipTo?.name || 'Unknown';
      const city = shipment.shipTo?.city || '';
      const postalCode = (shipment.shipTo?.postalCode || '').trim();
      const carrierDisplay = (shipment.carrierCode || '').replace('_walleted', '').replace(/_/g, ' ');

      const poId = await sf.create(conn, 'PBSI__PBSI_Purchase_Order__c', {
        PBSI__Account__c: PROSOL_VENDOR_ID,
        PBSI__Order_Date__c: normalizeDate(shipment.shipDate) || todayPacific(),
        PBSI__Status__c: 'Open',
        PBSI__Shipping_Instructions__c: `Amazon Order ${shipment.orderNumber} — ${customerName}, ${city} ${postalCode} — ${carrierDisplay} — Tracking: ${shipment.trackingNumber}`.slice(0, 255),
        PBSI__Tracking_Code__c: shipment.trackingNumber || '',
      });
      orderResult.poId = poId;

      // Get PO number
      const poRecords = await sf.query(conn, `SELECT Name FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '${poId}'`);
      orderResult.poNumber = poRecords[0]?.Name || poId;

      // Create PO lines + matching receipts at Amazon Fulfillment.
      orderResult.receipts = orderResult.receipts || [];
      for (const item of resolvedItems) {
        const soLineEntry = orderResult.soLineIds.find(e => e.itemId === item.pbsiItemId);
        if (!soLineEntry) continue;

        let poLineId = null;
        try {
          poLineId = await sf.create(conn, 'PBSI__PBSI_Purchase_Order_Line__c', {
            PBSI__Purchase_Order__c: poId,
            PBSI__Item__c: item.pbsiItemId,
            PBSI__Quantity_Ordered__c: item.quantity,
            PBSI__Price__c: item.costPrice,
            PBSI__Sales_Order__c: soId,
            PBSI__Original_SO_Line__c: soLineEntry.soLineId,
          });
        } catch (err) {
          orderResult.errors.push(`PO line for ${item.pbsiItemName}: ${err.message}`);
          continue;
        }

        // Receive into Amazon Fulfillment immediately, via the managed
        // PBSI__ReceivedPOLinesCreateAction (see helper at top of file).
        // Direct sf.create() bypasses the MJ-creation chain and was the root
        // cause of the 2026-05-28 "inventory not packable / can't post
        // invoices" symptom. Failure here doesn't roll back the PO line — we
        // log and flag so a person can reconcile manually.
        try {
          const actionRes = await invokeReceivedPOLineAction(conn, {
            PBSI__Purchase_Order__c: poId,
            PBSI__Purchase_Order_Line__c: poLineId,
            PBSI__Item__c: item.pbsiItemId,
            PBSI__Location__c: AMAZON_FULFILLMENT_LOCATION_ID,
            PBSI__Quantity_Received__c: item.quantity,
            PBSI__Receiving_Date__c: normalizeDate(shipment.shipDate) || todayPacific(),
            PBSI__Price__c: item.costPrice,
            PBSI__Type__c: 'receive',
          });
          orderResult.receipts.push({
            itemId: item.pbsiItemId,
            qty: item.quantity,
            receiptId: actionRes.receivedPOLineId,
            actionMessage: actionRes.message,
          });
        } catch (err) {
          orderResult.errors.push(`Receive at Amazon Fulfillment for ${item.pbsiItemName}: ${err.message}`);
        }
      }

      // Advance to 'Received' (NOT 'Closed') once every line has been
      // received, and stamp the CFC custom fields the manual Receive Form
      // sets. The 2026-05-26 "close-on-fully-received" directive was reversed
      // on 2026-05-28: 'Closed' is a terminal state in PBSI and blocks
      // downstream payable creation, which is one of the symptoms that
      // surfaced when auto-receive was first audited. 'Received' lets the
      // natural Vendor Invoiced → Paid flow proceed.
      //
      // Also verify a Movement Journal was attached. If the managed action
      // ran but produced no MJ (defensive guard — shouldn't happen, but the
      // whole point of this refactor is the MJ), flag the PO loudly so we
      // notice on the first auto-received order rather than days later.
      const allReceived = resolvedItems.length > 0
        && resolvedItems.every((item) => orderResult.receipts.some((r) => r.itemId === item.pbsiItemId));
      if (allReceived) {
        try {
          await conn.sobject('PBSI__PBSI_Purchase_Order__c').update({
            Id: poId,
            PBSI__Status__c: 'Received',
            Received_Location__c: AMAZON_FULFILLMENT_LOCATION_ID,
            mm_Received_Location_Name__c: AMAZON_FULFILLMENT_LOCATION_NAME,
            Date_Received__c: normalizeDate(shipment.shipDate) || todayPacific(),
            CFC_Stage__c: 'Received',
          });
          orderResult.received = true;

          const verify = await sf.query(
            conn,
            `SELECT PBSI__Movement_Journal__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '${poId}'`,
          );
          const mjId = verify[0] && verify[0].PBSI__Movement_Journal__c;
          if (mjId) {
            orderResult.movementJournalId = mjId;
          } else {
            orderResult.errors.push(
              `PO ${orderResult.poNumber}: receipt action ran but no PBSI__Movement_Journal__c attached — investigate`,
            );
          }
        } catch (err) {
          orderResult.errors.push(`Advance-to-Received PO ${orderResult.poNumber}: ${err.message}`);
        }
      }

      orderResult.status = orderResult.errors.length ? 'partial' : 'created';
      onProgress({ step: 'po-created', message: `${orderResult.poNumber} for ${shipment.orderNumber}` });
    } catch (err) {
      orderResult.status = 'error';
      orderResult.errors.push(err.message);
    }

    results.orders.push(orderResult);
  }

  // For UI back-compat: surface the first SO touched as `soName`. The full
  // list is in `results.soNames` for callers that want to render all of them.
  results.soName = results.soNames[0] || null;

  return results;
}

// Back-compat alias for server.js /api/amazon/current-so endpoint.
async function findMostRecentAmazonSO(conn) {
  const recent = await findRecentAmazonSOs(conn, 1);
  return recent[0] || null;
}

module.exports = {
  getOrCreateAmazonSOForDate,
  findPbsiItem,
  createAmazonPOs,
  fetchShippedOrdersForPO,
  findExistingPOsByTracking,
  findMostRecentAmazonSO,
  findRecentAmazonSOs,
  parseEndDate,
  resolveSkuForPO,
};
