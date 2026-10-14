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

**One import, nothing subtracted (Mac, 2026-10-14).** Automayt doesn't migrate the Salesforce item master; it imports only quantities on hand (QOH). Every product that passes the rule goes in this one import, including the ones Salesforce already has. Automayt's QOH load then matches onto these items by vendor code. Whichever of the two runs second must match by vendor code and never create a duplicate. On our side that's covered by the batch-lookup before each create plus `createItem`'s 409 handling. The Salesforce match is information for the QOH load (`qoh-crosswalk.csv`), never a reason to skip a product.

Three scripts, all built so the run can be repeated:

| Script | What it does | Network |
|---|---|---|
| `scripts/automayt/prosol-catalog-pull.js` | Lists (`--phase=lists`): manufacturers, categories, every product (250 a page), every in-stock branch row (1,000 a page), then `catalog.json`. Costs (`--phase=costs`): one offers call per passing product, `--rps=1`, `--limit=N`, resumable. Salesforce (`--phase=sf`): read-only PBSI item codes. | Prosol (read-only), Salesforce (read-only) |
| `scripts/automayt/prosol-catalog-report.js` | Counts, conflicts, the Salesforce crosswalk. CSVs: `to-import.csv` (Salesforce match as info columns), `qoh-crosswalk.csv`, `conflicts.csv` (scope `import` or `qoh`), `sf-prosol-unmatched.csv` | none |
| `scripts/automayt/prosol-catalog-import.js` | Dry run by default. `--apply` creates the missing items; `--sync` re-checks imported items against a newer snapshot (PATCHes cost changes with `--apply`, only reports products that fell below the rule or were discontinued) | Automayt |

Snapshots live in `data/prosol-catalog/<date>/` (gitignored). The import progress file (`import-<env>.jsonl`) records each product's outcome: created, exists, duplicate, ambiguous, skipped or error. A re-run skips the finished ones.

**Mapping** (`lib/prosol-catalog.js toItemInput`, tested). Products whose Prosol code is shared with another passing product are held, because Automayt would link the second one to the first one's item; `conflicts.csv` (scope `import`) lists them. At import time, a match on an existing Automayt item that is a short code on another vendor's item, or that is ambiguous, is also held for a person.
- `vendor_code` is Prosol's code, stripped the run-orders way (no `/` or `-`), which is what `autoCreateItem` writes and the order flows look up.
- `item_number` is the maker's code, stripped.
- The raw Prosol code, the maker's code (when it differs, as with Aqua Mix and Mapei) and the barcode are added as aliases.
- The Prosol product id is an external ref (`system: prosol`).
- `unit` is `each`, meaning Prosol's selling unit: the piece, roll, carton or pack a Prosol PO line orders. Products Prosol prices by area or length keep the measure in the description ("- 60 SqFt", "- 5 LnFt"), where `lib/pbsi-uom.js` reads coverage from.
- Cost is our Prosol offer; retail is the offer's regular price, falling back to msrp.
- Category is mapped from Prosol's category tree to Automayt's ten categories (`CATEGORY_RULES`, default Accessories).
- `stock_status` is `Special Order`.

**Never a duplicate.** Each product's codes go through `POST /items/batch-lookup` against whatever Automayt already has: items auto-created by an order, seeded, or loaded by the QOH import if it ran first. The codes tried are Prosol's code, its leading-zero form and the maker's code, each also slash-stripped; then the same codes as item numbers, never short numbers. The outcomes:
- matched: the item exists, so it's recorded and not created.
- matched, but a short code on another vendor's item: held as a conflict.
- ambiguous: held for a person.
- not found: created with `Idempotency-Key: item-<vendorCode>`. A 409 duplicate counts as done, unless the existing item belongs to another vendor; then it's held as a conflict.

If the QOH load runs first and creates items itself, ours come back as "matched" and don't get the Prosol external ref, aliases or our cost. Ask Automayt to load QOH onto our items rather than create its own.

`prosol-catalog-report.js` matches the catalogue offline against a read-only Salesforce pull. It's information only: the crosswalk for the QOH load.

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
| share a Prosol code with another passing product, held for a person (`conflicts.csv` scope `import`) | 22 (11 codes) |
| **to import, in one run** | **10,921** |

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
- The 22 shared Prosol codes still block those products. One vendor code can't be two items, whatever Salesforce has.
- The 19 Salesforce duplicates and 15 short-code coincidences no longer block anything. Salesforce items don't become Automayt items, so these products are imported. They matter only to the QOH load: sum or pick for the 19, and keep the 15 apart.
- The Salesforce items claimed by two Prosol products are now 3 (5 counted products the rule drops). That's QOH only.

Matching by Salesforce item Name was tried and dropped. Every one of the 355 Name matches was a short number (CFC's own item numbering, e.g. 05961), and 342 were different products: a Rubi drill bit "matched" an Engineered Floors carpet. Short-number codes now never match by item number, and a maker's code that's a short number isn't looked up (`isShortNumeric`).

**Checks.**
- Branch counts against Prosol's live inventory (`sync_inventory=true`): 29 of 30 sampled products had the same count, and all 30 landed on the same side of the rule.
- Cost slice of 300 spread across the importable list: 299 priced. 283 priced at Burnaby, 16 needed a second branch and 1 a third. The median cost is 0.70 × msrp. The slice averaged about 2 s a product at `--rps=1`.

**Run time for the one import (10,921 products).**
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
3. Run `prosol-catalog-report.js`. A person settles the 22 shared Prosol codes (`conflicts.csv` scope `import`). Hand `qoh-crosswalk.csv` and the `qoh` conflicts to Automayt for their load.
4. Dry run against production.
5. `--apply --production`.
6. After that, run `--sync` weekly.

Open with Automayt: `drafts/automayt-prosol-catalogue-ask.md` in cfc-projects/06-salesforce-exit.
