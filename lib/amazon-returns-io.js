/**
 * Production IO for lib/amazon-returns-autopilot.js (docs/RETURNS.md):
 * Amazon returns report, the issue-refund script, ShipStation return labels,
 * buyer / Prosol / Mac emails, Salesforce RMAs. The policy lives in the
 * autopilot; nothing here decides anything.
 */

const https = require('https');
const path = require('path');
const ss = require('./shipstation-v2');
const { readSkuMap } = require('./sku-map-file');

const ROOT = path.join(__dirname, '..');
const LOC = require(path.join(ROOT, 'scripts', 'shipstation', 'prosol-location-map.json'));
const MARKETPLACE = () => (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '').trim();
const SELLER = () => (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '').trim();
const PUBLIC_BASE = process.env.RUN_ORDERS_PUBLIC_URL || 'http://freds-mac-mini.taila452b5.ts.net:3456';
const MAC = () => process.env.MAC_CC_EMAIL || 'mac@customfc.ca';
const KAITLYN = () => process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca';
const STORE_NAME = 'CustomFlooring'; // Amazon.ca storeName (sellers/v1/marketplaceParticipations)
const SIGN = process.env.SIGN_NAME || 'Mac';

const money = (c) => `$${((Number(c) || 0) / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res) => { try { return typeof res?.body === 'string' ? JSON.parse(res.body) : res; } catch { return null; } };

const byWarehouse = {};
for (const [key, b] of Object.entries(LOC)) if (b.shipstation_warehouse_id) byWarehouse[b.shipstation_warehouse_id] = { key, ...b };
const isProsol = (b) => /^\d+$/.test(String(b?.key || ''));
const branchName = (b) => (isProsol(b) ? `Prosol ${b.city}` : b.key === 'cfc_sechelt' ? 'CustomFlooring Sechelt' : `${b.key} ${b.city}`);

// ── Amazon ───────────────────────────────────────────────────────────────────

async function fetchReturns({ windowDays = 45 } = {}) {
  const { fetchReport } = require('./sp-api-reports');
  const now = new Date();
  try {
    const { rows } = await fetchReport({
      reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE',
      marketplaceIds: [MARKETPLACE()],
      dataStartTime: new Date(now - windowDays * 864e5).toISOString(),
      dataEndTime: now.toISOString(),
    });
    if (Array.isArray(rows)) return rows;
    throw new Error('returns report came back without rows');
  } catch (err) {
    // The 03:00 ETL keeps the same report in analytics; a stale copy beats a
    // skipped run, and the autopilot's own state stops double actions.
    const { open } = require('./analytics-db');
    const db = open();
    const rows = db.prepare("SELECT raw FROM amazon_returns WHERE channel = 'mfn' AND return_date >= ?").all(new Date(now - windowDays * 864e5).toISOString());
    console.warn(`[returns-autopilot] live returns report failed (${err.message}); using ${rows.length} rows from analytics`);
    return rows.map((r) => JSON.parse(r.raw));
  }
}

function refundDeps() {
  const { createAttemptStore } = require('./amazon-refund');
  return {
    sp: require('./sp-api'),
    audit: require('./audit'),
    store: createAttemptStore(path.join(ROOT, 'data')),
    seller: SELLER(),
    marketplace: MARKETPLACE(),
    log: () => {},
  };
}

function refundArgs(order, items, full) {
  return [`--order=${order}`, '--reason=CustomerReturn', ...(full ? ['--full'] : items.map((i) => `--item=${i.id}:${i.quantity}`))];
}

/** issue-refund preview: exact total from Amazon's order data, nothing submitted. */
async function previewRefund({ order, items }) {
  const { run } = require('../scripts/ops/issue-refund');
  // A processed attempt is a refund Amazon confirmed (e.g. 702-2700126-3225056 on 09-28); its lock file is
  // what makes issue-refund refuse, so say "already refunded", not "unreconciled".
  try {
    const attempt = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'data', 'refund-attempts', `${order}.json`), 'utf8'));
    if (attempt.status === 'processed') throw Object.assign(new Error(`Refund already submitted (processed ${attempt.at?.slice(0, 10)}, feed ${attempt.feedId})`), { settled: true });
  } catch (err) { if (err.settled) throw err; }
  let plan;
  try {
    plan = await run(refundArgs(order, items, false), refundDeps());
  } catch (err) {
    if (!/use explicit --full/.test(err.message)) throw err;
    plan = await run(refundArgs(order, items, true), refundDeps());
  }
  return { totalCents: plan.totalCents, full: plan.full, ordered: Object.fromEntries(plan.items.map((i) => [i.id, i.quantityOrdered])) };
}

async function commitRefund({ order, items, full, expectedCents, evidence }) {
  const { run } = require('../scripts/ops/issue-refund');
  const args = [...refundArgs(order, items || [], full), '--commit', `--expected-total=${(expectedCents / 100).toFixed(2)}`, `--evidence=${evidence.replace(/\s+/g, ' ')}`];
  const r = await run(args, refundDeps());
  return { feedId: r.feedId };
}

// ── ShipStation ──────────────────────────────────────────────────────────────

async function shipstationOrder(order) {
  const so = await ss.findOrderByAmazonOrderId(order);
  if (!so) throw new Error(`order ${order} not in ShipStation`);
  return so;
}

/** The warehouse that shipped the order: the branch the return goes back to. */
async function originBranch(order, so) {
  const res = json(await ss.v1Request('GET', `/shipments?orderNumber=${encodeURIComponent(order)}&pageSize=50`));
  const shipped = (res?.shipments || []).filter((s) => !s.voided && !s.isReturnLabel);
  const wid = shipped.find((s) => s.warehouseId)?.warehouseId || so.advancedOptions?.warehouseId;
  return wid ? byWarehouse[wid] || null : null;
}

function toLb(w) {
  const v = Number(w?.value) || 0;
  const u = String(w?.units || 'ounces').toLowerCase();
  return u.startsWith('pound') ? v : u.startsWith('gram') ? v / 453.6 : v / 16; // V1 order weight is ounces
}

function customerAddress(so) {
  const t = so.shipTo || {};
  const name = String(t.name || '').trim();
  const split = ss.splitLongReceiverName(name, t.company);
  return {
    name: split ? split.name : name.slice(0, 30),
    company_name: split ? split.company : (t.company || '').slice(0, 30) || undefined,
    phone: t.phone || '',
    address_line1: t.street1,
    address_line2: t.street2 || undefined,
    city_locality: t.city,
    state_province: ss.normalizeProvinceCode(t.state),
    postal_code: t.postalCode,
    country_code: 'CA',
    address_residential_indicator: 'yes',
  };
}

function branchAddress(b) {
  return {
    name: `${branchName(b)} Returns`.slice(0, 30),
    company_name: 'CFC RETURNS',
    phone: (b.contact_phone || [])[0] || '',
    address_line1: b.address,
    city_locality: b.city,
    state_province: b.province || 'BC',
    postal_code: b.postal_code,
    country_code: 'CA',
    address_residential_indicator: 'no',
  };
}

async function rateReturn(shipFrom, shipTo, weightLb) {
  const res = json(await ss.v2Request('POST', '/v2/rates', {
    rate_options: { carrier_ids: [ss.CARRIER_IDS.purolator_walleted] },
    shipment: { ship_from: shipFrom, ship_to: shipTo, packages: [{ weight: { value: Math.round(weightLb * 10) / 10, unit: 'pound' } }], confirmation: 'none' },
  }));
  const rates = res?.rate_response?.rates || [];
  if (!rates.length) return { error: (res?.rate_response?.errors || res?.errors || []).map((e) => e.message).join('; ') || 'no Purolator rate' };
  // Surcharges bill on top of shipping_amount: compare landed cost. Ground first.
  const landed = (x) => Number(x.shipping_amount?.amount || 0) + Number(x.other_amount?.amount || 0) + Number(x.confirmation_amount?.amount || 0);
  const ground = rates.filter((r) => /ground/i.test(r.service_code || ''));
  const best = (ground.length ? ground : rates).sort((a, b) => landed(a) - landed(b))[0];
  return { cents: Math.round(landed(best) * 100), serviceCode: best.service_code, carrierId: best.carrier_id, rateId: best.rate_id };
}

async function quoteLabel(ret) {
  const so = await shipstationOrder(ret.order);
  if (!so.shipTo?.street1 || !so.shipTo?.postalCode) return { error: 'no customer address in ShipStation' };
  const b = await originBranch(ret.order, so);
  if (!b || !b.address || !b.postal_code) return { error: 'cannot tell which warehouse shipped it' };
  // Weight only (never dimensions: ORDER-PREP). Scale the order weight to the
  // units coming back.
  const orderedUnits = (so.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0) || 1;
  const returning = ret.items.reduce((s, i) => s + i.qty, 0);
  const weightLb = Math.max(1, toLb(so.weight) * Math.min(1, returning / orderedUnits));
  const shipFrom = customerAddress(so);
  const shipTo = branchAddress(b);
  const r = await rateReturn(shipFrom, shipTo, weightLb);
  if (r.error) return r;
  return { ...r, branch: branchName(b), branchKey: b.key, branchCode: b.code || null, warehouseId: b.shipstation_warehouse_id, weightLb, shipFrom, shipTo };
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302].includes(res.statusCode) && res.headers.location) return download(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`label PDF download HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
}

