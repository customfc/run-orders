#!/usr/bin/env node
/**
 * Customer-requested cancel of a YourFloors Shopify order (rules in lib/order-autocancel.js).
 * Called by the hello@ ticket desk (yourfloors-cs/lib/autocancel.js); prints ONE JSON line on stdout.
 *
 *   node scripts/ops/order-autocancel.js --email a@b.ca [--order 1444]            read-only: facts + verdict + plan
 *   node scripts/ops/order-autocancel.js --email a@b.ca --order 1444 --commit     do it (re-checks first; any hold = nothing done)
 *        [--note "customer's words"] [--requested-at ISO]
 *   node scripts/ops/order-autocancel.js --email a@b.ca --order 1444 --ignore-cancel-state
 *        dry-run harness only: reads refunds / a CANCELLED pickup / cancelled ERP records as their earlier state
 *        ("what would it have done before this was handled by hand"); refuses --commit.
 * Runs on the Mini (live ops-state, pickup-state, audit.jsonl).
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const ac = require('../../lib/order-autocancel');

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

(async () => {
  const commit = process.argv.includes('--commit');
  const asBefore = process.argv.includes('--ignore-cancel-state');
  if (commit && asBefore) throw new Error('--ignore-cancel-state is a dry-run harness; it never commits');
  const sender = (arg('--email') || '').trim().toLowerCase();
  if (!sender) throw new Error('--email required');
  const orderNumbers = (arg('--order') || '').split(',').map((s) => s.trim()).filter(Boolean);

  const { graphql } = require('../../lib/shopify-graphql');
  const ss = require('../../lib/shipstation-v2');
  const pr = require('../../lib/pickup-runner');
  const gql = async (q, v) => (await graphql(q, v)).data;
  const deps = {
    gql,
    ssV1: (m, p, b) => ss.v1Request(m, p, b),
    ssV2: (m, p) => ss.v2Request(m, p),
    pickupRunner: pr,
    branches: pr.loadBranches(),
    erpBackend: process.env.ERP_BACKEND || null,
    get erp() { return require('../../lib/automayt-erp'); },
    get am() { return require('../../lib/automayt'); },
  };
  const facts = await ac.gather({ orderNumbers, sender }, deps);
  const ev = ac.evaluate(facts, { ignoreCancelState: asBefore });
  const brief = { eligible: ev.eligible, holds: ev.holds, summary: ev.summary, order: ev.order || null,
    plan: ev.plan.map((s) => ({ key: s.key, type: s.type, ...(s.type === 'branch_email' ? { to: s.to, cc: s.cc, subject: s.subject, text: s.text } : {}), ...(s.type === 'refund' ? { amount: s.amount, note: s.note } : {}), ...(s.number ? { number: s.number } : {}), ...(s.trackingNumber ? { trackingNumber: s.trackingNumber } : {}) })) };
  const factsBrief = { lookup: facts.lookup, order: facts.order && { name: facts.order.name, email: facts.order.email, financial: facts.order.financial, fulfillment: facts.order.fulfillmentStatus, total: facts.order.total, cancelledAt: facts.order.cancelledAt, refunds: facts.order.refundCount, transactions: facts.order.transactions.map((t) => `${t.kind} ${t.status} ${t.amount}`) },
    shipstation: facts.shipstation, opsState: facts.opsState, pickup: facts.pickup, erp: facts.erp, refund: facts.refund && { amount: facts.refund.amount, error: facts.refund.error } };
  if (!commit) return out({ mode: asBefore ? 'dry-run-ignore-cancel-state' : 'preview', ...brief, facts: factsBrief });
  if (!ev.eligible) return out({ mode: 'commit', committed: false, ...brief, facts: factsBrief });
  const r = await ac.execute(ev, { requestNote: arg('--note') || '', requestedAt: arg('--requested-at') || new Date().toISOString() }, {
    ...deps,
    ssCancelOrder: (id) => ss.cancelOrder(id),
    ssGetOrder: async (id) => { const x = await ss.v1Request('GET', `/orders/${id}`); if (x.status === 404) return null; if (x.status !== 200) throw new Error(`ShipStation GET order ${id} HTTP ${x.status}`); return JSON.parse(x.body); },
    emailer: require('../../lib/emailer'),
    audit: require('../../lib/audit'),
  });
  out({ mode: 'commit', committed: r.ok, ...brief, result: r });
})().catch((e) => { out({ error: e.message }); process.exit(1); });
