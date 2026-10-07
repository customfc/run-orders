/**
 * Amazon buyer-message handler. Runbook: docs/AMAZON-INBOX.md.
 *
 * Amazon buyer messages, Amazon customer-service messages and A-to-z notices land
 * in hello@yourfloors.ca. From 2026-10-02 (the YourFloors CS agent was switched off
 * because Prosol confirmations buried it) nobody read them: four went past Amazon's
 * 24 h response window by 10-07 and the account's average response time was 69.9 h.
 *
 * This reads ONLY Amazon mail, so supplier traffic can't bury it. For each new
 * message it gathers the order's facts (status, shipments and live tracking,
 * refunds, cancel requests, what the returns autopilot did), has Opus draft the
 * reply, and emails Mac one card per run with a one-tap Send link. Replies go
 * back into the Amazon thread from hello@ (Graph createReply).
 *
 * Auto-send is limited to plain "where is my order" answers backed by a carrier
 * scan, and only with AMAZON_INBOX_AUTOSEND=1. Everything else waits for Mac.
 *
 * Mail access, Amazon, ShipStation and Claude are injected (scripts/ops/amazon-inbox.js
 * wires the real ones) so the parsing and policy are testable offline.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = path.join(__dirname, '..', 'data', 'amazon-inbox.json');
const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/;
const MODEL = 'claude-opus-5-5';

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Which Amazon mail this is, or null for anything that isn't ours to answer. */
function classifySource(msg) {
  const from = String(msg.from?.emailAddress?.address || '').toLowerCase();
  const subject = String(msg.subject || '');
  if (/@marketplace\.amazon\.(ca|com)$/.test(from)) {
    if (/^(RE|TR|FW|AW)\s*:/i.test(subject) && /yourfloors|customfc/i.test(subject)) return null;
    return 'buyer';
  }
  if (/@amazon\.(ca|com)$/.test(from) && /A-to-z Guarantee Claim/i.test(subject)) return 'atoz';
  return null;
}

/** Order id, buyer name, and just the buyer's own words from an Amazon relay message. */
function parseMessage(msg, text) {
  const body = String(text || msg.bodyPreview || '');
  const subject = String(msg.subject || '');
  const orderId = (subject.match(ORDER_RE) || body.match(ORDER_RE) || [])[1] || null;
  const name = (subject.match(/Amazon customer\s+([^\s(]+)/i) || [])[1] || null;
  let said = body;
  const m = body.match(/Message:\s*([\s\S]*?)(?:View Message|Resolve Case|Report suspicious activity|This service is provided solely|$)/i);
  if (m) said = m[1];
  said = said.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const amazonCs = /This is Amazon.?s Customer Service team/i.test(body);
  // Tracking numbers the buyer quotes (Purolator 12 digits, UPS 1Z...): a deleted
  // ShipStation order leaves its labels findable only this way.
  const trackings = [...new Set((said.match(/\b(\d{12}|1Z[0-9A-Z]{16})\b/g) || []))].slice(0, 10);
  return { orderId, name, said, amazonCs, subject, trackings };
}

/** French if the buyer wrote French. */
function language(said) {
  return /\b(le|la|les|colis|bonjour|merci|commande|remboursement|pas|nous|vous)\b/i.test(said)
    && !/\b(the|and|my|order|please)\b/i.test(said) ? 'fr' : 'en';
}

// ── Facts ───────────────────────────────────────────────────────────────────

/** Plain-language fact sheet the draft is written from (and that Mac sees on the card). */
function factSheet(f) {
  if (!f) return 'No order found for this message.';
  const lines = [`Order ${f.orderId}: ${f.status}, placed ${f.placed || '?'}, total $${f.total ?? '?'}.`];
  for (const i of f.items || []) lines.push(`Item: ${i.qty}x ${i.title} (shipped ${i.shipped})${i.cancelRequested ? ' - BUYER ASKED TO CANCEL THIS ITEM' : ''}`);
  if (!(f.shipments || []).length) lines.push('No shipping label found.');
  for (const s of f.shipments || []) {
    const state = s.delivered ? `delivered ${s.delivered}` : s.scanned ? `in transit (${s.lastEvent || s.status})` : 'label made but the carrier has never scanned it';
    lines.push(`Shipment: ${s.carrier} ${s.tracking}, label ${s.shipDate || '?'}: ${state}.`);
  }
  if (f.refunds) lines.push(`Already refunded on this order: ${f.refunds}.`);
  if (f.claims) lines.push(`A-to-z claim money on this order: ${f.claims}.`);
  if (f.returns) lines.push(`Returns autopilot: ${f.returns}`);
  return lines.join('\n');
}

/** Only a carrier-backed "where is it" answer may go out without Mac. */
function autoSendable(draft, f) {
  if (draft.category !== 'tracking' || draft.needsMac) return false;
  const ships = (f && f.shipments) || [];
  return ships.length > 0 && ships.every((s) => s.scanned || s.delivered) && !(f.items || []).some((i) => i.cancelRequested);
}

// ── Drafting ────────────────────────────────────────────────────────────────

const SYSTEM = `You draft replies to Amazon.ca buyers for CustomFlooring, a Canadian flooring and tile-supplies seller (merchant-fulfilled).
You are given the buyer's message and a fact sheet pulled from Amazon, ShipStation and our returns system. Facts are the only truth: never guess a date, status or amount that is not in the fact sheet.

Write the reply as the seller. Rules:
- Plain text. Greeting "Hi <first name>," (or "Bonjour <first name>," in French). Never "Hey there".
- Reply in the buyer's language (French if they wrote French).
- Short: 2-5 sentences. Say what we know and what happens next. End on a positive note.
- Sign off exactly: "Thanks,\\nMac\\nCustomFlooring" (French: "Merci,\\nMac\\nCustomFlooring").
- No em dashes. No phone numbers or offers to call. No links. No mention of suppliers, warehouses, branch names, Prosol, SKUs or costs.
- Never ask for a review, rating or feedback, and never mention feedback (Amazon policy).
- Apologise only when the facts show we got something wrong (shipped late, never scanned, wrong item, shipped after a cancel request).
- Do not promise a refund, replacement or label unless the fact sheet says it has already happened. If one is needed, set needs_mac and write the reply as if Mac approves the action you propose (he sees it before it sends).
- Amazon customer-service messages ("This is Amazon's Customer Service team") get a brief, factual reply addressed to Amazon, not the buyer.
- If the buyer is only saying thanks or closing the conversation, category "thanks" with a one or two line warm acknowledgement (Amazon still counts the message as needing a reply within 24 h).

Categories: tracking (where is my order, answered from carrier facts), not_received (carrier says delivered but buyer says no), return (return, label or refund question), cancel, damaged_wrong (damaged, defective or wrong item), amazon_cs, thanks, other.`;

const TOOL = {
  name: 'submit_reply',
  description: 'Submit the drafted reply.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['tracking', 'not_received', 'return', 'cancel', 'damaged_wrong', 'amazon_cs', 'thanks', 'other'] },
      reply: { type: 'string', description: 'The full reply text, or empty for thanks.' },
      needs_mac: { type: 'boolean', description: 'True if a refund, replacement, label, cancellation or judgment call is needed before sending.' },
      action: { type: 'string', description: 'If needs_mac: the one action Mac should approve, in a short sentence with amounts. Otherwise empty.' },
    },
    required: ['category', 'reply', 'needs_mac', 'action'],
  },
};

