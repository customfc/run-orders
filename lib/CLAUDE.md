# run-orders/lib — Module Index

Helper modules for the pipeline + server. (See `../CLAUDE.md` for ops rules.) One-liner each:

## Pipeline core
- `pipeline.js` — pipeline stage orchestration.
- `map-rules.js` — sku-map rule resolution (title-is-truth, slashes, ASIN aliases).
- `auto-map.js` — exact-identity SKU auto-mapping (shadow-first).
- `sku-resolver.js` — unmapped-SKU resolver: exact tier auto-maps provable Sechelt stock during staging; everything else gets an Opus mapping proposal emailed with a one-tap approve link (`/sku-resolver/approve`), re-emailed daily while the order waits (`data/sku-resolver-state.json`).
- `schluter-map.js` — Schluter-specific SKU mapping.
- `ops-state.js` — persisted ops state (`data/ops-state/`).
- `audit.js` — append-only audit trail (`data/audit.jsonl`).

## Carriers / labels / pickups
- `shipstation-v2.js` — ShipStation V2 API (labels, `bookPickup`).
- `ups-api.js` — UPS API.
- `pickups.js` — pickup booking orchestration (UPS / Purolator / Canada Post).
- `auto-rebooker.js` — auto re-book stuck pickups. Sechelt Purolator is reported as "needs crew drop-off" instead of booked (no carrier pickup there); a carrier "already scheduled" answer is reported as locked, not failed.
- `manual-dropoff.js` — the `<warehouseId>::<carrier>` groups the crew hand-drops (Sechelt Purolator), shared by the pickup phase and the rebooker.
- `ghost-pickup.js` — ghost-pickup tracking (alert-only, no auto-spend). The throwaway label voids at noon the day AFTER its pickup (never before: an early void can cancel the pickup); dates are server-local, not UTC.
- `stale-tracker.js` — stale order / pickup detection (age≤1 wait is intentional).
- `package-split.js` — split-shipment child handling.
- `packing-slip.js` — packing-slip generation.
- `local-fulfillment.js` — pickup guard: Shopify pickup / local-delivery / "Pickup at our ..." orders never get a courier label or a Prosol PO (staging, manual buy, SO reconcile).
- `pickup-runner.js` — runs every pickup order (Coast truck, counter pickups, split trims) every 15 min; SHADOW unless `PICKUP_RUNNER_LIVE=coast|all`; state `data/pickup-state.json`. Helpers: `pickup-io.js` (fulfil, refund trims), `pickup-counter-messages.js` (counter + split emails), `pickup-actions.js` / `pickup-messages.js` / `pickup-eta.js` (Coast), `branch-pickup.js` (counter resolution + PO email).
- `trade-accounts.js` / `trade-applications.js` / `trade-verify.js` — ProZone one-tap approve, application intake, business check (CRA check digit + OrgBook BC).
- `counter-stock.js` — counter pickup stock gate: Prosol stock per counter -> `pz-no-<CODE>` product tags for the hide-shipping app (sync `scripts/trade/counter-stock-sync.js`, weekdays at `COUNTER_STOCK_TIMES` BC time (default 06:30, 11:00, 15:00), about 84 batched Prosol requests a run, SHADOW unless `COUNTER_STOCK_LIVE=1`, `COUNTER_STOCK_SYNC=1` for live counts, snapshots `data/trade/counter-stock/`).

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
- `large-order-releases.js` — human release for the large-order review gate (`/release`, `POST /api/orders/release`, `data/large-order-releases.json`, 14-day TTL, optional branch pin).

## Email / messaging
- `emailer.js` — nodemailer send path.
- `resend-email.js` — Resend helper (CFC; `RESEND_API_KEY`).
- `imap-watcher.js` · `mail-watcher.js` — inbound IMAP polling (no Mail.app scraping).
- `vendor-reply-parser.js` — parse vendor email replies.
- `orphan-email-sweep.js` — sweep un-emailed orphan orders (LIVE via `ORPHAN_SWEEP_LIVE=1`). ShipStation-first since 2026-09-09: labels bought outside the pipeline are discovered and backfilled into `phases.buy.labels` before classification.
- `telegram.js` — Telegram bot (`/deploy`, `/held`, `/buy`, `/claude`).

## Vendor data / analytics / health
- `prosol-stock.js` — Prosol stock lookup (also source of `cost_cad`).
- `analytics-db.js` + `analytics-schema.sql` + `analytics-views.sql` — SQLite analytics layer.
- `analytics-alerts.js` — analytics alerting.
- `sample-watch.js` — sample-order watchdog (samples carry no SKU, so other watchdogs miss them); 08:30 weekday email digest (`data/sample-watch-state.json`). Also names each sample customer to follow up with, once, 3 days after UPS shows the samples delivered (deliveries older than 14 days are skipped).
- `integration-health.js` — cross-integration health monitor.
