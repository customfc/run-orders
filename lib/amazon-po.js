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

const SKU_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json'), 'utf8'));
const SKU_MAPPINGS = SKU_MAP.mappings || {};

const AMAZON_ACCOUNT_ID = '0014x00001P1SiHAAV';
const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';
const TAX_CODE_ID = 'a1S4x000002pMUhEAM';
const PERIOD_DAYS = 14;

// ── Date helpers ─────────────────────────────────────────────────────────────

function formatDateRange(startDate, endDate) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T00:00:00');
  const sMonth = months[s.getMonth()];
  const eMonth = months[e.getMonth()];
  const sDay = s.getDate();
  const eDay = e.getDate();
  if (sMonth === eMonth) return `${sMonth} ${sDay} - ${eDay}`;
  return `${sMonth} ${sDay} - ${eMonth} ${eDay}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseEndDate(customerPO) {
  // Parse date ranges like "March 26 - Apr 8", "FEB.26 - MAR 11", "Feb 12 - 25"
  if (!customerPO) return null;
  const text = customerPO.trim();

  // Normalize month names
  const monthMap = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  function parseMonth(s) {
    return monthMap[s.replace(/\./g, '').toLowerCase()];
  }

  // Pattern: "Month DD - Month DD" or "Month DD - DD"
  const match = text.match(/^(\w+\.?)\s+(\d+)\s*-\s*(?:(\w+\.?)\s+)?(\d+)$/i);
  if (!match) return null;

  const startMonth = parseMonth(match[1]);
  const startDay = parseInt(match[2]);
  const endMonth = match[3] ? parseMonth(match[3]) : startMonth;
  const endDay = parseInt(match[4]);

  if (startMonth == null || endMonth == null) return null;

  const now = new Date();
  let year = now.getFullYear();
  // Handle year boundary (if end month is January and we're in December)
  const endDate = new Date(year, endMonth, endDay);
  return endDate.toISOString().slice(0, 10);
}

// ── Amazon SO management ─────────────────────────────────────────────────────

async function findMostRecentAmazonSO(conn) {
  const records = await sf.query(conn, `
    SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
    FROM PBSI__PBSI_Sales_Order__c
    WHERE PBSI__Customer__c = '${AMAZON_ACCOUNT_ID}'
    ORDER BY Name DESC
    LIMIT 1
  `);
  return records[0] || null;
}

async function clearAccountHold(conn, accountId) {
  try {
    await conn.sobject('Account').update({ Id: accountId, mm_On_Hold__c: false });
  } catch { /* ignore — hold field may not block all accounts */ }
}

async function getOrCreateCurrentAmazonSO(conn) {
  // Auto-clear the stupid hold that the Flow keeps re-applying
  await clearAccountHold(conn, AMAZON_ACCOUNT_ID);

  const mostRecent = await findMostRecentAmazonSO(conn);
  const today = new Date().toISOString().slice(0, 10);

  if (mostRecent) {
    const endDate = parseEndDate(mostRecent.PBSI__Customer_Purchase_Order__c);
    if (endDate && today <= endDate) {
      return { so: mostRecent, created: false };
    }
  }

  // Need a new SO — calculate the next period
  let startDate = today;
  if (mostRecent) {
    const prevEnd = parseEndDate(mostRecent.PBSI__Customer_Purchase_Order__c);
    if (prevEnd) {
      startDate = addDays(prevEnd, 1);
      // If the calculated start is in the future, something is off — use today
      if (startDate > today) startDate = today;
    }
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

  // Fetch it back to get the SO number
  const created = await sf.query(conn, `
    SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
    FROM PBSI__PBSI_Sales_Order__c WHERE Id = '${soId}'
  `);

  return { so: created[0] || { Id: soId, Name: soId }, created: true };
}

// ── PBSI Item lookup ─────────────────────────────────────────────────────────

async function findPbsiItem(conn, prosolSku) {
  if (!prosolSku) return null;

  // Exact match first
  let records = await sf.query(conn, `
    SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c
    FROM PBSI__PBSI_Item__c
    WHERE PBSI__Vendor_Item_ID__c = '${prosolSku.replace(/'/g, "\\'")}'
    LIMIT 1
  `);
  if (records.length) return records[0];

  // Fuzzy: try stripping leading zeros from suffix (C100978-01 → C100978-1)
  const dashMatch = prosolSku.match(/^(.+)-0*(\d+)$/);
  if (dashMatch) {
    const fuzzy = `${dashMatch[1]}-${dashMatch[2]}`;
    if (fuzzy !== prosolSku) {
      records = await sf.query(conn, `
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
    records = await sf.query(conn, `
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

  // 2. Get or create current Amazon SO
  onProgress({ step: 'amazon-so', message: 'Finding current Amazon SO...' });
  let soId, soName;
  try {
    const { so, created } = await getOrCreateCurrentAmazonSO(conn);
    soId = so.Id;
    soName = so.Name;
    results.soName = soName;
    results.soCreated = created;
    onProgress({ step: 'amazon-so', message: created
      ? `Created new SO: ${soName} (${so.PBSI__Customer_Purchase_Order__c})`
      : `Using existing SO: ${soName} (${so.PBSI__Customer_Purchase_Order__c})` });
  } catch (err) {
    results.errors.push({ step: 'amazon-so', error: err.message });
    return results;
  }

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
          const pbsiItem = await findPbsiItem(conn, comp.prosolSku);
          if (!pbsiItem) {
            orderResult.errors.push(`PBSI item not found for prosol_sku ${comp.prosolSku} (SS SKU: ${item.sku})`);
            continue;
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
        PBSI__Order_Date__c: new Date().toISOString().slice(0, 10),
        PBSI__Status__c: 'Open',
        PBSI__Shipping_Instructions__c: `Amazon Order ${shipment.orderNumber} — ${customerName}, ${city} ${postalCode} — ${carrierDisplay} — Tracking: ${shipment.trackingNumber}`.slice(0, 255),
        PBSI__Tracking_Code__c: shipment.trackingNumber || '',
      });
      orderResult.poId = poId;

      // Get PO number
      const poRecords = await sf.query(conn, `SELECT Name FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '${poId}'`);
      orderResult.poNumber = poRecords[0]?.Name || poId;

      // Create PO lines
      for (const item of resolvedItems) {
        const soLineEntry = orderResult.soLineIds.find(e => e.itemId === item.pbsiItemId);
        if (!soLineEntry) continue;

        try {
          await sf.create(conn, 'PBSI__PBSI_Purchase_Order_Line__c', {
            PBSI__Purchase_Order__c: poId,
            PBSI__Item__c: item.pbsiItemId,
            PBSI__Quantity_Ordered__c: item.quantity,
            PBSI__Price__c: item.costPrice,
            PBSI__Sales_Order__c: soId,
            PBSI__Original_SO_Line__c: soLineEntry.soLineId,
          });
        } catch (err) {
          orderResult.errors.push(`PO line for ${item.pbsiItemName}: ${err.message}`);
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

  return results;
}

module.exports = {
  getOrCreateCurrentAmazonSO,
  findPbsiItem,
  createAmazonPOs,
  fetchShippedOrdersForPO,
  findExistingPOsByTracking,
  findMostRecentAmazonSO,
  parseEndDate,
  resolveSkuForPO,
};
