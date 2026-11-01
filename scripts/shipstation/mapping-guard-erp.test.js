// Stage mapping guard by ERP_BACKEND: Salesforce by default (unchanged), the
// Automayt item description under ERP_BACKEND=automayt, never blocking on a
// lookup error. Run: `node --test scripts/shipstation/mapping-guard-erp.test.js`

process.env.DISABLE_CRON = '1';
process.env.AUTOMAYT_API_BASE = 'https://beta1.automayt.dev/api/v1';
process.env.AUTOMAYT_API_KEY = 'amk_test_unit_secret';
delete process.env.AUTOMAYT_REF_OVERRIDES;
delete process.env.AUTOMAYT_TEST_CODE_PREFIX;
delete process.env.ERP_BACKEND;

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Fake Salesforce: counts every connect, answers descriptions by vendor code.
const sfCalls = [];
const SF_DESCRIPTIONS = { HAZEPINT: 'Aqua Mix Grout Haze Remover 1 Quart (946ml)' };
const sfPath = path.resolve(__dirname, '../../lib/salesforce.js');
require.cache[sfPath] = {
  id: sfPath, filename: sfPath, loaded: true,
  exports: {
    connect: async () => { sfCalls.push('connect'); return {}; },
    query: async (conn, soql) => {
      sfCalls.push(soql);
      const code = (soql.match(/PBSI__Vendor_Item_ID__c = '([^']*)'/) || [])[1];
      return SF_DESCRIPTIONS[code] ? [{ PBSI__description__c: SF_DESCRIPTIONS[code] }] : [];
    },
  },
};

// Fake Automayt batch lookup.
const amCalls = [];
let amItems = {};
let amFail = false;
global.fetch = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : {};
  amCalls.push({ url: String(url), body });
  if (amFail) return new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), { status: 400 });
  const results = (body.lookups || []).map((l) => {
    const hits = amItems[l.vendor_code] || [];
    return { input: l, status: hits.length === 0 ? 'not_found' : hits.length === 1 ? 'matched' : 'ambiguous', items: hits };
  });
  return new Response(JSON.stringify({ results }), { status: 200, headers: { 'x-request-id': 'req-test' } });
};

const { checkMappingGuard } = require('./run-orders');

const pintOrdered = (code) => ({ name: 'Aqua Mix Grout Haze Clean-Up - 1 Pint', prosolSku: code });

test('unset ERP_BACKEND: the guard reads Salesforce and halts a size mismatch, Automayt untouched', async () => {
  delete process.env.ERP_BACKEND;
  sfCalls.length = 0; amCalls.length = 0;
  const halt = await checkMappingGuard([pintOrdered('HAZEPINT')]);
  assert.match(halt, /^Mapping guard HALT — ordered "Aqua Mix Grout Haze Clean-Up - 1 Pint" but HAZEPINT is "Aqua Mix Grout Haze Remover 1 Quart \(946ml\)": size mismatch/);
  assert.equal(sfCalls[0], 'connect');
  assert.equal(amCalls.length, 0);
});

test('automayt-shadow still uses Salesforce for the guard', async () => {
  process.env.ERP_BACKEND = 'automayt-shadow';
  try {
    sfCalls.length = 0; amCalls.length = 0;
    SF_DESCRIPTIONS.SHADOWCODE = 'Aqua Mix - Sealers Choice Gold 946ml (Quart)';
    assert.equal(await checkMappingGuard([{ name: 'Aqua Mix Sealers Choice Gold - 1 Quart', prosolSku: 'SHADOWCODE' }]), null);
    assert.ok(sfCalls.length > 0);
    assert.equal(amCalls.length, 0);
  } finally { delete process.env.ERP_BACKEND; }
});

test('automayt: the guard compares against the Automayt description and never calls Salesforce', async () => {
  process.env.ERP_BACKEND = 'automayt';
  try {
    sfCalls.length = 0; amCalls.length = 0;
    amItems = {
      AMHAZE: [{ id: 'it-1', vendor_code: 'AMHAZE', description: 'Aqua Mix Grout Haze Remover 1 Quart (946ml)' }],
      AMGOLD: [{ id: 'it-2', vendor_code: 'AMGOLD', description: 'Aqua Mix - Sealers Choice Gold 946ml (Quart)' }],
    };
    const halt = await checkMappingGuard([
      { name: 'Aqua Mix Sealers Choice Gold - 1 Quart', prosolSku: 'AMGOLD' },
      pintOrdered('AMHAZE'),
    ]);
    assert.match(halt, /AMHAZE is "Aqua Mix Grout Haze Remover 1 Quart \(946ml\)": size mismatch/);
    assert.equal(amCalls.length, 1, 'one batch lookup for the whole order');
    assert.ok(amCalls[0].url.endsWith('/items/batch-lookup'));
    assert.equal(sfCalls.length, 0);

    // A match passes, from the cache: no second lookup.
    assert.equal(await checkMappingGuard([{ name: 'Aqua Mix Sealers Choice Gold - 1 Quart', prosolSku: 'AMGOLD' }]), null);
    assert.equal(amCalls.length, 1);
  } finally { delete process.env.ERP_BACKEND; }
});

test('automayt: not found, ambiguous, catalogue lines and lookup errors never block staging', async () => {
  process.env.ERP_BACKEND = 'automayt';
  try {
    sfCalls.length = 0; amCalls.length = 0;
    amItems = {
      TWOITEMS: [{ id: 'a', description: 'Aqua Mix Grout Haze Remover 1 Quart (946ml)' }, { id: 'b', description: 'other' }],
    };
    assert.equal(await checkMappingGuard([pintOrdered('NOSUCHCODE'), pintOrdered('TWOITEMS')]), null);
    assert.equal(await checkMappingGuard([{ ...pintOrdered('CATALOGCODE'), catalog: true }]), null);
    amFail = true;
    assert.equal(await checkMappingGuard([pintOrdered('ERRCODE')]), null);
    assert.equal(sfCalls.length, 0);
  } finally { amFail = false; delete process.env.ERP_BACKEND; }
});
