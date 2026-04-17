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
const { scanStaleShipments } = require('./lib/stale-tracker');
const { runPipeline, PHASES: PIPELINE_PHASES } = require('./lib/pipeline');
const opsState = require('./lib/ops-state');
const telegram = require('./lib/telegram');
const { createGhostPickup, trackOrphanGhost, processPendingVoids, loadPending: loadPendingVoids, ghostStatus, reconcileGhostLedger } = require('./lib/ghost-pickup');
const fsRaw = require('fs');
const httpsRaw = require('https');
const cryptoRaw = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3456;

// Track active SSE connections so we don't run two at once
let runOrdersActive = false;
let pipelineActive = false;

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

// ── Single Order Retry ───────────────────────────────────────────────────────

app.get('/api/run-orders/single', (req, res) => {
  const orderNumber = req.query.orderNumber;
  const dryRun = req.query.dryRun === 'true';
  if (!orderNumber) {
    res.status(400).json({ error: 'orderNumber is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', { message: `Processing single order ${orderNumber} (${dryRun ? 'dry run' : 'staging'})...` });

  runOrders({
    dryRun,
    filterOrderNumber: orderNumber,
    onProgress: (ev) => send('progress', ev),
  }).then((result) => {
    audit.log({
      action: 'run-orders-single',
      orderNumber,
      dryRun,
      success: result.errors.length === 0,
      assignmentCount: result.assignments.length,
    });
    send('complete', result);
    res.end();
  }).catch((err) => {
    send('error', { error: err.message });
    res.end();
  });
});

// ── Shopify OAuth handler (one-time use to mint a fresh shpat_ token) ────────

const SHOPIFY_OAUTH_SCOPES = 'read_orders,read_customers,read_products,read_inventory,read_draft_orders,write_orders';
let pendingOAuthState = null;

function writeEnvVar(key, value) {
  const envPath = path.join(__dirname, '.env');
  let lines = [];
  try { lines = fsRaw.readFileSync(envPath, 'utf8').split('\n'); } catch {}
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const newLine = `${key}=${value}`;
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fsRaw.writeFileSync(envPath, lines.join('\n'));
  process.env[key] = value;
}

app.get('/oauth/shopify/start', (req, res) => {
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!store || !clientId) {
    return res.status(500).send('SHOPIFY_STORE or SHOPIFY_CLIENT_ID not set in .env');
  }
  pendingOAuthState = cryptoRaw.randomBytes(16).toString('hex');
  const redirectUri = `http://localhost:${PORT}/oauth/shopify/callback`;
  const url = `https://${store}/admin/oauth/authorize?client_id=${clientId}&scope=${encodeURIComponent(SHOPIFY_OAUTH_SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${pendingOAuthState}`;
  res.redirect(url);
});

app.get('/oauth/shopify/callback', (req, res) => {
  const { code, state, shop } = req.query;
  if (!pendingOAuthState || state !== pendingOAuthState) {
    return res.status(400).send('OAuth state mismatch — start flow again at /oauth/shopify/start');
  }
  pendingOAuthState = null;
  if (!code) return res.status(400).send('Missing code in callback');

  const store = shop || process.env.SHOPIFY_STORE;
  const body = JSON.stringify({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    code,
  });

  const exchangeReq = httpsRaw.request({
    hostname: store,
    path: '/admin/oauth/access_token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      try {
        const parsed = JSON.parse(d);
        if (!parsed.access_token) return res.status(500).send(`<pre>OAuth exchange failed:\n${d}</pre>`);
        writeEnvVar('SHOPIFY_ACCESS_TOKEN', parsed.access_token);
        writeEnvVar('SHOPIFY_STORE', store);
        telegram.notify('ok', 'Shopify OAuth complete', `Token saved. Scopes: ${parsed.scope || SHOPIFY_OAUTH_SCOPES}`).catch(() => {});
        audit.log({ action: 'shopify-oauth', success: true, scope: parsed.scope });
        res.send(`<html><body style="font-family:sans-serif;padding:40px"><h1>✅ Shopify token saved</h1><p>Scopes: ${parsed.scope || ''}<br>Store: ${store}</p><p>You can close this tab. The new token is live (no restart needed).</p><p><a href="/api/shopify/order/1242">→ Test by fetching order #1242</a></p></body></html>`);
      } catch (err) {
        res.status(500).send(`<pre>OAuth parse error: ${err.message}\nResponse: ${d}</pre>`);
      }
    });
  });
  exchangeReq.on('error', (err) => res.status(500).send('Exchange request error: ' + err.message));
  exchangeReq.write(body);
  exchangeReq.end();
});

// ── Pipeline Orchestrator ────────────────────────────────────────────────────

app.post('/api/pipeline/run', (req, res) => {
  if (pipelineActive) {
    res.status(409).json({ error: 'Pipeline is already running' });
    telegram.notify('attn', 'Pipeline collision', `Attempt rejected while another run is in progress.`).catch(() => {});
    return;
  }
  pipelineActive = true;

  const { phases, dryRun } = req.body || {};
  const source = req.get('X-Pipeline-Source') || 'api';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('status', { message: `Starting pipeline (${source})...` });

  runPipeline({
    phases: Array.isArray(phases) && phases.length ? phases : undefined,
    dryRun: !!dryRun,
    source,
    onProgress: (ev) => send('progress', ev),
  }).then((result) => {
    send('complete', result);
    res.end();
  }).catch((err) => {
    send('error', { error: err.message });
    telegram.notify('halt', 'Pipeline exception', err.message).catch(() => {});
    res.end();
  }).finally(() => { pipelineActive = false; });

  req.on('close', () => { pipelineActive = false; });
});