async function draftWithClaude({ parsed, facts, lang }, { client } = {}) {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  const user = [
    `Buyer first name: ${parsed.name || '(unknown)'}`,
    `Language: ${lang === 'fr' ? 'French' : 'English'}`,
    `From Amazon customer service: ${parsed.amazonCs ? 'yes' : 'no'}`,
    `Subject: ${parsed.subject}`,
    '', 'Their message:', parsed.said || '(empty)',
    '', 'Fact sheet:', factSheet(facts),
  ].join('\n');
  const messages = [{ role: 'user', content: user }];
  for (let turn = 0; turn < 2; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [TOOL],
      messages,
    });
    const use = res.content.find((b) => b.type === 'tool_use' && b.name === 'submit_reply');
    if (use) {
      const i = use.input || {};
      return { category: i.category || 'other', reply: String(i.reply || '').replace(/—/g, ',').trim(), needsMac: !!i.needs_mac, action: String(i.action || '') };
    }
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: 'Call submit_reply with your draft now.' });
  }
  throw new Error('no draft returned');
}

// ── State + links ───────────────────────────────────────────────────────────

function loadState(file = DEFAULT_STATE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: {} }; }
}
function saveState(state, file = DEFAULT_STATE) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}
const keyOf = (graphId) => crypto.createHash('sha256').update(String(graphId)).digest('hex').slice(0, 16);
function sendToken(key, secret = process.env.RETURNS_APPROVE_SECRET || process.env.SKU_RESOLVER_SECRET) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`amazon-inbox|${key}`).digest('hex').slice(0, 32);
}
function verifySend(key, token, secret) {
  const t = sendToken(key, secret);
  return !!t && typeof token === 'string' && token.length === t.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
}

// ── Run ─────────────────────────────────────────────────────────────────────

/**
 * io:
 *   listMessages(sinceIso) → Graph messages (id, subject, from, receivedDateTime, conversationId, body)
 *   bodyText(msg) → plain text
 *   repliedInConversation(conversationId, afterIso) → bool (hello@ already replied)
 *   facts(orderId) → fact object (see factSheet) | null
 *   draft({ parsed, facts, lang }) → { category, reply, needsMac, action }
 *   send(entry) → void (Graph reply into the thread)
 *   markRead(graphId)
 *   notifyMac({ fresh, stale }) → void
 */
