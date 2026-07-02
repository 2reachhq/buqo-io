// Buqo – Stripe Webhook (Abo-Status synchronisieren + AI-Guthaben gutschreiben)
// Wird von Stripe ohne Supabase-Login aufgerufen – die Signatur (STRIPE_WEBHOOK_SECRET)
// beweist die Echtheit. In config.toml daher verify_jwt = false.
//
// Benötigte Secrets:
//   STRIPE_SECRET_KEY        – sk_… des BUQO-Kontos
//   STRIPE_WEBHOOK_SECRET    – whsec_… (aus Stripe → Developers → Webhooks → Signing secret)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Findet die Supabase-User-ID zu einem Stripe-Objekt (Metadata oder Customer-Lookup).
async function resolveUserId(meta: Record<string, string> | undefined, customerId?: string): Promise<string | null> {
  if (meta?.supabase_user_id) return meta.supabase_user_id;
  if (customerId) {
    const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).single();
    if (data?.user_id) return data.user_id;
    try {
      const cust = await stripe.customers.retrieve(customerId);
      const uid = (cust as any)?.metadata?.supabase_user_id;
      if (uid) return uid;
    } catch (_) { /* ignore */ }
  }
  return null;
}

async function syncSubscription(sub: Stripe.Subscription) {
  const userId = await resolveUserId(sub.metadata as any, sub.customer as string);
  if (!userId) return;
  // Zusatzkonten = Menge der Zusatz-Position (Preis ≠ Basis-Abo). Wir zählen alle
  // recurring-Items außer dem ersten als Zusatzkonten.
  let extra = 0;
  const items = sub.items?.data || [];
  for (const it of items) {
    if (it.price?.id === Deno.env.get("STRIPE_PRICE_EXTRA_ACCOUNT")) extra += (it.quantity || 0);
  }
  const status = sub.status === "active" || sub.status === "trialing" ? sub.status
    : sub.status === "past_due" || sub.status === "unpaid" ? "past_due"
    : "canceled";
  await admin.from("subscriptions").upsert({
    user_id: userId,
    status,
    stripe_customer_id: sub.customer as string,
    stripe_subscription_id: sub.id,
    extra_accounts: extra,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("STRIPE_WEBHOOK_SECRET missing", { status: 500 });

  const sig = req.headers.get("stripe-signature") || "";
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`signature verification failed: ${(e as Error).message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === "payment" && (s.metadata?.kind === "credits" || s.metadata?.credit_cents)) {
          // AI-Guthaben aufladen (idempotent über stripe_ref = Session-ID).
          const userId = await resolveUserId(s.metadata as any, s.customer as string);
          const cents = parseInt(s.metadata?.credit_cents || "0", 10);
          if (userId && cents > 0) {
            const { data: exists } = await admin.from("ai_credit_ledger").select("id").eq("stripe_ref", s.id).maybeSingle();
            if (!exists) await admin.rpc("credit_topup", { p_user: userId, p_amount_cents: cents, p_stripe_ref: s.id, p_reason: "topup" });
          }
        } else if (s.mode === "subscription" && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription as string);
          await syncSubscription(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        if (inv.subscription) {
          const sub = await stripe.subscriptions.retrieve(inv.subscription as string);
          await syncSubscription(sub);
        }
        break;
      }
      default:
        break;
    }
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 500 });
  }
});