app.post('/api/pipeline/run-phase', async (req, res) => {
  if (pipelineActive) return res.status(409).json({ error: 'Pipeline is already running' });
  const { phase } = req.body || {};
  if (!PIPELINE_PHASES.includes(phase)) return res.status(400).json({ error: `phase must be one of: ${PIPELINE_PHASES.join(', ')}` });
  pipelineActive = true;
  try {
    const result = await runPipeline({ phases: [phase], source: req.get('X-Pipeline-Source') || 'api-phase' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally { pipelineActive = false; }
});

app.get('/api/pipeline/today', (req, res) => {
  const date = req.query.date || opsState.today();
  const state = opsState.load(date);
  res.json({ success: true, date, state, summary: opsState.summarize(state) });
});

// Per-label breakdown for a given date. Returns one row per label with
// order#, warehouse, carrier/service, labelCost, estimatedCost, Δ%, plus
// per-carrier and overall totals. Answers "why is today's avg label cost
// higher than usual."
app.get('/api/reports/labels', (req, res) => {
  const date = req.query.date || opsState.today();
  const state = opsState.load(date);
  const LOCATION_MAP = require(path.join(__dirname, 'scripts', 'shipstation', 'prosol-location-map.json'));
  const WHBY = {};
  for (const loc of Object.values(LOCATION_MAP)) {
    if (loc.shipstation_warehouse_id) WHBY[String(loc.shipstation_warehouse_id)] = loc;
  }
  const labels = Object.entries(state.phases.buy.labels || {}).map(([orderId, l]) => {
    const loc = l.warehouseId ? WHBY[String(l.warehouseId)] : null;
    const warehouseName = loc ? `${loc.city} (${loc.code})` : (l.warehouseId ? `Warehouse ${l.warehouseId}` : null);
    const deltaPct = (Number.isFinite(l.estimatedCost) && l.estimatedCost > 0 && Number.isFinite(l.labelCost))
      ? Number(((l.labelCost - l.estimatedCost) / l.estimatedCost * 100).toFixed(1))
      : null;
    return {
      orderId: Number(orderId),
      orderNumber: l.orderNumber,
      trackingNumber: l.trackingNumber,
      shipmentId: l.shipmentId,
      warehouseId: l.warehouseId,
      warehouseName,
      carrierCode: l.carrierCode,
      serviceCode: l.serviceCode,
      labelCost: Number.isFinite(l.labelCost) ? Number(l.labelCost) : null,
      estimatedCost: l.estimatedCost,
      deltaPct,
      costWarning: !!l.costWarning,
      at: l.at,
    };
  });
  const byCarrier = {};
  for (const l of labels) {
    const key = l.carrierCode || 'unknown';
    if (!byCarrier[key]) byCarrier[key] = { carrierCode: key, count: 0, totalCost: 0, totalEstimated: 0, costWarnings: 0 };
    byCarrier[key].count += 1;
    if (Number.isFinite(l.labelCost)) byCarrier[key].totalCost += l.labelCost;
    if (Number.isFinite(l.estimatedCost)) byCarrier[key].totalEstimated += l.estimatedCost;
    if (l.costWarning) byCarrier[key].costWarnings += 1;
  }
  const carriers = Object.values(byCarrier).map((c) => ({
    ...c,
    totalCost: Number(c.totalCost.toFixed(2)),
    totalEstimated: Number(c.totalEstimated.toFixed(2)),
    avgCost: c.count ? Number((c.totalCost / c.count).toFixed(2)) : null,
  })).sort((a, b) => b.totalCost - a.totalCost);
  const totalCost = labels.reduce((s, l) => s + (Number.isFinite(l.labelCost) ? l.labelCost : 0), 0);
  const totals = {
    labelCount: labels.length,
    totalCost: Number(totalCost.toFixed(2)),
    avgCost: labels.length ? Number((totalCost / labels.length).toFixed(2)) : null,
    costWarnings: labels.filter((l) => l.costWarning).length,
  };
  res.json({ success: true, date, totals, carriers, labels });
});

app.post('/api/pipeline/test-telegram', async (req, res) => {
  const sev = req.body?.severity || 'debug';
  const msg = req.body?.message || 'Ping from YourFloors ops';
  const r = await telegram.notify(sev, msg, 'This is a test message.');
  res.json(r);
});

// ── Buy Labels ───────────────────────────────────────────────────────────────

app.post('/api/labels/buy', async (req, res) => {
  const { orderId, carrierCode, serviceCode, packageCode, weight, estimatedCost } = req.body;
  if (!orderId || !carrierCode || !serviceCode) {
    return res.status(400).json({ success: false, error: 'orderId, carrierCode, serviceCode required' });
  }

  try {
    const { v1Request, getLabelUrl } = require('./lib/shipstation-v2');

    const payload = {
      orderId,
      carrierCode,
      serviceCode,
      packageCode: packageCode || 'package',
      confirmation: 'none',
      shipDate: new Date().toISOString().slice(0, 10),
      weight: weight || { value: 1, units: 'pounds' },
    };

    const labelRes = await v1Request('POST', '/orders/createlabelfororder', payload);
    if (labelRes.status !== 200) {
      const errBody = labelRes.body.slice(0, 500);
      audit.log({ action: 'buy-label', orderId, success: false, error: `HTTP ${labelRes.status}: ${errBody}` });
      return res.json({ success: false, error: `ShipStation ${labelRes.status}: ${errBody}` });
    }

    const data = JSON.parse(labelRes.body);
    const shipmentId = data.shipmentId;
    const trackingNumber = data.trackingNumber;
    const labelCost = data.shipmentCost;

    let labelUrl = null;
    if (shipmentId) {
      try { labelUrl = await getLabelUrl(shipmentId); } catch {}
    }

    const costWarning = estimatedCost && labelCost > estimatedCost * 1.5;

    audit.log({
      action: 'buy-label',
      orderId,
      success: true,
      shipmentId,
      trackingNumber,
      labelCost,
      estimatedCost,
      costWarning,
    });

    res.json({ success: true, shipmentId, trackingNumber, labelCost, labelUrl, costWarning });
  } catch (err) {
    audit.log({ action: 'buy-label', orderId, success: false, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Email to Prosol ──────────────────────────────────────────────────────────

app.post('/api/email/send-to-prosol', (req, res) => {
  const { orders } = req.body;
  if (!orders?.length) {
    return res.status(400).json({ success: false, error: 'orders array required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  (async () => {
    const { downloadLabelPdf } = require('./lib/shipstation-v2');
    const { generatePackingSlipPdf } = require('./lib/packing-slip');
    const { sendWarehouseEmail } = require('./lib/emailer');

    // Group by warehouse
    const byWarehouse = {};
    for (const o of orders) {
      const key = o.warehouseName || o.warehouseId || 'Unknown';
      if (!byWarehouse[key]) byWarehouse[key] = [];
      byWarehouse[key].push(o);
    }

    const warehouses = Object.entries(byWarehouse);
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < warehouses.length; i++) {
      const [warehouse, whOrders] = warehouses[i];
      send('progress', { warehouse, status: 'preparing', message: `Preparing ${warehouse} (${whOrders.length} orders)...` });

      try {
        const attachments = [];
        for (const o of whOrders) {
          // Download label PDF
          if (o.shipmentId) {
            try {
              const labelPdf = await downloadLabelPdf(o.shipmentId);
              if (labelPdf) attachments.push({ filename: `Label-${o.orderNumber}.pdf`, content: labelPdf });
            } catch {}
          }
          // Generate packing slip
          if (o.poNumber) {
            try {
              const slipPdf = await generatePackingSlipPdf({
                poNumber: o.poNumber,
                date: new Date().toISOString().slice(0, 10),
                vendor: 'Prosol Inc.',
                orderNumber: o.orderNumber,
                tracking: o.trackingNumber,
                carrier: o.carrier,
                shipTo: o.shipTo,
                items: o.items || [],
              });
              if (slipPdf) attachments.push({ filename: `PackingSlip-${o.poNumber}.pdf`, content: slipPdf });
            } catch {}
          }
        }

        send('progress', { warehouse, status: 'sending', message: `Sending email for ${warehouse}...` });

        await sendWarehouseEmail({
          warehouse,
          orders: whOrders.map(o => ({
            orderNumber: o.orderNumber,
            poNumber: o.poNumber || 'N/A',
            shipTo: o.shipTo ? `${o.shipTo.name}, ${o.shipTo.city} ${o.shipTo.postalCode}` : 'N/A',
            carrier: o.carrier,
            tracking: o.trackingNumber,
          })),
          attachments,
        });

        sent++;
        send('progress', { warehouse, status: 'sent', message: `${warehouse} email sent` });

        audit.log({ action: 'email-prosol', warehouse, orderCount: whOrders.length, success: true });

        // 60 second delay between warehouse emails
        if (i < warehouses.length - 1) {
          send('progress', { warehouse, status: 'waiting', message: `Waiting 60s before next email...` });
          await new Promise(r => setTimeout(r, 60000));
        }
      } catch (err) {
        failed++;
        send('progress', { warehouse, status: 'failed', message: `${warehouse} failed: ${err.message}` });
        audit.log({ action: 'email-prosol', warehouse, success: false, error: err.message });
      }
    }

    send('complete', { sent, failed, total: warehouses.length });
    res.end();
  })().catch(err => {
    send('error', { error: err.message });
    res.end();
  });
});

// ── Pickups ──────────────────────────────────────────────────────────────────

app.get('/api/pickups/scan', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '2', 10);
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
      error: result.errorMessage || result.error || null,
      errorCode: result.errorCode || null,
      errorLabelId: result.errorLabelId || null,
      httpStatus: result.success ? null : (result.error || null),
      body: result.success ? null : (result.body || '').toString().slice(0, 500),
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

// ── Active Pickups (for sidebar) ──────────────────────────────────────────────

app.get('/api/pickups/active', async (req, res) => {
  try {
    const { v2Request } = require('./lib/shipstation-v2');
    const fs = require('fs');
    const locMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts', 'shipstation', 'prosol-location-map.json'), 'utf8'));
    const whBySSId = {};
    for (const loc of Object.values(locMap)) {
      if (loc.shipstation_warehouse_id) whBySSId['se-' + loc.shipstation_warehouse_id] = loc;
    }

    const pickups = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const r = await v2Request('GET', `/v2/pickups?page_size=100&page=${page}`);
      if (r.status !== 200) break;
      const data = JSON.parse(r.body);
      pickups.push(...(data.pickups || []));
      hasMore = (data.pickups || []).length === 100;
      page++;
    }

    const today = new Date().toISOString().slice(0, 10);
    // Show pickups from yesterday onward
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const active = pickups
      .filter(p => !p.canceled_at)
      .map(p => {
        const pickupDate = p.pickup_windows?.[0]?.start_at?.slice(0, 10) || null;
        const toPS = (utcStr) => {
          if (!utcStr) return '';
          const d = new Date(utcStr);
          return d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
        };
        const startTime = toPS(p.pickup_windows?.[0]?.start_at);
        const endTime = toPS(p.pickup_windows?.[0]?.end_at);
        const loc = whBySSId[p.warehouse_id] || null;
        const carrierName = p.carrier_id === 'se-1813879' ? 'UPS' : p.carrier_id === 'se-1813880' ? 'Purolator' : p.carrier_id || 'Unknown';
        return {
          pickupId: p.pickup_id,
          confirmation: p.confirmation_number,
          carrier: carrierName,
          warehouse: loc ? `${loc.city} (${loc.code})` : p.pickup_address?.city_locality || p.warehouse_id,
          pickupDate,
          timeWindow: startTime && endTime ? `${startTime} - ${endTime} PST` : '',
          labels: (p.label_ids || []).length,
          isPast: pickupDate && pickupDate < today,
          isToday: pickupDate === today,
        };
      })
      .filter(p => p.pickupDate && p.pickupDate >= yesterday)
      .sort((a, b) => (a.pickupDate || '').localeCompare(b.pickupDate || ''));

    // Merge in CP pickups from local log
    const { loadCpPickups } = require('./lib/pickups');
    const cpPickups = loadCpPickups()
      .filter(p => p.pickupDate && p.pickupDate >= yesterday)
      .map(p => ({
        pickupId: p.pickupId,
        confirmation: p.pickupId,
        carrier: 'Canada Post',
        warehouse: p.warehouse,
        pickupDate: p.pickupDate,
        timeWindow: p.cost ? `Cost: ${p.cost}` : '',
        labels: p.labels || 1,
        isPast: p.pickupDate < today,
        isToday: p.pickupDate === today,
      }));

    const all = [...active, ...cpPickups].sort((a, b) => (a.pickupDate || '').localeCompare(b.pickupDate || ''));
    res.json({ success: true, pickups: all });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Stale Shipment Tracker ────────────────────────────────────────────────────

app.get('/api/shipments/stale', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '14', 10);
    const result = await scanStaleShipments({ days });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Audit Logs ───────────────────────────────────────────────────────────────

// ── FBA Command ─────────────────────────────────────────────────────────────

const fbaSignals = require('./lib/fba-signals');
let fbaPullActive = false;

app.get('/api/fba/today', (req, res) => {
  try {
    const snap = fbaSignals.loadLatestSnapshot();
    if (!snap) return res.json({ success: true, snapshot: null, rows: [] });
    const rows = fbaSignals.rankForToday(snap.rows);
    const byTier = {};
    for (const r of rows) (byTier[r.tier] ||= []).push(r);
    const bleedingRev = (byTier.bleeding || []).reduce((s, r) => s + r.dailyVelocity * (r.featuredOfferPrice || r.yourPrice || 0), 0);
    const recUnitsTotal = rows.reduce((s, r) => s + (r.recShipQty || 0), 0);
    const bbLosing = byTier['bb-losing'] || [];
    const bbGapSum = bbLosing.reduce((s, r) => s + (r.bb?.gap || 0), 0);
    res.json({
      success: true,
      snapshot: { path: snap.path, pulledAt: snap.pulledAt, rowCount: snap.rowCount },
      buyboxPulledAt: snap.buyboxPulledAt || null,
      summary: {
        totalSkus: rows.length,
        tierCounts: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, v.length])),
        bleedingDailyRevenue: Number(bleedingRev.toFixed(2)),
        totalRecommendedUnits: recUnitsTotal,
        lipcActiveCount: (byTier['lipc-active'] || []).length,
        bbLosingCount: bbLosing.length,
        bbGapSum: Number(bbGapSum.toFixed(2)),
      },
      rows,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── FBA PO Draft (Queue) ────────────────────────────────────────────────────

const poDrafts = require('./lib/fba-po-drafts');

app.get('/api/fba/po-draft', (req, res) => {
  try {
    const draft = poDrafts.loadCurrent();
    res.json({ success: true, draft, summary: poDrafts.summarize(draft) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/fba/po-draft/add', (req, res) => {
  try {
    const { asin, sku, product, qty, recQty, addedFromTier, vendor, mapCad, ourPrice, buyBoxPrice, autoAdjust } = req.body || {};
    if (!asin) return res.status(400).json({ success: false, error: 'asin required' });
    if (qty == null || qty < 1) return res.status(400).json({ success: false, error: 'qty must be >= 1' });
    const draft = poDrafts.loadCurrent();
    let line;
    try {
      line = poDrafts.addLine(draft, { asin, sku, product, qty, recQty, addedFromTier, vendor, mapCad, ourPrice, buyBoxPrice, autoAdjust: autoAdjust !== false });
    } catch (e) {
      if (e.code === 'PROSOL_OOS') return res.status(422).json({ success: false, error: e.message, code: 'PROSOL_OOS', prosolStock: e.prosolStock });
      throw e;
    }
    poDrafts.saveCurrent(draft);
    audit.log({ action: 'fba-po-queue', asin, qtyRequested: qty, qtyQueued: line.qty, tier: addedFromTier, vendor: line.vendor, prosolAction: line.prosolStock?.decision?.action });
    res.json({ success: true, line, summary: poDrafts.summarize(draft) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/fba/prosol-stock/pull', async (req, res) => {
  if (fbaPullActive) return res.status(409).json({ error: 'FBA pull already in progress' });
  fbaPullActive = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    send('status', { message: 'Launching Prosol session and iterating SKUs (several minutes)...' });
    const { main: pullProsolStock } = require('./scripts/fba/pull-prosol-stock');
    const origLog = console.log;
    console.log = (...args) => { send('progress', { line: args.join(' ') }); origLog(...args); };
    try { await pullProsolStock(); } finally { console.log = origLog; }
    // Invalidate lib/prosol-stock cache so next lookup reads fresh
    require('./lib/prosol-stock').invalidate();
    audit.log({ action: 'fba-prosol-stock-pull', success: true });
    send('complete', { success: true });
    res.end();
  } catch (e) {
    audit.log({ action: 'fba-prosol-stock-pull', success: false, error: e.message });
    send('error', { error: e.message });
    res.end();
  } finally {
    fbaPullActive = false;
  }
});

app.get('/api/fba/prosol-stock/status', (req, res) => {
  try {
    const ps = require('./lib/prosol-stock');
    const p = ps.latestSnapshotPath();
    if (!p) return res.json({ success: true, snapshot: null });
    const snap = ps.loadLatest();
    res.json({ success: true, snapshot: { path: p, pulledAt: snap.pulledAt, skuCount: snap.skuCount } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/fba/po-draft/line/:lineId', (req, res) => {
  try {
    const { qty } = req.body || {};
    const draft = poDrafts.loadCurrent();
    const line = poDrafts.updateLine(draft, req.params.lineId, { qty });
    poDrafts.saveCurrent(draft);
    res.json({ success: true, line, summary: poDrafts.summarize(draft) });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.delete('/api/fba/po-draft/line/:lineId', (req, res) => {
  try {
    const draft = poDrafts.loadCurrent();
    const removed = poDrafts.removeLine(draft, req.params.lineId);
    if (!removed) return res.status(404).json({ success: false, error: 'line not found' });
    poDrafts.saveCurrent(draft);
    res.json({ success: true, removed, summary: poDrafts.summarize(draft) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/fba/po-draft', (req, res) => {
  try {
    poDrafts.clearCurrent();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Preview rendered HTML for a vendor group (for the Review modal)
app.get('/api/fba/po-draft/preview/:vendor', (req, res) => {
  try {
    const poSender = require('./lib/fba-po-sender');
    const draft = poDrafts.loadCurrent();
    const lines = draft.lines.filter((l) => l.vendor === req.params.vendor && !l.sentAt);
    if (!lines.length) return res.status(404).json({ success: false, error: `No queued lines for vendor '${req.params.vendor}'` });
    const preview = poSender.preview(req.params.vendor, lines, draft.draftId);
    res.json({ success: true, preview });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send a single vendor group (requires explicit vendor)
app.post('/api/fba/po-draft/send', async (req, res) => {
  try {
    const { vendor } = req.body || {};
    if (!vendor) return res.status(400).json({ success: false, error: 'vendor required' });
    const poSender = require('./lib/fba-po-sender');
    const draft = poDrafts.loadCurrent();
    const unsent = draft.lines.filter((l) => l.vendor === vendor && !l.sentAt);
    if (!unsent.length) return res.status(400).json({ success: false, error: `No unsent lines for vendor '${vendor}'` });

    const result = await poSender.sendVendorGroup({ draft, vendor });
    poDrafts.saveCurrent(draft); // persist sentAt markers on lines
    const archivedPath = poSender.archiveIfAllSent(draft);
    if (archivedPath) {
      // All vendors sent — clear the current draft (archived copy remains)
      poDrafts.clearCurrent();
    }
    audit.log({ action: 'fba-po-send', vendor, to: result.to, cc: result.cc, lineCount: result.lineCount, totalUnits: result.totalUnits, draftId: draft.draftId, archived: !!archivedPath });
    res.json({ success: true, result, archivedPath, remainingDraft: archivedPath ? null : poDrafts.summarize(poDrafts.loadCurrent()) });
  } catch (e) {
    audit.log({ action: 'fba-po-send', success: false, vendor: req.body?.vendor, error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/fba/map-violators', (req, res) => {
  try {
    const snap = fbaSignals.loadLatestSnapshot();
    if (!snap) return res.json({ success: true, violators: [], ourViolations: [] });
    const rows = fbaSignals.rankForToday(snap.rows);
    const violators = rows.filter((r) => r.mapDecision?.action === 'competitor-below-map').map((r) => ({
      asin: r.asin,
      product: r.productName,
      brand: r.brand,
      mapPrice: r.mapCad,
      observedPrice: r.mapDecision.buyBoxPrice,
      amountBelow: r.mapDecision.violationDetails?.amountBelow,
      sellerId: r.mapDecision.buyBoxSellerId,
      observedAt: r.mapDecision.violationDetails?.observedAt,
    }));
    const ourViolations = rows.filter((r) => r.mapDecision?.action === 'violation-by-us').map((r) => ({
      asin: r.asin,
      product: r.productName,
      brand: r.brand,
      mapPrice: r.mapCad,
      ourPrice: r.mapDecision.ourPrice,
      recommendedPrice: r.mapDecision.recommendedPrice,
    }));
    // Build a ready-to-send email body for Schluter iMAP enforcement
    const today = new Date().toISOString().slice(0, 10);
    const emailBody = violators.length ? [
      `Hello Schluter iMAP Team,`,
      ``,
      `I would like to report the following observed MAP violations on Amazon.ca as of ${today}. I am a Schluter authorized reseller (via Prosol), Amazon seller CustomFlooring (merchant token ${process.env.AMAZON_SELLER_ID || ''}).`,
      ``,
      ...violators.map((v, i) =>
        `${i + 1}. ${v.product}\n   ASIN: ${v.asin}\n   MAP: CAD $${v.mapPrice?.toFixed(2)}\n   Observed offer: CAD $${v.observedPrice?.toFixed(2)}  (CAD $${v.amountBelow?.toFixed(2)} below MAP)\n   Offering seller ID: ${v.sellerId}\n   Observed at: ${v.observedAt}`
      ),
      ``,
      `Please let me know if you need additional screenshots or offer detail.`,
      ``,
      `Thank you,`,
      `CustomFlooring`,
    ].join('\n') : '';
    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      violators,
      ourViolations,
      emailBody,
      reportingEmail: 'imap@schluter.ca',
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/fba/buybox/pull', async (req, res) => {
  if (fbaPullActive) return res.status(409).json({ error: 'FBA pull already in progress' });
  fbaPullActive = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    send('status', { message: 'Pulling Buy Box data (batches of 20, 30s apart)...' });
    const { main: pullBuyBox } = require('./scripts/fba/pull-buybox');
    const origLog = console.log;
    console.log = (...args) => { send('progress', { line: args.join(' ') }); origLog(...args); };
    try { await pullBuyBox(); } finally { console.log = origLog; }
    const snap = fbaSignals.loadLatestSnapshot();
    const rows = snap ? fbaSignals.rankForToday(snap.rows) : [];
    const byTier = {};
    for (const r of rows) (byTier[r.tier] ||= []).push(r);
    audit.log({ action: 'fba-buybox-pull', success: true, asinCount: rows.length, bbLosing: (byTier['bb-losing'] || []).length });
    send('complete', { success: true, bbLosing: (byTier['bb-losing'] || []).length });
    res.end();
  } catch (e) {
    audit.log({ action: 'fba-buybox-pull', success: false, error: e.message });
    send('error', { error: e.message });
    res.end();
  } finally {
    fbaPullActive = false;
  }
});

app.post('/api/fba/signals/pull', async (req, res) => {
  if (fbaPullActive) {
    return res.status(409).json({ error: 'FBA signal pull already in progress' });
  }
  fbaPullActive = true;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    send('status', { message: 'Requesting GET_FBA_INVENTORY_PLANNING_DATA from Amazon...' });
    const { main: pullInventoryPlanning } = require('./scripts/fba/pull-inventory-planning');
    // Capture stdout-style progress by monkey-patching console.log for this call
    const origLog = console.log;
    console.log = (...args) => { send('progress', { line: args.join(' ') }); origLog(...args); };
    try {
      await pullInventoryPlanning();
    } finally {
      console.log = origLog;
    }
    const snap = fbaSignals.loadLatestSnapshot();
    const rows = snap ? fbaSignals.rankForToday(snap.rows) : [];
    const byTier = {};
    for (const r of rows) (byTier[r.tier] ||= []).push(r);
    audit.log({ action: 'fba-signal-pull', success: true, rowCount: rows.length, tierCounts: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, v.length])) });
    send('complete', { success: true, rowCount: rows.length });
    res.end();
  } catch (e) {
    audit.log({ action: 'fba-signal-pull', success: false, error: e.message });
    send('error', { error: e.message });
    res.end();
  } finally {
    fbaPullActive = false;
  }
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  const logs = audit.readRecent(limit);
  res.json({ success: true, logs });
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/api/scheduled-run', (req, res) => {
  const logs = audit.readRecent(50);
  const lastRun = logs.find(l => l.action === 'pipeline-complete' || l.action === 'pipeline-start');
  res.json({
    lastRun: lastRun || null,
    nextRun: '07:00 / 10:00 / 12:00 / 13:30 stage · 14:00 email · 14:30 pickups · 15:00 digest (ET weekdays)',
    paused: opsState.isPaused(),
  });
});

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

// ── Autonomous schedule (node-cron, America/Toronto) ─────────────────────────
//
// Replaces the old 10-min dry-run interval with purposeful phase-specific ticks:
//   07:00, 10:00, 12:00, 13:30 ET — stage + buy + POs (idempotent, skips no-ops)
//   14:00 ET — email Kaitlyn sweep (one email per warehouse)
//   14:30 ET — pickup sweep (one pickup per warehouse+carrier for next biz day)
//   15:00 ET — daily digest Telegram
//   08:00 ET — morning stale-tracker scan (alerts if anything needs attention)
//   10:00 ET Sat — weekend stale scan so Monday isn't a surprise

const cron = require('node-cron');
const TZ = { timezone: 'America/Toronto' };

async function runCronPipeline(source, phases) {
  if (pipelineActive) { console.log(`[cron ${source}] skipped — pipeline already running`); return; }
  if (opsState.isPaused()) { console.log(`[cron ${source}] skipped — OPS paused`); return; }
  pipelineActive = true;
  try {
    await runPipeline({ phases, source: `cron:${source}` });
  } catch (err) {
    console.error(`[cron ${source}] error:`, err.message);
    telegram.notify('halt', `Cron ${source} crashed`, err.message).catch(() => {});
  } finally {
    pipelineActive = false;
  }
}

// Dev/smoke-test kill-switch: set DISABLE_CRON=1 to skip all scheduled work
// and Telegram bot polling. Use when running a second instance of this server
// for testing so it doesn't collide with the production cron + bot on the
// Mac Mini.
const CRON_DISABLED = process.env.DISABLE_CRON === '1';
const schedule = CRON_DISABLED ? (() => ({ stop() {} })) : cron.schedule.bind(cron);
if (CRON_DISABLED) console.warn('⚠️  DISABLE_CRON=1 — all scheduled jobs + telegram bot polling are OFF (dev/smoke mode)');

// Stage + Buy + POs ticks (idempotent — state file ensures nothing duplicates)
schedule('0 7 * * 1-5',  () => runCronPipeline('07:00-stage', ['stage', 'buy', 'pos']), TZ);
schedule('0 10 * * 1-5', () => runCronPipeline('10:00-stage', ['stage', 'buy', 'pos']), TZ);
schedule('0 12 * * 1-5', () => runCronPipeline('12:00-stage', ['stage', 'buy', 'pos']), TZ);
schedule('30 13 * * 1-5', () => runCronPipeline('13:30-stage', ['stage', 'buy', 'pos']), TZ);

// Email sweep — after last stage tick
schedule('0 14 * * 1-5', () => runCronPipeline('14:00-email', ['email']), TZ);

// Pickup sweep — books one pickup per (warehouse,carrier) for next biz day
schedule('30 14 * * 1-5', () => runCronPipeline('14:30-pickups', ['pickups']), TZ);

// Daily digest at 15:00 — pure notification, reads today's ops-state
schedule('0 15 * * 1-5', async () => {
  const state = opsState.load();
  const s = opsState.summarize(state);
  const g = ghostStatus();
  const attn = s.errorCount > 0 ? ` · ⚠ ${s.errorCount} error(s)` : '';
  let ghostLine = `Ghost: ${g.count} outstanding`;
  if (g.count > 0) {
    const oldestDate = g.oldest?.createdAt ? String(g.oldest.createdAt).slice(0, 10) : '?';
    const overdueFlag = g.maxOverdue > 0 ? ` · ⚠ ${g.maxOverdue}d overdue` : '';
    ghostLine += ` (oldest ${oldestDate}, $${g.exposure.toFixed(2)} exposure${overdueFlag})`;
  }
  // Per-order detail for daily digest
  const LOC_MAP = require(path.join(__dirname, 'scripts', 'shipstation', 'prosol-location-map.json'));
  const whById = {};
  for (const loc of Object.values(LOC_MAP)) {
    if (loc.shipstation_warehouse_id) whById[String(loc.shipstation_warehouse_id)] = loc;
  }
  const labels = Object.values(state.phases.buy.labels || {});
  const orderLines = labels.map((l) => {
    const carrier = String(l.carrierCode || '').replace(/_walleted$/, '').replace(/_/g, ' ');
    const wh = whById[String(l.warehouseId)];
    const whName = wh ? wh.code : `wh-${l.warehouseId}`;
    const items = (l.packages || []).flatMap((p) => (p.items || []));
    const itemStr = items.length
      ? items.map((i) => `${i.name || i.sku}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')
      : l.orderNumber || '?';
    const itemShort = itemStr.length > 80 ? itemStr.slice(0, 77) + '...' : itemStr;
    return `  ${l.orderNumber || '?'} → ${whName} ${carrier} $${(l.labelCost || 0).toFixed(2)}\n    ${itemShort}`;
  });
  const posByTracking = state.phases.pos.byTracking || {};
  const poNumbers = [...new Set(Object.values(posByTracking).map((p) => p.poNumber))];
  const emailsByWh = state.phases.email.byWarehouse || {};
  const emailLines = Object.entries(emailsByWh).map(([wh, info]) => `  ${wh}: ${info.orderCount} order(s)`);

  const body = [
    `Staged: ${s.staged}`,
    `Labels: ${s.labelsBought}${s.totalLabelCost ? ` ($${s.totalLabelCost})` : ''}${s.costWarnings ? ` · ⚠${s.costWarnings} cost` : ''}`,
    ...(orderLines.length ? ['', 'Orders:', ...orderLines, ''] : []),
    `POs: ${s.posCreated}${poNumbers.length ? ` (${poNumbers.join(', ')})` : ''}`,
    `Emails: ${s.emailsSent}`,
    ...(emailLines.length ? emailLines : []),
    `Pickups: ${s.pickupsBooked} (${s.totalPickedLabels} labels)`,
    ghostLine,
    s.errorCount ? `\nLast error: [${s.lastError?.phase}] ${s.lastError?.reason}` : null,
    '',
    'http://localhost:3456',
  ].filter(Boolean).join('\n');
  // Bubble to attn if digest reveals ghost trouble (overdue > 0) — the 16:00 void cron has already alerted halt-level
  // for same-day failures, but the digest is still the place to surface slow-burning accumulation.
  const sev = s.errorCount > 0 || g.maxOverdue > 0 ? 'attn' : 'ok';
  await telegram.notify(sev, `Daily digest — ${s.date}${attn}`, body);
}, TZ);

// Morning stale-tracker scan — alerts if anything stuck overnight
async function morningStaleScan(source) {
  try {
    const { scanStaleShipments } = require('./lib/stale-tracker');
    const scan = await scanStaleShipments({ days: 14 });
    const needAction = scan.shipments.filter(s => s.movement === 'hanging' && (s.suggestedAction === 'book' || s.suggestedAction === 'rebook'));
    if (!needAction.length) {
      await telegram.notify('ok', `Morning scan clean (${source})`, `${scan.summary.hanging} hanging, all covered by booked pickups.`);
      return;
    }
    const byGroup = {};
    for (const s of needAction) {
      const k = `${s.warehouseName} ${s.carrier}`;
      byGroup[k] = (byGroup[k] || 0) + 1;
    }
    const body = Object.entries(byGroup)
      .map(([k, n]) => `• ${k}: ${n}`)
      .join('\n');
    await telegram.notify('attn', `Morning scan — ${needAction.length} need pickup`, body + '\n\nhttp://localhost:3456#tab-tracking');
  } catch (err) {
    await telegram.notify('attn', `Morning stale scan failed (${source})`, err.message);
  }
}
schedule('0 8 * * 1-5', () => morningStaleScan('08:00 weekday'), TZ);
schedule('0 10 * * 6', () => morningStaleScan('10:00 Saturday'), TZ);

// Daily ghost-label auto-void — voids labels whose pickup window closed yesterday.
// Runs at 16:00 ET (after all pickups are done for the day).
schedule('0 16 * * *', async () => {
  try {
    const r = await processPendingVoids();
    if (r.attempted > 0) console.log(`[cron ghost-void] attempted=${r.attempted} voided=${r.voided} remaining=${r.remaining}`);
  } catch (err) {
    telegram.notify('attn', 'Ghost-void cron error', err.message).catch(() => {});
  }
}, TZ);

// ── Telegram command dispatcher ──────────────────────────────────────────────

function fmtSummary(s) {
  return [
    `*${s.date}*`,
    `Staged: ${s.staged}`,
    `Labels: ${s.labelsBought}${s.totalLabelCost ? ` ($${s.totalLabelCost})` : ''}${s.costWarnings ? ` ⚠${s.costWarnings} cost` : ''}`,
    `POs: ${s.posCreated}`,
    `Emails: ${s.emailsSent}`,
    `Pickups: ${s.pickupsBooked} (${s.totalPickedLabels} labels)`,
    s.errorCount ? `Errors: ${s.errorCount}` : null,
  ].filter(Boolean).join('\n');
}

const COMMAND_HELP = `Commands:
/launch — run full pipeline (stage → buy → POs → email → pickups)
/status — today's ops summary
/pickups — run just the pickup sweep (for tomorrow)
/stage — run just the stage+buy+POs phases (no email, no pickups)
/deploy — git pull main + restart server
/claude <message> — ask Claude anything (full repo + tool access)
/ghost-pickup <WH_CODE> <ups|purolator> [--force] — trigger a carrier visit at a fringe warehouse (ghost label, auto-refunded). --force skips the "real shipments exist" guard.
/ghost-track <trackingNumber> [WH_CODE] — rescue an orphan ghost (add to void ledger). Use when /ghosts doesn't show a Mac-Roy label that exists in SS.
/ghosts — list pending ghost labels awaiting void
/pause — halt all pipeline runs until /resume
/resume — clear pause
/help — this help

Or just type a message — anything that isn't a command goes straight to Claude.`;

// ── Claude CLI integration ──────────────────────────────────────────────────
let claudeActive = false;
let lastClaudeAt = 0;
const CLAUDE_SESSION_TTL = 10 * 60 * 1000; // 10 min — after this, start a fresh conversation

function runClaude(prompt) {
  const { execFile } = require('child_process');
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(process.env.HOME || '/Users/fred', '.claude', 'bin', 'claude'),
  ];
  const claudeBin = candidates.find((p) => fsRaw.existsSync(p)) || 'claude';

  // Ensure node + homebrew tools are in PATH (SSH sessions strip it)
  const envPath = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');

  const now = Date.now();
  const shouldContinue = (now - lastClaudeAt) < CLAUDE_SESSION_TTL;
  lastClaudeAt = now;

  return new Promise((resolve) => {
    const args = shouldContinue
      ? ['--continue', '-p', '--output-format', 'text', '--model', 'sonnet', prompt]
      : ['-p', '--output-format', 'text', '--model', 'sonnet', prompt];
    execFile(claudeBin, args, {
      cwd: __dirname,
      timeout: 180000, // 3 min max
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: envPath, CLAUDE_CODE_ENTRYPOINT: 'telegram' },
    }, (err, stdout) => {
      if (err) {
        if (err.killed) resolve('(timed out after 3 minutes)');
        else resolve(`Error: ${err.message.slice(0, 500)}`);
        return;
      }
      resolve(stdout.trim() || '(no response)');
    });
  });
}

async function handleClaudeMessage(text) {
  if (claudeActive) {
    await telegram.reply('⏳ Already working on something — hold on.');
    return;
  }
  claudeActive = true;
  await telegram.reply('🤖 Thinking...');
  try {
    const response = await runClaude(text);
    // Telegram message limit is 4096 chars — split if needed
    if (response.length <= 4000) {
      await telegram.reply(response);
    } else {
      const chunks = response.match(/[\s\S]{1,4000}/g) || [response];
      for (const chunk of chunks) {
        await telegram.reply(chunk);
      }
    }
  } catch (err) {
    await telegram.reply(`❌ Claude error: ${err.message.slice(0, 500)}`);
  } finally {
    claudeActive = false;
  }
}

async function handleTelegramCommand(command, args) {
  switch (command) {
    case 'start':
    case 'help':
      return COMMAND_HELP;

    case 'status': {
      const state = opsState.load();
      const summary = opsState.summarize(state);
      const paused = opsState.isPaused() ? '\n🛑 PAUSED' : '';
      return fmtSummary(summary) + paused;
    }

    case 'pause':
      opsState.setPaused(true, 'via telegram');
      return '🛑 Paused. Pipeline runs will no-op until /resume.';

    case 'resume':
      opsState.setPaused(false);
      return '▶️ Resumed. Pipeline runs will execute again.';

    case 'deploy': {
      if (pipelineActive) return '⚠️ Pipeline is running — wait for it to finish before deploying.';
      const { execFile } = require('child_process');
      const envPath = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');
      return new Promise((resolve) => {
        execFile('git', ['pull', 'origin', 'main'], { cwd: __dirname, timeout: 30000, env: { ...process.env, PATH: envPath } }, (err, stdout, stderr) => {
          if (err) {
            resolve(`❌ git pull failed: ${(stderr || err.message).slice(0, 500)}`);
            return;
          }
          const pullMsg = stdout.trim();
          if (/Already up to date/.test(pullMsg)) {
            resolve(`✅ Already up to date — no restart needed.`);
            return;
          }
          resolve(`✅ Pulled:\n${pullMsg}\n\nRestarting in 2s...`);
          setTimeout(() => process.exit(0), 2000);
        });
      });
    }

    case 'launch':
    case 'pickups':
    case 'stage': {
      if (pipelineActive) return '⚠️ Pipeline is already running — wait for it to finish.';
      if (opsState.isPaused()) return '🛑 Currently paused. Send /resume first.';
      const phasesMap = {
        launch:  undefined,                              // all
        pickups: ['pickups'],
        stage:   ['stage', 'buy', 'pos'],
      };
      const phases = phasesMap[command];
      pipelineActive = true;
      // fire and forget — the orchestrator's own end-of-run telegram delivers the digest
      runPipeline({ phases, source: `telegram:/${command}` })
        .catch((err) => telegram.notify('halt', `Pipeline via /${command} crashed`, err.message))
        .finally(() => { pipelineActive = false; });
      return `🚀 Started /${command}. Digest will arrive when done.`;
    }

    case 'ghost-pickup':
    case 'ghost_pickup': {
      const force = args.includes('--force');
      const positional = args.filter((a) => a !== '--force');
      const [whCode, carrier] = positional;
      if (!whCode || !carrier) return 'Usage: /ghost-pickup <WH_CODE> <ups|purolator> [--force]\nExample: /ghost-pickup LOND ups';
      const r = await createGhostPickup({ warehouseCode: whCode.toUpperCase(), carrier: carrier.toLowerCase(), force });
      if (!r.success) {
        if (r.step === 'guard' && r.existingShipments) {
          const sample = r.existingShipments.slice(0, 5).map((s) => `  • ${s.orderNumber || '(no order)'} — ${s.trackingNumber} (${s.shipTo || '?'})`).join('\n');
          const more = r.existingShipments.length > 5 ? `\n  … and ${r.existingShipments.length - 5} more` : '';
          return `🛑 ${r.error}\n\nExisting shipments at ${whCode.toUpperCase()}/${carrier}:\n${sample}${more}`;
        }
        return `❌ Ghost pickup failed at ${r.step || 'start'}: ${r.error}${r.refunded ? '\n(label auto-refunded)' : ''}`;
      }
      const voidDate = new Date(r.voidAfter).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `👻 Ghost pickup booked${force ? ' (forced)' : ''}\nWarehouse: ${whCode.toUpperCase()} (${carrier})\nPickup: ${r.pickupDate} (conf ${r.confirmation || r.pickupId})\nGhost tracking: ${r.trackingNumber} ($${Number(r.labelCost || 0).toFixed(2)})\nAuto-void scheduled: ${voidDate} ET`;
    }

    case 'ghost-track':
    case 'ghost_track': {
      const [trackingNumber, whCode] = args;
      if (!trackingNumber) return 'Usage: /ghost-track <trackingNumber> [WH_CODE]\nExample: /ghost-track 520490621205 NANA';
      const r = await trackOrphanGhost({ trackingNumber, warehouseCode: whCode ? whCode.toUpperCase() : null });
      if (!r.success) {
        if (r.action === 'not-a-ghost') {
          return `🛑 ${r.error}\nShipment ${r.shipmentId} — this looks like a real customer label, not a ghost. No action taken.`;
        }
        return `❌ Track orphan failed: ${r.error}`;
      }
      if (r.action === 'already-pending') return `ℹ️ Tracking ${trackingNumber} is already in the ghost-voids ledger. No action taken.`;
      const e = r.entry;
      const voidDate = new Date(e.voidAfter).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `🧾 Orphan ghost tracked\nShipment: ${e.shipmentId}\nTracking: ${e.trackingNumber}\nWarehouse: ${e.warehouseCode || '(unknown)'} (${e.carrier})\nLabel cost: $${e.labelCost.toFixed(2)}\nAuto-void scheduled: ${voidDate} ET`;
    }

    case 'ghosts': {
      const g = ghostStatus();
      if (g.count === 0) return '👻 0 outstanding ghost labels.';
      const header = `👻 ${g.count} outstanding · $${g.exposure.toFixed(2)} exposure${g.maxOverdue > 0 ? ` · ⚠ ${g.maxOverdue}d max overdue` : ''}`;
      const rows = g.entries.map((e) => {
        const voidDate = e.voidAfter ? String(e.voidAfter).slice(0, 10) : '?';
        const overdue = e.daysOverdue > 0 ? ` (⚠ ${e.daysOverdue}d overdue)` : '';
        return `• ${e.warehouseCode || '?'} ${e.carrier || '?'} — ${e.trackingNumber} · $${e.labelCost.toFixed(2)} · void ${voidDate}${overdue}`;
      });
      return `${header}\n${rows.join('\n')}`;
    }

    case 'claude': {
      const prompt = args.join(' ');
      if (!prompt) return 'Usage: /claude <message>\nOr just type a message without a command.';
      handleClaudeMessage(prompt); // fire and forget
      return null; // suppress default reply — handleClaudeMessage sends its own
    }

    default: {
      // Anything unrecognized goes to Claude
      const fullText = [command, ...args].join(' ');
      handleClaudeMessage(fullText); // fire and forget
      return null;
    }
  }
}

app.listen(PORT, () => {
  console.log(`YourFloors ops UI running at http://localhost:${PORT}`);
  console.log(`Cron schedule (America/Toronto):`);
  console.log(`  07:00 / 10:00 / 12:00 / 13:30 weekdays — stage + buy + POs`);
  console.log(`  14:00 weekdays — email Kaitlyn sweep`);
  console.log(`  14:30 weekdays — pickup sweep (next biz day)`);
  console.log(`  15:00 weekdays — daily digest Telegram`);
  console.log(`  08:00 weekdays + 10:00 Sat — stale-tracker scan`);
  if (!CRON_DISABLED) {
    telegram.startPolling({
      allowedChatId: process.env.TELEGRAM_CHAT_ID,
      onCommand: handleTelegramCommand,
    });
  } else {
    console.warn('⚠️  Telegram bot polling skipped (DISABLE_CRON=1)');
  }
  // Ghost-ledger reconcile at startup: catches wiped state files or
  // crashed-mid-save inconsistencies. Alerts loudly via Telegram on mismatch.
  reconcileGhostLedger()
    .then((r) => {
      console.log(`[startup] ghost ledger — ${r.outstanding} outstanding, ${r.orphans.length} orphan, ${r.stale.length} stale`);
    })
    .catch((err) => console.error('[startup] ghost reconcile failed:', err.message));
});
