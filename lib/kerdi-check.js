/**
 * Kerdi-Line size check: catch the wrong part before it ships.
 *
 * About 1 in 4 Kerdi-Line orders on Amazon.ca came back (10 of ~43 in the year
 * to 2026-10). The channel-body pages lead with a picture of the whole drain, so
 * buyers order a channel expecting a grate, a grate with no channel, a 36" grate
 * for a 40" channel (Robert, 701-8161988 + 701-3798231), or the 3" ABS flange
 * kit for a 2" or PVC drain. We can't change those titles or images.
 *
 * At staging, an Amazon order holding a Kerdi-Line part that doesn't line up
 * with the buyer's other recent orders is held, and the buyer gets one "quick
 * check before we ship" email through the Amazon relay from hello@. No reply in
 * 24 h (or the ship-by date getting close) and it ships as normal. A reply lands
 * in the Amazon inbox handler and reaches Mac as a card; a cancel request is
 * caught by the cancel guard.
 *
 * Mac approved 2026-10-07. State: data/kerdi-check.json.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'kerdi-check.json');
const HOLD_HOURS = 24;
const SHIP_BY_MARGIN_HOURS = 18;
// Schluter and the listings name lengths by nominal inches: 60 cm = 24", 100 cm = 40", 150 cm = 60".
const inch = (cm) => Math.round(cm * 0.4);

/** What a vendor code is, as far as Kerdi-Line fit goes. */
function parse(code) {
  const c = String(code || '').toUpperCase().replace(/[\s/_.-]/g, '');
  let m;
  if ((m = c.match(/^KL1V(O?)60E(\d{2,3})/))) return { kind: 'channel', len: +m[2], offset: !!m[1] };
  if ((m = c.match(/^KL1DR(O?)E(\d{2,3})$/))) return { kind: 'grate', len: +m[2], offset: !!m[1], frameless: true };
  if ((m = c.match(/^KL1(?:B|AR|IF[A-Z])\d{2}[A-Z]{2,3}(\d{2,3})$/))) return { kind: 'grate', len: +m[1] };
  if (/^KD3ABSFL/.test(c)) return { kind: 'flange', pipe: 'ABS' };
  if (/^KD3PVCFL/.test(c)) return { kind: 'flange', pipe: 'PVC' };
  return null;
}

/** Issues with THIS order's Kerdi-Line parts, given the buyer's other recent parts. */
function assess(thisCodes, otherCodes = []) {
  const mine = thisCodes.map(parse).filter(Boolean);
  const all = [...mine, ...otherCodes.map(parse).filter(Boolean)];
  const channels = all.filter((p) => p.kind === 'channel');
  const grates = all.filter((p) => p.kind === 'grate');
  const issues = [];
  const add = (i) => { if (!issues.some((x) => x.type === i.type && x.len === i.len && x.other === i.other)) issues.push(i); };
  for (const p of mine) {
    if (p.kind === 'channel') {
      if (!grates.length) add({ type: 'channel_only', len: p.len });
      else if (!grates.some((g) => g.len === p.len)) add({ type: 'size_mismatch', len: p.len, other: grates[0].len, part: 'channel' });
      else if (grates.filter((g) => g.len === p.len).every((g) => g.frameless && g.offset !== p.offset)) add({ type: 'outlet_mismatch', len: p.len, offset: p.offset });
    } else if (p.kind === 'grate') {
      if (!channels.length) add({ type: 'grate_only', len: p.len });
      else if (!channels.some((ch) => ch.len === p.len)) add({ type: 'size_mismatch', len: channels[0].len, other: p.len, part: 'grate' });
    } else if (p.kind === 'flange') {
      add({ type: `flange_${p.pipe.toLowerCase()}` });
    }
  }
  return issues;
}

