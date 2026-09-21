-- Buqo – Registrierung darf nie an den optionalen Abo-/Guthaben-Zeilen scheitern
--
-- Symptom: Registrierung (und „Add user" im Dashboard) bricht ab mit
--   „Database error saving new user" / „Database error creating new user".
-- Ursache: Der Trigger handle_new_user (Migration billing_and_roles) schreibt beim Anlegen eines
-- Auth-Nutzers in profiles, subscriptions und ai_credits. Fehlt eine dieser Tabellen, der Typ
-- app_role oder schlägt ein Insert fehl, rollt Supabase den KOMPLETTEN Signup zurück.
-- Diese Version fängt jeden Teilschritt einzeln ab: der Nutzer wird immer angelegt, fehlende
-- Zusatzzeilen werden im Postgres-Log als WARNING vermerkt und stören die App nicht
-- (sie behandelt fehlendes Profil/Guthaben bereits als „user" ohne Guthaben).
-- Idempotent – gefahrlos mehrfach ausführbar.

do $$ begin
  create type public.app_role as enum ('user', 'advisor');
exception when duplicate_object then null; end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role text := coalesce(new.raw_user_meta_data->>'role', 'user');
begin
  begin
    insert into public.profiles (id, role, full_name)
    values (new.id,
            case when v_role = 'advisor' then 'advisor'::public.app_role else 'user'::public.app_role end,
            new.raw_user_meta_data->>'full_name')
    on conflict (id) do nothing;
  exception when others then
    raise warning 'buqo handle_new_user: profiles insert failed for %: %', new.id, sqlerrm;
  end;

  if v_role <> 'advisor' then
    begin
      insert into public.subscriptions (user_id) values (new.id) on conflict do nothing;
    exception when others then
      raise warning 'buqo handle_new_user: subscriptions insert failed for %: %', new.id, sqlerrm;
    end;
    begin
      insert into public.ai_credits (user_id) values (new.id) on conflict do nothing;
    exception when others then
      raise warning 'buqo handle_new_user: ai_credits insert failed for %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
