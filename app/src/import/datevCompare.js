// Buqo – DATEV-Datei (Buchungsstapel, z. B. für den Steuerberater) mit den Buqo-Buchungen vergleichen.
// Reine Logik ohne UI: parseDatev() liest die Datei, compareDatev() findet Abweichungen.
import { parseCSV, decodeText, autoMap, normalizeRows } from './sevdesk.js';

const tok = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
const dayOf = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t / 864e5; };

export function parseDatev(buf) {
  const parsed = parseCSV(decodeText(new Uint8Array(buf)));
  if (!parsed.header.length || !parsed.rows.length) throw new Error('Die Datei enthält keine Tabelle.');
  const map = autoMap(parsed.header); const reliable = map.sh != null; // Einnahme/Ausgabe nur bei Soll/Haben-Kennzeichen verlässlich
  return normalizeRows(parsed, map, { kind: 'auto' }).filter(r => r.brutto > 0 && r.datum && !r.cancelled).map(r => ({ ...r, kindOk: reliable }));
}

// bookings: [{id, y, m, kind, acct, name, amount, datum, nummer, category, mwst}]
export function compareDatev(dRows, bookings) {
  const dates = dRows.map(r => r.datum).sort();
  const lo = dates[0] || '', hi = dates[dates.length - 1] || '';
  const bDate = (b) => (b.datum && /^\d{4}-\d{2}-\d{2}/.test(b.datum)) ? b.datum.slice(0, 10) : (b.y + '-' + String(b.m + 1).padStart(2, '0') + '-15');
  const B = bookings.filter(b => { const d = bDate(b); return d >= lo && d <= hi; });
  const used = new Set(); const matched = [], missing = [];
  dRows.forEach(d => {
    const cents = Math.round(d.brutto * 100); const dn = tok(d.nummer), dd = dayOf(d.datum), nm = tok(d.name).slice(0, 6);
    let best = null, bestScore = 0;
    B.forEach(b => {
      if (used.has(b.id) || Math.round(Math.abs(b.amount) * 100) !== cents) return;
      let s = 0; const bn = tok(b.nummer);
      if (dn.length >= 3 && bn && (bn.includes(dn) || dn.includes(bn))) s += 10;
      const bd = dayOf(bDate(b)); if (dd != null && bd != null && Math.abs(dd - bd) <= 3) s += 3;
      if (nm.length >= 3 && tok(b.name).includes(nm)) s += 2;
      if (s > bestScore) { bestScore = s; best = b; }
    });
    if (best && bestScore >= 3) { used.add(best.id); matched.push({ d, b: best }); } else missing.push(d);
  });
  const extra = B.filter(b => !used.has(b.id));
  const diffs = [];
  matched.forEach(({ d, b }) => {
    const w = [];
    if (d.kategorie && b.category && d.kategorie !== 'Allgemein' && b.category !== 'Allgemein' && d.kategorie !== b.category) w.push('Kategorie: DATEV „' + d.kategorie + '“, Buqo „' + b.category + '“');
    if (d.mwst != null && b.mwst !== '' && b.mwst != null && !Number.isNaN(+b.mwst) && +b.mwst !== +d.mwst) w.push('MwSt: DATEV ' + d.mwst + ' %, Buqo ' + b.mwst + ' %');
    const dd = dayOf(d.datum), bd = dayOf(bDate(b)); if (dd != null && bd != null && d.datum.slice(0, 7) !== bDate(b).slice(0, 7)) w.push('Monat: DATEV ' + d.datum.slice(0, 7) + ', Buqo ' + bDate(b).slice(0, 7));
    if (w.length) diffs.push({ d, b, why: w });
  });
  return { matched, missing, extra, diffs, range: [lo, hi] };
}
