-- Buqo – Abo, AI-Guthaben und Steuerberater-Rollen
-- Ausführen im Supabase SQL-Editor (oder via `supabase db push`).
--
-- Architektur-Hinweis: Die App speichert ihre Fachdaten bisher single-tenant
-- (app_state id=1, bookings, events …). Die folgenden Tabellen hängen dagegen
-- PRO Auth-Nutzer (auth.uid()) und sind rein additiv – sie fassen das bestehende
-- Datenmodell nicht an. Damit lässt sich Abrechnung/Rollen einführen, ohne die
-- laufende App zu brechen.

-- ── 0) Rollen-Typ ───────────────────────────────────────────────────────────
do $$ begin
  create type public.app_role as enum ('user', 'advisor');
exception when duplicate_object then null; end $$;

-- ── 1) Profile (erweitert auth.users) ───────────────────────────────────────
-- Eine Zeile je Auth-Nutzer. Trägt Rolle (Nutzer vs. Steuerberater), Anzeigename
-- und Firma. Wird beim ersten Login automatisch angelegt (Trigger unten).
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'user',
  full_name text,
  company text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Steuerberater dürfen die Profile ihrer verknüpften Mandanten sehen (Name/Firma).
drop policy if exists profiles_select_as_advisor on public.profiles;
create policy profiles_select_as_advisor on public.profiles
  for select to authenticated using (
    exists (
      select 1 from public.advisor_links al
      where al.advisor_user_id = auth.uid() and al.client_user_id = profiles.id
    )
  );

-- Profil automatisch beim Signup anlegen. Die Rolle kommt – falls gesetzt – aus
-- den raw_user_meta_data (der Client schickt {role:'advisor'} bei der Steuerberater-
-- Registrierung mit), sonst 'user'.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    coalesce((new.raw_user_meta_data->>'role')::public.app_role, 'user'),
    new.raw_user_meta_data->>'full_name'
  )
  on conflict (id) do nothing;

  -- Nur echte Nutzer (keine Steuerberater) bekommen ein Abo- und Guthaben-Konto.
  if coalesce(new.raw_user_meta_data->>'role', 'user') <> 'advisor' then
    insert into public.subscriptions (user_id) values (new.id) on conflict do nothing;
    insert into public.ai_credits (user_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 2) Abo (ein Plan: 14,99 €/Monat, +7 € je Zusatzkonto) ───────────────────
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'none' check (status in ('none','trialing','active','past_due','canceled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  -- Zusätzliche Konten über das erste hinaus (je 7 €/Monat).
  extra_accounts int not null default 0 check (extra_accounts >= 0),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = auth.uid());
-- Schreibzugriff nur über die Edge Functions (service_role, umgeht RLS).

-- ── 3) AI-Guthaben (prepaid, in Euro-Cent geführt) ──────────────────────────
create table if not exists public.ai_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance_cents bigint not null default 0,
  -- Auto-Aufladung: wenn Guthaben < threshold, automatisch topup_cents nachladen.
  auto_recharge boolean not null default false,
  auto_threshold_cents bigint not null default 100,
  auto_topup_cents bigint not null default 1000,
  updated_at timestamptz not null default now()
);

alter table public.ai_credits enable row level security;

drop policy if exists ai_credits_select_own on public.ai_credits;
create policy ai_credits_select_own on public.ai_credits
  for select to authenticated using (user_id = auth.uid());

-- Nutzer darf nur die Auto-Aufladungs-Einstellungen ändern (nicht den Kontostand).
drop policy if exists ai_credits_update_settings on public.ai_credits;
create policy ai_credits_update_settings on public.ai_credits
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.ai_credits from authenticated;
grant update (auto_recharge, auto_threshold_cents, auto_topup_cents) on public.ai_credits to authenticated;

-- Transaktions-Log: jede Gutschrift/Abbuchung nachvollziehbar.
create table if not exists public.ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta_cents bigint not null,               -- negativ = Nutzung, positiv = Aufladung
  reason text not null check (reason in ('topup','usage','bonus','refund','adjustment')),
  model text,
  input_tokens int,
  output_tokens int,
  raw_cost_cents numeric(12,4),              -- reale Anthropic-Rohkosten (vor Marge)
  balance_after_cents bigint,                -- Kontostand nach dieser Buchung
  stripe_ref text,                           -- Payment-Intent/Session bei Aufladungen
  created_at timestamptz not null default now()
);

alter table public.ai_credit_ledger enable row level security;

drop policy if exists ai_ledger_select_own on public.ai_credit_ledger;
create policy ai_ledger_select_own on public.ai_credit_ledger
  for select to authenticated using (user_id = auth.uid());

create index if not exists ai_credit_ledger_user_idx on public.ai_credit_ledger (user_id, created_at desc);

