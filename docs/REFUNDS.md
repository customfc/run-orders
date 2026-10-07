# Amazon merchant-fulfilled refund script

`scripts/ops/issue-refund.js` defaults to preview only. A scope and reason are mandatory. Old commands that supplied just an order/reason now fail before loading credentials.

## Preview

Use Amazon **OrderItemId**, not ASIN, SKU, label or tracking number. Repeated `--item` flags select different lines; the number after the colon is the quantity to refund from that line.

```sh
node scripts/ops/issue-refund.js --order=123-1234567-1234567 --reason=CouldNotShip --item=12345678901234:1
```

To inspect the whole order and its item IDs, explicitly preview a full refund:

```sh
node scripts/ops/issue-refund.js --order=123-1234567-1234567 --reason=CustomerReturn --full
```

Full and item selection cannot be combined. Selecting every unit through `--item` also requires switching to `--full`. Neither preview submits anything.

## Submit an approved refund

After checking the preview, append `--commit`, the exact approved `--expected-total` in CAD, and an `--evidence` description identifying the parcel/item facts and Mac's approval reference. Example only:

```sh
node scripts/ops/issue-refund.js --order=123-1234567-1234567 --reason=CouldNotShip --item=12345678901234:1 --commit --expected-total=123.45 --evidence="Branch confirmed this item remains there; sibling delivered; approval reference ..."
```

The expected amount must match the calculated refund exactly. The evidence field records the operator's basis; the script cannot determine whether that evidence or approval is true. Check all parcels, messages, returns and claims before approving. Customer silence and empty tracking do not prove fulfillment or non-delivery.

Line amounts returned by Amazon cover the entire ordered quantity. For a selected quantity, the script prorates principal, tax, shipping and shipping tax separately, rounding each component half-up to cents. Only selected lines appear in the feed, with explicit `ActionType=Refund` and the selected `Quantity`. This supports item/quantity refunds, not discretionary dollar-only adjustments. The XML fields and reason codes were checked against [Amazon's OrderAdjustment schema](https://images-na.ssl-images-amazon.com/images/G/01/rainier/help/xsd/release_1_9/OrderAdjustment.xsd).

Supported scope is CAD/MFN orders with status Shipped, PartiallyShipped or Unshipped. Promotions, gift-wrap/COD charges, inconsistent totals, currency mismatches and incomplete responses stop for manual review. The script checks all order-item and financial-event pages, requires item charges to reconcile exactly to the order total, and refuses existing refunds, A-to-z financial events or chargebacks. Further refunds after an earlier partial refund require manual reconciliation; no override is provided.

## Duplicate prevention and outcomes

Run commits from the production host with its complete `data/audit.jsonl` history. Both earlier audit submissions and `data/refund-attempts/<order>.json` block new attempts. The exclusive attempt record is written before feed operations and retained after success, failure, crash or timeout. The document ID is saved before submission; the feed ID, item allocation, evidence and processing report are saved when available.

This lock protects concurrent runs on the same host/data directory. It cannot coordinate separate hosts, Seller Central actions or other refund tools. Financial records can lag, so use a single operational refund writer and reconcile other activity first.

If an attempt fails or times out, **do not blindly retry or delete the record**. Check the saved document/feed IDs, Amazon's processing report and payment transactions. An accepted request may have succeeded despite a lost response. There is deliberately no automatic unlock or force option. If Amazon proves no refund was created, preserve the failed attempt and evidence before a human-controlled reset; otherwise resolve through Seller Central.

A feed being accepted or reaching DONE is not enough: the script requires a processing report confirming one successful message and zero errors. Pending, failed or unreadable results exit nonzero and retain retry protection. A successful processing report still needs payment-ledger reconciliation.

## Validation

```sh
node --test lib/amazon-refund.test.js
```

Tests use synthetic orders, a temporary data directory and mocked APIs. They never load production credentials or submit refunds.
