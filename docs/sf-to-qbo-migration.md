# Salesforce → QuickBooks Online Migration Spec

**Status:** Draft, awaiting decisions on items flagged in §11
**Author:** drafted with Claude on 2026-04-27 (revised same day to add A2X)
**Scope:** All Salesforce reads/writes performed by `run-orders`. Replace with QuickBooks Online (QBO) as the system of record for inventory items, vendors, and purchase orders. **A2X (a2xaccounting.com) is in scope as the integration layer for Amazon and Shopify channel revenue/payouts → QBO journals.** This materially shrinks what run-orders needs to write to QBO.

---

## 1. Executive Summary

Run-orders currently writes every Amazon shipment, Shopify special order, and FBA restock to Salesforce as PBSI (Pro Business Suite Inventory) Sales Orders, Purchase Orders, and Items. PBSI is an ISV-managed package — closer to an inventory ERP than CRM — so the migration is not "switching CRMs," it's **replacing an inventory/ops backbone with QuickBooks Online's Items/POs/Bills model**.

**Key architectural change vs the v1 draft:** A2X owns channel revenue. A2X-Amazon pulls Seller Central settlements and posts settlement-period summary journals into QBO that net to the actual bank deposit. A2X-Shopify does the same for Shopify payouts. This means:

- Run-orders does **not** need to create per-Amazon-order or per-Shopify-order sales records in QBO. A2X handles all channel revenue, refunds, fees, taxes, and bank reconciliation.
- The 14-day rolling Amazon "channel SO" concept disappears entirely — A2X uses Amazon's actual settlement periods.
- Run-orders' QBO write surface shrinks to: **Vendors, Items, and Purchase Orders only**. About one-third of the original migration scope.

What QBO + A2X together cover well: channel revenue, payout reconciliation, fees, tax, vendor POs, item costs, COGS, P&L by channel.

What's now an open question (see §3a): with A2X posting summary journals (no per-order detail), QBO's perpetual inventory module never sees Amazon/Shopify consumption. Either accept QBO QtyOnHand drift and treat the local SQLite analytics DB as the inventory truth, OR have run-orders post periodic inventory adjustments to QBO. Decision needed before phase 2.

Realistic effort post-A2X: **3–4 weeks** of focused work for a parallel-write cutover, plus 1 week stabilization. Hard-cutover is possible in **1.5–2 weeks**.

---

## 2. Current State Snapshot

| Area | Salesforce footprint |
|---|---|
| Objects written | `PBSI__PBSI_Sales_Order__c`, `PBSI__PBSI_Sales_Order_Line__c`, `PBSI__PBSI_Purchase_Order__c`, `PBSI__PBSI_Purchase_Order_Line__c`, `Account` (status updates) |
| Objects read | All of the above + `Contact`, `User`, `PBSI__PBSI_Item__c` |
| Custom `mm_*` fields | `mm_Exempt_GST__c`, `mm_Exempt_PST__c`, `mm_Exempt_GST_ID__c`, `mm_Exempt_PST_ID__c`, `mm_On_Hold__c` |
| Hard-coded IDs | Shopify account `0014x000023jkuDAAQ`, Amazon account `0014x00001P1SiHAAV`, Prosol vendor `0014x00001P1ScCAAV`, Treeco vendor `0014x00001P1SW2AAN`, Tax code `a1S4x000002pMUhEAM` |
| Auth | jsforce SOAP login (username + password + security token) |
| Call sites | `lib/salesforce.js`, `lib/amazon-po.js`, `lib/shopify-sf.js`, `lib/fba-po-sender.js`, `server.js` (proposal preview), `scripts/etl/sync-item-costs.js`, `scripts/etl/sync-sku-map.js`, `scripts/analytics/generate-financial-report.js`, `scripts/analytics-data-inventory.js` |
| Distinct SOQL queries | 13 |
| Distinct writes | 9 (SO, SO line, PO, PO line, Account update — for each of Shopify/Amazon/FBA flows) |
| Business flows depending on SF | 7 (see §6) |

QBO scaffolding in repo: **none**. Greenfield.

---

## 3. Target State (QBO + A2X Architecture)

### 3.0 Division of labor

```
                ┌──────────────┐
  Amazon SC ───▶│              │
                │              │   summary journals
  Shopify   ───▶│     A2X      │──────────────────────▶ QBO
                │              │  (settlement periods,
                │              │   per-payout, nets to
                └──────────────┘   bank deposit)
                                                          ▲
                                                          │
  ShipStation ─▶ run-orders ──── POs / Bills / Items ────┘
                              (vendor procurement only)
```

