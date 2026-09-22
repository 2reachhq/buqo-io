import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_TOOLS, TOOL_NAMES, buildSystemPrompt, stepLabel } from './tools.js';
import { buildApiMessages, runAssistantTurn } from './agent.js';
import {
  resolveAccount, addCustomer, updateCustomer, deleteCustomer, findCustomer, listCustomers,
  buildInvoiceDraft, listInvoices, setInvoicePaid, deleteInvoice, invTotals,
  addBooking, updateBooking, deleteBooking, listBookings, addTodo, updateTodo, listTodos,
  getSettings, updateSettings, emptyMonth, moveInvoiceAccount,
} from './actions.js';

const names = { unternehmen: 'Designpeak', p1: 'Ferienwohnung Sylt', p2: 'Immobilie 2', p3: 'Immobilie 3', privatLabel: 'Privat' };
const baseData = () => ({ customers: [{ id: 'c1', name: 'Max Muster GmbH', custNo: '1001', domain: 'unter', address: 'Hauptstr. 1\n50667 Köln', email: 'max@example.de' }], invoices: [], todos: [] });

test('Tool-Schemas sind gültig und eindeutig', () => {
  assert.equal(new Set(ASSISTANT_TOOLS.map(t => t.name)).size, ASSISTANT_TOOLS.length);
  for (const t of ASSISTANT_TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length > 10, t.name);
    assert.equal(t.input_schema.type, 'object');
    for (const r of (t.input_schema.required || [])) assert.ok(t.input_schema.properties[r], t.name + ' required ' + r);
  }
  assert.ok(TOOL_NAMES.has('create_invoice') && TOOL_NAMES.has('update_settings'));
});

test('Systemprompt enthält Kontext und Regeln', () => {
  const sys = buildSystemPrompt({ today: '22.09.2026', period: 'September 2026', accounts: [{ key: 'unter', name: 'Designpeak' }], finance: 'Jahr 2026: …', pendingInvoice: '2026-004 an Max' });
  assert.match(sys, /Designpeak/); assert.match(sys, /confirm_invoice/); assert.match(sys, /Kein Markdown/); assert.match(sys, /2026-004/);
});

test('resolveAccount erkennt Schlüssel, Namen und Kurzformen', () => {
  assert.equal(resolveAccount('firma', names), 'unter');
  assert.equal(resolveAccount('Designpeak', names), 'unter');
  assert.equal(resolveAccount('sylt', names), 'p1');
  assert.equal(resolveAccount('p2', names), 'p2');
  assert.equal(resolveAccount('privat', names), 'privat');
  assert.equal(resolveAccount('gibtsnicht', names), '');
  assert.equal(resolveAccount('', names, 'unter'), 'unter');
});

test('Kunden anlegen, finden, ändern, löschen', () => {
  const r = addCustomer(baseData(), names, { name: 'Erika Beispiel', email: 'e@x.de', account: 'Ferienwohnung Sylt' }, 'c2');
  assert.equal(r.customer.custNo, '1001'); // eigener Nummernkreis je Konto
  assert.equal(r.customer.domain, 'p1'); assert.equal(r.customer.firstName, 'Erika'); assert.equal(r.customer.lastName, 'Beispiel');
  assert.equal(r.data.customers.length, 2);
  assert.equal(findCustomer(r.data, 'erika beispiel').id, 'c2');
  assert.equal(findCustomer(r.data, '1001').id, 'c1');
  assert.equal(findCustomer(r.data, 'Max Muster').id, 'c1');
  const u = updateCustomer(r.data, names, 'Erika', { phone: '0221 1', address: 'Neue Str. 2' });
  assert.equal(u.customer.phone, '0221 1'); assert.deepEqual(u.changed.sort(), ['address', 'phone']);
  const d = deleteCustomer(u.data, 'c2'); assert.equal(d.data.customers.length, 1);
  assert.throws(() => deleteCustomer(d.data, 'c2'), /nicht gefunden/);
  assert.equal(listCustomers(d.data, names, { query: 'köln' }).length, 1);
  assert.equal(listCustomers(d.data, names, { account: 'privat' }).length, 0);
});

