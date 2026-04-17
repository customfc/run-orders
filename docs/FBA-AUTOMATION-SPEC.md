# FBA Automation Spec

## Goal
Build an always-on FBA replenishment + opportunity engine that parallels the FBM pipeline (`lib/pipeline.js`). It reads every signal Amazon gives us (and some it doesn't), decides what to buy, from whom, in what order, respects monthly cash, drafts POs, gates on human approval, ships into FBA, tracks receipt, and chases reimbursements.

Design principle: **scripts + SP-API + deterministic rules > conversational reasoning**. Same idempotent, phase-based, SSE-streamed model the FBM pipeline already uses.

---

## Problem Statement (What's Broken Today)

1. Amazon's Restock page (GET_FBA_INVENTORY_PLANNING_DATA) tells us "ship X units in Y days" but we don't check it daily → stockouts.
2. Once we do check, it's a manual slog: gather SKUs → group by vendor → type PO → email → wait → create Amazon inbound → arrange pickup → drop off. Easy to lose a line.
3. Amazon only surfaces restock for what's already listed. It can't tell us about:
   - Vendor SKUs we haven't listed yet
   - Listings losing Buy Box (no point restocking)
   - Lost/damaged FBA inventory we can reimburse on
   - Keyword gaps in Brand Analytics
   - Long-tail variations orphaned from parents
   - AWD arbitrage on overstocked slow-movers
4. Cash gets tied up in FBA inventory with 30-90 day turnover — no one is projecting cash impact before POs go out.

---

## Architecture

### Pipeline phases (mirrors `lib/pipeline.js`)

```
SIGNAL → FORECAST → OPTIMIZE → SOURCE → DRAFT_PO → APPROVE → EMAIL → INBOUND → LABEL → SHIP → TRACK → RECONCILE
                                                                                                          ↓
                                                                                                    REIMBURSE
```

Every phase:
- Idempotent. Writes `data/ops-state/fba-<phase>-<date>.json` marker.
- Logs every decision to `data/audit.jsonl` with `{phase, sku, asin, qty, cost, cash_impact, reason}`.
- Streams progress to the dashboard over SSE (same pattern as `/api/pipeline/run`).
- Can be run standalone for debugging.

### State model (JSON files, same pattern as FBM)

```
data/fba/
  snapshots/                  # daily Amazon report pulls (raw)
    inventory-planning-YYYY-MM-DD.json
    sales-traffic-YYYY-MM-DD.json
    fees-YYYY-MM-DD.json
    settlements-YYYY-MM-DD.json
    reimbursements-YYYY-MM-DD.json
  forecast/                   # demand model output per SKU
    <sku>.json                # rolling 90-day forecast, lead-time dist
  plans/                      # proposed replenishment plans
    plan-YYYY-MM-DD.json      # full state: SKUs, qtys, vendors, cash
  pos/                        # generated POs (pre + post confirmation)
    <vendor>-<yyyymmdd>-<seq>.json
  inbound/                    # Amazon inbound plans/shipments
    <planId>.json
  ledger/
    cash-flow.json            # running 90-day projection
    open-pos.json             # unconfirmed + confirmed PO ledger
    reimbursement-claims.json
  catalog/
    vendor-catalogs/          # full vendor SKU catalogs (new-product discovery)
  opportunities/              # weekly opportunity scan outputs
    YYYY-MM-DD.json
```

Add a lightweight time-series store (sqlite) for velocity/conversion/BuyBox history — JSON files are fine for snapshots but bad for trend queries.

---

## Phase 1: SIGNAL — Pull every Amazon data source

Runs every morning at 6 AM ET (cron) via a new `lib/sp-api-reports.js` that extends the existing `lib/sp-api.js` token handler.

### Reports to pull daily

| Report / API | Purpose | SP-API endpoint |
|---|---|---|
| `GET_FBA_INVENTORY_PLANNING_DATA` | **The Restock page data.** Recommended qty, days-of-cover, lead time, alert level, lost-units-last-30d | Reports API |
| `GET_SALES_AND_TRAFFIC_REPORT` (by-ASIN daily) | Sessions, unit session %, conversion, Buy Box % | Reports API |
| `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | Actual cash landed per settlement — feeds cash-flow projection | Reports API |
| `GET_FBA_STORAGE_FEE_CHARGES_DATA` | Monthly storage fees per ASIN | Reports API |
| `GET_FBA_INVENTORY_AGED_DATA` | Aged inventory surcharge risk (180d/270d/330d/365d buckets) | Reports API |
| `GET_FBA_REIMBURSEMENTS_DATA` | Reimbursements Amazon paid — need to cross-check against what we're owed | Reports API |
| `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | Returns per ASIN — feeds net velocity | Reports API |
| `GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA` | Lost/damaged by Amazon — reimbursement targets | Reports API |
| `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` | Removal orders in flight | Reports API |
| Product Fees API (per ASIN) | Referral %, FBA pick/pack, LIPC (low-inventory-cost fee) exposure | `/products/fees/v0/listings/{sku}/feesEstimate` |
| Pricing API → Competitive Summary | Buy Box winner, lowest price, featured offer | `/products/pricing/2022-05-01/items/competitiveSummary` |
| Listings API | Listing status (Active/Suppressed) — don't restock suppressed ASINs | `/listings/2021-08-01/items/{sellerId}/{sku}` |
| Finances API — Financial Events | Real-time charges/refunds between settlements | `/finances/v0/financialEvents` |
| Notifications API | Subscribe to `REPORT_PROCESSING_FINISHED`, `BRANCH_ORDER_CHANGE`, `FULFILLMENT_ORDER_STATUS` | `/notifications/v1` |

### Weekly pulls (Sunday 2 AM ET)

| Source | Purpose |
|---|---|
| Brand Analytics: Top Search Terms | Keyword gap analysis — search terms we rank in but have no relevant listing for |
| Brand Analytics: Repeat Purchase Behavior | Subscribe-and-save candidates, high-repeat SKUs → stock more aggressively |
| Brand Analytics: Market Basket Analysis | Bundle opportunities |
| Product Opportunity Explorer | Niche-level search frequency rank, click share — find whitespace in our categories (flooring accessories, tile tools) |
| Seller Central "Opportunity" reports (via manual download until API, e.g. `GET_BRAND_ANALYTICS_*`) | Cross-check |

### Monthly

| Source | Purpose |
|---|---|
| IPI score, capacity limits | Storage cap planning |
| Vendor catalog sync (Prosol, Bona, Schluter, Aqua Mix, etc.) | New-product discovery pipeline |
| Amazon Ads API — spend, ACOS, orders by campaign | Tie replenishment to ad-driven velocity |

All raw reports land in `data/fba/snapshots/` untouched. Transforms happen in later phases.

---

## Phase 2: FORECAST — Demand projection per SKU

Per-SKU inputs:
- 90-day sales history (from Sales & Traffic + Orders + Settlements reconciled)
- Returns-adjusted net velocity
- Seasonality index (compute from rolling 2-year history where available; flooring products are lumpy — Q1 renovations, Q2/Q3 peak)
- Promo effect (sale price windows from Listings API)
- Ad spend correlation (campaign $ → sessions → units)
- Stockout-hours in window (to deflate observed velocity — don't undershoot because we ran out)

Outputs per SKU:
```
{
  sku, asin,
  velocity_30d, velocity_90d, velocity_ytd,
  forecast_p50_90d, forecast_p90_90d,   // p90 = "90% chance demand ≤ this"
  lead_time_days_p50, lead_time_days_p90,
  seasonality_factor_next_30d,
  days_of_cover_now,
  reorder_point,                         // safety stock + lead-time demand at p90
  target_stock,                          // cover until next reorder + safety
  suggested_ship_now, suggested_ship_in_days,  // overrides Amazon's rec where our signal is stronger
  confidence: "high|med|low"
}
```

Override Amazon's restock number when:
- Our velocity signal disagrees (e.g., Amazon is averaging over a stockout window)
- Buy Box % < 70% (don't send more if we're not winning the offer)
- Listing suppressed or at review-bomb risk
- Aged inventory already in warehouse (reduce order)

---

## Phase 3: OPTIMIZE — Cash-constrained order planning

This is the brain. Takes forecast + current inbound-in-flight + open POs + **cash budget** and produces a ranked order plan.

### Constraints

1. **Monthly cash envelope.** User sets a ceiling per month (e.g., $50K in April). Pull open POs + in-flight inbounds + committed spend, know what's left.
2. **FBA capacity limits.** Storage capacity (cubic ft) and restock limits by storage type (Standard/Oversize/Apparel). Don't plan shipments that exceed capacity.
3. **Low-Inventory-Level Fee avoidance.** Amazon charges extra if <28d cover. Cost this into the prioritization — SKUs near the LIPC threshold get priority.
4. **Aged inventory penalty.** SKUs hitting 181d/271d/331d/365d bands incur surcharges — trigger removal / AWD transfer / liquidation ahead of billing date.
5. **Vendor MOQ + pack quantities.** Round up to vendor-imposed minimums.
6. **Lead time buffer.** Prefer ordering earlier when lead time variance is high.

### Scoring function (per SKU per candidate qty)

```
score = (unit_margin × velocity_30d × buy_box_rate)           // revenue velocity
      - (cash_tied_up / days_to_cash_return × cost_of_capital)  // cash drag
      - stockout_penalty_if_skipped                             // lost margin + rank decay
      - lipc_fee_if_understocked                                // low-inventory-level fee
      - aged_inventory_risk_if_overbought                       // aged surcharge
      - storage_fee_for_qty                                     // monthly storage
```

Then knapsack the list under the month's cash envelope. High-margin, high-velocity, Buy Box-winning SKUs get funded first.

Output: `data/fba/plans/plan-YYYY-MM-DD.json` with SKUs, qtys, vendors, total cash, expected ROI, payback window.

---

## Phase 4: SOURCE — Allocate to vendors

- Map each line to primary vendor from `sku-map.json` (extend with MOQ, case pack, lead time, NET terms, per-SKU cost).
- If Prosol is primary, check live Prosol stock via existing `prosol-client-v2.js` — if out, flag alternate vendor or defer.
- Multi-vendor SKUs: pick by landed cost including shipping to our warehouse vs. directly to FBA.
- **Drop-ship-to-FBA candidates**: some vendors will ship directly to Amazon inbound with our FBA labels applied by the vendor (Prosol supports this case-by-case). Flag these — they cut us out of the middle entirely.

---

## Phase 5: DRAFT_PO — Generate purchase orders

Per vendor, consolidate lines into a draft PO:
- Extend `lib/amazon-po.js` pattern. Create Salesforce SO+PO for FBA the same way we do for FBM, but tagged `Channel__c = "FBA"` and linked to a new `FBA Master SO` (rolling one per month, not per 14 days).
- Include: vendor item ID, qty, case pack, unit cost, extended cost, expected ship date, ship-to (our warehouse or FBA directly).
- Compute full PO summary: total $, payment terms, expected receipt, cash-out date.
- Store as `data/fba/pos/<vendor>-<yyyymmdd>-<seq>.json` with status `draft`.

---

## Phase 6: APPROVE — Human gate

Non-negotiable. POs don't go to vendors without human confirm.

Delivery channels:
- Dashboard tab "FBA Command" → shows all drafts with qty / cost / cash delta / expected margin
- Telegram notification: `/fba-review` lists pending drafts with inline approve/defer/edit buttons
- Per-draft actions: approve as-is, cut qty, defer to next run, reject

On approve: status → `approved`, queues for email phase.

This is where the FBM pipeline's 60s email spacing idea applies — **never auto-fire multiple vendor emails in quick succession without an approval gate**.

---

## Phase 7: EMAIL — Send POs

Reuse `lib/emailer.js`. Same 60s spacing to avoid quarantine. PDF attachment generated from PO JSON via existing packing-slip pattern.

Vendor-specific recipients live in `sku-map.json` → extend with `vendor_contact` block per vendor. Cc: `mac@customfc.ca`.

Subject line: `PO #{{poNumber}} — {{vendor}} — FBA restock — please confirm stock & ship date`.

Post-send: status → `sent`, log to `audit.jsonl`, start waiting for vendor confirmation.

---

## Phase 8: INBOUND — Create Amazon inbound plan

**Triggered by vendor confirmation** (inbound email parsing, or manual "confirmed" button).

Use the new **Fulfillment Inbound v2024-03-20** API (the "Send to Amazon" workflow, replaces the legacy v0):

1. `POST /inbound/fba/2024-03-20/inboundPlans` — create plan with items + qtys
2. `GET /inbound/fba/2024-03-20/inboundPlans/{planId}/packingOptions` — Amazon returns packing options (case-packed vs individual)
3. Pick option, `POST .../packingOptions/{packingOptionId}/confirmation`
4. `GET .../shipments/{shipmentId}/deliveryWindowOptions` — available delivery windows
5. `POST .../shipments/{shipmentId}/placementOptions/{placementOptionId}/confirmation` — lock which FC(s) Amazon routes to
6. `POST .../shipments/{shipmentId}/transportationOptions/{transportationOptionId}/confirmation` — pick Amazon Partnered Carrier (SPD or LTL) vs. own carrier
7. `POST .../shipments/{shipmentId}/labels` — get FNSKU box labels, pallet labels, BOL
8. `POST .../shipments/{shipmentId}/confirmation` — final submit

Partnered carrier decision:
- **SPD (small parcel)**: UPS via Amazon partnered, typically cheapest for <150 lb cartons
- **LTL**: Amazon partnered LTL — always compare to our own Purolator/UPS Freight quote
- **Own carrier**: when Prosol warehouse proximity to FBA node beats Amazon partnered

Store everything in `data/fba/inbound/<planId>.json`.

---

## Phase 9: LABEL — Generate carton & pallet labels

Pull from the inbound plan API. Print-ready PDFs saved to `data/fba/inbound/<planId>/labels.pdf`. If vendor is labeling for us (drop-ship-to-FBA), email labels to vendor with the PO confirmation.

FNSKU labels → one per unit if vendor is prepping. Box ID labels → one per carton. Pallet labels → one per pallet for LTL.

---

## Phase 10: SHIP — Book transport

Three routing modes:

1. **Vendor → Amazon (drop-ship)**: vendor applies our labels, we pay vendor's shipping line. Track via vendor's tracking #.
2. **Vendor → our warehouse → Amazon**: vendor ships to us (handled by existing FBM pipeline's pickup booking), we consolidate, ship to FBA using Amazon Partnered Carrier or own.
3. **Vendor → 3PL cross-dock → Amazon**: some Prosol warehouses will palletize + ship to FBA directly for a fee.

For Amazon Partnered: already handled in Phase 8. For own carrier: reuse `scripts/shipstation/book-cp-pickup.js` pattern and ShipStation V2 integration. Canada Post/Purolator/UPS pickup booking with pallet inputs.

---

## Phase 11: TRACK — Poll until received

Subscribe to **Notifications API** events (`FULFILLMENT_ORDER_STATUS` adjacent for inbound — actual endpoint for inbound shipment events):
- `FBA_INBOUND_SHIPMENT_STATUS_CHANGE` (via SQS subscription)

Or poll `GET /inbound/fba/2024-03-20/inboundPlans/{planId}/shipments` hourly until each shipment moves through `WORKING → READY_TO_SHIP → SHIPPED → IN_TRANSIT → DELIVERED → CHECKED_IN → RECEIVING → CLOSED`.

On `CLOSED`: pull receiving summary. Compare to expected qty.

---

## Phase 12: RECONCILE & REIMBURSE

For every closed shipment:
- Expected qty vs. received qty → variance report
- If received < expected by >2 units: file reimbursement claim (or queue for claim — Amazon policy changed in 2024 to auto-reimburse some, manual for others)

Continuous reimbursement scanner (separate cron, weekly):
1. `GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA` — look for `M-` / `R-` / `W-` code adjustments (lost, damaged by warehouse, warehouse adjustment)
2. `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` — customer returns with no physical return received after 45 days
3. `GET_FBA_REIMBURSEMENTS_DATA` — already-reimbursed items (don't double-file)
4. File case via Seller Central (no public API for case filing — build a Puppeteer flow like `prosol-client-v2.js`)

Typical recovery: 1–3% of FBA revenue. On a $1M run rate, that's $10–30K/yr found money.

---

## Parallel Module: OPPORTUNITY ENGINE

Runs Sunday nights. Doesn't touch replenishment — produces a weekly report of things Amazon isn't telling us.

### Signal sources & what to do with them

1. **Vendor catalog diff**. Ingest full Prosol/Bona/Schluter/Aqua Mix catalogs. Diff against our current listings. Output: unlisted SKUs ranked by estimated demand (cross-reference Amazon Catalog Items API for ASIN existence + sales rank).

2. **Brand Analytics keyword gaps**. Top search terms in our categories where we have zero click share → listing creation or ad bid opportunity.

3. **Variation orphans**. ASINs that should be children under a parent (e.g., `Schluter Pentagonal Corner Shelf` exists in 3 sizes, listed as 3 separate ASINs) — consolidating lifts conversion 20-30%.

4. **Buy Box loss scanner**. ASINs where we lost Buy Box in last 7 days → pricing action or stock action, not more inventory.

5. **Hijacker detector**. New offers on our ASINs from unauthorized sellers → Brand Registry action.

6. **Ad-to-organic gap**. High-ACOS SKUs with strong organic rank → pull back ads. Low-ACOS SKUs with weak organic rank → push ads + ensure stock.

7. **Bundle opportunity from market basket**. Two ASINs frequently co-purchased → create bundled ASIN.

8. **AWD arbitrage**. SKUs with >90d cover in FBA → push excess to AWD (~80% cheaper storage), pull back as needed. Run the numbers monthly.

9. **Removal/liquidation triggers**. Aged inventory approaching 271d/331d surcharge bands with negative trailing velocity → removal order or liquidate through Amazon Outlet / off-Amazon.

10. **NARF (Remote Fulfillment to US)**. CA listings eligible for NARF sell to US without cross-border shipping. Check eligibility monthly for our catalog.

Output: `data/fba/opportunities/YYYY-MM-DD.json` + weekly Telegram summary.

---

## Cash Flow Module

Runs daily. Consumed by the OPTIMIZE phase but also available as a dashboard widget.

### Inputs
- **Settlements (historical)**: what actually hit the bank per 14-day Amazon settlement
- **Financial Events (in-flight)**: what's accrued in the current settlement window
- **Reserve balance**: Amazon holds a percentage — pull from Financial Events
- **Open POs (approved but not yet paid)**: payment due dates by vendor NET terms
- **Inventory-in-transit**: cash already out, not yet sellable
- **FBA inventory on hand valued at cost**: tied-up working capital

### Output: 90-day cash curve

```
{ date, opening_cash, amazon_payouts_in, po_payments_out, net_change, closing_cash }[]
```

Surface red zones (closing_cash < threshold) in the OPTIMIZE phase so big POs don't get approved into a cash crunch.

### Per-SKU ROI metrics
- Cash-conversion cycle: days from PO payment → Amazon payout
- Return on invested capital (ROIC) by SKU
- Rank SKUs by ROIC for capital allocation, not just margin

---

## Dashboard — "FBA Command Center"

New tab in existing dashboard. Sections:

1. **Today** — urgent SKUs (Amazon's "ship today" bucket), stockouts, Buy Box losses, expired LIPC windows
2. **Plan** — current month's optimized plan, remaining cash envelope, what's been approved/sent/received
3. **Inbound** — open shipments by status, ETAs, variance alerts
4. **Opportunities** — latest weekly scan results
5. **Reimbursements** — pending claims, recovered YTD
6. **Cash** — 90-day curve, open PO ledger, reserve balance
7. **Audit** — full event log from `audit.jsonl`

All driven by the same SSE pattern as the FBM pipeline.

---

## Configuration Extensions

Add to `.env`:
```
AMAZON_SELLER_ID=
AMAZON_AWS_REGION=us-east-1
AMAZON_SQS_NOTIFICATION_QUEUE_URL=
AMAZON_ADS_CLIENT_ID=
AMAZON_ADS_REFRESH_TOKEN=
AMAZON_ADS_PROFILE_ID=
FBA_CASH_ENVELOPE_MONTHLY=50000
FBA_COST_OF_CAPITAL_ANNUAL=0.12
FBA_SAFETY_STOCK_DAYS=14
FBA_LIPC_THRESHOLD_DAYS=28
```

Extend `sku-map.json` per ASIN:
```json
{
  "asin": "B003IS31TS",
  "prosol_sku": "...",
  "unit_cost": 18.50,
  "vendor": "prosol",
  "vendor_item_id": "CM18",
  "case_pack": 12,
  "moq_units": 12,
  "vendor_lead_time_days": 7,
  "vendor_payment_terms_days": 30,
  "drop_ship_to_fba_eligible": true,
  "vendor_contact": "klazzarotto@prosol.ca",
  "fba_dims_in": [10, 5, 2],
  "fba_weight_lb": 1.2,
  "referral_pct": 0.15,
  "fba_fulfillment_fee": 4.75,
  "notes": ""
}
```

---

## Critical Rules

### Restock Rules
- **Never ship to FBA if Buy Box % < 60%** — fix pricing/listing first
- **Never ship to FBA if listing is suppressed** — fix listing first
- **Always respect monthly cash envelope** — partial orders > blowing budget
- **Cap any single PO at 30% of monthly cash envelope** unless explicitly overridden
- **If aged inventory >120d exists for a SKU, offset next order by aged qty**

### Reimbursement Rules
- **Cross-check reimbursements file before claiming** — don't double-file
- **Never claim for inventory adjustments <$1 per unit** — Amazon rejects
- **45-day waiting period** for customer-return reimbursements

### Cash Rules
- **Reserve balance is not spendable** — exclude from available cash
- **Count PO as committed on send date, not approval date** — conservative

### Human Gate Rules
- **No vendor email without explicit approval** — never
- **No Amazon inbound plan confirmed without inventory physically staged** — avoid placement fees on ghost shipments
- **No reimbursement case filed without human review** — Amazon penalizes sloppy cases

---

## Strategic Framing: Growth to $100K/month, Reseller Model

We are **resellers, not brand registered.** This removes from scope: Brand Analytics, A+ content, Brand Store, Product Opportunity Explorer API, hijacker takedowns, parent/child variation restructuring. Don't design around them.

The goal is **$100K CAD/month on Amazon.ca** with **growth and cash flow balanced** — not growth at any cost, not efficiency at the cost of growth.

### Reseller growth levers, ranked by leverage

| Lever | Mechanism | Why it works for a reseller |
|---|---|---|
| **Catalog breadth** | Vendor catalog diff → list every vendor SKU that already has an Amazon ASIN | Every new ASIN is incremental revenue with near-zero listing cost — we don't create the listing, we join it |
| **Buy Box win rate** | Pricing API + repricer with margin floors + competitive intel | You cannot sell what you don't have the Buy Box on — this is the #1 reseller lever |
| **In-stock rate** | Daily restock automation, aggressive safety stock on winners | Stockouts tank BSR and give competitors the sale; compounds over weeks |
| **FBM → FBA graduation** | Identify high-velocity FBM SKUs → move to FBA | Prime eligibility materially lifts Buy Box % and conversion |
| **NARF (Remote Fulfillment to US)** | Enable CA FBA listings to sell to US customers | Doubles your addressable market with zero new inventory |
| **Price-elasticity testing** | Algorithmic price nudges within margin floor, watch BB% and velocity | Find the local optimum per SKU |
| **Condition/handling-time optimization** | Ensure all FBA listings show fastest Prime, not slow 2-day where 1-day is possible | Small BB% nudge |

### Cash flow levers (guardrails, not blockers)

| Lever | Mechanism |
|---|---|
| **Monthly cash envelope scaled to revenue target** | Envelope grows with revenue — e.g. ~40–60% of trailing 30d revenue as inventory investment, depending on turnover |
| **Settlements projection** | 90-day cash curve from Financial Events + Settlements so we don't fund POs into a cash crunch |
| **Reimbursement recovery** | Lost/damaged/returns-not-received claims — 1–3% of FBA revenue. At $100K/mo that's $12–36K/yr |
| **AWD arbitrage** | Overstock → AWD (~80% cheaper storage) — matters more as SKU count grows |
| **Aged inventory triggers** | Removal/liquidate before 181/271/331/365d surcharge bands |

### Budget philosophy

Cash flow is a **guardrail, not a gate.** A growth-funding PO with strong ROI (high margin × velocity, or a new-ASIN first buy) can push the envelope up for that month if cash curve supports it. The optimizer scores by ROIC and respects the envelope, but the envelope itself flexes month-to-month based on revenue trajectory — not a fixed number baked in forever.

---

## Build Order (Growth-First, Cash-Aware)

### Phase 1 (Weeks 1-2): Signal + stockout defense + Buy Box intel
**Goal: stop revenue already leaking. No code is growth-generating yet — it's growth-protecting.**

- Extend `lib/sp-api.js` with Reports API async polling (request → wait → download → parse)
- Daily pulls: `GET_FBA_INVENTORY_PLANNING_DATA` + `GET_SALES_AND_TRAFFIC_REPORT` + Pricing API competitiveSummary per ASIN
- **Stockout dashboard**: every "ship today" rec surfaces with historical velocity + margin + Buy Box %
- **Buy Box monitor**: alert on BB% drops, show winning offer, delta from our price
- **Cash starting position**: pull last 90d settlements, compute current cash runway
- SSE stream + dashboard tab "FBA Command → Today"

Outcome: every morning you wake up to a prioritized list of what to ship today and where you're losing Buy Box. No POs sent yet — just visibility.

### Phase 2 (Weeks 3-4): Catalog expansion engine — THE reseller growth lever
**Goal: add 50–200 new ASINs in the first cycle.**

- **Vendor catalog ingestion**: scrape or import Prosol, Bona, Schluter, Aqua Mix, Perfect Level catalogs into `data/fba/catalog/vendor-catalogs/<vendor>.json`
- **Gap detection**: diff vendor SKU list against our active Seller Central listings (Listings Items API)
- **ASIN matching**: for each gap SKU, Catalog Items API lookup by UPC/EAN — find existing Amazon ASIN
- **Ranking**: score gaps by estimated demand (Sales Rank, category avg velocity) × estimated margin (our cost vs. lowest offer)
- **Bulk listing creation**: Listings API v2021-08-01 `PUT /listings/2021-08-01/items/{sellerId}/{sku}` with OFFER-only submission (we're not creating the ASIN, just joining an existing one as a new offer)
- Dashboard tab "FBA Command → Catalog Gaps" with bulk-approve + bulk-list actions

Outcome: a machine that takes "all vendor catalogs" + "all our listings" and surfaces listable ASINs ranked by expected revenue, with one-click publish.

### Phase 3 (Weeks 5-6): Repricer + FBM→FBA graduation
**Goal: win more Buy Box on existing SKUs + move proven FBM winners to FBA.**

- **Automated repricer**:
  - Pull competitive summary per ASIN every 15 min
  - Rules: match lowest FBA offer minus $0.01 (aggressive), or match within X% (conservative), with hard margin floor
  - Never reprice below `unit_cost × (1 + referral_pct) + fba_fee + target_margin_floor`
  - Handle "sole offer" (don't drop price unnecessarily) vs. "price war" (hold firm at floor, don't chase) vs. "winning BB" (can nudge up) states
- **FBM→FBA graduation list**: flag every FBM SKU with >N monthly units from trailing 90d where the ASIN has FBA offers from competitors and we don't — add to next Phase 5 restock plan as FBA-first

Outcome: automated pricing defends Buy Box 24/7 without margin-floor violations.

### Phase 4 (Weeks 7-8): Replenishment with growth-aware envelope
**Goal: close the loop from signal to PO sent.**

- Forecasting model: trailing velocity × seasonality × Buy Box % × stockout-hours adjustment
- Optimizer with **growth-aware envelope**: monthly cash cap scales with trailing revenue, new-ASIN first-buys get a dedicated sub-budget so catalog expansion doesn't compete with restock
- PO draft + approve gate (dashboard + Telegram)
- Email via `lib/emailer.js` (60s spacing, same pattern as FBM)
- Salesforce SO/PO creation tagged `Channel__c = "FBA"`, rolling monthly Master SO

Outcome: full vendor-ordering pipeline automated end-to-end with approval gate.

### Phase 5 (Weeks 9-10): Amazon inbound automation
**Goal: vendor confirmation → FBA receipt fully automated.**

- Inbound v2024-03-20 API integration (createInboundPlan → packingOptions → placementOptions → transportationOptions → labels → confirmation)
- Partnered carrier SPD/LTL decision vs. own carrier
- Label/BOL generation, email to vendor if drop-ship-to-FBA
- Notifications API → SQS subscription for shipment status
- Variance reconciliation on CLOSED

Outcome: once a vendor confirms a PO, no human touches the shipment until it's received at FBA.

### Phase 6 (Weeks 11-12): NARF + margin recovery
**Goal: +20–40% revenue from US market without new inventory. Plus plug margin leaks.**

- **NARF enablement**: enroll eligible CA ASINs for Remote Fulfillment to US. CA inventory ships to US customers automatically.
- **Reimbursement scanner** (weekly):
  - `GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA` → lost/damaged
  - `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` → returns not physically received after 45d
  - Cross-check `GET_FBA_REIMBURSEMENTS_DATA` → don't double-file
  - Generate case packets for one-click Seller Central filing
- **AWD arbitrage**: for SKUs with >90d cover, propose transfer to AWD
- **Aged inventory triggers**: removal/liquidate before surcharge bands

Outcome: revenue expansion into US + 1–3% margin recovery from reimbursements.

### Phase 7 (Week 13+): Ads + opportunity discovery
**Goal: paid acceleration + whitespace hunting.**

- **Amazon Ads API**: pull spend + ACOS per SKU. Auto-bid adjustments within margin rules. Even without Brand Registry, Sponsored Products runs on reseller accounts.
- **Opportunity discovery** (non-Brand-Registry dependent):
  - Category BSR scanning for niches where our vendors have catalog coverage but we have no listings
  - Competitor ASIN monitoring — track a set of competing reseller accounts, surface ASINs they sell that we don't
  - Bundle opportunities via co-purchase patterns in our own order data (not Market Basket — that's BR)

Outcome: paid-traffic flywheel + proactive new-ASIN discovery beyond vendor catalogs.

---

## Target Math

Rough revenue lever model to $100K/mo (assumes current revenue as baseline X):

| Lever | Typical lift |
|---|---|
| Stockout prevention (Phase 1) | +10–25% (recovery of lost sales) |
| Repricer (Phase 3) | +5–15% (Buy Box gains on existing SKUs) |
| FBM→FBA graduation (Phase 3) | +10–20% on graduated SKUs |
| Catalog expansion, 100 new ASINs (Phase 2) | +20–50% (new revenue) |
| NARF to US (Phase 6) | +20–40% |
| Ads scaling (Phase 7) | +10–30% |

These compound. Any three out of six typically gets a reseller to 2x baseline in 4–6 months.

---

## Open Questions

1. **Current monthly revenue baseline?** Needed to size envelope + calibrate which levers matter most.
2. **Current active SKU count vs. full vendor catalog size?** Sets the catalog expansion opportunity.
3. **Working capital ceiling?** Hard max on monthly PO spend independent of the flex envelope.
4. **Marketplaces currently active?** Just Amazon.ca, or US too? Impacts NARF urgency.
5. **AWD enrollment status?** For Phase 6 arbitrage.
6. **Existing Ads spend?** For Phase 7 baseline.
7. **Reimbursement filing — Puppeteer vs. manual case packet?** Seller Central gates case-filing behind UI; Puppeteer works but fragile. Prepared case packets for one-click filing may be the safer call.

---

## References (endpoints, not to be guessed at implementation time)

- SP-API docs: https://developer-docs.amazon.com/sp-api/
- Inbound 2024-03-20 migration guide
- Brand Analytics reports list
- Product Opportunity Explorer API
- Amazon Ads API docs
- IPI & capacity manager policy pages
