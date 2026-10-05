/**
 * ProZone accounts (02, 2026-10-02): approving a contractor turns their pricing on.
 *
 * approveAccount() finds the customer by email (creates one if missing; marketing consent is never touched), sets the
 * trade.* metafields, adds the customer to the ProZone automatic discounts (Coast: 10% + 20% + 25% over
 * $1,000; national: 10% + 20%; the 10% never wins a line since trims joined the 20% on 2026-10-05) and adds their client code to the "ProZone client" code discount. Idempotent: a second
 * run changes nothing. Same logic as cfc-projects/02-yf-schluter-trade/scripts/live/trade-account.js, for the one-tap
 * approve link (lib/trade-applications.js, server.js /prozone/*).
 */

'use strict';

const { graphql } = require('./shopify-graphql');

// Tiers by role (Mac 2026-10-02: national 20% across the board; the Coast keeps 25% over $1,000; trims in accessories
// since 2026-10-05, so the ProZone 10% is redundant but harmless).
// The discounts were renamed "ProZone Coast 20%/25%" -> "ProZone 20%/25%" the same day (the title shows in the cart,
// and national buyers must never see "Coast"); both names resolve so the rename can't break an approval.
const TITLES = { t10: ['ProZone 10%'], t20: ['ProZone 20%', 'ProZone Coast 20%'], t25: ['ProZone 25%', 'ProZone Coast 25%'] };
const COAST = ['t10', 't20', 't25'];
const NATIONAL = ['t10', 't20'];
const CLIENT = 'ProZone client';

function errs(label, ue) { if (ue && ue.length) throw new Error(`${label}: ${JSON.stringify(ue)}`); }

async function proZoneDiscounts(gql = graphql) {
  const r = await gql(`{ discountNodes(first: 20, query: "title:ProZone*") { nodes { id discount { __typename
    ... on DiscountAutomaticBasic { title status context { __typename ... on DiscountCustomers { customers { id } } } }
    ... on DiscountCodeBasic { title status codes(first: 250) { nodes { id code } } } } } } }`);
  const out = {};
  for (const n of r.data.discountNodes.nodes) {
    if (n.discount.status === 'EXPIRED') continue;
    out[n.discount.title] = {
      id: n.id, type: n.discount.__typename,
      customers: ((n.discount.context && n.discount.context.customers) || []).map((c) => c.id),
      codes: n.discount.codes ? n.discount.codes.nodes : [],
    };
  }
  for (const [role, names] of Object.entries(TITLES)) {
    const hit = names.find((n) => out[n]);
    if (!hit) throw new Error(`discount "${names[0]}" not found`);
    out[role] = { ...out[hit], title: hit };
  }
  if (!out[CLIENT]) throw new Error(`discount "${CLIENT}" not found`);
  return out;
}

async function customerByEmail(email, gql = graphql) {
  const r = await gql(`query($q: String!) { customers(first: 2, query: $q) { nodes { id email firstName lastName
    metafields(first: 20, namespace: "trade") { nodes { key value } } } } }`, { q: `email:"${email}"` });
  const hits = r.data.customers.nodes.filter((c) => (c.email || '').toLowerCase() === email.toLowerCase());
  if (hits.length > 1) throw new Error(`${hits.length} customers share ${email}`);
  if (!hits[0]) return null;
  return { ...hits[0], trade: Object.fromEntries(hits[0].metafields.nodes.map((m) => [m.key, m.value])) };
}

function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return '';
}

/** "Sam's Tile & Stone Ltd" -> PRO-SAMSTILE: whole words until 6+ letters, at most 12. */
function codeFor(business, fallback = '') {
  const skip = new Set(['THE', 'AND', 'LTD', 'INC', 'CORP', 'CO', 'LTEE']);
  const words = String(business || fallback).toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter((w) => w && !skip.has(w));
  let stem = '';
  for (const w of words) { if (stem.length >= 6 || (stem + w).length > 12) break; stem += w; }
  stem = stem || (words[0] || '').slice(0, 12);
  return stem ? `PRO-${stem}` : '';
}

