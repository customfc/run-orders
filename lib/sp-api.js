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

// ── Finances API v0 — per-order financial events (730-day retention) ───────
//
// Unlike settlement reports (90-day listReports cap), this endpoint returns
// 2 years of per-order charges + fees + refunds + storage + service fees.
// Rate limit: 0.5 req/s sustained, burst 30. Backfill in daily date windows
// with 2.1s sleeps.

async function listFinancialEvents({ postedAfter, postedBefore, maxResultsPerPage = 100, nextToken } = {}) {
  const query = { MaxResultsPerPage: maxResultsPerPage };
  if (postedAfter) query.PostedAfter = postedAfter;
  if (postedBefore) query.PostedBefore = postedBefore;
  if (nextToken) query.NextToken = nextToken;
  const res = await spApiRequest('GET', '/finances/v0/financialEvents', { query });
  if (res.status === 429) throw Object.assign(new Error('Finances API throttled'), { status: 429, retryable: true });
  if (res.status !== 200) throw new Error(`listFinancialEvents failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function listFinancialEventsByOrder(amazonOrderId, { nextToken } = {}) {
  const query = {};
  if (nextToken) query.NextToken = nextToken;
  const res = await spApiRequest('GET', `/finances/v0/orders/${encodeURIComponent(amazonOrderId)}/financialEvents`, { query });
  if (res.status === 429) throw Object.assign(new Error('Finances API throttled'), { status: 429, retryable: true });
  if (res.status !== 200) throw new Error(`listFinancialEventsByOrder(${amazonOrderId}) failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

// ── Reports API v2021-06-30 — settlement + fee CSVs ────────────────────────

async function listReports({ reportTypes, processingStatuses = ['DONE'], createdSince, createdUntil, pageSize = 100, nextToken } = {}) {
  const query = { pageSize };
  if (reportTypes) query.reportTypes = Array.isArray(reportTypes) ? reportTypes.join(',') : reportTypes;
  if (processingStatuses) query.processingStatuses = Array.isArray(processingStatuses) ? processingStatuses.join(',') : processingStatuses;
  if (createdSince) query.createdSince = createdSince;
  if (createdUntil) query.createdUntil = createdUntil;
  if (nextToken) query.nextToken = nextToken;
  const res = await spApiRequest('GET', '/reports/2021-06-30/reports', { query });
  if (res.status !== 200) throw new Error(`listReports failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function getReportDocument(reportDocumentId) {
  const res = await spApiRequest('GET', `/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`);
  if (res.status !== 200) throw new Error(`getReportDocument(${reportDocumentId}) failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

// Fetches the actual CSV (or gzipped CSV) from the S3 URL in a report
// document. Handles gzip transparently and returns the decoded text.
async function fetchReportDocumentBody({ url, compressionAlgorithm }) {
  const zlib = require('zlib');
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`report document HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          let buf = Buffer.concat(chunks);
          if (compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
          resolve(buf.toString('utf8'));
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Orders API v0 — order + order-item history ─────────────────────────────
//
// Orders has strict rate limits (0.0167 req/s = 1 req/min sustained, burst
// 20) and OrderItems is worse (0.5 req/s sustained, burst 30). Our backfill
// paginates with explicit sleeps to stay under.

async function listOrders({ createdAfter, createdBefore, lastUpdatedAfter, lastUpdatedBefore, nextToken, maxResultsPerPage = 100, orderStatuses, marketplaceIds } = {}) {
  const mid = (marketplaceIds || process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '');
  if (!mid) throw new Error('MarketplaceIds required');
  const query = { MarketplaceIds: mid, MaxResultsPerPage: maxResultsPerPage };
  if (createdAfter) query.CreatedAfter = createdAfter;
  if (createdBefore) query.CreatedBefore = createdBefore;
  if (lastUpdatedAfter) query.LastUpdatedAfter = lastUpdatedAfter;
  if (lastUpdatedBefore) query.LastUpdatedBefore = lastUpdatedBefore;
  if (nextToken) query.NextToken = nextToken;
  if (orderStatuses) query.OrderStatuses = Array.isArray(orderStatuses) ? orderStatuses.join(',') : orderStatuses;

  const res = await spApiRequest('GET', '/orders/v0/orders', { query });
  if (res.status === 429) throw Object.assign(new Error('Orders API throttled'), { status: 429, retryable: true });
  if (res.status >= 500) throw Object.assign(new Error(`listOrders failed: ${res.status} — ${res.body.slice(0, 300)}`), { status: res.status, retryable: true });
  if (res.status !== 200) throw new Error(`listOrders failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function getOrderItems(amazonOrderId, { nextToken } = {}) {
  const query = {};
  if (nextToken) query.NextToken = nextToken;
  const res = await spApiRequest('GET', `/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/orderItems`, { query });
  if (res.status === 429) throw Object.assign(new Error('OrderItems API throttled'), { status: 429, retryable: true });
  if (res.status !== 200) throw new Error(`getOrderItems(${amazonOrderId}) failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function getOrder(amazonOrderId) {
  const res = await spApiRequest('GET', `/orders/v0/orders/${encodeURIComponent(amazonOrderId)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`getOrder(${amazonOrderId}) failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

// Paginated iterator. Yields order arrays as they come, respects rate limits
// with explicit sleeps between pages.
async function* iterateOrders(opts = {}) {
  let nextToken = null;
  const pageSleepMs = opts.pageSleepMs ?? 60_000; // Orders sustained = 1/min
  do {
    let data;
    try {
      data = await listOrders({ ...opts, nextToken });
    } catch (e) {
      if (e.retryable) {
        await new Promise((r) => setTimeout(r, 65_000));
        data = await listOrders({ ...opts, nextToken });
      } else throw e;
    }
    const orders = data.payload?.Orders || [];
    nextToken = data.payload?.NextToken || null;
    yield orders;
    if (nextToken) await new Promise((r) => setTimeout(r, pageSleepMs));
  } while (nextToken);
}

// ── Listings Items API v2021-08-01 — get + patch price ─────────────────────

const _productTypeCache = new Map(); // sku → productType

// Search our own listings by ASIN (or SKU, GTIN). Returns paginated
// listing summaries including the seller-SKU we assigned + current offer
// status. Used to find listings that are SUPPRESSED / INCOMPLETE / missing
// an offer entirely.
async function searchListingsItems({ asins, skus, pageToken, pageSize = 20, includedData = 'summaries,offers,fulfillmentAvailability,issues', sellerId: sid } = {}) {
  const sellerId = sid || (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await getSellerId();
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  const query = {
    marketplaceIds: marketplaceId,
    pageSize,
    includedData,
  };
  if (asins?.length) {
    query.identifiers = asins.join(',');
    query.identifiersType = 'ASIN';
  } else if (skus?.length) {
    query.identifiers = skus.join(',');
    query.identifiersType = 'SKU';
  }
  if (pageToken) query.pageToken = pageToken;
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`;
  const res = await spApiRequest('GET', path, { query });
  if (res.status === 429) throw Object.assign(new Error('Listings search throttled'), { status: 429, retryable: true });
  if (res.status !== 200) throw new Error(`searchListingsItems failed: ${res.status} — ${res.body.slice(0, 400)}`);
  return JSON.parse(res.body);
}

async function getListingsItem(sku, { sellerId: sid, includedData = 'summaries' } = {}) {
  const sellerId = sid || (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await getSellerId();
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const res = await spApiRequest('GET', path, { query: { marketplaceIds: marketplaceId, includedData } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`getListingsItem(${sku}) failed: ${res.status} — ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function getProductType(sku, { sellerId } = {}) {
  if (_productTypeCache.has(sku)) return _productTypeCache.get(sku);
  const item = await getListingsItem(sku, { sellerId, includedData: 'summaries' });
  const pt = item?.summaries?.[0]?.productType || null;
  if (pt) _productTypeCache.set(sku, pt);
  return pt;
}

/**
 * Replace the listing price for a single SKU via Listings Items PATCH.
 * Amazon CA marketplace, CAD. Price is GST-inclusive (value_with_tax), matching
 * what the Buy Box reports back to us.
 *
 * @param {string} sku
 * @param {number} price     – new price in CAD (value_with_tax)
 * @param {object} [opts]
 * @param {string} [opts.sellerId]
 * @returns {{status:number, submissionId:?string, issues:Array, body:string}}
 */
async function updateListingPrice(sku, price, { sellerId: sid } = {}) {
  if (!sku) throw new Error('sku required');
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid price: ${price}`);

  const sellerId = sid || (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await getSellerId();
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  if (!marketplaceId) throw new Error('AMAZON_SP_MARKETPLACE_ID not set');

  const productType = await getProductType(sku, { sellerId });
  if (!productType) throw new Error(`Could not resolve productType for ${sku} (listing may not exist)`);

  const body = {
    productType,
    patches: [
      {
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [
          {
            marketplace_id: marketplaceId,
            currency: 'CAD',
            our_price: [{ schedule: [{ value_with_tax: Number(n.toFixed(2)) }] }],
          },
        ],
      },
    ],
  };

  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const res = await spApiRequest('PATCH', path, { query: { marketplaceIds: marketplaceId }, body });
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  if (res.status !== 200) {
    const msg = parsed?.errors?.map((e) => e.message).join('; ') || res.body.slice(0, 300);
    throw new Error(`updateListingPrice(${sku}) failed: ${res.status} — ${msg}`);
  }
  return {
    status: res.status,
    submissionId: parsed?.submissionId || null,
    issues: parsed?.issues || [],
    raw: parsed,
  };
}

// PATCH a listing to add/replace a specific attribute. Thin wrapper used
// by remediation scripts (set condition_type, fulfillment quantity, etc).
async function patchListingAttribute(sku, { attribute, value, op = 'replace', productType, sellerId: sid } = {}) {
  if (!sku) throw new Error('sku required');
  if (!attribute) throw new Error('attribute required');
  const sellerId = sid || (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '') || await getSellerId();
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  const pt = productType || await getProductType(sku, { sellerId });
  if (!pt) throw new Error(`Could not resolve productType for ${sku}`);
  const body = {
    productType: pt,
    patches: [{ op, path: `/attributes/${attribute}`, value: Array.isArray(value) ? value : [value] }],
  };
  const res = await spApiRequest('PATCH', `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, { query: { marketplaceIds: marketplaceId }, body });
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  if (res.status !== 200) {
    const msg = parsed?.errors?.map((e) => e.message).join('; ') || res.body.slice(0, 400);
    throw new Error(`patchListingAttribute(${sku},${attribute}) failed: ${res.status} — ${msg}`);
  }
  return { status: res.status, submissionId: parsed?.submissionId, issues: parsed?.issues || [], raw: parsed };
}

// Set condition_type for a listing (common remediation for 8115 errors).
async function setListingCondition(sku, condition = 'new_new', opts = {}) {
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  return patchListingAttribute(sku, {
    attribute: 'condition_type',
    value: [{ value: condition, marketplace_id: marketplaceId }],
    op: 'add',
    ...opts,
  });
}

// Set MFN inventory quantity for a listing.
async function setListingMfnQuantity(sku, quantity, opts = {}) {
  const marketplaceId = process.env.AMAZON_SP_MARKETPLACE_ID?.replace(/"/g, '');
  return patchListingAttribute(sku, {
    attribute: 'fulfillment_availability',
    value: [{ fulfillment_channel_code: 'DEFAULT', quantity, marketplace_id: marketplaceId }],
    op: 'replace',
    ...opts,
  });
}

/**
 * Upload a feed body to the pre-signed URL returned by createFeedDocument.
 * Lifted out of scripts/ops/issue-refund.js so the feed path has one
 * implementation rather than a copy per caller.
 */
function putToUrl(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  putToUrl,
  getToken,
  spApiRequest,
  getFbaInventory,
  getAllFbaInventory,
  getSellerId,
  getItemOffers,
  getItemOffersBatch,
  getOffersForAsins,
  summarizeOffers,
  getListingsItem,
  getProductType,
  updateListingPrice,
  searchListingsItems,
  listOrders,
  getOrderItems,
  getOrder,
  iterateOrders,
  listReports,
  getReportDocument,
  fetchReportDocumentBody,
  listFinancialEvents,
  listFinancialEventsByOrder,
  patchListingAttribute,
  setListingCondition,
  setListingMfnQuantity,
};
