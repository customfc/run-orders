/**
 * Parse vendor replies (carton dimensions + ready-to-ship acks) out of email
 * bodies. Regex-first; surfaces raw text + low confidence so the dashboard
 * can render a manual-entry fallback when the vendor formats something new.
 *
 * Added 2026-04-23 per the FBA replenishment walkthrough — step 5 waits on
 * Kaitlyn's reply with carton dims before we can create the Amazon inbound
 * plan. IMAP watcher (1c-iii-b) feeds bodies in here; same parser handles
 * both Prosol (Kaitlyn) and Treeco (Robyn) since both send prose replies.
 *
 * No LLM dependency by design — volume is handful-of-POs/day and replies
 * are short. If a reply stumps the regex, dashboard prompts for manual
 * entry in 10 seconds. Upgrade path to OpenAI/Claude is trivial later.
 */

/**
 * parseDims(body) → { count, L, W, H, weightLb, parseConfidence, raw, matches }
 * or null when nothing parsable is found.
 *
 * Tries several shapes in priority order. Each match contributes to
 * confidence; full parse (count + L + W + H + weight) → 1.0; partial → <1.
 * Callers treat < 0.8 as "review before firing the orchestrator".
 *
 * Assumptions (fine-tune as real replies come in):
 *   - Units: inches + pounds by default. Centimetres/kilograms detected
 *     and converted.
 *   - Quote style doesn't matter — ", ", "in", "inch", "inches" all accepted.
 *   - "×" / "x" / "X" all valid dim separators.
 *   - "per carton" / "per box" / "each" / plain weight all accepted.
 */
function parseDims(body) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
  const matches = {};

  // L × W × H — "24 × 18 × 12" / "24x18x12" / 24" x 18" x 12". Grab the first
  // plausible triple; prefer ones that appear near "carton"/"box"/"dim" text.
  const dimRegexes = [
    // "L: 24 W: 18 H: 12" labelled form
    /L[:\s]*(\d+(?:\.\d+)?)[^\d]+W[:\s]*(\d+(?:\.\d+)?)[^\d]+H[:\s]*(\d+(?:\.\d+)?)/i,
    // "24 × 18 × 12" unlabelled triple with × or x, optional inches
    /(\d+(?:\.\d+)?)\s*["']?\s*[x×X]\s*(\d+(?:\.\d+)?)\s*["']?\s*[x×X]\s*(\d+(?:\.\d+)?)/,
  ];
  let dimsUnit = 'in';
  for (const re of dimRegexes) {
    const m = text.match(re);
    if (m) {
      matches.L = Number(m[1]);
      matches.W = Number(m[2]);
      matches.H = Number(m[3]);
      // Unit detection near the match — cm/centimetre anywhere close?
      const around = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
      if (/\b(cm|centimetre|centimeter)s?\b/i.test(around)) dimsUnit = 'cm';
      break;
    }
  }
  if (dimsUnit === 'cm' && matches.L) {
    // Amazon expects inches; convert 1 cm = 0.3937 in.
    matches.L = Number((matches.L * 0.3937).toFixed(2));
    matches.W = Number((matches.W * 0.3937).toFixed(2));
    matches.H = Number((matches.H * 0.3937).toFixed(2));
    matches.dimsOriginalUnit = 'cm';
  }

  // Carton count — "20 cartons" / "20 boxes" / "20 pcs" / "20 pieces" /
  // "qty 20" / "count: 20". Pick the first that's not tied to a dim we
  // already parsed.
  const countRegexes = [
    /\b(\d{1,4})\s*(?:cartons?|boxes?|pcs|pieces?|skids?)\b/i,
    /\bcount[:\s]+(\d{1,4})\b/i,
    /\bqty[:\s]+(\d{1,4})\b/i,
    /\btotal\s+(?:of\s+)?(\d{1,4})\s*(?:cartons?|boxes?)\b/i,
  ];
  for (const re of countRegexes) {
    const m = text.match(re);
    if (m) {
      matches.count = Number(m[1]);
      break;
    }
  }

  // Weight per carton — "38 lb", "~38lbs", "38 pounds", "17 kg".
  const weightRegexes = [
    /(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)\b/i,
    /(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilograms?)\b/i,
  ];
  let weightUnit = 'lb';
  for (const re of weightRegexes) {
    const m = text.match(re);
    if (m) {
      matches.weightLb = Number(m[1]);
      if (/kg/i.test(m[0])) weightUnit = 'kg';
      break;
    }
  }
  if (weightUnit === 'kg' && matches.weightLb) {
    matches.weightLb = Number((matches.weightLb * 2.20462).toFixed(2));
    matches.weightOriginalUnit = 'kg';
  }

  const have = ['count', 'L', 'W', 'H', 'weightLb'].filter((k) => Number.isFinite(matches[k]));
  if (!have.length) return null;

  const parseConfidence = have.length / 5;
  return {
    count: matches.count || null,
    L: matches.L || null,
    W: matches.W || null,
    H: matches.H || null,
    weightLb: matches.weightLb || null,
    parseConfidence,
    raw: text.slice(0, 1000),
    dimsOriginalUnit: matches.dimsOriginalUnit || 'in',
    weightOriginalUnit: matches.weightOriginalUnit || 'lb',
  };
}

