# YourFloors Order Prep — "Run-Orders"

**Trigger phrases:** "Run-Orders", "prep orders", "process orders", "do the orders", "do the amazon orders", "run the orders", "ship the orders" — basically anything that means "process today's shipments"
**Codeword to execute:** `go` (or `ship it`)
**Hard rule:** NEVER buy labels, send emails, or touch Salesforce without explicit `go`. Present plan first. Always.

---

## Overview

Full order-to-warehouse flow. Every step in sequence, no skipping.

---

## STEP 1 — Pull Orders

```
GET /orders?orderStatus=awaiting_shipment&pageSize=50
```

- All channels treated equally (Amazon, Shopify, manual)
- For each order, capture: orderId, orderNumber, shipTo (full address), items (SKU, name, qty), weight, dimensions
- **Dimensions NOTE:** ShipStation stores dims in cm but API returns `units: "inches"` — DO NOT pass dimensions to carriers. Use weight-only. Passing dims causes massive overbilling (learned hard way April 2).

Report: N orders found, list them.

---

## STEP 2 — Check Prosol Inventory

Use **ProsolClientV2** (Puppeteer-based) — NOT the simple HTTP client in fulfillment-pipeline.js (that's broken, cross-subdomain cookie issue).

Credentials: use `PROSOL_EMAIL` / `PROSOL_PASSWORD` environment variables

**SKU resolution:**
- ShipStation item `.sku` field = Amazon ASIN (e.g. `B071VFHLJS`)
- Look up in `scripts/shipstation/sku-map.json` → `mappings[ASIN]` → `{api_sku, prosol_sku}`
- Use `api_sku` for Prosol inventory lookup via `filter[sku]=`
- If ASIN not in SKU map: try matching from item title/description — verified matches only, NO guesses, skip if uncertain

**Known non-Prosol items (ship from CFC / manual handling unless verified otherwise):**
- Bona products
- Temporary Floor Protector
- Perfect Level Master

**Routing correction learned Apr 8, 2026:**
- **RedGard is a Prosol item** (Custom Building Products RedGard Pink 1 gal, manufacturer SKU `CLLQWAF1`, Prosol web SKU shown as `CLQWAF1-2`). Do **not** treat RedGard as non-Prosol. Check Prosol inventory/rates like other Prosol items.

**Main hubs (check first):**
| Prosol Location ID | Warehouse | Province |
|---|---|---|
| 10004 | Saint-Laurent | QC |
| 10010 | Burnaby | BC |
| 10054 | Calgary | AB |
| 10001 | Concord (Vaughan) | ON |

Fallback: if main hubs OOS, check nearest secondary Prosol location to delivery postal code.

---

## STEP 3 — Rate Shop

Rate shop from stocked warehouse(s) to customer postal code. **Weight only — no dimensions.**

**Carriers to check:** `ups_walleted`, `canada_post_walleted`, `purolator_walleted`, `canpar_walleted`

**Carrier selection rules:**
1. Get rates for ALL THREE: UPS, Purolator, Canada Post
2. Pick cheapest of UPS vs Purolator — that's your winner
3. Canada Post: ONLY wins if it beats BOTH UPS and Purolator by >$4
4. Canada Post ALWAYS for PO Boxes (no exceptions)
5. UPS free pickup via ShipStation V2 API
6. Purolator pickup via ShipStation V2 API (needs pickup_address in payload)

**❌ Never pick CP just because it ties or barely beats UPS/Puro — the threshold is $4 gap**

**Warehouse consolidation:** if shipping multiple orders from same region, prefer same warehouse even if slightly higher cost (fewer pickups = less management overhead).

---

## STEP 4 — Present Plan

Preferred command:
```bash
cd /Users/fred/.openclaw/workspace/scripts/shipstation && npm run run-orders
```

Optional preview-only mode:
```bash
cd /Users/fred/.openclaw/workspace/scripts/shipstation && npm run run-orders -- --dry-run
```

This script is **Run-Orders prep**, not just a hypothetical planner. It must:
- pull `awaiting_shipment` from ShipStation V1
- keep only the Amazon CA → Prosol run scope
- include Perfect Level items only when they have an explicit supported non-Prosol routing rule; otherwise flag for manual review
- use `ProsolClientV2` (browser session), not the old direct-login HTTP path
- rate-shop with **weight only** and the exact carrier rule:
  - compare UPS vs Purolator first → take the cheaper one
  - Canada Post only if it is **more than $4 cheaper than both**
  - Canada Post always for PO Boxes
- assign warehouse + carrier + service in ShipStation so Mac can inspect the queue directly
- persist `packageCode` too, and verify warehouse + carrier + service + package type after re-fetch
- print a clean approval table that matches what was staged in ShipStation
- never buy labels

Format:
```
| Order # | Item | To | From | Carrier | Cost | Notes |
```

Total cost and pickup counting can be done after approval, but the planning table must be deterministic and approval-ready.

🛑 **FULL STOP. Reply ends here. Wait for Mac to say "go".**

---

## STEP 5 — Buy Labels

Only after explicit `go`.

**Endpoint:** `POST /shipments/createlabel` (V1 API)
- `/orders/createlabel` does NOT exist — don't try it
- One label at a time, 4 second delays between
- `serviceCode` for Purolator Ground has trailing space: `'purolator_ground '`
- Include `shipFrom` with correct Prosol warehouse address
- Do NOT include dimensions

**Prosol warehouse addresses:**
| Warehouse | Address | Postal |
|---|---|---|
| Saint-Laurent | 4305 Griffith St, Saint-Laurent QC | H4T 2A2 |
| Calgary | 30 Freeport Blvd NE, Calgary AB | T3J 5J9 |
| Concord | 65 Kenview Blvd, Concord ON | L4K 4G5 |
| Burnaby | 1374 Boundary Rd, Burnaby BC | V5K 4T6 |

After buying each label: confirm tracking number and actual cost. If cost is way off from estimate, STOP and investigate before continuing.

---

## STEP 6 — Mark Orders Shipped in ShipStation

```
POST /orders/markasshipped
{
  orderId, carrierCode, serviceCode, trackingNumber,
  shipDate, notifyCustomer: false, notifySalesChannel: true
}
```

Do this for every order after label is purchased. Otherwise they stay in "awaiting shipment" forever.

---

## STEP 7 — Create Salesforce POs

One PO per order, linked to SO-023144 (Mac's Amazon catch-all SO). This is what Kaitlyn needs to receive inventory.

**⚠️ NOTE: Shopify orders** — Do NOT link to SO-023144. Shopify orders need separate Sales Orders created per order, linked to the Shopify Account and customer Contact. Amazon catch-all is for Amazon orders only.

**Prosol vendor ID:** `0014x00001P1ScCAAV`
**Amazon SO:** `a10OJ00000Av9teYAB` (SO-023144)

For each order:

**a) Create SO line:**
```
POST /sobjects/PBSI__PBSI_Sales_Order_Line__c
{
  PBSI__Sales_Order__c: SO_ID,
  PBSI__Item__c: item_id,
  PBSI__Quantity__c: qty,
  PBSI__Price__c: retail_price
}
```
Save the returned SO line ID.

**b) Create PO:**
```
POST /sobjects/PBSI__PBSI_Purchase_Order__c
{
  PBSI__Account__c: PROSOL_VENDOR_ID,
  PBSI__Order_Date__c: today,
  PBSI__Status__c: "Open",
  PBSI__Shipping_Instructions__c: "Amazon Order {num} — {customer}, {city} — {carrier} — Tracking: {tracking}",
  PBSI__Tracking_Code__c: tracking_number
}
```
Save the returned PO ID.

