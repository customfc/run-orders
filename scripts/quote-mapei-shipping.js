require('dotenv').config({ path: '/Users/mvcddy91/daddy-dev/run-orders/.env' });
const https = require('https');

const V2 = process.env.SHIPSTATION_V2_API_KEY;
function v2(method, path, body=null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.shipstation.com', path, method,
      headers: { 'API-Key': V2, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    }, res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve({status:res.statusCode, body:d})); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

(async () => {
  // 1. Get carriers
  const c = await v2('GET', '/v2/carriers');
  const carriers = JSON.parse(c.body).carriers || [];
  console.log(`Carriers (${carriers.length}):`);
  carriers.forEach(x => console.log(`  ${x.carrier_id}  ${x.friendly_name || x.carrier_code}  primary=${x.primary || false}`));

  // 2. Get warehouses
  const w = await v2('GET', '/v2/warehouses');
  const warehouses = JSON.parse(w.body).warehouses || [];
  console.log(`\nWarehouses (${warehouses.length}):`);
  warehouses.forEach(x => {
    const a = x.origin_address || {};
    console.log(`  ${x.warehouse_id}  ${x.name}  ${a.city_locality}, ${a.state_province} ${a.postal_code}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
