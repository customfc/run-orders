#!/usr/bin/env node
/**
 * Trim sales since the catalogue launch (2026-10-02), emailed to Mac for the waves 2b and 3 decision (02
 * PROZONE-BUILD-PLAN.md section 4 item 5, C-1: "decide on 2b and 3 after 8 weeks of data"). Read only.
 * Mini crontab runs it once, on 2026-11-27; --year guards a crontab line left behind.
 *
 * Usage: node scripts/trade/trim-sales-report.js [--dry] [--since=2026-10-02] [--year=2026]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { isCatalogEntry } = require(path.join(ROOT, 'lib', 'trade-skumap'));
const { toCents } = require(path.join(ROOT, 'lib', 'trade-rules'));

const args = process.argv.slice(2);
const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const DRY = args.includes('--dry');
const SINCE = opt('since') || '2026-10-02';
const money = (c) => `$${(Math.round(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function family(entry) {
  const m = String(entry.product || '').match(/^Schluter\s+([A-Z][A-Z0-9-]*)/);
  return m ? m[1] : 'other';
}

async function main() {
  if (opt('year') && String(new Date().getUTCFullYear()) !== opt('year')) return;
  const { graphql } = require(path.join(ROOT, 'lib', 'shopify-graphql'));
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'shipstation', 'sku-map.json'), 'utf8')).mappings;
  const cat = new Map(Object.entries(map).filter(([, e]) => isCatalogEntry(e)));

  const orders = [];
  let after = null;
  do {
    const r = (await graphql(`query($q: String!, $after: String) { orders(first: 100, after: $after, query: $q) { pageInfo { hasNextPage endCursor }
      nodes { name test cancelledAt createdAt discountCodes fulfillmentOrders(first: 5) { nodes { deliveryMethod { methodType } assignedLocation { name } } }
        lineItems(first: 100) { nodes { sku currentQuantity discountedTotalSet { shopMoney { amount } } } } } } }`,
    { q: `created_at:>=${SINCE}`, after })).data.orders;
    orders.push(...r.nodes);
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);

  const fam = {};
  const sku = {};
  const how = {};
  let trimOrders = 0;
  let cents = 0;
  let units = 0;
  let proOrders = 0;
  for (const o of orders) {
    if (o.test || o.cancelledAt) continue;
    const lines = o.lineItems.nodes.filter((l) => cat.has(l.sku) && l.currentQuantity > 0);
    if (!lines.length) continue;
    trimOrders++;
    if ((o.discountCodes || []).some((c) => /^PRO-/i.test(c))) proOrders++;
    const fo = o.fulfillmentOrders.nodes[0];
    const method = fo ? `${fo.deliveryMethod.methodType === 'PICK_UP' ? 'Pickup' : 'Shipping'}${fo.assignedLocation ? ` (${fo.assignedLocation.name})` : ''}` : 'unknown';
    how[method] = (how[method] || 0) + 1;
    for (const l of lines) {
      const c = toCents(l.discountedTotalSet);
      const f = family(cat.get(l.sku));
      cents += c;
      units += l.currentQuantity;
      fam[f] = fam[f] || { cents: 0, units: 0 };
      fam[f].cents += c;
      fam[f].units += l.currentQuantity;
      sku[l.sku] = sku[l.sku] || { cents: 0, units: 0 };
      sku[l.sku].cents += c;
      sku[l.sku].units += l.currentQuantity;
    }
  }
  const rows = (o) => Object.entries(o).sort((a, b) => b[1].cents - a[1].cents);
  const subject = `Trim sales since ${SINCE}: ${trimOrders} orders, ${money(cents)} (decide waves 2b and 3)`;
  const html = `<p>Schluter trims on yourfloors.ca since the catalogue launched (${esc(SINCE)}), from Shopify. Cancelled and test orders are left out.</p>
<ul><li>${trimOrders} orders with trims, ${units} units, ${money(cents)} after discounts.</li><li>${proOrders} of them used a ProZone client code.</li></ul>
<p><b>By family</b></p><table style="border-collapse:collapse;font-size:14px">${rows(fam).map(([k, v]) => `<tr><td style="padding:4px 8px">${esc(k)}</td><td style="padding:4px 8px">${v.units} units</td><td style="padding:4px 8px">${money(v.cents)}</td></tr>`).join('') || '<tr><td>none</td></tr>'}</table>
<p><b>How they were fulfilled</b></p><ul>${Object.entries(how).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join('') || '<li>none</li>'}</ul>
<p><b>Top SKUs</b></p><ul>${rows(sku).slice(0, 15).map(([k, v]) => `<li>${esc(k)}: ${v.units} units, ${money(v.cents)}</li>`).join('') || '<li>none</li>'}</ul>
<p><b>The decision (plan C-1):</b> wave 2b is DILEX, TREP, ECK, BARA, DESIGNBASE and SHOWERPROFILE (about 1,030 variants, near-zero counter sales, 683 on backorder at the distributor); wave 3 is the non-profile gap, mostly KERDI-LINE, plus 87 new 2026 items (about 440). Reply to Claude in the 02 project with go or no for each.</p>`;
  if (DRY) { console.log(subject); console.log(JSON.stringify({ fam, how, top: rows(sku).slice(0, 5) })); return; }
  await require(path.join(ROOT, 'lib', 'emailer')).sendEmail({ to: process.env.MAC_CC_EMAIL || 'mac@customfc.ca', subject, html });
  console.log(`emailed Mac: ${subject}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
