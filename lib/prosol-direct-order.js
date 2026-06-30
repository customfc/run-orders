/**
 * Place a wholesale order DIRECTLY on shop.prosol.ca, instead of emailing a PO
 * for Prosol to type into Tecsys by hand.
 *
 * Why: (1) removes the manual-entry bottleneck/delay at Prosol's order desk;
 * (2) uses carrier_pickup, which has NO delivery ship-to address, so the Tecsys
 * `vat_region_doesnt_match_shipto_prov_whse_bc` rule (ship-to province must
 * match branch province) cannot fire — even for out-of-province customers, since
 * the goods are collected at the branch and WE self-ship with our own label;
 * (3) never discloses our customer to Prosol.
 *
 * Flow reverse-engineered from the Nuxt SPA and LIVE-VALIDATED 2026-06-24 up to
 * (but not including) the commit — see reference_prosol_direct_order_api:
 *   auth (Sanctum CSRF) -> POST /carts {branch} -> POST /carts/{tok}/items
 *   -> PATCH /carts/{tok} {reference_number:PO} -> select carrier_pickup
 *   -> POST /orders/{tok}/revalidate {}  -> [COMMIT: POST /orders/{tok}/addToCreditLine {}]
 *
 * SAFETY (defense in depth):
 *  - A hard path guard NEVER lets a /moneris/ request out (card path — not ours),
 *    and only lets /addToCreditLine through when the commit is explicitly ARMED.
 *  - Commit is armed only when BOTH opts.commit === true AND
 *    process.env.PROSOL_DIRECT_COMMIT === '1'. Otherwise the function builds and
 *    revalidates a DRAFT (reversible, never charged, never paged to the rep) and
 *    returns it. addToCreditLine commits against our credit line — NO card.
 */

const https = require('https');

const HOST = 'shop.api.prosol.ca';
const FORBIDDEN_ALWAYS = /\/moneris\//i;       // card path — never, under any condition
const COMMIT_PATH = /\/addToCreditLine\b/i;    // the single irreversible commit

class CommitGuardError extends Error {}

function buildJar(cookieHeader) {
  const jar = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

// Low-level request with the Sanctum stateful-SPA headers + cookie-jar upkeep.
// `armed` gates the commit path; moneris is always refused.
function makeReq(jar, armed) {
  return function req(method, path, body) {
    if (FORBIDDEN_ALWAYS.test(path)) throw new CommitGuardError(`refused: moneris/card path is never called (${path})`);
    if (COMMIT_PATH.test(path) && !armed) throw new CommitGuardError(`refused: commit not armed — ${path} blocked (set opts.commit + PROSOL_DIRECT_COMMIT=1)`);
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = {
      'Accept': 'application/json',
      'Origin': 'https://shop.prosol.ca',
      'Referer': 'https://shop.prosol.ca/',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''),
    };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    return new Promise((resolve, reject) => {
      const r = https.request({ hostname: HOST, path, method, headers }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          for (const c of (res.headers['set-cookie'] || [])) {
            const kv = c.split(';')[0]; const i = kv.indexOf('=');
            if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
          }
          let json = null; try { json = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode, body: d, json });
        });
      });
      r.on('error', reject);
      r.setTimeout(30000, () => { r.destroy(); reject(new Error(`timeout ${method} ${path}`)); });
      if (payload) r.write(payload);
      r.end();
    });
  };
}

const unwrap = (r) => (r && r.json && (r.json.data !== undefined ? r.json.data : r.json)) || null;

/**
 * @param {ProsolClientV2} client  an already-init()'d client (carries the login session cookies)
 * @param {object} opts
 *   branchId       {number}  product_inventory_location_id to source/collect from
 *   items          {Array<{sku, quantity}>}  resolved against the branch's offers
 *   poNumber       {string}  our PO (required — account is po_required)
 *   pickupType     {'carrier_pickup'|'warehouse_pickup'}  default carrier_pickup
 *   pickupForm     {object}  optional carrier_name/carrier_account_number/contact fields
 *   commit         {boolean} arm the commit (also needs PROSOL_DIRECT_COMMIT=1)
 *   onLog          {fn}      optional progress logger
 * @returns {object}  { ok, committed, orderNumber, orderId, cartToken, status, totalPrice, totalTax, criticalNotifications, steps }
 */
