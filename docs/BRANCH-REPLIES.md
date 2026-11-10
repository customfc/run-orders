# Prosol branch replies

`lib/branch-replies.js`, CLI `scripts/ops/branch-replies.js`, cron + Send route in `server.js`.

## Why
Every weekday the pipeline emails each Prosol branch's orders to Kaitlyn from hello@ ("Order - Concord (WCON)",
audit `pipeline-email-prosol`). She relays to the branch, and branch staff reply-all. Nothing read those replies (the
yourfloors-cs desk skips all @prosol.ca mail by design). On 2026-11-06 Concord wrote "we dont have KP27-01
available" and #1449 sat for 4 days; on 2026-11-04 Kaitlyn's "@mac please advise ... 1 box?" went unanswered.

## What it does
Every 15 min, weekdays 07:00-18:00 BC, it reads hello@ (all folders, Graph via the yourfloors-cs login) for mail from
@prosol.ca whose subject matches `Order - <Branch> (<CODE>)`, including the Zendesk form `[Prosol Inc] Re: Re: ...`.
For each new reply:

1. **New text only.** Cuts the quoted thread (`____`, `From:`, `On ... wrote:`, `De :`), signature links and
   `<mailto:>` tails. For the Zendesk form, keeps only the newest comment.
2. **Classify** with Opus (`claude-opus-5-5`): `ack`, `cant_ship` (with the codes named), `question`, `other`.
   Code guard: stock words (don't have, out of stock, not available, no stock, backorder, short, discontinued,
   cannot be allocated, inventory adjusted) or a question to us (`?`, "please advise", "willing to wait", `@mac`)
   never stay `ack`; they become `other` at minimum.
3. **Tie to orders.** The thread's first message is our send (SMTP lands in Sent Items). The tie is the newest
   `pipeline-email-prosol` entry for that branch code at or before it (15 min slack), with the orders read from
   `data/ops-state/` (labels, packages, POs) and the sku-map (`api_sku`, `prosol_sku`). Order refs, POs and tracking
   numbers the thread quotes narrow it (or find an older send that has them); a named SKU narrows it again. Any
   doubt is written on the card as "NOT SURE of this tie: ..." and never guessed silently.
4. **Act.**
   - `ack`: audit `branch-reply` only. No email.
   - `cant_ship`: live Prosol stock per branch (`getMappingInfo(api_sku)` or the pinned `prosol_product_id`, then
     `getInventoryByLocation`), only active, shippable Prosol branches. Pick: never the branch that said no, holds
     at least the order qty, `>= 2` first (thin stock), then the customer's ship-to province (ShipStation), then
     distance. Draft to Kaitlyn, worded as Mac approved on 2026-11-10: "Concord let us know they don't have
     KP27-01. Could you send #1449 (1x KP27-01 ...) from Ottawa instead? They show 7 in stock. Same Purolator
     label, tracking 520861603352, PO-017709." The label is reused; we never relabel or void. No branch with
     stock: the card says so and offers no send. A vendor-error line (`not_shipped`) is logged once per
     order + SKU (skipped when the ledger already has one).
   - `question` / `other`: card with their words, the tied orders and an Opus draft to Kaitlyn.
5. **Card** = one email to Mac per reply, with a Send link (`/branch-replies/send?k=..&t=..`). GET shows the draft
   in an editable box; POST sends it. Mac can also just reply from his own mail.

## Send
Graph `createReplyAll` on the branch's message, then the body is set to plain text (Mac's text plus a short quote
of their words), To = Kaitlyn only, CC = mac@customfc.ca, BCC empty; every attachment on the draft is deleted
(createReplyAll copies inline signature images). The draft is re-read and must be in the same conversation with
exactly one To (Kaitlyn), CC Mac only, no BCC, no attachments, or it is deleted and nothing is sent. After Send it
must show in hello@ Sent Items before the card is marked sent. One send per key: a second tap shows "Already
sent"; a send that went out but was not seen in Sent Items stays `sending` and refuses another tap for 10 minutes
(check Sent Items first). Audit `branch-reply-sent`. There is no autosend.

## Flags
- `BRANCH_REPLIES_LIVE=1`: cards to Mac + vendor-error lines. Without it the cron runs in SHADOW: classify, tie,
  draft, state + audit only, no emails. Replies seen in shadow keep status `shadow` and are not carded later.
- `BRANCH_REPLIES_OFF=1`: the cron does nothing.
- Uses `ANTHROPIC_API_KEY`, `RETURNS_APPROVE_SECRET` (or `SKU_RESOLVER_SECRET`) for the link token, `YF_CS_DIR`,
  `KAITLYN_EMAIL`, `MAC_CC_EMAIL`, `RUN_ORDERS_PUBLIC_URL`, the Prosol and ShipStation keys the pipeline already has.

## State
`data/branch-replies-state.json`: `lastSeenAt` (each pass lists from 15 min before it), `messages` (one entry per
reply with kind, tie, draft, status `ack` / `carded` / `shadow` / `sending` / `sent` / `retry` / `error`),
`vendorErrors` (order|sku already logged). The first run starts from now: no backfill. A reply that fails 3 passes
is carded as "could not process" (live).

## CLI
```
node scripts/ops/branch-replies.js --since=2026-10-10T00:00:00Z --dry [--out=/tmp/replay.json]   # replay, writes and sends nothing
node scripts/ops/branch-replies.js --state
node scripts/ops/branch-replies.js --read-test="we dont have KP27-01 available"
```
The dry replay still calls Opus and reads live Prosol stock and ShipStation (read-only). Run it on the Mini, where
`data/audit.jsonl` and `data/ops-state/` are current.
