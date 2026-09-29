-- Buqo – gelöschte automatische To-dos bleiben gelöscht
--
-- Hintergrund: Automatische To-dos (überfällige Rechnung, offener Beleg, Dublette) tragen einen `autoKey`.
-- Löscht der Nutzer sie, merkt sich die App den Schlüssel in data.dismissedAuto. Ein alter, noch offener
-- Browser-Tab (oder ein Gerät mit veraltetem Stand) kennt das nicht und schreibt die To-dos immer wieder zurück.
-- Dieser Trigger räumt serverseitig auf: To-dos, deren autoKey in dismissedAuto steht, werden bei jedem
-- Speichern entfernt, und dismissedAuto selbst kann durch ältere Clients nicht mehr verloren gehen.

create or replace function public.app_state_strip_dismissed_todos()
returns trigger
language plpgsql
as $$
declare
  dis jsonb;
begin
  if new.data is null or jsonb_typeof(new.data) <> 'object' then
    return new;
  end if;

  dis := coalesce(new.data->'dismissedAuto', '[]'::jsonb);
  if tg_op = 'UPDATE' and old.data is not null and jsonb_typeof(old.data) = 'object' then
    dis := dis || coalesce(old.data->'dismissedAuto', '[]'::jsonb);
  end if;
  if jsonb_typeof(dis) <> 'array' then dis := '[]'::jsonb; end if;

  dis := coalesce((select jsonb_agg(distinct v) from jsonb_array_elements(dis) v), '[]'::jsonb);
  if jsonb_array_length(dis) > 0 then
    new.data := jsonb_set(new.data, '{dismissedAuto}', dis);
    if jsonb_typeof(new.data->'todos') = 'array' then
      new.data := jsonb_set(
        new.data, '{todos}',
        coalesce((
          select jsonb_agg(t)
          from jsonb_array_elements(new.data->'todos') t
          where not (t ? 'autoKey' and dis @> jsonb_build_array(t->'autoKey'))
        ), '[]'::jsonb)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists app_state_strip_dismissed_todos on public.app_state;
create trigger app_state_strip_dismissed_todos
  before insert or update on public.app_state
  for each row execute function public.app_state_strip_dismissed_todos();
