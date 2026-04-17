/**
 * SP-API Reports — async request/poll/download flow.
 *
 * Reports API lifecycle:
 *   1. POST /reports/2021-06-30/reports  → returns reportId
 *   2. GET  /reports/2021-06-30/reports/{reportId}  → poll until processingStatus=DONE
 *   3. GET  /reports/2021-06-30/documents/{reportDocumentId}  → returns { url, compressionAlgorithm? }
 *   4. HTTPS GET url → raw bytes (gzip-decode if compressionAlgorithm=GZIP)
 *
 * Most FBA reports come back as TSV. Some are JSON.
 */

const https = require('https');
const zlib = require('zlib');
const { spApiRequest } = require('./sp-api');

const POLL_INTERVAL_MS = 15_000;      // how long between status polls
const POLL_TIMEOUT_MS = 15 * 60_000;  // give up after 15 min

// ── Create a report request ─────────────────────────────────────────────────

async function createReport({ reportType, marketplaceIds, dataStartTime, dataEndTime, reportOptions }) {
  const body = {
    reportType,
    marketplaceIds: Array.isArray(marketplaceIds) ? marketplaceIds : [marketplaceIds],
  };
  if (dataStartTime) body.dataStartTime = dataStartTime;
  if (dataEndTime) body.dataEndTime = dataEndTime;
  if (reportOptions) body.reportOptions = reportOptions;

  const res = await spApiRequest('POST', '/reports/2021-06-30/reports', { body });
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`createReport failed: ${res.status} — ${res.body.slice(0, 500)}`);
  }
  const data = JSON.parse(res.body);
  return data.reportId;
}

// ── Poll until DONE ─────────────────────────────────────────────────────────

async function waitForReport(reportId, { onPoll } = {}) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await spApiRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
    if (res.status !== 200) {
      throw new Error(`getReport failed: ${res.status} — ${res.body.slice(0, 500)}`);
    }
    const report = JSON.parse(res.body);
    if (onPoll) onPoll(report);

    if (report.processingStatus === 'DONE') return report;
    if (report.processingStatus === 'CANCELLED' || report.processingStatus === 'FATAL') {
      throw new Error(`Report ${reportId} ended with status ${report.processingStatus}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Report ${reportId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ── Fetch the document metadata ─────────────────────────────────────────────

async function getReportDocument(reportDocumentId) {
  const res = await spApiRequest('GET', `/reports/2021-06-30/documents/${reportDocumentId}`);
  if (res.status !== 200) {
    throw new Error(`getReportDocument failed: ${res.status} — ${res.body.slice(0, 500)}`);
  }
  return JSON.parse(res.body);
}

// ── Download the raw bytes from the signed URL ──────────────────────────────

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ── TSV parser — handles \r\n and \n, trims BOM ─────────────────────────────

function parseTsv(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ''; });
    return row;
  });
}

// ── One-shot: create → wait → download → parse ──────────────────────────────

async function fetchReport({ reportType, marketplaceIds, dataStartTime, dataEndTime, reportOptions, parse = 'tsv', onProgress }) {
  const emit = (msg) => { if (onProgress) onProgress(msg); };

  emit({ step: 'create', reportType });
  const reportId = await createReport({ reportType, marketplaceIds, dataStartTime, dataEndTime, reportOptions });
  emit({ step: 'created', reportId });

  const report = await waitForReport(reportId, {
    onPoll: (r) => emit({ step: 'poll', status: r.processingStatus, reportId }),
  });
  emit({ step: 'ready', reportDocumentId: report.reportDocumentId });

  const doc = await getReportDocument(report.reportDocumentId);
  emit({ step: 'document', url: doc.url ? '[signed]' : null, compression: doc.compressionAlgorithm || null });

  let bytes = await downloadUrl(doc.url);
  if (doc.compressionAlgorithm === 'GZIP') {
    bytes = zlib.gunzipSync(bytes);
  }
  const text = bytes.toString('utf8');
  emit({ step: 'downloaded', bytes: text.length });

  if (parse === 'tsv') return { report, rows: parseTsv(text), raw: text };
  if (parse === 'json') return { report, rows: JSON.parse(text), raw: text };
  return { report, raw: text };
}

module.exports = {
  createReport,
  waitForReport,
  getReportDocument,
  downloadUrl,
  parseTsv,
  fetchReport,
};
