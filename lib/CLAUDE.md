# run-orders/lib — Module Index

Helper modules for the pipeline + server. (See `../CLAUDE.md` for ops rules.) One-liner each:

## Pipeline core
- `pipeline.js` — pipeline stage orchestration.
- `map-rules.js` — sku-map rule resolution (title-is-truth, slashes, ASIN aliases).
- `auto-map.js` — exact-identity SKU auto-mapping (shadow-first).
- `schluter-map.js` — Schluter-specific SKU mapping.
- `ops-state.js` — persisted ops state (`data/ops-state/`).
- `audit.js` — append-only audit trail (`data/audit.jsonl`).

## Carriers / labels / pickups
- `shipstation-v2.js` — ShipStation V2 API (labels, `bookPickup`).
- `ups-api.js` — UPS API.
- `pickups.js` — pickup booking orchestration (UPS / Purolator / Canada Post).
- `auto-rebooker.js` — auto re-book stuck pickups.
- `ghost-pickup.js` — ghost-pickup tracking (alert-only, no auto-spend).
- `stale-tracker.js` — stale order / pickup detection (age≤1 wait is intentional).
- `package-split.js` — split-shipment child handling.
- `packing-slip.js` — packing-slip generation.

## Salesforce / Shopify / Amazon
- `salesforce.js` — jsforce SO/PO + PBSI integration.
- `shopify-sf.js` — Shopify → Salesforce SO/PO sync.
- `shopify-graphql.js` — Shopify Admin GraphQL.
- `sp-api.js` / `sp-api-reports.js` / `sp-api-inbound.js` — Amazon SP-API base / reports / FBA inbound.
- `amazon-po.js` — Amazon PO drafts/creation.

## FBA
- `fba-inbound-orchestrator.js` · `fba-inbound-plans.js` — FBA inbound flow + plans.
- `fba-po-drafts.js` · `fba-po-sender.js` — FBA PO draft + send.
- `fba-signals.js` — restock/days-of-supply signals.
- `auto-restock.js` — FBM auto-activation when FBA dips.

## Pricing / budget
- `auto-reprice.js` — buybox repricer (SHADOW; 18 Mapei SKUs).
- `budget-guards.js` — spend guards (label-cost confirm, etc.).
- `held-rebuys.js` — void→rebuy hold queue (`/held`, `data/held-rebuys.json`).

## Email / messaging
- `emailer.js` — nodemailer send path.
- `resend-email.js` — Resend helper (CFC; `RESEND_API_KEY`).
- `imap-watcher.js` · `mail-watcher.js` — inbound IMAP polling (no Mail.app scraping).
- `vendor-reply-parser.js` — parse vendor email replies.
- `orphan-email-sweep.js` — sweep un-emailed orphan orders (SHADOW).
- `telegram.js` — Telegram bot (`/deploy`, `/held`, `/buy`, `/claude`).

## Vendor data / analytics / health
- `prosol-stock.js` — Prosol stock lookup (also source of `cost_cad`).
- `analytics-db.js` + `analytics-schema.sql` + `analytics-views.sql` — SQLite analytics layer.
- `analytics-alerts.js` — analytics alerting.
- `integration-health.js` — cross-integration health monitor.
