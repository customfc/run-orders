/**
 * XLSX adapter. Excel is binary (zipped XML), so it needs a parser lib.
 * To avoid adding a dependency before it's needed, this is a guarded stub:
 * if `xlsx` is installed we use it; otherwise we point at the trivial fallback.
 *
 * Enable real support with:  npm i xlsx
 */
const csv = require('./csv');

function parse(buffer, vendorCfg = {}) {
  let XLSX;
  try { XLSX = require('xlsx'); } catch {
    throw new Error('XLSX ingest needs the `xlsx` package (npm i xlsx). '
      + 'Fallback: "Save As CSV" in Excel/Sheets and ingest with --format csv.');
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = vendorCfg.sheet || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const asCsv = XLSX.utils.sheet_to_csv(ws);
  return csv.parse(asCsv, vendorCfg);
}

module.exports = { parse };
