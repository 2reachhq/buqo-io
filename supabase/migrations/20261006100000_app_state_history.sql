-- Buqo – automatische Sicherung der Buchhaltungsdaten
--
-- Vor jedem Speichern von app_state wird der bisherige Stand gesichert, wenn die letzte Sicherung
-- älter als 30 Minuten ist ODER der neue Stand deutlich kleiner wird (Verdacht auf versehentlich
-- verlorene Daten). Es bleiben die letzten 300 Sicherungen erhalten. Die App kann sie nur lesen;
-- eine Wiederherstellung erfolgt bei Bedarf per SQL aus dieser Tabelle.

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
revoke all on public.app_state_history from anon;
revoke insert, update, delete on public.app_state_history from authenticated;
grant select on public.app_state_history to authenticated;

create or replace function public.app_state_backup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  last_at timestamptz;
  old_b integer;
  new_b integer;
  why text;
begin
  if old.data is null or old.data = '{}'::jsonb then
    return new;
  end if;
  old_b := octet_length(old.data::text);
  new_b := octet_length(coalesce(new.data, '{}'::jsonb)::text);
  select max(saved_at) into last_at from public.app_state_history;
  if new_b < old_b * 0.8 then
    why := 'shrink';
  elsif last_at is null or last_at < now() - interval '30 minutes' then
    why := 'periodic';
  end if;
  if why is not null then
    insert into public.app_state_history (reason, bytes, data, names) values (why, old_b, old.data, old.names);
    delete from public.app_state_history
      where id in (select id from public.app_state_history order by id desc offset 300);
  end if;
  return new;
end;
$$;

drop trigger if exists app_state_backup_trg on public.app_state;
create trigger app_state_backup_trg before update on public.app_state
  for each row execute function public.app_state_backup();
