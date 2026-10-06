// Buqo – Abgleich der Import-Zeilen mit Kontoauszug und DATEV-Datei (vor dem Verbuchen, reine Logik).
import { compareDatev } from './datevCompare.js';

const tok = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
const dayOf = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t / 864e5; };

// rows: [{key, kind, datum, brutto, name}]; bankRows: [{name, amount, kind, datum}] → Map key → Kontoauszug-Umsatz
// Rechnungen (Einnahmen) werden oft Wochen später bezahlt, Ausgaben meist zeitnah abgebucht.
export function matchBank(rows, bankRows) {
  const used = new Set(); const res = new Map();
  const sorted = rows.slice().sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
  sorted.forEach(r => {
    const cents = Math.round(Math.abs(r.brutto) * 100); const rd = dayOf(r.datum); if (rd == null) return;
    const after = r.kind === 'ein' ? 60 : 31; const nm = tok(r.name).slice(0, 6);
    let best = null, bestScore = -1;
    bankRows.forEach((b, i) => {
      if (used.has(i) || Math.round(Math.abs(b.amount) * 100) !== cents) return;
      if (b.kind && r.kind && b.kind !== r.kind) return;
      const bd = dayOf(b.datum); if (bd == null) return; const d = bd - rd; if (d < -5 || d > after) return;
      const s = (nm.length >= 3 && tok(b.name + ' ' + (b.note || '')).includes(nm) ? 5 : 0) + (30 - Math.min(30, Math.abs(d)) / 2);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best != null) { used.add(best); res.set(r.key, bankRows[best]); }
  });
  res.used = used; // Indizes der zugeordneten Umsätze (der Rest sind Umsätze ohne Gegenstück in der CSV)
  return res;
}

// rows: [{key, y, m, kind, name, amount(brutto, Storno negativ), datum, nummer, category, mwst}]; datevRows: Zeilen aus parseDatev
// → { byKey: Map key → {state:'ok'|'abw'|'fehlt', why[]}, onlyDatev: DATEV-Zeilen ohne Gegenstück }
export function matchDatev(rows, datevRows) {
  const bookings = rows.map(r => ({ id: r.key, y: r.y, m: r.m, kind: r.kind, acct: '', name: r.name, amount: r.amount, datum: r.datum, nummer: r.nummer, category: r.category, mwst: r.mwst }));
  const cmp = compareDatev(datevRows, bookings);
  const byKey = new Map();
  cmp.matched.forEach(({ b }) => byKey.set(b.id, { state: 'ok', why: [] }));
  cmp.diffs.forEach(({ b, why }) => byKey.set(b.id, { state: 'abw', why }));
  cmp.extra.forEach(b => byKey.set(b.id, { state: 'fehlt', why: ['nicht in der DATEV-Datei'] }));
  return { byKey, onlyDatev: cmp.missing, range: cmp.range };
}
