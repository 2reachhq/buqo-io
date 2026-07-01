# Rechnungen per E-Mail-Weiterleitung einrichten (Resend Inbound)

Ergänzt den Code in `supabase/functions/resend-inbound` und
`supabase/migrations/20260701130000_resend_inbound.sql`. Unabhängig von der
Gmail-Integration (`GMAIL_SETUP.md`) – beide füttern dieselbe
Entwürfe-Übersicht (Import → Kontoauszug), können aber getrennt genutzt
werden.

Prinzip: Ihr richtet eine Adresse ein (z. B.
`rechnungen@inbound.designpeak.io`), an die Rechnungs-Mails weitergeleitet
werden bzw. die ihr Lieferanten direkt geben könnt. Resend empfängt die Mail
und ruft einen Webhook mit den Anhängen auf.

## 1. Empfangs-Domain bei Resend einrichten

1. [Resend-Dashboard](https://resend.com/domains) → **Domains** → Domain
   hinzufügen. **Empfehlung:** eine eigene Subdomain nur fürs Empfangen
   verwenden (z. B. `inbound.designpeak.io`), damit die bestehenden
   MX-Records für den normalen Mailverkehr (Google Workspace) nicht
   überschrieben werden.
2. Bei eurem DNS-Anbieter den von Resend angezeigten **MX-Record** auf diese
   Subdomain setzen (Resend zeigt die genaue Priorität/den Zielwert im
   Dashboard an).
3. Im Dashboard unter der Domain **"Receiving"/"Inbound" aktivieren**.

## 2. Webhook-Endpunkt bei Resend anlegen

1. **Resend-Dashboard → Webhooks → Add Webhook**.
2. Endpoint-URL:
   `https://rlorfhpgxmyplmsgmkzw.supabase.co/functions/v1/resend-inbound`
3. Nur das Event **`email.received`** abonnieren.
4. Das angezeigte **Signing Secret** (`whsec_…`) kopieren.

## 3. Supabase-Secrets setzen

```
RESEND_WEBHOOK_SECRET=whsec_…
```

`RESEND_API_KEY` ist bereits vorhanden (wird auch von `send-invoice`
verwendet) – bitte prüfen, ob dieser Key **Lesezugriff auf eingehende Mails/
Anhänge** hat (Resend-Dashboard → API Keys → Permissions). Falls der
vorhandene Key nur "Sending Access" hat, einen zweiten Key mit "Full Access"
anlegen und stattdessen dafür verwenden.

## 4. Datenbank-Migration ausführen

`supabase/migrations/20260701130000_resend_inbound.sql` im Supabase
SQL-Editor ausführen. Legt die Tabelle `resend_import_queue` inkl. Rechten
an.

## 5. Edge Function deployen

```
supabase functions deploy resend-inbound
```

`verify_jwt = false` ist für diese Funktion schon in `supabase/config.toml`
hinterlegt – Resend/Svix ruft sie ohne Supabase-Login-Header auf; die
Funktion prüft die Anfrage stattdessen selbst über die Svix-Signatur.

## 6. Nutzen

Rechnungs-Mails an die eingerichtete Adresse weiterleiten (oder Lieferanten
bitten, direkt dorthin zu senden). PDF-/Bild-Anhänge werden automatisch von
Claude ausgelesen und erscheinen als Entwurf unter **Import → Kontoauszug**
(Status in den App-Einstellungen unter **Einstellungen → E-Mail-
Weiterleitung** sichtbar).

## Funktionsweise (kurz)

- Resend ruft `resend-inbound` bei jeder eingehenden Mail mit Anhang auf
  (Event `email.received`, Payload enthält nur Metadaten der Anhänge).
- Die Funktion prüft die Svix-Signatur, lädt PDF/Bild-Anhänge über die
  Resend-API nach, lässt sie von Claude auslesen (gleiche Logik wie der
  manuelle Beleg-Scan in der App), speichert sie im Storage-Bucket `belege`
  und legt einen Eintrag in `resend_import_queue` an.
- Die App holt offene Einträge von dort und reiht sie in die bestehenden
  Bankauszug-Entwürfe ein.
