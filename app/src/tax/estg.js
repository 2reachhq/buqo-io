// Buqo – deterministische Steuer-Engine (Deutschland, natürliche Person)
//
// Grundsatz wie im Rest der App: Alles hier wird REGELBASIERT berechnet, die KI erklärt
// die Ergebnisse nur. Keine Steuerberatung – Schätzung zur Planung (Rücklage, Nachzahlung,
// Optimierungs-Hebel). Gesetzesstand: Steuerfortentwicklungsgesetz (Dez. 2024) für 2025/2026.
//
// Reines ESM ohne React, damit es sich mit `node --test` prüfen lässt (siehe estg.test.js).

/* ── Parameter je Veranlagungszeitraum ───────────────────────────────────────── */
export const TAX_PARAMS = {
  2024: {
    gfb: 11784,                                             // Grundfreibetrag
    z2: { to: 17005, a: 954.80, b: 1400 },                  // (a·y + b)·y
    z3: { to: 66760, a: 181.19, b: 2397, c: 991.21 },       // (a·z + b)·z + c
    z4: { to: 277825, rate: 0.42, sub: 10636.31 },          // rate·x − sub
    z5: { rate: 0.45, sub: 18971.06 },
    soliFreigrenze: 18130, soliMilderung: 0.119, soliSatz: 0.055,
    kinderFreibetrag: 9312, kindergeldMonat: 250,
    ruerupMax: 27566, sonstigeVorsorgeMax: 2800, sonderausgabenPausch: 36,
    minijobGrenze: 538,
    kleinunternehmerVorjahr: 22000, kleinunternehmerLaufend: 50000,
    fristOhneBerater: '2025-07-31', fristMitBerater: '2026-04-30',
  },
  2025: {
    gfb: 12096,
    z2: { to: 17443, a: 932.30, b: 1400 },
    z3: { to: 68480, a: 176.64, b: 2397, c: 1015.13 },
    z4: { to: 277825, rate: 0.42, sub: 10911.92 },
    z5: { rate: 0.45, sub: 19246.67 },
    soliFreigrenze: 19950, soliMilderung: 0.119, soliSatz: 0.055,
    kinderFreibetrag: 9600, kindergeldMonat: 255,
    ruerupMax: 29344, sonstigeVorsorgeMax: 2800, sonderausgabenPausch: 36,
    minijobGrenze: 556,
    kleinunternehmerVorjahr: 25000, kleinunternehmerLaufend: 100000,
    fristOhneBerater: '2026-07-31', fristMitBerater: '2027-03-01',
  },
  2026: {
    gfb: 12348,
    z2: { to: 17799, a: 914.51, b: 1400 },
    z3: { to: 69878, a: 173.10, b: 2397, c: 1034.87 },
    z4: { to: 277825, rate: 0.42, sub: 11135.63 },
    z5: { rate: 0.45, sub: 19470.38 },
    soliFreigrenze: 20350, soliMilderung: 0.119, soliSatz: 0.055,
    kinderFreibetrag: 9756, kindergeldMonat: 259,
    ruerupMax: 29344, /* Höchstbetrag 2026 noch nicht amtlich – Wert 2025 als Näherung */
    sonstigeVorsorgeMax: 2800, sonderausgabenPausch: 36,
    minijobGrenze: 603,
    kleinunternehmerVorjahr: 25000, kleinunternehmerLaufend: 100000,
    fristOhneBerater: '2027-08-02', fristMitBerater: '2028-02-29',
  },
};
// Gemeinsame Konstanten (jahresunabhängig bzw. seit Jahren stabil)
export const CONST = {
  gewstFreibetrag: 24500,     // §11 Abs. 1 GewStG (natürliche Personen / Personengesellschaften)
  gewstMesszahl: 0.035,       // §11 Abs. 2 GewStG
  gewstAnrechnung: 4.0,       // §35 EStG: 4,0 × Messbetrag
  iabQuote: 0.5,              // §7g EStG: 50 % der geplanten Anschaffungskosten
  iabGewinnGrenze: 200000,    // §7g: Gewinn ≤ 200.000 €
  homeofficeTag: 6, homeofficeMax: 1260,     // §4 Abs. 5 Nr. 6c EStG
  gwgNetto: 800,              // §6 Abs. 2 EStG
  p35aMinijob: { satz: 0.2, max: 510 },           // §35a Abs. 1
  p35aDienst:  { satz: 0.2, max: 4000 },          // §35a Abs. 2
  p35aHandwerk:{ satz: 0.2, max: 1200 },          // §35a Abs. 3
  verspaetungProMonat: 0.0025, verspaetungMinMonat: 25,   // §152 AO
  nachzahlungszinsProMonat: 0.0015,               // §233a/§238 AO (1,8 % p. a.)
};

export const YEARS = Object.keys(TAX_PARAMS).map(Number);
export const paramsFor = (year) => TAX_PARAMS[year] || TAX_PARAMS[Math.max(...YEARS)];

const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const r2 = (v) => Math.round(v * 100) / 100;
const clamp0 = (v) => Math.max(0, v);

