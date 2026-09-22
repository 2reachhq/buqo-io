// Buqo-Assistent: reine Datenfunktionen (kein React, kein Netz). Sie lesen und verändern das
// App-Zustandsobjekt (`data`, `names`) unverändert-immutabel und geben neue Objekte zurück,
// damit main.jsx sie per setData/setNames anwenden kann. Dadurch sind sie testbar (node --test).

export const PROPS = ['p1', 'p2', 'p3'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const CATS = ['Allgemein', 'Miete', 'Nebenkosten', 'Versicherung', 'Material', 'Personal', 'Steuern', 'Software', 'Marketing', 'Reise', 'Bewirtung', 'Bank & Gebühren', 'Sonstiges'];
const COMPANY_FIELDS = ['name', 'address', 'email', 'phone', 'iban', 'bic', 'taxId', 'ustId', 'defMwst', 'invHeaderDefault', 'invFooterDefault', 'senderEmail', 'senderName', 'contactName', 'contactEmail'];
const PROFILE_FIELDS = ['name', 'phone', 'contactEmail', 'role'];
const TAX_FIELDS = ['veranlagung', 'kirche', 'hebesatz', 'firmaArt', 'kvpv', 'altersvorsorge', 'sonstigeVorsorge', 'sonderausgaben', 'kinder', 'vzEst', 'vzGewst'];
const THEME_COLOR_KEYS = ['pri', 'act', 'accent', 'grn', 'exp', 'red', 'amb'];
const ICONS = ['house', 'bed', 'brief', 'prson', 'grid', 'cal', 'doc'];

export const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(n) ? 0 : n; };
const s = v => (v == null ? '' : String(v)).trim();
const lc = v => s(v).toLowerCase();
const clone = o => JSON.parse(JSON.stringify(o));
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const toISO = (d) => {
  const t = s(d); if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
  return '';
};
export const fmtEur = v => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(num(v));
const isHex = v => /^#[0-9a-fA-F]{6}$/.test(s(v));

/* ── Konten ─────────────────────────────────────────────────────────────── */
export const accountName = (key, names) => key === 'unter' ? (names.unternehmen || 'Firma') : key === 'privat' ? (names.privatLabel || 'Privat') : (names[key] || key);
export const accountList = (names, created) => {
  const out = [{ key: 'unter', name: accountName('unter', names) }];
  PROPS.forEach(p => { if (!created || created(p)) out.push({ key: p, name: accountName(p, names) }); });
  out.push({ key: 'privat', name: accountName('privat', names) });
  return out;
};
// „firma", „Privat", „Immobilie 1", „p2" … → Schlüssel
export function resolveAccount(ref, names, fallback) {
  const q = lc(ref);
  if (!q) return fallback == null ? '' : fallback;
  if (['unter', 'firma', 'unternehmen', 'business', 'geschäft', 'geschaeft', 'company'].includes(q)) return 'unter';
  if (['privat', 'private', 'personal'].includes(q)) return 'privat';
  if (PROPS.includes(q)) return q;
  if (q === 'immo' || q === 'immobilie' || q === 'immobilien') return PROPS.find(p => s(names[p])) || 'p1';
  const exact = ['unter', 'privat', ...PROPS].find(k => lc(accountName(k, names)) === q);
  if (exact) return exact;
  const part = ['unter', ...PROPS, 'privat'].find(k => { const n = lc(accountName(k, names)); return n && (n.includes(q) || q.includes(n)); });
  return part || (fallback == null ? '' : fallback);
}

