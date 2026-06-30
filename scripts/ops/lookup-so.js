/**
 * One-shot Sales Order lookup. Usage: node scripts/ops/lookup-so.js SO-024448
 * Read-only. Prints SO header, lines, item/vendor/stock detail, linked PO(s).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const sf = require('../../lib/salesforce');

const soName = process.argv[2];
if (!soName) { console.error('usage: node scripts/ops/lookup-so.js SO-024448'); process.exit(1); }

(async () => {
  const conn = await sf.connect();
  conn.version = '62.0'; // FIELDS(ALL) needs v51+

  const soFull = (await sf.query(conn, `SELECT FIELDS(ALL) FROM PBSI__PBSI_Sales_Order__c WHERE Name = '${soName}' LIMIT 1`))[0];
  if (!soFull) { console.error('SO not found:', soName); process.exit(2); }
  const so = { Id: soFull.Id, Name: soFull.Name };
  const soKeep = {};
  for (const [k, v] of Object.entries(soFull)) {
    if (v === null || v === false) continue;
    if (/Name|Status|Order_Date|Customer|Total|Price|Shipping|Email|Phone|Tracking|Ship/i.test(k)) soKeep[k] = v;
  }
  console.log('=== SALES ORDER ===');
  console.log(JSON.stringify(soKeep, null, 2));

  const lines = await sf.query(conn, `
    SELECT Id, Name, PBSI__Item__c, PBSI__Item__r.Name, PBSI__Item__r.PBSI__Description__c,
           PBSI__Item__r.PBSI__Vendor_Item_ID__c, PBSI__Item__r.PBSI__Default_Vendor_Name__c,
           PBSI__Quantity__c, PBSI__Quantity_Needed__c, PBSI__Price__c, PBSI__Total_Price__c
    FROM PBSI__PBSI_Sales_Order_Line__c WHERE PBSI__Sales_Order__c = '${so.Id}'
  `);
  console.log('\n=== SO LINES ===');
  console.log(JSON.stringify(lines, null, 2));

  for (const ln of lines) {
    if (!ln.PBSI__Item__c) continue;
    const item = (await sf.query(conn, `SELECT FIELDS(ALL) FROM PBSI__PBSI_Item__c WHERE Id = '${ln.PBSI__Item__c}' LIMIT 1`))[0];
    // Print only the fields likely to matter: stock/ATP/status/vendor + identity
    const keep = {};
    for (const [k, v] of Object.entries(item || {})) {
      if (v === null || v === false || v === 0) continue;
      if (/Quantity|Available|ATP|Stock|On_Hand|Status|Active|Discontinu|Vendor|Cost|Name|Description|UPC|Default_Location/i.test(k)) keep[k] = v;
    }
    console.log(`\n=== ITEM ${item?.Name} (stock/vendor fields, non-empty) ===`);
    console.log(JSON.stringify(keep, null, 2));
  }

  const pos = await sf.query(conn, `
    SELECT Id, Name, PBSI__Status__c, PBSI__Tracking_Code__c, PBSI__Account__c, PBSI__Account__r.Name, PBSI__Order_Date__c
    FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Sales_Order__c = '${so.Id}'
  `);
  console.log('\n=== LINKED PO(s) ===');
  console.log(JSON.stringify(pos, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERR', e.errorCode || '', e.message); process.exit(1); });
