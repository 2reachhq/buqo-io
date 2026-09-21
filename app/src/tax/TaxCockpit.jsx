// Buqo – Steuer-Cockpit: Steuerprognose, Optimierungs-Hebel, Minijob-Rechner, Steuerberater-Text.
// Alle Zahlen kommen deterministisch aus ./estg.js – die KI erklärt nur (wie überall in Buqo).
import React from 'react';
import { berechneSteuer, optimierungen, minijobKosten, steuerberaterBrief, paramsFor, CONST } from './estg.js';

const { useState, useMemo } = React;
const num = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const pct = v => (Math.round(v * 1000) / 10).toLocaleString('de-DE') + ' %';

export default function TaxCockpit(props) {
  const { ui, year, setYear, years, names, propIds, profile, setProfile, minijobs, setMinijobs, facts, aiInvoke, setToast, isMobile, goTab, children, absender } = props;
  const { C, SC, SS, NUM, fmt, Ic, P, hexA } = ui;
  const [aiBusy, setAiBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [openHint, setOpenHint] = useState(null);
  const [profOpen, setProfOpen] = useState(!isMobile);
  const [mjOpen, setMjOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);

  const pr = profile || {};
  const zusammen = pr.veranlagung === 'zusammen';
  const firmaArt = pr.firmaArt === 'freiberuf' ? 'freiberuf' : 'gewerbe';
  const propArt = pid => ((pr.propArt || {})[pid] === 'gewerbe' ? 'gewerbe' : 'vv');
  const afaFor = pid => { const w = num((pr.gebaeudewert || {})[pid]); const s = num((pr.afaSatz || {})[pid]) || 2; return w > 0 ? Math.round(w * s) / 100 : 0; };

  /* ── Einkünfte aus den Buchungen (facts) + Profil ── */
  const rows = useMemo(() => {
    const out = [];
    const f = facts || { acct: {} };
    const u = f.acct.unter || { inc: 0, exp: 0 };
    out.push({ key: 'unter', name: names.unternehmen || 'Firma', art: firmaArt, inc: u.inc, exp: u.exp, afa: 0, gewinn: u.inc - u.exp });
    propIds.forEach(pid => {
      const a = f.acct[pid] || { inc: 0, exp: 0, inserate: 0 };
      const inc = a.inc + (a.inserate || 0);
      const afa = afaFor(pid);
      out.push({ key: pid, name: names[pid] || pid, art: propArt(pid), inc, inserate: a.inserate || 0, exp: a.exp, afa, gewinn: inc - a.exp - afa });
    });
    return out;
  }, [facts, names, pr, propIds, firmaArt]);

  const ek = useMemo(() => {
    const e = { gewerbe: 0, freiberuf: 0, vv: 0, nichtselbst: num(pr.nichtselbst), sonstige: num(pr.sonstigeEinkuenfte) };
    rows.forEach(r => { e[r.art] += r.gewinn; });
    Object.keys(e).forEach(k => { e[k] = Math.round(e[k] * 100) / 100; });
    return e;
  }, [rows, pr.nichtselbst, pr.sonstigeEinkuenfte]);

  const inp = useMemo(() => ({
    year, zusammen, kirche: num(pr.kirche), hebesatz: num(pr.hebesatz) || 400,
    einkuenfte: ek,
    vorsorge: { kvpv: num(pr.kvpv), altersvorsorge: num(pr.altersvorsorge), sonstige: num(pr.sonstigeVorsorge) },
    sonderausgaben: num(pr.sonderausgaben), kinder: num(pr.kinder),
    p35a: { minijobHaushalt: num(pr.p35aMinijob), dienstleistungen: num(pr.p35aDienst), handwerker: num(pr.p35aHandwerk) },
    vorauszahlungen: { est: num(pr.vzEst), gewst: num(pr.vzGewst) },
  }), [year, zusammen, pr, ek]);
  const res = useMemo(() => berechneSteuer(inp), [inp]);
  const afaFehlt = rows.filter(r => r.key !== 'unter' && r.inc > 0 && r.art === 'vv' && afaFor(r.key) === 0).map(r => r.name);
  const hints = useMemo(() => optimierungen(inp, res, {
    mitBerater: !!pr.mitBerater, geplanteInvestition: num(pr.geplanteInvestition), homeofficeTage: num(pr.homeofficeTage),
    umsatz: facts && facts.umsatz, vorsteuer: facts && facts.vorsteuer, ausgabenOhneBeleg: facts && facts.ohneBeleg && facts.ohneBeleg.sum,
    anzahlOhneBeleg: facts && facts.ohneBeleg && facts.ohneBeleg.count, afaFehlt, personalKosten: facts && facts.personalKosten,
  }), [inp, res, pr, facts, afaFehlt.join('|')]);
  const p = paramsFor(year);
  const potenzial = hints.filter(h => h.typ === 'sparen' || h.typ === 'tipp').reduce((s, h) => s + (h.ersparnis || 0), 0);

  /* ── Minijobs ── */
  const mjList = Array.isArray(minijobs) ? minijobs : [];
  const mjCalc = mjList.map(m => ({ ...m, calc: minijobKosten({ brutto: num(m.brutto), art: m.art || 'gewerbe', year, rvBefreit: !!m.rvBefreit, monate: num(m.monate) || 12 }) }));
  const mjJahr = mjCalc.reduce((s, m) => s + m.calc.kostenJahr, 0);
  const updMj = (id, patch) => setMinijobs(mjList.map(m => m.id === id ? { ...m, ...patch } : m));
  const addMj = () => setMinijobs([...mjList, { id: Math.random().toString(36).slice(2, 9), name: 'Putzkraft ' + (mjList.length + 1), brutto: '', art: 'gewerbe', monate: 12, rvBefreit: true }]);
  const delMj = id => setMinijobs(mjList.filter(m => m.id !== id));

  /* ── Steuerberater-Text ── */
  const profilText = [
    'Veranlagung: ' + (zusammen ? 'Zusammenveranlagung (Splitting)' : 'Einzelveranlagung') + (res.kircheSatz ? ', Kirchensteuer ' + res.kircheSatz + ' %' : ', keine Kirchensteuer'),
    (names.unternehmen || 'Firma') + ' als ' + (firmaArt === 'gewerbe' ? 'Gewerbebetrieb (Hebesatz ' + res.hebesatz + ' %)' : 'freiberufliche Tätigkeit (§18 EStG)'),
    ...rows.filter(r => r.key !== 'unter' && (r.inc || r.exp)).map(r => r.name + ': ' + (r.art === 'vv' ? 'Vermietung & Verpachtung' : 'gewerblich (z. B. Kurzzeitvermietung mit Service)') + (r.afa ? ', AfA ' + fmt(r.afa) : ', keine AfA erfasst')),
  ];
  const briefText = useMemo(() => steuerberaterBrief({ res, hinweise: hints, names, absender, profilText, offen: { ohneBeleg: facts && facts.ohneBeleg && facts.ohneBeleg.count, ohneBelegSumme: facts && facts.ohneBeleg && facts.ohneBeleg.sum, ohneMwst: facts && facts.ohneMwst, afaFehlt } }), [res, hints, names, facts, afaFehlt.join('|'), absender]);
  const briefShown = pr.briefAi && pr.briefAiBase === briefText ? pr.briefAi : briefText;
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); setToast('In die Zwischenablage kopiert'); } catch (e) { setToast('Kopieren nicht möglich – Text markieren und kopieren.'); } };
  const download = (t) => { try { const blob = new Blob([t], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'Steuerberater_' + year + '.txt'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); } catch (e) { setToast('Download fehlgeschlagen'); } };

  /* ── KI erklärt (rechnet nicht) ── */
  const explain = async (force) => {
    if (aiBusy) return;
    if (!force && pr.aiText && pr.aiSig === sig(res)) return;
    setAiBusy(true);
    try {
      const sys = 'Du bist Buqo, die persönliche KI-Buchhaltung des Nutzers. Du bekommst FERTIG BERECHNETE Steuerzahlen und Hebel – rechne nichts nach und erfinde keine Zahlen. Sprich den Nutzer direkt an, Ich-Form („ich habe deine Zahlen durchgerechnet"), einfache Sprache, KEIN Markdown, 5–8 kurze Sätze: Was kommt auf ihn zu und warum (größte Treiber)? Was sollte er jetzt tun (Rücklage, die 2–3 wirksamsten Hebel)? Beträge in Euro. Letzter Satz: Schätzung ohne Gewähr, Steuerberater prüft.';
      const usr = JSON.stringify({ jahr: year, einkuenfte: res.einkuenfte, summeEinkuenfte: res.summeEinkuenfte, zvE: res.zvE, einkommensteuer: res.estFest, soli: res.soli, kirchensteuer: res.kist, gewerbesteuer: res.gewerbe.steuer, gewerbesteuerAngerechnet: res.p35, gesamt: res.gesamt, vorausgezahlt: res.vorausgezahlt, nachzahlung: res.nachzahlung, ruecklageProMonat: res.ruecklageMonat, grenzsteuersatzProzent: Math.round(res.grenz * 100), hebel: hints.slice(0, 6).map(h => ({ typ: h.typ, titel: h.titel, wirkungEuro: h.ersparnis })) });
      const { data: resp, error } = await aiInvoke({ body: { model: 'claude-haiku-4-5', max_tokens: 700, system: sys, messages: [{ role: 'user', content: usr }] } });
      if (error) throw error; if (resp && resp.error) throw new Error(resp.error.message || 'KI-Fehler');
      const text = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
      if (text) setProfile({ aiText: text, aiSig: sig(res), aiTs: new Date().toISOString() });
    } catch (e) { setToast('Erklärung fehlgeschlagen: ' + (e.message || e)); }
    setAiBusy(false);
  };
  const briefAi = async () => {
    if (briefBusy) return; setBriefBusy(true);
    try {
      const sys = 'Formuliere aus der folgenden Zusammenfassung eine kurze, professionelle E-Mail an meinen Steuerberater. Behalte ALLE Zahlen und Punkte exakt bei, erfinde nichts dazu, KEIN Markdown, klare Absätze. Beginne mit einer Anrede, ende mit Grußformel.';
      const { data: resp, error } = await aiInvoke({ body: { model: 'claude-sonnet-4-6', max_tokens: 1400, system: sys, messages: [{ role: 'user', content: briefText }] } });
      if (error) throw error; if (resp && resp.error) throw new Error(resp.error.message || 'KI-Fehler');
      const text = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
      if (text) setProfile({ briefAi: text, briefAiBase: briefText });
    } catch (e) { setToast('Ausformulieren fehlgeschlagen: ' + (e.message || e)); }
    setBriefBusy(false);
  };

  /* ── kleine UI-Bausteine ── */
  const card = { ...SC, padding: isMobile ? '16px 16px' : '20px 22px' };
  const lbl = { fontSize: 12, color: C.sub, marginBottom: 5, fontWeight: 600 };
  const fld = { ...SS, textAlign: 'left', border: '1px solid ' + C.bdr, borderRadius: 10, padding: '9px 11px', fontSize: 13.5 };
  const ctx = { C, NUM, fld, lbl, pr, setProfile };
  const btn = (primary) => ({ display: 'inline-flex', alignItems: 'center', gap: 7, background: primary ? C.act : C.surf2, color: primary ? C.actTxt : C.txt, border: primary ? 'none' : '1px solid ' + C.bdr, borderRadius: 11, padding: '10px 15px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' });
  const TYP = { achtung: { c: C.exp, l: 'Achtung' }, sparen: { c: C.grn, l: 'Sparen' }, tipp: { c: C.pri, l: 'Tipp' }, info: { c: C.amb, l: 'Info' } };
  const nach = res.nachzahlung;
  const artBadge = (art) => <span style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, background: C.surf3, borderRadius: 6, padding: '2px 7px', marginLeft: 8, whiteSpace: 'nowrap' }}>{art === 'vv' ? 'V+V §21' : art === 'freiberuf' ? 'Freiberuf §18' : 'Gewerbe §15'}</span>;

  return (<>
    {/* Kopf */}
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
      <div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 3 }}>Steuerprognose {year}</div>
        <div style={{ fontSize: 13, color: C.sub }}>Aus deinen Buchungen berechnet · Einkommensteuer, Soli, Kirchensteuer, Gewerbesteuer · Schätzung, keine Steuerberatung</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={year} onChange={e => setYear(+e.target.value)} style={{ ...SS, width: 96 }}>{years.map(y => <option key={y} value={y}>{y}</option>)}</select>
        <button onClick={() => goTab('steuern')} style={btn(false)}><Ic p={P.doc} sz={14} col={C.txt} /> UStVA · EÜR · DATEV</button>
      </div>
    </div>

    {/* Hero */}
    <div style={{ ...card, background: 'linear-gradient(135deg, ' + hexA(C.pri, 0.16) + ', ' + hexA(C.accent, 0.10) + ')', border: '1px solid ' + hexA(C.pri, 0.25), marginBottom: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.2fr 1fr 1fr', gap: isMobile ? 16 : 24, alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, marginBottom: 6 }}>Voraussichtliche Steuerlast {year}</div>
          <div style={{ fontSize: isMobile ? 38 : 46, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1, color: C.txt, ...NUM }}>{fmt(res.gesamt)}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
            {[['ESt', res.estFest], ['Soli', res.soli], ['KiSt', res.kist], ['GewSt', res.gewerbe.steuer]].filter(([, v]) => v > 0 || true).map(([l, v]) => (
              <span key={l} style={{ fontSize: 12, fontWeight: 600, color: v > 0 ? C.txt : C.mut, background: hexA(C.surf, 0.7), border: '1px solid ' + C.bdr, borderRadius: 8, padding: '4px 9px', ...NUM }}>{l} {fmt(v)}</span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, marginBottom: 6 }}>{nach >= 0 ? 'Voraussichtliche Nachzahlung' : 'Voraussichtliche Erstattung'}</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: nach > 0 ? C.exp : C.grn, ...NUM }}>{fmt(Math.abs(nach))}</div>
          <div style={{ fontSize: 12, color: C.mut, marginTop: 6, lineHeight: 1.5 }}>Bereits vorausgezahlt: {fmt(res.vorausgezahlt)} <button onClick={() => setProfOpen(true)} style={{ background: 'none', border: 'none', color: C.pri, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, padding: 0, fontWeight: 600 }}>ändern</button></div>
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, marginBottom: 6 }}>Monatlich zurücklegen</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: C.txt, ...NUM }}>{fmt(res.ruecklageMonat)}</div>
          <div style={{ fontSize: 12, color: C.mut, marginTop: 6, lineHeight: 1.5 }}>Effektiv {pct(res.effektiv)} · Grenzsteuersatz {pct(res.grenz)}</div>
        </div>
      </div>
      {/* Buqo erklärt */}
      <div style={{ marginTop: 18, borderTop: '1px solid ' + hexA(C.pri, 0.18), paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: ui.AI_GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic p={P.spark} sz={15} col="#fff" /></div>
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>Buqo erklärt dir deine Zahlen</div>
          <button onClick={() => explain(true)} disabled={aiBusy} style={{ ...btn(!pr.aiText), opacity: aiBusy ? 0.6 : 1 }}>{aiBusy ? 'Denkt nach…' : (pr.aiText && pr.aiSig === sig(res) ? 'Neu erklären' : 'Erklären lassen')}</button>
        </div>
        {pr.aiText && (
          <div style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6, color: C.txt, whiteSpace: 'pre-wrap' }}>{pr.aiText}{pr.aiSig !== sig(res) && <div style={{ fontSize: 11.5, color: C.amb, marginTop: 8 }}>Die Zahlen haben sich seit dieser Erklärung geändert – „Neu erklären" aktualisiert den Text.</div>}</div>
        )}
        {!pr.aiText && <div style={{ marginTop: 8, fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>Die KI rechnet nichts – sie erklärt die fertig berechneten Zahlen in Klartext und sagt dir, was du jetzt tun solltest.</div>}
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1.05fr) minmax(0,0.95fr)', gap: 14, marginBottom: 14, alignItems: 'start' }}>
      {/* Herleitung */}
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Wie sich die Steuer zusammensetzt</div>
        {rows.map(r => (
          <div key={r.key} style={{ borderBottom: '1px solid ' + C.sep, padding: '8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
              <span style={{ flex: 1, fontWeight: 600, color: C.txt, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}{artBadge(r.art)}</span>
              <span style={{ fontWeight: 700, color: r.gewinn >= 0 ? C.txt : C.exp, ...NUM }}>{fmt(r.gewinn)}</span>
            </div>
            <div style={{ fontSize: 11.5, color: C.mut, marginTop: 3, ...NUM }}>Einnahmen {fmt(r.inc)}{r.inserate ? ' (davon Inserate ' + fmt(r.inserate) + ')' : ''} − Ausgaben {fmt(r.exp)}{r.afa ? ' − AfA ' + fmt(r.afa) : ''}</div>
          </div>
        ))}
        {(res.einkuenfte.nichtselbst || res.einkuenfte.sonstige) ? <Row C={C} NUM={NUM} l="Weitere Einkünfte" sub="Anstellung, Sonstiges" v={fmt(res.einkuenfte.nichtselbst + res.einkuenfte.sonstige)} /> : null}
        <Row C={C} NUM={NUM} l="Summe der Einkünfte" v={fmt(res.summeEinkuenfte)} bold />
        <Row C={C} NUM={NUM} l="Vorsorgeaufwendungen" sub="KV/PV, Altersvorsorge" v={'− ' + fmt(res.vorsorge.gesamt)} indent />
        <Row C={C} NUM={NUM} l="Sonderausgaben" v={'− ' + fmt(res.sonderausgaben)} indent />
        {res.freibetragGuenstiger && <Row C={C} NUM={NUM} l="Kinderfreibeträge" v={'− ' + fmt(res.kinderFreibetrag)} indent />}
        <Row C={C} NUM={NUM} l="Zu versteuerndes Einkommen" v={fmt(res.zvE)} bold />
        <Row C={C} NUM={NUM} l={'Einkommensteuer (Tarif ' + year + (zusammen ? ', Splitting' : '') + ')'} v={fmt(res.estTarif)} />
        {res.p35 > 0 && <Row C={C} NUM={NUM} l="Anrechnung Gewerbesteuer §35" v={'− ' + fmt(res.p35)} indent />}
        {res.p35a.gesamt > 0 && <Row C={C} NUM={NUM} l="Haushaltsnahe Leistungen §35a" v={'− ' + fmt(res.p35a.gesamt)} indent />}
        <Row C={C} NUM={NUM} l="Festzusetzende Einkommensteuer" v={fmt(res.estFest)} bold />
        <Row C={C} NUM={NUM} l="Solidaritätszuschlag" sub={'Freigrenze ' + fmt(p.soliFreigrenze * (zusammen ? 2 : 1))} v={fmt(res.soli)} />
        {res.kircheSatz > 0 && <Row C={C} NUM={NUM} l={'Kirchensteuer ' + res.kircheSatz + ' %'} v={fmt(res.kist)} />}
        {res.einkuenfte.gewerbe > 0 && <Row C={C} NUM={NUM} l={'Gewerbesteuer'} sub={'Messbetrag ' + fmt(res.gewerbe.messbetrag) + ' × ' + res.hebesatz + ' %'} v={fmt(res.gewerbe.steuer)} />}
        <Row C={C} NUM={NUM} l="Gesamt" v={fmt(res.gesamt)} bold color={C.pri} />
        <div style={{ fontSize: 11, color: C.mut, marginTop: 10, lineHeight: 1.5 }}>Firma + Immobilien netto aus den Buchungen (ohne Privat). Inserate = Airbnb/Booking-Auszahlungen aus dem Inserate-Bereich. Vorsorge, Kinder, Vorauszahlungen kommen aus deinem Steuerprofil rechts.</div>
      </div>

      {/* Steuerprofil */}
      <div style={card}>
        <button onClick={() => setProfOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.txt, flex: 1 }}>Dein Steuerprofil {year}</span>
          <span style={{ display: 'inline-flex', transition: 'transform .16s', transform: profOpen ? 'rotate(180deg)' : 'none' }}><Ic p={P.down} sz={14} col={C.sub} /></span>
        </button>
        {!profOpen && <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6, lineHeight: 1.5 }}>{zusammen ? 'Zusammenveranlagung' : 'Einzelveranlagung'} · {res.kircheSatz ? 'KiSt ' + res.kircheSatz + ' %' : 'keine KiSt'} · Hebesatz {res.hebesatz} % · KV/PV {fmt(res.vorsorge.kvpv)} · Vorauszahlungen {fmt(res.vorausgezahlt)}</div>}
        {profOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div><div style={lbl}>Veranlagung</div><Seg C={C} options={[['einzel', 'Einzeln'], ['zusammen', 'Verheiratet (Splitting)']]} value={pr.veranlagung || 'einzel'} onChange={v => setProfile({ veranlagung: v })} /></div>
              <div><div style={lbl}>Kirchensteuer</div><Seg C={C} options={[[0, 'Nein'], [9, '9 % (NRW …)'], [8, '8 % (BY/BW)']]} value={num(pr.kirche)} onChange={v => setProfile({ kirche: v })} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div><div style={lbl}>{names.unternehmen || 'Firma'} ist</div><Seg C={C} options={[['gewerbe', 'Gewerbe'], ['freiberuf', 'Freiberuflich']]} value={firmaArt} onChange={v => setProfile({ firmaArt: v })} /></div>
              {firmaArt === 'gewerbe' && <div style={{ width: 130 }}><Field ctx={ctx} label="Hebesatz Gemeinde" k="hebesatz" suffix="%" placeholder="400" /></div>}
              <div style={{ width: 90 }}><Field ctx={ctx} label="Kinder" k="kinder" suffix="" placeholder="0" /></div>
            </div>
            {propIds.some(pid => (facts && facts.acct[pid] && (facts.acct[pid].inc || facts.acct[pid].exp || facts.acct[pid].inserate))) && (
              <div>
                <div style={{ ...lbl, marginBottom: 8 }}>Immobilien</div>
                {propIds.filter(pid => facts && facts.acct[pid] && (facts.acct[pid].inc || facts.acct[pid].exp || facts.acct[pid].inserate)).map(pid => (
                  <div key={pid} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid ' + C.sep }}>
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 110, flex: 1 }}>{names[pid] || pid}</span>
                    <Seg C={C} options={[['vv', 'Vermietung'], ['gewerbe', 'Gewerblich']]} value={propArt(pid)} onChange={v => setProfile({ propArt: { ...(pr.propArt || {}), [pid]: v } })} />
                    {propArt(pid) === 'vv' && <div style={{ position: 'relative', width: 140 }}><input value={(pr.gebaeudewert || {})[pid] ?? ''} onChange={e => setProfile({ gebaeudewert: { ...(pr.gebaeudewert || {}), [pid]: e.target.value } })} inputMode="decimal" placeholder="Gebäudewert" title="Anschaffungskosten des Gebäudes ohne Grundstück (AfA-Basis)" style={{ ...fld, paddingRight: 26, ...NUM }} /><span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: C.mut }}>€</span></div>}
                    {propArt(pid) === 'vv' && <select value={num((pr.afaSatz || {})[pid]) || 2} onChange={e => setProfile({ afaSatz: { ...(pr.afaSatz || {}), [pid]: +e.target.value } })} style={{ ...SS, width: 112 }}><option value={2}>AfA 2 %</option><option value={2.5}>AfA 2,5 %</option><option value={3}>AfA 3 %</option><option value={5}>AfA 5 %</option></select>}
                  </div>
                ))}
                <div style={{ fontSize: 11, color: C.mut, marginTop: 6, lineHeight: 1.45 }}>Gebäudewert = Kaufpreis ohne Grundstücksanteil. 2 % (Baujahr ab 1925), 2,5 % (vor 1925), 3 % (Fertigstellung ab 2023), 5 % degressiv (Neubau ab 10/2023). Gewerblich = Kurzzeitvermietung mit hotelähnlichem Service.</div>
              </div>
            )}
            <div>
              <div style={{ ...lbl, marginBottom: 8 }}>Vorsorge & Sonderausgaben (Jahresbeträge)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Field ctx={ctx} label="Kranken-/Pflegevers." k="kvpv" />
                <Field ctx={ctx} label="Altersvorsorge (Rürup/GRV)" k="altersvorsorge" hint={'max. ' + fmt(res.vorsorge.ruerupMax)} />
                <Field ctx={ctx} label="Sonstige Vorsorge" k="sonstigeVorsorge" hint="Haftpflicht, Unfall, BU" />
                <Field ctx={ctx} label="Sonderausgaben" k="sonderausgaben" hint="Spenden, gezahlte KiSt" />
                <Field ctx={ctx} label="Einkünfte Anstellung" k="nichtselbst" hint="Brutto − 1.230 € Pauschale" />
                <Field ctx={ctx} label="Sonstige Einkünfte" k="sonstigeEinkuenfte" hint="z. B. Kapital > Freibetrag" />
              </div>
            </div>
            <div>
              <div style={{ ...lbl, marginBottom: 8 }}>Bereits geleistete Vorauszahlungen {year}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field ctx={ctx} label="Einkommensteuer (inkl. Soli/KiSt)" k="vzEst" />
                <Field ctx={ctx} label="Gewerbesteuer" k="vzGewst" />
              </div>
            </div>
            <div>
              <div style={{ ...lbl, marginBottom: 8 }}>Hebel & Privathaushalt (§35a)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Field ctx={ctx} label="Geplante Investitionen" k="geplanteInvestition" hint="für §7g (nächste 3 Jahre)" />
                <Field ctx={ctx} label="Homeoffice-Tage" k="homeofficeTage" suffix="Tage" />
                <Field ctx={ctx} label="Minijob im Privathaushalt" k="p35aMinijob" hint="Kosten/Jahr → 20 %, max. 510 €" />
                <Field ctx={ctx} label="Haushaltsnahe Dienstl." k="p35aDienst" hint="max. 4.000 € Ermäßigung" />
                <Field ctx={ctx} label="Handwerker (Arbeitslohn)" k="p35aHandwerk" hint="max. 1.200 € Ermäßigung" />
                <div><div style={lbl}>Steuerberater beauftragt?</div><Seg C={C} options={[[false, 'Nein'], [true, 'Ja']]} value={!!pr.mitBerater} onChange={v => setProfile({ mitBerater: v === true || v === 'true' })} /></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* Hebel */}
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>So sparst du – Hebel für {year}</div>
        {potenzial > 0 && <div style={{ fontSize: 12.5, color: C.grn, fontWeight: 700, ...NUM }}>Potenzial bis zu {fmt(potenzial)}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {hints.map(h => { const t = TYP[h.typ] || TYP.tipp; const open = openHint === h.id; return (
          <div key={h.id} style={{ background: C.surf2, border: '1px solid ' + (open ? hexA(t.c, 0.45) : C.bdr), borderRadius: 12, overflow: 'hidden' }}>
            <button onClick={() => setOpenHint(open ? null : h.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 'none', padding: '11px 14px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: t.c, background: hexA(t.c, 0.14), border: '1px solid ' + hexA(t.c, 0.35), borderRadius: 6, padding: '2px 7px', flexShrink: 0, letterSpacing: '0.03em', textTransform: 'uppercase' }}>{t.l}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: C.txt }}>{h.titel}</span>
              {h.ersparnis > 0 && <span style={{ fontSize: 12.5, fontWeight: 700, color: h.typ === 'achtung' ? C.exp : C.grn, ...NUM, whiteSpace: 'nowrap' }}>{h.typ === 'achtung' ? '' : '−'}{fmt(h.ersparnis)}</span>}
              <span style={{ display: 'inline-flex', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' }}><Ic p={P.down} sz={13} col={C.sub} /></span>
            </button>
            {open && <div style={{ padding: '0 14px 13px 14px', fontSize: 13.5, color: C.sub, lineHeight: 1.6 }}>{h.detail}</div>}
          </div>
        ); })}
      </div>
    </div>

    {/* Minijob-Rechner */}
    <div style={{ ...card, marginBottom: 14 }}>
      <button onClick={() => setMjOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: C.txt, flex: 1 }}>Putzkräfte & Minijobs – Arbeitgeberkosten {year}</span>
        {mjList.length > 0 && <span style={{ fontSize: 12.5, fontWeight: 700, color: C.txt, ...NUM }}>{fmt(mjJahr)} / Jahr</span>}
        <span style={{ display: 'inline-flex', transition: 'transform .16s', transform: mjOpen ? 'rotate(180deg)' : 'none' }}><Ic p={P.down} sz={14} col={C.sub} /></span>
      </button>
      {!mjOpen && <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6, lineHeight: 1.5 }}>{mjList.length ? mjList.length + ' Minijob' + (mjList.length === 1 ? '' : 's') + ' erfasst · Pauschalabgaben gewerblich 31,49 %, Privathaushalt 14,94 % · Grenze ' + fmt(p.minijobGrenze) + '/Monat' : 'Rechnet Lohn + Pauschalabgaben (Minijob-Zentrale) je Reinigungskraft – gewerblich (Ferienwohnung) oder Privathaushalt (§35a).'}</div>}
      {mjOpen && (
        <div style={{ marginTop: 14 }}>
          {mjCalc.map(m => (
            <div key={m.id} style={{ background: C.surf2, border: '1px solid ' + C.bdr, borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={m.name || ''} onChange={e => updMj(m.id, { name: e.target.value })} placeholder="Name" style={{ ...fld, width: 150 }} />
                <div style={{ position: 'relative', width: 120 }}><input value={m.brutto ?? ''} onChange={e => updMj(m.id, { brutto: e.target.value })} inputMode="decimal" placeholder="Lohn/Monat" style={{ ...fld, paddingRight: 26, ...NUM }} /><span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: C.mut }}>€</span></div>
                <Seg C={C} options={[['gewerbe', 'Betrieb'], ['haushalt', 'Privathaushalt']]} value={m.art || 'gewerbe'} onChange={v => updMj(m.id, { art: v })} />
                <select value={num(m.monate) || 12} onChange={e => updMj(m.id, { monate: +e.target.value })} style={{ ...SS, width: 110 }}>{Array.from({ length: 12 }, (_, i) => 12 - i).map(k => <option key={k} value={k}>{k} Monate</option>)}</select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.sub, cursor: 'pointer' }}><input type="checkbox" checked={!!m.rvBefreit} onChange={e => updMj(m.id, { rvBefreit: e.target.checked })} /> RV-befreit</label>
                <button onClick={() => delMj(m.id)} title="Entfernen" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit' }}>×</button>
              </div>
              {num(m.brutto) > 0 && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '4px 24px', fontSize: 12.5 }}>
                  {m.calc.positionen.map(x => <div key={x.name} style={{ display: 'flex', justifyContent: 'space-between', color: C.sub }}><span>{x.name} ({x.satz.toLocaleString('de-DE')} %)</span><span style={NUM}>{fmt(x.betrag)}</span></div>)}
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: C.txt, fontWeight: 700, borderTop: '1px solid ' + C.sep, paddingTop: 6, marginTop: 4 }}><span>Abgaben gesamt ({m.calc.satzGesamt.toLocaleString('de-DE')} %)</span><span style={NUM}>{fmt(m.calc.abgaben)} / Monat</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: C.txt, fontWeight: 700, borderTop: '1px solid ' + C.sep, paddingTop: 6, marginTop: 4 }}><span>Kosten für dich</span><span style={NUM}>{fmt(m.calc.kostenMonat)} / Monat · {fmt(m.calc.kostenJahr)} / Jahr</span></div>
                  <div style={{ color: C.mut }}>Auszahlung an {m.name || 'Minijobber'}: {fmt(m.calc.nettoArbeitnehmer)}{m.calc.rvEigenanteil ? ' (RV-Eigenanteil ' + fmt(m.calc.rvEigenanteil) + ')' : ''}</div>
                  {!m.calc.grenzeOk && <div style={{ color: C.exp, fontWeight: 600 }}>Über der Minijob-Grenze von {fmt(p.minijobGrenze)} – dann Midijob mit vollen Sozialabgaben.</div>}
                  {m.art === 'haushalt' && m.calc.steuerermaessigung35a > 0 && <div style={{ color: C.grn, fontWeight: 600 }}>§35a: {fmt(m.calc.steuerermaessigung35a)} direkt von der Einkommensteuer abziehbar (im Profil unter „Minijob im Privathaushalt" eintragen).</div>}
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={addMj} style={btn(true)}><Ic p={P.plus} sz={14} col={C.actTxt} /> Minijob hinzufügen</button>
            <span style={{ fontSize: 11.5, color: C.mut, lineHeight: 1.5 }}>Sätze Minijob-Zentrale (Stand 2025), zzgl. Berufsgenossenschaft im Betrieb. Anmeldung über minijob-zentrale.de; Lohn ist Betriebsausgabe (Ferienwohnung) bzw. §35a-Ermäßigung (Privathaushalt).</span>
          </div>
        </div>
      )}
    </div>

    {/* Steuerberater-Text */}
    <div style={{ ...card, marginBottom: 14 }}>
      <button onClick={() => setBriefOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: C.txt, flex: 1 }}>Das soll mein Steuerberater wissen</span>
        <span style={{ display: 'inline-flex', transition: 'transform .16s', transform: briefOpen ? 'rotate(180deg)' : 'none' }}><Ic p={P.down} sz={14} col={C.sub} /></span>
      </button>
      {!briefOpen && <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6, lineHeight: 1.5 }}>Fertiger Text mit allen Zahlen, Annahmen und offenen Punkten – kopieren, als Datei laden oder von der KI als E-Mail ausformulieren lassen. Die Dateien (DATEV, EÜR, UStVA) exportierst du unter „Steuern".</div>}
      {briefOpen && (
        <div style={{ marginTop: 12 }}>
          <textarea readOnly value={briefShown} rows={isMobile ? 14 : 18} style={{ ...fld, width: '100%', resize: 'vertical', fontSize: 13, lineHeight: 1.55, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            <button onClick={() => copy(briefShown)} style={btn(true)}><Ic p={P.copy} sz={14} col={C.actTxt} /> Kopieren</button>
            <button onClick={() => download(briefShown)} style={btn(false)}><Ic p={P.dload} sz={14} col={C.txt} /> Als .txt</button>
            <button onClick={briefAi} disabled={briefBusy} style={{ ...btn(false), background: ui.AI_GRADIENT, color: '#fff', border: 'none', opacity: briefBusy ? 0.6 : 1 }}><Ic p={P.spark} sz={14} col="#fff" /> {briefBusy ? 'Formuliert…' : 'Als E-Mail ausformulieren (KI)'}</button>
            {pr.briefAi && pr.briefAiBase === briefText && <button onClick={() => setProfile({ briefAi: '', briefAiBase: '' })} style={{ background: 'none', border: 'none', color: C.mut, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Zurück zur Rohfassung</button>}
            <button onClick={() => goTab('steuern')} style={{ ...btn(false), marginLeft: 'auto' }}><Ic p={P.dload} sz={14} col={C.txt} /> DATEV-Paket exportieren</button>
          </div>
        </div>
      )}
    </div>

    {children}

    <div style={{ fontSize: 11, color: C.mut, lineHeight: 1.55, padding: '4px 2px 20px' }}>
      Berechnung nach §32a EStG (Tarif {year}), §35/§35a EStG, SolZG, GewStG (Freibetrag {fmt(CONST.gewstFreibetrag)}, Messzahl 3,5 %). Vereinfachungen: keine Hinzurechnungen/Kürzungen bei der Gewerbesteuer, Vorsorge nach dem gängigen Schema für Selbstständige, keine Verlustvorträge, keine Altersentlastung, Kirchensteuer ohne Sonderausgabenabzug. Ergebnis ist eine Planungsgröße – die verbindliche Berechnung macht der Steuerbescheid.
    </div>
  </>);
}

function Field({ ctx, label, k, suffix = '€', hint, placeholder = '0' }) {
  const { C, NUM, fld, lbl, pr, setProfile } = ctx;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={lbl}>{label}</div>
      <div style={{ position: 'relative' }}>
        <input value={pr[k] ?? ''} onChange={e => setProfile({ [k]: e.target.value })} inputMode="decimal" placeholder={placeholder} style={{ ...fld, paddingRight: suffix ? 34 : 11, ...NUM }} />
        {suffix && <span style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: C.mut }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: C.mut, marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}
function Seg({ C, options, value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 3, background: C.surf2, border: '1px solid ' + C.bdr, borderRadius: 10, padding: 3 }}>
      {options.map(([k, label]) => <button key={String(k)} onClick={() => onChange(k)} style={{ background: String(value) === String(k) ? C.pri : 'transparent', color: String(value) === String(k) ? C.priTxt : C.sub, border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>{label}</button>)}
    </div>
  );
}
function Row({ C, NUM, l, v, bold, color, sub, indent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + C.sep, fontSize: bold ? 14 : 13.5, paddingLeft: indent ? 14 : 0 }}>
      <span style={{ flex: 1, color: bold ? C.txt : C.sub, fontWeight: bold ? 700 : 500, minWidth: 0 }}>{l}{sub && <span style={{ fontSize: 11, color: C.mut, marginLeft: 6 }}>{sub}</span>}</span>
      <span style={{ fontWeight: bold ? 800 : 600, color: color || C.txt, ...NUM, whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
}

function sig(res) { return [res.year, res.gesamt, res.nachzahlung, res.zvE, res.gewerbe.steuer].join('|'); }
