#!/usr/bin/env node
// Rebuild data/automayt-items-index.json now (the server does it nightly at 01:30 ET).
// Usage: node scripts/automayt-item-index.js            rebuild
//        node scripts/automayt-item-index.js find CODE  list items carrying CODE
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const idx = require('../lib/automayt-item-index');
(async () => {
  if (process.argv[2] === 'find') {
    for (const h of idx.search(process.argv.slice(3))) console.log(h.code, h.row.id, h.row.item_number, h.row.vendor_code, h.row.vendor, '|', h.row.description);
    return;
  }
  const r = await idx.rebuild();
  console.log(`index: ${r.items} items, ${r.pages} pages → ${idx.INDEX_FILE}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
