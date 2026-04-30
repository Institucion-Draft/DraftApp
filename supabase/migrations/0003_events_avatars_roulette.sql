-- =====================================================================
-- Migration 0003: tipos de evento, avatares sin reposición, log de ruleta,
-- procedencia de datos
-- =====================================================================

-- 1. Tipo de evento
alter table public.draft_events 
  add column event_type text not null default 'draft';

alter table public.draft_events
  add constraint events_type_valid 
  check (event_type in ('draft', 'tournament', 'pepidraft'));

create index idx_events_workspace_type 
  on public.draft_events (workspace_id, event_type) 
  where deleted_at is null;

-- 2. Procedencia de los datos (para distinguir datos nativos de la app
-- vs datos importados de bitácoras físicas)
alter table public.draft_events
  add column data_source text not null default 'app';
alter table public.draft_events
  add constraint events_data_source_valid 
  check (data_source in ('app', 'imported_notebook', 'manual_entry'));

alter table public.event_participants
  add column data_source text not null default 'app';
alter table public.event_participants
  add constraint participants_data_source_valid 
  check (data_source in ('app', 'imported_notebook', 'manual_entry'));

alter table public.pairings
  add column data_source text not null default 'app';
alter table public.pairings
  add constraint pairings_data_source_valid 
  check (data_source in ('app', 'imported_notebook', 'manual_entry'));

alter table public.matches
  add column data_source text not null default 'app';
alter table public.matches
  add constraint matches_data_source_valid 
  check (data_source in ('app', 'imported_notebook', 'manual_entry'));

-- 3. Trigger de avatares modificado: muestreo sin reposición por evento
create or replace function public.assign_rotated_avatar()
returns trigger
language plpgsql
security definer
as $$
declare
  user_has_custom boolean;
  random_avatar_id uuid;
begin
  select (custom_avatar_path is not null) into user_has_custom
  from public.users
  where id = new.user_id;

  if not user_has_custom then
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
  end if;

  return new;
end;
$$;

-- 4. Log de ruleta de cubos
create table public.cube_roulette_spins (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  spun_by uuid not null references public.users(id),
  
  roulette_type text not null,
  result_type text not null,
  selected_cube_id uuid references public.cubes(id),
  selected_player_user_id uuid references public.users(id),
  
  spun_at timestamptz not null default now(),
  
  constraint roulette_type_valid check (roulette_type in ('cubes', 'players')),
  constraint roulette_result_type_valid check (
    result_type in ('cube', 'player_chooses', 'everyone_smokes', 'roulette_chooses', 'player_selected')
  ),
  constraint roulette_cube_result_consistency check (
    result_type <> 'cube' or selected_cube_id is not null
  ),
  constraint roulette_player_result_consistency check (
    result_type <> 'player_selected' or selected_player_user_id is not null
  )
);

create index idx_roulette_spins_event on public.cube_roulette_spins (event_id);
create index idx_roulette_spins_event_time on public.cube_roulette_spins (event_id, spun_at desc);
create index idx_roulette_spins_result on public.cube_roulette_spins (result_type);

alter table public.cube_roulette_spins enable row level security;

create policy "roulette_spins_select_workspace_member"
  on public.cube_roulette_spins for select
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "roulette_spins_insert_organizer"
  on public.cube_roulette_spins for insert
  to authenticated
  with check (
    spun_by = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

-- =====================================================================
-- FIN
-- =====================================================================