#!/usr/bin/env node
/**
 * Diagnose / fix a PBSI PO whose lines 2+ are stuck "unable to receive" because
 * receiving line 1 flipped the parent PO to status 'Complete', which locks the
 * remaining lines out of the Receive Form (PBSI__ReceivedPOLinesCreateAction
 * throws "Purchase order line could not be retrieved..."). See
 * reference_pbsi_receive_blocked_complete_po. The pipeline now self-heals
 * (commit ab2a261); this is for PRE-FIX POs already stuck.
 *
 * Usage:
 *   node scripts/ops/fix-stuck-po-receive.js PO-15376          # diagnose only
 *   node scripts/ops/fix-stuck-po-receive.js PO-15376 --fix    # reopen + receive stuck lines
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const sf = require('../../lib/salesforce');

const PO_NAME = process.argv[2];
const DO_FIX = process.argv.includes('--fix');
if (!PO_NAME) { console.error('Usage: fix-stuck-po-receive.js <PO-NAME> [--fix]'); process.exit(1); }

async function invokeReceivedPOLineAction(conn, receivedPOLine) {
  const v = conn.version || '42.0';
  const url = `/services/data/v${v}/actions/custom/apex/PBSI__ReceivedPOLinesCreateAction`;
  const res = await conn.requestPost(url, { inputs: [{ receivedRequests: [{ receivedPOLine }] }] });
  const result = Array.isArray(res) ? res[0] : res;
  if (!result || result.isSuccess === false) {
    const errMsg = (result && result.errors && result.errors[0] && result.errors[0].message)
      || (result && result.outputValues && result.outputValues.message) || 'unknown action failure';
    throw new Error(`ReceivedPOLinesCreateAction failed: ${errMsg}`);
  }
  return { receivedPOLineId: result.outputValues && result.outputValues.receivedPOLineId, message: result.outputValues && result.outputValues.message };
}

(async () => {
  const conn = await sf.connect();

  const pos = await sf.query(conn, `
    SELECT Id, Name, PBSI__Status__c, PBSI__Account__r.Name, PBSI__Order_Date__c,
           mm_Received_Location_Name__c, CFC_Stage__c, PBSI__Movement_Journal__c
    FROM PBSI__PBSI_Purchase_Order__c WHERE Name = '${PO_NAME}'`);
  if (!pos.length) { console.error(`No PO named ${PO_NAME}`); process.exit(1); }
  const po = pos[0];
  console.log(`=== ${po.Name} === status=${po.PBSI__Status__c} stage=${po.CFC_Stage__c} vendor=${po.PBSI__Account__r && po.PBSI__Account__r.Name} recvLoc=${po.mm_Received_Location_Name__c} MJ=${po.PBSI__Movement_Journal__c}`);

  const lines = await sf.query(conn, `
    SELECT Id, Name, PBSI__Item__c, PBSI__Item__r.Name, PBSI__Quantity_Ordered__c,
           PBSI__Quantity_Received__c, PBSI__Price__c
    FROM PBSI__PBSI_Purchase_Order_Line__c
    WHERE PBSI__Purchase_Order__c = '${po.Id}' ORDER BY Name`);
  console.log(`\nLines (${lines.length}):`);
  for (const l of lines) console.log(`  ${l.Name} | item ${l.PBSI__Item__r && l.PBSI__Item__r.Name} | ord=${l.PBSI__Quantity_Ordered__c} recv=${l.PBSI__Quantity_Received__c} | price=${l.PBSI__Price__c}`);

  // Determine the receiving location from the already-posted receipt(s).
  const recvs = await sf.query(conn, `
    SELECT PBSI__Location__c, PBSI__Location__r.Name, PBSI__Receiving_Date__c
    FROM PBSI__Received_Purchase_Order_Line__c
    WHERE PBSI__Purchase_Order__c = '${po.Id}' ORDER BY Name`);
  const locId = recvs[0] && recvs[0].PBSI__Location__c;
  const locName = recvs[0] && recvs[0].PBSI__Location__r && recvs[0].PBSI__Location__r.Name;
  const recvDate = recvs[0] && recvs[0].PBSI__Receiving_Date__c;
  console.log(`\nExisting receipts: ${recvs.length} | location=${locName} (${locId}) | date=${recvDate}`);

  const stuck = lines.filter((l) => (l.PBSI__Quantity_Received__c || 0) < (l.PBSI__Quantity_Ordered__c || 0));
  console.log(`\nStuck (unreceived) lines: ${stuck.map((l) => l.Name).join(', ') || 'NONE'}`);
  if (!stuck.length) { console.log('Nothing to fix.'); process.exit(0); }
  if (!locId) { console.error('Cannot determine receiving location (no prior receipt). Aborting — receive line 1 manually first.'); process.exit(1); }

  if (!DO_FIX) { console.log('\n(diagnose only — re-run with --fix to reopen + receive)'); process.exit(0); }

  console.log(`\nSetting ${po.Name} status -> Open ...`);
  await conn.sobject('PBSI__PBSI_Purchase_Order__c').update({ Id: po.Id, PBSI__Status__c: 'Open' });
  for (const l of stuck) {
    const qty = (l.PBSI__Quantity_Ordered__c || 0) - (l.PBSI__Quantity_Received__c || 0);
    console.log(`Receiving ${l.Name} (${l.PBSI__Item__r && l.PBSI__Item__r.Name}) qty=${qty} into ${locName} ...`);
    const r = await invokeReceivedPOLineAction(conn, {
      PBSI__Purchase_Order__c: po.Id,
      PBSI__Purchase_Order_Line__c: l.Id,
      PBSI__Item__c: l.PBSI__Item__c,
      PBSI__Location__c: locId,
      PBSI__Quantity_Received__c: qty,
      PBSI__Receiving_Date__c: recvDate || new Date().toISOString().slice(0, 10),
      PBSI__Price__c: l.PBSI__Price__c,
      PBSI__Type__c: 'receive',
    });
    console.log(`  -> ${r.message || ''} (${r.receivedPOLineId || 'no id'})`);
  }

  const after = (await sf.query(conn, `SELECT Name, PBSI__Status__c, CFC_Stage__c, PBSI__Movement_Journal__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '${po.Id}'`))[0];
  const afterLines = await sf.query(conn, `SELECT Name, PBSI__Item__r.Name, PBSI__Quantity_Ordered__c, PBSI__Quantity_Received__c FROM PBSI__PBSI_Purchase_Order_Line__c WHERE PBSI__Purchase_Order__c = '${po.Id}' ORDER BY Name`);
  console.log(`\n=== POST-FIX === ${after.Name} status=${after.PBSI__Status__c} stage=${after.CFC_Stage__c} MJ=${after.PBSI__Movement_Journal__c}`);
  for (const l of afterLines) console.log(`  ${l.Name} | ${l.PBSI__Item__r && l.PBSI__Item__r.Name} | ord=${l.PBSI__Quantity_Ordered__c} recv=${l.PBSI__Quantity_Received__c}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
