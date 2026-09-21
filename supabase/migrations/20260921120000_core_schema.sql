-- Buqo – Kern-Schema (fehlte bisher im Repo!)
--
-- Die App liest/schreibt ihre Fachdaten in genau diese Tabellen und den Storage-Bucket „belege".
-- Bisher lagen nur die Zusatz-Migrationen (Gmail, Resend, Abo/Rollen) im Repo – ein frisch
-- aufgesetztes Supabase-Projekt hatte daher weder app_state noch bookings/events/scan_meta noch
-- den Bucket, und die App meldete „Laden fehlgeschlagen". Dieses Skript ist idempotent
-- (create … if not exists / drop policy if exists) und kann gefahrlos auch auf dem bestehenden
-- Projekt laufen: es legt nur Fehlendes an und schaltet Row Level Security scharf.
--
-- Ausführen im Supabase SQL-Editor oder via `supabase db push`.

-- ── 1) Gesamter App-Zustand (eine Zeile, id = 1) ─────────────────────────────
-- Die App hält Buchungen, Rechnungen, Kunden, Einstellungen, Steuerprofil … als ein JSON-Dokument
-- (Spalte data) plus die Kontonamen (names). Sie lädt beim Start id=1 und speichert per Upsert.
create table if not exists public.app_state (
  id int primary key,
  data jsonb not null default '{}'::jsonb,
  names jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.app_state (id, data, names) values (1, '{}'::jsonb, '{}'::jsonb) on conflict (id) do nothing;

-- ── 2) Belegungskalender (Ferienwohnung/Airbnb) ──────────────────────────────
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  name text,
  checkin date not null,
  checkout date not null,
  amount numeric(12,2),
  status text,
  prop text,
  source text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists bookings_checkin_idx on public.bookings (checkin);

-- ── 3) Termine / Events (Nachfrage-Treiber, wöchentlicher Scan) ──────────────
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  title text not null,
  category text,
  location text,
  url text,
  created_at timestamptz not null default now()
);
create index if not exists events_date_idx on public.events (date);

create table if not exists public.scan_meta (
  id int primary key,
  last_scan timestamptz,
  last_count int
);
insert into public.scan_meta (id) values (1) on conflict (id) do nothing;

-- ── 4) Row Level Security: nur eingeloggte Nutzer ────────────────────────────
-- Der anon-Key steht im JavaScript der App – ohne RLS könnte jeder mit diesem Key die komplette
-- Buchhaltung lesen und überschreiben. Mit diesen Policies kommen nur Nutzer mit gültigem Login
-- (Supabase Auth) an die Daten. Die App ist aktuell bewusst single-tenant (ein Datenbestand,
-- id = 1); eine mandantengetrennte Variante (Spalte user_id + auth.uid()-Policies) ist der
-- nächste Schritt, sobald mehrere Nutzer denselben Supabase-Stand teilen sollen.
alter table public.app_state enable row level security;
alter table public.bookings  enable row level security;
alter table public.events    enable row level security;
alter table public.scan_meta enable row level security;

drop policy if exists app_state_all_authenticated on public.app_state;
create policy app_state_all_authenticated on public.app_state
  for all to authenticated using (true) with check (true);

drop policy if exists bookings_all_authenticated on public.bookings;
create policy bookings_all_authenticated on public.bookings
  for all to authenticated using (true) with check (true);

drop policy if exists events_all_authenticated on public.events;
create policy events_all_authenticated on public.events
  for all to authenticated using (true) with check (true);

drop policy if exists scan_meta_all_authenticated on public.scan_meta;
create policy scan_meta_all_authenticated on public.scan_meta
  for all to authenticated using (true) with check (true);

revoke all on public.app_state, public.bookings, public.events, public.scan_meta from anon;
grant select, insert, update, delete on public.app_state, public.bookings, public.events, public.scan_meta to authenticated;

-- ── 5) Storage-Bucket „belege" (private Belege, signierte URLs) ──────────────
insert into storage.buckets (id, name, public)
  values ('belege', 'belege', false)
  on conflict (id) do nothing;

drop policy if exists belege_select_authenticated on storage.objects;
create policy belege_select_authenticated on storage.objects
  for select to authenticated using (bucket_id = 'belege');

drop policy if exists belege_insert_authenticated on storage.objects;
create policy belege_insert_authenticated on storage.objects
  for insert to authenticated with check (bucket_id = 'belege');

drop policy if exists belege_update_authenticated on storage.objects;
create policy belege_update_authenticated on storage.objects
  for update to authenticated using (bucket_id = 'belege') with check (bucket_id = 'belege');

drop policy if exists belege_delete_authenticated on storage.objects;
create policy belege_delete_authenticated on storage.objects
  for delete to authenticated using (bucket_id = 'belege');
