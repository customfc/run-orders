# Pre-map the yourfloors.ca catalogue, and stop auto-routing to Sechelt

Spec written 2026-11-02 for a fresh session. Mac said go ("alright spec it for a new session") after reading the plan below. Run this session on Opus 5.5: it writes the production sku-map and changes how live orders route, so nothing here moves to a lower tier.

## Why

Two website orders held at staging on 2026-11-02 because their SKUs had no sku-map key: #1443 ($1,083 DITRA-HEAT kit) and #1441 (11564, Sealer's Choice Gold pint). They are fixed: all 49 active DITRA-HEAT variants and 11564 are mapped (commits 4ce6c5d, d433c23, dd0af43, c21904b). The cause is wider. 1,151 active Shopify variant SKUs (38%) still have no key, so the first order for any of them holds the same way. The map is keyed by channel SKU, and many products sit only under an Amazon ASIN or a pre-rebuild Shopify code.

## Mac's rule (2026-11-02, his words)

"we prefer not to ship anything from sechelt, unless i say so."

Map to Prosol by default, even when Shopify shows Sechelt stock. A Sechelt route happens only when Mac approves it. Numeric Shopify SKUs (11564 and the like) are Salesforce / Automayt item numbers: find the Prosol product for them (11564 = C030881 / C030881-05), do not route them to Sechelt.

## Part A: the sku-resolver stops choosing Sechelt

Today `lib/sku-resolver.js` maps a SKU to Sechelt with no human in two places, both against the rule:

1. Exact tier, `decideExact` (L130): Shopify SKU = one ERP item of that name + Shopify Sechelt stock covers the quantity, so it writes `route_to: CFC_SECHELT`, `discovered_by: sku-resolver-exact`. It is applied during staging and audited in `handleStageResult` (L744, `by: auto-exact`). Grep `autoMapped` / `decideExact` in `scripts/shipstation/run-orders.js` and `lib/pipeline.js` to find where staging calls it.
2. Opus tier 2c, `decideAutoApply` (L518, `p.route === 'sechelt'`): a high or medium confidence Sechelt proposal that passes the ERP-description guard and Sechelt stock is auto-applied as `opus-auto`.

Change:

- The exact tier never auto-maps. A Sechelt identity match stays useful evidence: keep it as the line's `exactReason` text (say "Sechelt has N, needs Mac's OK") so Opus and Mac's email see it, then let the line go on to the Opus tier.
- `decideAutoApply` returns a reason for every Sechelt route ("Sechelt route needs Mac's OK (policy 2026-11-02)"), so a Sechelt proposal goes out on the normal approve-link email. The approve link (`/sku-resolver/approve`) still applies a Sechelt entry: that is Mac's "unless I say so", one tap.
- Opus prompt (L328, route "sechelt" text): Prosol first. Propose Sechelt only when Prosol does not carry the product. A numeric SKU is our ERP item number: use its vendor item ID / description to find the Prosol code.
- `decideTwin` already refuses Sechelt; leave it.
- Grep `CFC_SECHELT` across `lib/` and `scripts/` for any other code that writes a Sechelt route without Mac (auto-map.js, map-by-barcode.js, automayt-settle.js). Report what you find; change only auto-writes.
- One more reason this is right: under `ERP_BACKEND=automayt` the Sechelt / Powell River counts in Shopify stopped updating on Oct 31 (see `lib/CLAUDE.md`, erp-mode.js), so the stock check the auto tiers rely on is reading frozen numbers.
- Tests: flip the cases in `lib/sku-resolver.test.js` that expect a Sechelt auto-apply (L22 "maps the #1388 trowel to Sechelt", L484 "applies a Sechelt proposal ... with no email", the L413 to L423 block, the L128 to L135 audit case) so they expect the email instead, and add one test that the approve link still applies a Sechelt entry.
- Docs: update the sku-resolver line in `lib/CLAUDE.md` and the header comment at the top of `lib/sku-resolver.js`.

## Part B: write the store-wide pre-map

The tool is built and dry-run. It is NOT merged and nothing has been written.

- Branch `premap-catalog`, commit 8f60f66, worktree `.claude/worktrees/agent-a904e0d9792c774b0`. Files: `lib/premap-catalog.js` (pure decisions), `lib/premap-catalog.test.js` (13 tests), `scripts/ops/premap-catalog.js` (CLI, usage in its header), `.gitignore` line for `data/premap-catalog/`, a `lib/CLAUDE.md` edit.
- Dry-run output (gitignored, in that worktree): `data/premap-catalog/premap-catalog-2026-11-02.csv` (one row per unkeyed SKU with tier and reason) and `premap-catalog-2026-11-02.plan.json` (`entries` = 668 `[key, entry]` pairs).
- Dry-run numbers: 668 mappable. 135 are aliases: the Shopify SKU is the `api_sku` of an existing verified entry (an ASIN or old key), copied over. 533 are exact Prosol matches: the Shopify SKU is a Prosol storefront code and Prosol's name passes the mapping guard against the Shopify title. 483 are skipped: 257 flooring, 198 numeric Salesforce item numbers, 11 non-Prosol brands, 7 guard failures, 1 ambiguous code. Every entry routes to Prosol, which fits Mac's rule.

