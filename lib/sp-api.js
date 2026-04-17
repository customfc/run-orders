/**
 * Amazon SP-API client — LWA token refresh + API calls.
 *
 * Handles:
 *   - OAuth2 token refresh via Login with Amazon (LWA)
 *   - Auto-refresh before expiry
 *   - Rate-limited API calls
 *   - FBA inventory summaries
 *
 * Env vars:
 *   AMAZON_SP_CLIENT_ID, AMAZON_SP_CLIENT_SECRET, AMAZON_SP_REFRESH_TOKEN,
 *   AMAZON_SP_MARKETPLACE_ID, AMAZON_SP_ENDPOINT
 */

const https = require('https');

let accessToken = null;
let tokenExpiresAt = 0;

// ── LWA token refresh ───────────────────────────────────────────────────────

function refreshAccessToken() {
  const clientId = process.env.AMAZON_SP_CLIENT_ID;
  const clientSecret = process.env.AMAZON_SP_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_SP_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return Promise.reject(new Error('Missing SP-API credentials in env'));
  }

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.amazon.com',
      path: '/auth/o2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`LWA token refresh failed: ${res.statusCode} — ${d.slice(0, 300)}`));
        }
        try {
          const data = JSON.parse(d);
          accessToken = data.access_token;
          // Refresh 60s before actual expiry
          tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
          resolve(accessToken);
        } catch (e) {
          reject(new Error(`LWA parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('LWA token timeout')); });
    req.write(body);
    req.end();
  });
}

async function getToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  return refreshAccessToken();
}

// ── SP-API request ──────────────────────────────────────────────────────────

async function spApiRequest(method, path, { query = {}, body = null } = {}) {
  const token = await getToken();
  const endpoint = process.env.AMAZON_SP_ENDPOINT || 'sellingpartnerapi-na.amazon.com';

  const qs = Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const fullPath = qs ? `${path}?${qs}` : path;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: endpoint,
      path: fullPath,
      method,
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));

    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: d });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('SP-API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── FBA Inventory ───────────────────────────────────────────────────────────

async function getFbaInventory({ skus = null, nextToken = null } = {}) {
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID;
  const query = {
    details: 'true',
    granularityType: 'Marketplace',
    granularityId: marketplaceId,
    marketplaceIds: marketplaceId,
  };
  if (skus && skus.length) query.sellerSkus = skus.join(',');
  if (nextToken) query.nextToken = nextToken;

  const res = await spApiRequest('GET', '/fba/inventory/v1/summaries', { query });
  if (res.status !== 200) {
    throw new Error(`FBA inventory failed: ${res.status} — ${res.body.slice(0, 500)}`);
  }
  return JSON.parse(res.body);
}

async function getAllFbaInventory({ skus = null } = {}) {
  const all = [];
  let nextToken = null;
  do {
    const data = await getFbaInventory({ skus, nextToken });
    const summaries = data.payload?.inventorySummaries || [];
    all.push(...summaries);
    nextToken = data.pagination?.nextToken || null;
    if (nextToken) await new Promise((r) => setTimeout(r, 500)); // rate limit
  } while (nextToken);
  return all;
}

// ── Sellers API — our own sellerId ─────────────────────────────────────────

let cachedSellerId = null;
async function getSellerId() {
  if (cachedSellerId) return cachedSellerId;
  if (process.env.AMAZON_SELLER_ID) {
    cachedSellerId = process.env.AMAZON_SELLER_ID.replace(/"/g, '');
    return cachedSellerId;
  }
  const res = await spApiRequest('GET', '/sellers/v1/marketplaceParticipations');
  if (res.status !== 200) {
    throw new Error(`getSellerId failed: ${res.status} — ${res.body.slice(0, 300)}`);
  }
  const data = JSON.parse(res.body);
  // First participation → seller ID (same across all marketplaces for the account)
  const sid = data.payload?.[0]?.storeName ? data.payload[0] : null;
  // Actual id is in participation.merchantId or .sellerId depending on API version
  // The v1 marketplaceParticipations wraps it differently — pull from _links or payload
  // Fallback: iterate and find first with a merchant identifier
  for (const p of data.payload || []) {
    const id = p.seller?.sellerId || p.marketplace?.id; // structure varies
    if (p.marketplace && p.participation) {
      // The sellerId isn't always in this payload; use x-amzn-Identity header if present
    }
  }
  // Most reliable: x-amzn-Identity response header from the original LWA-authorized token
  // — but we don't surface that here. If not resolvable, ask user to set AMAZON_SELLER_ID.
  throw new Error('Could not determine seller ID from marketplaceParticipations. Set AMAZON_SELLER_ID in .env (Seller Central → Settings → Account Info).');
}

// ── Pricing API v0 — getItemOffers (per-ASIN) + getItemOffersBatch (bulk) ──

async function getItemOffers(asin, { condition = 'New' } = {}) {
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  const query = { MarketplaceId: marketplaceId, ItemCondition: condition };
  const res = await spApiRequest('GET', `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`, { query });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`getItemOffers(${asin}) failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function getItemOffersBatch(asins, { condition = 'New', maxRetries = 4 } = {}) {
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  const body = {
    requests: asins.slice(0, 20).map((asin) => ({
      uri: `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`,
      method: 'GET',
      MarketplaceId: marketplaceId,
      ItemCondition: condition,
    })),
  };
  let attempt = 0;
  let wait = 10_000;
  while (true) {
    const res = await spApiRequest('POST', '/batches/products/pricing/v0/itemOffers', { body });
    if (res.status === 200) return JSON.parse(res.body);
    if (res.status === 429 && attempt < maxRetries) {
      attempt++;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60_000);
      continue;
    }
    throw new Error(`getItemOffersBatch failed: ${res.status} — ${res.body.slice(0, 300)}`);
  }
}

// Summarize a single ASIN's offers into what the optimizer needs.
// Takes the `payload` object from a v0 getItemOffers response.
function summarizeOffers(payload, { sellerId } = {}) {
  const out = {
    asin: payload?.ASIN || null,
    offerCount: (payload?.Offers || []).length,
    buyBoxPrice: null,
    buyBoxSellerId: null,
    buyBoxIsUs: false,
    buyBoxIsFba: false,
    lowestPrice: null,
    lowestFbaPrice: null,
    ourPrice: null,
    ourIsFba: false,
    offers: [],
  };

  // BuyBoxPrices is a separate summary block with the Buy Box winner's price
  const bbp = (payload?.Summary?.BuyBoxPrices || [])[0];
  if (bbp) {
    out.buyBoxPrice = (bbp.ListingPrice?.Amount ?? 0) + (bbp.Shipping?.Amount ?? 0);
  }

  for (const o of payload?.Offers || []) {
    const price = (o.ListingPrice?.Amount ?? 0) + (o.Shipping?.Amount ?? 0);
    const isFba = o.IsFulfilledByAmazon === true;
    const isUs = sellerId ? o.SellerId === sellerId : false;
    const offer = {
      sellerId: o.SellerId,
      price,
      listingPrice: o.ListingPrice?.Amount ?? null,
      shipping: o.Shipping?.Amount ?? 0,
      isFba,
      isBuyBoxWinner: o.IsBuyBoxWinner === true,
      isFeaturedMerchant: o.IsFeaturedMerchant === true,
      isUs,
      prime: o.PrimeInformation?.IsPrime === true,
      condition: o.SubCondition,
    };
    out.offers.push(offer);

    if (o.IsBuyBoxWinner) {
      out.buyBoxSellerId = o.SellerId;
      out.buyBoxIsUs = isUs;
      out.buyBoxIsFba = isFba;
      if (!out.buyBoxPrice) out.buyBoxPrice = price;
    }
    if (isUs) {
      out.ourPrice = price;
      out.ourIsFba = isFba;
    }
    if (out.lowestPrice === null || price < out.lowestPrice) out.lowestPrice = price;
    if (isFba && (out.lowestFbaPrice === null || price < out.lowestFbaPrice)) out.lowestFbaPrice = price;
  }

  return out;
}

// Bulk fetch + summarize for an array of ASINs. Batches in groups of 20.
async function getOffersForAsins(asins, { sellerId, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < asins.length; i += 20) {
    const batch = asins.slice(i, i + 20);
    try {
      const data = await getItemOffersBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        const entry = data.responses?.[j];
        if (entry?.status?.statusCode === 200) {
          results.push({ asin: batch[j], ok: true, summary: summarizeOffers(entry.body?.payload, { sellerId }) });
        } else {
          results.push({ asin: batch[j], ok: false, error: `${entry?.status?.statusCode} ${entry?.status?.reasonPhrase || ''}`.trim() });
        }
      }
    } catch (e) {
      for (const asin of batch) results.push({ asin, ok: false, error: e.message });
    }
    if (onProgress) onProgress({ done: Math.min(i + 20, asins.length), total: asins.length });
    if (i + 20 < asins.length) await new Promise((r) => setTimeout(r, 30_000));
  }
  return results;
}

module.exports = {
  getToken,
  spApiRequest,
  getFbaInventory,
  getAllFbaInventory,
  getSellerId,
  getItemOffers,
  getItemOffersBatch,
  getOffersForAsins,
  summarizeOffers,
};
