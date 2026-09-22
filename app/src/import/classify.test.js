import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowLine, buildClassifyPrompt, parseClassification, classifyRows } from './classify.js';

const accounts = [{ key: 'unter', label: 'Designpeak' }, { key: 'p1', label: 'Ferienwohnung Sylt' }, { key: 'privat', label: 'Privat' }];

test('Zeile und Prompt enthalten alles Nötige', () => {
  const l = rowLine({ key: 'r3', kind: 'ein', datum: '2025-03-01', name: 'Müller', beschreibung: 'Miete März', kategorie: '', brutto: 850 });
  assert.equal(l, 'r3 | Rechnung | 2025-03-01 | Müller | Miete März |  | 850.00 €');
  const p = buildClassifyPrompt(accounts, 'Mieter Müller = Sylt');
  assert.match(p, /p1: Ferienwohnung Sylt/); assert.match(p, /Mieter Müller = Sylt/); assert.match(p, /"z"/);
});

test('Antwort robust lesen: Zäune, ungültige Konten/IDs, abgeschnittenes Ende', () => {
  const ids = new Set(['r1', 'r2', 'b5', 'b6']); const keys = new Set(accounts.map(a => a.key));
  const txt = 'Hier:\n```json\n{"z":[{"id":"r1","k":"p1","s":true,"w":"Miete"},{"id":"r2","k":"unter","s":false,"w":"unklar"},{"id":"b5","k":"p9"},{"id":"xx","k":"unter"},{"id":"b6","k":"privat","s":true,"w":"Lebens';
  const r = parseClassification(txt, keys, ids);
  assert.deepEqual(r.r1, { acct: 'p1', sure: true, why: 'Miete' });
  assert.equal(r.r2.sure, false); assert.equal(r.b5, undefined); assert.equal(r.xx, undefined); assert.equal(r.b6, undefined);
  assert.deepEqual(parseClassification('kaputt', keys, ids), {});
});

test('classifyRows: Batches, fehlende Posten werden einmal nachgefragt', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ key: 'r' + i, kind: 'ein', datum: '2025-01-0' + (i + 1), name: i % 2 ? 'Miete' : 'Webdesign', brutto: 100 }));
  const calls = [];
  const invoke = async (body) => {
    calls.push(body); const ids = [...body.messages[0].content[0].text.matchAll(/^(r\d+) \|/gm)].map(m => m[1]);
    const skipR1 = calls.length === 1; // erster Aufruf „vergisst" r1
    const z = ids.filter(id => !(skipR1 && id === 'r1')).map(id => ({ id, k: +id.slice(1) % 2 ? 'p1' : 'unter', s: true, w: 'x' }));
    return { content: [{ type: 'text', text: JSON.stringify({ z }) }] };
  };
  const prog = [];
  const { results, missing } = await classifyRows({ invoke, model: 'claude-opus-5', accounts, rows, batchSize: 3, onProgress: (d, t) => prog.push(d + '/' + t) });
  assert.deepEqual(missing, []); assert.equal(results.r1.acct, 'p1'); assert.equal(results.r0.acct, 'unter');
  assert.equal(calls.length, 3); // Batch 1 + Nachfrage für r1 + Batch 2
  assert.equal(calls[0].thinking.type, 'adaptive'); assert.equal(calls[0].output_config.effort, 'low');
  assert.deepEqual(prog, ['3/5', '5/5']);
});
