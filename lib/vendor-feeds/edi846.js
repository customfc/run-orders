/**
 * EDI X12 846 (Inventory Inquiry/Advice) adapter — the standard "here's our
 * stock" feed from vendors that actually have EDI. Dependency-free X12 parse.
 *
 * Per line item (LIN):
 *   LIN  — product IDs as (qualifier,value) pairs. We prefer VP (vendor part),
 *          then VN, then BP/UP/UK. That value becomes vendor_sku.
 *   QTY  — QTY01 qualifier, QTY02 amount. We prefer 33 (qty available),
 *          then 17/QH (on hand), then first numeric qty present.
 *   PID  — PID05 free-form description.
 *
 * Separators are auto-detected from the ISA segment when present (ISA is fixed
 * width: element sep is char 4, segment terminator is the last char).
 */
const SKU_QUALS = ['VP', 'VN', 'BP', 'UP', 'UK', 'IN', 'PI'];
const QTY_QUALS_PREF = ['33', 'QH', '17', '20', '1', '2'];

function detectSeparators(raw) {
  if (raw.startsWith('ISA') && raw.length > 106) {
    const elem = raw[3];
    const seg = raw[105]; // char after the 16th element + element sep
    return { elem, seg };
  }
  return { elem: '*', seg: '~' };
}

function parse(content) {
  const raw = content.replace(/\r?\n/g, '').trim();
  const { elem, seg } = detectSeparators(raw);
  const segs = raw.split(seg).map(s => s.trim()).filter(Boolean);

  const items = [];
  let cur = null;
  const flush = () => { if (cur && cur.vendor_sku) items.push(cur); cur = null; };

  for (const s of segs) {
    const el = s.split(elem);
    const tag = el[0];
    if (tag === 'LIN') {
      flush();
      cur = { vendor_sku: null, qty: null, description: null, status: null, unit: null };
      // pairs start at el[2]: (qual, value), (qual, value)...
      let chosen = null, chosenRank = 999;
      for (let i = 2; i + 1 < el.length; i += 2) {
        const qual = el[i], val = el[i + 1];
        const rank = SKU_QUALS.indexOf(qual);
        if (rank !== -1 && rank < chosenRank) { chosen = val; chosenRank = rank; }
        else if (chosen == null) chosen = val; // fallback: first id present
      }
      cur.vendor_sku = chosen ? String(chosen).trim() : null;
    } else if (tag === 'QTY' && cur) {
      const qual = el[1], amt = parseFloat(el[2]);
      const unit = el[3];
      if (!Number.isNaN(amt)) {
        const better = QTY_QUALS_PREF.indexOf(qual);
        const curRank = cur._qtyRank == null ? 999 : cur._qtyRank;
        if (cur.qty == null || (better !== -1 && better < curRank)) {
          cur.qty = amt; cur._qtyRank = better === -1 ? 998 : better;
          if (unit) cur.unit = unit;
        }
      }
    } else if (tag === 'PID' && cur) {
      const desc = el[5];
      if (desc && !cur.description) cur.description = String(desc).trim();
    }
  }
  flush();
  for (const it of items) delete it._qtyRank;
  return items;
}

module.exports = { parse };