async function buyLabel(ret, quote) {
  // Rates expire and the quote may be from an earlier run: re-rate now.
  const fresh = await rateReturn(quote.shipFrom, quote.shipTo, quote.weightLb);
  if (fresh.error) throw new Error(`re-rate failed: ${fresh.error}`);
  if (fresh.cents > quote.cents * 1.15 + 200) throw new Error(`label now quotes ${money(fresh.cents)}, was ${money(quote.cents)}`);
  const reference = `CFC RETURN ${ret.order}`.slice(0, 30);
  const body = (asReturn) => ({
    ...(asReturn ? { is_return_label: true, rma_number: ret.items[0]?.rmaId || ret.order } : {}),
    validate_address: 'no_validation',
    label_layout: '4x6',
    label_format: 'pdf',
    label_download_type: 'url',
    shipment: {
      carrier_id: fresh.carrierId,
      service_code: fresh.serviceCode,
      ship_from: quote.shipFrom,
      ship_to: quote.shipTo,
      confirmation: 'none',
      packages: [{ weight: { value: Math.round(quote.weightLb * 10) / 10, unit: 'pound' }, label_messages: { reference1: reference, reference2: String(ret.items[0]?.sku || '').slice(0, 30) } }],
    },
  });
  let res = await ss.v2Request('POST', '/v2/labels', body(true));
  let lab = json(res);
  if (!lab?.tracking_number && /return/i.test(JSON.stringify(lab?.errors || lab || ''))) {
    // Carrier refuses the return-label flag: a plain label from the customer
    // to the branch does the same job.
    res = await ss.v2Request('POST', '/v2/labels', body(false));
    lab = json(res);
  }
  if (!lab?.tracking_number) throw new Error(`label buy failed: ${JSON.stringify(lab?.errors || lab).slice(0, 200)}`);
  const cents = Math.round(Number(lab.shipment_cost?.amount || 0) * 100) + Math.round(Number(lab.insurance_cost?.amount || 0) * 100);
  // Oversize surcharges show up on the buy, not the quote (reference_oversize_parcel_quote_vs_charge).
  if (cents > fresh.cents * 1.25 + 300) {
    await ss.v2Request('PUT', `/v2/labels/${lab.label_id}/void`).catch(() => {});
    throw new Error(`label charged ${money(cents)} against a ${money(fresh.cents)} quote; voided`);
  }
  const url = lab.label_download?.pdf || lab.label_download?.href;
  const pdf = url ? await download(url) : null;
  if (!pdf) throw new Error(`label ${lab.tracking_number} bought but no PDF came back (label ${lab.label_id})`);
  require('./audit').log({ action: 'returns-label-bought', order: ret.order, tracking: lab.tracking_number, labelId: lab.label_id, cents, branch: quote.branch });
  return { tracking: lab.tracking_number, labelId: lab.label_id, cents, pdf };
}