**c) Create PO line** (BOTH SO_ID and SO_LINE_ID required — validation rule):
```
POST /sobjects/PBSI__PBSI_Purchase_Order_Line__c
{
  PBSI__Purchase_Order__c: po_id,
  PBSI__Item__c: item_id,
  PBSI__Quantity_Ordered__c: qty,
  PBSI__Price__c: cost_price,
  PBSI__Sales_Order__c: SO_ID,
  PBSI__Original_SO_Line__c: sol_id   ← REQUIRED or validation fails
}
```

**d) Get real PO number:**
```
SELECT Name, PO_Number__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '{po_id}'
```
Name field = "PO-XXXXX" — use this on the packing slip.

**PBSI item lookup** — items are keyed by Prosol manufacturer code (`PBSI__Vendor_Item_ID__c`):
| Prosol SKU | PBSI Item ID | Description |
|---|---|---|
| DHEHK24053 | a0u4x000003r2InAAI | Schluter DITRA-HEAT Cable 240V 53sqft |
| C010382-01 | a0u4x000003r2KGAAY | Aqua Mix Heavy Duty Cleaner 946ml |
| C020552-01 | a0u4x000003r2K6AAI | Aqua Mix Seal & Finish Low Sheen 946ml |
| C100250-05 | a0u4x000003r2JrAAI | Aqua Mix Enrich N Seal 473ml |

