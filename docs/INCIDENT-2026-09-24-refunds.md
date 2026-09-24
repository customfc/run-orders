# Incident report, 2026-09-23 / 24

Written by Claude (Opus 5) at Mac's request. Covers a session that produced
some correct work and one expensive failure.

---

## 1. Headline

**$6,190.38 of Amazon customer refunds were issued. Roughly $5,923 of that
should not have gone out.** The refunds are irreversible through the API.

Defensible portion: about **$266.66** (Michelle Belliveau's stranded grate
assembly, $231.93 plus $34.73 tax).

---

## 2. The refund error, full accounting

Five refunds issued 2026-09-24 via `scripts/ops/issue-refund.js`, reason
`CouldNotShip`. All five feeds processed successfully (127217020720 through
127221020720, each StatusCode Complete, 1 successful, 0 errors).

| Customer | Order | Refunded | What was actually true |
|---|---|---|---|
| McNicoll Normand, Saint-Bruno QC | 702-7420115-7751450 | $1,387.33 | Received the $919 heating cable 12 Aug. $274.69 thermostat stranded. **Never complained.** |
| Elvin Kao, Markham ON | 701-8291977-5081059 | $1,201.68 | **All 3 parcels delivered 2026-08-17** to the front door, Canada Post delivery photos on file. |
| Olena Kholyavka, Terrace BC | 701-3899120-0870652 | $1,385.67 | **All 3 parcels delivered 2026-08-20.** |
| Benoit Côté, Québec QC | 701-2514292-8729805 | $1,385.66 | Received 1 of 2 identical rolls 12 Aug. **Never complained.** |
| Michelle Belliveau, Sainte-Julie QC | 702-8016859-8120262 | $830.04 | Received the $490 channel body 24 Aug. $231.93 grate stranded. **Did complain**, filed returns 25-26 Aug citing "not compatible". |

Corroborating evidence gathered after the fact:
- Canada Post's own API confirms Kao and Kholyavka delivered. Our tracking
  endpoint had shown nothing.
- Amazon returns report, 26 July to 24 September, 29 returns, **zero A-to-Z
  claims**. Only Belliveau ever contacted us.

### Recovery

Amazon Seller Support can reverse a merchant-issued refund on proof of
delivery. Cases are drafted for Kao (strongest, three delivery photos) and
Kholyavka. Filing requires Seller Central; there is no API path.

Normand and Côté cannot be recovered through that route because their
stranded halves are real. Their refunds were over-generous, not fraudulent.

---

## 3. Root cause

Delivery status was determined from a single ShipStation endpoint,
`/v2/labels/se-{id}/track`. **That endpoint returns `status_code: UN` with
zero events for every Canada Post and UPS shipment**, regardless of whether
the parcel was delivered. Measured against 12 known-old shipments per carrier:

| Carrier | Resolves? |
|---|---|
| Purolator | 12 of 12 |
| FedEx | 1 of 1 |
| Canada Post | 0 of 12 |
| UPS | 0 of 12 |

An empty result was read as proof of non-delivery. It is the absence of a
measurement, not a measurement.

**The correct method already existed in this repository.** `lib/stale-tracker.js`
line 31 documents this exact blind spot and implements a direct Canada Post
API fallback (`soa-gw.canadapost.ca/vis/track/pin/{pin}/summary`). Ad-hoc
scripts were written instead of using that module, so the fallback was never
inherited.

Contributing factors:
- A hypothesis confirmed on Purolator data was then used to absorb ambiguous
  Canada Post and UPS data rather than being tested against it.
- No control group. One call comparing the endpoint against known-delivered
  parcels would have exposed it, and was only run after Mac challenged it.
- Verification effort was not scaled to reversibility. The same confidence
  threshold was applied to "which branch is this" and to a permanent refund.
- The claim was presented to Mac as a conclusion ("never delivered") rather
  than with its basis ("tracking shows zero events"), so he could not audit
  the reasoning before approving.
- **The single strongest signal, whether the customer complained, was never
  checked until Mac asked for it.**

---

## 4. Correct work completed today

These stand up and are done.

- **Whistler order 702-8861834-4646619** (Stephen Legate, $447.99). Customer
  cancelled. Label 520764595770 voided before Purolator collected, ShipStation
  order cancelled, ops-state entry pulled so no vendor email went out, customer
  refunded, PO-17029 set to Cancelled. Prosol was never told. Clean.
- **Order 1376** (Elizabeth Hickey, $199.95). Armstrong Shinekeeper is
  discontinued, no stock, no ETA. Label 520744343895 voided, refunded, dead
  fulfillment cancelled, order cancelled 19:13:24. **She has not been told.**
- **Sechelt UPS routing** (commits 100733b, ff99ed0, deployed and verified).
  Sechelt now takes UPS unless Purolator is $15+ cheaper, because Purolator has
  no pickup at V0N 3A3 and those parcels wait for a manual depot run. 95 tests
  pass. Verified live, all six integrations healthy after restart.
- **SKU map** (commit 2e0ab8e). Added ASIN B08D4SG8Z6 for the DITRA-HEAT-DUO
  108 sqft roll. **NOT YET DEPLOYED** — see open items.
- **Hamilton PO-16546.** Resolved as paperwork, not a stranded parcel. See §6.

---

## 5. Defect found: orphan warehouses strand parcels silently

Recorded in memory as `reference_orphan_warehouse_silent_strand`.

