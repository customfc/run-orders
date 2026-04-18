#!/usr/bin/env node
/**
 * Data inventory probe for the analytics DB.
 *
 * Read-only. Hits SP-API Orders, Shopify Admin, Salesforce, and the local
 * snapshot dirs to surface: row counts, date ranges, and populated-% for
 * fields that matter to the analytics tabs (costs, return dates, etc).
 *
 * Goal: produce an honest inventory so the schema isn't designed from
 * whiteboard assumptions.
 *
 * Usage:
 *   DISABLE_CRON=1 node scripts/analytics-data-inventory.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spApiRequest } = require('../lib/sp-api');
const sfLib = require('../lib/salesforce');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'data', 'fba', 'snapshots');
const PO_SENT_DIR = path.join(__dirname, '..', 'data', 'fba', 'po-drafts', 'sent');

const out = { startedAt: new Date().toISOString(), sections: {} };
const log = (...args) => console.log(...args);
const section = (k) => { out.sections[k] = {}; log(`\n── ${k.toUpperCase()} ─────────────────`); return out.sections[k]; };

// ── 1. SP-API Orders ────────────────────────────────────────────────────────

async function probeSpApiOrders() {
  const s = section('sp-api-orders');
  const marketplaceId = (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');
  s.marketplaceId = marketplaceId || null;
  if (!marketplaceId) { s.error = 'AMAZON_SP_MARKETPLACE_ID not set'; return; }

  // Probe: how far back can we query? Amazon typically allows ~730d orders
  // history. Try a 2-year window, then a 90-day window, so we know both
  // the ceiling and a recent sample.
  const now = new Date();
  const iso = (d) => d.toISOString();
  const ago = (days) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - days); return d; };

  for (const [name, days] of [['last-30d', 30], ['last-90d', 90], ['last-365d', 365], ['last-730d', 730]]) {
    try {
      const q = {
        MarketplaceIds: marketplaceId,
        CreatedAfter: iso(ago(days)),
        MaxResultsPerPage: 1,
      };
      const res = await spApiRequest('GET', '/orders/v0/orders', { query: q });
      if (res.status !== 200) {
        s[name] = { error: `HTTP ${res.status}`, bodySnippet: res.body.slice(0, 200) };
        log(`  ${name}: HTTP ${res.status} — ${res.body.slice(0, 150)}`);
        continue;
      }
      const data = JSON.parse(res.body);
      const total = data.payload?.Orders?.length ?? 0;
      const hasNext = !!data.payload?.NextToken;
      const firstOrder = data.payload?.Orders?.[0];
      s[name] = {
        sampleCount: total,
        hasNextPage: hasNext,
        firstOrderPurchaseDate: firstOrder?.PurchaseDate || null,
        firstOrderId: firstOrder?.AmazonOrderId || null,
      };
      log(`  ${name}: sample=${total} hasNext=${hasNext} firstPurchase=${firstOrder?.PurchaseDate || '—'}`);
    } catch (e) {
      s[name] = { error: e.message };
      log(`  ${name}: ERROR ${e.message}`);
    }
    // Gentle throttle — Orders endpoint has tight rate limits
    await new Promise((r) => setTimeout(r, 1200));
  }

  // Fields on an Order object (describe via a single real fetch)
  try {
    const res = await spApiRequest('GET', '/orders/v0/orders', {
      query: { MarketplaceIds: marketplaceId, CreatedAfter: iso(ago(30)), MaxResultsPerPage: 1 },
    });
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const sampleOrder = data.payload?.Orders?.[0];
      if (sampleOrder) {
        s.orderFields = Object.keys(sampleOrder).sort();
        log(`  order fields (${s.orderFields.length}): ${s.orderFields.join(', ')}`);
      }
    }
  } catch (e) {
    s.orderFieldsError = e.message;
  }

  // Finances endpoint for fees/payouts — critical for the Money tab
  try {
    const res = await spApiRequest('GET', '/finances/v0/financialEventGroups', {
      query: { FinancialEventGroupStartedAfter: iso(ago(30)), MaxResultsPerPage: 1 },
    });
    s.financesEndpoint = { status: res.status };
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const group = data.payload?.FinancialEventGroupList?.[0];
      s.financesEndpoint.firstGroupStart = group?.FinancialEventGroupStart || null;
      log(`  finances endpoint: HTTP 200, firstGroup=${group?.FinancialEventGroupStart || '—'}`);
    } else {
      log(`  finances endpoint: HTTP ${res.status}`);
    }
  } catch (e) {
    s.financesEndpoint = { error: e.message };
  }
}

// ── 2. Shopify Admin API ────────────────────────────────────────────────────

function shopifyGet(endpoint) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) return Promise.reject(new Error('Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: store,
      path: `/admin/api/2026-01${endpoint}`,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Shopify timeout')); });
    req.end();
  });
}

async function probeShopify() {
  const s = section('shopify');
  const now = new Date();
  const iso = (d) => d.toISOString();
  const ago = (days) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - days); return d; };

  for (const [name, days] of [['last-30d', 30], ['last-90d', 90], ['last-365d', 365], ['all-time', null]]) {
    try {
      const qs = days ? `?created_at_min=${encodeURIComponent(iso(ago(days)))}&status=any` : `?status=any`;
      const res = await shopifyGet(`/orders/count.json${qs}`);
      if (res.status !== 200) {
        s[name] = { error: `HTTP ${res.status}`, bodySnippet: res.body.slice(0, 200) };
        log(`  ${name}: HTTP ${res.status}`);
        continue;
      }
      const data = JSON.parse(res.body);
      s[name] = { count: data.count };
      log(`  ${name}: ${data.count} orders`);
    } catch (e) {
      s[name] = { error: e.message };
      log(`  ${name}: ERROR ${e.message}`);
    }
  }

  // Earliest order — get oldest by ascending created_at
  try {
    const res = await shopifyGet(`/orders.json?limit=1&order=created_at+asc&status=any`);
    if (res.status === 200) {
      const order = JSON.parse(res.body).orders?.[0];
      if (order) {
        s.earliestOrder = { name: order.name, createdAt: order.created_at, id: order.id };
        log(`  earliest order: ${order.name} @ ${order.created_at}`);
      }
    } else {
      log(`  earliest order probe: HTTP ${res.status}`);
    }
  } catch (e) {
    s.earliestOrderError = e.message;
  }

  // Sample order shape
  try {
    const res = await shopifyGet(`/orders.json?limit=1&status=any&fields=id,name,created_at,financial_status,fulfillment_status,total_price,subtotal_price,total_tax,line_items,shipping_address,customer,source_name,currency,refunds`);
    if (res.status === 200) {
      const order = JSON.parse(res.body).orders?.[0];
      if (order) {
        s.sampleOrderKeys = Object.keys(order).sort();
        s.sampleLineItemKeys = order.line_items?.[0] ? Object.keys(order.line_items[0]).sort() : null;
        log(`  sample order keys (${s.sampleOrderKeys.length}): ${s.sampleOrderKeys.join(', ')}`);
      }
    }
  } catch (e) {
    s.sampleOrderError = e.message;
  }

  // Variant unitCost availability
  try {
    const res = await shopifyGet(`/products.json?limit=5`);
    if (res.status === 200) {
      const prods = JSON.parse(res.body).products || [];
      let variantsTotal = 0, variantsWithCost = 0;
      for (const p of prods) for (const v of (p.variants || [])) {
        variantsTotal++;
        // REST admin API: variant doesn't carry cost directly — cost lives on InventoryItem
        // Flag that so schema decision doesn't assume presence.
        if (v.inventory_item_id) {
          // Would need a separate /inventory_items/:id.json call
        }
      }
      s.shopifyCostAvailability = {
        note: 'REST: cost lives on InventoryItem, separate call per variant. GraphQL Admin API exposes variant.inventoryItem.unitCost directly. Recommend GraphQL for ETL.',
        variantsInSample: variantsTotal,
      };
      log(`  ${s.shopifyCostAvailability.note}`);
    }
  } catch (e) {
    s.shopifyCostAvailability = { error: e.message };
  }
}

// ── 3. Salesforce — cost fields on PBSI Item ───────────────────────────────

async function probeSalesforce() {
  const s = section('salesforce-costs');
  let conn;
  try {
    conn = await sfLib.connect();
  } catch (e) {
    s.error = `connect failed: ${e.message}`;
    log(`  ${s.error}`);
    return;
  }

  // Describe PBSI__PBSI_Item__c and find cost-like fields
  try {
    const meta = await conn.sobject('PBSI__PBSI_Item__c').describe();
    const costFields = (meta.fields || []).filter((f) => /cost|price/i.test(f.name)).map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
    }));
    s.costLikeFields = costFields;
    log(`  PBSI__PBSI_Item__c cost-like fields (${costFields.length}):`);
    for (const f of costFields) log(`    ${f.name}  (${f.type})  — ${f.label}`);
  } catch (e) {
    s.describeError = e.message;
    log(`  describe failed: ${e.message}`);
  }

  // Row counts + populated-% for likely cost fields
  try {
    const totalRec = await sfLib.query(conn, `SELECT COUNT(Id) c FROM PBSI__PBSI_Item__c`);
    s.totalItems = totalRec[0]?.c ?? totalRec[0]?.expr0 ?? null;
    log(`  total PBSI__PBSI_Item__c rows: ${s.totalItems}`);
  } catch (e) {
    s.totalItemsError = e.message;
  }

  // Try common cost field names
  const candidates = ['PBSI__Cost__c', 'PBSI__Unit_Cost__c', 'PBSI__Standard_Cost__c', 'PBSI__Purchase_Price__c', 'PBSI__Last_Cost__c', 'PBSI__Average_Cost__c'];
  s.populatedCostFields = {};
  for (const field of candidates) {
    try {
      const rec = await sfLib.query(conn, `SELECT COUNT(Id) c FROM PBSI__PBSI_Item__c WHERE ${field} != NULL AND ${field} > 0`);
      const n = rec[0]?.c ?? rec[0]?.expr0 ?? null;
      s.populatedCostFields[field] = n;
      log(`  ${field}: populated on ${n} rows`);
    } catch (e) {
      s.populatedCostFields[field] = { error: e.message.slice(0, 120) };
      // Field doesn't exist on this object — fine, moving on
    }
  }
}

// ── 4. Local snapshots ──────────────────────────────────────────────────────

function probeSnapshots() {
  const s = section('local-snapshots');
  try {
    const files = fs.existsSync(SNAPSHOT_DIR) ? fs.readdirSync(SNAPSHOT_DIR) : [];
    const buybox = files.filter((f) => f.startsWith('buybox-') && f.endsWith('.json')).sort();
    const inventory = files.filter((f) => f.startsWith('inventory-planning-') && f.endsWith('.json')).sort();
    s.buybox = { count: buybox.length, first: buybox[0] || null, last: buybox[buybox.length - 1] || null };
    s.inventoryPlanning = { count: inventory.length, first: inventory[0] || null, last: inventory[inventory.length - 1] || null };
    log(`  buybox snapshots: ${buybox.length} (${s.buybox.first} → ${s.buybox.last})`);
    log(`  inventory-planning snapshots: ${inventory.length} (${s.inventoryPlanning.first} → ${s.inventoryPlanning.last})`);

    // Sample latest inventory-planning for ASIN count
    if (s.inventoryPlanning.last) {
      const snap = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, s.inventoryPlanning.last), 'utf8'));
      s.inventoryPlanning.sampleRowCount = snap.rows?.length || snap.rowCount || null;
      log(`  latest inventory snapshot rows: ${s.inventoryPlanning.sampleRowCount}`);
    }
  } catch (e) {
    s.error = e.message;
  }

  try {
    const poFiles = fs.existsSync(PO_SENT_DIR) ? fs.readdirSync(PO_SENT_DIR).filter((f) => f.endsWith('.json')) : [];
    s.poSent = { count: poFiles.length, first: poFiles[0] || null, last: poFiles[poFiles.length - 1] || null };
    log(`  sent PO drafts: ${poFiles.length}`);
  } catch (e) {
    s.poSentError = e.message;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`Data inventory probe — ${out.startedAt}`);

  await probeSpApiOrders();
  await probeShopify();
  await probeSalesforce();
  probeSnapshots();

  const outPath = path.join(__dirname, '..', 'data', 'analytics-inventory.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`\n✓ wrote ${outPath}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
}

module.exports = { main };
