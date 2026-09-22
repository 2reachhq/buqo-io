// Buqo – Umzug aus sevDesk: CSV-Belege + ZIP-PDFs, CSV-Rechnungen + ZIP-PDFs oder DATEV-Buchungsstapel.
// Alles wird lokal gelesen und in einer Vorschau gezeigt; erst „Jetzt importieren" schreibt Buchungen,
// Rechnungen, Kunden und lädt die PDFs in den Beleg-Speicher (übernimmt die App über onImport).
import React from 'react';
import { decodeText, parseCSV, autoMap, detectFormat, FORMAT_LABEL, normalizeRows, matchFiles, markDuplicates, summarize, CATS } from './sevdesk.js';
import { readZipEntries, baseName } from './zip.js';

const { useState, useMemo } = React;
const MAP_FIELDS = [['datum','Datum'],['nummer','Nummer'],['name','Name / Kontakt'],['beschreibung','Beschreibung'],['brutto','Brutto'],['netto','Netto'],['mwst','MwSt-Satz'],['kategorie','Kategorie'],['status','Status'],['zahldatum','Zahldatum'],['faellig','Fällig']];
const isDoc = (n) => /\.(pdf|jpe?g|png|webp|heic)$/i.test(n);

export default function SevdeskImport(props) {
  const { ui, accounts, existing, defaultYear, onImport, isMobile } = props;
  const { C, SC, SS, NUM, fmt, Ic, P, hexA, AI_GRADIENT, MONTHS } = ui;
  const [belege, setBelege] = useState(null);      // {fileName, parsed, format, mapping, kind}
  const [rech, setRech] = useState(null);
  const [zipB, setZipB] = useState(null);          // {fileName, entries}
  const [zipR, setZipR] = useState(null);
  const [year, setYear] = useState(defaultYear ? String(defaultYear) : 'alle');
  const [acct, setAcct] = useState((accounts[0] || {}).key || 'unter');
  const [rowAcct, setRowAcct] = useState({});
  const [skip, setSkip] = useState({});
  const [confirmed, setConfirmed] = useState(true);
  const [mapOpen, setMapOpen] = useState({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  const readCsv = async (file, kind, setter) => {
    try { const buf = await file.arrayBuffer(); const parsed = parseCSV(decodeText(new Uint8Array(buf))); if (!parsed.header.length || !parsed.rows.length) throw new Error('Die Datei enthält keine Tabelle.'); const format = detectFormat(parsed); setter({ fileName: file.name, parsed, format, mapping: autoMap(parsed.header), kind: format === 'datev' ? 'auto' : kind }); setResult(null); setErr(''); }
    catch (e) { setErr('CSV konnte nicht gelesen werden: ' + (e.message || e)); }
  };
  const readZip = async (file, setter) => {
    try { const buf = await file.arrayBuffer(); const entries = readZipEntries(buf).filter(e => isDoc(e.name)); if (!entries.length) throw new Error('Keine PDF/Bild-Dateien im ZIP gefunden.'); setter({ fileName: file.name, entries }); setResult(null); setErr(''); }
    catch (e) { setErr('ZIP konnte nicht gelesen werden: ' + (e.message || e)); }
  };

  const build = (src, zip, exist) => {
    if (!src) return null;
    let recs = normalizeRows(src.parsed, src.mapping, { kind: src.kind, year: year !== 'alle' ? +year : null });
    recs = markDuplicates(recs, exist || []);
    const files = zip ? matchFiles(recs, zip.entries.map(e => e.name)) : new Map();
    const inYear = (r) => year === 'alle' || String(r.y) === year;
    const rows = recs.map(r => ({ ...r, file: files.get(r.idx) || null, inYear: inYear(r) }));
    return { rows, sum: summarize(rows.filter(inYear)), filesMatched: rows.filter(r => r.file && inYear(r)).length };
  };
  const B = useMemo(() => build(belege, zipB, existing && existing.belege), [belege, zipB, year, existing]);
  const R = useMemo(() => build(rech, zipR, existing && existing.rechnungen), [rech, zipR, year, existing]);
  const yearsSeen = useMemo(() => { const s = new Set(); [B, R].forEach(x => x && x.rows.forEach(r => r.y && s.add(r.y))); return [...s].sort(); }, [B, R]);

  const willImport = (X, key) => X ? X.rows.filter(r => r.inYear && !r.dup && !r.cancelled && r.brutto > 0 && r.datum && !skip[key + r.idx]) : [];
  const belegeGo = willImport(B, 'b'), rechGo = willImport(R, 'r');
  // Belege mit Wohnungs-/Vermietungsbezug landen standardmäßig beim ersten Immobilien-Konto
  const propKeys = accounts.filter(a => /^p\d$/.test(a.key)).map(a => a.key);
  const RE_PROP = /ferienwohnung|airbnb|booking|apartment|wohnung|immobil|mieter|vermiet|reinigung|putz|hausgeld|hausverwalt|stadtwerke|nebenkosten/i;
  const defaultAcctFor = (r) => (propKeys.length && RE_PROP.test([r.kategorie, r.beschreibung, r.name].join(' '))) ? propKeys[0] : acct;
  const fileFor = (zip, name) => { if (!zip || !name) return null; const e = zip.entries.find(x => x.name === name); return e ? { name: baseName(e.name), data: e.data } : null; };

  const run = async () => {
    if (busy || (!belegeGo.length && !rechGo.length)) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const payload = {
        confirmed,
        belege: belegeGo.map(r => ({ ...r, dest: rowAcct['b' + r.idx] || defaultAcctFor(r), file: fileFor(zipB, r.file) })),
        rechnungen: rechGo.map(r => ({ ...r, dest: 'unter', file: fileFor(zipR, r.file) })),
      };
      const res = await onImport(payload, setProgress);
      setResult(res);
    } catch (e) { setErr('Import fehlgeschlagen: ' + (e.message || e)); }
    setBusy(false); setProgress('');
  };

  /* ── UI-Bausteine ── */
  const card = { ...SC, padding: isMobile ? '16px' : '20px 22px' };
  const lbl = { fontSize: 12, color: C.sub, fontWeight: 600, marginBottom: 6 };
  const btnP = { display: 'inline-flex', alignItems: 'center', gap: 8, background: C.act, color: C.actTxt, border: 'none', borderRadius: 999, padding: '11px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
  const slot = (title, hint, accept, cur, onFile, done) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, background: cur ? hexA(C.grn, 0.08) : C.surf2, border: '1.5px ' + (cur ? 'solid ' + hexA(C.grn, 0.5) : 'dashed ' + C.bdrM), borderRadius: 14, padding: '13px 14px', cursor: 'pointer', minWidth: 0 }}>
      <span style={{ width: 38, height: 38, borderRadius: 11, background: cur ? C.grn : C.surf3, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={cur ? P.check : P.upload} sz={17} col={cur ? '#fff' : C.sub} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: C.txt }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.sub, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur ? (cur.fileName + ' · ' + done) : hint}</span>
      </span>
      <input type="file" accept={accept} onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onFile(f); }} style={{ display: 'none' }} />
    </label>
  );
  const Stat = ({ l, v, c }) => <div style={{ flex: 1, minWidth: 120 }}><div style={{ fontSize: 11.5, color: C.sub, fontWeight: 600 }}>{l}</div><div style={{ fontSize: 18, fontWeight: 800, color: c || C.txt, ...NUM }}>{v}</div></div>;

  return (<>
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span style={{ width: 44, height: 44, borderRadius: '50%', background: C.txt, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={P.swap} sz={20} col={C.bg} /></span>
        <div style={{ flex: 1, minWidth: 240, fontSize: 13.5, lineHeight: 1.6, color: C.txt }}>
          <b>So holst du alles aus sevDesk:</b> Dort unter <b>Belege → Exportieren</b> die <b>CSV</b> und das <b>ZIP mit den Belegdateien</b> laden, unter <b>Rechnungen → Exportieren</b> ebenfalls CSV + ZIP. Alternativ reicht der <b>DATEV-Export</b> (Buchungsstapel) im Belege-Feld. Buqo erkennt Spalten, Beträge, MwSt, Kategorien und ordnet die PDFs anhand der Belegnummer zu. Nichts wird geschrieben, bevor du unten auf „Jetzt importieren" drückst. Doppelte Einträge werden übersprungen, du kannst den Import also gefahrlos wiederholen.
        </div>
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 14 }}>
      {slot('Belege · CSV oder DATEV', 'sevDesk → Belege → Exportieren → CSV', '.csv,.txt,text/csv', belege, f => readCsv(f, 'aus', setBelege), belege && (belege.parsed.rows.length + ' Zeilen · ' + FORMAT_LABEL[belege.format]))}
      {slot('Belege · ZIP mit PDFs', 'sevDesk → Belege → Exportieren → ZIP (Dateien)', '.zip,application/zip', zipB, f => readZip(f, setZipB), zipB && (zipB.entries.length + ' Dateien'))}
      {slot('Rechnungen · CSV', 'sevDesk → Rechnungen → Exportieren → CSV', '.csv,.txt,text/csv', rech, f => readCsv(f, 'ein', setRech), rech && (rech.parsed.rows.length + ' Zeilen · ' + FORMAT_LABEL[rech.format]))}
      {slot('Rechnungen · ZIP mit PDFs', 'sevDesk → Rechnungen → Exportieren → ZIP (PDF)', '.zip,application/zip', zipR, f => readZip(f, setZipR), zipR && (zipR.entries.length + ' Dateien'))}
    </div>
    {err && <div style={{ background: hexA(C.red, 0.08), border: '1px solid ' + hexA(C.red, 0.35), borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.red, marginBottom: 14 }}>{err}</div>}

    {(B || R) && (<>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div style={lbl}>Steuerjahr</div><select value={year} onChange={e => setYear(e.target.value)} style={{ ...SS, width: 130 }}><option value="alle">Alle Jahre</option>{[...new Set([...(yearsSeen), defaultYear].filter(Boolean))].sort().map(y => <option key={y} value={String(y)}>{y}</option>)}</select></div>
          {B && <div><div style={lbl}>Belege standardmäßig auf Konto</div><select value={acct} onChange={e => setAcct(e.target.value)} style={{ ...SS, width: 220 }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></div>}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.txt, cursor: 'pointer', paddingBottom: 8 }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Als abgeschlossen importieren (kein „wartet auf Kontoauszug")</label>
        </div>
        <div style={{ fontSize: 12, color: C.mut, marginTop: 10, lineHeight: 1.5 }}>Rechnungen landen immer bei „{(accounts.find(a => a.key === 'unter') || {}).label || 'Firma'}" als Einnahmen und werden mit Kunden angelegt. Einzelne Belege kannst du in der Tabelle einem anderen Konto zuweisen, z. B. der Ferienwohnung.</div>
      </div>

      {B && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}><div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Belege · {FORMAT_LABEL[belege.format]}</div><div style={{ fontSize: 12.5, color: C.sub }}>{belege.fileName}</div></div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <Stat l="Importierbar" v={belegeGo.length} c={C.grn} /><Stat l="Schon vorhanden" v={B.sum.dup} c={C.amb} /><Stat l="Storniert / unvollständig" v={B.sum.cancelled + B.sum.invalid} /><Stat l="Summe brutto" v={fmt(belegeGo.reduce((s, r) => s + r.brutto, 0))} /><Stat l="PDF zugeordnet" v={(B.filesMatched) + (zipB ? ' / ' + zipB.entries.length : '')} c={zipB ? C.txt : C.mut} />
          </div>
          {!zipB && <div style={{ fontSize: 12, color: C.amb, marginTop: 8 }}>Ohne ZIP werden die Belege ohne Datei angelegt – du kannst die PDFs später einzeln nachladen. Besser: jetzt das ZIP dazulegen.</div>}
          <Mapping ui={ui} src={belege} setSrc={setBelege} k="b" mapOpen={mapOpen} setMapOpen={setMapOpen} isMobile={isMobile} />
          <Table ui={ui} X={B} k="b" withAcct skip={skip} setSkip={setSkip} rowAcct={rowAcct} setRowAcct={setRowAcct} acct={acct} accounts={accounts} defaultAcctFor={defaultAcctFor} />
        </div>
      )}
      {R && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}><div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Rechnungen · {FORMAT_LABEL[rech.format]}</div><div style={{ fontSize: 12.5, color: C.sub }}>{rech.fileName}</div></div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <Stat l="Importierbar" v={rechGo.length} c={C.grn} /><Stat l="Schon vorhanden" v={R.sum.dup} c={C.amb} /><Stat l="Davon offen" v={rechGo.filter(r => r.status === 'offen').length} /><Stat l="Summe brutto" v={fmt(rechGo.reduce((s, r) => s + r.brutto, 0))} /><Stat l="PDF zugeordnet" v={(R.filesMatched) + (zipR ? ' / ' + zipR.entries.length : '')} c={zipR ? C.txt : C.mut} />
          </div>
          <Mapping ui={ui} src={rech} setSrc={setRech} k="r" mapOpen={mapOpen} setMapOpen={setMapOpen} isMobile={isMobile} />
          <Table ui={ui} X={R} k="r" skip={skip} setSkip={setSkip} rowAcct={rowAcct} setRowAcct={setRowAcct} acct={acct} accounts={accounts} />
        </div>
      )}

      <div style={{ ...card, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{belegeGo.length} Belege und {rechGo.length} Rechnungen{year !== 'alle' ? ' für ' + year : ''} importieren</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>{progress || (busy ? 'Läuft…' : 'Buchungen kommen in den jeweiligen Monat, PDFs in den Beleg-Speicher, Kunden und Rechnungen in den Rechnungsbereich.')}</div>
        </div>
        <button onClick={run} disabled={busy || (!belegeGo.length && !rechGo.length)} style={{ ...btnP, opacity: (busy || (!belegeGo.length && !rechGo.length)) ? 0.55 : 1 }}><Ic p={P.check} sz={16} col={C.actTxt} /> {busy ? 'Importiert…' : 'Jetzt importieren'}</button>
      </div>
      {busy && <div className="prog" style={{ marginBottom: 14 }} />}
      {result && (
        <div style={{ ...card, marginBottom: 14, background: hexA(C.grn, 0.07), border: '1px solid ' + hexA(C.grn, 0.35) }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Fertig – {result.belege} Belege, {result.rechnungen} Rechnungen, {result.kunden} neue Kunden, {result.dateien} Dateien abgelegt</div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>{result.fehler ? result.fehler + ' Datei(en) konnten nicht hochgeladen werden, die Buchungen sind trotzdem da. ' : ''}Schau jetzt in die Übersicht oder direkt in die Steuerprognose {year !== 'alle' ? year : ''} – dort sind die Zahlen sofort drin. Einen erneuten Import mit denselben Dateien erkennt Buqo als Dubletten.</div>
        </div>
      )}
    </>)}
  </>);
}

