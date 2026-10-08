/**
 * Monthly trim cost check (02 PROZONE-BUILD-PLAN.md section 4 item 2, Mac 2026-10-08). Pure: the CLI is
 * scripts/trade/trim-costs.js.
 *
 * The catalogue trims' Shopify unit costs came from the 2026-09-28 Prosol pull, and trims now take up to 25% off in
 * ProZone. Each month: Prosol's current cost for every catalogue variant goes onto the Shopify inventory item, and
 * every variant whose price at 25% off no longer clears Mac's floor (5% net margin, trade-config floor) is reported
 * to Mac. Nothing is excluded automatically.
 */

'use strict';

const { toCents, clearsFloor, defaultConfig } = require('./trade-rules');

const DEEPEST_PERCENT = 25;

const margin = (priceCents, pct, costCents) => {
  const net = priceCents * (1 - pct / 100);
  return net > 0 ? Math.round(((net - costCents) / net) * 1000) / 10 : null;
};

/**
 * rows: [{ sku, handle, inventoryItemId, price, shopifyCost, prosolCost }] (money as numbers or strings, cost null
 * when unknown). -> { updates, belowFloor, missing, unchanged }
 *   updates     the Shopify cost differs from Prosol's by a cent or more: { sku, inventoryItemId, fromCents, toCents }
 *   belowFloor  at 25% off the variant is under the floor on Prosol's cost: { sku, handle, priceCents, costCents, marginPct }
 *   missing     no Prosol cost this run (left as it is)
 */
function planCosts(rows, { cfg = defaultConfig(), percent = DEEPEST_PERCENT } = {}) {
  const out = { updates: [], belowFloor: [], missing: [], unchanged: 0 };
  for (const r of rows) {
    if (r.prosolCost == null || !(toCents(r.prosolCost) > 0)) { out.missing.push(r.sku); continue; }
    const cost = toCents(r.prosolCost);
    const price = toCents(r.price);
    const before = r.shopifyCost == null || r.shopifyCost === '' ? null : toCents(r.shopifyCost);
    if (before !== cost && r.inventoryItemId) out.updates.push({ sku: r.sku, inventoryItemId: r.inventoryItemId, fromCents: before, toCents: cost });
    else out.unchanged++;
    if (!clearsFloor({ price: price / 100, cost: cost / 100, percent }, cfg)) {
      out.belowFloor.push({ sku: r.sku, handle: r.handle, priceCents: price, costCents: cost, marginPct: margin(price, percent, cost) });
    }
  }
  return out;
}

const money = (c) => (c == null ? 'none' : `$${(Math.round(c) / 100).toFixed(2)}`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Mac's monthly email. -> { subject, html } or null when there is nothing to tell. */
function report(plan, { applied, total, failedUpdates = [] }) {
  if (!plan.updates.length && !plan.belowFloor.length && !plan.missing.length && !failedUpdates.length) return null;
  const ups = plan.updates.filter((u) => u.fromCents != null && u.toCents > u.fromCents);
  const downs = plan.updates.filter((u) => u.fromCents != null && u.toCents < u.fromCents);
  const top = [...ups].sort((a, b) => (b.toCents / b.fromCents) - (a.toCents / a.fromCents)).slice(0, 10);
  const subject = `Trim costs: ${plan.updates.length} changed, ${plan.belowFloor.length} under the 5% floor at 25% off`;
  const html = `<p>Monthly check of the ${total} Schluter trim variants against Prosol's current cost.</p>
<ul><li>${plan.updates.length} costs ${applied ? 'updated in Shopify' : 'differ (not written: dry run)'}: ${ups.length} up, ${downs.length} down.</li>
<li>${plan.belowFloor.length} variants under the 5% net margin floor at 25% off (the Coast price over $1,000).</li>
<li>${plan.missing.length} with no cost from Prosol this month (left as they were).</li>
${failedUpdates.length ? `<li><b>${failedUpdates.length} cost updates failed:</b> ${esc(failedUpdates.slice(0, 10).join(', '))}</li>` : ''}</ul>
${plan.belowFloor.length ? `<p><b>Under the floor</b> (nothing was changed; tagging the product <code>prozone-exclude</code> takes it out of ProZone pricing):</p>
<table style="border-collapse:collapse;font-size:14px"><tr style="text-align:left"><th style="padding:4px 8px">SKU</th><th style="padding:4px 8px">Price</th><th style="padding:4px 8px">Cost</th><th style="padding:4px 8px">Margin at 25% off</th><th style="padding:4px 8px">Product</th></tr>
${plan.belowFloor.map((b) => `<tr><td style="padding:4px 8px">${esc(b.sku)}</td><td style="padding:4px 8px">${money(b.priceCents)}</td><td style="padding:4px 8px">${money(b.costCents)}</td><td style="padding:4px 8px">${b.marginPct}%</td><td style="padding:4px 8px">${esc(b.handle)}</td></tr>`).join('')}</table>` : ''}
${top.length ? `<p>Biggest increases: ${top.map((u) => `${esc(u.sku)} ${money(u.fromCents)} to ${money(u.toCents)}`).join('; ')}.</p>` : ''}`;
  return { subject, html };
}

module.exports = { DEEPEST_PERCENT, planCosts, report, margin };
