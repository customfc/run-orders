'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cs = require('./counter-stock');

const counters = [{ code: 'REGI', mapKey: '10037' }, { code: 'WCAS', mapKey: '10054' }];
const prod = (o = {}) => ({ id: o.id || 'gid://shopify/Product/1', tags: o.tags || [], variants: o.variants || [{ sku: '5LA004252', apiSku: '5LA004252', prosolSku: '943854221' }] });

test('countersFrom: enabled Prosol counters only, never the Coast or disabled rows', () => {
  const rows = [
    { code: 'REGI', map_key: '10037', enabled: true, rate_title: 'Pickup at our Regina trade counter' },
    { code: 'SECH', map_key: null, enabled: true, coast: true },
    { code: 'PRIV', map_key: '1', enabled: true, coast: true },
    { code: 'KAML', map_key: '10021', enabled: false },
  ];
  assert.deepStrictEqual(cs.countersFrom(rows), [{ code: 'REGI', mapKey: '10037', rateTitle: 'Pickup at our Regina trade counter' }]);
  const live = cs.countersFrom(require('../data/trade/pickup-branches.json').branches);
  assert.strictEqual(live.length, 17);
  assert.ok(live.every((c) => /^Pickup at our .+ trade counter$/.test(c.rateTitle) && /^\d+$/.test(c.mapKey)));
});

test('computeTags: #1405 case, none at Regina hides Regina only', () => {
  const [r] = cs.computeTags({ products: [prod()], stockBySku: { 943854221: { 10054: 4, 10010: 3 } }, counters });
  assert.deepStrictEqual(r.want, ['pz-no-REGI']);
  assert.deepStrictEqual(r.add, ['pz-no-REGI']);
  assert.deepStrictEqual(r.remove, []);
});

test('computeTags: any variant short hides the counter; all variants stocked shows it', () => {
  const variants = [{ sku: 'A', prosolSku: 'A' }, { sku: 'B', prosolSku: 'B' }];
  const [r] = cs.computeTags({ products: [prod({ variants })], stockBySku: { A: { 10037: 2, 10054: 1 }, B: { 10054: 5 } }, counters });
  assert.deepStrictEqual(r.want, ['pz-no-REGI']);
  const [ok] = cs.computeTags({ products: [prod({ variants })], stockBySku: { A: { 10037: 2, 10054: 1 }, B: { 10037: 1, 10054: 5 } }, counters });
  assert.deepStrictEqual(ok.want, []);
});

test('computeTags: unknown stock, a missing SKU or no variants hides every counter', () => {
  const all = ['pz-no-REGI', 'pz-no-WCAS'];
  assert.deepStrictEqual(cs.computeTags({ products: [prod()], stockBySku: { 943854221: null }, counters })[0].want, all);
  assert.deepStrictEqual(cs.computeTags({ products: [prod()], stockBySku: {}, counters })[0].want, all);
  assert.deepStrictEqual(cs.computeTags({ products: [prod({ variants: [{ sku: null, prosolSku: null }] })], stockBySku: {}, counters })[0].want, all);
  assert.deepStrictEqual(cs.computeTags({ products: [prod({ variants: [] })], stockBySku: {}, counters })[0].want, all);
});

test('computeTags: only pz-no tags move, other tags stay, case-insensitive, stale counters removed', () => {
  const tags = ['Schluter', 'pz-no-wcas', 'pz-no-OLDX', 'prozone-exclude'];
  const [r] = cs.computeTags({ products: [prod({ tags })], stockBySku: { 943854221: { 10054: 0, 10037: 1 } }, counters });
  assert.deepStrictEqual(r.want, ['pz-no-WCAS']);
  assert.deepStrictEqual(r.add, []);
  assert.deepStrictEqual(r.remove, ['pz-no-OLDX']);
  const [back] = cs.computeTags({ products: [prod({ tags })], stockBySku: { 943854221: { 10054: 3, 10037: 1 } }, counters });
  assert.deepStrictEqual(back.remove.sort(), ['pz-no-OLDX', 'pz-no-wcas']);
});

