# Prosol direct-order API — our payload

Call 2026-07-30 with Leo (Prosol tech), Daniela, and Prosol ops: Leo stands up a
draft webhook and sends us the URL; we POST an example payload; Prosol maps it to
Tecsys and tells us which fields are required, which are ignored, and what
completes an order on their side. Transcript: Mac has the recording; summary in
memory `project_prosol_direct_integration`.

## What the payload is

One JSON document per order = exactly what our pipeline already knows at buy time
(see `lib/audit.js` buy-label records + `lib/emailer.js` warehouse email). Every
field below is generated today, no new data collection needed.

| Field | Source in pipeline | Notes |
|---|---|---|
| `sender.prosol_customer_number` | constant `55010180` | our Prosol account |
| `order.reference` | ShipStation `orderNumber` prefixed `CFC-` | unique, idempotency key |
| `order.po_number` | SF PO (`pos.byTracking`) | our PO the order bills to |
| `order.branch.code` | warehouse mapping (`prosol-location-map.json`) | branch that holds the stock |
| `order.lines[]` | sku-map `prosol_sku` + qty | Prosol's own SKUs, slashes intact |
| `order.ship_to` | ShipStation ship-to | ALWAYS the real customer address (their explicit ask on the call) |
| `shipping.packages[]` | label buy record (tracking, weight, dims per package) | multi-package orders send one waybill per package |
| `shipping.documents` | label PDF + packing slip | waybill only — **no BOL** (their ask) |

`mode: "label_provided"` states our current model: we buy the label, they pick,
apply, and tender. If Prosol later takes over label buying (parked topic from the
call), `mode` gains a second value and `packages[].tracking_number` becomes
theirs to fill.

## Files

- `example-order-single.json` — the common case: one line, one package.
- `example-order-multipackage.json` — one line split across 3 waybills
  (DITRA-PS rolls); the case branch staff get wrong most often by hand.

Both are fictional samples for mapping. Production payloads carry real ship-to.

## Open questions for Prosol (send with the payload)

1. Which of these fields are REQUIRED to complete an order in Tecsys, which are
   ignored? What's missing?
2. Acknowledgement: what does the webhook return (order id? error shape?), and is
   there a status callback (accepted / picked / tendered) or do we poll?
   If Prosol ever generates the waybill (Eric's shipping-takeover track), the
   tracking number must come back the moment the label exists — Amazon's ship-by
   promise breaks on any delay. Instant tracking-back is the gate for that model.
3. How do documents travel — base64 in the payload, URLs we host, or keep
   emailing PDFs alongside for now?
4. Idempotency: if we retry a POST after a timeout, does `order.reference`
   dedupe it?
5. Cross-province ship-from: orders intentionally ship from whichever branch
   holds stock (e.g. QC branch → BC customer). Confirm the API path doesn't trip
   the VAT-region block that has bitten manual orders (`project_prosol_vat_region_block`).

## Status

- [x] Call done, draft-webhook promised (Leo)
- [ ] Leo sends draft URL
- [ ] We POST `example-order-single.json`, then the multi-package one
- [ ] Prosol returns required-field verdict; we adjust
- [ ] Wire into pipeline behind a flag (shadow: POST alongside the email flow)
