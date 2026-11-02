#!/usr/bin/env node
/**
 * The Prosol return heads-up ("Return coming in - <branch>") hello@ sent for an Amazon order, from hello@'s Sent
 * Items through the yourfloors-cs Graph login. Prints {"messageId","subject"} or {} when there is none.
 *
 * Used by lib/amazon-returns-io.js to reply in that thread when the return lands (Mac 2026-11-02: "can we just
 * follow up in the heads up email thread"), for heads-ups sent before their Message-ID was kept on the return.
 * A child process, like scripts/ops/amazon-inbox.js, so the Graph client's env never loads into server.js.
 *
 *   node scripts/ops/find-heads-up.js 702-3245580-4010613
 */
require('dotenv').config();
const path = require('path');

const order = process.argv[2];
if (!/^\d{3}-\d{7}-\d{7}$/.test(order || '')) { console.error('usage: find-heads-up.js <amazon order id>'); process.exit(2); }

const YF = process.env.YF_CS_DIR || '/Users/fred/yourfloors-cs';
require(path.join(YF, 'lib', 'env.js'));
const graph = require(path.join(YF, 'lib', 'graph-mail.js'));
const KAITLYN = (process.env.KAITLYN_EMAIL || 'klazzarotto@prosol.ca').toLowerCase();

(async () => {
  const q = `/me/mailFolders/sentitems/messages?$search=${encodeURIComponent(`"${order}"`)}&$select=subject,sentDateTime,internetMessageId,toRecipients&$top=25`;
  const r = await (await graph.graphFetch(q)).json();
  if (r.error) throw new Error(`Graph: ${r.error.code} ${r.error.message}`);
  const hit = (r.value || [])
    .filter((m) => /^Return coming in - /.test(m.subject || '') && (m.toRecipients || []).some((x) => String(x.emailAddress?.address).toLowerCase() === KAITLYN))
    .sort((a, b) => String(b.sentDateTime).localeCompare(String(a.sentDateTime)))[0];
  console.log(JSON.stringify(hit ? { messageId: hit.internetMessageId, subject: hit.subject } : {}));
})().catch((err) => { console.error(err.message); process.exit(1); });
