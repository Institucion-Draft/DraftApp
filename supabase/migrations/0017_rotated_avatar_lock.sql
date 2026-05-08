-- 0017_rotated_avatar_lock.sql
-- Si un user se desinscribe de un evento y vuelve a inscribirse, mantener el mismo
-- rotated_avatar_id que tenía la primera vez (no re-rollear).
-- 
-- Implementación:
-- 1. Tabla nueva event_participant_avatar_history que registra los avatares asignados
--    a cada user en cada evento (uno por user-evento, persistente aunque se desinscriba).
-- 2. Trigger BEFORE INSERT en event_participants que primero busca en el histórico:
--    si ya hay un avatar asignado para ese user en ese evento, lo reutiliza.
--    Si no, sigue la lógica existente de asignar uno random no usado.
-- 3. Trigger AFTER INSERT en event_participants que guarda el avatar asignado en el
--    histórico, así queda registrado para futuras re-inscripciones.

create table if not exists public.event_participant_avatar_history (
  user_id uuid not null references public.users(id) on delete cascade,
  event_id uuid not null references public.draft_events(id) on delete cascade,
  rotated_avatar_id uuid not null references public.default_avatars(id),
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

-- Permitir que la tabla sea leída por cualquier miembro del workspace del evento
alter table public.event_participant_avatar_history enable row level security;

create policy "select_avatar_history_for_workspace_members"
  on public.event_participant_avatar_history
  for select
  using (
    exists (
      select 1
      from public.draft_events de
      where de.id = event_participant_avatar_history.event_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

-- Reescribir assign_rotated_avatar para chequear el histórico primero
create or replace function public.assign_rotated_avatar()
returns trigger
language plpgsql
security definer
as $$
declare
  user_has_custom boolean;
  random_avatar_id uuid;
  historical_avatar_id uuid;
begin
  select (custom_avatar_path is not null) into user_has_custom
  from public.users
  where id = new.user_id;

  if user_has_custom then
    return new;
  end if;

  -- Chequear si ya hay un avatar asignado para este user en este evento
  select rotated_avatar_id into historical_avatar_id
  from public.event_participant_avatar_history
  where user_id = new.user_id and event_id = new.event_id;

  if historical_avatar_id is not null then
    new.rotated_avatar_id := historical_avatar_id;
    return new;
  end if;

  -- Asignar uno random no usado
  select id into random_avatar_id
  from public.default_avatars
  where is_active = true
    and id not in (
      select rotated_avatar_id
      from public.event_participants
      where event_id = new.event_id
        and rotated_avatar_id is not null
    )
  order by random()
  limit 1;

  new.rotated_avatar_id := random_avatar_id;
  return new;
end;
$$;

-- Trigger nuevo que guarda el avatar asignado en el histórico tras INSERT
create or replace function public.save_rotated_avatar_to_history()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.rotated_avatar_id is not null then
    insert into public.event_participant_avatar_history (user_id, event_id, rotated_avatar_id)
    values (new.user_id, new.event_id, new.rotated_avatar_id)
    on conflict (user_id, event_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_event_participant_save_avatar_history on public.event_participants;
create trigger on_event_participant_save_avatar_history
  after insert on public.event_participants
  for each row
  execute function public.save_rotated_avatar_to_history();

-- Backfill: registrar los avatares actuales en el histórico
insert into public.event_participant_avatar_history (user_id, event_id, rotated_avatar_id)
select user_id, event_id, rotated_avatar_id
from public.event_participants
where rotated_avatar_id is not null
on conflict (user_id, event_id) do nothing;
