# Run Orders System Spec

## Goal
Provide a deterministic internal operations system for YourFloors order staging, pickup booking, and Shopify/Salesforce special-order handling.

The system should prefer scripts and direct API execution over conversational reasoning.

## Core Workflows

### 1. Run Orders
Trigger intent: `run-orders`, `prep-orders`

Expected behavior:
1. Pull ShipStation `awaiting_shipment`
2. Filter to in-scope run-orders set
3. Resolve SKUs
4. Check Prosol stock via `prosol-client-v2.js`
5. Assign warehouse
6. Assign carrier + service + package
7. Write those assignments into ShipStation
8. Verify staged values via re-fetch
9. Print approval-ready table
10. Stop for review

No labels purchased in this step.

### 2. Pickup Booking
Expected behavior:
1. Scan already-purchased labels/shipments
2. Bucket by warehouse + carrier
3. Book:
   - UPS via ShipStation V2
   - Purolator via ShipStation V2
   - Canada Post via `book-cp-pickup.js`
4. Return pickup IDs, confirmations, errors

### 3. Shopify SO/PO
Expected behavior:
1. Look up Shopify Account
2. Look up Contact from order customer
3. Look up item by SKU/title/vendor mapping
4. Create Sales Order
5. Create SO line
6. Create PO linked to SO
7. Create PO line
8. Return SO/PO numbers

## Known Critical Rules

### Carrier Rule
- Compare UPS vs Purolator first
- Canada Post only if more than $4 cheaper than BOTH
- Canada Post always for PO Boxes
- Weight only, never dimensions

### Routing Rule
- Perfect Level must not silently fall into Prosol routing
- Non-Prosol items need explicit route or manual review
- Mixed-route orders should be flagged, not guessed

### Salesforce Rule
- Shopify orders require their own SO
- Do not link Shopify orders to Amazon SO-023144
- `mm_Exempt_GST__c` and `mm_Exempt_PST__c` must be explicit boolean `false`

## UI Recommendation
Build an internal UI with pages for:
- Run Orders
- Pickups
- Shopify SO/PO
- Logs / Audit Trail

Each button should call scripts/endpoints directly and return structured output.
