'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cs = require('./counter-stock');

const counters = [{ code: 'REGI', mapKey: '10037' }, { code: 'WCAS', mapKey: '10054' }];
const prod = (o = {}) => ({ id: o.id || 'gid://shopify/Product/1', tags: o.tags || [], variants: o.variants || [{ sku: '5LA004252', apiSku: '5LA004252', prosolSku: '943854221' }] });

test('countersFrom: enabled Prosol counters only, never the Coast or disabled rows', () => {
  const rows = [
    { code: 'REGI', map_key: '10037', enabled: true, rate_title: 'Pickup at our Regina trade counter', shopify_location_id: 'gid://shopify/Location/87453302951' },
    { code: 'SECH', map_key: null, enabled: true, coast: true },
    { code: 'PRIV', map_key: '1', enabled: true, coast: true },
    { code: 'KAML', map_key: '10021', enabled: false },
  ];
  assert.deepStrictEqual(cs.countersFrom(rows), [{ code: 'REGI', mapKey: '10037', rateTitle: 'Pickup at our Regina trade counter', locationId: 'gid://shopify/Location/87453302951' }]);
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

test('syncCounterStock: dry run writes nothing; apply stocks the counters that have it, pools and DENYs; >10% failed lookups aborts', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const sync = require('../scripts/trade/counter-stock-sync');
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  const writes = [];
  const product = (n, sku) => ({ product: { id: `gid://shopify/Product/${n}`, title: `P${n}`, tags: [], status: 'ACTIVE' }, variants: { pageInfo: { hasNextPage: false }, nodes: [{ id: `V${n}`, sku, barcode: null, inventoryPolicy: 'CONTINUE', inventoryItem: { id: `I${n}` } }] } });
  const gql = async (q, v) => {
    if (q.includes('deliveryProfiles')) return { deliveryProfiles: { nodes: sync.PROFILES.map((p) => ({ id: p.id, name: p.name })) } };
    if (q.includes('profileItems')) return { deliveryProfile: { profileItems: { pageInfo: { hasNextPage: false }, nodes: v.id === sync.PROFILES[0].id ? [product(1, '5LA004252'), product(2, 'ZZ-OK')] : [] } } };
    if (q.includes('inventoryLevels')) return { location: { inventoryLevels: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    if (q.includes('inventoryBulkToggleActivation')) { writes.push(['activate', v.i, v.u.length]); return { inventoryBulkToggleActivation: { userErrors: [] } }; }
    if (q.includes('inventorySetQuantities')) { writes.push(['set', v.in.quantities.length]); return { inventorySetQuantities: { userErrors: [] } }; }
    if (q.includes('productVariantsBulkUpdate')) { writes.push(['deny', v.p, v.v.map((x) => x.id)]); return { productVariantsBulkUpdate: { userErrors: [] } }; }
    throw new Error(`unexpected query ${q.slice(0, 40)}`);
  };
  // Every counter has ZZ-OK; Regina has none of 943854221 (#1405). Prosol answers the batched calls the way the live
  // API does: products?filter[sku]=a,b and product_inventory_items?filter[product_id]=1,2 (only in-stock rows).
  const counters = require('./counter-stock').countersFrom(require('../data/trade/pickup-branches.json').branches);
  const all = Object.fromEntries(counters.map((c) => [c.mapKey, 2]));
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
  const opts = { gql, sfItems: async () => new Map(), sfShelf: async () => new Map(), snapDir, gapMs: 0, log: () => {}, idCache, snapshots: path.join(snapDir, 'none') };
  const dry = await sync.syncCounterStock({ ...opts, makeClient: client() });
  assert.strictEqual(dry.summary.mode, 'dry-run');
  assert.deepStrictEqual(dry.summary.lookups, { ok: 2, notFound: 0, failed: 0 });
  assert.deepStrictEqual(dry.summary.prosolRequests, { ids: 1, stock: 1, compare: 0 }, 'one batched id lookup, one batched stock call');
  assert.strictEqual(writes.length, 0);
  assert.deepStrictEqual(dry.summary.perCounter.find((c) => c.code === 'REGI'), { code: 'REGI', products: 1 }, 'Regina can fill only ZZ-OK');
  assert.ok(!dry.plan.activate.some((x) => x.itemId === 'I1' && x.locationId === counters.find((c) => c.code === 'REGI').locationId), '#1405 item never stocked at Regina');
  assert.deepStrictEqual(dry.summary.plan, { activate: 35, set: 35, deny: 2, deactivate: 0, skipped: 0 }, '16 + 17 counters, 2 pool levels');
  assert.ok(fs.existsSync(dry.snapshotPath));
  const live = await sync.syncCounterStock({ ...opts, apply: true, makeClient: client() });
  assert.strictEqual(live.summary.mode, 'apply');
  assert.deepStrictEqual(live.summary.prosolRequests, { ids: 0, stock: 1, compare: 0 }, 'ids come from the cache now');
  assert.deepStrictEqual(writes, [['activate', 'I1', 17], ['activate', 'I2', 18], ['set', 35], ['deny', 'gid://shopify/Product/1', ['V1']], ['deny', 'gid://shopify/Product/2', ['V2']]],
    'activate, then quantities, then DENY (never DENY before the pool is set)');
  writes.length = 0;
  const stockDown = await sync.syncCounterStock({ ...opts, apply: true, makeClient: client('stock') });
  assert.match(stockDown.summary.aborted, /2 of 2 lookups failed/);
  assert.strictEqual(stockDown.summary.mode, 'apply-aborted');
  assert.strictEqual(writes.length, 0, 'an aborted run writes nothing');
  const fresh = path.join(snapDir, 'ids-fresh.json');
  const idsDown = await sync.syncCounterStock({ ...opts, idCache: fresh, apply: true, makeClient: client('ids') });
  assert.match(idsDown.summary.aborted, /2 of 2 lookups failed/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), {}, 'a Prosol outage never caches "not found"');
  assert.strictEqual(writes.length, 0);
});

// Bulky Items (50lbs), 2026-11-05: Prosol-sourced items over 20 lb moved there on 11-04 and their counts froze. Only
// variants the sku-map sends to Prosol join; the rest of the profile keeps its old handling ("other products").
test('syncCounterStock: Bulky variants mapped to Prosol pool + DENY like the Prosol profile; unmapped / NON_PROSOL / shelf-only stay out', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const sync = require('../scripts/trade/counter-stock-sync');
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bulky-'));
  const BULKY = sync.PROFILES.find((p) => p.mappedOnly);
  assert.strictEqual(BULKY.id, 'gid://shopify/DeliveryProfile/86107652263');
  const counters = require('./counter-stock').countersFrom(require('../data/trade/pickup-branches.json').branches);
  const SECHELT = 'gid://shopify/Location/65050771623';
  const v = (id, sku, item, policy = 'DENY') => ({ id, sku, title: 'Default Title', barcode: null, inventoryPolicy: policy, inventoryItem: { id: item } });
  const items = {
    [sync.PROFILES[0].id]: [{ product: { id: 'P1', title: 'Prosol thing', tags: [], status: 'ACTIVE' }, variants: { pageInfo: { hasNextPage: false }, nodes: [v('V1', 'ZZ-PROSOL', 'I1')] } }],
    [BULKY.id]: [
      { product: { id: 'PB', title: 'Heavy bag', tags: [], status: 'ACTIVE' }, variants: { pageInfo: { hasNextPage: false }, nodes: [v('VB1', 'BULKY-MAPPED', 'IB1', 'CONTINUE'), v('VB2', 'BULKY-NONPROSOL', 'IB2'), v('VB3', 'BULKY-UNMAPPED', 'IB3', 'CONTINUE'), v('VB4', '11285', 'IB4')] } },
      { product: { id: 'PD', title: 'Draft bag', tags: [], status: 'DRAFT' }, variants: { pageInfo: { hasNextPage: false }, nodes: [v('VB5', 'BULKY-MAPPED-2', 'IB5')] } },
    ],
  };
  // Frozen since 11-04: IB1 stale at Calgary + a Vancouver placeholder; IB3 (not mapped) a Sechelt placeholder.
  // IB3 also still stocked at a counter (frozen from its Prosol-profile days, like 609 / 4677).
  const levelsAt = { [sync.POOL.locationId]: { IB1: 3 }, [sync.MOVE_TO]: { IB1: 40 }, [SECHELT]: { IB3: 12 }, [counters[2].locationId]: { IB3: 4 } };
  const asked = [];
  const gql = async (q, vars) => {
    if (q.includes('deliveryProfiles')) return { deliveryProfiles: { nodes: sync.PROFILES.map((p) => ({ id: p.id, name: p.name })) } };
    if (q.includes('profileItems')) return { deliveryProfile: { profileItems: { pageInfo: { hasNextPage: false }, nodes: items[vars.id] || [] } } };
    if (q.includes('inventoryLevels')) return { location: { inventoryLevels: { pageInfo: { hasNextPage: false }, nodes: Object.entries(levelsAt[vars.id] || {}).map(([item, n]) => ({ id: `L-${item}`, item: { id: item }, quantities: [{ quantity: n }] })) } } };
    if (q.includes('productVariants(')) {
      const all = Object.values(items).flat().filter((it) => it.product.status === 'ACTIVE').flatMap((it) => it.variants.nodes.map((x) => ({ sku: x.sku, title: x.title, inventoryItem: x.inventoryItem, product: { title: it.product.title, status: 'ACTIVE', metafield: null } })));
      return { productVariants: { pageInfo: { hasNextPage: false }, nodes: all } };
    }
    throw new Error(`unexpected query ${q.slice(0, 40)}`);
  };
  const ids = { MBAG: 11, 'ZZ-PROSOL': 12, CSDS25: 13, MOULD: 14 };
  const client = () => ({ init: async () => {}, close: async () => {},
    async getProductId(sku) { const r = await this.apiGet(`/api/storefront/products?filter[sku]=${sku}`); return r.status === 200 ? ids[sku] || null : null; },
    apiGet: async (url) => {
      const q = decodeURIComponent(url);
      if (q.includes('/products?')) {
        const skus = q.match(/filter\[sku\]=([^&]*)/)[1].split(',');
        asked.push(...skus);
        return { status: 200, body: JSON.stringify({ data: skus.filter((s) => ids[s]).map((s) => ({ id: ids[s], sku: s })), last_page: 1 }) };
      }
      const pids = q.match(/filter\[product_id\]=([^&]*)/)[1].split(',').map(Number);
      const rows = pids.flatMap((id) => (id === 11 ? [[counters[0].mapKey, 7], [counters[1].mapKey, 7]] : counters.map((c) => [c.mapKey, 2])).map(([loc, n]) => ({ product_id: id, product_inventory_location_id: Number(loc), available: n })));
      return { status: 200, body: JSON.stringify({ data: rows, last_page: 1 }) };
    } });
  const skuMap = { 'BULKY-MAPPED': { api_sku: 'MBAG', prosol_sku: 'MBAG-01' }, 'BULKY-NONPROSOL': { api_sku: 'NON_PROSOL', prosol_sku: 'NON_PROSOL', route_to: 'CFC_SECHELT' }, 11285: { api_sku: 'MOULD', prosol_sku: 'MOULD' } };
  const opts = { gql, skuMap, makeClient: client, sfItems: async () => new Map([['BULKY-UNMAPPED', 'CSDS25']]), sfShelf: async () => new Map(), snapDir, gapMs: 0, log: () => {}, idCache: path.join(snapDir, 'ids.json'), snapshots: path.join(snapDir, 'none'), env: {} };

  const dry = await sync.syncCounterStock(opts);
  assert.ok(dry.summary.profiles.includes('Bulky Items (50lbs)'));
  assert.deepStrictEqual([...new Set(asked)].sort(), ['MBAG', 'ZZ-PROSOL'], 'Prosol is asked only for the mapped Bulky code, never the Salesforce guess CSDS25');
  assert.deepStrictEqual(dry.leftOut.map((x) => [x.sku, x.why.split(' (')[0]]), [['BULKY-NONPROSOL', 'sku-map NON_PROSOL: not a Prosol item'], ['BULKY-UNMAPPED', 'not in the sku-map'], ['11285', 'shelf-only SKU']]);
  assert.match(dry.leftOut[1].why, /would have guessed sf-item CSDS25/);
  assert.strictEqual(dry.summary.leftOut, 3);
  assert.ok(!dry.products.some((p) => p.id === 'PD'), 'a draft Bulky product is not synced');
  const setOf = (item, loc) => dry.plan.set.filter((x) => x.itemId === item && x.locationId === loc).map((x) => x.qty);
  // Mapped: network total 14 at Calgary, the Vancouver placeholder to 0, DENY, stocked at the two counters that have it.
  assert.deepStrictEqual(setOf('IB1', sync.POOL.locationId), [14]);
  assert.deepStrictEqual(setOf('IB1', sync.MOVE_TO), [0]);
  assert.ok(dry.plan.deny.some((x) => x.variantId === 'VB1'));
  assert.deepStrictEqual(dry.plan.activate.filter((x) => x.itemId === 'IB1' && x.locationId !== sync.POOL.locationId).map((x) => x.locationId).sort(), [counters[0].locationId, counters[1].locationId].sort());
  // Left out: no pool, no DENY, no counter. The unmapped one keeps the old "other products" handling (no Salesforce
  // item: the Sechelt placeholder moves to Vancouver), exactly as before Bulky joined.
  for (const item of ['IB2', 'IB3', 'IB4']) {
    assert.ok(!dry.plan.activate.some((x) => x.itemId === item && counters.some((c) => c.locationId === x.locationId)), `${item} never stocked at a counter`);
    assert.deepStrictEqual(setOf(item, sync.POOL.locationId), [], `${item} gets no pool`);
  }
  assert.ok(!dry.plan.deny.some((x) => ['VB2', 'VB3', 'VB4'].includes(x.variantId)));
  assert.deepStrictEqual(setOf('IB3', sync.MOVE_TO), [12]);
  assert.deepStrictEqual(setOf('IB3', SECHELT), [0]);
  assert.deepStrictEqual(dry.plan.deactivate.filter((x) => x.itemId === 'IB3').map((x) => x.locationId), [counters[2].locationId], 'a left-out variant is unstocked at the counter it froze at, nothing else');

  // The per-variant report: counts now and after, by warehouse.
  const rows = sync.variantReport({ products: dry.products, leftOut: dry.leftOut, plan: dry.plan, levels: dry.levels, lookups: dry.lookups, counterIds: counters.map((c) => c.locationId), profile: 'bulky' });
  assert.deepStrictEqual(rows.map((r) => r.sku), ['BULKY-MAPPED', 'BULKY-NONPROSOL', 'BULKY-UNMAPPED', '11285']);
  const m = rows[0];
  assert.deepStrictEqual([m.synced, m.calgary_now, m.calgary_after, m.vancouver_now, m.vancouver_after, m.ship_total_now, m.ship_total_after, m.change, m.policy_now, m.policy_after, m.prosol_network, m.counters_stocked_after],
    ['yes', 3, 14, 40, 0, 43, 14, 'down', 'CONTINUE', 'DENY', 14, 2]);
  const u = rows[2];
  assert.deepStrictEqual([u.synced, u.sechelt_now, u.sechelt_after, u.vancouver_now, u.vancouver_after, u.change, u.policy_after, u.counters_stocked_now, u.counters_stocked_after], ['no', 12, 0, '', 12, 'unchanged', 'CONTINUE', 1, 0]);
  assert.match(sync.toCsv(rows).split('\n')[0], /^profile,synced,sku,title,/);

  // COUNTER_STOCK_BULKY=0: the profile is out, its mapped variant goes back to the old handling.
  asked.length = 0;
  const off = await sync.syncCounterStock({ ...opts, env: { COUNTER_STOCK_BULKY: '0' }, idCache: path.join(snapDir, 'ids-off.json') });
  assert.ok(!off.summary.profiles.includes('Bulky Items (50lbs)'));
  assert.deepStrictEqual(off.leftOut, []);
  assert.ok(!off.plan.deny.some((x) => x.variantId === 'VB1'));
  assert.ok(!asked.includes('MBAG'));
  assert.ok(!off.plan.deactivate.some((x) => x.itemId === 'IB3'), 'with Bulky off nothing of the profile is touched at a counter');
});

// Native pickup (Mac 2026-10-02 "go", "we don't want to sell things that are out of stock").
test('planLocations: counters stocked only while Prosol has it; Prosol-profile variants get DENY and the network total', () => {
  const counters = [{ code: 'REGI', mapKey: '10037', locationId: 'L-REGI' }, { code: 'BURN', mapKey: '10010', locationId: 'L-BURN' }, { code: 'OTTA', mapKey: '10032', locationId: null }];
  const pool = { locationId: 'L-CAL', zero: ['L-ONT', 'L-VAN'] };
  const levels = new Map([
    ['I1|L-REGI', { levelId: 'lv1', qty: 5 }], // Regina had 5, Prosol now 0: unstock
    ['I1|L-ONT', { levelId: 'lv2', qty: 100 }], // placeholder: zeroed
    ['I1|L-VAN', { levelId: 'lv3', qty: 0 }], // already 0: nothing
    ['I2|L-BURN', { levelId: 'lv4', qty: 2 }],
  ]);
  const variants = [
    { id: 'V1', productId: 'P1', itemId: 'I1', policy: 'CONTINUE', prosolSku: 'A', pooled: true },
    { id: 'V2', productId: 'P2', itemId: 'I2', policy: 'CONTINUE', prosolSku: 'B', pooled: false }, // trim: policy and pool untouched
    { id: 'V3', productId: 'P3', itemId: 'I3', policy: 'DENY', prosolSku: 'C', pooled: true }, // lookup failed: untouched
    { id: 'V4', productId: 'P4', itemId: 'I4', policy: 'CONTINUE', prosolSku: 'D', pooled: true }, // not at Prosol
  ];
  const stockBySku = { A: { 10010: 3, 10049: 4 }, B: { 10010: 2, 10037: 1 }, D: null };
  const p = cs.planLocations({ variants, stockBySku, counters, pool, levels });
  assert.deepStrictEqual(p.activate, [{ itemId: 'I1', locationId: 'L-BURN' }, { itemId: 'I1', locationId: 'L-CAL' }, { itemId: 'I2', locationId: 'L-REGI' }]);
  assert.deepStrictEqual(p.set, [
    { itemId: 'I1', locationId: 'L-BURN', qty: 3 }, { itemId: 'I1', locationId: 'L-CAL', qty: 7 }, { itemId: 'I1', locationId: 'L-ONT', qty: 0 },
    { itemId: 'I2', locationId: 'L-REGI', qty: 1 },
  ]);
  assert.deepStrictEqual(p.deactivate, [{ itemId: 'I1', locationId: 'L-REGI', levelId: 'lv1' }]);
  assert.deepStrictEqual(p.deny, [{ productId: 'P1', variantId: 'V1' }], 'trims, failed lookups and not-at-Prosol keep their policy');
  assert.strictEqual(p.skipped, 1);
});

test('planLocations: nothing anywhere at Prosol means pool 0 and DENY (not sold); unchanged levels write nothing', () => {
  const counters = [{ code: 'REGI', mapKey: '10037', locationId: 'L-REGI' }];
  const levels = new Map([['I1|L-CAL', { levelId: 'x', qty: 0 }], ['I2|L-REGI', { levelId: 'y', qty: 4 }], ['I2|L-CAL', { levelId: 'z', qty: 4 }]]);
  const p = cs.planLocations({
    variants: [{ id: 'V1', productId: 'P1', itemId: 'I1', policy: 'CONTINUE', prosolSku: 'A', pooled: true }, { id: 'V2', productId: 'P2', itemId: 'I2', policy: 'DENY', prosolSku: 'B', pooled: true }],
    stockBySku: { A: {}, B: { 10037: 4 } }, counters, pool: { locationId: 'L-CAL', zero: [] }, levels,
  });
  assert.deepStrictEqual(p, { activate: [], set: [], deactivate: [], deny: [{ productId: 'P1', variantId: 'V1' }], skipped: 0 });
});

test('planLocations: CFC shelf (Salesforce) replaces the Sechelt/Powell River placeholders; unknown shelf leaves them', () => {
  const levels = new Map([['I1|SECH', { levelId: 'a', qty: 297 }], ['I1|PR', { levelId: 'b', qty: 100 }], ['I2|SECH', { levelId: 'c', qty: 50 }]]);
  const variants = [
    { id: 'V1', productId: 'P1', itemId: 'I1', policy: 'DENY', sku: '4172', prosolSku: 'KERDIFIX/BW', pooled: false },
    { id: 'V2', productId: 'P2', itemId: 'I2', policy: 'CONTINUE', sku: '1382', prosolSku: '1382', pooled: true }, // not at Prosol: shelf still real
  ];
  const cfc = { bySku: new Map([['4172', { SECH: 24, PR: 9 }]]), locations: ['SECH', 'PR'] };
  const p = cs.planLocations({ variants, stockBySku: { 'KERDIFIX/BW': { 10010: 5 }, 1382: null }, counters: [], pool: null, levels, cfc });
  assert.deepStrictEqual(p.set, [{ itemId: 'I1', locationId: 'SECH', qty: 24 }, { itemId: 'I1', locationId: 'PR', qty: 9 }, { itemId: 'I2', locationId: 'SECH', qty: 0 }]);
  assert.deepStrictEqual(p.activate, []);
  const none = cs.planLocations({ variants, stockBySku: { 'KERDIFIX/BW': { 10010: 5 }, 1382: null }, counters: [], pool: null, levels, cfc: null });
  assert.deepStrictEqual(none.set, [], 'Salesforce down: the shelf counts stay as they are');
});

test('planLocations: Coast pickup-only locations are stocked only while it is on the shelf (Mac: "Shelf only")', () => {
  const levels = new Map([['I2|SECH-PICK', { levelId: 'z', qty: 3 }]]);
  const variants = [
    { id: 'V1', productId: 'P1', itemId: 'I1', policy: 'DENY', sku: '4172', prosolSku: 'KERDIFIX/BW', pooled: true },
    { id: 'V2', productId: 'P2', itemId: 'I2', policy: 'DENY', sku: 'KD-STR', prosolSku: 'KD-STR', pooled: true }, // #1408: nothing on our shelf
  ];
  const cfc = { bySku: new Map([['4172', { SECH: 24, PR: 9 }]]), locations: ['SECH', 'PR'], pickup: { 'SECH-PICK': 'SECH', 'PR-PICK': 'PR' } };
  const p = cs.planLocations({ variants, stockBySku: { 'KERDIFIX/BW': {}, 'KD-STR': { 10010: 10 } }, counters: [], pool: null, levels, cfc });
  assert.deepStrictEqual(p.activate.filter((x) => /PICK/.test(x.locationId)), [{ itemId: 'I1', locationId: 'SECH-PICK' }, { itemId: 'I1', locationId: 'PR-PICK' }]);
  assert.deepStrictEqual(p.set.filter((x) => /PICK/.test(x.locationId)), [{ itemId: 'I1', locationId: 'SECH-PICK', qty: 24 }, { itemId: 'I1', locationId: 'PR-PICK', qty: 9 }]);
  assert.deepStrictEqual(p.deactivate, [{ itemId: 'I2', locationId: 'SECH-PICK', levelId: 'z' }], 'the strainer is not on our shelf: no Coast pickup');
});

test('shelfUnits: Salesforce square/linear feet become rolls; unknown sizes count as none', () => {
  assert.strictEqual(cs.shelfUnits(4198, 'SqFt', ['108 ft²', 'Schluter KERDI Membrane']), 38);
  assert.strictEqual(cs.shelfUnits(432, 'SqFt', ['323 ft²']), 1);
  assert.strictEqual(cs.shelfUnits(50, 'SqFt', ['323 ft²']), 0, 'less than a roll is no roll');
  assert.strictEqual(cs.shelfUnits(527, 'LnFt', ['Default Title', 'Schluter® KERDI-BAND 5" Waterproofing Strip — 98.5 LF Roll']), 5);
  assert.strictEqual(cs.shelfUnits(24, 'EA', ['x']), 24);
  assert.strictEqual(cs.shelfUnits(300, 'SqFt', ['Default Title', 'DITRA']), 0, 'no size in the title: never guess');
  assert.strictEqual(cs.shelfUnits(10, 'SqYd', ['x']), 0);
});

test('otherShelfUnits / planOtherShelf: flooring by the box, unknowns left alone (Mac: clean up the other placeholders)', () => {
  assert.strictEqual(cs.otherShelfUnits(9139.9, 'SqFt', { sqftPerCarton: 26.42 }), 345);
  assert.strictEqual(cs.otherShelfUnits(1118.56, 'SqFt', { sqftPerCarton: 10.12 }), 110);
  assert.strictEqual(cs.otherShelfUnits(296, 'EA'), 296);
  assert.strictEqual(cs.otherShelfUnits(100, 'SqYd', { sqftPerCarton: 90 }), 10);
  assert.strictEqual(cs.otherShelfUnits(500, 'SqFt', { titles: ['Default Title', 'Ceramic Wall Tile'] }), null, 'no box size: left alone');
  assert.strictEqual(cs.otherShelfUnits(0, 'SqFt', {}), 0, 'nothing on the shelf is 0 whatever the unit');
  assert.strictEqual(cs.otherShelfUnits(5, 'Rollend'), null);
  const levels = new Map([['I1|S', { qty: 2932 }], ['I1|P', { qty: 1000 }], ['I2|S', { qty: 2000 }], ['I3|S', { qty: 491 }]]);
  const shelf = new Map([['11239', { S: 296, P: 10, uom: 'EA' }], ['11256', { S: 9139.9, uom: 'SqFt' }]]);
  const items = [{ itemId: 'I1', sku: '11239', titles: [] }, { itemId: 'I2', sku: 'EC28906', titles: [] }, { itemId: 'I3', sku: '11256', titles: [], sqftPerCarton: 26.42 }];
  assert.deepStrictEqual(cs.planOtherShelf({ items, shelf, locations: ['S', 'P'], levels }).set, [
    { itemId: 'I1', locationId: 'S', qty: 296 }, { itemId: 'I1', locationId: 'P', qty: 10 }, { itemId: 'I3', locationId: 'S', qty: 345 },
  ], 'no moveTo: special-order flooring untouched');
  const moved = cs.planOtherShelf({ items, shelf, locations: ['S', 'P'], levels, moveTo: 'V' });
  assert.deepStrictEqual(moved.activate, [{ itemId: 'I2', locationId: 'V' }]);
  assert.deepStrictEqual(moved.set.filter((x) => x.itemId === 'I2'), [{ itemId: 'I2', locationId: 'V', qty: 2000 }, { itemId: 'I2', locationId: 'S', qty: 0 }],
    'special-order flooring: placeholder moves to Vancouver (still orderable), never on our shelf');
  levels.set('I2|S', { qty: 0 });
  levels.set('I2|V', { qty: 2000 });
  assert.deepStrictEqual(cs.planOtherShelf({ items, shelf, locations: ['S', 'P'], levels, moveTo: 'V' }).set.filter((x) => x.itemId === 'I2'), [], 'moved once: nothing on the next run');
});

test('planOtherShelf: a known product with nothing on either shelf stays orderable via the move, once', () => {
  const levels = new Map([['I9|S', { qty: 15494 }], ['I9|P', { qty: 200 }]]);
  const shelf = new Map([['11080', { S: 0, P: 0, uom: 'SqFt' }]]);
  const items = [{ itemId: 'I9', sku: '11080', titles: ['15.55 ft² / Box'], sqftPerCarton: 15.55 }];
  const p = cs.planOtherShelf({ items, shelf, locations: ['S', 'P'], levels, moveTo: 'V' });
  assert.deepStrictEqual(p.activate, [{ itemId: 'I9', locationId: 'V' }]);
  assert.deepStrictEqual(p.set, [{ itemId: 'I9', locationId: 'V', qty: 15694 }, { itemId: 'I9', locationId: 'S', qty: 0 }, { itemId: 'I9', locationId: 'P', qty: 0 }]);
  levels.set('I9|S', { qty: 0 }); levels.set('I9|P', { qty: 0 }); levels.set('I9|V', { qty: 15694 });
  assert.deepStrictEqual(cs.planOtherShelf({ items, shelf, locations: ['S', 'P'], levels, moveTo: 'V' }).set, []);
});

test('planOtherShelf: everything on the shelf gets Coast pickup (Mac: "everything on the shelf"), only while it is there', () => {
  const levels = new Map([['I1|S', { qty: 2932 }], ['I2|S', { qty: 2000 }], ['I2|SP', { levelId: 'x', qty: 5 }], ['I3|S', { qty: 4 }], ['I3|SP', { levelId: 'y', qty: 4 }]]);
  const shelf = new Map([['11239', { S: 296, uom: 'EA' }], ['1530', { S: 0, uom: 'EA' }]]);
  const items = [{ itemId: 'I1', sku: '11239', titles: [] }, { itemId: 'I2', sku: 'EC28906', titles: [] }, { itemId: 'I3', sku: '1530', titles: [] }];
  const p = cs.planOtherShelf({ items, shelf, locations: ['S'], levels, moveTo: 'V', pickup: { SP: 'S' } });
  assert.deepStrictEqual(p.activate.filter((x) => x.locationId === 'SP'), [{ itemId: 'I1', locationId: 'SP' }], 'floor protection roll: pickup at Sechelt');
  assert.deepStrictEqual(p.set.filter((x) => x.locationId === 'SP'), [{ itemId: 'I1', locationId: 'SP', qty: 296 }]);
  assert.deepStrictEqual(p.deactivate, [{ itemId: 'I2', locationId: 'SP', levelId: 'x' }, { itemId: 'I3', locationId: 'SP', levelId: 'y' }], 'special order and an empty shelf: no pickup');
});

test('planOtherShelf: shelf-only SKUs (unreliable mouldings) come off sale when the shelf is empty', () => {
  const levels = new Map([['I5|S', { qty: 0 }], ['I5|V', { qty: 30 }]]);
  const shelf = new Map([['11285', { S: 0, uom: 'EA' }]]);
  const p = cs.planOtherShelf({ items: [{ itemId: 'I5', sku: '11285', titles: [] }], shelf, locations: ['S'], levels, moveTo: 'V', shelfOnly: new Set(['11285']) });
  assert.deepStrictEqual(p.set, [{ itemId: 'I5', locationId: 'V', qty: 0 }]);
  shelf.set('11285', { S: 4, uom: 'EA' });
  levels.set('I5|V', { qty: 0 });
  assert.deepStrictEqual(cs.planOtherShelf({ items: [{ itemId: 'I5', sku: '11285', titles: [] }], shelf, locations: ['S'], levels, moveTo: 'V', shelfOnly: new Set(['11285']) }).set, [{ itemId: 'I5', locationId: 'S', qty: 4 }], 'back on sale when the shelf has it');
});
