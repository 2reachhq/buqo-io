import { test } from 'node:test';
import assert from 'node:assert/strict';
import { einkommensteuerTarif, einkommensteuer, soli, gewerbesteuer, berechneSteuer, optimierungen, minijobKosten, steuerberaterBrief, TAX_PARAMS } from './estg.js';

test('Tarif 2025: Grundfreibetrag und Zonengrenzen stetig', () => {
  assert.equal(einkommensteuerTarif(12096, 2025), 0);
  assert.equal(einkommensteuerTarif(0, 2025), 0);
  assert.equal(einkommensteuerTarif(-500, 2025), 0);
  // Zonenübergänge: kein Sprung > 1 € (Tarif ist stetig, nur Rundung)
  for (const y of [2024, 2025, 2026]) {
    const p = TAX_PARAMS[y];
    for (const x of [p.gfb, p.z2.to, p.z3.to, p.z4.to]) {
      const a = einkommensteuerTarif(x, y), b = einkommensteuerTarif(x + 1, y);
      assert.ok(b - a <= 1 && b >= a, `Sprung bei ${y}/${x}: ${a} → ${b}`);
    }
  }
});

test('Tarif 2025: Referenzwerte (Formel §32a EStG)', () => {
  // (176,64·z + 2.397)·z + 1.015,13 mit z=(20.000−17.443)/10.000 → 1.639,59 → 1.639
  assert.equal(einkommensteuerTarif(20000, 2025), 1639);
  assert.equal(einkommensteuerTarif(50000, 2025), 10691);
  // Zone 4: 0,42·100.000 − 10.911,92 = 31.088,08 → 31.088
  assert.equal(einkommensteuerTarif(100000, 2025), 31088);
  // Zone 5: 0,45·300.000 − 19.246,67 = 115.753,33 → 115.753
  assert.equal(einkommensteuerTarif(300000, 2025), 115753);
  // 2024 zum Vergleich höher (kleinerer Grundfreibetrag)
  assert.ok(einkommensteuerTarif(50000, 2024) > einkommensteuerTarif(50000, 2025));
  assert.ok(einkommensteuerTarif(50000, 2026) < einkommensteuerTarif(50000, 2025));
});

test('Tarif ist monoton steigend', () => {
  let prev = 0;
  for (let x = 0; x <= 400000; x += 250) { const v = einkommensteuerTarif(x, 2025); assert.ok(v >= prev); prev = v; }
});

test('Splitting halbiert Progression', () => {
  const einzel = einkommensteuer(80000, 2025, false);
  const zusammen = einkommensteuer(80000, 2025, true);
  assert.ok(zusammen < einzel);
  assert.equal(zusammen, 2 * einkommensteuerTarif(40000, 2025));
});

test('Soli: Freigrenze + Milderungszone', () => {
  assert.equal(soli(19950, 2025, false), 0);
  assert.equal(soli(20000, 2025, false), Math.floor((20000 - 19950) * 0.119 * 100) / 100);
  // weit oberhalb: voller Satz 5,5 %
  assert.equal(soli(100000, 2025, false), 5500);
  assert.equal(soli(39900, 2025, true), 0);
});

test('Gewerbesteuer: Freibetrag, Rundung, Hebesatz', () => {
  assert.deepEqual(gewerbesteuer(24500, 400), { ertrag: 24500, basis: 0, messbetrag: 0, steuer: 0 });
  const g = gewerbesteuer(44599, 400);
  assert.equal(g.ertrag, 44500);            // auf volle 100 € abgerundet
  assert.equal(g.basis, 20000);
  assert.equal(g.messbetrag, 700);
  assert.equal(g.steuer, 2800);
});

test('Gesamtrechnung: Gewerbe + Vermietung, §35 neutralisiert GewSt bis 400 %', () => {
  const r = berechneSteuer({ year: 2025, hebesatz: 400, einkuenfte: { gewerbe: 60000, vv: -4000 }, vorsorge: { kvpv: 6000 }, vorauszahlungen: { est: 5000 } });
  assert.equal(r.summeEinkuenfte, 56000);
  assert.equal(r.zvE, 56000 - 6000 - 36);
  assert.equal(r.gewerbe.steuer, gewerbesteuer(60000, 400).steuer);
  assert.equal(r.p35, r.gewerbe.steuer);     // 4,0 × Messbetrag = Steuer bei 400 %
  assert.equal(r.estFest, r.estTarif - r.p35);
  assert.equal(r.gesamt, Math.round((r.estFest + r.soli + r.kist + r.gewerbe.steuer) * 100) / 100);
  assert.equal(r.nachzahlung, Math.round((r.gesamt - 5000) * 100) / 100);
  assert.equal(r.kist, 0);
  // Hebesatz 480: Restbelastung bleibt
  const r2 = berechneSteuer({ year: 2025, hebesatz: 480, einkuenfte: { gewerbe: 60000, vv: -4000 }, vorsorge: { kvpv: 6000 } });
  assert.ok(r2.gewerbe.steuer > r2.p35);
  assert.ok(r2.gesamt > r.gesamt);
});

