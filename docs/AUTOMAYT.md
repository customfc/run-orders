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

## Rules the code depends on

- **Fixed records are external refs, never ids in code.** System `run-orders`, keys `shopify-house`, `amazon-house`, `prosol`, `treeco`, `sechelt-warehouse`, `amazon-fulfillment`. A mapping can never be re-pointed, so map only the real record.
- **Idempotency keys come from our ids** (`shopify-<order>-so`, `amazon-<tracking>-po`, `amazon-<tracking>-rcv`, `fba-<draft>-po`), and the body under a key must be deterministic. A date of "now" in a retried body gets `422 idempotency_key_reused` instead of a replay, so dates come from the order.
- **`409 duplicate` means already done.** Read the existing record from `details.existing_id`. A failed dedupe read throws; it never means "no match".
- **Sales orders are `procurement_mode: external`.** Automayt must never raise its own POs or reserve stock for our orders.
- **POs are `status: confirmed`.** run-orders tells the vendor itself; Automayt never emails on create, and we never call `/send`.
- **Amazon period order:** one sales order per 14-day payout window, `external_ref` `period:<start date>`, windows counted from `AMAZON_PERIOD_ANCHOR` (the start of the Salesforce period open at cutover). Each parcel adds its lines with `external_line_ref` `<amazon order>:<n>`, so a re-run skips them.
- **Receipts post or fail as a whole,** at the PO line cost. A receipt priced differently is refused (422). A received PO can't be cancelled through the API.

## Rehearsal

```
node scripts/automayt/beta1-e2e.js
```

Runs every call run-orders makes on beta1 or staging (refuses production) and writes `data/automayt-e2e/<run>.json` with each step and its `request_id`s. Test records use refs under system `run-orders-test` and vendor codes starting `ROTEST-`. Where the environment lacks a CFC vendor or the Amazon Fulfillment location, a demo record stands in and the report lists it.

First full pass: 2026-10-01 on beta1, 22 of 22 steps, run `261001172010`.

## Waiting on Automayt before staging

- Vendors Prosol, Treeco and the carriers, and a virtual Amazon Fulfillment location: the API can't create vendors or locations.
- `PO-16xxx` and `SO-025xxx` numbering. beta1 issues `PO-0213` and `SO-0078`.