/* ── §32a EStG: Grundtarif ───────────────────────────────────────────────────── */
export function einkommensteuerTarif(zvE, year) {
  const p = paramsFor(year);
  const x = Math.floor(clamp0(n(zvE)));           // auf vollen Euro abgerundet
  let est = 0;
  if (x <= p.gfb) est = 0;
  else if (x <= p.z2.to) { const y = (x - p.gfb) / 10000; est = (p.z2.a * y + p.z2.b) * y; }
  else if (x <= p.z3.to) { const z = (x - p.z2.to) / 10000; est = (p.z3.a * z + p.z3.b) * z + p.z3.c; }
  else if (x <= p.z4.to) est = p.z4.rate * x - p.z4.sub;
  else est = p.z5.rate * x - p.z5.sub;
  return Math.floor(clamp0(est));                 // §32a Abs. 1 S. 6: abrunden
}
// Splittingtarif (§32a Abs. 5): 2 × Tarif(zvE/2)
export function einkommensteuer(zvE, year, zusammen) {
  if (!zusammen) return einkommensteuerTarif(zvE, year);
  return 2 * einkommensteuerTarif(Math.floor(clamp0(n(zvE)) / 2), year);
}
// Grenzsteuersatz (numerisch über +1.000 €)
export function grenzsteuersatz(zvE, year, zusammen) {
  const a = einkommensteuer(zvE, year, zusammen), b = einkommensteuer(n(zvE) + 1000, year, zusammen);
  return (b - a) / 1000;
}

/* ── Solidaritätszuschlag ────────────────────────────────────────────────────── */
export function soli(est, year, zusammen) {
  const p = paramsFor(year);
  const fg = p.soliFreigrenze * (zusammen ? 2 : 1);
  const e = clamp0(n(est));
  if (e <= fg) return 0;
  return Math.floor(Math.min(e * p.soliSatz, (e - fg) * p.soliMilderung) * 100) / 100;
}

/* ── Gewerbesteuer ───────────────────────────────────────────────────────────── */
export function gewerbesteuer(gewerbeertrag, hebesatz) {
  const ertrag = Math.floor(clamp0(n(gewerbeertrag)) / 100) * 100;             // auf volle 100 € abrunden
  const basis = clamp0(ertrag - CONST.gewstFreibetrag);
  const messbetrag = r2(basis * CONST.gewstMesszahl);
  const steuer = r2(messbetrag * n(hebesatz) / 100);
  return { ertrag, basis, messbetrag, steuer };
}

/* ── Gesamtrechnung ──────────────────────────────────────────────────────────── */
/**
 * @param {object} inp
 *  year, zusammen(bool), kirche (0|8|9), hebesatz
 *  einkuenfte: { gewerbe, freiberuf, vv, nichtselbst, sonstige }   (Gewinn/Verlust je Einkunftsart, netto)
 *  vorsorge:   { kvpv, altersvorsorge, sonstige }
 *  sonderausgaben (Spenden, gezahlte KiSt …), kinder (Anzahl, volle Freibeträge), behinderung … (ignoriert)
 *  p35a: { minijobHaushalt, dienstleistungen, handwerker }  (Aufwendungen, nicht Ermäßigung)
 *  vorauszahlungen: { est, soli, kist, gewst }
 */