async function trackLabel(labelId) {
  const t = json(await ss.v2Request('GET', `/v2/labels/${labelId}/track`));
  const status = t?.status_code || '';
  return { status, scanned: ['IT', 'AT', 'DE', 'EX'].includes(status), delivered: status === 'DE' };
}

// ── Email ────────────────────────────────────────────────────────────────────

function shortName(item) {
  const map = readSkuMap().mappings || {};
  const e = map[item.asin] || map[item.sku];
  const product = e && typeof e === 'object' && e.product ? e.product : String(item.itemName || 'item');
  return product.replace(/\s+/g, ' ').slice(0, 70);
}

let lastSend = 0;
async function send(msg) {
  // 60 s between sends: rapid-fire got customfc.ca quarantined (ORDER-PREP).
  const wait = lastSend + 60000 - Date.now();
  if (wait > 0) await sleep(wait);
  const r = await require('./emailer').sendEmail(msg);
  lastSend = Date.now();
  return r;
}

/** Buyer emails go only through Amazon's relay (@marketplace.amazon.ca). */
async function emailBuyer(kind, ret, ctx) {
  const so = await shipstationOrder(ret.order);
  const to = String(so.customerEmail || '').trim();
  if (!/@marketplace\.amazon\.(ca|com)$/i.test(to)) throw new Error(`no Amazon relay address on the order (got "${to || 'none'}")`);
  const first = String(so.shipTo?.name || '').trim().split(/\s+/)[0] || '';
  const hi = first ? `Hi ${first.charAt(0).toUpperCase()}${first.slice(1).toLowerCase()},` : 'Hello,';
  const what = ret.items.length === 1 ? `the ${shortName(ret.items[0])}` : 'these items';
  let subject;
  let lines;
  if (kind === 'never_shipped') {
    subject = `Your refund for Amazon order ${ret.order}`;
    lines = [hi, '',
      `Your order didn't ship, and we're sorry for the wait. We have refunded the full ${money(ctx.cents)} to your original payment method, and Amazon will email you when it posts. There is nothing to send back.`, '',
      'Thanks for shopping with us,', SIGN, STORE_NAME];
  } else if (kind === 'returnless') {
    subject = `Your return for Amazon order ${ret.order}`;
    lines = [hi, '',
      `We have refunded ${money(ctx.cents)} to your original payment method, and Amazon will email you when it posts.`, '',
      `If you haven't sent ${what} back yet, there's no need to. Please keep it.`, '',
      'Thanks for shopping with us,', SIGN, STORE_NAME];
  } else {
    subject = `Prepaid return label for Amazon order ${ret.order}`;
    lines = [hi, '',
      'Your prepaid Purolator return label is attached, so return shipping is on us.', '',
      `1. Pack ${what} in a sturdy box.`,
      '2. Print the label and tape it to the box.',
      '3. Drop it at any Purolator location, or hand it to a Purolator driver.', '',
      ctx.refundOn === 'delivered'
        ? `Your refund of ${money(ctx.cents)} goes through as soon as the box reaches us.`
        : `Your refund of ${money(ctx.cents)} goes through as soon as Purolator scans the box.`,
      `Tracking: ${ctx.tracking}`, '',
      'Please use this label instead of Amazon\'s, which charges you for postage.', '',
      'Thanks for shopping with us,', SIGN, STORE_NAME];
  }
  const attachments = kind === 'label' ? [{ filename: `Return-label-${ret.order}.pdf`, content: ctx.pdf, contentType: 'application/pdf' }] : [];
  await send({ to, subject, text: lines.join('\n'), attachments, fromName: STORE_NAME, replyTo: 'hello@yourfloors.ca' });
  require('./audit').log({ action: 'returns-buyer-email', order: ret.order, kind, to });
  return { to };
}

