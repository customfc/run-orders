# run-orders on Automayt

Automayt replaces Salesforce as CFC's system of record: production go-live and the hard Salesforce cutoff are **2026-11-01** (moved from about 10-09). All Salesforce records migrate into Automayt.
This is how run-orders talks to it. The Salesforce-side contract is `AUTOMAYT-INTEGRATION-SPEC.md`.

## Environments and keys

| Env | Base URL | Key |
|---|---|---|
| beta1 | `https://beta1.automayt.dev/api/v1` | `amk_test_…` (demo data, may be reset) |
| staging | `https://staging.automayt.dev/api/v1` | `amk_test_…` (rehearsal) |
| production | `https://app.automayt.com/api/v1` | `amk_live_…`, locked to the Mini's IPs |

`.env`: `AUTOMAYT_API_BASE`, `AUTOMAYT_API_KEY`. The client refuses a test key on the production URL and a live key anywhere else.

## Modules

- `lib/automayt.js`: transport. Bearer auth, required `Idempotency-Key` on every create or command, retries with the same key (429 `Retry-After`, 5xx, `request_in_progress`), 8 requests in flight, `AutomaytError` with `code` and `request_id`, cursor paging.
- `lib/automayt-erp.js`: domain calls. Fixed records through external refs, items, sales orders, the Amazon period order, POs, receipts, cancels, notes, payables.
- `lib/automayt-orders.js`: Automayt twins of the three live flows, same result shapes as the Salesforce originals (`createShopifySoPo`, `createAmazonPOs`, the FBA PO create).
- `lib/erp-backend.js`: the switch every caller goes through (pipeline, server, Shopify SO reconcile, FBA sender).
- `lib/channel-tax.js` / `lib/channel-tax-io.js`: what Shopify and Amazon actually charged, by tax code; the Amazon period tax close; the record files. CLI `scripts/automayt/channel-tax.js`. See **Tax** below.

## The switch: `ERP_BACKEND`

| Value | What happens |
|---|---|
| `salesforce` (default, also when unset) | Today's Salesforce flows, unchanged. Automayt code isn't even loaded. |
| `automayt-shadow` | Salesforce exactly as today, then the same order mirrored to Automayt. |
| `automayt` | Automayt only. Cutover. |

An unknown value throws, so a typo stops the pos phase loudly instead of guessing.

**Shadow mode** starts the mirror only after Salesforce has answered and can't change or fail that result. Every error is caught; a mirror still running after `AUTOMAYT_SHADOW_TIMEOUT_MS` (default 90000) is abandoned. Each mirror writes one `automayt-shadow` line to `data/audit.jsonl` and adds `automaytShadow: { ok, error, soNumber, poNumber, requestIds }` to the result. It writes to Automayt what cutover would: the Shopify SO + Prosol PO, Amazon period-SO lines + one PO per parcel received into Amazon Fulfillment, FBA stock POs. Amazon shares one ShipStation fetch between both backends. Shadow never emails anyone.

**Turning shadow on (staging, after Automayt seeds Prosol, Treeco and Amazon Fulfillment):** in the Mini's `.env` set `AUTOMAYT_API_BASE=https://staging.automayt.dev/api/v1`, `AUTOMAYT_API_KEY=<staging key>`, `AMAZON_PERIOD_ANCHOR=<any Salesforce period start, e.g. 2026-09-24>`, `ERP_BACKEND=automayt-shadow`; map the six fixed records once under system `run-orders` (`erp.mapRef`); restart. Off again: remove `ERP_BACKEND`, restart.

**Deliberate differences from Salesforce:** no fuzzy title or code-prefix item match (a miss auto-creates from the sku-map or goes to review); a vendor code shared by two items stops the line; PO lines carry the item cost (the Salesforce Shopify flow wrote the sale price there); a Shopify order whose SO already exists is skipped, as in Salesforce, but the guard can only see SOs that carry `channel: shopify` and the order number, so staff entering a Shopify order by hand in Automayt must fill both.

## Rules the code depends on

