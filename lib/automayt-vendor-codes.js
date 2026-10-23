/**
 * Vendor codes for the items Automayt loaded from the Salesforce item master
 * (2026-10-20, numbered PRD-xxxx, no vendor_code). Pure: no I/O.
 *
 * Automayt kept Manufacturer__c, Original_Style_Name__c and Color__c as
 * manufacturer / style / color, the default vendor, Retail Price as
 * retail_price and PBSI__Cost__c as the vendor cost, and dropped the item
 * number, Size and the Vendor Item ID. So each PRD item is matched back to its
 * Salesforce item on those fields, exactly (case and spacing aside), and the
 * vendor code comes from that Salesforce item:
 *
 *   exact        one Salesforce item has the same vendor, maker, style and
 *                colour, and its retail price or cost agrees
 *   exact+price  several do (sizes Automayt dropped); exactly one also has
 *                the same retail price AND cost
 *   exact+upc    several do; exactly one also has the item's barcode
 *   text         Automayt's copy mangled accented or dash characters
 *                ("DÈcor", "Quartz ? Alabaster"): the same fields compared on
 *                letters and digits only, one candidate, retail price AND
 *                cost both agree
 *
 * Code: the Prosol code from the QOH crosswalk when Prosol is the Salesforce
 * item's vendor and the crosswalk has one, else the Salesforce Vendor Item ID;
 * both stripped the run-orders way
 * (no "/" or "-"). Never written: a Salesforce item two PRD items claim, a
 * code two items would share, a crosswalk "same short code, different
 * product" row, an empty, one-character or placeholder code ("n/a", the
 * vendor's own name), a code that already sits
 * in another item's barcode field, or another vendor's code that is also a
 * Prosol code (an order for that Prosol product would find the wrong item). A barcode that is one of our codes rather
 * than a UPC/EAN is cleared in the same change.
 */

const stripCode = (s) => String(s || '').replace(/[\/-]/g, '').trim(); // "- TAWH1224M" -> "TAWH1224M"
// Automayt treats codes that differ only by spaces or punctuation as the same code (409 duplicate).
const codeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const normLoose = (s) => normText(s).normalize('NFKD').replace(/[^a-z0-9]/g, '');
const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const isRealBarcode = (s) => /^\d{8,14}$/.test(String(s || '').trim());

function sfKey(norm, sf) {
  return [sf.PBSI__Default_Vendor_Name__c, sf.Manufacturer__c, sf.Original_Style_Name__c, sf.Color__c].map(norm).join('|');
}
function itemKey(norm, item) {
  return [item.default_vendor && item.default_vendor.name, item.manufacturer, item.style, item.color].map(norm).join('|');
}

function indexBy(norm, sfItems) {
  const idx = new Map();
  for (const sf of sfItems) {
    const k = sfKey(norm, sf);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(sf);
  }
  return idx;
}

const retailEq = (item, sf) => money(item.retail_price) != null && money(item.retail_price) === money(sf.PBSI__salesprice__c);
const costEq = (item, sf) => {
  const c = money(item.cost && item.cost.vendor_cost);
  return c != null && c === money(sf.PBSI__Cost__c);
};
const upcEq = (item, sf) => {
  const u = String(item.upc || '').trim();
  return !!u && [sf.PBSI__UPC_Code__c, sf.PBSI__UPC__c].some((x) => String(x || '').trim() === u);
};

/** The Salesforce item behind one PRD item: { sf, rule } or { reason, candidates }. */
function findSalesforceItem(item, exactIdx, looseIdx) {
  const cands = exactIdx.get(itemKey(normText, item)) || [];
  if (cands.length === 1) {
    if (retailEq(item, cands[0]) || costEq(item, cands[0])) return { sf: cands[0], rule: 'exact' };
    return { reason: 'one Salesforce item matches, but neither its retail price nor its cost agrees', candidates: cands };
  }
  if (cands.length > 1) {
    const priced = cands.filter((sf) => retailEq(item, sf) && costEq(item, sf));
    if (priced.length === 1) return { sf: priced[0], rule: 'exact+price' };
    const byUpc = cands.filter((sf) => upcEq(item, sf));
    if (byUpc.length === 1) return { sf: byUpc[0], rule: 'exact+upc' };
    return { reason: `${cands.length} Salesforce items share vendor, maker, style and colour (${priced.length} at this price and cost)`, candidates: cands };
  }
  const loose = (looseIdx.get(itemKey(normLoose, item)) || []).filter((sf) => retailEq(item, sf) && costEq(item, sf));
  if (loose.length === 1) return { sf: loose[0], rule: 'text' };
  if (loose.length > 1) return { reason: `${loose.length} Salesforce items match on letters and digits at this price and cost`, candidates: loose };
  return { reason: 'no Salesforce item with this vendor, maker, style and colour', candidates: [] };
}

