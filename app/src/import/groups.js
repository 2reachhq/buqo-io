// Buqo – Abbuchungsgruppen erkennen (reine Logik): wiederkehrende Zahlungen an/von derselben Stelle zu Vorschlägen bündeln.
const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');

// Bekannte Absender/Empfänger: mehrere Schreibweisen → eine Gruppe (Airbnb, Booking …), mit Kategorie-Vorschlag
export const FAMILIES = [
  { re: /airbnb/i, label: 'Airbnb', term: 'airbnb', cat: '' },
  { re: /booking\.?\s?com|bookingcom|booking\s?b\.?v/i, label: 'Booking.com', term: 'booking', cat: '' },
  { re: /amazon|amzn/i, label: 'Amazon', term: 'amazon', cat: 'Material' },
  { re: /paypal/i, label: 'PayPal', term: 'paypal', cat: '' },
  { re: /minijob|knappschaft|krankenkasse|\baok\b|techniker|\btk\b|barmer|\bikk\b|\bdak\b|\bhek\b|kkh|hkk|sozialversicherung|beitragsnachweis/i, label: 'Krankenkasse / Sozialabgaben', term: 'krankenkasse', terms: ['krankenkasse', 'knappschaft', 'minijob', 'aok', 'techniker', 'barmer', 'ikk', 'sozialversicherung'], cat: 'Personal' },
  { re: /finanzamt|steuerkasse|lohnsteuer|umsatzsteuer/i, label: 'Finanzamt', term: 'finanzamt', terms: ['finanzamt', 'steuerkasse'], cat: 'Steuern' },
  { re: /\blohn\b|gehalt|lohnabrechnung/i, label: 'Löhne / Gehalt', term: 'lohn', terms: ['lohn', 'gehalt'], cat: 'Personal' },
];
const familyOf = (text) => FAMILIES.find(f => f.re.test(text)) || null;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// rows: [{key, name, text, kind, datum, brutto}] → Vorschläge [{sid, name, terms, kind, category, monthly, keys, months, variable}]
// Voraussetzung: gleiche Stelle in mindestens `minMonths` verschiedenen Monaten (oder Familie mit ≥ 2 Buchungen).
export function detectGroups(rows, { catOf, minMonths = 3, skipKeys } = {}) {
  const map = new Map();
  rows.forEach(r => {
    if (!r.datum || !(r.brutto > 0) || (skipKeys && skipKeys.has(r.key))) return;
    const fam = familyOf(r.name + ' ' + (r.text || ''));
    const words = String(r.name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
    const first = words.slice(0, 2).join(' '); const base = norm(first);
    if (!fam && base.length < 4) return;
    const key = (r.kind === 'ein' ? 'e|' : 'a|') + (fam ? 'F:' + fam.label : base);
    let g = map.get(key); if (!g) { g = { fam, kind: r.kind === 'ein' ? 'ein' : 'aus', names: {}, rows: [], months: new Set(), base, first }; map.set(key, g); }
    g.rows.push(r); g.months.add(String(r.datum).slice(0, 7)); const nm = String(r.name || '').trim().slice(0, 40); g.names[nm] = (g.names[nm] || 0) + 1;
  });
  const mIdx = (iso) => { const s = String(iso || ''); return (+s.slice(0, 4)) * 12 + (+s.slice(5, 7)) - 1; };
  const latest = rows.reduce((a, r) => (r.datum && String(r.datum) > a ? String(r.datum) : a), '');
  const out = [];
  map.forEach((g, key) => {
    const amts = g.rows.map(r => r.brutto); const med = median(amts); const spread = med ? (Math.max(...amts) - Math.min(...amts)) / med : 1;
    const enough = g.months.size >= minMonths || (g.fam && g.rows.length >= 2) || (g.rows.length >= 2 && g.months.size >= 2 && spread < 0.03);
    if (!enough) return;
    const last = g.rows.reduce((a, r) => (String(r.datum) > a ? String(r.datum) : a), ''); const ongoing = !!latest && (mIdx(latest) - mIdx(last)) <= 1;
    const topName = Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0];
    const category = (g.fam && g.fam.cat) || (catOf ? catOf(topName + ' ' + (g.rows[0].text || '')) : '') || '';
    out.push({ sid: key, name: g.fam ? g.fam.label : topName, terms: g.fam ? (g.fam.terms || [g.fam.term]) : [g.first], kind: g.kind, category: category === 'Allgemein' ? '' : category, monthly: spread < 0.25 ? Math.round(med * 100) / 100 : '', variable: spread >= 0.25, keys: g.rows.map(r => r.key), months: g.months.size, count: g.rows.length, last, ongoing });
  });
  return out.sort((a, b) => b.count - a.count);
}
