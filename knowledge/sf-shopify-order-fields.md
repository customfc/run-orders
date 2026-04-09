# Salesforce SO/PO Field Documentation — Order 1241 (Shopify)

## Overview

Documenting the fields needed to programmatically create Salesforce Sales Orders and Purchase Orders for Shopify orders (like order 1241 with Biyork HydroGen 6 items).

---

## 1. Biyork Item (SKU 00941 — HydroGen 6)

**Successfully queried from Salesforce:**

| Field | Value |
|-------|-------|
| Item ID | `a0u4x000004FIvKAAW` |
| Name/SKU | `00941` |
| Sales Price | `$3.48` |
| Vendor Item ID | `BYKRCET50PO` |
| Default Vendor | `Biyork Materials Canada Inc.` |

**SOQL:**
```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c 
FROM PBSI__PBSI_Item__c 
WHERE Name = '00941'
```

---

## 2. Shopify Account & Contact

**Shopify Account:**
| Field | Value |
|-------|-------|
| Account ID | `0014x000023jkuDAAQ` |
| Name | `Shopify` |

**SOQL:**
```sql
SELECT Id, Name FROM Account WHERE Name = 'Shopify' LIMIT 1
```

**Josh McEvoy Contact:**
| Field | Value |
|-------|-------|
| Contact ID | `003OJ00000tgjsOYAQ` |
| Name | `Josh McEvoy` |
| Email | `josh@epriusgroup.com` |
| Phone | `+19023052144` |
| AccountId | `0014x000023jkuDAAQ` (Shopify) |

**SOQL:**
```sql
SELECT Id, Name, Email, Phone, AccountId 
FROM Contact 
WHERE Email = 'josh@epriusgroup.com' LIMIT 1
```

---

## 3. Sales Order Field Map (SO-23278)

Based on prior API attempts and session context, these are the fields needed:

### Required Fields for API Creation

| Field | Expected Value | Notes |
|-------|----------------|-------|
| `PBSI__Customer__c` | `0014x000023jkuDAAQ` | Shopify Account ID |
| `PBSI__Contact__c` | `003OJ00000tgjsOYAQ` | Josh McEvoy Contact ID |
| `PBSI__Tax_Code__c` | `` (empty) or `Exempt` | Empty string for no tax |
| `mm_Exempt_GST__c` | `false` | **MUST be boolean false, not null** |
| `mm_Exempt_PST__c` | `false` | **MUST be boolean false, not null** |
| `mm_Exempt_GST_ID__c` | `` (empty) | Empty string |
| `mm_Exempt_PST_ID__c` | `` (empty) | Empty string |
| `PBSI__Status__c` | `Open` | Standard status |
| `PBSI__Order_Date__c` | `2026-04-06` | ISO format |

### Sales Order Line Item Fields

| Field | Expected Value |
|-------|----------------|
| `PBSI__Sales_Order__c` | SO ID (from created SO) |
| `PBSI__Item__c` | `a0u4x000004FIvKAAW` (Biyork item) |
| `PBSI__Quantity__c` | `3` |
| `PBSI__Unit_Price__c` | `3.48` (or $77.33 per box = 22.26 kg) |
| `PBSI__Total__c` | Calculated (qty × unit price) |

---

## 4. Purchase Order Field Map (PO-14262)

### Required Fields for API Creation

| Field | Expected Value | Notes |
|-------|----------------|-------|
| `PBSI__Account__c` | `0014x00001P1ScCAAV` | Prosol account (likely) |
| `PBSI__Sales_Order__c` | SO ID (a10OJ00000Av9teYAB or SO-23278 ID) | Link to Sales Order |
| `PBSI__Status__c` | `Open` | Standard status |
| `PBSI__Order_Date__c` | `2026-04-06` | ISO format |
| `PBSI__Purchase_Order_Description__c` | `Order 1241 - Josh McEvoy - Biyork HydroGen 6` | Description |

### Purchase Order Line Item Fields

| Field | Expected Value |
|-------|----------------|
| `PBSI__Purchase_Order__c` | PO ID (from created PO) |
| `PBSI__Item__c` | `a0u4x000004FIvKAAW` (Biyork item) |
| `PBSI__Quantity__c` | `3` |
| `PBSI__Unit_Cost__c` | Vendor cost (need to find) |
| `PBSI__Total__c` | Calculated |

---

## 5. Key Findings from Session

### Critical Success Factors

1. **Exempt fields must be boolean false** — The Salesforce Flow was failing because `mm_Exempt_GST__c` was being passed as null. Must explicitly set to `false`.

2. **Shopify orders need separate SO** — Cannot use Amazon catch-all SO (SO-023144). Must create separate SO per Shopify order.

3. **Account/Contact linkage** — Shopify orders must link to:
   - Account: "Shopify" (ID: 0014x000023jkuDAAQ)
   - Contact: Customer name/email from order

4. **Item lookup by Name (SKU)** — Biyork items stored with SKU as Name field. Query by `Name = '00941'`.

### Fields That Cause Flow Errors

- `mm_Exempt_GST__c` — Must be `false`, not null/empty
- `mm_Exempt_PST__c` — Must be `false`, not null/empty  
- `mm_Exempt_GST_ID__c` — Must be empty string, not null
- `mm_Exempt_PST_ID__c` — Must be empty string, not null

---

## 6. API Calls That Work

### Login
```javascript
const conn = new jsforce.Connection({
  loginUrl: 'https://login.salesforce.com'
});
await conn.login(process.env.SALESFORCE_USERNAME, `${process.env.SALESFORCE_PASSWORD}${process.env.SALESFORCE_SECURITY_TOKEN}`);
```

### Query Biyork Item
```javascript
await conn.query("SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c FROM PBSI__PBSI_Item__c WHERE Name = '00941'");
```

### Query Shopify Account
```javascript
await conn.query("SELECT Id, Name FROM Account WHERE Name = 'Shopify' LIMIT 1");
```

### Query Contact
```javascript
await conn.query("SELECT Id, Name, Email, Phone, AccountId FROM Contact WHERE Email = 'josh@epriusgroup.com' LIMIT 1");
```

---

## 7. What's Missing

- **SO-23278 and PO-14262 could not be queried** — They may have been created manually in UI but not accessible via API, or were deleted
- **Vendor cost for Biyork item** — Need to find the cost (not just sales price)
- **Account for PO** — Need to confirm which Account ID to use for Prosol in PO

---

*Documented: 2026-04-06*
*Source: Session history analysis + successful API queries for Shopify Account, Contact, and Biyork Item*