/**
 * Salesforce record for an Amazon return the autopilot refunded
 * (lib/amazon-returns-autopilot.js, docs/RETURNS.md).
 *
 * Mirrors what Lynnae builds by hand today, so the books keep their shape:
 *   1. Customer RMA: Case, Return Type "From Customer", account Amazon.ca, the
 *      order's period SO, From Location Amazon Fulfillment, one RMA line per
 *      returned item against its SO line (and packed line when there is one).
 *   2. Vendor RMA, only when the item is on its way back to a Prosol branch:
 *      Case, Return Type "To Vendor", account Prosol, the original PO, linked
 *      to the customer RMA through mm_Customer_RMA__c, RMA lines against the PO
 *      lines. This is what Prosol's credit gets matched to.
 *
 * Both are created with status New and nothing received. RMAs have no
 * invocable receive action (POs do: PBSI__ReceivedPOLinesCreateAction), and a
 * receipt written straight onto the line skips the Movement Journal the same
 * way the 2026-05 PO receipts did, so the Receive click stays in Salesforce.
 *
 * Writes only when RETURNS_SF_LIVE=1; otherwise returns the plan.
 */

const sf = require('./salesforce');
const { readSkuMap } = require('./sku-map-file');

const AMAZON_ACCOUNT_ID = '0014x00001P1SiHAAV';
const PROSOL_VENDOR_ID = '0014x00001P1ScCAAV';
const AMAZON_FULFILLMENT_LOCATION_ID = 'a0v4x000005kF5ZAAU';
const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;

const norm = (s) => String(s || '').replace(/[\s/_.-]/g, '').toUpperCase();
const money = (c) => `$${((Number(c) || 0) / 100).toFixed(2)}`;

function rmaReason(code) {
  const c = String(code || '').toUpperCase();
  if (/DAMAGED/.test(c)) return 'Damaged';
  if (/DEFECTIVE|SWITCHEROO|QUALITY|MISSING_PARTS|NOT_AS_DESCRIBED|BAD-DESC/.test(c)) return 'Defective';
  if (/UNWANTED|NOT_COMPATIBLE|ORDERED_WRONG|BETTER_PRICE|NO_REASON|MISSED_ESTIMATED|ARRIVED_LATE/.test(c)) return 'Not Needed';
  return 'Other';
}

/** Vendor item codes the sku-map says this ASIN/SKU ships as (bundles: every component). */
function vendorCodes(item, map = readSkuMap().mappings || {}) {
  const entry = map[item.asin] || map[item.sku];
  if (!entry || typeof entry !== 'object') return [];
  const parts = entry.bundle && Array.isArray(entry.components) ? entry.components : [entry];
  return parts.flatMap((p) => [p.prosol_sku, p.api_sku]).filter(Boolean).map(norm);
}

/** The PO(s), PO lines and SO lines run-orders created for this Amazon order. */
async function findOrderRecords(conn, order) {
  if (!ORDER_ID.test(order)) throw new Error(`bad Amazon order id ${order}`);
  const pos = await sf.query(conn, `
    SELECT Id, Name, PBSI__Account__c, PBSI__Status__c
    FROM PBSI__PBSI_Purchase_Order__c
    WHERE PBSI__Shipping_Instructions__c LIKE 'Amazon Order ${order}%'
    ORDER BY CreatedDate`);
  const live = pos.filter((p) => p.PBSI__Status__c !== 'Cancelled');
  if (!live.length) return { pos: [], lines: [] };
  const ids = live.map((p) => `'${p.Id}'`).join(',');
  const lines = await sf.query(conn, `
    SELECT Id, Name, PBSI__Purchase_Order__c, PBSI__Item__c, PBSI__Item__r.Name, PBSI__Item__r.PBSI__Vendor_Item_ID__c,
           PBSI__Item__r.PBSI__description__c, PBSI__Quantity_Ordered__c, PBSI__Price__c,
           PBSI__Sales_Order__c, PBSI__Original_SO_Line__c
    FROM PBSI__PBSI_Purchase_Order_Line__c
    WHERE PBSI__Purchase_Order__c IN (${ids})`);
  return { pos: live, lines };
}

