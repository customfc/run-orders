#!/usr/bin/env node
/**
 * Inspect a PBSI purchase order: header, lines, and what's been received.
 *
 * Field names on the PBSI line object vary by org config, so this describes
 * the object and picks the fields that actually exist rather than hard-coding
 * a guess that throws INVALID_FIELD.
 *
 * Usage:
 *   node scripts/ops/po-lookup.js PO-15904
 *   node scripts/ops/po-lookup.js PO-15904 PO-15902
 *   node scripts/ops/po-lookup.js --open-prosol      # all open Prosol POs
 */

require('dotenv').config();
const sf = require('../../lib/salesforce');

const PO_OBJ = 'PBSI__PBSI_Purchase_Order__c';
const LINE_OBJ = 'PBSI__PBSI_Purchase_Order_Line__c';

/** Return only the requested field paths that exist on the object. */
async function usableFields(conn, object, wanted) {
  const meta = await conn.sobject(object).describe();
  const have = new Set(meta.fields.map((f) => f.name));
  const rels = new Map(meta.fields.filter((f) => f.relationshipName).map((f) => [f.relationshipName, true]));
  return wanted.filter((path) => {
    if (!path.includes('.')) return have.has(path);
    const [rel] = path.split('.');
    return rels.has(rel);
  });
}

async function describeOnly(conn, object) {
  const meta = await conn.sobject(object).describe();
  console.log(`\n── ${object} fields ──`);
  console.log(meta.fields.map((f) => f.name).join(', '));
}

