# Today's Learnings — April 6, 2026

## 1. Run-Orders Automation Fixes

### What Was Fixed

**a) packageCode now stages and verifies**
- `run-orders.js` now includes `packageCode` in the ShipStation update payload
- Post-write verification now checks **warehouse + carrier + service + packageCode**
- Verification errors now report package mismatch
- **Commit:** `9ff86c6` — fix run-orders staging and routing guards

**b) Perfect Level routing blocked from Prosol**
- Added explicit guard to prevent Perfect Level Master items from being routed through the Prosol path
- Perfect Level items now flagged for manual review instead of incorrectly assigned a Prosol warehouse
- Example: Order `702-0453395-7953840` was properly kicked to manual review

### Verified Working
- Ran `npm run run-orders -- --dry-run` — 13 Amazon orders plannable, 1 Perfect Level flagged
- Ran `npm run run-orders` — staging passed, re-fetch verification passed including `packageCode`

---

## 2. Carrier Pickups Booked Today

### Canada Post (Booked for April 7)
| Warehouse | Pickup ID | Cost |
|-----------|-----------|------|
| St. Laurent | 5073169 | $4.03 |
| Concord | 5073170 | $3.96 |
| Burnaby | 5073171 | $3.68 |

### Purolator
| Warehouse | Pickup ID | Confirmation |
|-----------|-----------|--------------|
| Prosol St. Laurent | pik_2VZ8WMczkgadvGM5caXbwc | 20485193 |
| Prosol Burnaby | pik_HfGi4dhuS5XoDk1C3f59PU | 20546260 |
| TREECO Vancouver (Delta) | pik_5KXD8asjV4oGdN5Khkxpjp | 20549798 |

### TREECO Pickup Fix
- Purolator API requires `pickup_notes` field (not `pickup_location`)
- Address: 1230 Cliveden Ave, Delta BC V3M 6Y1

### Note on Pickup Confirmations
- UPS pickups: confirmation emails sent to mac@customfc.ca ✅
- Purolator pickups: may not trigger confirmation emails from ShipStation side
- If Purolator confirmations don't arrive, check spam or book manually via eshiponline.purolator.com

---

## 3. Salesforce Login Issues

### What Happened
- SOAP login to customfc.my.salesforce.com returned INVALID_LOGIN error
- Initially seemed like credential problem

### What Resolved It
- Credentials are valid: username=mac@customfc.ca, password+token works
- Using `login.salesforce.com` (not customfc.my.salesforce.com) for SOAP endpoint
- Everything works correctly — no actual login issue

### Key Takeaway
The custom subdomain works for REST API, but SOAP login still uses standard login.salesforce.com endpoint.

---

## 4. Biyork/Shopify Order Flow

### What's Different About Shopify vs Amazon Orders

| Aspect | Amazon Orders | Shopify Orders |
|--------|---------------|----------------|
| SO Linkage | Auto-linked to SO-023144 (Amazon catch-all) | Must find/create separate SO per order |
| Account | Uses generic Amazon account | Must find Shopify account or create new Contact/Account |
| Item Lookup | Works via ASIN → SKU map → Prosol items | Must find Biyork items in PBSI by SKU |
| Automation Status | Fully automated in run-orders flow | Manual intervention often needed |

### Why PO Creation is Harder for Shopify

1. **Account/Contact setup** — Shopify orders need proper Account (likely "Shopify") and Contact (customer name/email) linked in Salesforce
2. **Flow validation error** — Salesforce Flow is failing on API creates because `mm_Exempt_GST__c` expects boolean but receives null
3. **No automated SO creation** — Unlike Amazon which uses catch-all SO-023144, Shopify orders need explicit SO per order

### Manual Resolution (Order 1241)
- **PO Created:** PO-14262
- **SO Linked:** SO-23278
- **Customer:** Josh McEvoy (josh@epriusgroup.com)
- **Item:** Biyork HydroGen 6 (SKU 00941) — 3 qty

### Next Steps
A subagent was spawned to study PO-14262 and SO-23278 to document all field values needed for successful API creation next time.

---

## 5. API Credential Status

All credentials verified working as of today:
- ShipStation V1: ✅ working
- ShipStation V2: ✅ working  
- Prosol portal: ✅ working (via PROSOL_EMAIL / PROSOL_PASSWORD env vars)
- Salesforce: ✅ working (SOAP login verified)
- Shopify: ✅ working (API access confirmed)

**No credential updates needed.**

---

## 6. Files to Update

### MEMORY.md
Add today's key lessons:
- Run-orders packageCode staging now verified
- Perfect Level routing blocked from Prosol path
- Shopify orders require separate SO creation (not Amazon catch-all)
- Purolator pickup_notes field requirement
- Salesforc Flow issue with mm_Exempt_GST__c field

### ORDER-PREP.md
No major process changes needed — the order flow is already documented. The Shopify vs Amazon distinction should be added as a note.

---

## Key Takeaways for Future Sessions

1. **Perfect Level items** — Always flag for manual review, never route to Prosol automatically
2. **Shopify orders** — Don't link to SO-023144, create separate SO per order with Shopify Account/Contact
3. **Purolator pickups** — Must include `pickup_notes` field in API payload
4. **Salesforce Flow** — Watch for `mm_Exempt_GST__c` null/boolean issues on API creates
5. **Pickup confirmations** — UPS emails work, Purolator may need manual follow-up

---

*Documented: 2026-04-06*