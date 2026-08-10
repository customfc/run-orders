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
const path = require('path');
const sf = require('./salesforce');
const { resolveLineQty } = require('./pbsi-uom');

// Known Salesforce IDs
const SHOPIFY_ACCOUNT_ID = '0014x000023jkuDAAQ';
const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';
const SECHELT_WAREHOUSE_LOCATION_ID = 'a0v4x000005kF5gAAE'; // PBSI__PBSI_Location__c — matches every existing PBSI item's PBSI__Default_Location__c (verified 2026-05-21)
// Auto-created items must NOT land in the "Generic" group (a0t4x00000NiZCkAAN):
// that group is purpose-built for labour/generic-billing items, so dumping
// physical products there both polluted the SO "Generic Item" picklist and gave
// them the wrong accounting behavior. Instead route each auto-created item to the
// group a human would have picked — mirroring how the 239 existing Mapei items are
// already booked (~70% Accessories, with Grout + Adhesive carve-outs). Driven by
// the `category` already on the sku-map entry; anything unmapped falls to
// Accessories (the team's de-facto catch-all for physical product) — never Generic.
const ITEM_GROUP_IDS = {
  accessories: 'a0t4x00000NiZCoAAN',
  adhesive:    'a0t4x00000NiZChAAN',
  grout:       'a0t4x00000NiZCVAA3',
};
const CATEGORY_TO_ITEM_GROUP = {
  'grout / sealant':   ITEM_GROUP_IDS.grout,
  'flooring adhesive': ITEM_GROUP_IDS.adhesive,
  'adhesive':          ITEM_GROUP_IDS.adhesive,
};
function resolveItemGroupId(entry) {
  const cat = ((entry && entry.category) || '').trim().toLowerCase();
  return CATEGORY_TO_ITEM_GROUP[cat] || ITEM_GROUP_IDS.accessories;
}
const SALES_REVENUE_GL_ACCOUNT_ID   = 'a6Q4x0000000sr4EAA'; // AcctSeed__GL_Account__c "4000-Sales". A PBSI trigger auto-creates a Product2 (PBSI__Product__c) for every new item with its AcctSeed__Revenue_GL_Account__c left null; Accounting Seed then defaults the Billing Line revenue GL to the org default "4000-Product Revenue" (wrong). Accounting wants 4000-Sales (Melanie White, 2026-06-01). We stamp the Product2 ourselves so sales of auto-created items post correctly.

// sku-map lookup — used as fallback when Shopify SKU doesn't match an SF
// PBSI__PBSI_Item__c.Name directly (e.g. Shopify sku="KD-STR" but the SF
// item's Name is "13572"; the sku-map entry's api_sku field is the SF Name).
function loadSkuMap() {
  try { return require(path.join(__dirname, '..', 'scripts', 'shipstation', 'sku-map.json')).mappings || {}; }
  catch { return {}; }
}

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

