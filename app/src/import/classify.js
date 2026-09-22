// Buqo – KI-Sortierung für den sevDesk-Import: entscheidet pro Rechnung/Beleg, zu welchem Konto
// (Firma, Immobilie 1–3, Privat) sie gehört. Reine Logik ohne React; `invoke(body)` ruft den KI-Proxy.

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// Eine Zeile pro Posten – kompakt, damit viele Posten in eine Anfrage passen.
export function rowLine(r) {
  const art = r.key && r.key[0] === 'r' ? 'Rechnung' : (r.kind === 'ein' ? 'Einnahme' : 'Ausgabe');
  return [r.key, art, r.datum || '', clip(r.name, 60), clip(r.beschreibung && r.beschreibung !== r.name ? r.beschreibung : '', 90), clip(r.kategorie, 30), (Math.round((r.brutto || 0) * 100) / 100).toFixed(2) + ' €'].join(' | ');
}

export function buildClassifyPrompt(accounts, hint) {
  const acc = accounts.map(a => '- ' + a.key + ': ' + a.label + (a.key === 'unter' ? ' (Unternehmen: Dienstleistungen, Projekte, Honorare, Betriebsausgaben)' : a.key === 'privat' ? ' (private Ausgaben, nichts Geschäftliches)' : ' (vermietete Immobilie: Mieteinnahmen, Ferienvermietung, Nebenkosten, Reparaturen, Reinigung, Hausgeld)')).join('\n');
  return [
    'Du sortierst Rechnungen und Belege aus einem sevDesk-Export auf die Konten einer deutschen Buchhaltungs-App.',
    'Der Nutzer hat in sevDesk alles in einem Topf geführt: Rechnungen für seine Dienstleistungen UND für seine Immobilien (Miete, Ferienwohnung). Deine Aufgabe: für jeden Posten das richtige Konto wählen.',
    '',
    'KONTEN',
    acc,
    '',
    'REGELN',
    '- Miete, Kaltmiete, Nebenkosten-Abrechnung an Mieter, Ferienwohnung, Airbnb, Booking.com, Übernachtung, Kurtaxe, Endreinigung, Stellplatz → passendes Immobilien-Konto. Gibt es mehrere Immobilien, nutze Namen, Adressen oder Hinweise des Nutzers; ist es nicht eindeutig, nimm die wahrscheinlichste und setze sicher=false.',
    '- Webdesign, Beratung, Projekte, Honorare, Stundensätze, Software, Werbung, Agentur-/Freelancer-Leistungen → Firma (unter).',
    '- Ausgaben für die Wohnung (Handwerker, Reinigung, Hausverwaltung, Stadtwerke der Wohnung, Grundsteuer, Gebäudeversicherung) → Immobilien-Konto.',
    '- Privat nur, wenn klar privat (Lebensmittel, Kleidung, private Versicherungen) und nicht betrieblich.',
    '- Im Zweifel Firma und sicher=false.',
    hint ? '\nHINWEISE DES NUTZERS (haben Vorrang):\n' + clip(hint, 1500) : '',
    '',
    'ANTWORT: ausschließlich JSON, ohne Markdown, in der Form {"z":[{"id":"r3","k":"p1","s":true,"w":"Miete Wohnung Sylt"}]}. Für JEDEN Posten genau ein Eintrag. id = die erste Spalte, k = Kontoschlüssel aus der Liste, s = sicher (true/false), w = Begründung in höchstens 6 Wörtern.',
  ].filter(x => x !== '').join('\n');
}

// Robust JSON aus der Modellantwort lesen (Markdown-Zäune, Text drumherum, abgeschnittenes Ende).
export function parseClassification(text, validKeys, validIds) {
  let t = String(text || '').replace(/```json|```/g, '').trim();
  const a = t.indexOf('{'); if (a > 0) t = t.slice(a);
  let parsed = null;
  try { parsed = JSON.parse(t); } catch (e) {
    const cut = t.lastIndexOf('}'); // abgeschnitten: bis zum letzten vollständigen Objekt retten
    if (cut > 0) { try { parsed = JSON.parse(t.slice(0, cut + 1) + ']}'); } catch (e2) { parsed = null; } }
  }
  const list = parsed && Array.isArray(parsed.z) ? parsed.z : (Array.isArray(parsed) ? parsed : []);
  const out = {};
  list.forEach(e => {
    if (!e) return; const id = String(e.id || ''); const k = String(e.k || e.konto || '');
    if (!validIds.has(id) || !validKeys.has(k)) return;
    out[id] = { acct: k, sure: e.s !== false && e.sicher !== false, why: clip(e.w || e.grund || '', 60) };
  });
  return out;
}

const textOf = (resp) => ((resp && resp.content) || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');

// rows: [{key, kind, datum, name, beschreibung, kategorie, brutto}] · accounts: [{key,label}]
// Gibt {results: {key: {acct, sure, why}}, missing: [key]} zurück.
export async function classifyRows({ invoke, model, adaptive = true, accounts, rows, hint, batchSize = 70, onProgress }) {
  const validKeys = new Set(accounts.map(a => a.key));
  const system = buildClassifyPrompt(accounts, hint);
  const results = {};
  const batches = []; for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
  let done = 0;
  for (const batch of batches) {
    let todo = batch;
    for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
      const ids = new Set(todo.map(r => r.key));
      const body = { model, max_tokens: 8000, system, messages: [{ role: 'user', content: [{ type: 'text', text: 'POSTEN (id | Art | Datum | Name | Beschreibung | Kategorie | Brutto):\n' + todo.map(rowLine).join('\n') }] }] };
      if (adaptive) { body.thinking = { type: 'adaptive' }; body.output_config = { effort: 'low' }; }
      const resp = await invoke(body);
      Object.assign(results, parseClassification(textOf(resp), validKeys, ids));
      todo = todo.filter(r => !results[r.key]); // fehlende Posten einmal nachfragen
    }
    done += batch.length; if (onProgress) onProgress(done, rows.length);
  }
  return { results, missing: rows.filter(r => !results[r.key]).map(r => r.key) };
}
