// Refund planning is independent of network and environment loading.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const REASONS = new Set(['CouldNotShip', 'CustomerReturn', 'NoInventory', 'GeneralAdjustment', 'DifferentItem', 'Abandoned', 'CustomerCancel', 'PriceError']);
const COMPONENTS = { Principal: 'ItemPrice', Tax: 'ItemTax', Shipping: 'ShippingPrice', ShippingTax: 'ShippingTax' };
const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;

function cents(value, label) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`${label}: expected a non-negative decimal amount`);
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(amount)) throw new Error(`${label}: amount is too large`);
  return amount;
}
const money = (value) => (value / 100).toFixed(2);

function parseArgs(argv) {
  const opts = { items: [], full: false, commit: false };
  const seen = new Set();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Invalid argument: ${arg}`);
    const [, key, value] = match;
    if (!['order', 'reason', 'item', 'full', 'commit', 'expected-total', 'evidence', 'help'].includes(key)) throw new Error(`Unknown option: --${key}`);
    if (seen.has(key) && key !== 'item') throw new Error(`Duplicate option: --${key}`);
    seen.add(key);
    if (['full', 'commit', 'help'].includes(key)) {
      if (value !== undefined) throw new Error(`--${key} does not take a value`);
      opts[key] = true;
    } else {
      if (!value?.trim()) throw new Error(`--${key} requires a value`);
      if (key === 'item') {
        const item = /^(\d+):([1-9]\d*)$/.exec(value);
        if (!item || !Number.isSafeInteger(Number(item[2]))) throw new Error('--item must be OrderItemId:positiveQuantity');
        if (opts.items.some(i => i.id === item[1])) throw new Error(`Duplicate item: ${item[1]}`);
        opts.items.push({ id: item[1], quantity: Number(item[2]) });
      } else opts[key] = value;
    }
  }
  if (opts.help) return opts;
  if (!ORDER_ID.test(opts.order || '')) throw new Error('--order must be an Amazon order ID');
  if (!REASONS.has(opts.reason)) throw new Error(`Explicit --reason required; choose ${[...REASONS].join(', ')}`);
  if (opts.full === (opts.items.length > 0)) throw new Error('Choose either --full or one or more --item=OrderItemId:quantity; no implicit full refunds');
  if (opts['expected-total'] !== undefined) opts.expectedCents = cents(opts['expected-total'], '--expected-total');
  if (opts.commit && (!(opts.expectedCents > 0) || !opts.evidence?.trim())) throw new Error('--commit requires --expected-total and --evidence describing the verified basis and approval');
  return opts;
}

function readMoney(item, field, currency, required = false) {
  if (item[field] === undefined && !required) return 0;
  const value = item[field];
  if (!value || value.CurrencyCode !== currency) throw new Error(`${field}: missing amount or currency mismatch`);
  return cents(value.Amount, field);
}

function buildPlan(order, items, opts) {
  if (!order || order.AmazonOrderId !== opts.order) throw new Error('Missing or mismatched Amazon order');
  if (order.FulfillmentChannel !== 'MFN') throw new Error('Only merchant-fulfilled (MFN) orders are supported');
  if (!['Shipped', 'PartiallyShipped', 'Unshipped'].includes(order.OrderStatus)) throw new Error(`Order status ${order.OrderStatus} requires manual review`);
  if (order.OrderTotal?.CurrencyCode !== 'CAD') throw new Error('Only CAD refunds are supported by this tool');
  const orderTotal = cents(order.OrderTotal.Amount, 'OrderTotal');
  if (!Array.isArray(items) || !items.length) throw new Error('No order items returned');
  const ids = new Set();
  let itemTotal = 0;
  const lines = items.map(item => {
    if (!/^\d+$/.test(item.OrderItemId || '') || ids.has(item.OrderItemId)) throw new Error('Missing or duplicate OrderItemId');
    ids.add(item.OrderItemId);
    if (!Number.isSafeInteger(item.QuantityOrdered) || item.QuantityOrdered < 1) throw new Error(`Invalid quantity for ${item.OrderItemId}`);
    // Avoid inventing promotion offsets or silently omitting charged components.
    for (const field of ['PromotionDiscount', 'PromotionDiscountTax', 'ShippingDiscount', 'ShippingDiscountTax', 'GiftWrapPrice', 'GiftWrapTax', 'CODFee', 'CODFeeDiscount']) {
      if (readMoney(item, field, 'CAD') !== 0) throw new Error(`${field} on ${item.OrderItemId} requires manual refund review`);
    }
    const components = Object.fromEntries(Object.entries(COMPONENTS).map(([type, field]) => [type, readMoney(item, field, 'CAD', type === 'Principal')]));
    itemTotal += Object.values(components).reduce((a, b) => a + b, 0);
    return { id: item.OrderItemId, sku: item.SellerSKU, quantityOrdered: item.QuantityOrdered, components };
  });
  if (!Number.isSafeInteger(itemTotal) || itemTotal !== orderTotal) throw new Error('Order-item charges do not reconcile exactly to OrderTotal; manual review required');
  const selections = opts.full ? lines.map(i => ({ id: i.id, quantity: i.quantityOrdered })) : opts.items;
  const selectedIds = new Set();
  const adjusted = selections.map(selection => {
    const line = lines.find(i => i.id === selection.id);
    if (!line) throw new Error(`Item ${selection.id} is not on this order`);
    if (selectedIds.has(line.id)) throw new Error(`Duplicate item: ${line.id}`);
    selectedIds.add(line.id);
    if (!Number.isSafeInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > line.quantityOrdered) throw new Error(`Refund quantity exceeds ordered quantity or is invalid for ${line.id}`);
    // API amounts are line totals. Round each selected component half-up to
    // cents; expected-total approval pins the exact result before submission.
    const components = Object.fromEntries(Object.entries(line.components).map(([type, value]) => {
      const numerator = BigInt(value) * BigInt(selection.quantity);
      const denominator = BigInt(line.quantityOrdered);
      return [type, Number((numerator * 2n + denominator) / (denominator * 2n))];
    }));
    return { ...line, quantity: selection.quantity, components };
  });
  if (!adjusted.length) throw new Error('No items selected');
  if (!opts.full && adjusted.length === lines.length && adjusted.every(i => i.quantity === i.quantityOrdered)) throw new Error('Selection covers the entire order; use explicit --full');
  const totalCents = adjusted.reduce((sum, i) => sum + Object.values(i.components).reduce((a, b) => a + b, 0), 0);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > orderTotal) throw new Error('Invalid refund total');
  if (opts.expectedCents !== undefined && opts.expectedCents !== totalCents) throw new Error(`Expected total ${money(opts.expectedCents)} does not match calculated refund ${money(totalCents)} CAD`);
  return { order: opts.order, currency: 'CAD', reason: opts.reason, full: opts.full, items: adjusted, totalCents, evidence: opts.evidence || null };
}

const esc = value => String(value).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function buildXml(plan, seller) {
  if (!seller?.trim()) throw new Error('AMAZON_SELLER_ID is required');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">',
    '<Header><DocumentVersion>1.01</DocumentVersion>',
    `<MerchantIdentifier>${esc(seller)}</MerchantIdentifier></Header>`,
    '<MessageType>OrderAdjustment</MessageType><Message><MessageID>1</MessageID><OrderAdjustment>',
    `<AmazonOrderID>${esc(plan.order)}</AmazonOrderID>`,
    '<ActionType>Refund</ActionType>',
    ...plan.items.flatMap(item => [
      '<AdjustedItem>',
      `<AmazonOrderItemCode>${esc(item.id)}</AmazonOrderItemCode>`,
      `<AdjustmentReason>${esc(plan.reason)}</AdjustmentReason>`,
      '<ItemPriceAdjustments>',
      ...Object.entries(item.components).filter(([type, amount]) => type === 'Principal' || amount > 0).map(([type, amount]) =>
        `<Component><Type>${type}</Type><Amount currency="${plan.currency}">${money(amount)}</Amount></Component>`),
      '</ItemPriceAdjustments>',
      `<Quantity>${item.quantity}</Quantity>`,
      '</AdjustedItem>',
    ]),
    '</OrderAdjustment></Message></AmazonEnvelope>',
  ].join('\n');
}

async function readPages(fetchPage, field) {
  const results = [];
  const seen = new Set();
  let nextToken;
  do {
    const response = await fetchPage({ nextToken });
    const page = response?.payload || response;
    if (!page || typeof page !== 'object' || Array.isArray(page) || page.errors || !(field in page)) throw new Error(`Invalid ${field} API response; refusing to assume empty data`);
    const value = page[field];
    if (field === 'OrderItems') {
      if (!Array.isArray(value)) throw new Error('Invalid OrderItems response');
      results.push(...value);
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid FinancialEvents response');
      for (const key of ['RefundEventList', 'GuaranteeClaimEventList', 'ChargebackEventList']) {
        if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error(`Invalid ${key}`);
        if (value[key]?.length) throw new Error(`${key} already exists; refusing another refund`);
      }
    }
    nextToken = page.NextToken;
    if (nextToken != null && (typeof nextToken !== 'string' || !nextToken.trim() || seen.has(nextToken))) throw new Error('Invalid or repeated pagination token');
    if (nextToken) seen.add(nextToken);
    if (seen.size > 1000) throw new Error('Pagination limit exceeded');
  } while (nextToken);
  return results;
}

function createAttemptStore(dataDir) {
  const dir = path.join(dataDir, 'refund-attempts');
  function attemptPath(order) {
    if (!ORDER_ID.test(order)) throw new Error('Invalid order ID');
    return path.join(dir, `${order}.json`);
  }
  function assertClear(order) {
    if (fs.existsSync(attemptPath(order))) throw new Error('A local refund attempt exists. Reconcile it with Amazon before any retry; do not delete it blindly.');
    const auditPath = path.join(dataDir, 'audit.jsonl');
    if (!fs.existsSync(auditPath)) throw new Error('Local audit history is missing; use the production host with its complete refund history');
    for (const line of fs.readFileSync(auditPath, 'utf8').split('\n').filter(s => s.trim())) {
      let entry;
      try { entry = JSON.parse(line); } catch { throw new Error('Unreadable audit history; manual reconciliation required'); }
      if (!entry || typeof entry !== 'object') throw new Error('Invalid audit record');
      if (entry.order === order && entry.action === 'amazon-refund-submitted') throw new Error('Refund already submitted in audit history; refusing another refund');
    }
  }
  return {
    assertClear,
    reserve(plan) {
      assertClear(plan.order);
      fs.mkdirSync(dir, { recursive: true });
      // Exclusive creation serializes attempts on this host. Keep the marker
      // after crashes, timeouts and failures with unknown outcomes.
      const fd = fs.openSync(attemptPath(plan.order), 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ ...plan, status: 'reserved', at: new Date().toISOString() }, null, 2));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    },
    update(plan, state) {
      const destination = attemptPath(plan.order);
      if (!fs.existsSync(destination)) throw new Error('Refund attempt must be reserved before update');
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ ...plan, ...state, at: new Date().toISOString() }, null, 2));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      // Preserve the previous complete record if writing the next state fails.
      fs.renameSync(temporary, destination);
    },
  };
}

module.exports = { parseArgs, buildPlan, buildXml, readPages, createAttemptStore, money };
