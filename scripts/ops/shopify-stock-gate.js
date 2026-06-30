/**
 * shopify-stock-gate.js — drive custom-flooring-centres Shopify inventory from
 * Salesforce + confirmed vendor availability, so we stop selling what we can't
 * supply WITHOUT pulling product we can still get.
 *
 * Mac's policy (2026-06-18):
 *   - IN-STOCK (warehouse) items  -> can't oversell: policy DENY, qty = boxes(ATP).
 *   - SPECIAL-ORDER / out-of-stock -> STAY BUYABLE (backorder is fine). We just
 *       stop showing fake counts (set qty to real ATP) and never flip them off.
 *   - DISCONTINUED ONLY            -> KILL: qty 0, policy DENY, sold out.
 *       "Discontinued" = confirmed gone forever (Layer 2 vendor-availability flag,
 *        a human mark, or SF Not_Available_For_Sale). Mere no-stock is NOT a kill.
 *
 * The #1288 Bourbon tile was DISCONTINUED, which is why it gets killed.
 *
 * SAFE BY DEFAULT: dry-run prints the diff and exits. Pass --apply to write.
 * Flags: --apply  --buffer=N (min ATP to count as in-stock, default 0)
 *        --sku=00775 (restrict to one Shopify SKU, e.g. live-test a single variant)
 *        --limit=N (debug)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { graphql } = require('../../lib/shopify-graphql');
const sf = require('../../lib/salesforce');
const va = require('../../lib/vendor-availability'); // Layer 2: confirmed vendor availability

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const APPLY = !!args.apply;
const BUFFER = Number(args.buffer || 0);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const ONLY_SKU = args.sku || null;
const KILLS_ONLY = !!args['kills-only']; // apply only DISCONTINUED/NOT_FOR_SALE changes
// CFC stock truth lives at the Sechelt warehouse (matches SF default location).
const LOCATION_NAME = process.env.SHOPIFY_STOCK_LOCATION || 'Sechelt';

// KILL only on DISCONTINUED (never on mere out-of-stock).
function vendorConfirmedDiscontinued(ourSku) {
  let s; try { s = va.statusForOurSku(ourSku); } catch { return false; }
  return !!(s && (s.discontinued === 1 || s.status === 'discontinued'));
}

function boxesFromAtp(atp, boxQty) {
  const a = Number(atp) || 0;
  const bq = Number(boxQty) || 0;
  if (bq > 1) return Math.max(0, Math.floor(a / bq)); // sold by the box
  return Math.max(0, Math.floor(a));                   // sold by the each/unit
}

async function fetchAllVariants() {
  const out = []; let after = null;
  while (out.length < LIMIT) {
    const q = await graphql(`query($after:String){
      productVariants(first: 200, after:$after){
        nodes {
          id sku inventoryQuantity inventoryPolicy
          inventoryItem { id tracked }
          product { id title status }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`, { after });
    const pv = q.data.productVariants;
    out.push(...pv.nodes);
    if (!pv.pageInfo.hasNextPage) break;
    after = pv.pageInfo.endCursor;
  }
  return out.slice(0, LIMIT);
}

async function fetchSfBySkus(conn, skus) {
  const map = new Map();
  const clean = [...new Set(skus.filter(Boolean).map(s => String(s).replace(/'/g, "\\'")))];
  for (let i = 0; i < clean.length; i += 180) {
    const inList = clean.slice(i, i + 180).map(s => `'${s}'`).join(',');
    const rows = await sf.query(conn, `
      SELECT Name, AscentBTO__Stock_Status__c, PBSI__Available_to_Promise__c,
             PBSI__Not_Available_For_Sale__c, Box_Quantity__c, PBSI__description__c
      FROM PBSI__PBSI_Item__c WHERE Name IN (${inList})
    `);
    for (const r of rows) map.set(String(r.Name), r);
  }
  return map;
}

// Classify a Shopify variant against SF + Layer 2.
function classify(sfRow, ourSku) {
  if (vendorConfirmedDiscontinued(ourSku)) return 'DISCONTINUED';
  if (sfRow && sfRow.PBSI__Not_Available_For_Sale__c === true) return 'NOT_FOR_SALE';
  if (!sfRow) return 'UNKNOWN';
  const status = (sfRow.AscentBTO__Stock_Status__c || '').trim();
  const atp = Number(sfRow.PBSI__Available_to_Promise__c) || 0;
  if (status === 'Stock' || atp > BUFFER) return 'IN_STOCK';
  return 'KEEP_BUYABLE'; // special-order / out-of-stock / blank — buyable, never killed
}

// Desired (policy, qty). policy null = leave as-is. qty null = leave as-is.
function desired(cls, sfRow) {
  const atp = sfRow ? Number(sfRow.PBSI__Available_to_Promise__c) || 0 : 0;
  const boxQty = sfRow ? sfRow.Box_Quantity__c : 0;
  switch (cls) {
    case 'IN_STOCK':      return { policy: 'DENY', qty: boxesFromAtp(atp, boxQty) };
    case 'DISCONTINUED':  return { policy: 'DENY', qty: 0 }; // kill
    case 'NOT_FOR_SALE':  return { policy: 'DENY', qty: 0 }; // kill (explicit SF flag)
    case 'KEEP_BUYABLE':  return { policy: null,   qty: boxesFromAtp(atp, boxQty) }; // fix fake counts only
    default:              return { policy: null,   qty: null }; // UNKNOWN — untouched
  }
}

async function getLocationId() {
  const q = await graphql(`{ locations(first: 20){ nodes { id name isPrimary } } }`);
  const nodes = q.data.locations.nodes;
  const match = nodes.find(n => n.name.toLowerCase().includes(LOCATION_NAME.toLowerCase()));
  if (!match) throw new Error(`Location "${LOCATION_NAME}" not found. Have: ${nodes.map(n => n.name).join(', ')}`);
  return match.id;
}
async function activateAt(inventoryItemId, locationId) {
  await graphql(`mutation($i:ID!,$l:ID!){ inventoryActivate(inventoryItemId:$i, locationId:$l){ userErrors{ message } } }`,
    { i: inventoryItemId, l: locationId });
}
async function applyPolicy(productId, variantId, policy) {
  const r = await graphql(`mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){
    productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ field message } }
  }`, { pid: productId, v: [{ id: variantId, inventoryPolicy: policy }] });
  const ue = r.data?.productVariantsBulkUpdate?.userErrors || [];
  if (ue.length) throw new Error('policy: ' + ue.map(e => e.message).join('; '));
}
async function setQtyOnce(inventoryItemId, locationId, qty) {
  const r = await graphql(`mutation($input:InventorySetQuantitiesInput!){
    inventorySetQuantities(input:$input){ userErrors{ field message } }
  }`, { input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true,
    quantities: [{ inventoryItemId, locationId, quantity: qty }] } });
  return r.data?.inventorySetQuantities?.userErrors || [];
}
async function applyQty(inventoryItemId, locationId, qty) {
  let ue = await setQtyOnce(inventoryItemId, locationId, qty);
  if (ue.some(e => /not stocked/i.test(e.message))) {        // activate then retry
    await activateAt(inventoryItemId, locationId);
    ue = await setQtyOnce(inventoryItemId, locationId, qty);
  }
  if (ue.length) throw new Error('qty: ' + ue.map(e => e.message).join('; '));
}

(async () => {
  console.log(`MODE: ${APPLY ? 'APPLY (writing to Shopify)' : 'DRY-RUN'}  buffer=${BUFFER}${ONLY_SKU ? `  only sku=${ONLY_SKU}` : ''}`);
  const conn = await sf.connect(); conn.version = '62.0';
  let variants = await fetchAllVariants();
  if (ONLY_SKU) variants = variants.filter(v => String(v.sku) === String(ONLY_SKU));
  console.log(`Shopify variants: ${variants.length}`);
  const sfMap = await fetchSfBySkus(conn, variants.map(v => v.sku));
  console.log(`SF items matched: ${sfMap.size}`);
  const locationId = APPLY ? await getLocationId() : null;

  const buckets = { IN_STOCK: 0, KEEP_BUYABLE: 0, DISCONTINUED: 0, NOT_FOR_SALE: 0, UNKNOWN: 0 };
  const changes = [];
  const kills = [];
  for (const v of variants) {
    if (!v.sku) { buckets.UNKNOWN++; continue; }
    const sfRow = sfMap.get(String(v.sku));
    const cls = classify(sfRow, v.sku);
    buckets[cls]++;
    const want = desired(cls, sfRow);
    const polChange = want.policy && want.policy !== v.inventoryPolicy;
    const qtyChange = want.qty != null && want.qty !== v.inventoryQuantity;
    if (cls === 'DISCONTINUED' || cls === 'NOT_FOR_SALE') {
      if (polChange || qtyChange) kills.push({ v, cls, want });
    }
    if (polChange || qtyChange) changes.push({ v, cls, want, polChange, qtyChange });
  }

  console.log(`\n=== CLASSIFICATION ===`);
  for (const k of Object.keys(buckets)) console.log(`  ${k.padEnd(13)} ${buckets[k]}`);

  console.log(`\n=== KILLS (DISCONTINUED / not-for-sale -> sold out) === ${kills.length}`);
  for (const c of kills.slice(0, 50)) {
    console.log(`  [${c.cls}] ${c.v.sku}  qty ${c.v.inventoryQuantity}->${c.want.qty}  policy ${c.v.inventoryPolicy}->${c.want.policy || '(keep)'}  ${c.v.product.title.slice(0,60)}`);
  }

  const oversellFix = changes.filter(c => c.cls === 'IN_STOCK' && c.polChange && c.v.inventoryPolicy === 'CONTINUE');
  const sampleInStock = changes.filter(c => c.cls === 'IN_STOCK').slice(0, 12);
  console.log(`\n=== IN-STOCK anti-oversell (CONTINUE->DENY): ${oversellFix.length} | sample qty corrections ===`);
  for (const c of sampleInStock) {
    console.log(`  ${c.v.sku}  qty ${c.v.inventoryQuantity}->${c.want.qty}  policy ${c.v.inventoryPolicy}->${c.want.policy}  ${c.v.product.title.slice(0,50)}`);
  }

  const byCls = {};
  for (const c of changes) byCls[c.cls] = (byCls[c.cls] || 0) + 1;
  console.log(`\n=== TOTAL CHANGES: ${changes.length} ===  by class: ${JSON.stringify(byCls)}`);

  if (!APPLY) { console.log('\nDRY-RUN — nothing written. Re-run with --apply to enforce.'); process.exit(0); }

  const toApply = KILLS_ONLY
    ? changes.filter(c => c.cls === 'DISCONTINUED' || c.cls === 'NOT_FOR_SALE')
    : changes;
  console.log(`Applying ${toApply.length}${KILLS_ONLY ? ' (kills only)' : ''} of ${changes.length} changes...`);
  let done = 0;
  for (const c of toApply) {
    try {
      if (c.polChange) await applyPolicy(c.v.product.id, c.v.id, c.want.policy);
      if (c.qtyChange) await applyQty(c.v.inventoryItem.id, locationId, c.want.qty);
      done++;
      if (done % 25 === 0) console.log(`  applied ${done}/${toApply.length}`);
    } catch (e) { console.error(`  FAIL ${c.v.sku}: ${e.message}`); }
  }
  console.log(`\nAPPLIED ${done}/${toApply.length} changes to Shopify.`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