test('Kirchensteuer und §35a', () => {
  const base = berechneSteuer({ year: 2025, einkuenfte: { freiberuf: 40000 } });
  const kist = berechneSteuer({ year: 2025, kirche: 9, einkuenfte: { freiberuf: 40000 } });
  assert.equal(kist.kist, Math.round(base.estFest * 0.09 * 100) / 100);
  const a = berechneSteuer({ year: 2025, einkuenfte: { freiberuf: 40000 }, p35a: { minijobHaushalt: 4000, handwerker: 10000, dienstleistungen: 1000 } });
  assert.equal(a.p35a.minijob, 510);          // 20 % von 4.000 = 800, gedeckelt 510
  assert.equal(a.p35a.handwerker, 1200);      // 20 % von 10.000 = 2.000, gedeckelt 1.200
  assert.equal(a.p35a.dienstleistungen, 200);
  assert.equal(a.estFest, base.estFest - 1910);
});

test('Kinder: Günstigerprüfung', () => {
  const low = berechneSteuer({ year: 2025, kinder: 1, zusammen: true, einkuenfte: { freiberuf: 30000 } });
  assert.equal(low.freibetragGuenstiger, false);          // Kindergeld 3.060 > Steuerersparnis
  const high = berechneSteuer({ year: 2025, kinder: 1, zusammen: true, einkuenfte: { freiberuf: 250000 } });
  assert.equal(high.freibetragGuenstiger, true);
  assert.ok(high.kinderVorteil > 0);
});

test('Optimierungen liefern sortierte Hinweise mit €-Wirkung', () => {
  const inp = { year: 2025, hebesatz: 480, einkuenfte: { gewerbe: 30000, vv: -2000 }, vorsorge: { kvpv: 5000 } };
  const res = berechneSteuer(inp);
  const hints = optimierungen(inp, res, { heute: '2026-09-21', geplanteInvestition: 10000, homeofficeTage: 100, ausgabenOhneBeleg: 3000, anzahlOhneBeleg: 4, umsatz: 20000, vorsteuer: 900, afaFehlt: ['Immobilie 1'] });
  const ids = hints.map(h => h.id);
  for (const id of ['frist', 'iab', 'homeoffice', 'ruerup', 'belege', 'kleinunternehmer', 'afa', 'vv-verlust', 'gewst-frei']) assert.ok(ids.includes(id), 'fehlt: ' + id);
  const frist = hints.find(h => h.id === 'frist');
  assert.equal(frist.typ, 'achtung');                      // 31.07.2026 ist am 21.09.2026 verstrichen
  const iab = hints.find(h => h.id === 'iab');
  assert.ok(iab.ersparnis > 0 && iab.ersparnis < 5000);
  assert.ok(hints.every((h, i) => i === 0 || hints[i - 1].prio <= h.prio));
  // mit Berater: Frist noch offen
  const h2 = optimierungen(inp, res, { heute: '2026-09-21', mitBerater: true });
  assert.equal(h2.find(h => h.id === 'frist').typ, 'info');
});

test('Minijob-Rechner: Sätze 2025', () => {
  const g = minijobKosten({ brutto: 556, art: 'gewerbe', year: 2025 });
  assert.equal(g.satzGesamt, 31.49);
  assert.equal(g.abgaben, Math.round(556 * 0.3149 * 100) / 100);
  assert.equal(g.grenzeOk, true);
  assert.equal(g.kostenJahr, Math.round((556 + g.abgaben) * 12 * 100) / 100);
  const h = minijobKosten({ brutto: 400, art: 'haushalt', year: 2025 });
  assert.equal(h.satzGesamt, 14.94);
  assert.ok(h.steuerermaessigung35a <= 510 && h.steuerermaessigung35a > 0);
  assert.equal(minijobKosten({ brutto: 700, year: 2025 }).grenzeOk, false);
  assert.equal(minijobKosten({ brutto: 600, year: 2026 }).grenzeOk, true);
});

test('Steuerberater-Brief enthält Kernzahlen', () => {
  const inp = { year: 2025, einkuenfte: { gewerbe: 45000, vv: 3000 }, vorsorge: { kvpv: 4800 } };
  const res = berechneSteuer(inp);
  const txt = steuerberaterBrief({ res, hinweise: optimierungen(inp, res, { heute: '2026-01-10' }), names: { unternehmen: 'Designpeak' }, offen: { ohneBeleg: 3, ohneBelegSumme: 500 } });
  assert.match(txt, /Steuerjahr 2025/);
  assert.match(txt, /Designpeak/);
  assert.match(txt, /Vermietung und Verpachtung/);
  assert.match(txt, /3 Ausgaben ohne Beleg/);
  assert.match(txt, /Einkommensteuer: /);
});
