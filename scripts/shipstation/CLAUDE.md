# run-orders/scripts/shipstation — Engine + Data

The core pipeline lives here. (See `../../CLAUDE.md` for ops rules.)

## The engine
- **`run-orders.js`** — THE pipeline (stage → buy → PO → email → pickup). **Live routing logic is here (~L671)**, Puro-vs-UPS-$4 + CP-PO-box-only. Run via `npm run run-orders` / `:dry`.
- **`order-router.js`** — ⚠️ **DEAD CODE.** Superseded by `run-orders.js`. Don't edit it expecting runtime effect.

## Data (load-bearing)
- **`sku-map.json`** — SKU mapping. Title-is-truth; keep Schluter slashes; `api_sku` vs `prosol_sku`; ASIN aliases for Amazon/Mapei. Verify a new SKU appears in pipeline output **before** buy/pos (`feedback_sku_map_deploy_restart`).
- **`prosol-location-map.json`** — Prosol warehouse → routing-tier map.

## Vendor / carrier
- `prosol-client-v2.js` — Prosol portal client (stock, price, COO, attrs).
- `book-cp-pickup.js` — Canada Post pickup. **Use the `/cp-pickup` skill — don't re-explore the schema** (`reference_cp_pickup_skill`).
- `check-tracking.js` — tracking-status checker.
- `track-orphan-ghost.js` — orphan / ghost-pickup tracking (alert-only).

## One-offs (historical, don't re-run blindly)
- `_oneoff-create-prosol-warehouses.js`, `_oneoff-link-new-warehouses.js` — ShipStation warehouse setup (UI-created, linked by postal — see `reference_shipstation_warehouse_creation`).
