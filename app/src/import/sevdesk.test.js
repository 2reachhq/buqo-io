import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCSV, parseNumber, parseDate, autoMap, detectFormat, normalizeRows, matchFiles, markDuplicates, summarize, mapCategory, decodeText } from './sevdesk.js';
import { readZipEntries } from './zip.js';

const SEV_BELEGE = '﻿Belegnummer;Belegdatum;Lieferant;Beschreibung;Buchungskonto;Nettobetrag;Steuersatz;Bruttobetrag;Zahlungsstatus;Zahlungsdatum;Währung\n'
 + 'B-2025-0012;02.01.2025;Adobe Systems;Creative Cloud Abo;Software / Lizenzen;59,92;19;71,31;Bezahlt;03.01.2025;EUR\n'
 + 'B-2025-0013;01.03.2025;Stadtwerke MG;Strom Ferienwohnung;Strom, Gas, Wasser;99,50;19;118,40;Bezahlt;05.03.2025;EUR\n'
 + 'B-2025-0014;15.03.2025;Bahn AG;Fahrt Kundentermin;Reisekosten;36,36;7;38,90;Offen;;EUR\n'
 + 'B-2025-0015;20.03.2025;"Müller, Klaus";Storno Test;Sonstiges;10,00;19;11,90;Storniert;;EUR\n';
const SEV_RECH = 'Rechnungsnummer,Rechnungsdatum,Kunde,Betreff,Netto,MwSt,Brutto,Status,Fälligkeitsdatum\n'
 + 'RE-2025-007,2025-02-10,"Müller Immobilien GmbH",Website-Relaunch,"2,000.00",19,"2,380.00",Bezahlt,2025-02-24\n'
 + 'RE-2025-008,2025-04-01,Café Lotte,Social Media,1000.00,19,1190.00,Offen,2025-04-15\n';
const DATEV = '"EXTF";700;21;"Buchungsstapel";12;20260101120000;;"RE";"sevdesk";"";1001;1;20250101;4;20250101;20251231;"Belege 2025";"";1;0;;"EUR";;;;;;;;;;""\n'
 + 'Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;Kurs;Basis-Umsatz;WKZ Basis-Umsatz;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;Belegfeld 1;Belegfeld 2;Skonto;Buchungstext\n'
 + '71,31;"S";"EUR";;;;4964;1200;"9";0201;"B-2025-0012";"";0,00;"Adobe Creative Cloud"\n'
 + '2380,00;"H";"EUR";;;;8400;1200;"3";1002;"RE-2025-007";"";0,00;"Müller Immobilien Website"\n'
 + '38,90;"S";"EUR";;;;4670;1200;"8";1503;"";"";0,00;"Bahn Kundentermin"\n';

