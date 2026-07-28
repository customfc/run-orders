/**
 * Morning stale-scan digest — ONE message instead of three.
 *
 * Why this exists: the scan was never broken. It correctly found every stranded
 * parcel and alerted every weekday morning. But it sent up to three separate
 * messages, one of them naming 15 parcels plus "and N more", and it reported a
 * 29-day-old parcel identically to one that went stale yesterday. The Quebec
 * parcel appeared in ~20 consecutive alerts looking exactly the same each time.
 * A correct alert that fires daily with 30 unchanging items is wallpaper — which
 * is how order 1316 sat six days until the customer chased it.
 *
 * So: name what is NEW, collapse what is known to a count, and go quiet when
 * nothing has changed — but never fully silent, because that was the orphan
 * sweep's failure in the other direction (see lib/orphan-email-sweep.js).
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'stale-digest-state.json');
// Days at which a known parcel is worth mentioning by name again.
const ESCALATION_MARKS = [7, 14, 30];
// If nothing is new and nothing escalated, still surface a standing total this
// often, so an unchanged problem cannot go quiet forever.
const QUIET_REMINDER_HOURS = Number(process.env.STALE_DIGEST_QUIET_HOURS || 72);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: {}, lastSentAt: null }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

const key = (s) => String(s.trackingNumber || s.orderNumber || '');
const label = (s) => `${s.orderNumber || s.trackingNumber} @ ${s.warehouseName || '?'}`;

/**
 * Turn a raw scan into a single digest.
 * Pure — takes state and `now`, returns the message plus the next state.
 */
function buildDigest({ scan, state = loadState(), now = new Date(), seriousDays = 4 }) {
  const shipments = scan.shipments || [];
  const hanging = shipments
    .filter((s) => s.movement === 'hanging' && (s.age || 0) >= seriousDays)
    .filter((s) => ['book', 'rebook', 'monitor'].includes(s.suggestedAction))
    .sort((a, b) => (b.age || 0) - (a.age || 0));
  const stuck = shipments.filter((s) => s.movement === 'stuck-in-transit');

  const seen = { ...(state.seen || {}) };
  const fresh = [];      // never reported before
  const escalated = [];  // known, but crossed 7 / 14 / 30 days since last named

  for (const s of hanging) {
    const k = key(s);
    const age = s.age || 0;
    const prior = seen[k];
    if (!prior) {
      fresh.push(s);
      seen[k] = { firstSeen: now.toISOString(), lastNamedAge: age, times: 1 };
      continue;
    }
    const crossed = ESCALATION_MARKS.find((m) => age >= m && (prior.lastNamedAge || 0) < m);
    if (crossed) {
      escalated.push({ ...s, crossed });
      seen[k] = { ...prior, lastNamedAge: age, times: (prior.times || 0) + 1 };
    } else {
      seen[k] = { ...prior, times: (prior.times || 0) + 1 };
    }
  }

  // drop anything that has resolved, so the state file doesn't grow forever
  const live = new Set(hanging.map(key));
  for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k];

  const ongoing = hanging.length - fresh.length - escalated.length;
  const oldest = hanging[0];
  const sinceLast = state.lastSentAt ? (now - new Date(state.lastSentAt)) / 3600000 : Infinity;
  const quietDue = sinceLast >= QUIET_REMINDER_HOURS;

  const shouldSend = Boolean(fresh.length || escalated.length || stuck.length || (hanging.length && quietDue));
  if (!shouldSend) return { shouldSend: false, state: { seen, lastSentAt: state.lastSentAt }, counts: { hanging: hanging.length, stuck: stuck.length, fresh: 0, escalated: 0 } };

  const L = [];
  if (stuck.length) {
    L.push(`🚚 STUCK IN TRANSIT — ${stuck.length} (A-to-Z risk)`);
    for (const s of stuck.slice(0, 6)) L.push(`   • ${label(s)} — ${s.age}d, ${s.latestEvent || 'no recent event'}`);
    if (stuck.length > 6) L.push(`   …and ${stuck.length - 6} more`);
    L.push('');
  }
  if (fresh.length) {
    L.push(`🆕 NEW — never collected, first seen today (${fresh.length})`);
    for (const s of fresh.slice(0, 10)) L.push(`   • ${label(s)} — ${s.age}d [${s.suggestedAction}]`);
    if (fresh.length > 10) L.push(`   …and ${fresh.length - 10} more`);
    L.push('');
  }
  if (escalated.length) {
    L.push(`⏫ GETTING OLD (${escalated.length})`);
    for (const s of escalated) L.push(`   • ${label(s)} — now ${s.age}d, past ${s.crossed}`);
    L.push('');
  }
  if (ongoing > 0) {
    L.push(`${ongoing} other${ongoing === 1 ? '' : 's'} still hanging, already reported${oldest ? ` · oldest ${oldest.age}d (${label(oldest)})` : ''}`);
  } else if (!fresh.length && !escalated.length && hanging.length) {
    L.push(`${hanging.length} still hanging, all previously reported · oldest ${oldest.age}d`);
  }
  L.push('');
  L.push('Full list: http://localhost:3456#tab-tracking');

  const newCount = fresh.length + escalated.length;
  const subject = newCount
    ? `Morning scan — ${newCount} need${newCount === 1 ? 's' : ''} attention (${hanging.length} hanging total)`
    : `Morning scan — ${hanging.length} still hanging, nothing new`;

  return {
    shouldSend: true,
    severity: (fresh.length || stuck.length) ? 'attn' : 'ok',
    subject,
    body: L.join('\n'),
    state: { seen, lastSentAt: now.toISOString() },
    counts: { hanging: hanging.length, stuck: stuck.length, fresh: fresh.length, escalated: escalated.length, ongoing },
  };
}

module.exports = { buildDigest, loadState, saveState, ESCALATION_MARKS, QUIET_REMINDER_HOURS };
