/**
 * Is a ProZone applicant a real business? (Mac 2026-10-02: "it let me put 000 as the gst number. we need a way to
 * verify that these are actual businesses.")
 *
 *   1. The GST/HST number must look like 123456789RT0001 and its first 9 digits (the CRA business number) must pass
 *      the CRA check digit (Luhn). The join form refuses anything else before it sends; this re-checks.
 *   2. BC's public registry (OrgBook BC, orgbook.gov.bc.ca, no key) is searched by that business number. An active
 *      entity carrying the same number = verified, and we show its registered name.
 *   3. If the number isn't listed (sole proprietors often aren't), the registry is searched by business name.
 *
 * Levels: verified | name_found | number_only | inactive | invalid | lookup_failed. Only `invalid` blocks Approve.
 */

'use strict';

const ORGBOOK = 'https://orgbook.gov.bc.ca/api/v4/search/topic';

function parseGst(s) {
  const m = /^\s*(\d{9})\s*-?\s*(RT)\s*-?\s*(\d{4})\s*$/i.exec(String(s || ''));
  return m ? { bn9: m[1], gst: `${m[1]}RT${m[3]}` } : null;
}

function luhnOk(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Client-side twin lives in the theme (sections/prozone-coast.liquid); keep them the same. */
function gstValid(s) { const g = parseGst(s); return !!g && luhnOk(g.bn9) && !/^0+$/.test(g.bn9); }

const norm = (s) => String(s || '').toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ')
  .split(/\s+/).filter((w) => w && !['LTD', 'LIMITED', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'THE', 'AND', 'BC'].includes(w));
function nameMatch(a, b) {
  const A = new Set(norm(a)); const B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}

async function orgbook(q, fetchImpl = fetch) {
  const url = `${ORGBOOK}?q=${encodeURIComponent(q)}&inactive=any&revoked=false&latest=true`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'yourfloors-prozone/1.0', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`OrgBook ${r.status}`);
  const j = await r.json();
  return (j.results || []).map((x) => {
    const attrs = Object.fromEntries((x.attributes || []).map((a) => [a.type, a.value]));
    const names = (x.names || []).map((n) => n.text);
    return { id: x.source_id, name: names.find((n) => !/^\d{9}$/.test(n)) || names[0] || '', bn9: names.find((n) => /^\d{9}$/.test(n)) || null,
      status: attrs.entity_status || null, type: attrs.entity_type || null, since: (attrs.registration_date || '').slice(0, 10) };
  });
}

const TYPES = { SP: 'sole proprietorship', GP: 'partnership', BC: 'BC company', C: 'company', A: 'extraprovincial company', ULC: 'unlimited company', CP: 'co-op', S: 'society' };

async function verifyBusiness({ gst, business }, { fetchImpl = fetch } = {}) {
  const g = parseGst(gst);
  if (!g || !luhnOk(g.bn9) || /^0+$/.test(g.bn9)) {
    return { level: 'invalid', summary: `GST/HST number "${String(gst || '').slice(0, 30)}" is not a real CRA number (wrong format or check digit).` };
  }
  try {
    const byNumber = (await orgbook(g.bn9, fetchImpl)).filter((r) => r.bn9 === g.bn9);
    if (byNumber.length) {
      const r = byNumber[0];
      const active = r.status === 'ACT';
      return {
        level: active ? 'verified' : 'inactive', gst: g.gst, registry: r,
        summary: active
          ? `Registered BC business: ${r.name} (${TYPES[r.type] || r.type}, active since ${r.since}), business number ${g.bn9} matches.${nameMatch(r.name, business) < 0.5 ? ` They wrote "${business}".` : ''}`
          : `Business number ${g.bn9} belongs to ${r.name}, but the BC registry shows it as NOT active (${r.status}).`,
      };
    }
    const byName = business ? (await orgbook(business, fetchImpl)).map((r) => ({ ...r, score: nameMatch(r.name, business) }))
      .filter((r) => r.score >= 0.6).sort((a, b) => b.score - a.score) : [];
    if (byName.length && byName[0].status === 'ACT') {
      const r = byName[0];
      return { level: 'name_found', gst: g.gst, registry: r,
        summary: `GST number is a valid CRA number. "${business}" matches ${r.name} in the BC registry (${TYPES[r.type] || r.type}, active since ${r.since}); the registry doesn't list its business number.` };
    }
    return { level: 'number_only', gst: g.gst,
      summary: `GST number is a valid CRA number, but neither the number nor "${business}" is in the BC registry. Common for a sole proprietor working under their own name.` };
  } catch (err) {
    return { level: 'lookup_failed', gst: g.gst, summary: `GST number is a valid CRA number. The BC registry lookup failed (${err.message}).` };
  }
}

module.exports = { parseGst, luhnOk, gstValid, nameMatch, verifyBusiness, orgbook };
