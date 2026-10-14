#!/usr/bin/env node
/**
 * The six fixed records run-orders resolves by external ref (system run-orders):
 * shopify-house, amazon-house, prosol, treeco, sechelt-warehouse, amazon-fulfillment.
 *
 *   node scripts/automayt/map-fixed.js                         # status: mapped id, or candidates by name
 *   node scripts/automayt/map-fixed.js map prosolVendor <id>   # shows the record, maps nothing
 *   node scripts/automayt/map-fixed.js map prosolVendor <id> --confirm
 *
 * A mapping can never be re-pointed, so map only after reading the record it
 * prints. Works against whatever AUTOMAYT_API_BASE / AUTOMAYT_API_KEY point at.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const am = require('../../lib/automayt');
const erp = require('../../lib/automayt-erp');

// Name patterns used only to suggest candidates; the mapping itself is by id.
const HINTS = {
  shopifyCustomer: { path: '/customers', name: 'yourfloors', also: /shopify|yourfloors/i },
  amazonCustomer: { path: '/customers', name: 'amazon', also: /amazon/i },
  prosolVendor: { path: '/vendors', name: 'prosol', also: /^prosol/i },
  treecoVendor: { path: '/vendors', name: 'treeco', also: /treeco/i },
  secheltWarehouse: { path: '/locations', also: /sechelt/i },
  amazonFulfillment: { path: '/locations', also: /amazon|fba|fulfil/i },
};

async function candidates(hint) {
  const rows = hint.path === '/locations'
    ? await am.listAll('/locations', {}, { max: 500 })
    : ((await am.get(hint.path, { name: hint.name, limit: 50 })).data.data || []);
  return rows.filter((r) => hint.also.test(r.name || '')).map((r) => `${r.id}  ${r.name}${r.virtual ? ' (virtual)' : ''}`);
}

async function status() {
  console.log(`Automayt ${am.config().base}`);
  for (const name of Object.keys(HINTS)) {
    try {
      console.log(`  ${name.padEnd(18)} mapped -> ${await erp.resolveRef(name)}`);
    } catch (err) {
      const c = await candidates(HINTS[name]).catch((e) => [`(lookup failed: ${e.message})`]);
      const none = HINTS[name].path === '/customers' ? 'none (create the house customer in Automayt, then map it)' : 'none (Automayt has to create it; the API cannot create vendors or locations)';
      console.log(`  ${name.padEnd(18)} UNMAPPED. Candidates: ${c.length ? `\n      ${c.join('\n      ')}` : none}`);
    }
  }
}

async function map(name, id, confirm) {
  const hint = HINTS[name];
  if (!hint || !id) throw new Error(`usage: map <${Object.keys(HINTS).join('|')}> <automayt id> [--confirm]`);
  const rec = hint.path === '/locations'
    ? (await am.listAll('/locations', {}, { max: 500 })).find((l) => l.id === id)
    : (await am.get(`${hint.path}/${id}`)).data;
  if (!rec) throw new Error(`${id} not found under ${hint.path}`);
  console.log(`${name} -> ${rec.id}  ${rec.name}`);
  if (!confirm) { console.log('Not mapped. Re-run with --confirm once this is the right record (a mapping can never be re-pointed).'); return; }
  await erp.mapRef(name, id);
  console.log(`mapped ${name} (system run-orders) -> ${id}`);
}

const [cmd, name, id] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
(cmd === 'map' ? map(name, id, process.argv.includes('--confirm')) : status())
  .catch((err) => { console.error(err.message); process.exit(1); });
