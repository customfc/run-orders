#!/usr/bin/env node
/**
 * Amazon FBM buy-box defender.
 *
 * For each managed SKU in data/buybox-defender-config.json:
 *   - Pulls current buy-box + all competing offers
 *   - If we are not the buy-box winner and a competitor is cheaper:
 *       compute undercut price = competitor × 0.98
 *       if undercut keeps margin >= min_margin_pct AND within min_price..max_price: PATCH our price
 *       else: alert and do not undercut (we'd lose money)
 *   - If we are the buy-box winner AND the next competitor is far above us:
 *       optionally raise our price to (next_competitor × 0.98) to capture more margin
 *       only if our current price > min_price + $1
 *
 * Logs to data/buybox-defender-log.jsonl (one line per SKU per run).
 * Sends Telegram alert on any material action.
 *
 * Run via:   node scripts/amazon-buybox-defender.js [--dry-run] [--sku=...]
 * Cron:      daily at 09:00 PT (or wherever the user's launchd schedule fires)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { getItemOffersBatch, updateListingPrice } = require('../lib/sp-api');
const { notify } = require('../lib/telegram');

const CONFIG = path.join(__dirname, '..', 'data', 'buybox-defender-config.json');
const LOG = path.join(__dirname, '..', 'data', 'buybox-defender-log.jsonl');
const REFERRAL = 0.15;
const RETURNS = 0.04;
const PICK_PACK = 1.50;
const UNDERCUT_FACTOR = 0.98;
const MIN_PRICE_DELTA = 0.05;

function marginAt(sell, wholesale, ship, strategy) {
  const base = sell * (1 - REFERRAL - RETURNS) - wholesale - PICK_PACK;
  return strategy === 'free_shipping' ? base - ship : base - REFERRAL * ship;
}

function marginPct(sell, wholesale, ship, strategy) {
  return sell > 0 ? (100 * marginAt(sell, wholesale, ship, strategy)) / sell : -100;
}

function parseArgs() {
  const a = { dryRun: false, sku: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--sku=')) a.sku = arg.slice(6);
  }
  return a;
}

function logLine(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

async function decide(skuCfg, offersPayload) {
  const { sku, asin, wholesale, ship_cost, shipping_strategy, min_margin_pct, min_price, max_price, name } = skuCfg;
  const offers = offersPayload?.payload?.Offers || [];
  const sellerId = (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '');

  const allInPrice = (o) => Number(o.ListingPrice?.Amount || 0) + Number(o.Shipping?.Amount || 0);

  const ourOffer = offers.find((o) => o.SellerId === sellerId);
  const competitors = offers.filter((o) => o.SellerId !== sellerId);

  if (!ourOffer) {
    return {
      sku, asin, name, action: 'not_listed_or_not_visible',
      n_offers: offers.length,
      reason: 'Our offer not visible in the listing yet — may still be propagating after creation.',
    };
  }

  const ourPrice = allInPrice(ourOffer);
  const ourBuyBox = !!(ourOffer.IsBuyBoxWinner || ourOffer.IsFeaturedMerchant);
  const lowestCompetitor = competitors.reduce((m, o) => {
    const p = allInPrice(o);
    return m === null || p < m ? p : m;
  }, null);

  const base = { sku, asin, name, ourPrice, ourBuyBox, lowestCompetitor, n_offers: offers.length };

  if (lowestCompetitor === null) {
    return { ...base, action: 'no_competition', reason: 'No other sellers — we own the listing.' };
  }

  if (ourPrice <= lowestCompetitor + MIN_PRICE_DELTA) {
    return { ...base, action: 'holding', reason: 'We are at or below cheapest competitor.' };
  }

  const target = Math.round(lowestCompetitor * UNDERCUT_FACTOR * 100) / 100;
  if (target < min_price) {
    return {
      ...base, action: 'alert_underwater', proposed: target,
      reason: `Competitor at $${lowestCompetitor} — undercut $${target} is below our min_price $${min_price}. Withdrawing from competition.`,
    };
  }
  if (target > max_price) {
    return { ...base, action: 'alert_above_max', proposed: target, reason: `Target ${target} > max_price ${max_price}` };
  }

  const newMarginPct = marginPct(target, wholesale, ship_cost, shipping_strategy);
  if (newMarginPct < min_margin_pct) {
    return {
      ...base, action: 'alert_thin_margin', proposed: target, newMarginPct: newMarginPct.toFixed(1),
      reason: `Competitor at $${lowestCompetitor} — undercut to $${target} = ${newMarginPct.toFixed(1)}% margin, below floor ${min_margin_pct}%.`,
    };
  }

  if (Math.abs(target - ourPrice) < MIN_PRICE_DELTA) {
    return { ...base, action: 'holding', reason: 'Target equals current price (no-op).' };
  }

  return {
    ...base, action: 'undercut', proposed: target, newMarginPct: newMarginPct.toFixed(1),
    reason: `Competitor at $${lowestCompetitor}; undercutting to $${target} (margin ${newMarginPct.toFixed(1)}%).`,
  };
}

async function main() {
  const args = parseArgs();
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const skus = config.skus.filter((s) => s.active && (!args.sku || s.sku === args.sku));
  if (!skus.length) {
    console.error('No active SKUs to defend.');
    return;
  }

  console.log(`Defender run: ${skus.length} SKU(s)${args.dryRun ? ' [DRY RUN]' : ''}`);
  const asins = skus.map((s) => s.asin);
  const offersPayloads = await getItemOffersBatch(asins);
  const byAsin = new Map();
  for (const r of offersPayloads.responses || []) {
    const asin = r?.request?.Asin;
    if (asin) byAsin.set(asin, r.body || r);
  }

  const decisions = [];
  for (const s of skus) {
    const p = byAsin.get(s.asin);
    if (!p) {
      decisions.push({ sku: s.sku, asin: s.asin, action: 'fetch_failed' });
      continue;
    }
    decisions.push(await decide(s, p));
  }

  const ts = new Date().toISOString();
  const alertsNeeded = [];

  for (const d of decisions) {
    logLine({ ts, ...d });
    console.log(`  ${d.sku.padEnd(12)} ${d.action.padEnd(22)}  ${d.reason || ''}`);

    if (d.action === 'undercut' && args.dryRun) {
      // SHADOW mode — surface the would-be reprice so it's visible in the daily
      // Telegram digest + log, without touching the live price.
      logLine({ ts: new Date().toISOString(), sku: d.sku, action: 'would_reprice', oldPrice: d.ourPrice, newPrice: d.proposed });
      alertsNeeded.push(`🧪 [DRY] ${d.sku} (${d.name}): would reprice $${d.ourPrice} → $${d.proposed} (competitor at $${d.lowestCompetitor}; margin ${d.newMarginPct}%)`);
    } else if (d.action === 'undercut' && !args.dryRun) {
      try {
        const res = await updateListingPrice(d.sku, d.proposed);
        logLine({ ts: new Date().toISOString(), sku: d.sku, action: 'priced', oldPrice: d.ourPrice, newPrice: d.proposed, submissionId: res.submissionId });
        alertsNeeded.push(`✅ ${d.sku} (${d.name}): repriced $${d.ourPrice} → $${d.proposed} (was: competitor at $${d.lowestCompetitor}; margin ${d.newMarginPct}%)`);
      } catch (e) {
        logLine({ ts: new Date().toISOString(), sku: d.sku, action: 'price_failed', error: e.message });
        alertsNeeded.push(`❌ ${d.sku}: reprice FAILED — ${e.message}`);
      }
    } else if (d.action === 'alert_thin_margin') {
      alertsNeeded.push(`⚠️  ${d.sku} (${d.name}): competitor at $${d.lowestCompetitor}, undercut would be ${d.newMarginPct}% margin (floor ${skus.find((s) => s.sku === d.sku).min_margin_pct}%). Holding price; consider exiting.`);
    } else if (d.action === 'alert_underwater') {
      alertsNeeded.push(`⚠️  ${d.sku} (${d.name}): competitor at $${d.lowestCompetitor}, below our min_price floor. Withdrawing.`);
    } else if (d.action === 'fetch_failed' || d.action === 'not_listed_or_not_visible') {
      // No alert — likely propagation; check next run
    }
  }

  if (alertsNeeded.length) {
    const subject = `${args.dryRun ? '🧪 [SHADOW] ' : ''}Amazon buy-box defender: ${alertsNeeded.length} update(s)`;
    await notify('info', subject, alertsNeeded.join('\n\n'));
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Defender error:', e);
  process.exit(1);
});
