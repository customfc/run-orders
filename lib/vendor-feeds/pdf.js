/**
 * PDF adapter — for the vendors who "just send a PDF."
 *
 * Strategy: hand the raw PDF to Gemini (vision) and ask for a clean CSV of
 * product rows, then run it through the CSV adapter. Gemini accepts PDFs inline
 * (base64) via the REST API, so this needs no PDF libs — just a Gemini key in
 * the environment (GEMINI_API_KEY / GOOGLE_AI_API_KEY / GOOGLE_API_KEY).
 *
 * If no key is present, we fail loudly with the manual fallback: export the PDF
 * to CSV (most vendor PDFs are exported from a spreadsheet anyway) and ingest
 * that with --format csv.
 */
const https = require('https');
const csv = require('./csv');

const MODEL = process.env.VENDOR_PDF_MODEL || 'gemini-2.5-flash';

function keyFromEnv() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function callGemini(key, base64Pdf, prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: 'application/pdf', data: base64Pdf } },
    ] }],
    generationConfig: { temperature: 0 },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${MODEL}:generateContent?key=${key}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(`Gemini: ${j.error.message}`));
          const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          resolve(text);
        } catch (e) { reject(new Error(`Gemini parse: ${e.message} — ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body); req.end();
  });
}

/**
 * @param {Buffer} buffer  raw PDF bytes
 * @param {object} vendorCfg  registry entry (columns hint optional)
 */
async function parse(buffer, vendorCfg = {}) {
  const key = keyFromEnv();
  if (!key) {
    throw new Error('PDF ingest needs a Gemini key (GEMINI_API_KEY/GOOGLE_AI_API_KEY). '
      + 'Fallback: export the PDF to CSV and ingest with --format csv.');
  }
  const prompt = [
    'You are extracting a vendor product availability list from this PDF.',
    'Return ONLY CSV (no prose, no code fences) with exactly these headers:',
    'sku,qty,description,status',
    '- sku: the vendor item/part/SKU number for each product row.',
    '- qty: numeric quantity available if shown, else blank.',
    '- description: the product name/description.',
    '- status: any availability text shown (e.g. "discontinued","backorder","in stock"), else blank.',
    'One row per product. Skip headers, totals, page furniture, and non-product lines.',
  ].join('\n');
  const out = await callGemini(key, buffer.toString('base64'), prompt);
  const clean = out.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
  // Reuse the CSV adapter with the canonical headers we asked Gemini to emit.
  return csv.parse(clean, { columns: { sku: 'sku', qty: 'qty', description: 'description', status: 'status' } });
}

module.exports = { parse, _callGemini: callGemini };