(async () => {
  const args = process.argv.slice(2);
  const conn = await sf.connect();

  if (args.includes('--describe')) {
    await describeOnly(conn, PO_OBJ);
    await describeOnly(conn, LINE_OBJ);
    return;
  }

  // --raw: dump every POPULATED field on a PO's lines. PBSI orgs differ on
  // which field carries the ordered quantity, and a header total with qty 0 on
  // every line means we picked the wrong one.
  //
  // SOQL FIELDS(ALL) needs a newer API version than this connection negotiates,
  // so enumerate queryable fields from describe and select them explicitly.
  if (args.includes('--raw')) {
    const selectableFields = async (object) => {
      const meta = await conn.sobject(object).describe();
      return meta.fields
        .filter((f) => !['address', 'location', 'base64'].includes(f.type) && f.name !== 'attributes')
        .map((f) => f.name);
    };
    const dump = (r, indent) => {
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === '' || k === 'attributes') continue;
        console.log(`${indent}${k} = ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    };

    const hFields = await selectableFields(PO_OBJ);
    const lFields = await selectableFields(LINE_OBJ);

    for (const name of args.filter((a) => !a.startsWith('--'))) {
      const hdr = await sf.query(conn, `SELECT Id, Name FROM ${PO_OBJ} WHERE Name = '${name.replace(/'/g, "\\'")}'`);
      if (!hdr.length) { console.log(`${name}: NOT FOUND`); continue; }

      console.log(`\n═══ ${name} — header, populated fields ═══`);
      const h = await sf.query(conn, `SELECT ${hFields.join(', ')} FROM ${PO_OBJ} WHERE Id = '${hdr[0].Id}'`);
      dump(h[0] || {}, '  ');

      const rows = await sf.query(conn, `SELECT ${lFields.join(', ')} FROM ${LINE_OBJ} WHERE PBSI__Purchase_Order__c = '${hdr[0].Id}'`);
      console.log(`\n═══ ${name} — ${rows.length} lines, populated fields ═══`);
      rows.forEach((r, i) => {
        console.log(`  ── line ${i + 1} ──`);
        dump(r, '    ');
      });
    }
    return;
  }

  const headerWanted = [
    'Id', 'Name', 'PBSI__Status__c', 'PBSI__Order_Total__c', 'PBSI__Order_Date__c',
    'PBSI__Expected_Date__c', 'PBSI__Account__r.Name', 'PBSI__Ship_To_Location__r.Name',
    'PBSI__Sales_Order__r.Name', 'PBSI__Notes__c', 'PBSI__Reference__c', 'CreatedDate', 'LastModifiedDate',
  ];
  const lineWanted = [
    'Id', 'Name', 'PBSI__Item__r.Name', 'PBSI__Item__r.PBSI__Vendor_Item_ID__c',
    'PBSI__Item__r.PBSI__Description__c',
    'PBSI__Quantity__c', 'PBSI__Price__c', 'PBSI__Line_Total__c',
    'PBSI__Quantity_Received__c', 'PBSI__Received_Quantity__c', 'PBSI__Qty_Received__c',
    'PBSI__Quantity_Outstanding__c', 'PBSI__Purchase_Order__c',
  ];

  const hf = await usableFields(conn, PO_OBJ, headerWanted);
  const lf = await usableFields(conn, LINE_OBJ, lineWanted);

  let names = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--open-prosol')) {
    const open = await sf.query(conn, `
      SELECT ${hf.join(', ')} FROM ${PO_OBJ}
      WHERE PBSI__Account__r.Name LIKE '%rosol%'
      ORDER BY CreatedDate DESC LIMIT 25`);
    console.log(`\nRecent Prosol POs (${open.length}):`);
    for (const p of open) {
      console.log(`  ${p.Name}  ${String(p.PBSI__Status__c || '').padEnd(12)} $${p.PBSI__Order_Total__c ?? '?'}  ${String(p.CreatedDate || '').slice(0, 10)}`);
    }
    if (!names.length) return;
  }

  for (const name of names) {
    const hdr = await sf.query(conn, `SELECT ${hf.join(', ')} FROM ${PO_OBJ} WHERE Name = '${name.replace(/'/g, "\\'")}'`);
    if (!hdr.length) { console.log(`\n${name}: NOT FOUND`); continue; }
    for (const p of hdr) {
      console.log(`\n═══ ${p.Name} ═══`);
      console.log(`  status      : ${p.PBSI__Status__c ?? '—'}`);
      console.log(`  vendor      : ${p.PBSI__Account__r?.Name ?? '—'}`);
      console.log(`  ship to     : ${p.PBSI__Ship_To_Location__r?.Name ?? '—'}`);
      console.log(`  total       : $${p.PBSI__Order_Total__c ?? '—'}`);
      console.log(`  ordered     : ${p.PBSI__Order_Date__c ?? '—'}   expected: ${p.PBSI__Expected_Date__c ?? '—'}`);
      console.log(`  created     : ${String(p.CreatedDate || '').slice(0, 19)}   modified: ${String(p.LastModifiedDate || '').slice(0, 19)}`);
      if (p.PBSI__Sales_Order__r?.Name) console.log(`  sales order : ${p.PBSI__Sales_Order__r.Name}`);
      if (p.PBSI__Notes__c) console.log(`  notes       : ${String(p.PBSI__Notes__c).slice(0, 200)}`);

      const lines = await sf.query(conn, `SELECT ${lf.join(', ')} FROM ${LINE_OBJ} WHERE PBSI__Purchase_Order__c = '${p.Id}'`);
      console.log(`  ── ${lines.length} lines ──`);
      console.log('  ' + 'item'.padEnd(14) + 'vendor sku'.padEnd(20) + 'qty'.padStart(6) + 'recv'.padStart(6) + 'price'.padStart(10) + 'ext'.padStart(11) + '  description');
      let tot = 0;
      for (const l of lines) {
        const qty = Number(l.PBSI__Quantity__c || 0);
        const price = Number(l.PBSI__Price__c || 0);
        const recv = l.PBSI__Quantity_Received__c ?? l.PBSI__Received_Quantity__c ?? l.PBSI__Qty_Received__c ?? '—';
        const ext = l.PBSI__Line_Total__c != null ? Number(l.PBSI__Line_Total__c) : qty * price;
        tot += ext;
        console.log(
          '  ' + String(l.PBSI__Item__r?.Name ?? '?').padEnd(14) +
          String(l.PBSI__Item__r?.PBSI__Vendor_Item_ID__c ?? '—').slice(0, 19).padEnd(20) +
          String(qty).padStart(6) + String(recv).padStart(6) +
          ('$' + price.toFixed(2)).padStart(10) + ('$' + ext.toFixed(2)).padStart(11) +
          '  ' + String(l.PBSI__Item__r?.PBSI__Description__c ?? '').slice(0, 42)
        );
      }
      console.log(`  ${'—'.repeat(60)}\n  line total: $${tot.toFixed(2)}`);
    }
  }
})().catch((e) => { console.error('ERR', e.errorCode || '', e.message); process.exit(1); });