- **Fixed records are external refs, never ids in code.** System `run-orders`, keys `shopify-house`, `amazon-house`, `prosol`, `treeco`, `sechelt-warehouse`, `amazon-fulfillment`. A mapping can never be re-pointed, so map only the real record.
- **Idempotency keys come from our ids** (`shopify-<order>-so`, `amazon-<tracking>-po`, `amazon-<tracking>-rcv`, `fba-<draft>-po`), and the body under a key must be deterministic. A date of "now" in a retried body gets `422 idempotency_key_reused` instead of a replay, so dates come from the order.
- **`409 duplicate` means already done.** Read the existing record from `details.existing_id`. A failed dedupe read throws; it never means "no match".
- **Sales orders are `procurement_mode: external`.** Automayt must never raise its own POs or reserve stock for our orders.
- **POs are `status: confirmed`.** run-orders tells the vendor itself; Automayt never emails on create, and we never call `/send`.
- **Amazon period order:** one sales order per 14-day payout window on Salesforce's own schedule (Sep 24 - Oct 7, Oct 8 - 21, Oct 22 - Nov 4, ...), `external_ref` `period:<start date>`, windows counted from `AMAZON_PERIOD_ANCHOR`. Any period start gives the same windows (2026-09-24, 10-08 and 10-22 are equivalent); nothing is hardcoded. Each parcel adds its lines with `external_line_ref` `<tracking>:<n>` (one PO per parcel, and a multi-package order has several), so a re-run skips them. Every add repeats the GST/PST exemption. The period lookup checks a `sales_order` external ref `period:<start>` under system `run-orders` first (how the migrated order is found), then the order's own channel and external_ref.
- **No split at cutover.** The Oct 22 - Nov 4 period order is migrated from Salesforce as the same record, and run-orders keeps adding to it from Nov 1. In production run-orders refuses to open the anchor period (or an earlier one) itself: an unmapped one fails the parcel with `ALERT: ... has no mapped Automayt order` (code `amazon_period_unmapped`) and creates nothing.
- **Receipts post or fail as a whole,** at the PO line cost. A receipt priced differently is refused (422). A received PO can't be cancelled through the API.

## Rehearsal

```
node scripts/automayt/beta1-e2e.js        # every API call shape
node scripts/automayt/replay-on-beta1.js  # the real flows, ERP_BACKEND=automayt
```

The replay takes the newest real Amazon order in `../run-orders/data/ops-state` (read-only, buyer replaced with placeholders) plus Shopify and FBA fixtures from the sku-map, runs each twice (the second pass must create nothing) and writes `data/automayt-e2e/replay-<run>.json`. Test-only env it sets: `AUTOMAYT_REF_OVERRIDES` (stand-in ids for records the environment lacks) and `AUTOMAYT_TEST_CODE_PREFIX=ROTEST-`; both are refused against production.

`beta1-e2e` runs every call shape run-orders uses on beta1 or staging (refuses production) and writes `data/automayt-e2e/<run>.json` with each step and its `request_id`s. Test records use refs under system `run-orders-test` and vendor codes starting `ROTEST-`. Where the environment lacks a CFC vendor or the Amazon Fulfillment location, a demo record stands in and the report lists it.