-- ── 4) Atomare Abbuchung der AI-Nutzung ─────────────────────────────────────
-- Die ai-Edge-Function ruft das nach jedem Anthropic-Call auf. SECURITY DEFINER,
-- damit die Buchung atomar unter RLS-Umgehung läuft; der Aufrufer muss aber der
-- eingeloggte Nutzer sein (p_user = auth.uid()) ODER service_role.
create or replace function public.charge_ai_usage(
  p_user uuid,
  p_charge_cents bigint,       -- bereits inkl. Marge, positiver Betrag
  p_model text,
  p_input_tokens int,
  p_output_tokens int,
  p_raw_cost_cents numeric
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_new_balance bigint;
begin
  if auth.uid() is not null and auth.uid() <> p_user then
    raise exception 'not allowed';
  end if;
  if p_charge_cents < 0 then
    raise exception 'charge must be non-negative';
  end if;

  update public.ai_credits
     set balance_cents = balance_cents - p_charge_cents,
         updated_at = now()
   where user_id = p_user
   returning balance_cents into v_new_balance;

  if v_new_balance is null then
    -- Guthaben-Konto existiert noch nicht → anlegen und dann abbuchen.
    insert into public.ai_credits (user_id, balance_cents) values (p_user, -p_charge_cents)
      on conflict (user_id) do update set balance_cents = public.ai_credits.balance_cents - p_charge_cents
      returning balance_cents into v_new_balance;
  end if;

  insert into public.ai_credit_ledger
    (user_id, delta_cents, reason, model, input_tokens, output_tokens, raw_cost_cents, balance_after_cents)
  values
    (p_user, -p_charge_cents, 'usage', p_model, p_input_tokens, p_output_tokens, p_raw_cost_cents, v_new_balance);

  return v_new_balance;
end $$;

grant execute on function public.charge_ai_usage(uuid,bigint,text,int,int,numeric) to authenticated, service_role;

-- Gutschrift (Aufladung). Nur service_role (Stripe-Webhook) darf das aufrufen.
create or replace function public.credit_topup(
  p_user uuid,
  p_amount_cents bigint,
  p_stripe_ref text,
  p_reason text default 'topup'
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_new_balance bigint;
begin
  if p_amount_cents <= 0 then
    raise exception 'amount must be positive';
  end if;

  insert into public.ai_credits (user_id, balance_cents) values (p_user, p_amount_cents)
    on conflict (user_id) do update set balance_cents = public.ai_credits.balance_cents + p_amount_cents, updated_at = now()
    returning balance_cents into v_new_balance;

  insert into public.ai_credit_ledger
    (user_id, delta_cents, reason, stripe_ref, balance_after_cents)
  values
    (p_user, p_amount_cents, coalesce(p_reason,'topup'), p_stripe_ref, v_new_balance);

  return v_new_balance;
end $$;

revoke execute on function public.credit_topup(uuid,bigint,text,text) from authenticated, anon;
grant execute on function public.credit_topup(uuid,bigint,text,text) to service_role;

-- ── 5) Steuerberater-Einladungen & Verknüpfungen ────────────────────────────
-- Ein Nutzer lädt seinen Steuerberater per E-Mail ein. Der Berater registriert sich
-- (oder ist schon registriert) und nimmt die Einladung über den Token an.
create table if not exists public.advisor_invitations (
  id uuid primary key default gen_random_uuid(),
  inviter_user_id uuid not null references auth.users(id) on delete cascade,
  advisor_email text not null,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days')
);

alter table public.advisor_invitations enable row level security;

create index if not exists advisor_invitations_inviter_idx on public.advisor_invitations (inviter_user_id);
create index if not exists advisor_invitations_email_idx on public.advisor_invitations (lower(advisor_email));

-- Einladender darf seine Einladungen sehen und anlegen.
drop policy if exists advisor_inv_select_inviter on public.advisor_invitations;
create policy advisor_inv_select_inviter on public.advisor_invitations
  for select to authenticated using (inviter_user_id = auth.uid());

drop policy if exists advisor_inv_insert_inviter on public.advisor_invitations;
create policy advisor_inv_insert_inviter on public.advisor_invitations
  for insert to authenticated with check (inviter_user_id = auth.uid());

-- Einladender darf zurückziehen (Status auf 'revoked').
drop policy if exists advisor_inv_update_inviter on public.advisor_invitations;
create policy advisor_inv_update_inviter on public.advisor_invitations
  for update to authenticated using (inviter_user_id = auth.uid()) with check (inviter_user_id = auth.uid());

-- Verknüpfung Mandant ⇄ Steuerberater (nach Annahme der Einladung).
create table if not exists public.advisor_links (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references auth.users(id) on delete cascade,
  advisor_user_id uuid not null references auth.users(id) on delete cascade,
  invitation_id uuid references public.advisor_invitations(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_user_id, advisor_user_id)
);

alter table public.advisor_links enable row level security;

create index if not exists advisor_links_advisor_idx on public.advisor_links (advisor_user_id);
create index if not exists advisor_links_client_idx on public.advisor_links (client_user_id);

-- Beide Seiten dürfen die Verknüpfung sehen.
drop policy if exists advisor_links_select on public.advisor_links;
create policy advisor_links_select on public.advisor_links
  for select to authenticated using (client_user_id = auth.uid() or advisor_user_id = auth.uid());

-- Mandant darf die Verknüpfung lösen.
drop policy if exists advisor_links_delete_client on public.advisor_links;
create policy advisor_links_delete_client on public.advisor_links
  for delete to authenticated using (client_user_id = auth.uid());

-- Einladung annehmen: der eingeloggte (Berater-)Nutzer löst per Token die
-- Verknüpfung aus. SECURITY DEFINER, damit die Einladungszeile trotz RLS
-- aktualisiert werden kann.
create or replace function public.accept_advisor_invitation(p_token text)
returns public.advisor_links
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.advisor_invitations;
  v_link public.advisor_links;
begin
  select * into v_inv from public.advisor_invitations
    where token = p_token and status = 'pending' and expires_at > now()
    for update;
  if v_inv.id is null then
    raise exception 'Einladung ungültig oder abgelaufen';
  end if;
  if v_inv.inviter_user_id = auth.uid() then
    raise exception 'Man kann sich nicht selbst als Steuerberater einladen';
  end if;

  insert into public.advisor_links (client_user_id, advisor_user_id, invitation_id)
  values (v_inv.inviter_user_id, auth.uid(), v_inv.id)
  on conflict (client_user_id, advisor_user_id) do update set invitation_id = excluded.invitation_id
  returning * into v_link;

  update public.advisor_invitations
     set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
   where id = v_inv.id;

  return v_link;
end $$;

grant execute on function public.accept_advisor_invitation(text) to authenticated;