/** One sentence per issue, buyer-facing. */
function sentence(i) {
  switch (i.type) {
    case 'channel_only': return `The ${inch(i.len)}" Kerdi-Line channel body is the channel only. It doesn't include a grate, and it needs a ${inch(i.len)}" Kerdi-Line grate to match.`;
    case 'grate_only': return `The ${inch(i.len)}" Kerdi-Line grate is the grate only. It fits a ${inch(i.len)}" Kerdi-Line channel body, which is sold separately.`;
    case 'size_mismatch': return `Your Kerdi-Line channel body is ${inch(i.len)}" and your grate is ${inch(i.other)}". The grate has to be the same length as the channel, so these two won't fit together.`;
    case 'outlet_mismatch': return `Your frameless grate and channel body are for different drain positions (one is centre-outlet, the other offset), so they won't fit together.`;
    case 'flange_abs': return 'The Kerdi-Drain flange kit is for a 3-inch ABS drain pipe. It won\'t fit a 2-inch drain or a PVC pipe.';
    case 'flange_pvc': return 'The Kerdi-Drain flange kit is for a PVC drain pipe. It won\'t fit an ABS pipe.';
    default: return '';
  }
}

function buyerEmail({ firstName, orderNumber, issues }) {
  const hi = firstName ? `Hi ${firstName.charAt(0).toUpperCase()}${firstName.slice(1).toLowerCase()},` : 'Hello,';
  const body = [...new Set(issues.map(sentence).filter(Boolean))];
  return {
    subject: `Quick check on your Amazon order ${orderNumber}`,
    text: [hi, '', 'A quick check before we ship your order:', '', ...body, '',
      "If that's what you need, there's nothing to do and it ships tomorrow. If not, reply here and we'll cancel it at no charge.", '',
      'Thanks,', 'Mac', 'CustomFlooring'].join('\n'),
  };
}

function loadState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { orders: {} }; } }
function saveState(s, file = STATE_FILE) { fs.writeFileSync(file, JSON.stringify(s, null, 1)); }

/**
 * Staging decision. Holds while the buyer hasn't been asked yet or was asked
 * under 24 h ago. Never holds once asking failed, or when ship-by is close.
 */
function decide({ orderNumber, shipByDate, issues, now = new Date(), state = loadState() }) {
  if (!issues.length) return { hold: false };
  const st = state.orders?.[orderNumber];
  if (st?.releasedAt) return { hold: false, why: `released ${st.releasedAt.slice(0, 16)}` };
  // The buyer answered: wait for Mac however long it takes (his Send on the inbox card releases it).
  if (st?.replyAt) return { hold: true, asked: true, reason: 'buyer replied, waiting on Mac' };
  if (st?.askFailedAt) return { hold: false, why: 'could not reach the buyer; shipping as normal' };
  if (shipByDate && (new Date(shipByDate) - now) / 36e5 < SHIP_BY_MARGIN_HOURS) return { hold: false, why: 'ship-by date too close to wait' };
  if (st?.askedAt && (now - new Date(st.askedAt)) / 36e5 >= HOLD_HOURS) return { hold: false, why: `buyer asked ${st.askedAt.slice(0, 16)}, no stop in ${HOLD_HOURS} h` };
  return { hold: true, asked: !!st?.askedAt, reason: issues.map((i) => i.type).join(', ') };
}

/** Inbox handler: the buyer wrote back on a held order. Returns true if this order is a Kerdi-Line hold. */
function noteReply(orderNumber, atIso, file = STATE_FILE) {
  const s = loadState(file);
  const st = s.orders?.[orderNumber];
  if (!st || !st.askedAt || st.releasedAt) return false;
  if (atIso && atIso < st.askedAt) return false;
  if (!st.replyAt) { st.replyAt = atIso || new Date().toISOString(); saveState(s, file); }
  return true;
}

/** Mac answered the buyer from the inbox card: the order ships on the next staging pass. */
function release(orderNumber, file = STATE_FILE) {
  const s = loadState(file);
  const st = s.orders?.[orderNumber];
  if (!st || st.releasedAt) return false;
  st.releasedAt = new Date().toISOString();
  saveState(s, file);
  return true;
}

module.exports = { parse, assess, sentence, buyerEmail, decide, noteReply, release, loadState, saveState, STATE_FILE, HOLD_HOURS };
