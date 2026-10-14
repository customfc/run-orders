# run-orders on Automayt

Automayt replaces Salesforce as CFC's system of record (target cutover about 2026-10-09).
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

## The switch: `ERP_BACKEND`

| Value | What happens |
|---|---|
| `salesforce` (default, also when unset) | Today's Salesforce flows, unchanged. Automayt code isn't even loaded. |
| `automayt-shadow` | Salesforce exactly as today, then the same order mirrored to Automayt. |
| `automayt` | Automayt only. Cutover. |

An unknown value throws, so a typo stops the pos phase loudly instead of guessing.

**Shadow mode** starts the mirror only after Salesforce has answered and can't change or fail that result. Every error is caught; a mirror still running after `AUTOMAYT_SHADOW_TIMEOUT_MS` (default 90000) is abandoned. Each mirror writes one `automayt-shadow` line to `data/audit.jsonl` and adds `automaytShadow: { ok, error, soNumber, poNumber, requestIds }` to the result. It writes to Automayt what cutover would: the Shopify SO + Prosol PO, Amazon period-SO lines + one PO per parcel received into Amazon Fulfillment, FBA stock POs. Amazon shares one ShipStation fetch between both backends. Shadow never emails anyone.

**Turning shadow on (staging, after Automayt seeds Prosol, Treeco and Amazon Fulfillment):** in the Mini's `.env` set `AUTOMAYT_API_BASE=https://staging.automayt.dev/api/v1`, `AUTOMAYT_API_KEY=<staging key>`, `AMAZON_PERIOD_ANCHOR=<start of the Salesforce Amazon period open that day>`, `ERP_BACKEND=automayt-shadow`; map the six fixed records once under system `run-orders` (`erp.mapRef`); restart. Off again: remove `ERP_BACKEND`, restart.

**Deliberate differences from Salesforce:** no fuzzy title or code-prefix item match (a miss auto-creates from the sku-map or goes to review); a vendor code shared by two items stops the line; PO lines carry the item cost (the Salesforce Shopify flow wrote the sale price there); a Shopify order whose SO already exists is skipped, as in Salesforce, but the guard can only see SOs that carry `channel: shopify` and the order number, so staff entering a Shopify order by hand in Automayt must fill both.

## Rules the code depends on

- **Fixed records are external refs, never ids in code.** System `run-orders`, keys `shopify-house`, `amazon-house`, `prosol`, `treeco`, `sechelt-warehouse`, `amazon-fulfillment`. A mapping can never be re-pointed, so map only the real record.
- **Idempotency keys come from our ids** (`shopify-<order>-so`, `amazon-<tracking>-po`, `amazon-<tracking>-rcv`, `fba-<draft>-po`), and the body under a key must be deterministic. A date of "now" in a retried body gets `422 idempotency_key_reused` instead of a replay, so dates come from the order.
- **`409 duplicate` means already done.** Read the existing record from `details.existing_id`. A failed dedupe read throws; it never means "no match".
- **Sales orders are `procurement_mode: external`.** Automayt must never raise its own POs or reserve stock for our orders.
- **POs are `status: confirmed`.** run-orders tells the vendor itself; Automayt never emails on create, and we never call `/send`.
- **Amazon period order:** one sales order per 14-day payout window, `external_ref` `period:<start date>`, windows counted from `AMAZON_PERIOD_ANCHOR` (the start of the Salesforce period open at cutover). Each parcel adds its lines with `external_line_ref` `<tracking>:<n>` (one PO per parcel, and a multi-package order has several), so a re-run skips them. Every add repeats the GST/PST exemption.
- **Receipts post or fail as a whole,** at the PO line cost. A receipt priced differently is refused (422). A received PO can't be cancelled through the API.

## Rehearsal

```
node scripts/automayt/beta1-e2e.js        # every API call shape
node scripts/automayt/replay-on-beta1.js  # the real flows, ERP_BACKEND=automayt
```

The replay takes the newest real Amazon order in `../run-orders/data/ops-state` (read-only, buyer replaced with placeholders) plus Shopify and FBA fixtures from the sku-map, runs each twice (the second pass must create nothing) and writes `data/automayt-e2e/replay-<run>.json`. Test-only env it sets: `AUTOMAYT_REF_OVERRIDES` (stand-in ids for records the environment lacks) and `AUTOMAYT_TEST_CODE_PREFIX=ROTEST-`; both are refused against production.

