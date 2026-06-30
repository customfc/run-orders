# FBA Auto-Restock Plan — never let a top SKU go dead

Authored 2026-06-16. Goal: top-revenue FBA SKUs never hit 0 FBA stock and lose the Prime buy box again.
Priority is ranked by trailing SALES DOLLARS, not unit velocity.

## Root cause (proven from data 2026-06-16)
When a top SKU's FBA on-hand hits 0, we drop to FBM-only and forfeit the Prime buy box.
An FBM offer cannot beat an FBA competitor at price parity (Amazon gives FBA the tie;
US cross-border sellers on .ca routinely take it). Two live examples:
- DHERT103BW / B01E7WHC34 (non-prog thermostat): ~30 units/mo through Jan-2026, then ran out of
  FBA -> our_is_fba=0 every day -> buy box held by a US FBA seller 15 of 21 days -> sales cratered.
- 88-3WTH-F3NL / B07BKST1ZY (WiFi thermostat): $9,800 in Jan-2026, dead since April -> FBA=0 AND
  priced 363.37 vs a ~280 buy box (29% too high).
So prevention has TWO legs: (a) never let top-SKU FBA cover dip low; (b) keep price competitive vs the live buy box.

## Top cluster (stocked out, ranked by trailing 3-mo revenue Apr-Jun)
1. DITRA-HEAT-E-RS1 Smart Thermostat  8D-MV2H-J3A4 -> DHERT105/BW   ~$5,490/mo   COST MISSING
2. Bona Mega Satin 1 gal              2U-D2GR-2BHN -> Treeco         ~$1,933/mo   thin margin
3. DITRA-HEAT-E-R non-prog thermostat DHERT103BW   -> DHERT103BW    ~$1,654/mo
4. KERDI-BAND 5in waterproofing strip 1K-Z895-SQRZ -> KEBA100125    ~$1,027/mo
5. DITRA-HEAT Cable 240V 88.2ft       11461-DHEHK24027 -> DHEHK24027 ~$907/mo
6. DITRA-HEAT-E-WIFI Thermostat       88-3WTH-F3NL -> DHERT104/BW    ~$606/mo    COST MISSING + overpriced
   (also: Kerdi-Seal Pipe Nipple WS-D4GC-Z09D and Corner Shelf SES3D6MGS = UNMAPPED)

## What already exists (do NOT rebuild)
- inventory_daily ETL: pull-inventory-planning.js + pull-restock-recs.js @ 6am weekdays
  -> sync-snapshots.js -> data/analytics.sqlite (live; fresher than data/analytics-backup/).
- lib/auto-restock.js : builds per-vendor PO drafts + Telegram approve URLs. enabled:false (SHADOW).
- lib/auto-reprice.js + buybox-defender FBM repricer cron. enabled:false (SHADOW).
  buybox_daily has our_price/bb_price/our_is_fba/bb_is_fba/bb_is_us/offer_count.
- FBA inbound v2024-03-20 steps 1-5 proven (create-inbound -> packing -> placement -> transport -> labels).
  Real reseller shipment 2026-06-11: FBA19G0V65LD / ref 142FUUTB / FC YXU1.
- lib/prosol-stock.js + scripts/fba/pull-prosol-stock.js (WCAS = primary id 10054). lib/telegram.js notify().

## Gaps to close (the work-list)
G1. scripts/fba/fba-inbound-spd.js (setPackingInformation -> unlocks UPS partnered SPD) is NOT on the
    Mac Mini. Canned step2 still skips packing info => LTL-only. Re-create + commit.
G2. No CFC/PBSI warehouse on-hand query (SF exposes cost only). "ship now vs PO first" = Prosol availability only.
G3. Prosol stock snapshot shows available:1 at every location = binary in-stock FLAG, not a count.
    Don't quote unit depth; verify the puller's quantity fidelity.
G4. 2 top SKUs unmapped (no prosol_sku): WS-D4GC-Z09D (Kerdi-Seal Pipe Nipple 1/2in),
    SES3D6MGS (Quadrilateral Corner Shelf).
G5. 2 top thermostats missing cost_cad: DHERT105/BW (RS1 Smart), DHERT104/BW (WiFi).
G6. Barcode status per cluster SKU unverified. Reseller inbound fails FBA_INB_0465 unless Amazon-barcode
    (X00 FNSKU). Stranded manufacturer-barcode FBA stock blocks the new SKU's fa registration.

## Phased plan (approval-gated; honor alert+propose / human-triggers-buys)
PHASE 0 - Data truth (no spend)
 - Map the 2 unmapped SKUs (prosol_sku + api_sku + cost).
 - Backfill cost_cad for DHERT105/BW and DHERT104/BW from the Prosol product lookup.
 - Verify Prosol stock puller returns real qty (not a 0/1 flag); fix if flag-only.
 - Run check-listings-status.js on the cluster: confirm each is Amazon-barcode (X00 FNSKU) and BUYABLE.

PHASE 1 - Watchlist + signal
 - Define a TOP-SKU watchlist = SKUs whose trailing 90-day revenue >= threshold (from v_sku_monthly_pnl).
 - Add a days-of-cover alarm: FBA total_days_of_supply < N (start 21) on a watchlist SKU -> Telegram ATTN.
 - This is the early-warning that did not exist; fires BEFORE stock hits 0.

PHASE 2 - Restock proposal (SHADOW first)
 - Enable lib/auto-restock.js for the watchlist only, SHADOW: build per-vendor PO draft + Telegram
   approve URL with proposed qty (size to ~60-90 day cover x daily_velocity), cost, and vendor.
 - Mac one-tap approves -> draft becomes a real Prosol/Treeco PO (per-email approval still required).

PHASE 3 - Inbound automation
 - Re-deploy fba-inbound-spd.js; wire approved draft -> create-inbound -> packing+setPackingInformation
   -> placement -> transport (UPS partnered SPD) -> labels (FNSKU PDF, fetch bytes within 29s).
 - Surface shipmentConfirmationId + amazonReferenceId; Mac books the physical pickup.

PHASE 4 - Price defense (pairs with restock)
 - Enable auto-reprice for watchlist so the FBM mirror stays buy-box-competitive while FBA refills.
   WiFi thermostat is the poster child: drop from 363 toward the ~280 buy box (with a margin floor).

PHASE 5 - Go live for the top cluster first, widen by revenue rank. Keep cost-confirm on spends > $30.

## Open decisions for Mac
- Days-of-cover trigger N (default 21) and target cover (default 60-90 days).
- Auto-restock fully automatic vs. one-tap-approve (recommend one-tap to start; standing rule = human triggers buys).
- Brand-gating: are any cluster ASINs DISCOVERABLE-not-BUYABLE (err 18299/100390)? Needs Seller Central approval.
