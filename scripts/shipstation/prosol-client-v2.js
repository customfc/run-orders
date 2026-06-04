#!/usr/bin/env node
/**
 * Prosol Client v2 — Browser session auth + direct API calls
 * 
 * The storefront API blocks Raelene's account on some endpoints (approved: false),
 * but the browser session cookies work fine for:
 *   - GET /api/storefront/products?filter[where_identifier]=... → get product ID
 *   - GET /api/storefront/product_inventory_items?filter[product_id]=... → stock by location
 * 
 * Strategy: login via Puppeteer, extract session cookies, use for direct HTTPS calls.
 */

const puppeteer = require('puppeteer');
const https = require('https');

const PROSOL_EMAIL = process.env.PROSOL_EMAIL;
const PROSOL_PASSWORD = process.env.PROSOL_PASSWORD;
if (!PROSOL_EMAIL || !PROSOL_PASSWORD) {
  throw new Error('Missing PROSOL_EMAIL or PROSOL_PASSWORD');
}
const PROSOL_API_BASE = 'shop.api.prosol.ca';
const SLEEP_BETWEEN = 2000; // 2s between product lookups

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class ProsolClientV2 {
  constructor() {
    this.browser = null;
    this.cookieHeader = '';
    this.xsrfToken = '';
    // Cache: prosol SKU → numeric product ID
    this.skuToIdCache = {};
  }

  async init() {
    log('🌐 Launching browser for Prosol session...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await this.browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Login (with retry — page sometimes loads slow)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto('https://shop.prosol.ca/login', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        break;
      } catch (e) {
        if (attempt === 3) throw new Error('Prosol login page failed to load after 3 attempts');
        log(`⚠️  Login page load attempt ${attempt} failed, retrying...`);
        await sleep(2000);
      }
    }
    await page.type('input[type="email"]', PROSOL_EMAIL);
    await page.type('input[type="password"]', PROSOL_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    if (page.url().includes('/login')) {
      throw new Error('Prosol login failed');
    }
    log('✅ Prosol login successful');

    // Extract cookies
    const cookies = await page.cookies('https://shop.api.prosol.ca');
    this.cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const xsrf = cookies.find(c => c.name === 'XSRF-TOKEN');
    this.xsrfToken = xsrf ? decodeURIComponent(xsrf.value) : '';

    await page.close();
    return this;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  async apiGet(path) {
    const options = {
      hostname: PROSOL_API_BASE,
      path,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://shop.prosol.ca',
        'Referer': 'https://shop.prosol.ca/',
        'Cookie': this.cookieHeader,
        'X-XSRF-TOKEN': this.xsrfToken,
      },
    };
    return httpsRequest(options);
  }

  /**
   * Look up Prosol's numeric product ID for a SKU.
   * Uses the products endpoint with filter[sku] first, then where_identifier fallback.
   */
  async getProductId(prosolSku) {
    if (this.skuToIdCache[prosolSku]) return this.skuToIdCache[prosolSku];

    // Try SKU filter
    const res = await this.apiGet(
      `/api/storefront/products?filter[sku]=${encodeURIComponent(prosolSku)}&limit=1`
    );

    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const products = data.data || data;
      if (Array.isArray(products) && products.length > 0) {
        const id = products[0].id;
        this.skuToIdCache[prosolSku] = id;
        return id;
      }
    }

    // Note: filter[manufacturer_sku] is NOT in Prosol's allowed filters
    // (allowed: id, uuid, name, slug, sku, active, stock_status, ...). It always
    // returns HTTP 400. Removed 2026-04-30. The slashed-SKU lookup miss it tried
    // to paper over was a sku-map data bug — slashes had been stripped from
    // api_sku for ~30 Schluter entries; fixed in the same commit.

    // Last-resort full-text search. `keyword=` was deprecated/silently-ignored
    // by Prosol's API sometime before 2026-04-24 — it returns the same top 5
    // products regardless of query. `search=` actually filters. Kept the same
    // exact-match guard so we don't accept false positives.
    const res3 = await this.apiGet(
      `/api/storefront/products?search=${encodeURIComponent(prosolSku)}&limit=20`
    );
    if (res3.status === 200) {
      const data3 = JSON.parse(res3.body);
      const products3 = data3.data || data3;
      if (Array.isArray(products3) && products3.length > 0) {
        const exact = products3.find((p) => {
          if (p.sku === prosolSku) return true;
          if (p.manufacturer_sku === prosolSku) return true;
          const n = typeof p.name === 'object' ? (p.name.en || p.name.fr) : p.name;
          return typeof n === 'string' && n === prosolSku;
        });
        if (exact) {
          this.skuToIdCache[prosolSku] = exact.id;
          return exact.id;
        }
      }
    }

    return null;
  }

  /**
   * Get inventory by location for a product ID.
   * Returns array of { locationId, locationName, city, province, quantity, inStock }
   */
  async getInventoryByLocation(productId) {
    const res = await this.apiGet(
      `/api/storefront/product_inventory_items?include=productInventoryLocation` +
      `&filter[product_id]=${productId}&filter[where_is_in_stock]=true` +
      `&sync_inventory=true&product_id=${productId}`
    );

    if (res.status !== 200) {
      log(`  ⚠️  product_inventory_items ${productId}: ${res.status}`);
      return null;
    }

    const data = JSON.parse(res.body);
    const items = data.data || data;
    if (!Array.isArray(items)) return null;

    return items.map(item => {
      const loc = item.product_inventory_location || item.productInventoryLocation || {};
      return {
        locationId: item.product_inventory_location_id || loc.id,
        locationName: loc.name || '',
        city: loc.city || '',
        province: loc.province || '',
        quantity: item.available || item.quantity || 0,
        inStock: (item.available || 0) > 0,
      };
    });
  }

  /**
   * Full inventory check for a Prosol SKU.
   * Returns { sku, productId, locationStock: { [locationId]: { available, quantity } } }
   */
  async checkInventory(prosolSku) {
    const productId = await this.getProductId(prosolSku);
    if (!productId) {
      log(`  ❌ Product not found for SKU: ${prosolSku}`);
      return null;
    }

    const locations = await this.getInventoryByLocation(productId);
    if (!locations) return null;

    // Build locationStock map (same format as old ProsolClient for compatibility)
    const locationStock = {};
    for (const loc of locations) {
      locationStock[loc.locationId] = {
        available: loc.inStock,
        quantity: loc.quantity,
      };
    }

    log(`  📊 ${prosolSku} (ID:${productId}) — stocked at ${locations.length} location(s)`);

    return { sku: prosolSku, productId, locationStock };
  }

  /**
   * Fetch the logged-in account's NET price (our cost) + list price for a product.
   * The catalog and inventory endpoints only expose MSRP/list (e.g. $116.81); the
   * per-account net price (e.g. $66.59) lives ONLY on /products/{id}/offers, field
   * `current_price` (cents). Location-keyed, but wholesale cost is account-level so
   * any active hub returns the same number — defaults to Burnaby (10010).
   * Returns { cost_cad, retail_cad, costSource } in dollars, or null.
   */
  async getOfferPrice(productId, locationId = 10010) {
    if (!productId) return null;
    const res = await this.apiGet(
      `/api/storefront/products/${productId}/offers?include=country,productInventoryItem&product_inventory_location_id=${locationId}`
    );
    if (res.status !== 200) { log(`  ⚠️  offers ${productId}@${locationId}: ${res.status}`); return null; }
    let data; try { data = JSON.parse(res.body); } catch { return null; }
    const arr = data.data || data;
    const o = Array.isArray(arr) ? arr[0] : arr;
    if (!o || typeof o !== 'object') return null;
    const toDollars = (v) => (typeof v === 'number' ? Math.round(v) / 100 : null);
    const cost = toDollars(o.current_price != null ? o.current_price : o.sale_price);
    const retail = toDollars(o.regular_price != null ? o.regular_price : o.msrp_price);
    if (cost == null) return null;
    return { cost_cad: cost, retail_cad: retail, costSource: `prosol-offers-loc${locationId}` };
  }

  /**
   * Convenience: SKU → our cost. Resolves the product id, then the offer price.
   * Use when adding a sku-map entry so cost_cad is captured automatically instead
   * of being left "pending" for a manual portal lookup.
   */
  async getCost(prosolSku, locationId = 10010) {
    const productId = await this.getProductId(prosolSku);
    if (!productId) return null;
    return this.getOfferPrice(productId, locationId);
  }

  /**
   * Resolve a SKU to everything a sku-map entry needs: prosol_sku, product name,
   * and our cost. EXACT filter[sku] match. Returns null if no hit, {ambiguous}
   * if >1 hit (variant ambiguity — caller should refuse), else the full info.
   */
  async getMappingInfo(sku, locationId = 10010) {
    const res = await this.apiGet(`/api/storefront/products?filter[sku]=${encodeURIComponent(sku)}&append=prosol_sku&limit=2`);
    if (res.status !== 200) return null;
    let d; try { d = JSON.parse(res.body); } catch { return null; }
    const arr = d.data || d;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    if (arr.length > 1) return { ambiguous: true, count: arr.length };
    const p = arr[0];
    const name = (typeof p.name === 'object' && p.name) ? (p.name.en || p.name.fr || '') : (p.name || '');
    const offer = await this.getOfferPrice(p.id, locationId);
    return { productId: p.id, sku: p.sku, prosol_sku: p.prosol_sku || null, name, cost_cad: offer ? offer.cost_cad : null, retail_cad: offer ? offer.retail_cad : null };
  }
}

module.exports = { ProsolClientV2 };

// ── Self-test ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const testSkus = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['C010861'];

  (async () => {
    const client = new ProsolClientV2();
    await client.init();

    for (const sku of testSkus) {
      log(`\n─── Testing SKU: ${sku} ───`);
      const inv = await client.checkInventory(sku);
      if (inv) {
        console.log('  locationStock:', JSON.stringify(inv.locationStock, null, 2));
      }
      await sleep(SLEEP_BETWEEN);
    }

    await client.close();
    log('\n✅ Done');
  })().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