function Mapping({ ui, src, setSrc, k, mapOpen, setMapOpen, isMobile }) {
  const { C, SS } = ui; const lbl = { fontSize: 12, color: C.sub, fontWeight: 600, marginBottom: 6 };
  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setMapOpen(o => ({ ...o, [k]: !o[k] }))} style={{ background: 'none', border: 'none', color: C.pri, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>{mapOpen[k] ? 'Spalten-Zuordnung ausblenden' : 'Spalten-Zuordnung prüfen'}</button>
      {mapOpen[k] && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0,1fr))', gap: 8, marginTop: 8 }}>
          {MAP_FIELDS.map(([f, l]) => (
            <div key={f}><div style={lbl}>{l}</div><select value={src.mapping[f] != null ? src.mapping[f] : ''} onChange={e => setSrc({ ...src, mapping: { ...src.mapping, [f]: e.target.value === '' ? undefined : +e.target.value } })} style={{ ...SS, fontSize: 12.5 }}><option value="">— nicht vorhanden —</option>{src.parsed.header.map((h, i) => <option key={i} value={i}>{h || ('Spalte ' + (i + 1))}</option>)}</select></div>
          ))}
          {src.format !== 'datev' && <div><div style={lbl}>Art der Zeilen</div><select value={src.kind} onChange={e => setSrc({ ...src, kind: e.target.value })} style={{ ...SS, fontSize: 12.5 }}><option value="aus">Ausgaben (Belege)</option><option value="ein">Einnahmen (Rechnungen)</option><option value="auto">Automatisch (Typ-Spalte / Vorzeichen)</option></select></div>}
        </div>
      )}
    </div>
  );
}
function Table({ ui, X, k, withAcct, skip, setSkip, rowAcct, setRowAcct, acct, accounts, defaultAcctFor }) {
  const { C, SS, NUM, fmt, hexA } = ui;
    if (!X) return null;
    const rows = X.rows.filter(r => r.inYear).slice(0, 300);
    const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.mut, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '8px 8px', borderBottom: '1px solid ' + C.bdr, whiteSpace: 'nowrap' };
    const td = { fontSize: 13, padding: '7px 8px', borderBottom: '1px solid ' + C.sep, verticalAlign: 'top' };
    return (
      <div style={{ overflowX: 'auto', marginTop: 12, maxHeight: 420, overflowY: 'auto', border: '1px solid ' + C.bdr, borderRadius: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead><tr><th style={th}></th><th style={th}>Datum</th><th style={th}>Name</th><th style={th}>Nummer</th><th style={th}>Kategorie</th><th style={{ ...th, textAlign: 'right' }}>Brutto</th><th style={th}>MwSt</th>{withAcct && <th style={th}>Konto</th>}<th style={th}>PDF</th><th style={th}>Hinweis</th></tr></thead>
          <tbody>
            {rows.map(r => { const off = r.dup || r.cancelled || !(r.brutto > 0 && r.datum); const sk = !!skip[k + r.idx]; const dim = off || sk; return (
              <tr key={r.idx} style={{ opacity: dim ? 0.5 : 1, background: dim ? 'transparent' : (r.kind === 'ein' ? hexA(C.grn, 0.04) : 'transparent') }}>
                <td style={td}><input type="checkbox" checked={!off && !sk} disabled={off} onChange={e => setSkip(s => ({ ...s, [k + r.idx]: !e.target.checked }))} /></td>
                <td style={{ ...td, ...NUM, whiteSpace: 'nowrap' }}>{r.datum ? r.datum.split('-').reverse().join('.') : '—'}</td>
                <td style={{ ...td, maxWidth: 240 }}><div style={{ fontWeight: 600, color: C.txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || '—'}</div>{r.beschreibung && r.beschreibung !== r.name && <div style={{ fontSize: 11.5, color: C.mut, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{r.beschreibung}</div>}</td>
                <td style={{ ...td, ...NUM, whiteSpace: 'nowrap' }}>{r.nummer || '—'}</td>
                <td style={td}>{r.kategorie || <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, ...NUM, textAlign: 'right', whiteSpace: 'nowrap', color: r.kind === 'ein' ? C.grn : C.txt, fontWeight: 600 }}>{r.kind === 'ein' ? '+' : '−'}{fmt(r.brutto)}</td>
                <td style={{ ...td, ...NUM }}>{r.mwst} %</td>
                {withAcct && <td style={td}><select value={rowAcct[k + r.idx] || (defaultAcctFor ? defaultAcctFor(r) : acct)} onChange={e => setRowAcct(a => ({ ...a, [k + r.idx]: e.target.value }))} style={{ ...SS, fontSize: 12, padding: '4px 6px', width: 150 }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></td>}
                <td style={td}>{r.file ? <span title={r.file} style={{ color: C.grn, fontWeight: 700 }}>✓</span> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, fontSize: 12, color: r.dup ? C.amb : (r.cancelled ? C.mut : C.exp) }}>{r.dup ? 'schon vorhanden' : r.cancelled ? 'storniert/Entwurf' : r.warn.join(', ')}</td>
              </tr>
            ); })}
          </tbody>
        </table>
        {X.rows.filter(r => r.inYear).length > 300 && <div style={{ fontSize: 12, color: C.mut, padding: 8 }}>… nur die ersten 300 Zeilen werden angezeigt, importiert werden alle.</div>}
      </div>
    );
}
