// Buqo – Umzug aus sevDesk (und anderen Tools): CSV-Belege, CSV-Rechnungen, DATEV-Buchungsstapel,
// ZIP mit PDFs. Alles regelbasiert und lokal, keine KI nötig. Reines ESM, testbar mit `node --test`.

export const CATS = ['Allgemein','Miete','Nebenkosten','Versicherung','Material','Personal','Steuern','Software','Marketing','Reise','Bewirtung','Bank & Gebühren','Sonstiges'];

/* ── Text-Dekodierung: sevDesk liefert je nach Einstellung UTF-8 oder Windows-1252 ── */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let txt = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  const bad = (txt.match(/�/g) || []).length;
  if (bad > 0) { try { const alt = new TextDecoder('windows-1252').decode(u8); if (!/�/.test(alt)) txt = alt; } catch (e) { /* Node ohne ICU: UTF-8 behalten */ } }
  return txt.replace(/^﻿/, '');
}

/* ── CSV ── */
export function detectDelimiter(firstLine) {
  const cands = [';', ',', '\t', '|'];
  let best = ';', bestN = -1;
  for (const d of cands) { let n = 0, q = false; for (const ch of firstLine) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } if (n > bestN) { bestN = n; best = d; } }
  return best;
}
export function parseCSV(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstNl = src.search(/\r?\n/);
  const delimiter = detectDelimiter(firstNl < 0 ? src : src.slice(0, firstNl));
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') { q = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c !== '')) rows.push(row); row = []; continue; }
    cell += ch;
  }
  row.push(cell); if (row.some(c => c !== '')) rows.push(row);
  let meta = null, header = rows[0] || [], body = rows.slice(1);
  if (header[0] && /^"?EXTF"?$/i.test(String(header[0]).trim())) { meta = header; header = rows[1] || []; body = rows.slice(2); }
  header = header.map(h => String(h || '').trim());
  return { delimiter, meta, header, rows: body };
}

/* ── Zahlen & Daten (deutsch/englisch) ── */
export function parseNumber(v) {
  if (v == null) return 0;
  let s = String(v).trim(); if (!s) return 0;
  const neg = /^-|-$|^\(.*\)$/.test(s);
  s = s.replace(/[€$£\s]/g, '').replace(/^\(|\)$/g, '').replace(/-$/, '').replace(/^-/, '').replace(/^\+/, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');           // 1.234,56
  else if (/\.\d{1,2}$/.test(s) && /,/.test(s)) s = s.replace(/,/g, '');          // 1,234.56
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');               // 1.234 (Tausender)
  else s = s.replace(',', '.');
  const n = parseFloat(s); if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}
export function parseDate(v, fallbackYear) {
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/); if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.?$/); if (m && fallbackYear) return fallbackYear + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = s.match(/^(\d{2})(\d{2})$/); if (m && fallbackYear) return fallbackYear + '-' + m[2] + '-' + m[1];   // DATEV DDMM
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return m[1] + '-' + m[2] + '-' + m[3];                         // YYYYMMDD
  return '';
}