async function placeDirectOrder(client, opts) {
  const { branchId, items, poNumber, pickupType = 'carrier_pickup', pickupForm = {}, commit = false } = opts || {};
  const log = opts && opts.onLog ? opts.onLog : () => {};
  if (!branchId) throw new Error('branchId required');
  if (!Array.isArray(items) || !items.length) throw new Error('items required');
  if (!poNumber) throw new Error('poNumber required (account is po_required)');

  const armed = commit === true && process.env.PROSOL_DIRECT_COMMIT === '1';
  const jar = buildJar(client.cookieHeader);
  const req = makeReq(jar, armed);
  const steps = [];
  const record = (name, r) => { steps.push({ name, status: r.status }); if (r.status >= 400) log(`⚠️ ${name} -> ${r.status} ${String(r.body).slice(0, 200)}`); else log(`✓ ${name} -> ${r.status}`); return r; };

  // 0) refresh CSRF
  record('csrf', await req('GET', '/sanctum/csrf-cookie'));

  // 1) resolve each SKU to a product + an offer AT THIS BRANCH
  const lineInputs = [];
  for (const it of items) {
    const pr = await req('GET', `/api/storefront/products?filter[sku]=${encodeURIComponent(it.sku)}&include=productOffers&limit=1`);
    const p = (pr.json && (pr.json.data || [])[0]) || null;
    if (!p) throw new Error(`Prosol product not found for SKU ${it.sku}`);
    const offers = p.product_offers || p.productOffers || [];
    const offer = offers.find((o) => o.product_inventory_location_id === branchId);
    if (!offer) throw new Error(`No offer for ${it.sku} at branch ${branchId} (not stocked there)`);
    lineInputs.push({ product_id: p.id, product_offer_id: offer.id, quantity: it.quantity || 1, sku: it.sku });
  }

  // 2) create draft cart at the branch
  const created = unwrap(record('create-cart', await req('POST', '/api/storefront/carts', { product_inventory_location_id: branchId })));
  const token = created && created.cart_token;
  if (!token) throw new Error('cart create failed — no cart_token');
  const orderNumber = created.name;      // e.g. "#346235"
  const orderId = created.id;

  // 3) add line items
  for (const li of lineInputs) {
    record(`add-item:${li.sku}`, await req('POST', `/api/storefront/carts/${token}/items`, { product_id: li.product_id, product_offer_id: li.product_offer_id, quantity: li.quantity }));
  }

  // 4) set PO (reference_number) via full-object PATCH
  const full = unwrap(await req('GET', `/api/storefront/carts/${token}`));
  record('set-po', await req('PATCH', `/api/storefront/carts/${token}`, { ...full, reference_number: poNumber }));

  // 5) shipment + pick the pickup service
  const shipments = (unwrap(await req('GET', `/api/storefront/carts/${token}/shipments`))) || [];
  const shipment = shipments[0];
  if (!shipment) throw new Error('no shipment created for cart');
  const svcs = shipment.available_shipping_services || [];
  const svc = svcs.find((s) => s.shipping_method && s.shipping_method.shipping_type === pickupType)
    || svcs.find((s) => s.shipping_method && /pickup/.test(s.shipping_method.shipping_type || ''));
  if (!svc) throw new Error(`no ${pickupType} service offered at branch ${branchId} (services: ${svcs.map((s) => s.shipping_method && s.shipping_method.shipping_type).join(',')})`);
  record('select-pickup', await req('PATCH', `/api/storefront/carts/${token}/shipments/${shipment.id}`, { shipping_service_id: svc.id, pickupForm, selectedShippingOptions: [] }));

  // 6) revalidate (last safe step — re-prices, validates the vat_region rule, no commit)
  const rev = unwrap(record('revalidate', await req('POST', `/api/storefront/orders/${token}/revalidate`, {})));
  const criticalNotifications = (rev && rev.critical_notifications) || [];

  const result = {
    ok: criticalNotifications.length === 0,
    committed: false,
    orderNumber, orderId, cartToken: token,
    status: rev && rev.status,
    totalPrice: rev && rev.total_price,
    totalTax: rev && rev.total_tax,
    referenceNumber: rev && rev.reference_number,
    criticalNotifications,
    branchId,
    steps,
  };

  if (criticalNotifications.length) {
    log(`✗ revalidate flagged critical notifications — NOT committing: ${JSON.stringify(criticalNotifications).slice(0, 300)}`);
    return result;
  }

  // 7) COMMIT — only when armed (opts.commit && PROSOL_DIRECT_COMMIT=1)
  if (!armed) {
    log(`◻︎ draft ${orderNumber} built + revalidated clean. Commit NOT armed — left as draft.`);
    return result;
  }
  const commitRes = record('COMMIT:addToCreditLine', await req('POST', `/api/storefront/orders/${token}/addToCreditLine`, {}));
  result.committed = commitRes.status >= 200 && commitRes.status < 300;
  result.commitResponse = (commitRes.json && commitRes.json.data) || commitRes.body && String(commitRes.body).slice(0, 500);
  log(result.committed ? `🟢 COMMITTED order ${orderNumber}` : `✗ commit failed ${commitRes.status}`);
  return result;
}

module.exports = { placeDirectOrder, CommitGuardError };