/* ── Kunden ─────────────────────────────────────────────────────────────── */
const normName = v => lc(v).replace(/\b(gmbh|ag|ug|kg|ohg|gbr|mbh|e\.?k\.?|e\.?v\.?|co\.?|ltd|inc)\b/g, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
export function findCustomer(data, ref) {
  const list = data.customers || []; const q = s(ref); if (!q) return null;
  return list.find(c => c.id === q)
    || list.find(c => s(c.custNo) && s(c.custNo) === q)
    || list.find(c => lc(c.name) === lc(q))
    || list.find(c => lc(c.email) === lc(q))
    || list.find(c => normName(c.name) === normName(q))
    || list.find(c => normName(c.name).includes(normName(q)) || normName(q).includes(normName(c.name)))
    || null;
}
export const customerView = c => ({ id: c.id, custNo: c.custNo || '', name: c.name || '', firstName: c.firstName || '', lastName: c.lastName || '', company: c.company || '', anrede: c.anrede || '', address: c.address || '', email: c.email || '', phone: c.phone || '', website: c.website || '', konto: c.domain || 'unter', notes: c.notes || '' });
export function listCustomers(data, names, { query, account } = {}) {
  let list = (data.customers || []).slice();
  if (account) { const k = resolveAccount(account, names); if (k) list = list.filter(c => (c.domain || 'unter') === k); }
  const q = lc(query);
  if (q) list = list.filter(c => ((c.name || '') + ' ' + (c.email || '') + ' ' + (c.custNo || '') + ' ' + (c.company || '') + ' ' + (c.address || '')).toLowerCase().includes(q));
  return list.map(customerView);
}
export function nextCustNo(data, domain) {
  const nums = (data.customers || []).filter(c => (c.domain || 'unter') === (domain || 'unter')).map(c => parseInt(c.custNo, 10)).filter(n => !isNaN(n));
  return String(nums.length ? Math.max(...nums) + 1 : 1001);
}
export function addCustomer(data, names, input, id) {
  const domain = resolveAccount(input.account, names, 'unter') || 'unter';
  const nm = s(input.name) || s(input.company) || [s(input.firstName), s(input.lastName)].filter(Boolean).join(' ');
  if (!nm) throw new Error('Name fehlt.');
  const c = { id, name: nm, anrede: s(input.anrede), firstName: s(input.firstName), lastName: s(input.lastName), company: s(input.company), address: s(input.address), email: s(input.email), phone: s(input.phone), website: s(input.website), notes: s(input.notes), custNo: s(input.custNo) || nextCustNo(data, domain), domain };
  // Vor-/Nachname aus dem Anzeigenamen ableiten, wenn nicht angegeben und keine Firma
  if (!c.firstName && !c.lastName && !c.company && !/\b(gmbh|ag|ug|kg|ohg|gbr|mbh|e\.?k\.?|e\.?v\.?|ltd|inc)\b/i.test(nm)) { const parts = nm.split(/\s+/); if (parts.length >= 2) { c.firstName = parts.slice(0, -1).join(' '); c.lastName = parts[parts.length - 1]; } }
  return { data: { ...data, customers: [...(data.customers || []), c] }, customer: c };
}
export function updateCustomer(data, names, ref, patch) {
  const c = findCustomer(data, ref); if (!c) throw new Error('Kunde „' + s(ref) + '" nicht gefunden.');
  const allowed = ['name', 'firstName', 'lastName', 'company', 'anrede', 'address', 'email', 'phone', 'website', 'notes', 'custNo'];
  const next = { ...c }; const changed = [];
  allowed.forEach(k => { if (patch[k] !== undefined && patch[k] !== null) { next[k] = s(patch[k]); changed.push(k); } });
  if (patch.account) { const k = resolveAccount(patch.account, names); if (k) { next.domain = k; changed.push('konto'); } }
  if (!s(next.name)) next.name = s(next.company) || [s(next.firstName), s(next.lastName)].filter(Boolean).join(' ') || c.name;
  return { data: { ...data, customers: (data.customers || []).map(x => x.id === c.id ? next : x) }, customer: next, changed };
}
export function deleteCustomer(data, ref) {
  const c = findCustomer(data, ref); if (!c) throw new Error('Kunde „' + s(ref) + '" nicht gefunden.');
  return { data: { ...data, customers: (data.customers || []).filter(x => x.id !== c.id) }, customer: c };
}

/* ── Rechnungen ─────────────────────────────────────────────────────────── */
export const invTotals = (items) => { let net = 0, tax = 0; (items || []).forEach(it => { const n = num(it.qty || 1) * num(it.price); net += n; tax += n * (num(it.mwst != null && it.mwst !== '' ? it.mwst : 19) / 100); }); return { net: r2(net), tax: r2(tax), gross: r2(net + tax) }; };
const r2 = v => Math.round(v * 100) / 100;
export const addDays = (iso, n) => { const d = new Date(iso); if (isNaN(d.getTime())) return ''; d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
export function findInvoice(data, ref) {
  const q = lc(ref); if (!q) return null; const list = data.invoices || [];
  return list.find(iv => iv.id === s(ref)) || list.find(iv => lc(iv.number) === q) || list.find(iv => lc(iv.number).endsWith(q)) || null;
}
export function invoiceView(data, iv, today) {
  const c = (data.customers || []).find(x => x.id === iv.customerId);
  const tot = invTotals(iv.items); const due = iv.due || addDays(iv.date, 14); const t = today || todayISO();
  const overdue = !iv.paid && due && due < t;
  return { id: iv.id, number: iv.number, kunde: (c && c.name) || iv.custName || '', kundeId: iv.customerId || '', datum: iv.date, faellig: due, netto: tot.net, mwst: tot.tax, brutto: tot.gross, konto: iv.account || 'unter', bezahlt: !!iv.paid, bezahltAm: iv.paidDate || '', ueberfaellig: overdue, tageUeberfaellig: overdue ? Math.max(1, Math.round((new Date(t) - new Date(due)) / 86400000)) : 0, positionen: (iv.items || []).map(i => ({ desc: i.desc, qty: num(i.qty || 1), price: num(i.price), mwst: i.mwst })), note: iv.note || '' };
}
export function listInvoices(data, { status = 'alle', customer, year, limit = 50 } = {}, today) {
  let list = (data.invoices || []).slice();
  if (customer) { const c = findCustomer(data, customer); list = list.filter(iv => c ? iv.customerId === c.id : lc(iv.custName).includes(lc(customer))); }
  if (year) list = list.filter(iv => String(iv.date || '').startsWith(String(year)));
  let views = list.map(iv => invoiceView(data, iv, today));
  if (status === 'offen') views = views.filter(v => !v.bezahlt);
  else if (status === 'bezahlt') views = views.filter(v => v.bezahlt);
  else if (status === 'ueberfaellig') views = views.filter(v => v.ueberfaellig);
  views.sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || '')));
  const total = views.length; views = views.slice(0, Math.max(1, limit || 50)).map(v => { const { positionen, ...rest } = v; return { ...rest, leistung: (positionen || []).map(p => p.desc).filter(Boolean).join(', ').slice(0, 120) }; });
  return { anzahl: total, offeneSumme: r2(list.filter(iv => !iv.paid).reduce((sum, iv) => sum + invTotals(iv.items).gross, 0)), rechnungen: views };
}
export function nextInvNo(data, year) {
  const y = year || new Date().getFullYear();
  const n = (data.invoices || []).filter(i => String(i.number || '').startsWith(String(y))).length + 1;
  return y + '-' + String(n).padStart(3, '0');
}
// Rechnungsobjekt aus Tool-Eingabe bauen (noch nicht gebucht). Gibt {inv, missing[]} zurück.
export function buildInvoiceDraft(data, names, input, { id, defMwst, today } = {}) {
  const t = today || todayISO();
  let cust = input.customer ? findCustomer(data, input.customer) : null;
  if (!cust && input.customer_name) cust = findCustomer(data, input.customer_name);
  const custName = cust ? (cust.name || '') : s(input.customer_name || input.customer);
  const domain = resolveAccount(input.account, names, cust ? (cust.domain || 'unter') : 'unter') || 'unter';
  const mw = (typeof defMwst === 'function') ? defMwst(domain) : (defMwst != null ? defMwst : 19);
  const items = (input.items || []).map(it => ({ desc: s(it.desc) || 'Leistung', qty: num(it.qty) || 1, price: r2(num(it.price)), mwst: (it.mwst != null && it.mwst !== '') ? num(it.mwst) : mw }));
  const date = toISO(input.date) || t;
  const inv = {
    id: id || ('inv_' + Math.random().toString(36).slice(2, 9)), number: nextInvNo(data, date.slice(0, 4)), domain,
    customerId: cust ? cust.id : '', custName, custAddress: s(input.customer_address) || (cust ? cust.address || '' : ''), custEmail: s(input.customer_email) || (cust ? cust.email || '' : ''),
    firstName: cust ? cust.firstName || '' : '', lastName: cust ? cust.lastName || '' : '', company: cust ? cust.company || '' : '', anrede: cust ? cust.anrede || '' : '',
    saveCust: !cust, account: domain, date, due: toISO(input.due) || addDays(date, 14), items, note: s(input.note),
  };
  if (s(input.header_text)) inv.headerText = s(input.header_text);
  if (s(input.footer_text)) inv.footerText = s(input.footer_text);
  const missing = [];
  if (!custName) missing.push('Kunde');
  if (!inv.custAddress) missing.push('Anschrift des Kunden');
  if (!items.length || !items.some(i => i.price > 0)) missing.push('mindestens eine Position mit Preis');
  return { inv, missing, customer: cust };
}
export function setInvoicePaid(data, ref, paid, date) {
  const iv = findInvoice(data, ref); if (!iv) throw new Error('Rechnung „' + s(ref) + '" nicht gefunden.');
  const pd = paid ? (toISO(date) || todayISO()) : '';
  const nd = clone(data);
  nd.invoices = (nd.invoices || []).map(x => x.id === iv.id ? { ...x, paid: !!paid, paidDate: pd } : x);
  // verknüpfte Buchung mitziehen (Einnahme gilt als bezahlt/offen)
  forEachMonth(nd, (M) => { const fix = arr => (arr || []).map(it => it.invId === iv.id ? { ...it, paid: !!paid, status: paid ? 'bezahlt' : 'offen', bankDate: paid ? pd : it.bankDate } : it); if (M.unternehmen) M.unternehmen.clients = fix(M.unternehmen.clients); if (M.privat) M.privat.einnahmen = fix(M.privat.einnahmen); if (M.props) Object.keys(M.props).forEach(p => { M.props[p].einnahmen = fix(M.props[p].einnahmen); }); });
  return { data: nd, invoice: { ...iv, paid: !!paid, paidDate: pd } };
}
export function deleteInvoice(data, ref) {
  const iv = findInvoice(data, ref); if (!iv) throw new Error('Rechnung „' + s(ref) + '" nicht gefunden.');
  const nd = clone(data);
  nd.invoices = (nd.invoices || []).filter(x => x.id !== iv.id);
  forEachMonth(nd, (M) => { const strip = arr => (arr || []).filter(it => it.invId !== iv.id); if (M.unternehmen) { M.unternehmen.clients = strip(M.unternehmen.clients); M.unternehmen.items = strip(M.unternehmen.items); } if (M.privat) { M.privat.einnahmen = strip(M.privat.einnahmen); M.privat.items = strip(M.privat.items); } if (M.props) Object.keys(M.props).forEach(p => { M.props[p].einnahmen = strip(M.props[p].einnahmen); M.props[p].expenses = strip(M.props[p].expenses); }); });
  return { data: nd, invoice: iv };
}
// Rechnung (und ihre Einnahme-Buchung) auf ein anderes Konto legen; optional den Kunden mitnehmen.
export function moveInvoiceAccount(data, names, ref, account, { customerToo = false } = {}) {
  const iv = findInvoice(data, ref); if (!iv) throw new Error('Rechnung „' + s(ref) + '" nicht gefunden.');
  const to = resolveAccount(account, names); if (!to) throw new Error('Konto „' + s(account) + '" nicht gefunden.');
  const from = iv.account || iv.domain || 'unter';
  const nd = clone(data);
  nd.invoices = (nd.invoices || []).map(x => x.id === iv.id ? { ...x, account: to, domain: to } : x);
  let moved = 0;
  forEachMonth(nd, (M) => {
    ['unter', 'privat', ...PROPS].forEach(acc => ['ein', 'aus'].forEach(kind => {
      if (acc === to) return;
      const list = listsOf(M, acc, kind); if (!list || !list.length) return;
      const keep = []; const take = [];
      list.forEach(it => (it.invId === iv.id ? take : keep).push(it));
      if (!take.length) return;
      list.splice(0, list.length, ...keep);
      take.forEach(it => { bookInto(M, to, kind, it); moved++; });
    }));
  });
  if (customerToo && iv.customerId) nd.customers = (nd.customers || []).map(c => c.id === iv.customerId ? { ...c, domain: to } : c);
  return { data: nd, invoice: { ...iv, account: to, domain: to }, from, to, movedBookings: moved };
}

