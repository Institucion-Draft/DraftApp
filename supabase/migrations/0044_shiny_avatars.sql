-- 0044_shiny_avatars.sql
-- Variantes shiny de avatares rotados (1/4096) y flag de copa shiny en eventos.

-- a) default_avatars.storage_path_shiny
alter table public.default_avatars
  add column if not exists storage_path_shiny text;

update public.default_avatars
set storage_path_shiny = replace(storage_path, 'default-avatars/', 'default-avatars/shiny/')
where storage_path_shiny is null
  and storage_path is not null;

-- b) event_participants.is_shiny
alter table public.event_participants
  add column if not exists is_shiny boolean not null default false;

-- c) draft_events.has_shiny_participant
alter table public.draft_events
  add column if not exists has_shiny_participant boolean not null default false;

-- Histórico: conservar is_shiny al re-inscribirse
alter table public.event_participant_avatar_history
  add column if not exists is_shiny boolean not null default false;

-- d) Marcar evento cuando hay un shiny inscripto
create or replace function public.update_event_shiny_flag()
returns trigger
language plpgsql
as $$
begin
  if new.is_shiny = true then
    update public.draft_events
    set has_shiny_participant = true
    where id = new.event_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tr_event_shiny_flag on public.event_participants;
create trigger tr_event_shiny_flag
  after insert or update on public.event_participants
  for each row execute function public.update_event_shiny_flag();

-- Asignación de avatar: tirar shiny (1/4096) antes de elegir Pokémon; restaurar desde histórico
create or replace function public.assign_rotated_avatar()
returns trigger
language plpgsql
security definer
as $$
declare
  user_has_custom boolean;
  random_avatar_id uuid;
  historical_avatar_id uuid;
  historical_is_shiny boolean;
begin
  select (custom_avatar_path is not null) into user_has_custom
  from public.users
  where id = new.user_id;

  if user_has_custom then
    return new;
  end if;

  select rotated_avatar_id, is_shiny
  into historical_avatar_id, historical_is_shiny
  from public.event_participant_avatar_history
  where user_id = new.user_id
    and event_id = new.event_id;

  if historical_avatar_id is not null then
    new.rotated_avatar_id := historical_avatar_id;
    new.is_shiny := coalesce(historical_is_shiny, false);
    return new;
  end if;

  -- Shiny antes de elegir qué Pokémon
  new.is_shiny := (random() < (1.0 / 4096.0));

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

create or replace function public.save_rotated_avatar_to_history()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.rotated_avatar_id is not null then
    insert into public.event_participant_avatar_history (
      user_id,
      event_id,
      rotated_avatar_id,
      is_shiny
    )
    values (new.user_id, new.event_id, new.rotated_avatar_id, coalesce(new.is_shiny, false))
    on conflict (user_id, event_id) do update
      set rotated_avatar_id = excluded.rotated_avatar_id,
          is_shiny = excluded.is_shiny;
  end if;
  return new;
end;
$$;

-- Backfill has_shiny_participant en eventos que ya tienen shinies
update public.draft_events de
set has_shiny_participant = true
where exists (
  select 1
  from public.event_participants ep
  where ep.event_id = de.id
    and ep.is_shiny = true
);