export function berechneSteuer(inp) {
  const year = n(inp.year) || 2025;
  const p = paramsFor(year);
  const zusammen = !!inp.zusammen;
  const E = inp.einkuenfte || {};
  const ek = { gewerbe: n(E.gewerbe), freiberuf: n(E.freiberuf), vv: n(E.vv), nichtselbst: n(E.nichtselbst), sonstige: n(E.sonstige) };
  const summeEinkuenfte = r2(ek.gewerbe + ek.freiberuf + ek.vv + ek.nichtselbst + ek.sonstige);
  const positive = Object.values(ek).filter(v => v > 0).reduce((s, v) => s + v, 0);

  // Vorsorgeaufwendungen (vereinfachtes Schema: Altersvorsorge bis Höchstbetrag zu 100 %,
  // Basis-KV/PV zu 100 %, sonstige Vorsorge nur soweit 2.800 € nicht schon durch KV/PV belegt)
  const V = inp.vorsorge || {};
  const altersvorsorge = Math.min(clamp0(n(V.altersvorsorge)), p.ruerupMax * (zusammen ? 2 : 1));
  const kvpv = clamp0(n(V.kvpv));
  const sonstigeMax = p.sonstigeVorsorgeMax * (zusammen ? 2 : 1);
  const sonstigeVorsorge = clamp0(Math.min(n(V.sonstige), sonstigeMax - kvpv));
  const vorsorgeAbz = r2(altersvorsorge + kvpv + sonstigeVorsorge);
  const sonderausgaben = Math.max(p.sonderausgabenPausch * (zusammen ? 2 : 1), clamp0(n(inp.sonderausgaben)));

  const gdE = summeEinkuenfte;                                    // Gesamtbetrag der Einkünfte (ohne Altersentlastung)
  const einkommen = gdE - vorsorgeAbz - sonderausgaben;            // Einkommen
  const zvEOhneKinder = Math.floor(clamp0(einkommen));

  // Kinder: Günstigerprüfung Kindergeld vs. Freibetrag (§31 EStG)
  const kinder = Math.max(0, Math.floor(n(inp.kinder)));
  const kinderFreibetrag = kinder * p.kinderFreibetrag * (zusammen ? 1 : 0.5);
  const kindergeld = kinder * p.kindergeldMonat * 12;
  const estOhneKinder = einkommensteuer(zvEOhneKinder, year, zusammen);
  const zvEMitKindern = Math.floor(clamp0(einkommen - kinderFreibetrag));
  const estMitKindern = einkommensteuer(zvEMitKindern, year, zusammen);
  const freibetragGuenstiger = kinder > 0 && (estOhneKinder - estMitKindern) > kindergeld;
  const zvE = freibetragGuenstiger ? zvEMitKindern : zvEOhneKinder;
  // tarifliche ESt (bei Freibetrag: Kindergeld wird hinzugerechnet)
  const estTarif = freibetragGuenstiger ? estMitKindern + kindergeld : estOhneKinder;
  const kinderVorteil = freibetragGuenstiger ? (estOhneKinder - estMitKindern) - kindergeld : 0;

  // Gewerbesteuer + §35-Anrechnung
  const gew = gewerbesteuer(ek.gewerbe, n(inp.hebesatz) || 400);
  const anteilGewerbe = positive > 0 ? clamp0(ek.gewerbe) / positive : 0;
  const ermaessigungHoechst = r2((freibetragGuenstiger ? estMitKindern : estOhneKinder) * anteilGewerbe);
  const p35 = r2(Math.min(CONST.gewstAnrechnung * gew.messbetrag, gew.steuer, ermaessigungHoechst));

  // §35a (haushaltsnahe Beschäftigung / Dienstleistungen / Handwerker) – nur Privathaushalt
  const A = inp.p35a || {};
  const p35aMini = r2(Math.min(clamp0(n(A.minijobHaushalt)) * CONST.p35aMinijob.satz, CONST.p35aMinijob.max));
  const p35aDienst = r2(Math.min(clamp0(n(A.dienstleistungen)) * CONST.p35aDienst.satz, CONST.p35aDienst.max));
  const p35aHandwerk = r2(Math.min(clamp0(n(A.handwerker)) * CONST.p35aHandwerk.satz, CONST.p35aHandwerk.max));
  const p35aGesamt = r2(Math.min(p35aMini + p35aDienst + p35aHandwerk, clamp0(estTarif - p35)));

  const estFest = r2(clamp0(estTarif - p35 - p35aGesamt));        // festzusetzende ESt
  // Soli/KiSt: Bemessungsgrundlage ist die ESt unter Ansatz der Kinderfreibeträge (§3 SolZG, §51a EStG)
  const bmgZuschlag = r2(clamp0((kinder > 0 ? estMitKindern : estOhneKinder) - p35 - p35aGesamt));
  const soliBetrag = soli(bmgZuschlag, year, zusammen);
  const kircheSatz = [8, 9].includes(Number(inp.kirche)) ? Number(inp.kirche) : 0;
  const kist = r2(bmgZuschlag * kircheSatz / 100);

  const gesamt = r2(estFest + soliBetrag + kist + gew.steuer);
  const Vz = inp.vorauszahlungen || {};
  const vorausgezahlt = r2(clamp0(n(Vz.est)) + clamp0(n(Vz.soli)) + clamp0(n(Vz.kist)) + clamp0(n(Vz.gewst)));
  const nachzahlung = r2(gesamt - vorausgezahlt);

  return {
    year, zusammen, kircheSatz, hebesatz: n(inp.hebesatz) || 400,
    einkuenfte: ek, summeEinkuenfte, gdE,
    vorsorge: { altersvorsorge, kvpv, sonstige: sonstigeVorsorge, gesamt: vorsorgeAbz, ruerupMax: p.ruerupMax * (zusammen ? 2 : 1) },
    sonderausgaben, einkommen: r2(einkommen),
    kinder, kinderFreibetrag, kindergeld, freibetragGuenstiger, kinderVorteil,
    zvE, estTarif, p35, ermaessigungHoechst,
    p35a: { minijob: p35aMini, dienstleistungen: p35aDienst, handwerker: p35aHandwerk, gesamt: p35aGesamt },
    estFest, soli: soliBetrag, kist, gewerbe: gew,
    gesamt, vorausgezahlt, nachzahlung,
    ruecklageMonat: r2(gesamt / 12),
    effektiv: summeEinkuenfte > 0 ? gesamt / summeEinkuenfte : 0,
    grenz: grenzsteuersatz(zvE, year, zusammen),
    params: p,
  };
}