| System | Owns |
|---|---|
| **A2X (Amazon)** | Amazon revenue, FBA fees, ad fees, refunds, sales tax journals, bank reconciliation for AmazonPay payouts |
| **A2X (Shopify)** | Shopify revenue, payment processor fees, gift cards, refunds, sales tax journals, bank reconciliation for Shopify Payments payouts |
| **run-orders → QBO** | Vendors (Prosol, Treeco), Items (with cost), Purchase Orders to vendors, FBA restock POs, open-pipeline tracking, vendor email/PDF flow |
| **run-orders local SQLite** | sku-map (canonical), item-cost cache, settlement/buybox snapshots, financial reporting joins |
| **QBO (passive)** | Receives A2X journals + run-orders POs, computes inventory valuation from POs/Bills, runs P&L |

### 3.0.1 A2X posting modes

A2X supports two posting strategies. Pick one and configure both Amazon and Shopify A2X subscriptions consistently.

- **Summary mode (lump-sum journals).** Each settlement becomes one journal entry: e.g. Amazon Apr 9–22 settlement = `Cr Sales 12,400` / `Dr FBA Fees 1,800` / `Dr Ad Spend 600` / `Dr Bank Deposit 9,800` / etc. **No per-order detail in QBO. No Items touched.** Bank rec is one click. Inventory in QBO is *not* deducted on sale — QBO only sees POs going in. Most FBA sellers use this mode.
- **Item-level mode.** A2X creates one SalesReceipt per Amazon order, mapped to QBO Items. Inventory is deducted on sale. QBO has full per-order detail. Heavier (creates ~80 records/day for typical FBA volume), and partly defeats A2X's "summarized journal" value proposition.

**Recommendation:** summary mode for both A2X-Amazon and A2X-Shopify. Simpler bookkeeping, faster reconciliation, smaller QBO record count.

### 3.0.2 The inventory-deduction gap

If A2X is in summary mode, QBO's `Item.QtyOnHand` only goes UP (from Bills) and never DOWN (no sales records to deduct from). Three ways to handle this:

- **Option α: accept the drift.** QBO's QtyOnHand becomes meaningless for FBA SKUs. Treat the local SQLite DB (`item_costs` + Amazon inventory snapshot tables) as the inventory truth. QBO is accounting-only. Periodic physical counts reconcile.
- **Option β: post inventory adjustments from run-orders.** Daily cron creates a QBO `InventoryAdjustment` entry: "consumed today: 47 units of SKU-XYZ". Keeps QBO's inventory module roughly accurate. Adds a write path. ~1 day of work.
- **Option γ: switch A2X to item-level mode.** Sales records hit QBO, inventory deducts naturally. But you give up summary-mode benefits.

**Recommendation:** Option α. Simpler. QBO is where accountants live; SQLite is where ops lives. Don't conflate them. Revisit if accounting starts complaining about inventory variance.

### 3.0.3 Customer/vendor records under A2X

- A2X-Amazon needs **one** QBO Customer ("Amazon" or "Amazon.ca"). It posts journals against that customer when in item-level mode, or doesn't reference one at all in summary mode.
- A2X-Shopify needs **one** QBO Customer ("Shopify Web Orders") for similar reasons.
- Run-orders does **not** create customers. Special-order Shopify cases (e.g. Biyork) — see §6.2 — handle the customer side via A2X journal lines plus a vendor PO from run-orders. The customer record in QBO is created lazily by A2X if it appears in a Shopify settlement.
- Vendors (Prosol, Treeco) are still owned by run-orders since A2X has no vendor concept.

### 3.1 QBO subscription requirement

**QBO Plus (minimum) or Advanced.** Inventory tracking, POs, and class/location tracking are gated to these tiers. Confirm current subscription before any work starts.

### 3.2 QBO object mapping (high level)

