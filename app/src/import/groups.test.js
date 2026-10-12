import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGroups } from './groups.js';

test('Gruppen: wiederkehrende Zahlungen und Familien (Airbnb) werden erkannt', () => {
  const rows = [];
  ['01', '02', '03', '04'].forEach((m, i) => { rows.push({ key: 'x' + i, name: 'Stadtwerke Köln GmbH', text: 'Abschlag Strom', kind: 'aus', datum: '2026-' + m + '-03', brutto: 95 }); });
  rows.push({ key: 'a1', name: 'AIRBNB PAYMENTS LUXEMBOURG', text: '', kind: 'ein', datum: '2026-01-10', brutto: 800 }, { key: 'a2', name: 'Airbnb Ireland UC', text: '', kind: 'ein', datum: '2026-02-11', brutto: 1250 });
  rows.push({ key: 'o1', name: 'Einmalige Lieferung GmbH', text: '', kind: 'aus', datum: '2026-02-01', brutto: 33 });
  const g = detectGroups(rows, { catOf: (t) => /strom/i.test(t) ? 'Nebenkosten' : '' });
  const strom = g.find(x => /Stadtwerke/.test(x.name)); const ab = g.find(x => x.name === 'Airbnb');
  assert.ok(strom && strom.keys.length === 4 && strom.monthly === 95 && strom.category === 'Nebenkosten');
  assert.ok(ab && ab.keys.length === 2 && ab.variable && ab.kind === 'ein');
  assert.ok(!g.find(x => /Einmalige/.test(x.name)));
  assert.equal(detectGroups(rows, { skipKeys: new Set(['x0', 'x1', 'x2', 'x3']) }).find(x => /Stadtwerke/.test(x.name)), undefined);
});
