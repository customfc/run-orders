# Run Orders

YourFloors.ca internal ops — order staging, pickup booking, Shopify SO/PO.

## Setup

```bash
npm install
cp .env.example .env   # fill in credentials
npm start              # starts at http://localhost:3456
```

## UI

Open `http://localhost:3456` — four tabs:

- **Run Orders** — dry-run or stage orders in ShipStation (real-time progress via SSE)
- **Pickups** — scan shipped labels, group by warehouse/carrier, book pickups
- **Shopify SO/PO** — fetch Shopify order, create Salesforce SO + PO
- **Logs** — audit trail of all actions

## CLI (still works)

```bash
# Run-orders staging
npm run run-orders           # stage in ShipStation
npm run run-orders:dry       # dry run only

# Canada Post pickup
npm run book-cp -- --location WGRF --boxes 3
npm run book-cp -- --list    # show available locations
```

## Architecture

```
server.js                 Express server (port 3456)
public/index.html         Single-page UI (vanilla JS, SSE)
lib/
  audit.js               JSONL append logger → data/audit.jsonl
  shipstation-v2.js      ShipStation V2 API (pickups, labels)
  pickups.js             Pickup orchestrator (UPS, Purolator, Canada Post)
  salesforce.js          SF connection via jsforce
  shopify-sf.js          Shopify → SF SO/PO creation
scripts/shipstation/
  run-orders.js          Core order staging engine (CLI + importable)
  prosol-client-v2.js    Puppeteer-based Prosol auth
  book-cp-pickup.js      Canada Post pickup booking (CLI + importable)
  sku-map.json           SKU mappings
  prosol-location-map.json  Warehouse locations
```

## Credentials

All from `.env`. See `.env.example` for required keys.
