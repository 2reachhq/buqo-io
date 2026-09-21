# Supabase-Setup für Buqo

Buqo läuft als statische React-App (GitHub Pages) gegen ein Supabase-Projekt:
Auth (E-Mail/Passwort), Postgres (Daten), Storage (Belege) und Edge Functions (KI-Proxy,
Gmail, Resend, Stripe). Diese Anleitung bringt ein Projekt von null auf lauffähig – und
erklärt, was beim bisherigen Setup gefehlt hat.

## Was bisher das „Supabase-Problem" war

Im Repo lagen nur drei Zusatz-Migrationen (Gmail, Resend, Abo/Rollen). Die Kern-Tabellen,
die die App tatsächlich liest und schreibt, waren nirgends definiert:

| Objekt | Zweck | Zugriff in der App |
|---|---|---|
| `app_state` (Zeile `id = 1`) | kompletter App-Zustand als JSON (`data`, `names`) | Laden beim Start, Speichern per Upsert |
| `bookings` | Belegungskalender | Kalender-Tab |
| `events`, `scan_meta` | Termine/Events + Scan-Status | Kalender-Tab |
| Storage-Bucket `belege` | Beleg-Dateien (PDF/JPG) | Upload, signierte URLs |

Folgen je nach Zustand des Projekts:

- Tabellen fehlen → „Laden fehlgeschlagen: relation app_state does not exist".
- Tabelle da, aber Zeile `id = 1` fehlt → früher `.single()`-Fehler; die App legt die Zeile
  jetzt selbst per Upsert an.
- Row Level Security an, aber keine Policy → eingeloggte Nutzer sehen nichts („permission denied").
- Row Level Security aus → jeder mit dem (öffentlichen) anon-Key kann alles lesen und schreiben.

Die Migration `supabase/migrations/20260921120000_core_schema.sql` behebt alle vier Fälle in
einem Rutsch und ist idempotent (kann auch auf dem bestehenden Projekt laufen).

## Schritt für Schritt

1. **Projekt anlegen** (supabase.com) – Region EU. Unter *Authentication → Providers* E-Mail
   aktivieren; für die eigene Nutzung „Confirm email" ausschalten oder eine Absender-Domain
   hinterlegen.
2. **Migrationen ausführen** – entweder per CLI

   ```bash
   supabase link --project-ref <PROJECT-REF>
   supabase db push
   ```

   oder die vier Dateien aus `supabase/migrations/` in dieser Reihenfolge im SQL-Editor ausführen:
   `20260701120000_gmail_integration.sql`, `20260701130000_resend_inbound.sql`,
   `20260702120000_billing_and_roles.sql`, `20260921120000_core_schema.sql`.
3. **App auf das Projekt zeigen** – in `app/src/main.jsx` die Konstanten `SB_URL` und `SB_KEY`
   (Project URL + anon public key aus *Settings → API*) eintragen, dann
   `cd app && npm ci && npm run build` und den Inhalt von `app/dist/` ins Repo-Root kopieren
   (`index.html` + `assets/`), wie bei jedem Deploy.
4. **KI-Proxy deployen** – die Edge Function `ai` braucht den Anthropic-Schlüssel als Secret:

   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy ai
   ```

   Ohne diese Funktion laufen Beleg-Scan, Assistent, BWA-Erklärung und die Erklärungen im
   Steuer-Cockpit nicht; alle deterministischen Berechnungen (UStVA, EÜR, BWA, Steuerprognose)
   funktionieren auch ohne KI.
5. **Optional** – Gmail-Import (`GMAIL_SETUP.md`), Rechnungen per Mail (`RESEND_INBOUND_SETUP.md`),
   Stripe (`stripe-checkout`, `stripe-webhook` mit `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
6. **Ersten Nutzer anlegen** – in der App „Registrieren" (Rolle „Unternehmer / Selbstständig").
   Der Trigger aus der Billing-Migration legt Profil, Abo- und Guthaben-Zeile automatisch an.
   Für die Eigen-Nutzung kann das AI-Guthaben direkt in SQL aufgeladen werden:

   ```sql
   select public.credit_topup('<AUTH-USER-UUID>', 5000, 'manuell', 'bonus');  -- 50,00 €
   ```

## Datenmodell heute und der nächste Schritt

Der komplette Buchhaltungs-Zustand liegt als ein JSON-Dokument in `app_state` (Zeile 1). Das ist
für eine Person schnell, robust und einfach zu sichern (Einstellungen → Daten exportieren).
Sobald mehrere Nutzer getrennte Bücher führen sollen, bekommt `app_state` eine Spalte `user_id`
mit `auth.uid()`-Policies; die Lade-/Speicher-Stelle in `main.jsx` ist dafür bereits auf
`maybeSingle()` + `upsert()` umgestellt, so dass nur der Filter zu ergänzen ist.