/* ── Spalten erkennen ── */
export const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9%\/]/g, '');
export const FIELDS = [
  ['datum',        ['belegdatum','rechnungsdatum','datum','date','voucherdate','invoicedate','buchungsdatum','erstelltam','ausgestelltam']],
  ['nummer',       ['belegnummer','belegnr','rechnungsnummer','rechnungsnr','belegfeld1','nummer','number','invoicenumber','vouchernumber','dokumentnummer','referenz']],
  ['name',         ['lieferant','kontakt','kunde','kreditor','debitor','geschaeftspartner','kontaktname','supplier','customer','contact','firma','organisation','name']],
  ['beschreibung', ['beschreibung','buchungstext','betreff','verwendungszweck','kopfzeile','titel','bezeichnung','description','text','positionen','leistung']],
  ['brutto',       ['bruttobetrag','betragbrutto','brutto','gesamtbetrag','summebrutto','sumgross','umsatzohnesoll/habenkz','endbetrag','gesamt','betrag','amount','total','umsatz']],
  ['netto',        ['nettobetrag','betragnetto','netto','summenetto','sumnet','net']],
  ['steuerbetrag', ['steuerbetrag','umsatzsteuerbetrag','mwstbetrag','ustbetrag','sumtax','taxamount']],
  ['mwst',         ['steuersatz','mwstsatz','ustsatz','mwst','ust','umsatzsteuer','taxrate','steuersatzin%','steuer%','steuersatzprozent']],
  ['kategorie',    ['kategorie','buchungskategorie','buchungskonto','kontobezeichnung','sachkonto','accountingtype','category','kostenart','konto']],
  ['status',       ['zahlungsstatus','status','bezahlt','paymentstatus','zahlstatus']],
  ['zahldatum',    ['zahlungsdatum','bezahltam','zahldatum','paydate','paidat']],
  ['faellig',      ['faelligkeitsdatum','faelligam','faellig','duedate','zahlungsziel']],
  ['waehrung',     ['waehrung','currency','wkzumsatz','wkz']],
  ['typ',          ['belegtyp','typ','art','type','dokumenttyp','creditdebit','einausgabe','richtung']],
  ['sh',           ['soll/habenkennzeichen','sollhabenkennzeichen','sollhaben','s/h']],
  ['gegenkonto',   ['gegenkontoohnebuschluessel','gegenkonto']],
  ['bu',           ['buschluessel','bu']],
];
export function autoMap(header) {
  const hs = header.map(norm); const used = new Set(); const map = {};
  const take = (field, i) => { map[field] = i; used.add(i); };
  // Pass 1: exakte Treffer über alle Felder, Pass 2: Präfix, Pass 3: enthält (nur Kernfelder, längere Synonyme)
  for (const [field, syns] of FIELDS) { for (const syn of syns) { const i = hs.findIndex((h, idx) => !used.has(idx) && h === syn); if (i >= 0) { take(field, i); break; } } }
  for (const [field, syns] of FIELDS) { if (map[field] != null) continue; for (const syn of syns) { if (syn.length < 4) continue; const i = hs.findIndex((h, idx) => !used.has(idx) && h.startsWith(syn)); if (i >= 0) { take(field, i); break; } } }
  for (const [field, syns] of FIELDS) { if (map[field] != null || !['datum','nummer','name','brutto','netto','kategorie'].includes(field)) continue; for (const syn of syns) { if (syn.length < 5) continue; const i = hs.findIndex((h, idx) => !used.has(idx) && h.includes(syn)); if (i >= 0) { take(field, i); break; } } }
  // DATEV: „Konto" ist dort das Sachkonto (Kategorie), „Belegfeld 1" die Nummer, „Umsatz" der Betrag
  if (map.sh != null || map.gegenkonto != null) { const k = hs.findIndex(h => h === 'konto'); if (k >= 0) { if (map.kategorie === k) delete map.kategorie; map.datevKonto = k; } }
  return map;
}
export function detectFormat(parsed) {
  const hs = (parsed.header || []).map(norm);
  if (parsed.meta || hs.includes('soll/habenkennzeichen') || hs.includes('gegenkontoohnebuschluessel')) return 'datev';
  if (hs.some(h => /rechnungsnummer|rechnungsnr|invoicenumber/.test(h)) && hs.some(h => /kunde|customer|debitor/.test(h))) return 'sevdesk-rechnungen';
  if (hs.some(h => /belegnummer|belegnr|vouchernumber/.test(h)) || hs.some(h => /lieferant|kreditor|supplier/.test(h))) return 'sevdesk-belege';
  return 'generic';
}
export const FORMAT_LABEL = { 'datev': 'DATEV-Buchungsstapel (EXTF)', 'sevdesk-belege': 'sevDesk-Belege (CSV)', 'sevdesk-rechnungen': 'sevDesk-Rechnungen (CSV)', 'generic': 'CSV (Spalten bitte prüfen)' };

