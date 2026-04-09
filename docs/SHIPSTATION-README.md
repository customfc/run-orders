# YourFloors.ca — ShipStation / Prosol Ops

This folder now has two distinct flows:

1. **`npm run run-orders`** → Run-Orders prep flow: assign warehouses + carrier/service in ShipStation, then print the approval table that reflects those assignments
2. **`node order-router.js`** → older warehouse assignment helper / legacy routing utility

`run-orders` is supposed to be the real approval-prep step: it pulls `awaiting_shipment`, filters to the true Amazon/Prosol run scope, checks inventory through the real Prosol browser session, assigns warehouse + carrier/service, writes those assignments into ShipStation for Mac to review, and prints the approval-ready table from that same plan. It still must **not** buy labels.

**Mac's manual ad-lib planning step: killed forever. 🔥**

## Quick Start

```bash
# Prep Run-Orders in ShipStation, stage warehouse/carrier/service, then print the approval table
cd /Users/fred/.openclaw/workspace/scripts/shipstation && npm run run-orders

# Optional safety preview: compute the plan only, do not write ShipStation
cd /Users/fred/.openclaw/workspace/scripts/shipstation && npm run run-orders -- --dry-run

# Older warehouse router dry run / legacy utility
node scripts/shipstation/order-router.js

# Legacy direct ShipStation warehouse assignment helper
node scripts/shipstation/order-router.js --execute

# Print the full Prosol location map
node scripts/shipstation/order-router.js --discover
```

## `run-orders.js` behavior

- ShipStation V1 `awaiting_shipment`
- Amazon CA only
- Uses `sku-map.json` exactly; unresolved items are flagged, not guessed
- Only explicit `shipstation_warehouse_id` non-Prosol mappings can auto-route outside Prosol; otherwise the order is flagged for manual review
- Perfect Level items are blocked from the Prosol path unless there is an explicit supported non-Prosol routing rule
- Uses `ProsolClientV2` browser-session inventory lookups
- Deterministic warehouse selection from mapped Prosol hubs
- Carrier rule:
  - compare UPS vs Purolator first
  - Canada Post only if it beats **both** by more than $4
  - Canada Post forced for PO Boxes
  - **weight only**, never dimensions
- Default run writes the selected warehouse + carrier + service back into ShipStation so Mac can inspect the queue
- `--dry-run` keeps it read-only for planning/debugging
- Default staging persists warehouse + carrier + service + `packageCode=package`, then re-fetches the order to verify all four fields stuck
- Prints the approval table from the verified staged assignments (or from the live unchanged orders in dry-run mode)
- Never buys labels

## How It Works

1. **Logs into Prosol** dealer portal (cookie-based auth with XSRF tokens)
2. **Fetches all `awaiting_shipment` orders** from ShipStation API
3. **Maps ShipStation SKUs → Prosol SKUs** using `sku-map.json`
4. **Checks real-time inventory** at every Prosol location via their API
5. **Routes by province** — assigns the nearest warehouse that has stock:
   - BC → Burnaby → Calgary
   - AB/SK/MB → Calgary → Burnaby/Winnipeg
   - ON → Concord → Cambridge/Kingston/London/Ottawa/Sudbury
   - QC/Atlantic → St. Laurent → Concord
6. **Haversine distance fallback** — if no preferred hub has stock, finds the nearest stocked warehouse by geographic distance (using lat/lng from `prosol-location-map.json`)
7. **Multi-SKU orders** find a single warehouse that has ALL items
8. **Flags for manual review** if no stock anywhere

## Warehouse Mapping

### Main Hubs (Preferred)
| Prosol ID | Code | City | Province | ShipStation ID |
|-----------|------|------|----------|----------------|
| 10010 | BURN | Burnaby | BC | 1374417 |
| 10054 | WCAS | Calgary South | AB | 1284722 |
| 10001 | WCON | Concord | ON | 1791764 |
| 10004 | WGRF | St. Laurent | QC | 1791765 |

