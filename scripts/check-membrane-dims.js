require('dotenv').config({ path: '/Users/mvcddy91/daddy-dev/run-orders/.env' });
const { ProsolClientV2 } = require('./shipstation/prosol-client-v2');
(async () => {
  const c = new ProsolClientV2();
  await c.init();
  const sku = process.argv[2] || '04140000';
  const r = await c.apiGet(`/api/storefront/products?filter[sku]=${encodeURIComponent(sku)}&include=productTerms.productAttribute`);
  const p = JSON.parse(r.body).data[0];
  console.log(`SKU: ${sku}`);
  console.log(`Name: ${typeof p.name === 'object' ? p.name.en : p.name}`);
  const terms = p.product_terms || [];
  console.log(`\nProduct attributes (with values):`);
  for (const t of terms) {
    const attr = t.product_attribute || {};
    const attrName = typeof attr.name === 'object' ? (attr.name.en || attr.name.fr) : attr.name;
    const value = typeof t.name === 'object' ? (t.name.en || t.name.fr) : t.name;
    if (value && String(value).trim()) console.log(`  ${attrName}: ${value}`);
  }
  await c.close();
})().catch(e => { console.error(e); process.exit(1); });