// List recent Shopify orders (lightweight — status fields only, not normalized).
// Used by the SO reconciliation sweep to find fulfilled orders that never got
// an SF Sales Order. YourFloors volume is ~1 order/day, so a single 250-row
// page covers any reasonable window — no pagination needed.
async function listShopifyOrders({ days = 45 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const fields = 'id,name,order_number,created_at,financial_status,fulfillment_status,cancelled_at,tags';
  const data = await shopifyRequest(
    `/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}&fields=${fields}`);
  return data.orders || [];
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
  const skuStr = String(sku);
  // Try slash/hyphen variants — most-stripped first so the canonical legacy
  // SF row (KERDIFIXBW, DitraDRAIN25M) wins over any duplicate auto-created
  // slashed row, per project_prosol_sku_slashes.
  const stripped = skuStr.replace(/[\/-]/g, '');
  const noSlash = skuStr.replace(/\//g, '');
  const noHyphen = skuStr.replace(/-/g, '');
  const variants = [];
  for (const v of [stripped, noSlash, noHyphen, skuStr]) {
    if (v && !variants.includes(v)) variants.push(v);
  }

  for (const v of variants) {
    const escaped = v.replace(/'/g, "\\'");
    const records = await sf.query(conn, `SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c, Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '${escaped}' LIMIT 1`);
    if (records[0]) return records[0];
  }

  // Legacy fallback: items where Name (Sechelt internal numeric) equals the
  // Shopify SKU directly (CFC-owned products like 458, 9225, 11524).
  const escaped = skuStr.replace(/'/g, "\\'");
  const records = await sf.query(conn, `SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c, Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c FROM PBSI__PBSI_Item__c WHERE Name = '${escaped}' LIMIT 1`);
  return records[0] || null;
}

async function findItemByTitle(conn, title) {
  if (!title) return null;
  const escaped = String(title).replace(/'/g, "\\'").slice(0, 80);
  const records = await sf.query(conn, `SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c FROM PBSI__PBSI_Item__c WHERE PBSI__Description__c LIKE '%${escaped}%' LIMIT 5`);
  return records[0] || null;
}

// Lazy on-demand PBSI Item creation. Triggered when a Shopify order references
// a SKU we've mapped in sku-map.json but for which no SF item exists yet
// (typical case: bulk-imported catalog families like Mapei UltraCare where
// Sechelt hasn't yet hand-entered the SF item record). Cheaper than bulk-
// pre-creating hundreds of items that may never sell.
//
// Naming: prefer the manufacturer SKU as Name. If that collides with an
// existing Sechelt internal numeric ID (rare — Mapei SKUs are usually
// alphanumeric), prefix with "MFG-" so we don't trample.
//
// Required fields (per object describe 2026-05-21): Name, PBSI__description__c,
// mm_Landed_Cost__c. Default Vendor link is best-effort — Prosol Inc. for
// everything that ships via our pipeline.
// Standard defaults for auto-created PBSI items, copied from human-curated
// Schluter items (sample A100ATGB Jolly) so the new entry behaves like one a
// person would have set up.
const PBSI_AUTO_DEFAULTS = {
  PBSI__Item_Status__c: 'Active',
  PBSI__Item_Type__c: 'Item',
  PBSI__Cost_Type__c: 'Standard Cost',
  PBSI__Coverage_Code__c: 'Min/Max',
  PBSI__Lot_Tracking__c: true,
  PBSI__No_Lot_Expiration__c: true,
  PBSI__Taxable__c: true,
  PBSI__Tax_Code__c: 'a1S4x000002QmjbEAC',
};

// Normalise sku-map.brand strings ("schluter", "aqua_mix", "custom_building_products")
// into the human-friendly Manufacturer__c value that matches existing SF rows.
const MANUFACTURER_LOOKUP = {
  schluter: 'Schluter',
  aqua_mix: 'Aqua Mix',
  aquamix: 'Aqua Mix',
  bona: 'Bona',
  perfect_level: 'Perfect Level Master',
  perfectlevel: 'Perfect Level Master',
  mapei: 'Mapei',
  custom_building_products: 'Custom Building Products',
  treeco: 'Treeco',
};

function toTitleCase(s) {
  if (!s) return s;
  return String(s).split(/[\s_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Decode common Schluter color abbreviations seen in product names.
function decodeColorAbbreviations(s) {
  if (!s) return s;
  return s
    .replace(/\bBRT WHT\b/gi, 'Bright White')
    .replace(/\bBRT\b/gi, 'Bright')
    .replace(/\bWHT\b/gi, 'White')
    .replace(/\bGRY\b/gi, 'Grey')
    .replace(/\bBLK\b/gi, 'Black')
    .replace(/\bBNA\b/gi, 'Brushed Nickel Anodized')
    .replace(/\bBGA\b/gi, 'Brushed Graphite Anodized')
    .replace(/\bMGS\b/gi, 'Matte Black')
    .replace(/\bEB\b/gi, 'Elegant Black');
}

// Heuristic parse of a sku-map product name into Manufacturer + Style + Color + Size.
// Best-effort — covers the canonical Schluter format. Aqua Mix / Mapei / Bona
// names get partial coverage (style/color/size may be null and need manual fill).
function inferBrandFromProduct(product) {
  if (!product) return null;
  const lower = product.toLowerCase();
  if (/\bschluter\b/.test(lower)) return 'schluter';
  if (/\baqua\s*mix\b/.test(lower)) return 'aqua_mix';
  if (/\bbona\b/.test(lower)) return 'bona';
  if (/\bmapei\b/.test(lower)) return 'mapei';
  if (/\bperfect\s*level\b/.test(lower)) return 'perfect_level';
  if (/^kerdi|^ditra|^kebra|^kerdi|^kms|^ses/i.test(product)) return 'schluter';
  return null;
}

function deriveItemFields(entry, vendorItemId) {
  if (!entry) return {};
  const brand = ((entry.brand || inferBrandFromProduct(entry.product) || '') + '').toLowerCase().trim();
  const Manufacturer__c = MANUFACTURER_LOOKUP[brand] || (brand ? toTitleCase(brand) : null);

  let product = (entry.product || '').trim();
  if (Manufacturer__c) {
    // Strip leading brand prefix from product so it doesn't end up in Style.
    const brandRe = new RegExp('^' + Manufacturer__c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i');
    product = product.replace(brandRe, '').trim();
  }

  let style = null;
  let remainder = product;
  // Schluter style names are typically the first ALL-CAPS hyphenated token (KERDI-FIX, DITRA-DRAIN, KERDI-SEAL-PS).
  const styleMatch = product.match(/^([A-Z][A-Z0-9-]+(?:[/][A-Z0-9-]+)*)/);
  if (styleMatch) {
    style = styleMatch[1].split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
    remainder = product.slice(styleMatch[0].length).trim();
  }

  let size = null;
  let colorRaw = remainder;
  // Look for the first size/measurement token in the remainder.
  const sizeMatch = remainder.match(/(\d+(?:\.\d+)?\s*(?:ML|mL|ml|MM|mm|L\b|GAL|gal|gallon|qt|quart|pt|pint|oz|sf|sqft|sqin|in|cm|m\b|"|'|\/\d+))/i);
  if (sizeMatch) {
    size = sizeMatch[0].trim();
    // Remove the size run from the descriptor so Color__c gets the cosmetic part
    // (e.g. "SEALING/BONDING BRT WHT" stays intact after pulling out "290ML").
    colorRaw = (remainder.slice(0, sizeMatch.index) + ' ' + remainder.slice(sizeMatch.index + sizeMatch[0].length)).replace(/\s+/g, ' ').trim();
  }

  let color = colorRaw.replace(/[-,;\s]+$/, '').replace(/^[-,;\s]+/, '').trim() || null;
  if (color) color = decodeColorAbbreviations(color).replace(/\s*\/\s*/g, '/').split(/[\s/]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

  // Match human format: Size__c often includes the variant SKU on the end
  // (e.g. "3/8\" A100ATGB"). When we have both, append.
  let Size__c = null;
  if (size && vendorItemId) Size__c = `${size} ${vendorItemId}`;
  else if (size) Size__c = size;
  else if (vendorItemId) Size__c = vendorItemId;

  return {
    Manufacturer__c: Manufacturer__c || undefined,
    Original_Style_Name__c: style || undefined,
    Color__c: color || undefined,
    Size__c: Size__c || undefined,
  };
}

// Pull the authoritative wholesale cost from the analytics SQLite mirror
// (sku_map_canonical.cost_cad — sourced from PBSI__Cost__c on existing
// items + Salesforce vendor-item-ID lookups). Returns null when no data.
function lookupCanonicalCost(prosolSku, apiSku) {
  if (!prosolSku && !apiSku) return null;
  let sqlite;
  try { sqlite = require('better-sqlite3'); } catch { return null; }
  const dbPath = path.join(__dirname, '..', 'data', 'analytics.sqlite');
  let db;
  try {
    db = sqlite(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      'SELECT cost_cad FROM sku_map_canonical WHERE (prosol_sku = ? OR api_sku = ? OR prosol_sku = ?) AND cost_cad IS NOT NULL AND cost_cad > 0 ORDER BY updated_at DESC LIMIT 1'
    ).get(prosolSku || '', apiSku || '', apiSku || '');
    return row && row.cost_cad ? Number(row.cost_cad) : null;
  } catch { return null; }
  finally { if (db) try { db.close(); } catch {} }
}

// Resolve the wholesale cost (and retail) for a brand-new PBSI item. SF requires
// mm_Landed_Cost__c (nillable:false), so this must yield a number or the caller
// refuses the insert. Priority order — every source is Prosol-derived:
//   1. sku-map entry cost_cad — captured live from Prosol at /map time
//      (cost_source=prosol-offers-loc10010). The authoritative copy.
//   2. live Prosol offer lookup — only reached when the entry carries no cost.
//      Lazy: spins a puppeteer session, so it never runs on the common path.
//   3. analytics SQLite mirror — a derived copy that lags ports (it never got
//      the 2026-05 Mapei batch, which is exactly why 1284 fell through).
// Returns { cost, retail, source }; cost is null only when all three miss.
async function resolveItemCost(prosolSku, mfgSku, entry) {
  if (entry && entry.cost_cad != null && Number(entry.cost_cad) > 0) {
    const retail = entry.retail_cad != null ? Number(entry.retail_cad) : null;
    return { cost: Number(entry.cost_cad), retail, source: entry.cost_source || 'sku-map' };
  }
  if (prosolSku) {
    let client;
    try {
      const { ProsolClientV2 } = require(path.join(__dirname, '..', 'scripts', 'shipstation', 'prosol-client-v2'));
      client = new ProsolClientV2();
      await client.init();
      const offer = await client.getCost(prosolSku);
      if (offer && offer.cost_cad != null) {
        return {
          cost: Number(offer.cost_cad),
          retail: offer.retail_cad != null ? Number(offer.retail_cad) : null,
          source: offer.costSource || 'prosol-live',
        };
      }
    } catch {
      // Degrade to the mirror, then to the null-cost refusal — a Prosol/browser
      // hiccup must not crash the whole POS phase.
    } finally {
      if (client) { try { await client.close(); } catch {} }
    }
  }
  const mirror = lookupCanonicalCost(prosolSku, mfgSku);
  if (mirror !== null) return { cost: mirror, retail: null, source: 'analytics-mirror' };
  return { cost: null, retail: null, source: null };
}

// The PBSI managed package creates a companion Product2 (PBSI__Product__c) for
// every new item via an after-insert trigger — sometimes synchronously, sometimes
// a beat later. That Product2's AcctSeed__Revenue_GL_Account__c is left null, so
// Accounting Seed bills its sales to the org-default revenue GL ("4000-Product
// Revenue") instead of "4000-Sales". We poll briefly for the Product2 and stamp
// the correct revenue GL. Non-fatal: never let this break item creation.
async function stampProductRevenueGL(conn, itemId) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let productId = null;
  for (let attempt = 0; attempt < 6 && !productId; attempt++) {
    if (attempt) await sleep(1500);
    try {
      const rows = await sf.query(conn, `SELECT PBSI__Product__c FROM PBSI__PBSI_Item__c WHERE Id = '${itemId}' LIMIT 1`);
      productId = rows[0] && rows[0].PBSI__Product__c;
    } catch { /* transient query failure — retry */ }
  }
  if (!productId) return { stamped: false, reason: 'Product2 not provisioned in time' };
  try {
    const prod = await sf.query(conn, `SELECT Id, AcctSeed__Revenue_GL_Account__c FROM Product2 WHERE Id = '${productId}' LIMIT 1`);
    const current = prod[0] && prod[0].AcctSeed__Revenue_GL_Account__c;
    if (current === SALES_REVENUE_GL_ACCOUNT_ID) return { stamped: false, productId, reason: 'already correct' };
    await conn.sobject('Product2').update({ Id: productId, AcctSeed__Revenue_GL_Account__c: SALES_REVENUE_GL_ACCOUNT_ID });
    return { stamped: true, productId, previous: current || null };
  } catch (e) {
    return { stamped: false, productId, error: e.message };
  }
}

async function createPbsiItem(conn, { mfgSku, prosolSku, productName, title, entry }) {
  // Prosol's Schluter SKUs — and our legacy SF items — carry NO slash or hyphen,
  // and Prosol's website price-import matches on the un-slashed SKU. Creating an
  // item WITH the slash makes a duplicate AND blocks the price update from ever
  // matching (Lynnae / accounting, 2026-06-09). So strip / and - HERE, on the SF
  // item identifier only. The ordering api_sku/prosol_sku in sku-map keep their
  // slashes — Prosol's order API needs them (project_prosol_sku_slashes).
  const stripSku = (s) => String(s || '').trim().replace(/[\/-]/g, '');
  const vendorItemId = stripSku(prosolSku || mfgSku);
  if (!vendorItemId) throw new Error('createPbsiItem: need at least one of prosolSku / mfgSku');

  let name = stripSku(mfgSku || prosolSku || vendorItemId);
  const collisionCheck = await sf.query(conn, `SELECT Id FROM PBSI__PBSI_Item__c WHERE Name = '${name.replace(/'/g, "\\'")}' LIMIT 1`);
  if (collisionCheck.length) name = `MFG-${name}`;

  // Pull entry from sku-map if caller didn't pass one (covers older call sites).
  const skuMap = loadSkuMap();
  const resolvedEntry = entry || (mfgSku && skuMap[mfgSku]) || (prosolSku && skuMap[prosolSku]) || null;

  const derived = deriveItemFields(resolvedEntry, prosolSku || mfgSku);
  const barcode = resolvedEntry && resolvedEntry.barcode ? String(resolvedEntry.barcode) : null;

  // mm_Landed_Cost__c is required (nillable:false). Resolve it from Prosol —
  // cached sku-map cost first, live lookup second, mirror last. No cost ⇒ refuse
  // the insert so the order routes to manual review with a precise reason,
  // instead of SF rejecting it with a cryptic REQUIRED_FIELD_MISSING.
  const { cost, retail: liveRetail, source: costSource } = await resolveItemCost(prosolSku, mfgSku, resolvedEntry);
  if (cost === null) {
    throw new Error(`no Prosol cost for ${prosolSku || mfgSku} (sku-map cost_cad empty, live Prosol + mirror miss) — add cost via /map`);
  }
  let retail = resolvedEntry && resolvedEntry.retail_cad ? Number(resolvedEntry.retail_cad) : null;
  if (retail === null && liveRetail != null) retail = liveRetail;

  // PBSI__description__c is also required (nillable:false) and NOT auto-generated
  // (no formula/default — the describe confirms it; human-created items just
  // always carry one). Use the product name we already have; never empty.
  const description = (resolvedEntry && resolvedEntry.product) || productName || title || name;

  const payload = {
    Name: name,
    PBSI__description__c: description,
    PBSI__Vendor_Item_ID__c: vendorItemId,
    PBSI__Default_Vendor__c: PROSOL_VENDOR_ID,
    PBSI__Default_Location__c: SECHELT_WAREHOUSE_LOCATION_ID,
    PBSI__Item_Group__c: resolveItemGroupId(resolvedEntry),
    PBSI__defaultunitofmeasure__c: 'EA',
    Unit_of_Measure__c: 'EA',
    ...PBSI_AUTO_DEFAULTS,
    ...derived,
  };
  if (retail !== null) {
    payload.PBSI__salesprice__c = retail;
    payload.mm_Original_Retail_Price__c = retail;
  }
  payload.PBSI__Cost__c = cost;
  payload.PBSI__purchaseprice__c = cost;
  payload.mm_Landed_Cost__c = cost;
  // Schluter manufacturer barcodes are 13-digit EAN. Skip otherwise to avoid
  // populating a garbage code from a non-barcode field.
  if (barcode && /^\d{8,14}$/.test(barcode)) payload.PBSI__UPC_Code__c = barcode;

  const id = await sf.create(conn, 'PBSI__PBSI_Item__c', payload);
  const glStamp = await stampProductRevenueGL(conn, id);
  return {
    Id: id,
    Name: name,
    PBSI__Vendor_Item_ID__c: vendorItemId,
    PBSI__salesprice__c: retail,
    PBSI__Cost__c: cost,
    autoCreated: true,
    costSource,
    revenueGlStamped: glStamp.stamped,
    revenueGlProductId: glStamp.productId || null,
  };
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
    // FAIL CLOSED, same as the Amazon branch's check-existing guard. This used
    // to proceed on lookup failure, reasoning that a duplicate was cheaper than
    // a missing SO because someone would catch it at month-end. 2026-07-24 is
    // the counter-example: the Amazon guard failed the same way and quietly put
    // 12 duplicate POs ($744.26) into the books as Complete/Received, where they
    // sat unnoticed for weeks and only surfaced during a vendor dispute. A
    // missing SO costs one cron tick; a duplicate costs a reconciliation.
    results.errors.push({
      step: 'skip-check',
      error: `duplicate guard failed, SO/PO creation aborted for ${shopifyOrder.orderNumber} (nothing created): ${err.message || err}`,
    });
    results.steps.push({ step: 'skip-check', success: false, error: err.message, note: 'aborted — duplicate guard unavailable' });
    onProgress({ step: 'skip-check', message: `Aborted: duplicate guard failed (${err.message || err})` });
    return results;
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

  // 3. Resolve items. Lookup order:
  //   a. Direct SF Name = Shopify SKU (normal case — e.g. "C010861-01")
  //   b. If no hit, translate via sku-map (Shopify SKU → api_sku field →
  //      SF Name) — handles the case where Shopify's SKU ("KD-STR") and
  //      SF's Name ("13572") differ and the bridge lives in sku-map.
  //   c. Final fallback: title fuzzy-match on PBSI__Description__c.
  const SKU_MAP = loadSkuMap();
  const SKIP_API_SKUS = new Set(['UNMAPPED_CABLE', 'UNMAPPED', 'UNMAPPED_GROUT', 'SKIP', 'NON_PROSOL']);
  const resolvedItems = [];
  for (const item of shopifyOrder.items) {
    onProgress({ step: 'find-item', message: `Looking up item: ${item.sku || item.title}` });
    try {
      let sfItem = await findItemBySku(conn, item.sku);
      let lookedUp = [item.sku];
      const mapped = SKU_MAP[String(item.sku || '')];
      if (!sfItem && mapped && typeof mapped === 'object') {
        // Try every distinct mapped form (api_sku then prosol_sku). For most
        // vendors these differ — e.g. Mapei: api_sku=mfg_sku (5LA001452),
        // prosol_sku=Prosol PO code (943851421). SF items keyed by either
        // form get found here; without this, lookups by mfg_sku would miss
        // records keyed under the prosol_sku.
        for (const candidate of [mapped.api_sku, mapped.prosol_sku]) {
          if (sfItem) break;
          if (!candidate || candidate === item.sku || SKIP_API_SKUS.has(candidate)) continue;
          if (lookedUp.includes(candidate)) continue;
          sfItem = await findItemBySku(conn, candidate);
          lookedUp.push(candidate);
        }
      }
      if (!sfItem && item.title) sfItem = await findItemByTitle(conn, item.title);

      // Lazy auto-create: if no SF item found AND we have a real sku-map
      // entry (not UNMAPPED / SKIP / NON_PROSOL), create the SF item now.
      // We set VendorItemID = prosol_sku (Sechelt's invoicing convention).
      // The lookup chain above tries prosol_sku, so subsequent orders for
      // the same SKU will find this record instead of re-creating.
      if (!sfItem) {
        const prosolSku = mapped && typeof mapped === 'object' ? mapped.prosol_sku : null;
        const apiSku    = mapped && typeof mapped === 'object' ? mapped.api_sku    : null;
        const productName = mapped && typeof mapped === 'object' ? mapped.product : null;
        const haveValidMapping = mapped && typeof mapped === 'object'
          && prosolSku && !SKIP_API_SKUS.has(String(prosolSku))
          && !SKIP_API_SKUS.has(String(apiSku || ''));
        if (haveValidMapping) {
          try {
            sfItem = await createPbsiItem(conn, {
              mfgSku: item.sku,
              prosolSku,
              productName,
              title: item.title,
            });
            lookedUp.push(`AUTO-CREATED Name=${sfItem.Name}`);
            results.steps.push({ step: 'auto-create-item', success: true, sku: item.sku, sfItemId: sfItem.Id, sfItemName: sfItem.Name });
          } catch (err) {
            results.errors.push({ step: 'auto-create-item', error: `Auto-create failed for ${item.sku}: ${err.message}` });
          }
        }
      }

      if (sfItem) {
        // Area-priced items (Schluter membrane rolls stocked per SqFt in PBSI)
        // need the ordered roll count converted to square feet before we write
        // SO/PO lines — else a 1-roll order records "1 SqFt" for a full roll.
        // Non-area items pass through unchanged; area items with unresolvable
        // coverage route to manual review (never silently qty 1).
        // See project_area_product_coverage_multiplier.
        const qtyRes = resolveLineQty({
          uom: sfItem.Unit_of_Measure__c || sfItem.PBSI__defaultunitofmeasure__c,
          description: sfItem.PBSI__description__c,
          orderQty: item.quantity,
          coverageOverride: mapped && typeof mapped === 'object' ? mapped.coverage_sqft : null,
        });
        if (qtyRes.error) {
          resolvedItems.push({ ...item, sfItemId: null });
          results.errors.push({ step: 'find-item', error: `Area-UoM coverage unresolved for ${sfItem.Name} (SKU=${item.sku}): ${qtyRes.error}` });
        } else {
          if (qtyRes.isArea) {
            results.steps.push({ step: 'area-qty', success: true, sku: item.sku, sfItemName: sfItem.Name, rolls: item.quantity, coverage: qtyRes.coverage, qty: qtyRes.qty });
          }
          resolvedItems.push({ ...item, quantity: qtyRes.qty, orderRolls: item.quantity, coverageSqft: qtyRes.isArea ? qtyRes.coverage : null, sfItemId: sfItem.Id, sfItemName: sfItem.Name, salesPrice: sfItem.PBSI__salesprice__c });
          results.steps.push({ step: 'find-item', success: true, sku: item.sku, sfItemId: sfItem.Id, sfItemName: sfItem.Name, lookedUp });
        }
      } else {
        resolvedItems.push({ ...item, sfItemId: null });
        results.errors.push({ step: 'find-item', error: `Item not found in Salesforce: SKU=${item.sku}${lookedUp.length > 1 ? ` (also tried ${lookedUp.slice(1).join(', ')})` : ''}, title=${item.title}` });
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

  // 5a. Decide which resolved items belong on a Prosol PO. Items the sku-map
  // classifies NON_PROSOL/SKIP are CFC's own stock (e.g. floor-protection roll
  // SKU 11239) shipped from the Sechelt warehouse — we never purchase them from
  // Prosol, so they must NOT land on a Prosol PO. The Sales Order above keeps
  // every line (the sale is real); only the *purchase* is Prosol-specific.
  // This mirrors the email phase's NON_PROSOL drop (lib/pipeline.js) and the
  // Amazon path's allItemsNonProsol skip (lib/amazon-po.js). Items not in the
  // sku-map (resolved by direct SF Name match) default to Prosol-eligible.
  const isNonProsolSku = (sku) => {
    const e = SKU_MAP[String(sku || '')];
    return !!(e && typeof e === 'object' && (e.api_sku === 'NON_PROSOL' || e.api_sku === 'SKIP'));
  };
  const poItems = resolvedItems.filter((i) => i.sfItemId && !isNonProsolSku(i.sku));

  // No Prosol-sourced items → skip PO creation entirely (keep the SO). Without
  // this guard, a pure-Sechelt own-stock order minted a phantom Prosol PO that
  // overstated payables / misattributed COGS at month-end (PO-15363 incident,
  // Shopify #1286, 2026-06-11).
  if (poItems.length === 0) {
    results.poSkipped = true;
    results.poSkipReason = 'all items NON_PROSOL (CFC own stock / Sechelt) — no Prosol PO needed';
    results.steps.push({ step: 'create-po', success: true, skipped: true, reason: results.poSkipReason });
    onProgress({ step: 'create-po', message: `Skipped PO — ${results.poSkipReason}` });
    return results;
  }

  // 6. Create Purchase Order
  onProgress({ step: 'create-po', message: 'Creating Purchase Order...' });
  try {
    const customerName = shopifyOrder.customer
      ? `${shopifyOrder.customer.firstName || ''} ${shopifyOrder.customer.lastName || ''}`.trim()
      : shopifyOrder.shippingAddress?.name || 'Unknown';
    const itemDesc = poItems.map(i => i.title || i.sku).join(', ');
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

  // 7. Create PO Lines (linked to SO + SO Line — required by validation rule).
  // Only Prosol-eligible items (poItems); NON_PROSOL/Sechelt own-stock lines
  // stay on the SO but never hit the Prosol PO.
  for (const item of poItems) {
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

module.exports = { fetchShopifyOrder, listShopifyOrders, createShopifySoPo, createPbsiItem };