export function recurringInvoiceView(data, r) {
  const c = (data.customers || []).find(x => x.id === r.customerId); const tot = invTotals(r.items);
  return { id: r.id, kunde: (c && c.name) || r.custName || '', konto: r.account, von: MONTHS[r.fromM] + ' ' + r.fromY, bis: MONTHS[r.toM] + ' ' + r.toY, tag: r.genDay || 1, brutto: tot.gross, aktiv: r.active !== false, positionen: (r.items || []).map(i => i.desc + ' ' + fmtEur(num(i.price) * num(i.qty || 1))).join(', ') };
}

/* ── Buchungen ──────────────────────────────────────────────────────────── */
export const forEachMonth = (data, fn) => { Object.keys(data || {}).forEach(y => { if (!/^\d+$/.test(y)) return; const Y = data[y]; if (!Y || typeof Y !== 'object') return; Object.keys(Y).forEach(m => { if (!/^\d+$/.test(m)) return; const M = Y[m]; if (M) fn(M, +y, +m); }); }); };
export const emptyMonth = () => ({ props: { p1: { income: { mieteinnahmen: 0, airbnb: 0, booking: 0, sonstig: 0 }, expenses: [] }, p2: { income: { mieteinnahmen: 0, airbnb: 0, booking: 0, sonstig: 0 }, expenses: [] }, p3: { income: { mieteinnahmen: 0, airbnb: 0, booking: 0, sonstig: 0 }, expenses: [] } }, unternehmen: { clients: [], items: [] }, privat: { items: [] } });
export function bookInto(M, account, kind, item) {
  const isExp = kind === 'aus';
  if (account === 'unter') { const sec = M.unternehmen || {}; M.unternehmen = isExp ? { ...sec, items: [...(sec.items || []), item] } : { ...sec, clients: [...(sec.clients || []), item] }; }
  else if (account === 'privat') { const sec = M.privat || {}; M.privat = isExp ? { ...sec, items: [...(sec.items || []), item] } : { ...sec, einnahmen: [...(sec.einnahmen || []), item] }; }
  else { if (!M.props) M.props = {}; const sec = M.props[account] || {}; M.props[account] = isExp ? { ...sec, expenses: [...(sec.expenses || []), item] } : { ...sec, einnahmen: [...(sec.einnahmen || []), item] }; }
}
const listsOf = (M, account, kind) => {
  if (account === 'unter') { const sec = M.unternehmen || {}; return kind === 'ein' ? sec.clients : sec.items; }
  if (account === 'privat') { const sec = M.privat || {}; return kind === 'ein' ? sec.einnahmen : sec.items; }
  const sec = (M.props && M.props[account]) || {}; return kind === 'ein' ? sec.einnahmen : sec.expenses;
};
export const bookingView = (b, names) => ({ id: b.it.id, jahr: b.y, monat: b.m + 1, konto: b.account, kontoName: accountName(b.account, names), art: b.kind, name: b.it.name || '', betrag: num(b.it.amount), netto: b.it.netto !== '' && b.it.netto != null ? num(b.it.netto) : null, mwst: b.it.mwst != null && b.it.mwst !== '' ? num(b.it.mwst) : null, datum: b.it.datum || '', kategorie: b.it.category || '', belegnr: b.it.belegnr || '', notiz: b.it.note || '', status: b.it.status || '', wiederkehrend: !!b.it.recurring, beleg: !!(b.it.filePath || b.it.fileData), rechnung: b.it.invId ? true : false });
export function allBookings(data) {
  const out = [];
  forEachMonth(data, (M, y, m) => {
    const grab = (arr, account, kind) => (arr || []).forEach(it => out.push({ it, account, kind, y, m }));
    if (M.props) Object.keys(M.props).forEach(p => { const sec = M.props[p] || {}; grab(sec.einnahmen, p, 'ein'); grab(sec.expenses, p, 'aus'); });
    if (M.unternehmen) { grab(M.unternehmen.clients, 'unter', 'ein'); grab(M.unternehmen.items, 'unter', 'aus'); }
    if (M.privat) { grab(M.privat.einnahmen, 'privat', 'ein'); grab(M.privat.items, 'privat', 'aus'); }
  });
  return out;
}
export function listBookings(data, names, { year, month, account, kind, query, limit = 80 } = {}) {
  let list = allBookings(data);
  const y = year || new Date().getFullYear();
  list = list.filter(b => b.y === +y);
  if (month) list = list.filter(b => b.m === (+month) - 1);
  if (account) { const k = resolveAccount(account, names); if (k) list = list.filter(b => b.account === k); }
  if (kind === 'ein' || kind === 'aus') list = list.filter(b => b.kind === kind);
  const q = lc(query);
  if (q) list = list.filter(b => ((b.it.name || '') + ' ' + (b.it.note || '') + ' ' + (b.it.belegnr || '') + ' ' + (b.it.category || '')).toLowerCase().includes(q));
  // Zeilen ohne Betrag (leere Vorlagen-Zeilen) ausblenden
  list = list.filter(b => num(b.it.amount) || s(b.it.datum) || s(b.it.belegnr));
  list.sort((a, b) => (b.y - a.y) || (b.m - a.m) || String(b.it.datum || '').localeCompare(String(a.it.datum || '')));
  const total = list.length; const sumEin = r2(list.filter(b => b.kind === 'ein').reduce((sum, b) => sum + num(b.it.amount), 0)); const sumAus = r2(list.filter(b => b.kind === 'aus').reduce((sum, b) => sum + num(b.it.amount), 0));
  return { anzahl: total, summeEinnahmen: sumEin, summeAusgaben: sumAus, buchungen: list.slice(0, Math.max(1, limit || 80)).map(b => bookingView(b, names)) };
}
export function findBooking(data, id) { return allBookings(data).find(b => b.it.id === s(id)) || null; }
export function addBooking(data, names, input, { ids, today, guessCategory } = {}) {
  const account = resolveAccount(input.account, names); if (!account) throw new Error('Konto „' + s(input.account) + '" nicht gefunden.');
  const kind = input.kind === 'ein' ? 'ein' : 'aus';
  const amount = Math.abs(num(input.amount)); if (!amount) throw new Error('Betrag fehlt.');
  const nm = s(input.name); if (!nm) throw new Error('Name fehlt.');
  const t = today || todayISO(); const date = toISO(input.date) || t; const d = new Date(date); const ty = isNaN(d) ? +t.slice(0, 4) : d.getFullYear(); const tm = isNaN(d) ? (+t.slice(5, 7)) - 1 : d.getMonth();
  const cat = s(input.category) && CATS.find(c => lc(c) === lc(input.category)) || (guessCategory ? guessCategory(nm + ' ' + s(input.note)) : '') || 'Allgemein';
  const idList = (ids && ids.length) ? ids.slice() : [];
  const nextId = () => idList.length ? idList.shift() : ('b_' + Math.random().toString(36).slice(2, 9));
  const status = ['offen', 'bezahlt', 'abgebucht'].includes(input.status) ? input.status : 'offen';
  const base = { id: nextId(), name: nm.slice(0, 80), amount, recurring: !!input.recurring, note: s(input.note), filePath: input.filePath || null, fileName: s(input.fileName), fileData: input.fileData || null, belegnr: s(input.belegnr), datum: date, category: cat, netto: input.netto != null && input.netto !== '' ? Math.abs(num(input.netto)) : '', mwst: input.mwst != null && input.mwst !== '' ? String(num(input.mwst)) : '', status, bankConfirmed: status !== 'offen', customerId: '', custName: '' };
  const nd = clone(data);
  const months = [];
  if (input.recurring) {
    const fr = { y: +(input.from_year || ty), m: input.from_month ? (+input.from_month) - 1 : tm };
    const un = { y: +(input.until_year || fr.y), m: input.until_month ? (+input.until_month) - 1 : 11 };
    let yy = fr.y, mm = fr.m, guard = 0;
    while ((yy < un.y || (yy === un.y && mm <= un.m)) && guard < 120) { if (!nd[yy]) nd[yy] = {}; if (!nd[yy][mm]) nd[yy][mm] = emptyMonth(); bookInto(nd[yy][mm], account, kind, { ...base, id: guard === 0 ? base.id : nextId(), from: fr, until: un }); months.push(MONTHS[mm] + ' ' + yy); mm++; if (mm > 11) { mm = 0; yy++; } guard++; }
  } else {
    if (!nd[ty]) nd[ty] = {}; if (!nd[ty][tm]) nd[ty][tm] = emptyMonth(); bookInto(nd[ty][tm], account, kind, base); months.push(MONTHS[tm] + ' ' + ty);
  }
  return { data: nd, item: base, account, kind, months };
}
export function updateBooking(data, names, id, patch) {
  const loc = findBooking(data, id); if (!loc) throw new Error('Buchung „' + s(id) + '" nicht gefunden.');
  const it = { ...loc.it }; const changed = [];
  if (patch.name != null) { it.name = s(patch.name); changed.push('name'); }
  if (patch.amount != null) { it.amount = Math.abs(num(patch.amount)); changed.push('amount'); }
  if (patch.date != null) { it.datum = toISO(patch.date) || it.datum; changed.push('date'); }
  if (patch.category != null) { const c = CATS.find(x => lc(x) === lc(patch.category)); it.category = c || s(patch.category); changed.push('category'); }
  if (patch.note != null) { it.note = s(patch.note); changed.push('note'); }
  if (patch.belegnr != null) { it.belegnr = s(patch.belegnr); changed.push('belegnr'); }
  if (patch.netto != null) { it.netto = patch.netto === '' ? '' : Math.abs(num(patch.netto)); changed.push('netto'); }
  if (patch.mwst != null) { it.mwst = patch.mwst === '' ? '' : String(num(patch.mwst)); changed.push('mwst'); }
  if (patch.status != null && ['offen', 'bezahlt', 'abgebucht'].includes(patch.status)) { it.status = patch.status; it.bankConfirmed = patch.status !== 'offen'; changed.push('status'); }
  const nd = clone(data); const M = nd[loc.y][loc.m];
  const newKind = (patch.kind === 'ein' || patch.kind === 'aus') ? patch.kind : loc.kind;
  const newAccount = patch.account ? (resolveAccount(patch.account, names) || loc.account) : loc.account;
  if (newKind !== loc.kind || newAccount !== loc.account) {
    // aus alter Liste entfernen, in neue einsortieren
    const src = listsOf(M, loc.account, loc.kind); const idx = (src || []).findIndex(x => x.id === it.id); if (idx >= 0) src.splice(idx, 1);
    bookInto(M, newAccount, newKind, it); changed.push(newKind !== loc.kind ? 'kind' : 'account');
  } else { const src = listsOf(M, loc.account, loc.kind); const idx = (src || []).findIndex(x => x.id === it.id); if (idx >= 0) src[idx] = it; }
  return { data: nd, item: it, changed, account: newAccount, kind: newKind, y: loc.y, m: loc.m };
}
export function deleteBooking(data, id) {
  const loc = findBooking(data, id); if (!loc) throw new Error('Buchung „' + s(id) + '" nicht gefunden.');
  const nd = clone(data); const M = nd[loc.y][loc.m]; const src = listsOf(M, loc.account, loc.kind); const idx = (src || []).findIndex(x => x.id === loc.it.id); if (idx >= 0) src.splice(idx, 1);
  return { data: nd, item: loc.it, y: loc.y, m: loc.m };
}

