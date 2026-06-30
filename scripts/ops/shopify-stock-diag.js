/**
 * Read-only diagnostic: how does custom-flooring-centres Shopify handle stock?
 * 1) Inspect order #1288's variants (tracked? policy? qty?)
 * 2) Sample the catalog: how many variants are CONTINUE (oversellable) or untracked?
 * Usage: node scripts/ops/shopify-stock-diag.js [orderNumber]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { graphql } = require('../../lib/shopify-graphql');

const orderNum = process.argv[2] || '1288';

(async () => {
  // 1) Find the order by number
  const oq = await graphql(`{
    orders(first: 1, query: "name:#${orderNum}") {
      nodes {
        id name displayFulfillmentStatus
        lineItems(first: 20) {
          nodes {
            title quantity sku
            variant { id sku inventoryQuantity
              inventoryItem { id tracked }
              inventoryPolicy
              product { id title status totalInventory }
            }
          }
        }
      }
    }
  }`);
  const order = oq.data.orders.nodes[0];
  console.log('=== ORDER', order?.name, '/', order?.displayFulfillmentStatus, '===');
  for (const li of order?.lineItems.nodes || []) {
    const v = li.variant;
    console.log(`\n• ${li.title}  (sku ${li.sku}, qty ${li.quantity})`);
    if (!v) { console.log('   [variant deleted/unlinked]'); continue; }
    console.log(`   variant.inventoryQuantity = ${v.inventoryQuantity}`);
    console.log(`   inventoryPolicy           = ${v.inventoryPolicy}   ${v.inventoryPolicy === 'CONTINUE' ? '<-- OVERSELLABLE' : ''}`);
    console.log(`   inventoryItem.tracked     = ${v.inventoryItem?.tracked}   ${v.inventoryItem?.tracked === false ? '<-- NOT TRACKED (always buyable)' : ''}`);
    console.log(`   product.status            = ${v.product?.status}   totalInventory=${v.product?.totalInventory}`);
  }

  // 2) Catalog-wide posture sample
  console.log('\n=== CATALOG POSTURE (first 250 variants) ===');
  let after = null, n = 0, cont = 0, untracked = 0, activeProducts = 0;
  for (let page = 0; page < 1; page++) {
    const cq = await graphql(`query($after:String){
      productVariants(first: 250, after:$after){
        nodes { inventoryPolicy inventoryItem { tracked } product { status } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { after });
    const pv = cq.data.productVariants;
    for (const v of pv.nodes) {
      n++;
      if (v.inventoryPolicy === 'CONTINUE') cont++;
      if (v.inventoryItem?.tracked === false) untracked++;
      if (v.product?.status === 'ACTIVE') activeProducts++;
    }
    after = pv.pageInfo.endCursor;
    if (!pv.pageInfo.hasNextPage) break;
  }
  console.log(`variants sampled: ${n}`);
  console.log(`  oversellable (policy CONTINUE): ${cont}  (${Math.round(cont/n*100)}%)`);
  console.log(`  not tracked (always buyable):   ${untracked}  (${Math.round(untracked/n*100)}%)`);
  console.log(`  on ACTIVE products:             ${activeProducts}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