/* ── Optimierungs-Hebel (regelbasiert, mit €-Wirkung wo berechenbar) ─────────── */
/**
 * ctx: { heute (ISO), mitBerater(bool), geplanteInvestition, homeofficeTage, umsatz, vorsteuer,
 *        ausgabenOhneBeleg, anzahlOhneBeleg, afaFehlt:[names], personalKosten, minijobsHaushalt }
 */
export function optimierungen(inp, res, ctx = {}) {
  const out = [];
  const p = res.params;
  const year = res.year;
  const re = (patch) => berechneSteuer({ ...inp, ...patch });
  const withGewinn = (delta) => {
    const ek = { ...res.einkuenfte };
    if (ek.gewerbe !== 0 || ek.freiberuf === 0) ek.gewerbe += delta; else ek.freiberuf += delta;
    return re({ einkuenfte: ek });
  };
  const ersparnisBeiAusgabe = (betrag) => r2(clamp0(res.gesamt - withGewinn(-betrag).gesamt));
  const gewinnBetrieb = res.einkuenfte.gewerbe + res.einkuenfte.freiberuf;
  const add = (o) => out.push({ ersparnis: null, prio: 5, typ: 'tipp', ...o });

  // 1) Frist / Verspätung
  const heute = ctx.heute ? new Date(ctx.heute) : new Date();
  const frist = new Date(ctx.mitBerater ? p.fristMitBerater : p.fristOhneBerater);
  if (heute > frist) {
    const monate = Math.max(1, Math.ceil((heute - frist) / (30.44 * 24 * 3600 * 1000)));
    const offenESt = clamp0(res.estFest - clamp0(n((inp.vorauszahlungen || {}).est)));
    const zuschlag = Math.min(25000, r2(monate * Math.max(CONST.verspaetungMinMonat, offenESt * CONST.verspaetungProMonat)));
    add({ id: 'frist', typ: 'achtung', prio: 0, titel: 'Abgabefrist ' + year + ' ist verstrichen', ersparnis: zuschlag,
      detail: 'Die Frist (' + frist.toLocaleDateString('de-DE') + (ctx.mitBerater ? ', mit Steuerberater' : ', ohne Steuerberater') + ') liegt ' + monate + ' Monat' + (monate === 1 ? '' : 'e') + ' zurück. Verspätungszuschlag: 0,25 % der festgesetzten Steuer je Monat, mindestens 25 €/Monat – aktuell ca. ' + fmtEur(zuschlag) + ', wächst monatlich. Jetzt abgeben spart jeden weiteren Monat.' + (ctx.mitBerater ? '' : ' Mit Steuerberater gilt die längere Frist bis ' + new Date(p.fristMitBerater).toLocaleDateString('de-DE') + '.') });
  } else {
    const tage = Math.ceil((frist - heute) / (24 * 3600 * 1000));
    add({ id: 'frist', typ: 'info', prio: 6, titel: 'Abgabefrist ' + year + ': ' + frist.toLocaleDateString('de-DE'), detail: 'Noch ' + tage + ' Tage' + (ctx.mitBerater ? ' (Frist mit Steuerberater).' : ' (ohne Steuerberater). Mit Steuerberater verlängert sich die Frist bis ' + new Date(p.fristMitBerater).toLocaleDateString('de-DE') + '.') });
  }

  // 2) Nachzahlung / Rücklage / Vorauszahlungen
  if (res.nachzahlung > 500) {
    const zins = r2(res.nachzahlung * CONST.nachzahlungszinsProMonat * 12);
    add({ id: 'ruecklage', typ: 'achtung', prio: 1, titel: 'Nachzahlung von ' + fmtEur(res.nachzahlung) + ' einplanen', ersparnis: null,
      detail: 'Vorauszahlungen decken die geschätzte Steuer nicht. Lege ' + fmtEur(res.ruecklageMonat) + ' pro Monat zurück. Ab 15 Monaten nach Jahresende fallen 1,8 % Zinsen p. a. an (ca. ' + fmtEur(zins) + ' je Jahr Verzug). Tipp: Vorauszahlungen beim Finanzamt anpassen lassen (§37 EStG), damit die Nachzahlung nicht auf einen Schlag kommt.' });
  } else if (res.nachzahlung < -500) {
    add({ id: 'erstattung', typ: 'sparen', prio: 2, titel: 'Voraussichtliche Erstattung ' + fmtEur(-res.nachzahlung), ersparnis: r2(-res.nachzahlung),
      detail: 'Du hast mehr vorausgezahlt als nötig. Erklärung früh abgeben = Geld früher zurück. Für das laufende Jahr kannst du eine Herabsetzung der Vorauszahlungen beantragen (mehr Liquidität).' });
  }

  // 3) Investitionsabzugsbetrag §7g
  if (gewinnBetrieb > 0 && gewinnBetrieb <= CONST.iabGewinnGrenze) {
    const inv = clamp0(n(ctx.geplanteInvestition));
    const iab = r2(inv * CONST.iabQuote);
    if (iab > 0) {
      add({ id: 'iab', typ: 'sparen', prio: 1, titel: 'Investitionsabzugsbetrag: ' + fmtEur(iab) + ' vorab absetzen', ersparnis: ersparnisBeiAusgabe(iab),
        detail: '50 % der geplanten Anschaffungen (' + fmtEur(inv) + ', z. B. Laptop, Kamera, Reinigungsgeräte) darfst du schon jetzt gewinnmindernd abziehen – bis zu 3 Jahre vor dem Kauf (§7g EStG). Voraussetzung: Gewinn ≤ 200.000 € und mind. 90 % betriebliche Nutzung.' });
    } else {
      add({ id: 'iab', typ: 'tipp', prio: 4, titel: 'Planst du Anschaffungen? Investitionsabzugsbetrag nutzen', ersparnis: ersparnisBeiAusgabe(5000),
        detail: 'Bei geplanten Investitionen von z. B. 10.000 € kannst du 5.000 € sofort absetzen (§7g EStG) – das wären hier rund ' + fmtEur(ersparnisBeiAusgabe(5000)) + ' weniger Steuer. Trag die geplante Summe im Steuerprofil ein, dann rechnet Buqo es konkret.' });
    }
  }

  // 4) Homeoffice-Pauschale
  const hoTage = clamp0(n(ctx.homeofficeTage));
  const hoBetrag = Math.min(hoTage * CONST.homeofficeTag, CONST.homeofficeMax);
  if (gewinnBetrieb > 0) {
    if (hoBetrag > 0) add({ id: 'homeoffice', typ: 'sparen', prio: 3, titel: 'Homeoffice-Pauschale ' + fmtEur(hoBetrag) + ' buchen', ersparnis: ersparnisBeiAusgabe(hoBetrag),
      detail: hoTage + ' Tage × 6 € (max. 1.260 €/Jahr, §4 Abs. 5 Nr. 6c EStG). Wenn noch nicht als Betriebsausgabe gebucht: als Zeile „Homeoffice-Pauschale" in der Firma anlegen.' });
    else add({ id: 'homeoffice', typ: 'tipp', prio: 5, titel: 'Homeoffice-Tage eintragen', ersparnis: ersparnisBeiAusgabe(CONST.homeofficeMax),
      detail: 'Für jeden Tag überwiegend zu Hause gearbeitet: 6 € pauschal, bis 1.260 €/Jahr – ohne Belege. Bei 210 Tagen wären das hier ca. ' + fmtEur(ersparnisBeiAusgabe(CONST.homeofficeMax)) + ' weniger Steuer.' });
  }

  // 5) Altersvorsorge (Rürup / Basisrente)
  const rest = clamp0(res.vorsorge.ruerupMax - res.vorsorge.altersvorsorge);
  if (rest > 0 && res.zvE > p.gfb) {
    const beispiel = Math.min(5000, rest);
    const sp = r2(clamp0(res.gesamt - re({ vorsorge: { ...(inp.vorsorge || {}), altersvorsorge: res.vorsorge.altersvorsorge + beispiel } }).gesamt));
    add({ id: 'ruerup', typ: 'sparen', prio: 3, titel: 'Basisrente: ' + fmtEur(beispiel) + ' einzahlen spart ' + fmtEur(sp), ersparnis: sp,
      detail: 'Beiträge zur Basisrente (Rürup) / gesetzlichen Rente sind zu 100 % absetzbar, bis ' + fmtEur(res.vorsorge.ruerupMax) + ' im Jahr. Noch ' + fmtEur(rest) + ' Spielraum. Dein Grenzsteuersatz liegt bei ' + Math.round(res.grenz * 100) + ' % – jeder eingezahlte Euro spart etwa ' + Math.round(res.grenz * 100) + ' Cent Steuer.' });
  }

  // 6) Gewerbesteuer / §35
  if (res.einkuenfte.gewerbe > 0) {
    const ueber = res.einkuenfte.gewerbe - CONST.gewstFreibetrag;
    if (ueber > 0 && ueber <= 6000) {
      add({ id: 'gewst-frei', typ: 'tipp', prio: 3, titel: 'Nur ' + fmtEur(ueber) + ' über dem Gewerbesteuer-Freibetrag', ersparnis: res.gewerbe.steuer,
        detail: 'Der Gewerbeertrag liegt knapp über 24.500 €. Vorgezogene Betriebsausgaben (z. B. Investitionsabzugsbetrag, Anschaffungen bis 800 € netto sofort abschreiben) könnten die Gewerbesteuer ganz vermeiden.' });
    }
    if (res.gewerbe.steuer > 0) {
      const restlast = r2(res.gewerbe.steuer - res.p35);
      add({ id: 'p35', typ: restlast > 50 ? 'info' : 'sparen', prio: 4, titel: restlast > 50 ? 'Gewerbesteuer-Restbelastung ' + fmtEur(restlast) : 'Gewerbesteuer wird fast voll auf die ESt angerechnet',
        detail: 'Von ' + fmtEur(res.gewerbe.steuer) + ' Gewerbesteuer werden ' + fmtEur(res.p35) + ' auf die Einkommensteuer angerechnet (§35 EStG, 4,0 × Messbetrag). ' + (restlast > 50 ? 'Bei Hebesatz ' + res.hebesatz + ' % bleibt eine echte Mehrbelastung. Prüfen, ob die Tätigkeit freiberuflich (§18) statt gewerblich einzuordnen ist – dann entfällt die Gewerbesteuer komplett.' : 'Bis Hebesatz 400 % ist die Gewerbesteuer damit praktisch neutral.') });
    }
  } else if (res.einkuenfte.freiberuf > CONST.gewstFreibetrag) {
    add({ id: 'freiberuf', typ: 'info', prio: 6, titel: 'Freiberuflich eingestuft – keine Gewerbesteuer', detail: 'Achte darauf, dass keine gewerblichen Tätigkeiten (z. B. Handel, Vermittlung, Werbeplatz-Verkauf) beigemischt sind – sonst kann die gesamte Tätigkeit gewerblich werden (Abfärbetheorie).' });
  }

  // 7) Vermietung: Verluste / AfA
  if (res.einkuenfte.vv < 0) {
    const sp = r2(clamp0(re({ einkuenfte: { ...res.einkuenfte, vv: 0 } }).gesamt - res.gesamt));
    add({ id: 'vv-verlust', typ: 'info', prio: 4, titel: 'Vermietungsverlust senkt deine Steuer um ca. ' + fmtEur(sp), ersparnis: sp,
      detail: 'Der Verlust aus Vermietung (' + fmtEur(res.einkuenfte.vv) + ') wird mit deinen anderen Einkünften verrechnet. Wichtig: Einkünfteerzielungsabsicht muss erkennbar sein (dauerhafte Vermietung, ortsübliche Miete ≥ 66 %).' });
  }
  if (Array.isArray(ctx.afaFehlt) && ctx.afaFehlt.length) {
    add({ id: 'afa', typ: 'achtung', prio: 2, titel: 'Gebäude-AfA fehlt bei ' + ctx.afaFehlt.join(', '), ersparnis: null,
      detail: 'Die Abschreibung des Gebäudes (2 % bzw. 3 %/Jahr vom Gebäudewert ohne Grundstück, Neubauten ab 10/2023 wahlweise 5 % degressiv) ist meist der größte Werbungskostenposten bei Vermietung. Trag den Gebäudewert im Steuerprofil ein – Buqo rechnet die AfA dann automatisch ein.' });
  }

  // 8) Belege
  const ohne = clamp0(n(ctx.ausgabenOhneBeleg));
  if (ohne > 0) {
    const risiko = r2(clamp0(withGewinn(ohne).gesamt - res.gesamt));
    add({ id: 'belege', typ: 'achtung', prio: 1, titel: (ctx.anzahlOhneBeleg || '') + ' Ausgaben ohne Beleg – bis zu ' + fmtEur(risiko) + ' Risiko', ersparnis: risiko,
      detail: 'Betriebsausgaben von ' + fmtEur(ohne) + ' haben keinen Beleg. Ohne Nachweis kann das Finanzamt sie streichen – das würde bis zu ' + fmtEur(risiko) + ' mehr Steuer bedeuten (plus verlorene Vorsteuer). Belege nachreichen: Foto hochladen reicht, Buqo ordnet sie zu.' });
  }

  // 9) Kleinunternehmer (§19 UStG)
  const umsatz = clamp0(n(ctx.umsatz));
  if (umsatz > 0 && umsatz <= p.kleinunternehmerVorjahr) {
    add({ id: 'kleinunternehmer', typ: 'tipp', prio: 5, titel: 'Umsatz unter ' + fmtEur(p.kleinunternehmerVorjahr) + ' – Kleinunternehmerregelung möglich',
      detail: 'Bei Umsatz ≤ ' + fmtEur(p.kleinunternehmerVorjahr) + ' im Vorjahr und ≤ ' + fmtEur(p.kleinunternehmerLaufend) + ' im laufenden Jahr kannst du auf Umsatzsteuer verzichten (§19 UStG): keine UStVA, einfachere Rechnungen. Nachteil: kein Vorsteuerabzug' + (n(ctx.vorsteuer) > 0 ? ' (du hattest ' + fmtEur(n(ctx.vorsteuer)) + ' Vorsteuer)' : '') + '. Lohnt sich vor allem bei Privatkunden.' });
  }

  // 10) Putzkräfte / Personal
  if (clamp0(n(ctx.personalKosten)) > 0) {
    add({ id: 'minijob', typ: 'info', prio: 5, titel: 'Personalkosten ' + fmtEur(n(ctx.personalKosten)) + ' – Minijob-Abgaben prüfen',
      detail: 'Für Reinigungskräfte im Betrieb (Ferienwohnung) zahlst du als Arbeitgeber ca. 31,5 % Pauschalabgaben auf den Lohn an die Minijob-Zentrale (bis ' + fmtEur(p.minijobGrenze) + '/Monat je Person). Der volle Aufwand ist Betriebsausgabe. Nutze den Minijob-Rechner unten für die genaue Summe.' });
  }
  if (res.p35a.gesamt > 0) {
    add({ id: 'p35a', typ: 'sparen', prio: 3, titel: 'Haushaltsnahe Leistungen: ' + fmtEur(res.p35a.gesamt) + ' direkt von der Steuer abgezogen', ersparnis: res.p35a.gesamt,
      detail: '20 % der Kosten für Minijob im Privathaushalt (max. 510 €), haushaltsnahe Dienstleistungen (max. 4.000 €) und Handwerker-Arbeitslohn (max. 1.200 €) mindern die Steuer direkt (§35a EStG). Nur bei Überweisung und mit Rechnung – keine Barzahlung.' });
  }

  // 11) Kinder
  if (res.kinder > 0) {
    add({ id: 'kinder', typ: 'info', prio: 6, titel: res.freibetragGuenstiger ? 'Kinderfreibetrag ist günstiger als Kindergeld (+' + fmtEur(res.kinderVorteil) + ')' : 'Kindergeld ist günstiger als der Kinderfreibetrag',
      detail: 'Das Finanzamt prüft automatisch (Günstigerprüfung). ' + (res.freibetragGuenstiger ? 'Der Freibetrag bringt dir zusätzlich ' + fmtEur(res.kinderVorteil) + ' gegenüber dem Kindergeld.' : 'Das Kindergeld (' + fmtEur(res.kindergeld) + '/Jahr) bleibt – der Freibetrag würde nichts zusätzlich bringen.') });
  }

  // 12) GWG (allgemein)
  if (gewinnBetrieb > 0) add({ id: 'gwg', typ: 'tipp', prio: 7, titel: 'Anschaffungen bis 800 € netto sofort absetzen', detail: 'Geringwertige Wirtschaftsgüter (Laptop, Monitor, Staubsauger …) bis 800 € netto werden im Kaufjahr komplett abgezogen statt über Jahre abgeschrieben. Teurere Geräte: lineare AfA über die Nutzungsdauer (PC/Laptop: 1 Jahr möglich).' });

  return out.sort((a, b) => a.prio - b.prio || (b.ersparnis || 0) - (a.ersparnis || 0));
}

