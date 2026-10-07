// Buqo – KI-Helfer für die Import-Liste: Kontext aufbauen, Antwort der KI lesen und die Filter deterministisch auf die Zeilen anwenden.
// Die KI schlägt nur Aktionen vor; ausgeführt wird erst nach „Anwenden" in der Oberfläche.
const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');

// Einheit: {key, kind:'ein'|'aus', datum:'YYYY-MM-DD', name, brutto, kategorie, konto, cls:'passt'|'hinweis'|'fehlt', hasFile, src:'csv'|'bank', skip}
export function groupContext(units, limit = 250) {
  const g = new Map();
  units.forEach(u => {
    const k = norm(u.name) + '|' + u.kind; let x = g.get(k);
    if (!x) { x = { name: u.name, kind: u.kind, n: 0, sum: 0, first: u.datum, last: u.datum, cats: {}, kontos: {}, miss: 0, notes: new Set(), mw: {} }; g.set(k, x); }
    x.n++; x.sum += u.brutto; if (u.datum < x.first) x.first = u.datum; if (u.datum > x.last) x.last = u.datum;
    x.cats[u.kategorie || '—'] = (x.cats[u.kategorie || '—'] || 0) + 1; x.kontos[u.konto] = (x.kontos[u.konto] || 0) + 1; if (u.mwst != null) x.mw[u.mwst] = (x.mw[u.mwst] || 0) + 1; if (!u.hasFile) x.miss++; if (u.notiz && x.notes.size < 2) x.notes.add(String(u.notiz).slice(0, 60));
  });
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0][0];
  return [...g.values()].sort((a, b) => (b.n - a.n) || (b.sum - a.sum)).slice(0, limit)
    .map(x => [x.name, x.kind === 'ein' ? 'Einnahme' : 'Ausgabe', x.n + '×', Math.round(x.sum) + '€', x.first + '..' + x.last, 'Kat:' + top(x.cats), 'Konto:' + top(x.kontos), x.miss ? 'ohneBeleg:' + x.miss : '', Object.keys(x.mw).length ? 'MwSt:' + top(x.mw) + '%' : '', x.notes.size ? 'Notiz:' + [...x.notes].join('/') : ''].filter(Boolean).join(' | '));
}

export function parseBotJson(text) {
  let t = String(text || '').replace(/```json|```/g, '').trim(); const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
  try { const o = JSON.parse(t); return { antwort: String(o.antwort || '').trim(), aktionen: Array.isArray(o.aktionen) ? o.aktionen : [] }; }
  catch (e) { return { antwort: String(text || '').trim(), aktionen: [] }; }
}

export function matchFilter(u, f) {
  if (!f) return true;
  const names = f.name ? [].concat(f.name).map(norm).filter(Boolean) : [];
  if (names.length && !names.some(n => norm(u.name).includes(n))) return false;
  if (f.von && u.datum < f.von) return false;
  if (f.bis && u.datum > f.bis) return false;
  if (f.art && u.kind !== f.art) return false;
  if (f.konto && u.konto !== f.konto) return false;
  if (f.kategorie && norm(u.kategorie) !== norm(f.kategorie)) return false;
  if (f.min != null && u.brutto < +f.min) return false;
  if (f.max != null && u.brutto > +f.max) return false;
  if (f.status && u.cls !== f.status) return false;
  if (f.ohneBeleg === true && u.hasFile) return false;
  if (f.quelle && u.src !== f.quelle) return false;
  if (f.text && !norm(u.name + ' ' + (u.beschreibung || '') + ' ' + (u.notiz || '')).includes(norm(f.text))) return false;
  return true;
}

// Aktionen der KI prüfen und auf erlaubte Werte begrenzen
export function normalizeActions(actions, { cats, accounts }) {
  const kontoKey = (v) => { if (!v) return null; const n = norm(v); const a = accounts.find(x => norm(x.key) === n || norm(x.label) === n || norm(x.label).includes(n) || n.includes(norm(x.label))); return a ? a.key : null; };
  const catOf = (v) => { if (!v) return null; const c = cats.find(x => norm(x) === norm(v)); return c || null; };
  const ok = ['auswaehlen', 'setzen', 'ignorieren', 'wiederherstellen', 'notiz', 'merken', 'todo'];
  return (actions || []).filter(a => a && ok.includes(a.typ)).map(a => {
    const s = a.setzen || {}; const set = {};
    const kat = catOf(s.kategorie); if (kat) set.kategorie = kat;
    const ko = kontoKey(s.konto || (s.privat ? 'privat' : null)); if (ko) set.konto = ko;
    if (s.mwst != null && [0, 7, 19].includes(+s.mwst)) set.mwst = +s.mwst;
    const note = String(s.notiz || a.notiz || '').trim().slice(0, 300); if (note) set.notiz = note;
    const filter = a.filter ? { ...a.filter, konto: a.filter.konto ? kontoKey(a.filter.konto) : undefined, kategorie: a.filter.kategorie ? (catOf(a.filter.kategorie) || a.filter.kategorie) : undefined } : {};
    return { typ: a.typ, filter, set, text: String(a.text || '').trim().slice(0, 400) };
  });
}

