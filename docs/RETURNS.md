# Amazon.ca returns autopilot

`lib/amazon-returns-autopilot.js` (policy + state), `lib/amazon-returns-io.js` (Amazon, ShipStation, email),
`lib/amazon-return-sf.js` (Salesforce RMAs). Runs from `server.js` every 2 hours, 06:40-16:40 BC.

**Why (2026-10-07):** the last three seller ratings were 1 star, all Aqua Mix, all about returns. Amazon.ca gives
merchant-fulfilled buyers an *unpaid* label (`Label type: AmazonUnPaidLabel` on every row of the returns report,
even when `Label to be paid by: Seller`), so buyers paid $21-$25 to mail back a $50-$100 bottle and then waited on us.

## What happens to each open return

| Return | Action |
|---|---|
| Refund at or under **$60**, or a consumable (sealer, cleaner, grout, silicone...) at or under **$150** | Refund now, email the buyer to keep it |
| Buyer already shipped it on Amazon's label | Refund now |
| Anything else | Purolator return label to the branch that shipped it, emailed to the buyer as a PDF; Kaitlyn gets a heads-up; refund on Purolator's first scan (on delivery above **$300**) |
| Label quote is **35%** or more of the refund | Refund without return instead |
| A-to-Z claim, unauthorised purchase, refund over **$600**, label over **$30**, past **$1,000** of auto refunds today, no branch/address | Held: Mac gets one email with a one-tap approve link (or "handle in Seller Central" when a tap can't settle it) |

All thresholds are env vars (`RETURNS_RETURNLESS_MAX`, `RETURNS_CONSUMABLE_MAX`, `RETURNS_AUTO_REFUND_MAX`,
`RETURNS_DAILY_REFUND_CAP`, `RETURNS_LABEL_MAX`, `RETURNS_LABEL_SHARE_MAX`, `RETURNS_DELIVERED_REFUND_ABOVE`,
`RETURNS_WINDOW_DAYS`, `RETURNS_MAX_REFUNDS_PER_RUN`, `RETURNS_UNUSED_LABEL_DAYS`).

Two lines of one order are refunded together in one feed. A refund that does not confirm is held for Seller Central
and never retried; `scripts/ops/issue-refund.js` keeps its per-order lock in `data/refund-attempts/`.

## Switches

- `RETURNS_AUTOPILOT_LIVE=1`: refunds, labels, buyer and Prosol emails, Mac's email. Without it the server runs in
  SHADOW and writes what it would do to `data/returns-autopilot-shadow.json`; nothing is sent or spent.
- `RETURNS_SF_LIVE=1`: create the Salesforce RMAs. Without it they are only planned.
- Approve links are signed with `RETURNS_APPROVE_SECRET` (falls back to `SKU_RESOLVER_SECRET`).

## Money and messages

- **Refunds** go only through `scripts/ops/issue-refund.js` `run()`: item-level, `CustomerReturn`, the amount
  pinned to the preview, evidence naming this policy. Run on the Mini only (its `data/audit.jsonl` is the duplicate guard).
- **Labels**: ShipStation V2 `POST /v2/labels`, `is_return_label`, ship_from = customer, ship_to = branch, weight
  only (never dimensions). Re-rated at purchase; voided if the charge comes in well over the quote.
- **Buyer emails** go to the Amazon relay address on the ShipStation order, From "CustomFlooring" (the Amazon.ca
  store name) via hello@yourfloors.ca, reply-to hello@. Amazon only relays from approved senders: if hello@ is not on
  Seller Central's messaging permissions list, the first one bounces.
- **Prosol heads-up** (Mac 2026-10-07, "prosol should know"): one email to Kaitlyn per label going to a Prosol branch,
  cc Mac: item, PO, Amazon ref, return tracking, "please receive and credit". No customer address.
- **Mac** gets one email per run, only when something was done, needs him, or failed.

## Salesforce

Same records Lynnae builds by hand:
1. Case, Return Type **From Customer**, account Amazon.ca, the order's period SO, From Location Amazon Fulfillment,
   one RMA line per item against its SO line (qty in Salesforce units, so area items scale).
2. Label returns to Prosol also get a Case, Return Type **To Vendor**, account Prosol, the original PO, linked through
   `mm_Customer_RMA__c`, RMA lines on the PO lines. Prosol's credit matches against this.

Both are created New with nothing received. RMAs have no invocable receive action, and writing the received quantity
directly skips the Movement Journal (the 2026-05 PO receipt trap), so the Receive click stays in Salesforce.

## By hand

```sh
node scripts/ops/returns-autopilot.js            # SHADOW dry run
node scripts/ops/returns-autopilot.js --sf       # + the Salesforce records each would get
node scripts/ops/returns-autopilot.js --state    # what the live autopilot has done
node scripts/ops/returns-autopilot.js --approve=702-1234567-1234567
node --test lib/amazon-returns-autopilot.test.js
```

`scripts/ops/returns-triage.js` and `returns-label.js` (2026-08) are the older read-only triage and a label
buyer that never ran live; the autopilot replaces both.
