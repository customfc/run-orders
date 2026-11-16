'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-index-'));
process.env.AUTOMAYT_ITEM_INDEX_FILE = path.join(tmp, 'index.json');
const idx = require('./automayt-item-index');

// #1468's real shape: Mapesil T Plus filed under a Dal-Tile 9999 code, Mapei code in the description only.
const NIGHT_SKY = { id: 'it-ns', item_number: 'PRD-031853', vendor_code: '9999579273', sku: '9999579273', description: 'MAPESIL T PLUS 10.1OZ NIGHT SKY 3BU523291', color: '3BU523291 NIGHT SKY', aliases: [], active: true };
const CLEAR = { id: 'it-cl', item_number: 'PRD-031801', vendor_code: '9999578001', sku: '9999578001', description: 'MAPESIL T PLUS 10.1OZ CLEAR 3BU002391', aliases: [], active: true };
const DRAIN = { id: 'it-dr', item_number: 'PRD-044120', vendor_code: '9999123456', description: 'KERDI-DRAIN HORIZ OUTLET ABS KDH2ABSFL', aliases: [], active: true };
const LONGER = { id: 'it-x', item_number: 'PRD-1', vendor_code: 'X', description: 'SOMETHING 3BU0023910 OTHER', aliases: [], active: true };
const DEAD = { id: 'it-dead', item_number: 'PRD-2', vendor_code: 'Y', description: 'OLD 3BU002391', aliases: [], active: false };

function writeIndex(items) {
  fs.writeFileSync(process.env.AUTOMAYT_ITEM_INDEX_FILE, JSON.stringify({ at: 'now', items }));
  idx._resetCache();
}

test('carries: whole-word code, with or without its slashes; never a bare word', () => {
  assert.equal(idx.carries('MAPESIL T PLUS CLEAR 3BU002391', '3BU002391'), true);
  assert.equal(idx.carries('SOMETHING 3BU0023910 OTHER', '3BU002391'), false);
  assert.equal(idx.carries('KERDI-DRAIN ABS KDH2ABSFL', 'KDH2/ABS/FL'), true);
  assert.equal(idx.carries('OUTLET KDH2/ABS/FL NO SEALS', 'KDH2/ABS/FL'), true);
  assert.equal(idx.carries('FLOOR PROTECTOR REUSABLE', 'REUSABLE'), false);
});

test('search: finds the hidden item, skips inactive rows and longer codes', () => {
  writeIndex([NIGHT_SKY, CLEAR, DRAIN, LONGER, DEAD]);
  const hits = idx.search(['3BU002391']);
  assert.deepEqual(hits.map((h) => h.row.id), ['it-cl']);
  assert.deepEqual(idx.search(['KDH2/ABS/FL']).map((h) => h.row.id), ['it-dr']);
  assert.deepEqual(idx.search(['NOPE123']), []);
});

test('findHidden: reads each hit live, drops one gone inactive since the scan', async () => {
  writeIndex([NIGHT_SKY, CLEAR]);
  const live = { 'it-cl': { ...CLEAR, active: false } };
  const r = await idx.findHidden(['3BU002391'], { getItem: async (id) => live[id], isInactive: (i) => i.active === false });
  assert.equal(r, null);
  const r2 = await idx.findHidden(['3BU523291'], { getItem: async () => NIGHT_SKY, isInactive: () => false });
  assert.equal(r2.code, '3BU523291');
  assert.deepEqual(r2.candidates.map((c) => c.id), ['it-ns']);
});

test('findHidden: no index file means no answer (fail open)', async () => {
  fs.rmSync(process.env.AUTOMAYT_ITEM_INDEX_FILE, { force: true });
  idx._resetCache();
  assert.equal(await idx.findHidden(['3BU002391']), null);
});

test('findHidden: a failed live read gives no answer rather than a partial one', async () => {
  writeIndex([CLEAR]);
  const r = await idx.findHidden(['3BU002391'], { getItem: async () => { throw new Error('503'); }, isInactive: () => false });
  assert.equal(r, null);
});
