# Test day: the first real Automayt key

What to do the day Aaron sends a key. Branch `automayt` (laptop worktree `~/daddy-dev/run-orders-automayt`). Nothing here touches Salesforce: it keeps running as today until cutover.

## 0. First, check the Prosol cost pull finished

It ran on the Mini from 20:00 PDT Oct 14 (about 6 hours, read-only against Prosol):

```
ssh fred@freds-mac-mini.taila452b5.ts.net 'tail -3 ~/prosol-catalog-pull/logs/costs-2026-10-14.log; wc -l ~/prosol-catalog-pull/data/prosol-catalog/2026-10-14/costs.jsonl'
```

Expect `exit 0` and about 10,950 lines. If it stopped early, run `~/prosol-catalog-pull/run-costs-tonight.sh` again that evening; it skips what is priced.

Bring the costs to the laptop and rebuild the counts:

```
cd ~/daddy-dev/run-orders-automayt
scp fred@freds-mac-mini.taila452b5.ts.net:prosol-catalog-pull/data/prosol-catalog/2026-10-14/costs.jsonl data/prosol-catalog/2026-10-14/costs.jsonl
node scripts/automayt/prosol-catalog-report.js --date=2026-10-14
```

The snapshot folder is gitignored. If it is missing, copy it from `~/daddy-dev/run-orders-prosol-catalog/data/prosol-catalog/2026-10-14` or from the Mini.

## A. Staging key

Ask Aaron first: staging is CFC's own tenant and it is fine to load the real catalogue codes there. beta1 never gets real codes.

1. **Key.** In the laptop worktree's `.env`: `AUTOMAYT_API_BASE=https://staging.automayt.dev/api/v1` and `AUTOMAYT_API_KEY=<staging key>`. If a call returns `403 ip_not_allowed`, the error names our public IP; send it to Aaron.
2. **Fixed records.** `node scripts/automayt/map-fixed.js` lists the six (Shopify and Amazon house customers, Prosol, Treeco, Sechelt warehouse, Amazon Fulfillment virtual location) with candidates. For each: `node scripts/automayt/map-fixed.js map <name> <id>`, read the record it prints, then the same command with `--confirm`. A mapping can never be re-pointed. Vendors and locations must exist first. The API takes `POST /vendors` and `POST /locations` since 2026-10-23, but they're Automayt's records: Aaron sets them up unless Mac says otherwise.
3. **Call shapes.** `node scripts/automayt/beta1-e2e.js` then `node scripts/automayt/replay-on-beta1.js`. Both refuse production, and both use `ROTEST-` test codes. Every step should be green; the reports land in `data/automayt-e2e/`.

   **One real day (the sample for Automayt):** copy a recent day's pipeline state from the Mini, then replay every Amazon parcel and Shopify order of that day at what Amazon and Shopify actually charged (ROTEST- order numbers, placeholder buyers, each run twice):

   ```
   scp fred@freds-mac-mini.taila452b5.ts.net:run-orders/data/ops-state/2026-10-22.json data/ops-state/ && node scripts/automayt/replay-on-beta1.js --day=2026-10-22
   ```

   It sets up the two rehearsal house customers under `run-orders-test` if they're missing (as beta1-e2e does) and never maps anything under `run-orders`. 2026-10-22 = 5 Amazon parcels onto the period order + 1 Shopify order. On CFC's beta1 tenant (2026-10-23, report `replay-day-2026-10-22-261023174601.json`) 4 parcels and the Shopify order went through at the charged prices; the KERDI-BOARD kit (`KBKIT`) failed with `409 DUPLICATE_BARCODE`, because the tenant's own items (`PRD-0001`..`PRD-3212`, loaded 2026-10-20) carry no vendor codes, so run-orders can't find `PRD-2502` by its Prosol code and its auto-create collides on the barcode. Production with real codes would fail the same way until those items carry vendor codes. After the catalogue load (step 4), run it again with `--real-codes` (staging only) so the lines land on the real catalogue items instead of auto-created `ROTEST-` ones. A Shopify SKU that is neither in the sku-map nor in the Prosol catalogue (2026-10-20: TORLYS Bulldog `04083`/`04084`, Salesforce-only items) fails with "Item not found" until Automayt's own item load brings it in; production would fail the same way.
