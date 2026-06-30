require('dotenv').config({ path: '/Users/mvcddy91/daddy-dev/run-orders/.env' });
const fs = require('fs');
const { ProsolClientV2 } = require('./shipstation/prosol-client-v2');

const BURN_LOC = 10010;
const OUR_CUST = 12070;
const CACHE = '/tmp/mapei-pricing-burnaby.json';
const CONCURRENCY = 8;

(async () => {
  const lines = fs.readFileSync('/Users/mvcddy91/daddy-dev/yourfloors.ca/yourfloors-theme/.local/mapei-amazon-pricing.csv', 'utf8').replace(/\r/g,'').trim().split('\n');
  const skus = lines.slice(1).map(l => l.split(',')[0]);
  let cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const todo = skus.filter(s => !cache[s]);
  console.log(`Total: ${skus.length}, cached: ${skus.length-todo.length}, todo: ${todo.length}`);
  if (!todo.length) { summarize(cache); return; }

  const client = new ProsolClientV2();
  await client.init();

  let done = 0, ok = 0;
  const startTs = Date.now();

  async function processSku(sku) {
    try {
      const r = await client.apiGet(`/api/storefront/products?filter[sku]=${encodeURIComponent(sku)}&include=productOffers&limit=1`);
      if (r.status !== 200) { cache[sku] = { error: r.status }; return; }
      const data = JSON.parse(r.body);
      const p = (data.data || data)[0];
      if (!p) { cache[sku] = { error: 'not-found' }; return; }
      const offers = p.product_offers || [];
      let chosen = offers.find(o => o.product_inventory_location_id === BURN_LOC && o.customer_id === OUR_CUST);
      let strategy = 'us@burnaby';
      if (!chosen) {
        const burns = offers.filter(o => o.product_inventory_location_id === BURN_LOC);
        if (burns.length) {
          burns.sort((a,b) => a.current_price - b.current_price);
          chosen = burns[Math.floor(burns.length/2)];
          strategy = 'median@burnaby';
        }
      }
      if (!chosen) {
        chosen = offers.find(o => o.customer_id === OUR_CUST);
        strategy = chosen ? 'us@anywhere' : 'no-match';
      }
      if (chosen) {
        cache[sku] = {
          wholesale_cents: chosen.current_price, regular_cents: chosen.regular_price,
          msrp_cents: p.msrp_price, location_id: chosen.product_inventory_location_id,
          customer_id: chosen.customer_id, strategy, offer_count: offers.length,
        };
        ok++;
      } else cache[sku] = { error: 'no-offer-found', offer_count: offers.length, msrp_cents: p.msrp_price };
    } catch (e) { cache[sku] = { error: e.message }; }
  }

  // Worker pool
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const i = idx++;
      await processSku(todo[i]);
      done++;
      if (done % 25 === 0 || done === todo.length) {
        fs.writeFileSync(CACHE, JSON.stringify(cache));
        const rate = done / ((Date.now() - startTs) / 1000);
        console.log(`  [${done}/${todo.length}] ok=${ok}  rate=${rate.toFixed(1)}/s  ETA ${Math.ceil((todo.length-done)/rate)}s`);
      }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  await client.close();
  summarize(cache);
})().catch(e => { console.error(e); process.exit(1); });

function summarize(cache) {
  console.log('\n=== SUMMARY ===');
  const stats = {};
  let priced = 0, total = 0;
  for (const v of Object.values(cache)) {
    const k = v.error ? `error: ${v.error}` : v.strategy;
    stats[k] = (stats[k]||0) + 1;
    if (v.wholesale_cents) { priced++; total += v.wholesale_cents; }
  }
  Object.entries(stats).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
  if (priced) console.log(`Avg Burnaby wholesale: $${(total/priced/100).toFixed(2)} across ${priced} SKUs`);

  const old = JSON.parse(fs.readFileSync('/tmp/mapei-pricing.json', 'utf8'));
  const oldBySku = {}; for (const v of Object.values(old)) if (v.sku) oldBySku[v.sku] = v.wholesale_cents;
  const diffs = [];
  for (const [sku, v] of Object.entries(cache))
    if (v.wholesale_cents != null && oldBySku[sku] != null)
      diffs.push({ sku, old: oldBySku[sku], neu: v.wholesale_cents, delta: v.wholesale_cents - oldBySku[sku] });
  if (diffs.length) {
    diffs.sort((a,b) => b.delta - a.delta);
    const avg = diffs.reduce((s,d)=>s+d.delta,0)/diffs.length;
    console.log(`\nOld→new delta across ${diffs.length} SKUs: avg ${avg>=0?'+':''}$${(avg/100).toFixed(2)}`);
    console.log('Top 5 increases:');
    diffs.slice(0,5).forEach(d => console.log(`  ${d.sku}: $${(d.old/100).toFixed(2)} → $${(d.neu/100).toFixed(2)}  (+$${(d.delta/100).toFixed(2)})`));
  }
}
