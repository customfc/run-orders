require('dotenv').config({ path: '/Users/mvcddy91/daddy-dev/run-orders/.env' });
const fs = require('fs');
const { ProsolClientV2 } = require('./shipstation/prosol-client-v2');

const CACHE = '/tmp/mapei-coo-coverage.json';
(async () => {
  const lines = fs.readFileSync('/Users/mvcddy91/daddy-dev/yourfloors.ca/yourfloors-theme/.local/mapei-amazon-pricing.csv', 'utf8').replace(/\r/g,'').trim().split('\n');
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
            const terms = p.product_terms || [];
            const cooTerm = terms.find(t => {
              const n = (t.product_attribute || {}).name;
              const name = typeof n === 'object' ? (n.en || n.fr) : n;
              return name && /country.*origin/i.test(name);
            });
            const val = cooTerm ? cooTerm.value : null;
            const v = typeof val === 'object' ? JSON.stringify(val) : String(val || '').trim();
            cache[sku] = { coo: v };
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
  await Promise.all(Array.from({length: 6}, worker));
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  await c.close();
  summarize(cache);
})().catch(e => { console.error(e); process.exit(1); });

function summarize(cache) {
  const stats = {};
  for (const [sku, v] of Object.entries(cache)) {
    let bucket;
    if (v.error) bucket = 'ERROR';
    else if (!v.coo || v.coo === '' || v.coo === 'null' || v.coo === '{}' || v.coo === '[]') bucket = 'BLANK';
    else bucket = `SET: ${v.coo}`;
    stats[bucket] = (stats[bucket] || 0) + 1;
  }
  console.log('\n=== COO coverage across all SKUs ===');
  const sorted = Object.entries(stats).sort((a,b) => b[1]-a[1]);
  for (const [k,v] of sorted) console.log(`  ${k}: ${v}`);
}