/* ── Kategorien ── */
const SKR_TO_CAT = { '4210':'Miete','4220':'Miete','4230':'Miete','4240':'Nebenkosten','4250':'Nebenkosten','4260':'Nebenkosten','4360':'Versicherung','4380':'Versicherung','4985':'Material','4980':'Software','4964':'Software','4100':'Personal','4110':'Personal','4120':'Personal','4130':'Personal','4138':'Personal','4190':'Personal','4320':'Steuern','4340':'Steuern','4600':'Marketing','4610':'Marketing','4630':'Marketing','4660':'Reise','4663':'Reise','4664':'Reise','4666':'Reise','4670':'Reise','4650':'Bewirtung','4653':'Bewirtung','4970':'Bank & Gebühren','4900':'Sonstiges','4910':'Sonstiges','4920':'Software','4930':'Material','4940':'Material','4950':'Sonstiges','4955':'Bank & Gebühren','4957':'Sonstiges',
  // SKR04 (häufige Konten)
  '6310':'Miete','6320':'Nebenkosten','6325':'Nebenkosten','6400':'Versicherung','6020':'Personal','6030':'Personal','6040':'Personal','6600':'Marketing','6640':'Bewirtung','6650':'Reise','6660':'Reise','6670':'Reise','6805':'Software','6815':'Software','6820':'Material','6830':'Sonstiges','6855':'Bank & Gebühren','6300':'Sonstiges','7685':'Steuern' };
const CAT_RULES = [
  ['Miete', /miete|pacht|raumkosten/i], ['Nebenkosten', /nebenkost|\bstrom\b|\bgas\b|wasser|heiz|stadtwerke|grundsteuer|\bm(ü|ue)ll\b|abfall|hausgeld|hausverwalt/i], ['Versicherung', /versicher|haftpflicht|rechtsschutz/i], ['Steuern', /steuer|finanzamt|elster/i], ['Personal', /lohn|gehalt|personal|sozial|minijob|reinigungskraft|putz/i],
  ['Software', /software|lizenz|abo\b|saas|hosting|domain|server|cloud|adobe|microsoft|google|apple|openai|anthropic|notion|figma|canva/i], ['Marketing', /marketing|werbung|ads\b|anzeige|meta|facebook|instagram|google ads|flyer|druck/i], ['Reise', /reise|fahrt|bahn|flug|hotel|taxi|uber|tank|benzin|diesel|park|maut|kfz|auto/i], ['Bewirtung', /bewirtung|restaurant|caf(é|e)|essen|lieferando|imbiss/i],
  ['Bank & Gebühren', /geb(ü|ue)hr|bank|paypal|stripe|kontof|zins|kredit/i], ['Material', /material|baumarkt|werkzeug|ikea|ausstattung|inventar|einrichtung|ger(ä|ae)t/i],
];
export function mapCategory(text, skr) {
  const k = String(skr || '').replace(/\D/g, '');
  if (k && SKR_TO_CAT[k]) return SKR_TO_CAT[k];
  const t = String(text || '');
  if (!t.trim()) return '';
  const exact = CATS.find(c => c.toLowerCase() === t.trim().toLowerCase()); if (exact) return exact;
  for (const [cat, re] of CAT_RULES) if (re.test(t)) return cat;
  return '';
}
const BU_RATE = { '9': 19, '8': 7, '3': 19, '2': 7, '19': 19, '7': 7 };
const isBankAcct = (k) => /^(1000|1200|1210|1300|1360|1400|1460|1600|1800|1810|1890|1000)$/.test(String(k || '').trim());

/* ── Zeilen normalisieren ── */
/**
 * opts: { kind:'aus'|'ein'|'auto', year (Fallback für DATEV DDMM), format }
 * Ergebnis je Zeile: { idx, kind, datum, y, m, nummer, name, beschreibung, brutto, netto, mwst, kategorie, status, zahldatum, faellig, waehrung, skr, warn:[] }
 */
