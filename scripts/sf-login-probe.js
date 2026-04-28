/**
 * One-shot Salesforce login probe.
 * Usage: node scripts/sf-login-probe.js
 * Loads .env, calls sf.connect(), prints identity + org context, exits.
 * Does NOT print credentials. Safe to re-run any time.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sf = require('../lib/salesforce');

(async () => {
  const t0 = Date.now();
  try {
    const conn = await sf.connect();
    const ms = Date.now() - t0;
    const ui = conn.userInfo || {};
    const id = await conn.identity().catch(() => null);
    console.log('OK login in', ms, 'ms');
    console.log('  username   :', id?.username || '(unknown)');
    console.log('  user_id    :', ui.id || id?.user_id || '(unknown)');
    console.log('  org_id     :', ui.organizationId || id?.organization_id || '(unknown)');
    console.log('  instance   :', conn.instanceUrl);
    const probe = await conn.query('SELECT Id FROM User WHERE Id = \'' + (ui.id || '') + '\' LIMIT 1');
    console.log('  test query :', probe.totalSize, 'row(s) — API responding');
    process.exit(0);
  } catch (e) {
    console.error('FAIL login after', Date.now() - t0, 'ms');
    console.error('  errorCode:', e.errorCode || '(none)');
    console.error('  message  :', e.message);
    process.exit(1);
  }
})();
