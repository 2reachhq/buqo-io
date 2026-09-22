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
   `20260702120000_billing_and_roles.sql`, `20260921120000_core_schema.sql`,
   `20260921130000_signup_trigger_hardening.sql`.
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
   funktionieren auch ohne KI. Nach jeder Änderung an `supabase/functions/ai/index.ts` (z. B.
   neue Modelle) muss die Funktion erneut deployt werden – der Assistent nutzt standardmäßig
   `claude-opus-5`; eine alte Proxy-Version fällt still auf `claude-sonnet-4-6` zurück.
5. **Optional** – Gmail-Import (`GMAIL_SETUP.md`), Rechnungen per Mail (`RESEND_INBOUND_SETUP.md`),
   Stripe (`stripe-checkout`, `stripe-webhook` mit `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
6. **Ersten Nutzer anlegen** – in der App „Registrieren" (Rolle „Unternehmer / Selbstständig").
   Der Trigger aus der Billing-Migration legt Profil, Abo- und Guthaben-Zeile automatisch an.
   Für die Eigen-Nutzung kann das AI-Guthaben direkt in SQL aufgeladen werden:

   ```sql
   select public.credit_topup('<AUTH-USER-UUID>', 5000, 'manuell', 'bonus');  -- 50,00 €
   ```

## Wenn Login oder Registrierung scheitern

| Meldung in der App / im Dashboard | Ursache | Abhilfe |
|---|---|---|
| „Supabase ist nicht erreichbar" / Netzwerkfehler | Projekt pausiert (Free-Tarif nach 7 Tagen Inaktivität) | Dashboard → „Restore project" |
| „Database error saving new user" | Signup-Trigger schlägt fehl (Billing-Tabellen/Typ fehlen) | Migration `signup_trigger_hardening` ausführen |
| „email rate limit exceeded" | Standard-SMTP erlaubt nur wenige Mails pro Stunde | Warten, oder Nutzer im Dashboard anlegen (*Authentication → Users → Add user*, „Auto Confirm") |
| „Signups not allowed" | Registrierung deaktiviert | *Authentication → Providers → Email* einschalten, „Allow new users to sign up" |
| „E-Mail noch nicht bestätigt" | Bestätigungslink nicht geklickt | Link klicken, „Bestätigungs-Mail erneut senden", oder „Confirm email" abschalten |
| „E-Mail oder Passwort stimmen nicht" | falsches Passwort / kein Konto | „Passwort vergessen?" in der App |

Schnellster Weg für die Eigen-Nutzung: den Nutzer direkt im Dashboard anlegen (*Authentication →
Users → Add user → Create new user*, Häkchen „Auto Confirm User"). Das umgeht Bestätigungs-Mails
und das Mail-Limit komplett.

## Auto-Pause im Free-Tarif

Supabase pausiert kostenlose Projekte nach 7 Tagen ohne Nutzung. Dann schlagen Login, Registrierung
und Laden gleichzeitig fehl, bis im Dashboard „Restore project" geklickt wird. Der Workflow
`.github/workflows/supabase-keepalive.yml` ruft die API alle 3 Tage auf und hält das Projekt so
wach (GitHub Actions muss für das Repo aktiviert sein). Alternativ: Pro-Tarif, dort gibt es keine
Auto-Pause.

## Solo-Modus (Buqo nur für dich)

Die App läuft mit `SOLO_MODE = true` (in `app/src/main.jsx`): Abo & Guthaben, Team-Einladungen und
Steuerberater-Rollen sind ausgeblendet. Damit die KI-Funktionen ohne Guthaben laufen, einmal

```bash
supabase secrets set BUQO_SOLO=1
supabase functions deploy ai
```

Alternative ohne Redeploy: Guthaben per SQL gutschreiben (`credit_topup`, siehe oben).

## Der Assistent (oben rechts neben dem Profilbild)

Der Chat-Assistent ist ein KI-Agent mit Werkzeugen über die ganze App: Er liest und ändert
Kunden, Rechnungen (Vorschau → Bestätigung → Buchung + PDF), Buchungen/Belege, den Bank-Import,
To-dos, jede Einstellung (Profil, Firmendaten, Kontonamen/Farben, Darstellung, Steuerprofil),
den angezeigten Zeitraum und die Navigation. Angehängte Dateien (PDF, Bild, CSV/XML) gehen
direkt an das Modell – ein Beleg wird gebucht und im Bucket `belege` abgelegt, ein Kontoauszug
landet im Bank-Import. Alles passiert in `app_state` des eingeloggten Kontos; der Verlauf liegt
in `data.assistantChat`, das gewählte Modell in `data.assistant.model`.

Code: `app/src/assistant/` (`tools.js` Werkzeug-Schemas + Systemprompt, `actions.js` reine
Datenfunktionen mit Tests, `agent.js` Tool-Calling-Schleife) und die Ausführung in `main.jsx`
(`runTool`). Der frühere Reiter „KI-Berater" ist entfallen; `#/berater` öffnet den Assistenten,
`#/home` führt auf die Kundenliste (Startseite).

## Umzug aus sevDesk

In der App unter *Sidebar → „Umzug aus sevDesk"* (oder Mehr): CSV-Export der Belege
und Rechnungen plus die ZIP-Dateien mit den PDFs hochladen, Vorschau prüfen, importieren. Erkannt
werden sevDesk-CSV (deutsche und englische Zahlen, UTF-8 oder Windows-1252), DATEV-Buchungsstapel
(EXTF) und beliebige CSVs über die Spalten-Zuordnung. Doppelte Einträge werden übersprungen, PDFs
landen im Bucket `belege` in der gewohnten Ordnerstruktur.

**Mit KI sortieren:** Wer in sevDesk Rechnungen für Immobilien und für Dienstleistungen gemischt hat,
klickt in der Vorschau auf „Jetzt mit KI sortieren". Die KI legt jede Rechnung und jeden Beleg auf
das passende Konto (Firma, Immobilie, Privat) und markiert unsichere Fälle gelb; ein optionaler
Hinweis (z. B. „Mieter Müller = Sylt") hat Vorrang. Rechnungen, ihre Einnahme-Buchungen und neu
angelegte Kunden landen auf dem gewählten Konto. Schon importierte Daten sortiert der Assistent
nachträglich um („Ordne alle Mietrechnungen der Ferienwohnung zu" → Werkzeug `move_to_account`).

## Datenmodell heute und der nächste Schritt

Der komplette Buchhaltungs-Zustand liegt als ein JSON-Dokument in `app_state` (Zeile 1). Das ist
für eine Person schnell, robust und einfach zu sichern (Einstellungen → Daten exportieren).
Sobald mehrere Nutzer getrennte Bücher führen sollen, bekommt `app_state` eine Spalte `user_id`
mit `auth.uid()`-Policies; die Lade-/Speicher-Stelle in `main.jsx` ist dafür bereits auf
`maybeSingle()` + `upsert()` umgestellt, so dass nur der Filter zu ergänzen ist.
