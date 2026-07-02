// Buqo – Stripe Checkout (Abo + AI-Guthaben aufladen)
// Legt Stripe-Checkout-Sessions an. Nur eingeloggte App-Nutzer.
//
// Benötigte Secrets (Supabase → Project Settings → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY            – sk_live_… bzw. sk_test_… des BUQO-Stripe-Kontos
//   STRIPE_PRICE_SUBSCRIPTION    – Price-ID des 14,99-€-Basis-Abos (recurring, monatlich)
//   STRIPE_PRICE_EXTRA_ACCOUNT   – Price-ID des 7-€-Zusatzkontos (recurring, monatlich, mengenbasiert)
//   APP_URL                      – z. B. https://app.buqo.de (für success/cancel-Redirect)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const PRICE_SUBSCRIPTION = Deno.env.get("STRIPE_PRICE_SUBSCRIPTION") || "";
const PRICE_EXTRA_ACCOUNT = Deno.env.get("STRIPE_PRICE_EXTRA_ACCOUNT") || "";
const APP_URL = Deno.env.get("APP_URL") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

// Sorgt dafür, dass der Nutzer genau einen Stripe-Customer hat, und speichert die ID.
async function ensureCustomer(admin: any, userId: string, email: string): Promise<string> {
  const { data: sub } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", userId).single();
  if (sub?.stripe_customer_id) return sub.stripe_customer_id;
  const customer = await stripe.customers.create({ email, metadata: { supabase_user_id: userId } });
  await admin.from("subscriptions").upsert({ user_id: userId, stripe_customer_id: customer.id }, { onConflict: "user_id" });
  return customer.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!STRIPE_SECRET_KEY) return json({ error: "STRIPE_SECRET_KEY ist nicht gesetzt." }, 500);

    // 1) Nur eingeloggte Nutzer
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "Nicht eingeloggt" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const body = await req.json();
    const kind = String(body.kind || "");
    const base = (APP_URL || new URL(req.url).origin).replace(/\/$/, "");
    const customerId = await ensureCustomer(admin, user.id, user.email || body.email || "");

    if (kind === "subscription") {
      if (!PRICE_SUBSCRIPTION) return json({ error: "STRIPE_PRICE_SUBSCRIPTION ist nicht gesetzt." }, 500);
      const extra = Math.max(0, Math.min(100, parseInt(body.extraAccounts, 10) || 0));
      const line_items: any[] = [{ price: PRICE_SUBSCRIPTION, quantity: 1 }];
      if (extra > 0 && PRICE_EXTRA_ACCOUNT) line_items.push({ price: PRICE_EXTRA_ACCOUNT, quantity: extra });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items,
        allow_promotion_codes: true,
        client_reference_id: user.id,
        subscription_data: { metadata: { supabase_user_id: user.id, extra_accounts: String(extra) } },
        success_url: `${base}/?checkout=success`,
        cancel_url: `${base}/?checkout=cancel`,
      });
      return json({ url: session.url });
    }

    if (kind === "credits") {
      // Prepaid AI-Guthaben. Betrag frei (Pakete 5/10/25 € oder Eingabe), in Cent.
      const amountCents = Math.max(200, Math.min(50000, parseInt(body.amountCents, 10) || 0));
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: amountCents,
            product_data: { name: "Buqo AI-Guthaben", description: `${(amountCents / 100).toFixed(2)} € AI-Guthaben` },
          },
        }],
        payment_intent_data: { metadata: { supabase_user_id: user.id, credit_cents: String(amountCents) } },
        metadata: { supabase_user_id: user.id, credit_cents: String(amountCents), kind: "credits" },
        success_url: `${base}/?checkout=credits_success`,
        cancel_url: `${base}/?checkout=cancel`,
      });
      return json({ url: session.url });
    }

    if (kind === "portal") {
      // Kundenportal (Abo verwalten/kündigen, Zahlungsmethode ändern).
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${base}/`,
      });
      return json({ url: session.url });
    }

    return json({ error: "Unbekannter Vorgang." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
