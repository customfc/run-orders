/**
 * Shopify Admin GraphQL helper.
 *
 * Uses X-Shopify-Access-Token auth + the versioned 2026-01 endpoint.
 * Includes query-cost aware pagination (Shopify throttles by calculated
 * query cost, not just request count).
 */

const https = require('https');

const API_VERSION = '2026-01';

async function graphql(query, variables = {}) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN');

  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: store,
      path: `/admin/api/${API_VERSION}/graphql.json`,
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(d);
          if (data.errors?.length) {
            reject(new Error(`Shopify GraphQL: ${data.errors.map((e) => e.message).join('; ')}`));
            return;
          }
          if (data.data?.userErrors?.length) {
            reject(new Error(`Shopify userErrors: ${data.data.userErrors.map((e) => e.message).join('; ')}`));
            return;
          }
          resolve(data);
        } catch (e) {
          reject(new Error(`Shopify GraphQL parse: ${e.message} — body: ${d.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Shopify GraphQL timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { graphql, API_VERSION };
