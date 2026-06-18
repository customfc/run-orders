# run-orders — Claude Code Instructions

## What this is
CFC/YourFloors order-automation pipeline + live ops dashboard. Pulls Amazon.ca + Shopify
orders, stages them, buys ShipStation labels, creates Salesforce SO/POs, emails vendors,
books carrier pickups. **This is live production ops on the Mac Mini** — treat runtime with care.

## Stack / entry points
- **`server.js`** — Express HTTP + SSE dashboard, owns the `node-cron` schedules.
- **`scripts/shipstation/run-orders.js`** — the pipeline engine (stage → buy → PO → email → pickup).
- npm: `start` (server), `run-orders` / `run-orders:dry`, `book-cp`.
- Node + `better-sqlite3` (`data/analytics.sqlite`), `jsforce` (Salesforce), ShipStation V2, Shopify GraphQL, `imapflow` (vendor email), `puppeteer`, Telegram bot.
- Module map: `lib/CLAUDE.md`. Engine/script map: `scripts/shipstation/CLAUDE.md`.

## Deploy / run ritual (atomic deploy)
- Every code commit bundles **commit + push + Mac Mini pull + restart** into one action.
- Restart = `launchctl kickstart -k gui/$(id -u)/com.fred.run-orders` (**NOT** `pkill -f "node server.js"` — the cmdline has a path between them). launchd auto-respawns.
- **Always `git status` the Mini for divergence BEFORE pulling** — it regularly has direct uncommitted edits. See `feedback_mac_mini_check_divergence`, `reference_mac_mini_deploy_stash`.
- Dashboard: `freds-mac-mini.taila452b5.ts.net:3456` (Tailscale). Telegram `/deploy`, `/held`, `/buy`, `/claude` (remote shell). See `reference_run_orders_host`, `reference_telegram_bot_remote_shell`.
- **Doc-only changes (like this file) need NO restart** — never bounce the live process for documentation.
- Smoke-test a local instance with **`DISABLE_CRON=1`** so it doesn't fire real buys (`feedback_smoke_test_server`).

## Architecture rules & gotchas
- **Live routing logic is in `run-orders.js` (~L671), NOT `order-router.js`** — order-router.js is DEAD code.
- **Routing policy:** Purolator preferred over UPS unless UPS is **$4+ cheaper**; Canada Post ONLY for PO-box / postal-outlet destinations (never on price). See `project_routing_policy`.
- **Pickups:** age ≤ 1 day "wait" is intentional (warehouse packing time); **never void+recreate** a stuck pickup; **never auto-spend** ghost labels — alert + propose only. See `feedback_pickup_delay_intentional`, `feedback_no_voiding_for_stuck_pickups`, `feedback_no_auto_ghost_spend`.
- **Dog detection = alert + propose, never auto-disable a listing** (`feedback_no_autokill_dogs`).
- **SKU map** (`scripts/shipstation/sku-map.json`): listing-title trailing SKU is ground truth (halt on mismatch); keep Schluter slashes intact; `api_sku` (mfg, for live API) vs `prosol_sku` (internal, for PO emails) differ for Aqua Mix; Mapei/Amazon orders need ASIN-keyed aliases. See `feedback_sku_map_title_truth`, `reference_sku_map_dual_field`.
- **Never leave `cost_cad` pending** — pull cost from the Prosol lookup the pipeline already makes (`feedback_never_leave_cost_pending`).
- **Confirm before buying any label > $30**; sanity-check dims (`feedback_label_cost_confirm`).

## Hard rule — log vendor fuckups
**Every** vendor/warehouse error that costs CFC time, a refund, or a new shipping label (Prosol short-ships, missing/wrong/damaged items, stuck pickups…) gets logged to the vendor-error ledger **automatically, unprompted** — Mac reconciles these monthly/yearly. Log: `node scripts/ops/log-vendor-error.js --vendor Prosol --location "<city (CODE)>" --issue <short_ship|not_shipped|wrong_item|damaged|stuck_pickup|...> --order <#> --sku <#> --qty <n> --label-cost <cad> --refund-cost <cad> --tracking <#> --desc "..." --resolution "..." --by Mac --source mac_report`. Reconcile: `node scripts/ops/vendor-error-report.js [--month YYYY-MM|--year YYYY|--vendor X|--csv]`. Ledger `data/vendor-errors.jsonl` is COMMITTED (single source of truth). See `feedback_log_vendor_errors`, `lib/vendor-errors.js`.

## Hard rule — outbound email
**NEVER send vendor/customer email without an explicit per-email "send it" green-light**, even mid-session
when told to "act / fix it / stop asking." Emails are action-only (SKU+qty+verb+ship-to+ref). See
`feedback_never_email_vendors_unprompted`, `feedback_email_construction`.

## Current status
Active daily ops. Recent: void→rebuy guard (`/held`), orphan-email sweep (SHADOW), integration-health
monitor, package-split handling, buybox defender (SHADOW, 18 Mapei SKUs). Open: PO backfill, standing
UPS pickups, area-product coverage-multiplier bug. See `project_session_handoff_2026-06-09`,
`project_pickup_collapse_june2026`, `project_buybox_defender`.

## Related memory
`reference_mac_mini_access` · `reference_mac_mini_deploy_stash` · `reference_pipeline_health_signals` ·
`project_routing_policy` · `project_routing_tier_policy` · `reference_cp_pickup_skill` · `feedback_atomic_deploy`