| PBSI / SF object | QBO equivalent | Notes |
|---|---|---|
| `PBSI__PBSI_Item__c` | `Item` (Type=`Inventory`) | Owned by run-orders. QBO Items have UnitPrice, PurchaseCost, QtyOnHand, IncomeAccountRef, ExpenseAccountRef, AssetAccountRef. |
| `PBSI__PBSI_Sales_Order__c` (Amazon, rolling) | **A2X journal entries** | Eliminated. A2X posts settlement-period journals automatically; no equivalent record in QBO. |
| `PBSI__PBSI_Sales_Order__c` (Shopify regular) | **A2X journal entries** | Eliminated. A2X-Shopify posts payout journals. |
| `PBSI__PBSI_Sales_Order__c` (Shopify *special order*) | Memo on the run-orders PO | The special-order case (e.g. Biyork) only needs the vendor PO. Customer revenue still flows through A2X-Shopify when the order ships. See §6.2. |
| `PBSI__PBSI_Sales_Order_Line__c` | n/a | Eliminated with parent. |
| `PBSI__PBSI_Purchase_Order__c` | `PurchaseOrder` | Owned by run-orders. Flat header + lines. No per-line SO linkage natively — see §11.B. |
| `PBSI__PBSI_Purchase_Order_Line__c` | Line items on the QBO PurchaseOrder | Linked-Txn from PO → Bill on receipt is automatic. |
| `Account` (vendor) | `Vendor` | Owned by run-orders. One-to-one. |
| `Account` (customer, Amazon/Shopify) | `Customer` (lazily by A2X) | A2X creates these customer records as needed. Run-orders does not write customers. |
| `mm_Exempt_GST__c` etc. | A2X tax mapping | A2X maps Amazon/Shopify tax to QBO tax codes via its own configuration UI. Run-orders no longer touches tax flags. |
| `mm_On_Hold__c` (auto-cleared during SO create) | **Drop entirely.** | Pure SF Flow side effect. Gone. |

### 3.3 QBO API surface

- Production base URL: `https://quickbooks.api.intuit.com/v3/company/{realmId}/`
- Sandbox: `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/`
- Auth: OAuth 2.0, refresh-token rotation. Refresh token expires after 100 days of inactivity, 1 year max.
- Throttle: 500 requests/minute per realm, 40,000 requests/day. Plenty of headroom for run-orders' volume.
- SDK: `node-quickbooks` (community) for the API client; `intuit-oauth` for the auth flow. Both maintained as of 2026-01.
- **No anonymizing-proxy heuristics**. The SF lockout pattern doesn't have a QBO analog.

---

## 4. Auth & SDK Setup

1. Register an Intuit developer app at `developer.intuit.com` → get `CLIENT_ID`, `CLIENT_SECRET`
2. One-time OAuth handshake: redirect to Intuit consent screen, capture `realmId` + `refresh_token`, store both. The `realmId` is the QBO company ID and never changes for that file.
3. Build `lib/qbo.js` mirroring `lib/salesforce.js`'s shape:
   - Module-level cached `QBO` client
   - Refresh-token rotation: when access token nears expiry (default 1h), refresh and persist the new refresh token (Intuit rotates them on every refresh)
   - **Persist refresh tokens to disk** (e.g. `.qbo-tokens.json`, gitignored, mode 600), not env vars — they change frequently
   - Inflight-promise mutex on refresh to avoid concurrent token churn
   - No retry on 401 (re-auth required) or 403 (permission); exponential backoff on 429/5xx only
4. Env vars:
   - `QBO_CLIENT_ID`
   - `QBO_CLIENT_SECRET`
   - `QBO_REALM_ID`
   - `QBO_ENV` (`sandbox` | `production`)
   - `QBO_TOKEN_PATH` (default `.qbo-tokens.json` next to `.env`)
5. Add a probe script (`scripts/qbo-probe.js`) modeled on `scripts/sf-login-probe.js` — fetches `CompanyInfo`, prints company name, verifies auth health.

---

## 5. ID Resolution Layer

Today's hard-coded SF IDs need QBO replacements. Build a single `lib/qbo-ids.js` module that resolves logical names to QBO IDs at startup and caches them:

```
const ids = {
  customers: {
    amazon:  await resolveCustomerByName(qbo, 'Amazon.ca'),
    shopify: await resolveCustomerByName(qbo, 'Shopify Web Orders'),
  },
  vendors: {
    prosol:  await resolveVendorByName(qbo, 'Prosol'),
    treeco:  await resolveVendorByName(qbo, 'Treeco'),
  },
  taxCodes: {
    gstExempt: await resolveTaxCodeByName(qbo, 'GST Exempt'),
    pstExempt: await resolveTaxCodeByName(qbo, 'PST Exempt'),
  },
};
```

Why resolve-by-name instead of hard-coding QBO IDs: easier dev/sandbox parity, and surviving a QBO company file rebuild.