export function normalizeRows(parsed, mapping, opts = {}) {
  const map = mapping || autoMap(parsed.header);
  const get = (row, f) => (map[f] != null ? String(row[map[f]] ?? '').trim() : '');
  let year = opts.year || null;
  if (parsed.meta && parsed.meta[14]) { const d = parseDate(parsed.meta[14]); if (d) year = +d.slice(0, 4); }
  const out = [];
  parsed.rows.forEach((row, idx) => {
    const warn = [];
    const datum = parseDate(get(row, 'datum'), year);
    const nummer = get(row, 'nummer');
    const name = get(row, 'name') || get(row, 'beschreibung') || '';
    const beschreibung = get(row, 'beschreibung');
    let brutto = parseNumber(get(row, 'brutto'));
    let netto = parseNumber(get(row, 'netto'));
    let steuer = parseNumber(get(row, 'steuerbetrag'));
    let rate = map.mwst != null ? parseNumber(get(row, 'mwst').replace('%', '')) : NaN;
    if (map.bu != null) { const r = BU_RATE[get(row, 'bu')]; if (r != null) rate = r; }
    if (Number.isNaN(rate) || rate < 0) rate = NaN;
    // Betrags-Logik: fehlt netto, aus brutto & Satz; fehlt brutto, aus netto & Satz; Steuerbetrag als Hilfe
    if (!brutto && netto && !Number.isNaN(rate)) brutto = Math.round(netto * (1 + rate / 100) * 100) / 100;
    if (!brutto && netto && steuer) brutto = Math.round((netto + steuer) * 100) / 100;
    if (!netto && brutto && !Number.isNaN(rate)) netto = Math.round(brutto / (1 + rate / 100) * 100) / 100;
    if (!netto && brutto && steuer) netto = Math.round((brutto - steuer) * 100) / 100;
    if (Number.isNaN(rate)) { rate = (netto && brutto && brutto > netto) ? Math.round((brutto / netto - 1) * 100) : 0; if (![0, 7, 19, 16, 5].includes(rate)) rate = Math.abs(rate - 19) < 2 ? 19 : Math.abs(rate - 7) < 2 ? 7 : rate; }
    if (!netto && brutto) netto = brutto;
    // Richtung
    let kind = opts.kind && opts.kind !== 'auto' ? opts.kind : 'aus';
    const typ = get(row, 'typ').toLowerCase();
    if (map.sh != null) {
      const sh = get(row, 'sh').toUpperCase(); const konto = get(row, 'datevKonto'), gegen = get(row, 'gegenkonto');
      const sach = isBankAcct(konto) ? 'gegen' : 'konto';
      kind = sach === 'konto' ? (sh === 'S' ? 'aus' : 'ein') : (sh === 'S' ? 'ein' : 'aus');
    } else if (typ) {
      if (/ausgangsrechnung|rechnung an|einnahme|erl(ö|oe)s|gutschrift an|revenue|income|credit/.test(typ) && !/eingangs|lieferant/.test(typ)) kind = 'ein';
      else if (/eingangsrechnung|beleg|ausgabe|aufwand|expense|debit|lieferant/.test(typ)) kind = 'aus';
    } else if (opts.kind === 'auto' && brutto < 0) kind = 'aus';
    if (brutto < 0) { brutto = Math.abs(brutto); netto = Math.abs(netto); }
    const skr = map.datevKonto != null ? (isBankAcct(get(row, 'datevKonto')) ? get(row, 'gegenkonto') : get(row, 'datevKonto')) : '';
    let kategorie = mapCategory(get(row, 'kategorie'), skr) || mapCategory(beschreibung) || mapCategory(name);
    if (kind === 'ein') kategorie = CATS.includes(get(row, 'kategorie')) ? get(row, 'kategorie') : 'Allgemein';
    const statusTxt = get(row, 'status').toLowerCase(); const zahldatum = parseDate(get(row, 'zahldatum'), year);
    const paid = /bezahlt|paid|ausgeglichen|abgeschlossen|erledigt|gebucht/.test(statusTxt) || (!!zahldatum) || (map.status == null && map.zahldatum == null);
    const cancelled = /storniert|cancel|entwurf|draft/.test(statusTxt);
    if (!datum) warn.push('kein Datum');
    if (!brutto) warn.push('kein Betrag');
    if (cancelled) warn.push('storniert/Entwurf');
    const y = datum ? +datum.slice(0, 4) : null, m = datum ? (+datum.slice(5, 7) - 1) : null;
    out.push({ idx, kind, datum, y, m, nummer, name: name.slice(0, 90), beschreibung, brutto, netto, mwst: rate, kategorie, status: paid ? 'bezahlt' : 'offen', cancelled, zahldatum, faellig: parseDate(get(row, 'faellig'), year), waehrung: (get(row, 'waehrung') || 'EUR').toUpperCase().slice(0, 3), skr, warn });
  });
  return out;
}