/** Heads-up to Prosol (Kaitlyn) that a return is on its way to a branch. Mac 2026-10-07: "prosol should know". */
async function notifyBranch(ret, e) {
  const b = Object.values(byWarehouse).find((x) => x.shipstation_warehouse_id === e.label.warehouseId);
  if (!isProsol(b)) return null; // Sechelt / other vendors: not Prosol's box
  const { findOrderRecords } = require('./amazon-return-sf');
  let poName = '';
  try {
    const { pos } = await findOrderRecords(await require('./salesforce').connect(), ret.order);
    poName = pos.map((p) => p.Name).join(', ');
  } catch { /* the email still carries the Amazon ref */ }
  const map = readSkuMap().mappings || {};
  const itemLines = ret.items.map((i) => {
    const m = map[i.asin] || map[i.sku] || {};
    const parts = m.bundle && Array.isArray(m.components) ? m.components : [m];
    return parts.map((p) => `${i.qty} x ${p.prosol_sku || i.sku}  ${p.product || shortName(i)}`).join('\n');
  });
  const where = `${b.city}${b.code ? ` (${b.code})` : ''}`;
  const text = [
    'Hi Kaitlyn,', '',
    `Heads-up: a return is coming in to ${where} by Purolator.`, '',
    ...itemLines,
    ...(poName ? [`PO: ${poName}`] : []),
    `Ref: ${ret.order}`,
    `Return tracking: ${e.label.tracking}`,
    `Box label reads: CFC RETURN ${ret.order}`, '',
    `Please receive it at ${b.city}${poName ? ` and credit it against ${poName}` : ''}.`, '',
    'Thanks,', SIGN,
  ].join('\n');
  const to = KAITLYN();
  await send({ to, cc: MAC(), subject: `Return coming in - ${where}`, text });
  require('./audit').log({ action: 'returns-branch-email', order: ret.order, to, branch: where, po: poName });
  return { to };
}