test('CSV: Delimiter, Quotes, BOM, EXTF-Metazeile', () => {
  const a = parseCSV(SEV_BELEGE); assert.equal(a.delimiter, ';'); assert.equal(a.header[0], 'Belegnummer'); assert.equal(a.rows.length, 4); assert.equal(a.rows[3][2], 'Müller, Klaus');
  const b = parseCSV(SEV_RECH); assert.equal(b.delimiter, ','); assert.equal(b.rows[0][6], '2,380.00');
  const d = parseCSV(DATEV); assert.ok(d.meta); assert.equal(d.meta[0], 'EXTF'); assert.equal(d.header[0], 'Umsatz (ohne Soll/Haben-Kz)'); assert.equal(d.rows.length, 3);
});
test('Zahlen und Daten', () => {
  assert.equal(parseNumber('1.234,56'), 1234.56); assert.equal(parseNumber('2,380.00'), 2380); assert.equal(parseNumber('-12,00 €'), -12); assert.equal(parseNumber('71,31'), 71.31); assert.equal(parseNumber('1.234'), 1234); assert.equal(parseNumber('19'), 19);
  assert.equal(parseDate('02.01.2025'), '2025-01-02'); assert.equal(parseDate('2025-02-10'), '2025-02-10'); assert.equal(parseDate('0201', 2025), '2025-01-02'); assert.equal(parseDate('20250101'), '2025-01-01'); assert.equal(parseDate('1.3.25'), '2025-03-01');
});
test('Format + Spalten erkennen', () => {
  const a = parseCSV(SEV_BELEGE); assert.equal(detectFormat(a), 'sevdesk-belege');
  const m = autoMap(a.header); assert.equal(a.header[m.datum], 'Belegdatum'); assert.equal(a.header[m.nummer], 'Belegnummer'); assert.equal(a.header[m.name], 'Lieferant'); assert.equal(a.header[m.brutto], 'Bruttobetrag'); assert.equal(a.header[m.netto], 'Nettobetrag'); assert.equal(a.header[m.mwst], 'Steuersatz'); assert.equal(a.header[m.kategorie], 'Buchungskonto'); assert.equal(a.header[m.status], 'Zahlungsstatus');
  const b = parseCSV(SEV_RECH); assert.equal(detectFormat(b), 'sevdesk-rechnungen'); const mb = autoMap(b.header); assert.equal(b.header[mb.nummer], 'Rechnungsnummer'); assert.equal(b.header[mb.name], 'Kunde'); assert.equal(b.header[mb.brutto], 'Brutto'); assert.equal(b.header[mb.faellig], 'Fälligkeitsdatum');
  const d = parseCSV(DATEV); assert.equal(detectFormat(d), 'datev'); const md = autoMap(d.header); assert.equal(d.header[md.brutto], 'Umsatz (ohne Soll/Haben-Kz)'); assert.equal(d.header[md.sh], 'Soll/Haben-Kennzeichen'); assert.equal(d.header[md.nummer], 'Belegfeld 1'); assert.equal(d.header[md.beschreibung], 'Buchungstext'); assert.equal(d.header[md.datevKonto], 'Konto'); assert.equal(d.header[md.bu], 'BU-Schlüssel');
});
test('sevDesk-Belege normalisieren', () => {
  const a = parseCSV(SEV_BELEGE); const rs = normalizeRows(a, autoMap(a.header), { kind: 'aus' });
  assert.equal(rs.length, 4);
  assert.deepEqual([rs[0].datum, rs[0].y, rs[0].m, rs[0].brutto, rs[0].netto, rs[0].mwst, rs[0].kategorie, rs[0].status, rs[0].kind], ['2025-01-02', 2025, 0, 71.31, 59.92, 19, 'Software', 'bezahlt', 'aus']);
  assert.equal(rs[1].kategorie, 'Nebenkosten'); assert.equal(rs[2].kategorie, 'Reise'); assert.equal(rs[2].status, 'offen'); assert.equal(rs[2].mwst, 7);
  assert.equal(rs[3].cancelled, true);
  const s = summarize(markDuplicates(rs, [])); assert.equal(s.importable, 3); assert.equal(s.cancelled, 1); assert.equal(s.brutto, 228.61); assert.deepEqual(s.years, [2025]);
});
test('sevDesk-Rechnungen normalisieren (englische Zahlen)', () => {
  const b = parseCSV(SEV_RECH); const rs = normalizeRows(b, autoMap(b.header), { kind: 'ein' });
  assert.equal(rs[0].brutto, 2380); assert.equal(rs[0].netto, 2000); assert.equal(rs[0].status, 'bezahlt'); assert.equal(rs[0].faellig, '2025-02-24'); assert.equal(rs[0].kind, 'ein');
  assert.equal(rs[1].status, 'offen'); assert.equal(rs[1].name, 'Café Lotte'); assert.equal(rs[0].kategorie, 'Allgemein'); assert.equal(rs[1].kategorie, 'Allgemein');
});
test('DATEV-Buchungsstapel: Richtung, Satz aus BU, Jahr aus Kopfzeile', () => {
  const d = parseCSV(DATEV); const rs = normalizeRows(d, autoMap(d.header), { kind: 'auto' });
  assert.deepEqual([rs[0].kind, rs[0].datum, rs[0].mwst, rs[0].netto, rs[0].kategorie, rs[0].nummer], ['aus', '2025-01-02', 19, 59.92, 'Software', 'B-2025-0012']);
  assert.deepEqual([rs[1].kind, rs[1].datum, rs[1].mwst, rs[1].netto], ['ein', '2025-02-10', 19, 2000]);
  assert.deepEqual([rs[2].kind, rs[2].mwst, rs[2].kategorie], ['aus', 7, 'Reise']);
});
test('Dubletten gegen Bestand', () => {
  const a = parseCSV(SEV_BELEGE); const rs = normalizeRows(a, autoMap(a.header), { kind: 'aus' });
  const marked = markDuplicates(rs, [{ nummer: 'B-2025-0012', brutto: 71.31, name: 'Adobe', datum: '2025-01-02' }, { nummer: '', brutto: 118.4, name: 'Stadtwerke MG', datum: '2025-03-01' }]);
  assert.deepEqual(marked.map(r => r.dup), [true, true, false, false]);
});
test('PDF-Zuordnung aus ZIP-Dateinamen', () => {
  const a = parseCSV(SEV_BELEGE); const rs = normalizeRows(a, autoMap(a.header), { kind: 'aus' });
  const files = ['Belege/B-2025-0012_Adobe.pdf', 'Belege/Stadtwerke_MG_118-40_2025-03-01.pdf', 'Belege/irgendwas.pdf', 'Belege/RE-2025-007_Mueller.pdf'];
  const m = matchFiles(rs, files);
  assert.equal(m.get(0), 'Belege/B-2025-0012_Adobe.pdf'); assert.equal(m.get(1), 'Belege/Stadtwerke_MG_118-40_2025-03-01.pdf'); assert.equal(m.has(2), false);
});
test('ZIP lesen (deflate + stored)', async () => {
  const buf = readFileSync(new URL('./__fixtures__/belege.zip', import.meta.url));
  const entries = readZipEntries(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.deepEqual(entries.map(e => e.name).sort(), ['Belege/B-2025-0012_Adobe.pdf', 'Belege/RE-2025-007_Mueller.pdf', 'Belege/Stadtwerke_MG_118-40_2025-03-01.pdf', 'Belege/irgendwas.pdf'].sort());
  const adobe = await entries.find(e => e.name.includes('Adobe')).data(); assert.equal(new TextDecoder().decode(adobe).slice(0, 8), '%PDF-1.4'); assert.equal(adobe.length, 15 * 40);
  const stored = await entries.find(e => e.name.includes('Mueller')).data(); assert.equal(new TextDecoder().decode(stored), '%PDF-1.4 stored');
});
test('Kategorie-Mapping und Windows-1252-Fallback', () => {
  assert.equal(mapCategory('', '4964'), 'Software'); assert.equal(mapCategory('Versicherung Allianz'), 'Versicherung'); assert.equal(mapCategory('Bank & Gebühren'), 'Bank & Gebühren'); assert.equal(mapCategory('Reinigungskraft'), 'Personal'); assert.equal(mapCategory('Müller Immobilien GmbH'), '');
  const cp = new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]); const t = decodeText(cp); assert.ok(t === 'Müller' || t.includes('�'));
});

