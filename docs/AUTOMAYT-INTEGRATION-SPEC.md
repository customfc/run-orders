# Automayt integration spec for run-orders

Prepared for Doug's engineering team by Custom Flooring Centres (CFC).
Written 2026-09-09 against the live Salesforce org `00D4x000006rqqBEAQ` (customfc.my.salesforce.com) and against the run-orders working tree at `/Users/mvcddy91/daddy-dev/run-orders`.
Target switchover: on or about 2026-10-09.

Notation used throughout this document:

- Field and object names are exact Salesforce API names. They are given verbatim so you can match them against an export.
- `file.js:123` means line 123 of that file in the run-orders repository. Every claim in this document was read out of the source or out of a live read-only `describe()` on 2026-09-09.
- Where a Salesforce field is a formula or a roll-up (`calculated = true` in the describe), it is marked CALCULATED. Automayt has to compute those, not accept them on a write.
- The literal character U+2014 (the long dash) appears inside several real data strings that CFC's staff and vendors read. Because that character does not survive copy and paste cleanly, this document writes it as `<EMDASH>` inside examples. Wherever you see `<EMDASH>` in a payload, the real byte is U+2014.
- `<NAME>`, `<EMAIL>`, `<STREET>`, `<POSTALSUFFIX>` in sample records are redactions applied when the sample was pulled. Everything else in a sample is the real production value.

---

## 1. Purpose and scope

### 1.1 What run-orders is

run-orders is a single long-lived Node process (`server.js`) on a Mac Mini, started by launchd as `com.fred.run-orders`, listening on port 3456. It runs CFC's ecommerce order-to-cash and order-to-pay automation for two storefronts:

- Amazon.ca merchant-fulfilled (FBM) orders.
- yourfloors.ca, the Shopify storefront (ShipStation store id 798860).