4. **Catalogue.** Dry run first, then the real load (about 3.3 hours at 55 writes a minute; safe to re-run, it carries on where it stopped):

   ```
   node scripts/automayt/prosol-catalog-import.js --date=2026-10-14 --real-codes
   node scripts/automayt/prosol-catalog-import.js --date=2026-10-14 --real-codes --apply
   ```

   10,723 items: flooring with known coverage per sq ft or ft, 209 flooring products with no coverage left out (`flooring-no-coverage.csv`), and the 11 Perfect Level Master codes listed twice by Prosol merged into one item each. Progress: `data/prosol-catalog/2026-10-14/import-staging.jsonl`.
5. **Shadow on the Mini (needs Mac's go: it is a live deploy).** Merge `automayt` into `main` (the default `ERP_BACKEND=salesforce` changes nothing) and deploy the usual way: push, `git status` on the Mini for local edits, pull, restart. Then in the Mini's `~/run-orders/.env`:

   ```
   AUTOMAYT_API_BASE=https://staging.automayt.dev/api/v1
   AUTOMAYT_API_KEY=<staging key>
   ERP_BACKEND=automayt-shadow
   ```

   Restart only when no pass is running (`curl -s localhost:3456/api/scheduled-run` shows `running: false`): `launchctl kickstart -k gui/$(id -u)/com.fred.run-orders`. The fixed-record mappings live in Automayt, so step 2 already covers the Mini.
6. **Read the shadow results.** Every order Salesforce takes is mirrored to Automayt after Salesforce answers; Salesforce is never affected. One line per mirror:

   ```
   grep '"type":"automayt-shadow"' ~/run-orders/data/audit.jsonl | tail -20
   grep '"type":"automayt-shadow"' ~/run-orders/data/audit.jsonl | grep -c '"ok":true'
   grep '"type":"automayt-shadow"' ~/run-orders/data/audit.jsonl | grep '"ok":false'
   ```

   Each line has `kind`, `ref`, `ok`, `error`, `soNumber`, `poNumber` and `requestIds` (quote those to Aaron for anything odd).
7. **Rollback.** Remove `ERP_BACKEND` from the Mini's `.env` (or set it to `salesforce`) and restart. Salesforce never stopped, so nothing else is needed. Test records in staging can stay.

## B. Production key (before Nov 1)

The live key only works from the Mini's IPs, so production runs happen on the Mini.

1. **Keep shadow pointed at staging.** Never put the live key in `~/run-orders/.env` before cutover: shadow mode would then write real orders into production.
2. **Catalogue into production, before Automayt's QOH load** (the order agreed with Aaron). Run it from `~/prosol-catalog-pull`, which already has the snapshot and costs. Update its code from the laptop, then keep the live key in a file of its own:

   ```
   rsync -a --exclude node_modules --exclude .git --exclude .env --exclude 'data/*' ~/daddy-dev/run-orders-automayt/ fred@freds-mac-mini.taila452b5.ts.net:prosol-catalog-pull/
   ssh fred@freds-mac-mini.taila452b5.ts.net
   cd ~/prosol-catalog-pull
   # .env.production holds AUTOMAYT_API_BASE=https://app.automayt.com/api/v1 and AUTOMAYT_API_KEY=amk_live_..., chmod 600
   set -a; . ./.env.production; set +a
   node scripts/automayt/map-fixed.js
   node scripts/automayt/prosol-catalog-import.js --date=2026-10-14 --production
   node scripts/automayt/prosol-catalog-import.js --date=2026-10-14 --production --apply
   ```

   Then send Aaron `qoh-exceptions-54.csv` for the QOH load.
3. **Cutover (Nov 1).** Follow "Cutover steps" in `docs/AUTOMAYT.md`. The Amazon period is split at the cutover (Mac, 2026-10-19): Oct 22 - 31 stays on the Salesforce order, and run-orders opens `period:2026-11-01` (Nov 1 - 4) in Automayt with the first November parcel. Nothing to map.