async function notifyMac({ held, errors, actions }) {
  const { approveToken } = require('./amazon-returns-autopilot');
  const out = [];
  if (actions.length) {
    out.push('Done:');
    for (const a of actions) out.push(a.do === 'refund'
      ? `  ${a.order}  refunded ${money(a.cents)}  ${a.items?.join('; ') || ''}  (${a.why})`
      : `  ${a.order}  ${money(a.cents)} return label ${a.tracking} to ${a.branch}, refund ${money(a.refundCents)} on scan  ${a.items?.join('; ') || ''}`);
    out.push('');
  }
  const need = held.filter((h) => !h.info);
  if (need.length) {
    out.push('Needs you:');
    for (const h of need) {
      const t = approveToken(h.order);
      out.push(`  ${h.order}  ${h.cents != null ? money(h.cents) : ''}  ${h.items.join('; ')}`);
      out.push(`    ${h.why}`);
      if (h.manual || !h.decision) out.push('    Not something a tap can settle: handle it in Seller Central.');
      else if (t) out.push(`    Approve (${h.decision === 'label' ? 'send the label' : 'refund without return'}): ${PUBLIC_BASE}/returns/approve?order=${encodeURIComponent(h.order)}&t=${t}`);
    }
    out.push('');
  }
  const info = held.filter((h) => h.info);
  if (info.length) { out.push('FYI:'); for (const h of info) out.push(`  ${h.order}  ${h.why}`); out.push(''); }
  if (errors.length) { out.push('Errors:'); for (const e of errors) out.push(`  ${e.order}  ${String(e.error).slice(0, 240)}`); }
  const subject = need.length
    ? `Amazon returns: ${need.length} need${need.length === 1 ? 's' : ''} you`
    : errors.length ? 'Amazon returns: something failed' : `Amazon returns: ${actions.length} handled`;
  await require('./emailer').sendEmail({ to: MAC(), subject, text: out.join('\n') });
}

// ── Salesforce ───────────────────────────────────────────────────────────────

async function logSalesforce(ret, e) {
  return require('./amazon-return-sf').logReturn(ret, e);
}

function createIo() {
  return { fetchReturns, previewRefund, commitRefund, quoteLabel, buyLabel, trackLabel, emailBuyer, notifyBranch, notifyMac, logSalesforce };
}

module.exports = { createIo, fetchReturns, previewRefund, quoteLabel, rateReturn, originBranch, customerAddress, branchAddress, toLb };
