'use strict';
/**
 * Is Salesforce switched off (ERP_BACKEND=automayt)?
 *
 * Read straight from the env so the Salesforce-only paths outside the SO/PO
 * writes (stage's mapping guard and sku-resolver lookups, the Shopify SO
 * reconcile sweep, the nightly ETL) can stand down without loading
 * lib/erp-backend.js, which pulls in shopify-sf and amazon-po.
 *
 * Only the exact value "automayt" counts. Unset, "salesforce",
 * "automayt-shadow" and anything unrecognised keep today's Salesforce path;
 * lib/erp-backend.js still throws on an unknown value when the pos phase
 * writes orders, so a typo is loud there.
 */
function automaytOnly() {
  return String(process.env.ERP_BACKEND || '').trim().toLowerCase() === 'automayt';
}

module.exports = { automaytOnly };
