require('dotenv').config({ path: '/Users/mvcddy91/daddy-dev/run-orders/.env' });
const fs = require('fs');
const { ProsolClientV2 } = require('./shipstation/prosol-client-v2');
const CACHE = '/tmp/mapei-prosol-attrs.json';
const CONCURRENCY = 2;
(async () => {
  const lines = fs.readFileSync('/Users/mvcddy91/daddy-dev/yourfloors.ca/yourfloors-theme/.local/mapei-amazon-pricing.csv','utf8').replace(/\r/g,'').trim().split('\n');
  const skus = lines.slice(1).map(l => l.split(',')[0]);
  let cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE,'utf8')) : {};
  const todo = skus.filter(s => !(s in cache));
  console.log(`Total ${skus.length}, cached ${skus.length-todo.length}, todo ${todo.length}`);
  if (!todo.length) { summarize(cache); return; }

  const c = new ProsolClientV2();
  await c.init();
  let done = 0, idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const i = idx++; const sku = todo[i];
      try {
        const r = await c.apiGet(`/api/storefront/products?filter[sku]=${encodeURIComponent(sku)}&include=productTerms.productAttribute`);
        if (r.status !== 200) { cache[sku] = {error: r.status}; }
        else {
          const p = JSON.parse(r.body).data[0];
          if (!p) cache[sku] = {error: 'not-found'};
          else {
            const out = {};
            for (const t of p.product_terms || []) {
              const attr = t.product_attribute || {};
              const attrName = typeof attr.name === 'object' ? (attr.name.en || attr.name.fr) : attr.name;
              const value = typeof t.name === 'object' ? (t.name.en || t.name.fr) : t.name;
              if (attrName && value && String(value).trim()) out[attrName] = value;
            }
            cache[sku] = out;
          }
        }
      } catch (e) { cache[sku] = {error: e.message}; }
      done++;
      if (done % 25 === 0 || done === todo.length) {
        fs.writeFileSync(CACHE, JSON.stringify(cache));
        console.log(`  [${done}/${todo.length}]`);
      }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  await c.close();
  summarize(cache);
})().catch(e => { console.error(e); process.exit(1); });

function summarize(cache) {
  let withCOO = 0, total = 0, errors = 0;
  const coo_dist = {};
  for (const [sku, v] of Object.entries(cache)) {
    if (v.error) { errors++; continue; }
    total++;
    const c = v['Country of Origin'];
    if (c) { withCOO++; coo_dist[c] = (coo_dist[c] || 0) + 1; }
  }
  console.log(`\n=== Coverage ===`);
  console.log(`Total OK: ${total}  errors: ${errors}`);
  console.log(`With COO: ${withCOO} (${(100*withCOO/total).toFixed(0)}%)`);
  console.log(`COO distribution:`);
  for (const [k,v] of Object.entries(coo_dist).sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v}`);
}