Steps:

1. Work in a fresh worktree off `origin/main`, not the main checkout. The main checkout at `~/daddy-dev/run-orders` has another session's uncommitted edits (`lib/CLAUDE.md`, `server.js`, `scripts/trade/counter-stock-sync.js`): never commit, stash or discard them. In the new worktree run a real `npm ci` (symlinked node_modules break), and link `.env` from the main checkout. Check env keys by NAME only, never print values.
2. Merge `premap-catalog`. Expect a conflict in `lib/CLAUDE.md` (the branch rewrote the `map-rules.js` line and added a premap line; main has changed since). Keep both sides' facts.
3. Tighten the review before writing. The mapping guard is lenient: it checks product words, not size, length, colour or pack count. Over the 533 Prosol-tier entries, compare the size / length / colour / pack tokens (mm, in, ", ft, ml, L, qt, gal, kg, lb, pc, pack, colour names) between the Shopify product + variant title and Prosol's product name. Any mismatch, or a title you can't parse, comes out of the plan: the resolver handles it on its first order. Give the 47 all-digit keys (Rubi 20906, Olfa 1086562, Roberts 10-194 ...) the same check plus a brand check (Shopify vendor = Prosol brand). Then read 40 random survivors and every borderline one yourself. Log how many you dropped and why.
4. Refresh costs. The 135 alias entries carry `cost_cad` copied from old entries (`cost_source` like `prosol-portal-2026-05-11`). Re-price them from Prosol offers (`ProsolClientV2`, `getOfferPrice`), one request every 2 s (Prosol is the live vendor site, be gentle; about 5 min). Update `cost_cad` + `cost_source`, and list any change over 10%.
5. Write the reviewed plan: `node scripts/ops/premap-catalog.js --write --plan=<reviewed plan.json>`. This makes no Shopify or Prosol calls. `writeEntry` skips any key that exists now, so the DITRA-HEAT keys and 11564 added since the dry run are left alone (the plan's 320012 entry, for one, will be skipped: 320012 is already mapped to DHEHKSK).
6. Tests: `node --test $(ls scripts/shipstation/*.test.js lib/*.test.js | grep -v pickup-runner.test.js)`. `lib/pickup-runner.test.js` hangs `npm test` (pre-existing), so leave it out. Everything else must pass (669 before this work).

## Part C: the 26 SKUs already set to Sechelt

`sku-map.json` has 26 entries with `route_to: CFC_SECHELT`. 25 were set by hand. One, 4657 (Aqua Mix Enrich N' Seal quart), was auto-mapped by the resolver's exact tier on 2026-10-05, which the rule forbids. Find its Prosol product (Aqua Mix has different `api_sku` and `prosol_sku`, like 11564 = C030881 / C030881-05) and repoint it to Prosol in the same commit. Leave the 25 hand-set ones as they are, and list them (key, product) in the report so Mac can say which, if any, move to Prosol.

## Deploy (one atomic step)

The sku-map is loaded once at server start (`scripts/shipstation/run-orders.js` L99, required in-process by `server.js` / `pipeline.js`). Cron passes do NOT reload it, so nothing takes effect until a restart.

1. Commit (sku-map.json + resolver + premap tool + docs) and push to main.
2. Pick a quiet window: read the schedule in `server.js`. On 2026-11-02 the passes ran in BC time at 10:00 and 11:30 (stage), 12:00 (email), 12:30 (pickups), 13:00 (digest). Restart after the digest or before the first morning pass, never during a pass (no concurrent runs, and a kickstart kills a running one).
3. On the Mini (`ssh fred@freds-mac-mini.taila452b5.ts.net`, repo `~/run-orders` or the path in `reference_mac_mini_access`): `git status` first. The resolver writes `sku-map.json` there itself, so expect local changes. Diff them, fold anything worth keeping into a follow-up commit, back up the file to `/tmp/sku-map-mini-<date>.json`, `git checkout -- scripts/shipstation/sku-map.json`, then `git pull --ff-only`.
4. `launchctl kickstart -k gui/$(id -u)/com.fred.run-orders`, then confirm a new PID and the :3456 listener.
5. Check it took: on the Mini, `node -e` load the map and print the key count and three new keys (one alias, one Prosol tier, 4657).

## Done when

- No code path maps a SKU to Sechelt without Mac's tap, with tests proving it.
- The reviewed pre-map is in `sku-map.json` on the Mini and loaded (restart verified).
- 4657 routes to Prosol.
- Mac gets a short report in the session: entries written by tier, dropped by the size check (with 3 examples), cost changes over 10%, the 25 hand-set Sechelt SKUs, commit hashes, the restart time in BC. No email to anyone.

## Standing rules that apply

- No vendor or customer email at all in this work.
- Times in Pacific / BC.
- Atomic deploy; check Mini divergence before pulling.
- Memory to update when done: `project_shopify_sku_map_coverage.md` (mark the premap written and the resolver change live).