/**
 * Which PO lines each returned Amazon item maps to, and the quantity in
 * Salesforce units. Area items (membrane rolls stocked per sqft) carry
 * coverage x rolls on the line, so scale by the PO line's own ratio.
 */
function matchLines(ret, entry, lines, map) {
  const out = [];
  const unmatched = [];
  for (const item of ret.items) {
    const codes = vendorCodes(item, map);
    let hits = lines.filter((l) => codes.includes(norm(l.PBSI__Item__r?.PBSI__Vendor_Item_ID__c)) || codes.includes(norm(l.PBSI__Item__r?.Name)));
    if (!hits.length && ret.items.length === 1) hits = lines; // single-item order: every line belongs to it
    if (!hits.length) { unmatched.push(item.sku || item.asin); continue; }
    const ordered = Number(entry.ordered?.[item.itemId]) || item.qty;
    for (const l of hits) {
      const perUnit = Number(l.PBSI__Quantity_Ordered__c || 0) / ordered;
      out.push({ item, line: l, qty: Math.round(perUnit * item.qty * 1000) / 1000 });
    }
  }
  return { matched: out, unmatched };
}

function describe(ret, entry) {
  const how = entry.label
    ? `Prepaid return label ${entry.label.tracking} (Purolator) to ${entry.label.branch}.`
    : 'Refunded without return: nothing is coming back.';
  return [
    `Amazon order ${ret.order}, refunded ${money(entry.refund?.cents ?? entry.totalCents)} by the returns autopilot${entry.refund?.feedId ? ` (feed ${entry.refund.feedId})` : ''}.`,
    how,
    ...ret.items.map((i) => `${i.qty}x ${i.sku} ${String(i.itemName || '').slice(0, 80)}: ${i.reason}${i.rmaId ? `, Amazon RMA ${i.rmaId}` : ''}`),
  ].join('\n');
}

async function packedLine(conn, soLineId) {
  try {
    const r = await sf.query(conn, `SELECT Id FROM PBSI__Shipped_Sales_Order_Line__c WHERE PBSI__Sales_Order_Line__c = '${soLineId}' ORDER BY CreatedDate DESC LIMIT 1`);
    return r[0]?.Id || null;
  } catch { return null; }
}

