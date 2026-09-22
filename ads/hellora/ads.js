/*
 * ads.js – Inhalte der Hellora-Ads. Hier Texte, Farben und Dauern anpassen.
 *
 * Szenen-Typen:
 *   brand      { text?, kicker?, sub?, glow?: false }            Markenwort groß + Aurora
 *   words      { words: ['Einfach.', 'Klar.'] }                  ein Wort nach dem anderen
 *   statement  { kicker?, text, sub?, align?: 'center' }         Headline Wort für Wort
 *   shapes     { text, kicker?, shapes? }                         geometrische Formen + Headline
 *   list       { kicker?, text?, items: [...] }                   nummerierte Liste
 *   stat       { value, prefix?, suffix?, label?, decimals? }     Zahl zählt hoch
 *   cta        { text?, sub?, button?, buttonStyle?, url?, glow? } Abschluss mit Button
 *
 * Gemeinsame Felder: kind, dur (Sekunden), theme ('light' | 'dark').
 * In Texten: "\n" = Zeilenumbruch, *Wort* = Farbverlauf-Highlight.
 */

const THEME = {
  brand: 'Hellora',
  fps: 30,
  light: { bg: '#FFFFFF', fg: '#1D1D1F', muted: '#86868B', shape: '#EDEDF0', glow: 0.6 },
  dark:  { bg: '#000000', fg: '#F5F5F7', muted: '#8E8E93', shape: '#202024', glow: 0.8 },
  accent: '#0A84FF',
  gradient: ['#FF8A3D', '#FF4D8D', '#9B5CFF', '#3D8BFF'],
};

const ADS = {
  // 1) Intro – hell/dunkel im Wechsel, Marke → Claim → Statement → Grafik → CTA
  intro: {
    title: 'Intro (15 s)',
    scenes: [
      { kind: 'brand', theme: 'light', dur: 2.8, kicker: 'Neu', text: 'Hellora.' },
      { kind: 'words', theme: 'dark', dur: 3.3, words: ['Einfach.', 'Klar.', 'Modern.'] },
      { kind: 'statement', theme: 'light', dur: 3.9, kicker: 'Weniger ist mehr.', text: 'Alles, was du *brauchst*.\nNichts, was dich ablenkt.' },
      { kind: 'shapes', theme: 'dark', dur: 3.2, text: 'Design,\ndas mitdenkt.' },
      { kind: 'cta', theme: 'light', dur: 2.6, button: 'Jetzt entdecken', url: '' },
    ],
  },

  // 2) Features – dunkel, mit Liste und Zahl
  features: {
    title: 'Features (17 s)',
    scenes: [
      { kind: 'brand', theme: 'dark', dur: 2.8, text: 'Hellora', sub: 'Alles an einem Ort.' },
      { kind: 'list', theme: 'dark', dur: 4.6, kicker: 'Was dich erwartet', items: ['In Minuten eingerichtet', 'Alles an einem Ort', 'Immer auf dem neuesten Stand'] },
      { kind: 'stat', theme: 'dark', dur: 3.2, value: 100, suffix: ' %', label: 'Fokus auf das Wesentliche.' },
      { kind: 'shapes', theme: 'light', dur: 3.2, text: 'Reduziert.\nAuf den *Punkt*.' },
      { kind: 'cta', theme: 'dark', dur: 2.8, button: 'Jetzt entdecken', buttonStyle: 'accent', url: '', glow: true },
    ],
  },

  // 3) Statement – hell, editorial, ruhig
  statement: {
    title: 'Statement (13 s)',
    scenes: [
      { kind: 'statement', theme: 'light', dur: 3.6, align: 'center', text: 'Weniger Lärm.\nMehr *Hellora*.' },
      { kind: 'words', theme: 'light', dur: 3.2, words: ['Schnell.', 'Schön.', 'Smart.'] },
      { kind: 'shapes', theme: 'light', dur: 3.4, text: 'Für Menschen,\ndie Klarheit lieben.' },
      { kind: 'cta', theme: 'light', dur: 2.8, sub: 'Der Anfang von etwas Einfachem.', button: 'Mehr erfahren', url: '' },
    ],
  },
};