test('codesFor: sku-map object or string, Schluter UPC fallback, SKIP/NON_PROSOL/HALT hide, raw SKU last', () => {
  const { prosolCodes } = require('./pickup-runner');
  const map = { '5LA004252': { api_sku: '5LA004252', prosol_sku: '943854221' }, 'B0X': 'C030192-4', SK: 'SKIP', NP: { api_sku: 'NON_PROSOL' }, H: { api_sku: 'HALT_X', prosol_sku: 'HALT_X' } };
  const upcIndex = new Map([['4011832190445', 'KMS172/12']]);
  const f = (v) => cs.codesFor(v, { map, upcIndex, prosolCodes });
  assert.deepStrictEqual(f({ sku: '5LA004252' }), { apiSku: '5LA004252', prosolSku: '943854221', via: 'sku-map' });
  assert.deepStrictEqual(f({ sku: 'B0X' }), { apiSku: 'C030192-4', prosolSku: 'C030192-4', via: 'sku-map' });
  assert.deepStrictEqual(f({ sku: '9129', barcode: '4011832190445' }), { apiSku: 'KMS172/12', prosolSku: 'KMS172/12', via: 'schluter-upc' });
  assert.strictEqual(f({ sku: 'SK' }).prosolSku, null);
  assert.strictEqual(f({ sku: 'NP' }).prosolSku, null);
  assert.strictEqual(f({ sku: 'H' }).prosolSku, null);
  assert.deepStrictEqual(f({ sku: 'X1', barcode: '999' }), { apiSku: 'X1', prosolSku: 'X1', via: 'raw-sku' });
  const g = (v) => cs.codesFor(v, { map, upcIndex, prosolCodes, sfIndex: new Map([['9963', 'KB12SN305305AF'], ['9130', '\u200eKMS17234']]), itemIndex: new Map([['KMS17234', 'KMS172/34']]) });
  assert.deepStrictEqual(g({ sku: '9963', barcode: '0' }), { apiSku: 'KB12SN305305AF', prosolSku: 'KB12SN305305AF', via: 'sf-item' });
  assert.deepStrictEqual(g({ sku: '9130' }), { apiSku: 'KMS172/34', prosolSku: 'KMS172/34', via: 'sf-item' }, 'invisible mark stripped, slashes restored');
  assert.deepStrictEqual(f({ sku: null }), { apiSku: null, prosolSku: null, via: 'no-sku' });
});