/** Plan (and with live, create) the customer RMA and, for label returns, the vendor RMA. */
async function logReturn(ret, entry, { live = process.env.RETURNS_SF_LIVE === '1', conn } = {}) {
  conn = conn || await sf.connect();
  // Never twice: an earlier run (or Lynnae) may already have the case.
  const existing = await sf.query(conn, `SELECT Id, CaseNumber FROM Case WHERE AccountId = '${AMAZON_ACCOUNT_ID}' AND Subject = 'Amazon return ${ret.order}' LIMIT 1`);
  if (existing.length) return { created: [`Case ${existing[0].CaseNumber} (already there)`], customerCaseId: existing[0].Id };

  const { pos, lines } = await findOrderRecords(conn, ret.order);
  // Shipped outside the Prosol PO flow (Sechelt, non-Prosol vendor): the sale never
  // reached Salesforce, so there is nothing to reverse.
  if (!lines.length) return { none: `no Salesforce PO for ${ret.order} (shipped outside the Prosol PO flow), so no RMA` };
  const { matched, unmatched } = matchLines(ret, entry, lines);
  if (unmatched.length) throw new Error(`could not match ${unmatched.join(', ')} to a PO line on ${pos.map((p) => p.Name).join(', ')}`);
  const soId = matched[0].line.PBSI__Sales_Order__c;
  const description = describe(ret, entry);

  const customerCase = {
    AccountId: AMAZON_ACCOUNT_ID,
    Subject: `Amazon return ${ret.order}`,
    Description: description,
    Status: 'New',
    Origin: 'Web',
    PBSI__Return_Type__c: 'From Customer',
    PBSI__Sales_Order__c: soId,
    PBSI__From_Location__c: AMAZON_FULFILLMENT_LOCATION_ID,
    Allow_Create_Credit_Billing__c: true,
  };
  const customerLines = matched.map(({ item, line, qty }) => ({
    PBSI__Item__c: line.PBSI__Item__c,
    PBSI__Quantity__c: qty,
    PBSI__Sales_Order_Line__c: line.PBSI__Original_SO_Line__c,
    PBSI__Location__c: AMAZON_FULFILLMENT_LOCATION_ID,
    PBSI__Type__c: 'Return',
    PBSI__Reason_RMA_Line__c: rmaReason(item.reason),
    PBSI__Cost__c: line.PBSI__Price__c,
    PBSI__Comment__c: `Amazon ${ret.order} ${item.reason}${item.rmaId ? ` RMA ${item.rmaId}` : ''}`.slice(0, 250),
  }));
  // Vendor RMA only for goods physically going back to a Prosol branch.
  const toProsol = !!entry.label && /^Prosol /.test(entry.label.branch || '') && pos.some((p) => p.PBSI__Account__c === PROSOL_VENDOR_ID);
  const vendorCase = toProsol ? {
    AccountId: PROSOL_VENDOR_ID,
    Subject: `Amazon return ${ret.order} to ${entry.label.branch}`,
    Description: description,
    Status: 'New',
    Origin: 'Web',
    PBSI__Return_Type__c: 'To Vendor',
    PBSI__Purchase_Order__c: matched[0].line.PBSI__Purchase_Order__c,
    PBSI__Sales_Order__c: soId,
  } : null;
  const vendorLines = toProsol ? matched.map(({ item, line, qty }) => ({
    PBSI__Item__c: line.PBSI__Item__c,
    PBSI__Quantity__c: qty,
    PBSI__Purchase_Order_Line__c: line.Id,
    PBSI__Sales_Order_Line__c: line.PBSI__Original_SO_Line__c,
    PBSI__Type__c: 'Return',
    PBSI__Reason_RMA_Line__c: rmaReason(item.reason),
    PBSI__Cost__c: line.PBSI__Price__c,
    PBSI__Comment__c: `Return tracking ${entry.label.tracking}`.slice(0, 250),
  })) : [];

  const plan = { customerCase, customerLines, vendorCase, vendorLines, pos: pos.map((p) => p.Name) };
  if (!live) return { planned: plan };

  for (const l of customerLines) { const p = await packedLine(conn, l.PBSI__Sales_Order_Line__c); if (p) l.PBSI__Packed_Sales_Order_Line__c = p; }
  const created = [];
  const caseId = await sf.create(conn, 'Case', customerCase);
  const caseNo = (await sf.query(conn, `SELECT CaseNumber FROM Case WHERE Id = '${caseId}'`))[0]?.CaseNumber || caseId;
  created.push(`Case ${caseNo} (from customer)`);
  for (const l of customerLines) await sf.create(conn, 'PBSI__RMA_Lines__c', { ...l, PBSI__RMA__c: caseId });
  let vendorCaseId = null;
  if (vendorCase) {
    vendorCaseId = await sf.create(conn, 'Case', { ...vendorCase, mm_Customer_RMA__c: caseId });
    const vNo = (await sf.query(conn, `SELECT CaseNumber FROM Case WHERE Id = '${vendorCaseId}'`))[0]?.CaseNumber || vendorCaseId;
    created.push(`Case ${vNo} (to Prosol)`);
    for (const l of vendorLines) await sf.create(conn, 'PBSI__RMA_Lines__c', { ...l, PBSI__RMA__c: vendorCaseId });
  }
  return { created, customerCaseId: caseId, vendorCaseId };
}

module.exports = { logReturn, findOrderRecords, matchLines, rmaReason, vendorCodes, AMAZON_ACCOUNT_ID, PROSOL_VENDOR_ID };
