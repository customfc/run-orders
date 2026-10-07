#!/usr/bin/env node
// See docs/REFUNDS.md. Importing this module never loads credentials or runs a refund.
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { parseArgs, buildPlan, buildXml, readPages, createAttemptStore, money } = require('../../lib/amazon-refund');

const HELP = `Preview a partial refund (Amazon OrderItemId, not SKU):
  node scripts/ops/issue-refund.js --order=123-1234567-1234567 --reason=CouldNotShip --item=12345678901234:1
Preview the whole order, including its item IDs:
  node scripts/ops/issue-refund.js --order=123-1234567-1234567 --reason=CustomerReturn --full
Submit only after reviewing the preview and evidence:
  append --commit --expected-total=123.45 --evidence="verified parcel/item facts and Mac's approval reference"
Repeat --item for multiple lines. CAD/MFN only. Defaults to dry-run.
Existing refunds/claims, local attempts, promotions and unreconciled charges require manual review.`;

function responseJson(response, expectedStatus, context) {
  if (response?.status !== expectedStatus) throw new Error(`${context} failed (HTTP ${response?.status}); reconcile any pending attempt before retrying`);
  const data = JSON.parse(response.body);
  if (!data || typeof data !== 'object' || data.errors) throw new Error(`Invalid ${context} response`);
  return data;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Feed result download failed: HTTP ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Feed result download timed out')));
  });
}

async function run(argv, deps) {
  const opts = parseArgs(argv);
  if (opts.help) { (deps?.log || console.log)(HELP); return; }
  const { sp, audit, store, seller, marketplace, log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)), getDocument = download } = deps;
  if (!marketplace || !seller) throw new Error('Seller ID and marketplace must be configured');
  store.assertClear(opts.order);
  const orderResponse = await sp.getOrder(opts.order);
  const order = orderResponse?.payload || orderResponse;
  if (order?.MarketplaceId !== marketplace) throw new Error('Order marketplace does not match configured marketplace');
  await readPages(page => sp.listFinancialEventsByOrder(opts.order, page), 'FinancialEvents');
  const items = await readPages(page => sp.getOrderItems(opts.order, page), 'OrderItems');
  const plan = buildPlan(order, items, opts);
  const body = buildXml(plan, seller);
  log(`${plan.full ? 'FULL ORDER' : 'PARTIAL'} REFUND — ${plan.order}`);
  for (const item of plan.items) log(`${item.id} | ${item.sku} | ${item.quantity}/${item.quantityOrdered} units | ${Object.entries(item.components).map(([k, v]) => `${k} ${money(v)}`).join(' | ')}`);
  log(`TOTAL ${money(plan.totalCents)} CAD — ${plan.reason}`);
  log(`Evidence / approval: ${plan.evidence || '(required before commit)'}`);
  log(body);
  if (!opts.commit) { log('DRY RUN — nothing submitted.'); return plan; }

  store.reserve(plan);
  // Refresh refund/claim history under the local lock immediately before writes.
  await readPages(page => sp.listFinancialEventsByOrder(opts.order, page), 'FinancialEvents');
  const contentType = 'text/xml; charset=UTF-8';
  const document = responseJson(await sp.spApiRequest('POST', '/feeds/2021-06-30/documents', { body: { contentType } }), 201, 'createFeedDocument');
  if (!document.feedDocumentId || !document.url) throw new Error('Missing feed document ID or upload URL');
  const upload = await sp.putToUrl(document.url, body, contentType);
  if (upload.status !== 200) throw new Error(`Feed upload failed: HTTP ${upload.status}`);
  // Persist the document ID before createFeed: a timeout can hide acceptance.
  store.update(plan, { status: 'submitting', feedDocumentId: document.feedDocumentId });
  const created = responseJson(await sp.spApiRequest('POST', '/feeds/2021-06-30/feeds', {
    body: { feedType: 'POST_PAYMENT_ADJUSTMENT_DATA', marketplaceIds: [marketplace], inputFeedDocumentId: document.feedDocumentId },
  }), 202, 'createFeed');
  if (!created.feedId) throw new Error('Amazon did not return a feed ID; reconcile before retrying');
  const state = { status: 'submitted', feedId: created.feedId, feedDocumentId: document.feedDocumentId };
  store.update(plan, state);
  audit.log({ action: 'amazon-refund-submitted', order: plan.order, amount: Number(money(plan.totalCents)), currency: plan.currency, reason: plan.reason, feedId: created.feedId, items: plan.items, evidence: plan.evidence, full: plan.full });
  log(`Feed submitted: ${created.feedId}. Acceptance is not proof that the refund processed.`);

  for (let i = 0; i < 20; i++) {
    await sleep(15000);
    const feed = responseJson(await sp.spApiRequest('GET', `/feeds/2021-06-30/feeds/${created.feedId}`), 200, 'getFeed');
    log(`Feed status: ${feed.processingStatus}`);
    if (['FATAL', 'CANCELLED'].includes(feed.processingStatus)) {
      store.update(plan, { ...state, status: feed.processingStatus });
      throw new Error(`Feed ${created.feedId} ${feed.processingStatus}; inspect Amazon before any retry`);
    }
    if (feed.processingStatus !== 'DONE') continue;
    if (!feed.resultFeedDocumentId) throw new Error('DONE feed has no processing report; outcome is unverified');
    const report = responseJson(await sp.spApiRequest('GET', `/feeds/2021-06-30/documents/${feed.resultFeedDocumentId}`), 200, 'getFeedDocument');
    if (!report.url) throw new Error('Missing processing report URL');
    let bytes = await getDocument(report.url);
    if (report.compressionAlgorithm === 'GZIP') bytes = zlib.gunzipSync(bytes);
    else if (report.compressionAlgorithm) throw new Error('Unsupported processing report compression');
    const text = bytes.toString('utf8');
    const count = tag => Number(text.match(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`))?.[1] ?? NaN);
    const complete = /<StatusCode>\s*Complete\s*<\/StatusCode>/.test(text);
    const successful = complete && count('MessagesProcessed') === 1 && count('MessagesSuccessful') === 1 && count('MessagesWithError') === 0;
    store.update(plan, { ...state, status: successful ? 'processed' : 'needs-review', resultFeedDocumentId: feed.resultFeedDocumentId, processingReport: text });
    log(text);
    if (!successful) throw new Error(`Feed ${created.feedId} did not confirm one successful adjustment; review the saved report`);
    log('Processing report confirms the adjustment. Verify the posted refund in Amazon Payments.');
    return { ...plan, feedId: created.feedId };
  }
  throw new Error(`Feed ${created.feedId} still pending. Check that feed; do not resubmit.`);
}

if (require.main === module) {
  // Parse before loading credentials: typos and missing approvals fail offline.
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return; }
    require('dotenv').config();
    await run(process.argv.slice(2), {
      sp: require('../../lib/sp-api'), audit: require('../../lib/audit'),
      store: createAttemptStore(path.join(__dirname, '..', '..', 'data')),
      seller: (process.env.AMAZON_SELLER_ID || '').replace(/"/g, '').trim(),
      marketplace: (process.env.AMAZON_SP_MARKETPLACE_ID || '').replace(/"/g, '').trim(),
    });
  })().catch(error => { console.error(`ABORT: ${error.message}`); process.exitCode = 1; });
}

module.exports = { run };
