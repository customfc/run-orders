# YourFloors Ops Dashboard — Full Rebuild Spec

**Status:** draft — awaiting Sprint 0 kickoff
**Last updated:** 2026-04-15
**Owner:** Mac
**Scope:** complete replacement of `public/index.html` with a new single-page dashboard; significant new backend for analytics, inventory, reorder, replenishment POs, and profitability.

---

## Overview

Replace the current 1,700-line vanilla-HTML tabbed dashboard with a single-page "command HQ" control surface. Add nightly rollup jobs and new API integrations (Amazon SP-API, Amazon Ads API) to support inventory awareness, automated reorder alerts, bulk replenishment PO generation, and per-SKU profitability analysis.

The existing 5-phase pipeline (`stage → buy → pos → email → pickups`) and `lib/amazon-po.js` customer-fulfillment PO flow are **NOT changed** by this work. The new "replenishment PO" feature is distinct from the existing "customer-fulfillment PO" flow — do not conflate.

## Infrastructure & Deployment

- **Host:** Always-on Mac mini (existing). No VPS, no PaaS.
- **Access:** Tailscale-only. Dashboard binds `0.0.0.0:3457`; reachable at `<mac-mini>.tail<xxxx>.ts.net:3457` from any device on the tailnet (Mac's laptop, phone). No public URL, no HTTPS cert, no Cloudflare tunnel.
- **Architecture: two processes, one repo**
  - `server-pipeline.js` (port 3456) — existing pipeline + cron + Telegram bot + OAuth handlers. The operationally critical process. Untouched except for removing the current dashboard static routes.
  - `server-dashboard.js` (port 3457, NEW) — auth, config API, warehouse API, unified SSE bus, conveyor state, analytics/profitability/reorder scripts, PO builder endpoints. All read-heavy + bursty work isolated here.
- **Why split:** Dashboard code can crash, memory-leak during a 13-week rollup backfill, or hang on a slow SP-API call without disrupting label purchases or Prosol emails.
- **Cron split:**
  - Pipeline process owns write-path crons: daily pipeline run, hourly pickup check, etc.
  - Dashboard process owns read-path crons: nightly analytics rollup, nightly profitability rollup, nightly reorder-alert scan.
- **Shared state:** Both processes read/write the `data/` directory. Dashboard writes `config.json`, `warehouses.json`, `sku-config.json`; pipeline hot-reloads on next cron tick. Pipeline writes `ops-state/`, `audit.jsonl`; dashboard tails these for UI updates.
- **Cross-process events:** Dashboard subscribes via HTTP SSE to pipeline's existing `/api/pipeline/run` stream when the pipeline is actively running. Dashboard also watches `data/audit.jsonl` with `fs.watch` for post-facto audit events. Rebroadcast to dashboard UI clients as unified `/api/ops/stream`.
- **Pipeline watchdog (S1 addition):** If a pipeline run is in-flight >30 minutes, pipeline process SIGTERMs itself and fires a Telegram alert. Covers hung external API calls.
- **Existing access patterns preserved:**
  - Telegram bot on pipeline process unchanged
  - Remote shell to mac-mini via Mac's on-host Claude Code agent unchanged

---

## Aesthetic Brief

**"Mid-90s Bullfrog/Westwood management sim where you run a national logistics operation. Warm saturated palette, chunky beveled panels, isometric warehouse view with tiny workers doing jobs, Carmen-style world map, C&C command sidebar, LEGO-bright package bricks. The system talks to you in PA announcements. You're the operator of a humming little logistics world."**

### References pinned

- **Carmen Sandiego (Brøderbund, 1985+)** — ACME Crimenet world map, dossier cards, red pins, cream paper backgrounds, typewriter readouts
- **LEGO City (game + brick sets)** — chunky primary-color bricks, black outlines, isometric scenes, studs, vehicles
- **Command & Conquer: Red Alert (Westwood, 1996)** — dense right-side command panel, brushed metal with rivets, klaxon alerts, status readouts
- **Theme Hospital (Bullfrog, 1997)** — isometric working-operation view, tiny worker sprites, PA announcements, chunky beveled management panels

### Color palette (max 6, enforced)

| Token | Hex | Use |
|---|---|---|
| `--alert-red` | `#c8102e` | alerts, C&C klaxons, Carmen fedora, LEGO fire |
| `--cargo-yellow` | `#ffc72c` | packages, warehouse tiles, warning tape |
| `--command-blue` | `#005eb8` | in-transit state, info, RA Allies |
| `--go-green` | `#1d7a3e` | delivered, success |
| `--dossier-cream` | `#f5e6c8` | panel backgrounds, Carmen paper |
| `--outline-black` | `#1a1a1a` | 2-3px borders on all interactive elements |

No purple, no cyan, no additional accents. Gradients allowed only for paper texture and brushed-metal texture (one of each, subtle).

### Typography (max 2 families)

- **Display / headers:** Cooper Black OR Bungee (chunky, 90s, playful)
- **Data / readouts:** IBM Plex Mono OR DM Mono on cream background (legible, not phosphor-cheesy)

### Textures (4, each used for exactly one purpose)

- Dossier paper cream — panel backgrounds (Carmen)
- Brushed metal with rivets — command sidebar (C&C)
- Stud grid — conveyor belt surface (LEGO)
- Map grid with dashed travel lines — Canada heatmap (Carmen flight paths)

### Animation rules

- Packages on belt = LEGO bricks, **snap between stations in steps**, no smooth easing
- Pin drops on Canada map = Carmen-style red pin with one small bounce
- Alert states = C&C klaxon strobe
- Loading = dashed flight-path line drawing across map
- **No CSS smooth easing anywhere** — everything steps or snaps, never ease-in-out

### Optional sound (PA announcements)

Default OFF, toggle on knobs panel. When on: Theme-Hospital-style announcements for order events, stale alerts, deliveries. Audio files in `public/audio/`. Mac-specific — unlikely to be used in mixed company settings.

---

## Layout

```
┌─ Cream dossier header: "ACME LOGISTICS COMMAND" ─────────┐
│  [clock]    [current phase banner]    [alert lamps]       │
├──────────────┬───────────────────────────────┬────────────┤
│              │                               │            │
│  WAREHOUSE   │    CONVEYOR (stud-belt)       │  C&C       │
│  YARD        │    🧱🧱🧱🧱 → truck 🚚          │  COMMAND   │
│  (LEGO tile  │    ─────────────────          │  PANEL     │
│   cards)     │    FALLEN BRICKS (heap)       │  (knobs    │
│              │                               │   + btns)  │
│              │                               │  brushed   │
├──────────────┴───────────────────────────────┤  metal     │
│                                              │  w/ rivets │
│  CARMEN CRIMENET MAP — CANADA FSA HEAT       │            │
│  📍 red pins for new orders                  │            │
│                                              │            │
├──────────────────────────────────────────────┴────────────┤
│  INSTRUMENT RACK (C&C sidebar readouts)                   │
│  [Dwell gauge] [Volume bars] [Ghost dial] [Cash register] │
├───────────────────────────────────────────────────────────┤
│  DOSSIER TERMINAL (PA ticker + click-to-expand full log)  │
└───────────────────────────────────────────────────────────┘
```

Consoles (fullscreen modals, triggered by clicking instruments/tiles):
- Package Detail Drawer (click package on belt)
- Warehouse Drawer (click warehouse tile, includes edit mode)
- Analytics Console (click any analytics instrument)
- Inventory Console (click stock tanks)
- P&L Console (click cash register)
- Terminal Fullscreen (click terminal)

---

## Feature Scope

1. Password login page + signed-cookie session
2. Unified SSE ops stream (`/api/ops/stream`)
3. Preact + htm + esm.sh component UI (zero build step)
4. Conveyor belt visualization — LEGO-brick packages snapping through 5 stations
5. Terminal panel with live audit tail + filter commands
6. Knobs panel — real config writing to `data/config.json`
7. Warehouse drill-down + inline editor (writes to `data/warehouses.json`)
8. Analytics rollup (`scripts/build-analytics.js`) — dwell, volume, ghost rate, trends, customer geo
9. Analytics instruments — dwell oscilloscope, volume bars, ghost dial, LED scoreboard, carrier lamps
10. Analytics Console modal
11. FSA customer heatmap (Carmen Crimenet map of Canada)
12. Inventory awareness — Prosol + FBA merged view
13. SKU config (`data/sku-config.json`) — vendor, lead time, safety stock, case pack, unit cost, is_fba
14. Reorder logic + Telegram/dashboard alerts
15. Replenishment PO builder (vendor-email + FBA inbound via SP-API)
16. Profitability rollup — SP-API Settlement + Finances → per-SKU net margin
17. Amazon Ads API → ACoS + ad attribution overlay on profitability
18. P&L Console — cash register, waterfall chart, per-SKU margin table
19. Legacy retirement + hardening

---

## Settled Design Decisions

- **Stack:** Preact + htm via esm.sh, zero build step, ES modules under `public/components/`
- **Auth:** Password login page (`/login`) with signed cookie (`DASH_SESSION`, HMAC with `DASH_SESSION_SECRET`). Single-user. Env: `DASH_PASSWORD`, `DASH_SESSION_SECRET`.
- **Storage:** JSON files under `data/` everywhere. Migrate to SQLite only if proven slow.
- **Warehouse config:** move to `data/warehouses.json` (gitignored), seed from `scripts/shipstation/prosol-location-map.json` on first boot
- **Sound:** off by default, toggle via knob. Hook built in Sprint 2, sound packs loaded in Sprint 3.
- **Conveyor density:** summarize-by-warehouse when packages per stage > 30
- **Backfill depth:** 13 weeks initial. Full-history backfill behind a knob.
- **Revenue in analytics:** yes, included
- **Orion tenant:** YourFloors only for v1. Design for multi-tenancy, do not implement.
- **Refund lag:** rollups re-compute for 60 days post-sale; UI shows "as of" date
- **SP-API / Ads API registration:** Mac handles Amazon-side clickthroughs as prerequisite gates
- **CASL:** not an issue — customer data is internal analytics only (heatmap), never outbound marketing
- **Not touching:** `lib/amazon-po.js`, 5-phase pipeline, Prosol integration, ShipStation V1/V2 clients
- **Device target:** desktop dispatcher workstation only. Mobile degrades to read-only.
- **Typography:** Cooper Black or Bungee (display) + IBM Plex Mono or DM Mono (data). Pick exact families at Sprint 0.
- **Conveyor style (flat vs iso):** decide at Sprint 0 review. Flat is default fallback; iso is stretch.

---

## Open Decisions (per sprint kickoff)

- **S1:** Config hot-reload (re-read every cycle) vs restart? Default: hot-reload.
- **S2:** Pin specific esm.sh version strings? Default: pin exact, e.g. `https://esm.sh/preact@10.25.4`.
- **S4:** 13-week window measured as calendar weeks (ending Saturday) or trailing 91 days? Default: trailing 91 days.
- **S7:** Pull Prosol stock for all mapped SKUs, or sales-active only? Default: sales-active in last 13w.
- **S10:** Refund-lag re-computation — overwrite history in-place or keep "revised vs original" columns? Default: overwrite in-place.

---

## Prerequisite Gates (Mac action items, not code tasks)

| Gate | Blocks | Lead time | Action |
|---|---|---|---|
| **SP-API developer app** (scopes: Reports, Finances, FBA Inventory, FBA Inbound) | S7, S9, S10 | 1-3 weeks Amazon approval | Register at `sellercentral.amazon.ca` → Developer Central. Provide `client_id`, `client_secret`, `refresh_token`. |
| **Amazon Ads API app** | S11 | 1-2 weeks | Register at `advertising.amazon.com/API`. Provide `profile_id`, `refresh_token`. |
| **Canadian FSA TopoJSON** | S6 | 1 hour | Download from StatsCan boundary files, pre-simplify. Sprint can source if not pre-supplied. |

**Start the SP-API registration NOW**, before any sprint begins. It is the longest lead-time gate and blocks three sprints.

---

## Risk Concentrations

- **S4 (Analytics Rollup):** Heaviest API usage. 13w of ShipStation V2 tracking calls vs rate limits. First-time joining V1+V2+audit in batch. Budget debug buffer.
- **S10 (Profitability Rollup):** SP-API report generation is async (request → poll → download). Settlement report format is complex. Highest slippage risk after S4.
- **S11 (Amazon Ads API):** Separate OAuth from SP-API. Amazon changes API semantics periodically.
- **S9 (FBA Inbound API):** Multi-step flow Amazon changes frequently. Vendor-email path ships first as the reliable fallback.

---

## Sprint Dependency Graph

```
S0 ─► S1 ─► S2 ─► S3
              │    │
              └────┴──► S4 ─► S5
                        │     │
                        ├─────┴──► S6
                        │
                        └──► S7 ─► S8 ─► S9
                                          │
       [Mac: SP-API reg] ────────► S7,S9,S10
       [Mac: Ads API reg] ──────────────► S11
                                          │
                              S10 ─► S11 ─► S12 ─► S13
```

S1-S3 are strictly serial. S4 unlocks parallel work on S5/S7/S10 (if gates are met). S13 runs when everything is stable.

---

## Sprint Plan

### Sprint 0 — ACME Command HQ Style Tile

**Goal:** Produce a static design tile that captures the full aesthetic so every subsequent sprint matches against a pinned visual target.

**Deliverables:**
- `public/design-tile.html` — static page, no data, no API
- All atoms: knob, lamp, dial, LEGO-brick package, dossier card, C&C command button, Carmen map pin, typewriter readout, brushed-metal bezel, LED readout, chunky toggle switch
- Color swatches block (6 tokens)
- Typography samples (display + data fonts at 3 sizes)
- Mini-scenes:
  - Conveyor slice: 3 bricks mid-belt, one fallen
  - Canada heatmap slice: BC + AB with pins
  - Instrument rack slice: dwell gauge + cash register
  - Warehouse tile: 3 tiles with different states
  - PA ticker slice: 2 scrolling headlines
  - Dossier drawer: 1 package detail card
- **Two conveyor variants** side-by-side: flat 2D belt (fallback) + iso warehouse with worker sprites (stretch) — Mac picks at review

**Prerequisites:** None.

**Exit criteria:** Mac opens `design-tile.html`, iterates with Claude until he says "yes, this." Committed to repo as the visual target for S2+.

**Size:** M

**Risks:** Visual taste is subjective — expect 2-4 iteration rounds. If the aesthetic still feels wrong after round 4, fallback to "modern industrial dark" (Linear/Stripe dark) — documented as plan B.

**Testing:** Open the HTML file, visual review only.

**Open decisions:**
- Final font families (Cooper Black vs Bungee, IBM Plex Mono vs DM Mono)
- Flat belt vs iso warehouse for conveyor
- Worker sprites yes/no
- PA announcements yes/no (re-decide with aesthetic context)

---

### Sprint 1 — Dashboard Process Scaffold: Auth, Config, SSE, Warehouse API, Pipeline Watchdog

**Goal:** Stand up the new dashboard process on port 3457 (Tailscale-accessible), isolated from pipeline. Auth, config, warehouse API, unified SSE bus, and a pipeline watchdog live here. Pipeline process untouched except for adding the watchdog.

**Deliverables:**
- **`server-dashboard.js`** — new entry point on port 3457, binds `0.0.0.0` for Tailscale. Runs `npm run dashboard`.
- **Auth middleware** — checks `DASH_SESSION` signed cookie; redirects to `/login` if missing. Skip for `/api/health` only.
- `GET /login` + `POST /login` — password form, cookie issuance (HMAC with `DASH_SESSION_SECRET`, 30-day expiry)
- `GET /logout` — clears cookie
- Env additions: `DASH_PASSWORD`, `DASH_SESSION_SECRET` (documented in `.env.example`)
- `GET /api/config` + `PATCH /api/config` — reads/writes `data/config.json`. Keys: `staleThresholdDays`, `pickupCutoffHour`, `dryRun`, `telegramMuted`, `rateShopStrategy`, `soundEnabled`, `activeWarehouses[]`. **Pipeline process hot-reloads config.json at start of each cron tick** (one-line addition to pipeline).
- `GET /api/warehouses` + `PATCH /api/warehouses/:code` — reads/writes `data/warehouses.json`. Seeded from `prosol-location-map.json` on first boot. Destructive fields (`active` toggle, contact email change, `shipstation_warehouse_id` change) require `{ confirm: true }` in body. Every edit appends audit entry.
- `GET /api/ops/stream` — unified SSE. Sources:
  - Tails `data/audit.jsonl` via `fs.watch` — new lines broadcast as `{type: 'audit', ...}`
  - HTTP SSE client subscribes to pipeline's existing `/api/pipeline/run` stream (reconnecting) — rebroadcasts as `{type: 'pipeline-progress', ...}`
  - Pickup events (new bookings detected via periodic poll of `/api/pickups/active` from pipeline) — `{type: 'pickup', ...}`
- **Pipeline watchdog** (modification to `server-pipeline.js`): track pipeline run start time; if >30min, SIGTERM + Telegram alert. ~20 lines.
- `npm run dashboard` + `npm run pipeline` scripts
- Dashboard process has NO cron itself yet (Sprint 4 adds the rollup cron)

**Prerequisites:** None. Mac has Tailscale running on mac-mini.

**Exit criteria:**
- `curl -b "DASH_SESSION=<signed>" http://<mac-mini>.tail<xxxx>.ts.net:3457/api/config` from phone returns config
- Killing dashboard process does NOT stop pipeline cron (verify a scheduled run still fires)
- PATCH /api/config on dashboard process is visible on next pipeline tick
- SSE stream emits `pipeline-progress` events when a pipeline run is manually triggered via Telegram
- PATCH /api/warehouses writes to JSON + audit
- Pipeline watchdog SIGTERMs a run hung >30min (simulate with a `setTimeout` test)

**Size:** M

**Risks:** Two-process coordination — file-based state is robust but `fs.watch` semantics differ on macOS. Test thoroughly. SSE client reconnection to pipeline when pipeline restarts or briefly hangs.

**Testing:**
1. `npm run pipeline` in one terminal, `npm run dashboard` in another
2. From phone on Tailscale: hit `/login`, enter password, confirm cookie set, `/api/config` returns
3. Trigger pipeline via Telegram `/launch`; watch SSE events flow to dashboard client
4. Kill dashboard process; Telegram `/launch` still works; restart dashboard, reconnects to SSE

**Open decisions:** Config hot-reload cadence — every cron tick (default) or file-watch on pipeline side for faster propagation?

---

### Sprint 2 — Preact Shell: Header, Knobs, Conveyor Skeleton, Theme

**Goal:** Ship the ACME dashboard shell matching the Sprint 0 design tile. Wired to live SSE, but conveyor still shows static placeholders (S3 fills it).

**Deliverables:**
- `public/dashboard.html` — entry point, loads Preact 10.x + htm 3.x from esm.sh (pinned versions)
- `public/theme.css` — ACME aesthetic (palette + typography + textures from design tile)
- `public/components/App.js` — root, SSE subscription, global state
- `public/components/Header.js` — clock, phase indicator, alert lamps (from SSE)
- `public/components/KnobsPanel.js` — wired to `GET/PATCH /api/config`. All config keys editable.
- `public/components/Terminal.js` — PA ticker (scrolling) + click-to-expand fullscreen with filter commands (`/filter action:pipeline-buy`)
- `public/components/ConveyorBelt.js` — SVG skeleton: 5 stations, off-belt bin, placeholder bricks
- `public/components/WarehouseRack.js` — skeleton tiles (populated from `/api/warehouses`, no live events yet)
- `public/components/Footer.js` — status bar
- Express serves `dashboard.html` at `/`; old `index.html` at `/legacy.html`

**Prerequisites:** S0 (design tile) + S1 (auth, SSE, config).

**Exit criteria:**
- Load `localhost:3456/`, see CRT-free ACME dashboard
- Header shows current pipeline phase live via SSE
- PA ticker tails audit events
- Toggling a knob persists across refresh
- Warehouse tiles render all warehouses
- Conveyor skeleton visible, 5 stations labeled

**Size:** M

**Risks:** esm.sh CDN availability (pin exact versions, consider vendoring if flaky). Aesthetic drift from S0 tile — compare against tile frequently.

**Testing:** Open browser, confirm visual match with S0 tile. Toggle dry-run knob, check `data/config.json` updates.

**Open decisions:** Exact esm.sh version strings.

---

### Sprint 3 — Live Conveyor + Warehouse Rack + Drawers + Editor

**Goal:** Wire the conveyor and warehouse rack to real order data. Package and warehouse drawers functional.

**Deliverables:**
- `GET /api/conveyor/state` — reads today's `ops-state`, stale-tracker output, returns packages grouped: `staged`, `label_bought`, `pickup_scheduled`, `in_transit`, `delivered`, plus off-belt: `hanging`, `ghost`, `errored`. Summarize-by-warehouse when count > 30 per stage.
- Server-side cache for stale-tracker results (5 min TTL, invalidated on relevant SSE events)
- `ConveyorBelt.js` — live: packages appear, snap between stations on SSE events, click opens drawer. Off-belt bin color-coded.
- `public/components/PackageDrawer.js` — fullscreen modal: order details, tracking timeline, label cost, PO number, carrier, warehouse, rebook button if stale
- `WarehouseRack.js` — live: tiles blink on SSE events involving that warehouse, status colors (green=orders today, gray=idle, red=error)
- `public/components/WarehouseDrawer.js` — click tile: warehouse details, today's orders, carrier mapping, edit form, destructive-field confirmation modal
- Worker sprites (if S0 voted iso) — idle animations at each station, react to events

**Prerequisites:** S2 (shell exists). S1 (warehouse API, SSE).

**Exit criteria:**
- Real packages appear on belt when pipeline runs
- Clicking a package opens drawer with correct ShipStation data
- **Pickup sidebar** carried forward from v1: today's booked pickups visible at a glance (grouped by date, today highlighted, warehouse + carrier + label count + confirmation). Sourced from `/api/pickups/active`. This is a daily-ops essential in v1 — must not regress in the rebuild.
- Clicking warehouse tile opens drawer, edits persist
- Destructive warehouse edit shows confirmation before writing

**Size:** L

**Risks:** Stale-tracker is slow (V2 tracking per label). Server cache mitigates but cold start is slow. Animation performance with 50+ packages — throttle state updates.

**Testing:** Run real pipeline, watch packages flow across belt. Edit a warehouse email, verify audit log records it.

---

### Sprint 4 — Analytics Rollup Script + API Endpoint

**Goal:** Build the data layer that feeds every subsequent analytics sprint. Validate numbers before building any UI on top.

**Deliverables:**
- `scripts/build-analytics.js` — walks ShipStation V1 shipments (13w), V2 tracking events, `data/audit.jsonl`. Emits `data/analytics/rollup.json` with:
  - `dwell`: per (warehouse, carrier, week) — median, p90, count, distribution
  - `transit`: per (carrier, week) — median, p90
  - `volume`: per (warehouse, week, channel) — order count, label count, revenue if available
  - `ghost_rate`: per (warehouse, week) — voided-post-pickup / total
  - `stale_rate`: per (warehouse, week) — hung >3d / total
  - `top_warehouses`: current week, by volume
  - `carrier_performance`: per carrier — on-time %, exception %, avg transit
  - `top_skus`: top 50 by volume + revenue
  - `fsa_geo`: per FSA — customer count (deduped on email+postal), order count, top city, last order at
  - `metadata`: `rollup_generated_at`, `coverage_start`, `coverage_end`, `backfill_mode`
- Incremental mode (default): processes since last checkpoint in `data/analytics/checkpoint.json`
- Full-backfill mode (`--full`): re-processes from scratch
- Rate-limited to ShipStation's 40 req/sec
- `GET /api/analytics/rollup` — serves latest rollup
- `GET /api/analytics/rollup?from=YYYY-MM-DD&to=YYYY-MM-DD` — date-filtered
- Cron: nightly 04:00 ET via existing cron infrastructure

**Prerequisites:** S1 (ops stream unlocks rollup timestamps). ShipStation V1/V2 keys already in `.env`.

**Exit criteria:**
- `node scripts/build-analytics.js --full` completes end-to-end (expect hours, runs overnight)
- `data/analytics/rollup.json` is valid JSON with all keys populated
- **Spot-check:** 3-5 numbers verified against Seller Central / ShipStation UI
- Incremental re-run in under 5 minutes
- Nightly cron scheduled

**Size:** M (the heaviest individual sprint for API wrangling)

**Risks:** **HIGHEST RISK SPRINT.** Rate limits, pagination edge cases, V2 events missing for older CP shipments (fallback to CP direct API exists in codebase). Budget debug time. Mitigation: build checkpoint file so interrupted backfills resume.

**Testing:** Run backfill overnight, verify outputs. Compare 3 warehouses' dwell medians against Mac's gut sense — must be roughly right.

**Open decisions:** 13-week window = calendar weeks ending Saturday or trailing 91 days? Default: trailing 91 days.

---

### Sprint 5 — Analytics Instruments

**Goal:** Build the 5 dashboard instruments reading from the rollup.

**Deliverables:**
- `public/components/InstrumentRack.js` — container below conveyor
- `public/components/DwellOscilloscope.js` — time-series line per warehouse, weekly dwell median, brushed-metal bezel, CRT-style grid (adapted to ACME palette — amber-green on cream, not phosphor-black)
- `public/components/VolumeBarChart.js` — daily chunky pixel bars, stacked by channel
- `public/components/GhostDial.js` — radial gauge, needle, green/amber/red bands (C&C style)
- `public/components/LEDScoreboard.js` — top 5 warehouses, LED-segment scrolling
- `public/components/CarrierLamps.js` — row of status lamps per carrier

All instruments:
- Click → opens Analytics Console (S6) with that instrument focused
- Hover shows tooltip with exact numbers
- Update on SSE `type: 'rollup-refreshed'` after nightly cron

**Prerequisites:** S4 (rollup exists). S2 (instrument rack placement).

**Exit criteria:**
- All 5 instruments render with real data
- Hover tooltips work
- Numbers reconcile with rollup.json

**Size:** M

**Risks:** Visual polish matching S0 tile — keep comparing.

**Testing:** Open dashboard, visual review + spot-check numbers against rollup.json.

---

### Sprint 6 — FSA Heatmap + Analytics Console

**Goal:** Canada FSA choropleth and the fullscreen analytics drill-down modal.

**Deliverables:**
- `public/geo/canada-fsa.topo.json` — pre-simplified TopoJSON, committed to repo
- `public/components/FSAHeatmap.js` — D3-based choropleth, Carmen map aesthetic (cream background, dashed grid, red pins animating in on new orders via SSE). Hover tooltip: FSA code, customer count, order count, top city. Click FSA: drill to per-FSA order list.
- `public/components/AnalyticsConsole.js` — fullscreen modal, triggered by clicking any instrument. Contains:
  - Date range selector (1w / 4w / 13w / 52w / custom)
  - All instruments at full size
  - Drill-down tables: top SKUs, per-warehouse breakdown, carrier comparison
  - CSV export per table
- Heatmap promoted to prominent position between conveyor region and instrument rack (layout update)

**Prerequisites:** S5 (instruments exist). S4 (rollup has fsa_geo).

**Exit criteria:**
- Heatmap renders entire Canada at FSA granularity, colored by order density
- Analytics Console opens, date range works, tables show data
- CSV export produces valid files
- New-order SSE events drop pins on the map

**Size:** M

**Risks:** TopoJSON size (~1.5-2 MB) — aggressive pre-simplification, confirm browser performance. If FSA geo proves too heavy, fallback to province-level choropleth.

**Testing:** Hover provinces/FSAs, verify tooltips. Change date range in console, verify numbers shift.

---

### Sprint 7 — Inventory View (Prosol + FBA) + SKU Config

**Goal:** Unified inventory data layer + SKU config file. Dashboard instrument showing stock levels.

**Deliverables:**
- `GET /api/inventory/prosol` — calls existing `ProsolClientV2.getInventoryByLocation` for sales-active SKUs (last 13w from rollup). Cached 30 min.
- `GET /api/inventory/fba` — calls SP-API `GET /fba/inventory/v1/summaries`. Cached 1 hour. If SP-API creds missing, returns `{ status: "pending", reason: "sp-api not configured" }`.
- `GET /api/inventory/merged` — joins Prosol + FBA by SKU, adds fields from sku-config
- `data/sku-config.json` — per-SKU object:
  ```json
  {
    "sku": "C010382-4",
    "vendor": "prosol",
    "lead_time_days": 3,
    "safety_stock_days": 7,
    "case_pack_qty": 12,
    "preferred_reorder_qty": 48,
    "unit_cost": 18.50,
    "is_fba": true,
    "last_updated": "2026-04-15T10:00:00Z"
  }
  ```
- Seeded from `sku-map.json` with defaults (vendor=prosol, lead_time=3, safety=7, case=1, reorder=10, cost=0, is_fba=false)
- `GET /api/sku-config` + `PATCH /api/sku-config/:sku` — CRUD, audited
- `public/components/InventoryTanks.js` — instrument: vertical tank gauges per top-10 SKU, fill level = current stock / (ROP × 2), color by band (green / amber / red)
- `public/components/InventoryConsole.js` — fullscreen modal, full SKU table, editable fields inline, filter/sort

**Prerequisites:** S4 (rollup gives sales-active SKU list). **Mac gate: SP-API registered + refresh token provided** (for FBA column; Prosol-only works without it).

**Exit criteria:**
- Inventory tanks render with Prosol data
- If SP-API creds present, FBA column also populated
- SKU config editable, persists, shows in audit log
- Merged endpoint returns joined view

**Size:** M

**Risks:** Prosol's Puppeteer-based client is slow — batch inventory across 50+ SKUs takes minutes. Mitigation: parallelism cap + progress feedback. SP-API not yet available → design so feature works Prosol-only.

**Testing:** Open Inventory Console, verify stock levels against known Prosol UI. Edit a SKU's lead_time, refresh, confirm persisted.

**Open decisions:** Which SKUs to pull inventory for — all mapped or sales-active? Default: sales-active.

---

### Sprint 8 — Reorder Alerts

**Goal:** Automated detection and alerting when SKU stock drops below reorder point.

**Deliverables:**
- `lib/reorder.js` — computes ROP = `avg_daily_sales × (lead_time_days + safety_stock_days)` per SKU using rollup + sku-config. Returns `[{ sku, current_qty, rop, suggested_qty, vendor, days_of_cover }]` for SKUs below ROP.
- `GET /api/reorder/alerts` — returns below-ROP list
- Nightly cron runs after analytics rollup: fires Telegram alert if any SKUs below ROP. Dedupe — only alert on new entries (stored in `data/reorder-state.json`).
- Dashboard: inventory tanks blink red below ROP, amber approaching (within 1.5× ROP)
- Alert lamp in Header when any SKU below ROP

**Prerequisites:** S7 (inventory + sku-config). S4 (avg_daily_sales from rollup).

**Exit criteria:**
- Artificially lower a SKU's safety_stock_days → triggers alert Telegram + dashboard lamp
- Alerts dedupe across nightly runs
- Below-ROP count visible in Header at a glance

**Size:** S

**Risks:** Low. Math is straightforward, Telegram integration exists.

**Testing:** Temporarily bump a SKU's safety_stock to force below-ROP, run `node -e "require('./lib/reorder').computeAlerts().then(console.log)"`, verify Telegram arrives.

---

### Sprint 9 — Replenishment PO Builder

**Goal:** Full workflow: select SKUs → adjust → preview → generate PDF → email vendor OR create FBA inbound plan.

**Deliverables:**
- `public/components/POBuilder.js` — wizard modal inside Inventory Console:
  - Step 1: Auto-selects below-ROP SKUs, Mac toggles and adjusts quantities (rounded to case_pack)
  - Step 2: Select vendor (per SKU vendor field)
  - Step 3: Preview line items with costs
  - Step 4: Choose output path:
    - **Vendor email** — generate PO PDF, email to vendor contact with attachment
    - **Amazon FBA inbound** — create SP-API inbound shipment plan, present confirmation, finalize
- `GET /api/reorder/po-preview` — returns preview
- `POST /api/reorder/po-create` — generates PO, persists `data/replenishment-pos/<YYYY-MM-DD>-<seq>.json`, audits
- `POST /api/reorder/fba-inbound-plan` — SP-API `POST /inbound/fba/2024-03-20/inboundPlans`, returns `inboundPlanId`
- `POST /api/reorder/fba-inbound-confirm/:planId` — confirms + generates shipping labels
- PO PDF generator — reuses Puppeteer pattern from `lib/packing-slip.js`, new template in `lib/replenishment-po-template.js`
- Vendor email template in `lib/emailer.js`

**Prerequisites:** S8 (below-ROP detection). **Mac gate: SP-API Reports + FBA Inbound scopes for FBA path.**

**Exit criteria:**
- Click "Build Replenishment PO" from dashboard, wizard opens with pre-selected below-ROP SKUs
- Adjust quantities, preview, generate PDF
- Email sent to test vendor, PDF attached and renders correctly
- (If SP-API ready) FBA inbound plan created, inboundPlanId returned, labels downloadable

**Size:** L

**Risks:** FBA inbound is multi-step and Amazon changes API semantics. **Ship vendor-email path first**, FBA inbound as follow-up within same sprint or deferred to S9.5.

**Testing:** Full wizard flow with test vendor email. If SP-API ready, full FBA flow with smallest possible test shipment.

**Open decisions:** Replenishment flow — Prosol → own warehouse → FBA, Prosol direct to FBA, direct from manufacturer, or mix? Affects PO template ship-from/ship-to fields.

---

### Sprint 10 — Profitability Rollup (Settlement + Finances → Net Margin)

**Goal:** Ingest Amazon financials and compute per-SKU margin BEFORE ad spend. (Ads layer = S11.)

**Deliverables:**
- `lib/sp-api-client.js` — reusable SP-API client:
  - LWA token refresh with automatic refresh-before-expiry
  - Rate limiting per SP-API docs
  - Report request/poll/download pattern
  - Report types supported initially: `_GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2_`
- `scripts/build-profitability.js`:
  - Ingest Settlement reports (60-day rolling window for refund lag)
  - Ingest Financial Events API for real-time detail between settlements
  - Join ShipStation label costs from audit.jsonl (by trackingNumber → order)
  - Join COGS from sku-config unit_cost × quantity
  - Emit `data/profitability/rollup.json` per (sku, week):
    - `revenue`, `refunds`, `amazon_referral_fee`, `fba_fee`, `storage_fee`, `other_fees`
    - `cogs`, `shipping_cost`
    - `net_margin_pre_ads`, `margin_pct_pre_ads`
    - `as_of_date` (flag for refund-lag recomputation)
- `GET /api/profitability/rollup` — serves latest
- Cron: nightly after analytics rollup

**Prerequisites:** S4 (rollup pattern). S7 (sku-config for COGS). **Mac gate: SP-API registered with Reports + Finances scopes.**

**Exit criteria:**
- `node scripts/build-profitability.js` completes
- Spot-check: pick 5 SKUs, verify margin within 5% of Seller Central
- "as_of" timestamps correct
- Refund lag re-computation works (re-run tomorrow, confirm revised numbers for 59-day-old orders)

**Size:** L

**Risks:** **HIGH RISK SPRINT.** Settlement report is async and complex. Build SP-API client first with one simple report, validate, then expand. Rate limits. Errors in report parsing can propagate into garbage margins.

**Testing:** Run script, compare 5 SKU margins against Seller Central exports. Both must reconcile within 5%.

**Open decisions:** Refund-lag recomputation strategy (overwrite in-place vs revised columns). Default: overwrite.

---

### Sprint 11 — Amazon Ads API + ACoS Attribution

**Goal:** Layer ad spend and ACoS onto profitability rollup.

**Deliverables:**
- `lib/amazon-ads-client.js` — Ads API client with own OAuth flow, token refresh
- `scripts/build-profitability.js` — extended:
  - Ingest Sponsored Products, Sponsored Brands, Sponsored Display campaign data
  - Attribute ad spend to SKU by campaign → ad group → keyword → product
  - Append to rollup: `ad_spend`, `attributed_sales`, `acos` (= ad_spend / attributed_sales), `net_margin` (= pre_ads - ad_spend), `margin_pct`
- `GET /api/profitability/ads-summary` — ACoS per campaign for lamps

**Prerequisites:** S10 (profitability rollup exists). **Mac gate: Amazon Ads API app registered + profile_id + refresh_token.**

**Exit criteria:**
- Full margin numbers include ad spend
- ACoS values reconcile with Amazon Ads console
- Pre-ads vs post-ads margins clearly distinguished

**Size:** M

**Risks:** Ad attribution is inherently imperfect (Amazon attribution window + organic sales tagged as ad-driven). UI must show ACoS as directional, not precise.

**Testing:** Compare ACoS for one campaign against Ads console for same period.

---

### Sprint 12 — P&L Console + Cash Register + Waterfall

**Goal:** Visualize profitability data. Purely frontend over existing data layer.

**Deliverables:**
- `public/components/CashRegister.js` — instrument: receipt-style LED readout showing today's / this week's / this month's net margin, auto-advancing (C&C LCD style)
- `public/components/PLConsole.js` — fullscreen modal:
  - Date range selector
  - Per-SKU margin table, sortable by revenue / margin / ACoS / margin%
  - Ad ACoS lamps (green <20% / amber <35% / red >35%)
  - Waterfall chart
  - "As of" date indicator
  - CSV export
- `public/components/WaterfallChart.js` — SVG waterfall: revenue → referral fee → FBA fee → storage → COGS → shipping → ads → net. Each step chunky pixel bar, outline black, ACME palette.

**Prerequisites:** S10 (pre-ads data). S11 (with-ads data) — degrades gracefully if S11 not yet done.

**Exit criteria:**
- Cash register shows real current margin
- P&L Console: waterfall sums match net margin in table
- ACoS lamps colored correctly
- Sortable columns work, CSV exports valid

**Size:** M

**Risks:** Low. Pure UI over solid data.

**Testing:** Open console, verify waterfall total = table net margin, spot-check SKUs.

---

### Sprint 13 — Legacy Retirement + Hardening

**Goal:** Remove old dashboard, harden error handling, production-stabilize.

**Deliverables:**
- Archive `public/index.html` → `public/_legacy/index.html` or delete after 2-week stability window
- Route `/` exclusively to new dashboard
- Remove `/legacy.html` route
- Preact error boundaries on every component (fallback UI, not white screen)
- SSE reconnection with exponential backoff (1s, 2s, 4s, 8s, 16s, cap at 30s)
- Loading/empty states for all API-dependent components
- `GET /api/health` expanded — last rollup timestamp, last profitability timestamp, SSE connection count, config.json validity
- README update — new endpoints, config format, cron schedule
- `.env.example` updated with all new vars

**Prerequisites:** All prior sprints stable for ≥1 week.

**Exit criteria:**
- Kill server mid-pipeline, restart, dashboard reconnects SSE automatically
- Pull network cable, dashboard degrades gracefully (not white screen)
- Health endpoint reports all subsystems
- No dead links to legacy

**Size:** S

**Risks:** Minimal — no new features.

**Testing:** Simulate failures (kill server, disconnect network, delete rollup file), verify graceful degradation each time.

---

## Change Log

- **2026-04-15 (initial)** — 13 sprints + Sprint 0. Aesthetic pinned as ACME Command HQ (Carmen + LEGO + C&C + Theme Hospital). Auth: password login page. Mac to start SP-API + Ads API registration immediately.
- **2026-04-15 (revision 1)** — Architecture clarified: two-process split on the existing always-on Mac mini, Tailscale-only access, no VPS, no public URL. Pipeline watchdog added to S1. Cron ownership split between processes.
