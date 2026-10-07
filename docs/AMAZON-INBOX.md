# Amazon buyer messages

`lib/amazon-inbox.js` (parsing, policy, state `data/amazon-inbox.json`), `scripts/ops/amazon-inbox.js` (Graph mailbox,
SP-API, ShipStation, Claude), scheduled from `server.js` every 30 min, 06:00-20:30 BC.

**Why (2026-10-07):** Amazon buyer messages land in hello@yourfloors.ca. The YourFloors CS agent that read them was
switched off on 10-02 (Prosol confirmations buried it), so four buyer messages went past Amazon's 24 h response window
and the account averaged 69.9 h. This reads Amazon mail only, so supplier traffic can't bury it.

## What it does with each new Amazon message

1. Ignores anything that isn't from `@marketplace.amazon.ca` (buyer and Amazon CS threads) or an A-to-z notice.
2. Skips threads hello@ already replied to. A "thanks" message is NOT skipped: Amazon still counts it against the 24 h
   response clock, so it gets a one-line acknowledgement (carded, or sent on its own with `AMAZON_INBOX_AUTOSEND_THANKS=1`).
3. Gathers the order's facts: Amazon status, items and cancel requests, every ShipStation shipment (split children
   too) with live tracking, refunds and A-to-z money, and what the returns autopilot did.
4. Opus drafts the reply from those facts only (French for French buyers), following the email rules: plain text, no
   em dashes, no phone, no links, no supplier names, never asks for feedback, apologises only for our own mistakes,
   promises a refund/replacement/label only when it already happened (otherwise it flags "needs your OK").
5. Mac gets one email per run: what the buyer wrote, the facts, the draft and a Send link. The link opens the draft in
   an editable box; Send replies in the Amazon thread from hello@.
6. A carded message still unanswered after 18 h is listed once more ("still unanswered").
7. A-to-z notices are carded with the facts and "answer in Seller Central".

## Switches

- `AMAZON_INBOX_LIVE=1`: record state and email Mac the cards. Without it the server does nothing.
- `AMAZON_INBOX_AUTOSEND=1`: send "where is my order" answers automatically when every shipment has a carrier scan and
  no item has a cancel request. Off until Mac gives that standing OK.
- `AMAZON_INBOX_START` (ISO time): ignore messages received before it, so going live doesn't card old threads that were
  answered in Seller Central (those replies are invisible to hello@).
- Send links are signed with `RETURNS_APPROVE_SECRET` / `SKU_RESOLVER_SECRET`. `YF_CS_DIR` points at the yourfloors-cs
  checkout whose Graph login reads hello@.

## By hand

```sh
node scripts/ops/amazon-inbox.js           # dry run: drafts for every unanswered Amazon message, sends nothing
node scripts/ops/amazon-inbox.js --state
node --test lib/amazon-inbox.test.js
```