---

## 6. Flow-by-Flow Migration Plan

### 6.1 Amazon shipped order → QBO records

**Today:** find/create rolling 14-day Amazon SO → create SO line → create PO (Prosol vendor) → create PO line linked to SO line.

**Target (with A2X handling revenue side):**
1. **No SalesReceipt creation.** A2X-Amazon will post settlement-period journals when the actual Amazon payout lands. Run-orders does not touch the revenue side at all.
2. Create one `PurchaseOrder` per Amazon shipment (Vendor = Prosol, TxnDate = ship date in Pacific TZ).
3. PO lines reference QBO Items resolved from sku-map.
4. Stamp Amazon order ID on PO `DocNumber` (built-in dedup — QBO throws on duplicate DocNumber per vendor) and shipping carrier/tracking in PO `Memo`.
5. Optionally: post a daily `InventoryAdjustment` summarizing units shipped, if §3.0.2 Option β was chosen. Skip if Option α.

**Replaces:** `lib/amazon-po.js` end-to-end. ~150 lines rewrite (down from 300; the SO/SO-line code is gone entirely).

**Solves the dating bug from 2026-04-27** by construction: PO TxnDate = actual ship date, no rolling-window matching needed. The 14-day SO concept disappears.

### 6.2 Shopify special order → QBO records

**Today:** Contact lookup → SO → SO line → PO → PO line linked to SO line.

**Target:**
1. **No Estimate or Invoice creation.** A2X-Shopify will post the customer revenue side when the Shopify payout settles, including the special-order item line if it shipped through Shopify Payments.
2. Create one `PurchaseOrder` to the special-order vendor (Prosol, or Biyork-type vendor if added).
3. PO `Memo` carries Shopify order number + customer name for cross-reference. PO `DocNumber` = Shopify order ID for dedup.
4. **Customer-side ↔ PO linkage:** if accounting needs to trace a special-order PO back to the originating Shopify order, they do it via the matching order number on both sides (PO Memo + A2X-Shopify journal line). No native QBO `LinkedTxn` involved.

**Replaces:** `lib/shopify-sf.js`. ~80 lines rewrite (down from 250; the contact lookup, SO creation, SO line creation, and tax-exemption logic are all eliminated).

### 6.3 FBA restock → QBO PO

**Today:** ASIN → vendor SKU → PBSI item → SF PO (Prosol or Treeco) with FBA tag in shipping instructions.

**Target:**
1. Resolve vendor (Prosol or Treeco) via `lib/qbo-ids.js`
2. Create `PurchaseOrder` with `Memo = "FBA restock"` (replaces `PBSI__Shipping_Instructions__c` tag)
3. `DocNumber` field carries the FBA shipment ID for cross-reference

**Replaces:** `lib/fba-po-sender.js`. ~150 lines rewrite. The Telegram approval gate, email send, and PDF generation stay unchanged — only the SF-write step is swapped.

### 6.4 Cost hydration (`sync-item-costs.js`)

**Today:** SOQL stream of `PBSI__PBSI_Item__c` where cost > 0.

**Target:** QBO `Item` query: `select * from Item where Type='Inventory' and PurchaseCost > '0'`. QBO supports pagination via `STARTPOSITION` and `MAXRESULTS=1000`. Same upsert-into-local-SQLite pattern downstream.

**Replaces:** `scripts/etl/sync-item-costs.js`. ~80 lines rewrite. Behavior identical to user.

### 6.5 SKU-map sync (`sync-sku-map.js`)

**Today:** SOQL of all PBSI items with `PBSI__Vendor_Item_ID__c` populated.

**Target:** Vendor item ID isn't a default QBO field. Two options:
- **Option A:** Add a custom field on QBO Item ("Vendor Item ID") — QBO Plus allows up to 3 custom fields per Item. Use one for vendor SKU.
- **Option B:** Stop syncing from QBO; treat the local `sku_map_canonical` table as the source of truth and seed it from existing `scripts/shipstation/sku-map.json`. Lower coupling, fewer moving parts.

**Recommendation:** Option B. The current SF-driven sync exists because PBSI was the system of record; if we're recasting QBO as a *write target* for transactional data and keeping the SKU map locally, we eliminate this dependency entirely.

### 6.6 Open-pipeline subtraction

**Today:** Query open `PBSI__PBSI_Purchase_Order_Line__c` to subtract from restock proposal qty.

