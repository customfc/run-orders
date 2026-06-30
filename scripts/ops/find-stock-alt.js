/**
 * Read-only: find in-stock alternatives in SF PBSI.
 * Usage: node scripts/ops/find-stock-alt.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const sf = require('../../lib/salesforce');

(async () => {
  const conn = await sf.connect();
  conn.version = '62.0';

  // In-stock vinyl tile (12x24-ish), positive ATP, sorted by stock depth
  const vinyl = await sf.query(conn, `
    SELECT Name, PBSI__description__c, PBSI__Available_to_Promise__c, Box_Quantity__c,
           Original_Style_Name__c, PBSI__Default_Vendor_Name__c, PBSI__Cost__c, AscentBTO__Stock_Status__c
    FROM PBSI__PBSI_Item__c
    WHERE Item_Group_Name__c = 'Vinyl Tile'
      AND PBSI__Available_to_Promise__c > 0
    ORDER BY PBSI__Available_to_Promise__c DESC
    LIMIT 60
  `);
  console.log('=== IN-STOCK VINYL TILE (ATP>0) ===  count=', vinyl.length);
  for (const i of vinyl) {
    console.log(`${i.Name}  ATP=${i.PBSI__Available_to_Promise__c}  box=${i.Box_Quantity__c}  $${i.PBSI__Cost__c}  [${i.PBSI__Default_Vendor_Name__c}]  ${i.PBSI__description__c}`);
  }

  // Anything Bourbon-colored still in stock (cross-group: matches the customer's chosen tone)
  const bourbon = await sf.query(conn, `
    SELECT Name, PBSI__description__c, PBSI__Available_to_Promise__c, Item_Group_Name__c,
           PBSI__Default_Vendor_Name__c, AscentBTO__Stock_Status__c
    FROM PBSI__PBSI_Item__c
    WHERE PBSI__description__c LIKE '%Bourbon%'
    ORDER BY PBSI__Available_to_Promise__c DESC
    LIMIT 40
  `);
  console.log('\n=== ANY "BOURBON" ITEMS (stock + status) ===  count=', bourbon.length);
  for (const i of bourbon) {
    console.log(`${i.Name}  ATP=${i.PBSI__Available_to_Promise__c}  [${i.Item_Group_Name__c}]  ${i.AscentBTO__Stock_Status__c}  ${i.PBSI__description__c}`);
  }

  // Other in-stock Biyork Hydrogen colorways (same exact product line, different color)
  const hydrogen = await sf.query(conn, `
    SELECT Name, PBSI__description__c, PBSI__Available_to_Promise__c, Original_Style_Name__c,
           AscentBTO__Stock_Status__c
    FROM PBSI__PBSI_Item__c
    WHERE PBSI__description__c LIKE '%Hydrogen%'
    ORDER BY PBSI__Available_to_Promise__c DESC
    LIMIT 40
  `);
  console.log('\n=== BIYORK HYDROGEN LINE (all colorways, stock + status) ===  count=', hydrogen.length);
  for (const i of hydrogen) {
    console.log(`${i.Name}  ATP=${i.PBSI__Available_to_Promise__c}  ${i.AscentBTO__Stock_Status__c}  ${i.PBSI__description__c}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.errorCode || '', e.message); process.exit(1); });
