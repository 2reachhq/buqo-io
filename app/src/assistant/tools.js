// Buqo-Assistent: Werkzeuge, die die KI im Chat aufrufen darf, plus Systemprompt.
// Alle Werkzeuge arbeiten ausschließlich auf den Daten der App (app_state des eingeloggten
// Kontos) – nichts wird außerhalb der App gespeichert. Die Ausführung passiert in main.jsx
// (runTool), hier stehen nur Schemas und Texte.

export const ASSISTANT_MODELS = [
  { id: 'claude-opus-5',    label: 'Claude Opus 5',    hint: 'am schlausten',      adaptive: true },
  { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5',  hint: 'schnell & schlau',   adaptive: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'am günstigsten',     adaptive: false },
];
export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5';

const ACCOUNT_DESC = 'Konto: "firma" (Unternehmen), "privat", "p1"/"p2"/"p3" (Immobilien-Konten) oder der Name des Kontos.';
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const numT = (description) => ({ type: 'number', description });
const boolT = (description) => ({ type: 'boolean', description });
const intT = (description) => ({ type: 'integer', description });

const CUSTOMER_FIELDS = {
  name: str('Anzeigename (Firma oder Vor- und Nachname).'),
  firstName: str('Vorname (optional).'),
  lastName: str('Nachname (optional).'),
  company: str('Firmenname (optional).'),
  anrede: str('Anrede für Briefe.', { enum: ['', 'herr', 'frau'] }),
  address: str('Postanschrift, mehrzeilig mit \\n erlaubt (Straße, PLZ Ort).'),
  email: str('E-Mail-Adresse.'),
  phone: str('Telefon.'),
  website: str('Website.'),
  notes: str('Interne Notizen zum Kunden.'),
  custNo: str('Kundennummer (nur setzen, wenn der Nutzer sie vorgibt; sonst automatisch).'),
};

const INVOICE_ITEM = obj({
  desc: str('Beschreibung der Position.'),
  qty: numT('Menge (Standard 1).'),
  price: numT('Netto-Einzelpreis in Euro.'),
  mwst: numT('MwSt-Satz in Prozent (19, 7 oder 0). Weglassen = Standard des Kontos.'),
}, ['desc', 'price']);

const BOOKING_FIELDS = {
  name: str('Bezeichnung / Lieferant / Kunde.'),
  amount: numT('Bruttobetrag in Euro (immer positiv).'),
  date: str('Datum als JJJJ-MM-TT. Weglassen = heute.'),
  category: str('Kategorie: Allgemein, Miete, Nebenkosten, Versicherung, Material, Personal, Steuern, Software, Marketing, Reise, Bewirtung, Bank & Gebühren, Sonstiges. Weglassen = automatisch geraten.'),
  note: str('Notiz / Verwendungszweck.'),
  belegnr: str('Beleg-/Rechnungsnummer des Belegs.'),
  netto: numT('Nettobetrag, falls bekannt.'),
  mwst: numT('MwSt-Satz in Prozent, falls bekannt.'),
  status: str('"offen" (Standard: wartet auf Bankbestätigung), "bezahlt" (Einnahme eingegangen) oder "abgebucht" (Ausgabe vom Konto abgegangen).', { enum: ['offen', 'bezahlt', 'abgebucht'] }),
};

export const ASSISTANT_TOOLS = [
  // ── Lesen ──────────────────────────────────────────────────────────────────
  {
    name: 'get_overview',
    description: 'Finanz-Überblick: Einnahmen/Ausgaben/Ergebnis für Monat und Jahr, je Konto, Rechnungsstatus, offene Belege, To-dos. Nutze das für Fragen wie "wie läuft es", "wie steht die Firma da".',
    input_schema: obj({ year: intT('Jahr (Standard: aktuell gewähltes Jahr).'), month: intT('Monat 1–12 (Standard: aktuell gewählter Monat).') }),
  },
  {
    name: 'list_customers',
    description: 'Kundenliste mit id, Kundennummer, Name, Konto, Adresse, E-Mail, Telefon. Optional nach Suchbegriff oder Konto filtern.',
    input_schema: obj({ query: str('Suchbegriff (Name, E-Mail, Kundennummer).'), account: str(ACCOUNT_DESC) }),
  },
  {
    name: 'list_invoices',
    description: 'Rechnungen auflisten (Nummer, Kunde, Datum, Fälligkeit, Betrag, bezahlt/offen/überfällig).',
    input_schema: obj({
      status: str('Filter.', { enum: ['alle', 'offen', 'bezahlt', 'ueberfaellig'] }),
      customer: str('Kunde (Name, Kundennummer oder id).'),
      year: intT('Nur Rechnungen dieses Jahres.'),
      limit: intT('Maximale Anzahl (Standard 50).'),
    }),
  },
  {
    name: 'get_invoice',
    description: 'Eine Rechnung mit allen Positionen anzeigen.',
    input_schema: obj({ number: str('Rechnungsnummer, z. B. 2026-003, oder id.') }, ['number']),
  },
  {
    name: 'list_bookings',
    description: 'Buchungen (Belege, Einnahmen, Ausgaben) eines Zeitraums auflisten – mit id, Konto, Art, Name, Betrag, Datum, Kategorie, Status.',
    input_schema: obj({
      year: intT('Jahr (Standard: aktuelles Jahr).'),
      month: intT('Monat 1–12. Weglassen = ganzes Jahr.'),
      account: str(ACCOUNT_DESC),
      kind: str('"ein" = Einnahmen, "aus" = Ausgaben.', { enum: ['ein', 'aus'] }),
      query: str('Suchbegriff in Name/Notiz/Belegnummer.'),
      limit: intT('Maximale Anzahl (Standard 80).'),
    }),
  },
  {
    name: 'list_todos',
    description: 'To-dos / Aufgaben auflisten.',
    input_schema: obj({ status: str('Filter.', { enum: ['offen', 'erledigt', 'alle'] }) }),
  },
  {
    name: 'list_recurring_invoices',
    description: 'Wiederkehrende Rechnungen (z. B. monatliche Miete) auflisten.',
    input_schema: obj({}),
  },
  {
    name: 'get_settings',
    description: 'Aktuelle Einstellungen lesen: profil (Nutzer), firma (Firmendaten je Konto inkl. IBAN, Steuernummer, Rechnungstexte, Absender-E-Mail), konten (Kontonamen, Icons, Farben), darstellung (Hell/Dunkel, Farben), steuerprofil (Annahmen für die Steuerprognose je Jahr), assistent (Modell). "alle" liefert alles.',
    input_schema: obj({
      section: str('Bereich.', { enum: ['alle', 'profil', 'firma', 'konten', 'darstellung', 'steuerprofil', 'assistent'] }),
      account: str('Für "firma": ' + ACCOUNT_DESC),
      year: intT('Für "steuerprofil": Jahr.'),
    }, ['section']),
  },
  {
    name: 'get_tax_estimate',
    description: 'Steuerprognose (Einkommensteuer, Gewerbesteuer, Rücklage pro Monat) für ein Jahr – dieselbe Rechnung wie das Steuer-Cockpit der App.',
    input_schema: obj({ year: intT('Steuerjahr (Standard: aktuelles Jahr).') }),
  },

  // ── Kunden ────────────────────────────────────────────────────────────────
  {
    name: 'create_customer',
    description: 'Neuen Kunden anlegen. Kundennummer wird automatisch vergeben. Vorher mit list_customers prüfen, ob er schon existiert.',
    input_schema: obj({ ...CUSTOMER_FIELDS, account: str(ACCOUNT_DESC + ' Standard: firma.') }, ['name']),
  },
  {
    name: 'update_customer',
    description: 'Kundendaten ändern (nur die angegebenen Felder werden überschrieben).',
    input_schema: obj({ customer: str('Kunde (id, Kundennummer oder Name).'), ...CUSTOMER_FIELDS }, ['customer']),
  },
  {
    name: 'delete_customer',
    description: 'Kunden löschen. Erst den Nutzer fragen, dann mit confirmed=true aufrufen.',
    input_schema: obj({ customer: str('Kunde (id, Kundennummer oder Name).'), confirmed: boolT('Nur true, wenn der Nutzer das Löschen ausdrücklich bestätigt hat.') }, ['customer', 'confirmed']),
  },

  // ── Rechnungen ────────────────────────────────────────────────────────────
  {
    name: 'create_invoice',
    description: 'Rechnung erstellen. Standard: Es wird eine Vorschau mit Bestätigungs-Button gezeigt; die Rechnung wird erst nach Bestätigung (Button oder confirm_invoice) gebucht und als PDF abgelegt. Nur wenn der Nutzer ausdrücklich "direkt/ohne Rückfrage" sagt, book_now=true setzen. Bestehende Kunden über "customer" referenzieren; neue Kunden über customer_name + customer_address (werden automatisch angelegt). Pflicht: Kunde, Anschrift, mindestens eine Position mit Preis.',
    input_schema: obj({
      customer: str('Bestehender Kunde (id, Kundennummer oder Name).'),
      customer_name: str('Name eines NEUEN Kunden (wenn "customer" nicht passt).'),
      customer_address: str('Anschrift des Kunden (Pflicht, falls beim Kunden keine hinterlegt ist).'),
      customer_email: str('E-Mail des Kunden (optional).'),
      account: str('Konto, auf das die Einnahme gebucht wird. ' + ACCOUNT_DESC + ' Standard: Konto des Kunden bzw. firma.'),
      date: str('Rechnungsdatum JJJJ-MM-TT (Standard heute).'),
      due: str('Fälligkeitsdatum JJJJ-MM-TT (Standard: 14 Tage).'),
      items: { type: 'array', items: INVOICE_ITEM, description: 'Rechnungspositionen.' },
      note: str('Bemerkung auf der Rechnung.'),
      header_text: str('Eigener Einleitungstext (optional).'),
      footer_text: str('Eigener Schlusstext (optional).'),
      book_now: boolT('true = sofort buchen ohne Vorschau (nur bei ausdrücklichem Wunsch).'),
    }, ['items']),
  },
  {
    name: 'confirm_invoice',
    description: 'Die zuletzt mit create_invoice vorbereitete Rechnung buchen (wenn der Nutzer per Text bestätigt, z. B. "ja, erstellen").',
    input_schema: obj({}),
  },
  {
    name: 'mark_invoice_paid',
    description: 'Rechnung als bezahlt (oder wieder als offen) markieren.',
    input_schema: obj({ number: str('Rechnungsnummer oder id.'), paid: boolT('true = bezahlt, false = offen.'), date: str('Zahlungsdatum JJJJ-MM-TT (Standard heute).') }, ['number', 'paid']),
  },
  {
    name: 'delete_invoice',
    description: 'Rechnung samt zugehöriger Buchung löschen. Erst fragen, dann confirmed=true.',
    input_schema: obj({ number: str('Rechnungsnummer oder id.'), confirmed: boolT('Nur true nach ausdrücklicher Bestätigung.') }, ['number', 'confirmed']),
  },
  {
    name: 'send_invoice_email',
    description: 'Öffnet den E-Mail-Versand für eine Rechnung (mit PDF-Anhang). Der Nutzer prüft und klickt selbst auf Senden – es wird nichts automatisch verschickt.',
    input_schema: obj({ number: str('Rechnungsnummer oder id.') }, ['number']),
  },
  {
    name: 'prepare_payment_reminder',
    description: 'Zahlungserinnerung / Mahnung zu einer offenen Rechnung vorbereiten (öffnet E-Mail-Entwurf zur Prüfung, sendet nicht automatisch).',
    input_schema: obj({ number: str('Rechnungsnummer oder id.') }, ['number']),
  },
  {
    name: 'create_recurring_invoice',
    description: 'Wiederkehrende (monatliche) Rechnung anlegen, z. B. Miete. Die App erzeugt daraus automatisch jeden Monat eine Rechnung.',
    input_schema: obj({
      customer: str('Bestehender Kunde (id, Kundennummer oder Name).'),
      customer_name: str('Name eines neuen Kunden.'),
      customer_address: str('Anschrift des Kunden.'),
      customer_email: str('E-Mail des Kunden.'),
      account: str(ACCOUNT_DESC),
      from_year: intT('Startjahr.'), from_month: intT('Startmonat 1–12.'),
      to_year: intT('Endjahr.'), to_month: intT('Endmonat 1–12.'),
      gen_day: intT('Tag im Monat, an dem die Rechnung erzeugt wird (Standard 1).'),
      items: { type: 'array', items: INVOICE_ITEM, description: 'Positionen.' },
      note: str('Bemerkung.'),
    }, ['items', 'from_year', 'from_month']),
  },

  // ── Buchungen / Belege ────────────────────────────────────────────────────
  {
    name: 'add_booking',
    description: 'Einnahme oder Ausgabe (Beleg) auf ein Konto buchen. Für wiederkehrende Buchungen recurring=true plus Zeitraum. Der angehängte Beleg (Datei) wird automatisch mit abgelegt, wenn eine Datei im Chat hängt.',
    input_schema: obj({
      account: str(ACCOUNT_DESC),
      kind: str('"ein" = Einnahme, "aus" = Ausgabe.', { enum: ['ein', 'aus'] }),
      ...BOOKING_FIELDS,
      recurring: boolT('true = jeden Monat (z. B. Miete, Abo).'),
      from_year: intT('Wiederkehrend: Startjahr.'), from_month: intT('Wiederkehrend: Startmonat 1–12.'),
      until_year: intT('Wiederkehrend: Endjahr (Standard: Dezember des Startjahres).'), until_month: intT('Wiederkehrend: Endmonat 1–12.'),
      attach_file: boolT('true (Standard) = angehängte Datei als Beleg speichern.'),
    }, ['account', 'kind', 'name', 'amount']),
  },
  {
    name: 'update_booking',
    description: 'Bestehende Buchung ändern (id aus list_bookings). Nur angegebene Felder werden geändert.',
    input_schema: obj({ id: str('Buchungs-id.'), kind: str('Art ändern.', { enum: ['ein', 'aus'] }), account: str('Auf dieses Konto verschieben. ' + ACCOUNT_DESC), ...BOOKING_FIELDS }, ['id']),
  },
  {
    name: 'move_to_account',
    description: 'Rechnungen und/oder Buchungen auf ein anderes Konto legen (z. B. Mietrechnungen von der Firma zur Immobilie). Mehrere auf einmal möglich – für „sortier alles richtig" erst list_invoices/list_bookings lesen, dann hier in Blöcken zuordnen. Bei Rechnungen wird die verknüpfte Einnahme-Buchung mitverschoben.',
    input_schema: obj({
      items: { type: 'array', description: 'Zuordnungen.', items: obj({
        type: str('"rechnung" oder "buchung".', { enum: ['rechnung', 'buchung'] }),
        id: str('Rechnungsnummer/-id bzw. Buchungs-id.'),
        account: str(ACCOUNT_DESC),
      }, ['type', 'id', 'account']) },
      customer_too: boolT('Bei Rechnungen auch den Kunden diesem Konto zuordnen (Standard true).'),
    }, ['items']),
  },
  {
    name: 'delete_booking',
    description: 'Buchung löschen. Erst fragen, dann confirmed=true.',
    input_schema: obj({ id: str('Buchungs-id.'), confirmed: boolT('Nur true nach ausdrücklicher Bestätigung.') }, ['id', 'confirmed']),
  },
  {
    name: 'add_import_drafts',
    description: 'Mehrere Umsätze (z. B. aus einem Kontoauszug oder einer Abrechnung) als Entwürfe in den Bank-Import legen. Dort ordnet der Nutzer sie per Klick Konten zu; Dubletten und Zahlungseingänge werden automatisch erkannt.',
    input_schema: obj({
      items: { type: 'array', description: 'Umsätze.', items: obj({
        name: str('Name/Verwendungszweck (kurz).'), amount: numT('Betrag positiv.'), kind: str('"ein" oder "aus".', { enum: ['ein', 'aus'] }),
        date: str('JJJJ-MM-TT.'), note: str('Verwendungszweck (lang).'), belegnr: str('Referenz/Belegnummer.'), category: str('Kategorie.'),
      }, ['name', 'amount', 'kind']) },
    }, ['items']),
  },
  {
    name: 'extract_attachment_items',
    description: 'Angehängte Datei (Kontoauszug, Airbnb-/Booking-Abrechnung, Beleg) mit dem Beleg-Scanner der App in einzelne Umsätze zerlegen – für lange Auszüge. Mit import=true landen sie direkt im Bank-Import.',
    input_schema: obj({ import: boolT('true = direkt in den Bank-Import übernehmen (Standard true).') }),
  },

  // ── To-dos ────────────────────────────────────────────────────────────────
  {
    name: 'create_todo',
    description: 'Aufgabe anlegen.',
    input_schema: obj({ title: str('Titel.'), note: str('Beschreibung.') }, ['title']),
  },
  {
    name: 'update_todo',
    description: 'Aufgabe ändern oder abhaken.',
    input_schema: obj({ id: str('Aufgaben-id oder (Teil des) Titels.'), done: boolT('true = erledigt.'), title: str('Neuer Titel.'), note: str('Neue Beschreibung.') }, ['id']),
  },
  {
    name: 'delete_todo',
    description: 'Aufgabe löschen.',
    input_schema: obj({ id: str('Aufgaben-id oder (Teil des) Titels.') }, ['id']),
  },

  // ── Einstellungen & App ───────────────────────────────────────────────────
  {
    name: 'update_settings',
    description: 'Einstellungen ändern. section=profil: name, phone, contactEmail. section=firma (+account): name, address, email, phone, iban, bic, taxId (Steuernummer), ustId, defMwst (Standard-MwSt %), invHeaderDefault, invFooterDefault, senderEmail, senderName, contactName, contactEmail. section=konten: names {unternehmen, p1, p2, p3, privatLabel}, icon {p1:"house"|"bed"|"brief"|"prson"|"grid"|"cal"|"doc"}, color {p1:"#RRGGBB"}. section=darstellung: theme "light"|"dark"|"system", colors {pri, accent, grn, red, amb, exp} als Hex. section=steuerprofil (+year): veranlagung "einzel"|"zusammen", kirche (0/8/9 %), hebesatz, firmaArt "gewerbe"|"freiberuf", kvpv, altersvorsorge, sonstigeVorsorge, sonderausgaben, kinder, vzEst, vzGewst, gebaeudewert {p1:…}, afaSatz {p1:…}. section=assistent: model.',
    input_schema: obj({
      section: str('Bereich.', { enum: ['profil', 'firma', 'konten', 'darstellung', 'steuerprofil', 'assistent'] }),
      patch: { type: 'object', description: 'Felder, die geändert werden sollen (siehe Beschreibung).', additionalProperties: true },
      account: str('Für "firma": ' + ACCOUNT_DESC),
      year: intT('Für "steuerprofil": Jahr.'),
    }, ['section', 'patch']),
  },
  {
    name: 'open_app_tab',
    description: 'Bereich der App öffnen: kunden, rechnung (sub: neu | wiederkehrend), belege, bank (Kontoauszug-Import), aufgaben, konten (sub: firma | privat | p1 | p2 | p3 | alle), steuer (Steuerprognose), steuern (sub: ustva | euer | guv | bwa | susa | datev), analyse, raten, events, download, kosten, sevdesk, settings (sub: profil | konten | gmail | email-import | admin).',
    input_schema: obj({ tab: str('Bereich.'), sub: str('Unterbereich (optional).') }, ['tab']),
  },
  {
    name: 'set_period',
    description: 'Angezeigten Monat/Jahr der App wechseln.',
    input_schema: obj({ year: intT('Jahr.'), month: intT('Monat 1–12.') }, ['year', 'month']),
  },
  {
    name: 'export_data',
    description: 'Alle Daten als JSON-Datei herunterladen (Backup).',
    input_schema: obj({}),
  },
];

export const TOOL_NAMES = new Set(ASSISTANT_TOOLS.map(t => t.name));

// Kurze deutsche Beschriftung für den "Aktionen"-Verlauf unter einer Antwort.
export function stepLabel(step) {
  const n = step && step.name; const inp = (step && step.input) || {}; const r = (step && step.result) || {};
  const fail = r && r.ok === false;
  const lbl = {
    get_overview: 'Überblick gelesen', list_customers: 'Kunden gelesen', list_invoices: 'Rechnungen gelesen', get_invoice: 'Rechnung gelesen',
    list_bookings: 'Buchungen gelesen', list_todos: 'To-dos gelesen', list_recurring_invoices: 'Wiederkehrende Rechnungen gelesen',
    get_settings: 'Einstellungen gelesen', get_tax_estimate: 'Steuerprognose berechnet',
    create_customer: 'Kunde angelegt' + (r.name ? ': ' + r.name : ''), update_customer: 'Kunde geändert' + (r.name ? ': ' + r.name : ''), delete_customer: 'Kunde gelöscht',
    create_invoice: r.booked ? ('Rechnung ' + (r.number || '') + ' gebucht') : ('Rechnungsentwurf ' + (r.number || '') + ' vorbereitet'),
    confirm_invoice: 'Rechnung ' + (r.number || '') + ' gebucht', mark_invoice_paid: 'Rechnung ' + (r.number || '') + (inp.paid === false ? ' auf offen gesetzt' : ' als bezahlt markiert'),
    delete_invoice: 'Rechnung gelöscht', move_to_account: (r.moved != null ? r.moved + ' ' : '') + 'Posten umsortiert', send_invoice_email: 'E-Mail-Versand geöffnet', prepare_payment_reminder: 'Mahnung vorbereitet', create_recurring_invoice: 'Wiederkehrende Rechnung angelegt',
    add_booking: (inp.kind === 'ein' ? 'Einnahme' : 'Ausgabe') + ' gebucht' + (inp.name ? ': ' + inp.name : ''), update_booking: 'Buchung geändert', delete_booking: 'Buchung gelöscht',
    add_import_drafts: (r.added != null ? r.added + ' ' : '') + 'Umsätze in den Bank-Import gelegt', extract_attachment_items: 'Datei ausgelesen' + (r.count != null ? ' (' + r.count + ' Posten)' : ''),
    create_todo: 'To-do angelegt', update_todo: 'To-do geändert', delete_todo: 'To-do gelöscht',
    update_settings: 'Einstellungen geändert (' + (inp.section || '') + ')', open_app_tab: 'Bereich geöffnet: ' + (inp.tab || ''), set_period: 'Zeitraum gewechselt', export_data: 'Daten exportiert',
  }[n] || n;
  return (fail ? '⚠️ ' : '') + lbl + (fail && r.error ? ' – ' + r.error : '');
}

// Systemprompt: Rolle, Regeln, Kontext. Der Kontext (Zahlen, Konten, Einstellungen) wird pro
// Anfrage frisch aus der App gebaut und hier nur eingesetzt.
export function buildSystemPrompt(ctx) {
  const c = ctx || {};
  const lines = [];
  lines.push('Du bist der Buqo-Assistent: die KI-Buchhaltung in der App „Buqo" (Deutschland) für einen selbstständigen Nutzer mit Firma, ggf. vermieteten Immobilien und privaten Ausgaben. Du bist gleichzeitig persönlicher Assistent, Buchhalter und Sparringspartner in Steuerfragen.');
  lines.push('Alles, was du tust, passiert in der App des Nutzers – seine Daten bleiben in seinem Konto. Du hast Werkzeuge, mit denen du ALLES lesen und erledigen kannst: Kunden, Rechnungen, Buchungen/Belege, Bank-Import, To-dos, jede Einstellung, Navigation, Zeitraum, Export. Nutze sie, statt den Nutzer auf die Oberfläche zu verweisen.');
  lines.push('');
  lines.push('ARBEITSWEISE');
  lines.push('- Der Nutzer will so wenig wie möglich selbst tun. Erledige Aufträge direkt und vollständig. Fehlt eine Pflichtangabe (z. B. Anschrift für eine Rechnung), frag genau EINE kurze Rückfrage; alles Übrige sinnvoll annehmen (Datum = heute, Konto = Firma bei geschäftlichen Vorgängen, Standard-MwSt des Kontos) und die Annahme kurz nennen.');
  lines.push('- Fakten NIE erfinden: Zahlen, Kunden, Rechnungen immer über Werkzeuge nachschlagen. Prüfe vor dem Anlegen eines Kunden mit list_customers, ob er schon existiert.');
  lines.push('- Rechnungen: create_invoice zeigt eine Vorschau mit Bestätigungs-Button; sag dem Nutzer nur kurz, dass er bestätigen soll. Bestätigt er per Text ("ja", "passt", "erstellen"), rufe confirm_invoice auf. book_now nur bei ausdrücklichem Wunsch.');
  lines.push('- Löschen (Kunde, Rechnung, Buchung): einmal kurz rückfragen, dann mit confirmed=true ausführen.');
  lines.push('- Angehängte Dateien liest du selbst: Beleg/Quittung → add_booking (Konto erfragen, wenn unklar); Kontoauszug oder Plattform-Abrechnung → add_import_drafts (bei sehr vielen Umsätzen extract_attachment_items); Auftrags-/Leistungsdaten → create_invoice; Kundenliste → create_customer je Kunde. Fasse kurz zusammen, was du aus der Datei gelesen hast.');
  lines.push('- Nach Aktionen: in einem Satz sagen, was erledigt ist (mit Nummern/Beträgen). Keine Wiederholung der Frage, keine Einleitungen.');
  lines.push('- Einstellungen: erst get_settings lesen, dann update_settings mit nur den geänderten Feldern.');
  lines.push('- Sortieren (z. B. „ordne alle Rechnungen richtig zu", Immobilie vs. Firma): Rechnungen mit list_invoices (limit hoch, z. B. 500) und Buchungen mit list_bookings lesen, anhand von Kunde, Leistung und Kontonamen entscheiden (Miete, Ferienwohnung, Airbnb, Nebenkosten → Immobilien-Konto; Dienstleistungen, Projekte → Firma), dann nur die falsch liegenden mit move_to_account verschieben. Unklare Fälle nicht raten, sondern am Ende kurz auflisten und nachfragen.');
  lines.push('- Werkzeug-Ergebnisse mit ok=false sind Fehler: erkläre kurz und schlage den nächsten Schritt vor.');
  lines.push('');
  lines.push('STIL');
  lines.push('- Deutsch, Du-Form, freundlich-direkt wie ein erfahrener Buchhalter. Kurz: meist 1–4 Sätze; Listen nur, wenn mehrere Einträge gezeigt werden (Zeilen mit „• "). Kein Markdown (keine #, keine **, keine Tabellen).');
  lines.push('- Beträge in Euro mit Komma (1.234,56 €). Datumsangaben deutsch (12.03.2026).');
  lines.push('- Bei verbindlichen Steuerfragen ein kurzer Hinweis, dass der Steuerberater final entscheidet – nicht bei jeder Antwort.');
  lines.push('');
  lines.push('KONTEXT');
  if (c.today) lines.push('Heute: ' + c.today + '. In der App gewählter Zeitraum: ' + (c.period || '—') + '.');
  if (c.user) lines.push('Nutzer: ' + c.user + '.');
  if (c.accounts && c.accounts.length) lines.push('Konten (Schlüssel → Name): ' + c.accounts.map(a => a.key + ' → ' + a.name).join(', ') + '. Immobilien-Konten sind nur die angelegten.');
  if (c.company) lines.push('Firma: ' + c.company + '.');
  if (c.finance) lines.push('Zahlen:\n' + c.finance);
  if (c.counts) lines.push('Bestand: ' + c.counts + '.');
  if (c.pendingInvoice) lines.push('Es liegt ein unbestätigter Rechnungsentwurf vor: ' + c.pendingInvoice + '. Bestätigt der Nutzer, rufe confirm_invoice auf; will er etwas ändern, rufe create_invoice erneut mit den korrigierten Daten auf.');
  if (c.attachment) lines.push('An die aktuelle Nachricht ist eine Datei angehängt: ' + c.attachment + '.');
  return lines.join('\n');
}
