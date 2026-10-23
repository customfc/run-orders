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

**Shadow mode** starts the mirror only after Salesforce has answered and can't change or fail that result. Every error is caught; a mirror still running after `AUTOMAYT_SHADOW_TIMEOUT_MS` (default 90000) is abandoned. Each mirror writes one `automayt-shadow` line to `data/audit.jsonl` and adds `automaytShadow: { ok, error, soNumber, poNumber, requestIds }` to the result. It writes to Automayt what cutover would: the Shopify SO + Prosol PO, Amazon period-SO lines + one PO per parcel received into Amazon Fulfillment, FBA sales as period-SO lines, FBA stock POs. Amazon shares one ShipStation fetch between both backends. Shadow never emails anyone.

**Turning shadow on (staging, after Automayt seeds Prosol, Treeco and Amazon Fulfillment):** in the Mini's `.env` set `AUTOMAYT_API_BASE=https://staging.automayt.dev/api/v1`, `AUTOMAYT_API_KEY=<staging key>`, `ERP_BACKEND=automayt-shadow`; map the six fixed records once under system `run-orders` (`node scripts/automayt/map-fixed.js`: status with candidates, then `map <name> <id> --confirm`); restart. Step by step for the day a key arrives: `scripts/automayt/test-day.md`. Off again: remove `ERP_BACKEND`, restart.

**Deliberate differences from Salesforce:** no fuzzy title or code-prefix item match (a miss auto-creates from the sku-map or goes to review); a vendor code shared by two items stops the line; PO lines carry the item cost (the Salesforce Shopify flow wrote the sale price there); a Shopify order whose SO already exists is skipped, as in Salesforce, but the guard can only see SOs that carry `channel: shopify` and the order number, so staff entering a Shopify order by hand in Automayt must fill both.

## Rules the code depends on

- **Fixed records are external refs, never ids in code.** System `run-orders`, keys `shopify-house`, `amazon-house`, `prosol`, `treeco`, `sechelt-warehouse`, `amazon-fulfillment`. A mapping can never be re-pointed, so map only the real record.
- **Idempotency keys come from our ids** (`shopify-<order>-so`, `amazon-<tracking>-po`, `amazon-<tracking>-rcv`, `fba-<draft>-po`), and the body under a key must be deterministic. A date of "now" in a retried body gets `422 idempotency_key_reused` instead of a replay, so dates come from the order.
- **`409 duplicate` means already done.** Read the existing record from `details.existing_id`. A failed dedupe read throws; it never means "no match".
- **Sales orders are `procurement_mode: external`.** Automayt must never raise its own POs or reserve stock for our orders.
- **POs are `status: confirmed`.** run-orders tells the vendor itself; Automayt never emails on create, and we never call `/send`.
- **Amazon period order:** one sales order per 14-day payout window on Salesforce's own schedule (Sep 24 - Oct 7, Oct 8 - 21, Oct 22 - Nov 4, ...), `external_ref` `period:<start date>`, windows counted from Salesforce's 2026-10-22 period (`AMAZON_PERIOD_ANCHOR` overrides it, for test environments; any period start gives the same windows). Each parcel adds its lines with `external_line_ref` `<tracking>:<n>` (one PO per parcel, and a multi-package order has several), so a re-run skips them. Every add repeats the GST/PST exemption. The period lookup checks a `sales_order` external ref `period:<start>` under system `run-orders` first, then the order's own channel and external_ref.
- **Split at cutover (Mac, 2026-10-19).** The period holding `AMAZON_CUTOVER_DATE` (default 2026-11-01) is cut there: Oct 22 - 31 stays on the Salesforce order, Automayt's first Amazon order is `period:2026-11-01` (Nov 1 - 4), and whole 14-day periods resume Nov 5. In production a parcel whose ship date is before the cutover fails with `ALERT: ... belongs to Salesforce` (code `amazon_period_salesforce`) and creates nothing, so the last Salesforce pass must take every parcel shipped by Oct 31. `amazon-close --period 2026-10-22` gives Lynnae the Oct 22 - 31 figures for the Salesforce order (`--post` refuses it); `--period 2026-11-01 --post` posts Nov 1 - 4 to Automayt.
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