`beta1-e2e` runs every call shape run-orders uses on beta1 or staging (refuses production) and writes `data/automayt-e2e/<run>.json` with each step and its `request_id`s. Test records use refs under system `run-orders-test` and vendor codes starting `ROTEST-`. Where the environment lacks a CFC vendor or the Amazon Fulfillment location, a demo record stands in and the report lists it.

First full pass: 2026-10-01 on beta1, 22 of 22 steps, run `261001172010`. Replay: 6 of 6 flows, run `261001173350` (real 2026-07-28 DITRA-PS order, 3 parcels, 269 sqft each).

**Found on beta1:** a per-order tax exemption is stamped on the lines sent with the create, and lines added later through `POST /sales-orders/{id}/lines` are taxable unless the call repeats `tax_treatment`. `addToAmazonPeriodSo` now sends it on every add (request `req_20417913a907408eb0e3918d7d4176e6` shows the taxed case).

## Facts settled 2026-10-01

- **No QuickBooks after cutover.** Automayt is CFC's books, so channel orders must carry the tax CFC owes (see below) and are invoiced in Automayt.
- **Tax.** Shopify charges destination GST/HST plus BC PST on BC deliveries only, shipping taxed; Shopify remits nothing. On Amazon, Amazon remits BC PST (marketplace facilitator) but CFC is GST/HST-registered, so GST/HST is CFC's (Amazon passes it through in the settlement). Automayt computes destination tax from `ship_to_region` but also adds QST, SK PST and MB RST, which CFC doesn't charge. How Amazon GST/HST lands in Automayt is open with Automayt (one order per Amazon order, or booked from settlements).
- **Amazon cutover window.** Salesforce's open Amazon order is SO-026232 "Sep 24 - Oct 7"; Automayt's first is `period:2026-10-08`, so `AMAZON_PERIOD_ANCHOR=2026-10-08`.
- **Production IP.** The Mini's public address is 64.180.67.80 (TELUS, can change). On `403 ip_not_allowed` the client adds the host's current public IP to the error.

## Waiting on Automayt before staging

- Vendors Prosol, Treeco and the carriers, and a virtual Amazon Fulfillment location: the API can't create vendors or locations.
- `PO-16xxx` and `SO-025xxx` numbering. beta1 issues `PO-0213` and `SO-0078`.

## Prosol catalogue

Every product Prosol is actively selling becomes an Automayt item, so an order, quote or PO for any Prosol product finds its item without the order flows having to auto-create it. **Rule (Mac, 2026-10-14): a product is imported when it has stock at two or more Prosol branches.** It must also not be discontinued at Prosol, and it needs a cost. Each record keeps its branch count and the as-of date, so a later sync can apply the rule again.

Three scripts, all built so the run can be repeated:

| Script | What it does | Network |
|---|---|---|
| `scripts/automayt/prosol-catalog-pull.js` | Lists (`--phase=lists`): manufacturers, categories, every product (250 a page), every in-stock branch row (1,000 a page), then `catalog.json`. Costs (`--phase=costs`): one offers call per passing product, `--rps=1`, `--limit=N`, resumable. Salesforce (`--phase=sf`): read-only PBSI item codes. | Prosol (read-only), Salesforce (read-only) |
| `scripts/automayt/prosol-catalog-report.js` | Counts, Salesforce dedupe, CSVs (`to-import.csv`, `in-salesforce.csv`, `conflicts.csv`, `sf-prosol-unmatched.csv`) | none |
| `scripts/automayt/prosol-catalog-import.js` | Dry run by default. `--apply` creates the missing items; `--sync` re-checks imported items against a newer snapshot (PATCHes cost changes with `--apply`, only reports products that fell below the rule or were discontinued) | Automayt |

Snapshots live in `data/prosol-catalog/<date>/` (gitignored). The import progress file (`import-<env>.jsonl`) records each product's outcome: created, exists, duplicate, ambiguous, skipped or error. A re-run skips the finished ones.

