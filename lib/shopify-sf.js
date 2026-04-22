/**
 * Shopify → Salesforce SO/PO creation flow.
 *
 * For Shopify/web special orders:
 * 1. Fetch order from Shopify Admin API
 * 2. Login to Salesforce (fresh each run)
 * 3. Find/create Contact from customer
 * 4. Find Shopify Account
 * 5. Lookup PBSI Item by SKU
 * 6. Create SO (Sales Order)
 * 7. Create SO Line
 * 8. Create PO (Purchase Order) linked to SO
 * 9. Create PO Line linked to PO + SO + SO Line
 *
 * CRITICAL: mm_Exempt_GST__c and mm_Exempt_PST__c must be boolean false, NOT null.
 * CRITICAL: Shopify orders must NOT link to Amazon catch-all SO-023144.
 */

const https = require('https');
const sf = require('./salesforce');

// Known Salesforce IDs
const SHOPIFY_ACCOUNT_ID = '0014x000023jkuDAAQ';
const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';

function shopifyRequest(endpoint) {
  // Read env each call so a fresh OAuth token (written by /oauth/shopify/callback)
  // takes effect without restarting the server.
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) {
    throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN');
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: store,
      path: `/admin/api/2026-01${endpoint}`,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Shopify API ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Fetch Shopify order ──────────────────────────────────────────────────────

async function fetchShopifyOrder(orderIdOrNumber) {
  // Try by order number first (most common input)
  const id = String(orderIdOrNumber).replace('#', '');

  // If it looks like a numeric ID (long), fetch directly
  if (/^\d{10,}$/.test(id)) {
    const data = await shopifyRequest(`/orders/${id}.json`);
    return normalizeOrder(data.order);
  }

  // Otherwise search by order number
  const data = await shopifyRequest(`/orders.json?name=%23${id}&status=any&limit=1`);
  if (!data.orders?.length) {
    throw new Error(`Shopify order #${id} not found`);
  }
  return normalizeOrder(data.orders[0]);
}

function normalizeOrder(order) {
  return {
    id: order.id,
    orderNumber: order.name || `#${order.order_number}`,
    email: order.email || order.contact_email,
    customer: order.customer ? {
      firstName: order.customer.first_name,
      lastName: order.customer.last_name,
      email: order.customer.email,
      phone: order.customer.phone,
    } : null,
    shippingAddress: order.shipping_address ? {
      name: `${order.shipping_address.first_name || ''} ${order.shipping_address.last_name || ''}`.trim(),
      address1: order.shipping_address.address1,
      city: order.shipping_address.city,
      province: order.shipping_address.province_code,
      zip: order.shipping_address.zip,
    } : null,
    items: (order.line_items || []).map(li => ({
      sku: li.sku,
      title: li.title,
      variant: li.variant_title,
      quantity: li.quantity,
      price: li.price,
    })),
    totalPrice: order.total_price,
    createdAt: order.created_at,
  };
}

// ── Salesforce lookups ───────────────────────────────────────────────────────

async function findContact(conn, email) {
  if (!email) return null;
  const escaped = email.replace(/'/g, "\\'");
  const records = await sf.query(conn, `SELECT Id, Name, Email, Phone, AccountId FROM Contact WHERE Email = '${escaped}' LIMIT 1`);
  return records[0] || null;
}

async function findItemBySku(conn, sku) {
  if (!sku) return null;
  const escaped = String(sku).replace(/'/g, "\\'");
  const records = await sf.query(conn, `SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c FROM PBSI__PBSI_Item__c WHERE Name = '${escaped}' LIMIT 1`);
  return records[0] || null;
}

async function findItemByTitle(conn, title) {
  if (!title) return null;
  const escaped = String(title).replace(/'/g, "\\'").slice(0, 80);
  const records = await sf.query(conn, `SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c FROM PBSI__PBSI_Item__c WHERE PBSI__Description__c LIKE '%${escaped}%' LIMIT 5`);
  return records[0] || null;
}

// ── Create SO/PO flow ────────────────────────────────────────────────────────

// Extract the numeric Shopify order number from any common format we've
// seen Sechelt use: "1244", "#1244", "Shopify #1244", "po 1244", "po-1244".
// Returns the bare digits so we can LIKE-match on the SF Customer PO field.
function shopifyOrderDigits(orderNumber) {
  const m = String(orderNumber || '').match(/(\d+)/);
  return m ? m[1] : null;
}

// Skip-if-exists guard. Deterministic match on PBSI__Customer_Purchase_Order__c
// (the "Customer PO #" field) — Sechelt's established convention stamps the
// Shopify order number there on every manual entry. 100% coverage on
// existing 15 Shopify SOs (various formats, all contain the digit string).
// Our automation also stamps this field when it creates new SOs, so the
// dedup keeps working across manual + automated entries.
async function findExistingShopifySo(conn, shopifyOrder, trackingNumber) {
  // Strong check 1: any PO with matching tracking number (prior automation run)
  if (trackingNumber) {
    const escaped = String(trackingNumber).replace(/'/g, "\\'");
    const pos = await sf.query(conn, `SELECT Id, Name, PBSI__Sales_Order__c FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Tracking_Code__c = '${escaped}' LIMIT 3`);
    if (pos.length) return { reason: `PO ${pos[0].Name} exists for tracking ${trackingNumber}`, candidates: [pos[0].Name] };
  }
  // Strong check 2: any SO under the Shopify account whose Customer PO # contains
  // the Shopify order digits. Covers "1244", "#1244", "Shopify #1244", "po 1244".
  const digits = shopifyOrderDigits(shopifyOrder.orderNumber);
  if (digits) {
    const sos = await sf.query(conn, `
      SELECT Id, Name, PBSI__Order_Date__c, PBSI__Customer_Purchase_Order__c, CreatedBy.Name
      FROM PBSI__PBSI_Sales_Order__c
      WHERE PBSI__Customer__c = '${SHOPIFY_ACCOUNT_ID}'
        AND PBSI__Customer_Purchase_Order__c LIKE '%${digits}%'
      LIMIT 5
    `);
    // Require the match to be a "whole number" — i.e. "1244" shouldn't match "12445".
    // We check the actual string against a word-boundary-ish regex.
    const re = new RegExp(`(^|[^0-9])${digits}([^0-9]|$)`);
    const hits = sos.filter((s) => re.test(s.PBSI__Customer_Purchase_Order__c || ''));
    if (hits.length) {
      const existing = hits.map((s) => `${s.Name} ("${s.PBSI__Customer_Purchase_Order__c}", ${s.PBSI__Order_Date__c}, by ${s.CreatedBy?.Name || '?'})`);
      return { reason: `${hits.length} SO(s) under Shopify account with Customer PO # containing "${digits}"`, candidates: existing };
    }
  }
  return null;
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
  };

  // 1. Connect to Salesforce
  onProgress({ step: 'sf-login', message: 'Logging into Salesforce...' });
  let conn;
  try {
    conn = await sf.connect();
    // Auto-clear hold on Shopify account (Flow keeps re-applying it)
    try { await conn.sobject('Account').update({ Id: SHOPIFY_ACCOUNT_ID, mm_On_Hold__c: false }); } catch {}
    results.steps.push({ step: 'sf-login', success: true });
  } catch (err) {
    results.errors.push({ step: 'sf-login', error: err.message });
    return results;
  }

  // 1a. Skip-if-exists guard — 12/16 Shopify SOs in SF are manually entered
  // by Sechelt warehouse / Mac, not by this automation. Without this check,
  // enabling automation creates parallel duplicate SOs.
  onProgress({ step: 'skip-check', message: 'Checking for existing SO under Shopify account...' });
  try {
    const existing = await findExistingShopifySo(conn, shopifyOrder, trackingNumber);
    if (existing) {
      results.skipped = true;
      results.skipReason = existing.reason;
      results.existingCandidates = existing.candidates || (existing.poName ? [existing.poName] : []);
      results.steps.push({ step: 'skip-check', success: true, skipped: true, ...existing });
      onProgress({ step: 'skip-check', message: `Skipped: ${existing.reason}` });
      return results;
    }
    results.steps.push({ step: 'skip-check', success: true, skipped: false });
  } catch (err) {
    // Don't block on lookup failure — proceed with creation to avoid silently
    // missing SOs because of a transient SF query issue. Worst case we create
    // a dupe and Mac/accountant cleans it up at month-end.
    results.steps.push({ step: 'skip-check', success: false, error: err.message, note: 'proceeding despite lookup failure' });
  }

  // 2. Find Contact
  onProgress({ step: 'find-contact', message: `Looking up contact: ${shopifyOrder.email}` });
  let contactId = null;
  try {
    const contact = await findContact(conn, shopifyOrder.email || shopifyOrder.customer?.email);
    if (contact) {
      contactId = contact.Id;
      results.steps.push({ step: 'find-contact', success: true, contactId, name: contact.Name });
    } else {
      results.steps.push({ step: 'find-contact', success: true, contactId: null, note: 'No contact found — SO will be created without contact link' });
    }
  } catch (err) {
    results.steps.push({ step: 'find-contact', success: false, error: err.message });
  }

  // 3. Resolve items
  const resolvedItems = [];
  for (const item of shopifyOrder.items) {
    onProgress({ step: 'find-item', message: `Looking up item: ${item.sku || item.title}` });
    try {
      let sfItem = await findItemBySku(conn, item.sku);
      if (!sfItem && item.title) sfItem = await findItemByTitle(conn, item.title);
      if (sfItem) {
        resolvedItems.push({ ...item, sfItemId: sfItem.Id, sfItemName: sfItem.Name, salesPrice: sfItem.PBSI__salesprice__c });
        results.steps.push({ step: 'find-item', success: true, sku: item.sku, sfItemId: sfItem.Id });
      } else {
        resolvedItems.push({ ...item, sfItemId: null });
        results.errors.push({ step: 'find-item', error: `Item not found in Salesforce: SKU=${item.sku}, title=${item.title}` });
      }
    } catch (err) {
      resolvedItems.push({ ...item, sfItemId: null });
      results.errors.push({ step: 'find-item', error: `Item lookup failed for ${item.sku}: ${err.message}` });
    }
  }

  // If no items resolved, bail
  if (!resolvedItems.some(i => i.sfItemId)) {
    results.errors.push({ step: 'validation', error: 'No items could be resolved in Salesforce. Cannot create SO/PO.' });
    return results;
  }

  // 4. Create Sales Order
  onProgress({ step: 'create-so', message: 'Creating Sales Order...' });
  try {
    // Honour orderDateOverride for backfills so an SO for a January order
    // doesn't get stamped with today's date and scramble month-end close.
    const today = new Date().toISOString().slice(0, 10);
    const orderDate = orderDateOverride || today;
    const soFields = {
      PBSI__Customer__c: SHOPIFY_ACCOUNT_ID,
      PBSI__Status__c: 'Open',
      PBSI__Order_Date__c: orderDate,
      // Stamp the Shopify order number in the standard "Customer PO #" field
      // so future dedup lookups find this SO deterministically, matching
      // Sechelt's manual-entry convention.
      PBSI__Customer_Purchase_Order__c: String(shopifyOrder.orderNumber || '').replace(/^#/, ''),
      mm_Exempt_GST__c: false,
      mm_Exempt_PST__c: false,
      mm_Exempt_GST_ID__c: '',
      mm_Exempt_PST_ID__c: '',
    };
    if (contactId) soFields.PBSI__Contact__c = contactId;

    results.soId = await sf.create(conn, 'PBSI__PBSI_Sales_Order__c', soFields);
    results.steps.push({ step: 'create-so', success: true, soId: results.soId });

    // Fetch SO number
    const soRecords = await sf.query(conn, `SELECT Name FROM PBSI__PBSI_Sales_Order__c WHERE Id = '${results.soId}'`);
    results.soNumber = soRecords[0]?.Name || results.soId;
    onProgress({ step: 'create-so', message: `Created ${results.soNumber}` });
  } catch (err) {
    results.errors.push({ step: 'create-so', error: err.message });
    return results;
  }

  // 5. Create SO Lines
  const soLineIds = {};
  for (const item of resolvedItems) {
    if (!item.sfItemId) continue;
    onProgress({ step: 'create-so-line', message: `Adding SO line: ${item.sku || item.title}` });
    try {
      const lineId = await sf.create(conn, 'PBSI__PBSI_Sales_Order_Line__c', {
        PBSI__Sales_Order__c: results.soId,
        PBSI__Item__c: item.sfItemId,
        PBSI__Quantity__c: item.quantity,
            PBSI__Quantity_Needed__c: item.quantity,
        PBSI__Price__c: parseFloat(item.price) || item.salesPrice || 0,
      });
      soLineIds[item.sfItemId] = lineId;
      results.steps.push({ step: 'create-so-line', success: true, sku: item.sku, lineId });
    } catch (err) {
      results.errors.push({ step: 'create-so-line', error: `SO line for ${item.sku}: ${err.message}` });
    }
  }

  // 6. Create Purchase Order
  onProgress({ step: 'create-po', message: 'Creating Purchase Order...' });
  try {
    const customerName = shopifyOrder.customer
      ? `${shopifyOrder.customer.firstName || ''} ${shopifyOrder.customer.lastName || ''}`.trim()
      : shopifyOrder.shippingAddress?.name || 'Unknown';
    const itemDesc = resolvedItems.map(i => i.title || i.sku).join(', ');
    const carrierPart = carrierCode ? ` — ${String(carrierCode).replace(/_walleted$/, '').replace(/_/g, ' ')}` : '';
    const trackingPart = trackingNumber ? ` — Tracking: ${trackingNumber}` : '';

    const poFields = {
      PBSI__Account__c: PROSOL_VENDOR_ID,
      PBSI__Order_Date__c: orderDateOverride || new Date().toISOString().slice(0, 10),
      PBSI__Status__c: 'Open',
      PBSI__Shipping_Instructions__c: `Shopify ${shopifyOrder.orderNumber} — ${customerName} — ${itemDesc}${carrierPart}${trackingPart}`.slice(0, 255),
    };
    if (trackingNumber) poFields.PBSI__Tracking_Code__c = trackingNumber;
    results.poId = await sf.create(conn, 'PBSI__PBSI_Purchase_Order__c', poFields);
    results.steps.push({ step: 'create-po', success: true, poId: results.poId });

    // Fetch PO number
    const poRecords = await sf.query(conn, `SELECT Name, PO_Number__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '${results.poId}'`);
    results.poNumber = poRecords[0]?.Name || results.poId;
    onProgress({ step: 'create-po', message: `Created ${results.poNumber}` });
  } catch (err) {
    results.errors.push({ step: 'create-po', error: err.message });
    return results;
  }

  // 7. Create PO Lines (linked to SO + SO Line — required by validation rule)
  for (const item of resolvedItems) {
    if (!item.sfItemId) continue;
    const soLineId = soLineIds[item.sfItemId];
    if (!soLineId) continue;

    onProgress({ step: 'create-po-line', message: `Adding PO line: ${item.sku || item.title}` });
    try {
      await sf.create(conn, 'PBSI__PBSI_Purchase_Order_Line__c', {
        PBSI__Purchase_Order__c: results.poId,
        PBSI__Item__c: item.sfItemId,
        PBSI__Quantity_Ordered__c: item.quantity,
        PBSI__Price__c: parseFloat(item.price) || item.salesPrice || 0,
        PBSI__Sales_Order__c: results.soId,
        PBSI__Original_SO_Line__c: soLineId,
      });
      results.steps.push({ step: 'create-po-line', success: true, sku: item.sku });
    } catch (err) {
      results.errors.push({ step: 'create-po-line', error: `PO line for ${item.sku}: ${err.message}` });
    }
  }

  return results;
}

module.exports = { fetchShopifyOrder, createShopifySoPo };
