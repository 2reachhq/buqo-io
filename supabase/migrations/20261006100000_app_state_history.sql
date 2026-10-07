-- Buqo – automatische Sicherung der Buchhaltungsdaten
--
-- Die App sichert den bisherigen Stand von app_state in diese Tabelle, wenn die letzte Sicherung
-- älter als 30 Minuten ist ODER der neue Stand deutlich kleiner wird (Verdacht auf versehentlich
-- verlorene Daten). Es bleiben die letzten ~100 Sicherungen erhalten (die App räumt auf).
-- Eine Wiederherstellung erfolgt bei Bedarf per SQL aus dieser Tabelle.

create table if not exists public.app_state_history (
  id bigserial primary key,
  saved_at timestamptz not null default now(),
  reason text not null default 'periodic',
  bytes integer,
  data jsonb,
  names jsonb
);
alter table public.app_state_history enable row level security;
drop policy if exists app_state_history_read on public.app_state_history;
create policy app_state_history_read on public.app_state_history for select to authenticated using (true);
drop policy if exists app_state_history_write on public.app_state_history;
create policy app_state_history_write on public.app_state_history for insert to authenticated with check (true);
drop policy if exists app_state_history_delete on public.app_state_history;
create policy app_state_history_delete on public.app_state_history for delete to authenticated using (true);
revoke all on public.app_state_history from anon;
revoke all on public.app_state_history from authenticated;
grant select, insert, delete on public.app_state_history to authenticated;
