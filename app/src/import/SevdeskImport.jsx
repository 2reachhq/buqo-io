// Buqo – Umzug aus sevDesk: CSV-Belege + ZIP-PDFs, CSV-Rechnungen + ZIP-PDFs oder DATEV-Buchungsstapel.
// Alles wird lokal gelesen und in einer Vorschau gezeigt; erst „Jetzt importieren" schreibt Buchungen,
// Rechnungen, Kunden und lädt die PDFs in den Beleg-Speicher (übernimmt die App über onImport).
import React from 'react';
import { decodeText, parseCSV, autoMap, detectFormat, FORMAT_LABEL, normalizeRows, matchFiles, markDuplicates, summarize, detectRecurring, bankRowsFromCsv, CATS } from './sevdesk.js';
import { readZipEntries, baseName } from './zip.js';

const { useState, useMemo } = React;
const MAP_FIELDS = [['datum','Datum'],['nummer','Nummer'],['name','Name / Kontakt'],['beschreibung','Beschreibung'],['brutto','Brutto'],['netto','Netto'],['mwst','MwSt-Satz'],['kategorie','Kategorie'],['status','Status'],['zahldatum','Zahldatum'],['faellig','Fällig']];
const isDoc = (n) => /\.(pdf|jpe?g|png|webp|heic)$/i.test(n);