/* ── PDFs aus dem ZIP den Zeilen zuordnen ── */
const tok = (s) => norm(s).replace(/[^a-z0-9]/g, '');
export function matchFiles(records, fileNames) {
  const files = fileNames.map(n => ({ name: n, key: tok(n.split('/').pop().replace(/\.[a-z0-9]+$/i, '')), used: false }));
  const res = new Map();
  // 1) Belegnummer im Dateinamen
  records.forEach(r => { const k = tok(r.nummer); if (k.length < 3) return; const f = files.find(x => !x.used && x.key.includes(k)); if (f) { f.used = true; res.set(r.idx, f.name); } });
  // 2) Name + Betrag/Datum im Dateinamen
  records.forEach(r => { if (res.has(r.idx)) return; const nk = tok(r.name).slice(0, 12); if (nk.length < 4) return; const cents = String(Math.round(r.brutto * 100)); const f = files.find(x => !x.used && x.key.includes(nk) && (x.key.includes(cents) || (r.datum && x.key.includes(r.datum.replace(/-/g, ''))) || x.key.includes(String(Math.round(r.brutto))))); if (f) { f.used = true; res.set(r.idx, f.name); } });
  // 3) Nur-Name-Treffer, wenn eindeutig
  records.forEach(r => { if (res.has(r.idx)) return; const nk = tok(r.name).slice(0, 12); if (nk.length < 5) return; const cand = files.filter(x => !x.used && x.key.includes(nk)); if (cand.length === 1) { cand[0].used = true; res.set(r.idx, cand[0].name); } });
  return res;
}

/* ── Dubletten gegen bestehende Buchungen ── */
export function markDuplicates(records, existing) {
  const byNr = new Set(), bySig = new Set();
  (existing || []).forEach(e => { const nr = tok(e.nummer); const cents = Math.round((e.brutto || 0) * 100); if (nr.length >= 3) byNr.add(nr + '|' + cents); bySig.add(tok(e.name).slice(0, 14) + '|' + cents + '|' + (e.datum || '')); });
  const seen = new Set();
  return records.map(r => { const cents = Math.round(r.brutto * 100); const nr = tok(r.nummer); const k1 = nr + '|' + cents, k2 = tok(r.name).slice(0, 14) + '|' + cents + '|' + r.datum; const dup = (nr.length >= 3 && byNr.has(k1)) || bySig.has(k2) || seen.has(k1 + '|' + k2); seen.add(k1 + '|' + k2); return { ...r, dup }; });
}

export function summarize(records) {
  const ok = records.filter(r => !r.dup && !r.cancelled && r.brutto > 0 && r.datum);
  const sum = (arr, f) => Math.round(arr.reduce((s, r) => s + (r[f] || 0), 0) * 100) / 100;
  return { total: records.length, importable: ok.length, dup: records.filter(r => r.dup).length, cancelled: records.filter(r => r.cancelled).length, invalid: records.filter(r => !r.dup && !r.cancelled && !(r.brutto > 0 && r.datum)).length, brutto: sum(ok, 'brutto'), netto: sum(ok, 'netto'), years: [...new Set(ok.map(r => r.y))].sort() };
}