test('Rechnungsentwurf: Kunde, Anschrift, Positionen, Nummer, MwSt-Standard', () => {
  const { inv, missing } = buildInvoiceDraft(baseData(), names, { customer: 'Max Muster', items: [{ desc: 'Webdesign', price: 1500 }] }, { id: 'i1', defMwst: () => 19, today: '2026-09-22' });
  assert.deepEqual(missing, []);
  assert.equal(inv.number, '2026-001'); assert.equal(inv.customerId, 'c1'); assert.equal(inv.custAddress, 'Hauptstr. 1\n50667 Köln');
  assert.equal(inv.due, '2026-10-06'); assert.equal(inv.items[0].mwst, 19); assert.equal(inv.saveCust, false);
  assert.equal(invTotals(inv.items).gross, 1785);
  const neu = buildInvoiceDraft(baseData(), names, { customer_name: 'Neu AG', items: [{ desc: 'Beratung', price: 100, qty: 2, mwst: 7 }] }, { today: '2026-09-22' });
  assert.deepEqual(neu.missing, ['Anschrift des Kunden']); assert.equal(neu.inv.saveCust, true); assert.equal(invTotals(neu.inv.items).gross, 214);
});

test('Rechnungen listen, bezahlen, löschen (inkl. verknüpfter Buchung)', () => {
  const data = baseData();
  data.invoices = [{ id: 'i1', number: '2026-001', customerId: 'c1', date: '2026-08-01', due: '2026-08-15', items: [{ desc: 'A', qty: 1, price: 100, mwst: 19 }], paid: false, account: 'unter' }];
  data[2026] = { 7: { ...emptyMonth(), unternehmen: { clients: [{ id: 'b1', name: 'Rechnung 2026-001', amount: 119, invId: 'i1', status: 'offen' }], items: [] } } };
  const l = listInvoices(data, { status: 'ueberfaellig' }, '2026-09-22');
  assert.equal(l.rechnungen.length, 1); assert.equal(l.rechnungen[0].brutto, 119); assert.ok(l.rechnungen[0].tageUeberfaellig > 30); assert.equal(l.offeneSumme, 119);
  const p = setInvoicePaid(data, '001', true, '2026-09-20');
  assert.equal(p.data.invoices[0].paid, true); assert.equal(p.data[2026][7].unternehmen.clients[0].status, 'bezahlt');
  assert.equal(listInvoices(p.data, { status: 'offen' }).rechnungen.length, 0);
  const d = deleteInvoice(p.data, '2026-001');
  assert.equal(d.data.invoices.length, 0); assert.equal(d.data[2026][7].unternehmen.clients.length, 0);
});

test('Buchungen: anlegen (einmalig + wiederkehrend), listen, ändern, löschen', () => {
  const a = addBooking(baseData(), names, { account: 'firma', kind: 'aus', name: 'Adobe', amount: '71,31', date: '15.09.2026', category: 'software', netto: 59.92, mwst: 19 }, { ids: ['b1'], today: '2026-09-22' });
  assert.equal(a.item.category, 'Software'); assert.equal(a.item.amount, 71.31); assert.equal(a.item.status, 'offen'); assert.deepEqual(a.months, ['September 2026']);
  assert.equal(a.data[2026][8].unternehmen.items[0].id, 'b1');
  const r = addBooking(a.data, names, { account: 'p1', kind: 'ein', name: 'Miete Müller', amount: 800, recurring: true, from_year: 2026, from_month: 10, until_year: 2027, until_month: 3, status: 'bezahlt' }, { today: '2026-09-22' });
  assert.equal(r.months.length, 6); assert.equal(r.data[2027][2].props.p1.einnahmen[0].name, 'Miete Müller'); assert.equal(r.data[2027][2].props.p1.einnahmen[0].bankConfirmed, true);
  const l = listBookings(r.data, names, { year: 2026, account: 'Designpeak' });
  assert.equal(l.anzahl, 1); assert.equal(l.summeAusgaben, 71.31); assert.equal(l.buchungen[0].kontoName, 'Designpeak');
  assert.equal(listBookings(r.data, names, { year: 2027, kind: 'ein' }).anzahl, 3);
  const u = updateBooking(r.data, names, 'b1', { amount: 80, kind: 'ein', note: 'Gutschrift' });
  assert.equal(u.data[2026][8].unternehmen.items.length, 0); assert.equal(u.data[2026][8].unternehmen.clients[0].amount, 80); assert.ok(u.changed.includes('kind'));
  const d = deleteBooking(u.data, 'b1'); assert.equal(d.data[2026][8].unternehmen.clients.length, 0);
  assert.throws(() => addBooking(baseData(), names, { account: 'unbekannt', kind: 'aus', name: 'x', amount: 1 }), /Konto/);
});