import { detectRecurring } from './sevdesk.js';
test('Wiederkehrendes erkennen: gleicher Name+Betrag in ≥3 Monaten, Lücke überbrückt, Einzelposten nicht', () => {
  const mk = (idx, name, y, m, brutto) => ({ idx, name, y, m, brutto, netto: brutto / 1.19, mwst: 19, datum: y + '-' + String(m + 1).padStart(2, '0') + '-05', cancelled: false, dup: false });
  const rows = [mk(1, 'VW Leasing GmbH', 2026, 5, 228.63), mk(2, 'VW Leasing GmbH', 2026, 6, 228.63), mk(3, 'VW Leasing GmbH', 2026, 8, 228.63), mk(4, 'VW Leasing GmbH', 2026, 7, 230), // 230 liegt innerhalb 2 %
    mk(5, 'Jet', 2026, 1, 50), mk(6, 'Jet', 2026, 2, 80), mk(7, 'Jet', 2026, 3, 30), // schwankende Beträge → kein Treffer
    mk(8, 'Adobe', 2025, 0, 29.4), mk(9, 'Adobe', 2025, 1, 29.4)]; // nur 2 Monate
  const g = detectRecurring(rows, { today: new Date('2026-09-29') });
  assert.equal(g.length, 1); assert.equal(g[0].name, 'VW Leasing GmbH'); assert.equal(g[0].months, 4); assert.equal(g[0].ongoing, true); assert.deepEqual(g[0].to, { y: 2026, m: 8 }); assert.equal(g[0].idxs.length, 4);
  assert.equal(detectRecurring(rows, { today: new Date('2027-06-01') })[0].ongoing, false);
});

