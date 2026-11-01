# run-orders/lib — Module Index

Helper modules for the pipeline + server. (See `../CLAUDE.md` for ops rules.) One-liner each:

## Pipeline core
- `pipeline.js` — pipeline stage orchestration.
- `map-rules.js` — sku-map rule resolution (title-is-truth, slashes, ASIN aliases).
- `auto-map.js` — exact-identity SKU auto-mapping (shadow-first).
- `sku-resolver.js` — unmapped-SKU resolver: exact tier auto-maps provable Sechelt stock during staging (Shopify SKU = one ERP item of that name: the SF item, or the Automayt item_number under `ERP_BACKEND=automayt`); an Amazon ASIN whose listing SellerSKU (SP-API order items) is an exact Prosol storefront SKU with vendor code + cost and passes the mapping guard auto-maps (`discovered_by: sku-resolver-seller-sku`); a high-confidence Opus Prosol proposal that is the same api_sku+prosol_sku as an existing verified entry and passes the mapping guard on the order title auto-maps as a twin (`discovered_by: sku-resolver-twin`); any other high- or medium-confidence Opus proposal that code re-checks (Prosol confirms the api_sku, its vendor code and a cost, and the order title passes the mapping guard against Prosol's product name, or for a Sechelt route against the ERP item description, with Shopify Sechelt stock covering the quantity like the exact tier) is applied like the approve link applies it (state `appliedBy: opus-auto`, sku-map note "Auto-applied ... by sku-resolver"). No auto-apply sends an email (Mac 2026-11-01: no FYI emails): each is in the state and the audit trail (`sku-resolver-auto-applied`, `by` auto-exact / auto-seller-sku / auto-twin / opus-auto). Only no proposal, low confidence or a failed re-check emails Mac a one-tap approve link (`/sku-resolver/approve`), re-emailed daily while the order waits (`data/sku-resolver-state.json`). Opus has read-only tools: Shopify, Salesforce or (under automayt) `automayt_item_lookup`, the sku-map, an exact-code `prosol_lookup`; `askOpus` is the shared loop `automayt-settle.js` reuses.
- `discontinued.js` — discontinued-at-Prosol desk (#1412, 2026-10-11): staging tags "No Prosol inventory result" rows (`prosolGone`); after the pass it confirms in its own Prosol session (every code form + pinned product id; a still-listed product is a blip, emailed only if it lasts 3 h), Opus picks an in-stock substitute that code re-checks (stock, cost, list >= 80% of what they paid), and Mac gets one email of taps (`/discontinued/act`): Shopify = Offer the swap / Refund, Amazon = Mark discontinued. Offer/refund also HALT the SKU (`sku-map-file.writeEntry`) and DRAFT the listing. Ship the swap writes a per-order swap that staging, the Prosol email and the SF PO apply (`applySwaps`). Reminders daily, offers every 3 days. State `data/discontinued-state.json`; CLI `scripts/ops/discontinued.js status|offered`.
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
- `amazon-inbox.js` — Amazon buyer messages in hello@: reads Amazon mail only, gathers the order's facts, Opus drafts the reply, Mac gets a card with a Send link (`/amazon-inbox/send`). Every 30 min with `AMAZON_INBOX_LIVE=1`; auto-sends only carrier-backed tracking answers with `AMAZON_INBOX_AUTOSEND=1`. CLI `scripts/ops/amazon-inbox.js`, see `docs/AMAZON-INBOX.md`.
- `kerdi-check.js` — Kerdi-Line size check at staging (Mac 2026-10-07): an Amazon order whose Kerdi-Line channel/grate/flange parts don't line up with the buyer's last 14 days of orders is held and the buyer is asked once through the relay (`lib/pipeline.js`); ships after 24 h with no reply; a buyer reply keeps it held until Mac sends his answer from the inbox card. State `data/kerdi-check.json`.
- `pick-notes.js` — per-product pick notes on the Prosol email + routing `min_spare` (`scripts/shipstation/pick-notes.json`; Sealer's Choice Gold quart).
- `amazon-cancel-request.js` — the buyer's cancel request is on each order ITEM (`BuyerRequestedCancel`), not the order; used by poll-cancellations and the orphan sweep.
- `amazon-returns-autopilot.js` — Amazon MFN returns: refund without return (≤$60, consumables ≤$150), else prepaid Purolator label to the shipping branch + Prosol heads-up, refund on first scan; holds go to Mac with a one-tap approve (`/returns/approve`). Every 2 h; SHADOW unless `RETURNS_AUTOPILOT_LIVE=1`. IO in `amazon-returns-io.js`, Salesforce RMAs in `amazon-return-sf.js` (`RETURNS_SF_LIVE=1`). State `data/returns-autopilot.json`. See `docs/RETURNS.md`.

## Automayt (replaces Salesforce, see `../docs/AUTOMAYT.md`)
- `automayt.js` — Open API transport: bearer key, required Idempotency-Key, same-key retries, 8 in flight, `AutomaytError` with `code` + `request_id`.
- `automayt-erp.js` — domain calls: external-ref fixed records, items (create, `updateItem` PATCH, `getItem`, `itemSummary`, `isInactiveItem`), SOs (procurement external), Amazon 14-day period SO, shipments out of a location, invoices and credit notes, confirmed POs, receipts, cancels, notes, payables.
- `automayt-orders.js` — Automayt twins of the Shopify, Amazon and FBA SO/PO flows, same result shapes as the Salesforce originals.
- `automayt-settle.js` — Opus settles two item problems in those flows, only under `ERP_BACKEND=automayt` (Salesforce and the shadow mirror keep today's errors): a code several Automayt items share (Shopify, Amazon Prosol + own-stock, FBA) gets one Opus pick (order line sku/title/qty/unit price vs each item's description, unit, cost, price, vendor, dates) that must pass the mapping guard, pinned on the sku-map entry (`automayt_item_id` + `automayt_item_for`) through `liveSetMapping`; lookups honour a pin first and drop it when the item is gone or inactive; "can't tell" keeps today's error. A missing Prosol cost at auto-create gets one Opus search of Prosol for the right storefront SKU; code re-reads Prosol for it (same vendor code, a cost, guard passes), corrects the entry's `api_sku` + `cost_cad` and uses Prosol's cost, else refuses as today. Capped by `SKU_RESOLVER_SETTLE_MAX_PER_PASS` (5 an hour); answers kept in `data/sku-resolver-state.json` (`itemPicks`, `costFixes`), a no re-asked after a day.
- `prosol-catalog.js` — Prosol catalogue → Automayt items (pure): 2+ branch stock rule, Salesforce dedupe, category mapping, flooring per sq ft / ft (`flooringUnit`, `unitCostFor`; no-coverage flooring left out), shared codes at one price merged (`resolveCollisions`), brand = maker, `toItemInput` for `createItem`. Scripts in `scripts/automayt/prosol-catalog-*.js`, see `../docs/AUTOMAYT.md` "Prosol catalogue".
- `automayt-vendor-codes.js` — vendor codes for Automayt's migrated items (pure): matches each PRD item back to its Salesforce item exactly (vendor, maker, style, colour + price/cost/barcode), code = Prosol code (Prosol items) else Salesforce Vendor Item ID, holds placeholder/clashing codes; a code Prosol shares is written when same brand + maker's code, with the default vendor/cost by cheaper unit cost or `scripts/automayt/vendor-preferences.json` (Bona → Treeco); `salesforceCrosswalk` keys the same codes by Salesforce item for Automayt's migration. Script `scripts/automayt/set-vendor-codes.js`.
- `erp-backend.js` — `ERP_BACKEND` switch every SO/PO caller goes through: `salesforce` (default) | `automayt-shadow` (mirror after SF, never fails SF) | `automayt`.
- `erp-mode.js` — `automaytOnly()`: true only for `ERP_BACKEND=automayt`; the Salesforce side paths (Shopify SO reconcile, ETL item-costs/sku-map, returns autopilot RMA log) stand down on it without loading `erp-backend.js`, and the stage mapping guard, the sku-resolver exact tier and its Opus ERP tool look items up in Automayt instead; branch-pickup `pickup-io.ensurePo` creates the SO/PO through `erp-backend` under it. Still on Salesforce under automayt (stale, non-blocking): `counter-stock-sync` Sechelt/Powell River shelf counts and the Kaitlyn return heads-up PO name.
- `channel-tax.js` — pure tax math: Shopify order money (paid line totals, tax by code as `tax_charged`, fee, refunds), the Amazon Finances transactions counted like Seller Central's Date Range report, CFC GST/HST vs Amazon-withheld provincial tax by province, the period tax line, a Date Range CSV parser.
- `channel-tax-io.js` — Finances API pull, Amazon order provinces (analytics DB, then Orders API), Shopify money fetch, records under `data/channel-tax/` (gitignored). CLI `scripts/automayt/channel-tax.js`; read-only check against Lynnae's numbers `scripts/automayt/verify-channel-tax.js`.

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
- `tap-log.js` — audit line for every emailed tap link Mac opens (`tap-open`) or presses (`tap-press`): record keys, HTTP status, error, Tailscale IP, browser; never tokens or reply text. Links only resolve on the tailnet, so no line = the page never loaded (phone off Tailscale / NordVPN on). `grep '"action":"tap-' data/audit.jsonl`.
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