---

## STEP 8 — Generate Packing Slips

Salesforce does NOT auto-generate PO PDFs via API. We generate our own.

**Script:** `scripts/shipstation/generate-packing-slip.py`

```bash
python3 generate-packing-slip.py '{
  "po_number": "PO-14252",
  "date": "2026-04-02",
  "vendor": "Prosol Inc.",
  "amazon_order": "702-0287009-8952251",
  "tracking": "520438706118",
  "carrier": "Purolator Ground",
  "ship_to": {"name": "...", "address": "...", "city_state_zip": "..."},
  "items": [{"item_number": "11465", "description": "...", "qty": 1, "unit_cost": 189.99}]
}'
```

Output: `/tmp/packing-slip-PO-14252.pdf`

---

## STEP 9 — Download Label PDFs

Via ShipStation V2 (after label creation, shipmentId is available):

```
GET https://api.shipstation.com/v2/labels/se-{shipmentId}
→ result.label_download.pdf = download URL
```

Auth: `API-Key: $SHIPSTATION_V2_API_KEY`

---

## STEP 10 — Email Kaitlyn

**To:** KLazzarotto@prosol.ca
**CC:** mac@customfc.ca
**From:** `Mac Roy <hello@yourfloors.ca>`
**Subject:** `Order - {Warehouse}` (e.g. "Order - Saint-Laurent")

One email per warehouse. All orders for that warehouse in one email.
60 seconds between emails (throttle — got customfc.ca quarantined March 20 from rapid-fire sending).

Each email contains (per order):
- Amazon Order #
- PO #
- Ship To: customer name + city/postal
- Carrier + tracking number
- Attached: label PDF + packing slip PDF

Close with: "Please reply to confirm receipt."

**SMTP:** smtp.office365.com:587 (STARTTLS)
Login: `hello@yourfloors.ca` / `JohnD33r35G!`

---

## STEP 11 — Book Pickups

**Only after Kaitlyn confirms** (reply to email). If no reply after 24h, alert Mac.

Pickup next business day from each warehouse used.

**UPS:** ShipStation V2 `POST /v2/pickups`
```json
{
  "carrier_id": "se-1813879",
  "label_ids": ["se-{shipmentId}"],
  "pickup_date": "YYYY-MM-DD",
  "contact_details": {"name": "...", "email": "mac@customfc.ca", "phone": "..."},
  "pickup_window": {"start_at": "..T14:00:00Z", "end_at": "..T21:00:00Z"}
}
```
Note: pickup_address is auto-set to warehouse — works correctly for outbound.

**Purolator:** Same endpoint, carrier_id `se-1813880`, MUST include `pickup_address` in payload.

**Canada Post:** Use `scripts/shipstation/book-cp-pickup.js --location {CODE} --boxes N`

**Tracking follow-up:** If order shows no tracking movement after 3 days, alert Mac.

---

## STEP 12 — Residential Return Pickups

ShipStation V2 pickup API only books from our warehouses — NOT customer addresses.
For residential returns: customer must go to ups.com or call 1-800-742-5877 (UPS On-Call Pickup).

---

## Key Account Info

| Thing | Value |
|---|---|
| ShipStation V1 Auth | `$SHIPSTATION_API_KEY:$SHIPSTATION_API_SECRET` |
| ShipStation V2 API Key | `$SHIPSTATION_V2_API_KEY` |
| Prosol login | `$PROSOL_EMAIL` / `$PROSOL_PASSWORD` |
| Salesforce session | Re-login each run (SOAP, expires 2h) |
| Kaitlyn email | KLazzarotto@prosol.ca |
| Purolator service code | `purolator_ground ` (trailing space — required) |
| Amazon catch-all SO | SO-023144 (`a10OJ00000Av9teYAB`) |

---

## What's NOT Automated Yet

- [ ] Prosol inventory script (ProsolClientV2 not integrated into main pipeline)
- [ ] Pickup booking (manual step until Kaitlyn confirms)
- [ ] Salesforce PO PDF auto-generation (SF Flow not set up — using our own generator)
- [ ] mac@customfc.ca IMAP watch (M365 Basic Auth blocked — needs App Password)
- [ ] Dimensions data — all 238 products missing dims in SS products API (stored on orders only)

---

*Last updated: 2026-04-02*