/* ── To-dos ─────────────────────────────────────────────────────────────── */
export function findTodo(data, ref) { const list = data.todos || []; const q = s(ref); if (!q) return null; return list.find(t => t.id === q) || list.find(t => lc(t.title) === lc(q)) || list.find(t => lc(t.title).includes(lc(q))) || null; }
export const todoView = t => ({ id: t.id, titel: t.title || '', notiz: t.note || '', erledigt: !!t.done, erstellt: (t.createdAt || '').slice(0, 10), quelle: t.source || 'user' });
export function listTodos(data, { status = 'offen' } = {}) { let list = (data.todos || []).slice(); if (status === 'offen') list = list.filter(t => !t.done); else if (status === 'erledigt') list = list.filter(t => t.done); return list.map(todoView); }
export function addTodo(data, input, id) { const title = s(input.title); if (!title) throw new Error('Titel fehlt.'); const t = { id, done: false, source: 'user', createdAt: new Date().toISOString(), ref: null, note: s(input.note), title, comments: [] }; return { data: { ...data, todos: [t, ...(data.todos || [])] }, todo: t }; }
export function updateTodo(data, ref, patch) { const t = findTodo(data, ref); if (!t) throw new Error('Aufgabe „' + s(ref) + '" nicht gefunden.'); const next = { ...t }; if (patch.title != null) next.title = s(patch.title); if (patch.note != null) next.note = s(patch.note); if (patch.done != null) { next.done = !!patch.done; next.doneAt = patch.done ? new Date().toISOString() : null; } return { data: { ...data, todos: (data.todos || []).map(x => x.id === t.id ? next : x) }, todo: next }; }
export function deleteTodo(data, ref) { const t = findTodo(data, ref); if (!t) throw new Error('Aufgabe „' + s(ref) + '" nicht gefunden.'); return { data: { ...data, todos: (data.todos || []).filter(x => x.id !== t.id) }, todo: t }; }

