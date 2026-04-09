#!/usr/bin/env node

require('dotenv').config();

const express = require('express');
const path = require('path');
const audit = require('./lib/audit');
const { runOrders } = require('./scripts/shipstation/run-orders');
const { scanShippedLabels, bookPickupForBucket } = require('./lib/pickups');
const { fetchShopifyOrder, createShopifySoPo } = require('./lib/shopify-sf');
const { createAmazonPOs, findMostRecentAmazonSO } = require('./lib/amazon-po');
const sfLib = require('./lib/salesforce');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3456;

// Track active SSE connections so we don't run two at once
let runOrdersActive = false;

// ── Run Orders (SSE stream) ─────────────────────────────────────────────────

app.get('/api/run-orders/stream', (req, res) => {
  if (runOrdersActive) {
    res.status(409).json({ error: 'Run-orders is already in progress' });
    return;
  }
  runOrdersActive = true;

  const dryRun = req.query.dryRun === 'true';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', { message: `Starting run-orders (${dryRun ? 'dry run' : 'staging'})...` });

  runOrders({
    dryRun,
    onProgress: (ev) => send('progress', ev),
  }).then((result) => {
    audit.log({
      action: 'run-orders',
      dryRun,
      success: result.errors.length === 0,
      summary: result.summary,
      assignmentCount: result.assignments.length,
      manualReviewCount: result.manualReview.length,
      errorCount: result.errors.length,
    });
    send('complete', result);
    res.end();
  }).catch((err) => {
    audit.log({
      action: 'run-orders',
      dryRun,
      success: false,
      error: err.message,
    });
    send('error', { error: err.message });
    res.end();
  }).finally(() => {
    runOrdersActive = false;
  });

  req.on('close', () => {
    runOrdersActive = false;
  });
});

// ── Pickups ──────────────────────────────────────────────────────────────────

app.get('/api/pickups/scan', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const buckets = await scanShippedLabels({ days });
    res.json({ success: true, buckets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/pickups/book', async (req, res) => {
  const { warehouseId, carrier, pickupDate, shipmentIds } = req.body;
  if (!warehouseId || !carrier) {
    res.status(400).json({ success: false, error: 'warehouseId and carrier are required' });
    return;
  }

  try {
    const result = await bookPickupForBucket({
      warehouseId,
      carrier,
      pickupDate,
      shipmentIds: shipmentIds || [],
    });

    audit.log({
      action: 'book-pickup',
      carrier,
      warehouseId,
      warehouseName: result.warehouseName,
      pickupDate: result.pickupDate,
      success: result.success,
      pickupId: result.pickupId || null,
      confirmation: result.confirmation || null,
      error: result.error || null,
      labelCount: shipmentIds?.length || 0,
    });

    res.json(result);
  } catch (err) {
    audit.log({
      action: 'book-pickup',
      carrier,
      warehouseId,
      success: false,
      error: err.message,
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Shopify SO/PO ────────────────────────────────────────────────────────────

app.get('/api/shopify/order/:id', async (req, res) => {
  try {
    const order = await fetchShopifyOrder(req.params.id);
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/shopify/create-so-po', async (req, res) => {
  const { orderIdOrNumber } = req.body;
  if (!orderIdOrNumber) {
    res.status(400).json({ success: false, error: 'orderIdOrNumber is required' });
    return;
  }

  try {
    const shopifyOrder = await fetchShopifyOrder(orderIdOrNumber);
    const result = await createShopifySoPo({
      shopifyOrder,
      onProgress: () => {}, // No SSE for this one — it's fast enough
    });

    const success = result.errors.length === 0 && result.soId && result.poId;
    audit.log({
      action: 'shopify-so-po',
      shopifyOrder: shopifyOrder.orderNumber,
      success,
      soId: result.soId,
      soNumber: result.soNumber,
      poId: result.poId,
      poNumber: result.poNumber,
      errors: result.errors,
      steps: result.steps.length,
    });

    res.json({ success, ...result, shopifyOrderDetails: shopifyOrder });
  } catch (err) {
    audit.log({
      action: 'shopify-so-po',
      orderIdOrNumber,
      success: false,
      error: err.message,
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Amazon POs ───────────────────────────────────────────────────────────────

app.get('/api/amazon/current-so', async (req, res) => {
  try {
    const conn = await sfLib.connect();
    const so = await findMostRecentAmazonSO(conn);
    res.json({ success: true, so });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/amazon/create-pos', async (req, res) => {
  const days = parseInt(req.body.days || '7', 10);
  try {
    const result = await createAmazonPOs({
      days,
      onProgress: () => {},
    });

    const created = result.orders.filter(o => o.status === 'created');
    const skipped = result.orders.filter(o => o.status === 'skipped');
    const errors = result.orders.filter(o => o.status === 'error' || o.status === 'partial');

    audit.log({
      action: 'amazon-pos',
      success: errors.length === 0,
      soName: result.soName,
      soCreated: result.soCreated,
      posCreated: created.length,
      posSkipped: skipped.length,
      posErrored: errors.length,
      poNumbers: created.map(o => o.poNumber),
      errors: result.errors,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    audit.log({
      action: 'amazon-pos',
      success: false,
      error: err.message,
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Audit Logs ───────────────────────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  const logs = audit.readRecent(limit);
  res.json({ success: true, logs });
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: {
      shipstation_v1: !!(process.env.SHIPSTATION_API_KEY && process.env.SHIPSTATION_API_SECRET),
      shipstation_v2: !!process.env.SHIPSTATION_V2_API_KEY,
      prosol: !!(process.env.PROSOL_EMAIL && process.env.PROSOL_PASSWORD),
      canada_post: !!(process.env.CANADA_POST_API_KEY && process.env.CANADA_POST_API_SECRET),
      salesforce: !!(process.env.SALESFORCE_USERNAME && process.env.SALESFORCE_PASSWORD),
      shopify: !!(process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN),
    },
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`YourFloors ops UI running at http://localhost:${PORT}`);
});