test('syncCounterStock: dry run writes nothing; apply writes only changes; >10% failed lookups aborts', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const sync = require('../scripts/trade/counter-stock-sync');
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  const writes = [];
  const product = (n, sku, tags = []) => ({ product: { id: `gid://shopify/Product/${n}`, title: `P${n}`, tags, status: 'ACTIVE' }, variants: { pageInfo: { hasNextPage: false }, nodes: [{ id: `V${n}`, sku, barcode: null }] } });
  const gql = async (q, v) => {
    if (q.includes('deliveryProfiles')) return { deliveryProfiles: { nodes: [{ id: 'DP1', name: 'Prosol', profileLocationGroups: [{ locationGroupZones: { nodes: [{ methodDefinitions: { nodes: [{ name: 'Pickup at our Regina trade counter' }] } }] } }] }, { id: 'DP2', name: 'General', profileLocationGroups: [] }] } };
    if (q.includes('profileItems')) return { deliveryProfile: { profileItems: { pageInfo: { hasNextPage: false }, nodes: [product(1, '5LA004252'), product(2, 'ZZ-OK', ['pz-no-REGI'])] } } };
    if (q.includes('tagsAdd')) { writes.push(['add', v.id, v.t]); return { tagsAdd: { userErrors: [] } }; }
    if (q.includes('tagsRemove')) { writes.push(['remove', v.id, v.t]); return { tagsRemove: { userErrors: [] } }; }
    throw new Error(`unexpected query ${q.slice(0, 40)}`);
  };
  // Every counter has ZZ-OK; Regina has none of 943854221 (#1405). Prosol answers the batched calls the way the live
  // API does: products?filter[sku]=a,b and product_inventory_items?filter[product_id]=1,2 (only in-stock rows).
  const all = Object.fromEntries(require('./counter-stock').countersFrom(require('../data/trade/pickup-branches.json').branches).map((c) => [c.mapKey, 2]));
  const ids = { '5LA004252': 1, 'ZZ-OK': 2 };
  const client = (down = '') => () => ({ init: async () => {}, close: async () => {},
    async getProductId(sku) { const r = await this.apiGet(`/api/storefront/products?filter[sku]=${sku}`); return r.status === 200 ? ids[sku] || null : null; },
    apiGet: async (url) => {
      const q = decodeURIComponent(url);
      if (q.includes('/products?')) {
        if (down === 'ids') return { status: 503, body: '' };
        const asked = q.match(/filter\[sku\]=([^&]*)/)[1].split(',');
        return { status: 200, body: JSON.stringify({ data: asked.filter((s) => ids[s]).map((s) => ({ id: ids[s], sku: s })), last_page: 1 }) };
      }
      if (down === 'stock') return { status: 503, body: '' };
      const pids = q.match(/filter\[product_id\]=([^&]*)/)[1].split(',').map(Number);
      const rows = pids.flatMap((id) => Object.entries(id === 1 ? { ...all, 10037: 0 } : all).filter(([, n]) => n > 0).map(([loc, n]) => ({ product_id: id, product_inventory_location_id: Number(loc), available: n })));
      return { status: 200, body: JSON.stringify({ data: rows, last_page: 1 }) };
    } });
  const idCache = path.join(snapDir, 'ids.json');
  const opts = { gql, sfItems: async () => new Map(), snapDir, gapMs: 0, log: () => {}, idCache, snapshots: path.join(snapDir, 'none') };
  const dry = await sync.syncCounterStock({ ...opts, makeClient: client() });
  assert.strictEqual(dry.summary.mode, 'dry-run');
  assert.deepStrictEqual(dry.summary.lookups, { ok: 2, notFound: 0, failed: 0 });
  assert.deepStrictEqual(dry.summary.prosolRequests, { ids: 1, stock: 1, compare: 0 }, 'one batched id lookup, one batched stock call');
  assert.strictEqual(writes.length, 0);
  assert.deepStrictEqual(dry.summary.perCounter.find((c) => c.code === 'REGI'), { code: 'REGI', hidden: 1, add: 1, remove: 1 });
  assert.ok(fs.existsSync(dry.snapshotPath));
  const live = await sync.syncCounterStock({ ...opts, apply: true, makeClient: client() });
  assert.strictEqual(live.summary.mode, 'apply');
  assert.deepStrictEqual(live.summary.prosolRequests, { ids: 0, stock: 1, compare: 0 }, 'ids come from the cache now');
  assert.deepStrictEqual(writes, [['add', 'gid://shopify/Product/1', ['pz-no-REGI']], ['remove', 'gid://shopify/Product/2', ['pz-no-REGI']]]);
  writes.length = 0;
  const stockDown = await sync.syncCounterStock({ ...opts, apply: true, makeClient: client('stock') });
  assert.match(stockDown.summary.aborted, /2 of 2 lookups failed/);
  assert.strictEqual(stockDown.summary.mode, 'apply-aborted');
  assert.strictEqual(writes.length, 0, 'an aborted run keeps the previous tags');
  const fresh = path.join(snapDir, 'ids-fresh.json');
  const idsDown = await sync.syncCounterStock({ ...opts, idCache: fresh, apply: true, makeClient: client('ids') });
  assert.match(idsDown.summary.aborted, /2 of 2 lookups failed/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), {}, 'a Prosol outage never caches "not found"');
  assert.strictEqual(writes.length, 0);
});