async function codeTaken(code, gql = graphql) {
  const r = await gql(`query($c: String!) { codeDiscountNodeByCode(code: $c) { id } }`, { c: code });
  return r.data.codeDiscountNodeByCode ? r.data.codeDiscountNodeByCode.id : null;
}

/** A free PRO- code: the business stem, then -2, -3 ... if taken by someone else. */
async function freeCode(base, ownCode, gql = graphql) {
  if (ownCode) return ownCode;
  for (let i = 1; i < 20; i++) {
    const c = i === 1 ? base : `${base}-${i}`;
    if (!(await codeTaken(c, gql))) return c;
  }
  throw new Error(`no free client code near ${base}`);
}

/**
 * app: { email, firstName, lastName, business, gst, phone, area, national? }.
 * -> { customerId, created, code, discountsAdded: [...], codeAdded }
 */
async function approveAccount(app, { gql = graphql, now = new Date() } = {}) {
  const email = String(app.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`bad email "${app.email}"`);
  if (!app.business) throw new Error('business name required');
  const want = app.national ? NATIONAL : COAST;
  const ds = await proZoneDiscounts(gql);
  let c = await customerByEmail(email, gql);
  let created = false;
  if (!c) {
    const phone = e164(app.phone);
    const r = await gql(`mutation($i: CustomerInput!) { customerCreate(input: $i) { customer { id } userErrors { field message } } }`, {
      i: { email, firstName: app.firstName || null, lastName: app.lastName || null, ...(phone ? { phone } : {}),
        note: `ProZone approved by Mac on ${now.toISOString().slice(0, 10)}` },
    });
    errs('customerCreate', r.data.customerCreate.userErrors);
    c = { id: r.data.customerCreate.customer.id, trade: {} };
    created = true;
  }
  const code = await freeCode(codeFor(app.business, app.lastName || email.split('@')[0]), c.trade.code, gql);

  const fields = [
    ['approved_at', 'date_time', c.trade.approved_at || now.toISOString()],
    ['local', 'boolean', app.national ? 'false' : 'true'],
    ['business', 'single_line_text_field', String(app.business).slice(0, 200)],
    ['province', 'single_line_text_field', app.province || 'BC'],
    ['code', 'single_line_text_field', code],
  ];
  if (app.gst) fields.push(['gst', 'single_line_text_field', String(app.gst).slice(0, 40)]);
  const m = await gql(`mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    { m: fields.map(([key, type, value]) => ({ ownerId: c.id, namespace: 'trade', key, type, value })) });
  errs('metafieldsSet', m.data.metafieldsSet.userErrors);

  const discountsAdded = [];
  for (const t of want) {
    if (ds[t].customers.includes(c.id)) continue;
    const r = await gql(`mutation($id: ID!, $d: DiscountAutomaticBasicInput!) { discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) { userErrors { field message } } }`,
      { id: ds[t].id, d: { context: { customers: { add: [c.id] } } } });
    errs(`add to ${ds[t].title}`, r.data.discountAutomaticBasicUpdate.userErrors);
    discountsAdded.push(ds[t].title);
  }

  let codeAdded = false;
  if (!ds[CLIENT].codes.some((x) => x.code.toUpperCase() === code)) {
    const r = await gql(`mutation($id: ID!, $c: [DiscountRedeemCodeInput!]!) { discountRedeemCodeBulkAdd(discountId: $id, codes: $c) { bulkCreation { id } userErrors { field message } } }`,
      { id: ds[CLIENT].id, c: [{ code }] });
    errs('discountRedeemCodeBulkAdd', r.data.discountRedeemCodeBulkAdd.userErrors);
    codeAdded = true;
  }
  return { customerId: c.id, created, code, discountsAdded, codeAdded };
}

module.exports = { approveAccount, codeFor, e164, customerByEmail, proZoneDiscounts, COAST, NATIONAL, CLIENT };