// Zwischenspeicher: Dateien (CSV/ZIP/Kontoauszüge) und Arbeitsstand bleiben im Browser (IndexedDB) erhalten
const idbOpen = () => new Promise((res, rej) => { try { const q = indexedDB.open('buqo_import_draft', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); } catch (e) { rej(e); } });
const idbGet = async (k) => { const d = await idbOpen(); return new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); };
const idbSet = async (k, v) => { const d = await idbOpen(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };
const idbDel = async (k) => { const d = await idbOpen(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };
const normN = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

export default function SevdeskImport(props) {
  const { ui, accounts, existing, defaultYear, onImport, isMobile, aiClassify, aiReadDoc } = props;
  const { C, SC, SS, NUM, fmt, Ic, P, hexA, AI_GRADIENT, MONTHS } = ui;
  const [belege, setBelege] = useState(null);      // {fileName, parsed, format, mapping, kind}
  const [rech, setRech] = useState(null);
  const [zipB, setZipB] = useState(null);          // {fileName, entries}
  const [zipR, setZipR] = useState(null);
  const [year, setYear] = useState(defaultYear ? String(defaultYear) : 'alle');
  const [acct, setAcct] = useState((accounts[0] || {}).key || 'unter');
  const [rowAcct, setRowAcct] = useState({});
  const [skip, setSkip] = useState({});
  const [notes, setNotes] = useState({});           // Notiz je Zeile (für den KI-Steuerberater), Schlüssel k+idx
  const [confirmed, setConfirmed] = useState(true);
  const [bank, setBank] = useState([]);           // Kontoauszüge: [{file, name, kind:'csv'|'datei', rows?}]
  const [recurOff, setRecurOff] = useState({}); // erkannte Wiederkehrend-Gruppen, die der Nutzer abgewählt hat
  const [minCust, setMinCust] = useState(2); // Kunden nur anlegen, wenn er mind. so viele Rechnungen hat (1 = alle)
  const [mapOpen, setMapOpen] = useState({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [ai, setAi] = useState({});             // KI-Sortierung: {b12|r3: {acct, sure, why}}
  const [aiBusy, setAiBusy] = useState(false);
  const [aiProg, setAiProg] = useState('');
  const [ocr, setOcr] = useState({});               // KI-Lesung der PDFs: {b12|r3: {name, datum, nummer, brutto, netto, mwst, kategorie, beschreibung} | {error}}
  const [ocrOff, setOcrOff] = useState({});         // Zeilen, bei denen die KI-Änderungen abgeschaltet sind
  const [kiRows, setKiRows] = useState({});         // Zeilen, die die KI beim Import im Hintergrund lesen soll (k+idx)
  const [kiAll, setKiAll] = useState(false);        // alle PDFs beim Import von der KI lesen lassen
  const restored = React.useRef(false);
  const [draftInfo, setDraftInfo] = useState(null); // {savedAt} – Zwischenstand vorhanden
  const [hint, setHint] = useState('');         // Hinweise für die KI, z. B. „Mieter Müller = Sylt"
  const [onlyUnsure, setOnlyUnsure] = useState(false);

  const readCsv = async (file, kind, setter) => {
    try { const buf = await file.arrayBuffer(); const parsed = parseCSV(decodeText(new Uint8Array(buf))); if (!parsed.header.length || !parsed.rows.length) throw new Error('Die Datei enthält keine Tabelle.'); const format = detectFormat(parsed); setter({ fileName: file.name, file, parsed, format, mapping: autoMap(parsed.header), kind: format === 'datev' ? 'auto' : kind }); setResult(null); setErr(''); }
    catch (e) { setErr('CSV konnte nicht gelesen werden: ' + (e.message || e)); }
  };
  const readZip = async (file, setter) => {
    try { const buf = await file.arrayBuffer(); const entries = readZipEntries(buf).filter(e => isDoc(e.name)); if (!entries.length) throw new Error('Keine PDF/Bild-Dateien im ZIP gefunden.'); setter({ fileName: file.name, file, entries }); setResult(null); setErr(''); }
    catch (e) { setErr('ZIP konnte nicht gelesen werden: ' + (e.message || e)); }
  };

  const addBank = async (files) => {
    const list = [];
    for (const f of files) {
      try {
        if (/\.(csv|txt)$/i.test(f.name) || /csv|text/.test(f.type || '')) { const parsed = parseCSV(decodeText(new Uint8Array(await f.arrayBuffer()))); const rows = bankRowsFromCsv(parsed, autoMap(parsed.header)); if (!rows.length) throw new Error('Keine Umsätze erkannt (Spalten Datum/Betrag fehlen?)'); list.push({ file: f, name: f.name, kind: 'csv', rows }); }
        else list.push({ file: f, name: f.name, kind: 'datei' });
      } catch (e) { setErr('Kontoauszug „' + f.name + '": ' + (e.message || e)); }
    }
    if (list.length) { setBank(b => [...b, ...list]); setResult(null); }
  };
  // Wirksame Zeile: Original + KI-Korrekturen (Name, Kategorie, Beschreibung, Nummer wenn leer, MwSt nur wenn der Brutto-Betrag im PDF übereinstimmt).
  // Betrag und Datum werden NIE automatisch geändert – Abweichungen erscheinen nur als Hinweis.
  const eff = (k, r) => {
    const o = ocr[k + r.idx]; if (!o || o.error || ocrOff[k + r.idx]) return r;
    const out = { ...r };
    if (o.name && normN(o.name) !== normN(r.name)) out.name = String(o.name).slice(0, 90);
    if (o.kategorie && CATS.includes(o.kategorie) && r.kind === 'aus') out.kategorie = o.kategorie;
    if (o.beschreibung) out.beschreibung = String(o.beschreibung).slice(0, 120);
    if (o.nummer && !r.nummer) out.nummer = String(o.nummer).slice(0, 40);
    if ([0, 7, 19].includes(o.mwst) && o.brutto != null && Math.abs(o.brutto - r.brutto) < 0.02 && o.mwst !== r.mwst) { out.mwst = o.mwst; out.netto = Math.round(r.brutto / (1 + o.mwst / 100) * 100) / 100; }
    return out;
  };
  const ocrDiff = (k, r) => { const o = ocr[k + r.idx]; if (!o || o.error) return []; const w = []; if (o.brutto != null && Math.abs(o.brutto - r.brutto) > 0.02) w.push('PDF: Betrag ' + fmt(o.brutto)); if (o.datum && r.datum && o.datum !== r.datum) w.push('PDF: Datum ' + o.datum.split('-').reverse().join('.')); return w; };

  // ── Zwischenspeicher: beim Öffnen wiederherstellen, bei Änderungen speichern ──
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const f = await idbGet('files'); const s = await idbGet('state'); if (!alive) return;
        const map = (s && s.mappings) || {};
        if (f) {
          if (f.belege) await readCsv(f.belege.file, f.belege.kind, o => setBelege(map.belege ? { ...o, mapping: map.belege } : o));
          if (f.rech) await readCsv(f.rech.file, f.rech.kind, o => setRech(map.rech ? { ...o, mapping: map.rech } : o));
          if (f.zipB) await readZip(f.zipB, setZipB);
          if (f.zipR) await readZip(f.zipR, setZipR);
          if (f.bank && f.bank.length) await addBank(f.bank.map(x => x.file));
        }
        if (s && s.state) { const st = s.state; setYear(st.year); setAcct(st.acct); setRowAcct(st.rowAcct || {}); setSkip(st.skip || {}); setNotes(st.notes || {}); setConfirmed(st.confirmed !== false); setRecurOff(st.recurOff || {}); setMinCust(st.minCust || 2); setAi(st.ai || {}); setKiRows(st.kiRows || {}); setKiAll(!!st.kiAll); setHint(st.hint || ''); setDraftInfo({ savedAt: s.savedAt }); }
      } catch (e) { /* kein Zwischenspeicher (z. B. privater Modus) */ }
      restored.current = true;
    })();
    return () => { alive = false; };
  }, []);
  React.useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      if (!belege && !rech && !zipB && !zipR && !bank.length) { idbDel('files').catch(() => {}); idbDel('state').catch(() => {}); setDraftInfo(null); return; }
      idbSet('files', { belege: belege && { file: belege.file, kind: belege.kind }, rech: rech && { file: rech.file, kind: rech.kind }, zipB: zipB && zipB.file, zipR: zipR && zipR.file, bank: bank.map(b => ({ file: b.file })) }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [belege && belege.file, rech && rech.file, zipB && zipB.file, zipR && zipR.file, bank]);
  React.useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      if (!belege && !rech && !zipB && !zipR && !bank.length) return;
      const savedAt = Date.now();
      idbSet('state', { savedAt, mappings: { belege: belege && belege.mapping, rech: rech && rech.mapping }, state: { year, acct, rowAcct, skip, notes, confirmed, recurOff, minCust, ai, kiRows, kiAll, hint } }).then(() => setDraftInfo({ savedAt })).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [year, acct, rowAcct, skip, notes, confirmed, recurOff, minCust, ai, kiRows, kiAll, hint, belege && belege.mapping, rech && rech.mapping]);
  const discardDraft = () => { idbDel('files').catch(() => {}); idbDel('state').catch(() => {}); setBelege(null); setRech(null); setZipB(null); setZipR(null); setBank([]); setRowAcct({}); setSkip({}); setNotes({}); setAi({}); setOcr({}); setOcrOff({}); setRecurOff({}); setDraftInfo(null); setResult(null); };
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
  // Wiederkehrendes: über ALLE Jahre erkennen (Lauf reißt nicht an der Jahresgrenze ab), gesetzt wird es nur bei importierten Zeilen
  const recurB = useMemo(() => B ? detectRecurring(B.rows.filter(r => !r.dup).map(r => r)) : [], [B]);
  const recurR = useMemo(() => R ? detectRecurring(R.rows.filter(r => !r.dup).map(r => r)) : [], [R]);
  const goIdx = (go) => new Set(go.map(r => r.idx));
  const recurActive = (groups, go, k) => { const set = goIdx(go); return groups.filter(g => !recurOff[k + g.id] && g.idxs.some(i => set.has(i))); };
  // Belege mit Wohnungs-/Vermietungsbezug landen standardmäßig beim ersten Immobilien-Konto
  const propKeys = accounts.filter(a => /^p\d$/.test(a.key)).map(a => a.key);
  const RE_PROP = /ferienwohnung|airbnb|booking|apartment|wohnung|immobil|mieter|vermiet|reinigung|putz|hausgeld|hausverwalt|stadtwerke|nebenkosten/i;
  const defaultAcctFor = (r) => (propKeys.length && RE_PROP.test([r.kategorie, r.beschreibung, r.name].join(' '))) ? propKeys[0] : acct;
  const defaultInvAcct = (r) => (propKeys.length && RE_PROP.test([r.beschreibung, r.name].join(' '))) ? propKeys[0] : 'unter';
  // Reihenfolge: manuelle Wahl in der Tabelle > KI-Vorschlag > Stichwort-Regel
  const acctOf = (k, r) => rowAcct[k + r.idx] || (ai[k + r.idx] && ai[k + r.idx].acct) || (k === 'r' ? defaultInvAcct(r) : defaultAcctFor(r));
  const allGo = [...belegeGo.map(r => ({ r, k: 'b' })), ...rechGo.map(r => ({ r, k: 'r' }))];
  const aiDone = allGo.filter(x => ai[x.k + x.r.idx]).length;
  const aiUnsure = allGo.filter(x => ai[x.k + x.r.idx] && !ai[x.k + x.r.idx].sure && !rowAcct[x.k + x.r.idx]).length;
  const perAcct = accounts.map(a => ({ ...a, n: allGo.filter(x => acctOf(x.k, x.r) === a.key).length, sum: allGo.filter(x => acctOf(x.k, x.r) === a.key).reduce((s, x) => s + (x.r.kind === 'ein' ? x.r.brutto : 0), 0) })).filter(a => a.n);
  const runAi = async () => {
    if (aiBusy || !aiClassify || !allGo.length) return;
    setAiBusy(true); setErr(''); setAiProg('KI liest ' + allGo.length + ' Posten …');
    try {
      const rows = allGo.map(({ r, k }) => ({ key: k + r.idx, kind: k === 'r' ? 'ein' : r.kind, datum: r.datum, name: r.name, beschreibung: r.beschreibung, kategorie: r.kategorie, brutto: r.brutto }));
      const { results, missing } = await aiClassify(rows, hint, (d, t) => setAiProg('KI sortiert … ' + d + ' / ' + t));
      setAi(prev => ({ ...prev, ...results }));
      setAiProg(Object.keys(results).length + ' Posten sortiert' + (missing.length ? ', ' + missing.length + ' ohne Vorschlag (bitte selbst wählen)' : '') + '.');
    } catch (e) { setErr('KI-Sortierung fehlgeschlagen: ' + (e.message || e)); setAiProg(''); }
    setAiBusy(false);
  };
  const fileFor = (zip, name) => { if (!zip || !name) return null; const e = zip.entries.find(x => x.name === name); return e ? { name: baseName(e.name), data: e.data } : null; };

  const run = async () => {
    if (busy || (!belegeGo.length && !rechGo.length && !bank.length)) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const payload = {
        confirmed, minCust,
        bank: bank.map(b => ({ file: b.file, name: b.name, kind: b.kind, rows: b.rows || null })),
        belege: belegeGo.map(r0 => { const r = eff('b', r0); const g = recurActive(recurB, belegeGo, 'b').find(x => x.idxs.includes(r.idx)); return { ...r, ki: !!r.file && (kiAll || !!kiRows['b' + r.idx]), taxNote: (notes['b' + r.idx] || '').trim(), dest: acctOf('b', r), file: fileFor(zipB, r.file), recur: g ? { from: g.from, until: g.ongoing ? null : g.to } : null }; }),
        rechnungen: rechGo.map(r0 => { const r = eff('r', r0); return ({ ...r, ki: !!r.file && (kiAll || !!kiRows['r' + r.idx]), taxNote: (notes['r' + r.idx] || '').trim(), dest: acctOf('r', r), file: fileFor(zipR, r.file) }); }),
        // laufende Rechnungs-Serien: ab dem Folgemonat automatisch weiter erzeugen
        recurInvoices: recurActive(recurR, rechGo, 'r').filter(g => g.ongoing && g.idxs.includes(g.last.idx) && rechGo.some(r => r.idx === g.last.idx)).map(g => ({ name: g.last.name, dest: acctOf('r', g.last), netto: g.last.netto, mwst: g.last.mwst, beschreibung: g.last.beschreibung, adresse: g.last.adresse, lastY: g.to.y, lastM: g.to.m })),
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

    {draftInfo && (belege || rech || zipB || zipR || bank.length > 0) && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: hexA(C.grn, 0.08), border: '1px solid ' + hexA(C.grn, 0.35), borderRadius: 12, padding: '10px 14px', fontSize: 12.5, color: C.txt, marginBottom: 14 }}>
        <span style={{ flex: 1, minWidth: 220 }}>💾 Zwischengespeichert ({new Date(draftInfo.savedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}): geladene Dateien, Kontozuordnungen, Notizen und KI-Ergebnisse bleiben erhalten, auch wenn du die Seite schließt.</span>
        <button onClick={() => { if (window.confirm('Zwischenstand wirklich verwerfen? Geladene Dateien und alle Zuordnungen hier werden entfernt (bereits importierte Buchungen bleiben).')) discardDraft(); }} style={{ background: 'none', border: '1px solid ' + C.bdr, color: C.sub, borderRadius: 999, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>Zwischenstand verwerfen</button>
      </div>)}
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 14 }}>
      {slot('Belege · CSV oder DATEV', 'sevDesk → Belege → Exportieren → CSV', '.csv,.txt,text/csv', belege, f => readCsv(f, 'aus', setBelege), belege && (belege.parsed.rows.length + ' Zeilen · ' + FORMAT_LABEL[belege.format]))}
      {slot('Belege · ZIP mit PDFs', 'sevDesk → Belege → Exportieren → ZIP (Dateien)', '.zip,application/zip', zipB, f => readZip(f, setZipB), zipB && (zipB.entries.length + ' Dateien'))}
      {slot('Rechnungen · CSV', 'sevDesk → Rechnungen → Exportieren → CSV', '.csv,.txt,text/csv', rech, f => readCsv(f, 'ein', setRech), rech && (rech.parsed.rows.length + ' Zeilen · ' + FORMAT_LABEL[rech.format]))}
      {slot('Rechnungen · ZIP mit PDFs', 'sevDesk → Rechnungen → Exportieren → ZIP (PDF)', '.zip,application/zip', zipR, f => readZip(f, setZipR), zipR && (zipR.entries.length + ' Dateien'))}
    </div>
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, background: bank.length ? hexA(C.grn, 0.08) : C.surf2, border: '1.5px ' + (bank.length ? 'solid ' + hexA(C.grn, 0.5) : 'dashed ' + C.bdrM), borderRadius: 14, padding: '13px 14px', cursor: 'pointer', marginBottom: 14 }}>
      <span style={{ width: 38, height: 38, borderRadius: 11, background: bank.length ? C.grn : C.surf3, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={bank.length ? P.check : P.bank} sz={17} col={bank.length ? '#fff' : C.sub} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: C.txt }}>Kontoauszüge · CSV, PDF oder Foto (mehrere möglich)</span>
        <span style={{ display: 'block', fontSize: 12, color: C.sub, marginTop: 2 }}>{bank.length ? bank.map(b => b.name + (b.rows ? ' (' + b.rows.length + ' Umsätze)' : ' (wird gelesen)')).join(' · ') : 'Die Umsätze werden mit deinen Belegen und Rechnungen abgeglichen; die Datei wird für den Steuerberater abgelegt.'}</span>
      </span>
      {bank.length > 0 && <button onClick={e => { e.preventDefault(); setBank([]); }} style={{ background: 'none', border: 'none', color: C.mut, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit' }}>Entfernen</button>}
      <input type="file" multiple accept=".csv,.txt,.pdf,image/*,text/csv" onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) addBank(fs); }} style={{ display: 'none' }} />
    </label>
    {err && <div style={{ background: hexA(C.red, 0.08), border: '1px solid ' + hexA(C.red, 0.35), borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.red, marginBottom: 14 }}>{err}</div>}

    {(B || R) && (<>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div style={lbl}>Steuerjahr</div><select value={year} onChange={e => setYear(e.target.value)} style={{ ...SS, width: 130 }}><option value="alle">Alle Jahre</option>{[...new Set([...(yearsSeen), defaultYear].filter(Boolean))].sort().map(y => <option key={y} value={String(y)}>{y}</option>)}</select></div>
          {B && <div><div style={lbl}>Belege standardmäßig auf Konto</div><select value={acct} onChange={e => setAcct(e.target.value)} style={{ ...SS, width: 220 }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></div>}
          <div><div style={lbl}>Kunden anlegen ab</div><select value={minCust} onChange={e => setMinCust(+e.target.value)} style={{ ...SS, width: 190 }}><option value={1}>1 Rechnung (alle)</option><option value={2}>2 Rechnungen</option><option value={3}>3 Rechnungen</option><option value={5}>5 Rechnungen</option></select></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.txt, cursor: 'pointer', paddingBottom: 8 }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Als abgeschlossen importieren (kein „wartet auf Kontoauszug")</label>
        </div>
        <div style={{ fontSize: 12, color: C.mut, marginTop: 10, lineHeight: 1.5 }}>Jede Rechnung und jeder Beleg landet auf dem Konto, das in der Tabelle steht. Einmalige Gäste werden nicht als Kunde angelegt (ihre Rechnung bleibt mit Namen erhalten) – nur wer mindestens so viele Rechnungen hat, wie oben gewählt. Lass die KI unten alles vorsortieren und korrigiere nur, was gelb markiert ist.</div>
      </div>

      {aiClassify && allGo.length > 0 && (
        <div style={{ ...card, marginBottom: 14, border: '1px solid ' + hexA(C.pri, 0.35) }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span style={{ width: 44, height: 44, borderRadius: 13, background: AI_GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={P.spark} sz={20} col="#fff" /></span>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Mit KI sortieren: Immobilien oder Firma?</div>
              <div style={{ fontSize: 13, color: C.sub, marginTop: 3, lineHeight: 1.55 }}>Die KI geht alle {allGo.length} Rechnungen und Belege durch und legt jede auf das passende Konto – Miete und Ferienwohnung zur Immobilie, Dienstleistungen zur Firma. Unsichere Fälle werden gelb markiert.</div>
              <textarea value={hint} onChange={e => setHint(e.target.value)} rows={2} placeholder={'Optional: Hinweise, z. B. „Mieter Müller und alles mit Sylt gehört zu ' + ((accounts.find(a => /^p\d$/.test(a.key)) || {}).label || 'Immobilie 1') + '"'} style={{ ...SS, marginTop: 10, width: '100%', resize: 'vertical', fontSize: 13, lineHeight: 1.45, boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={runAi} disabled={aiBusy} style={{ ...btnP, background: AI_GRADIENT, color: '#fff', opacity: aiBusy ? 0.6 : 1 }}><Ic p={P.spark} sz={15} col="#fff" /> {aiBusy ? 'Sortiert…' : aiDone ? 'Nochmal sortieren' : 'Jetzt mit KI sortieren'}</button>
                {aiProg && <span style={{ fontSize: 12.5, color: C.sub }}>{aiProg}</span>}
                {aiUnsure > 0 && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.amb, fontWeight: 700, cursor: 'pointer' }}><input type="checkbox" checked={onlyUnsure} onChange={e => setOnlyUnsure(e.target.checked)} /> nur {aiUnsure} unsichere zeigen</label>}
              </div>
              {aiBusy && <div className="prog" style={{ marginTop: 10 }} />}
              {aiDone > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>{perAcct.map(a => <span key={a.key} style={{ fontSize: 12.5, fontWeight: 600, color: C.txt, background: C.surf2, border: '1px solid ' + C.bdr, borderRadius: 99, padding: '5px 11px' }}>{a.label}: {a.n}{a.sum ? ' · ' + fmt(a.sum) + ' Einnahmen' : ''}</span>)}</div>}
            </div>
          </div>
        </div>
      )}

      {B && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}><div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Belege · {FORMAT_LABEL[belege.format]}</div><div style={{ fontSize: 12.5, color: C.sub }}>{belege.fileName}</div></div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <Stat l="Importierbar" v={belegeGo.length} c={C.grn} /><Stat l="Schon vorhanden" v={B.sum.dup} c={C.amb} /><Stat l="Storniert / unvollständig" v={B.sum.cancelled + B.sum.invalid} /><Stat l="Summe brutto" v={fmt(belegeGo.reduce((s, r) => s + r.brutto, 0))} /><Stat l="PDF zugeordnet" v={(B.filesMatched) + (zipB ? ' / ' + zipB.entries.length : '')} c={zipB ? C.txt : C.mut} />
          </div>
          {!zipB && <div style={{ fontSize: 12, color: C.amb, marginTop: 8 }}>Ohne ZIP werden die Belege ohne Datei angelegt – du kannst die PDFs später einzeln nachladen. Besser: jetzt das ZIP dazulegen.</div>}
          <Mapping ui={ui} src={belege} setSrc={setBelege} k="b" mapOpen={mapOpen} setMapOpen={setMapOpen} isMobile={isMobile} />
          <Table ui={ui} eff={eff} ocr={ocr} ocrOff={ocrOff} setOcrOff={setOcrOff} ocrDiff={ocrDiff} kiRows={kiRows} setKiRows={setKiRows} kiAll={kiAll} year={year} setYear={setYear} years={yearsSeen} notes={notes} setNotes={setNotes} title="Belege" zip={zipB} X={B} k="b" withAcct skip={skip} setSkip={setSkip} rowAcct={rowAcct} setRowAcct={setRowAcct} accounts={accounts} acctOf={acctOf} ai={ai} onlyUnsure={onlyUnsure} />
        </div>
      )}
      {R && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}><div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Rechnungen · {FORMAT_LABEL[rech.format]}</div><div style={{ fontSize: 12.5, color: C.sub }}>{rech.fileName}</div></div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <Stat l="Importierbar" v={rechGo.length} c={C.grn} /><Stat l="Schon vorhanden" v={R.sum.dup} c={C.amb} /><Stat l="Davon offen" v={rechGo.filter(r => r.status === 'offen').length} /><Stat l="Summe brutto" v={fmt(rechGo.reduce((s, r) => s + r.brutto, 0))} /><Stat l="PDF zugeordnet" v={(R.filesMatched) + (zipR ? ' / ' + zipR.entries.length : '')} c={zipR ? C.txt : C.mut} />
          </div>
          <Mapping ui={ui} src={rech} setSrc={setRech} k="r" mapOpen={mapOpen} setMapOpen={setMapOpen} isMobile={isMobile} />
          <Table ui={ui} eff={eff} ocr={ocr} ocrOff={ocrOff} setOcrOff={setOcrOff} ocrDiff={ocrDiff} kiRows={kiRows} setKiRows={setKiRows} kiAll={kiAll} year={year} setYear={setYear} years={yearsSeen} notes={notes} setNotes={setNotes} title="Rechnungen" zip={zipR} X={R} k="r" withAcct skip={skip} setSkip={setSkip} rowAcct={rowAcct} setRowAcct={setRowAcct} accounts={accounts} acctOf={acctOf} ai={ai} onlyUnsure={onlyUnsure} />
        </div>
      )}

      {aiReadDoc && (B || R) && (belegeGo.length + rechGo.length) > 0 && (() => {
        const withFile = [...belegeGo.map(r => ['b', r]), ...rechGo.map(r => ['r', r])].filter(([k, r]) => r.file);
        const marked = withFile.filter(([k, r]) => kiAll || kiRows[k + r.idx]).length;
        return (
          <div style={{ ...card, marginBottom: 14, border: '1px solid ' + hexA(C.pri, 0.35) }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span style={{ width: 44, height: 44, borderRadius: 13, background: AI_GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={P.spark} sz={20} col="#fff" /></span>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>KI soll PDFs lesen (beim Import, im Hintergrund)</div>
                <div style={{ fontSize: 12.5, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>Hake in der Tabelle in der Spalte „KI" die Zeilen an, deren PDF die KI lesen soll – oder alle auf einmal. Gelesen wird erst, wenn du auf <b>Importieren</b> klickst; danach läuft es im Hintergrund, den Fortschritt siehst du unten rechts. Die KI korrigiert Name, Kategorie, Beschreibung, Nummer und MwSt-Satz. <b>Betrag und Datum ändert sie nie</b> – weicht das PDF ab, legt sie ein To-do an. Verbraucht KI-Guthaben pro PDF.</div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}><input type="checkbox" checked={kiAll} onChange={e => setKiAll(e.target.checked)} /> Alle {withFile.length} PDFs von der KI lesen lassen</label>
                  <span style={{ fontSize: 12.5, color: C.sub }}>{marked} von {withFile.length} PDFs für die KI markiert</span>
                </div>
              </div>
            </div>
          </div>);
      })()}

      {(recurB.length + recurR.length > 0) && (() => {
        const M = (f) => ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'][f.m] + ' ' + f.y;
        const sec = (title, groups, go, k, note) => groups.filter(g => g.idxs.some(i => goIdx(go).has(i))).length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, letterSpacing: '0.03em', marginBottom: 6 }}>{title}</div>
            {groups.filter(g => g.idxs.some(i => goIdx(go).has(i))).map(g => { const off = !!recurOff[k + g.id]; return (
              <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderTop: '1px solid ' + C.sep, cursor: 'pointer', opacity: off ? 0.5 : 1 }}>
                <input type="checkbox" checked={!off} onChange={e => setRecurOff(o => ({ ...o, [k + g.id]: !e.target.checked }))} />
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ fontSize: 13.5, fontWeight: 600, color: C.txt }}>{g.name}</span><span style={{ display: 'block', fontSize: 12, color: C.sub }}>{g.months} Monate · {M(g.from)} – {M(g.to)}{g.ongoing ? ' · läuft noch' : ''}{note && g.ongoing ? note(g) : ''}</span></span>
                <span style={{ fontSize: 13.5, fontWeight: 700, ...NUM }}>{fmt(g.amount)}</span>
              </label>); })}
          </div>);
        return (
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Wiederkehrendes erkannt</div>
            <div style={{ fontSize: 12.5, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>Gleicher Name und Betrag in mindestens 3 Monaten hintereinander. Die einzelnen Monate bleiben als Buchungen erhalten; zusätzlich werden sie als wiederkehrend markiert. Bei laufenden Rechnungs-Serien wird ab dem Folgemonat automatisch weiter eine Rechnung erzeugt. Nimm das Häkchen raus, wo es nicht stimmt.</div>
            {sec('BELEGE / AUSGABEN', recurB, belegeGo, 'b')}
            {sec('RECHNUNGEN / EINNAHMEN', recurR, rechGo, 'r', g => ' · neue Rechnung ab ' + M({ y: g.to.m === 11 ? g.to.y + 1 : g.to.y, m: (g.to.m + 1) % 12 }))}
          </div>);
      })()}

      <div style={{ ...card, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{belegeGo.length} Belege und {rechGo.length} Rechnungen{year !== 'alle' ? ' für ' + year : ''} importieren</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>{progress || (busy ? 'Läuft…' : 'Buchungen kommen in den jeweiligen Monat, PDFs in den Beleg-Speicher, Kunden und Rechnungen in den Rechnungsbereich.')}</div>
        </div>
        <button onClick={run} disabled={busy || (!belegeGo.length && !rechGo.length && !bank.length)} style={{ ...btnP, opacity: (busy || (!belegeGo.length && !rechGo.length && !bank.length)) ? 0.55 : 1 }}><Ic p={P.check} sz={16} col={C.actTxt} /> {busy ? 'Importiert…' : 'Jetzt importieren'}</button>
      </div>
      {busy && <div className="prog" style={{ marginBottom: 14 }} />}
      {result && (
        <div style={{ ...card, marginBottom: 14, background: hexA(C.grn, 0.07), border: '1px solid ' + hexA(C.grn, 0.35) }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Fertig – {result.belege} Belege, {result.rechnungen} Rechnungen, {result.kunden} neue Kunden, {result.dateien} Dateien abgelegt{result.wiederkehrend ? ' · ' + result.wiederkehrend + ' Belege als wiederkehrend markiert' : ''}{result.serien ? ' · ' + result.serien + ' laufende Rechnungs-Serie(n) angelegt' : ''}{result.kontoauszuege ? ' · ' + result.kontoauszuege + ' Kontoauszug/-auszüge abgelegt (' + result.bankUmsaetze + ' Umsätze zum Abgleich im Bereich Bank)' : ''}</div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>{result.fehler ? result.fehler + ' Datei(en) konnten nicht hochgeladen werden, die Buchungen sind trotzdem da. ' : ''}Schau jetzt in die Konten oder direkt in die Steuerprognose {year !== 'alle' ? year : ''} – dort sind die Zahlen sofort drin. Einen erneuten Import mit denselben Dateien erkennt Buqo als Dubletten.</div>
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
function Table({ ui, eff, ocr, ocrOff, setOcrOff, ocrDiff, kiRows, setKiRows, kiAll, X, k, title, zip, year, setYear, years, notes, setNotes, withAcct, skip, setSkip, rowAcct, setRowAcct, accounts, acctOf, ai, onlyUnsure }) {
  const { C, SS, NUM, fmt, hexA } = ui;
  const [sort, setSort] = useState('name');        // Sortierung: nach Name (Standard), Datum oder Betrag
  const [noteAsk, setNoteAsk] = useState(null);      // Rückfrage nach einer Notiz: {r, val, count}
  const [ask, setAsk] = useState(null);            // Rückfrage beim Konto-Wechsel: {r, val, count}
  const [note, setNote] = useState('');
  const [big, setBig] = useState(false);          // Vollbild-Ansicht der Tabelle
  const [view, setView] = useState(null);          // Index der Zeile mit geöffnetem Beleg
  const [pv, setPv] = useState(null);               // {url, isPdf} des geöffneten Belegs
    if (!X) return null;
    const aiOf = (r) => (ai && ai[k + r.idx]) || null;
    const nkey = (r) => String(r.name || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
    const cmpName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de', { sensitivity: 'base' }) || String(a.datum || '').localeCompare(String(b.datum || ''));
    const rows = X.rows.filter(r => r.inYear && (!onlyUnsure || (aiOf(r) && !aiOf(r).sure && !rowAcct[k + r.idx]))).sort(sort === 'datum' ? (a, b) => String(a.datum || '').localeCompare(String(b.datum || '')) : sort === 'betrag' ? (a, b) => (b.brutto || 0) - (a.brutto || 0) : cmpName).slice(0, big ? 3000 : 300);
    // Beleg in neuem Tab: Fenster sofort öffnen (Popup-Blocker), Datei danach laden
    const openTab = async (r) => {
      const w = window.open('', '_blank'); if (w) { try { w.document.title = r.file; w.document.body.style.cssText = 'margin:0;font-family:sans-serif;background:#222;color:#fff'; w.document.body.innerText = 'Beleg wird geladen…'; } catch (e) { /* egal */ } }
      try {
        const e = zip && zip.entries.find(x => x.name === r.file); if (!e) throw new Error('Datei nicht gefunden');
        const bytes = await e.data(); const ext = (r.file.split('.').pop() || '').toLowerCase(); const type = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const url = URL.createObjectURL(new Blob([bytes], { type })); if (w) w.location.href = url; else window.open(url, '_blank');
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e2) { /* egal */ } }, 10 * 60 * 1000);
      } catch (err) { if (w) { try { w.document.body.innerText = 'Beleg konnte nicht geöffnet werden: ' + (err.message || err); } catch (e3) { /* egal */ } } }
    };
    const closeView = () => { if (pv && pv.url) { try { URL.revokeObjectURL(pv.url); } catch (e) { /* egal */ } } setPv(null); setView(null); };
    const openView = async (i) => {
      const r = rows[i]; if (!r) return; if (pv && pv.url) { try { URL.revokeObjectURL(pv.url); } catch (e) { /* egal */ } }
      setView(i); setPv({ loading: true });
      try { const e = zip && zip.entries.find(x => x.name === r.file); if (!e) { setPv({ missing: true }); return; } const bytes = await e.data(); const isPdf = /\.pdf$/i.test(r.file); const ext = (r.file.split('.').pop() || '').toLowerCase(); const blob = new Blob([bytes], { type: isPdf ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }); setPv({ url: URL.createObjectURL(blob), isPdf }); }
      catch (e) { setPv({ missing: true }); }
    };
    const nameCount = {}; X.rows.filter(r => r.inYear).forEach(r => { const n = nkey(r); nameCount[n] = (nameCount[n] || 0) + 1; });
    // Konto ändern: gibt es weitere Zeilen mit demselben Namen, fragt ein Pop-up, ob alle oder nur diese Zeile geändert werden.
    const sameRows = (r) => { const n = nkey(r); return X.rows.filter(x => x.inYear && !x.dup && !x.cancelled && nkey(x) === n); };
    const assign = (r, val) => {
      const same = sameRows(r);
      if (same.length > 1) setAsk({ r, val, count: same.length });
      else { setRowAcct(a => ({ ...a, [k + r.idx]: val })); setNote(''); }
    };
    // Notiz geändert: gibt es weitere Zeilen mit demselben Namen (ohne diese Notiz), fragt ein Pop-up, ob sie für alle gelten soll.
    const askNote = (r, val) => {
      val = String(val || '').trim(); if (!val) return;
      const others = sameRows(r).filter(x => x.idx !== r.idx && String((notes && notes[k + x.idx]) || '').trim() !== val);
      if (others.length) setNoteAsk({ r, val, count: others.length + 1 });
    };
    const applyNoteAsk = (all) => {
      const { r, val } = noteAsk;
      if (all) { const same = sameRows(r); setNotes(n => { const nx = { ...n }; same.forEach(g => { nx[k + g.idx] = val; }); return nx; }); setNote('Notiz für „' + String(r.name).slice(0, 40) + '" bei ' + same.length + ' Zeilen übernommen.'); }
      setNoteAsk(null);
    };
    const applyAsk = (all) => {
      const { r, val } = ask; const same = sameRows(r);
      if (all) { setRowAcct(a => { const nx = { ...a }; same.forEach(g => { nx[k + g.idx] = val; }); return nx; }); setNote('„' + String(r.name).slice(0, 40) + '": ' + same.length + ' Zeilen auf einmal zugeordnet.'); }
      else { setRowAcct(a => ({ ...a, [k + r.idx]: val })); setNote(''); }
      setAsk(null);
    };
    const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.mut, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '8px 8px', borderBottom: '1px solid ' + C.bdr, whiteSpace: 'nowrap' };
    const td = { fontSize: 13, padding: '7px 8px', borderBottom: '1px solid ' + C.sep, verticalAlign: 'top' };
    return (
      <div style={big ? { position: 'fixed', inset: 0, zIndex: 140, background: C.bg, padding: 16, overflow: 'auto' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: big ? 0 : 12 }}>
        {big && <span style={{ fontSize: 17, fontWeight: 800, marginRight: 6 }}>{title}</span>}
        <span style={{ fontSize: 12, color: C.sub, fontWeight: 600 }}>Jahr</span>
        <select value={year} onChange={e => setYear(e.target.value)} style={{ ...SS, width: 'auto', fontSize: 12.5, padding: '5px 8px' }}><option value="alle">Alle Jahre</option>{(years || []).map(y => <option key={y} value={String(y)}>{y}</option>)}</select>
        <span style={{ fontSize: 12, color: C.sub, fontWeight: 600 }}>Sortieren nach</span>
        <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...SS, width: 'auto', fontSize: 12.5, padding: '5px 8px' }}><option value="name">Name (Abbuchung/Kunde)</option><option value="datum">Datum</option><option value="betrag">Betrag</option></select>
        <span style={{ fontSize: 11.5, color: C.mut, flex: 1, minWidth: 220 }}>{note || 'Tipp: Änderst du das Konto bei einem Namen, der öfter vorkommt, fragt die App, ob alle Zeilen mit diesem Namen oder nur diese Zeile geändert werden.'}</span>
        <button onClick={() => setBig(b => !b)} style={{ background: big ? C.txt : C.surf2, color: big ? C.bg : C.txt, border: '1px solid ' + (big ? C.txt : C.bdr), borderRadius: 9, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{big ? 'Schließen' : 'Vergrößern'}</button>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 8, maxHeight: big ? 'calc(100vh - 90px)' : 420, overflowY: 'auto', border: '1px solid ' + C.bdr, borderRadius: 12, background: C.surf }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead><tr><th style={th}></th><th style={th}>Datum</th><th style={th}>Name</th><th style={th}>Nummer</th><th style={th}>Kategorie</th><th style={{ ...th, textAlign: 'right' }}>Brutto</th><th style={th}>MwSt</th>{withAcct && <th style={th}>Konto</th>}<th style={th}>PDF</th><th style={th} title="KI liest das PDF beim Import im Hintergrund">KI</th><th style={th}>Notiz für den Steuerberater</th><th style={th}>Hinweis</th></tr></thead>
          <tbody>
            {rows.map(r => { const off = r.dup || r.cancelled || !(r.brutto > 0 && r.datum); const sk = !!skip[k + r.idx]; const dim = off || sk; const e = eff(k, r); const o = ocr[k + r.idx]; const kiOn = !!o && !o.error && !ocrOff[k + r.idx]; const chg = (f) => kiOn && e[f] !== r[f]; const odiff = ocrDiff(k, r); return (
              <tr key={r.idx} style={{ opacity: dim ? 0.5 : 1, background: dim ? 'transparent' : (r.kind === 'ein' ? hexA(C.grn, 0.04) : 'transparent') }}>
                <td style={td}><input type="checkbox" checked={!off && !sk} disabled={off} onChange={e => setSkip(s => ({ ...s, [k + r.idx]: !e.target.checked }))} /></td>
                <td style={{ ...td, ...NUM, whiteSpace: 'nowrap' }}>{r.datum ? r.datum.split('-').reverse().join('.') : '—'}</td>
                <td style={{ ...td, maxWidth: 240 }}><div style={{ fontWeight: 600, color: C.txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name || '—'}{chg('name') && <span title={'vorher: ' + (r.name || '—')} style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: C.pri, background: hexA(C.pri, 0.14), borderRadius: 6, padding: '1px 5px' }}>KI</span>}{nameCount[nkey(r)] > 1 && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: C.sub, background: C.surf3, borderRadius: 6, padding: '1px 6px' }}>×{nameCount[nkey(r)]}</span>}</div>{e.beschreibung && e.beschreibung !== e.name && <div title={chg('beschreibung') ? 'vorher: ' + (r.beschreibung || '—') : undefined} style={{ fontSize: 11.5, color: chg('beschreibung') ? C.pri : C.mut, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{e.beschreibung}</div>}</td>
                <td style={{ ...td, ...NUM, whiteSpace: 'nowrap' }}>{e.nummer || '—'}{chg('nummer') && <span title="von der KI aus dem PDF ergänzt" style={{ marginLeft: 4, fontSize: 10, fontWeight: 800, color: C.pri }}>KI</span>}</td>
                <td style={td}>{e.kategorie ? <span title={chg('kategorie') ? 'vorher: ' + (r.kategorie || '—') : undefined} style={{ color: chg('kategorie') ? C.pri : C.txt, fontWeight: chg('kategorie') ? 700 : 400 }}>{e.kategorie}{chg('kategorie') ? ' ·KI' : ''}</span> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, ...NUM, textAlign: 'right', whiteSpace: 'nowrap', color: r.kind === 'ein' ? C.grn : C.txt, fontWeight: 600 }}>{r.kind === 'ein' ? '+' : '−'}{fmt(r.brutto)}</td>
                <td style={{ ...td, ...NUM, color: chg('mwst') ? C.pri : undefined, fontWeight: chg('mwst') ? 700 : undefined }} title={chg('mwst') ? 'vorher: ' + r.mwst + ' %' : undefined}>{e.mwst} %</td>
                {withAcct && (() => { const s = aiOf(r); const manual = !!rowAcct[k + r.idx]; const unsure = s && !s.sure && !manual; return <td style={td}><select value={acctOf(k, r)} onChange={e => assign(r, e.target.value)} style={{ ...SS, fontSize: 12, padding: '4px 6px', width: 150, border: '1px solid ' + (unsure ? C.amb : 'transparent') }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select>{s && <div title={s.why} style={{ fontSize: 11, marginTop: 3, color: manual ? C.mut : unsure ? C.amb : C.sub, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{manual ? 'von dir gewählt' : (unsure ? '? ' : 'KI: ') + (s.why || '')}</div>}</td>; })()}
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.file ? <><button onClick={() => openTab(r)} title={'Beleg in neuem Tab öffnen: ' + r.file} style={{ background: C.surf3, border: '1px solid ' + C.bdr, color: C.txt, borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Ansehen ↗</button> <button onClick={() => openView(rows.indexOf(r))} title="Beleg neben Konto und Notiz prüfen (blättern)" style={{ background: 'none', border: '1px solid ' + C.bdr, color: C.sub, borderRadius: 8, padding: '3px 7px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>⇆</button></> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, textAlign: 'center' }}>{r.file ? <input type="checkbox" checked={kiAll || !!kiRows[k + r.idx]} disabled={kiAll || off} onChange={e => setKiRows(p => ({ ...p, [k + r.idx]: e.target.checked }))} title="KI soll dieses PDF beim Import lesen" /> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, minWidth: big ? 280 : 170 }}><input value={(notes && notes[k + r.idx]) || ''} onChange={e => setNotes(n => ({ ...n, [k + r.idx]: e.target.value }))} onBlur={e => askNote(r, e.target.value)} placeholder="z. B. Material Wohnung 2" disabled={off} style={{ ...SS, width: '100%', fontSize: 12, padding: '5px 8px', textAlign: 'left', boxSizing: 'border-box' }} /></td>
                <td style={{ ...td, fontSize: 12, color: r.dup ? C.amb : (r.cancelled ? C.mut : C.exp) }}>{r.dup ? 'schon vorhanden' : r.cancelled ? 'storniert/Entwurf' : r.warn.join(', ')}{odiff.length > 0 && <div style={{ color: C.amb, fontWeight: 700 }}>{odiff.join(' · ')}</div>}{o && !o.error && (e !== r || odiff.length > 0) && <button onClick={() => setOcrOff(p => ({ ...p, [k + r.idx]: !p[k + r.idx] }))} style={{ marginTop: 3, background: 'none', border: 'none', color: C.mut, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}>{ocrOff[k + r.idx] ? 'KI-Korrektur wieder an' : 'KI-Korrektur aus'}</button>}{o && o.error && <div style={{ color: C.red }}>KI: {o.error}</div>}</td>
              </tr>
            ); })}
          </tbody>
        </table>
        {!big && X.rows.filter(r => r.inYear).length > 300 && <div style={{ fontSize: 12, color: C.mut, padding: 8 }}>… nur die ersten 300 Zeilen werden angezeigt (mit „Vergrößern" siehst du alle), importiert werden alle.</div>}
      </div>
      {noteAsk && (
        <div onClick={() => setNoteAsk(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 175, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surf, border: '1px solid ' + C.bdr, borderRadius: 18, padding: '20px 22px', maxWidth: 440, width: '100%', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.txt, marginBottom: 6 }}>Notiz für alle gleichen Namen?</div>
            <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.55, marginBottom: 16 }}>„{String(noteAsk.r.name || '').slice(0, 50)}" kommt {noteAsk.count}× vor. Soll die Notiz <b style={{ color: C.txt }}>„{noteAsk.val.slice(0, 80)}"</b> für alle {noteAsk.count} Zeilen gelten oder nur für diese eine?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => applyNoteAsk(true)} style={{ background: C.act, color: C.actTxt, border: 'none', borderRadius: 11, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Für alle {noteAsk.count} Zeilen übernehmen</button>
              <button onClick={() => applyNoteAsk(false)} style={{ background: C.surf2, color: C.txt, border: '1px solid ' + C.bdr, borderRadius: 11, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Nur diese Zeile</button>
            </div>
          </div>
        </div>
      )}
      {ask && (
        <div onClick={() => setAsk(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 170, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surf, border: '1px solid ' + C.bdr, borderRadius: 18, padding: '20px 22px', maxWidth: 440, width: '100%', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.txt, marginBottom: 6 }}>Konto für mehrere Zeilen ändern?</div>
            <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.55, marginBottom: 16 }}>„{String(ask.r.name || '').slice(0, 50)}" kommt {ask.count}× vor. Soll das Konto <b style={{ color: C.txt }}>{(accounts.find(a => a.key === ask.val) || {}).label || ask.val}</b> für alle {ask.count} Zeilen gelten oder nur für diese eine?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => applyAsk(true)} style={{ background: C.act, color: C.actTxt, border: 'none', borderRadius: 11, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Alle {ask.count} Zeilen ändern</button>
              <button onClick={() => applyAsk(false)} style={{ background: C.surf2, color: C.txt, border: '1px solid ' + C.bdr, borderRadius: 11, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Nur diese Zeile</button>
              <button onClick={() => setAsk(null)} style={{ background: 'none', color: C.sub, border: 'none', padding: '8px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Abbrechen</button>
            </div>
          </div>
        </div>)}
      {view != null && rows[view] && (() => { const r = rows[view]; const money = fmt(r.brutto); return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 160, background: 'rgba(8,8,10,0.92)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: C.surf, borderBottom: '1px solid ' + C.bdr, flexWrap: 'wrap' }}>
            <button onClick={() => view > 0 && openView(view - 1)} disabled={view === 0} style={{ background: C.surf2, border: '1px solid ' + C.bdr, color: C.txt, borderRadius: 9, padding: '7px 12px', cursor: view === 0 ? 'default' : 'pointer', opacity: view === 0 ? 0.4 : 1, fontFamily: 'inherit', fontWeight: 700 }}>‹ Zurück</button>
            <button onClick={() => view < rows.length - 1 && openView(view + 1)} disabled={view >= rows.length - 1} style={{ background: C.surf2, border: '1px solid ' + C.bdr, color: C.txt, borderRadius: 9, padding: '7px 12px', cursor: view >= rows.length - 1 ? 'default' : 'pointer', opacity: view >= rows.length - 1 ? 0.4 : 1, fontFamily: 'inherit', fontWeight: 700 }}>Weiter ›</button>
            <div style={{ flex: 1, minWidth: 200 }}><div style={{ fontSize: 15, fontWeight: 800, color: C.txt }}>{r.name || '—'} · {money}</div><div style={{ fontSize: 12, color: C.sub }}>{r.datum ? r.datum.split('-').reverse().join('.') : '—'}{r.nummer ? ' · Nr. ' + r.nummer : ''}{r.kategorie ? ' · ' + r.kategorie : ''} · {r.mwst} % MwSt · Zeile {view + 1} von {rows.length}</div></div>
            {withAcct && <select value={acctOf(k, r)} onChange={e => assign(r, e.target.value)} style={{ ...SS, width: 'auto', fontSize: 13 }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select>}
            <input value={(notes && notes[k + r.idx]) || ''} onChange={e => setNotes(n => ({ ...n, [k + r.idx]: e.target.value }))} onBlur={e => askNote(r, e.target.value)} placeholder="Notiz für den Steuerberater" style={{ ...SS, width: 260, fontSize: 13, textAlign: 'left' }} />
            <button onClick={closeView} style={{ background: C.txt, color: C.bg, border: 'none', borderRadius: 9, padding: '8px 14px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Schließen</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
            {pv && pv.loading && <div style={{ color: '#fff' }}>Beleg wird geladen…</div>}
            {pv && pv.missing && <div style={{ color: '#fff' }}>Datei nicht gefunden.</div>}
            {pv && pv.url && (pv.isPdf ? <iframe title="Beleg" src={pv.url} style={{ width: '100%', height: '100%', border: 'none', background: '#fff', borderRadius: 10 }} /> : <img alt="Beleg" src={pv.url} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10 }} />)}
          </div>
        </div>); })()}
      </div>
    );
}