/* ── Einstellungen ──────────────────────────────────────────────────────── */
export const companyKey = (account) => account === 'unter' ? 'company' : account === 'privat' ? 'companyPrivat' : PROPS.includes(account) ? 'company_' + account : 'company';
export function getSettings(data, names, { section = 'alle', account, year, theme, created } = {}) {
  const out = {};
  const want = k => section === 'alle' || section === k;
  if (want('profil')) { const p = data.profile || {}; out.profil = { name: p.name || '', phone: p.phone || '', contactEmail: p.contactEmail || '', role: p.role || '' }; }
  if (want('firma')) {
    const keys = account ? [resolveAccount(account, names, 'unter')] : accountList(names, created).map(a => a.key);
    out.firma = {};
    keys.forEach(k => { const co = data[companyKey(k)] || {}; const v = {}; COMPANY_FIELDS.forEach(f => { v[f] = co[f] == null ? '' : co[f]; }); v.logo = !!co.logoData; out.firma[k] = { kontoName: accountName(k, names), ...v }; });
  }
  if (want('konten')) { out.konten = { names: { unternehmen: names.unternehmen || 'Firma', p1: names.p1 || '', p2: names.p2 || '', p3: names.p3 || '', privatLabel: names.privatLabel || 'Privat' }, icons: names.propIcon || {}, colors: names.acctColors || {}, angelegt: accountList(names, created).map(a => a.key) }; }
  if (want('darstellung')) { out.darstellung = { theme: theme || 'light', colors: data.themeColors || {} }; }
  if (want('steuerprofil')) { const tp = data.taxProfile || {}; const y = year || new Date().getFullYear(); out.steuerprofil = { jahr: y, ...(tp[y] || {}) }; }
  if (want('assistent')) { out.assistent = { model: (data.assistant && data.assistant.model) || 'claude-opus-5' }; }
  return out;
}
// Gibt {data, names, theme?, applied[], ignored[]} zurück – Theme wird von main.jsx gesetzt.
export function updateSettings(data, names, section, patch, { account, year, mode } = {}) {
  const p = patch || {}; const applied = []; const ignored = []; let nd = data; let nn = names; let theme;
  if (section === 'profil') { const cur = { ...(data.profile || {}) }; Object.keys(p).forEach(k => { if (PROFILE_FIELDS.includes(k)) { cur[k] = s(p[k]); applied.push(k); } else ignored.push(k); }); nd = { ...data, profile: cur }; }
  else if (section === 'firma') { const k = resolveAccount(account, names, 'unter') || 'unter'; const key = companyKey(k); const cur = { ...(data[key] || {}) }; Object.keys(p).forEach(f => { if (COMPANY_FIELDS.includes(f)) { cur[f] = f === 'defMwst' ? String(num(p[f])) : s(p[f]); applied.push(f); } else ignored.push(f); }); nd = { ...data, [key]: cur }; }
  else if (section === 'konten') {
    nn = { ...names };
    const nm = p.names || {}; Object.keys(nm).forEach(k => { if (['unternehmen', 'p1', 'p2', 'p3', 'privatLabel'].includes(k)) { nn[k] = s(nm[k]); applied.push('name:' + k); } else ignored.push('names.' + k); });
    // Kurzformen: {account:"p1", name:"Ferienwohnung"} bzw. {unternehmen:"…"}
    ['unternehmen', 'p1', 'p2', 'p3', 'privatLabel'].forEach(k => { if (p[k] != null && typeof p[k] === 'string') { nn[k] = s(p[k]); applied.push('name:' + k); } });
    if (p.account && p.name != null) { const k = resolveAccount(p.account, names); if (k === 'unter') nn.unternehmen = s(p.name); else if (k === 'privat') nn.privatLabel = s(p.name); else if (k) nn[k] = s(p.name); if (k) applied.push('name:' + k); }
    const ic = p.icon || p.icons || {}; Object.keys(ic).forEach(k => { const key = resolveAccount(k, names); if (key && ICONS.includes(s(ic[k]))) { nn.propIcon = { ...(nn.propIcon || {}), [key]: s(ic[k]) }; applied.push('icon:' + key); } else ignored.push('icon.' + k); });
    const co = p.color || p.colors || {}; Object.keys(co).forEach(k => { const key = resolveAccount(k, names); if (key && isHex(co[k])) { nn.acctColors = { ...(nn.acctColors || {}), [key]: s(co[k]) }; applied.push('color:' + key); } else ignored.push('color.' + k); });
  }
  else if (section === 'darstellung') {
    if (p.theme != null) { if (['light', 'dark', 'system'].includes(s(p.theme))) { theme = s(p.theme); applied.push('theme'); } else ignored.push('theme'); }
    const co = p.colors || {}; const m = (mode === 'dark' ? 'dark' : 'light'); if (Object.keys(co).length) { const tc = { ...(data.themeColors || {}) }; const cur = { ...(tc[m] || {}) }; Object.keys(co).forEach(k => { if (THEME_COLOR_KEYS.includes(k) && isHex(co[k])) { cur[k] = s(co[k]); applied.push('color:' + k); } else ignored.push('colors.' + k); }); tc[m] = cur; nd = { ...data, themeColors: tc }; }
    if (p.reset_colors) { const tc = { ...(data.themeColors || {}) }; delete tc[m]; nd = { ...nd, themeColors: tc }; applied.push('reset_colors'); }
  }
  else if (section === 'steuerprofil') {
    const y = year || p.jahr || p.year || new Date().getFullYear(); const tp = { ...(data.taxProfile || {}) }; const cur = { ...(tp[y] || {}) };
    Object.keys(p).forEach(k => { if (k === 'jahr' || k === 'year') return; if (TAX_FIELDS.includes(k)) { cur[k] = (k === 'veranlagung' || k === 'firmaArt') ? s(p[k]) : num(p[k]); applied.push(k); } else if ((k === 'gebaeudewert' || k === 'afaSatz') && p[k] && typeof p[k] === 'object') { const o = { ...(cur[k] || {}) }; Object.keys(p[k]).forEach(a => { const key = resolveAccount(a, names); if (PROPS.includes(key)) { o[key] = num(p[k][a]); applied.push(k + ':' + key); } else ignored.push(k + '.' + a); }); cur[k] = o; } else ignored.push(k); });
    tp[y] = cur; nd = { ...data, taxProfile: tp };
  }
  else if (section === 'assistent') { if (p.model) { nd = { ...data, assistant: { ...(data.assistant || {}), model: s(p.model) } }; applied.push('model'); } Object.keys(p).forEach(k => { if (k !== 'model') ignored.push(k); }); }
  else throw new Error('Unbekannter Einstellungsbereich: ' + s(section));
  return { data: nd, names: nn, theme, applied, ignored };
}
