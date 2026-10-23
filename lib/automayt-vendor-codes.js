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
 * Prosol code (an order for that Prosol product would find the wrong item),
 * unless it is the same product (see Shared codes). A barcode that is one of
 * our codes rather than a UPC/EAN is cleared in the same change.
 *
 * Shared codes (Mac, 2026-10-23: "can we just choose the cheaper?"). Another
 * vendor's code that Prosol also uses is the same product, and the code is
 * written, when the brand is the same at both (Bona at Treeco and at Prosol)
 * AND the code is a maker's code: letters and digits, 5 or more, or 7 or more
 * digits. CFC's own short numbers (05961, 10645) never qualify; that is where
 * the coincidences are (a Biyork floor and Prosol's moisture test kit). The
 * item's default vendor and cost then go to the cheaper unit cost: the
 * current vendor's (Salesforce PBSI__Cost__c) against Prosol's (the Burnaby
 * offer, per sq ft for flooring). A tie keeps the current vendor; so does a
 * missing cost, and costs more than 3x apart (a pack or unit mismatch, flagged
 * for review). A preference (scripts/automayt/vendor-preferences.json; Mac,
 * 2026-10-23: every Bona item stays with Treeco until Prosol's pricing is
 * confirmed better) wins over price. A preference for another vendor never
 * moves an item away from Prosol (that vendor's cost and range are unknown
 * here): it keeps the item where it is. A preference for Prosol moves only an
 * item Prosol sells under its code (in the catalogue snapshot), at Prosol's
 * cost (the current cost when Prosol's is missing), and the 3x guard then only
 * warns; "costStale" marks Prosol's cost as possibly stale. This is Automayt's
 * default vendor only: run-orders still picks the vendor on its own POs.
 */

const stripCode = (s) => String(s || '').replace(/[\/-]/g, '').trim(); // "- TAWH1224M" -> "TAWH1224M"
// Automayt treats codes that differ only by spaces or punctuation as the same code (409 duplicate).
const codeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const normLoose = (s) => normText(s).normalize('NFKD').replace(/[^a-z0-9]/g, '');
const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const isRealBarcode = (s) => /^\d{8,14}$/.test(String(s || '').trim());

const PROSOL = 'Prosol Inc.';
const isProsolVendor = (name) => normText(name) === normText(PROSOL);

/** A maker's code, not one of CFC's short numbers: letters and digits 5+, or digits 7+. */
function isMakerCode(code) {
  const k = codeKey(code);
  return (/[A-Z]/.test(k) && /\d/.test(k) && k.length >= 5) || /^\d{7,}$/.test(k);
}

/** "Bona" = "Bona", "Buzon" = "Buzon Canada", "Rubi Tools" = "Rubi"; "Fitties" != "Fittes". */
function sameBrand(a, b) {
  const [x, y] = [normLoose(a), normLoose(b)].sort((p, q) => p.length - q.length);
  if (x.length < 3) return false;
  return x === y || (x.length >= 4 && y.startsWith(x));
}

// prosolCodes values are a product name, or { name, manufacturer, cost } (cost per stocking unit).
const prosolInfo = (v) => (v == null ? null : typeof v === 'string' ? { name: v } : v);

/** The preference that applies to a brand + text (style, colour, description), if any. */
function preferenceFor(preferences, brand, text) {
  return (preferences || []).find((p) => new RegExp(p.brand, 'i').test(String(brand || '').trim()) && (!p.match || new RegExp(p.match, 'i').test(String(text || '')))) || null;
}

const RATIO_LIMIT = 3;
const cost4 = (v) => (v == null || v === '' || !(Number(v) > 0) ? null : Math.round(Number(v) * 10000) / 10000);

/**
 * Default vendor + cost for an item whose code Prosol also sells (atProsol),
 * or one a preference names. Returns { vendor, cost, switched, rule, note }:
 * vendor/cost are the item's default after the choice (the current ones
 * unless switched).
 */
function chooseVendor({ currentVendor, currentCost, prosolCost, brand, text, preferences, atProsol = true }) {
  const cur = cost4(currentCost);
  const pro = cost4(prosolCost);
  const keep = (rule, note) => ({ vendor: currentVendor || '', cost: cur, switched: false, rule, note });
  const pref = preferenceFor(preferences, brand, text);
  if (pref) {
    const why = pref.why || `preference: ${pref.vendor}`;
    if (normText(pref.vendor) === normText(currentVendor)) return keep('preference', why);
    if (!isProsolVendor(pref.vendor)) return keep('preference not applied', `${why}; current vendor ${currentVendor || 'none'} kept (${pref.vendor}'s cost for this item is unknown)`);
    if (!atProsol) return keep('no Prosol code', `${why}; no Prosol product under this item's code in the catalogue snapshot: vendor kept`);
    const notes = [why];
    if (pro == null) notes.push(`no Prosol cost in the snapshot: cost left at ${currentVendor}'s ${cur}`);
    else if (pref.costStale) notes.push(`Prosol cost ${pro} from the 2026-10-14 portal pull, may be stale`);
    if (pro != null && cur != null && Math.max(cur, pro) / Math.min(cur, pro) > RATIO_LIMIT) notes.push(`costs more than ${RATIO_LIMIT}x apart (${currentVendor} ${cur}): check pack or unit`);
    return { vendor: pref.vendor, cost: pro != null ? pro : cur, switched: true, rule: 'preference', note: notes.join('; '), ...(pro != null && pref.costStale ? { costStale: true } : {}) };
  }
  if (cur == null) return keep('no current cost', 'no cost from the current vendor to compare');
  if (pro == null) return keep('no Prosol cost', 'no Prosol cost to compare');
  if (Math.max(cur, pro) / Math.min(cur, pro) > RATIO_LIMIT) return keep('review', `costs more than ${RATIO_LIMIT}x apart (${currentVendor} ${cur}, Prosol ${pro}): check pack or unit before switching`);
  if (pro < cur) return { vendor: PROSOL, cost: pro, switched: true, rule: 'cheaper', note: `Prosol ${pro} < ${currentVendor} ${cur}` };
  return keep(pro === cur ? 'tie' : 'cheaper', pro === cur ? `same cost ${cur}` : `${currentVendor} ${cur} <= Prosol ${pro}`);
}

/**
 * Another vendor's code that Prosol also uses: { ok, reason } where ok means
 * it is the same product (same brand, maker's code).
 */
function sharedCode(code, brand, vendorName, info) {
  const what = `${vendorName} code ${code} is also a Prosol code (${info.name})`;
  let why = null;
  if (!isMakerCode(code)) why = "not a maker's code (short or CFC-style number)";
  else if (!info.manufacturer || !sameBrand(brand, info.manufacturer)) why = `different brand (${brand || 'none'} vs Prosol's ${info.manufacturer || 'none'})`;
  return why ? { ok: false, why, reason: `${what}; ${why}` } : { ok: true };
}

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
 * prosolCodes: Map of codeKey(Prosol code) → product name, or { name, manufacturer, cost }
 * (cost per stocking unit, needed for the shared-code vendor choice). Codes are compared
 * the way Automayt does, ignoring spaces and punctuation (codeKey). preferences: see
 * chooseVendor.
 * Returns { matched: [{ item, sf, rule, code, source, clearUpc, vendor? }], held: [{ item, reason, sf?, code? }],
 *           unmatched: [{ item, reason, candidates }], skipped: [{ item, reason }] }.
 */
function matchVendorCodes(items, sfItems, crosswalkRows, prosolCodes = new Map(), { preferences = [] } = {}) {
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
    const vendorName = (p.item.default_vendor && p.item.default_vendor.name) || p.sf.PBSI__Default_Vendor_Name__c;
    const info = p.source === 'salesforce' && !isProsolVendor(p.sf.PBSI__Default_Vendor_Name__c) ? prosolInfo(prosolCodes.get(codeKey(p.code))) : null;
    const shared = info && sharedCode(p.code, p.sf.Manufacturer__c || p.item.manufacturer, p.sf.PBSI__Default_Vendor_Name__c, info);
    if (bySf.get(p.sf.Id) > 1) out.held.push({ ...p, reason: `Salesforce item ${p.sf.Name} is matched by ${bySf.get(p.sf.Id)} PRD items` });
    else if (byCode.get(codeKey(p.code)) > 1) out.held.push({ ...p, reason: `code ${p.code} would go on ${byCode.get(codeKey(p.code))} items` });
    else if (owners.length) out.held.push({ ...p, reason: `code ${p.code} is already the barcode of another item (${owners.join(', ')})` });
    else if (shared && !shared.ok) out.held.push({ ...p, reason: shared.reason });
    else {
      const upc = String(p.item.upc || '').trim();
      const clearUpc = !!upc && !isRealBarcode(upc) && [p.code, p.sf.PBSI__Vendor_Item_ID__c].some((c) => codeKey(c) && codeKey(upc) === codeKey(c));
      const m = { ...p, clearUpc };
      const text = [p.item.style, p.item.color, p.sf.Original_Style_Name__c, p.sf.PBSI__description__c].join(' ');
      const currentCost = (p.item.cost && p.item.cost.vendor_cost) != null ? p.item.cost.vendor_cost : p.sf.PBSI__Cost__c;
      // Shared with Prosol: the cheaper vendor (or a preference). Otherwise only a preference moves the vendor.
      if (shared) m.vendor = { ...chooseVendor({ currentVendor: vendorName, currentCost, prosolCost: info.cost, brand: p.sf.Manufacturer__c, text, preferences }), shared: true };
      else if (preferenceFor(preferences, p.sf.Manufacturer__c, text)) m.vendor = chooseVendor({ currentVendor: vendorName, currentCost, prosolCost: null, brand: p.sf.Manufacturer__c, text, preferences, atProsol: isProsolVendor(vendorName) });
      out.matched.push(m);
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
 * decision. beta1 links come from a matchVendorCodes result. Every row carries
 * the default vendor and cost: the Salesforce ones, unless a shared Prosol code
 * or a preference moves them (chooseVendor).
 * Returns { rows: [...], held: [...] }; every Salesforce item is in one of them.
 */
function salesforceCrosswalk(sfItems, crosswalkRows, prosolCodes = new Map(), beta1 = { matched: [], held: [] }, { preferences = [] } = {}) {
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
  const asIs = (sf) => ({ vendor: sf.PBSI__Default_Vendor_Name__c || '', cost: cost4(sf.PBSI__Cost__c), switched: false, rule: '', note: '' });
  const vendorFor = (sf, info) => {
    const args = { currentVendor: sf.PBSI__Default_Vendor_Name__c, currentCost: sf.PBSI__Cost__c, brand: sf.Manufacturer__c, text: [sf.Original_Style_Name__c, sf.Color__c, sf.PBSI__description__c].join(' '), preferences };
    if (info) return { ...chooseVendor({ ...args, prosolCost: info.cost }), shared: true };
    return preferenceFor(preferences, args.brand, args.text) ? chooseVendor({ ...args, prosolCost: null, atProsol: isProsolVendor(sf.PBSI__Default_Vendor_Name__c) }) : asIs(sf);
  };
  for (const c of coded) {
    const links = prd.get(c.sf.Id) || [];
    const base = { sf: c.sf, beta1: links };
    if (!c.code && c.noCode) { rows.push({ ...base, code: '', source: 'none', clearBarcode: '', vendor: vendorFor(c.sf, null) }); continue; }
    if (!c.code) { held.push({ ...base, issue: c.reason, others: [] }); continue; }
    const key = codeKey(c.code);
    const twins = byCode.get(key).filter((sf) => sf.Id !== c.sf.Id);
    const inBarcode = (barcodeOf.get(key) || []).filter((sf) => sf.Id !== c.sf.Id);
    const cw = crosswalk.get(String(c.sf.Name || '').trim());
    if (twins.length) {
      held.push({ ...base, code: c.code, issue: cw && cw.advice !== 'match by vendor code' ? `same code on ${twins.length + 1} Salesforce items (${cw.advice})` : `same code on ${twins.length + 1} Salesforce items`, others: twins.map(label) });
    } else if (inBarcode.length) {
      held.push({ ...base, code: c.code, issue: 'code is the barcode of another Salesforce item', others: inBarcode.map(label) });
    } else {
      const info = c.source === 'salesforce' && !isProsolVendor(c.sf.PBSI__Default_Vendor_Name__c) ? prosolInfo(prosolCodes.get(key)) : null;
      const shared = info && sharedCode(c.code, c.sf.Manufacturer__c, c.sf.PBSI__Default_Vendor_Name__c, info);
      if (shared && !shared.ok) {
        held.push({ ...base, code: c.code, issue: `another vendor's code that is also a Prosol code (Prosol: ${info.name}); ${shared.why}`, others: [] });
        continue;
      }
      const upc = String(c.sf.PBSI__UPC_Code__c || '').trim();
      const clear = !!upc && !isRealBarcode(upc) && [c.code, c.sf.PBSI__Vendor_Item_ID__c].some((x) => codeKey(x) && codeKey(upc) === codeKey(x));
      rows.push({ ...base, code: c.code, source: c.source, clearBarcode: clear ? upc : '', vendor: vendorFor(c.sf, shared ? info : null) });
    }
  }
  return { rows, held };
}

/** The PATCH body for one match. vendorIds: vendor name → Automayt id, needed when the default vendor moves. */
function patchBody(m, vendorIds = new Map()) {
  const body = { vendor_code: m.code };
  if (m.clearUpc) body.upc = null;
  if (m.vendor && m.vendor.switched) {
    const id = vendorIds.get(normText(m.vendor.vendor));
    if (!id) throw new Error(`no Automayt vendor named ${m.vendor.vendor}`);
    body.vendor_id = id;
    if (m.vendor.cost != null) body.cost = m.vendor.cost.toFixed(4);
  }
  if (m.item.version) body.expected_version = m.item.version;
  return body;
}

module.exports = { matchVendorCodes, salesforceCrosswalk, patchBody, findSalesforceItem, codeFor, crosswalkBySfName, normText, normLoose, stripCode, codeKey, isRealBarcode, isMakerCode, sameBrand, chooseVendor, preferenceFor, sharedCode, PROSOL };