**Target:** QBO `PurchaseOrder` query with `POStatus='Open'`, then sum line qty per Item — but **QBO POs don't track received-qty per line natively** the way PBSI does (`PBSI__Quantity_Received__c`). Receiving in QBO is recorded by converting PO → Bill, where line qty is the ordered qty. Partial receiving creates partial Bills.

Implication: open-pipeline math changes from `ordered − received` to `ordered − billed`. For most cases these are equivalent. Edge case: a PO partially billed is treated as fully open until the Bill is recorded — could lead to over-subtraction. Mitigation: filter to POs older than 24h to give Kaitlyn time to record Bills.

**Replaces:** `server.js:1052-1056` query block. Logic in `proposal-preview` handler stays similar.

### 6.7 Financial reporting (`generate-financial-report.js`)

**Today:** 730 days of PO line history filtered by Mac Roy as PO owner.

**Target:** QBO has no per-record owner equivalent. Options:
- **Option A:** Use QBO `Class` field on every PO (e.g. `Class='Mac Roy'`). Requires Class tracking enabled (QBO Plus).
- **Option B:** Skip the owner filter; assume all run-orders POs are "ours" since this is the only writer.
- **Option C:** Stamp `PrivateNote` with `created-by:run-orders` and filter on that.

**Recommendation:** Option B for run-orders-created POs, since run-orders is the sole programmatic writer. Manual POs entered into QBO directly are out of scope for the report (which matches today's behavior — the SF report only counts Mac's POs anyway).

For the historical 730-day window: the existing data is in *Salesforce*. Either:
- **Backfill:** export PBSI PO lines to CSV, import into QBO as historical records. Risks: messes with QBO's historical inventory valuation.
- **Freeze:** keep the SF-driven analytics report running read-only on a frozen SF instance for 24 months until 730-day window rolls past, then retire it. SF read-only access is much cheaper than write access.
- **Replace:** rewrite report to pull from local `item_costs` + Amazon/Shopify settlement tables already in SQLite, ignore SF entirely. Loses some historical fidelity but is clean.

**Recommendation:** Freeze (read-only SF access for analytics only) for 12 months, then replace.

---

## 7. Custom Fields & Tax Handling

QBO Plus allows up to 3 custom fields per object (Customer, Vendor, Sales Form). QBO Advanced raises this to 12.

Required custom fields per object:
- **Customer:** none if we use built-in tax exemption
- **Vendor:** none
- **PurchaseOrder:** "Source" (e.g. "Amazon", "Shopify", "FBA"), "External Ref" (Amazon order ID / Shopify order ID), one spare
- **SalesReceipt/Invoice:** "External Ref"