It also runs the FBA replenishment workflow (buying stock into Amazon's fulfilment network), a nightly analytics ETL, a set of vendor and carrier watchdogs, a Telegram bot, and an operator dashboard.

The order pipeline is five phases, in this fixed order (`lib/pipeline.js:1255`):

```
stage  ->  buy  ->  pos  ->  email  ->  pickups
```

- `stage` reads ShipStation, resolves each order line to a vendor SKU through a local mapping file, picks a Prosol branch, and rate-shops. It makes one Salesforce read: the mapping guard.
- `buy` purchases the carrier label. Real money is spent here. No Salesforce.
- `pos` is not point of sale. It is the abbreviation for "purchase orders". This phase creates every Salesforce record run-orders creates: Sales Orders, Sales Order Lines, Purchase Orders, Purchase Order Lines, goods receipts, and lazily created Items.
- `email` sends the order to the Prosol branch and to CFC's own warehouse. It prints the Salesforce PO number in the email body and on the packing slip PDF, read out of local state, not out of Salesforce.
- `pickups` books carrier pickups. No Salesforce.

The ordering matters and is load-bearing: **the carrier label is bought before the Purchase Order exists**, and the PO number is what the vendor is asked to work against.

### 1.2 What this document covers

Everything run-orders does against Salesforce, so that Automayt can expose an equivalent API and the cutover is a configuration change plus one adapter module rather than a rewrite. Specifically:

- The connection, authentication and error model (section 2).
- Every Salesforce object and field run-orders reads or writes, with types, calculated flags, identity keys and status lifecycles (section 3 and Appendix A).
- Every flow, step by step, with exact payloads, dedupe rules and failure behaviour (section 4).
- Every hard-coded record id, account name, location name, picklist string and numbering convention (section 5).
- The API surface Automayt has to provide, split into day-one and can-lag (section 6).
- Record volumes and non-functional requirements measured from the live org (section 7).
- Cutover mechanics and what run-orders has to change on its side (section 8).
- Salesforce and PBSI behaviours that must be reproduced, and behaviours that must not (section 9).
- Open questions (section 10).
- Complete field inventory, complete SOQL inventory, and a file index (appendices A, B, C).

### 1.3 What this document does not cover, and why that matters

Automayt is replacing **everything Salesforce does at CFC**, not only the run-orders slice. This document is only the run-orders slice. The following are real, live, and heavily used in the same Salesforce org, and none of them is described here because run-orders does not touch them:

- Retail point of sale and showroom counter sales (Sechelt Showroom, Powell River Showroom).
- Contractor and trade sales. There is a contractor book of roughly 457 real contractor accounts. Note that `Account.Sub_Type__c = 'Installer'` marks one of CFC's own install crews, not a contractor customer.
- Field Service Lightning scheduling and work orders. The Sales Order Line object carries an enormous `Installation_Type__c` picklist (several hundred labour operations) that exists purely for that side of the business.
- Opportunities and quotes. Roughly 14,316 Opportunity records exist. run-orders creates none. A separate repository (`cfc-instock-sync`) creates Opportunities from Cal.com bookings and Facebook leads, using the same Salesforce credentials.
- Chatter feeds, EmailMessage capture (roughly 77,000 records), Cases, Content documents and attachments.
- Sales Orders and Purchase Orders created by humans in the Salesforce UI. These are the majority: run-orders creates about 40 percent of Purchase Orders but only about 7 to 9 percent of Sales Orders (section 7).
- The AcctSeed accounting layer as an application: billings, billing lines, journal entries, ledgers, accounting periods, the general ledger, and the Ascent2QB / A2AS QuickBooks connector internals.

Two consequences for Doug:

1. **A second discovery pass is required** for the list above before Automayt can replace Salesforce at CFC. This document does not size it.
2. **The accounting handoff is in scope for Automayt even though run-orders barely touches it.** run-orders creates the Purchase Order; everything after that (goods receipt, inventory posting, vendor invoice, AcctSeed payable, GL posting, QuickBooks sync) happens inside Salesforce today, is invisible in run-orders' own documentation, and is what CFC's accounting staff (Lynnae Grohs, Melanie White) work in daily. Sections 3.7, 3.9, 3.10, 4.13 and 9 say what run-orders relies on that chain to do.

Also explicitly out of scope of this document, though run-orders does it: ShipStation, Amazon SP-API, Shopify Admin API, Purolator and Canada Post booking, the Prosol storefront API, and the local SQLite analytics database. They appear only where a Salesforce identifier crosses into them.

### 1.4 How to read this document

- If you are scoping the API, read sections 2, 3, 6 and 7.
- If you are implementing, read section 4 (it is the specification of behaviour) with Appendix A and B open beside it.
- If you are planning the cutover, read sections 5, 8 and 9.
- Section 10 is the list of things CFC needs answered before code is written.

---

## 2. How run-orders talks to Salesforce today

### 2.1 The client

There is exactly one Salesforce client in the repository: `lib/salesforce.js`, 88 lines. Every other file goes through it, including a second repository (`cfc-instock-sync`) which imports it by path and reuses the same `.env`.

- Library: `jsforce`, declared as `^1.11.1` in `package.json:18`, installed at exactly 1.11.1.
- **API version: v42.0.** `lib/salesforce.js` pins no version, so jsforce's own default applies (`node_modules/jsforce/lib/connection.js:26`). This is a 2018-era REST surface and is the effective contract for everything the pipeline does. Three operator scripts raise it by mutating `conn.version = '62.0'` after connecting, because `FIELDS(ALL)` needs v51 or later: `scripts/ops/lookup-so.js:13`, `scripts/ops/find-stock-alt.js:10`, `scripts/ops/shopify-stock-gate.js:146`. Two literal URLs hard-code other versions: `v59.0` in `scripts/luca-sf-reset.js:27` and in the Chatter post at `scripts/ops/accounting-exceptions.js:194`.
- Login: SOAP partner login, not OAuth. `conn.login(username, password + securityToken)` at `lib/salesforce.js:49`. The endpoint is `https://login.salesforce.com/services/Soap/u/42.0`. Note that the custom subdomain works for REST but **not** for SOAP login; that was learned the hard way and is recorded in `knowledge/today-learnings.md:54-63`.
- Client identity: every REST call carries the header `Sforce-Call-Options: client=run-orders/1.0.0/pid<process id>` (`lib/salesforce.js:47`). It is not queryable, so it cannot be used to separate machine writes from human writes after the fact.

### 2.2 Credentials and environment

Four environment variables, read once at module load (`lib/salesforce.js:16-19`). Changing them requires a process restart.

```
SALESFORCE_USERNAME=
SALESFORCE_PASSWORD=
SALESFORCE_SECURITY_TOKEN=
SALESFORCE_LOGIN_URL=https://login.salesforce.com
```

Live value on the production host: `SALESFORCE_USERNAME=mac@customfc.ca`. **The integration runs as Mac's own named human System Administrator seat**, user id `0054x000005Ys0yAAC`, "Mac Roy". There is no service account. Consequences:

- `CreatedBy` cannot distinguish the pipeline from Mac working in the user interface.
- If that password rotates, the seat is locked, or the seat is repurposed, the whole pipeline stops.
- The full Salesforce license pool in this org is over-allocated (19 used against 14 owned), which is why a dedicated integration seat was never created.

There is no sandbox wiring. `grep` for `sandbox` or `test.salesforce` across `.env` and `.env.example` returns nothing. Pointing at a non-production org today means changing all four variables by hand.

`DISABLE_CRON=1` is the only smoke-test switch (`server.js:2044`). It replaces `cron.schedule` with a no-op and skips Telegram polling, so a second instance can be started without firing real buys. It is not documented in `.env.example`.

### 2.3 Connection lifecycle

`connect()` at `lib/salesforce.js:30-67`:

- One `jsforce.Connection` is cached at module scope for **90 minutes** (`SESSION_TTL_MS`), deliberately under the org's 2-hour session lifetime.
- Concurrent logins in the same process are coalesced through an inflight promise, so a burst of callers produces one login.
- Retry ladder for transient failures: three attempts at 0 seconds, 30 seconds, 60 seconds (`TRANSIENT_BACKOFF_MS = [0, 30_000, 60_000]`).
- **Auth-terminal errors are never retried.** `lib/salesforce.js:24` holds a single case-insensitive regex alternating these eight strings, tested against the error code concatenated with the error message: `INVALID_LOGIN`, `LOGIN_MUST_USE_SECURITY_TOKEN`, `PASSWORD_LOCKOUT`, `INVALID_OPERATION_WITH_EXPIRED_PASSWORD`, `INVALID_AUTH_HEADER`, `AUTHENTICATION_FAILURE`, `LOCKED`, `FROZEN`.
- Underneath, jsforce silently re-authenticates on any HTTP 401 and replays the request (`SessionRefreshDelegate`), bypassing the terminal-error guard entirely. That is invisible to run-orders and would not be reproduced deliberately.
- **There is no HTTP timeout on any Salesforce call.** jsforce only honours `process.env.HTTP_TIMEOUT`, which is not set anywhere in this repository. A hung Salesforce endpoint hangs the pipeline phase indefinitely.
- `invalidateSession()` is exported but called by nothing. There is no way to drop a poisoned session short of restarting the process.

The module's own docstring explains why terminal errors are excluded: retrying a credential failure is what previously tripped Salesforce's token-reuse and lockout heuristics. **This is a hard requirement on Automayt: a client must be able to tell "retry this" from "stop, you will get locked out".**

### 2.4 The four exported functions, and everything that bypasses them

```js
module.exports = { connect, query, create, invalidateSession };
```

- `query(conn, soql)` (`lib/salesforce.js:74-77`) returns `result.records` and discards `done` and `nextRecordsUrl`. **There is no pagination.** Any query returning more than one Salesforce batch (2000 rows) is silently truncated, with no error and no log line. At least one live query has no LIMIT and no vendor filter (`server.js:1126-1130`, every open Purchase Order Line in the org).
- `create(conn, sobject, fields)` (`lib/salesforce.js:79-86`) inserts one record and returns **only the 18-character id**. It throws `SF create <object> failed: <messages joined by "; ">` when the result is not successful. Because create returns only an id, every caller that needs the human-readable document number issues a second query immediately afterwards. There are five such call sites across four query shapes, all listed in Appendix B: `lib/shopify-sf.js:736` (Sales Order Name), `lib/shopify-sf.js:811` (Purchase Order Name plus `PO_Number__c`), `lib/amazon-po.js:277-280` (full Sales Order read-back), `lib/amazon-po.js:799` and `lib/fba-po-sender.js:413` (Purchase Order Name).
- There is **no** `update`, `delete`, `upsert`, `describe`, `composite`, `bulk` or `action` helper. Everything else reaches past the wrapper onto the raw jsforce connection:
  - `conn.sobject(T).update({Id, ...})` for six update call sites across four objects and five fields: `Account.mm_On_Hold__c` (`lib/shopify-sf.js:558`, `lib/amazon-po.js:180`), `Product2.AcctSeed__Revenue_GL_Account__c` (`lib/shopify-sf.js:409`), `PBSI__PBSI_Purchase_Order__c.PBSI__Status__c` (`lib/amazon-po.js:835`, `scripts/ops/fix-stuck-po-receive.js:71`), and `UserLogin.IsPasswordLocked` plus `IsFrozen` (`scripts/luca-sf-reset.js:20`). A seventh update path, the Sales Order status change described in section 4.16, exists in production practice but in no source file.
  - `conn.sobject(T).destroy(id)` for two delete calls on two object types, both in one script (`scripts/ops/_tmp-1321-delete-freight-po.js:12` and `:15`). Cascade-dependent, see section 4.17.
  - `conn.requestPost(url, body)` for the PBSI invocable action and for the Chatter Connect API post.
  - `conn.request({method, url, body, headers})` for the admin password REST call and for binary file fetches.
  - `conn.sobject(T).describe()` and `conn.describeGlobal()` for schema introspection.
  - `conn.query(soql).on('record').run({autoFetch: true, maxFetch: N})` for streamed full-table reads.

### 2.5 Transport styles in use

Automayt has to cover six distinct shapes:

1. **SOQL read.** Roughly 60 distinct queries. Features actually relied on: `IN` lists, `LIKE '%x%'`, `!= NULL`, parent-relationship traversal in SELECT, WHERE and ORDER BY (up to two hops, for example `PBSI__Purchase_Order__r.PBSI__Account__r.Name`), child sub-selects (`(SELECT ... FROM PBSI__Purchase_Order_Lines__r)`), aggregates (`COUNT(Id)`, `SUM`, `MIN`, `MAX`, `GROUP BY`, `HAVING COUNT(Id) > 1`), the `CALENDAR_YEAR()` date function, relative date literals (`LAST_N_DAYS:65`, `TODAY`), `ORDER BY ... NULLS LAST`, aliasing, and `FIELDS(ALL)`.
2. **Single-record sObject create.** Five object types.
3. **Single-record sObject update.** Five fields, on four objects, at six call sites (listed in section 2.4), plus the Sales Order status change in section 4.16.
4. **Single-record sObject delete.** Two calls on two object types, in one script, cascade-dependent.
5. **REST invocable action.** `POST /services/data/v42.0/actions/custom/apex/PBSI__ReceivedPOLinesCreateAction`. This is the goods receipt, and it is the single most important non-CRUD operation in the system.
6. **Connect API (Chatter) POST.** `POST /services/data/v59.0/chatter/feed-elements`, to put a "DO NOT PAY" note with real user mentions onto a Purchase Order record.

There are **no** Composite API calls, no sObject Tree calls, and no Bulk API calls anywhere. Every order is a sequence of independent single-record writes with no transaction and no rollback. That is the root cause of most of the partial-write failure modes described in section 4.

### 2.6 Error handling and what happens when Salesforce fails

Ordered from innermost outward:

- Login, transient: retried three times, then thrown.
- Login, terminal: thrown on the attempt that raised it, never retried.
- `sf.create` failure: throws `SF create <object> failed: <joined messages>`.
- Per-flow: the Shopify path records the error on the order and returns; the Amazon path treats three specific step names as run-halting.
- Pipeline halt policy (`lib/pipeline.js:770`):

```js
const HALT_STEPS = new Set(['sf-login', 'amazon-so', 'check-existing']);
```

Only the **Amazon** branch's errors are inspected against that set. A halt sets `result.halted = 'pos'`, sends a Telegram alert at severity `halt`, and returns before the email and pickups phases run. Note two facts: the step name `amazon-so` is dead (no code emits it), and the Shopify duplicate-guard step is named `skip-check`, not `check-existing`, so a Shopify guard failure aborts one order rather than the run.

- **Duplicate guards fail closed. Everything else fails open.** This is the single most important error rule in the system. If the duplicate-check query errors, nothing is created. If any other Salesforce call errors, the pipeline degrades and continues. The rationale is recorded in code at `lib/shopify-sf.js:581-587`: on 2026-07-24 a duplicate-check query threw `QUERY_TIMEOUT` with an **empty error message**, the code treated "no results" as "no duplicates", and created 12 duplicate Purchase Orders worth 744.26 dollars, which posted as Complete and Received. A missing PO costs one cron tick. A duplicate PO costs a vendor argument and a reconciliation.
- The mapping guard fails open on purpose: any Salesforce error there returns null and staging proceeds unverified (`scripts/shipstation/run-orders.js:40-41`).
- The financial report returns null and prints "PO data was unavailable from SF" rather than failing.
- The quick-PO open-PO subtraction swallows its failure and **over-orders silently**.

### 2.7 Health monitoring today

`lib/integration-health.js` runs at 06:30 America/Toronto every day (`server.js:2213`) and on the Telegram command `/health`. Its Salesforce check, `checkPOCreation()` at `:59-73`, **never contacts Salesforce**. It walks back up to six days of local state files, finds the first day with at least two labels bought, and reports the Salesforce path as down if that day recorded zero Purchase Orders. It exists because in late May 2026 jsforce broke and roughly 66 orders shipped with no vendor PO before anyone noticed.

`GET /api/health` (`server.js:2003`) reports Salesforce as green based on the presence of two environment variables. It does not check the security token, which `connect()` requires, and it never opens a connection.

The only artefact that actually proves Salesforce is reachable is `scripts/sf-login-probe.js`, which is run by hand: connect, read identity, run `SELECT Id FROM User WHERE Id = '<self>' LIMIT 1`, print latency.

### 2.8 Scheduling: when the machine runs, and which ticks reach Salesforce

All schedules live in `server.js` under `node-cron`, timezone `America/Toronto` (`server.js:2024`). Four entries in the list below open no Salesforce session at all (06:30, 14:00, 14:30, 15:00). They are included because they consume Salesforce identifiers out of local state, which is why they still break when a cutover changes the numbering.

- 03:00 daily: analytics ETL (`server.js:2401`). Two full-table Item reads, roughly 12,700 rows each.
- 06:30 daily: integration health (local inference only).
- 07:00, 10:00, 12:00, 13:30 Monday to Friday: `stage, buy, pos` (`server.js:2049-2052`). **This is when all Salesforce writes happen.** Four times a weekday.
- 14:00 daily: `email`. Reads Salesforce identifiers out of local state, makes no Salesforce call.
- 14:30 Monday to Friday: `pickups`. No Salesforce.
- 15:00 Monday to Friday: Telegram digest, lists the PO numbers from local state.
- 07:15 to 17:15 hourly: orphan email sweep, reads prior days' local state.
- 09:30 Monday to Friday: stale parcel reminder. Reads the PO number out of every local state file ever written and prints it in a vendor-facing email.
- 06:00 Monday to Friday: FBA morning pull, which produces the restock proposal that a Telegram approval link later turns into Salesforce POs.

On-demand entry points that also write to Salesforce: the dashboard buttons `POST /api/shopify/create-so-po` (`server.js:600`), `POST /api/amazon/create-pos` (`server.js:651`), `POST /api/fba/quick-po` (`server.js:1044`), `POST /api/fba/po-draft/send` (`server.js:1550`), `POST /api/fba/po-draft/send-all-buckets` (`server.js:1607`); the unauthenticated one-click Telegram approval link `GET /api/fba/auto-restock/approve/:token` (`server.js:2434`); `POST /api/pipeline/run` and `POST /api/pipeline/run-phase` with an arbitrary phase list; and the Telegram commands `/launch`, `/stage`, `/po`, `/replen`.

Note that `POST /api/amazon/create-pos` does **not** take the pipeline concurrency lock, so pressing the dashboard button while a cron run is in the `pos` phase runs two concurrent PO passes over the same shipments.

### 2.9 What Automayt must provide for this subsystem

Authentication and session:

- A credential issued to a **service identity**, not to a named human. Username plus password plus security-token concatenation must not be required, and there must be no interactive or MFA step.
- A published token lifetime so the client can cache below it. Today the client caches 90 minutes against a 2-hour session because the number is known.
- **A machine-readable error taxonomy that separates retryable from terminal.** At minimum: transport or 5xx or 429 is retryable; bad credentials, locked, disabled, expired password is terminal and must never be retried. The current terminal list is in section 2.3 and is the behaviour to preserve.
- Tolerance for concurrent logins from the same host. On a normal day the Mac Mini runs the run-orders server, the `cfc-instock-sync` server, a 02:30 cron in that second repository, and up to four operator scripts, all as the same identity.
- A client or agent identifier accepted on every call and **made queryable**, so a Purchase Order created by run-orders can be told apart from one keyed by a human. Today the discriminators are all indirect: pipeline Sales Orders always carry the Shopify or Amazon house account as customer, and pipeline Purchase Orders always carry Prosol as vendor plus a non-null tracking code. Two platform-computed fields on the Purchase Order look like channel markers and are not usable as one; both are described in section 3.3 under "Channel markers".
- An explicitly versioned base path with a deprecation policy, so the client pins deliberately instead of inheriting a library default.
- A sandbox or staging environment reachable by changing one base-URL environment variable, with separate credentials. There is no such thing today, which is why every change is validated against production.
- A configurable, server-honoured request timeout and a documented maximum request duration.
- A Node client, or a plain HTTP contract, that a 30-line script can authenticate against in three lines. That workload is real: 47 throwaway forensic scripts in `scripts/ops/` do exactly that (section 4.18).

Reads:

- **Pagination that a naive caller cannot silently truncate.** Either return everything, or return an explicit `has_more` and cursor. The current silent 2000-row cut is a live bug class.
- Streaming or cursored bulk export of the item master (roughly 12,700 rows nightly) and of Purchase Order Lines.
- Parameter binding. Today every query is built by string interpolation and the escaping is inconsistent across call sites: some escape a quote to a backslash-quote, some delete quotes, most do neither.
- Relationship traversal or server-side joins, up to two hops, in SELECT, WHERE and ORDER BY.
- Aggregates with `GROUP BY` and `HAVING`, and a year-bucketing function.
- Relative date filters equivalent to `LAST_N_DAYS:n` and `TODAY`.
- A "return every populated field on this record" mode, which is what an operator reaches for when a field name is in doubt.
- Schema introspection: per-object field list with API name, label, type, length, writability, formula flag and picklist values, plus an object-list endpoint. Without it, `scripts/ops/po-lookup.js` (which describes before it queries precisely so it does not throw `INVALID_FIELD` on an org-specific field name) cannot be ported.

Writes:

- **Create must return the human-readable document number in the create response.** This removes one follow-up read per created document (at most two per order, the Sales Order and the Purchase Order, across the five call sites in section 2.4) and, more importantly, is a hard requirement of the Prosol direct-order path (section 4.19).
- Update and delete with documented cascade behaviour.
- An action or operation endpoint for things that are not row inserts, above all the goods receipt.
- Structured per-record errors: a stable machine code, a field, and a non-empty human message. An error object with an empty message is what caused the 2026-07-24 duplicate-PO incident.
- **Server-side idempotency.** Either an `Idempotency-Key` header, or natural-key uniqueness on the two keys the pipeline already relies on: customer purchase order reference on a Sales Order, and tracking code on a Purchase Order. Today both are plain non-unique strings and the dedupe is a read-then-write race.
- Optimistic concurrency on status updates, so two runs cannot both flip a status.
- Batch or composite writes: header plus all lines in one atomic call. Today a failure halfway through leaves a Sales Order with no Purchase Order, or a Purchase Order with zero lines, and nothing cleans it up.
- Read-your-writes consistency. The pipeline creates a Purchase Order, immediately reads its number, and prints that number in an email within the same run.

Operations:

- A real authenticated health endpoint returning `{ok, auth_ok, db_ok, version, time}` that the 06:30 cron can call, and that distinguishes "authentication is dead" from "no data today".
- A cheap authenticated ping equivalent to the login probe, returning identity plus latency.
- Published rate limits: requests per minute, concurrent sessions, and bulk row caps.
- Webhooks or change events would remove whole classes of polling. The Shopify Sales Order reconcile sweep (section 4.2) exists only because nothing tells run-orders that a Sales Order did or did not appear.

---

## 3. The data model Automayt must provide

Salesforce here is not a CRM. The load-bearing part is **PBSI (Ascent ERP)**, an ISV-managed inventory ERP package, plus **AcctSeed** for accounting and the **Ascent2QB / A2AS** connector to QuickBooks. Replacing it is replacing an inventory and operations backbone, not switching CRMs.

Three managed namespaces plus a bag of CFC-local custom fields are in play, and Automayt has to reproduce fields from all four groups:

- `PBSI__` - Ascent ERP. Orders, items, locations, receipts, movements.
- `AcctSeed__` - Accounting Seed. Payables, GL accounts.
- `A2AS__` and `Ascent2QB__` and `Ascent_FPL__` - the bridges to AcctSeed and QuickBooks.
- `AscentBTO__` - Ascent Build To Order. One field matters: item stock status.
- No prefix, or `mm_` prefix - CFC-local custom fields. The `mm_` family came from a prior consultant and is a mix of genuinely load-bearing fields (tax exemption, landed cost, on-hold) and formula cruft.

Object sizes and record counts as of 2026-09-09 are in section 7.

### 3.1 Sales Order - `PBSI__PBSI_Sales_Order__c`

Purpose. The customer-side order document. For run-orders it exists for two reasons: it is the demand record a drop-ship Purchase Order line must point back at, and it is CFC's revenue truth. Revenue for the business is `PBSI__Final_Order_Total__c` on this object, excluding records at status `Cancelled`.

Shape: key prefix `a10`, 231 fields, 23,228 records, createable, updateable, deletable, no record types.

Identity and dedupe:

- `Id` - 18-character record id.
- `Name` - CALCULATED in the sense that it is trigger-assigned, not caller-supplied. Type string, length 80, `createable=false`, `updateable=false`, marked autonumber. Format `SO-` plus six digits, for example `SO-025763`. This is the number humans use.
- `PBSI__Customer_Purchase_Order__c` - **the dedupe key.** Type string, length 100, plain, `unique=false`, not an external id. Nothing in Salesforce enforces the uniqueness the pipeline relies on. Two incompatible meanings live in this one field:
  - Shopify: the bare Shopify order number with a leading hash stripped, for example `1373`.
  - Amazon: a human-readable 14-day date range, for example `Apr 9 - 22` or `Mar 26 - Apr 8` or `FEB.26 - MAR 11`.
  Sechelt staff also type into this field by hand, in formats such as `1244`, `#1244`, `Shopify #1244`, `po 1244`. That is why the dedupe read is a substring match plus a client-side whole-number regex, not an equality test.

Fields run-orders writes on create:

- `PBSI__Customer__c` - reference to Account. The house account for the channel. Never a per-buyer account.
- `PBSI__Contact__c` - reference to Contact. Shopify path only, and only when an email lookup matched. Never created if missing.
- `PBSI__Status__c` - picklist. Written as `Open` and never changed by run-orders. Declared values: Open (default), Partially Complete, Closed, In Progress, Cancelled, Packed, Staged.
- `PBSI__Order_Date__c` - date, `nillable=false`, defaulted. Must accept a caller-supplied back-dated value for reconciliation.
- `PBSI__Tax_Code__c` - reference to `PBSI__Tax_Code__c`. Amazon path only, hard-coded id `a1S4x000002pMUhEAM`, which is the tax code named `Exempt` at rate 0 (section 5.3). Shopify path sends nothing.
- `mm_Exempt_GST__c` - boolean, `nillable=false`. Amazon writes `true`, Shopify writes `false`.
- `mm_Exempt_PST__c` - boolean, `nillable=false`. Same split.
- `mm_Exempt_GST_ID__c` - string 255. Amazon writes `Third Party Amazon`, Shopify writes an empty string.
- `mm_Exempt_PST_ID__c` - string 255. Same split.
- `PBSI__BOL_Description__c` - string 100. Amazon path only, literal `None`.

**Critical, and previously undocumented: an org automation overwrites the tax fields after insert.** A live Shopify Sales Order created by the pipeline on 2026-09-04 (`SO-025763`, customer PO `1373`) stores `mm_Exempt_GST__c = true`, `mm_Exempt_PST__c = true`, `mm_Exempt_GST_ID__c = "123456"`, `mm_Exempt_PST_ID__c = "123456"` and `PBSI__Tax_Code__c = a1S4x000002pMUhEAM` (`Exempt`, rate 0), none of which the code sent. The same record also arrives with billing address, delivery company, comments, due date, terms, a shipping-instructions value of the literal string `None`, and `PBSI__BOL_Description__c = "None"`, all defaulted from the Account or from a Flow. Note the last one in particular: the client writes the bill-of-lading description on the Amazon path only, and all three sampled Shopify Sales Orders carry it anyway. So the values the client writes are not the values that end up on the record, and Automayt must decide deliberately whether to reproduce that behaviour or to make the caller authoritative. The historical reason the client sends explicit booleans at all is that a Salesforce Flow **fails on null** where it expects `false`.

A related mechanism that Automayt inherits if it copies this model: the org carries an active Flow, `Mamoon_prevent_the_creation_of_SO_with_on_hold_accounts`, which is an after-save Create trigger on the Sales Order that raises the custom error "The account associated to this sales order is on hold". The Shopify and Amazon house accounts are put back on hold by a scheduled Flow (`Mamoon_put_account_on_hold`) that walks AcctSeed Billings aged 61 to 90 days and over 90 days. Both house accounts read `mm_On_Hold__c = true` at the time of writing. That pairing, an automated hold plus a hard block on order creation, is the entire reason for the credit-hold clear in section 3.8.

Fields run-orders reads:

- `Id`, `Name`, `PBSI__Customer_Purchase_Order__c`, `PBSI__Order_Date__c`, `PBSI__Status__c`, `CreatedDate`, `CreatedBy.Name` (displayed to the operator when a duplicate is found).
- `PBSI__Final_Order_Total__c` - CALCULATED formula, currency. Revenue truth.
- `PBSI__Order_Total__c` - CALCULATED roll-up, currency.
- `CFC_Stage__c` - CALCULATED formula, string 1300. Sample value on a Sales Order: `In Process`. Not groupable in SOQL, which is how you can tell it is a formula.
- `OwnerId` - reference to User.

Other state machines on the same object that Automayt has to understand before migrating status: `PBSI__Stage__c` (declared Open, Packed, Waiting Pick Up, On Route, Delivered), `Billing_Stage__c`, and the formula `CFC_Stage__c`. Four overlapping state machines on one object. Note also that the real data contains `PBSI__Stage__c` values that the picklist does not declare at all: `Partially Packed` (514 records), `Staged` (31), `Cancelled` (6).

Status distribution for Sales Orders created in the last 365 days: Closed 5,213, Open 375, Partially Complete 197, Staged 10, Cancelled 6. `In Progress` and `Packed` are declared and unused.

Relationships: children `PBSI__Sales_Order_Lines__r` and `PBSI__Purchase_Order_Lines__r`.

### 3.2 Sales Order Line - `PBSI__PBSI_Sales_Order_Line__c`

Purpose. One line per item sold. It is also the anchor a drop-ship Purchase Order line points at.

Shape: key prefix `a0z`, 249 fields, 95,595 records.

Fields run-orders writes on create (all five, every time):

- `PBSI__Sales_Order__c` - reference to the parent Sales Order. **`nillable=false`, `createable=true`, `updateable=false`.** Master-detail. Accept it at insert only; reject re-parenting.
- `PBSI__Item__c` - reference to Item.
- `PBSI__Quantity__c` - double, precision 18 scale 0.
- `PBSI__Quantity_Needed__c` - double, precision 18 scale 6, `nillable=false`. Always set equal to `PBSI__Quantity__c`. It appears in no CFC document; it is set because PBSI needs it.
- `PBSI__Price__c` - currency, precision 18 scale 2. Labelled "Unit Price". The Shopify path writes the Shopify retail price. The Amazon path writes the Salesforce list price `PBSI__salesprice__c`, falling back to the Amazon unit price.

Fields run-orders reads: `Id`, `Name` (autonumber, for example `113176`), `PBSI__Item__r.Name`, `PBSI__Item__r.PBSI__Description__c`, `PBSI__Item__r.PBSI__Vendor_Item_ID__c`, `PBSI__Item__r.PBSI__Default_Vendor_Name__c`, `PBSI__Quantity__c`, `PBSI__Quantity_Needed__c`, `PBSI__Price__c`, `PBSI__Total_Price__c` (CALCULATED formula, "Total Discounted Price").

Not written and derived by the platform: `PBSI__Total_Price__c`. The 2026-04 hand-written field map in `knowledge/sf-shopify-order-fields.md` names a field `PBSI__Unit_Price__c` and a field `PBSI__Total__c` on this object. Neither is written anywhere in the shipped code. Trust `PBSI__Price__c`.

Quantity semantics matter and are covered in section 4.1 step 3e: for an area-stocked item the quantity written here is in **square feet**, not in rolls, while the price stays per roll.

### 3.3 Purchase Order - `PBSI__PBSI_Purchase_Order__c`

Purpose. The vendor-side order document. This is the artefact CFC's vendor, Prosol, works against: the number on it is what a Prosol branch matches to their own floor paperwork, what Kaitlyn Lazzarotto at Prosol's order desk is given in the order email, and what identifies a chargeback claim months later.

Shape: key prefix `a0y`, 119 fields, 15,045 records.

Identity and dedupe:

- `Name` - trigger-assigned, `createable=false`, `updateable=false`, autonumber. Format `PO-` plus five digits today, for example `PO-16839`. **The format is a contract, not a cosmetic** (section 4.19).
- `PO_Number__c` - CALCULATED formula, string 1300. The bare numeric form of `Name`, for example `16839`. It is selected once and never read. Automayt does not need to reproduce it.
- `PBSI__Tracking_Code__c` - string, length 50, plain, not unique, not indexed as an external id. **This is the Purchase Order dedupe key**: one physical parcel means one Purchase Order.

Fields run-orders writes on create:

- `PBSI__Account__c` - reference to Account. This is the **vendor** on a Purchase Order (whereas the customer field on a Sales Order is `PBSI__Customer__c`). Always Prosol on the two order flows; Prosol or Treeco on the FBA flow.
- `PBSI__Order_Date__c` - date, `nillable=false`. Amazon writes the ship date, Shopify writes today or the back-dated override, FBA writes today.
- `PBSI__Status__c` - picklist, written as `Open`. Full declared domain: Open (default), Partially Complete, Not ordered, Ordered, Received, Vendor Invoiced, Paid, Complete, Closed, Cancelled.
- `PBSI__Shipping_Instructions__c` - textarea. **The schema length is 255 on the Purchase Order** and the code truncates to 255 as well. This field is doing real work as the human-readable cross-reference and as the only channel marker (section 5).
- `PBSI__Tracking_Code__c` - set when a tracking number exists. The Amazon path writes an empty string when there is none, which defeats the dedupe.

Fields run-orders updates: `PBSI__Status__c` set back to `Open` before each goods receipt after the first, and only on the Amazon flow.

Fields run-orders reads: `Id`, `Name`, `PBSI__Status__c`, `PBSI__Order_Date__c`, `PBSI__Order_Total__c` (CALCULATED), `PBSI__Final_Order_Total__c` (CALCULATED), `PBSI__Sales_Tax__c` (percent, writable), `PBSI__Freight_Amount__c` (currency, writable, see section 9), `PBSI__Tracking_Code__c`, `PBSI__Account__r.Name`, `PBSI__Sales_Order__c` and `PBSI__Sales_Order__r.Name`, `CreatedDate`, `LastModifiedDate`, `CreatedBy.Name`, `OwnerId` and `Owner.Name`, `PBSI__Movement_Journal__c`, `Date_Received__c`, `Date_Invoiced__c`, `Count_Payables__c`, `mm_Claim__c`, `Received_Location__c`, `mm_Received_Location_Name__c` (CALCULATED), `CFC_Stage__c` (CALCULATED), `Ascent2QB__QB_Purchase_Order_ID__c`, `Ascent2QB__QB_Needs_Update__c`.

**Four field names appear in the operator inspector and do not exist in this org.** `scripts/ops/po-lookup.js:92-93` names `PBSI__Expected_Date__c`, `PBSI__Notes__c`, `PBSI__Reference__c` and `PBSI__Ship_To_Location__r.Name` as wanted fields, but `usableFields()` at `po-lookup.js:21-31` filters that wish list against a live `describe()` before building the SOQL, which is the entire reason that script exists (`po-lookup.js:5-7`). None of the four is on the 119-field describe, so none ever reaches a query and the printers at `:126`, `:128` and `:131` always render the fallback. **Do not build them on the Automayt purchase order.** In particular there is no `PBSI__Ship_To_Location__c` reference of any kind: a Purchase Order in this org has no ship-to location, which matches section 4.5's note that an FBA Purchase Order carries no location and no ship-to. The one real date field of that family is `ETA_Date__c` (date, writable), which nothing in run-orders reads today but which feeds the `CFC_Stage__c` formula.

Three of the fields that do exist deserve attention:

- `PBSI__Movement_Journal__c` is typed **string, length 20**, not a reference, even though it stores a Movement Journal record id such as `a0pOJ000001ZGPVYA4`. It is the canary the pipeline reads to prove a receipt actually posted inventory. In Automayt this should be a real foreign key.
- `PBSI__Sales_Order__c` on the header is **not written by run-orders** but is populated on live records. A trigger stamps it from the Purchase Order line's drop-ship Sales Order link. The 2026-04 field map claims the client should write it; the shipped code does not, and the value appears anyway.
- `Received_Location__c` (reference to Location) and `Date_Received__c` (date) are both writable per the schema, but a Salesforce Flow stamps them on receipt. `CFC_Stage__c` and `mm_Received_Location_Name__c` are formulas computed from them, and an API write to either returns `INVALID_FIELD_FOR_INSERT_UPDATE`.

Status distribution for Purchase Orders created in the last 365 days: Complete 4,563, Open 242, Partially Complete 68, Closed 19, Cancelled 6, null 1. `Not ordered`, `Ordered`, `Received`, `Vendor Invoiced` and `Paid` are declared and completely unused in the last year.

**The terminal status for an auto-received pipeline Purchase Order is `Complete`, and it is set by PBSI's own trigger, not by run-orders.** Two comments in the source and several older notes still claim the flow ends at `Received`. They are stale. The authoritative statement is the comment at `lib/amazon-po.js:872-880`, and the live data agrees: no Amazon-flow Purchase Order has ever sat at `Received`. Separately, `Closed` is terminal and blocks payable creation, which is why the receipt path deliberately does not use it. `Cancelled` is the established soft-delete: 12 cancelled Purchase Orders exist all time as an audit trail, and the convention is to cancel rather than delete. The consolidated status requirement, including which transitions have to be legal, is in section 6.10.

**Channel markers.** Two platform-computed fields on the Purchase Order look like channel discriminators. Neither is one, and both appear in the section 4.3 sample:

- `Opportunity__c` - string 1300, CALCULATED, label "Job Name", formula `PBSI__Sales_Order__r.PBSI__Customer__r.Name+" - "+PBSI__Sales_Order__r.PBSI__Opportunity__r.Name`. Because pipeline Sales Orders carry a house account and no Opportunity, it evaluates to the literal `Amazon.ca -` on Amazon Purchase Orders and `Shopify -` on Shopify Purchase Orders. It is the closest thing the org has to a channel field, and it works only by accident of the house-account naming. An FBA Purchase Order has no Sales Order link at all, so the whole formula resolves to null. There is no fourth value and no room for one.
- `mm_Amazon_or_Shopify__c` - boolean, CALCULATED, formula `IF(OR(PBSI__Sales_Order__r.PBSI__Customer__r.Name = 'Amazon.ca', PBSI__Sales_Order__r.Shopify_Order__c = True), True, False)`. It reads `true` on the Amazon Purchase Order and `false` on all three sampled Shopify Purchase Orders, so despite the name it is not a two-valued channel flag in practice. The reason is the second half of the condition: `PBSI__PBSI_Sales_Order__c.Shopify_Order__c` is itself a formula, `AND(OR(CreatedBy.LastName = "Support", CreatedBy.FirstName = "Mac"), LEFT(PBSI__Customer_Purchase_Order__c, 1) = "#")`, and the pipeline strips the leading hash before writing the customer purchase order reference, so that branch never fires for a pipeline Sales Order. Note also that it keys on the **first name of the creating user**: the moment the integration stops running as a person called Mac, the flag changes meaning. Do not carry this design forward.

The requirement that follows is in section 6.3: a first-class `channel` enum and an `external_ref` on the Purchase Order, so the free-text memo in section 5.7 and both of these formulas can be retired.

**The vendor-notification control surface.** This is the most dangerous single behaviour to get wrong at cutover, because the failure mode is a duplicate order at Prosol. Five fields on the Purchase Order govern or record vendor email, and run-orders writes none of them:

- `Auto_Send_Itemized_PO__c` - boolean, label "Auto Send PO?", `nillable=false`, default `false`, createable and updateable. **Every sampled pipeline Purchase Order carries `true`.** It is set to `true` by the active org Flow `PO_Order_Desk_Contact` (after-save, on Create, entry criterion `PBSI__Account__c` is not null), which in the same update stamps `PBSI__Contact__c`. So a Purchase Order created over the API arrives flagged "auto send" within milliseconds, and nothing the caller does prevents it.
- `PBSI__Contact__c` - reference to Contact, createable and updateable, never written by run-orders. The same Flow looks up the first Contact whose `Name` contains the string `Order Desk` on the Purchase Order's vendor account and writes its id. On every pipeline Purchase Order that resolves to `0034x00001u639QAAQ`, which is the Contact named "Order Desk" on `Prosol Inc.`, email `order.burnaby@prosol.ca`. That is the address any create-time vendor email in Automayt would go to, and it is not the address run-orders emails: the pipeline emails the specific branch order desk itself.
- `mm_Send_Email__c` - boolean, label "Send Email?", writable, default `false`. `false` on every sampled pipeline Purchase Order. It is not the send gate: it is written to `true` by the active Flow `received_po_line_date_update_on_po`, which fires when a `PBSI__Received_Purchase_Order_Line__c` is created and updates the Purchase Order header. Over the last 60 days it is `true` on 227 Purchase Orders, of which only 122 were ever sent.
- `mm_Do_not_send_email_notification__c` - boolean, **CALCULATED**, formula `PBSI__Account__r.mm_Do_not_send_email_notification__c`. It is a vendor-account opt-out mirrored onto the order. It reads `false` on Prosol, so it is not what suppresses the email either.
- `mm_PO_pdf_created__c` - boolean, writable, default `false`, `false` on every sampled Purchase Order including human ones. A record of whether the Salesforce-rendered PDF was produced.

What actually happens, measured rather than assumed. `PBSI__Date_Sent__c` (date, writable, null on every pipeline Purchase Order) is the field that records that a Purchase Order was sent, and it is what makes `CFC_Stage__c` read `Sent`. Over Purchase Orders created in the last 60 days: 936 total, 373 with `PBSI__Date_Sent__c` populated, and **0 of those 373 had `Auto_Send_Itemized_PO__c = false`**, so that flag is a necessary precondition for a send. Of the 375 pipeline Prosol Purchase Orders in the same window (vendor Prosol plus a non-null tracking code), **0 were ever sent, 0 carry `mm_Send_Email__c = true`, and 0 carry `Auto_Send_Itemized_PO__c = false`.** No Workflow Rule exists on the Purchase Order object. The managed package ships a Visualforce email template `PBSI.POmail`.

The conclusion Doug's team needs: **in Salesforce the vendor email is an interactive, record-level action, not a create-time side effect.** Nothing on the record suppresses it for machine-created Purchase Orders. The pipeline's Purchase Orders are never emailed because nobody presses the button on them, and because Prosol is told by run-orders' own email instead (`lib/pipeline.js` `phaseEmail`). The `Auto_Send_Itemized_PO__c = true` that an org Flow stamps on every one of them is a live loaded gun: **if Automayt reads a flag with that name and sends on create, every pipeline Purchase Order emails `order.burnaby@prosol.ca` on top of the email run-orders already sent, and Prosol ships the order twice.** The requirement in section 9.1 item 14 is therefore: creating a Purchase Order must never send anything to anybody; sending must be a separate, explicit, addressable operation.

### 3.4 Purchase Order Line - `PBSI__PBSI_Purchase_Order_Line__c`

Shape: key prefix `a0x`, 105 fields, 25,388 records.

Fields run-orders writes on create:

- `PBSI__Purchase_Order__c` - reference to the parent. **`nillable=false`, `createable=true`, `updateable=false`.** Master-detail.
- `PBSI__Item__c` - reference to Item.
- `PBSI__Quantity_Ordered__c` - double, precision 18 scale 6, **`nillable=false`**. Fractional quantities are real: an area item ordered as 3 rolls is written as 403.5.
- `PBSI__Price__c` - currency 18.2. See the warning below.
- `PBSI__Sales_Order__c` - reference to Sales Order, labelled "Drop Ship SO". Written on the Shopify and Amazon flows, **not** on the FBA flow.
- `PBSI__Original_SO_Line__c` - reference to Sales Order Line. Written on the Shopify and Amazon flows, not on FBA.

**The demand link is conditionally mandatory.** An org validation rule blocks ordering an item whose item status is `Special Order` unless the Purchase Order line carries `PBSI__Sales_Order__c`. Drop-ship lines always carry both links; FBA replenishment lines carry neither and work fine for non-special-order items. Automayt must make the demand link supported and optional, not universally required, or the replenishment flow cannot be modelled.

**`PBSI__Price__c` is trigger-managed and the value the client sends is discarded.** This is confirmed by live data, not only by lore. On Shopify order 1373, the Sales Order line price is 59.11 (the Shopify retail price the client wrote) and the Purchase Order line price is 44.71 with `PBSI__Price4__c` also 44.71. The client wrote 59.11 to the Purchase Order line; PBSI overwrote it with the item's cost. The documented workaround, learned in August 2026, is that `PBSI__Price4__c` is the field the user-interface price column edits and the trigger's source of truth, and that writing **both** `PBSI__Price4__c` and `PBSI__Price__c` in the same DML makes the value stick. Nothing in run-orders does that today. The practical effects:

- Shopify Purchase Order lines are recorded at vendor cost, not at retail, which is correct by luck rather than by design.
- Amazon and FBA lines write the item cost, which is the same value the trigger stamps, so the defect is invisible there.
- Any future attempt to write a negotiated or corrected price silently fails. This cost real money on a freight line (377.05 sent, 332.82 wanted) and on a Schluter line (35.14 sent, 29.95 stored).

**Requirement: the price a caller sends must be the price Automayt stores, or Automayt must say in the response that it derived a different one.**

Fields run-orders reads: `Id`, `Name` (autonumber), `PBSI__Item__r.Name`, `PBSI__Item__r.PBSI__Vendor_Item_ID__c`, `PBSI__Item__r.PBSI__Description__c`, `PBSI__Quantity_Ordered__c`, `PBSI__Quantity_Received__c` (double 18.6, writable), `PBSI__Quantity_Left_To_Receive__c` (CALCULATED formula), `PBSI__Price__c`, `PBSI__Item_Cost__c` (CALCULATED formula, currency 18.2), `PBSI__Total_Price__c` (CALCULATED), `PBSI__Pre_Tax_Total_Price__c` (CALCULATED), `PBSI__ItemDescription__c` (textarea 255, writable), `PBSI__PO_Line_Item_Description__c` (CALCULATED), `PBSI__Vendor_Item_ID__c` (string 255, writable, **a copy of the vendor code on the line itself**), `PBSI__Purchase_Order__r.*` traversals.

Note the naming trap that cost real debugging time: this object uses `PBSI__Quantity_Ordered__c`, the Sales Order Line uses `PBSI__Quantity__c`, and `scripts/ops/po-lookup.js` probes three candidate names for received quantity (`PBSI__Quantity_Received__c`, `PBSI__Received_Quantity__c`, `PBSI__Qty_Received__c`) because it did not know which existed. **Automayt should ship one name per concept.**

### 3.5 Item - `PBSI__PBSI_Item__c`

Purpose. The item master. Everything resolves through it: order lines, costs, stock, tax, GL routing.

Shape: key prefix `a0u`, 270 fields, 12,685 records.

Two competing identities, and both are load-bearing:

- `Name` - "Item Number", string 80, writable, defaulted. In practice a numeric CFC item number such as `11433`, `02240`, `13572`. **It is not unique in practice.** The ETL calls this out explicitly: multiple Salesforce items share a Name, so a cost lookup by Name can pick the wrong item. It is nonetheless the join key the analytics database uses as "our SKU", and it is what some Shopify variant SKUs match on.
- `PBSI__Vendor_Item_ID__c` - "Manufacturer Code", string 30, writable. The vendor's code. This is what every order-time lookup uses. It is effectively unique org-wide (the org enforces it), but there are roughly 31 known duplicate pairs created historically when separators were stripped.

**The item identity decision, stated once so the rest of this document is consistent.** Every other flow resolves through the item, so this cannot be left open. What run-orders requires of Automayt:

1. **`vendor_code` is the primary key of an item.** It is what all three lookup ladders in section 4.7 query, what the mapping guard queries before any money is spent, and what the FBA replenishment subtraction joins on. Automayt must own the normalisation: separators (`/` and `-`) and case must not change which record is found, so `KERDIFIX/BW`, `KERDIFIXBW`, `kerdifixbw` and `KERDIFIX-BW` all resolve to one record. That retires the four-spelling ladder.
2. **`item_number` must survive verbatim as a queryable secondary identifier, and it must not be silently made unique.** The Salesforce `Name` value (for example `11433`, `02240`, `13572`) is a foreign key in three local stores that Automayt does not control: `analytics.sqlite.sku_map_canonical.sf_item_name`, `analytics.sqlite.item_costs.sku`, and the `api_sku` field in `scripts/shipstation/sku-map.json`, which doubles as the Salesforce item number for some Shopify products (section 8.3). The nightly cost mirror in section 4.9 is keyed on it end to end. Renumbering items at migration means rewriting all three plus every Shopify variant SKU that matches on it. **The requirement is: same string, same item, after the move.**
3. **Uniqueness differs between the two, and the document should stop implying otherwise.** `vendor_code` is unique and Automayt should enforce it. `item_number` is **not** unique in the current data and must be modelled as non-unique, because deduplicating it at migration would either merge two live items or renumber one of them, and both break rule 2. A lookup by item number must be able to return more than one row and say so, rather than picking one.
4. **The roughly 31 duplicate pairs migrate as they are.** They are two item records sharing one vendor code in separator-stripped and separator-bearing spellings. Do not merge them at migration and do not delete either side: Purchase Order lines, Sales Order lines and receipts reference both, and CFC's own cleanup convention is to move the non-overlapping data (UPC code, colour, size) onto the canonical legacy row and then set the auto-created twin to `PBSI__Item_Status__c = 'Inactive'`. If Automayt enforces vendor-code uniqueness on import, it must resolve each pair by keeping the row with transaction history, marking the other inactive, and reporting the list. CFC will reconcile from that list.
5. **Aliases are the mechanism, not client-side string mangling.** An item should carry a set of alternate codes (the ASIN, the manufacturer SKU, the legacy stripped form, the CFC item number) that all resolve through one lookup call.

Sections 6.5, 8.3, 9.2 item 6 and 10.1 item 9 restate parts of this. Where they differ in emphasis, this list governs.

**The separator rule.** Prosol's SKUs carry slashes and hyphens (`KERDIFIX/BW`, `DITRA-DRAIN25M`, `94130-51`). Salesforce's catalogue has decades of legacy rows with the separators stripped (`KERDIFIXBW`, `DitraDRAIN25M`, mixed case). So:

- Lookups try four spellings in this order and take the first hit: fully stripped (both slash and hyphen removed), slash removed only, hyphen removed only, exact. Most-stripped first, deliberately, so the canonical legacy row wins over a duplicate auto-created slashed row.
- New items are created with the **stripped** form in both `Name` and `PBSI__Vendor_Item_ID__c`, because Prosol's website price import matches the un-slashed form.
- The sku-map keeps slashes, because Prosol's order API needs them.

Fields run-orders writes when it lazily creates an item:

- `Name` - **mandatory in practice even though the schema says nillable.** Omitting it throws `PBSI.ItemMasterTrigger: execution of BeforeInsert / System.NullPointerException`. An org Flow then **overwrites it after insert** with the `Auto_Item_Number__c` autonumber, so the record ends up named for example `14146`.
- `PBSI__description__c` - textarea 255, **`nillable=false`**. Note the lowercase d; see the case-sensitivity warning below. An org Flow **rewrites this after insert** into the house format `Manufacturer -  - Product - <sku> -` (with the doubled space and trailing hyphen as shown).
- `PBSI__Vendor_Item_ID__c`, `PBSI__Default_Vendor__c` (reference to Account, Prosol), `PBSI__Default_Location__c` (reference to Location, Sechelt Warehouse), `PBSI__Item_Group__c` (reference to `PBSI__PBSI_Item_Group__c`).
- `PBSI__defaultunitofmeasure__c` - string 255, **`nillable=false`**, written as `EA`.
- `Unit_of_Measure__c` - picklist, restricted, domain `SqFt, EA, SqYd, LnFt`, written as `EA`.
- `PBSI__Item_Status__c` = `Active`, `PBSI__Item_Type__c` = `Item`, `PBSI__Cost_Type__c` = `Standard Cost`, `PBSI__Coverage_Code__c` = `Min/Max`, `PBSI__Lot_Tracking__c` = true, `PBSI__No_Lot_Expiration__c` = true, `PBSI__Taxable__c` = true, `PBSI__Tax_Code__c` = `a1S4x000002QmjbEAC`.
- `PBSI__Cost__c`, `PBSI__purchaseprice__c`, `mm_Landed_Cost__c` - all three set to the resolved Prosol cost. **`mm_Landed_Cost__c` is `nillable=false`**, which is why the code refuses to create an item with no known cost rather than letting Salesforce reject it with a cryptic message.
- `PBSI__salesprice__c` and `mm_Original_Retail_Price__c` - set only when a retail price is known.
- `PBSI__UPC_Code__c` - string 30, set only when the barcode matches 8 to 14 digits.
- Derived descriptive fields: `Manufacturer__c`, `Original_Style_Name__c`, `Color__c`, `Size__c`, all string 255. `Manufacturer__c` is **free text**: known brands are normalised to one of seven values, and anything else is title-cased and written verbatim, so Automayt must not make it a restricted picklist.

Fields run-orders reads:

- `Id`, `Name`, `PBSI__Vendor_Item_ID__c`, `PBSI__description__c`, `PBSI__salesprice__c`, `PBSI__Cost__c`, `Unit_of_Measure__c`, `PBSI__defaultunitofmeasure__c`, `PBSI__Default_Vendor_Name__c` (CALCULATED formula), `PBSI__Product__c` (reference to Product2), `PBSI__Item_Group__c` and `Item_Group_Name__c` (CALCULATED).
- `PBSI__Available_to_Promise__c` - CALCULATED formula, double 18.6. Available to promise, net of committed. **Negative values are real** and mean oversold. This is the stock truth for the storefront, not on-hand.
- `Box_Quantity__c` - double 18.2. Square feet or units per carton. Boxes for sale equal floor of available-to-promise divided by box quantity.
- `PBSI__Not_Available_For_Sale__c` - boolean, `nillable=false`. A hard kill flag, tested with strict identity against `true`.
- `AscentBTO__Stock_Status__c` - picklist, restricted, domain `Discontinued, Special Order, Stock, Labour`. The literal string `Stock` is load-bearing: it is one half of the in-stock test.
- Cost-probe candidates enumerated by the data-inventory script: `PBSI__Cost__c`, `PBSI__Unit_Cost__c`, `PBSI__Standard_Cost__c`, `PBSI__Purchase_Price__c`, `PBSI__Last_Cost__c`, `PBSI__Average_Cost__c`.

**Field-name case.** The real API name is `PBSI__description__c`, all lowercase after the namespace. **Five live query sites** spell it `PBSI__Description__c` with a capital D: `lib/shopify-sf.js:198` (in a WHERE clause), `scripts/etl/sync-item-costs.js:56`, `scripts/etl/sync-sku-map.js:73`, and two traversals, `scripts/ops/po-lookup.js:97` and `scripts/ops/lookup-so.js:27`. SOQL is case-insensitive so all five work, but the response echoes the canonical casing, so the read-back is `undefined` in **two** places: `sync-sku-map.js:161` (`sfItem?.PBSI__Description__c`, so the canonical product name silently falls back) and `po-lookup.js:148` (`l.PBSI__Item__r?.PBSI__Description__c`, so the inspector's description column is permanently blank). **If Automayt is case-sensitive on field names, five queries break on day one and two of them already fail silently today.** Either be case-insensitive, or tell CFC so the five call sites can be fixed before cutover.

**Unit of measure is modelled twice, once cleanly and once filthily.** `Unit_of_Measure__c` is a restricted picklist with four values (`SqFt` 4,861, `EA` 5,485, `SqYd` 1,836, `LnFt` 298, null on 205). `PBSI__defaultunitofmeasure__c` is free text and holds 17 distinct values across 12,685 items: `EA` 5,599, `SqFt` 4,898, `SqYd` 1,842, `LnFt` 299, `Sq Ft` 12, `Rollend` 11, `SF` 10, `Take All` 4, `SY` 2, and one record each of `Take All 40`, `Take All 120`, `Take All 314`, `Take All 791`, `sq yrds`, `Lft`, `LF` and `length`. Note that `LnFt`, `Lft` and `LF` are three spellings of one unit and `SqYd`, `SY` and `sq yrds` are three spellings of another, which is exactly the normalisation this paragraph is arguing for. Keep the restricted one and normalise the free-text twin on migration.

**Coverage is not a field, and it should be.** For an area-stocked item, run-orders needs square feet per roll. There is no numeric field for it, so `lib/pbsi-uom.js` regex-parses the **last** "N sq ft" token out of the free-text `PBSI__description__c` (section 4.1 step 4e and section 5.9). That makes a description string load-bearing accounting data, on a field the active org Flow `Item_Master_Description_Updated` rewrites whenever `Size__c`, `Box_Quantity__c`, `Original_Style_Name__c`, `Manufacturer__c` or `Color__c` changes. **Automayt must expose a real numeric conversion factor on the item, and it must cover every non-each unit, not only square feet.** Section 5.9 sets out where the numbers come from at migration and what the current implementation does not cover.

### 3.6 Location - `PBSI__PBSI_Location__c`

Shape: key prefix `a0v`, 53 fields, **14 records total**. Fields read: `Id`, `Name`, `PBSI__description__c`.

All 14 locations, with ids, because the migration needs them:

- `Amazon Fulfillment` - `a0v4x000005kF5ZAAU`. **Virtual, not a physical warehouse.** Every Amazon FBM goods receipt posts here.
- `Sechelt Warehouse` - `a0v4x000005kF5gAAE`. The default location stamped on every auto-created item. Note it differs from the Amazon Fulfillment id by two characters.
- `Sechelt` - `a0vOJ00000AVI1JYAX`
- `Sechelt Showroom` - `a0v4x000005kF5bAAE`
- `Staging - Sechelt Warehouse` - `a0vOJ000007RmcPYAS`
- `Powell River` - `a0v4x000005kF60AAE`
- `Staging - Powell River` - `a0vOJ0000080OP7YAM`
- `IN - TRANSIT` - `a0v4x000005kF7mAAE`
- `Clyde Higginson` - `a0vOJ00000HwjB3YAJ`
- `DMG` - `a0vOJ000004yqCjYAI`
- `Gibsons - DO NOT USE` - `a0v4x000006Sz15AAC`
- `Gibsons Showroom - DO NOT USE` - `a0v4x000005kF5XAAU`
- `Hino 5 Ton - DO NOT USE` - `a0v4x000005kF6DAAU`
- `Powell river - - DO NOT USE` - `a0v4x000006jAKuAAM`

The object has no active or inactive flag and no type field, so deprecation is encoded by appending the literal text " - DO NOT USE" to the name. **Automayt should give locations a real active flag and a real virtual or physical type flag, and migrate those three accordingly.**

### 3.7 Goods receipt: Received Purchase Order Line, Movement Journal, Movement Line

This is the most important non-CRUD behaviour in the whole integration.

`PBSI__Received_Purchase_Order_Line__c` - key prefix `a1D`, 78 fields, 25,911 records. The receipt row.

Fields the receipt carries, exactly the eight run-orders supplies:

- `PBSI__Purchase_Order__c` (reference), `PBSI__Purchase_Order_Line__c` (reference), `PBSI__Item__c` (reference), `PBSI__Location__c` (reference), `PBSI__Quantity_Received__c` (double 18.6), `PBSI__Receiving_Date__c` (date), `PBSI__Price__c` (currency 18.2), `PBSI__Type__c` (picklist: `receive` default, `credit`, `reverse poline`).

Type usage in the real data: `receive` 9,094 in the last year, which is 100 percent. `credit` and `reverse poline` exist and have never been used.

All eight fields are `createable=true`. **That is the trap.** A plain row insert succeeds and looks correct, but skips the chain that actually posts inventory. Between 2026-05-26 and 2026-05-28 the pipeline did exactly that, and the symptoms were: quantity on hand appeared, stock was not packable, vendor invoices could not post, and QuickBooks never synced. The accountant had to repair the broken receipts by hand.

The correct path is the managed invocable action:

```
POST /services/data/v42.0/actions/custom/apex/PBSI__ReceivedPOLinesCreateAction
{ "inputs": [ { "receivedRequests": [ { "receivedPOLine": { ...the eight fields... } } ] } ] }
```

It creates, atomically: the `PBSI__Received_Purchase_Order_Line__c`, a `PBSI__Movement_Journal__c` of type `Goods Receipt for Purchase Order`, and its `PBSI__Movement_Line__c` children. It returns HTTP 200 with an array of per-input envelopes; per-input failure is signalled by `isSuccess: false` inside the envelope, not by an HTTP error code. The outputs are `outputValues.receivedPOLineId` and `outputValues.message`.

`PBSI__Movement_Journal__c` - key prefix `a0p`, 20 fields, 46,603 records. `PBSI__Type__c` is a picklist of 25 movement types; the ones that matter here are `Goods Receipt for Purchase Order` (14,602 records) and `Goods Receipt for Purchase Order - Reversal` (82). Two spellings of the return type are both live and both have to migrate: the **declared** value `RMA  Returned from Customer` with two spaces carries 73 records, and an **undeclared** one-space variant `RMA Returned from Customer` carries 4,969. `Un-Stage` (44 records) is undeclared as well.

`PBSI__Movement_Line__c` - key prefix `a0q`, 85 fields, 156,217 records. `PBSI__Movement_Journal__c` is `nillable=false`, `updateable=false`. Never written by run-orders.

run-orders never writes a Movement Journal or Movement Line. It only **reads** `PBSI__PBSI_Purchase_Order__c.PBSI__Movement_Journal__c` as a canary that the receipt fired, and raises a loud error when it is null after a full receipt.

The same Purchase Order record also carries `PBSI__hasMJ__c` (double, writable, not calculated), which reads 1 on both received sample Purchase Orders (PO-16839, PO-16701) and 0 on the two unreceived ones (PO-16785, PO-16683). That is closer to the boolean "did inventory post" signal section 6.4 asks Automayt to return than a 20-character string holding a record id, and it is the better model of the two to copy. Automayt should return the inventory-transaction id itself (a real foreign key) plus a posted flag, and CFC will assert on both.

**Requirement: Automayt must expose receiving as an operation that atomically posts inventory, and must return the resulting inventory-transaction identifier so the caller can assert that it posted.** A receipt that does not post inventory must be an error, not a silent success.

### 3.8 Account and Contact

`Account` - key prefix `001`, 249 fields, 21,582 records, record types Business Account (default) and Person Account.

run-orders reads `Id`, `Name`, `Phone`, `Type` (picklist: Customer, Prospect default, Vendor, Other) and traverses `PBSI__Account__r.Name` on Purchase Orders. It resolves vendors by partial name (`Name LIKE '%rosol%'`, `Name LIKE '%reight%imple%'`) in operator scripts.

run-orders writes exactly one Account field: `mm_On_Hold__c` (boolean, `nillable=false`) set to `false`. It is not a Flow side effect the pipeline inherits; the pipeline issues the update itself, unconditionally, with failures swallowed:

- Shopify: inline immediately after connecting, before the duplicate guard, so it fires once per Shopify order processed including ones that are then skipped (`lib/shopify-sf.js:557-558`).
- Amazon: a named function called once per distinct 14-day window per run, before the Sales Order lookup (`lib/amazon-po.js:178-182`, called at `:220`).

The reason is that an org Flow keeps re-applying a credit hold to the Shopify and Amazon house accounts, and a held account blocks Sales Order creation. If Automayt has no credit-hold concept, or guarantees automation is never hold-blocked, both call sites simply disappear.

Other Account facts worth carrying: `Sub_Type__c` picklist is `Retail Customer, Contractor, Designer, Vendor, Installer, Flooring Vendor`, and `Installer` means one of CFC's own crews. Account creation over the API has org-specific traps (a billing address is required by validation, `BillingState` must be a two-letter code, and the record type is forced to Business on insert so a Person Account needs a create-then-update). run-orders does not create Accounts; the sibling repository does.

`Contact` - key prefix `003`, 63 fields, 6,517 records. **Read only.** One query, by email, limit 1, returning `Id, Name, Email, Phone, AccountId`. If it misses, the Sales Order is created with no contact link and no contact is ever created. `LastName` is the only genuinely required field on create.

### 3.9 Product2 and GL revenue routing

`Product2` - key prefix `01t`, 50 fields, 12,698 records, one per Item.

run-orders never inserts a Product2. When a `PBSI__PBSI_Item__c` is created, a PBSI or Ascent4Prods trigger creates the companion Product2 **asynchronously** and links it at `PBSI__PBSI_Item__c.PBSI__Product__c`. The pipeline then polls for it: six attempts, with the sleep skipped on the first, so five waits of 1.5 seconds, about 7.5 seconds of sleeping plus query time (`lib/shopify-sf.js:397-398`). It reads `Product2.AcctSeed__Revenue_GL_Account__c`, and if it is not already correct, updates it to the GL account `4000-Sales` (`a6Q4x0000000sr4EAA`). The whole stamp is non-fatal and its failure is not surfaced in the run output.

Why this exists. Accounting Seed fills each Billing Line's revenue GL from `Product2.AcctSeed__Revenue_GL_Account__c`; when that is null it falls back to the ledger's GL Account Default records. For years the four relevant defaults pointed at `4000-Product Revenue` (`a6Q4x0000000sU2EAI`), an account that had been deactivated, so every machine-created item leaked revenue there. The defect was closed in 2026-06 by repointing the four defaults; since then 1,375 revenue billing lines have posted, all to `4000-Sales`.

**Two mechanics Automayt must decide about explicitly:**

1. **The revenue GL is snapshotted onto each Billing Line at the instant the line is created.** It is a frozen copy, not a live pointer. Changing the item, the product, or the default afterwards does nothing to lines that already exist. That is why the leak appeared to keep recurring for three years: every fix was forward-only.
2. **There must be a ledger-level default** that catches items with no per-item GL. If Automayt has a live pointer and a default, the per-item stamp becomes unnecessary and the poll-and-patch dance disappears. If it has a snapshot and no default, the stamp becomes load-bearing and **must be settable atomically at item-create time**.

Also relevant: four Product2 validation rules (`Require_*_GL_Account`, `Inventory_Type`) only fire when `AcctSeed__Inventory_Type__c = 'Purchased'` or `AcctSeed__Inventory_Product__c = true`, both of which are false on auto-created items, which is why those items were allowed to exist with a null GL in the first place.

### 3.10 Vendor Invoice, AcctSeed Payable and Payable Line

These are read-only for run-orders, but they are where payment truth lives and they are the spine of the accounting-exception tooling.

`PBSI__Vendor_Invoice__c` - key prefix `a1d`, 56 fields, **only 213 records**. Fields read: `Id`, `Name`, `PBSI__Status__c` (picklist: Open default, Complete, Closed, Voided), `PBSI__Payment_Status__c` (picklist: Open default, Partially Paid, Paid, Past Due), `PBSI__Amount_Paid__c`, `PBSI__Purchase_Order__c`, `CreatedDate`. This object was investigated as a possible payment-truth source and **rejected**: with 213 records against 15,045 Purchase Orders it is not in real use.

`AcctSeed__Account_Payable__c` - key prefix `a5i`, 71 fields, **25,982 records** by object count. A separate status scan taken minutes later on the same day counted 25,984 rows across the two `AcctSeed__Status__c` values, because the object grows during a business day. Re-count both in one pass before sizing a migration; the difference is two records, not a modelling problem. This is where payment truth lives. Fields read:

- `Name` (autonumber, format `AP-30476`).
- `A2AS__Purchase_Order__c` - reference to `PBSI__PBSI_Purchase_Order__c`. **This is the Ascent2AcctSeed bridge field and the single most important join in the accounting layer.** It is not always populated; one script exists purely to measure the link rate.
- `AcctSeed__Vendor__c` - reference to Account.
- `AcctSeed__Date__c` - date, `nillable=false`.
- `AcctSeed__Total__c` - CALCULATED roll-up, currency.
- `AcctSeed__Sub_Total__c` - CALCULATED formula, currency. **Pre-tax.** Every over-billing comparison uses this and not the gross total, because comparing gross flags every Ontario (13 percent) and Quebec (14.975 percent) shipment as fraud.
- `AcctSeed__Paid_Amount__c` - CALCULATED roll-up.
- `AcctSeed__Balance__c` - CALCULATED formula. Unpaid balance.
- `AcctSeed__Payment_Status__c` and `AcctSeed__Status__c` - picklists.

**Picklist declarations here are wrong and the data proves it.** The real domains, with counts, are:

- `AcctSeed__Status__c`: `Posted` on 25,983 records (undeclared by the picklist) and `Approved` on 1 (declared). The picklist also declares `In Process`, which nothing uses. Payables reach `Posted` automatically: the active org Flow `Payable_on_Create_Auto_Post` does it on create.
- `AcctSeed__Payment_Status__c`: `Paid` 24,893 (undeclared), `Unpaid` 1,083 (declared), `Partially Paid` 8 (undeclared).

`Unpaid` matters more than its share of the rows suggests: it is the value the entire accounting-exception subsystem filters on (the read in section 4.13, the requirement in section 6.7, and the closing rule of this section). It is also the only one of the three that the picklist declares. None of these fields is a restricted picklist, so the managed package writes values outside the declaration. **Automayt's status domains must come from the data, not from the schema, and must include every value above.**

`AcctSeed__Account_Payable_Line__c` - key prefix `a5h`, 53 fields. Fields read: `Name`, `AcctSeed__Account_Payable__c` (reference, `nillable=false`, `updateable=false`), `AcctSeed__Quantity__c`, `AcctSeed__Unit_Cost__c`, `AcctSeed__Amount__c`, `AcctSeed__Sub_Total__c`, `AcctSeed__Product__r.Name`.

**Correction to earlier CFC notes: there is no `AcctSeed__Rate__c` on this object.** The unit-price field is `AcctSeed__Unit_Cost__c` (there is also `AcctSeed__Tax_Rate__c` and `AcctSeed__Combined_Tax_Rate__c`, which are tax rates, not prices). `scripts/ops/_tmp-sf-payable-link.js:17` selects `AcctSeed__Rate__c` and therefore fails with `INVALID_FIELD`; that script's payable-line query does not run as written, and Appendix B item 62 reproduces it only to record the fact. `AcctSeed__Unit_Cost__c` is itself written by the active org Flow `Mamoon_Update_PO_cost_on_POL`, which fires on payable-line create where `A2AS__Purchase_Order_Line__c` is not null and copies `A2AS__Received_Purchase_Order_Line__r.PBSI__Landed_Price4__c` into it. So the payable's unit cost is sourced from the goods receipt, not from the vendor invoice.

`AcctSeed__AP_Disbursement__c` is counted once by a forensic script and otherwise unused.

The business rule that governs all of this: **every accounting exception keys off UNPAID payables and goes quiet once paid.** An unpaid payable can simply be deducted; a paid one is a debt-collection problem and is out of scope by design.

### 3.11 Supporting objects: Tax Code, Item Group, GL Account, User

- `PBSI__Tax_Code__c` - 8 records. All ids, names and rates were read from the live org on 2026-09-09 and are listed in section 5.3. The three that appear in or on pipeline records are `a1S4x000002QmjbEAC` = `GST/PST - BC` at 12 percent (written on every auto-created item), `a1S4x000002pMUhEAM` = `Exempt` at 0 percent (written on the Amazon Sales Order), and `a1S4x000002oCP0EAM` = `GST` at 5 percent (stamped by an org Flow on every Purchase Order). This was previously an open question and is now closed.
- `PBSI__PBSI_Item_Group__c` - three ids hard-coded for auto-created items, and one that must never be used (section 5). The group changes accounting behaviour and populates a picklist in the Sales Order user interface, which is why putting physical product in the "Generic" group was a real incident.
- `AcctSeed__GL_Account__c` - two ids hard-coded, one live and one deactivated (section 5). Read via `AcctSeed__Active__c` and `AcctSeed__Type__c` in ad-hoc work.
- `User` - read for two reasons: to resolve "Mac Roy" so the financial report can filter Purchase Orders by owner, and to resolve accounting staff ids so a Chatter mention actually notifies. Also written once, by a one-shot admin script that unlocks a user and sets a password over `POST /services/data/v59.0/sobjects/User/<id>/password` (which requires an explicit `Content-Type: application/json` header or it fails).
- `FeedItem` and the Chatter Connect API - read to check whether anyone uses the Purchase Order feed, written to post the "DO NOT PAY" note.
- `EmailMessage`, `ContentDocumentLink`, `ContentVersion`, `Attachment`, `ApexPage` - read only, in the attempts to retrieve a rendered Purchase Order PDF (section 4.18).

### 3.12 Summary of calculated fields run-orders reads

Automayt must compute these; they can never be accepted on a write.

- Sales Order: `PBSI__Final_Order_Total__c`, `PBSI__Order_Total__c`, `CFC_Stage__c`, `Name`.
- Sales Order Line: `PBSI__Total_Price__c`, `Name`.
- Purchase Order: `PBSI__Order_Total__c`, `PBSI__Final_Order_Total__c`, `PO_Number__c`, `CFC_Stage__c`, `mm_Received_Location_Name__c`, `Name`, `Count_Payables__c` is writable but behaves as a count.
- Purchase Order Line: `PBSI__Quantity_Left_To_Receive__c`, `PBSI__Item_Cost__c`, `PBSI__Total_Price__c`, `PBSI__Pre_Tax_Total_Price__c`, `PBSI__PO_Line_Item_Description__c`, `Name`.
- Item: `PBSI__Available_to_Promise__c`, `PBSI__Default_Vendor_Name__c`, `Item_Group_Name__c`.
- Payable: `AcctSeed__Total__c`, `AcctSeed__Sub_Total__c`, `AcctSeed__Paid_Amount__c`, `AcctSeed__Balance__c`.
- Vendor Invoice: `PBSI__Total__c`.

---

## 4. Flow by flow

Every flow below states its trigger, its exact sequence of Salesforce operations, the dedupe key, what happens on failure, and what run-orders keeps locally.

### 4.1 Shopify order to Sales Order and Purchase Order

Entry point: `createShopifySoPo()` at `lib/shopify-sf.js:538-844`.

Triggers:

- The `pos` phase of the cron pipeline, once per Shopify label bought today (`lib/pipeline.js:665-728`). Four times a weekday.
- Dashboard button "Create SO + PO in Salesforce" via `POST /api/shopify/create-so-po` (`server.js:600`). This path passes **no tracking number**, so only half the duplicate guard runs.
- The reconcile sweep (section 4.2).
- Telegram `/launch` and `/stage`, and `POST /api/pipeline/run` or `/run-phase` with the `pos` phase.

Which orders are picked up: labels in today's local state whose `source` field equals `shopify`. The value originates on the staged assignment (`scripts/shipstation/run-orders.js:1117`) and is written onto the label row by `recordLabelBought` (`lib/ops-state.js:101`, where the inline comment reads "drives POS phase routing"). It was silently dropped for months, which is why a batch of Shopify orders shipped with no Sales Order at all and why the reconcile sweep exists.

Local pre-check: if `state.phases.pos.byTracking[trackingNumber]` already exists, the order is marked skipped and **no Salesforce call is made** (`lib/pipeline.js:672`).

Step 0. Fetch the Shopify order (no Salesforce). The normalised shape carries id, order number, email, customer name, shipping address, and per-line sku, title, variant, quantity and price. Taxes, discounts, shipping charges, currency, and financial or fulfilment status are **not** carried through and never reach Salesforce.

Step 1. Connect, then clear the account hold.

```
UPDATE Account 0014x000023jkuDAAQ SET mm_On_Hold__c = false
```

Failure is swallowed entirely. A connect failure records the step `sf-login` and returns with nothing created.

Step 2. Duplicate guard, `findExistingShopifySo()` at `lib/shopify-sf.js:508-536`. Two reads, in order.

Check A, only when a tracking number was passed:

```sql
SELECT Id, Name, PBSI__Sales_Order__c
FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c = '<tracking>'
LIMIT 3
```

This query has **no account and no vendor scope**. Any Purchase Order anywhere in the org carrying that tracking code aborts the whole Shopify order with the reason "PO <name> exists for tracking <code>", and no Sales Order is ever created for it.

Check B:

```sql
SELECT Id, Name, PBSI__Order_Date__c, PBSI__Customer_Purchase_Order__c, CreatedBy.Name
FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x000023jkuDAAQ'
  AND PBSI__Customer_Purchase_Order__c LIKE '%<digits>%'
LIMIT 5
```

`digits` is the first run of digits in the Shopify order name. The `LIMIT 5` is applied **before** a client-side whole-number regex filters the rows (the regex requires a non-digit character or a string boundary on both sides of the digit run, so that `1244` does not match `12445`), so if more than five Sales Orders contain the digit run as a substring the true match can fall outside the returned set and the guard passes wrongly. Low risk today at roughly 15 to 40 Shopify Sales Orders; structural once order numbers reach five digits.

**This guard fails closed.** If either query throws, the whole creation aborts with "duplicate guard failed, SO/PO creation aborted for <order> (nothing created)". A missing Sales Order costs one cron tick; a duplicate costs a reconciliation.

Step 3. Contact lookup.

```sql
SELECT Id, Name, Email, Phone, AccountId FROM Contact WHERE Email = '<email>' LIMIT 1
```

Lookup only. A miss is recorded as a successful step with a null contact id and the note "No contact found - SO will be created without contact link". No Account filter, so a contact under any account will be linked.

Step 4. Resolve every Shopify line to a Salesforce item. Three strategies in order, described in section 4.7. If none resolves and a valid sku-map entry exists, the item is lazily created (section 4.6). If nothing at all resolves, the flow aborts with "No items could be resolved in Salesforce. Cannot create SO/PO." If some resolve, the Sales Order is created with only those lines and the unresolved ones are silently absent from the order while their errors are reported.

Step 4e. Area unit-of-measure conversion. All of it lives in one module, `lib/pbsi-uom.js`, called as `resolveLineQty()` from `lib/shopify-sf.js:678-683` and `lib/amazon-po.js:706-711`. It is the one piece of client logic section 6.5 asks Automayt to absorb server-side, so it is spelled out in full here and in section 5.9.

- **Which unit field is consulted, and in what order.** `Unit_of_Measure__c` first, `PBSI__defaultunitofmeasure__c` as the fallback (the code reads `Unit_of_Measure__c` and falls back with a JavaScript logical-or to `PBSI__defaultunitofmeasure__c`, documented at `lib/pbsi-uom.js:51` and evaluated at the two call sites). The restricted picklist wins over the free-text twin.
- **Which units trigger a conversion.** Exactly the seven strings in `AREA_UOMS` at `lib/pbsi-uom.js:25-27`, compared lowercased and trimmed: `sqft`, `sq ft`, `sq. ft`, `sq.ft`, `sf`, `square feet`, `square foot`. Everything else passes through unchanged (`lib/pbsi-uom.js:62`).
- **Where the factor comes from.** An optional numeric override on the sku-map entry under the key **`coverage_sqft`**, otherwise a regex over the item description at `lib/pbsi-uom.js:42`, taking the **last** match of a number followed by a square-foot unit. A bare "SF" is deliberately not matched because it is too noisy.
- **What happens when it cannot be resolved.** `resolveLineQty` returns an error object and the line is refused with an explicit message; the order goes to manual review. **It is never silently written as quantity 1.** The reason: DITRA-HEAT membrane rolls are stocked, costed and priced per square foot, a roll is for example 134.5 square feet, and writing 1 made the order, the purchase and the receipt roughly 134 times too small. Accounting caught it in July 2026 on item 11503 and Purchase Orders 16000 and 16070.

Two things about this that a reimplementation must not copy forward:

1. **Today zero sku-map entries carry `coverage_sqft`** (grep returns 0 occurrences in `scripts/shipstation/sku-map.json`), so 100 percent of area conversions depend on parsing free text out of a field an org Flow rewrites. Where the factor comes from at migration is an open item for Mac (section 10.2 item 8): either it is populated into the map before cutover, or, better, Automayt carries it as a real numeric field on the item and CFC populates it there once.
2. **The guard only covers square feet.** `AREA_UOMS` holds seven square-foot spellings and nothing else, so `SqYd` (1,842 items) and `LnFt` (299 items) fall through the non-area branch and are written as the raw ordered count. That is the same class of error the square-foot conversion was built to stop, still live, on 2,141 items. It has not bitten yet only because those items are not sold through the two ecommerce channels today. **Automayt's conversion factor must be per unit of measure, not square-foot-only**, and the requirement in section 6.5 is written that way.

Step 5. Create the Sales Order.

```json
{
  "PBSI__Customer__c": "0014x000023jkuDAAQ",
  "PBSI__Status__c": "Open",
  "PBSI__Order_Date__c": "2026-09-04",
  "PBSI__Customer_Purchase_Order__c": "1373",
  "mm_Exempt_GST__c": false,
  "mm_Exempt_PST__c": false,
  "mm_Exempt_GST_ID__c": "",
  "mm_Exempt_PST_ID__c": "",
  "PBSI__Contact__c": "003OJ00000tgjsOYAQ"
}
```

`PBSI__Contact__c` is present only when the email lookup hit. The order date is the UTC date, or a caller-supplied override for backfills. Nothing else is sent: no ship-to address, no order total, no currency, no salesperson, no location, no freight, no tax code.

Then a second read purely for the number:

```sql
SELECT Name FROM PBSI__PBSI_Sales_Order__c WHERE Id = '<soId>'
```

A create failure here returns immediately and no Purchase Order is attempted.

Step 6. Create one Sales Order Line per resolved item.

```json
{
  "PBSI__Sales_Order__c": "a10OJ00000H8mdaYAB",
  "PBSI__Item__c": "a0uOJ000004r9u5YAA",
  "PBSI__Quantity__c": 2,
  "PBSI__Quantity_Needed__c": 2,
  "PBSI__Price__c": 59.11
}
```

Line ids are collected into a map keyed by **item id**, so two Shopify lines resolving to the same Salesforce item collide: the second overwrites the first and only one gets a Purchase Order line. Rare but silent.

Step 7. Decide which items go on the vendor Purchase Order. Items whose sku-map entry marks them `NON_PROSOL` or `SKIP` are CFC's own stock shipped from Sechelt. **The sale is real so they stay on the Sales Order; the purchase is Prosol-specific so they must not hit the Purchase Order.** If nothing Prosol-eligible remains, the flow returns with the Sales Order only, status `so-only`, reason "all items NON_PROSOL (CFC own stock / Sechelt) - no Prosol PO needed". Without this guard a pure own-stock order minted a phantom Prosol Purchase Order (PO-15363, Shopify order 1286, 2026-06-11) that overstated payables and misattributed cost of goods.

Known defect, still open: an item that is **not in the sku-map at all** but resolves in Salesforce by name or by fuzzy description defaults to Prosol-eligible, so it can still mint a phantom Prosol Purchase Order. The general fix would be to read the item's own default vendor, which the lookup query already selects and nothing reads.

Step 8. Create the Purchase Order.

```json
{
  "PBSI__Account__c": "0014x00001P1ScCAAV",
  "PBSI__Order_Date__c": "2026-09-04",
  "PBSI__Status__c": "Open",
  "PBSI__Shipping_Instructions__c": "Shopify #1373 <EMDASH> Jane Doe <EMDASH> Schluter Kerdi-Board Niche <EMDASH> purolator <EMDASH> Tracking: 520736098713",
  "PBSI__Tracking_Code__c": "520736098713"
}
```

Reminder on the notation: every `<EMDASH>` in that payload is the single character U+2014 in the real data. It reaches Prosol's order desk and is printed on CFC's own paperwork, so if you paste this example into a test harness, put the real character back. The same applies to every payload below.

The instructions string is `Shopify <order name> <EMDASH> <customer name> <EMDASH> <comma-joined item titles>` plus, when known, ` <EMDASH> <carrier>` and ` <EMDASH> Tracking: <code>`, truncated to 255 characters. The carrier code is normalised by removing a trailing `_walleted` and replacing underscores with spaces. Note the instructions keep the leading hash of the Shopify order name while the customer-PO field strips it. The tracking code key is only set when a tracking number was passed, so the dashboard button and the reconcile sweep both produce Purchase Orders with no dedupe key.

Then:

```sql
SELECT Name, PO_Number__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'
```

Only `Name` is used. A create failure here returns, leaving the Sales Order and its lines in place with no Purchase Order and no rollback.

Step 9. Create one Purchase Order Line per Prosol-eligible item.

```json
{
  "PBSI__Purchase_Order__c": "a0yOJ00000F5xxxYAA",
  "PBSI__Item__c": "a0uOJ000004r9u5YAA",
  "PBSI__Quantity_Ordered__c": 2,
  "PBSI__Price__c": 59.11,
  "PBSI__Sales_Order__c": "a10OJ00000H8mdaYAB",
  "PBSI__Original_SO_Line__c": "a0zOJ000006AOjyYAG"
}
```

The price sent is the Shopify retail price; the value PBSI stores is the item cost (44.71 in the live sample). See section 3.4. A line whose Sales Order line failed to create is silently skipped.

Failure summary for this flow: connect fails, return with nothing. Account hold update fails, ignored. Guard query fails, abort. Contact query fails, continue without a contact. Item lookup or area coverage or auto-create fails, drop that line and continue. Zero items resolved, return. Sales Order create fails, return. Sales Order line fails, continue. Purchase Order create fails, return with an orphaned Sales Order. Purchase Order line fails, continue. **There is no transaction and no rollback anywhere.**

Local persistence: `data/ops-state/<date>.json` under `phases.pos.byTracking[<tracking>]` gets `{poNumber, poId, soNumber, soId, at}`. The audit log gets a `pipeline-pos` or `shopify-so-po` record. Nothing is written back to Shopify: no order tag, no note, no metafield carrying the Sales Order or Purchase Order number.

Per-order result status is one of `created`, `skipped`, `so-only` (Sales Order created, Prosol Purchase Order deliberately skipped), `partial` (both created but with errors), or `error`.

### 4.2 Shopify Sales Order reconcile sweep

Entry point: `reconcileShopifySOs()` at `lib/shopify-so-reconcile.js`, wired non-fatally into the end of every `pos` phase (`lib/pipeline.js:737-747`), plus a command-line wrapper.

Why it exists: the per-order path only creates Sales Orders for labels bought in **today's** run state. A label bought manually, on a prior day, or on a day the `pos` phase did not run, ships with no Sales Order and nothing back-fills it. A July 2026 audit found 8 such shipped orders in 60 days.

Sequence:

1. List recent Shopify orders (Shopify REST, single page of up to 250, 45-day window).
2. Read what Salesforce already has:

```sql
SELECT PBSI__Customer_Purchase_Order__c FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x000023jkuDAAQ' AND CreatedDate = LAST_N_DAYS:65
```

The Salesforce window is deliberately 20 days wider than the order window so an edge order whose Sales Order was created later still counts as present. Values are normalised by stripping a leading hash and trimming.

3. Classify and skip: cancelled orders; orders whose financial status is not paid; orders whose fulfilment status is not fulfilled; orders whose Shopify tags match `SO-` followed by three or more digits (they were consolidated onto a parent order's Sales Order, and a fresh one would double-book revenue); orders tagged as add-ons.
4. The missing set is the eligible orders whose bare order number is not in the set from step 2. Note this is a **strict equality** test while the create guard uses a substring plus regex, so a manually entered Sales Order whose customer PO is not the bare digits is invisible to the sweep and is reported as missing on every tick forever.
5. In shadow mode, report and stop. In live mode, per missing order: refuse anything dated before the first of the current month and report it for manual backfill ("do not touch prior accounting months"), otherwise fetch the full Shopify order and call the create path with the Shopify creation date as the order-date override, and with **no tracking number and no carrier**.

This sweep is currently **shadow only**: the environment flag that makes it live is not set. Note that it still connects and still issues its query on every `pos` tick regardless, including on days with no Shopify orders at all, because the shadow gate suppresses writes, not reads.

### 4.3 Amazon FBM order to rolling Sales Order, Purchase Order and immediate goods receipt

Entry point: `createAmazonPOs({days})` at `lib/amazon-po.js:537-923`. This is the most complex flow and the only one that receives goods.

Triggers: the four weekday cron ticks with a 2-day lookback; the dashboard button "Create POs for Shipped Orders" with a 7-day lookback; the dashboard pipeline-bar step "Create POs" with a 2-day lookback; Telegram `/launch` and `/stage`; `POST /api/amazon/create-pos`.

Note the source of orders is **not** today's local state. The flow re-reads ShipStation shipments for the last N days, so it can create Purchase Orders for orders bought by any path including manual ones. It also means a Purchase Order gap left by an earlier failed tick is not picked up by a later tick that happens to stage nothing, because the pipeline returns early when nothing stages.

Step 1. Connect. Failure records step `sf-login`, which **halts the whole pipeline run**.

Step 2. Fetch shipped ShipStation shipments, filter to source `amazon_ca`. Multi-package buys attach packages 2 and later to phantom child order ids that do not exist in ShipStation's order API; the parent is recovered from local state by matching the package's tracking number. An unresolvable shipment is surfaced as a per-order error, never silently dropped: a bought label must never be silently without a Purchase Order.

Step 3. Duplicate guard, chunked 50 tracking numbers per query:

```sql
SELECT PBSI__Tracking_Code__c FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c IN ('trk1','trk2', ...)
```

**Fail closed.** On error the phase records step `check-existing` and returns having created nothing, and the pipeline halts with a Telegram alert. This is the guard that failed open on 2026-07-24 and produced 12 duplicate Purchase Orders (PO-16108 through PO-16119 duplicating PO-16069 through PO-16101) worth 744.26 dollars, all landing as Complete and Received. A regression test now asserts the fail-closed behaviour by injecting a `QUERY_TIMEOUT` with an empty message.

A shipment with no tracking number is dropped from the guard input but still gets a Purchase Order created with an empty tracking code, so it is never dedupe-checked and gets a fresh Purchase Order on every run.

Step 4, per shipment. Select or create the 14-day Amazon Sales Order, by **ship date**, not by run date.

```sql
SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x00001P1SiHAAV'
ORDER BY Name DESC
LIMIT 10
```

Each candidate's customer-PO string is parsed back into a date range (regex on month abbreviation and day, tolerant of `March 26 - Apr 8`, `FEB.26 - MAR 11`, `Feb 12 - 25`), the window start is the end minus 13 days, and the first window containing the shipment's ship date wins. The Sales Order's own order date is deliberately not trusted; only its year is used as a parse anchor. If the ship date is after the most recent window, a new Sales Order is forward-filled starting the day after. If it is before, the most recent Sales Order is reused with a console warning so accounting can move it by hand. A Sales Order whose customer PO does not parse is invisible as a candidate, so a human-created Amazon Sales Order with a free-text reference causes a second Sales Order to be created for the same period. Ordering is by `Name` descending, that is by autonumber, used as a proxy for recency, and only 10 candidates are considered.

Create payload when a new window is needed:

```json
{
  "PBSI__Customer__c": "0014x00001P1SiHAAV",
  "PBSI__Status__c": "Open",
  "PBSI__Order_Date__c": "2026-09-03",
  "PBSI__Customer_Purchase_Order__c": "Sep 3 - 16",
  "PBSI__Tax_Code__c": "a1S4x000002pMUhEAM",
  "mm_Exempt_GST__c": true,
  "mm_Exempt_PST__c": true,
  "mm_Exempt_GST_ID__c": "Third Party Amazon",
  "mm_Exempt_PST_ID__c": "Third Party Amazon",
  "PBSI__BOL_Description__c": "None"
}
```

Amazon lines are tax-exempt because Amazon is the marketplace facilitator and collects and remits. `a1S4x000002pMUhEAM` is the tax code named `Exempt` at rate 0, so the code and the two boolean flags agree. The exemption reason string is real data, not a placeholder.

Before that lookup, and only once per window per run, the Amazon account hold is cleared.

Step 5. Resolve each shipped line to a Prosol SKU and then to a Salesforce item.

- A sku-map entry marked `bundle` explodes into components, each with quantity multiplied by the ordered quantity.
- A component or listing marked `UNMAPPED_CABLE` is resolved from the Amazon listing title at run time (regex for a DITRA-HEAT cable model, else voltage plus square footage looked up in a table).
- Entries marked `NON_PROSOL` or `SKIP` produce no line. If **every** line is such an entry and there were no errors, the order is skipped with reason "Non-Prosol item - no PO needed". An unmapped SKU is an error, never a skip.
- The Salesforce item lookup is by vendor item id only, never by name (section 4.7).
- A miss triggers lazy item creation (section 4.6).
- Area conversion is applied exactly as in section 4.1.

Step 6. Create one Sales Order Line per resolved item onto the period Sales Order. Same five fields as section 4.1, except the price is the Salesforce list price with the Amazon unit price as fallback. **Zero Sales Order lines means the order errors and no Purchase Order is attempted.**

Step 7. Create the Purchase Order.

```json
{
  "PBSI__Account__c": "0014x00001P1ScCAAV",
  "PBSI__Order_Date__c": "2026-09-09",
  "PBSI__Status__c": "Open",
  "PBSI__Shipping_Instructions__c": "Amazon Order 701-3293141-1053032 <EMDASH> <NAME>, Terrace V8G <EMDASH> purolator <EMDASH> Tracking: 520743084805",
  "PBSI__Tracking_Code__c": "520743084805"
}
```

Then `SELECT Name FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'`.

Step 8, per resolved item. Create the Purchase Order Line, then immediately receive it.

```json
{
  "PBSI__Purchase_Order__c": "a0yOJ00000FdBuDYAV",
  "PBSI__Item__c": "a0u4x000003r2C4AAI",
  "PBSI__Quantity_Ordered__c": 1,
  "PBSI__Price__c": 72.41,
  "PBSI__Sales_Order__c": "a10OJ00000GnJujYAF",
  "PBSI__Original_SO_Line__c": "a0zOJ00000xxxxxYAA"
}
```

**Reopen guard.** Before every receive after the first on the same Purchase Order, the header is forced back to `Open`:

```json
{ "Id": "a0yOJ00000FdBuDYAV", "PBSI__Status__c": "Open" }
```

This exists because receiving line 1 of a multi-line Purchase Order triggers a PBSI workflow that flips the whole order to `Complete`, which then makes the receipt action throw `AscentException: Purchase order line could not be retrieved. Is it a non-credit, non-reversal, non-dropship line?` for every remaining line. The error text is misleading; the blocker is the header status. This bit CFC on PO-15381, PO-15408, PO-15376, PO-15429, PO-15489 and PO-15491 before the guard was added. The guard keys on the count of **successful** receipts, so if line 1's insert or receive throws after PBSI has already completed the order, lines 2 and later still get no reopen.

**Goods receipt.** Not an insert. The managed invocable action:

```
POST /services/data/v42.0/actions/custom/apex/PBSI__ReceivedPOLinesCreateAction
```

```json
{
  "inputs": [
    {
      "receivedRequests": [
        {
          "receivedPOLine": {
            "PBSI__Purchase_Order__c": "a0yOJ00000FdBuDYAV",
            "PBSI__Purchase_Order_Line__c": "a0xOJ00000CSoRBYA1",
            "PBSI__Item__c": "a0u4x000003r2C4AAI",
            "PBSI__Location__c": "a0v4x000005kF5ZAAU",
            "PBSI__Quantity_Received__c": 1,
            "PBSI__Receiving_Date__c": "2026-09-09",
            "PBSI__Price__c": 72.41,
            "PBSI__Type__c": "receive"
          }
        }
      ]
    }
  ]
}
```

Transport note that cost a month of silent breakage: the body must be JSON-serialised with a JSON content type. jsforce's generic request helper passed the object through unserialised with no content type and threw an unhelpful stream error, which broke Purchase Order creation from 2026-05-28 until it was found.

Response handling: HTTP 200 with an array of per-input envelopes. Failure is `isSuccess === false` inside the envelope; the message is taken from `errors[0].message`, else `outputValues.message`, else "unknown action failure". An envelope that omits `isSuccess` entirely is currently treated as success, which yields an undefined receipt id that still counts toward the reopen guard and the all-received check.

**Why goods are received at all, immediately.** Prosol drop-ships directly to the Amazon buyer, so no CFC warehouse ever touches the goods, but Salesforce still has to record the Prosol-to-Amazon-channel movement or the inventory and the payables never post. The receiving location is the virtual `Amazon Fulfillment` location. This was a standing directive from 2026-05-26: every shipped Amazon order is received.

Step 9. No header stamp after receiving. A Salesforce Flow stamps `Received_Location__c` and `Date_Received__c`; `CFC_Stage__c` and `mm_Received_Location_Name__c` are formulas computed from those; PBSI auto-flips the status to `Complete`, and `Complete` is the intended end state.

Step 10. Movement Journal canary. Once every resolved item has a receipt:

```sql
SELECT PBSI__Movement_Journal__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'
```

A null value raises the loud error "PO <name>: receipt action ran but no PBSI__Movement_Journal__c attached - investigate".

A fully processed live example, redacted, showing the end state PBSI produces:

```json
{
  "Name": "PO-16839",
  "PBSI__Account__c": "0014x00001P1ScCAAV",
  "PBSI__Order_Date__c": "2026-09-09",
  "PBSI__Status__c": "Complete",
  "PBSI__Tracking_Code__c": "520743084805",
  "PBSI__Sales_Order__c": "a10OJ00000GnJujYAF",
  "PBSI__Movement_Journal__c": "a0pOJ000001ZGPVYA4",
  "PBSI__Order_Total__c": 66.6,
  "PBSI__Final_Order_Total__c": 66.6,
  "PBSI__Sales_Tax__c": 0,
  "PBSI__Total_Tax__c": 0,
  "PBSI__Freight_Amount__c": 0,
  "PBSI__Tax_Code__c": "a1S4x000002oCP0EAM",
  "Date_Received__c": "2026-09-09",
  "Received_Location__c": "a0v4x000005kF5ZAAU",
  "mm_Received_Location_Name__c": "Amazon Fulfillment",
  "CFC_Stage__c": "Received",
  "PO_Number__c": "16839",
  "Count_Payables__c": 0,
  "Ascent2QB__QB_Needs_Update__c": true,
  "Ascent2QB__QB_Purchase_Order_ID__c": null,
  "Opportunity__c": "Amazon.ca -",
  "mm_Amazon_or_Shopify__c": true
}
```

Everything in that block other than `PBSI__Account__c`, `PBSI__Order_Date__c`, `PBSI__Tracking_Code__c` and the original `PBSI__Status__c = 'Open'` is populated by the platform, not by run-orders. Specifically:

- `PBSI__Tax_Code__c = a1S4x000002oCP0EAM` is the tax code named `GST` at 5 percent, whose own description in the org reads "used for tax on Labour ONLY". It is written by the active org Flow `PO_Default_Values`, an after-save Create trigger on the Purchase Order with no entry criteria, which assigns that literal id to every Purchase Order in the org. Whether a goods Purchase Order should carry a labour-only tax code is a question for CFC's accountant, not for Doug, but Automayt must know that the value is machine-stamped and uniform rather than meaningful.
- `PBSI__Sales_Order__c`, `Date_Received__c`, `Received_Location__c`, `mm_Received_Location_Name__c`, `CFC_Stage__c`, the totals and the QuickBooks flags are all trigger or Flow output.
- `Opportunity__c` and `mm_Amazon_or_Shopify__c` are formulas. See "Channel markers" in section 3.3 for what they actually mean and why neither is a channel field.
- `Auto_Send_Itemized_PO__c` (not shown in the trimmed block above, but `true` on this record) and `PBSI__Contact__c = 0034x00001u639QAAQ` are written by the org Flow `PO_Order_Desk_Contact`. See "The vendor-notification control surface" in section 3.3. This is the single most important thing on the record not to reproduce naively.

The matching receipt record, redacted:

```json
{
  "Name": "26329",
  "PBSI__Purchase_Order__c": "a0yOJ00000FdBuDYAV",
  "PBSI__Purchase_Order_Line__c": "a0xOJ00000CSoRBYA1",
  "PBSI__Item__c": "a0u4x000003r2C4AAI",
  "PBSI__Location__c": "a0v4x000005kF5ZAAU",
  "PBSI__Quantity_Received__c": 1,
  "PBSI__Receiving_Date__c": "2026-09-09",
  "PBSI__Price__c": 72.41,
  "PBSI__Price4__c": 0,
  "PBSI__Cost__c": 72.41,
  "PBSI__Landed_Price__c": 72.41,
  "PBSI__Total_Received_Price__c": 72.41,
  "PBSI__Type__c": "receive",
  "PBSI__PO_Name__c": "PO-16839",
  "PBSI__Qoh__c": 17,
  "PBSI__Quantity_Invoiced__c": 0,
  "PBSI__Quantity_Left_to_Invoice__c": 1,
  "PBSI__Lot__c": "a0lOJ00000CuDwYYAV",
  "Ascent2QB__QB_Needs_Update__c": true,
  "mm_Line_Desc__c": "Schluter - Kerdi Board - Shower Niche - 12\" x 20\" - with a quantity of 1 EA"
}
```

Local persistence: only `{poNumber, poId}` keyed by tracking number. **The Amazon branch does not forward the Sales Order number or id**, so every Amazon row in local state has null Sales Order fields, and the tracking-to-Sales-Order link exists only inside Salesforce.

### 4.4 Repairing a stuck multi-line receive

Entry point: `scripts/ops/fix-stuck-po-receive.js <PO-NAME> [--fix]`. Manual, one Purchase Order at a time. It carries an independent copy of the invocable-action wrapper, so there are two call sites to port, not one.

Finding the backlog: `PBSI__Status__c = 'Complete' AND CFC_Stage__c = 'Partially Received'`. SOQL cannot compare two quantity fields, so the formula stage field is the only tell. **Automayt should expose the honest predicate instead: sum of received less than sum of ordered.**

For anyone porting the proxy rather than replacing it, the `CFC_Stage__c` formula on the Purchase Order is, in full: `Invoiced` when `Date_Invoiced__c` is set; else `Received` when `Date_Received__c` is set and `PBSI__Total_Quant_to_receive__c` is 0; else `Partially Received` when `Date_Received__c` is set and it is not; else `Confirmed` when both `PBSI__Vendor_Sales_Order__c` and `ETA_Date__c` are set; else `Sent` when `PBSI__Date_Sent__c` is set; else `New`. Six values, and every input is a field the platform writes, not the caller.

Sequence: read the header by name; read the lines; read existing receipts ordered by name and inherit the location and receiving date from the first row (note "first" here means alphabetically first record name, not earliest date, so a Purchase Order part-received into two locations can put the remainder in the wrong one); compute the shortfall per line; abort if there is no prior receipt at all, refusing to invent a location; with `--fix`, set the header back to `Open` **once**, then invoke the receipt action per stuck line for the shortfall quantity; then re-read the header and lines to verify.

Two flaws worth not reproducing: the status reset happens once before the loop rather than before each receive, so a Purchase Order with three or more stuck lines can still fail on the second; and the no-prior-receipt abort fires in diagnose mode as well, so the read-only diagnostic refuses to diagnose exactly the case a human is asking about.

### 4.5 FBA replenishment Purchase Orders

Entry point: `createSalesforceFbaPO()` at `lib/fba-po-sender.js:348-453`, reached from `sendVendorGroup()` (call site `lib/fba-po-sender.js:480`) and, through it, from `sendAllBucketsForVendor()`.

**There is a third caller with different granularity, and it is exported.** `sendCombinedProsolPo()` at `lib/fba-po-sender.js:707-763` calls `createSalesforceFbaPO({ vendor, draft, lines: [line], bucket: line.availabilityBucket })` at `:725`, **inside a per-line loop**. So on that path it is one Salesforce Purchase Order per draft line, not one per vendor per bucket, and the resulting Purchase Orders are attached to a single combined vendor email with one PDF each. It exists for the split-shipment case (ship 20 now from in-stock, backorder 40), and its email body says so in plain words. It also stamps only `line.sfPoNumber` (`:740`); it does not write `sfPoId` or `sfPoLineId`, so the create-response contract in section 4.19 D is unmet on this path. Nothing in the repository calls it today, but it is exported at `:765`, which is the same "written, validated and dark" status this document grants `lib/prosol-direct-order.js` in section 4.19. **Automayt must therefore support both granularities on the same create endpoint**, and CFC must decide before cutover whether the per-line shape stays.

This is a **draft-first, human-gated** flow that lives almost entirely in local JSON. Salesforce is touched only on send.

Triggers that create Salesforce records:

- Dashboard "Quick PO" (`POST /api/fba/quick-po`), which builds a proposal, subtracts open pipeline, hydrates costs, applies budget guards, and then sends with email suppressed.
- Dashboard "Send" (`POST /api/fba/po-draft/send`) and "Approve All" (`POST /api/fba/po-draft/send-all-buckets`). Both accept an optional flag to suppress the vendor email.
- The one-click Telegram approval link `GET /api/fba/auto-restock/approve/:token`. **This is an unauthenticated bearer-token URL that creates a Purchase Order and emails the vendor**, and it bypasses the budget guards and the bucket split.

Sequence:

1. Vendor gate. `prosol` maps to Account `0014x00001P1ScCAAV`, `treeco` to `0014x00001P1SW2AAN`. `perfectlevel` is deliberately absent because Sechelt self-fulfilment is an internal transfer, not a vendor purchase, so it produces **no Salesforce record at all**: stock physically leaves Sechelt for Amazon and Salesforce never hears about it.
2. Resolve each draft line to an item by vendor SKU (`prosol_sku` or `treeco_sku` from the sku-map, keyed by ASIN) using the same lookup ladder as section 4.7. A line that cannot resolve is skipped with an error; if nothing resolves, no Purchase Order is created.
3. Create the Purchase Order. Four fields only:

```json
{
  "PBSI__Account__c": "0014x00001P1ScCAAV",
  "PBSI__Order_Date__c": "2026-09-09",
  "PBSI__Status__c": "Open",
  "PBSI__Shipping_Instructions__c": "FBA Restock <EMDASH> Amazon CA <EMDASH> READY <EMDASH> Draft auto-restock-2026-09-09-a1b2c3 <EMDASH> 7 lines"
}
```

No tracking code, no location, no ship-to, no Sales Order link, no channel field, no freight, no expected date, no currency, no terms.

4. Read the number back: `SELECT Name FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'`, falling back to the raw record id if the read returns nothing, in which case that raw id is printed on the vendor PDF.
5. Create one Purchase Order line per resolved line, four fields: purchase order, item, `PBSI__Quantity_Ordered__c`, `PBSI__Price__c` set from the item's own cost (or zero when the item cost is null).
6. Stamp `sfPoId`, `sfPoNumber` and `sfPoLineId` back onto the local draft line.

Buckets: `ready`, `backorder`, `sechelt`, sent in that order, **one Purchase Order per vendor per bucket**, 60 seconds apart. That granularity holds on the two live callers only. The dark third caller described above creates one Purchase Order per draft line instead. The split exists so in-stock goods ship immediately instead of waiting roughly a week behind cross-warehouse consolidation.

**There is no dedupe on the Purchase Order create.** Nothing is queried before the insert. The only protection is a local `sentAt` flag on each draft line, in a single-slot file that the Quick PO endpoint overwrites. So: a mail-server failure after a successful Purchase Order create leaves the line unmarked and a retry mints a second Purchase Order; a replayed draft mints duplicates silently; and the Telegram approval path writes its Salesforce references into a different draft file that no other code path reads.

**FBA Purchase Orders are never received and never closed.** There is no receipt step, no movement journal, no status advance, no close. They sit at `Open` indefinitely. The proposal script papers over this by treating any Purchase Order older than 120 days as abandoned paperwork rather than inbound supply, on the reasoning that counting it as supply silently suppresses restock lines that genuinely need ordering. **Whether FBA stock should hit the books at all is an open question for Mac (section 10).**

The only marker identifying an FBA Purchase Order in Salesforce is the free text at the start of the shipping instructions. A `Channel__c = "FBA"` field and a rolling monthly "FBA Master SO" were specified twice in CFC's own FBA automation spec and never built.

### 4.6 Lazy item creation and revenue-GL stamping

Entry point: `createPbsiItem()` at `lib/shopify-sf.js:416-490`. Shared by the Shopify and the Amazon paths. Since 2026-05-25 both paths auto-create, so a stale Salesforce catalogue never blocks a Purchase Order.

Sequence:

1. Strip slashes and hyphens from the vendor SKU and the manufacturer SKU to form the Salesforce identifiers.
2. Name collision pre-check: `SELECT Id FROM PBSI__PBSI_Item__c WHERE Name = '<name>' LIMIT 1`. On a hit the name becomes `MFG-<name>`.
3. Resolve the cost. Three tiers, all Prosol-derived: the cached cost in the local sku-map; a live Prosol storefront lookup (which spins a browser session and so is avoided on the common path); the analytics SQLite mirror of canonical costs. **If none produces a cost, the insert is refused** with "no Prosol cost for <sku> (sku-map cost_cad empty, live Prosol + mirror miss) - add cost via /map", so the order routes to manual review with a precise reason instead of Salesforce rejecting it with a required-field error.
4. Insert. A representative payload:

```json
{
  "Name": "KP10701",
  "PBSI__description__c": "Schluter Kerdi-Fix Bright White 290ml",
  "PBSI__Vendor_Item_ID__c": "KP10701",
  "PBSI__Default_Vendor__c": "0014x00001P1ScCAAV",
  "PBSI__Default_Location__c": "a0v4x000005kF5gAAE",
  "PBSI__Item_Group__c": "a0t4x00000NiZCoAAN",
  "PBSI__defaultunitofmeasure__c": "EA",
  "Unit_of_Measure__c": "EA",
  "PBSI__Item_Status__c": "Active",
  "PBSI__Item_Type__c": "Item",
  "PBSI__Cost_Type__c": "Standard Cost",
  "PBSI__Coverage_Code__c": "Min/Max",
  "PBSI__Lot_Tracking__c": true,
  "PBSI__No_Lot_Expiration__c": true,
  "PBSI__Taxable__c": true,
  "PBSI__Tax_Code__c": "a1S4x000002QmjbEAC",
  "Manufacturer__c": "Schluter",
  "Original_Style_Name__c": "Kerdi-Fix",
  "Color__c": "Bright White",
  "Size__c": "290ml KP10701",
  "PBSI__salesprice__c": 41.99,
  "mm_Original_Retail_Price__c": 41.99,
  "PBSI__Cost__c": 27.35,
  "PBSI__purchaseprice__c": 27.35,
  "mm_Landed_Cost__c": 27.35,
  "PBSI__UPC_Code__c": "4038072000000"
}
```

5. Stamp the revenue GL: poll `SELECT PBSI__Product__c FROM PBSI__PBSI_Item__c WHERE Id = '<itemId>' LIMIT 1` six times, with the sleep skipped on the first attempt, so five waits of 1.5 seconds (about 7.5 seconds of sleeping plus query time); read `SELECT Id, AcctSeed__Revenue_GL_Account__c FROM Product2 WHERE Id = '<productId>' LIMIT 1`; if it is not already `a6Q4x0000000sr4EAA`, update it. Non-fatal, and its failure is not surfaced.

Post-insert behaviour the caller cannot control: an org Flow overwrites `Name` with the autonumber, `Item_Master_Description_Updated` rewrites `PBSI__description__c` (and the four purchase-order and sales-order description twins) into the house format, the active before-save Flow `Mamoon_update_tax_code` overwrites `PBSI__Tax_Code__c` on both create and update, and the companion Product2 is created asynchronously. Note what the tax-code Flow means in practice: the `a1S4x000002QmjbEAC` the client sends in the payload below is the same value the Flow would have written anyway, so the write is redundant, not authoritative. **Automayt must state in the create response any value it normalises.**

Two known weaknesses: the returned object omits unit of measure and description, so a just-created item never area-converts on its first order; and the Shopify caller does not pass the resolved sku-map entry, so when the Shopify SKU is not itself a map key the derived manufacturer, style, colour and size come out empty and the item group defaults to Accessories.

### 4.7 Item and cost lookups

Three distinct lookup ladders exist and they do not agree with each other. Automayt should collapse them into one server-side normalised lookup.

**Ladder A, the Shopify path** (`findItemBySku`, `lib/shopify-sf.js:168-193`). Tier 1, by vendor code, four spellings in order (fully stripped, slash removed, hyphen removed, exact), each:

```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '<variant>' LIMIT 1
```

Tier 2, legacy fallback on the internal item number (CFC-owned products such as `458`, `9225`, `11524`):

```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE Name = '<sku>' LIMIT 1
```

Tier 3, a blind fuzzy match on description, first of up to five with no scoring:

```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, Unit_of_Measure__c,
       PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Description__c LIKE '%<first 80 chars of title>%' LIMIT 5
```

Between tiers, the sku-map is consulted and the mapped vendor codes are tried through the same ladder.

**Ladder B, the Amazon and FBA path** (`findPbsiItem`, `lib/amazon-po.js:288-346`). Vendor code only, never by name:

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '<variant>' LIMIT 1
```

Four spellings as above, then a leading-zero fuzzy retry (`C100978-01` becomes `C100978-1`), then a last-resort prefix match:

```sql
SELECT ... FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c LIKE '<baseCode>%' LIMIT 1
```

That last one drops a trailing hyphen-plus-digits suffix, has no ordering, and **can bind a different colour or size variant than the one ordered**.

Cost of this design: up to six sequential queries per line. On a 25-line Quick PO run each line is resolved twice, once for cost hydration and once inside the Purchase Order creation, with no memoisation between them, so roughly 300 sequential queries plus one unbounded org-wide query plus 27 writes.

**Ladder C, the mapping guard** (`scripts/shipstation/run-orders.js:22-41`), which runs in the `stage` phase before any money is spent:

```sql
SELECT PBSI__description__c FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '<code>' LIMIT 1
```

The returned description is compared against the channel listing title by local logic in `lib/mapping-guard.js` that canonicalises sizes (pint 473 ml, quart 946 ml, gallon 3785 ml, plus millilitres, litres, pounds, kilograms and ounces) and measures token overlap after stripping brand noise. Four numbers govern it and a reimplementation needs all four (`lib/mapping-guard.js:50-64`): sizes match within **6 percent relative**, or within an absolute slack of **30 ml** on a volume comparison (`:56`) or **0.1 lb** on a weight comparison (`:61`); token overlap must be at least **0.34**. A size mismatch, a volume-versus-weight comparison (which returns null, meaning incomparable), or token overlap below the floor produces a HALT: the order is rejected to manual review, no label is bought and no Purchase Order is created. This exists because an order once shipped a quart of "Grout Haze Remover" for a pint of "Grout Haze Clean-Up".

Four things about the guard that Automayt inherits:

- It is **fail-open on infrastructure and fail-closed on data**. Any Salesforce error returns null and staging proceeds unverified.
- Results are memoised in a module-level map that **never expires**, including negative results. After correcting an item in Salesforce the server must be restarted or it keeps halting on the cached value, and a command-line dry run will disagree with the server.
- It queries the **exact un-stripped** vendor code, while created items store the stripped form, so every hyphenated or slashed SKU silently skips verification.
- A stale legacy Salesforce description makes it halt a **correct** mapping. That happened on YourFloors order 1308 where the sku-map was right and Salesforce item 07290 described the vendor code as a different colour; the order sat three days. The fix in that case is the Salesforce item, not the map.

**Requirement.** One lookup by vendor code that normalises separators and case server-side, returns at minimum id, item number, vendor code, description, cost, sales price, unit of measure and default unit of measure, and exposes alternate codes (ASIN, manufacturer SKU, legacy stripped form) as first-class aliases rather than as client-side string mangling. Plus a batch form accepting at least 200 codes, and a description search that returns scored candidates rather than an arbitrary first of five.

### 4.8 Open purchase-order subtraction (do not re-order what is already coming)

Two implementations, keyed on **two different fields**, for the same business rule.

Implementation 1, the Quick PO endpoint (`server.js:1126-1130`):

```sql
SELECT PBSI__Item__r.Name, PBSI__Quantity_Ordered__c, PBSI__Quantity_Received__c, PBSI__Purchase_Order__r.Name
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__r.PBSI__Status__c = 'Open'
```

No vendor filter, no date filter, no LIMIT, no pagination: every open Purchase Order line in the org. Outstanding per line is ordered minus received, floored at zero. Rows are indexed by the item's **`Name`** and matched against the draft line's **vendor SKU**. Since `Name` is a numeric CFC item number and the vendor SKU is a Prosol or Treeco code, this match almost certainly finds nothing, and the subtraction is probably dead in production. Effect when it does match: a line whose outstanding quantity already covers the proposal is dropped entirely; a partial cover reduces the quantity and records which Purchase Orders it saw.

Implementation 2, the weekly replenishment proposal (`scripts/fba/build-replen-po.js:222-229`):

```sql
SELECT PBSI__Vendor_Item_ID__c, PBSI__Quantity_Left_To_Receive__c,
       PBSI__Purchase_Order__r.Name, PBSI__Purchase_Order__r.PBSI__Status__c,
       PBSI__Purchase_Order__r.CreatedDate
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__r.PBSI__Account__r.Name LIKE '%rosol%'
  AND PBSI__Purchase_Order__r.PBSI__Status__c IN ('Open','Partially Complete')
  AND PBSI__Quantity_Left_To_Receive__c > 0
```

This one keys on the vendor code on the line, uses the platform's computed remaining quantity, matches the vendor by a deliberately loose name pattern, and **ages out any Purchase Order older than 120 days** on the reasoning that a Purchase Order left open for months is abandoned paperwork rather than inbound stock. Note the two-hop filter through the parent to the vendor account name is not in the projection, so an Automayt query API that can only filter on returned fields cannot express it.

Both fail non-fatally and proceed **without** dedupe, which means over-ordering, silently.

**Requirement.** One endpoint: open purchase-order lines, filterable by vendor and status set, returning the vendor item code, quantity ordered, quantity received and a **server-computed remaining quantity**, with real pagination.

### 4.9 Nightly ETL reads

Trigger: 03:00 America/Toronto daily (`server.js:2401`), plus a manual trigger endpoint and a command line. Two of the ETL steps read Salesforce, both as streamed full-table pulls that bypass the query helper because it does not paginate.

Item costs (`scripts/etl/sync-item-costs.js:55-59`, streamed with a 100,000-row ceiling):

```sql
SELECT Id, Name, PBSI__Cost__c, PBSI__Description__c
FROM PBSI__PBSI_Item__c
WHERE PBSI__Cost__c > 0
```

Mapped into the local analytics database as `{sku: Name, cost_cad: PBSI__Cost__c, cost_source: 'sf-primary', source_detail: 'PBSI__Cost__c', pbsi_item_id: Id}`. **The join key is the item Name treated as CFC's internal SKU**, which is the collision hazard noted in section 3.5 and the reason rule 2 of the item-identity decision requires those strings to survive the migration verbatim. Local sku-map overrides win over Salesforce.

Canonical SKU map (`scripts/etl/sync-sku-map.js:72-79`, 50,000-row ceiling):

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__Cost__c, PBSI__Description__c
FROM PBSI__PBSI_Item__c
WHERE PBSI__Vendor_Item_ID__c != NULL
```

Deliberately unfiltered, because a WHERE IN clause cannot hold 20,000 values. Duplicates on the vendor code are resolved by preferring the row that has a cost. Results land in a local table carrying `sf_pbsi_item_id` and `sf_item_name` so every cost-aware analytics view can join through them.

Consequences for the migration: those two local tables carry Salesforce record ids and Salesforce item names as foreign keys, and the item-creation path falls back to that mirror as its third cost tier, so a stale mirror silently becomes the cost of record.

### 4.10 Stock gate: Salesforce to Shopify

Trigger: manual command line only, dry run by default. No cron, no npm script, no dashboard button references it.

Salesforce read, chunked 180 SKUs per query, matched on **`Name` only**:

```sql
SELECT Name, AscentBTO__Stock_Status__c, PBSI__Available_to_Promise__c,
       PBSI__Not_Available_For_Sale__c, Box_Quantity__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE Name IN ('sku1','sku2', ...)
```

Classification, in order: a vendor-confirmed discontinued mark in a local database wins; then `PBSI__Not_Available_For_Sale__c === true` means not for sale; then no Salesforce row means unknown and untouched; then `AscentBTO__Stock_Status__c === 'Stock'` **or** available-to-promise above a buffer means in stock; otherwise keep buyable.

Desired Shopify state: in stock means inventory policy DENY and quantity equal to boxes (floor of available-to-promise divided by box quantity when box quantity is above 1, otherwise floor of available-to-promise, never negative); discontinued or not-for-sale means DENY and quantity zero; keep-buyable means correct the quantity but leave the policy alone; unknown means do not touch.

The policy this encodes, from Mac: an in-stock warehouse item must not oversell; a special-order or out-of-stock item **stays buyable** because backorder is fine, it just must stop showing a fake count; **only a confirmed discontinued item is killed**.

Known blind spot: Shopify variant SKUs match Salesforce inconsistently, sometimes on `Name` and sometimes on `PBSI__Vendor_Item_ID__c`, and whitespace differs (Shopify `EC 626` against Salesforce vendor code `EC626`, Salesforce name `12174`). This script matches on `Name` with quote escaping and no other normalisation, so every vendor-code-keyed or space-bearing variant is classified unknown and left alone. Note also the strict identity test against `true` on the not-for-sale flag: if Automayt returns `1` or `"true"`, the one signal that de-lists product silently stops firing.

### 4.11 Vendor availability link refresh

Trigger: manual command line, behind a flag, in two scripts. The vendor-availability subsystem is otherwise entirely local SQLite: feeds are ingested, absence across two consecutive full feeds infers discontinuation, discontinuation is sticky.

One Salesforce read, chunked 180 codes:

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c FROM PBSI__PBSI_Item__c
WHERE PBSI__Vendor_Item_ID__c IN ('code1','code2', ...)
```

It maps a vendor code to CFC's item number and record id and stores that link locally. The link is never pruned, and because the intermediate map is keyed on the vendor code alone, a code carried by two vendors ends up attributed to whichever vendor was processed last.

### 4.12 Financial report purchase-order spend

Trigger: manual command line, or through the report emailer. No cron.

Read 1, resolve the human:

```sql
SELECT Id, Name, Email FROM User
WHERE (Name LIKE '%Mac%Roy%' OR Email = 'mac@customfc.ca' OR Email LIKE 'mac%customfc%')
  AND IsActive = true LIMIT 5
```

Read 2, 730 days of purchase-order line spend, streamed with a 100,000-row ceiling:

```sql
SELECT
  PBSI__Quantity_Ordered__c,
  PBSI__Item_Cost__c,
  PBSI__Total_Price__c,
  PBSI__Pre_Tax_Total_Price__c,
  PBSI__Purchase_Order__r.Name,
  PBSI__Purchase_Order__r.PBSI__Order_Date__c,
  PBSI__Purchase_Order__r.PBSI__Account__r.Name,
  PBSI__Purchase_Order__r.OwnerId,
  PBSI__Purchase_Order__r.Owner.Name
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__r.OwnerId = '<macUserId>'
  AND PBSI__Purchase_Order__r.PBSI__Order_Date__c >= LAST_N_DAYS:730
```

**Record ownership is the only thing separating the ecommerce purchasing stream from the rest of CFC's purchasing in the same system.** Other staff order from Prosol for non-ecommerce work; the report filters them out by owner. Line value priority is pre-tax total, then total, then quantity times item cost. The whole function returns null on any failure and the report renders with a note that Salesforce data was unavailable.

**Requirement.** Either a real owner or creator on the Purchase Order that can be filtered, or a first-class channel or source field, so this stops depending on matching a person's name.

### 4.13 Accounting exceptions and the "DO NOT PAY" note

Entry point: `scripts/ops/accounting-exceptions.js`. Manual command line, run before an accounts-payable payment run. Not scheduled. Report only unless `--post` is passed.

Design premise: roughly 139,000 dollars of Prosol payables are outstanding at any time, and an unpaid payable can simply be deducted, so **every rule keys off unpaid payables and goes quiet once paid**. Second design rule: an exception fires on **positive evidence only** (a tracking event, a payable row, a duplicate), never on absence of data, because twice in one session an absence inference produced a five-figure number that was not real.

Read 1, unpaid Prosol payables, paginated (the only paginated query in the repository):

```sql
SELECT Name, A2AS__Purchase_Order__c, AcctSeed__Total__c, AcctSeed__Sub_Total__c,
       AcctSeed__Paid_Amount__c, AcctSeed__Balance__c, AcctSeed__Date__c
FROM AcctSeed__Account_Payable__c
WHERE AcctSeed__Vendor__c = '0014x00001P1ScCAAV' AND AcctSeed__Date__c >= 2026-05-12
  AND A2AS__Purchase_Order__c != null AND AcctSeed__Balance__c > 0
```

Read 2, hydrate those Purchase Orders, chunked 150 ids:

```sql
SELECT Id, Name, PBSI__Order_Total__c, PBSI__Status__c, PBSI__Tracking_Code__c
FROM PBSI__PBSI_Purchase_Order__c WHERE Id IN ('id1','id2', ...)
```

Rule 1, never moved. Refunded orders joined by tracking number to a Purchase Order, then the carrier is asked whether the parcel ever physically moved. Only positive evidence that it did not counts. Output text prescribes the action: do not pay, request cancellation or credit.

Rule 2, duplicate purchase orders, a server-side aggregate:

```sql
SELECT PBSI__Tracking_Code__c, COUNT(Id) n FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c != null AND CreatedDate >= 2026-05-12T00:00:00Z
GROUP BY PBSI__Tracking_Code__c HAVING COUNT(Id) > 1
```

then per group:

```sql
SELECT Id, Name, PBSI__Order_Total__c FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c = '<code>' ORDER BY CreatedDate
```

The exception is anchored on the last-created Purchase Order in the group, which means the query must be able to order by a creation timestamp that is not in the projection. This rule is **not** gated on unpaid payables, so it can emit a note whose headline amount is zero dollars.

Rule 3, over-billing. Compare the sum of unpaid payable **pre-tax** subtotals against the Purchase Order total, and flag only when the excess is more than 2 percent plus 2 dollars. Comparing gross totals instead flags every Ontario and Quebec shipment as fraud.

Rule 4, return orphans. Local data only, reported but never posted.

The write, with `--post`, is a Chatter Connect API call, not an sObject insert:

```
POST /services/data/v59.0/chatter/feed-elements
```

```json
{
  "feedElementType": "FeedItem",
  "subjectId": "<purchase order record id>",
  "body": {
    "messageSegments": [
      { "type": "Text", "text": "DO NOT PAY (over-billed) <EMDASH> $412.90\n\n<detail>\n\nFlagged automatically. " },
      { "type": "Mention", "id": "0054x000005Ys0sAAC" },
      { "type": "Text", "text": " " },
      { "type": "Mention", "id": "0054x000005Ys0rAAC" },
      { "type": "Text", "text": " " }
    ]
  }
}
```

The note lands on the Purchase Order record's feed, which is where Lynnae Grohs and Melanie White see it before a cheque goes out. **Typing an at-sign and a name into the body renders as plain text and notifies nobody**; a real mention needs the user id in a structured segment. Dedupe is a local JSON file keyed `<rule>:<purchase order name>`, so re-running the report is safe, but a mid-run crash loses the whole batch's marks.

**Requirement.** A per-record note or flag stream with real notifications to named users, accepting a caller-supplied amount and a client idempotency key. If Automayt has no such feature, this workflow becomes email and the dedupe key moves with it.

### 4.14 Returns, claims and cancellations

`scripts/ops/return-actions.js`, manual. One Salesforce read, only when there is at least one claim, wrapped so the report still prints when Salesforce is down:

```sql
SELECT Name, PBSI__Tracking_Code__c, PBSI__Order_Total__c, PBSI__Status__c
FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Tracking_Code__c IN ('tn1','tn2', ...)
```

No chunking on that IN list, so a long claim list will exceed the query length limit.

The business problem it addresses: when a buyer cancels or is refunded and the branch never tendered the parcel, the goods never left Prosol's building, but **CFC's Purchase Order is already Complete and Received because CFC receives at label purchase**, so it reads as payable. The rule is "refunded and no carrier scan means claim, not pay. Tracking is the arbiter, not anyone's memory."

Related gap: the 15-minute buyer-cancellation poller cancels the ShipStation order but **nothing cancels or reverses the Salesforce Sales Order or Purchase Order**. That is exactly the condition rule 1 of the accounting exceptions has to clean up weeks later.

### 4.15 Dashboard and Telegram reads

`GET /api/amazon/current-so` (`server.js:641`) opens its own connection and runs:

```sql
SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x00001P1SiHAAV'
ORDER BY Name DESC
LIMIT 1
```

The dashboard renders it as "Current Amazon SO: <name> (<customer PO>) - Status: <status>". Ordering is by autonumber string, not by date.

The dashboard also renders, from the create responses: Sales Order and Purchase Order summary boxes with a per-step table showing the Sales Order id, line id, contact id, resolved item id, note and error; a Purchase Order number column on the results table; a per-line "no PBSI cost" warning whose tooltip literally says to populate `PBSI__Cost__c`; the pipeline-subtract panel listing which open Purchase Orders reduced a proposal; and the FBA send banner showing the Salesforce Purchase Order number or its error.

Telegram commands that reach Salesforce: `/launch` and `/stage` run the pipeline including the `pos` phase; `/po`, `/po create`, `/po create force` and `/replen` post to the Quick PO endpoint on localhost; `/health` runs the local-inference health check. Note also that `/claude` and any unrecognised text spawn a coding agent with the repository as its working directory and the Salesforce credentials in the environment; that is the widest write surface in the system and it will hold Automayt credentials after cutover.

### 4.16 Sales Order cancellation: a live operation with no code

This is the one Salesforce write that appears in no source file and that nobody had documented.

On 2026-09-09 at 16:57, three Sales Orders were cancelled within three seconds of each other, and the audit ledger recorded:

```json
{"timestamp":"2026-09-09T16:57:08.829Z","action":"sf-so-cancelled","orderNumber":"1359","so":"SO-025636","soId":"a10OJ00000Goa2HYAR","reason":"sechelt-cannot-fulfil"}
{"timestamp":"2026-09-09T16:57:10.326Z","action":"sf-so-cancelled","orderNumber":"1362","so":"SO-025655","soId":"a10OJ00000GrBTxYAN","reason":"sechelt-cannot-fulfil"}
{"timestamp":"2026-09-09T16:57:11.573Z","action":"sf-so-cancelled","orderNumber":"1365","so":"SO-025672","soId":"a10OJ00000Gx5s5YAB","reason":"sechelt-cannot-fulfil"}
```

No source file emits that action. Nothing in the repository ever writes the string `Cancelled` to Salesforce, and nothing ever calls update on a Sales Order. The write was done ad hoc from a throwaway script that then called the audit logger.

Reconstructed operation: update `PBSI__PBSI_Sales_Order__c` by record id, setting `PBSI__Status__c = 'Cancelled'`. The record id is obtained by looking up the customer purchase order field, the same key the create path dedupes on. The established convention is **cancel, never delete**.

It is one step in a fixed human-approved sequence: void the carrier label, cancel and fully refund the Shopify order with customer notification suppressed, cancel the Sales Order in Salesforce, cancel the ShipStation order, then write and commit a vendor-error ledger entry. Rules visible in that batch:

- The Sales Order cancel must **not** be conditional on the storefront cancel succeeding. Shopify refused to cancel order 1365 because a return request existed, so the refund went by transaction instead, and the Sales Order was still cancelled.
- **The Sales Order may not exist.** Order 1368 in the same batch recorded "no SF SO existed". Cancellation must be a safe no-op in that case and must report it distinctly from a failure.
- Nothing checks the current status first, and nothing prevents cancelling a Sales Order that has already been invoiced.

**Requirement.** Sales Order status mutation, addressed by record id, with the document number readable for logging, safe to call twice, usable ad hoc from a script, and with an audit event. Read as a set, the rest of this document implies Automayt never needs to mutate a Sales Order. That is false, and it is false in current, this-week practice.

### 4.17 Deleting a phantom Purchase Order

One live example exists, approved in advance by Mac and recorded as a comment in a single-purpose script.

Two rules, both learned the hard way:

- **You cannot delete a Purchase Order line while its linked Sales Order line exists.** The error text is "You must delete the sales order line first", because the line references the Sales Order line through the drop-ship link. Note for the record that this is **not** the managed package speaking, as CFC's own older notes claim: it is the active CFC Flow `Mamoon_prevent_deleting_the_POL`, a before-delete trigger on the Purchase Order Line that looks up an `AcctSeed__Account_Payable_Line__c` by `A2AS__Purchase_Order_Line__c` and raises a custom error.
- **Delete the Purchase Order header instead.** That succeeds and cascade-deletes its lines without touching the Sales Order or its lines. This is how a phantom Purchase Order is killed while keeping the real sale intact.

**Deletion is already gated by a field, and that gate belongs in the requirement.** The active Flow `Mamoon_prevent_deleting_the_PO` is a before-delete trigger on the Purchase Order whose entry criterion is `mm_Allow_Delete__c = false`. When it runs, it permits the delete only when both of the following hold, and otherwise raises the custom error "You can't use this functionality to delete a Purchase Order. Please do so directly from the record page":

- `PBSI__Status__c` is `Open` or `Cancelled`, and
- no `AcctSeed__Account_Payable__c` exists whose `A2AS__Purchase_Order__c` points at this Purchase Order.

Setting `mm_Allow_Delete__c = true` bypasses the whole check, because it is the entry criterion. Two related booleans sit on the record and read `false` on all four sampled pipeline Purchase Orders: `mm_Allow_Delete__c` (writable, the bypass) and `Can_be_deleted__c` (writable, an advisory flag nothing in run-orders reads). **Automayt's delete semantics should encode the same rule as a server-side precondition rather than a bypassable boolean: a purchase order with a payable against it, or past the open state, is not deletable.**

The alternative, and the preferred one, is to cancel by status rather than delete.

**Requirement.** Delete on a purchase order with documented cascade behaviour, a distinct cancel or void status transition, and an audit trail. Also worth asking: should Automayt require an explicit approval or reason field on a destructive administrative operation, so approval lives in the system rather than in a disposable script comment.

### 4.18 Ad-hoc forensics: the long tail

47 throwaway scripts in `scripts/ops/` named `_tmp-*` talk to Salesforce. None is scheduled, none exports anything, nothing references them. They are typed by an operator during an incident. Their mtimes cluster into four forensic sessions: an order-1321 freight-purchase-order investigation in late July 2026, the duplicate-purchase-order incident on 2026-08-10, the "have we actually paid for the duplicates" payables dig on 2026-08-11 (which graduated into the production accounting-exceptions tool), and a purchase-order-versus-vendor-PDF reconciliation on 2026-08-17.

**This is a real workload, not noise.** Roughly 40 of the 47 are a single bespoke query each. If Automayt exposes a fixed set of endpoints rather than a general filtered read, this class of work becomes 40 feature requests. Appendix B enumerates every query on a scheduled or operator-facing path plus a representative sample of this long tail; it does not enumerate all of it, and roughly 23 further one-off forensic scripts are cited nowhere in this document.

The capability categories they exercise, all of which Automayt needs:

- Purchase order header by number, by id, and by a list of numbers; by linked sales order; by vendor account; by created-date window and by "today"; by tracking code list; by freight amount greater than zero.
- Purchase order lines by parent, with a stable field vocabulary. The naming drift here is the single largest source of failed queries in the set.
- "Give me every populated field on this record", used when the operator does not yet know the field name.
- Sales order by customer purchase order reference, substring and exact; sales order lines; purchase orders linked to a sales order.
- Item by internal number **or** vendor code in one call; recent purchase order lines for a SKU, filtered and sorted through the parent order's date.
- Payables by vendor and year; payables for a list of purchase order ids; payable lines; aggregate payables by purchase order with a having-count filter (the double-billing detector); aggregate payables by vendor by year.
- Schema introspection: per-object field list with type, writability, formula flag and formula text, picklist values with active flags, plus an object-list endpoint. In an org nobody documented, describe **is** the documentation.
- Status vocabulary discovery from the data, not from the schema: `SELECT PBSI__Status__c, COUNT(Id) FROM ... GROUP BY PBSI__Status__c`. A picklist can declare values nothing uses and omit values everything uses (section 3.10).
- Chatter feed read and object-level feed-enabled flag.
- Files: list and download attachments and content versions on any record, and search sent emails by subject and download their attachments.
- Active user roster, and created-by on a purchase order.

One capability was fought over for six scripts and four techniques and never obtained: **retrieving the Salesforce-rendered Purchase Order PDF over the API.** The Visualforce print pages (`PBSI__PrintPO`, `PBSI__PrintViewPO`, `PBSI__viewPO`) all return "This page requires a CSRF confirmation token" for any API or headless session, even after a front-door session handoff. The workaround that shipped is a local renderer that rebuilds the document from scratch. **`GET /purchase-orders/{id}/pdf` returning a PDF is the clearest single win available in this migration**, and it would delete six scripts and a headless-browser dependency.

### 4.19 The purchase-order number is a foreign-system identifier, not a print artefact

This is the most easily missed requirement in the whole document. The Salesforce Purchase Order `Name` leaves CFC's systems in four directions.

**A. It is a required input to Prosol's own ordering API.** `lib/prosol-direct-order.js` places wholesale orders directly on Prosol's storefront instead of emailing a purchase order for their order desk to key into their ERP. CFC's Prosol account is configured server-side as purchase-order-required, so:

```js
if (!poNumber) throw new Error('poNumber required (account is po_required)');
```

is validated before any network call, and the number is written onto Prosol's cart as `reference_number` through a full-object PATCH (setting it at cart-create time does not stick). It is echoed back on revalidation. So **our purchase-order number becomes the reference on Prosol's paperwork, inside Prosol's system, outside CFC's control and unfixable after the fact.** The module is currently dark (nothing calls it) but the path has been validated end to end and one real order was placed through it by hand.

Consequence: **Automayt must mint the human-readable number before the vendor order is placed**, which means returning it in the create response, not through a follow-up read that might fail.

**B. It is printed in a vendor-facing chase email.** The stale-parcel reminder (09:30 weekdays, currently shadow) walks **every** local state file ever written, builds a tracking-number to purchase-order-number map, and prints it as the **first column, titled "Our PO"**, of a table emailed to Prosol's order desk and to the specific branch. The code comment states the reason: "Prosol branches match on their own paperwork, not our tracking number, so a reminder quoting only a PIN is not actionable on their floor. The PO number we sent them on the original order is the reference they hold." The scan is unbounded in history, so for weeks after cutover the same email to the same branch will carry legacy numbers and new Automayt numbers in one table. Neither may be dropped, and both must be things the branch can look up.

**C. It is the routing key for inbound vendor email.** The FBA flow puts the purchase-order number in the email subject; the vendor replies to that subject; and the reply is matched back to the right draft lines by a hard-coded regex on the Salesforce autonumber format:

```js
function matchPoFromSubject(subject) {
  if (!subject) return null;
  const m = subject.match(/\bPO-(\d{3,6})\b/);
  return m ? `PO-${m[1]}` : null;
}
```

The match is exact string equality against the stored number. **So the number must be exactly `PO-` plus 3 to 6 digits, word-boundary delimited.** Any other shape and the match returns null, the reply falls through to a from-address heuristic, and it is applied to the **wrong** purchase order rather than failing loudly. Note that this also breaks on its own when the autonumber reaches seven digits.

Four hand-run verification harnesses are the only mechanical assertion of that contract, and none of them runs under `npm test`. They also define the object shape the create response must satisfy, per draft line: `sfPoNumber`, `sfPoId`, `sfPoLineId`.

**D. It is a permanent identifier inside Amazon.** The purchase-order number is baked into FBA inbound plan keys and Amazon shipment names. The only inbound plan in the tree, `data/fba/inbound-plans/po15056-prosol-inbound.json`, carries `planKey: "po15056-prosol-inbound"` and `name: "PROSOL PO15056 Sealers Gold 112u"`, and `scripts/fba/fba-inbound-spd.js:34` carries the same string. Note that the hyphen is stripped on both the plan key and the Amazon-facing name, so the requirement here is narrower than the one in A and C: **the numeric portion must remain stable and resolvable**, because Amazon holds those shipment names permanently and they are not rewritable. The hard `PO-` plus digits format contract holds where the literal string is matched, which is the inbound vendor-email regex at `lib/vendor-reply-parser.js:167` and Prosol's `reference_number`.

Plus: it indexes open money claims against Prosol in the local vendor-error ledger; it is printed on the warehouse packing-slip PDF and in the packing-slip filename; it is printed in the order email body; it appears in the daily Telegram digest and on the dashboard.

### 4.20 Health monitoring

Covered in section 2.7. The requirement is a real authenticated health endpoint plus a cheap identity ping, so the 06:30 check can stop inferring Salesforce liveness from local files.

---

## 5. Hard-coded identifiers and constants Automayt must reproduce or map

Every one of these is a literal in the source or in a document. CFC needs a mapping table from the Salesforce id to the Automayt identifier **before** cutover, because these appear across six or more files.

### 5.1 Account records

- Shopify house customer account: `0014x000023jkuDAAQ`, Account name `Shopify`. Every Shopify sale books to it. It is also the scope filter on both dedupe reads and on the reconcile sweep.
- Amazon house customer account: `0014x00001P1SiHAAV`, Account name effectively "Amazon.ca". Every Amazon sale books to it.
- Prosol vendor account: `0014x00001P1ScCAAV`, Account name "Prosol Inc.", `Type = Vendor`. The vendor on every pipeline Purchase Order and the default vendor on every auto-created item. Appears in at least seven files. Two constants ride on this record and both must survive the migration:
  - `mm_Account_Number__c = 55010180`, which is **CFC's customer number inside Prosol's own system**. It is mirrored onto every Purchase Order through the calculated field `mm_Account_Number__c` (formula `PBSI__Account__r.mm_Account_Number__c`), and it is the same `external_id` the direct-order path in section 4.19 uses against Prosol's storefront API. It is the natural join between CFC's ERP and the vendor's.
  - Contact `0034x00001u639QAAQ`, `LastName = "Order Desk"`, email `order.burnaby@prosol.ca`. An org Flow stamps it onto every Prosol Purchase Order (section 3.3, vendor-notification control surface). It is not the address run-orders emails.
  - The Treeco equivalent is `mm_Account_Number__c = 70056`.
- Treeco vendor account: `0014x00001P1SW2AAN`. FBA replenishment for Bona products.
- Freight Simple vendor account: `001OJ000007VtFWYA0`. Freight Purchase Orders only.
- Account record types: Business `0124x0000002LVxAAM` (the default), Person `0124x0000002LWvAAM`.

### 5.2 Locations

- Amazon Fulfillment, virtual: `a0v4x000005kF5ZAAU`.
- Sechelt Warehouse: `a0v4x000005kF5gAAE`.
- The full list of 14 with ids is in section 3.6.

### 5.3 Tax codes

Read from the live org on 2026-09-09. `PBSI__Tax_Code__c` holds 8 records; the fields that matter are `Name`, `PBSI__Tax_Rate__c` and `PBSI__Total_Tax_Rate__c`, plus `Tax_Rate_1__c` and `Tax_Rate_2__c` where a combined rate is split into its federal and provincial halves.

The three that appear in the pipeline surface:

- `a1S4x000002pMUhEAM` - `Exempt`, rate **0**. Split 0 and 0. Description "exempt for use on WO invoicing". This is the id the Amazon Sales Order create writes, and it is also what an org automation writes back onto pipeline Shopify Sales Orders.
- `a1S4x000002QmjbEAC` - `GST/PST - BC`, rate **12**. Split 5 and 7. Description "DO NOT CHANGE THE NAME OF THIS TAX CODE". This is the id written on every auto-created item, and also what the before-save Flow `Mamoon_update_tax_code` writes on one of its two branches.
- `a1S4x000002oCP0EAM` - `GST`, rate **5**. Split 5 and 0. Description "used for tax on Labour ONLY". This is what the org Flow `PO_Default_Values` stamps on **every** Purchase Order in the org, including all four sampled pipeline Purchase Orders (PO-16839 Amazon, PO-16785, PO-16701 and PO-16683 Shopify). It is not a one-off. Whether a goods Purchase Order should carry a labour-only code is a CFC accounting question; for the migration the fact is that the value is uniform and machine-stamped.

The other five, for completeness, because a migration has to carry all of them:

- `a1S4x000002p6oHEAQ` - `HST - ON`, rate 13, split 5 and 8.
- `a1S4x000004IgXAEA0` - `GST/HST`, rate 13.
- `a1S4x000003bjx6EAA` - `HST - Maritimes`, rate 15.
- `a1SOJ000003fVR72AM` - `GST/PST - SK`, rate 11.
- `a1SOJ000001Ymcj2AC` - `GST/QST - QC`, rate 14.75.

Note that the last two carry `PBSI__Total_Tax_Rate__c = 0` while `PBSI__Tax_Rate__c` holds the real rate, so a migration that reads the total field alone would move Saskatchewan and Quebec across at zero tax.

### 5.4 GL accounts

- `a6Q4x0000000sr4EAA` - `4000-Sales`. The live product-revenue account, roughly 73,700 postings. Stamped on the Product2 of every auto-created item.
- `a6Q4x0000000sU2EAI` - `4000-Product Revenue`. **Deactivated. Never use. Do not carry it forward.** It is the account a three-year revenue leak drained into.
- Other revenue accounts in the org: `4010-Services Revenue`, `4015-Unapplied Revenue`.
- AcctSeed Accounting Settings singleton: `a5l4x00000031YiAAI`. The four GL Account Default records that actually drive the fallback are GLAD-00005, GLAD-00014, GLAD-00021, GLAD-00030.

### 5.5 Item groups

- Accessories, the default for auto-created physical product: `a0t4x00000NiZCoAAN`.
- Adhesive: `a0t4x00000NiZChAAN`.
- Grout: `a0t4x00000NiZCVAA3`.
- **Generic: `a0t4x00000NiZCkAAN`. NEVER use.** It is purpose-built for labour and generic-billing items; putting physical product there polluted a picklist in the Sales Order user interface and produced wrong accounting behaviour.

The routing from a local category string to a group id is: `grout / sealant` maps to Grout; `flooring adhesive` and `adhesive` map to Adhesive; everything else maps to Accessories.

### 5.6 Users

- Integration user: `0054x000005Ys0yAAC`, "Mac Roy", `mac@customfc.ca`.
- Lynnae Grohs, accounting: `0054x000005Ys0sAAC`, mailbox `accounting@customfc.ca`.
- Melanie White, accounting: `0054x000005Ys0rAAC`, mailbox `melanie@customfc.ca`.
- Other human creators of the same records, all fourteen of whom Automayt must serve: Raelene Wood, Kevin McDonald, Nathan Collins, Josh Gray, Mia Saunders, Janice Kuester, Doug Saunders, Bill Yardley, Mark Dixon, Lynnae Grohs, Melanie White, and three shared location seats named for the location rather than the person: `Sechelt Warehouse`, `Powell River Warehouse` and `Tamara Powell River Showroom`. The last of those is **one seat**, not two people: the org's naming convention for a shared location seat is a blank first name and the location as the last name, and this one carries an operator's first name in front of it.

### 5.7 Literal strings

- Sales Order status on create: `Open`.
- Purchase Order status on create: `Open`. Reopen value before a subsequent receive: `Open`. Cancel value: `Cancelled`.
- Receipt type: `receive`. Other declared values `credit` and `reverse poline`, both unused.
- Amazon Sales Order tax-exemption reason, both GST and PST: `Third Party Amazon`.
- Amazon Sales Order bill-of-lading description: `None`.
- Auto-created item defaults: item status `Active`, item type `Item`, cost type `Standard Cost`, coverage code `Min/Max`, unit of measure `EA` in both unit-of-measure fields.
- Manufacturer normalisation targets, seven values from nine input keys: `Schluter`, `Aqua Mix`, `Bona`, `Perfect Level Master`, `Mapei`, `Custom Building Products`, `Treeco`. Anything else is title-cased and written verbatim.
- Item stock status test value: `Stock`.
- Vendor name match patterns used in queries: `%rosol%` (deliberately case and prefix tolerant), `%reight%imple%`.
- Item group name filter used in a substitution search: `Vinyl Tile`.
- Sentinel values in CFC's local sku-map that mean "do not put this on a vendor purchase order": `NON_PROSOL` (28 entries), `SKIP` (checked in code, zero entries today), `UNMAPPED`, `UNMAPPED_CABLE`, `UNMAPPED_GROUT` (10 entries between them, blocked from auto-create but **not** blocked from the Prosol Purchase Order).
- Free-text channel marker on an FBA Purchase Order. It is the only usable way to identify one in Salesforce: the two platform-computed fields that look like channel markers (`Opportunity__c` and `mm_Amazon_or_Shopify__c`, section 3.3) both derive from the Purchase Order's Sales Order, and an FBA Purchase Order has none, so both come back empty. There is no external-reference field on the object at all. The shipping instructions begin `FBA Restock <EMDASH> Amazon CA`, then optionally ` <EMDASH> READY` or ` <EMDASH> BACKORDER` or ` <EMDASH> SECHELT`, then ` <EMDASH> Draft <draftId> <EMDASH> N lines`, truncated to 255 characters. Note the draft id has two shapes, `draft-YYYY-MM-DD-<base36>` from the dashboard and `auto-restock-YYYY-MM-DD-<hex>` from the proposal builder and from Quick PO, so any migration query keying on it must accept both.

### 5.8 Numbering conventions

- Sales Order: `Name` is `SO-` plus six digits, currently around `SO-025763`. Trigger-assigned.
- Purchase Order: `Name` is `PO-` plus five digits, currently around `PO-16839`. Trigger-assigned. **This format is a hard contract, see section 4.19.** `PO_Number__c` is a formula holding the bare digits and is not consumed.
- Sales Order Line, Purchase Order Line, receipt line, movement journal and movement line all carry plain numeric autonumbers.
- Item `Name` is assigned post-insert from an autonumber, currently around `14146`. A second autonumber (`Item_Auto_Number__c` versus `Auto_Item_Number__c`) exists with a different counter.
- Payable: `AP-` plus five digits, for example `AP-30476`.

### 5.9 Unit of measure and quantity rules

All of this lives in `lib/pbsi-uom.js`, exporting `AREA_UOMS`, `isAreaUom`, `parseCoverageFromDescription` and `resolveLineQty`.

- The unit is read as `Unit_of_Measure__c` first, `PBSI__defaultunitofmeasure__c` second (`lib/pbsi-uom.js:51`, applied at `lib/shopify-sf.js:679` and `lib/amazon-po.js:707`).
- Area units, the complete set, compared lowercased and trimmed (`lib/pbsi-uom.js:25-27`): `sqft`, `sq ft`, `sq. ft`, `sq.ft`, `sf`, `square feet`, `square foot`. **Seven spellings of one unit, and no other unit is handled.**
- Coverage comes from the sku-map key **`coverage_sqft`** if present, otherwise from `parseCoverageFromDescription` (`lib/pbsi-uom.js:42`), which takes the **last** match of a number followed by a square-foot unit in the item description. A bare "SF" is deliberately not matched.
- **Zero sku-map entries carry `coverage_sqft` today.** Every area conversion in production is a regex over free text.
- Quantity written on an area line is rolls multiplied by coverage, unrounded, so fractional quantities such as 403.5 are normal. The price is not converted and stays per roll.
- If coverage cannot be resolved on an area item, the line is refused rather than defaulted.
- **`SqYd` (1,842 items) and `LnFt` (299 items) are never converted.** They are not in `AREA_UOMS`, so they take the pass-through branch and are written as the raw ordered count. That is the same 134-times-too-small error class the square-foot path exists to prevent, still live on 2,141 items, and unexercised only because those items do not sell through the two ecommerce channels today. Do not reproduce the gap: the conversion factor in Automayt must be per unit of measure.
- Auto-created items are always `EA` in both unit fields, so an area-stocked roll created automatically will not convert on its first order.
- Boxes for the storefront are the floor of available-to-promise divided by box quantity, when box quantity is greater than 1.
- A local per-item quantity multiplier exists in the analytics layer for cases where the Salesforce cost is per plank or per square foot while the storefront sells by the box. Four SKUs are known to be affected: `04059`, `11888`, `01602`, `00941`.

### 5.10 Freight

Freight is **never** a field on the goods Purchase Order. It is its own Purchase Order to the carrier's own vendor account, using the carrier's own item, quantity 1, line price equal to the all-in invoice amount, and `PBSI__Sales_Tax__c` set to 0.

- Freight Simple vendor `001OJ000007VtFWYA0`, item `05313` described as "freightsimple - pallet - 0 - regular -".
- Roughly 22 sibling carrier freight items exist: UPS `05374`, Canada Post `06422`, Olympia Fast Freight `08567`, and others.
- **`PBSI__Freight_Amount__c` must never be populated.** Zero of 14,382 Purchase Orders have ever used it. It is writable, but it feeds the final-order-total formula, so stamping it inflates the goods Purchase Order above what the goods vendor actually invoices and breaks the three-way match. It is also conceptually wrong: when CFC books the carrier on its own account, the goods vendor is not billing the carriage.

---

## 6. Required API contract for Automayt

**This section is the normative list.** Where it and section 9 differ, this section governs; section 9 is the rationale, the incident history and the "do not reproduce" list behind it. Anything in section 9 that is a requirement rather than a rationale is restated here, including the three that used to appear only there: freight as its own Purchase Order (6.3), positive-evidence-only exception rules and pre-tax over-billing comparison (6.7).

Grouped by object. Each item states inputs, outputs, dedupe semantics, and which run-orders call site it replaces. "Day one" means the 07:00 cron on the first Monday after cutover fails without it. "Can lag" means an operator tool degrades but orders still flow. Section 6.10 is the status contract that every write in this section has to satisfy. Section 6.11 is a draft of the wire itself: paths, verbs, request and response bodies, the error envelope, the pagination shape, the filter grammar and the field-name mapping. Treat 6.11 as CFC's proposal to be argued with, not as a specification of Automayt.

### 6.1 Cross-cutting, all day one

1. **Authenticate a headless service identity.** Inputs: client id and secret, or an API key. Outputs: access token, expiry, base URL, identity. No security-token concatenation, no browser step, no MFA.
2. **Every create returns the record id and the human-readable document number in one response.** Replaces four follow-up reads and is mandatory for the Prosol direct-order path.
3. **Machine-readable errors** with a stable code, a field where applicable, and a **non-empty** message, plus an explicit retryable or terminal classification.
4. **Pagination on every list**, either complete results or an explicit cursor. No silent truncation.
5. **Idempotency**, either a key header or natural-key uniqueness on customer purchase order reference and on tracking code.
6. **A client or agent identifier** accepted on every call and queryable afterwards.
7. **An authenticated health endpoint** plus a cheap identity ping.

### 6.2 Sales Order

Day one:

- **Create sales order.** Inputs: customer account id, optional contact id, status, order date (must accept a back-dated value), customer purchase order reference, tax treatment (exempt flags plus a reason string per tax type, or an explicit enum), optional bill-of-lading description. Outputs: id and document number. Dedupe: idempotent on customer account plus customer purchase order reference; a duplicate submission should return the existing record rather than erroring opaquely. Replaces `lib/shopify-sf.js:717-732` and `lib/amazon-po.js:264-275`.
- **Create sales order line.** Inputs: sales order id, item id, quantity, quantity needed, unit price. Output: line id, **returned synchronously** because it is a required input to the purchase order line. Replaces `lib/shopify-sf.js:750-756` and `lib/amazon-po.js:757-763`.
- **Find sales orders by customer plus customer purchase order reference**, supporting both exact and contains matching, returning id, number, order date, the reference itself, and the creating user's name (it is displayed to the operator). Replaces `lib/shopify-sf.js:519-525`.
- **List sales orders for a customer created in the last N days**, returning at least the customer purchase order reference. Replaces `lib/shopify-so-reconcile.js:75-77`.
- **Get the most recent sales order for a customer**, returning id, number, reference, order date, status. Replaces `lib/amazon-po.js:167-176` at limit 1 and at limit 10.
- **Update sales order status**, specifically to a `Cancelled` equivalent, addressed by record id, safe to call twice, reporting "no such record" distinctly from failure. Replaces the undocumented ad-hoc operation in section 4.16.

Can lag:

- Get a sales order by document number with a full header (today this is a "give me every field" query plus a client-side filter, so nobody actually knows the field list).
- Get sales order lines by sales order.
- List purchase orders linked to a sales order.
- Delete a sales order line (used once, in a phantom-record cleanup).

Strongly wanted, not present today: a **real period start and end pair** on the Amazon rolling sales order, so a 14-day window is a queryable range instead of a parsed English string.

### 6.3 Purchase Order

Day one:

- **Create purchase order.** Inputs: vendor account id, order date, status, free-text instructions of at least 255 characters (ideally more), optional tracking code, and ideally first-class `channel` (`Amazon`, `Shopify`, `FBA`) and `external_ref` fields so the free-text marker can be retired. Outputs: id and document number. Dedupe: unique on tracking code when present, and tolerant of null so the FBA flow's untracked orders do not collapse into one; ideally an idempotency key so a retry after a mail failure returns the existing record. Replaces `lib/shopify-sf.js:800-807`, `lib/amazon-po.js:789-795`, and `lib/fba-po-sender.js:405-410` on both of its granularities (per vendor per bucket at `:480`, per draft line at `:725`).
- **Create purchase order line.** Inputs: purchase order id, item id, quantity ordered (decimal), unit price, optional sales order id, optional originating sales-order-line id. Output: line id **and the price as actually stored**. The demand link must be supported and optional. Replaces `lib/shopify-sf.js:829-836`, `lib/amazon-po.js:810-817`, `lib/fba-po-sender.js:420-425`.
- **Query purchase orders by tracking code, IN a list of at least 50.** Output: the tracking codes that already have one. **This is the primary duplicate guard and the client treats any error as fatal, so it must be cheap, exact and reliable.** Replaces `lib/amazon-po.js:515-533` and `lib/shopify-sf.js:512`.
- **Update purchase order status**, including a `Complete` to `Open` reopen if Automayt reproduces auto-complete-on-first-receipt. Ideally it does not, and this disappears.
- **Read purchase order by id**, at minimum the document number. Redundant if create returns it.

Can lag:

- Get purchase order by document number, and by a list of document numbers, returning "not found" per number rather than erroring the batch.
- Get purchase order lines by purchase order, with one canonical name per concept, including a server-computed remaining-to-receive quantity.
- List purchase orders by vendor with a status filter and a created-date sort.
- Find purchase orders sharing a tracking code (the duplicate detector), as a server-side aggregate or a groupable list.
- Find purchase orders where received is less than ordered (the receipt-repair backlog), expressed honestly rather than through a stage-formula proxy. Today the only available predicate is `PBSI__Status__c = 'Complete' AND CFC_Stage__c = 'Partially Received'`, because SOQL cannot compare two quantity fields; the `CFC_Stage__c` formula and its six values are in section 4.4.
- **Freight must be a purchase order in its own right, never a field on the goods purchase order.** CFC books the carrier on its own account, so the goods vendor is not billing the carriage. The shape is: vendor account is the carrier's own account, one line, the carrier's own item, quantity 1, line price equal to the all-in invoice amount, tax 0. Section 5.10 has the ids and the reason a freight amount field on the goods order breaks the three-way match.
- Cancel or void a purchase order as a status transition, distinct from delete.
- Delete a purchase order header with documented cascade to its lines.
- Render the purchase order as a PDF over the API. This deletes six scripts and a headless-browser dependency.

### 6.4 Receiving

Day one, because the Amazon flow cannot ship without it:

- **Receive a purchase order line.** Inputs: purchase order id, purchase order line id, item id, location id, quantity received (decimal), receiving date, unit price, type (`receive`, `credit`, `reverse`). Outputs: receipt id, a human message, **and the id of the inventory transaction it created**. Must be atomic: receipt plus inventory posting plus downstream accounting in one call, or nothing. Must be safe to retry, either rejecting a duplicate or being idempotent. **Must not require reopening the header between lines of the same purchase order.** Replaces the invocable action at `lib/amazon-po.js:850-869` and its duplicate at `scripts/ops/fix-stuck-po-receive.js:75-83`.
- **Receive multiple lines of one purchase order in one call.** This removes the reopen dance entirely.

Can lag:

- List receipts for a purchase order, filterable by location, returning quantity, location and date, so a repair tool can find where the first receipt landed.
- Read the inventory-transaction id on a purchase order (the canary).

### 6.5 Item

Day one:

- **Find item by vendor code**, matching separator-insensitively and case-insensitively, returning id, item number, vendor code, description, cost, sales price, unit of measure, default unit of measure and default vendor name. Ideally accept a list of spellings, or better, own the normalisation and expose alternate codes as aliases. Replaces `scripts/shipstation/run-orders.js:31`, `lib/shopify-sf.js:184`, `lib/amazon-po.js:306-312`. `vendor_code` is the item's primary key, per the identity decision in section 3.5.
- **Find item by internal item number**, which is **not unique** and must be able to return more than one row and say so. The item number string must survive the migration verbatim, because three local stores outside Automayt key on it (section 3.5 rule 2, section 8.3). Replaces `lib/shopify-sf.js:191`.
- **Create item.** Full payload as in section 4.6. Contract requirements: the name field must be required and must not throw a null-pointer error if omitted; a name-collision precheck or a documented conflict response so the `MFG-` prefix rule can run; a stated uniqueness rule on the vendor code; the response must return the **final, post-normalisation** name and description; and the revenue GL must be settable at create time so the poll-and-patch dance disappears. Must refuse, not default, when the cost is unknown. Replaces `lib/shopify-sf.js:477`.
- **Expose unit of measure and a numeric conversion factor as first-class fields**, and make the factor **per unit of measure, not square-foot-only**. The item's stocking unit is one of a small closed set (`EA`, `SqFt`, `SqYd`, `LnFt` in the restricted picklist today, plus a free-text twin holding 17 spellings of those four); the factor is how many stocking units one saleable unit contains, for example 134.5 square feet per DITRA-HEAT roll. Ideally the API also does the conversion, so the client sends "2 rolls" and never multiplies. This retires the description-parsing in `lib/pbsi-uom.js` described in section 4.1 step 4e, and it closes the live `SqYd` and `LnFt` gap on 2,141 items described in section 5.9. Where the factor comes from at migration is a CFC question, not an Automayt one (section 10.2 item 8), but the field has to exist for the answer to have anywhere to go.

Can lag:

- Batch get by a list of at least 200 item numbers, returning stock status, available-to-promise, not-for-sale flag, box quantity and description (the storefront stock gate).
- Batch get by a list of at least 200 vendor codes returning id, item number and vendor code (the vendor-availability link).
- Description substring search returning scored candidates.
- Streaming or cursored export of the whole item master, filterable on cost greater than zero and on vendor code not null, with an `updatedSince` cursor as an improvement over today's full snapshot.
- Get one item with every field, including the linked product and revenue-GL reference.
- Aggregate counts, and a metadata endpoint listing fields with name, label and type.
- Substitution search: by item group, description substring or style name, **sorted** by available-to-promise (note: sorted, not filtered, for two of the three real queries).

### 6.6 Accounts, contacts, locations, tax codes, GL accounts

Day one:

- Resolve the four house and vendor accounts by a stable identifier, and preferably **by name** rather than by id, so a sandbox and production stay in parity. The vendor record must also carry its own `account_number` (CFC's customer number inside the vendor's system, `55010180` at Prosol and `70056` at Treeco), because it is the join between CFC's ERP and Prosol's and it is an input to the direct-order path.
- Get contact by email, exact, limit 1, lookup only. Never create.
- Resolve the two locations by a stable identifier, including the virtual receiving location.
- Resolve the item groups, the item tax code and the revenue GL account by a stable identifier.
- Clear an account credit hold, or guarantee automation is never hold-blocked so the call disappears.

Can lag:

- Vendor directory with stable id, name, remit address and default contact email, so two vendor ids and two street addresses stop being source constants.
- GL account list with an active flag.
- Find user by email, and list active users.

### 6.7 Payables and accounting

Can lag relative to the pipeline, but **cannot lag relative to CFC's accounts-payable cycle**, which runs continuously.

- List unpaid payables by vendor, from a date, with balance greater than zero, paginated, returning number, **linked purchase order**, total, **pre-tax subtotal**, paid amount, balance and date.
- Get payables for a purchase order, and for a list of purchase order ids.
- Payable lines by payable: quantity, **unit cost** (the Salesforce field is `AcctSeed__Unit_Cost__c`, not `AcctSeed__Rate__c`, which does not exist on that object), amount, sub-total, product.
- **Exception rules fire on positive evidence only.** A carrier tracking event, a payable row, a duplicate group. Never on the absence of data. Twice in one session an absence inference produced a five-figure number that was not real.
- **Over-billing is compared pre-tax.** Sum the unpaid payables' pre-tax subtotals against the purchase order total, and flag only when the excess exceeds 2 percent plus 2 dollars. Comparing gross totals flags every Ontario shipment at 13 percent and every Quebec shipment at 14.75 percent as fraud.
- Aggregate payables by purchase order with a having-count filter (double billing), and by vendor by year.
- **The payable-to-purchase-order link must be a first-class field.** In Salesforce it is the Ascent2AcctSeed bridge field. If Automayt loses it, three of the four accounting exception rules die.
- An explicit paid versus open-balance distinction on every payable.
- A per-record note or flag with real user mentions and notifications, accepting a caller-supplied amount and a client idempotency key.
- Whatever replaces the "is this purchase order in QuickBooks yet" flag, which CFC uses as a stop-the-cheque signal.

### 6.8 Reporting

- Purchase order line spend, filterable by **who or what created the purchase order** and by order date over a 730-day window, streamed, returning quantity ordered, item cost, total price, pre-tax total price, and the parent order's number, date, vendor and owner.

### 6.9 The general query surface

Above everything on this list, in value: **one general, parameterised read API over every object**, with a filter grammar supporting equality, inequality, greater-than, IN, LIKE with wildcards and null tests; an explicit field list including parent traversal to at least two hops and child collections in one round trip; ORDER BY including nulls-last and including fields not in the projection; LIMIT; and a cursor. Plus aggregates with GROUP BY and HAVING and a year-bucketing function. Plus schema introspection.

Roughly 40 of the 47 forensic scripts, and every ad-hoc question CFC asks of the ERP during an incident, are a single bespoke query each. A fixed endpoint list turns that into a permanent backlog of feature requests. Section 6.11.4 proposes a concrete grammar for it.

### 6.10 The status contract

What Automayt's status models will be is the wrong thing for CFC to ask and the wrong thing for Doug to guess at. Below is what run-orders **requires**. The remaining question, in section 10.1 item 11, is only whether Automayt can express it and what it calls the values.

None of these is arbitrary. Every one is load-bearing somewhere in section 4, and several of them have cost CFC money.

**Sales Order. Minimum vocabulary: five values.**

- `open` - the literal value written on every create, both channels (sections 4.1 step 5, 4.3 step 4).
- `partially_complete` - human workflow, must migrate. 607 records.
- `closed` - the normal human end state, and the bulk of the data. 21,992 records.
- `cancelled` - the established soft-delete, set by the ad-hoc operation in section 4.16. 6 records.
- `staged` - human workflow, must migrate. 32 records.

The declared picklist also carries `In Progress` and `Packed`, which nothing uses, and a second, overlapping state machine `PBSI__Stage__c` carries three values the picklist does not declare at all (`Partially Packed` 514, `Staged` 31, `Cancelled` 6). Four overlapping state machines on one object is one of the things not to reproduce (section 3.1).

Transitions run-orders needs to be legal:

1. Create at `open`. Nothing else.
2. Any state to `cancelled`, addressed by record id, at any time, **including after the order has been invoiced**. Nothing checks first today and the operator sequence in section 4.16 depends on it working.
3. `cancelled` to `cancelled` must be a **safe no-op**, not an error, because the operator sequence is re-run by hand.
4. Cancelling a record that does not exist must report "no such record" **distinctly from a failure**. Shopify order 1368 in the 2026-09-09 batch had no Sales Order at all, and the operator needs to see that as a clean skip.
5. run-orders never sets any other value. Everything else is human workflow that has to survive the migration but that the API does not have to expose to the pipeline.

**Purchase Order. Minimum vocabulary: five values.**

- `open` - the literal value written on every create, all three flows, and the value written **back** onto the header before each receive after the first (section 4.3 step 8). 484 records currently.
- `partially_complete` - 192 records. Paired with `open`, this is the **open-supply filter**: the replenishment subtraction in section 4.8 asks for lines whose parent is in `('Open','Partially Complete')` with a remaining quantity above zero. If Automayt splits or renames these, the subtraction silently stops finding inbound stock and CFC double-orders.
- `complete` - the end state of an auto-received pipeline Purchase Order, 14,326 records, and the largest single requirement in this list: **`complete` must not lock out further receives.** In Salesforce it does, which produced six stuck Purchase Orders, a repair script, and a permanent reopen dance in the pipeline (sections 3.3, 4.3 step 8, 4.4).
- `closed` - terminal, and **blocks payable creation**. 25 records. It must therefore never be an automated end state. The receipt path deliberately avoids it.
- `cancelled` - the established soft-delete, preferred over delete, 12 records all time.

Declared and effectively unused: `Not ordered`, `Ordered` (1 record), `Received` (4 records), `Vendor Invoiced`, `Paid`. One record carries a null status. CFC does not need Automayt to reproduce the unused five, but a migration has to put the five stragglers somewhere.

Transitions run-orders needs to be legal:

1. Create at `open`. Nothing else, on any of the three flows.
2. `complete` back to `open`, addressed by record id. This exists only to work around the lock-out above. **If receiving does not complete the order and does not lock out siblings, this transition disappears and CFC would rather it did.**
3. Receiving must be legal from `open`, from `partially_complete` and from `complete`. The third is the one Salesforce gets wrong.
4. Any state to `cancelled`, as a soft-delete with an audit trail.
5. Automayt may advance the status itself on full receipt, but if it does, the value it advances to must still accept receipts, and it must not be `closed`.

**Two derived predicates that are currently expressed through a formula and should not be.**

- The **receive-repair backlog** is "received is less than ordered". Today the only way to ask is `status = 'Complete' AND CFC_Stage__c = 'Partially Received'`, because SOQL cannot compare two quantity fields on the same row. Expose the honest predicate.
- The **open supply** is "quantity ordered minus quantity received, per line, where the parent is still open". Today one implementation computes it client-side from two fields and the other reads the platform's `PBSI__Quantity_Left_To_Receive__c`. Expose a server-computed remaining quantity and one filter.

**One status-adjacent rule that is not a status.** `PBSI__Date_Sent__c` records that a purchase order was sent to the vendor, and it is what makes the `CFC_Stage__c` formula read `Sent`. It is **null on every pipeline Purchase Order**, and that is correct: the pipeline tells Prosol by its own email. Automayt should keep a "sent to vendor" timestamp as a separate, explicitly-set field, and creating a purchase order must never set it. See section 3.3, vendor-notification control surface.

### 6.11 Draft wire contract

The rest of section 6 says what the operations are. This subsection is CFC's proposal for what they look like on the wire, so the two teams have something concrete to disagree about in week one rather than week four. Names, paths and shapes are all negotiable. The **semantics** are not: they are the ones sections 4, 6.10 and 9 set out.

Every path below is relative to a single configurable base URL, so that pointing run-orders at a sandbox is one environment variable (section 2.9).

#### 6.11.1 Conventions

- Transport: HTTPS, JSON request and response bodies, UTF-8, `Content-Type: application/json` required on every write. The current Salesforce client lost a month to a generic request helper that sent an object with no content type (section 4.3), so be strict and say so in the error.
- Versioning: the version is in the path, `{BASE}/v1/...`, with a published deprecation policy. The client must pin deliberately rather than inherit a library default, which is how run-orders ended up on a 2018 REST surface.
- Authentication: `Authorization: Bearer <token>`, token from `POST {BASE}/v1/auth/token` with client credentials. No username plus security-token concatenation, no browser step, no MFA on the API path.
- `Idempotency-Key: <caller-generated string>` accepted on every POST. Replaying the same key returns the original response with `"idempotent_replay": true` rather than creating a second record.
- `X-Client-Id: run-orders/1.0.0` accepted on every call and **stored on the record**, queryable afterwards as `created_by_client`. This is what finally separates machine writes from human writes (section 4.12).
- Dates are `YYYY-MM-DD`. Timestamps are RFC 3339 with an explicit offset. Money and quantities are JSON numbers with a documented scale (money 2, quantity 6); if Automayt prefers decimal strings, say so now, because the client currently sends JavaScript numbers.
- Record ids are opaque strings. Do not encode meaning in them.
- Server-honoured request timeout, and a documented maximum request duration. There is no HTTP timeout anywhere in run-orders today, so a hung endpoint hangs the phase forever.

#### 6.11.2 Error envelope

Every non-2xx response, without exception, returns this shape. An empty message is the proximate cause of the 12-duplicate-purchase-order incident of 2026-07-24, so `message` is required and must be non-empty.

```json
{
  "error": {
    "code": "CONFLICT_DUPLICATE",
    "message": "A purchase order already exists for tracking code 520743084805",
    "field": "tracking_code",
    "retryable": false,
    "request_id": "req_01J8ZP3Q",
    "details": [
      { "field": "tracking_code", "code": "DUPLICATE", "message": "PO-16839 holds this code" }
    ]
  }
}
```

- `code` is from a stable, published, closed enum. `message` is human-readable and non-empty. `field` is present whenever the error is attributable to one input field, absent otherwise. `details` is present on multi-field validation failures.
- `retryable` is a **boolean the server sets**, and it is the single most important field in this document after the purchase order number. The client's retry ladder branches on it directly. It replaces the eight-string regex at `lib/salesforce.js:24`.
- Minimum code enum, grouped by how the client treats them:
  - Terminal, never retry, alert a human: `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_DISABLED`, `AUTH_PASSWORD_EXPIRED`, `AUTH_FORBIDDEN`.
  - Terminal, the request is wrong: `VALIDATION_FAILED`, `REQUIRED_FIELD_MISSING`, `UNKNOWN_FIELD`, `NOT_FOUND`, `CONFLICT_DUPLICATE`, `CONFLICT_VERSION`, `PRECONDITION_FAILED`, `UNSUPPORTED_TRANSITION`.
  - Retryable: `RATE_LIMITED` (with `Retry-After`), `UPSTREAM_TIMEOUT`, `SERVICE_UNAVAILABLE`, `INTERNAL`.
- `AUTH_TOKEN_EXPIRED` is the one code that means "re-authenticate once, then retry once". Say explicitly whether the token endpoint has a lockout heuristic and what it returns, because retrying a credential failure is exactly what tripped Salesforce's lockout and is why the terminal list exists.
- HTTP status is advisory; `code` is authoritative. In particular a **per-record failure inside a batch must not be signalled by a 200 with a nested flag** the way the PBSI invocable action does it today (section 4.3).

#### 6.11.3 Pagination

Every list response, without exception:

```json
{
  "data": [ { "id": "..." } ],
  "page": { "returned": 200, "has_more": true, "next_cursor": "eyJvIjoyMDB9" }
}
```

Requests take `?limit=` (documented maximum) and `?cursor=`. `has_more` is always present, even when false. **There is no mode in which a caller can receive a truncated list and not know it**; the current silent 2000-row cut is a live bug class in run-orders and is section 9.2 item 13.

#### 6.11.4 The general query surface, and its filter grammar

This is the single highest-value item in section 6.9 and it needs a grammar, not a promise.

```
POST {BASE}/v1/query
```

```json
{
  "object": "purchase_order_line",
  "select": [
    "quantity_ordered",
    "quantity_left_to_receive",
    "purchase_order.number",
    "purchase_order.status",
    "purchase_order.created_at",
    "purchase_order.vendor.name"
  ],
  "where": {
    "and": [
      { "field": "purchase_order.vendor.name", "op": "like", "value": "%rosol%" },
      { "field": "purchase_order.status", "op": "in", "value": ["open", "partially_complete"] },
      { "field": "quantity_left_to_receive", "op": "gt", "value": 0 }
    ]
  },
  "order_by": [ { "field": "purchase_order.created_at", "dir": "desc", "nulls": "last" } ],
  "limit": 500,
  "cursor": null
}
```

- Operators, minimum set: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `like`, `not_like`, `is_null`, `is_not_null`.
- `like` takes `%` as the wildcard on either or both ends. Three live queries depend on a leading wildcard.
- Boolean composition: `and`, `or`, `not`, nestable.
- **Values are bound, not interpolated.** Today every query in run-orders is built by string concatenation and the quote escaping is inconsistent across call sites: some escape a quote to a backslash-quote, some delete quotes, most do neither.
- **Traversal to at least two hops** in `select`, in `where` and in `order_by`, written as dotted paths. The replenishment query above filters on a two-hop path (`purchase_order.vendor.name`) that is **not in the projection**, and the duplicate-group query orders by a creation timestamp that is not in the projection. Both must work.
- Child collections in one round trip: `"include": ["lines"]` returns the parent with a nested `lines` array, replacing the sub-select form.
- `"select": ["*"]` returns every populated field on the record. This is what an operator reaches for when the field name is in doubt, and in an org nobody documented it **is** the documentation.
- Relative dates as literal tokens so a client does not compute them: `"$today"`, `"$last_n_days:65"`, `"$last_n_days:730"`.
- Aggregates: `"group_by": ["tracking_code"]`, `"aggregate": [{ "fn": "count", "as": "n" }, { "fn": "sum", "field": "total", "as": "total" }]`, `"having": [{ "field": "n", "op": "gt", "value": 1 }]`. Functions needed today: `count`, `sum`, `min`, `max`, and a year-bucketing function `year(field)` for the payables-by-year reports.
- The IN-list ceiling must be published. run-orders chunks at 50 (tracking codes), 150 (purchase order ids) and 180 (item codes) today purely by guesswork, and section 6.5 asks for 200.

#### 6.11.5 Schema introspection

```
GET {BASE}/v1/meta/objects
GET {BASE}/v1/meta/objects/{object}
```

Per field: API name, label, type, length or precision and scale, `createable`, `updateable`, `nillable`, `unique`, `calculated` (with the expression where one exists), `default_value`, `reference_to`, and picklist values with an active flag **and a live usage count**. Without this, `scripts/ops/po-lookup.js` cannot be ported: it describes before it queries precisely so it does not throw on an org-specific field name, and that defensive pattern is what kept four non-existent field names from breaking the tool (section 3.3).

#### 6.11.6 Day-one operations

Thirty-five calls. Everything else in section 6 can lag.

Authentication and operations:

1. `POST /v1/auth/token` - client credentials in, `{access_token, expires_at, identity, base_url}` out.
2. `GET /v1/health` - authenticated, returns `{ok, auth_ok, db_ok, version, time}`. It must distinguish "authentication is dead" from "no data today", which the current 06:30 check cannot (section 2.7).
3. `GET /v1/whoami` - cheap identity plus latency ping, the equivalent of `scripts/sf-login-probe.js`.
4. `GET /v1/meta/objects` and 5. `GET /v1/meta/objects/{object}` - section 6.11.5.

Reference data:

6. `GET /v1/accounts?name=` and `?id=` - resolves the four house and vendor accounts, **by name** as well as by id, so a sandbox and production stay in parity.
7. `GET /v1/contacts?email=` - exact, limit 1, lookup only. Never creates.
8. `GET /v1/locations` - all of them, with an `active` flag and a `virtual` flag. Fourteen records today (section 3.6).
9. `GET /v1/tax-codes` - id, name, rate. Eight records today (section 5.3).
10. `GET /v1/item-groups` and 11. `GET /v1/gl-accounts` - id, name, active flag.

Items:

12. `GET /v1/items/lookup?vendor_code=` - separator-insensitive and case-insensitive, one canonical record.
13. `GET /v1/items/lookup?item_number=` - **may return more than one**, and says so.
14. `POST /v1/items/batch-lookup` - up to 200 codes of either kind in one call.
15. `POST /v1/items` - create, section 6.11.7.
16. `GET /v1/items/{id}` - everything, including the revenue GL reference.
17. `GET /v1/items/export?cursor=&updated_since=` - the nightly ETL pull, roughly 12,700 rows.

Sales Orders:

18. `POST /v1/sales-orders`
19. `POST /v1/sales-orders/{id}/lines`
20. `GET /v1/sales-orders?customer_id=&customer_po=&customer_po_contains=&created_after=&limit=&order_by=`
21. `GET /v1/sales-orders/{id}`
22. `PATCH /v1/sales-orders/{id}` - status only, per section 6.10.

Purchase Orders:

23. `POST /v1/purchase-orders`
24. `POST /v1/purchase-orders/{id}/lines`
25. `POST /v1/purchase-orders/check-tracking` - takes up to 200 tracking codes, returns the ones that already have a purchase order. **This is the primary duplicate guard, the client treats any error as fatal, and it must be cheap, exact and reliable.**
26. `GET /v1/purchase-orders/{id}` and `GET /v1/purchase-orders?number=`
27. `PATCH /v1/purchase-orders/{id}` - status only.
28. `GET /v1/purchase-order-lines?vendor_id=&status_in=&remaining_gt=` - the open-supply subtraction, with a server-computed `quantity_remaining`.
29. `POST /v1/purchase-orders/{id}/send` - **the explicit vendor send.** It exists so that create never sends. Body names the recipients or takes a saved contact id, and the response returns what was sent and to whom. See section 9.1 item 14.
30. `GET /v1/purchase-orders/{id}/pdf` - returns a PDF. This one call deletes six forensic scripts and a headless-browser dependency (section 4.18).
31. `DELETE /v1/purchase-orders/{id}` - documented cascade to lines, refused when a payable exists or the order is past `open`, with an audit trail (section 4.17).

Receiving:

32. `POST /v1/purchase-orders/{id}/receipts` - one or many lines, atomic, section 6.11.7.
33. `GET /v1/purchase-orders/{id}/receipts` - so a repair tool can find where the first receipt landed.

Payables and notes:

34. `GET /v1/payables?vendor_id=&date_from=&balance_gt=&has_purchase_order=true` - paginated.
35. `POST /v1/purchase-orders/{id}/notes` - the "do not pay" note, with real user mentions and notifications, a caller-supplied amount and a client idempotency key.

#### 6.11.7 The five creates and the receive, on the wire

Field names below are a proposal. The Salesforce name each one maps from is in section 6.11.8.

**Create Sales Order.** Replaces `lib/shopify-sf.js:717-732` and `lib/amazon-po.js:264-275`.

```
POST {BASE}/v1/sales-orders
Idempotency-Key: shopify-so-1373
```

```json
{
  "customer_account_id": "acct_shopify",
  "contact_id": "cnt_9f21",
  "status": "open",
  "order_date": "2026-09-04",
  "customer_po": "1373",
  "tax": {
    "exempt_gst": false,
    "exempt_pst": false,
    "exempt_gst_ref": "",
    "exempt_pst_ref": "",
    "tax_code_id": null
  },
  "bol_description": null,
  "channel": "shopify"
}
```

```json
{
  "id": "so_01J8ZQ",
  "number": "SO-025763",
  "status": "open",
  "order_date": "2026-09-04",
  "customer_po": "1373",
  "created_at": "2026-09-04T18:11:04Z",
  "normalized": []
}
```

`number` in the create response is mandatory, not a convenience (section 4.19). `normalized` is an array naming any field the server changed from what the caller sent, which is the answer to section 9.2 item 4: if Automayt rewrites a value, it says so here rather than leaving the caller to discover it on a later read. The `tax` object exists because a Salesforce Flow **fails on null** where it expects `false`, so booleans must be explicitly required rather than optional-with-a-default (section 9.2 item 5). The Amazon variant of this payload sends `exempt_gst: true`, `exempt_pst: true`, both refs `"Third Party Amazon"`, `bol_description: "None"`, `tax_code_id` for the `Exempt` code, and `channel: "amazon"`.

Duplicate submission: idempotent on `(customer_account_id, customer_po)`. A repeat must return the **existing** record with `"idempotent_replay": true`, not a second record and not an opaque error.

**Create Sales Order Line.** Replaces `lib/shopify-sf.js:750-756` and `lib/amazon-po.js:757-763`.

```
POST {BASE}/v1/sales-orders/so_01J8ZQ/lines
```

```json
{ "item_id": "itm_4r9u5", "quantity": 2, "quantity_needed": 2, "unit_price": 59.11 }
```

```json
{ "id": "sol_01J8ZR", "number": "113176", "quantity": 2, "unit_price": 59.11, "normalized": [] }
```

The line id must come back **synchronously**, because it is a required input to the purchase order line that follows it in the same run.

**Create Purchase Order.** Replaces `lib/shopify-sf.js:800-807`, `lib/amazon-po.js:789-795`, `lib/fba-po-sender.js:405-410`.

```
POST {BASE}/v1/purchase-orders
Idempotency-Key: po-tracking-520736098713
```

```json
{
  "vendor_account_id": "acct_prosol",
  "order_date": "2026-09-04",
  "status": "open",
  "instructions": "Shopify #1373 <EMDASH> Jane Doe <EMDASH> Schluter Kerdi-Board Niche <EMDASH> purolator <EMDASH> Tracking: 520736098713",
  "tracking_code": "520736098713",
  "channel": "shopify",
  "external_ref": "shopify:1373",
  "notify_vendor": false
}
```

```json
{
  "id": "po_01J8ZS",
  "number": "PO-16785",
  "status": "open",
  "tracking_code": "520736098713",
  "vendor_notified": false,
  "normalized": []
}
```

- `number` must match `PO-` plus 3 to 6 digits, word-boundary delimited, because an inbound-email regex matches it exactly (section 4.19 C).
- `instructions` must accept at least 255 characters; more is better, since the current field truncates and the string is doing three jobs at once.
- `channel` is the first-class enum (`amazon`, `shopify`, `fba`, and room for more) that retires both the free-text marker in section 5.7 and the two accidental formulas in section 3.3.
- `notify_vendor` **defaults to false and there is no configuration that changes the default.** Passing `true` is the only way a create ever emails anybody, and CFC's pipeline never passes it. `vendor_notified` echoes what actually happened.
- Dedupe: unique on `tracking_code` when present. The FBA flow sends none, so the constraint must tolerate null and not collapse every FBA purchase order into one.

**Create Purchase Order Line.** Replaces `lib/shopify-sf.js:829-836`, `lib/amazon-po.js:810-817`, `lib/fba-po-sender.js:420-425`.

```
POST {BASE}/v1/purchase-orders/po_01J8ZS/lines
```

```json
{
  "item_id": "itm_4r9u5",
  "quantity_ordered": 2,
  "unit_price": 59.11,
  "demand": { "sales_order_id": "so_01J8ZQ", "sales_order_line_id": "sol_01J8ZR" }
}
```

```json
{
  "id": "pol_01J8ZT",
  "quantity_ordered": 2,
  "unit_price": 44.71,
  "normalized": [
    { "field": "unit_price", "sent": 59.11, "stored": 44.71, "reason": "derived from item standard cost" }
  ]
}
```

That `normalized` entry is the whole point. In Salesforce the sent price is silently discarded and replaced by the item cost, which cost CFC real money on a freight line and a Schluter line (section 3.4). **Either the caller's price is stored, or the response says what was stored and why.** The `demand` object is supported and **optional**: drop-ship lines carry both ids, FBA replenishment lines carry neither and must not be rejected for it.

**Create Item.** Replaces `lib/shopify-sf.js:477`. Full field list in section 4.6.

```
POST {BASE}/v1/items
```

```json
{
  "item_number": "KP10701",
  "vendor_code": "KP10701",
  "description": "Schluter Kerdi-Fix Bright White 290ml",
  "default_vendor_id": "acct_prosol",
  "default_location_id": "loc_sechelt_wh",
  "item_group_id": "grp_accessories",
  "unit_of_measure": "EA",
  "conversion_factor": 1,
  "status": "active",
  "type": "item",
  "cost_type": "standard",
  "lot_tracked": true,
  "taxable": true,
  "tax_code_id": "tax_gst_pst_bc",
  "revenue_gl_account_id": "gl_4000_sales",
  "cost": 27.35,
  "landed_cost": 27.35,
  "purchase_price": 27.35,
  "sales_price": 41.99,
  "upc": "4038072000000",
  "attributes": {
    "manufacturer": "Schluter",
    "style": "Kerdi-Fix",
    "color": "Bright White",
    "size": "290ml KP10701"
  }
}
```

```json
{
  "id": "itm_01J8ZU",
  "item_number": "14146",
  "vendor_code": "KP10701",
  "description": "Schluter -  - Kerdi-Fix - KP10701 -",
  "normalized": [
    { "field": "item_number", "sent": "KP10701", "stored": "14146", "reason": "assigned from item-number sequence" },
    { "field": "description", "sent": "Schluter Kerdi-Fix Bright White 290ml", "stored": "Schluter -  - Kerdi-Fix - KP10701 -", "reason": "rewritten to house description format" }
  ]
}
```

Contract requirements on this one, all of them earned:

- A missing name must be a `REQUIRED_FIELD_MISSING`, not a null-pointer exception from a trigger. Diagnosing that one cost a full session.
- A colliding item number must be **reported**, not silently accepted, so the client's `MFG-` prefix rule can run. Better: state the uniqueness rule and let the server assign.
- **Refuse, do not default, when the cost is unknown.** A costless item silently poisons every downstream margin number, which is why the client refuses first with a precise message rather than letting the server reject with a required-field error.
- `revenue_gl_account_id` must be settable **at create time**, which deletes the poll-and-patch dance in section 4.6 step 5 outright.
- `conversion_factor` is the numeric coverage from section 6.5.

**Receive.** Replaces the invocable action at `lib/amazon-po.js:850-869` and its independent duplicate at `scripts/ops/fix-stuck-po-receive.js:75-83`.

```
POST {BASE}/v1/purchase-orders/po_01J8ZS/receipts
Idempotency-Key: receipt-po_01J8ZS-2026-09-09-1
```

```json
{
  "location_id": "loc_amazon_fulfillment",
  "receiving_date": "2026-09-09",
  "type": "receive",
  "lines": [
    { "purchase_order_line_id": "pol_01J8ZT", "quantity_received": 1, "unit_price": 72.41 }
  ]
}
```

```json
{
  "receipts": [
    { "id": "rcpt_26329", "purchase_order_line_id": "pol_01J8ZT", "quantity_received": 1, "posted": true }
  ],
  "inventory_transaction_id": "mj_01J8ZV",
  "purchase_order": { "id": "po_01J8ZS", "status": "complete", "quantity_remaining": 0 },
  "posted": true
}
```

- **Atomic.** Receipt plus inventory posting plus whatever the accounting chain needs, in one call, or nothing. A receipt row without its inventory transaction looks correct and silently breaks packing, vendor invoicing and the QuickBooks sync; CFC lived that for two days in May 2026 and the accountant repaired it by hand.
- `inventory_transaction_id` is required on success and `posted` must be true. **A receipt that does not post inventory is an error, not a success.** Today the client asserts this by re-reading a 20-character string field on the header as a canary.
- **Many lines in one call**, which is what removes the reopen dance entirely.
- Must be safe to retry: either reject the duplicate or be idempotent on the key. Say which.
- `type` covers `receive`, `credit` and `reverse`. Only `receive` is used today (25,911 records, 100 percent), but the other two are declared and a migration has to carry them.
- **Receiving must not require the header status to be reset first**, from any status the order can legally be in. That is section 6.10, transition 3.

#### 6.11.8 Field mapping, Salesforce API name to proposed Automayt name

One bullet per field, grouped by object. This is the mapping table Appendix A is the source for; where Appendix A lists a field and this list does not, the field is read-only forensics and does not need a wire name.

Sales Order (`PBSI__PBSI_Sales_Order__c` maps to `sales_order`):

- `Name` maps to `number` (server-assigned, `SO-` plus six digits).
- `PBSI__Customer__c` maps to `customer_account_id`.
- `PBSI__Contact__c` maps to `contact_id`.
- `PBSI__Status__c` maps to `status` (section 6.10).
- `PBSI__Order_Date__c` maps to `order_date`.
- `PBSI__Customer_Purchase_Order__c` maps to `customer_po`.
- `PBSI__Tax_Code__c` maps to `tax.tax_code_id`.
- `mm_Exempt_GST__c` maps to `tax.exempt_gst`; `mm_Exempt_PST__c` maps to `tax.exempt_pst`.
- `mm_Exempt_GST_ID__c` maps to `tax.exempt_gst_ref`; `mm_Exempt_PST_ID__c` maps to `tax.exempt_pst_ref`.
- `PBSI__BOL_Description__c` maps to `bol_description`.
- `PBSI__Final_Order_Total__c` maps to `final_total` (CALCULATED, revenue truth).
- `PBSI__Order_Total__c` maps to `total` (CALCULATED).
- `CreatedBy.Name` maps to `created_by.name`; `CreatedDate` maps to `created_at`.
- No Salesforce equivalent, wanted: `channel`, `period_start` and `period_end` (so the Amazon 14-day window is a queryable range instead of a parsed English string, section 6.2).

Sales Order Line (`PBSI__PBSI_Sales_Order_Line__c` maps to `sales_order_line`):

- `PBSI__Sales_Order__c` maps to the path parameter. Accept at insert only; reject re-parenting.
- `PBSI__Item__c` maps to `item_id`.
- `PBSI__Quantity__c` maps to `quantity`.
- `PBSI__Quantity_Needed__c` maps to `quantity_needed`.
- `PBSI__Price__c` maps to `unit_price`.
- `PBSI__Total_Price__c` maps to `total_price` (CALCULATED).
- `Name` maps to `number`.

Purchase Order (`PBSI__PBSI_Purchase_Order__c` maps to `purchase_order`):

- `Name` maps to `number` (server-assigned, `PO-` plus 3 to 6 digits, hard contract).
- `PBSI__Account__c` maps to `vendor_account_id`. Note the asymmetry to carry forward or fix: on a Sales Order the party field is `PBSI__Customer__c`, on a Purchase Order it is `PBSI__Account__c`.
- `PBSI__Order_Date__c` maps to `order_date`.
- `PBSI__Status__c` maps to `status`.
- `PBSI__Shipping_Instructions__c` maps to `instructions`.
- `PBSI__Tracking_Code__c` maps to `tracking_code` (the dedupe key).
- `PBSI__Sales_Order__c` maps to `sales_order_id` (trigger-stamped today, never written by the client).
- `PBSI__Movement_Journal__c` maps to `inventory_transaction_id` (make it a real foreign key, not a 20-character string).
- `PBSI__Order_Total__c` maps to `total`; `PBSI__Final_Order_Total__c` maps to `final_total`. Both CALCULATED.
- `PBSI__Sales_Tax__c` maps to `tax_rate`.
- `Date_Received__c` maps to `received_at`; `Received_Location__c` maps to `received_location_id`.
- `CFC_Stage__c` maps to nothing. It is a formula proxy for predicates Automayt should answer directly (section 6.10).
- `PBSI__Date_Sent__c` maps to `vendor_notified_at`, set only by the send operation.
- `Auto_Send_Itemized_PO__c`, `mm_Send_Email__c`, `mm_Do_not_send_email_notification__c`, `mm_PO_pdf_created__c` map to **nothing**. They are the accidental notification surface in section 3.3 and the replacement is one explicit send endpoint.
- `Opportunity__c` and `mm_Amazon_or_Shopify__c` map to **nothing**. They are replaced by a real `channel` field.
- `mm_Allow_Delete__c` and `Can_be_deleted__c` map to **nothing**. They are replaced by a server-side delete precondition (section 4.17).
- `PBSI__Freight_Amount__c` maps to **nothing, deliberately.** Never populate it; freight is its own purchase order.
- `mm_Account_Number__c` maps to `vendor.account_number` on the vendor, not on the order.
- No Salesforce equivalent, wanted: `channel`, `external_ref`, `created_by_client`.

Purchase Order Line (`PBSI__PBSI_Purchase_Order_Line__c` maps to `purchase_order_line`):

- `PBSI__Purchase_Order__c` maps to the path parameter, insert only.
- `PBSI__Item__c` maps to `item_id`.
- `PBSI__Quantity_Ordered__c` maps to `quantity_ordered` (decimal, fractional values are normal).
- `PBSI__Price__c` **and** `PBSI__Price4__c` map to one field, `unit_price`. Two writable fields for one price, where writing only the first is silently discarded, is section 9.2 item 1.
- `PBSI__Sales_Order__c` maps to `demand.sales_order_id`.
- `PBSI__Original_SO_Line__c` maps to `demand.sales_order_line_id`.
- `PBSI__Quantity_Received__c` maps to `quantity_received`.
- `PBSI__Quantity_Left_To_Receive__c` maps to `quantity_remaining` (CALCULATED, and the one canonical name for the concept).
- `PBSI__Vendor_Item_ID__c` maps to `vendor_code` (a denormalised copy of the item's code, on the line).
- `PBSI__Item_Cost__c`, `PBSI__Total_Price__c`, `PBSI__Pre_Tax_Total_Price__c` map to `item_cost`, `total_price`, `pre_tax_total_price`. All CALCULATED.

Item (`PBSI__PBSI_Item__c` maps to `item`):

- `PBSI__Vendor_Item_ID__c` maps to `vendor_code`. **Primary key**, unique, separator- and case-insensitive.
- `Name` maps to `item_number`. Secondary, **not unique**, must survive verbatim.
- `PBSI__description__c` maps to `description`. Note the lowercase d on the Salesforce side.
- `PBSI__Cost__c` maps to `cost`; `mm_Landed_Cost__c` maps to `landed_cost`; `PBSI__purchaseprice__c` maps to `purchase_price`; `PBSI__salesprice__c` maps to `sales_price`; `mm_Original_Retail_Price__c` maps to `original_retail_price`.
- `Unit_of_Measure__c` maps to `unit_of_measure` (restricted). `PBSI__defaultunitofmeasure__c` maps to **nothing**; normalise the free-text twin away on migration.
- No Salesforce equivalent, required: `conversion_factor`, per unit of measure (section 6.5).
- `PBSI__Available_to_Promise__c` maps to `available_to_promise` (CALCULATED, **can be negative**, and negative means oversold).
- `Box_Quantity__c` maps to `box_quantity`.
- `PBSI__Not_Available_For_Sale__c` maps to `not_for_sale`. It is tested with strict identity against `true` today, so if Automayt returns `1` or `"true"` the one signal that de-lists product stops firing.
- `AscentBTO__Stock_Status__c` maps to `stock_status`. The literal `Stock` is load-bearing.
- `PBSI__Item_Status__c`, `PBSI__Item_Type__c`, `PBSI__Cost_Type__c`, `PBSI__Coverage_Code__c` map to `status`, `type`, `cost_type`, `coverage_code`.
- `PBSI__Tax_Code__c` maps to `tax_code_id`; `PBSI__Taxable__c` maps to `taxable`.
- `PBSI__Default_Vendor__c` maps to `default_vendor_id`; `PBSI__Default_Vendor_Name__c` maps to `default_vendor.name` (CALCULATED, and the field a vendor-aware purchase-order gate would use, section 4.1 step 7).
- `PBSI__Default_Location__c` maps to `default_location_id`; `PBSI__Item_Group__c` maps to `item_group_id`.
- `PBSI__Product__c` and `Product2.AcctSeed__Revenue_GL_Account__c` collapse to one field on the item, `revenue_gl_account_id`, settable at create.
- `Manufacturer__c`, `Original_Style_Name__c`, `Color__c`, `Size__c` map to `attributes.manufacturer`, `.style`, `.color`, `.size`. `manufacturer` is **free text**, not a restricted picklist.
- `PBSI__UPC_Code__c` maps to `upc`.

Receipt (`PBSI__Received_Purchase_Order_Line__c` maps to `receipt_line`):

- `PBSI__Purchase_Order__c` maps to the path parameter; `PBSI__Purchase_Order_Line__c` maps to `purchase_order_line_id`; `PBSI__Item__c` is derivable from the line and should not have to be sent.
- `PBSI__Location__c` maps to `location_id`; `PBSI__Quantity_Received__c` maps to `quantity_received`; `PBSI__Receiving_Date__c` maps to `receiving_date`; `PBSI__Price__c` maps to `unit_price`; `PBSI__Type__c` maps to `type`.

Payable (`AcctSeed__Account_Payable__c` maps to `payable`):

- `Name` maps to `number`; `A2AS__Purchase_Order__c` maps to `purchase_order_id` (**the bridge, and the single most important join in the accounting layer**); `AcctSeed__Vendor__c` maps to `vendor_account_id`; `AcctSeed__Date__c` maps to `date`.
- `AcctSeed__Total__c` maps to `total`; `AcctSeed__Sub_Total__c` maps to `pre_tax_total` (**this is what over-billing compares**); `AcctSeed__Paid_Amount__c` maps to `paid_amount`; `AcctSeed__Balance__c` maps to `balance`.
- `AcctSeed__Payment_Status__c` maps to `payment_status`; `AcctSeed__Status__c` maps to `posting_status`. Real domains and counts in section 3.10.
- Payable line `AcctSeed__Unit_Cost__c` maps to `unit_cost` (not `rate`; `AcctSeed__Rate__c` does not exist).

#### 6.11.9 The seven functions run-orders will wrap

Section 8.4 commits run-orders to a `lib/automayt.js` that presents the same shape as `lib/salesforce.js` plus the verbs it never wrapped. These are the signatures CFC will write against. They are listed here rather than in section 8 so that Doug's team can see, in one place, exactly which HTTP calls the client will make and in what shape it expects the answers.

```js
// Returns a cached, authenticated client. Caches below the published token
// lifetime; coalesces concurrent logins; retries only when the server says
// retryable, never on a terminal auth code (section 6.11.2).
async function connect(opts?: { baseUrl?, clientId?, clientSecret?, timeoutMs? })
  -> Client

// The general read surface (section 6.11.4). Pages internally by default and
// returns every row, or streams when onPage is supplied. Never truncates
// silently: throws if the server omits `page.has_more`.
async function query(client, spec: QuerySpec, opts?: { autoPage?: boolean, maxRows?: number, onPage?: (rows) => void })
  -> { rows: object[], truncated: false, pages: number }

// Single-record create. Resolves to the created record INCLUDING its
// human-readable number and any `normalized` entries. Throws AutomaytError
// carrying { code, field, retryable, requestId } on failure.
async function create(client, resource: string, body: object, opts?: { idempotencyKey?: string })
  -> { id, number?, normalized: [], idempotentReplay: boolean }

// Partial update, addressed by id. Safe to call twice with the same value.
async function update(client, resource: string, id: string, body: object, opts?: { ifVersion?: string })
  -> { id, normalized: [] }

// Delete, addressed by id. Reports the cascade it performed. Refuses with
// PRECONDITION_FAILED rather than silently succeeding on a protected record.
async function remove(client, resource: string, id: string, opts?: { reason?: string })
  -> { id, deleted: true, cascaded: { lines: number } }

// Non-CRUD operations: receive, send, pdf, notes. One call per operation, and
// a per-record failure inside a multi-line body must surface as a thrown
// AutomaytError, not as a success envelope with a nested flag.
async function action(client, resource: string, id: string, verb: string, body: object, opts?: { idempotencyKey?: string })
  -> object

// Schema introspection (section 6.11.5). Cached per process.
async function describe(client, object?: string)
  -> ObjectMeta or ObjectMeta[]
```

`AutomaytError` carries `code`, `message`, `field`, `retryable` and `requestId` verbatim from the error envelope. The one thing the client will not do is guess: if `retryable` is absent, it treats the error as terminal and alerts.


---

## 7. Volumes and non-functional needs

All counts read from the live org on 2026-09-09 by SOQL `COUNT()`. Windows are on `CreatedDate`. **The object totals and the per-status counts were captured minutes apart on a working weekday**, so a few of them disagree by one or two records (the AcctSeed payable object counted 25,982 rows, while the status scan counted 25,984 across its two values). That is the object growing during a business day, not a modelling error. Re-count in one pass before pricing a migration.

Records created, whole company, all users:

- Sales Order: 451 in 30 days, 1,344 in 90 days, 5,801 in 365 days, 23,228 all time.
- Purchase Order: 496 in 30 days, 1,422 in 90 days, 4,899 in 365 days, 15,045 all time.
- Purchase Order Line: 870 in 30 days, 2,362 in 90 days, 8,822 in 365 days, 25,388 all time.
- Received Purchase Order Line: 806 in 30 days, 2,389 in 90 days, 9,094 in 365 days, 25,911 all time.

Totals with no window measured:

- Sales Order Line 95,595; Item 12,685; Account 21,582; Contact 6,517; Product2 12,698; Movement Journal 46,603; Movement Line 156,217; Location 14; Vendor Invoice 213; AcctSeed Payable 25,982.

Roughly: 15 Sales Orders per day, 17 Purchase Orders per day, 29 Purchase Order lines per day, 27 receipt lines per day, across the whole company.

**The API user's share.** Because the integration runs as Mac's own seat, "Mac Roy" as creator covers both the pipeline and Mac's own user-interface work, so these are upper bounds:

- Purchase Orders: 217 of 496 in 30 days (44 percent), 548 of 1,422 in 90 days (39 percent), 884 of 4,899 in 365 days (18 percent).
- Purchase Order Lines: 235 of 870 in 30 days (27 percent), 598 of 2,362 in 90 days (25 percent), 1,096 of 8,822 in 365 days (12 percent).
- Received Purchase Order Lines: 191 of 806 in 30 days (24 percent), 504 of 2,389 in 90 days (21 percent), 638 of 9,094 in 365 days (7 percent).
- Sales Orders: 40 of 451 in 30 days (9 percent), 88 of 1,344 in 90 days (7 percent), 132 of 5,801 in 365 days (2 percent).

Read the three windows together rather than the headline: the pipeline's share of purchase-order work roughly doubles from the 365-day window to the 30-day window on every one of these objects. It is growing, not flat.

Read that carefully: **the pipeline is the single largest creator of Purchase Orders and a small minority of Sales Orders.** The rest is human work in the user interface, by fourteen named staff. Automayt has to serve all of them, not just the API.

Call volume and shape:

- Four write windows per weekday, at 07:00, 10:00, 12:00 and 13:30. Each processes a handful of orders.
- Per order the current implementation makes roughly 8 to 20 Salesforce calls: two guard reads, one contact read, one to six item reads per line, one create per record, one read-back per create, and on the Amazon path one action call plus one canary read per line.
- A 25-line Quick PO run can fire roughly 300 sequential item reads plus one unbounded org-wide query plus 27 writes.
- The nightly ETL at 03:00 streams roughly 12,700 item rows twice.
- Everything is **strictly sequential**. There is no batching, no concurrency, no connection pooling. One process, one cached session.

Latency tolerance:

- The pre-buy mapping guard is on the money path for every order line and is memoised, so it should be fast, but a slow response only delays staging.
- Order writes happen in a background cron and can tolerate seconds per call. What they cannot tolerate is an **unbounded** hang: there is no HTTP timeout anywhere today, so a hung endpoint hangs the phase forever.
- The dashboard endpoints are interactive and a human is watching.
- Read-your-writes matters: a Purchase Order is created, its number is read back, and that number is printed in an email inside the same run.

Concurrency:

- Normally one process. But the FBA Purchase Order endpoint does not take the pipeline lock, so two concurrent Purchase Order passes over the same shipments are possible today.
- Two repositories on the same host use the same credentials: run-orders and `cfc-instock-sync` (a long-lived server plus a 02:30 cron).
- Plus up to four operator scripts at any time.

What "seamless" means operationally, in CFC's terms:

- On the morning of cutover the 07:00 tick runs, buys labels, and produces a Purchase Order number for every parcel, with no manual step.
- Kaitlyn at Prosol's order desk and every Prosol branch can still look up the number CFC quotes at them.
- Accounting can still tell which purchase orders are unpaid, over-billed, or duplicated, and can still see a "do not pay" flag before cutting a cheque.
- Inventory still posts on receipt, so vendor invoices can post and the books close.
- No duplicate purchase orders. A missing one costs a cron tick; a duplicate costs a vendor argument.

---

## 8. Cutover and migration

### 8.1 Historical data

Mac's working assumption is that **everything is migrated**. It is flagged as a question for Doug because the volume determines the price. The numbers to scope against are in section 7; the complete field inventory is in Appendix A.

One hard constraint from prior work: **CFC's transactional history starts 2023-01-14.** Accounts were bulk-loaded in 2021 but carry no orders, opportunities or quotes before that date. Any request for five years of history cannot be met from this org.

If a full migration is not chosen, the minimum viable split, in priority order:

1. **Open Purchase Orders must exist in Automayt on day one, or Kaitlyn cannot receive against them.** Roughly 50 to 100 records at any time (242 at status Open plus 68 Partially Complete among orders created in the last year, most of which will have closed by cutover).
2. Every Item, because every order line resolves through one and because the analytics database joins on the item number and the item record id.
3. Every Account, Contact and Location.
4. Purchase Orders and lines for the trailing 730 days, because the financial report needs them.
5. Payables, because the accounting-exception rules key on unpaid balances and because open chargeback claims are indexed by purchase order number.
6. Sales Orders. The Amazon rolling ones are channel-summary staging with little ongoing value; the Shopify ones are the customer-facing record and are referenced by number in vendor-error entries.

### 8.2 In-flight orders and open purchase orders at the switch

At any moment there are parcels in transit with a Salesforce Purchase Order that Prosol has not yet invoiced, and Purchase Orders that Prosol will invoice weeks later. The switch must not orphan them.

- Every open Purchase Order needs a home in Automayt with **the same number**, or the branch cannot match it.
- Every in-flight parcel's tracking-to-purchase-order link must survive, because the stale-parcel chase email and the chargeback ledger both use it.
- Any Purchase Order at status Complete with a partial receipt (the receive-repair backlog) must be findable after the move.
- Open payables against Salesforce Purchase Orders must remain resolvable while accounts payable works them off.

### 8.3 Identifier mapping in local state

run-orders keeps Salesforce identifiers in seven local stores. **Every one of them becomes a dangling foreign key at cutover.**

- `data/ops-state/YYYY-MM-DD.json`, under `phases.pos.byTracking[<tracking>]`, holding `{poNumber, poId, soNumber, soId, at}`. Live shape from production: `"520672137350": {"poNumber": "PO-16175", "poId": "a0yOJ00000Eo6BpYAJ", "soNumber": null, "soId": null, "at": "2026-07-28T17:34:59.829Z"}`. **This is the single most load-bearing local-to-Salesforce binding.** It is read by the vendor email, the packing-slip PDF and its filename, the daily Telegram digest, the hourly orphan sweep (which reads prior days), and the stale-parcel reminder (which reads every day ever written). One file per day, one process, no schema versioning. It must tolerate a mixed corpus of legacy and Automayt numbers for weeks.
- `data/audit.jsonl`, containing Salesforce record ids, document numbers and **raw Salesforce error strings** inside four action types.
- `data/vendor-errors.jsonl`, where `po_ref` and `order_ref` index money claims against Prosol. Live values include PO-15388, PO-15902, PO-15904, PO-16069, PO-16108, PO-16173, PO-16174, PO-16438 and SO-024448, SO-025636, SO-025655, SO-025672. **These must stay resolvable while open chargebacks are worked.**
- `data/fba/inbound-plans/<planKey>.json` and the FBA draft files, where the purchase order number is baked into plan keys and into Amazon shipment names. The live example is `planKey: "po15056-prosol-inbound"` with `name: "PROSOL PO15056 Sealers Gold 112u"`, so the hyphen is stripped on the Amazon side and it is the **numeric portion** that has to stay stable and resolvable. **Those strings are inside Amazon and are not rewritable.**
- `data/fba/po-drafts/**`, where `sfPoNumber` per line is the routing key for inbound vendor email replies.
- `data/analytics.sqlite`, where `item_costs.pbsi_item_id` holds a Salesforce record id and `sku_map_canonical.sf_pbsi_item_id` plus `sf_item_name` are the analytics layer's join to the item master. Rebuilt nightly, so it self-heals once the ETL points at Automayt, but note that the item-creation path falls back to this mirror as its third cost tier, so a stale mirror silently becomes the cost of record during the switch.
- `scripts/shipstation/sku-map.json`, the pipeline's routing brain, where 8 entries carry explicit Salesforce item identifiers and where the `api_sku` field doubles as the Salesforce item number for some Shopify products. Together with the two analytics tables above, this is why rule 2 of the item-identity decision (section 3.5) requires the Salesforce item `Name` string to survive the migration verbatim. Renumbering items means rewriting all three of these plus every Shopify variant SKU that matches on the item number.

Practical requirement: **numbering continuity, or a documented dual-format period.** If Automayt continues the `PO-16xxx` and `SO-025xxx` sequences, nothing above needs migrating. If it restarts or changes shape, then the vendor-reply regex, the four verification harnesses, the reminder renderer and the chargeback ledger all need work in lockstep, and the same email to the same branch will carry both formats for weeks.

### 8.4 What run-orders changes on its side

The clean shape is **a new `lib/automayt.js` that presents the same three-function interface as `lib/salesforce.js` plus the verbs it does not currently wrap**, and then migrating the call sites.

Realistically that means:

1. `lib/automayt.js` exporting `connect`, `query` (with real pagination), `create` (returning id **and** number), `update`, `remove`, `action` and `describe`. **The seven signatures, with the response shapes they expect, are specified in section 6.11.9** so that the two teams are building against the same contract from week one.
2. A per-module switch on an environment flag, so each of the five write paths can be moved independently: `lib/shopify-sf.js`, `lib/amazon-po.js`, `lib/fba-po-sender.js`, `lib/shopify-so-reconcile.js`, and the mapping guard in `scripts/shipstation/run-orders.js`.
3. Replacing the invocable-action wrapper, which exists in **two** independent copies (`lib/amazon-po.js` and `scripts/ops/fix-stuck-po-receive.js`).
4. Replacing hard-coded record ids with resolved identifiers, ideally resolved by name so a sandbox and production stay in parity. Section 5 is the list; six or more files are affected.
5. Deleting the code that exists only to work around Salesforce: the five create-then-read-number round trips, the poll-and-patch revenue GL stamp, the reopen-before-receive dance, the four-spelling lookup ladder, the whole of `lib/pbsi-uom.js` if the conversion factor moves server-side, and the account-hold clear. **How much of that can be deleted is a direct function of the answers in section 10.**
6. Porting the ETL reads to a bulk or cursored export.
7. Updating the four hand-run verification harnesses if the number format changes, and moving them into `npm test`.
8. Adding a real health probe.

Note the second repository. `cfc-instock-sync` imports run-orders' Salesforce module by path and reuses the same `.env`. **The cutover touches two repositories.**

Also note there is **no test coverage** on the Salesforce layer today: `npm test` runs six test files, none of which is `lib/salesforce.test.js` or `lib/integration-health.test.js`. An adapter swap has no regression net to land on.

### 8.5 Cutover style

Undecided; this is a question for Doug. The three options and what each requires from Automayt:

**Option A, parallel run (recommended).** run-orders dual-writes to Salesforce and to Automayt behind two flags, one enabling Automayt writes and one flipping the source of truth. A daily job diffs the two systems and is driven to zero before the flip. Then Salesforce writes are switched off and reads are kept for the reporting window. Requires from Automayt: a sandbox or at least a second tenant, stable identifiers, and enough of the API to write every record type. Risk: duplicate vendor notification if both systems auto-email, and double work for Kaitlyn if she is asked to receive in both.

**Option B, hard switch on a date, with a sandbox dry-run first.** Stop the cron on the Friday, snapshot Salesforce, migrate open Purchase Orders, point the environment at Automayt, restart, and watch the Monday 07:00 tick by hand. Requires from Automayt: a sandbox to rehearse against, a documented rollback, and the migrated open Purchase Orders with their numbers intact. Risk: no easy rollback once Kaitlyn starts receiving against Automayt Purchase Orders.

**Option C, read-only shadow then hard switch.** Point a second run-orders instance with `DISABLE_CRON=1` at Automayt, replay a day of orders in dry-run mode, compare outputs, then hard switch. Cheapest to build, least coverage of the write path.

**What a day-scale outage actually looks like, because a cutover weekend is the same shape.** Section 2.6 covers per-call behaviour. The day-scale behaviour is on record: on 2026-04-27 Salesforce was down while the pipeline kept running, and `data/pause-reconciliation/2026-04-27.md` records the result. 17 orders staged, **13 carrier labels bought and money spent**, 0 Purchase Orders created, 0 emails sent, 0 pickups booked, 4 errors. The reconciliation afterwards was a set difference: every tracking number in `phases.pos.byTracking` that had no Salesforce record had to be re-driven through the `pos` phase, and the file is literally a list of 13 tracking numbers with their order numbers, carriers, costs and SKUs, held for exactly that. Two consequences for the plan:

- **Labels keep printing when the order system is down.** The `buy` phase spends real money before the `pos` phase touches the ERP (section 1.1), so an outage produces parcels in the world with no purchase order behind them. That is the exact condition the cutover window creates deliberately.
- **The reconciliation tool already exists and it is a set difference on local state.** Whatever the cutover style, the acceptance test on the Monday is the same one: every tracking number in that day's `byTracking` map has a purchase order number, and every purchase order number resolves in the new system.

Whichever is chosen, the following belong in the plan:

- A rehearsal of **Kaitlyn's receiving workflow** before the flip. Every risk in this document points at it. Note that there are **two** human receiving paths, not one: run-orders auto-receives on the Amazon path into the virtual `Amazon Fulfillment` location, and Shopify pipeline Purchase Orders are received by hand into `Sechelt Warehouse` by warehouse staff. The sample PO-16701 is exactly that case, a Shopify pipeline Purchase Order sitting at `Complete` with a Movement Journal and `mm_Received_Location_Name__c = "Sechelt Warehouse"`. Both paths have to work on the Monday.
- A written rollback for the case where the answer on the Monday is no.
- A rehearsal of the accounts-payable exception scan, because it is what stops a wrong cheque.
- A dry-run switch that is genuinely inert. `DISABLE_CRON=1` exists and works, but it is not documented in `.env.example` and it does not gate the Telegram commands or the HTTP endpoints.
- A decision on whether the reconcile sweep goes live at cutover. It has been in shadow since July 2026, so Automayt would otherwise inherit the same gap the sweep was built to close.

### 8.6 Suggested test plan

Before any dual-write:

1. Authenticate from a bare Node script in three lines. Confirm the terminal-versus-transient error classification by sending bad credentials.
2. Create an item with a known-good payload; confirm the response returns the final name and description after any normalisation; confirm a duplicate name is reported, not silently accepted.
3. Create an item with no cost; confirm it is refused.
4. Create a Sales Order and two lines; confirm the number comes back on the create; confirm a back-dated order date is honoured.
5. Submit the same Sales Order twice; confirm the duplicate is rejected or the existing record is returned.
6. Create a Purchase Order with a tracking code; submit the same tracking code again; confirm rejection.
7. Create a two-line Purchase Order; receive line 1; **receive line 2 without touching the header status**; confirm both post and that the inventory transaction id comes back on each.
8. Receive the same line twice; confirm rejection or idempotency.
9. Query open purchase-order lines for a vendor; confirm a server-computed remaining quantity and confirm pagination past 2,000 rows.
10. Look up an item by `KERDIFIX/BW`, `KERDIFIXBW`, `kerdifixbw` and `KERDIFIX-BW`; confirm all four resolve to the same record.
11. Write a purchase-order line price that differs from the item cost; read it back; confirm the value stuck or that the response says it was derived.
12. Cancel a Sales Order; cancel it again; cancel one that does not exist. Confirm all three behave.
13. Pull the whole item master through the export endpoint and diff the row count against Salesforce.
14. Kill the connection mid-flow and confirm the client can tell "nothing was attempted" from "something may have been written".

Then a full-day replay of a real day's orders in the sandbox, compared record by record against what Salesforce produced that day.

---

## 9. PBSI and Salesforce behaviours: what to reproduce, what to drop

**Section 6 is the normative requirement list. This section is the rationale behind it**: the incident history, the reasoning and the "do not reproduce" list. Where the two differ in wording, section 6 governs. Anything here that reads as a requirement is also stated in section 6, including the three that used to live only here (freight as its own purchase order, positive-evidence-only exceptions, pre-tax over-billing comparison).

### 9.1 Must reproduce

1. **Receiving posts inventory atomically, or it is an error.** A receipt row without its inventory transaction looks fine and silently breaks packing, vendor invoicing and the QuickBooks sync. CFC lived that for two days in May 2026 and the accountant repaired it by hand. Expose receiving as an operation, return the transaction id, and make a non-posting receipt fail loudly.
2. **The demand link.** A drop-ship purchase order line points back at both the sales order and the specific sales order line that created it. That is the trace from a vendor purchase to the customer demand behind it, and CFC uses it. Keep it supported. Do not make it universally mandatory: replenishment lines have no customer sale.
3. **Cancel, never delete.** `Cancelled` is the established soft-delete on both order types and carries an audit trail.
4. **Fail-closed duplicate guards.** If the check cannot run, do not write. This is the single most valuable safety property in the current system.
5. **One parcel means one purchase order.** Tracking code is the identity of a physical shipment.
6. **Never write an area item's quantity in the wrong unit.** Convert, or refuse the line.
7. **Refuse an item with no cost.** A costless item is worse than a failed order, because it silently poisons every downstream margin number.
8. **Revenue routing that cannot fall to a dead account.** Whatever the mechanism, an item with no explicit revenue account must land somewhere live and intentional.
9. **Pre-tax comparison for over-billing.** Gross comparison flags every Ontario and Quebec shipment as fraud.
10. **Positive evidence only.** An exception fires on a tracking event, a payable row or a duplicate. Never on absence of data.
11. **The purchase order number format and stability** (section 4.19).
12. **Back-dated order dates**, and a way to know whether a posting date falls in a closed accounting period, so the reconcile sweep can stop using a client-side first-of-month heuristic.
13. **Freight as its own purchase order to the carrier's vendor account** (section 5.10).
14. **No automatic vendor email on purchase order creation.** This is the hard requirement in this list with the worst failure mode: a duplicate order at Prosol.

    What actually happens in Salesforce, measured rather than assumed (the full evidence and field-by-field detail is in section 3.3, "The vendor-notification control surface"): the vendor email is an **interactive, record-level action**, not a create-time trigger. Human-created purchase orders get one because a person sends them; pipeline-created ones do not because nobody presses the button, and because Prosol is told by run-orders' own email instead. Over the last 60 days, 373 of 936 purchase orders were sent, and **0 of the 375 pipeline Prosol purchase orders in that window were ever sent**.

    The trap is that the record does not say so. An active org Flow (`PO_Order_Desk_Contact`) stamps `Auto_Send_Itemized_PO__c = true` and `PBSI__Contact__c = 0034x00001u639QAAQ` (Prosol's "Order Desk", `order.burnaby@prosol.ca`) on **every** purchase order at create, including every machine-created one. A field literally labelled "Auto Send PO?" reads true on every pipeline purchase order in the org. If Automayt reads a flag of that shape and sends on create, every pipeline purchase order emails Prosol's Burnaby order desk on top of the email run-orders already sent, and Prosol ships the order twice.

    The requirement: **creating a purchase order must never notify anybody.** Sending is a separate, explicitly-invoked operation (`POST /v1/purchase-orders/{id}/send`, section 6.11.6), with `notify_vendor` defaulting to false on create and no configuration that changes that default. The create response echoes `vendor_notified` so the caller can assert it.

### 9.2 Must not reproduce

1. **Trigger-managed prices.** `PBSI__Price__c` on a purchase order line is silently overwritten from the item cost unless a second, undocumented field is written in the same operation. The price a caller sends must be the price stored, or the response must say otherwise. This cost a full debugging session and real money on a freight line.
2. **Receiving line 1 completing the whole purchase order and locking out the rest.** This produced six stuck purchase orders, a repair script, and a permanent workaround in the pipeline.
3. **`Closed` blocking payable creation**, or at least, do not make it the natural end state of an automated flow.
4. **Post-insert rewriting of what the caller wrote.** Org Flows rewrite the item name and the item description after insert, and rewrite the sales order's tax-exemption fields. If Automayt normalises a value, it must say so in the response.
5. **A boolean that rejects null but is documented nowhere.** A Salesforce Flow fails when the tax-exemption booleans arrive as null instead of false. Make required booleans actually required, and say so.
6. **Two identities that are both treated as primary.** Item name versus vendor code, both load-bearing, name not unique in practice, roughly 31 known duplicate pairs from historical separator stripping. Note carefully what this item does and does not ask for: **it does not ask for the item number to be discarded.** Section 3.5 sets out the decision in full. `vendor_code` becomes the primary key; `item_number` survives verbatim as a non-unique secondary identifier because three local stores outside Automayt key on it; the duplicate pairs migrate as they are and are reconciled from a report, not merged on import.
7. **Separator-sensitive lookups.** One canonical item per vendor code, matched separator-insensitively and case-insensitively, with the normalisation owned by the server rather than by four client-side spellings.
8. **Coverage encoded in a description string.** Give the item a numeric conversion factor.
9. **Deprecation encoded in a record name.** Three locations are marked out of service by appending " - DO NOT USE" to the name. Give locations an active flag.
10. **Picklist declarations that do not match the data.** Several status fields in this org hold values the picklist does not declare, including `AcctSeed__Status__c`, whose dominant value `Posted` (25,983 payables) is undeclared, and `AcctSeed__Payment_Status__c`, where two of the three live values are undeclared. Restrict the picklists, or publish the real domain. **Publish it complete**: the real payment-status domain is `Paid` 24,893, `Unpaid` 1,083 and `Partially Paid` 8, and `Unpaid` is the one every accounting-exception rule keys on. Section 3.10 has all of them with counts; section 6.10 has the two order-status domains run-orders needs.
11. **The 14-day rolling Amazon sales order.** CFC's own migration analysis calls the rolling-window matching a bug source, and the code carries a fallback that staples a mis-dated shipment onto the most recent order for someone to move by hand. If Automayt can date a purchase order from the actual ship date and handle Amazon settlement separately, the whole rolling-window mechanism disappears.
12. **A credit hold that automation has to clear on every run.**
13. **Silent truncation at 2,000 rows.**
14. **Errors with an empty message.** That is the proximate cause of the 12-duplicate-purchase-order incident.
15. **A named human's login as the integration identity.**
16. **`PBSI__Freight_Amount__c`.** Writable, feeds the total formula, never used in 14,382 purchase orders, and populating it breaks the three-way match.
17. **Channel encoded three different accidental ways, none of them usable.** On an FBA purchase order the channel is a free-text prefix inside the shipping instructions. On an ecommerce purchase order there are two platform-computed formulas that look like channel fields and are not: `Opportunity__c` derives a string from the Sales Order's house-account name (`Amazon.ca -` or `Shopify -`, and null on FBA because there is no Sales Order), and `mm_Amazon_or_Shopify__c` is a boolean that reads false on Shopify pipeline purchase orders and whose formula keys on the **first name of the creating user**. Section 3.3 has both formulas in full. So: a two-valued flag that does not have the two values you would expect, a derived string with no FBA value and no room for a fourth channel, and no external-reference field anywhere on the object. Give the purchase order a first-class `channel` enum and an `external_ref`, per section 6.3 and section 6.11.7.

### 9.3 Behaviours that are undecided, not settled

- Whether FBA replenishment purchase orders should ever be received and closed. Today they sit open forever and a 120-day aging rule papers over it.
- Whether the Sechelt self-fulfilment path should produce an inventory transfer. Today stock leaves the warehouse for Amazon and Salesforce never hears about it.
- Whether the purchase order should be created **before** the label is bought rather than after. Automayt is the opportunity to make that change, and it would enforce in code the standing rule that no order email goes out without a purchase order on it.

---

## 10. Open questions

### 10.1 For Doug and the Automayt engineering team

1. **Historical migration.** CFC's working assumption is that everything moves. Volumes are in section 7 and the field inventory is in Appendix A. Is a full-history migration in scope, or should CFC plan for open-plus-recent with Salesforce frozen read-only for a reporting window? What does each cost?
2. **Cutover style.** Parallel run with dual writes, hard switch with a sandbox rehearsal, or read-only shadow then switch? If dual-write, which system mints the purchase order number that goes on the vendor email, given that number leaves the building within seconds of creation?
3. **Numbering continuity.** Does Automayt continue the `PO-16xxx` and `SO-025xxx` sequences with the same shape? If not, see section 4.19: the format is a hard contract with Prosol's ordering API, with inbound vendor email routing, with Amazon shipment names and with an open chargeback ledger.
4. **Does create return the human-readable document number in the create response?** If not, CFC keeps a follow-up read on every create and the Prosol direct-order path becomes unsafe.
5. **Idempotency.** Can `customer_purchase_order` on a sales order and `tracking_code` on a purchase order be unique or external-id columns, or can writes accept an idempotency key? Without it, the client keeps a read-then-write guard that is racy by construction.
6. **Atomic writes.** Can a sales order header plus all its lines plus a purchase order plus all its lines be created in one transaction? Today a failure halfway through leaves records that nothing cleans up.
7. **Receiving.** Is there a single atomic receive that posts inventory and returns the transaction id? Does receiving one line of a multi-line purchase order lock out the others? Can a whole purchase order be received in one call?
8. **Purchase-order line price.** Is the price caller-authoritative, or derived from the item master? This needs an explicit answer, not a discovery.
9. **Item identity.** CFC's requirement is stated in full in section 3.5 and is not open: `vendor_code` is the primary key and is unique; `item_number` survives verbatim as a non-unique secondary identifier; aliases are first-class so the four-spelling ladder collapses to one call. The questions for Doug are narrower. Can Automayt hold a unique key and a non-unique secondary identifier on the same record? Can it return more than one row from an item-number lookup and say so? And on import, what does it do with the roughly 31 vendor-code duplicate pairs, given that CFC needs them reported rather than merged?
10. **Unit of measure and conversion.** Does an item carry a unit of measure plus a numeric conversion factor, **per unit of measure rather than square-foot-only**, so quantity conversion happens server-side? Section 5.9 has the behaviour to absorb and the live gap on 2,141 `SqYd` and `LnFt` items that the current implementation does not cover.
11. **Status vocabularies.** CFC has stated its requirement rather than asking: section 6.10 lists the minimum vocabulary for both objects, with counts, and the transitions that have to be legal. The questions for Doug are: can Automayt express that vocabulary and those transitions, what does it call the values, does it advance a purchase order's status by itself on full receipt, and if so does the value it advances to still accept receipts? The two answers CFC needs a yes on are that a completed purchase order still accepts receipts, and that no automated flow ever lands an order in a state that blocks payables.
12. **A first-class channel or source field on the purchase order**, plus an external reference, so the free-text memo marker can be retired?
13. **Record ownership.** Is there an owner or a created-by-integration attribute that can be filtered? It is the only thing separating CFC's ecommerce purchasing from the rest of its purchasing in the same system.
14. **Payables.** Does Automayt own payables and payment status, or does that stay in QuickBooks? If it stays, what replaces the payable-to-purchase-order bridge field, and who serves it? Can one purchase order carry several payables, which is how double billing is detected today?
15. **QuickBooks.** Does Automayt sync to QuickBooks directly, and is the goods receipt still the event that makes stock invoiceable?
16. **Notes with real mentions.** Is there a per-record comment stream that actually notifies named users? If not, the "do not pay" workflow becomes email and the dedupe key moves with it.
17. **Purchase order PDF.** Is there `GET /purchase-orders/{id}/pdf`? And does creating a purchase order trigger any automatic vendor email (it must not, by default)?
18. **The general query surface.** One parameterised read API with filtering, traversal, aggregates and introspection, or a fixed endpoint list? What is the IN-list ceiling, and does the API page internally?
19. **Schema introspection.** Is there an endpoint exposing field type, writability, formula-ness and picklist values? Without it, CFC's defensive tooling cannot be ported and the migration cannot be validated.
20. **Auth model.** API key, OAuth client credentials, or JWT? Token lifetime and refresh? Any IP allow-list or MFA on the API path? What are the rate limits, the concurrent-session limit, and the lockout or bot-detection behaviour, and what does a lockout return so a client can tell it from a wrong password?
21. **Is there a sandbox**, reachable by changing one base-URL variable, with separate credentials? Without one there is no way to rehearse the cutover.
22. **Locations.** Does Automayt model a location on a receipt, and can a **virtual** location exist that accepts receipts but is not a physical warehouse? The auto-receive-at-label-purchase policy depends on it.
23. **Special-order restriction.** Is there an equivalent of an item status that blocks a purchase order line without a linked sales order?
24. **Delete semantics.** Is delete permitted at all, does deleting a purchase order cascade to its lines, and is there an audit trail? Should a destructive administrative operation require an explicit approval or reason field in the system rather than a comment in a script?
25. **Webhooks or change events.** If Automayt can push order and purchase-order changes, the reconcile sweep and parts of the health check retire.
26. **Field-name case sensitivity.** Three live queries spell the item description field with the wrong capitalisation and work today because SOQL is case-insensitive. If Automayt is case-sensitive, say so now.
27. **Who migrates the open purchase orders**, and when relative to 2026-10-09?

### 10.2 For Mac

1. **Repository access for Doug's team.** Undecided. This document is written to be self-contained either way, but if access is granted the file and line citations become directly usable.
2. **Does Automayt do the books?** The receipt to movement journal to billing line to GL posting to QuickBooks chain is entirely inside Salesforce today. If Automayt replaces PBSI but AcctSeed or QuickBooks stays, the payables join and the revenue GL routing need an owner.
3. **Does Kaitlyn receive in Automayt?** Every risk in this document points at her workflow. Who trains her, and on what date relative to the cutover?
4. **Should FBA replenishment purchase orders be received and closed in the new system?** Today they sit open forever, Salesforce inventory never reflects FBA stock, and a 120-day aging rule papers over it.
5. **Should the Sechelt self-fulfilment path produce a record at all?** Today stock physically leaves Sechelt for Amazon and nothing books it.
6. **Should the `pos` phase stay after the `buy` phase?** Moving purchase order creation before the label buy would make the "PO: N/A" case impossible and would enforce in code the standing rule that no order email goes out without a purchase order.
7. **Should the Shopify reconcile sweep go live at cutover?** It has been reporting only since July 2026. If it stays in shadow, Automayt inherits the same gap it was built to close. And the seven May and June orders it identified still need a dating decision from Lynnae before they are back-filled.
8. **Coverage data, and it is now two decisions not one.** (a) Zero sku-map entries carry `coverage_sqft` today, so every area conversion depends on parsing a description string that the org Flow `Item_Master_Description_Updated` rewrites. Should coverage move into the map, or into Automayt's item record, before cutover? Automayt's item record is the better home and section 6.5 asks for the field, but somebody has to populate roughly 4,900 square-foot items, and the only mechanical source available is the same regex over the same descriptions. (b) `SqYd` (1,842 items) and `LnFt` (299 items) are **not converted at all** today, because `AREA_UOMS` in `lib/pbsi-uom.js` holds only seven square-foot spellings. That is the same 134-times-too-small error class, live, on 2,141 items, unexercised only because those items are not sold on Amazon or Shopify yet. Fix it in run-orders now, or specify the factor per unit of measure in Automayt and fix it once at cutover?
9. **The dashboard "Create POs for Shipped Orders" button uses a 7-day lookback while the cron uses 2 days**, and it does not take the pipeline lock. Intentional? It is the widest duplicate window in the system.
10. **The Telegram one-click approval link** creates a purchase order and emails a vendor from an unauthenticated URL, and bypasses the budget guards and the bucket split. Should that change at cutover?
11. **The `/claude` Telegram surface** runs a coding agent with the repository as its working directory and full credentials in the environment. After cutover it will hold Automayt credentials. Does it need a scoped identity separate from the pipeline's?
12. **Which tax code is which. Answered, and one of the answers needs an accounting decision.** Read from the live org on 2026-09-09 and now in section 5.3: `a1S4x000002pMUhEAM` is `Exempt` at 0 percent (written on the Amazon Sales Order, which is correct), `a1S4x000002QmjbEAC` is `GST/PST - BC` at 12 percent (written on every auto-created item, which is correct), and `a1S4x000002oCP0EAM` is `GST` at 5 percent, whose own description in the org reads "used for tax on Labour ONLY". That third one is stamped by the org Flow `PO_Default_Values` on **every purchase order in the org**, goods and labour alike, including all four sampled pipeline purchase orders. Question for Lynnae rather than for Doug: is a labour-only 5 percent code the right thing on a goods purchase order, and should the migration carry it forward or correct it?
13. **The purchase-order line price question is now answered and it changes a number.** Live data confirms PBSI overwrites the price the pipeline sends on a Shopify purchase order line with the item cost. Shopify purchase orders are therefore recorded at cost, not at retail, which is correct, but by accident. Should Automayt take an explicit unit cost on that line so it is correct on purpose?
14. **Direct Prosol ordering.** The module that places orders on Prosol's storefront instead of emailing a purchase order is written, validated and dark. Is it in or out for the Automayt era? It is the one place the purchase order number is a hard input to a foreign system.
15. **`Date_Received__c`, `Date_Invoiced__c`, `Count_Payables__c`, `mm_Claim__c` and the two QuickBooks flags are read only by throwaway forensic scripts, never by the pipeline.** Do they need to exist in Automayt, or were they conveniences of this org?
16. **`docs/ORDER-PREP.md` line 276 contains a plaintext SMTP password** for `hello@yourfloors.ca`, in a repository with a remote. Rotate it before any of these documents are shared outside CFC.

---

## Appendix A. Complete field inventory per object

Legend for each bullet: field API name, then Salesforce type, then how run-orders uses it (WRITE-CREATE, WRITE-UPDATE, READ, or FILTER meaning it appears only in a WHERE clause), then CALCULATED where the describe reports `calculated = true`, then notes.

### A.1 `PBSI__PBSI_Sales_Order__c` (Sales Order, 231 fields total, 26 referenced)

- `Id` - id - READ. Not createable, not updateable.
- `Name` - string 80 - READ. Trigger-assigned autonumber, format `SO-######`. Not createable, not updateable.
- `PBSI__Customer__c` - reference to Account - WRITE-CREATE, FILTER. The channel house account.
- `PBSI__Contact__c` - reference to Contact - WRITE-CREATE, Shopify only and only when matched.
- `PBSI__Status__c` - picklist - WRITE-CREATE (`Open`), READ, and WRITE-UPDATE (`Cancelled`) in the undocumented ad-hoc path. Domain: Open (default), Partially Complete, Closed, In Progress, Cancelled, Packed, Staged.
- `PBSI__Order_Date__c` - date, nillable=false - WRITE-CREATE, READ. Must accept back-dating.
- `PBSI__Customer_Purchase_Order__c` - string 100 - WRITE-CREATE, READ, FILTER. **The dedupe key.** Not unique in the schema.
- `PBSI__Tax_Code__c` - reference to `PBSI__Tax_Code__c` - WRITE-CREATE on the Amazon path only.
- `mm_Exempt_GST__c` - boolean, nillable=false - WRITE-CREATE. Amazon true, Shopify false.
- `mm_Exempt_PST__c` - boolean, nillable=false - WRITE-CREATE. Same split.
- `mm_Exempt_GST_ID__c` - string 255 - WRITE-CREATE. `Third Party Amazon` or empty string.
- `mm_Exempt_PST_ID__c` - string 255 - WRITE-CREATE. Same.
- `PBSI__BOL_Description__c` - string 100 - WRITE-CREATE on the Amazon path, literal `None`.
- `PBSI__Order_Total__c` - currency 18.2 - READ - CALCULATED roll-up.
- `PBSI__Final_Order_Total__c` - currency 18.2 - READ - CALCULATED formula. **Revenue truth.**
- `CFC_Stage__c` - string 1300 - READ - CALCULATED formula. Not groupable.
- `PBSI__Stage__c` - picklist - READ. Domain declared Open, Packed, Waiting Pick Up, On Route, Delivered. Real data also contains Partially Packed, Staged, Cancelled.
- `Billing_Stage__c` - READ in ad-hoc work.
- `CreatedDate` - datetime - READ, FILTER (`LAST_N_DAYS`).
- `CreatedBy.Name` - traversal - READ. Displayed to the operator on a duplicate hit.
- `LastModifiedDate` - datetime - READ.
- `OwnerId` - reference - READ.
- `PBSI__Type__c` - picklist - READ. Domain Standard (default), Scheduled.
- `PBSI__Sales_Tax__c` - percent 6.3 - READ in freight forensics.
- `Ascent2QB__QB_Needs_Update__c` - boolean - READ in forensics.
- `Count_Payables__c` - double - READ in forensics.

### A.2 `PBSI__PBSI_Sales_Order_Line__c` (Sales Order Line, 249 fields total, 22 referenced)

- `Id` - id - READ.
- `Name` - string 80 - READ. Autonumber, plain numeric.
- `PBSI__Sales_Order__c` - reference, **nillable=false, createable=true, updateable=false** (master-detail) - WRITE-CREATE, FILTER.
- `PBSI__Item__c` - reference to Item - WRITE-CREATE, READ.
- `PBSI__Quantity__c` - double 18.0 - WRITE-CREATE, READ.
- `PBSI__Quantity_Needed__c` - double 18.6, nillable=false - WRITE-CREATE, READ. Always equal to quantity.
- `PBSI__Price__c` - currency 18.2, labelled Unit Price - WRITE-CREATE, READ.
- `PBSI__Total_Price__c` - currency 18.2 - READ - CALCULATED formula.
- `PBSI__Item_Cost__c` - currency 18.4 - READ.
- `PBSI__Item__r.Name`, `.PBSI__Description__c`, `.PBSI__Vendor_Item_ID__c`, `.PBSI__Default_Vendor_Name__c` - traversals - READ.
- `CreatedDate`, `LastModifiedDate` - READ.

Note: `PBSI__Unit_Price__c` and `PBSI__Total__c` appear in CFC's 2026-04 hand-written field map and are written nowhere in the code.

### A.3 `PBSI__PBSI_Purchase_Order__c` (Purchase Order, 119 fields total, 29 referenced)

- `Id` - id - READ.
- `Name` - string 80 - READ. Trigger-assigned autonumber, format `PO-#####`. **Contract, see 4.19.**
- `PBSI__Account__c` - reference to Account - WRITE-CREATE, READ, FILTER. **The vendor.**
- `PBSI__Order_Date__c` - date, nillable=false - WRITE-CREATE, READ, FILTER.
- `PBSI__Status__c` - picklist - WRITE-CREATE (`Open`), WRITE-UPDATE (`Open` to reopen), READ, FILTER. Domain: Open (default), Partially Complete, Not ordered, Ordered, Received, Vendor Invoiced, Paid, Complete, Closed, Cancelled.
- `PBSI__Shipping_Instructions__c` - textarea 255 - WRITE-CREATE. The channel marker and the human cross-reference.
- `PBSI__Tracking_Code__c` - string 50 - WRITE-CREATE, READ, FILTER, GROUP BY. **The dedupe key.**
- `PBSI__Sales_Order__c` - reference to Sales Order - READ, FILTER. **Not written by run-orders**; a trigger stamps it.
- `PBSI__Movement_Journal__c` - **string 20, not a reference** - READ. Holds an inventory-transaction id. The receipt canary.
- `PBSI__Order_Total__c` - currency 18.2 - READ - CALCULATED roll-up.
- `PBSI__Final_Order_Total__c` - currency 18.2 - READ - CALCULATED formula.
- `PBSI__Sales_Tax__c` - percent 6.3 - READ. Writable. Set to 0 on freight purchase orders.
- `PBSI__Freight_Amount__c` - currency 18.2 - READ only, in forensics. Writable. **Never populate.**
- `PO_Number__c` - string 1300 - READ - CALCULATED formula. Selected once, never consumed.
- `ETA_Date__c` - date, writable - not read by run-orders. Listed because it is the only real expected-date field on the object and because it is an input to the `CFC_Stage__c` formula.
- `PBSI__Date_Sent__c` - date, writable - not read by run-orders. **Null on every pipeline Purchase Order.** The record that a Purchase Order was sent to the vendor. See section 3.3.
- `Auto_Send_Itemized_PO__c` - boolean, `nillable=false`, default `false`, writable - not written by run-orders. Set to `true` by the org Flow `PO_Order_Desk_Contact` on every create. Label "Auto Send PO?". **The single most dangerous field to reproduce naively.**
- `PBSI__Contact__c` - reference to Contact, writable - not written by run-orders. Stamped by the same Flow to the vendor account's "Order Desk" contact, `0034x00001u639QAAQ` for Prosol.
- `mm_Send_Email__c` - boolean, `nillable=false`, default `false`, writable - not written by run-orders. Set to `true` by the org Flow `received_po_line_date_update_on_po` when a receipt is created. Not the send gate.
- `mm_Do_not_send_email_notification__c` - boolean, `nillable=false` - READ-adjacent only - CALCULATED formula `PBSI__Account__r.mm_Do_not_send_email_notification__c`. A vendor-account opt-out mirrored onto the order. `false` on Prosol.
- `mm_PO_pdf_created__c` - boolean, default `false`, writable - not written by run-orders.
- `Opportunity__c` - string 1300 - CALCULATED formula, label "Job Name". `Amazon.ca -` on Amazon Purchase Orders, `Shopify -` on Shopify ones, null on FBA. See "Channel markers", section 3.3.
- `mm_Amazon_or_Shopify__c` - boolean - CALCULATED formula. `true` on Amazon Purchase Orders, `false` on Shopify pipeline ones. Not a channel field. See section 3.3.
- `mm_Account_Number__c` - string 1300 - CALCULATED formula `PBSI__Account__r.mm_Account_Number__c`. `55010180` on every Prosol Purchase Order: CFC's customer number inside Prosol's system.
- `Can_be_deleted__c` - boolean, `nillable=false`, default `false`, writable - advisory, nothing in run-orders reads it.
- `mm_Allow_Delete__c` - boolean, `nillable=false`, default `false`, writable - the bypass on the delete-prevention Flow. See section 4.17.
- `PBSI__hasMJ__c` - double, writable, not calculated - 1 when a Movement Journal is attached, 0 when not. A cleaner "did inventory post" signal than the string id.
- `PBSI__Account__r.Name` - traversal - READ, FILTER (`LIKE '%rosol%'`).

**Field names probed by `scripts/ops/po-lookup.js` and confirmed NOT to exist on this object:** `PBSI__Expected_Date__c`, `PBSI__Notes__c`, `PBSI__Reference__c`, and any `PBSI__Ship_To_Location__c` reference (so `PBSI__Ship_To_Location__r.Name` cannot resolve either). All four are named in the wanted list at `po-lookup.js:92-93` and stripped by `usableFields()` at `:21-31` before the query is built, so they never reach a query and their print statements at `:126`, `:128` and `:131` always render the fallback. **Do not build them.** Earlier CFC notes listed all four as real fields; that was wrong.
- `PBSI__Type__c` - picklist - READ. Domain Standard (default), Drop Ship, Contract Manufacturing.
- `Received_Location__c` - reference to Location - READ. Writable per schema, Flow-stamped in practice.
- `Date_Received__c` - date - READ. Writable per schema, Flow-stamped in practice.
- `mm_Received_Location_Name__c` - string 1300 - READ - CALCULATED formula. Sample value `Amazon Fulfillment`. An API write returns `INVALID_FIELD_FOR_INSERT_UPDATE`.
- `CFC_Stage__c` - string 1300 - READ, FILTER - CALCULATED formula. A formula has no picklist, so the domain is read out of the expression rather than declared: `Invoiced`, `Received`, `Partially Received`, `Confirmed`, `Sent`, `New`. Six values, full formula in section 4.4. Observed live: `New` on PO-16785 and PO-16683, `Received` on PO-16839 and PO-16701.
- `Date_Invoiced__c` - date - READ in forensics only.
- `Count_Payables__c` - double - READ in forensics only.
- `mm_Claim__c` - boolean - READ in forensics only.
- `Ascent2QB__QB_Purchase_Order_ID__c` - string 100 - READ in forensics. "Is this in QuickBooks yet."
- `Ascent2QB__QB_Needs_Update__c` - boolean - READ in forensics.
- `CreatedDate`, `LastModifiedDate`, `CreatedBy.Name`, `OwnerId`, `Owner.Name` - READ, and `OwnerId` is the filter on the financial report.

### A.4 `PBSI__PBSI_Purchase_Order_Line__c` (Purchase Order Line, 105 fields total, 25 referenced)

- `Id` - id - READ.
- `Name` - string 80 - READ. Autonumber.
- `PBSI__Purchase_Order__c` - reference, **nillable=false, createable=true, updateable=false** (master-detail) - WRITE-CREATE, FILTER.
- `PBSI__Item__c` - reference to Item - WRITE-CREATE, READ, FILTER.
- `PBSI__Quantity_Ordered__c` - double 18.6, **nillable=false** - WRITE-CREATE, READ. Decimals are normal.
- `PBSI__Price__c` - currency 18.2 - WRITE-CREATE, READ. **Trigger-managed: the sent value is discarded unless `PBSI__Price4__c` is written with it.**
- `PBSI__Price4__c` - currency - not written today. The trigger's source of truth.
- `PBSI__Sales_Order__c` - reference, labelled Drop Ship SO - WRITE-CREATE on order flows, absent on replenishment.
- `PBSI__Original_SO_Line__c` - reference to Sales Order Line - WRITE-CREATE on order flows, absent on replenishment.
- `PBSI__Quantity_Received__c` - double 18.6 - READ. Writable per schema.
- `PBSI__Quantity_Left_To_Receive__c` - double 18.6 - READ - CALCULATED formula.
- `PBSI__Vendor_Item_ID__c` - string 255 - READ, FILTER. A copy of the vendor code on the line.
- `PBSI__Item_Cost__c` - currency 18.2 - READ - CALCULATED formula.
- `PBSI__Total_Price__c` - currency 18.2 - READ - CALCULATED formula.
- `PBSI__Pre_Tax_Total_Price__c` - currency 18.2 - READ - CALCULATED formula.
- `PBSI__ItemDescription__c` - textarea 255 - READ. Writable.
- `PBSI__PO_Line_Item_Description__c` - string 1300 - READ - CALCULATED formula.
- `PBSI__Status__c` - picklist - READ. Domain Open (default), Pending, Received.
- `PBSI__Purchase_Order__r.*` traversals to Name, status, order date, created date, and `PBSI__Account__r.Name` - READ and FILTER.
- `PBSI__Item__r.Name`, `.PBSI__Vendor_Item_ID__c`, `.PBSI__Description__c` - traversals - READ.
- `CreatedDate`, `LastModifiedDate` - READ.

**Field names probed by `scripts/ops/po-lookup.js` and confirmed NOT to exist on this object:** `PBSI__Received_Quantity__c` and `PBSI__Qty_Received__c` (`:98`, `:100`), plus `PBSI__Quantity__c`, `PBSI__Line_Total__c` and `PBSI__Quantity_Outstanding__c` (`:98`, `:100`). All five are stripped by `usableFields()` before the query runs. The consequence is worth recording so the replacement tooling does not copy it: because `PBSI__Quantity__c` does not exist on the line, the inspector's quantity column at `:139` always prints 0, and because `PBSI__Line_Total__c` does not exist either, the extended-price column at `:141` always falls back to quantity times price and therefore always prints zero dollars. **Both columns in the purchase-order inspector are dead.** The real names for those three concepts are `PBSI__Quantity_Ordered__c`, `PBSI__Total_Price__c` and `PBSI__Total_Unit_Qty_Left_To_Receive__c`.

### A.5 `PBSI__PBSI_Item__c` (Item, 270 fields total, 45 referenced)

Written on create:

- `Name` - string 80 - WRITE-CREATE, READ, FILTER. **Mandatory in practice; overwritten post-insert by an autonumber Flow.** Not unique in practice.
- `PBSI__description__c` - textarea 255, **nillable=false** - WRITE-CREATE, READ, FILTER. **Rewritten post-insert by a Flow into the house format.** Note the lowercase d.
- `PBSI__Vendor_Item_ID__c` - string 30 - WRITE-CREATE, READ, FILTER. **The primary lookup key.**
- `PBSI__Default_Vendor__c` - reference to Account - WRITE-CREATE.
- `PBSI__Default_Location__c` - reference to Location - WRITE-CREATE.
- `PBSI__Item_Group__c` - reference to Item Group - WRITE-CREATE.
- `PBSI__defaultunitofmeasure__c` - string 255, **nillable=false** - WRITE-CREATE (`EA`), READ. Free text, 17 distinct real values including three spellings of linear feet (`LnFt` 299, `Lft` 1, `LF` 1) and three of square yards (`SqYd` 1,842, `SY` 2, `sq yrds` 1). Full distribution in section 3.5.
- `Unit_of_Measure__c` - picklist, RESTRICTED, domain SqFt, EA, SqYd, LnFt - WRITE-CREATE (`EA`), READ.
- `PBSI__Item_Status__c` - picklist, domain Active (default), Inactive - WRITE-CREATE (`Active`).
- `PBSI__Item_Type__c` - picklist, domain Item (default), BOM - WRITE-CREATE (`Item`).
- `PBSI__Cost_Type__c` - picklist, domain Average Cost, Last Cost, Standard Cost (default) - WRITE-CREATE (`Standard Cost`).
- `PBSI__Coverage_Code__c` - picklist, domain Min/Max (default), Requirement, Manual - WRITE-CREATE (`Min/Max`).
- `PBSI__Lot_Tracking__c` - boolean, nillable=false - WRITE-CREATE (true).
- `PBSI__No_Lot_Expiration__c` - boolean, nillable=false - WRITE-CREATE (true).
- `PBSI__Taxable__c` - boolean, nillable=false - WRITE-CREATE (true).
- `PBSI__Tax_Code__c` - reference - WRITE-CREATE (`a1S4x000002QmjbEAC`).
- `PBSI__Cost__c` - double 18.2 - WRITE-CREATE, READ. **The number all cost of goods uses.**
- `PBSI__purchaseprice__c` - double 11.2, labelled Last Purchase Price - WRITE-CREATE.
- `mm_Landed_Cost__c` - double 18.2, **nillable=false** - WRITE-CREATE. The reason a costless item cannot be created.
- `PBSI__salesprice__c` - double 11.2, labelled Retail Price - WRITE-CREATE when known, READ.
- `mm_Original_Retail_Price__c` - currency 18.2 - WRITE-CREATE when known.
- `PBSI__UPC_Code__c` - string 30 - WRITE-CREATE when the barcode is 8 to 14 digits.
- `Manufacturer__c` - string 255 - WRITE-CREATE. **Free text**, not a picklist.
- `Original_Style_Name__c` - string 255 - WRITE-CREATE, READ.
- `Color__c` - string 255 - WRITE-CREATE.
- `Size__c` - string 255 - WRITE-CREATE.

Read only:

- `Id` - READ.
- `PBSI__Available_to_Promise__c` - double 18.6 - READ - CALCULATED formula. **Stock truth. Can be negative.**
- `Box_Quantity__c` - double 18.2 - READ. Square feet or units per carton.
- `PBSI__Not_Available_For_Sale__c` - boolean, nillable=false - READ. Hard kill flag, tested with strict identity.
- `AscentBTO__Stock_Status__c` - picklist, RESTRICTED, domain Discontinued, Special Order, Stock, Labour - READ. The literal `Stock` is load-bearing.
- `Stock_Status__c` - picklist, RESTRICTED, marked Deprecated in its label - not used.
- `PBSI__Default_Vendor_Name__c` - string 1300 - READ - CALCULATED formula. Selected in two lookups and never consumed; it is the field a vendor-aware purchase-order gate would use.
- `Item_Group_Name__c` - string 1300 - READ, FILTER - CALCULATED formula.
- `PBSI__Product__c` - reference to Product2 - READ. The companion product, created asynchronously.
- `PBSI__Is_Service__c` - boolean - READ in freight forensics.
- `PBSI__Quantity_on_Hand__c` and `PBSI__Quantity_on_Hand_Not_Counted__c` - double - **not read by run-orders**, listed only because a migration scoping exercise will look for an item-level on-hand figure and these are the two real fields. run-orders reads `PBSI__Available_to_Promise__c` instead, which is the correct stock truth. There is no `PBSI__Qoh__c` on this object; that field lives on `PBSI__Received_Purchase_Order_Line__c` and is listed correctly in A.7.
- `PBSI__Average_Cost__c`, `PBSI__Last_Cost__c`, `PBSI__Standard_Cost__c` - probed by the data-inventory script.
- `Ascent_FPL__Expense_GL_Account__r.Name` - traversal - READ in freight forensics. The only place an expense GL appears.
- `PBSI__Tax_Code__r.Name` - traversal - READ in freight forensics.
- `CreatedDate`, `LastModifiedDate` - READ.

### A.6 `PBSI__PBSI_Location__c` (Location, 53 fields, 7 referenced)

- `Id` - READ. `Name` - string 80, writable - READ. `PBSI__description__c` - string 100 - READ. `PBSI__Account__c` - reference - READ. `CreatedDate`, `LastModifiedDate`, `OwnerId` - READ.
- No active flag and no type field exist. See section 3.6.

### A.7 `PBSI__Received_Purchase_Order_Line__c` (Received Purchase Order Line, 78 fields, 15 referenced)

Written, but **only through the invocable action**:

- `PBSI__Purchase_Order__c` - reference - WRITE-CREATE, FILTER.
- `PBSI__Purchase_Order_Line__c` - reference - WRITE-CREATE.
- `PBSI__Item__c` - reference - WRITE-CREATE.
- `PBSI__Location__c` - reference - WRITE-CREATE, READ, FILTER.
- `PBSI__Quantity_Received__c` - double 18.6 - WRITE-CREATE, READ.
- `PBSI__Receiving_Date__c` - date - WRITE-CREATE, READ.
- `PBSI__Price__c` - currency 18.2 - WRITE-CREATE, READ.
- `PBSI__Type__c` - picklist, domain receive (default), credit, reverse poline - WRITE-CREATE (`receive`).

Read or observed on the resulting record: `Name` (autonumber), `PBSI__Cost__c`, `PBSI__Landed_Price__c`, `PBSI__Total_Received_Price__c`, `PBSI__Qoh__c`, `PBSI__Quantity_Invoiced__c`, `PBSI__Quantity_Left_to_Invoice__c`, `PBSI__Lot__c`, `PBSI__PO_Name__c`, `mm_Line_Desc__c`, `Ascent2QB__QB_Needs_Update__c`, `PBSI__Location__r.Name`.

### A.8 `PBSI__Movement_Journal__c` and `PBSI__Movement_Line__c`

Never written by run-orders. The journal is read only as an id held on the Purchase Order. Journal `PBSI__Type__c` is a 25-value picklist; the relevant values are `Goods Receipt for Purchase Order` and its reversal. Movement Line has `PBSI__Movement_Journal__c` as a nillable=false, non-updateable master-detail reference, plus references to item, purchase order line and received purchase order line.

### A.9 `Account`

- `Id`, `Name` - READ, FILTER (partial-name match).
- `mm_On_Hold__c` - boolean, nillable=false - **WRITE-UPDATE (false)**. The only Account field run-orders writes.
- `Type` - picklist, domain Customer, Prospect (default), Vendor, Other - READ.
- `Sub_Type__c` - picklist, domain Retail Customer, Contractor, Designer, Vendor, Installer, Flooring Vendor - relevant for analysis, not written.
- `Phone`, `Description`, `ParentId`, `OwnerId`, `CreatedDate` - READ in ad-hoc work.
- Record types: Business Account (default), Person Account.

### A.10 `Contact`

- `Id`, `Name`, `Email`, `Phone`, `AccountId` - READ only, one query, by email, limit 1.
- `LastName` is the only field required on create. run-orders never creates a Contact.

### A.11 `Product2`

- `Id` - READ.
- `AcctSeed__Revenue_GL_Account__c` - reference to `AcctSeed__GL_Account__c` - READ and **WRITE-UPDATE** to `a6Q4x0000000sr4EAA`.
- `Name` - string 255, nillable=false - never written by run-orders. Product2 rows are created by a trigger.
- `AcctSeed__Inventory_Type__c` - picklist, domain Purchased, Manufactured, Kit - relevant because four validation rules only fire when it is `Purchased`.
- `AcctSeed__Accounting_Type__c` - picklist, domain Taxable Product, Tax Exempt Product, Tax Rate.

### A.12 `PBSI__Vendor_Invoice__c` (213 records, investigated and rejected as payment truth)

- `Id`, `Name`, `PBSI__Status__c` (Open default, Complete, Closed, Voided), `PBSI__Payment_Status__c` (Open default, Partially Paid, Paid, Past Due), `PBSI__Amount_Paid__c`, `PBSI__Purchase_Order__c`, `PBSI__Total__c` (CALCULATED), `CreatedDate` - all READ only.

### A.13 `AcctSeed__Account_Payable__c` and `AcctSeed__Account_Payable_Line__c`

Payable, all READ only:

- `Id`, `Name` (autonumber `AP-#####`).
- `A2AS__Purchase_Order__c` - reference to Purchase Order. **The bridge. Not always populated.**
- `AcctSeed__Vendor__c` - reference to Account - FILTER.
- `AcctSeed__Date__c` - date, nillable=false - READ, FILTER, and used with `CALENDAR_YEAR()`.
- `AcctSeed__Total__c` - CALCULATED roll-up.
- `AcctSeed__Sub_Total__c` - CALCULATED formula. **Pre-tax. The over-billing comparison uses this.**
- `AcctSeed__Paid_Amount__c` - CALCULATED roll-up.
- `AcctSeed__Balance__c` - CALCULATED formula - READ, FILTER (`> 0`).
- `AcctSeed__Payment_Status__c` - picklist declaring only `Unpaid`. Real data, all three values: `Paid` 24,893 (undeclared), `Unpaid` 1,083 (declared), `Partially Paid` 8 (undeclared). **`Unpaid` is the value every accounting-exception rule filters on.**
- `AcctSeed__Status__c` - picklist declaring `In Process` and `Approved`. Real data: `Posted` 25,983 (undeclared) and `Approved` 1 (declared). `In Process` is unused. Payables reach `Posted` through the org Flow `Payable_on_Create_Auto_Post`.

Payable Line, all READ only: `Name`, `AcctSeed__Account_Payable__c` (nillable=false, updateable=false), `AcctSeed__Quantity__c`, `AcctSeed__Unit_Cost__c`, `AcctSeed__Amount__c`, `AcctSeed__Product__r.Name`, `AcctSeed__Sub_Total__c`. Also present and relevant to tax: `AcctSeed__Tax_Rate__c`, `AcctSeed__Combined_Tax_Rate__c`, `AcctSeed__Tax_Amount__c`.

**There is no `AcctSeed__Rate__c` on this object.** The unit-price field is `AcctSeed__Unit_Cost__c`, and it is written by the org Flow `Mamoon_Update_PO_cost_on_POL` from the goods receipt's `PBSI__Landed_Price4__c`, not from the vendor invoice. Earlier CFC notes named `AcctSeed__Rate__c`; the one script that selects it (`scripts/ops/_tmp-sf-payable-link.js:17`) fails with `INVALID_FIELD` and has never returned a row.

### A.14 `User`, `FeedItem` and file objects

- `User`: `Id`, `Name`, `Email`, `Username`, `Title`, `Profile.Name`, `IsActive` (FILTER only), `LastLoginDate` - READ. Plus `UserLogin.IsFrozen` and `.IsPasswordLocked` - WRITE-UPDATE in a one-shot admin script, and a password set through a REST sub-resource.
- `FeedItem`: `Id`, `ParentId`, `Type`, `Body`, `CreatedDate`, `CreatedBy.Name` - READ, filtered on `Parent.Type`. Written through the Connect API, not as an sObject.
- `EmailMessage`: `Id`, `Subject`, `ToAddress`, `FromAddress`, `MessageDate`, `HasAttachment`, `RelatedToId` - READ.
- `ContentDocumentLink`, `ContentVersion` (`VersionData` for the binary), `ContentDocument`, `Attachment`, `ApexPage` - READ, in the purchase-order PDF hunt.

---

## Appendix B. Complete SOQL inventory

Every query on a scheduled or operator-facing path, plus a representative sample of the forensic long tail, verbatim or as its template, with the file and line and its purpose. Interpolated values are shown in angle brackets.

**What this appendix does not contain.** Roughly 23 further one-off forensic scripts under `scripts/ops/_tmp-*.js` carry a single bespoke query each and are cited nowhere in this document: `_tmp-billed-vs-refunded`, `_tmp-claim-triage`, `_tmp-dupe-verdict`, `_tmp-fetch-printpo`, `_tmp-orphan-po-check`, `_tmp-po-emails`, `_tmp-po15904`, `_tmp-po15904-full`, `_tmp-po15904-value`, `_tmp-po16149`, `_tmp-printpo-puppeteer`, `_tmp-printpo2`, `_tmp-printpo3`, `_tmp-replen-po-timeline`, `_tmp-sf-ap30476`, `_tmp-sf-chatter-check2`, `_tmp-sf-check-1322-1323`, `_tmp-sf-dupe-pos`, `_tmp-sf-freight-po`, `_tmp-sf-freight`, `_tmp-sf-payables`, `_tmp-sf-po-lines`, `_tmp-sf-po-lines2`. They are the workload described in section 4.18 and they are the argument for the general query surface in section 6.11.4, not a list Automayt has to implement endpoint by endpoint.

### B.1 Sales Order

1. `lib/shopify-sf.js:519-525` - Shopify duplicate guard.

```sql
SELECT Id, Name, PBSI__Order_Date__c, PBSI__Customer_Purchase_Order__c, CreatedBy.Name
FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x000023jkuDAAQ'
  AND PBSI__Customer_Purchase_Order__c LIKE '%<digits>%'
LIMIT 5
```

2. `lib/shopify-sf.js:736` - read back the Sales Order number after create.

```sql
SELECT Name FROM PBSI__PBSI_Sales_Order__c WHERE Id = '<soId>'
```

3. `lib/shopify-so-reconcile.js:75-77` - which Shopify orders already have a Sales Order.

```sql
SELECT PBSI__Customer_Purchase_Order__c FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x000023jkuDAAQ' AND CreatedDate = LAST_N_DAYS:65
```

4. `lib/amazon-po.js:167-176` - candidate rolling Amazon Sales Orders. Called with limit 10 from the pipeline and limit 1 from the dashboard.

```sql
SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer__c = '0014x00001P1SiHAAV'
ORDER BY Name DESC
LIMIT <n>
```

5. `lib/amazon-po.js:277-280` - read back the created Amazon Sales Order.

```sql
SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Order_Date__c, PBSI__Status__c
FROM PBSI__PBSI_Sales_Order__c WHERE Id = '<soId>'
```

6. `scripts/ops/lookup-so.js:15` - operator inspector. Requires API v51 or later.

```sql
SELECT FIELDS(ALL) FROM PBSI__PBSI_Sales_Order__c WHERE Name = '<soName>' LIMIT 1
```

7. `scripts/ops/_tmp-sf-1321.js:5` - find Sales Orders by a partial customer purchase order reference.

```sql
SELECT Id, Name, PBSI__Customer_Purchase_Order__c, PBSI__Status__c, PBSI__Order_Total__c, CreatedDate
FROM PBSI__PBSI_Sales_Order__c
WHERE PBSI__Customer_Purchase_Order__c LIKE '%1321%'
ORDER BY CreatedDate DESC LIMIT 5
```

### B.2 Sales Order Line

8. `scripts/ops/lookup-so.js:26-31` - lines of a Sales Order.

```sql
SELECT Id, Name, PBSI__Item__c, PBSI__Item__r.Name, PBSI__Item__r.PBSI__Description__c,
       PBSI__Item__r.PBSI__Vendor_Item_ID__c, PBSI__Item__r.PBSI__Default_Vendor_Name__c,
       PBSI__Quantity__c, PBSI__Quantity_Needed__c, PBSI__Price__c, PBSI__Total_Price__c
FROM PBSI__PBSI_Sales_Order_Line__c WHERE PBSI__Sales_Order__c = '<soId>'
```

### B.3 Purchase Order

9. `lib/amazon-po.js:525-526` (inside `findExistingPOsByTracking`, `:515-533`) - **the duplicate guard**, chunked 50 tracking codes.

```sql
SELECT PBSI__Tracking_Code__c FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c IN ('<trk1>','<trk2>', ...)
```

10. `lib/shopify-sf.js:512` - single-value form of the same guard, org-wide, no account scope.

```sql
SELECT Id, Name, PBSI__Sales_Order__c FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c = '<tracking>' LIMIT 3
```

11. `lib/shopify-sf.js:811` - read back the Purchase Order number.

```sql
SELECT Name, PO_Number__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'
```

12. `lib/amazon-po.js:799` and `lib/fba-po-sender.js:413` - same read, Name only.

```sql
SELECT Name FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'
```

13. `lib/amazon-po.js:891-894` - the Movement Journal canary.

```sql
SELECT PBSI__Movement_Journal__c FROM PBSI__PBSI_Purchase_Order__c WHERE Id = '<poId>'
```

14. `scripts/ops/fix-stuck-po-receive.js:37-40` - Purchase Order header by document number.

```sql
SELECT Id, Name, PBSI__Status__c, PBSI__Account__r.Name, PBSI__Order_Date__c,
       mm_Received_Location_Name__c, CFC_Stage__c, PBSI__Movement_Journal__c
FROM PBSI__PBSI_Purchase_Order__c WHERE Name = '<PO-NAME>'
```

15. `scripts/ops/accounting-exceptions.js:103-105` - hydrate Purchase Orders for unpaid payables, chunked 150 ids.

```sql
SELECT Id, Name, PBSI__Order_Total__c, PBSI__Status__c, PBSI__Tracking_Code__c
FROM PBSI__PBSI_Purchase_Order__c WHERE Id IN ('<id1>','<id2>', ...)
```

16. `scripts/ops/accounting-exceptions.js:129-131` and `scripts/ops/_tmp-sf-tracking-dupes.js:5-9` - duplicate detection, server-side aggregate.

```sql
SELECT PBSI__Tracking_Code__c, COUNT(Id) n FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c != null AND CreatedDate >= <sinceDatetime>
GROUP BY PBSI__Tracking_Code__c HAVING COUNT(Id) > 1
```

17. `scripts/ops/accounting-exceptions.js:132` - the members of a duplicate group.

```sql
SELECT Id, Name, PBSI__Order_Total__c FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Tracking_Code__c = '<code>' ORDER BY CreatedDate
```

18. `scripts/ops/return-actions.js:102-103` - Purchase Orders for a claim list, unchunked.

```sql
SELECT Name, PBSI__Tracking_Code__c, PBSI__Order_Total__c, PBSI__Status__c
FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Tracking_Code__c IN ('<tn1>','<tn2>', ...)
```

19. `scripts/ops/po-lookup.js:108-111` - recent Purchase Orders for a vendor, no status filter despite the flag name.

```sql
SELECT <describe-derived header fields> FROM PBSI__PBSI_Purchase_Order__c
WHERE PBSI__Account__r.Name LIKE '%rosol%' ORDER BY CreatedDate DESC LIMIT 25
```

20. `scripts/ops/po-lookup.js:120` and `:133` - header by name, then its lines.

```sql
SELECT <describe-derived header fields> FROM PBSI__PBSI_Purchase_Order__c WHERE Name = '<name>'
SELECT <describe-derived line fields> FROM PBSI__PBSI_Purchase_Order_Line__c WHERE PBSI__Purchase_Order__c = '<poId>'
```

21. `scripts/ops/lookup-so.js:48-51` - Purchase Orders linked to a Sales Order.

```sql
SELECT Id, Name, PBSI__Status__c, PBSI__Tracking_Code__c, PBSI__Account__c,
       PBSI__Account__r.Name, PBSI__Order_Date__c
FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Sales_Order__c = '<soId>'
```

22. `scripts/ops/_tmp-po16128.js:5` - the escape hatch. Requires v51 or later and a limit of 200 or less.

```sql
SELECT FIELDS(ALL) FROM PBSI__PBSI_Purchase_Order__c WHERE Name = 'PO-16128' LIMIT 1
```

23. `scripts/ops/_tmp-sf-fs-pos.js:5` - Purchase Orders for a vendor account id.

```sql
SELECT Name, PBSI__Status__c, PBSI__Order_Total__c, PBSI__Final_Order_Total__c,
       PBSI__Sales_Tax__c, CreatedDate
FROM PBSI__PBSI_Purchase_Order__c WHERE PBSI__Account__c = '001OJ000007VtFWYA0'
ORDER BY CreatedDate DESC LIMIT 20
```

24. `scripts/ops/_tmp-sf-dupe-sweep.js:6-11` - duplicate detection by line signature, parent with child sub-select, paginated.

```sql
SELECT Id, Name, PBSI__Order_Total__c, PBSI__Status__c, CreatedDate, Date_Received__c,
       Date_Invoiced__c, Ascent2QB__QB_Purchase_Order_ID__c,
       (SELECT PBSI__Vendor_Item_ID__c, PBSI__Quantity_Ordered__c, PBSI__Total_Price__c
        FROM PBSI__Purchase_Order_Lines__r)
FROM PBSI__PBSI_Purchase_Order__c
WHERE CreatedDate >= 2026-04-01T00:00:00Z
ORDER BY CreatedDate
```

25. `scripts/ops/_tmp-sf-paid-check.js:8` - status vocabulary from the data.

```sql
SELECT PBSI__Status__c s, COUNT(Id) n FROM PBSI__PBSI_Purchase_Order__c
GROUP BY PBSI__Status__c ORDER BY COUNT(Id) DESC
```

### B.4 Purchase Order Line

26. `server.js:1126-1130` - every open Purchase Order line in the org. No filter, no LIMIT, no pagination. This is the only SOQL written inline in `server.js`.

```sql
SELECT PBSI__Item__r.Name, PBSI__Quantity_Ordered__c, PBSI__Quantity_Received__c, PBSI__Purchase_Order__r.Name
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__r.PBSI__Status__c = 'Open'
```

27. `scripts/fba/build-replen-po.js:222-229` - open Prosol supply with a server-computed remainder.

```sql
SELECT PBSI__Vendor_Item_ID__c, PBSI__Quantity_Left_To_Receive__c,
       PBSI__Purchase_Order__r.Name, PBSI__Purchase_Order__r.PBSI__Status__c,
       PBSI__Purchase_Order__r.CreatedDate
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__r.PBSI__Account__r.Name LIKE '%rosol%'
  AND PBSI__Purchase_Order__r.PBSI__Status__c IN ('Open','Partially Complete')
  AND PBSI__Quantity_Left_To_Receive__c > 0
```

28. `scripts/ops/fix-stuck-po-receive.js:45-49` - lines of one Purchase Order.

```sql
SELECT Id, Name, PBSI__Item__c, PBSI__Item__r.Name, PBSI__Quantity_Ordered__c,
       PBSI__Quantity_Received__c, PBSI__Price__c
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__c = '<poId>' ORDER BY Name
```

29. `scripts/analytics/generate-financial-report.js:53-67` - 730 days of spend by owner, streamed. The `const soql =` statement begins at `:53`.

```sql
SELECT PBSI__Quantity_Ordered__c, PBSI__Item_Cost__c, PBSI__Total_Price__c,
       PBSI__Pre_Tax_Total_Price__c, PBSI__Purchase_Order__r.Name,
       PBSI__Purchase_Order__r.PBSI__Order_Date__c,
       PBSI__Purchase_Order__r.PBSI__Account__r.Name,
       PBSI__Purchase_Order__r.OwnerId, PBSI__Purchase_Order__r.Owner.Name
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__r.OwnerId = '<macUserId>'
  AND PBSI__Purchase_Order__r.PBSI__Order_Date__c >= LAST_N_DAYS:730
```

30. `scripts/ops/_tmp-find-skus.js:6-9` - has this SKU been ordered lately, filtered and sorted through the parent.

```sql
SELECT PBSI__Purchase_Order__r.Name, PBSI__Purchase_Order__r.PBSI__Status__c,
       PBSI__Quantity_Ordered__c, PBSI__Purchase_Order__r.PBSI__Order_Date__c
FROM PBSI__PBSI_Purchase_Order_Line__c
WHERE PBSI__Vendor_Item_ID__c = '<sku>'
  AND PBSI__Purchase_Order__r.PBSI__Order_Date__c >= 2026-06-01
ORDER BY PBSI__Purchase_Order__r.PBSI__Order_Date__c DESC LIMIT 5
```

### B.5 Received Purchase Order Line

31. `scripts/ops/fix-stuck-po-receive.js:54-57` - existing receipts, to inherit a location.

```sql
SELECT PBSI__Location__c, PBSI__Location__r.Name, PBSI__Receiving_Date__c
FROM PBSI__Received_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__c = '<poId>' ORDER BY Name
```

32. Backfill audit form, from prior work.

```sql
SELECT Id FROM PBSI__Received_Purchase_Order_Line__c
WHERE PBSI__Purchase_Order__c = '<poId>' AND PBSI__Location__c = 'a0v4x000005kF5ZAAU'
```

### B.6 Item

33. `scripts/shipstation/run-orders.js:31` - **the mapping guard**, on the pre-buy path for every order line. Single quotes are deleted from the input, not escaped.

```sql
SELECT PBSI__description__c FROM PBSI__PBSI_Item__c
WHERE PBSI__Vendor_Item_ID__c = '<code>' LIMIT 1
```

34. `lib/shopify-sf.js:184` - item by vendor code, run up to four times with different spellings.

```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '<variant>' LIMIT 1
```

35. `lib/shopify-sf.js:191` - same projection, by internal item number.

```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, PBSI__Default_Vendor_Name__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE Name = '<sku>' LIMIT 1
```

36. `lib/shopify-sf.js:198` - blind fuzzy fallback. Note the capital D in the WHERE clause.

```sql
SELECT Id, Name, PBSI__salesprice__c, PBSI__Vendor_Item_ID__c, Unit_of_Measure__c,
       PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Description__c LIKE '%<title first 80 chars>%' LIMIT 5
```

37. `lib/amazon-po.js:306-312` - item by vendor code, Amazon and FBA path.

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c = '<variant>' LIMIT 1
```

38. `lib/amazon-po.js:335-341` - last-resort prefix match. No ordering, can bind the wrong variant.

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__salesprice__c, PBSI__Cost__c,
       Unit_of_Measure__c, PBSI__defaultunitofmeasure__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c LIKE '<baseCode>%' LIMIT 1
```

39. `lib/shopify-sf.js:428` - name collision precheck before creating an item.

```sql
SELECT Id FROM PBSI__PBSI_Item__c WHERE Name = '<name>' LIMIT 1
```

40. `lib/shopify-sf.js:400` - poll for the trigger-created companion product.

```sql
SELECT PBSI__Product__c FROM PBSI__PBSI_Item__c WHERE Id = '<itemId>' LIMIT 1
```

41. `scripts/etl/sync-item-costs.js:55-59` - nightly cost pull, streamed with a 100,000-row ceiling.

```sql
SELECT Id, Name, PBSI__Cost__c, PBSI__Description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Cost__c > 0
```

42. `scripts/etl/sync-sku-map.js:72-79` - nightly vendor-code pull, streamed with a 50,000-row ceiling.

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c, PBSI__Cost__c, PBSI__Description__c
FROM PBSI__PBSI_Item__c WHERE PBSI__Vendor_Item_ID__c != NULL
```

43. `lib/vendor-availability.js:170-171` - vendor code to item number link, chunked 180.

```sql
SELECT Id, Name, PBSI__Vendor_Item_ID__c FROM PBSI__PBSI_Item__c
WHERE PBSI__Vendor_Item_ID__c IN ('<code1>','<code2>', ...)
```

44. `scripts/ops/shopify-stock-gate.js:76-80` - storefront stock gate, chunked 180, matched on Name only.

```sql
SELECT Name, AscentBTO__Stock_Status__c, PBSI__Available_to_Promise__c,
       PBSI__Not_Available_For_Sale__c, Box_Quantity__c, PBSI__description__c
FROM PBSI__PBSI_Item__c WHERE Name IN ('<sku1>','<sku2>', ...)
```

45. `scripts/ops/find-stock-alt.js:13-21` - substitution search, in stock, one group.

```sql
SELECT Name, PBSI__description__c, PBSI__Available_to_Promise__c, Box_Quantity__c,
       Original_Style_Name__c, PBSI__Default_Vendor_Name__c, PBSI__Cost__c, AscentBTO__Stock_Status__c
FROM PBSI__PBSI_Item__c
WHERE Item_Group_Name__c = 'Vinyl Tile' AND PBSI__Available_to_Promise__c > 0
ORDER BY PBSI__Available_to_Promise__c DESC LIMIT 60
```

46. `scripts/ops/find-stock-alt.js:28-35` - substitution search by colour name across groups. **Sorted by stock, not filtered by it.**

```sql
SELECT Name, PBSI__description__c, PBSI__Available_to_Promise__c, Item_Group_Name__c,
       PBSI__Default_Vendor_Name__c, AscentBTO__Stock_Status__c
FROM PBSI__PBSI_Item__c WHERE PBSI__description__c LIKE '%Bourbon%'
ORDER BY PBSI__Available_to_Promise__c DESC LIMIT 40
```

47. `scripts/ops/find-stock-alt.js:42-49` - other colourways of one product line.

```sql
SELECT Name, PBSI__description__c, PBSI__Available_to_Promise__c, Original_Style_Name__c,
       AscentBTO__Stock_Status__c
FROM PBSI__PBSI_Item__c WHERE PBSI__description__c LIKE '%Hydrogen%'
ORDER BY PBSI__Available_to_Promise__c DESC LIMIT 40
```

48. `scripts/analytics-data-inventory.js:247` and `:259` - counts, including a per-field populated count used to discover which cost fields exist.

```sql
SELECT COUNT(Id) c FROM PBSI__PBSI_Item__c
SELECT COUNT(Id) c FROM PBSI__PBSI_Item__c WHERE <field> != NULL AND <field> > 0
```

49. `scripts/ops/_tmp-pbsi-items.js:6` - item by either identity in one call.

```sql
SELECT Id, Name, PBSI__Cost__c, PBSI__Vendor_Item_ID__c FROM PBSI__PBSI_Item__c
WHERE Name = '<sku>' OR PBSI__Vendor_Item_ID__c = '<sku>' LIMIT 3
```

50. `scripts/ops/_tmp-sf-freight-item.js:7` - the widest item query, including expense GL and tax code.

```sql
SELECT Id, Name, PBSI__description__c, PBSI__Vendor_Item_ID__c, PBSI__Cost__c, PBSI__salesprice__c,
       PBSI__Is_Service__c, PBSI__Item_Type__c, PBSI__Default_Vendor__r.Name,
       Ascent_FPL__Expense_GL_Account__r.Name, PBSI__Tax_Code__r.Name
FROM PBSI__PBSI_Item__c
WHERE PBSI__description__c LIKE '%reight%' OR Name LIKE '%reight%'
   OR PBSI__description__c LIKE '%Shipping%' OR PBSI__description__c LIKE '%Delivery%'
ORDER BY Name LIMIT 25
```

### B.7 Product2, Contact, User

51. `lib/shopify-sf.js:406` - current revenue GL on the companion product.

```sql
SELECT Id, AcctSeed__Revenue_GL_Account__c FROM Product2 WHERE Id = '<productId>' LIMIT 1
```

52. `lib/shopify-sf.js:164` - contact by email. The only Contact query in the system.

```sql
SELECT Id, Name, Email, Phone, AccountId FROM Contact WHERE Email = '<email>' LIMIT 1
```

53. `scripts/analytics/generate-financial-report.js:36` - resolve the purchase-order owner.

```sql
SELECT Id, Name, Email FROM User
WHERE (Name LIKE '%Mac%Roy%' OR Email = 'mac@customfc.ca' OR Email LIKE 'mac%customfc%')
  AND IsActive = true LIMIT 5
```

54. `scripts/sf-login-probe.js:23` - liveness.

```sql
SELECT Id FROM User WHERE Id = '<self>' LIMIT 1
```

55. `scripts/ops/_tmp-sf-users-lines.js:10` - active user roster.

```sql
SELECT Id, Name, Username, Email, Title, Profile.Name, IsActive, LastLoginDate
FROM User WHERE IsActive = true ORDER BY LastLoginDate DESC NULLS LAST LIMIT 40
```

56. `scripts/luca-sf-reset.js:16` - login lock state.

```sql
SELECT Id, IsFrozen, IsPasswordLocked FROM UserLogin WHERE UserId = '<userId>'
```

### B.8 AcctSeed payables

57. `scripts/ops/accounting-exceptions.js:92-96` - unpaid payables for a vendor, paginated.

```sql
SELECT Name, A2AS__Purchase_Order__c, AcctSeed__Total__c, AcctSeed__Sub_Total__c,
       AcctSeed__Paid_Amount__c, AcctSeed__Balance__c, AcctSeed__Date__c
FROM AcctSeed__Account_Payable__c
WHERE AcctSeed__Vendor__c = '0014x00001P1ScCAAV' AND AcctSeed__Date__c >= <sinceDate>
  AND A2AS__Purchase_Order__c != null AND AcctSeed__Balance__c > 0
```

58. `scripts/ops/_tmp-sf-prosol-paid.js:26-27` - payables for a list of Purchase Order ids.

```sql
SELECT Id, Name, A2AS__Purchase_Order__c, AcctSeed__Total__c, AcctSeed__Paid_Amount__c,
       AcctSeed__Balance__c, AcctSeed__Payment_Status__c, AcctSeed__Status__c, AcctSeed__Date__c
FROM AcctSeed__Account_Payable__c WHERE A2AS__Purchase_Order__c IN ('<poId1>', ...)
```

59. `scripts/ops/_tmp-dupbill.js:6-10` - double billing detector.

```sql
SELECT A2AS__Purchase_Order__c, COUNT(Id) n, SUM(AcctSeed__Total__c) total,
       SUM(AcctSeed__Paid_Amount__c) paid
FROM AcctSeed__Account_Payable__c
WHERE AcctSeed__Vendor__c = '0014x00001P1ScCAAV' AND CALENDAR_YEAR(AcctSeed__Date__c) = 2026
  AND A2AS__Purchase_Order__c != null
GROUP BY A2AS__Purchase_Order__c
HAVING COUNT(Id) > 1
```

60. `scripts/ops/_tmp-overbill.js:6-9` - over-billing detector, same aggregate with the pre-tax subtotal and no HAVING.

```sql
SELECT A2AS__Purchase_Order__c, COUNT(Id) n, SUM(AcctSeed__Sub_Total__c) subtotal,
       SUM(AcctSeed__Total__c) total, SUM(AcctSeed__Paid_Amount__c) paid
FROM AcctSeed__Account_Payable__c
WHERE AcctSeed__Vendor__c = '0014x00001P1ScCAAV' AND CALENDAR_YEAR(AcctSeed__Date__c) = 2026
  AND A2AS__Purchase_Order__c != null
GROUP BY A2AS__Purchase_Order__c
```

61. `scripts/ops/_tmp-sf-prosol-paid.js:15-16` - payables by vendor by year.

```sql
SELECT CALENDAR_YEAR(AcctSeed__Date__c) y, COUNT(Id) n, SUM(AcctSeed__Total__c) total,
       SUM(AcctSeed__Paid_Amount__c) paid, SUM(AcctSeed__Balance__c) bal
FROM AcctSeed__Account_Payable__c WHERE AcctSeed__Vendor__c = '<vendorId>'
GROUP BY CALENDAR_YEAR(AcctSeed__Date__c) ORDER BY CALENDAR_YEAR(AcctSeed__Date__c)
```

62. `scripts/ops/_tmp-sf-payable-link.js:12-13` and `:17-18` - recent payables and their lines. **The second query below is broken as written**: `AcctSeed__Rate__c` does not exist on `AcctSeed__Account_Payable_Line__c`, so it throws `INVALID_FIELD` and has never returned a row. The correct field is `AcctSeed__Unit_Cost__c`. It is reproduced verbatim because the field list built from it made its way into earlier CFC notes.

```sql
SELECT Name, AcctSeed__Date__c, AcctSeed__Total__c, AcctSeed__Paid_Amount__c, AcctSeed__Balance__c,
       AcctSeed__Payment_Status__c, A2AS__Purchase_Order__r.Name
FROM AcctSeed__Account_Payable__c WHERE AcctSeed__Vendor__c = '0014x00001P1ScCAAV'
ORDER BY AcctSeed__Date__c DESC LIMIT 8

SELECT Name, AcctSeed__Quantity__c, AcctSeed__Rate__c, AcctSeed__Amount__c, AcctSeed__Product__r.Name
FROM AcctSeed__Account_Payable_Line__c WHERE AcctSeed__Account_Payable__r.Name = 'AP-30476'
```

### B.9 Vendor Invoice, Chatter, files

63. `scripts/ops/_tmp-sf-payable-detail.js:8` and `:14` - the PBSI payment surface, investigated and rejected.

```sql
SELECT Id, Name, PBSI__Status__c, PBSI__Payment_Status__c, PBSI__Amount_Paid__c,
       PBSI__Purchase_Order__c, CreatedDate
FROM PBSI__Vendor_Invoice__c WHERE PBSI__Purchase_Order__c = '<poId>'

SELECT Id, Name, PBSI__Status__c, PBSI__Payment_Status__c, CreatedDate
FROM PBSI__Vendor_Invoice__c ORDER BY CreatedDate DESC LIMIT 5
```

64. `scripts/ops/_tmp-sf-chatter-check.js:10` and `:13` - is anyone using the Purchase Order feed.

```sql
SELECT COUNT(Id) n FROM FeedItem WHERE Parent.Type = 'PBSI__PBSI_Purchase_Order__c'

SELECT Id, ParentId, Type, Body, CreatedDate, CreatedBy.Name FROM FeedItem
WHERE Parent.Type = 'PBSI__PBSI_Purchase_Order__c' ORDER BY CreatedDate DESC LIMIT 5
```

65. `scripts/ops/_tmp-po-email-att.js:7-14` - the working recipe for retrieving a vendor-facing purchase order PDF, by pulling it off the sent email.

```sql
SELECT Id, Subject FROM EmailMessage
WHERE Subject LIKE '%PO-16147%' AND HasAttachment = true ORDER BY MessageDate DESC LIMIT 1

SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '<emailId>'

SELECT Id, Title, FileExtension, ContentSize, VersionData FROM ContentVersion
WHERE ContentDocumentId = '<docId>' AND IsLatest = true
```

The binary is then fetched from the `VersionData` URL with a raw request in binary mode.

66. `scripts/ops/_tmp-find-po-pdf.js:8`, `:12`, `:16` - looking for a stored file on the Purchase Order, and for the print page.

```sql
SELECT Id, Name, ContentType, BodyLength, CreatedDate FROM Attachment WHERE ParentId = '<poId>'

SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileType,
       ContentDocument.ContentSize, ContentDocument.CreatedDate
FROM ContentDocumentLink WHERE LinkedEntityId = '<poId>'

SELECT Name, NamespacePrefix, MasterLabel FROM ApexPage WHERE NamespacePrefix = 'PBSI' ORDER BY Name
```

### B.10 Non-SOQL operations

- Invocable action, the goods receipt: `POST /services/data/v42.0/actions/custom/apex/PBSI__ReceivedPOLinesCreateAction`. Two independent call sites: `lib/amazon-po.js:61-90` and `scripts/ops/fix-stuck-po-receive.js:21-32`.
- Connect API, the accounting note: `POST /services/data/v59.0/chatter/feed-elements` at `scripts/ops/accounting-exceptions.js:194`.
- Admin password set: `POST /services/data/v59.0/sobjects/User/<userId>/password` at `scripts/luca-sf-reset.js:25-30`. Requires an explicit JSON content-type header.
- Per-object describe: `conn.sobject('<Object>').describe()` at `scripts/ops/po-lookup.js:23`, `:34`, `:57`, `scripts/analytics-data-inventory.js:231`, and roughly eight forensic scripts.
- Org-wide describe: `conn.describeGlobal()` at `scripts/ops/_tmp-sf-failed-pos.js:16` and `_tmp-sf-paid-dig.js:16`.
- Identity: `conn.identity()` at `scripts/sf-login-probe.js:17`.
- Updates: Account on-hold at `lib/shopify-sf.js:558` and `lib/amazon-po.js:180`; Purchase Order status at `lib/amazon-po.js:833-838` and `scripts/ops/fix-stuck-po-receive.js:71`; Product2 revenue GL at `lib/shopify-sf.js:409`; UserLogin unlock at `scripts/luca-sf-reset.js:19-21`; and the undocumented Sales Order cancel described in section 4.16.
- Deletes: `conn.sobject('PBSI__PBSI_Purchase_Order__c').destroy(<poId>)` and `conn.sobject('PBSI__PBSI_Sales_Order_Line__c').destroy(<lineId>)` at `scripts/ops/_tmp-1321-delete-freight-po.js:12` and `:15`.

---

## Appendix C. Index of run-orders files that touch Salesforce

### C.1 The client

- `lib/salesforce.js` - the only Salesforce client. Connect, query, create, and a dead session-invalidator. 88 lines.

### C.2 Pipeline and write paths

- `lib/pipeline.js` - the five-phase engine. Owns the `pos` phase, the halt policy and the local persistence of Salesforce identifiers.
- `lib/shopify-sf.js` - Shopify order to Sales Order and Purchase Order; lazy item creation; the revenue-GL stamp; the duplicate guard. 846 lines, the densest Salesforce file in the repository.
- `lib/amazon-po.js` - Amazon order to the rolling Sales Order, the Purchase Order, and the goods receipt through the invocable action. 941 lines.
- `lib/shopify-so-reconcile.js` - the back-fill sweep for Shopify orders that shipped with no Sales Order. Shadow mode.
- `lib/fba-po-sender.js` - FBA replenishment Purchase Orders, the vendor email and the PDF.
- `scripts/shipstation/run-orders.js` - the staging engine. Contains the mapping guard, the only Salesforce read on the pre-buy path.
- `lib/pbsi-uom.js` - 77 lines, no Salesforce calls of its own, and the one piece of client-side logic section 6.5 asks Automayt to absorb server-side. It decides whether a resolved item is area-stocked and converts the ordered roll count into square feet, refusing the line rather than defaulting when the coverage cannot be resolved. Exports `AREA_UOMS`, `isAreaUom`, `parseCoverageFromDescription` and `resolveLineQty`. Required by `lib/shopify-sf.js:22` and `lib/amazon-po.js:28`, called at `lib/shopify-sf.js:678` and `lib/amazon-po.js:706`. Behaviour in sections 4.1 step 4e and 5.9.
- `server.js` - all cron schedules, the dashboard endpoints, the Telegram bot, and the **one** SOQL written inline in the server, the open-purchase-order subtraction at `:1126-1130`. The cost hydration immediately below it (`:1179-1200`) writes no SOQL of its own; it delegates to `findPbsiItem` in `lib/amazon-po.js`.

### C.3 Reads, ETL and reporting

- `scripts/etl/run-all.js` - the ETL orchestrator, 03:00 daily.
- `scripts/etl/sync-item-costs.js` - full item cost pull into the local analytics database.
- `scripts/etl/sync-sku-map.js` - full vendor-code pull into the canonical local map.
- `scripts/analytics/generate-financial-report.js` - 730 days of purchase-order spend, filtered by owner.
- `scripts/analytics-data-inventory.js` - describe plus count probe over the item master.
- `lib/vendor-availability.js` - the one Salesforce read in the vendor-availability subsystem, linking vendor codes to item numbers.
- `scripts/vendor-availability/ingest.js`, `scripts/vendor-availability/mark.js` - the two command lines that trigger that read.

### C.4 Operator tools

- `scripts/ops/accounting-exceptions.js` - the accounts-payable exception scanner and the Chatter note. The heaviest Salesforce consumer outside the pipeline.
- `scripts/ops/fix-stuck-po-receive.js` - reopen and receive a stuck Purchase Order. Carries a second copy of the invocable-action wrapper.
- `scripts/ops/po-lookup.js` - purchase order inspector, built on describe so it degrades instead of throwing. The pattern works, and it is the reason nine non-existent field names in its two wanted lists never broke it. The cost is that six of its outputs are permanently dead: ship-to, expected date and notes on the header, and quantity, extended price and description on every line. See the probe notes in Appendix A.3 and A.4.
- `scripts/ops/lookup-so.js` - sales order inspector, uses `FIELDS(ALL)` and pins the API version.
- `scripts/ops/find-stock-alt.js` - substitution search for a customer-service conversation.
- `scripts/ops/return-actions.js` - returns routing and credit claims, degrades gracefully without Salesforce.
- `scripts/ops/shopify-stock-gate.js` - Salesforce stock to Shopify inventory. Manual, dry by default.
- `scripts/ops/reconcile-shopify-sos.js` - command-line wrapper for the reconcile sweep. **The only operator tool that creates a Sales Order.**
- `scripts/ops/verify-bucket-split.js` - regression harness that stubs the Salesforce module and pins part of the Purchase Order create contract.
- `scripts/fba/build-replen-po.js` - weekly replenishment proposal. Read only.
- `scripts/sf-login-probe.js` - the only artefact that proves Salesforce is reachable.
- `scripts/luca-sf-reset.js` - a one-shot user-administration write script that was meant to be deleted and is still in the tree.

### C.5 Files that consume Salesforce identifiers without calling Salesforce

- `lib/ops-state.js` - persists the purchase order and sales order numbers and ids per tracking number.
- `lib/audit.js` - the append-only ledger that carries Salesforce ids and raw Salesforce error text.
- `lib/emailer.js` - prints the purchase order and sales order numbers in the vendor email.
- `lib/packing-slip.js` - prints the purchase order number on the warehouse PDF and in its filename.
- `lib/stale-parcel-reminder.js` - prints the purchase order number in a vendor-facing chase email, sourced from every local state file ever written.
- `lib/prosol-direct-order.js` - **requires** the purchase order number as an input to Prosol's own ordering API. Currently dark.
- `lib/vendor-reply-parser.js`, `lib/mail-watcher.js`, `lib/imap-watcher.js` - route inbound vendor email by matching the purchase order number in the subject.
- `lib/integration-health.js` - infers Salesforce health from local files. Contains zero Salesforce references.
- `lib/orphan-email-sweep.js`, `scripts/ops/audit-orphan-labels.js`, `scripts/ops/prosol-chargeback.js` - consume the local purchase-order mirror.
- `scripts/ops/verify-vendor-reply-parser.js`, `verify-mail-watcher.js`, `verify-imap-watcher.js`, `verify-inbound-orchestration.js` - the only mechanical assertion of the purchase order number format. Hand-run, outside `npm test`.
- `public/index.html` - the dashboard, which renders Salesforce field names directly.

### C.6 Forensic scripts

`scripts/ops/` holds 172 files matching `_tmp-*.js`, of which **47 require the Salesforce client**. None is scheduled, none exports anything, nothing references them. They are the ad-hoc query workload described in section 4.18. Notable ones: `_tmp-1321-delete-freight-po.js` (the only delete in the repository), `_tmp-sf-tracking-dupes.js` (the duplicate detector that graduated into production), `_tmp-verify-failclosed.js` (the fail-closed regression test), `_tmp-sf-po-describe.js` and `_tmp-sf-acctseed.js` (schema discovery), and the six purchase-order PDF attempts.

### C.7 Outside this repository

- `cfc-instock-sync` - a separate repository that imports `run-orders/lib/salesforce` by path and reuses `run-orders/.env`. Twelve files. It syncs Salesforce stock to the WordPress site and creates Opportunities from Cal.com bookings and Facebook leads. **The cutover touches two repositories.**

### C.8 Documentation in the repository, and how much to trust it

- `docs/ORDER-PREP.md` - the human runbook. Written 2026-04-02. Its step 7 is the Salesforce write surface as documented. **Substantially stale**: it names a single fixed Amazon catch-all sales order that the code replaced with a rolling one, and it lists automation gaps that have since been closed. Also contains a plaintext SMTP password.
- `docs/RUN-ORDERS-SPEC.md` - the Shopify sequence and three named rules, still accurate in shape.
- `knowledge/sf-shopify-order-fields.md` - the 2026-04 field map. Useful for intent, wrong on several field names.
- `knowledge/today-learnings.md` - the origin of the tax-exemption-null rule and the SOAP login endpoint gotcha.
- `docs/sf-to-qbo-migration.md` - a QuickBooks migration plan that was never executed. **Its section 2 is a first-party audit of the Salesforce footprint and is worth reading**, but it under-counts: it lists neither Product2 nor the AcctSeed field run-orders writes. Its object mapping and cutover-strategy sections are the source of the parallel-run recommendation in section 8.
- `docs/FBA-AUTOMATION-SPEC.md` - specifies a channel field and a monthly master sales order that were never built.
- `CLAUDE.md`, `lib/CLAUDE.md`, `scripts/shipstation/CLAUDE.md` - the live operating rules. Current.

**In every case where a document and the code disagree, the code is correct.** The documents were written between 2026-04-02 and 2026-04-27; the integration changed substantially after that.
