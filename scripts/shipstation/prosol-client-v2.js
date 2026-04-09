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

    // Login
    await page.goto('https://shop.prosol.ca/login', { waitUntil: 'networkidle2' });
    await page.type('input[type="email"]', PROSOL_EMAIL);
    await page.type('input[type="password"]', PROSOL_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

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

    // Try manufacturer SKU (prosol_sku field)
    const res2 = await this.apiGet(
      `/api/storefront/products?filter[manufacturer_sku]=${encodeURIComponent(prosolSku)}&append=prosol_sku&limit=5`
    );
    if (res2.status === 200) {
      const data2 = JSON.parse(res2.body);
      const products2 = data2.data || data2;
      if (Array.isArray(products2) && products2.length > 0) {
        // Find the one matching our SKU
        const match = products2.find(p => p.sku === prosolSku || p.name === prosolSku);
        const id = match ? match.id : products2[0].id;
        this.skuToIdCache[prosolSku] = id;
        return id;
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
