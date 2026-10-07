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
- `local-fulfillment.js` — pickup guard: Shopify pickup / local-delivery / "Pickup at our ..." orders never get a courier label or a Prosol PO (staging, manual buy, SO reconcile). Also the refund guard (staging, manual buy): a Shopify order that is cancelled, refunded in full (a PENDING refund counts) or has every line removed is held with no label; partial refunds still ship.
- `pickup-runner.js` — runs every pickup order (Coast truck, counter pickups, split trims) every 15 min; SHADOW unless `PICKUP_RUNNER_LIVE=coast|all`; state `data/pickup-state.json`. Helpers: `pickup-io.js` (fulfil, refund trims), `pickup-counter-messages.js` (counter + split emails), `pickup-actions.js` / `pickup-messages.js` / `pickup-eta.js` (Coast), `branch-pickup.js` (counter resolution + PO email).
- `trade-accounts.js` / `trade-applications.js` / `trade-verify.js` — ProZone one-tap approve, application intake, business check (CRA check digit + OrgBook BC).
- `counter-stock.js` — counter pickup stock gate (native, 2026-10-02): each Prosol counter is a Shopify location with Shopify's own pickup (`scripts/trade/native-counters.js`; ids in `data/trade/pickup-branches.json` `shopify_location_id`, `native_pickup`), and `scripts/trade/counter-stock-sync.js` writes Prosol's count there; Prosol-profile variants are "don't sell when out of stock" with shipping stock = Prosol network total at Calgary Warehouse. Sechelt Warehouse / Powell River carry CFC's real shelf (Salesforce PBSI available at Sechelt + Sechelt Warehouse + Sechelt Showroom / Powell River), not placeholders. `scripts/trade/map-by-barcode.js` maps "not at Prosol" pickup SKUs by exact barcode against Prosol manufacturers' catalogs. Weekdays at `COUNTER_STOCK_TIMES` BC (06:30, 11:00, 15:00), about 84 batched Prosol requests a run, SHADOW unless `COUNTER_STOCK_LIVE=1`, `COUNTER_STOCK_SYNC=1` for live counts, emails Mac once a day on failure. Rollback: `native-counters.js pickup-off`, `counter-rates-remove.js rollback`, `native-rollback.js restore`.

## Salesforce / Shopify / Amazon
- `salesforce.js` — jsforce SO/PO + PBSI integration.
- `shopify-sf.js` — Shopify → Salesforce SO/PO sync.
- `shopify-graphql.js` — Shopify Admin GraphQL.
- `sp-api.js` / `sp-api-reports.js` / `sp-api-inbound.js` — Amazon SP-API base / reports / FBA inbound.
- `amazon-po.js` — Amazon PO drafts/creation.
- `amazon-returns-autopilot.js` — Amazon MFN returns: refund without return (≤$60, consumables ≤$150), else prepaid Purolator label to the shipping branch + Prosol heads-up, refund on first scan; holds go to Mac with a one-tap approve (`/returns/approve`). Every 2 h; SHADOW unless `RETURNS_AUTOPILOT_LIVE=1`. IO in `amazon-returns-io.js`, Salesforce RMAs in `amazon-return-sf.js` (`RETURNS_SF_LIVE=1`). State `data/returns-autopilot.json`. See `docs/RETURNS.md`.

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
- `sample-watch.js` — sample-order watchdog (samples carry no SKU, so other watchdogs miss them); 08:30 weekday email digest (`data/sample-watch-state.json`). Also names each sample customer to follow up with, once, 3 days after UPS shows the samples delivered (deliveries older than 14 days are skipped). A label is "idle" only if the carrier never scanned it; a scanned label on an order still open 5 days after pickup is `open-after-pickup` (unmarked, or a second vendor's half has no tracking).
- `integration-health.js` — cross-integration health monitor.