### Secondary Hubs
| Prosol ID | Code | City | Province | ShipStation ID |
|-----------|------|------|----------|----------------|
| 10013 | CAMB | Cambridge | ON | 1793463 |
| 10024 | KING | Kingston | ON | 1504076 |
| 10027 | LOND | London | ON | 1793487 |
| 10032 | OTTA | Ottawa | ON | 1814007 |
| 10043 | SUDB | Sudbury | ON | 1786140 |
| 10049 | WINN | Winnipeg | MB | 1811347 |

### Note on Location IDs
- `10003` (COQL) = **Coquitlam**, not Concord — the real Concord is `10001` (WCON)
- `10054` (WCAS) = Calgary South (the main Calgary hub)
- `10011` (CALN) = Calgary North (secondary, not mapped to ShipStation)
- The full Prosol network has 40 locations; only the ones with ShipStation warehouse IDs are used for routing

## SKU Mapping

Edit `sku-map.json` to add new product mappings:

```json
{
  "mappings": {
    "B00H4FKI4C": "C100726-4",
    "SHOPIFY-SKU-123": "PROSOL-SKU-HERE"
  }
}
```

**Current known mappings** (as of March 17, 2026):
- Most Aqua Mix products (ASINs → Prosol C-codes)
- Schluter products (DITRA-HEAT cables, KERDI-LINE drains, KERDI-BAND)
- Shopify order SKUs (e.g., `11524` → `C010262-4`)

**Not mapped (non-Prosol products):**
- Biyork flooring (SKU `04059` etc.) — these ship from Biyork Markham (SS ID 1274501), not Prosol
- Any new ASINs will show up as "unmapped" in the dry run output

## Files

```
scripts/shipstation/
├── order-router.js           # Main script
├── prosol-location-map.json  # All 40 Prosol locations with lat/lng, SS warehouse IDs
├── sku-map.json              # ShipStation SKU → Prosol SKU mapping
└── README.md                 # This file
```

## Configuration

Credentials are hardcoded (matching TOOLS.md). Override with environment variables:

```bash
SHIPSTATION_API_KEY=xxx SHIPSTATION_API_SECRET=yyy node order-router.js
PROSOL_EMAIL=xxx PROSOL_PASSWORD=yyy node order-router.js
```

## Running Daily

Add to cron or run on-demand:

```bash
# Daily at 7 AM Pacific
0 7 * * * cd /Users/fred/.openclaw/workspace && node scripts/shipstation/order-router.js --execute >> /tmp/order-router.log 2>&1
```

Or trigger via OpenClaw cron for a summary in Telegram.

## Edge Cases

- **Bundle products** (like B0947K5X3X) are mapped to their primary component. The bundle logic doesn't split orders across warehouses.
- **Multi-SKU orders** try to find a single warehouse with ALL items. If none exists, routes by first SKU and flags as `⚠️ SPLIT ORDER`.
- **Non-Canadian orders** are skipped automatically.
- **Rate limiting**: ShipStation has 40 req/minute limits. The script respects `Retry-After` headers and waits automatically. Prosol has a 200ms delay between lookups.
- **Orders already assigned** to the correct warehouse are detected and skipped (no unnecessary API calls).

## Architecture Notes

- **Zero dependencies** — pure Node.js `https` module, no npm packages needed
- **Cookie-based Prosol auth** — handles XSRF-TOKEN + session cookies properly (Laravel Sanctum)
- **Idempotent** — safe to run multiple times; won't re-assign already-correct orders
- **Prosol inventory** uses the `availability_by_location_ids` append which returns boolean availability + quantity per location for every product
- **Haversine distance** — uses postal code first letter → approximate lat/lng, then calculates distance to all 40 Prosol warehouses for smart fallback routing
- **Location data** loaded from `prosol-location-map.json` (generated from Prosol API, includes lat/lng, contact emails, addresses for all 40 locations)
