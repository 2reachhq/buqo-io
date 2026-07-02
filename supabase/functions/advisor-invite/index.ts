// Buqo – Steuerberater einladen
// Legt eine Einladung an (advisor_invitations) und schickt dem Berater per Resend
// eine E-Mail mit Annahme-Link. Nur eingeloggte App-Nutzer.
//
// Benötigte Secrets:
//   RESEND_API_KEY   – Resend-API-Key (bereits für send-invoice vorhanden)
//   MAIL_FROM        – Absender, z. B. "Buqo <einladung@buqo.de>" (verifizierte Domain)
//   APP_URL          – z. B. https://app.buqo.de (Basis für den Annahme-Link)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") || "Buqo <einladung@buqo.de>";
const APP_URL = Deno.env.get("APP_URL") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

function inviteHtml(link: string, fromName: string): string {
  return `<!doctype html><html><body style="margin:0;background:#F5F5F5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #eaeaea;border-radius:16px;padding:32px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
      <div style="width:34px;height:34px;border-radius:9px;background:#0A0A0A;color:#BBF451;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:19px">B</div>
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em">Buqo</div>
    </div>
    <h1 style="font-size:20px;margin:0 0 10px">Sie wurden als Steuerberater eingeladen</h1>
    <p style="font-size:14px;color:#444;line-height:1.6;margin:0 0 20px">
      ${fromName ? `<b>${fromName}</b>` : "Ein Buqo-Nutzer"} möchte Ihnen als Steuerberater Zugriff auf die vorbereitete Buchhaltung geben –
      Belege, Auswertungen (UStVA, EÜR, GuV, BWA, SuSa) und den DATEV-Export. Sie sehen die Daten in einer eigenen
      Steuerberater-Ansicht, ohne selbst buchen zu müssen.
    </p>
    <a href="${link}" style="display:inline-block;background:#007AFF;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:12px">Einladung annehmen</a>
    <p style="font-size:12px;color:#999;line-height:1.6;margin:22px 0 0">
      Falls Sie noch kein Buqo-Konto haben, können Sie sich beim Öffnen des Links direkt als Steuerberater registrieren.
      Der Link ist 30 Tage gültig.
    </p>
  </div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY ist nicht gesetzt." }, 500);

    // 1) Nur eingeloggte Nutzer
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "Nicht eingeloggt" }, 401);

    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    if (!/.+@.+\..+/.test(email)) return json({ error: "Ungültige E-Mail-Adresse." }, 400);

    // 2) Einladung anlegen (RLS erlaubt dem Nutzer nur eigene inviter_user_id).
    const { data: inv, error: invErr } = await supa
      .from("advisor_invitations")
      .insert({ inviter_user_id: user.id, advisor_email: email })
      .select("token")
      .single();
    if (invErr || !inv) return json({ error: invErr?.message || "Einladung konnte nicht angelegt werden." }, 400);

    // 3) Absender-Name (Profil des Einladenden)
    const { data: prof } = await supa.from("profiles").select("full_name, company").eq("id", user.id).maybeSingle();
    const fromName = (prof?.company || prof?.full_name || user.email || "").toString();

    const base = (APP_URL || new URL(req.url).origin).replace(/\/$/, "");
    const link = `${base}/?advisor_invite=${inv.token}`;

    // 4) Mail über Resend
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: `${fromName ? fromName + " lädt Sie" : "Einladung"} als Steuerberater zu Buqo ein`,
        html: inviteHtml(link, fromName),
      }),
    });
    const data = await r.json();
    if (!r.ok) return json({ error: (data && (data.message || data.name)) || "Versand fehlgeschlagen", details: data }, r.status);
    return json({ ok: true, id: data.id || null });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