1. Make sure the last Salesforce pass (Oct 31) has taken every Amazon parcel shipped by Oct 31; from Nov 1 those are refused.
2. Map the six fixed records (`node scripts/automayt/map-fixed.js`, above) and set `ERP_BACKEND=automayt`. The first November parcel opens `period:2026-11-01` (Nov 1 - 4).
3. After Oct 31 settles (Nov 3 or later): `node scripts/automayt/channel-tax.js amazon-close --period 2026-10-22` for the Salesforce Oct 22 - 31 order. After Nov 4 settles: `amazon-close --period 2026-11-01 --post`.

The day a key arrives: `scripts/automayt/test-day.md` (staging and production, step by step).

## Tax

**Who owes what** (verified against live data 2026-10-14):

- **Shopify:** CFC charges destination GST/HST plus BC PST on BC deliveries only, shipping taxed, and remits all of it. Shopify remits nothing.
- **Amazon.ca:** Amazon withholds and remits **every provincial tax** as marketplace facilitator: QST in QC, PST in BC and SK, RST in MB. Share of tax collected, Apr to Oct 2026: QC 66.6%, BC and MB 58.3%, SK 54.5%, and 0% in the HST provinces, AB and the territories. CFC is GST/HST-registered, so GST (or HST) is CFC's: collected minus withheld. CFC books none of the withheld tax; it is kept on the record, by province and type, only as proof Amazon remitted it. Amazon.com (US) sales are US tax withheld in full: flagged separately, never folded in.
- **Automayt** computes destination tax from `ship_to_region` and adds QST, SK PST and MB RST that CFC doesn't charge (seen on beta1: a QC order got GST + QST). So run-orders never lets it compute: every Shopify line carries **`tax_charged`**, the tax Shopify actually charged on it by code, which Automayt books exactly (`[]` = none). This is in Automayt's contract on beta1 (2026-10-14) and proven there: the replay's BC order books GST 7.17 + PST 10.02 = Shopify's total to the cent. `AUTOMAYT_TAX_AS_CHARGED=0` falls back to an exempt order with the tax only in our record, for an environment without it.

