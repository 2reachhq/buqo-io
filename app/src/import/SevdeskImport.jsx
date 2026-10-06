// Buqo – Umzug aus sevDesk: CSV-Belege + ZIP-PDFs, CSV-Rechnungen + ZIP-PDFs oder DATEV-Buchungsstapel.
// Alles wird lokal gelesen und in einer Vorschau gezeigt; erst „Jetzt importieren" schreibt Buchungen,
// Rechnungen, Kunden und lädt die PDFs in den Beleg-Speicher (übernimmt die App über onImport).
import React from 'react';
import { decodeText, parseCSV, autoMap, detectFormat, FORMAT_LABEL, normalizeRows, matchFiles, markDuplicates, summarize, detectRecurring, bankRowsFromCsv, mapCategory, CATS } from './sevdesk.js';
import { readZipEntries, baseName } from './zip.js';
import { parseDatev } from './datevCompare.js';
import { matchBank, matchDatev } from './reconcile.js';
import { groupContext, parseBotJson, matchFilter, normalizeActions } from './importBot.js';

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
  const { ui, accounts, existing, defaultYear, onImport, isMobile, aiClassify, aiReadDoc, aiBankRows, aiAsk, onRemember } = props;
  const { C, SC, SS, NUM, fmt, Ic, P, hexA, AI_GRADIENT, MONTHS } = ui;
  const [step, setStep] = useState(1);              // 1 Hochladen · 2 Abgleich · 3 Wiederkehrendes + Verbuchen
  const [belege, setBelege] = useState(null);      // {fileName, parsed, format, mapping, kind}
  const [rech, setRech] = useState(null);
  const [zipB, setZipB] = useState(null);          // {fileName, files, entries}
  const [zipR, setZipR] = useState(null);
  const [year, setYear] = useState(defaultYear ? String(defaultYear) : 'alle');
  const [yearChosen, setYearChosen] = useState(false);   // Jahr wurde nach dem CSV-Upload bewusst gewählt
  const [yearAsk, setYearAsk] = useState(false);
  const [acct, setAcct] = useState((accounts[0] || {}).key || 'unter');
  const [rowAcct, setRowAcct] = useState({});
  const [skip, setSkip] = useState({});
  const [notes, setNotes] = useState({});           // Notiz je Zeile (für den KI-Steuerberater), Schlüssel k+idx
  const [confirmed, setConfirmed] = useState(false);  // false: Belege/Rechnungen bleiben offen, bis der Kontoauszug sie abgleicht
  const [bank, setBank] = useState([]);           // Kontoauszüge: [{file, name, kind:'csv'|'datei', rows?}]
  const [datev, setDatev] = useState([]);         // DATEV-Dateien (Steuerberater), mehrere möglich: [{file, name}]
  const [datevRows, setDatevRows] = useState([]);
  const [extra, setExtra] = useState([]);         // weitere Unterlagen/Infos für die KI (landen in den Steuerunterlagen): [{file, name}]
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
  const [ocr, setOcr] = useState({});               // KI-Lesung der PDFs: {b12|r3: {name, datum, nummer, brutto, netto, mwst, kategorie, beschreibung, storno, urteil} | {error}}
  const [ocrOff, setOcrOff] = useState({});         // Zeilen, bei denen die KI-Änderungen abgeschaltet sind
  const [kiRows, setKiRows] = useState({});         // Zeilen, deren PDF die KI lesen soll (k+idx)
  const [kiAll, setKiAll] = useState(false);        // alle PDFs von der KI lesen lassen
  const [ovr, setOvr] = useState({});             // Änderungen aus der Liste: {k+idx: {name, kategorie, mwst}}
  const [sel, setSel] = useState({});             // ausgewählte Zeilen für Sammelaktionen (zu Beginn ist nichts ausgewählt, importiert wird trotzdem alles)
  const [view, setView] = useState('liste');       // Abgleich: liste | tabelle
  const [openRow, setOpenRow] = useState(null);     // aufgeklappte Zeile (Felder ändern)
  const [listLimit, setListLimit] = useState(120);
  const [listQ, setListQ] = useState('');
  const [bulkNote, setBulkNote] = useState('');
  const [botMsgs, setBotMsgs] = useState([]);       // KI-Helfer für die Liste: [{role:'user'|'ai', text}]
  const [botInput, setBotInput] = useState('');
  const [botBusy, setBotBusy] = useState(false);
  const [botPending, setBotPending] = useState(null);   // vorgeschlagene Aktionen, werden erst nach „Anwenden" ausgeführt
  const [later, setLater] = useState({});           // „Für später": wird gebucht, dazu entsteht ein To-do (k+idx)
  const [datevAct, setDatevAct] = useState({});     // DATEV-Zeilen ohne Gegenstück: 'later' | 'ignore'
  const [upPdf, setUpPdf] = useState({});           // im Abgleich nachgeladene PDFs: {k+idx: {name, data}}
  const [filt, setFilt] = useState('alle');         // Abgleich-Filter: alle | ausgaben | einnahmen | passt | hinweis | fehlt
  const [analysing, setAnalysing] = useState(false);
  const [anaProg, setAnaProg] = useState('');
  const [anaTotal, setAnaTotal] = useState(0);        // Arbeitsschritte im Abgleich (Kontoauszüge, DATEV, PDFs) für die Prozentanzeige
  const [anaDone, setAnaDone] = useState(0);
  const [confirmRun, setConfirmRun] = useState(false);   // Rückfrage vor dem Verbuchen
  const [importMsg, setImportMsg] = useState('');     // Hinweis nach dem Laden eines Buqo-Exports
  const restored = React.useRef(false);
  const bankCacheRef = React.useRef({});          // bereits gelesene Kontoauszug-PDFs (Name|Größe → Umsätze), damit die KI sie nicht erneut lesen muss
  const [draftInfo, setDraftInfo] = useState(null); // {savedAt} – Zwischenstand vorhanden
  const [hint, setHint] = useState('');         // Hinweise für die KI, z. B. „Mieter Müller = Sylt"
  const [onlyUnsure, setOnlyUnsure] = useState(false);

  const readCsv = async (file, kind, setter) => {
    try { const buf = await file.arrayBuffer(); const parsed = parseCSV(decodeText(new Uint8Array(buf))); if (!parsed.header.length || !parsed.rows.length) throw new Error('Die Datei enthält keine Tabelle.'); const format = detectFormat(parsed); setter({ fileName: file.name, file, parsed, format, mapping: autoMap(parsed.header), kind: format === 'datev' ? 'auto' : kind }); setResult(null); setErr('');
      // Eigener Buqo-Export (Tabelle als CSV geladen)? Dann Konto, Notiz, KI-Haken und Überspringen wiederherstellen.
      const hs = parsed.header.map(normN); const ix = (n) => hs.indexOf(normN(n)); const cK = ix('Buqo-Konto'), cN = ix('Buqo-Notiz'), cI = ix('Buqo-KI'), cS = ix('Buqo-Überspringen');
      if (cK >= 0 || cN >= 0 || cI >= 0 || cS >= 0) {
        const pk = kind === 'ein' ? 'r' : 'b'; const a = {}, n = {}, ki = {}, sk = {};
        const byLabel = {}; accounts.forEach(x => { byLabel[normN(x.label)] = x.key; byLabel[normN(x.key)] = x.key; });
        parsed.rows.forEach((row, i) => {
          const kk = cK >= 0 ? byLabel[normN(row[cK])] : null; if (kk) a[pk + i] = kk;
          if (cN >= 0 && String(row[cN] || '').trim()) n[pk + i] = String(row[cN]).trim();
          if (cI >= 0 && /^(ja|1|true|x)$/i.test(String(row[cI] || '').trim())) ki[pk + i] = true;
          if (cS >= 0 && /^(ja|1|true|x)$/i.test(String(row[cS] || '').trim())) sk[pk + i] = true;
        });
        setRowAcct(p => ({ ...p, ...a })); setNotes(p => ({ ...p, ...n })); setKiRows(p => ({ ...p, ...ki })); setSkip(p => ({ ...p, ...sk }));
        setImportMsg('Buqo-Export erkannt: ' + Object.keys(a).length + ' Konto-Zuordnungen, ' + Object.keys(n).length + ' Notizen, ' + Object.keys(ki).length + ' KI-Haken und ' + Object.keys(sk).length + ' übersprungene Zeilen wiederhergestellt.');
      } }
    catch (e) { setErr('CSV konnte nicht gelesen werden: ' + (e.message || e)); }
  };
  // ZIP-Dateien und einzelne PDFs/Fotos (mehrere auf einmal, auch nachträglich dazu) zu einer Belegliste zusammenfassen
  const readDocs = async (files, setter, cur) => {
    const entries = cur ? [...cur.entries] : [], fl = cur ? [...cur.files] : [];
    for (const f of files) {
      try {
        if (/\.zip$/i.test(f.name) || f.type === 'application/zip') { entries.push(...readZipEntries(await f.arrayBuffer()).filter(e => isDoc(e.name))); fl.push(f); }
        else if (isDoc(f.name)) { entries.push({ name: f.name, data: async () => new Uint8Array(await f.arrayBuffer()) }); fl.push(f); }
      } catch (e) { setErr('„' + f.name + '" konnte nicht gelesen werden: ' + (e.message || e)); }
    }
    if (!entries.length) { setErr('Keine PDF/Bild-Dateien gefunden.'); return; }
    setter({ fileName: fl.length === 1 ? fl[0].name : fl.length + ' Dateien', files: fl, entries }); setResult(null); setErr('');
  };

  const addBank = async (files) => {
    const list = [];
    for (const f of files) {
      try {
        if (/\.(csv|txt)$/i.test(f.name) || /csv|text/.test(f.type || '')) { const parsed = parseCSV(decodeText(new Uint8Array(await f.arrayBuffer()))); const rows = bankRowsFromCsv(parsed, autoMap(parsed.header)); if (!rows.length) throw new Error('Keine Umsätze erkannt (Spalten Datum/Betrag fehlen?)'); list.push({ file: f, name: f.name, kind: 'csv', rows }); }
        else list.push({ file: f, name: f.name, kind: 'datei', rows: bankCacheRef.current[f.name + '|' + f.size] });
      } catch (e) { setErr('Kontoauszug „' + f.name + '": ' + (e.message || e)); }
    }
    if (list.length) { setBank(b => [...b, ...list]); setResult(null); }
  };
  // Wirksame Zeile: Original + KI-Korrekturen (Name, Kategorie, Beschreibung, Nummer wenn leer, MwSt nur wenn der Brutto-Betrag im PDF übereinstimmt).
  // Betrag und Datum werden NIE automatisch geändert – Abweichungen erscheinen nur als Hinweis.
  const eff = (k, r) => {
    const key = k + r.idx; const o = ocr[key]; let out = r;
    if (o && !o.error && !ocrOff[key]) {
      out = { ...r };
      if (o.name && normN(o.name) !== normN(r.name)) out.name = String(o.name).slice(0, 90);
      if (o.kategorie && CATS.includes(o.kategorie) && r.kind === 'aus') out.kategorie = o.kategorie;
      if (o.beschreibung) out.beschreibung = String(o.beschreibung).slice(0, 120);
      if (o.nummer && !r.nummer) out.nummer = String(o.nummer).slice(0, 40);
      if ([0, 7, 19].includes(o.mwst) && o.brutto != null && Math.abs(o.brutto - r.brutto) < 0.02 && o.mwst !== r.mwst) { out.mwst = o.mwst; out.netto = Math.round(r.brutto / (1 + o.mwst / 100) * 100) / 100; }
    }
    const v = ovr[key]; // Eingaben des Nutzers (Liste, Sammelaktionen, KI-Helfer) haben Vorrang vor der PDF-Lesung
    if (v) {
      out = { ...out };
      if (v.name) out.name = v.name;
      if (v.kategorie) out.kategorie = v.kategorie;
      if (v.mwst != null) { out.mwst = v.mwst; out.netto = Math.round(out.brutto / (1 + v.mwst / 100) * 100) / 100; }
    }
    return out;
  };
  const ocrDiff = (k, r) => { const o = ocr[k + r.idx]; if (!o || o.error) return []; const w = []; if (o.brutto != null && Math.abs(o.brutto - r.brutto) > 0.02) w.push('PDF: Betrag ' + fmt(o.brutto)); if (o.datum && r.datum && o.datum !== r.datum) w.push('PDF: Datum ' + o.datum.split('-').reverse().join('.')); return w; };

  // ── Zwischenspeicher: beim Öffnen wiederherstellen, bei Änderungen speichern ──
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const f = await idbGet('files'); const s = await idbGet('state'); if (!alive) return;
        const map = (s && s.mappings) || {}; bankCacheRef.current = (s && s.state && s.state.bankCache) || {};
        const arr = (v) => v ? (Array.isArray(v) ? v : [v]) : [];
        if (f) {
          if (f.belege) await readCsv(f.belege.file, f.belege.kind, o => setBelege(map.belege ? { ...o, mapping: map.belege } : o));
          if (f.rech) await readCsv(f.rech.file, f.rech.kind, o => setRech(map.rech ? { ...o, mapping: map.rech } : o));
          if (arr(f.zipB).length) await readDocs(arr(f.zipB), setZipB, null);
          if (arr(f.zipR).length) await readDocs(arr(f.zipR), setZipR, null);
          if (f.bank && f.bank.length) await addBank(f.bank.map(x => x.file));
          if (f.datev && f.datev.length) setDatev(f.datev.map(x => ({ file: x.file, name: x.file.name })));
          if (f.extra && f.extra.length) setExtra(f.extra.map(x => ({ file: x.file, name: x.file.name })));
        }
        if (s && s.state) { const st = s.state; setYear(st.year); setYearChosen(st.yearChosen !== false); setAcct(st.acct); setRowAcct(st.rowAcct || {}); setSkip(st.skip || {}); setNotes(st.notes || {}); setRecurOff(st.recurOff || {}); setMinCust(st.minCust || 2); setAi(st.ai || {}); setKiRows(st.kiRows || {}); setKiAll(!!st.kiAll); setHint(st.hint || ''); setOcr(st.ocr || {}); setLater(st.later || {}); setDatevAct(st.datevAct || {}); setOvr(st.ovr || {}); setDraftInfo({ savedAt: s.savedAt }); }
      } catch (e) { /* kein Zwischenspeicher (z. B. privater Modus) */ }
      restored.current = true;
    })();
    return () => { alive = false; };
  }, []);
  const anyFile = () => belege || rech || zipB || zipR || bank.length || datev.length || extra.length;
  React.useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      if (!anyFile()) { idbDel('files').catch(() => {}); idbDel('state').catch(() => {}); setDraftInfo(null); return; }
      idbSet('files', { belege: belege && { file: belege.file, kind: belege.kind }, rech: rech && { file: rech.file, kind: rech.kind }, zipB: zipB && zipB.files, zipR: zipR && zipR.files, bank: bank.map(b => ({ file: b.file })), datev: datev.map(d => ({ file: d.file })), extra: extra.map(d => ({ file: d.file })) }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [belege && belege.file, rech && rech.file, zipB && zipB.files, zipR && zipR.files, bank, datev, extra]);
  React.useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      if (!anyFile()) return;
      const savedAt = Date.now();
      idbSet('state', { savedAt, mappings: { belege: belege && belege.mapping, rech: rech && rech.mapping }, state: { year, yearChosen, acct, rowAcct, skip, notes, confirmed, recurOff, minCust, ai, kiRows, kiAll, hint, ocr, later, datevAct, ovr, bankCache: Object.fromEntries(bank.filter(b => b.kind === 'datei' && b.rows && b.rows.length).map(b => [b.name + '|' + b.file.size, b.rows])) } }).then(() => setDraftInfo({ savedAt })).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [year, yearChosen, acct, rowAcct, skip, notes, confirmed, recurOff, minCust, ai, kiRows, kiAll, hint, ocr, later, datevAct, ovr, bank, belege && belege.mapping, rech && rech.mapping]);
  const discardDraft = () => { idbDel('files').catch(() => {}); idbDel('state').catch(() => {}); setBelege(null); setRech(null); setZipB(null); setZipR(null); setBank([]); setDatev([]); setDatevRows([]); setExtra([]); setRowAcct({}); setSkip({}); setNotes({}); setAi({}); setOcr({}); setOcrOff({}); setRecurOff({}); setLater({}); setDatevAct({}); setUpPdf({}); setOvr({}); setSel({}); setYearChosen(false); setStep(1); setDraftInfo(null); setResult(null); };
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
  const yearsSeen = useMemo(() => { const s = new Set(); [B, R].forEach(x => x && x.rows.forEach(r => r.y && s.add(r.y))); bank.forEach(b => (b.rows || []).forEach(r => r.datum && s.add(+String(r.datum).slice(0, 4)))); if (!s.size) { const y = new Date().getFullYear(); s.add(y - 1); s.add(y); } return [...s].sort(); }, [B, R, bank]);
  const yearCounts = useMemo(() => { const c = {}; [B, R].forEach(x => x && x.rows.forEach(r => { if (r.y && !r.cancelled) c[r.y] = (c[r.y] || 0) + 1; })); return c; }, [B, R]);
  // Nach dem Laden der ersten CSV wird gefragt, welches Jahr importiert werden soll (nur dieses Jahr wird geladen)
  React.useEffect(() => { if (restored.current && !yearChosen && (belege || rech || bank.length)) setYearAsk(true); }, [belege, rech, bank.length, yearChosen]);

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
  const csvGo = [...belegeGo.map(r => ({ r, k: 'b' })), ...rechGo.map(r => ({ r, k: 'r' }))];
  const fileFor = (zip, name, key) => { if (upPdf[key]) return { name: upPdf[key].name, data: upPdf[key].data }; if (!zip || !name) return null; const e = zip.entries.find(x => x.name === name); return e ? { name: baseName(e.name), data: e.data } : null; };

  // ── Abgleich: Hinweise, Kontoauszug, DATEV ──
  const NOTE_RE = /anschau|prüf|pruef|nochmal|nochmals|kontrollier|checken|klären|klaeren|\?/i;
  // Doppelung = gleicher Name + Betrag innerhalb von 5 Tagen. Raten/Leasing (monatlich gleicher Betrag) zählen nicht.
  const dupFlag = useMemo(() => {
    const flag = {}; const groups = new Map();
    csvGo.forEach(({ r, k }) => { if (r.storno) return; const key = k + '|' + normN(r.name) + '|' + Math.round(r.brutto * 100); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ r, k }); });
    groups.forEach(list => { if (list.length < 2) return; list.forEach(a => { const near = list.some(b => b !== a && Math.abs(new Date(a.r.datum) - new Date(b.r.datum)) <= 5 * 864e5); if (near) flag[a.k + a.r.idx] = true; }); });
    return flag;
  }, [belege, rech, year, skip]); // eslint-disable-line
  const inY = (r) => year === 'alle' || String(r.datum || '').slice(0, 4) === year;
  const bankRowsY = useMemo(() => bank.flatMap(b => b.rows || []).filter(inY), [bank, year]); // eslint-disable-line
  const datevRowsY = useMemo(() => datevRows.filter(inY), [datevRows, year]); // eslint-disable-line
  const signed = (r) => (r.storno ? -r.brutto : r.brutto);
  const bankMatch = useMemo(() => bankRowsY.length ? matchBank(csvGo.map(({ r, k }) => ({ key: k + r.idx, kind: r.storno ? (r.kind === 'ein' ? 'aus' : 'ein') : r.kind, datum: r.datum, brutto: r.brutto, name: r.name })), bankRowsY) : null, [B, R, skip, year, bankRowsY]); // eslint-disable-line
  // Kontoauszug = Hauptquelle: Umsätze ohne Gegenstück in der CSV werden als eigene Buchung angelegt (CSV und PDFs sind nur Hilfe)
  const xRows = useMemo(() => {
    if (!bankRowsY.length) return [];
    const used = bankMatch ? bankMatch.used : new Set();
    const recs = bankRowsY.map((b, i) => ({ b, i })).filter(({ b, i }) => !used.has(i) && b.datum && Math.abs(+b.amount) > 0).map(({ b, i }) => {
      const brutto = Math.round(Math.abs(+b.amount) * 100) / 100; const aus = b.kind !== 'ein';
      return { idx: i, kind: aus ? 'aus' : 'ein', datum: b.datum, y: +b.datum.slice(0, 4), m: +b.datum.slice(5, 7) - 1, nummer: b.belegnr || '', name: String(b.name || 'Umsatz').slice(0, 90), beschreibung: b.note || '', brutto, netto: brutto, mwst: 0, kategorie: aus ? (mapCategory(b.category || '', '') || mapCategory(b.note || '') || mapCategory(b.name || '') || 'Allgemein') : 'Allgemein', status: 'bezahlt', cancelled: false, dup: false, storno: false, file: null, inYear: true, bankOnly: true, warn: [], faellig: '', zahldatum: b.datum };
    });
    return markDuplicates(recs, existing && existing.belege).filter(r => !r.dup);
  }, [bankRowsY, bankMatch, existing]); // eslint-disable-line
  const xGo = xRows.filter(r => !skip['x' + r.idx]);
  const allGo = [...csvGo, ...xGo.map(r => ({ r, k: 'x' }))];
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
  const dMatch = useMemo(() => datevRowsY.length ? matchDatev(allGo.map(({ r, k }) => ({ key: k + r.idx, y: r.y, m: r.m, kind: r.kind, name: r.name, amount: signed(r), datum: r.datum, nummer: r.nummer, category: r.kategorie, mwst: r.mwst })), datevRowsY) : null, [B, R, skip, year, datevRowsY]); // eslint-disable-line
  // Status je Zeile: passt / hinweis / fehlt, dazu die Kurz-Hinweise
  const statusOf = (k, r) => {
    const key = k + r.idx; const chips = []; let miss = false, hintF = false; const o = ocr[key];
    if (!(r.file || upPdf[key])) { chips.push({ t: 'PDF fehlt', c: 'miss' }); miss = true; }
    if (r.bankOnly) { chips.push({ t: 'Nur im Kontoauszug', c: 'ai' }); if (!(ovr[key] && ovr[key].mwst != null)) { chips.push({ t: 'MwSt prüfen', c: 'warn' }); hintF = true; } }
    if (bankMatch && !r.bankOnly) { if (bankMatch.has(key)) chips.push({ t: 'Kontoauszug ✓', c: 'ok' }); else if (r.kind === 'aus' && !r.storno) { chips.push({ t: 'nicht im Kontoauszug', c: 'miss' }); miss = true; } }
    if (dMatch) { const d = dMatch.byKey.get(key); if (d) { if (d.state === 'ok') chips.push({ t: 'DATEV ✓', c: 'ok' }); else if (d.state === 'abw') { chips.push({ t: 'DATEV: ' + d.why.join('; '), c: 'warn' }); hintF = true; } else { chips.push({ t: 'fehlt in DATEV', c: 'miss' }); miss = true; } } }
    if (r.storno) { chips.push({ t: 'Storno/Gutschrift (negativ)', c: 'warn' }); hintF = true; }
    if (dupFlag[key] && !(o && o.storno)) { chips.push({ t: 'Doppelung?', c: 'warn' }); hintF = true; }
    if (o && o.error) chips.push({ t: 'KI: ' + o.error, c: 'miss' });
    if (o && !o.error) { ocrDiff(k, r).forEach(t => { chips.push({ t, c: 'warn' }); hintF = true; }); if (o.storno && !r.storno) chips.push({ t: 'PDF ist Storno/Gutschrift', c: 'warn' }); if (o.urteil) chips.push({ t: '🤖 ' + o.urteil, c: 'ai' }); }
    if (NOTE_RE.test(String(notes[key] || ''))) { chips.push({ t: 'Notiz: ' + String(notes[key]).slice(0, 50), c: 'warn' }); hintF = true; }
    return { cls: miss ? 'fehlt' : hintF ? 'hinweis' : 'passt', chips };
  };
  const stats = useMemo(() => { const c = { passt: 0, hinweis: 0, fehlt: 0, ausg: 0, einn: 0 }; allGo.forEach(({ r, k }) => { c[statusOf(k, r).cls]++; if (r.kind === 'ein') c.einn++; else c.ausg++; }); return c; }, [B, R, skip, year, bankMatch, dMatch, ocr, upPdf, notes]); // eslint-disable-line

  // KI liest PDFs (zugeordnete PDFs der gewählten Zeilen), 3 gleichzeitig
  const runOcr = async (targets) => {
    if (!aiReadDoc) return;
    const todo = targets.filter(([k, r, z]) => r.file && z && !ocr[k + r.idx]); if (!todo.length) return;
    let done = 0, i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const [k, r, z] = todo[i++];
        try { const e = z.entries.find(x => x.name === r.file); if (!e) throw new Error('Datei fehlt'); const bytes = await e.data(); const res = await withRetry(() => aiReadDoc(bytes, r.file, { kind: r.kind, name: r.name, brutto: r.brutto })); setOcr(p => ({ ...p, [k + r.idx]: res })); }
        catch (e) { setOcr(p => ({ ...p, [k + r.idx]: { error: String(e.message || e).slice(0, 80) } })); }
        done++; setAnaDone(d => d + 1); setAnaProg('KI liest PDFs … ' + done + ' / ' + todo.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  };
  // Aufrufe der KI-Funktion bei kurzen Netzwerkfehlern bis zu zweimal wiederholen
  const withRetry = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 2 || !/Failed to send|fetch|network|timeout|timed out|50[234]/i.test(String((e && e.message) || e))) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
  const kiTargets = (only) => [...belegeGo.map(r => ['b', r, zipB]), ...rechGo.map(r => ['r', r, zipR])].filter(([k, r]) => only ? (kiAll || kiRows[k + r.idx]) : (kiAll || kiRows[k + r.idx] || dupFlag[k + r.idx] || NOTE_RE.test(String(notes[k + r.idx] || ''))));
  // „Abgleich starten": Kontoauszüge (PDF/Foto) und DATEV-Dateien lesen, markierte/auffällige PDFs von der KI prüfen lassen – gebucht wird noch nichts
  const analyze = async () => {
    if (analysing || (!belegeGo.length && !rechGo.length && !bank.length)) return;
    setAnalysing(true); setErr('');
    try {
      const kiTodo = kiTargets(false).filter(([k, r]) => r.file && !ocr[k + r.idx]).length; const toRead = bank.filter(b => !b.rows).length;
      setAnaTotal((aiBankRows ? toRead : 0) + datev.length + (aiReadDoc ? kiTodo : 0)); setAnaDone(0);
      // Kontoauszüge (PDF/Foto): 3 gleichzeitig, mit Wiederholung bei Netzwerkfehlern
      const nb = [...bank]; const idxs = nb.map((b, i) => i).filter(i => !nb[i].rows && aiBankRows); let n = 0, q = 0;
      const bw = async () => { while (q < idxs.length) { const i = idxs[q++]; try { nb[i] = { ...nb[i], rows: await withRetry(() => aiBankRows(nb[i].file)) }; } catch (e) { nb[i] = { ...nb[i], rows: [], err: String(e.message || e) }; setErr(x => (x ? x + '\n' : '') + 'Kontoauszug „' + nb[i].name + '" konnte nicht gelesen werden: ' + (e.message || e) + ' – bitte später nochmal versuchen.'); } n++; setAnaDone(d => d + 1); setAnaProg('Kontoauszüge gelesen: ' + n + ' / ' + idxs.length); } };
      await Promise.all([bw(), bw(), bw()]);
      setBank(nb);
      const dr = [];
      for (const d of datev) { setAnaProg('DATEV lesen: ' + d.name); try { dr.push(...parseDatev(await d.file.arrayBuffer())); } catch (e) { setErr(x => (x ? x + '\n' : '') + 'DATEV „' + d.name + '": ' + (e.message || e)); } setAnaDone(x => x + 1); }
      setDatevRows(dr);
      await runOcr(kiTargets(false));
      setStep(2);
    } catch (e) { setErr('Abgleich fehlgeschlagen: ' + (e.message || e)); }
    setAnalysing(false); setAnaProg(''); setAnaTotal(0); setAnaDone(0);
  };
  const kiOpen = kiTargets(true).filter(([k, r]) => r.file && !ocr[k + r.idx]).length;
  const readMarked = async () => { if (analysing) return; setAnalysing(true); setAnaTotal(kiOpen); setAnaDone(0); try { await runOcr(kiTargets(true)); } catch (e) { setErr(String(e.message || e)); } setAnalysing(false); setAnaProg(''); setAnaTotal(0); setAnaDone(0); };
  const run = async () => {
    if (busy || (!belegeGo.length && !rechGo.length && !xGo.length)) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const todos = [];
      allGo.forEach(({ r, k }) => { if (later[k + r.idx]) todos.push({ rowKey: k + r.idx, title: 'Prüfen: ' + (eff(k, r).name || 'Posten') + ' · ' + fmt(r.brutto), note: statusOf(k, r).chips.map(c => c.t).join('\n') }); });
      (dMatch ? dMatch.onlyDatev : []).forEach((d, i) => { if (datevAct['d' + i] === 'later') todos.push({ title: 'In DATEV, aber nicht im Import: ' + (d.name || 'Posten') + ' · ' + fmt(d.brutto), note: (d.datum || '') + (d.nummer ? ' · ' + d.nummer : '') }); });
      const payload = {
        confirmed, minCust, year, todos,
        bank: bank.map(b => ({ file: b.file, name: b.name, kind: b.kind, rows: b.rows || null })),
        extraDocs: extra.map(x => x.file),
        belege: [...xGo.map(r0 => { const r = eff('x', r0); return { ...r, rowKey: 'x' + r.idx, taxNote: (notes['x' + r.idx] || '').trim(), dest: acctOf('x', r), file: fileFor(null, null, 'x' + r.idx), recur: null }; }), ...belegeGo.map(r0 => { const r = eff('b', r0); const g = recurActive(recurB, belegeGo, 'b').find(x => x.idxs.includes(r.idx)); return { ...r, rowKey: 'b' + r.idx, status: (bankMatch && bankMatch.has('b' + r.idx)) ? 'bezahlt' : r.status, taxNote: (notes['b' + r.idx] || '').trim(), dest: acctOf('b', r), file: fileFor(zipB, r.file, 'b' + r.idx), recur: g ? { from: g.from, until: g.ongoing ? null : g.to } : null }; })],
        rechnungen: rechGo.map(r0 => { const r = eff('r', r0); return ({ ...r, rowKey: 'r' + r.idx, status: (bankMatch && bankMatch.has('r' + r.idx)) ? 'bezahlt' : r.status, taxNote: (notes['r' + r.idx] || '').trim(), dest: acctOf('r', r), file: fileFor(zipR, r.file, 'r' + r.idx) }); }),
        // laufende Rechnungs-Serien: ab dem Folgemonat automatisch weiter erzeugen
        recurInvoices: recurActive(recurR, rechGo, 'r').filter(g => g.ongoing && g.idxs.includes(g.last.idx) && rechGo.some(r => r.idx === g.last.idx)).map(g => ({ name: g.last.name, dest: acctOf('r', g.last), netto: g.last.netto, mwst: g.last.mwst, beschreibung: g.last.beschreibung, adresse: g.last.adresse, lastY: g.to.y, lastM: g.to.m })),
      };
      const res = await onImport(payload, setProgress);
      setResult(res);
    } catch (e) { setErr('Import fehlgeschlagen: ' + (e.message || e)); }
    setBusy(false); setProgress('');
  };

  // ── Abgleich-Liste (Kontoauszug als Hauptquelle) ──
  const dispRows = [...(B ? B.rows : []).filter(r => r.inYear && !r.dup && !r.cancelled && r.brutto > 0 && r.datum).map(r => ({ k: 'b', r })), ...(R ? R.rows : []).filter(r => r.inYear && !r.dup && !r.cancelled && r.brutto > 0 && r.datum).map(r => ({ k: 'r', r })), ...xRows.map(r => ({ k: 'x', r }))];
  const unitOf = ({ k, r }) => { const e = eff(k, r); const key = k + r.idx; return { key, k, kind: r.kind, datum: r.datum, name: e.name, brutto: r.brutto, kategorie: e.kategorie, konto: acctOf(k, r), cls: statusOf(k, r).cls, hasFile: !!(r.file || upPdf[key]), src: r.bankOnly ? 'bank' : 'csv', beschreibung: r.beschreibung, skip: !!skip[key] }; };
  const selKeys = Object.keys(sel).filter(x => sel[x]);
  // Sammelaktion auf alle ausgewählten Zeilen
  const bulk = (patch, keys) => {
    const ks = keys || selKeys; if (!ks.length) return;
    if (patch.kategorie || patch.mwst != null) setOvr(o => { const n = { ...o }; ks.forEach(k => { n[k] = { ...(n[k] || {}), ...(patch.kategorie ? { kategorie: patch.kategorie } : {}), ...(patch.mwst != null ? { mwst: patch.mwst } : {}) }; }); return n; });
    if (patch.konto) setRowAcct(a => { const n = { ...a }; ks.forEach(k => { n[k] = patch.konto; }); return n; });
    if (patch.notiz) setNotes(a => { const n = { ...a }; ks.forEach(k => { n[k] = patch.notiz; }); return n; });
    if (patch.skip != null) setSkip(a => { const n = { ...a }; ks.forEach(k => { n[k] = patch.skip; }); return n; });
  };
  const openPdf = async (k, r) => {
    const key = k + r.idx; const w = window.open('', '_blank'); try {
      let bytes, name = r.file || 'beleg.pdf';
      if (upPdf[key]) { bytes = await upPdf[key].data(); name = upPdf[key].name; } else { const z = k === 'r' ? zipR : zipB; const e = z && z.entries.find(x => x.name === r.file); if (!e) throw new Error('Datei nicht gefunden'); bytes = await e.data(); }
      const isPdf = /\.pdf$/i.test(name); const ext = (name.split('.').pop() || '').toLowerCase();
      const url = URL.createObjectURL(new Blob([bytes], { type: isPdf ? 'application/pdf' : (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg') }));
      if (w) w.location.href = url; else window.open(url, '_blank');
    } catch (e) { if (w) w.close(); setErr('Beleg konnte nicht geöffnet werden: ' + (e.message || e)); }
  };
  const describeAction = (a) => { const f = a.filter || {}; const fp = [f.name && 'Name „' + [].concat(f.name).join('/') + '"', f.von && 'ab ' + f.von.split('-').reverse().join('.'), f.bis && 'bis ' + f.bis.split('-').reverse().join('.'), f.art && (f.art === 'ein' ? 'Einnahmen' : 'Ausgaben'), f.kategorie && 'Kategorie ' + f.kategorie, f.ohneBeleg && 'ohne Beleg', f.status && 'Status ' + f.status].filter(Boolean).join(', ');
    const sp = [a.set.kategorie && 'Kategorie → ' + a.set.kategorie, a.set.konto && 'Konto → ' + ((accounts.find(x => x.key === a.set.konto) || {}).label || a.set.konto), a.set.mwst != null && 'MwSt → ' + a.set.mwst + ' %', a.set.notiz && 'Notiz „' + a.set.notiz + '"'].filter(Boolean).join(', ');
    const t = { auswaehlen: 'Auswählen', setzen: 'Ändern: ' + sp, ignorieren: 'Ignorieren (nicht importieren)', wiederherstellen: 'Wiederherstellen', notiz: 'Notiz setzen: ' + sp, merken: 'Merken: ' + a.text }[a.typ];
    return t + (a.typ !== 'merken' && fp ? ' · ' + fp : ''); };
  const sendBot = async () => {
    const text = botInput.trim(); if (!text || botBusy || !aiAsk) return;
    setBotInput(''); setBotMsgs(m => [...m, { role: 'user', text }]); setBotBusy(true); setBotPending(null);
    try {
      const units = dispRows.map(unitOf); const ctx = groupContext(units);
      const system = 'Du bist der Import-Helfer von Buqo (deutsche Buchhaltung). Der Nutzer gibt Anweisungen zu seiner Buchungsliste (Kontoauszug-Umsätze, Belege, Rechnungen). Antworte NUR mit minifiziertem JSON ohne Markdown: {"antwort":"…","aktionen":[…]}. "antwort": 1 bis 3 kurze, klare Sätze mit Zeilenumbrüchen (\\n), ohne Floskeln. Aktionen: {"typ":"auswaehlen|setzen|ignorieren|wiederherstellen|notiz|merken","filter":{"name":"Teil des Namens oder Liste","von":"YYYY-MM-DD","bis":"YYYY-MM-DD","art":"ein|aus","konto":"Schlüssel","kategorie":"…","min":0,"max":0,"status":"passt|hinweis|fehlt","ohneBeleg":true,"quelle":"bank|csv","text":"…"},"setzen":{"kategorie":"aus der Liste","konto":"Schlüssel","privat":true,"mwst":0|7|19,"notiz":"…"},"text":"…"}. "merken": text = kurzer Fakt über den Nutzer oder das Konto für die spätere Steuerberatung (max. 200 Zeichen). Notizen sind intern für den Steuer-Assistenten: sachlich festhalten, was gekauft/gebucht wurde und was steuerlich relevant sein kann. Nutze nur vorhandene Kategorien und Konten, erfinde nichts. Ist der Auftrag unklar, gib keine Aktion zurück und stelle in "antwort" eine kurze Rückfrage.';
      const user = 'Konten (Schlüssel=Name): ' + accounts.map(a => a.key + '=' + a.label).join(', ') + '\nKategorien: ' + CATS.join(', ') + '\nListe: ' + units.length + ' Buchungen, zusammengefasst nach Name:\n' + ctx.join('\n') + '\n\nBisheriges Gespräch:\n' + botMsgs.slice(-6).map(m => (m.role === 'user' ? 'Nutzer: ' : 'Helfer: ') + m.text).join('\n') + '\n\nAuftrag: ' + text;
      const out = parseBotJson(await aiAsk(system, user, { max: 1500 }));
      const acts = normalizeActions(out.aktionen, { cats: CATS, accounts }).map(a => ({ ...a, keys: a.typ === 'merken' ? [] : units.filter(u => matchFilter(u, a.filter)).map(u => u.key), sample: units.filter(u => matchFilter(u, a.filter)).slice(0, 3).map(u => u.name) }));
      setBotMsgs(m => [...m, { role: 'ai', text: out.antwort || (acts.length ? 'Das würde ich tun:' : 'Das habe ich nicht verstanden – kannst du es anders formulieren?') }]);
      if (acts.length) setBotPending(acts);
    } catch (e) { setBotMsgs(m => [...m, { role: 'ai', text: 'Das hat nicht geklappt: ' + (e.message || e) }]); }
    setBotBusy(false);
  };
  const applyBot = () => {
    if (!botPending) return; let n = 0; const facts = [];
    botPending.forEach(a => {
      if (a.typ === 'auswaehlen') { setSel(s => { const x = { ...s }; a.keys.forEach(k => { x[k] = true; }); return x; }); n += a.keys.length; }
      else if (a.typ === 'ignorieren') { bulk({ skip: true }, a.keys); n += a.keys.length; }
      else if (a.typ === 'wiederherstellen') { bulk({ skip: false }, a.keys); n += a.keys.length; }
      else if (a.typ === 'setzen' || a.typ === 'notiz') { bulk(a.set, a.keys); n += a.keys.length; if (a.set.notiz || a.set.kategorie) { const f = a.filter || {}; const who = f.name ? [].concat(f.name).join('/') : 'Auswahl'; const per = [f.von && 'ab ' + f.von.split('-').reverse().join('.'), f.bis && 'bis ' + f.bis.split('-').reverse().join('.')].filter(Boolean).join(' '); facts.push(who + (per ? ' (' + per + ')' : '') + ': ' + [a.set.kategorie && 'Kategorie ' + a.set.kategorie, a.set.konto && 'Konto ' + ((accounts.find(x => x.key === a.set.konto) || {}).label || a.set.konto), a.set.notiz && a.set.notiz].filter(Boolean).join(', ')); } }
      else if (a.typ === 'merken' && a.text) facts.push(a.text);
    });
    if (facts.length && onRemember) onRemember(facts);
    setBotMsgs(m => [...m, { role: 'ai', text: '✓ Erledigt' + (n ? ' – ' + n + ' Zeilen betroffen.' : '.') + (facts.length ? '\nIch habe es mir für die Steuerberatung gemerkt.' : '') }]); setBotPending(null);
  };

  /* ── UI-Bausteine ── */
  const card = { ...SC, padding: isMobile ? '16px' : '20px 22px' };
  const lbl = { fontSize: 12, color: C.sub, fontWeight: 600, marginBottom: 6 };
  const btnP = { display: 'inline-flex', alignItems: 'center', gap: 8, background: C.act, color: C.actTxt, border: 'none', borderRadius: 999, padding: '11px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
  const btnS = { display: 'inline-flex', alignItems: 'center', gap: 8, background: C.surf2, color: C.txt, border: '1px solid ' + C.bdr, borderRadius: 999, padding: '10px 16px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
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
  // mehrere Dateien auf einmal (und später weitere dazu)
  const slotMulti = (title, hint, accept, names, onFiles, onClear) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, background: names.length ? hexA(C.grn, 0.08) : C.surf2, border: '1.5px ' + (names.length ? 'solid ' + hexA(C.grn, 0.5) : 'dashed ' + C.bdrM), borderRadius: 14, padding: '13px 14px', cursor: 'pointer', minWidth: 0 }}>
      <span style={{ width: 38, height: 38, borderRadius: 11, background: names.length ? C.grn : C.surf3, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={names.length ? P.check : P.upload} sz={17} col={names.length ? '#fff' : C.sub} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: C.txt }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.sub, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{names.length ? names.join(' · ') : hint}</span>
      </span>
      {names.length > 0 && <button onClick={e => { e.preventDefault(); onClear(); }} style={{ background: 'none', border: 'none', color: C.mut, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit' }}>Entfernen</button>}
      <input type="file" multiple accept={accept} onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) onFiles(fs); }} style={{ display: 'none' }} />
    </label>
  );
  const Stat = ({ l, v, c }) => <div style={{ flex: 1, minWidth: 120 }}><div style={{ fontSize: 11.5, color: C.sub, fontWeight: 600 }}>{l}</div><div style={{ fontSize: 18, fontWeight: 800, color: c || C.txt, ...NUM }}>{v}</div></div>;
  const Steps = () => (
    <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
      {[[1, 'Hochladen'], [2, 'Abgleich'], [3, 'Wiederkehrendes & Verbuchen']].map(([n, t]) => (
        <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, background: step === n ? C.act : C.surf2, color: step === n ? C.actTxt : (step > n ? C.grn : C.sub), border: '1px solid ' + (step === n ? C.act : C.bdr) }}>{step > n ? '✓' : n} {t}</span>))}
    </div>);
  // Fortschrittsbalken mit Prozentzahl (done/total); ohne Gesamtzahl der laufende Balken
  const Bar = ({ done, total, label }) => { const pct = total ? Math.min(100, Math.round(done / total * 100)) : null; return (
    <div style={{ marginTop: 10 }}>
      {pct != null ? (<>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: C.sub, marginBottom: 5 }}><span>{label}</span><b style={{ ...NUM, color: C.txt }}>{pct} %</b></div>
        <div style={{ height: 8, borderRadius: 99, background: C.surf3, overflow: 'hidden' }}><div style={{ height: '100%', width: pct + '%', background: C.pri, transition: 'width .3s' }} /></div>
      </>) : <div className="prog" />}
    </div>); };
  const progPct = (t) => { const m = String(t || '').match(/(\d+)\s*\/\s*(\d+)/); return m ? [+m[1], +m[2]] : [0, 0]; };
  const chipCol = (c) => c === 'ok' ? C.grn : c === 'miss' ? C.red : c === 'ai' ? C.pri : C.amb;

  const renderList = () => {
    const q = normN(listQ);
    const list = dispRows.filter(({ k, r }) => {
      if (filt === 'ausgaben' && r.kind === 'ein') return false; if (filt === 'einnahmen' && r.kind !== 'ein') return false;
      if (['passt', 'hinweis', 'fehlt'].includes(filt) && statusOf(k, r).cls !== filt) return false;
      if (q && !normN(eff(k, r).name + ' ' + (r.nummer || '') + ' ' + r.brutto).includes(q)) return false; return true;
    }).sort((a, b) => String(b.r.datum).localeCompare(String(a.r.datum)));
    const shownL = list.slice(0, listLimit); const groups = new Map();
    shownL.forEach(x => { const mk = String(x.r.datum).slice(0, 7); if (!groups.has(mk)) groups.set(mk, []); groups.get(mk).push(x); });
    const mkeys = [...groups.keys()].sort().reverse();
    const fieldSel = { ...SS, textAlign: 'left', padding: '8px 10px', fontSize: 13, width: '100%' };
    const sm = { background: C.surf2, border: '1px solid ' + C.bdr, color: C.txt, borderRadius: 8, padding: '6px 11px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
    return (<>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input value={listQ} onChange={e => { setListQ(e.target.value); setListLimit(120); }} placeholder="Name, Nummer, Betrag suchen …" style={{ ...SS, flex: 1, minWidth: 180, textAlign: 'left', padding: '11px 13px' }} />
        <button onClick={() => setSel(x => { const n = { ...x }; const all = list.every(({ k, r }) => x[k + r.idx]); list.forEach(({ k, r }) => { n[k + r.idx] = !all; }); return n; })} style={sm}>{list.length && list.every(({ k, r }) => sel[k + r.idx]) ? 'Auswahl aufheben' : 'Alle ' + list.length + ' auswählen'}</button>
      </div>
      {selKeys.length > 0 && (
        <div style={{ position: 'sticky', top: 8, zIndex: 30, background: C.surf, border: '1px solid ' + hexA(C.pri, 0.5), borderRadius: 14, padding: '10px 12px', marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
          <b style={{ fontSize: 13.5 }}>{selKeys.length} ausgewählt</b>
          <select value="" onChange={e => { if (e.target.value) bulk({ kategorie: e.target.value }); }} style={{ ...sm, width: 'auto' }}><option value="">Kategorie …</option>{CATS.map(c => <option key={c} value={c}>{c}</option>)}</select>
          <select value="" onChange={e => { if (e.target.value) bulk({ konto: e.target.value }); }} style={{ ...sm, width: 'auto' }}><option value="">Konto …</option>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select>
          <select value="" onChange={e => { if (e.target.value !== '') bulk({ mwst: +e.target.value }); }} style={{ ...sm, width: 'auto' }}><option value="">MwSt …</option><option value="0">0 %</option><option value="7">7 %</option><option value="19">19 %</option></select>
          <input value={bulkNote} onChange={e => setBulkNote(e.target.value)} placeholder="Notiz für alle …" style={{ ...SS, textAlign: 'left', padding: '6px 10px', fontSize: 12.5, width: 160 }} />
          <button onClick={() => { if (bulkNote.trim()) { bulk({ notiz: bulkNote.trim() }); setBulkNote(''); } }} style={sm}>Notiz setzen</button>
          <button onClick={() => bulk({ konto: (accounts.find(a => a.key === 'privat') || {}).key || 'privat' })} style={sm}>Privat</button>
          <button onClick={() => { bulk({ skip: true }); setSel({}); }} style={{ ...sm, color: C.red }}>Nicht importieren</button>
          <button onClick={() => bulk({ skip: false })} style={sm}>Wiederherstellen</button>
          <button onClick={() => setSel({})} style={{ ...sm, background: 'none', border: 'none', color: C.mut }}>Auswahl aufheben</button>
        </div>)}
      {!mkeys.length && <div style={{ ...card, textAlign: 'center', color: C.mut, fontSize: 14 }}>Keine Buchungen mit diesem Filter.</div>}
      {mkeys.map(mk => { const items = groups.get(mk); const sum = items.reduce((a, { r }) => a + (r.kind === 'ein' ? 1 : -1) * (r.storno ? -1 : 1) * r.brutto, 0); return (
        <div key={mk} style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}><span style={{ fontSize: 14, fontWeight: 800 }}>{MONTHS[+mk.slice(5) - 1]} {mk.slice(0, 4)}</span><span style={{ fontSize: 12.5, color: C.sub }}>{items.length} Buchungen</span><span style={{ flex: 1 }} /><span style={{ ...NUM, fontSize: 13, fontWeight: 700, color: sum >= 0 ? C.grn : C.txt }}>{sum >= 0 ? '+' : '−'}{fmt(Math.abs(sum))}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map(({ k, r }) => { const key = k + r.idx; const e = eff(k, r); const st = statusOf(k, r); const open = openRow === key; const skipped = !!skip[key]; const hasPdf = !!(r.file || upPdf[key]); const aus = (r.kind !== 'ein') !== !!r.storno; const acc = accounts.find(a => a.key === acctOf(k, r)); const tint = st.cls === 'fehlt' ? C.red : st.cls === 'hinweis' ? C.amb : C.grn; return (
              <div key={key} style={{ background: C.surf2, border: '1px solid ' + (sel[key] ? C.pri : C.bdr), borderRadius: 14, opacity: skipped ? 0.5 : 1 }}>
                <div onClick={() => setOpenRow(open ? null : key)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!sel[key]} onClick={ev => ev.stopPropagation()} onChange={ev => setSel(x => ({ ...x, [key]: ev.target.checked }))} />
                  <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 11, background: hexA(tint, 0.16), display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic p={hasPdf ? P.clip : P.doc} sz={18} col={tint} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700, color: C.txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: skipped ? 'line-through' : 'none' }}>{e.name || '—'}</div>
                    <div style={{ fontSize: 12, color: C.sub, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}><span>{r.datum.split('-').reverse().join('.')}</span><span>{acc ? acc.label : ''}</span><span>{e.kategorie}</span>{r.nummer && <span>{r.nummer}</span>}{e.mwst !== '' && e.mwst != null && <span>MwSt {e.mwst} %</span>}</div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 5, flexWrap: 'wrap' }}>{skipped && <span style={{ fontSize: 11, fontWeight: 700, color: C.mut, background: C.surf3, borderRadius: 6, padding: '2px 7px' }}>Wird nicht importiert</span>}{later[key] && <span style={{ fontSize: 11, fontWeight: 700, color: C.pri, background: hexA(C.pri, 0.13), borderRadius: 6, padding: '2px 7px' }}>To-do</span>}{st.chips.map((c, i) => { const col = chipCol(c.c); return <span key={i} style={{ fontSize: 11, fontWeight: 700, color: col, background: hexA(col, 0.12), border: '1px solid ' + hexA(col, 0.35), borderRadius: 6, padding: '2px 7px', lineHeight: 1.35 }}>{c.t}</span>; })}</div>
                  </div>
                  <div style={{ ...NUM, fontSize: 16, fontWeight: 800, color: aus ? C.txt : C.grn, whiteSpace: 'nowrap' }}>{aus ? '−' : '+'}{fmt(r.brutto)}</div>
                  <span style={{ color: C.mut, fontSize: 14 }}>{open ? '▾' : '▸'}</span>
                </div>
                {open && (
                  <div style={{ padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid ' + C.sep }}>
                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0,1fr))', gap: 10, marginTop: 10 }}>
                      <div style={{ gridColumn: isMobile ? '1 / -1' : 'span 2' }}><div style={lbl}>Name</div><input value={e.name} onChange={ev => setOvr(o => ({ ...o, [key]: { ...(o[key] || {}), name: ev.target.value } }))} style={fieldSel} /></div>
                      <div><div style={lbl}>Kategorie</div><select value={e.kategorie || ''} onChange={ev => setOvr(o => ({ ...o, [key]: { ...(o[key] || {}), kategorie: ev.target.value } }))} style={fieldSel}>{[...new Set([e.kategorie, ...CATS].filter(Boolean))].map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                      <div><div style={lbl}>MwSt</div><select value={String(e.mwst)} onChange={ev => setOvr(o => ({ ...o, [key]: { ...(o[key] || {}), mwst: +ev.target.value } }))} style={fieldSel}>{[0, 7, 19].map(v => <option key={v} value={v}>{v} %</option>)}{![0, 7, 19].includes(+e.mwst) && <option value={e.mwst}>{e.mwst} %</option>}</select></div>
                      <div><div style={lbl}>Konto</div><select value={acctOf(k, r)} onChange={ev => setRowAcct(a => ({ ...a, [key]: ev.target.value }))} style={fieldSel}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></div>
                      <div style={{ gridColumn: isMobile ? '1 / -1' : 'span 3' }}><div style={lbl}>Notiz (intern, für den KI-Steuerassistenten)</div><input value={notes[key] || ''} onChange={ev => setNotes(n => ({ ...n, [key]: ev.target.value }))} placeholder="z. B. Material Renovierung Wohnung 2" style={fieldSel} /></div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {hasPdf ? <button onClick={() => openPdf(k, r)} style={{ ...sm, background: C.act, color: C.actTxt, border: 'none' }}>📎 Beleg ansehen</button> : <label style={{ ...sm, color: C.red, display: 'inline-block' }}>Beleg hochladen<input type="file" accept=".pdf,image/*" style={{ display: 'none' }} onChange={ev => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) setUpPdf(p => ({ ...p, [key]: { name: f.name, data: async () => new Uint8Array(await f.arrayBuffer()) } })); }} /></label>}
                      {hasPdf && aiReadDoc && <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={kiAll || !!kiRows[key]} disabled={kiAll} onChange={ev => setKiRows(p => ({ ...p, [key]: ev.target.checked }))} /> KI liest das PDF</label>}
                      <button onClick={() => setLater(p => ({ ...p, [key]: !p[key] }))} style={{ ...sm, background: later[key] ? hexA(C.pri, 0.16) : C.surf2 }}>{later[key] ? '✓ Für später' : 'Für später'}</button>
                      <button onClick={() => setSkip(x => ({ ...x, [key]: !x[key] }))} style={{ ...sm, color: skipped ? C.txt : C.red }}>{skipped ? 'Wiederherstellen' : 'Nicht importieren'}</button>
                      {ocr[key] && !ocr[key].error && <span style={{ fontSize: 12, color: C.sub }}>KI-Lesung vorhanden{ocrOff[key] ? ' (Korrekturen aus)' : ''}</span>}
                    </div>
                  </div>)}
              </div>); })}
          </div>
        </div>); })}
      {list.length > shownL.length && <button onClick={() => setListLimit(l => l + 120)} style={{ ...btnS, width: '100%', justifyContent: 'center', borderRadius: 12 }}>Mehr anzeigen ({shownL.length} von {list.length})</button>}
    </>);
  };

  return (<>
    <Steps />
    {importMsg && <div style={{ background: hexA(C.grn, 0.08), border: '1px solid ' + hexA(C.grn, 0.35), borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.txt, marginBottom: 14 }}>✅ {importMsg}</div>}
    {err && <div style={{ background: hexA(C.red, 0.08), border: '1px solid ' + hexA(C.red, 0.35), borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.red, marginBottom: 14 }}>{err}</div>}

    {step === 1 && (<>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <span style={{ width: 44, height: 44, borderRadius: '50%', background: C.txt, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={P.swap} sz={20} col={C.bg} /></span>
          <div style={{ flex: 1, minWidth: 240, fontSize: 13.5, lineHeight: 1.6, color: C.txt }}>
            <b>Schritt 1: Alles hochladen.</b> Starte mit den <b>Kontoauszügen aller Monate</b> – danach wirst du gefragt, <b>welches Jahr</b> importiert werden soll; nur dieses Jahr wird geladen. Dann kannst du CSV, PDFs/ZIPs, DATEV und weitere Unterlagen als Hilfe dazulegen, so viele du willst. <b>Es wird nichts angezeigt und nichts gespeichert</b>, bis du auf „Abgleich starten" klickst. Im nächsten Schritt siehst du alles auf einen Blick: was passt, was fehlt, Hinweise der KI. Gebucht wird erst ganz am Ende.
          </div>
        </div>
      </div>
      {draftInfo && anyFile() && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: hexA(C.grn, 0.08), border: '1px solid ' + hexA(C.grn, 0.35), borderRadius: 12, padding: '10px 14px', fontSize: 12.5, color: C.txt, marginBottom: 14 }}>
          <span style={{ flex: 1, minWidth: 220 }}>💾 Zwischengespeichert ({new Date(draftInfo.savedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}): geladene Dateien, Zuordnungen, Notizen und KI-Ergebnisse bleiben erhalten, auch wenn du die Seite schließt.</span>
          <button onClick={() => { if (window.confirm('Zwischenstand wirklich verwerfen? Geladene Dateien und alle Zuordnungen hier werden entfernt (bereits importierte Buchungen bleiben).')) discardDraft(); }} style={{ background: 'none', border: '1px solid ' + C.bdr, color: C.sub, borderRadius: 999, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>Verwerfen</button>
        </div>)}
      {(belege || rech) && yearChosen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14, fontSize: 13.5 }}>
          <span style={{ fontWeight: 700 }}>Importiert wird nur:</span>
          <span style={{ background: hexA(C.pri, 0.14), color: C.pri, borderRadius: 999, padding: '5px 12px', fontWeight: 800 }}>{year === 'alle' ? 'Alle Jahre' : year}</span>
          <button onClick={() => setYearAsk(true)} style={{ background: 'none', border: 'none', color: C.pri, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700 }}>Jahr ändern</button>
        </div>)}
      <div style={{ ...card, marginBottom: 14, border: '1px solid ' + hexA(C.pri, 0.4) }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>1 · Kontoauszüge aller Monate</div>
        <div style={{ fontSize: 12.5, color: C.sub, margin: '3px 0 12px', lineHeight: 1.55 }}>Der Kontoauszug ist die Hauptquelle: <b>jeder Umsatz wird eine Buchung</b>. Lade alle Monate auf einmal hoch (PDF, Foto oder CSV). Die CSV-Dateien und Belege unten sind nur Hilfe und ergänzen Name, MwSt, Kategorie und Beleg.</div>
        {slotMulti('Kontoauszüge hochladen', 'Alle Monate auf einmal – PDF, Foto oder CSV', '.csv,.txt,.pdf,image/*,text/csv', [], addBank, () => setBank([]))}
        {bank.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {bank.map((b, i) => (
              <div key={b.name + i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.surf2, border: '1px solid ' + C.bdr, borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{b.name}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: b.rows ? (b.rows.length ? C.grn : C.amb) : C.sub }}>{b.rows ? (b.rows.length ? b.rows.length + ' Umsätze' : 'nicht lesbar') : 'wird beim Abgleich gelesen'}</span>
                <button onClick={() => setBank(x => x.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: C.mut, cursor: 'pointer', fontSize: 15 }}>×</button>
              </div>))}
          </div>)}
      </div>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>2 · Hilfsdateien <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub }}>(optional)</span></div>
        <div style={{ fontSize: 12.5, color: C.sub, margin: '3px 0 12px', lineHeight: 1.55 }}>CSV aus sevDesk, PDFs, DATEV: Buqo ordnet die Belege und Rechnungen den Umsätzen automatisch zu und übernimmt Namen, MwSt-Satz und Rechnungsnummer.</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
        {slot('Belege · CSV oder DATEV', 'sevDesk → Belege → Exportieren → CSV', '.csv,.txt,text/csv', belege, f => readCsv(f, 'aus', setBelege), belege && (belege.parsed.rows.length + ' Zeilen · ' + FORMAT_LABEL[belege.format]))}
        {slotMulti('Belege · PDFs (ZIP oder einzelne Dateien)', 'sevDesk → Belege → Exportieren → ZIP, mehrere möglich', '.zip,application/zip,.pdf,image/*', zipB ? [zipB.fileName + ' (' + zipB.entries.length + ' Dateien)'] : [], fs => readDocs(fs, setZipB, zipB), () => setZipB(null))}
        {slot('Rechnungen · CSV', 'sevDesk → Rechnungen → Exportieren → CSV', '.csv,.txt,text/csv', rech, f => readCsv(f, 'ein', setRech), rech && (rech.parsed.rows.length + ' Zeilen · ' + FORMAT_LABEL[rech.format]))}
        {slotMulti('Rechnungen · PDFs (ZIP oder einzelne Dateien)', 'sevDesk → Rechnungen → Exportieren → ZIP, mehrere möglich', '.zip,application/zip,.pdf,image/*', zipR ? [zipR.fileName + ' (' + zipR.entries.length + ' Dateien)'] : [], fs => readDocs(fs, setZipR, zipR), () => setZipR(null))}
        {slotMulti('DATEV-Dateien (Steuerberater)', 'Buchungsstapel als CSV, mehrere möglich – wird mit deinen Buchungen abgeglichen', '.csv,.txt,text/csv', datev.map(d => d.name), fs => setDatev(d => [...d, ...fs.map(f => ({ file: f, name: f.name }))]), () => { setDatev([]); setDatevRows([]); })}
        </div>
      </div>
      {slotMulti('Weitere Unterlagen und Infos für die KI', 'z. B. EÜR, BWA, Steuerbescheid, Verträge, Notizen – landen in den Steuerunterlagen, die KI nutzt sie als Steuerberater', '.pdf,.csv,.txt,image/*', extra.map(x => x.name), fs => setExtra(x => [...x, ...fs.map(f => ({ file: f, name: f.name }))]), () => setExtra([]))}
      <div style={{ ...card, margin: '14px 0' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, cursor: 'pointer' }}><input type="checkbox" checked={kiAll} onChange={e => setKiAll(e.target.checked)} /> <span><b>KI liest alle PDFs</b> vor dem Abgleich (genauer, verbraucht KI-Guthaben). Ohne Haken liest sie nur auffällige Zeilen (mögliche Doppelungen, Notizen mit „prüfen").</span></label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          <button onClick={analyze} disabled={analysing || !yearChosen || (!belegeGo.length && !rechGo.length && !bank.length)} style={{ ...btnP, opacity: (analysing || !yearChosen || (!belegeGo.length && !rechGo.length && !bank.length)) ? 0.55 : 1 }}><Ic p={P.spark} sz={16} col={C.actTxt} /> {analysing ? 'Läuft …' : 'Weiter: Abgleich starten'}</button>
          <span style={{ fontSize: 12.5, color: C.sub }}>{anaProg || (!(belege || rech || bank.length) ? 'Lade zuerst die Kontoauszüge (oder eine CSV).' : !yearChosen ? 'Bitte zuerst das Jahr wählen.' : '')}</span>
        </div>
        {analysing && <Bar done={anaDone} total={anaTotal} label={anaProg || 'Abgleich läuft …'} />}
      </div>
    </>)}

    {step === 2 && (<>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 17, fontWeight: 800, flex: 1, minWidth: 200 }}>Abgleich · {year === 'alle' ? 'Alle Jahre' : year}</div>
          <button onClick={() => setStep(1)} style={btnS}>‹ Zurück zum Hochladen</button>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <Stat l="Ausgaben" v={stats.ausg} /><Stat l="Einnahmen" v={stats.einn} /><Stat l="✅ Passt" v={stats.passt} c={C.grn} /><Stat l="⚠ Hinweise" v={stats.hinweis} c={stats.hinweis ? C.amb : C.sub} /><Stat l="❌ Fehlt" v={stats.fehlt} c={stats.fehlt ? C.red : C.sub} />{dMatch && <Stat l="Nur in DATEV" v={dMatch.onlyDatev.length} c={dMatch.onlyDatev.length ? C.amb : C.sub} />}
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginTop: 10, lineHeight: 1.5 }}>{bankMatch ? 'Kontoauszug geladen (' + bankRowsY.length + ' Umsätze). ' : 'Kein Kontoauszug geladen. '}{dMatch ? 'DATEV geladen (' + datevRowsY.length + ' Zeilen). ' : 'Keine DATEV-Datei geladen. '}Bei jeder Zeile kannst du ein fehlendes PDF direkt hochladen, sie <b>für später</b> als To-do vormerken oder <b>ignorieren</b>. Gebucht wird erst in Schritt 3.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {[['alle', 'Alle'], ['ausgaben', 'Ausgaben'], ['einnahmen', 'Einnahmen'], ['passt', '✅ Passt'], ['hinweis', '⚠ Hinweise'], ['fehlt', '❌ Fehlt']].map(([k, t]) => (
            <button key={k} onClick={() => setFilt(k)} style={{ background: filt === k ? C.txt : C.surf2, color: filt === k ? C.bg : C.txt, border: '1px solid ' + (filt === k ? C.txt : C.bdr), borderRadius: 999, padding: '6px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{t}</button>))}
          {aiReadDoc && kiOpen > 0 && <button onClick={readMarked} disabled={analysing} style={{ ...btnS, background: AI_GRADIENT, color: '#fff', border: 'none', padding: '6px 13px', fontSize: 12.5 }}>{analysing ? (anaProg || 'KI liest …') : 'KI liest ' + kiOpen + ' markierte PDFs'}</button>}
        </div>
        {analysing && <Bar done={anaDone} total={anaTotal} label={anaProg || 'KI liest …'} />}
      </div>
      {aiAsk && (
        <div style={{ ...card, marginBottom: 14, border: '1px solid ' + hexA(C.pri, 0.35) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 34, height: 34, borderRadius: 10, background: AI_GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic p={P.spark} sz={16} col="#fff" /></span><div><div style={{ fontSize: 15, fontWeight: 800 }}>KI-Helfer für diese Liste</div><div style={{ fontSize: 12.5, color: C.sub }}>Sag in eigenen Worten, was geändert oder ausgewählt werden soll – vor jeder Änderung frage ich nach.</div></div></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
            {['Wähle alle Buchungen ohne Beleg aus', 'Alle Bauhaus-Käufe → Kategorie Material, Notiz „Renovierung"', 'Markiere alle Zahlungen an Amazon als privat'].map(t => <button key={t} onClick={() => setBotInput(t)} style={{ background: C.surf2, border: '1px solid ' + C.bdr, color: C.sub, borderRadius: 999, padding: '5px 11px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>{t}</button>)}
          </div>
          {botMsgs.slice(-6).map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '6px 0' }}><div style={{ maxWidth: '88%', background: m.role === 'user' ? C.act : C.surf2, color: m.role === 'user' ? C.actTxt : C.txt, borderRadius: 14, padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.text}</div></div>)}
          {botBusy && <div style={{ fontSize: 12.5, color: C.sub, margin: '6px 0' }}>Ich überlege …</div>}
          {botPending && (
            <div style={{ background: C.surf2, border: '1px solid ' + C.bdr, borderRadius: 12, padding: '10px 12px', margin: '8px 0' }}>
              {botPending.map((a, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.5, padding: '3px 0' }}>• {describeAction(a)}{a.typ !== 'merken' && <span style={{ color: C.sub }}> – <b>{a.keys.length} Zeilen</b>{a.sample.length ? ' (z. B. ' + a.sample.join(', ') + ')' : ''}</span>}</div>)}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button onClick={applyBot} style={{ ...btnP, padding: '8px 16px', fontSize: 13 }}>Anwenden</button><button onClick={() => setBotPending(null)} style={{ ...btnS, padding: '8px 14px', fontSize: 13 }}>Verwerfen</button></div>
            </div>)}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input value={botInput} onChange={e => setBotInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') sendBot(); }} placeholder='z. B. Bauhaus ab dem 15.03. war für die Renovierung von Wohnung 2 …' style={{ ...SS, flex: 1, textAlign: 'left', padding: '11px 13px' }} />
            <button onClick={sendBot} disabled={botBusy || !botInput.trim()} style={{ ...btnP, padding: '10px 18px', opacity: (botBusy || !botInput.trim()) ? 0.55 : 1 }}>Senden</button>
          </div>
        </div>)}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {[['liste', 'Liste'], ['tabelle', 'Tabelle (CSV-Zeilen)']].map(([k2, l]) => <button key={k2} onClick={() => setView(k2)} style={{ ...btnS, padding: '7px 14px', fontSize: 12.5, background: view === k2 ? C.txt : C.surf2, color: view === k2 ? C.bg : C.txt }}>{l}</button>)}
      </div>
      {view === 'liste' && renderList()}
      {view === 'tabelle' && (<>
      {B && filt !== 'einnahmen' && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}><div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Belege · {FORMAT_LABEL[belege.format]}</div><div style={{ fontSize: 12.5, color: C.sub }}>{belege.fileName}</div></div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <Stat l="Importierbar" v={belegeGo.length} c={C.grn} /><Stat l="Schon vorhanden" v={B.sum.dup} c={C.amb} /><Stat l="Storniert / unvollständig" v={B.sum.cancelled + B.sum.invalid} /><Stat l="Summe brutto" v={fmt(belegeGo.reduce((s, r) => s + (r.storno ? -r.brutto : r.brutto), 0))} /><Stat l="PDF zugeordnet" v={(B.filesMatched) + (zipB ? ' / ' + zipB.entries.length : '')} c={zipB ? C.txt : C.mut} />
          </div>
          {!zipB && <div style={{ fontSize: 12, color: C.amb, marginTop: 8 }}>Ohne ZIP werden die Belege ohne Datei angelegt – du kannst die PDFs später einzeln nachladen. Besser: jetzt das ZIP dazulegen.</div>}
          <Mapping ui={ui} src={belege} setSrc={setBelege} k="b" mapOpen={mapOpen} setMapOpen={setMapOpen} isMobile={isMobile} />
          <Table ui={ui} statusOf={statusOf} filt={filt} later={later} setLater={setLater} upPdf={upPdf} setUpPdf={setUpPdf} eff={eff} ocr={ocr} ocrOff={ocrOff} setOcrOff={setOcrOff} ocrDiff={ocrDiff} kiRows={kiRows} setKiRows={setKiRows} kiAll={kiAll} year={year} setYear={setYear} years={yearsSeen} notes={notes} setNotes={setNotes} title="Belege" zip={zipB} X={B} k="b" withAcct skip={skip} setSkip={setSkip} rowAcct={rowAcct} setRowAcct={setRowAcct} accounts={accounts} acctOf={acctOf} ai={ai} onlyUnsure={onlyUnsure} />
        </div>
      )}
      {R && filt !== 'ausgaben' && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}><div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Rechnungen · {FORMAT_LABEL[rech.format]}</div><div style={{ fontSize: 12.5, color: C.sub }}>{rech.fileName}</div></div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <Stat l="Importierbar" v={rechGo.length} c={C.grn} /><Stat l="Schon vorhanden" v={R.sum.dup} c={C.amb} /><Stat l="Davon offen" v={rechGo.filter(r => r.status === 'offen').length} /><Stat l="Summe brutto" v={fmt(rechGo.reduce((s, r) => s + (r.storno ? -r.brutto : r.brutto), 0))} /><Stat l="PDF zugeordnet" v={(R.filesMatched) + (zipR ? ' / ' + zipR.entries.length : '')} c={zipR ? C.txt : C.mut} />
          </div>
          <Mapping ui={ui} src={rech} setSrc={setRech} k="r" mapOpen={mapOpen} setMapOpen={setMapOpen} isMobile={isMobile} />
          <Table ui={ui} statusOf={statusOf} filt={filt} later={later} setLater={setLater} upPdf={upPdf} setUpPdf={setUpPdf} eff={eff} ocr={ocr} ocrOff={ocrOff} setOcrOff={setOcrOff} ocrDiff={ocrDiff} kiRows={kiRows} setKiRows={setKiRows} kiAll={kiAll} year={year} setYear={setYear} years={yearsSeen} notes={notes} setNotes={setNotes} title="Rechnungen" zip={zipR} X={R} k="r" withAcct skip={skip} setSkip={setSkip} rowAcct={rowAcct} setRowAcct={setRowAcct} accounts={accounts} acctOf={acctOf} ai={ai} onlyUnsure={onlyUnsure} />
        </div>
      )}
      </>)}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div style={lbl}>Steuerjahr</div><select value={year} onChange={e => setYear(e.target.value)} style={{ ...SS, width: 130 }}><option value="alle">Alle Jahre</option>{[...new Set([...(yearsSeen), defaultYear].filter(Boolean))].sort().map(y => <option key={y} value={String(y)}>{y}</option>)}</select></div>
          {B && <div><div style={lbl}>Belege standardmäßig auf Konto</div><select value={acct} onChange={e => setAcct(e.target.value)} style={{ ...SS, width: 220 }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></div>}
          <div><div style={lbl}>Kunden anlegen ab</div><select value={minCust} onChange={e => setMinCust(+e.target.value)} style={{ ...SS, width: 190 }}><option value={1}>1 Rechnung (alle)</option><option value={2}>2 Rechnungen</option><option value={3}>3 Rechnungen</option><option value={5}>5 Rechnungen</option></select></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.txt, cursor: 'pointer', paddingBottom: 8 }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Alles sofort als bezahlt buchen (nur wenn du keinen Kontoauszug hochlädst – sonst gleicht Schritt 2 das ab)</label>
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

      {dMatch && dMatch.onlyDatev.length > 0 && (
        <div style={{ ...card, marginBottom: 14, border: '1px solid ' + hexA(C.amb, 0.5) }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>In DATEV, aber nicht im Import · {dMatch.onlyDatev.length}</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>Diese Buchungen des Steuerberaters finden sich nicht in deinen sevDesk-Dateien. Fehlt etwas, lade die Datei oben nach; sonst „Für später" (To-do) oder „Ignorieren".</div>
          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 8 }}>
            {dMatch.onlyDatev.map((d, i) => { const a = datevAct['d' + i]; return (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 2px', borderTop: '1px solid ' + C.sep, fontSize: 12.5, opacity: a === 'ignore' ? 0.45 : 1 }}>
                <span style={{ ...NUM, color: C.sub, whiteSpace: 'nowrap' }}>{d.datum ? d.datum.split('-').reverse().join('.') : '—'}</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name || d.beschreibung || '—'}{d.nummer ? ' · ' + d.nummer : ''}</span>
                <span style={{ ...NUM, whiteSpace: 'nowrap' }}>{fmt(d.brutto)}</span>
                <button onClick={() => setDatevAct(x => ({ ...x, ['d' + i]: a === 'later' ? null : 'later' }))} style={{ ...btnS, padding: '4px 10px', fontSize: 12, background: a === 'later' ? hexA(C.pri, 0.16) : C.surf2 }}>{a === 'later' ? '✓ Für später' : 'Für später'}</button>
                <button onClick={() => setDatevAct(x => ({ ...x, ['d' + i]: a === 'ignore' ? null : 'ignore' }))} style={{ ...btnS, padding: '4px 10px', fontSize: 12 }}>{a === 'ignore' ? '✓ Ignoriert' : 'Ignorieren'}</button>
              </div>); })}
          </div>
        </div>)}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <button onClick={() => setStep(1)} style={btnS}>‹ Zurück</button>
        <button onClick={() => setStep(3)} style={btnP}>Weiter: Wiederkehrendes prüfen ›</button>
      </div>
    </>)}

    {step === 3 && (<>
      {(recurB.length + recurR.length > 0) ? (() => {
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
      })() : <div style={{ ...card, marginBottom: 14, fontSize: 13.5, color: C.sub }}>Keine wiederkehrenden Buchungen (Leasing, Raten, Abos) erkannt.</div>}

      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, color: C.pri, letterSpacing: '0.05em', marginBottom: 2 }}>SCHRITT 3 VON 3</div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{belegeGo.length} Belege, {rechGo.length} Rechnungen{xGo.length ? ' und ' + xGo.length + ' Buchungen aus dem Kontoauszug' : ''}{year !== 'alle' ? ' aus ' + year : ''} verbuchen</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '10px 0' }}>
          <Stat l="✅ Passt" v={stats.passt} c={C.grn} /><Stat l="⚠ Hinweise" v={stats.hinweis} c={stats.hinweis ? C.amb : C.sub} /><Stat l="❌ Fehlt" v={stats.fehlt} c={stats.fehlt ? C.red : C.sub} /><Stat l="Für später (To-do)" v={Object.keys(later).filter(k => later[k]).length + Object.values(datevAct).filter(v => v === 'later').length} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.txt, cursor: 'pointer', marginBottom: 6 }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Alles sofort als bezahlt buchen (sonst bleiben Posten offen, die nicht im Kontoauszug gefunden wurden)</label>
        <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>{progress || 'Beim Verbuchen landen Buchungen in den Konten, PDFs im Beleg-Speicher, Kunden und Rechnungen im Rechnungsbereich, Kontoauszüge und weitere Unterlagen bei den Steuerunterlagen.'}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button onClick={() => setStep(2)} style={btnS}>‹ Zurück zum Abgleich</button>
          <button onClick={() => setConfirmRun(true)} disabled={busy || (!belegeGo.length && !rechGo.length && !xGo.length)} style={{ ...btnP, opacity: (busy || (!belegeGo.length && !rechGo.length && !xGo.length)) ? 0.55 : 1 }}><Ic p={P.check} sz={16} col={C.actTxt} /> {busy ? 'Verbucht …' : 'Alles richtig verbuchen'}</button>
        </div>
        {busy && (() => { const [d, t] = progPct(progress); return <Bar done={d} total={t} label={progress || 'Verbucht …'} />; })()}
      </div>
      {result && (
        <div style={{ ...card, marginBottom: 14, background: hexA(C.grn, 0.07), border: '1px solid ' + hexA(C.grn, 0.35) }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Fertig – {result.belege} Belege, {result.rechnungen} Rechnungen, {result.kunden} neue Kunden, {result.dateien} Dateien abgelegt{result.wiederkehrend ? ' · ' + result.wiederkehrend + ' Belege als wiederkehrend markiert' : ''}{result.serien ? ' · ' + result.serien + ' laufende Rechnungs-Serie(n) angelegt' : ''}{result.kontoauszuege ? ' · ' + result.kontoauszuege + ' Kontoauszug/-auszüge' : ''}</div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>{result.fehler ? result.fehler + ' Datei(en) konnten nicht hochgeladen werden, die Buchungen sind trotzdem da. ' : ''}Schau jetzt in die Konten oder direkt in die Steuerprognose {year !== 'alle' ? year : ''} – dort sind die Zahlen sofort drin. Einen erneuten Import mit denselben Dateien erkennt Buqo als Dubletten.</div>
        </div>
      )}
    </>)}

    {yearAsk && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 185, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ background: C.surf, border: '1px solid ' + C.bdr, borderRadius: 18, padding: '20px 22px', maxWidth: 420, width: '100%', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
          <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>Welches Jahr soll importiert werden?</div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 12 }}>Nur dieses Jahr wird geladen und später gebucht. Alle anderen Jahre bleiben draußen – auch bei PDFs, DATEV und Kontoauszügen.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {yearsSeen.slice().reverse().map(y => (
              <button key={y} onClick={() => { setYear(String(y)); setYearChosen(true); setYearAsk(false); }} style={{ ...btnS, justifyContent: 'space-between', borderRadius: 12, padding: '12px 14px', background: String(y) === year && yearChosen ? hexA(C.pri, 0.14) : C.surf2 }}><span>{y}</span><span style={{ color: C.sub, fontWeight: 600 }}>{yearCounts[y] || 0} Zeilen</span></button>))}
            <button onClick={() => { setYear('alle'); setYearChosen(true); setYearAsk(false); }} style={{ ...btnS, borderRadius: 12, padding: '12px 14px', color: C.sub }}>Alle Jahre</button>
          </div>
        </div>
      </div>)}

    {confirmRun && (() => {
      const stornos = [...belegeGo, ...rechGo].filter(r => r.storno).length; const laterN = Object.keys(later).filter(k => later[k]).length;
      const allYears = year === 'alle';
      return (
        <div onClick={() => setConfirmRun(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surf, border: '1px solid ' + C.bdr, borderRadius: 18, padding: '20px 22px', maxWidth: 460, width: '100%', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>Jetzt alles verbuchen?</div>
            {allYears && <div style={{ background: hexA(C.amb, 0.12), border: '1px solid ' + hexA(C.amb, 0.5), borderRadius: 10, padding: '8px 12px', fontSize: 12.5, marginBottom: 10 }}>⚠ Du hast <b>Alle Jahre</b> gewählt.</div>}
            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: C.txt }}>
              Es werden <b>{belegeGo.length} Belege</b>, <b>{rechGo.length} Rechnungen</b>{xGo.length ? <> und <b>{xGo.length} Buchungen aus dem Kontoauszug</b></> : null} {allYears ? 'aus allen Jahren' : 'aus ' + year} gebucht{bankMatch ? ' – im Kontoauszug gefundene als bezahlt, die übrigen als offen' : ' – als offen'}{confirmed ? ' (du hast „sofort als bezahlt" gewählt)' : ''}. Andere Jahre und bereits vorhandene Buchungen bleiben unberührt.
              {stornos > 0 && <div style={{ color: C.sub, fontSize: 12.5 }}>Davon {stornos} Storno/Gutschriften – negativ gebucht.</div>}
              {laterN > 0 && <div style={{ color: C.sub, fontSize: 12.5 }}>Für {laterN} Zeilen entsteht ein To-do („Für später").</div>}
              {bank.length > 0 && <div style={{ color: C.sub, fontSize: 12.5 }}>{bank.length} Kontoauszug-Datei(en) werden für den Steuerberater abgelegt.</div>}
              {extra.length > 0 && <div style={{ color: C.sub, fontSize: 12.5 }}>{extra.length} weitere Unterlage(n) kommen in die Steuerunterlagen (KI liest sie aus).</div>}
              <div style={{ color: C.sub, fontSize: 12.5 }}>Bis jetzt wurde nichts gespeichert – alles liegt nur in diesem Browser.</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => { setConfirmRun(false); run(); }} style={{ flex: 1, background: C.act, color: C.actTxt, border: 'none', borderRadius: 11, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Jetzt verbuchen</button>
              <button onClick={() => setConfirmRun(false)} style={{ background: C.surf2, color: C.txt, border: '1px solid ' + C.bdr, borderRadius: 11, padding: '12px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Abbrechen</button>
            </div>
          </div>
        </div>); })()}
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
function Table({ ui, statusOf, filt, later, setLater, upPdf, setUpPdf, eff, ocr, ocrOff, setOcrOff, ocrDiff, kiRows, setKiRows, kiAll, X, k, title, zip, year, setYear, years, notes, setNotes, withAcct, skip, setSkip, rowAcct, setRowAcct, accounts, acctOf, ai, onlyUnsure }) {
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
    const rows = X.rows.filter(r => r.inYear && (!statusOf || !filt || ['alle', 'ausgaben', 'einnahmen'].includes(filt) || statusOf(k, r).cls === filt) && (!onlyUnsure || (aiOf(r) && !aiOf(r).sure && !rowAcct[k + r.idx]))).sort(sort === 'datum' ? (a, b) => String(a.datum || '').localeCompare(String(b.datum || '')) : sort === 'betrag' ? (a, b) => (b.brutto || 0) - (a.brutto || 0) : cmpName).slice(0, big ? 3000 : 300);
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
    // Tabelle als CSV exportieren (alle Zeilen der Datei, nicht nur das gewählte Jahr) – inkl. deiner Änderungen
    const exportCsv = () => {
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const num = (v) => String(Math.round((v || 0) * 100) / 100).replace('.', ',');
      const dt = (d) => d ? d.split('-').reverse().join('.') : '';
      const head = ['Datum', 'Name', 'Nummer', 'Beschreibung', 'Kategorie', 'Brutto', 'Netto', 'MwSt', 'Art', 'Status', 'PDF-Datei', 'Buqo-Konto', 'Buqo-Notiz', 'Buqo-KI', 'Buqo-Überspringen', 'Hinweis'];
      const lines = X.rows.map(r => {
        const acc = accounts.find(a => a.key === acctOf(k, r)); const status = r.cancelled ? 'storniert' : (r.status === 'bezahlt' ? 'bezahlt' : 'offen');
        return [dt(r.datum), r.name, r.nummer, r.beschreibung, r.kategorie, num(r.brutto), num(r.netto), r.mwst, r.kind === 'ein' ? 'Einnahme' : 'Ausgabe', status, r.file || '', acc ? acc.label : acctOf(k, r), (notes && notes[k + r.idx]) || '', (kiAll || (kiRows && kiRows[k + r.idx])) ? 'ja' : '', (skip && skip[k + r.idx]) ? 'ja' : '', [r.dup ? 'schon vorhanden' : '', ...(r.warn || [])].filter(Boolean).join(', ')].map(q).join(';');
      });
      const blob = new Blob(['\uFEFF' + [head.map(q).join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'buqo-import-' + (k === 'r' ? 'rechnungen' : 'belege') + '-' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      setNote(X.rows.length + ' Zeilen als CSV geladen. Du kannst sie später wieder als ' + title + '-CSV hochladen – deine Änderungen bleiben erhalten.');
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
        <button onClick={exportCsv} title="Die Tabelle mit allen deinen Änderungen (Konto, Notiz, KI-Haken, Überspringen) als CSV laden – später wieder hier hochladen" style={{ background: C.surf2, color: C.txt, border: '1px solid ' + C.bdr, borderRadius: 9, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Als CSV laden</button>
        <button onClick={() => setBig(b => !b)} style={{ background: big ? C.txt : C.surf2, color: big ? C.bg : C.txt, border: '1px solid ' + (big ? C.txt : C.bdr), borderRadius: 9, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{big ? 'Schließen' : 'Vergrößern'}</button>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 8, maxHeight: big ? 'calc(100vh - 90px)' : 420, overflowY: 'auto', border: '1px solid ' + C.bdr, borderRadius: 12, background: C.surf }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead><tr><th style={th}></th><th style={th}>Datum</th><th style={th}>Name</th><th style={th}>Nummer</th><th style={th}>Kategorie</th><th style={{ ...th, textAlign: 'right' }}>Brutto</th><th style={th}>MwSt</th>{withAcct && <th style={th}>Konto</th>}<th style={th}>PDF</th><th style={th} title="KI liest das PDF beim Import im Hintergrund">KI</th><th style={th}>Notiz für den Steuerberater</th><th style={th}>Hinweis</th>{statusOf && <th style={th}>Status</th>}{statusOf && <th style={th}>Aktion</th>}</tr></thead>
          <tbody>
            {rows.map(r => { const off = r.dup || r.cancelled || !(r.brutto > 0 && r.datum); const sk = !!skip[k + r.idx]; const dim = off || sk; const e = eff(k, r); const o = ocr[k + r.idx]; const kiOn = !!o && !o.error && !ocrOff[k + r.idx]; const chg = (f) => kiOn && e[f] !== r[f]; const odiff = ocrDiff(k, r); return (
              <tr key={r.idx} style={{ opacity: dim ? 0.5 : 1, background: dim ? 'transparent' : (r.kind === 'ein' ? hexA(C.grn, 0.04) : 'transparent') }}>
                <td style={td}><input type="checkbox" checked={!off && !sk} disabled={off} onChange={e => setSkip(s => ({ ...s, [k + r.idx]: !e.target.checked }))} /></td>
                <td style={{ ...td, ...NUM, whiteSpace: 'nowrap' }}>{r.datum ? r.datum.split('-').reverse().join('.') : '—'}</td>
                <td style={{ ...td, maxWidth: 240 }}><div style={{ fontWeight: 600, color: C.txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name || '—'}{chg('name') && <span title={'vorher: ' + (r.name || '—')} style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: C.pri, background: hexA(C.pri, 0.14), borderRadius: 6, padding: '1px 5px' }}>KI</span>}{nameCount[nkey(r)] > 1 && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: C.sub, background: C.surf3, borderRadius: 6, padding: '1px 6px' }}>×{nameCount[nkey(r)]}</span>}</div>{e.beschreibung && e.beschreibung !== e.name && <div title={chg('beschreibung') ? 'vorher: ' + (r.beschreibung || '—') : undefined} style={{ fontSize: 11.5, color: chg('beschreibung') ? C.pri : C.mut, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{e.beschreibung}</div>}</td>
                <td style={{ ...td, ...NUM, whiteSpace: 'nowrap' }}>{e.nummer || '—'}{chg('nummer') && <span title="von der KI aus dem PDF ergänzt" style={{ marginLeft: 4, fontSize: 10, fontWeight: 800, color: C.pri }}>KI</span>}</td>
                <td style={td}>{e.kategorie ? <span title={chg('kategorie') ? 'vorher: ' + (r.kategorie || '—') : undefined} style={{ color: chg('kategorie') ? C.pri : C.txt, fontWeight: chg('kategorie') ? 700 : 400 }}>{e.kategorie}{chg('kategorie') ? ' ·KI' : ''}</span> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, ...NUM, textAlign: 'right', whiteSpace: 'nowrap', color: r.kind === 'ein' ? C.grn : C.txt, fontWeight: 600 }}>{(r.kind === 'ein') !== !!r.storno ? '+' : '−'}{fmt(r.brutto)}</td>
                <td style={{ ...td, ...NUM, color: chg('mwst') ? C.pri : undefined, fontWeight: chg('mwst') ? 700 : undefined }} title={chg('mwst') ? 'vorher: ' + r.mwst + ' %' : undefined}>{e.mwst} %</td>
                {withAcct && (() => { const s = aiOf(r); const manual = !!rowAcct[k + r.idx]; const unsure = s && !s.sure && !manual; return <td style={td}><select value={acctOf(k, r)} onChange={e => assign(r, e.target.value)} style={{ ...SS, fontSize: 12, padding: '4px 6px', width: 150, border: '1px solid ' + (unsure ? C.amb : 'transparent') }}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select>{s && <div title={s.why} style={{ fontSize: 11, marginTop: 3, color: manual ? C.mut : unsure ? C.amb : C.sub, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{manual ? 'von dir gewählt' : (unsure ? '? ' : 'KI: ') + (s.why || '')}</div>}</td>; })()}
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.file ? <><button onClick={() => openTab(r)} title={'Beleg in neuem Tab öffnen: ' + r.file} style={{ background: C.surf3, border: '1px solid ' + C.bdr, color: C.txt, borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Ansehen ↗</button> <button onClick={() => openView(rows.indexOf(r))} title="Beleg neben Konto und Notiz prüfen (blättern)" style={{ background: 'none', border: '1px solid ' + C.bdr, color: C.sub, borderRadius: 8, padding: '3px 7px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>⇆</button></> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, textAlign: 'center' }}>{r.file ? <input type="checkbox" checked={kiAll || !!kiRows[k + r.idx]} disabled={kiAll || off} onChange={e => setKiRows(p => ({ ...p, [k + r.idx]: e.target.checked }))} title="KI soll dieses PDF beim Import lesen" /> : <span style={{ color: C.mut }}>—</span>}</td>
                <td style={{ ...td, minWidth: big ? 280 : 170 }}><input value={(notes && notes[k + r.idx]) || ''} onChange={e => setNotes(n => ({ ...n, [k + r.idx]: e.target.value }))} onBlur={e => askNote(r, e.target.value)} placeholder="z. B. Material Wohnung 2" disabled={off} style={{ ...SS, width: '100%', fontSize: 12, padding: '5px 8px', textAlign: 'left', boxSizing: 'border-box' }} /></td>
                <td style={{ ...td, fontSize: 12, color: r.dup ? C.amb : (r.cancelled ? C.mut : C.exp) }}>{r.dup ? 'schon vorhanden' : r.cancelled ? 'storniert/Entwurf' : r.warn.join(', ')}{odiff.length > 0 && <div style={{ color: C.amb, fontWeight: 700 }}>{odiff.join(' · ')}</div>}{o && !o.error && (e !== r || odiff.length > 0) && <button onClick={() => setOcrOff(p => ({ ...p, [k + r.idx]: !p[k + r.idx] }))} style={{ marginTop: 3, background: 'none', border: 'none', color: C.mut, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}>{ocrOff[k + r.idx] ? 'KI-Korrektur wieder an' : 'KI-Korrektur aus'}</button>}{o && o.error && <div style={{ color: C.red }}>KI: {o.error}</div>}</td>
                {statusOf && (() => { const st = statusOf(k, r); const key = k + r.idx; const hasPdf = r.file || upPdf[key]; const small = { background: C.surf2, border: '1px solid ' + C.bdr, color: C.txt, borderRadius: 8, padding: '3px 8px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }; return (<>
                  <td style={{ ...td, minWidth: 190, maxWidth: 320 }}>{st.chips.map((c, i) => { const col = c.c === 'ok' ? C.grn : c.c === 'miss' ? C.red : c.c === 'ai' ? C.pri : C.amb; return <span key={i} style={{ display: 'inline-block', margin: '0 4px 4px 0', fontSize: 11, fontWeight: 700, color: col, background: hexA(col, 0.12), border: '1px solid ' + hexA(col, 0.35), borderRadius: 6, padding: '2px 7px', lineHeight: 1.35 }}>{c.t}</span>; })}{!st.chips.length && <span style={{ color: C.mut }}>—</span>}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {!hasPdf && <label style={{ ...small, display: 'inline-block', marginRight: 5 }}>PDF hochladen<input type="file" accept=".pdf,image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) setUpPdf(p => ({ ...p, [key]: { name: f.name, data: async () => new Uint8Array(await f.arrayBuffer()) } })); }} /></label>}
                    <button onClick={() => setLater(p => ({ ...p, [key]: !p[key] }))} style={{ ...small, marginRight: 5, background: later[key] ? hexA(C.pri, 0.16) : C.surf2 }}>{later[key] ? '✓ Für später' : 'Für später'}</button>
                    <button onClick={() => setSkip(sk => ({ ...sk, [key]: !sk[key] }))} style={small}>{skip[key] ? '✓ Ignoriert' : 'Ignorieren'}</button>
                  </td></>); })()}
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
