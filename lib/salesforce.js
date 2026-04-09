/**
 * Salesforce connection helper.
 * Logs in fresh each call (SOAP login, session expires after 2h).
 * Uses jsforce.
 */

let jsforce;
try {
  jsforce = require('jsforce');
} catch {
  // jsforce not installed — will fail at runtime if SF features are used
  jsforce = null;
}

const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN;
const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

async function connect() {
  if (!jsforce) throw new Error('jsforce is not installed. Run: npm install jsforce');
  if (!SF_USERNAME || !SF_PASSWORD || !SF_TOKEN) {
    throw new Error('Missing SALESFORCE_USERNAME, SALESFORCE_PASSWORD, or SALESFORCE_SECURITY_TOKEN');
  }

  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, `${SF_PASSWORD}${SF_TOKEN}`);
  return conn;
}

async function query(conn, soql) {
  const result = await conn.query(soql);
  return result.records || [];
}

async function create(conn, sobject, fields) {
  const result = await conn.sobject(sobject).create(fields);
  if (!result.success) {
    const errs = (result.errors || []).map(e => e.message || JSON.stringify(e)).join('; ');
    throw new Error(`SF create ${sobject} failed: ${errs}`);
  }
  return result.id;
}

module.exports = { connect, query, create };