/** crosswalk rows (qoh-crosswalk.csv + qoh-exceptions-54.csv) by Salesforce item number. */
function crosswalkBySfName(rows) {
  const out = new Map();
  for (const r of rows) {
    const name = String(r.sf_item_name || '').trim();
    if (!name) continue;
    const prev = out.get(name);
    // An exception row ("do NOT match", "two or more") outranks the plain match.
    if (!prev || (prev.advice === 'match by vendor code' && r.advice !== 'match by vendor code')) out.set(name, r);
  }
  return out;
}

// Placeholders typed into Vendor Item ID: "n/a", "EA", or the vendor's own name ("Goodfellow", "C&S").
const PLACEHOLDERS = new Set(['NA', 'NONE', 'TBD', 'EA', 'NULL']);
function isPlaceholder(code, vendorName) {
  const l = normLoose(code);
  return PLACEHOLDERS.has(String(code).toUpperCase()) || (l.length >= 2 && normLoose(vendorName).startsWith(l));
}

function codeFor(sf, crosswalk) {
  const cw = crosswalk.get(String(sf.Name || '').trim());
  if (cw && /do not match/i.test(cw.advice || '')) return { reason: `crosswalk: ${cw.advice}` };
  // The crosswalk's Prosol code only for an item Prosol supplies: on another vendor's item a
  // matching code is a coincidence as often as not (Biyork "10645" is Prosol's moisture test kit).
  if (cw && cw.automayt_vendor_code && normText(sf.PBSI__Default_Vendor_Name__c) === 'prosol inc.') return { code: stripCode(cw.automayt_vendor_code), source: 'prosol' };
  const own = stripCode(sf.PBSI__Vendor_Item_ID__c);
  if (own.length < 2 || isPlaceholder(own, sf.PBSI__Default_Vendor_Name__c)) return { reason: `Salesforce item ${sf.Name} has no usable Vendor Item ID (${JSON.stringify(sf.PBSI__Vendor_Item_ID__c)})`, noCode: true };
  return { code: own, source: 'salesforce' };
}

/**
 * items: Automayt items (GET /items rows); sfItems: Salesforce PBSI items;
 * crosswalkRows: parsed qoh-crosswalk.csv + qoh-exceptions-54.csv;
 * prosolCodes: Map of codeKey(Prosol code) → product name. Codes are compared the
 * way Automayt does, ignoring spaces and punctuation (codeKey).
 * Returns { matched: [{ item, sf, rule, code, source, clearUpc }], held: [{ item, reason, sf?, code? }],
 *           unmatched: [{ item, reason, candidates }], skipped: [{ item, reason }] }.
 */
function matchVendorCodes(items, sfItems, crosswalkRows, prosolCodes = new Map()) {
  const exactIdx = indexBy(normText, sfItems);
  const looseIdx = indexBy(normLoose, sfItems);
  const crosswalk = crosswalkBySfName(crosswalkRows);
  const out = { matched: [], held: [], unmatched: [], skipped: [] };

  const proposals = [];
  for (const item of items) {
    if (!/^PRD-/.test(item.item_number || '')) { out.skipped.push({ item, reason: 'not a PRD item' }); continue; }
    if (item.vendor_code) { out.skipped.push({ item, reason: `already has vendor code ${item.vendor_code}` }); continue; }
    const found = findSalesforceItem(item, exactIdx, looseIdx);
    if (!found.sf) { out.unmatched.push({ item, reason: found.reason, candidates: found.candidates }); continue; }
    const c = codeFor(found.sf, crosswalk);
    if (!c.code) { out.held.push({ item, sf: found.sf, rule: found.rule, reason: c.reason }); continue; }
    proposals.push({ item, sf: found.sf, rule: found.rule, code: c.code, source: c.source });
  }

  // One Salesforce item per PRD item, one item per code, and no code that is
  // already another item's barcode.
  const count = (key) => proposals.reduce((m, p) => m.set(key(p), (m.get(key(p)) || 0) + 1), new Map());
  const bySf = count((p) => p.sf.Id);
  const byCode = count((p) => codeKey(p.code));
  const barcodeOwner = new Map();
  for (const it of items) {
    const u = codeKey(it.upc);
    if (u) barcodeOwner.set(u, (barcodeOwner.get(u) || []).concat(it.id));
  }
  for (const p of proposals) {
    const owners = (barcodeOwner.get(codeKey(p.code)) || []).filter((id) => id !== p.item.id);
    if (bySf.get(p.sf.Id) > 1) out.held.push({ ...p, reason: `Salesforce item ${p.sf.Name} is matched by ${bySf.get(p.sf.Id)} PRD items` });
    else if (byCode.get(codeKey(p.code)) > 1) out.held.push({ ...p, reason: `code ${p.code} would go on ${byCode.get(codeKey(p.code))} items` });
    else if (owners.length) out.held.push({ ...p, reason: `code ${p.code} is already the barcode of another item (${owners.join(', ')})` });
    else if (p.source === 'salesforce' && normText(p.sf.PBSI__Default_Vendor_Name__c) !== 'prosol inc.' && prosolCodes.has(codeKey(p.code))) {
      out.held.push({ ...p, reason: `${p.sf.PBSI__Default_Vendor_Name__c} code ${p.code} is also a Prosol code (${prosolCodes.get(codeKey(p.code))})` });
    }
    else {
      const upc = String(p.item.upc || '').trim();
      const clearUpc = !!upc && !isRealBarcode(upc) && [p.code, p.sf.PBSI__Vendor_Item_ID__c].some((c) => codeKey(c) && codeKey(upc) === codeKey(c));
      out.matched.push({ ...p, clearUpc });
    }
  }
  return out;
}

