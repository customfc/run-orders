#!/usr/bin/env node
/**
 * POST our sample order payload at Prosol's draft webhook.
 *
 * Built 2026-08-13 so that the moment Leo (Prosol tech) sends the endpoint URL,
 * we can fire the samples immediately instead of rebuilding the context. The
 * mapping exercise agreed on the 2026-07-30 call is: we POST, they map it into
 * Tecsys, they tell us which fields are required, ignored, or missing.
 *
 *   node scripts/prosol-post-sample-order.js --url=https://... [--which=single|multi|both]
 *                                            [--dry] [--header 'X-Api-Key: abc']
 *
 * Defaults to --which=both. Prints status + response body and writes the full
 * exchange to data/prosol-api-responses/ so the reply is on the record.
 *
 * No dependencies. Reads the payloads from docs/prosol-api/.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'prosol-api');
const OUT = path.join(ROOT, 'data', 'prosol-api-responses');

const PAYLOADS = {
  single: 'example-order-single.json',
  multi: 'example-order-multipackage.json',
};

function parseArgs(argv) {
  const a = { which: 'both', headers: {}, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith('--url=')) a.url = v.slice(6);
    else if (v === '--url') a.url = argv[++i];
    else if (v.startsWith('--which=')) a.which = v.slice(8);
    else if (v === '--dry' || v === '--dry-run') a.dry = true;
    else if (v === '--header' || v === '-H') {
      const h = argv[++i] || '';
      const ix = h.indexOf(':');
      if (ix > 0) a.headers[h.slice(0, ix).trim()] = h.slice(ix + 1).trim();
    }
  }
  return a;
}

function post(url, body, extraHeaders) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const data = Buffer.from(body, 'utf8');
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'CFC-run-orders/1.0 (prosol-integration; mac@customfc.ca)',
      ...extraHeaders,
    },
    timeout: 30000,
  };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = lib.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: b,
        ms: Date.now() - started,
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('timed out after 30s')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const a = parseArgs(process.argv.slice(2));

  if (!a.url && !a.dry) {
    console.error(`
Prosol draft webhook not supplied.

  node scripts/prosol-post-sample-order.js --url=<endpoint> [--which=single|multi|both] [--dry]
                                           [--header 'X-Api-Key: ...']

Context: Leo at Prosol owes us this URL (promised on the 2026-07-30 kickoff call).
Payloads live in docs/prosol-api/. Field map + open questions are in that README.
`.trim());
    process.exit(1);
  }

  const which = a.which === 'both' ? ['single', 'multi'] : [a.which];
  const bad = which.filter((w) => !PAYLOADS[w]);
  if (bad.length) { console.error(`unknown --which: ${bad.join(', ')} (use single, multi, or both)`); process.exit(1); }

  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];

  for (const w of which) {
    const file = path.join(DOCS, PAYLOADS[w]);
    const body = fs.readFileSync(file, 'utf8');
    const ref = (JSON.parse(body).order || {}).reference;

    if (a.dry) {
      console.log(`\n--- ${w} (${PAYLOADS[w]}, ref ${ref}) — DRY RUN, nothing sent ---`);
      console.log(body.trim());
      continue;
    }

    process.stdout.write(`POST ${w.padEnd(6)} ref=${ref} -> ${a.url} ... `);
    try {
      const r = await post(a.url, body, a.headers);
      console.log(`${r.status} (${r.ms}ms)`);
      console.log(r.body.slice(0, 2000) || '(empty body)');
      results.push({ which: w, reference: ref, request: JSON.parse(body), response: r });
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      results.push({ which: w, reference: ref, error: e.message });
    }
  }

  if (!a.dry && results.length) {
    const f = path.join(OUT, `post-${stamp}.json`);
    fs.writeFileSync(f, JSON.stringify({ url: a.url, sentAt: new Date().toISOString(), results }, null, 2));
    console.log(`\nfull exchange saved to ${path.relative(ROOT, f)}`);
    const ok = results.filter((r) => r.response && r.response.status >= 200 && r.response.status < 300).length;
    console.log(`${ok}/${results.length} accepted.`);
    console.log('\nNext: ask Prosol which fields were required, ignored, or missing — the six questions are in docs/prosol-api/README.md.');
  }
})();