First full pass: 2026-10-01 on beta1, 22 of 22 steps, run `261001172010`. Replay: 6 of 6 flows, run `261001173350` (real 2026-07-28 DITRA-PS order, 3 parcels, 269 sqft each). Replay with tax as charged: 7 of 7 flows, run `261014173421` (BC Shopify fixture books GST 7.17 + PST 10.02, total 160.43 = Shopify's).

**Found on beta1:** a per-order tax exemption is stamped on the lines sent with the create, and lines added later through `POST /sales-orders/{id}/lines` are taxable unless the call repeats `tax_treatment`. `addToAmazonPeriodSo` now sends it on every add (request `req_20417913a907408eb0e3918d7d4176e6` shows the taxed case).

## Facts settled 2026-10-01 (updated 2026-10-14)

- **No QuickBooks after cutover.** Automayt is CFC's books, so channel orders must carry the tax CFC owes (see **Tax**) and are invoiced in Automayt.
- **Production IP.** The Mini's public address is 64.180.67.80 (TELUS, can change). On `403 ip_not_allowed` the client adds the host's current public IP to the error.

## Cutover steps (Nov 1)

1. Set `AMAZON_PERIOD_ANCHOR=2026-10-22` (the period open at go-live; it is also the guard's line: that period and earlier are never opened by run-orders in production).
2. **Before the first Nov 1 pass, map the migrated Amazon period order once:** find the migrated Oct 22 - Nov 4 order in Automayt, then `node scripts/automayt/channel-tax.js map-period --period 2026-10-22 --so <SO number>` (dry run: prints the order) and, after confirming it is that period's order, the same with `--confirm`. A mapping can never be re-pointed, so map only the confirmed record. Without it the guard refuses every Oct 22 - Nov 4 parcel and alerts.
3. Map the six fixed records (above) and set `ERP_BACKEND=automayt`.

## Tax

**Who owes what** (verified against live data 2026-10-14):

- **Shopify:** CFC charges destination GST/HST plus BC PST on BC deliveries only, shipping taxed, and remits all of it. Shopify remits nothing.
- **Amazon.ca:** Amazon withholds and remits **every provincial tax** as marketplace facilitator: QST in QC, PST in BC and SK, RST in MB. Share of tax collected, Apr to Oct 2026: QC 66.6%, BC and MB 58.3%, SK 54.5%, and 0% in the HST provinces, AB and the territories. CFC is GST/HST-registered, so GST (or HST) is CFC's: collected minus withheld. CFC books none of the withheld tax; it is kept on the record, by province and type, only as proof Amazon remitted it. Amazon.com (US) sales are US tax withheld in full: flagged separately, never folded in.
- **Automayt** computes destination tax from `ship_to_region` and adds QST, SK PST and MB RST that CFC doesn't charge (seen on beta1: a QC order got GST + QST). So run-orders never lets it compute: every Shopify line carries **`tax_charged`**, the tax Shopify actually charged on it by code, which Automayt books exactly (`[]` = none). This is in Automayt's contract on beta1 (2026-10-14) and proven there: the replay's BC order books GST 7.17 + PST 10.02 = Shopify's total to the cent. `AUTOMAYT_TAX_AS_CHARGED=0` falls back to an exempt order with the tax only in our record, for an environment without it.

**Shopify SO (replaces Lynnae's per-order PDF + "Adj for fees, taxes and freight" line).** `createShopifySoPo` reads the order's money from Shopify (`channel-tax-io.fetchShopifyOrderMoney`; fails closed, no SO, if it can't) and sends: each line at what the customer paid (after discounts; an area item is its Shopify line total over the converted sqft, not the catalogue price), a `freight` line per shipping line, sample lines as description lines (no PO), `tax_charged` on every line, `ship_to_region`, and a note with subtotal, shipping, tax by code, total and the processing fee. `results.moneyCheck` compares the SO with Shopify's total. The **processing fee is recorded, not booked**: whether it nets against revenue (Lynnae's way today) or goes to an expense account is the accountant's call. PayPal reports no fee to Shopify, so those orders say the fee is unknown.

**Shopify refunds.** Automayt's API refuses negative qty and negative price and has no credit-note endpoint (beta1 2026-10-14). `reconcileShopifyRefund` / `channel-tax.js shopify-refunds --from --to [--apply]` cancels an SO refunded in full before invoicing (the fee stays in the note) and reports every other refund as `credit-note-pending` with its lines and tax by code. Open with Aaron.

**Amazon period tax close (replaces the Date Range CSV autosum and the "PST remitted by Amazon" file).** `channel-tax.js amazon-close --period <start>` pulls the period's transactions from the SP-API Finances API (2024-06-19 `listTransactions`; the Date Range report itself can't be requested through the API) over the whole 14-day period in Pacific days, and counts them the way Seller Central's Date Range report does: deferred originals count, their later releases don't. Writes `data/channel-tax/amazon/<start>.json` and `.csv`: tax collected, refunded, withheld by Amazon by province and type, CFC's GST/HST by code, and the net Lynnae adjusts the period SO to (total without transfers, minus every tax column). Provinces come from the analytics DB's `amazon_orders.ship_state` (normalised) then the Orders API; a miss is coded by the effective rate and flagged. A period is refused until 3 days after it ends unless `--provisional`. Windows default to US Pacific (`AMAZON_REPORT_TZ=America/Los_Angeles`, which falls back to PST on Nov 1, 2026 while BC stays at UTC-7): check the first November period with `amazon-compare` against Seller Central's CSV and set `AMAZON_REPORT_TZ=Etc/GMT+7` if Amazon.ca stays at UTC-7. `--post` adds CFC's GST/HST to the period order as one tax-only line (qty 1, price 0, `tax_charged` GST/HST, ref `tax:<start>`); Automayt books it even on the order's exempt lines (beta1). Withheld tax is never posted.

**Verified against Lynnae's numbers 2026-10-14** (`scripts/automayt/verify-channel-tax.js`, read-only): all 10 Amazon periods May 7 to Sep 23 match her attached Date Range CSVs to the cent on product sales, tax collected, withheld, CFC tax and net, and the net equals the period SO total she adjusted to. `amazon-compare --csv <file>` repeats the check for any downloaded report. Shopify: of the 63 orders she adjusted Aug to Sep 2026, 43 match subtotal + shipping - fee to the cent (4 of them after refunds); the other 20 are her side, not the formula: 13 SO-price drifts her fee-only adjustment leaves behind (12 at $0.01 to $0.03, #1392 at $0.13), 2 PayPal orders (no fee in Shopify; #1377 refunded outside Shopify), fees swapped between #1361 and #1363 ($0.30 each way), and 3 orders with two SOs (#1366, #1376, #1387). 7 SOs she created with no order number (samples, cancellations) can't be matched.

**Open:** credit notes or a refund path in the API; how Automayt wants the processor fee booked; Amazon period SO lines are still priced from the item (as in Salesforce), so the revenue side of the period order stays an accounting question like the fee.

## Waiting on Automayt before staging

- Vendors Prosol, Treeco and the carriers, and a virtual Amazon Fulfillment location: the API can't create vendors or locations.
- `PO-16xxx` and `SO-025xxx` numbering. beta1 issues `PO-0213` and `SO-0078`.
