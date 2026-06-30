require('dotenv').config({ path: '/Users/mvcddy91/daddy-dev/run-orders/.env' });
const { ProsolClientV2 } = require('./shipstation/prosol-client-v2');

(async () => {
  const c = new ProsolClientV2();
  await c.init();
  const sku = process.argv[2] || '6BU001005';
  const r = await c.apiGet(`/api/storefront/products?filter[sku]=${encodeURIComponent(sku)}&include=productOffers&limit=1`);
  const p = JSON.parse(r.body).data[0];
  // 1) Find our customer_id by querying the account endpoint variants
  const tries = ['/api/storefront/customer', '/api/storefront/me', '/api/storefront/profile', '/api/storefront/account/customer', '/api/account/customer'];
  for (const t of tries) {
    const ar = await c.apiGet(t);
    console.log(`${t}: ${ar.status}  ${ar.body.slice(0,180)}`);
  }
  // 2) Show offer's customer_id where the offer is most likely "ours" (the one shown to logged-in user)
  // The product detail call from the user's session returned customer_id=10008 at Saint-Laurent earlier.
  // Verify by filtering offers visible to us. Actually: ALL offers come back, so we can't filter that way.
  // Workaround: find customer_id which has an offer at Burnaby AND price matches user's screenshot ($18.17)
  const burnAtPrice = p.product_offers.filter(o => o.product_inventory_location_id === 10010 && Math.abs(o.current_price - 1817) < 5);
  console.log(`\nOffers at Burnaby (loc 10010) with current_price $18.17 (matching user's screenshot):`);
  burnAtPrice.forEach(o => console.log(`  customer_id=${o.customer_id}  offer_id=${o.id}  external_id=${o.external_id}`));

  await c.close();
})().catch(e => { console.error(e); process.exit(1); });