Tax exemption — replaces `mm_Exempt_*` flags:
- Set `Customer.Taxable = false` for Amazon and Shopify Web Orders customers (they're business-to-business, no tax collected)
- Set `Customer.SalesTaxCodeRef` to "Out of Scope" or whatever the QBO tax code is for tax-exempt
- Confirm with accounting whether GST/PST should be split or combined in QBO's tax setup

---

## 8. Historical Data Migration

Three tracks, picked per object:

| Object | Recommendation |
|---|---|
| Items | **Re-create in QBO from sku-map + cost data.** Don't migrate IDs. |
| Vendors (Prosol, Treeco) | **Re-create.** Two records, manual one-time. |
| Customers (Amazon, Shopify) | **Re-create.** Two channel customers + per-Shopify-buyer customers backfilled lazily on first new order. |
| Open POs (status='Open' as of cutover date) | **Migrate.** Export from SF, import into QBO so receiving workflow doesn't break. ~50–100 records typical. |
| Closed POs / receipts (>730 days lookback for reporting) | **Freeze in SF read-only;** see §6.7. |
| Old SOs | **Don't migrate.** Channel SOs are settlement-period staging; QBO uses different model. Retire. |

---

## 9. Cutover Strategy

Two paths. **Recommend Path A (parallel write).**

### Path A: Parallel write, then flip the read

**Week 1–4:** Build QBO write layer alongside existing SF write layer. Every flow writes to *both* systems on every event. Behind a feature flag (`QBO_WRITE_ENABLED=true`) and a toggle for read source (`QBO_AS_SOURCE_OF_TRUTH=false`).

**Week 5:** Reconcile QBO data against SF data daily for 7 days. Spot-check Kaitlyn's receiving workflow in QBO sandbox.

**Week 6:** Flip `QBO_AS_SOURCE_OF_TRUTH=true`. SF writes continue but become advisory. Watch for 1 week.

**Week 7:** Disable SF writes. Keep SF reads alive for 12 months for `generate-financial-report.js` only.

Pros: low-risk, continuous fallback. Cons: ~6 weeks, double writes mean double API spend.

### Path B: Hard cutover

**Week 1–2:** Build QBO write layer. Sandbox-test all 7 flows.

**Weekend cutover:** Stop cron, snapshot SF, switch `lib/salesforce.js` calls to `lib/qbo.js`, restart.

**Week 3:** Manual reconciliation of any drift.

Pros: fast, no double-writes. Cons: any bug surfaces in production, no easy rollback once Kaitlyn starts receiving against QBO POs.

---

## 10. Reporting & Analytics Re-pointing

In addition to §6.7's plan for `generate-financial-report.js`:

- `scripts/analytics-data-inventory.js` (counts of PBSI items with cost) — re-point to QBO `Item` query. Trivial.
- Any Telegram alerts that mention SF PO numbers — adjust copy to mention QBO PO `DocNumber` instead.
- The "find Mac Roy by name/email" query (`generate-financial-report.js:36`) is no longer relevant under §6.7 Option B. Delete.

---

## 11. Open Decisions Required Before Building

These can't be answered from code alone. Need answers before any line of code is written.

~~**A. Amazon channel SO modeling.**~~ **Resolved by A2X.** No channel SO needed.

**B. PO ↔ Shopify-order linkage.** With A2X owning the revenue side, the PO is the only QBO record run-orders creates for a Shopify special order. Accounting traces by matching order number on the PO `Memo` and the A2X journal line. Confirm this is acceptable — alternative is Class field tagging.

~~**C. Estimate vs Invoice for Shopify.**~~ **Resolved by A2X.** Neither — A2X journals replace both.

**D. QBO subscription tier.** Plus or Advanced? Plus covers 100% of needs post-A2X (Class tracking + 3 custom fields per object is plenty). Recommend Plus.

**E. Sandbox vs production for development.** Strongly recommend doing all build-out in QBO sandbox. Note: A2X does NOT have a sandbox — A2X integration testing happens against production QBO with a small/staging Amazon settlement window.

**F. Path A or Path B cutover.** §9 recommends Path A. With reduced scope post-A2X, Path B is more viable than before — possibly 1.5–2 weeks.

**G. Historical SF analytics retention.** 12 months of read-only SF? Or full backfill into QBO? §6.7 recommends 12-month freeze.

~~**H. Tax handling.**~~ **Resolved by A2X.** A2X maps Amazon/Shopify tax codes to QBO via its own UI.

**I. Keep `lib/salesforce.js` as fallback or delete?** Recommend keeping it for 12 months in case the analytics report needs SF reads, then delete.

### New decisions specific to A2X

**J. A2X posting mode for both Amazon and Shopify connectors.** Summary or item-level? §3.0.1 recommends summary mode for both.

**K. Inventory deduction strategy.** Option α (accept QBO QtyOnHand drift, treat SQLite as inventory truth), β (post daily InventoryAdjustment from run-orders), or γ (item-level A2X). §3.0.2 recommends α.

**L. A2X subscriptions provisioned?** Need both A2X-Amazon and A2X-Shopify accounts active before phase 0. Pricing: tiered by transaction volume; FBA seller at typical volume runs ~$50–100 CAD/month per connector.

**M. Settlement-period reconciliation cadence.** Who watches A2X postings to make sure each settlement reconciles to the bank deposit? Recommend a weekly check by accounting for the first 4 weeks post-cutover.

**N. Historical A2X backfill.** A2X can usually backfill the prior 12 months of settlements into QBO. Decide whether to do this or start clean from cutover. Backfill makes year-over-year reporting easier; clean start is faster.

---

## 12. Phased Implementation (Path A timeline, post-A2X)

| Phase | Duration | Deliverables |
|---|---|---|
| 0. Discovery | 1 week | Decisions §11 B, D–G, I, J–N locked. Sandbox QBO provisioned. OAuth app registered. Dev refresh token captured. **A2X-Amazon and A2X-Shopify subscriptions activated** and connected to production QBO (sandbox QBO is fine for run-orders' part of the build). |
| 1. Foundation | 1 week | `lib/qbo.js` (auth + cached client + mutex). `lib/qbo-ids.js`. `scripts/qbo-probe.js`. Sandbox seed: vendors (Prosol, Treeco), 10 test items with cost. |
| 2. Write parity (PO-only) | 1 week | `lib/qbo-amazon-po.js`, `lib/qbo-shopify-po.js`, `lib/qbo-fba.js`. Feature flag `QBO_WRITE_ENABLED`. Parallel-write to both SF and QBO on every PO event. *(Down from 2 weeks because no SO/SR code to write.)* |
| 3. Read parity | 1 week | Open-pipeline subtraction + cost hydration repointed to QBO. `QBO_AS_SOURCE_OF_TRUTH` flag flipped in dev. |
| 4. A2X smoke + reconcile | 1 week | First A2X settlement journals land in QBO. Verify they reconcile to bank. Daily diff job: SF PO records vs QBO PO records. Drive drift to zero. Kaitlyn validates receiving workflow in QBO. |
| 5. Cutover | ~3 days | Flip `QBO_AS_SOURCE_OF_TRUTH=true` in production. Watch one Amazon settlement period close. Disable SF writes at end. |
| 6. Cleanup | ongoing | Delete dead SF write code paths. Retire SF after 12-month analytics window. |

**Total active build:** 4 weeks. **Total elapsed including stabilization:** 5 weeks. *(Was 6 / 7–8 weeks before A2X.)*

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| QBO refresh token expires / rotates wrong → silent auth failure | Med | Persist token immediately on every refresh; alert on 401. Probe daily. |
| QBO QtyOnHand diverges from reality (Option α inventory mode) | Expected | Accept it. Document for accounting that QBO inventory is not the source of truth for FBA SKUs. |
| A2X settlement journal doesn't reconcile to bank deposit (mapping error in A2X) | Med | Watch the first 4 settlements after cutover; A2X has a "review before posting" mode worth using initially. |
| Duplicate revenue: A2X posts, AND a stray run-orders SalesReceipt also posts | Low | Code-level: run-orders never creates SalesReceipts, only POs. Audit the QBO write layer for any non-PO write paths before launch. |
| Kaitlyn's receiving workflow breaks during cutover | Med | Sandbox dry-run with Kaitlyn before flipping. Document QBO Bill creation steps. |
| Custom field cap (3 in Plus) exceeded on PO | Low | Stay within budget by using Memo / PrivateNote for low-priority refs. |
| Historical reports break | High | Plan for 12-month SF freeze (§6.7). Don't try to backfill 730 days into QBO. |
| QBO sandbox ≠ production behavior (esp. since A2X is production-only) | Med | Final smoke test in production at cutover, after backup. |
| A2X mapping needs adjustment after first few settlements | High | Plan for 1–2 hours/week of A2X tuning for the first month. Normal for new A2X integrations. |
| Accounting changes mind on §11.J (posting mode) mid-migration | Med | Lock §11.J in writing before A2X subscriptions are activated. Switching modes later is non-trivial in A2X. |

---

## 14. What NOT to migrate

- The `mm_On_Hold__c` workaround. Pure SF-Flow side effect, not needed.
- The 14-day rolling SO date logic. It's the source of this morning's "wrong SO" bug; QBO TxnDate makes it obsolete.
- The PBSI item master sync (`sync-sku-map.js`) — replace with local sku-map as source of truth (§6.5).
- Historical SOs. Channel-summary records, no ongoing value.

---

## 15. Effort Estimate Summary (post-A2X)

- **Build:** 4 weeks of focused engineering (down from 6 — A2X eats half the SO/SR work)
- **QBO Plus subscription:** ~$110 CAD/mo
- **A2X-Amazon subscription:** ~$50–100 CAD/mo (volume-tiered)
- **A2X-Shopify subscription:** ~$50–100 CAD/mo (volume-tiered)
- **Intuit dev account:** free
- **Sandbox:** free (QBO only — A2X has no sandbox)
- **Risk of needing rollback after cutover:** low if Path A, medium if Path B (lower than v1 spec because run-orders' write surface is smaller)
- **Ongoing reduction in operational burden:** large — no more SF lockouts, no more PBSI managed-package gotchas, no `mm_*` workarounds, **plus** A2X eliminates the manual settlement reconciliation accounting was doing every payout

End of spec. Decisions in §11 are blockers for phase 1 — don't start coding until B, D–G, I, J–N are answered. The A2X-specific decisions (J, K, L, N) are the new critical path.