// Gesamtüberblick über das Jahr für den KI-Helfer (Zahlen kommen aus der App, nicht aus dem Modell)
export function yearOverview(units) {
  const n = units.length; const act = units.filter(u => !u.skip); const sum = (a) => Math.round(a.reduce((s, u) => s + u.brutto, 0));
  const byKonto = {}; act.forEach(u => { const k = byKonto[u.konto] || (byKonto[u.konto] = { n: 0, ein: 0, aus: 0 }); k.n++; if (u.kind === 'ein') k.ein += u.brutto; else k.aus += u.brutto; });
  const byMonat = {}; act.forEach(u => { const m = String(u.datum).slice(0, 7); const x = byMonat[m] || (byMonat[m] = { n: 0, ein: 0, aus: 0 }); x.n++; if (u.kind === 'ein') x.ein += u.brutto; else x.aus += u.brutto; });
  const lines = ['Gesamt: ' + n + ' Buchungen (' + (n - act.length) + ' ignoriert, nicht importiert)',
    'Ausgaben ' + sum(act.filter(u => u.kind !== 'ein')) + '€, Einnahmen ' + sum(act.filter(u => u.kind === 'ein')) + '€',
    'Status: passt ' + act.filter(u => u.cls === 'passt').length + ', Hinweis ' + act.filter(u => u.cls === 'hinweis').length + ', fehlt ' + act.filter(u => u.cls === 'fehlt').length,
    'Beleg/PDF vorhanden ' + act.filter(u => u.hasFile).length + ', fehlt ' + act.filter(u => !u.hasFile).length,
    'Mit Notiz ' + act.filter(u => u.notiz).length + ', als To-do vorgemerkt ' + act.filter(u => u.todo).length];
  Object.entries(byKonto).forEach(([k, v]) => lines.push('Konto ' + k + ': ' + v.n + ' Buchungen, Einnahmen ' + Math.round(v.ein) + '€, Ausgaben ' + Math.round(v.aus) + '€'));
  Object.keys(byMonat).sort().forEach(m => lines.push('Monat ' + m + ': ' + byMonat[m].n + ' Buchungen, Einnahmen ' + Math.round(byMonat[m].ein) + '€, Ausgaben ' + Math.round(byMonat[m].aus) + '€'));
  return lines;
}

// Einzelbuchungen, die zu Wörtern der Nutzerfrage passen (Name, Beschreibung, Notiz, Betrag), damit der Helfer konkrete Zeilen kennt
export function relevantRows(units, text, limit = 40) {
  const words = String(text || '').toLowerCase().split(/[^a-zäöüß0-9]+/).filter(w => w.length >= 4 && !STOP.has(w)).map(norm).filter(Boolean);
  if (!words.length) return [];
  return units.filter(u => { const hay = norm(u.name + ' ' + (u.beschreibung || '') + ' ' + (u.notiz || '') + ' ' + (u.kategorie || '') + ' ' + String(u.brutto)); return words.some(w => hay.includes(w)); })
    .slice(0, limit).map(u => [u.datum, u.name, (u.kind === 'ein' ? '+' : '-') + u.brutto + '€', 'Kat:' + u.kategorie, 'Konto:' + u.konto, u.mwst != null ? 'MwSt:' + u.mwst + '%' : '', u.hasFile ? 'Beleg' : 'ohneBeleg', u.skip ? 'ignoriert' : '', u.notiz ? 'Notiz:' + String(u.notiz).slice(0, 80) : ''].filter(Boolean).join(' | '));
}
const STOP = new Set(['alle', 'alles', 'dass', 'diese', 'dieser', 'sowie', 'wurde', 'waren', 'sollen', 'bitte', 'einmal', 'machen', 'kannst', 'meine', 'meinen', 'oder', 'nicht', 'dann', 'habe', 'haben', 'wieder', 'immer', 'gedacht', 'verbuche', 'verbuchen', 'zeige', 'zeig']);