**Shopify SO (replaces Lynnae's per-order PDF + "Adj for fees, taxes and freight" line).** `createShopifySoPo` reads the order's money from Shopify (`channel-tax-io.fetchShopifyOrderMoney`; fails closed, no SO, if it can't) and sends: each line at what the customer paid (after discounts; an area item is its Shopify line total over the converted sqft, not the catalogue price), a `freight` line per shipping line, sample lines as description lines (no PO), `tax_charged` on every line, `ship_to_region`, and a note with subtotal, shipping, tax by code, total and the processing fee. `results.moneyCheck` compares the SO with Shopify's total. The **processing fee is recorded, not booked**: whether it nets against revenue (Lynnae's way today) or goes to an expense account is the accountant's call. PayPal reports no fee to Shopify, so those orders say the fee is unknown.

**Shopify refunds.** Automayt's API refuses negative qty and negative price. Its accounting has credit notes (Steph, 2026-10-19), but the API only makes one through `POST /sales-orders/{id}/cancel`, which voids open invoices and credits paid ones (`credit_note_ids`). `reconcileShopifyRefund` / `channel-tax.js shopify-refunds --from --to [--apply]` cancels an SO refunded in full, invoiced or not (the fee stays in the note), and reports a partial refund as `credit-note-pending` with its lines and tax by code. A credit note with lines and `tax_charged` is open with Aaron.

**Amazon period tax close (replaces the Date Range CSV autosum and the "PST remitted by Amazon" file).** `channel-tax.js amazon-close --period <start>` pulls the period's transactions from the SP-API Finances API (2024-06-19 `listTransactions`; the Date Range report itself can't be requested through the API) over the whole 14-day period in Pacific days, and counts them the way Seller Central's Date Range report does: deferred originals count, their later releases don't. Writes `data/channel-tax/amazon/<start>.json` and `.csv`: tax collected, refunded, withheld by Amazon by province and type, CFC's GST/HST by code, and the net Lynnae adjusts the period SO to (total without transfers, minus every tax column). Provinces come from the analytics DB's `amazon_orders.ship_state` (normalised) then the Orders API; a miss is coded by the effective rate and flagged. A period is refused until 3 days after it ends unless `--provisional`. Windows default to US Pacific (`AMAZON_REPORT_TZ=America/Los_Angeles`, which falls back to PST on Nov 1, 2026 while BC stays at UTC-7): check the first November period with `amazon-compare` against Seller Central's CSV and set `AMAZON_REPORT_TZ=Etc/GMT+7` if Amazon.ca stays at UTC-7. `--post` adds CFC's GST/HST to the period order as one tax-only line (qty 1, price 0, `tax_charged` GST/HST, ref `tax:<start>`); Automayt books it even on the order's exempt lines (beta1). Withheld tax is never posted.

**Verified against Lynnae's numbers 2026-10-14** (`scripts/automayt/verify-channel-tax.js`, read-only): all 10 Amazon periods May 7 to Sep 23 match her attached Date Range CSVs to the cent on product sales, tax collected, withheld, CFC tax and net, and the net equals the period SO total she adjusted to. `amazon-compare --csv <file>` repeats the check for any downloaded report. Shopify: of the 63 orders she adjusted Aug to Sep 2026, 43 match subtotal + shipping - fee to the cent (4 of them after refunds); the other 20 are her side, not the formula: 13 SO-price drifts her fee-only adjustment leaves behind (12 at $0.01 to $0.03, #1392 at $0.13), 2 PayPal orders (no fee in Shopify; #1377 refunded outside Shopify), fees swapped between #1361 and #1363 ($0.30 each way), and 3 orders with two SOs (#1366, #1376, #1387). 7 SOs she created with no order number (samples, cancellations) can't be matched.

**Amazon period order at Amazon's actual prices (Melanie, 2026-10-19).** Each parcel's lines carry what Amazon charged: the ShipStation item's `unitPrice` x quantity (it matched the SP-API order items on all 24 orders checked 2026-10-19), split across a bundle's components by catalogue value, cents exact, and spread over sq ft for area items (`priceAmazonLines`). The shipping the buyer paid goes on as one description-only `delivery` line per Amazon order (ref `<order>:ship`, so the parcels of a multi-package order add it once). An item with no ShipStation price falls back to the catalogue price with a warning on the result. Not on the order: promotional rebates (a few dollars a period) and refunds.

**FBA sales on the period order (Mac, 2026-10-23: "yes build it").** Amazon ships FBA orders from stock we sent ahead, so they never pass through ShipStation or the parcel flow. After the parcels, `createAmazonPOs` (Automayt backend only, so shadow and cutover both get it) adds them from the SP-API Finances API (2024-06-19 `listTransactions`, the same source as the tax close): every `Shipment` transaction whose items are `AFN`, counted the way the Date Range report counts them (`countsLikeDateRange`: a deferred original on the day Amazon shipped it, never its later release), on its Pacific day (`AMAZON_REPORT_TZ`). Lines are priced like a parcel's: Amazon's principal (`ProductCharges`) through `priceAmazonLines`, plus one `delivery` line for the shipping the buyer paid (shipping charged less any shipping discount). A $0 principal (a replacement) is a $0 line, never the catalogue price. Refs `fba:<order>:<shipment>:<n>` and `fba:<order>:<shipment>:ship`; the lines key is `amazon-<period>-fba:<order>:<shipment>-lines`. Items are found like a parcel's: the ASIN in the sku-map, then the seller SKU with and without `-FBA`, else the bare code is looked up (never auto-created). A sale goes on whole or not at all: one unresolved item sends nothing and reports `fba-sales` in the result's errors (never a halt). A sale already on its period's order is skipped without a write. No PO: the units went into Amazon Fulfillment with the FBA restock PO. In production a sale before the cutover is skipped (Salesforce period). Results sit in `result.fba` so the PO counts stay POs. Window `AMAZON_FBA_LOOKBACK_DAYS` (default 7, by posted date); off with `AUTOMAYT_FBA_SALES=0`. Sep 24 - Oct 7 it was about $1.7k of $12.2k in Amazon orders.

The tax close doesn't change: it already counted FBA sales (its source is every transaction), FBA lines carry no tax (the order is exempt), and CFC's GST/HST stays the one tax-only `tax:<start>` line. **Stock doesn't leave Amazon Fulfillment:** sales order lines move no stock and the API has no shipment, fulfilment or adjustment call (gaps 7 and 10 in the Aaron list), so FBA sales can't take units out, and each parcel receipt adds units there that never leave.

**Fees (2026-10-19):** expensed, not netted. One entry per Amazon and Shopify payout (fees by type to Digital Operating Expenses, GST/HST on them to 2311, deposit to the bank) once Automayt has a journal-entry call (asked of Aaron). Accounts: GST/HST Payable 2310, GST/HST ITC 2311, PST Payable 2315. Shopify Payments fees carry no GST; Amazon's do.

**Open:** a partial-refund credit note; a journal-entry call for the payout fees; taking stock out of Amazon Fulfillment for Amazon sales (FBA and parcels).

## Waiting on Automayt before staging

The running list of API gaps for Aaron is `drafts/automayt-api-gaps-for-aaron.txt` in cfc-projects/06-salesforce-exit. Add to it there. Steph dropped negative fee lines (2026-10-19): the processing fee total goes in a sales order header field he is adding, which for Amazon needs a header update at period close (gap 6).

- Vendors Prosol, Treeco and the carriers, and a virtual Amazon Fulfillment location. The API takes `POST /vendors` and `POST /locations` since 2026-10-23, but these are Automayt's records to set up. CFC's beta1 tenant (2026-10-23) has "Prosol Inc.", "Treeco" and an "Amazon Fulfillment" warehouse that isn't flagged virtual, and no Shopify or Amazon house customer yet (only the `[rehearsal]` pair the day replay set up under `run-orders-test`).
- Vendor codes on Automayt's own items. CFC's beta1 tenant has 3,212 items numbered `PRD-0001`.. with no `vendor_code` (2026-10-23). run-orders finds items by vendor code or item number only (batch-lookup takes nothing else), so it can't find them, auto-creates duplicates, and fails `409 DUPLICATE_BARCODE` where the barcode is already on a `PRD-` item (Schluter `KBKIT` = `PRD-2502`).
- `PO-16xxx` and `SO-025xxx` numbering. beta1 issues `PO-0213` and `SO-0078`.

## Prosol catalogue

Every product Prosol is actively selling becomes an Automayt item, so an order, quote or PO for any Prosol product finds its item without the order flows having to auto-create it. **Rule (Mac, 2026-10-14): a product is imported when it has stock at two or more Prosol branches.** It must also not be discontinued at Prosol, and it needs a cost. Each record keeps its branch count and the as-of date, so a later sync can apply the rule again.

**One import, nothing subtracted (Mac, 2026-10-14).** Automayt doesn't migrate the Salesforce item master; it imports only quantities on hand (QOH). Every product that passes the rule goes in this one import, including the ones Salesforce already has. Automayt's QOH load then matches onto these items by vendor code. Whichever of the two runs second must match by vendor code and never create a duplicate. On our side that's covered by the batch-lookup before each create plus `createItem`'s 409 handling. The Salesforce match is information for the QOH load (`qoh-crosswalk.csv`), never a reason to skip a product.

Three scripts, all built so the run can be repeated:

| Script | What it does | Network |
|---|---|---|
| `scripts/automayt/prosol-catalog-pull.js` | Lists (`--phase=lists`): manufacturers, categories, every product (250 a page), every in-stock branch row (1,000 a page), then `catalog.json`. Costs (`--phase=costs`): one offers call per passing product, `--rps=1`, `--limit=N`, resumable. Salesforce (`--phase=sf`): read-only PBSI item codes. | Prosol (read-only), Salesforce (read-only) |
| `scripts/automayt/prosol-catalog-report.js` | Counts, conflicts, the Salesforce crosswalk. CSVs: `to-import.csv` (Salesforce match as info columns), `qoh-crosswalk.csv`, `conflicts.csv` (scope `import` or `qoh`), `sf-prosol-unmatched.csv` | none |
| `scripts/automayt/prosol-catalog-import.js` | Dry run by default. `--apply` creates the missing items; `--sync` re-checks imported items against a newer snapshot (PATCHes cost changes with `--apply`, only reports products that fell below the rule or were discontinued) | Automayt |

Snapshots live in `data/prosol-catalog/<date>/` (gitignored). The import progress file (`import-<env>.jsonl`) records each product's outcome: created, exists, duplicate, ambiguous, skipped or error. A re-run skips the finished ones.

**Mapping** (`lib/prosol-catalog.js toItemInput`, tested). Two passing products can't share a Prosol code (Automayt would link the second to the first one's item). When the code AND the price match, it's one product listed twice: `resolveCollisions` imports the listing Prosol updated most recently and carries the others' barcodes as aliases and their ids as extra `prosol` external refs (2026-10-14: all 11 such codes were Perfect Level Master T-Lock parts listed again as "PTX Group - Lash and Wedge Kit"; all 11 merge into the Perfect Level Master listing). Same code at a different price is held (`conflicts.csv` scope `import`). At import time, a match on an existing Automayt item that is a short code on another vendor's item, or that is ambiguous, is also held for a person.
- `vendor_code` is Prosol's code, stripped the run-orders way (no `/` or `-`), which is what `autoCreateItem` writes and the order flows look up.
- `item_number` is the maker's code, stripped.
- The raw Prosol code, the maker's code (when it differs, as with Aqua Mix and Mapei) and the barcode are added as aliases.
- The Prosol product id is an external ref (`system: prosol`).
- **Flooring is per square foot or foot (Mac, 2026-10-14: "flooring is never sold by the carton").** For LVP, Laminate, Carpet, Tile and Hardwood with a Prosol pricing measure, `unit` is `sqft` or `lnft`, cost and retail are divided by the coverage, and `box_quantity` is the coverage. Prosol's price is for the whole tile, carton or roll (offers checked 2026-10-14: RT38S $47.32 for a 4 sq ft tile = $11.83/sq ft; TW55 $237.25 for a 50 ft roll = $4.745/ft). Flooring with no coverage in Prosol's data (209 products, mostly Tarkett commercial) is left out (`flooring-no-coverage.csv`; `--include-flooring-without-coverage` brings them in per piece). LVP and Carpet require lots in Automayt; a per sq ft LVP create works on beta1 (stocking_unit sqft, box_quantity 4).
- Everything else is `each`, meaning Prosol's selling unit: the piece, roll, box or pack a Prosol PO line orders. The measure stays in the description ("- 60 SqFt", "- 5 LnFt").
- Cost is our Prosol offer; retail is the offer's regular price, falling back to msrp.
- Category is mapped from Prosol's category tree to Automayt's ten categories (`CATEGORY_RULES`, default Accessories). Mac, 2026-10-14: tools, trims, shower parts etc. stay under Accessories (a category can be changed later with PATCH).
- `brand` = `manufacturer` = the maker (190 makers; Schluter 2,307, M-D PRO 860, Mapei 578...).
- `stock_status` is `Special Order`.

**Never a duplicate.** Each product's codes go through `POST /items/batch-lookup` against whatever Automayt already has: items auto-created by an order, seeded, or loaded by the QOH import if it ran first. The codes tried are Prosol's code, its leading-zero form and the maker's code, each also slash-stripped; then the same codes as item numbers, never short numbers. The outcomes:
- matched: the item exists, so it's recorded and not created.
- matched, but a short code on another vendor's item: held as a conflict.
- ambiguous: held for a person.
- not found: created with `Idempotency-Key: item-<vendorCode>`. A 409 duplicate counts as done, unless the existing item belongs to another vendor; then it's held as a conflict.

If the QOH load runs first and creates items itself, ours come back as "matched" and don't get the Prosol external ref, aliases or our cost. Ask Automayt to load QOH onto our items rather than create its own.

`prosol-catalog-report.js` matches the catalogue offline against a read-only Salesforce pull. It's information only: the crosswalk for the QOH load.

**Guards.** `--apply` against beta1 needs `AUTOMAYT_TEST_CODE_PREFIX` (e.g. `ROTEST-`), so the real catalogue never lands in a shared test tenant. Staging takes the real codes only with `--real-codes` (CFC's own test tenant; confirm with Aaron first). `--ids=1,2` limits a run to those Prosol product ids. Production needs `--production` and a live key, and refuses the test-only settings. Writes are paced to the key's `write_per_minute` from `/whoami`, minus 5. The transport now reports each response's `x-ratelimit-*` window.

**Prosol API facts (2026-10-14):**
- `append=is_clearance` returns a 504 at any page size, so clearance isn't pulled.
- `include=productOffers` returns every Prosol customer's offers (about 3,000 per product, 6 MB). Don't use it.
- Our price exists only on `/products/{id}/offers`, one product per call. Multi-product filters return a 500 or are ignored.
- Offers exist only at branches that carry the product, and prices are regional. The cost pull tries Burnaby (10010), then the BC branch with the most stock, then any stocking branch, and records which branch priced it.
- On raw `/product_inventory_items` rows, `available` is the unit count. The "always 1" flag in `project_prosol_stock_total_bug` is the derived `inStock` in `checkInventory`.

**Automayt API facts (beta1, standard tier):**
- Limits per minute: 300 reads, 60 writes, 30 batch, 10 export, 8 concurrent.
- `PATCH /items/{id}` exists (`items:update`; changing cost also needs `items:read_cost`). Setting `stock_status` to "Discontinued" runs Automayt's discontinue steps.
- Items have no custom field, so the branch count and as-of date live in our snapshot and progress files, not on the item.

**Numbers, snapshot 2026-10-14** (`data/prosol-catalog/2026-10-14/report.json`):

| | Products |
|---|---|
| Prosol catalogue (the storefront lists only active products, so `filter[active]=1` changes nothing) | 57,068 |
| Active and not discontinued (the old default) | 53,670 |
| Stock at 1 or more branches | 19,413 |
| Stock at exactly 1 branch | 7,448 |
| **Stock at 2 or more branches (the rule)** | **11,965** |
| of which discontinued at Prosol, left out | 1,022 |
| Importable | 10,943 |
| share a Prosol code with another passing product: same price, merged into one item each | 11 codes (11 listings folded in) |
| share a Prosol code at a different price, held for a person | 0 |
| flooring with no coverage in Prosol's data, left out (`flooring-no-coverage.csv`) | 209 |
| flooring per sq ft / ft (coverage known) | 29 (25 sq ft, 4 ft) |
| **to import, in one run** | **10,723** (10,694 each, 25 sq ft, 4 ft) |

Salesforce, for information (`qoh-crosswalk.csv`, `conflicts.csv` scope `qoh`). None of these stops the import:

| | |
|---|---|
| Salesforce items / with vendor Prosol | 12,993 / 3,013 |
| Imported products with exactly one Salesforce match (Vendor Item ID) | 2,094 (37 under another vendor, e.g. Bona via Treeco) |
| Match two or more Salesforce items (legacy duplicates). Their QOH lands on one item, so the load must sum or pick | 19 |
| Short Prosol code also on another vendor's Salesforce item (e.g. Crain 341 and an ERV item 341). That QOH is a different product and must not be matched by code | 15 |
| Salesforce items claimed by two imported products. The QOH belongs to one | 3 |
| Salesforce Prosol items matching no current Prosol code, so their QOH has no item to land on | 464 |
| Salesforce Prosol items whose product isn't imported (below the rule or discontinued), so likewise no item | 458 |

How the earlier 56 conflicts changed meaning once nothing is subtracted:
- The 22 shared-code products were 11 Perfect Level Master parts listed twice; each pair now merges into one item (same code, same price).
- The 19 Salesforce duplicates and 15 short-code coincidences no longer block anything. Salesforce items don't become Automayt items, so these products are imported. They matter only to the QOH load: sum or pick for the 19, and keep the 15 apart.
- The Salesforce items claimed by two Prosol products are now 3 (5 counted products the rule drops). That's QOH only.

Matching by Salesforce item Name was tried and dropped. Every one of the 355 Name matches was a short number (CFC's own item numbering, e.g. 05961), and 342 were different products: a Rubi drill bit "matched" an Engineered Floors carpet. Short-number codes now never match by item number, and a maker's code that's a short number isn't looked up (`isShortNumeric`).

**Checks.**
- Branch counts against Prosol's live inventory (`sync_inventory=true`): 29 of 30 sampled products had the same count, and all 30 landed on the same side of the rule.
- Cost slice of 300 spread across the importable list: 299 priced. 283 priced at Burnaby, 16 needed a second branch and 1 a third. The median cost is 0.70 × msrp. The slice averaged about 2 s a product at `--rps=1`.

**Run time for the one import (10,723 products).**
- Cost pull (`--phase=costs`): 10,622 still to price (299 done) at about 2 s a product at `--rps=1` is about 5.9 hours, resumable. Run it overnight, and never alongside another Prosol-heavy job.
- Creates at 55 a minute: about 3.3 hours (3.0 at the full 60). Lookups add a few minutes: about 85 batch calls against a 30-a-minute limit, interleaved.
- About 9 to 10 hours end to end. Both steps can be resumed, so they can be split across two nights.

**beta1 rehearsal (2026-10-14, `ROTEST-` codes, Prosol stand-in Pacific Tile & Stone):**
- 200 products: 199 created, 1 found existing (the e2e's `ROTEST-KEBA100/125/10M`, found via the stripped `KEBA10012510M`). 0 errors, 0 rate-limit hits, 3.6 minutes.
- Re-run with the progress file moved aside: 200 of 200 found, nothing created.
- Sync against a simulated next-day snapshot: 2 cost changes PATCHed, then restored. 1 discontinued product and 1 below-rule product reported, not changed.
- Reusing a create key with a different body returns 422 `idempotency_key_reused`. The importer records it as an error and the next run finds the item.

**Production run order:**
1. Production key, Prosol vendor mapped. The run doesn't need to wait for Automayt's QOH load, and should preferably go before it, so the load lands on our items.
2. Run `--phase=lists`, then `--phase=sf` on the same day, then `--phase=costs` overnight.
3. Run `prosol-catalog-report.js`. Check `conflicts.csv` scope `import` is empty (shared codes at the same price merge on their own). Hand Automayt the 54 QOH exceptions (`qoh` conflicts: two Salesforce items for one product, or a short code on a different product); everything else matches by vendor code, ignoring dashes and spaces, QOH only.
4. Dry run against production.
5. `--apply --production`.
6. After that, run `--sync` weekly.

Open with Automayt: `drafts/automayt-prosol-catalogue-ask.md` in cfc-projects/06-salesforce-exit.