/**
 * parseReadyAck(body) → { ready: boolean, matchedPhrase: string|null,
 * parseConfidence: number, raw: string }
 *
 * Detects "ready to ship" acks. Confidence is high when matched phrase is
 * isolated (e.g., subject-like "all ready") and lower when buried in prose
 * (might be "we'll be ready later this week" = NOT an ack).
 */
function parseReadyAck(body) {
  if (!body || typeof body !== 'string') return { ready: false, matchedPhrase: null, parseConfidence: 0, raw: '' };
  const text = body.replace(/\r/g, '').trim();

  // Phrases that are unambiguously a ready-ack at confidence 0.9+
  const strongPhrases = [
    /\b(all\s+)?ready\s+(for\s+pickup|to\s+ship|to\s+go)\b/i,
    /\b(order|this)\s+is\s+ready\b/i,
    /\ball\s+packed\s+and\s+ready\b/i,
    /\bready\s+when\s+you\s+are\b/i,
  ];
  for (const re of strongPhrases) {
    const m = text.match(re);
    if (m) return { ready: true, matchedPhrase: m[0], parseConfidence: 0.95, raw: text.slice(0, 500) };
  }

  // Future-tense / negated — explicitly NOT an ack. Checked BEFORE the weak
  // short-message fallback so "not yet ready" / "should be ready Thurs" don't
  // get misread as acks.
  const futureOrNegation = /\b(will\s+be|won'?t\s+be|should\s+be|not\s+yet\s+ready|not\s+ready|going\s+to\s+be)\s*(yet\s+)?ready\b/i;
  if (futureOrNegation.test(text)) {
    return { ready: false, matchedPhrase: null, parseConfidence: 0.8, raw: text.slice(0, 500) };
  }

  // Weaker: a bare "ready" in a short message (likely the whole reply is the
  // ack). Excludes any lingering negations the future-tense check missed.
  if (text.length < 200 && /\bready\b/i.test(text) && !/\bnot\b.*\bready\b|\bwhen\b.*\bready\b/i.test(text)) {
    const m = text.match(/\bready\b/i);
    return { ready: true, matchedPhrase: m[0], parseConfidence: 0.7, raw: text };
  }

  return { ready: false, matchedPhrase: null, parseConfidence: 0, raw: text.slice(0, 500) };
}

/**
 * matchPoFromSubject(subject) — extract PO-NNNNN or planKey reference from
 * a reply subject line. Callers use this to bind the reply to a specific
 * draft line when In-Reply-To header matching fails.
 */
function matchPoFromSubject(subject) {
  if (!subject) return null;
  const m = subject.match(/\bPO-(\d{3,6})\b/);
  return m ? `PO-${m[1]}` : null;
}

module.exports = { parseDims, parseReadyAck, matchPoFromSubject };