/* ── Minijob-Rechner (Arbeitgeber-Sicht) ─────────────────────────────────────── */
// Sätze Minijob-Zentrale, Stand 2025 (gewerblich): RV 15 %, KV 13 %, Pauschsteuer 2 %,
// U1 1,1 %, U2 0,24 %, Insolvenzgeldumlage 0,15 %. Privathaushalt (Haushaltsscheck):
// RV 5 %, KV 5 %, Pauschsteuer 2 %, U1 1,1 %, U2 0,24 %, Unfallversicherung 1,6 %.
export const MINIJOB_SAETZE = {
  gewerbe: [['Rentenversicherung', 15], ['Krankenversicherung', 13], ['Pauschale Lohnsteuer', 2], ['Umlage U1 (Krankheit)', 1.1], ['Umlage U2 (Mutterschaft)', 0.24], ['Insolvenzgeldumlage', 0.15]],
  haushalt: [['Rentenversicherung', 5], ['Krankenversicherung', 5], ['Pauschale Lohnsteuer', 2], ['Umlage U1 (Krankheit)', 1.1], ['Umlage U2 (Mutterschaft)', 0.24], ['Unfallversicherung', 1.6]],
};
export function minijobKosten({ brutto, art = 'gewerbe', year = 2025, rvBefreit = false, monate = 12 }) {
  const p = paramsFor(year);
  const b = clamp0(n(brutto));
  const saetze = MINIJOB_SAETZE[art] || MINIJOB_SAETZE.gewerbe;
  const positionen = saetze.map(([name, satz]) => ({ name, satz, betrag: r2(b * satz / 100) }));
  const satzGesamt = r2(saetze.reduce((s, [, x]) => s + x, 0));
  const abgaben = r2(positionen.reduce((s, x) => s + x.betrag, 0));
  const anRV = rvBefreit ? 0 : r2(b * (art === 'haushalt' ? 13.6 : 3.6) / 100);   // Eigenanteil RV (18,6 % − AG-Anteil)
  const netto = r2(b - anRV);
  const m = Math.max(0, Math.min(12, Math.floor(n(monate)) || 12));
  const kostenMonat = r2(b + abgaben);
  const ermaessigung = art === 'haushalt' ? r2(Math.min(kostenMonat * m * CONST.p35aMinijob.satz, CONST.p35aMinijob.max)) : 0;
  return { brutto: b, art, monate: m, positionen, satzGesamt, abgaben, kostenMonat, kostenJahr: r2(kostenMonat * m), nettoArbeitnehmer: netto, rvEigenanteil: anRV, grenze: p.minijobGrenze, grenzeOk: b <= p.minijobGrenze, steuerermaessigung35a: ermaessigung };
}