**Mapping** (`lib/prosol-catalog.js toItemInput`, tested). Products whose Prosol code is shared with another product are skipped, because Automayt would link the second one to the first one's item. So are short codes already on another vendor's item, and matches against two or more existing items; `conflicts.csv` lists them.
- `vendor_code` is Prosol's code, stripped the run-orders way (no `/` or `-`), which is what `autoCreateItem` writes and the order flows look up.
- `item_number` is the maker's code, stripped.
- The raw Prosol code, the maker's code (when it differs, as with Aqua Mix and Mapei) and the barcode are added as aliases.
- The Prosol product id is an external ref (`system: prosol`).
- `unit` is `each`, meaning Prosol's selling unit: the piece, roll, carton or pack a Prosol PO line orders. Products Prosol prices by area or length keep the measure in the description ("- 60 SqFt", "- 5 LnFt"), where `lib/pbsi-uom.js` reads coverage from.
- Cost is our Prosol offer; retail is the offer's regular price, falling back to msrp.
- Category is mapped from Prosol's category tree to Automayt's ten categories (`CATEGORY_RULES`, default Accessories).
- `stock_status` is `Special Order`.

**Dedupe.** The import runs after the Salesforce item migration lands in production, and creates only what isn't there. Each product's codes go through `POST /items/batch-lookup` (Prosol code, maker code, leading-zero form, each also slash-stripped). The outcomes:
- matched: the item already exists, so it's skipped and recorded.
- ambiguous: left for a person.
- not found: created with `Idempotency-Key: item-<vendorCode>`. A 409 duplicate counts as done.

`prosol-catalog-report.js` makes the same comparison offline against a read-only Salesforce pull.

**Guards.** `--apply` against beta1 or staging needs `AUTOMAYT_TEST_CODE_PREFIX` (e.g. `ROTEST-`), so the real catalogue never lands in a shared test tenant. Production needs `--production` and a live key, and refuses the test-only settings. Writes are paced to the key's `write_per_minute` from `/whoami`, minus 5. The transport now reports each response's `x-ratelimit-*` window.

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
| already a Salesforce item (matched on Vendor Item ID; migrates, skipped) | 2,094 (37 under another vendor, e.g. Bona via Treeco) |
| match 2+ Salesforce items (legacy duplicates), for a person | 19 |
| short Prosol code already on another vendor's item, for a person | 15 |
| share a Prosol code with another passing product, for a person | 22 (11 codes) |
| **new, to import** | **8,793** |

Salesforce has 12,993 items, 3,013 with vendor Prosol. Of those 3,013, 464 match no current Prosol code (dead or mistyped codes) and 423 belong to products that fail the rule; they migrate anyway, and `--sync` can flag them later. Conflicts are listed in `conflicts.csv`.

Matching by Salesforce item Name was tried and dropped. Every one of the 355 Name matches was a short number (CFC's own item numbering, e.g. 05961), and 342 were different products: a Rubi drill bit "matched" an Engineered Floors carpet. Short-number codes now never match by item number, and a maker's code that's a short number isn't looked up (`isShortNumeric`).

**Checks.**
- Branch counts against Prosol's live inventory (`sync_inventory=true`): 29 of 30 sampled products had the same count, and all 30 landed on the same side of the rule.
- Cost slice of 300 spread across the importable list: 299 priced. 283 priced at Burnaby, 16 needed a second branch and 1 a third. The median cost is 0.70 × msrp. The slice averaged about 2 s a product at `--rps=1`.

**Run time.**
- Cost pull for the 8,793 new products (`--phase=costs --skip-in-salesforce`): about 5 hours at 1 request a second, resumable. Run it overnight; never run it alongside another Prosol-heavy job.
- Creates at 55 a minute: about 2.7 hours for 8,793.

**beta1 rehearsal (2026-10-14, `ROTEST-` codes, Prosol stand-in Pacific Tile & Stone):**
- 200 products: 199 created, 1 found existing (the e2e's `ROTEST-KEBA100/125/10M`, found via the stripped `KEBA10012510M`). 0 errors, 0 rate-limit hits, 3.6 minutes.
- Re-run with the progress file moved aside: 200 of 200 found, nothing created.
- Sync against a simulated next-day snapshot: 2 cost changes PATCHed, then restored. 1 discontinued product and 1 below-rule product reported, not changed.
- Reusing a create key with a different body returns 422 `idempotency_key_reused`. The importer records it as an error and the next run finds the item.

**Production run order:**
1. The Salesforce item migration lands in production.
2. Run `--phase=lists`, then `--phase=sf` on the same day, then `--phase=costs --skip-in-salesforce` overnight.
3. Run `prosol-catalog-report.js`. A person settles `conflicts.csv`.
4. Dry run against production.
5. `--apply --production`.
6. After that, run `--sync` weekly.

Open with Automayt: `drafts/automayt-prosol-catalogue-ask.md` in cfc-projects/06-salesforce-exit.
