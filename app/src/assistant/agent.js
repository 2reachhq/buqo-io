// Buqo-Assistent: Tool-Calling-Schleife gegen den KI-Proxy (Supabase-Funktion „ai").
// Bewusst ohne SDK: der Browser spricht nur mit dem Proxy, der den Anthropic-Schlüssel hält.
// `invoke(body)` liefert die unveränderte Messages-API-Antwort ({content, stop_reason, usage}).

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Datei → Inhaltsblock für die Messages-API. `fileToB64` liefert den Base64-Teil ohne Prefix.
export async function attachmentFromFile(file, fileToB64) {
  const name = file.name || 'datei';
  const type = (file.type || '').toLowerCase();
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
  const isImg = IMAGE_TYPES.has(type) || /\.(png|jpe?g|webp|gif)$/i.test(name);
  if (isPdf) return { name, kind: 'pdf', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await fileToB64(file) } } };
  if (isImg) { const mt = IMAGE_TYPES.has(type) ? type : (/\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg'); return { name, kind: 'image', block: { type: 'image', source: { type: 'base64', media_type: mt, data: await fileToB64(file) } } }; }
  const txt = await file.text();
  return { name, kind: 'text', block: { type: 'text', text: 'DATEIINHALT (' + name + '):\n' + String(txt).slice(0, 60000) } };
}

// Gespeicherter Chat-Verlauf → API-Nachrichten. Nur die letzten `maxMessages`, sauber
// abwechselnd (user/assistant), erste Nachricht = user. Die Datei hängt nur an der letzten
// Nutzer-Nachricht; ältere Anhänge werden nur namentlich erwähnt.
export function buildApiMessages(history, { maxMessages = 16, attachment } = {}) {
  const src = (history || []).filter(m => m && (m.role === 'user' || m.role === 'assistant')).slice(-Math.max(2, maxMessages));
  const out = [];
  src.forEach((m, i) => {
    const last = i === src.length - 1;
    let text = String(m.content || '').trim();
    if (m.role === 'assistant' && m.steps && m.steps.length) text += (text ? '\n' : '') + '[Ausgeführte Aktionen: ' + m.steps.map(st => st.name + (st.result && st.result.ok === false ? ' (fehlgeschlagen)' : '')).join(', ') + ']';
    if (m.role === 'user' && m.attachmentName && !(last && attachment)) text += (text ? '\n' : '') + '[Datei angehängt: ' + m.attachmentName + ']';
    if (!text && !(last && attachment && m.role === 'user')) return;
    if (out.length && out[out.length - 1].role === m.role) { out[out.length - 1].content += '\n\n' + text; return; }
    out.push({ role: m.role, content: text });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length) out.push({ role: 'user', content: attachment ? 'Hier ist eine Datei.' : 'Hallo' });
  if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: 'Bitte fahre fort.' });
  const msgs = out.map(m => ({ role: m.role, content: [{ type: 'text', text: m.content }] }));
  if (attachment && attachment.block) {
    const lastMsg = msgs[msgs.length - 1];
    const txt = lastMsg.content[0].text.trim() || ('Hier ist eine Datei (' + attachment.name + '). Verarbeite sie sinnvoll – Beleg buchen, Rechnung erstellen oder Umsätze importieren – und frag nur nach, wenn etwas Wichtiges fehlt.');
    lastMsg.content = [attachment.block, { type: 'text', text: txt }];
  }
  // Leere Textblöcke lehnt die API ab
  msgs.forEach(m => m.content.forEach(b => { if (b.type === 'text' && !b.text.trim()) b.text = '…'; }));
  return msgs;
}

const safeJson = (v) => { try { return JSON.stringify(v == null ? { ok: true } : v); } catch (e) { return JSON.stringify({ ok: false, error: 'Ergebnis nicht serialisierbar' }); } };
const textOf = blocks => (blocks || []).filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n').trim();

// Führt eine Runde Nutzer → KI → (Tools → KI)* aus. Gibt {text, steps, stopReason} zurück.
export async function runAssistantTurn({ invoke, model, system, tools, messages, executeTool, maxRounds = 10, maxTokens = 4000, adaptive = true, effort = 'medium', onStep }) {
  let msgs = messages.slice();
  const steps = [];
  let finalText = '';
  let lastText = '';
  let stopReason = 'end_turn';
  for (let round = 0; round < maxRounds; round++) {
    const body = { model, max_tokens: maxTokens, system, messages: msgs, tools };
    if (adaptive) { body.thinking = { type: 'adaptive' }; body.output_config = { effort }; }
    const resp = await invoke(body);
    const blocks = (resp && resp.content) || [];
    stopReason = (resp && resp.stop_reason) || 'end_turn';
    const t = textOf(blocks); if (t) lastText = t;
    const toolUses = blocks.filter(b => b && b.type === 'tool_use');
    if (stopReason === 'refusal') { finalText = t || 'Das kann ich in diesem Fall leider nicht übernehmen.'; break; }
    if (!toolUses.length) { finalText = t; break; }
    msgs = [...msgs, { role: 'assistant', content: blocks }];
    const results = [];
    for (const tu of toolUses) {
      let result; let isError = false;
      try { result = await executeTool(tu.name, tu.input || {}); }
      catch (e) { result = { ok: false, error: String((e && e.message) || e) }; isError = true; }
      const step = { name: tu.name, input: tu.input || {}, result };
      steps.push(step); if (onStep) { try { onStep(step); } catch (e) { /* UI-Fehler nicht in die Schleife tragen */ } }
      const block = { type: 'tool_result', tool_use_id: tu.id, content: safeJson(result) };
      if (isError) block.is_error = true;
      results.push(block);
    }
    msgs = [...msgs, { role: 'user', content: results }];
    if (round === maxRounds - 1) finalText = lastText || 'Ich habe die Schritte ausgeführt, konnte aber nicht mehr alles zusammenfassen.';
  }
  if (!finalText) finalText = lastText || (steps.length ? 'Erledigt.' : '(keine Antwort)');
  if (stopReason === 'max_tokens') finalText += '\n\n(Antwort wurde gekürzt – frag gern nach dem Rest.)';
  return { text: finalText, steps, stopReason };
}
