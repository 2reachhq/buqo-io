// Buqo – KI-Proxy (hält den Anthropic-Schlüssel geheim)
// Nur eingeloggte App-Nutzer dürfen diese Funktion aufrufen.
// Zusätzlich: Prepaid-AI-Guthaben. Vor dem Aufruf wird geprüft, ob der Nutzer
// Guthaben hat; nach dem Aufruf werden die realen Anthropic-Kosten × Marge vom
// Guthaben abgebucht (siehe charge_ai_usage in der Migration billing_and_roles).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Erlaubte Modelle (verhindert teure Überraschungen)
const ALLOWED = new Set(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]);

// Anthropic-Rohpreise in EUR-Cent pro 1 Mio. Tokens (Stand 2026-07), input/output
// getrennt. Diese Werte sind die REALEN Kosten; die Marge kommt über MARGIN_MULT dazu.
// (Intern führen wir in „Cent" und behandeln $1 ≈ 100 Cent.)
const PRICE_CENTS_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5":  { in: 100, out: 500 },   // $1 / $5
  "claude-sonnet-4-6": { in: 300, out: 1500 },  // $3 / $15
  "claude-opus-4-8":   { in: 500, out: 2500 },  // $5 / $25
};
// Marge-Multiplikator auf die Rohkosten. Jederzeit hier anpassbar, keine Migration nötig.
const MARGIN_MULT = 3;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

function chargeCents(model: string, inTok: number, outTok: number): { charge: number; raw: number } {
  const p = PRICE_CENTS_PER_MTOK[model] || PRICE_CENTS_PER_MTOK["claude-sonnet-4-6"];
  const raw = (inTok * p.in + outTok * p.out) / 1_000_000; // reale Kosten in Cent
  const charge = raw * MARGIN_MULT;
  return { charge, raw };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1) Nur eingeloggte Nutzer
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "Nicht eingeloggt" }, 401);

    // 2) Guthaben-Guard: mindestens 1 Cent Guthaben nötig, um einen Call zu starten.
    //    Nutzer ohne Guthaben-Konto (z. B. Steuerberater) werden nicht abgerechnet.
    const { data: credit } = await supa.from("ai_credits").select("balance_cents").eq("user_id", user.id).maybeSingle();
    const hasCreditAccount = !!credit;
    if (hasCreditAccount && (credit!.balance_cents ?? 0) <= 0) {
      return json({ error: "AI-Guthaben aufgebraucht", code: "no_credit", balance_cents: credit!.balance_cents ?? 0 }, 402);
    }

    // 3) Anfrage an Claude weiterreichen
    const body = await req.json();
    const model = ALLOWED.has(body.model) ? body.model : "claude-sonnet-4-6";
    const max_tokens = Math.min(body.max_tokens || 2000, 8000);

    const payload: Record<string, unknown> = { model, max_tokens, messages: body.messages };
    if (body.system) payload.system = body.system;
    if (body.tools) payload.tools = body.tools;
    if (body.tool_choice) payload.tool_choice = body.tool_choice;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();

    // 4) Nutzung abrechnen (nur bei Erfolg und wenn ein Guthaben-Konto existiert).
    if (r.ok && hasCreditAccount && data?.usage) {
      const inTok = data.usage.input_tokens || 0;
      const outTok = data.usage.output_tokens || 0;
      const { charge, raw } = chargeCents(model, inTok, outTok);
      const chargeCentsRounded = Math.max(0, Math.ceil(charge)); // mind. 0, auf ganze Cent aufrunden
      try {
        const { data: newBal } = await supa.rpc("charge_ai_usage", {
          p_user: user.id,
          p_charge_cents: chargeCentsRounded,
          p_model: model,
          p_input_tokens: inTok,
          p_output_tokens: outTok,
          p_raw_cost_cents: Number(raw.toFixed(4)),
        });
        // Guthaben-Stand für die UI über einen Header mitgeben (JSON-Antwort bleibt
        // die unveränderte Claude-Antwort, damit der Client-Code nichts umbauen muss).
        return new Response(JSON.stringify(data), {
          status: r.status,
          headers: { ...cors, "content-type": "application/json", "x-buqo-balance-cents": String(newBal ?? "") },
        });
      } catch (_) {
        // Abbuchung fehlgeschlagen → Antwort trotzdem zurückgeben (kein Verlust für
        // den Nutzer); der Fehler wird serverseitig ignoriert.
      }
    }

    return new Response(JSON.stringify(data), {
      status: r.status, headers: { ...cors, "content-type": "application/json" },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