test('To-dos', () => {
  const a = addTodo(baseData(), { title: 'Steuerberater anrufen', note: 'wegen UStVA' }, 't1');
  assert.equal(listTodos(a.data).length, 1);
  const u = updateTodo(a.data, 'steuerberater', { done: true });
  assert.equal(u.todo.done, true); assert.equal(listTodos(u.data, { status: 'offen' }).length, 0); assert.equal(listTodos(u.data, { status: 'alle' }).length, 1);
});

test('Einstellungen lesen und ändern', () => {
  const data = { ...baseData(), company: { name: 'Designpeak', iban: 'DE00' }, profile: { name: 'Siva' } };
  const g = getSettings(data, names, { section: 'firma', account: 'firma' });
  assert.equal(g.firma.unter.iban, 'DE00'); assert.equal(g.firma.unter.kontoName, 'Designpeak');
  const u1 = updateSettings(data, names, 'firma', { iban: 'DE99', defMwst: '7', unbekannt: 1 }, { account: 'firma' });
  assert.equal(u1.data.company.iban, 'DE99'); assert.equal(u1.data.company.defMwst, '7'); assert.deepEqual(u1.ignored, ['unbekannt']);
  const u2 = updateSettings(u1.data, names, 'konten', { account: 'Ferienwohnung Sylt', name: 'FeWo Sylt', icon: { p1: 'bed' }, color: { p1: '#ABC4FF' } });
  assert.equal(u2.names.p1, 'FeWo Sylt'); assert.equal(u2.names.propIcon.p1, 'bed'); assert.equal(u2.names.acctColors.p1, '#ABC4FF');
  const u3 = updateSettings(u2.data, u2.names, 'darstellung', { theme: 'dark', colors: { pri: '#112233', bogus: '#000000' } }, { mode: 'light' });
  assert.equal(u3.theme, 'dark'); assert.equal(u3.data.themeColors.light.pri, '#112233'); assert.deepEqual(u3.ignored, ['colors.bogus']);
  const u4 = updateSettings(u3.data, u3.names, 'steuerprofil', { veranlagung: 'zusammen', hebesatz: '450', gebaeudewert: { p1: 250000 } }, { year: 2026 });
  assert.equal(u4.data.taxProfile[2026].hebesatz, 450); assert.equal(u4.data.taxProfile[2026].gebaeudewert.p1, 250000);
  const u5 = updateSettings(u4.data, u4.names, 'assistent', { model: 'claude-sonnet-5' });
  assert.equal(getSettings(u5.data, u5.names, { section: 'assistent' }).assistent.model, 'claude-sonnet-5');
  assert.throws(() => updateSettings(data, names, 'foo', {}), /Unbekannter/);
});