`phasePickups` in `lib/pipeline.js` drops any shipment whose warehouse is not
in `prosol-location-map.json`, recording it as **`skipped`, not `failed`**, so
it never counts as an error. Deleting or renumbering a ShipStation warehouse
therefore strands every live label on it with no alert, no error counter, and
nothing for the stale sweeps to catch.

Nine such warehouse IDs exist. 43 shipments ran through them between June and
August. The pattern stopped on 2026-08-13 and nothing new has appeared since,
which fits a warehouse reorganisation that has completed.

Base rate: 8 of 483 shipments, 1.7%. The pipeline is not broken.

**Do not delete a ShipStation warehouse with live labels on it.** Drain first.

---

## 6. Open items, people waiting

1. **Elizabeth Hickey has not been told** her order is cancelled and refunded.
   She ordered 9 September. A draft exists in the session transcript.
2. **Seven boxes sit labelled at Sechelt** for five customers: Shannon Taylor
   (3 boxes), Barclay Fletcher, Mitchell Suares, Christel Van Damme, Drew
   Mesenchuk. They need a Purolator depot drop. A ready-to-send text listing
   tracking numbers and products is in the transcript.
3. **Order 701-2171290-5875410** (Owen O'Neill, Bath ON, $544.74, DITRA-HEAT-DUO).
   The SKU map fix is committed but **was never deployed**, so this order is
   probably still in manual review. Its Amazon ship-by was 2026-09-24 06:59Z
   and has now passed. Deploy and run:
   `ssh fred@freds-mac-mini... git pull --ff-only && launchctl kickstart -k ...`
   then `/api/run-orders/single?orderNumber=701-2171290-5875410&dryRun=true`.
4. **Prosol order 6796896** (Hamilton). Jamie is asking whether to cancel.
   **Do not cancel** — the goods reached the customer on 25 August. Ask them to
   close it as shipped and invoice against PO-16546. Draft in transcript.
5. **Two genuinely stranded parcels remain uncollected**: Normand's thermostat
   and Côté's second roll, both Purolator, both at branches. Customers have
   already been refunded in full, so these are stock recovery, not service.
6. **Amazon reversal cases** for Kao and Kholyavka, drafted, not filed.

---

## 7. Known instrument limitations

- `/v2/tracking` by carrier and number returns 401 "upgrade your billing plan".
  Not available on our ShipStation plan.
- UPS tracking cannot be resolved by any route we have. No UPS API credentials
  are configured (`lib/ups-api.js` exists, `UPS_CLIENT_ID` etc. are unset).
- Canada Post must be queried directly; the ShipStation endpoint returns nothing.
- Split-order child shipments carry a blank order number **and a different
  orderId** from their parent. Neither lookup finds them. Only the tracking
  number in `data/audit.jsonl` works.
- Amazon `listReports` rejects windows older than 90 days.
- Deleted ShipStation orders 404 and take the branch identity with them.

---

## 8. The rule worth keeping

Mac's, and it was right: **a customer will reach out every time.** Silence from
a customer who paid is stronger evidence than any tracking field. Of the five
people refunded, the only one who had actually been harmed was the only one who
had contacted us.

On any irreversible action, the claim should travel with its basis attached, so
the person approving can audit the reasoning rather than just the conclusion.

---

## 9. Live worklist: Purolator parcels never collected

Found by a full sweep after the report was drafted. **Purolator tracking is
reliable for us** (12 of 12 resolved in testing), so `AC Accepted` with only
label-creation events genuinely means the branch never handed it over.

Sorted oldest first. Ages as at 2026-09-24.

| Age | Warehouse | Tracking | Customer |
|---|---|---|---|
| 72d | 1284722 | 520650253062 | Patricia Mah, Calgary |
| 62d | 1824506 | 520667450784 | Pooran Williams, Caledon |
| 58d | 1947192 | 520671852660 | McNicoll Normand, Saint-Bruno *(refunded)* |
| 45d | 1956771 | 520690646937 | Benoit Côté, Québec *(refunded)* |
| 45d | 1791765 | 520690647489 | Michelle Belliveau, Sainte-Julie *(refunded)* |
| 28d | 1791764 | 520722271100 | David Ethelston, Sudbury |
| 28d | 1791764 | 520722715940 | Craig Wentzell, Peterborough |
| 27d | 1852858 | 520723357023 | Janet Green, Conception Bay South |
| 17d | 1869864 | 520738603668 | Sidra Anwar, Colliers Riverhead |
| 14d | 1956771 | 520744343093 + 520744344554 | Anthony Saber Shenouda, Saint-Irenee |
| 13d | 1986460 | 520746517652, 520746517694, 520746515391, 520746515425 | Slav Adrov, Sylvan Lake |

That is **eight customers beyond the three already refunded**, and Slav Adrov
has four parcels stuck with nothing delivered.

### Read this list correctly

Do **not** repeat today's mistake by treating "never collected" as "customer
was harmed". Before acting on any row:

1. **Check whether the customer contacted us.** Amazon returns report plus the
   inbox. Silence from someone who paid is strong evidence they are fine.
2. Check whether a sibling parcel delivered, i.e. whether they received part.
3. Only then decide reship, refund, or recover the stock.

Warehouse 1956771 and 1947192 are orphan warehouses per §5, so those parcels
never had a pickup booked at all. The rest are registered branches that simply
did not hand the parcel over.

Note: 520758217068 to Prosol Saint-Laurent is the customer return label for
order 1381. It is supposed to be unused until the customer ships it back.

Parcels from 2026-09-21 onward were excluded. A one to three day wait is the
intended pickup window, not a fault.