/* ── Steuerberater-Zusammenfassung (Klartext) ────────────────────────────────── */
export function steuerberaterBrief({ res, hinweise = [], names = {}, offen = {}, profilText = [], absender = '' }) {
  const L = [];
  const y = res.year;
  L.push('Zusammenfassung Steuerjahr ' + y + ' – erstellt mit Buqo am ' + new Date().toLocaleDateString('de-DE'));
  L.push('');
  L.push('Hallo,');
  L.push('anbei meine vorbereitete Buchhaltung für ' + y + '. Alle Zahlen sind aus meinen Buchungen berechnet (Schätzung, bitte prüfen).');
  L.push('');
  L.push('EINKÜNFTE');
  const ek = res.einkuenfte;
  if (ek.gewerbe) L.push('  Gewerbebetrieb (' + (names.unternehmen || 'Firma') + '): ' + fmtEur(ek.gewerbe));
  if (ek.freiberuf) L.push('  Selbständige Arbeit §18 (' + (names.unternehmen || 'Firma') + '): ' + fmtEur(ek.freiberuf));
  if (ek.vv) L.push('  Vermietung und Verpachtung §21: ' + fmtEur(ek.vv));
  if (ek.nichtselbst) L.push('  Nichtselbständige Arbeit: ' + fmtEur(ek.nichtselbst));
  if (ek.sonstige) L.push('  Sonstige Einkünfte: ' + fmtEur(ek.sonstige));
  L.push('  Summe der Einkünfte: ' + fmtEur(res.summeEinkuenfte));
  L.push('');
  L.push('ABZÜGE');
  L.push('  Vorsorgeaufwendungen: ' + fmtEur(res.vorsorge.gesamt) + ' (Altersvorsorge ' + fmtEur(res.vorsorge.altersvorsorge) + ', KV/PV ' + fmtEur(res.vorsorge.kvpv) + ', sonstige ' + fmtEur(res.vorsorge.sonstige) + ')');
  L.push('  Sonderausgaben: ' + fmtEur(res.sonderausgaben));
  if (res.kinder) L.push('  Kinder: ' + res.kinder + ' (' + (res.freibetragGuenstiger ? 'Freibetrag günstiger' : 'Kindergeld günstiger') + ')');
  L.push('  Zu versteuerndes Einkommen (geschätzt): ' + fmtEur(res.zvE));
  L.push('');
  L.push('STEUER (SCHÄTZUNG)');
  L.push('  Einkommensteuer: ' + fmtEur(res.estFest) + (res.p35 ? ' (nach §35-Anrechnung ' + fmtEur(res.p35) + ')' : '') + (res.p35a.gesamt ? ' (nach §35a ' + fmtEur(res.p35a.gesamt) + ')' : ''));
  L.push('  Solidaritätszuschlag: ' + fmtEur(res.soli));
  if (res.kircheSatz) L.push('  Kirchensteuer (' + res.kircheSatz + ' %): ' + fmtEur(res.kist));
  if (res.gewerbe.steuer) L.push('  Gewerbesteuer (Hebesatz ' + res.hebesatz + ' %, Messbetrag ' + fmtEur(res.gewerbe.messbetrag) + '): ' + fmtEur(res.gewerbe.steuer));
  L.push('  Gesamt: ' + fmtEur(res.gesamt) + ' · bereits vorausgezahlt: ' + fmtEur(res.vorausgezahlt) + ' · ' + (res.nachzahlung >= 0 ? 'voraussichtliche Nachzahlung ' : 'voraussichtliche Erstattung ') + fmtEur(Math.abs(res.nachzahlung)));
  L.push('');
  if (profilText.length) { L.push('ANNAHMEN'); profilText.forEach(t => L.push('  • ' + t)); L.push(''); }
  const offenL = [];
  if (offen.ohneBeleg) offenL.push(offen.ohneBeleg + ' Ausgaben ohne Beleg (' + fmtEur(offen.ohneBelegSumme || 0) + ') – reiche ich nach');
  if (offen.ohneMwst) offenL.push(offen.ohneMwst + ' Buchungen ohne MwSt-Angabe');
  if (offen.afaFehlt && offen.afaFehlt.length) offenL.push('Gebäude-AfA für ' + offen.afaFehlt.join(', ') + ' noch nicht erfasst');
  if (offenL.length) { L.push('OFFENE PUNKTE'); offenL.forEach(t => L.push('  • ' + t)); L.push(''); }
  const fragen = hinweise.filter(h => h.typ === 'sparen' || h.typ === 'achtung').slice(0, 6);
  if (fragen.length) { L.push('BITTE PRÜFEN / FRAGEN'); fragen.forEach(h => L.push('  • ' + h.titel)); L.push(''); }
  L.push('Unterlagen: DATEV-Export (EXTF-Buchungsstapel + Belege als ZIP), EÜR, UStVA-Kennzahlen und SuSa sind in Buqo unter „Steuern" exportierbar.');
  L.push('');
  L.push('Viele Grüße' + (absender ? '\n' + absender : ''));
  return L.join('\n');
}

export function fmtEur(v) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n(v));
}
