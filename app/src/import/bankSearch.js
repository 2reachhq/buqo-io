// Buqo – gespeicherte Kontoauszug-Umsätze durchsuchen (ohne die PDFs erneut von der KI lesen zu lassen).
// Zeilen im kompakten Format {d: ISO-Datum, n: Name, a: Betrag (positiv), k: 'e'|'a', z: Verwendungszweck}.
const STOP = new Set(['dann', 'wurde', 'wurden', 'gezahlt', 'bezahlt', 'kontoauszug', 'kontoauszüge', 'sollte', 'steht', 'name', 'such', 'suche', 'kurz', 'buchung', 'buchungen', 'raus', 'habe', 'haben', 'soll', 'sollen', 'rechnung', 'verbuchen', 'euro', 'raten', 'rate', 'gerne', 'nochmal', 'durch', 'bitte', 'zahlung', 'zahlungen', 'konto', 'auszug', 'dieser', 'diese', 'dieses', 'damit', 'denn', 'weil', 'oder', 'aber', 'auch', 'noch', 'dass', 'eine', 'einen', 'einer', 'nicht', 'wird', 'sind', 'beim', 'unter', 'nach', 'vorher', 'danach', 'jetzt', 'gleich', 'schon', 'mal']);

export const compactRow = (r) => ({ d: r.datum || '', n: String(r.name || '').slice(0, 70), a: Math.round(Math.abs(+r.amount || 0) * 100) / 100, k: r.kind === 'ein' ? 'e' : 'a', z: String(r.note || r.info || '').slice(0, 100) });

// deutsche Beträge im Text („6.000", „1.130,50", „350")
export function parseAmounts(text) {
  const out = [];
  (String(text || '').match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?/g) || []).forEach(t => {
    const v = parseFloat(t.replace(/\./g, '').replace(',', '.'));
    if (v >= 5 && !(v >= 1990 && v <= 2100 && !/[.,]/.test(t))) out.push(v); // Jahreszahlen sind keine Beträge
  });
  return out;
}

export function searchBank(rows, text, { limit = 25 } = {}) {
  const t = String(text || '').toLowerCase();
  const amounts = parseAmounts(t);
  const words = [...new Set(t.replace(/[^a-zäöüß0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];
  const years = t.match(/\b20\d\d\b/g) || [];
  const scored = (rows || []).map((r, idx) => {
    const hay = (r.n + ' ' + (r.z || '')).toLowerCase(); let s = 0;
    words.forEach(w => { if (hay.includes(w)) s += 3; });
    amounts.forEach(v => { if (Math.abs(r.a - v) < 0.01) s += 6; });
    if (s && years.length && !years.some(y => String(r.d).startsWith(y))) s -= 1;
    return { ...r, idx, s };
  }).filter(x => x.s >= 3);
  scored.sort((a, b) => (b.s - a.s) || String(a.d).localeCompare(String(b.d)));
  const hits = scored.slice(0, limit).sort((a, b) => String(a.d).localeCompare(String(b.d)));
  return { hits, total: Math.round(hits.reduce((s, x) => s + x.a, 0) * 100) / 100, count: scored.length };
}