/**
 * The same codes keyed by Salesforce item, for Automayt's migration source
 * (production loads from Salesforce, not from beta1's PRD items). Every
 * Salesforce item gets the code codeFor gives it; held instead when the code is
 * on another Salesforce item too, is another vendor's code that Prosol also
 * uses, or sits in another Salesforce item's barcode (PBSI__UPC_Code__c, the
 * field Automayt loads as the barcode). An item with no Vendor Item ID in
 * Salesforce (labour, services, installers) is a row with no code, not a
 * decision. beta1 links come from a matchVendorCodes result.
 * Returns { rows: [...], held: [...] }; every Salesforce item is in one of them.
 */
function salesforceCrosswalk(sfItems, crosswalkRows, prosolCodes = new Map(), beta1 = { matched: [], held: [] }) {
  const crosswalk = crosswalkBySfName(crosswalkRows);
  const prd = new Map(); // sf Id -> [{ itemNumber, rule }]
  for (const m of [...beta1.matched, ...beta1.held.filter((h) => h.sf)]) {
    prd.set(m.sf.Id, (prd.get(m.sf.Id) || []).concat({ itemNumber: m.item.item_number, rule: m.rule }));
  }
  const coded = sfItems.map((sf) => ({ sf, ...codeFor(sf, crosswalk) }));
  const byCode = new Map();
  for (const c of coded) if (c.code) byCode.set(codeKey(c.code), (byCode.get(codeKey(c.code)) || []).concat(c.sf));
  const barcodeOf = new Map();
  for (const sf of sfItems) {
    const u = codeKey(sf.PBSI__UPC_Code__c);
    if (u) barcodeOf.set(u, (barcodeOf.get(u) || []).concat(sf));
  }
  const label = (sf) => `${sf.Name} (${sf.PBSI__Default_Vendor_Name__c || 'no vendor'}: ${String(sf.PBSI__description__c || '').trim()})`;
  const rows = [];
  const held = [];
  for (const c of coded) {
    const links = prd.get(c.sf.Id) || [];
    const base = { sf: c.sf, beta1: links };
    if (!c.code && c.noCode) { rows.push({ ...base, code: '', source: 'none', clearBarcode: '' }); continue; }
    if (!c.code) { held.push({ ...base, issue: c.reason, others: [] }); continue; }
    const key = codeKey(c.code);
    const twins = byCode.get(key).filter((sf) => sf.Id !== c.sf.Id);
    const inBarcode = (barcodeOf.get(key) || []).filter((sf) => sf.Id !== c.sf.Id);
    const cw = crosswalk.get(String(c.sf.Name || '').trim());
    if (twins.length) {
      held.push({ ...base, code: c.code, issue: cw && cw.advice !== 'match by vendor code' ? `same code on ${twins.length + 1} Salesforce items (${cw.advice})` : `same code on ${twins.length + 1} Salesforce items`, others: twins.map(label) });
    } else if (inBarcode.length) {
      held.push({ ...base, code: c.code, issue: 'code is the barcode of another Salesforce item', others: inBarcode.map(label) });
    } else if (c.source === 'salesforce' && normText(c.sf.PBSI__Default_Vendor_Name__c) !== 'prosol inc.' && prosolCodes.has(key)) {
      held.push({ ...base, code: c.code, issue: `another vendor's code that is also a Prosol code (Prosol: ${prosolCodes.get(key)})`, others: [] });
    } else {
      const upc = String(c.sf.PBSI__UPC_Code__c || '').trim();
      const clear = !!upc && !isRealBarcode(upc) && [c.code, c.sf.PBSI__Vendor_Item_ID__c].some((x) => codeKey(x) && codeKey(upc) === codeKey(x));
      rows.push({ ...base, code: c.code, source: c.source, clearBarcode: clear ? upc : '' });
    }
  }
  return { rows, held };
}

/** The PATCH body for one match. */
function patchBody(m) {
  const body = { vendor_code: m.code };
  if (m.clearUpc) body.upc = null;
  if (m.item.version) body.expected_version = m.item.version;
  return body;
}

module.exports = { matchVendorCodes, salesforceCrosswalk, patchBody, findSalesforceItem, codeFor, crosswalkBySfName, normText, normLoose, stripCode, codeKey, isRealBarcode };