async function run({ io, live = false, autosend = false, now = new Date(), stateFile = DEFAULT_STATE, sinceDays = 14, staleHours = 18, startAt = process.env.AMAZON_INBOX_START || null } = {}) {
  const state = loadState(stateFile);
  state.messages ||= {};
  const out = { live, fresh: [], auto: [], stale: [], skipped: [], errors: [] };
  // AMAZON_INBOX_START: threads before go-live may have been answered in Seller Central, which hello@ can't see.
  const floor = new Date(now - sinceDays * 864e5);
  const since = (startAt && new Date(startAt) > floor ? new Date(startAt) : floor).toISOString();
  const msgs = await io.listMessages(since);

  for (const msg of msgs) {
    const source = classifySource(msg);
    if (!source) continue;
    const key = keyOf(msg.id);
    const known = state.messages[key];
    if (known && known.status !== 'new') continue;
    try {
      if (await io.repliedInConversation(msg.conversationId, msg.receivedDateTime)) {
        if (live) state.messages[key] = { status: 'answered_elsewhere', receivedAt: msg.receivedDateTime, subject: msg.subject };
        out.skipped.push({ key, subject: msg.subject, why: 'already answered from hello@' });
        continue;
      }
      const parsed = parseMessage(msg, io.bodyText(msg));
      const facts = parsed.orderId ? await io.facts(parsed.orderId, { trackings: parsed.trackings }) : null;
      const entry = { key, graphId: msg.id, conversationId: msg.conversationId, source, receivedAt: msg.receivedDateTime, subject: msg.subject, orderId: parsed.orderId, name: parsed.name, said: parsed.said, facts: factSheet(facts) };
      if (source === 'atoz') {
        // A-to-z responses go through Seller Central's claim page, not email.
        Object.assign(entry, { category: 'atoz', reply: '', needsMac: true, action: 'Answer this A-to-z claim in Seller Central (Orders > A-to-z claims).' });
      } else {
        const d = await io.draft({ parsed, facts, lang: language(parsed.said) });
        Object.assign(entry, d);
      }
      // A thank-you still counts against Amazon's 24 h response clock (Slav, 2026-10-07:
      // "Due: 23 hrs" in Seller Central), so it gets a short acknowledgement, carded like
      // anything else unless AMAZON_INBOX_AUTOSEND_THANKS=1.
      const autoThanks = entry.category === 'thanks' && entry.reply && process.env.AMAZON_INBOX_AUTOSEND_THANKS === '1';
      if (live && entry.reply && ((autosend && autoSendable(entry, facts)) || autoThanks)) {
        await io.send(entry);
        await io.markRead(msg.id);
        entry.status = 'auto_sent';
        entry.sentAt = now.toISOString();
        state.messages[key] = entry;
        out.auto.push(entry);
        continue;
      }
      entry.status = 'carded';
      entry.cardedAt = now.toISOString();
      if (live) state.messages[key] = entry;
      out.fresh.push(entry);
    } catch (err) {
      out.errors.push({ key, subject: msg.subject, error: err.message });
    } finally {
      if (live) saveState(state, stateFile);
    }
  }

  // Still unanswered close to Amazon's 24 h window: one reminder each.
  for (const e of Object.values(state.messages)) {
    if (e.status !== 'carded' || e.remindedAt) continue;
    if ((now - new Date(e.receivedAt)) / 36e5 < staleHours) continue;
    if (out.fresh.some((f) => f.key === e.key)) continue;
    out.stale.push(e);
    if (live) e.remindedAt = now.toISOString();
  }

  if (live && (out.fresh.length || out.stale.length || out.auto.length || out.errors.length) && io.notifyMac) {
    await io.notifyMac(out);
  }
  if (live) saveState(state, stateFile);
  return out;
}

/** Mac tapped Send: reply with the draft (or his edited text) and record it. */
async function sendCarded(key, { io, text, stateFile = DEFAULT_STATE, now = new Date() } = {}) {
  const state = loadState(stateFile);
  const e = state.messages[key];
  if (!e) throw new Error('message not found');
  if (e.status === 'sent' || e.status === 'auto_sent') return e;
  const reply = String(text ?? e.reply).trim();
  if (!reply) throw new Error('empty reply');
  await io.send({ ...e, reply });
  await io.markRead(e.graphId);
  Object.assign(e, { status: 'sent', sentAt: now.toISOString(), reply });
  saveState(state, stateFile);
  return e;
}

module.exports = { classifySource, parseMessage, language, factSheet, autoSendable, draftWithClaude, run, sendCarded, loadState, keyOf, sendToken, verifySend, SYSTEM, DEFAULT_STATE };