import { bankRowsFromCsv } from './sevdesk.js';
test('Kontoauszug-CSV: Eingang/Abbuchung nach Vorzeichen, Bank-Spaltennamen', () => {
  const csv = 'Buchungstag;Valuta;Auftraggeber/Empfänger;Verwendungszweck;Betrag\n05.09.2026;05.09.2026;VW Leasing GmbH;Vertrag 1165849;-228,63\n07.09.2026;07.09.2026;Intensiv 4 you UG;RE-1482;722,25\n';
  const p = parseCSV(csv); const out = bankRowsFromCsv(p);
  assert.equal(out.length, 2); assert.equal(out[0].kind, 'aus'); assert.equal(out[0].amount, 228.63); assert.equal(out[0].name, 'VW Leasing GmbH'); assert.equal(out[0].datum, '2026-09-05');
  assert.equal(out[1].kind, 'ein'); assert.equal(out[1].amount, 722.25); assert.match(out[1].note, /RE-1482/);
});

test('Rechnungs-CSV ohne Namensspalte: Name aus Adresse, Brutto/Netto nicht vertauscht, Land nie als Name', async () => {
  const sv = await import('./sevdesk.js');
  const csv = '"Rechnungs-Nr.";"Rechnungs-Datum";"Betreff";"Gesamtbetrag-Netto";"Gesamtbetrag-Brutto";"Empfänger-KdNr";"Empfänger-Adresse";"Empfänger-Land"\n' +
    'RE-1;21.09.2026;Rechnung;800,00;952,00;1068;FK Growth GmbH Thalmannsdorf 2 86567 Hilgertshausen;Deutschland\n' +
    'RE-2;22.09.2026;Rechnung;79,44;85,00;1072;Veerle Schmitz Korte koningsdwarsstraat 7 1011GB Amsterdam;Deutschland\n';
  const p = sv.parseCSV(csv); const rows = sv.normalizeRows(p, sv.autoMap(p.header), { kind: 'ein' });
  assert.equal(rows[0].name, 'FK Growth GmbH'); assert.equal(rows[0].brutto, 952); assert.equal(rows[0].netto, 800); assert.equal(rows[0].mwst, 19);
  assert.equal(rows[1].name, 'Veerle Schmitz Korte'); assert.notEqual(rows[1].name, 'Deutschland');
});

test('DATEV-Abgleich: findet fehlende, überzählige und abweichende Buchungen', async () => {
  const { parseDatev, compareDatev } = await import('./datevCompare.js');
  const csv = '"Rechnungs-Nr.";"Rechnungs-Datum";"Lieferant";"Bruttobetrag";"Steuersatz";"Kategorie"\nA1;02.01.2025;Adobe;71,31;19;Software\nA2;05.01.2025;Telekom;50,00;19;Software\nA3;07.01.2025;Fehlt GmbH;10,00;19;Material\n';
  const rows = parseDatev(new TextEncoder().encode(csv));
  const B = [
    { id: '1', y: 2025, m: 0, kind: 'aus', name: 'Adobe', amount: 71.31, datum: '2025-01-02', nummer: 'A1', category: 'Marketing', mwst: 19 },
    { id: '2', y: 2025, m: 0, kind: 'aus', name: 'Telekom', amount: 50, datum: '2025-01-05', nummer: 'A2', category: 'Software', mwst: 19 },
    { id: '3', y: 2025, m: 0, kind: 'aus', name: 'Nur Buqo', amount: 99, datum: '2025-01-06', nummer: '', category: 'Material', mwst: 19 },
  ];
  const r = compareDatev(rows, B);
  assert.equal(r.matched.length, 2); assert.equal(r.missing.length, 1); assert.equal(r.extra.length, 1); assert.equal(r.diffs.length, 1);
  assert.match(r.diffs[0].why[0], /Kategorie/);
});