test('buildApiMessages: Alternierung, Begrenzung, Anhang nur an letzter Nachricht', () => {
  const hist = [
    { role: 'assistant', content: 'Hallo!' },
    { role: 'user', content: 'Beleg', attachmentName: 'alt.pdf' },
    { role: 'assistant', content: 'Gebucht.', steps: [{ name: 'add_booking', result: { ok: true } }] },
    { role: 'assistant', content: 'Noch etwas?' },
    { role: 'user', content: '' },
  ];
  const att = { name: 'neu.pdf', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAA' } } };
  const m = buildApiMessages(hist, { attachment: att });
  assert.equal(m[0].role, 'user'); assert.match(m[0].content[0].text, /alt\.pdf/);
  assert.equal(m[1].role, 'assistant'); assert.match(m[1].content[0].text, /add_booking/); assert.match(m[1].content[0].text, /Noch etwas/);
  assert.equal(m[2].role, 'user'); assert.equal(m[2].content[0].type, 'document'); assert.match(m[2].content[1].text, /neu\.pdf/);
  const many = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
  const cut = buildApiMessages(many, { maxMessages: 6 });
  assert.ok(cut.length <= 6); assert.equal(cut[0].role, 'user'); assert.equal(cut[cut.length - 1].content[0].text, 'm40');
});

test('runAssistantTurn: Tools werden ausgeführt, Ergebnisse zurückgegeben, Schritte gemeldet', async () => {
  const calls = [];
  const invoke = async (body) => {
    calls.push(body);
    if (calls.length === 1) return { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Ich lege an.' }, { type: 'tool_use', id: 'tu1', name: 'create_customer', input: { name: 'Neu' } }, { type: 'tool_use', id: 'tu2', name: 'kaputt', input: {} }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Kunde Neu angelegt.' }] };
  };
  const executeTool = async (name, input) => { if (name === 'kaputt') throw new Error('boom'); return { ok: true, name: input.name }; };
  const seen = [];
  const r = await runAssistantTurn({ invoke, model: 'claude-opus-5', system: 'sys', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Leg Neu an' }] }], executeTool, onStep: s => seen.push(s.name) });
  assert.equal(r.text, 'Kunde Neu angelegt.'); assert.equal(r.steps.length, 2); assert.deepEqual(seen, ['create_customer', 'kaputt']);
  assert.equal(calls[0].thinking.type, 'adaptive'); assert.equal(calls[0].output_config.effort, 'medium');
  const second = calls[1].messages; assert.equal(second[1].role, 'assistant'); assert.equal(second[2].content[0].type, 'tool_result'); assert.equal(second[2].content[1].is_error, true);
  assert.match(stepLabel(r.steps[0]), /Kunde angelegt: Neu/); assert.match(stepLabel(r.steps[1]), /⚠️/);
  const plain = await runAssistantTurn({ invoke: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi' }] }), model: 'claude-haiku-4-5', adaptive: false, system: '', tools: [], messages: [], executeTool });
  assert.equal(plain.text, 'Hi'); assert.equal(plain.steps.length, 0);
});

test('Rechnung samt Einnahme-Buchung auf ein Immobilien-Konto verschieben', () => {
  const data = baseData();
  data.invoices = [{ id: 'i1', number: '2025-007', customerId: 'c1', date: '2025-03-01', items: [{ desc: 'Miete März', qty: 1, price: 850, mwst: 0 }], paid: true, account: 'unter', domain: 'unter' }];
  data[2025] = { 2: { ...emptyMonth(), unternehmen: { clients: [{ id: 'b1', name: 'Rechnung 2025-007', amount: 850, invId: 'i1' }, { id: 'b2', name: 'Webdesign', amount: 500 }], items: [] } } };
  const r = moveInvoiceAccount(data, names, '2025-007', 'Sylt', { customerToo: true });
  assert.equal(r.from, 'unter'); assert.equal(r.to, 'p1'); assert.equal(r.movedBookings, 1);
  assert.equal(r.data.invoices[0].account, 'p1'); assert.equal(r.data.invoices[0].domain, 'p1');
  assert.deepEqual(r.data[2025][2].unternehmen.clients.map(x => x.id), ['b2']);
  assert.equal(r.data[2025][2].props.p1.einnahmen[0].id, 'b1');
  assert.equal(r.data.customers[0].domain, 'p1');
  assert.equal(listInvoices(r.data, {}).rechnungen[0].leistung, 'Miete März');
  assert.throws(() => moveInvoiceAccount(data, names, '2025-007', 'Mond'), /Konto/);
  const b = updateBooking(r.data, names, 'b2', { account: 'privat' });
  assert.equal(b.account, 'privat'); assert.equal(b.data[2025][2].privat.einnahmen[0].id, 'b2');
});
