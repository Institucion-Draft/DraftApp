-- =====================================================================
-- DraftApp - Initial Schema Migration
-- Migration: 0001_initial_schema
-- Created: 2026-04-29
-- =====================================================================
-- Esquema inicial completo: auth, workspaces, eventos, pairings, matches,
-- two-headed giant, media, auditoría y vistas de stats.
--
-- Aplicar en orden estricto (las capas dependen unas de otras).
-- Asume Supabase con auth.users ya disponible.
-- =====================================================================


-- =====================================================================
-- CAPA 1: AUTH Y PERFILES
-- =====================================================================

create table public.default_avatars (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  storage_path text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text not null,
  custom_avatar_path text,
  default_avatar_id uuid references public.default_avatars(id),
  birthday date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint username_lowercase check (username = lower(username))
);

create index idx_users_username on public.users (username);
create index idx_users_display_name on public.users (display_name);

-- Trigger: auto-crear perfil cuando se registra un usuario en auth.users
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  random_avatar_id uuid;
  generated_username text;
begin
  select id into random_avatar_id
  from public.default_avatars
  where is_active = true
  order by random()
  limit 1;

  generated_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);

  insert into public.users (id, username, display_name, default_avatar_id)
  values (
    new.id,
    generated_username,
    coalesce(new.raw_user_meta_data->>'display_name', generated_username),
    random_avatar_id
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.users enable row level security;
alter table public.default_avatars enable row level security;

create policy "users_select_authenticated"
  on public.users for select
  to authenticated
  using (true);

create policy "users_update_own"
  on public.users for update
  to authenticated
  using (auth.uid() = id);

create policy "default_avatars_select_all"
  on public.default_avatars for select
  to authenticated
  using (is_active = true);


-- =====================================================================
-- CAPA 2: WORKSPACES
-- =====================================================================

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  avatar_path text,
  created_by uuid not null references public.users(id),
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint slug_format check (slug ~ '^[a-z0-9_-]{3,40}$'),
  constraint name_length check (length(name) between 2 and 50)
);

create index idx_workspaces_slug on public.workspaces (slug) where deleted_at is null;
create index idx_workspaces_name on public.workspaces (name) where deleted_at is null;
create index idx_workspaces_public on public.workspaces (is_public) where deleted_at is null;

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),

  unique (workspace_id, user_id),
  constraint role_valid check (role in ('organizer', 'member'))
);

create index idx_workspace_members_workspace on public.workspace_members (workspace_id);
create index idx_workspace_members_user on public.workspace_members (user_id);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code text not null unique,
  created_by uuid not null references public.users(id),
  expires_at timestamptz,
  max_uses integer,
  uses_count integer not null default 0,
  is_revoked boolean not null default false,
  created_at timestamptz not null default now(),

  constraint code_format check (code ~ '^[A-Z0-9]{6,10}$')
);

create index idx_workspace_invites_code on public.workspace_invites (code) where is_revoked = false;
create index idx_workspace_invites_workspace on public.workspace_invites (workspace_id);

create table public.workspace_join_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  message text,
  status text not null default 'pending',
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),

  unique (workspace_id, user_id, status),
  constraint status_valid check (status in ('pending', 'approved', 'rejected')),
  constraint message_length check (message is null or length(message) <= 500)
);

create index idx_join_requests_workspace_pending
  on public.workspace_join_requests (workspace_id)
  where status = 'pending';
create index idx_join_requests_user on public.workspace_join_requests (user_id);

-- Funciones helper para chequear roles (usadas en RLS de capas siguientes)
create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
    and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_organizer(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
    and user_id = auth.uid()
    and role = 'organizer'
  );
$$;

-- Triggers: al crear workspace, el creador se vuelve organizer
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'organizer');
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- Trigger: al aprobar join request, agregar como member
create or replace function public.handle_join_request_approval()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.status = 'approved' and old.status = 'pending' then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.workspace_id, new.user_id, 'member')
    on conflict (workspace_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_join_request_approved
  after update on public.workspace_join_requests
  for each row execute function public.handle_join_request_approval();

-- RLS Capa 2
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.workspace_join_requests enable row level security;

create policy "workspaces_select_basic"
  on public.workspaces for select
  to authenticated
  using (deleted_at is null);

create policy "workspaces_insert_authenticated"
  on public.workspaces for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "workspaces_update_organizer"
  on public.workspaces for update
  to authenticated
  using (public.is_workspace_organizer(id));

create policy "members_select_if_member"
  on public.workspace_members for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members_insert_organizer"
  on public.workspace_members for insert
  to authenticated
  with check (public.is_workspace_organizer(workspace_id));

create policy "members_delete_organizer"
  on public.workspace_members for delete
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "members_update_organizer"
  on public.workspace_members for update
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "invites_select_member"
  on public.workspace_invites for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "invites_insert_organizer"
  on public.workspace_invites for insert
  to authenticated
  with check (public.is_workspace_organizer(workspace_id));

create policy "invites_update_organizer"
  on public.workspace_invites for update
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "join_requests_select_own"
  on public.workspace_join_requests for select
  to authenticated
  using (user_id = auth.uid());

create policy "join_requests_select_organizer"
  on public.workspace_join_requests for select
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "join_requests_insert_self"
  on public.workspace_join_requests for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "join_requests_update_organizer"
  on public.workspace_join_requests for update
  to authenticated
  using (public.is_workspace_organizer(workspace_id));


-- =====================================================================
-- CAPA 3: CATÁLOGOS DEL WORKSPACE (CUBOS Y SEDES)
-- =====================================================================

create table public.cubes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  cubecobra_url text,
  card_count integer,
  notes text,
  avatar_path text,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint cubes_name_length check (length(name) between 1 and 60),
  constraint cubes_card_count_positive check (card_count is null or card_count > 0),
  constraint cubes_notes_length check (notes is null or length(notes) <= 2000),
  constraint cubes_cubecobra_url_format check (
    cubecobra_url is null
    or cubecobra_url ~ '^https?://'
  )
);

create unique index idx_cubes_unique_name_per_workspace
  on public.cubes (workspace_id, name)
  where deleted_at is null;
create index idx_cubes_workspace on public.cubes (workspace_id) where deleted_at is null;

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  address text,
  notes text,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint venues_name_length check (length(name) between 1 and 60),
  constraint venues_notes_length check (notes is null or length(notes) <= 1000)
);

create unique index idx_venues_unique_name_per_workspace
  on public.venues (workspace_id, name)
  where deleted_at is null;
create index idx_venues_workspace on public.venues (workspace_id) where deleted_at is null;

alter table public.cubes enable row level security;
alter table public.venues enable row level security;

create policy "cubes_select_member"
  on public.cubes for select
  to authenticated
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
  );

create policy "cubes_insert_organizer"
  on public.cubes for insert
  to authenticated
  with check (
    public.is_workspace_organizer(workspace_id)
    and created_by = auth.uid()
  );

create policy "cubes_update_organizer"
  on public.cubes for update
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "cubes_delete_organizer"
  on public.cubes for delete
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "venues_select_member"
  on public.venues for select
  to authenticated
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
  );

create policy "venues_insert_organizer"
  on public.venues for insert
  to authenticated
  with check (
    public.is_workspace_organizer(workspace_id)
    and created_by = auth.uid()
  );

create policy "venues_update_organizer"
  on public.venues for update
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "venues_delete_organizer"
  on public.venues for delete
  to authenticated
  using (public.is_workspace_organizer(workspace_id));


-- =====================================================================
-- CAPA 4: EVENTOS Y PARTICIPANTES
-- =====================================================================

create table public.draft_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  cube_id uuid references public.cubes(id),
  venue_id uuid references public.venues(id),
  avatar_path text,
  notes text,

  scheduled_for timestamptz not null,
  draft_started_at timestamptz,
  draft_ended_at timestamptz,
  event_ended_at timestamptz,
  status text not null default 'scheduled',

  tournament_format text not null default 'round_robin',
  match_format text not null default 'bo3',
  scoring_mode text,

  champion_user_id uuid references public.users(id),
  champion_decided_by text,
  champion_override_reason text,
  final_pending boolean not null default false,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint events_name_length check (length(name) between 1 and 80),
  constraint events_notes_length check (notes is null or length(notes) <= 2000),
  constraint events_status_valid check (status in ('scheduled', 'drafting', 'playing', 'completed', 'cancelled')),
  constraint events_format_valid check (tournament_format in ('round_robin', 'swiss', 'league_playoff')),
  constraint events_match_format_valid check (match_format in ('bo1', 'bo3')),
  constraint events_scoring_valid check (
    scoring_mode is null
    or scoring_mode in ('classic', 'differential')
  ),
  constraint events_champion_decision_valid check (
    champion_decided_by is null
    or champion_decided_by in ('auto', 'manual_override')
  ),
  constraint events_draft_times_logical check (
    draft_ended_at is null
    or draft_started_at is null
    or draft_ended_at >= draft_started_at
  )
);

create index idx_events_workspace on public.draft_events (workspace_id) where deleted_at is null;
create index idx_events_workspace_status on public.draft_events (workspace_id, status) where deleted_at is null;
create index idx_events_scheduled on public.draft_events (scheduled_for) where deleted_at is null;
create index idx_events_cube on public.draft_events (cube_id) where deleted_at is null;
create index idx_events_venue on public.draft_events (venue_id) where deleted_at is null;
create index idx_events_champion on public.draft_events (champion_user_id) where deleted_at is null;

create table public.event_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'player',
  exile_borrowed_from_user_id uuid references public.users(id),
  self_evaluation integer,
  rotated_avatar_id uuid references public.default_avatars(id),
  joined_at timestamptz not null default now(),

  unique (event_id, user_id),
  constraint participants_role_valid check (role in ('player', 'ghost', 'exile')),
  constraint participants_self_eval_range check (
    self_evaluation is null
    or (self_evaluation between 1 and 10)
  )
);

create index idx_participants_event on public.event_participants (event_id);
create index idx_participants_user on public.event_participants (user_id);
create index idx_participants_event_role on public.event_participants (event_id, role);

create table public.participant_colors (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.event_participants(id) on delete cascade,
  color text not null,

  unique (participant_id, color),
  constraint colors_valid check (color in ('W', 'U', 'B', 'R', 'G', 'C'))
);

create index idx_participant_colors_participant on public.participant_colors (participant_id);
create index idx_participant_colors_color on public.participant_colors (color);

create table public.dice_rolls (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  participant_id uuid not null references public.event_participants(id) on delete cascade,
  value integer not null,
  is_virtual boolean not null default false,
  rolled_at timestamptz not null default now(),

  unique (event_id, participant_id),
  constraint dice_value_d20 check (value between 1 and 20)
);

create index idx_dice_rolls_event on public.dice_rolls (event_id);

-- Trigger: asignar avatar rotativo al unirse a un evento
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
    order by random()
    limit 1;

    new.rotated_avatar_id := random_avatar_id;
  end if;

  return new;
end;
$$;

create trigger on_participant_created
  before insert on public.event_participants
  for each row execute function public.assign_rotated_avatar();

-- Vistas útiles de catálogos
create or replace view public.cubes_with_stats as
select
  c.*,
  count(de.id) filter (where de.deleted_at is null) as usage_count,
  min(de.draft_started_at) filter (where de.deleted_at is null) as first_used_at,
  max(de.draft_started_at) filter (where de.deleted_at is null) as last_used_at
from public.cubes c
left join public.draft_events de on de.cube_id = c.id
where c.deleted_at is null
group by c.id;

create or replace view public.venues_with_stats as
select
  v.*,
  count(de.id) filter (where de.deleted_at is null) as usage_count,
  min(de.draft_started_at) filter (where de.deleted_at is null) as first_used_at,
  max(de.draft_started_at) filter (where de.deleted_at is null) as last_used_at
from public.venues v
left join public.draft_events de on de.venue_id = v.id
where v.deleted_at is null
group by v.id;

-- RLS Capa 4
alter table public.draft_events enable row level security;
alter table public.event_participants enable row level security;
alter table public.participant_colors enable row level security;
alter table public.dice_rolls enable row level security;

create policy "events_select_member"
  on public.draft_events for select
  to authenticated
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
  );

create policy "events_insert_organizer"
  on public.draft_events for insert
  to authenticated
  with check (
    public.is_workspace_organizer(workspace_id)
    and created_by = auth.uid()
  );

create policy "events_update_organizer"
  on public.draft_events for update
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "events_delete_organizer"
  on public.draft_events for delete
  to authenticated
  using (public.is_workspace_organizer(workspace_id));

create policy "participants_select_workspace_member"
  on public.event_participants for select
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "participants_insert_self"
  on public.event_participants for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "participants_insert_organizer"
  on public.event_participants for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "participants_update_self"
  on public.event_participants for update
  to authenticated
  using (user_id = auth.uid());

create policy "participants_update_organizer"
  on public.event_participants for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "participants_delete_organizer"
  on public.event_participants for delete
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "colors_select_workspace_member"
  on public.participant_colors for select
  to authenticated
  using (
    exists (
      select 1
      from public.event_participants ep
      join public.draft_events de on de.id = ep.event_id
      where ep.id = participant_id
      and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "colors_modify_self_or_organizer"
  on public.participant_colors for all
  to authenticated
  using (
    exists (
      select 1
      from public.event_participants ep
      join public.draft_events de on de.id = ep.event_id
      where ep.id = participant_id
      and (
        ep.user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );

create policy "dice_select_workspace_member"
  on public.dice_rolls for select
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "dice_insert_self_or_organizer"
  on public.dice_rolls for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.event_participants ep
      join public.draft_events de on de.id = ep.event_id
      where ep.id = participant_id
      and (
        ep.user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );

create policy "dice_update_organizer"
  on public.dice_rolls for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.is_workspace_organizer(de.workspace_id)
    )
  );


-- =====================================================================
-- CAPA 5: PAIRINGS, MATCHES Y LIFE EVENTS (1v1)
-- =====================================================================

create table public.pairings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  participant_a_id uuid not null references public.event_participants(id),
  participant_b_id uuid not null references public.event_participants(id),

  is_initial_dice_pairing boolean not null default false,

  official_winner_participant_id uuid references public.event_participants(id),
  official_resolved_at timestamptz,

  super_cup_winner_participant_id uuid references public.event_participants(id),
  super_cup_resolved_at timestamptz,

  created_at timestamptz not null default now(),

  unique (event_id, participant_a_id, participant_b_id),
  constraint pairings_different_participants check (participant_a_id <> participant_b_id),
  constraint pairings_participants_ordered check (participant_a_id < participant_b_id)
);

create index idx_pairings_event on public.pairings (event_id);
create index idx_pairings_participant_a on public.pairings (participant_a_id);
create index idx_pairings_participant_b on public.pairings (participant_b_id);
create index idx_pairings_event_initial on public.pairings (event_id, is_initial_dice_pairing);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  pairing_id uuid not null references public.pairings(id) on delete cascade,
  match_number integer not null,
  match_type text not null default 'draft',

  winner_participant_id uuid references public.event_participants(id),
  life_tracker_user_id uuid references public.users(id),

  is_borrowed_deck_a boolean not null default false,
  borrowed_from_a_user_id uuid references public.users(id),
  is_borrowed_deck_b boolean not null default false,
  borrowed_from_b_user_id uuid references public.users(id),

  starting_life_a integer not null default 20,
  starting_life_b integer not null default 20,

  status text not null default 'in_progress',
  started_at timestamptz not null default now(),
  ended_at timestamptz,

  abort_requested_by uuid references public.users(id),
  abort_requested_at timestamptz,
  abort_confirmed_by uuid references public.users(id),
  abort_confirmed_at timestamptz,

  unique (pairing_id, match_number),
  constraint matches_type_valid check (match_type in ('draft', 'revenge', 'final', 'two_headed_giant')),
  constraint matches_status_valid check (status in ('in_progress', 'completed', 'aborted')),
  constraint matches_number_positive check (match_number > 0),
  constraint matches_borrowed_a_consistency check (
    (is_borrowed_deck_a = false and borrowed_from_a_user_id is null)
    or (is_borrowed_deck_a = true and borrowed_from_a_user_id is not null)
  ),
  constraint matches_borrowed_b_consistency check (
    (is_borrowed_deck_b = false and borrowed_from_b_user_id is null)
    or (is_borrowed_deck_b = true and borrowed_from_b_user_id is not null)
  ),
  constraint matches_completed_has_winner check (
    status <> 'completed' or winner_participant_id is not null
  ),
  constraint matches_completed_has_ended_at check (
    status <> 'completed' or ended_at is not null
  )
);

create index idx_matches_pairing on public.matches (pairing_id);
create index idx_matches_pairing_number on public.matches (pairing_id, match_number);
create index idx_matches_status on public.matches (status);
create index idx_matches_winner on public.matches (winner_participant_id);
create index idx_matches_type on public.matches (match_type);

create table public.life_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  participant_id uuid not null references public.event_participants(id),
  delta integer not null,
  resulting_life integer not null,
  occurred_at timestamptz not null default now(),
  is_undo boolean not null default false,
  undoes_event_id uuid references public.life_events(id),

  constraint life_delta_not_zero check (delta <> 0),
  constraint life_undo_consistency check (
    (is_undo = false and undoes_event_id is null)
    or (is_undo = true and undoes_event_id is not null)
  )
);

create index idx_life_events_match on public.life_events (match_id);
create index idx_life_events_match_time on public.life_events (match_id, occurred_at);
create index idx_life_events_participant on public.life_events (participant_id);

-- Función helper: validar que un user puede ser life_tracker
create or replace function public.validate_life_tracker_assignment(
  p_match_id uuid,
  p_user_id uuid
) returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from public.pairings p
    join public.event_participants ep_a on ep_a.id = p.participant_a_id
    join public.event_participants ep_b on ep_b.id = p.participant_b_id
    join public.draft_events de on de.id = p.event_id
    where p.id = (select pairing_id from public.matches where id = p_match_id)
      and (
        ep_a.user_id = p_user_id
        or ep_b.user_id = p_user_id
        or public.is_workspace_organizer(de.workspace_id)
      )
  );
$$;

-- Trigger: clasificar match_type al insertar
create or replace function public.classify_match_type()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing public.pairings%rowtype;
  v_event public.draft_events%rowtype;
begin
  if new.match_type <> 'draft' then
    return new;
  end if;

  select * into v_pairing from public.pairings where id = new.pairing_id;
  select * into v_event from public.draft_events where id = v_pairing.event_id;

  if v_pairing.official_winner_participant_id is not null then
    new.match_type := 'revenge';
  elsif v_event.scoring_mode is not null then
    new.match_type := 'revenge';
  end if;

  return new;
end;
$$;

create trigger on_match_insert_classify
  before insert on public.matches
  for each row execute function public.classify_match_type();

-- Trigger: setear ended_at al completar
create or replace function public.set_match_ended_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'completed' and old.status <> 'completed' then
    new.ended_at := now();
  end if;
  return new;
end;
$$;

create trigger on_match_completed_set_ended_at
  before update of status on public.matches
  for each row execute function public.set_match_ended_at();

-- Trigger: finalizar abort cuando ambos confirman
create or replace function public.finalize_match_abort()
returns trigger
language plpgsql
as $$
begin
  if new.abort_confirmed_by is not null
     and new.abort_requested_by is not null
     and old.abort_confirmed_by is null then
    new.status := 'aborted';
    new.ended_at := now();
  end if;
  return new;
end;
$$;

create trigger on_match_abort_confirmed
  before update on public.matches
  for each row execute function public.finalize_match_abort();

-- Trigger: actualizar official_winner del pairing al cambiar matches
create or replace function public.update_pairing_official_result()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match_format text;
  v_a_wins integer;
  v_b_wins integer;
  v_winning_participant_id uuid;
  v_pairing public.pairings%rowtype;
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  select de.match_format
  into v_match_format
  from public.draft_events de
  where de.id = v_pairing.event_id;

  if v_match_format = 'bo1' then
    select winner_participant_id
    into v_winning_participant_id
    from public.matches
    where pairing_id = new.pairing_id
      and match_type = 'draft'
      and status = 'completed'
    order by match_number
    limit 1;

    if v_winning_participant_id is not null then
      update public.pairings
      set official_winner_participant_id = v_winning_participant_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    end if;

  elsif v_match_format = 'bo3' then
    select
      count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
      count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id)
    into v_a_wins, v_b_wins
    from public.matches m
    where m.pairing_id = new.pairing_id
      and m.match_type = 'draft'
      and m.status = 'completed';

    if v_a_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_a_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    elsif v_b_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_b_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    end if;
  end if;

  return new;
end;
$$;

create trigger on_match_status_changed_pairing_result
  after insert or update of status, winner_participant_id on public.matches
  for each row execute function public.update_pairing_official_result();

-- Trigger: tracking de Super Cup (2 wins seguidas)
create or replace function public.update_pairing_super_cup()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing public.pairings%rowtype;
  v_recent_winners uuid[];
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  if v_pairing.super_cup_winner_participant_id is not null then
    return new;
  end if;

  select array_agg(winner_participant_id order by match_number desc)
  into v_recent_winners
  from (
    select winner_participant_id, match_number
    from public.matches
    where pairing_id = new.pairing_id
      and status = 'completed'
      and winner_participant_id is not null
    order by match_number desc
    limit 2
  ) recent;

  if array_length(v_recent_winners, 1) = 2
     and v_recent_winners[1] = v_recent_winners[2] then
    update public.pairings
    set super_cup_winner_participant_id = v_recent_winners[1],
        super_cup_resolved_at = now()
    where id = new.pairing_id
      and super_cup_winner_participant_id is null;
  end if;

  return new;
end;
$$;

create trigger on_match_completed_super_cup
  after insert or update of status, winner_participant_id on public.matches
  for each row execute function public.update_pairing_super_cup();

-- Trigger: auto-resolver match cuando vida llega a 0
create or replace function public.auto_resolve_match_on_zero_life()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match public.matches%rowtype;
  v_pairing public.pairings%rowtype;
  v_winner_participant_id uuid;
begin
  if new.resulting_life > 0 then
    return new;
  end if;

  select * into v_match from public.matches where id = new.match_id;

  if v_match.status <> 'in_progress' then
    return new;
  end if;

  select * into v_pairing from public.pairings where id = v_match.pairing_id;

  if v_pairing.participant_a_id = new.participant_id then
    v_winner_participant_id := v_pairing.participant_b_id;
  else
    v_winner_participant_id := v_pairing.participant_a_id;
  end if;

  update public.matches
  set winner_participant_id = v_winner_participant_id,
      status = 'completed',
      ended_at = now()
  where id = new.match_id;

  return new;
end;
$$;

create trigger on_life_event_zero
  after insert on public.life_events
  for each row execute function public.auto_resolve_match_on_zero_life();

-- RLS Capa 5
alter table public.pairings enable row level security;
alter table public.matches enable row level security;
alter table public.life_events enable row level security;

create policy "pairings_select_workspace_member"
  on public.pairings for select
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "pairings_insert_organizer"
  on public.pairings for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "pairings_update_organizer"
  on public.pairings for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "matches_select_workspace_member"
  on public.matches for select
  to authenticated
  using (
    exists (
      select 1
      from public.pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = pairing_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "matches_insert_participant_or_organizer"
  on public.matches for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.pairings p
      join public.event_participants ep_a on ep_a.id = p.participant_a_id
      join public.event_participants ep_b on ep_b.id = p.participant_b_id
      join public.draft_events de on de.id = p.event_id
      where p.id = pairing_id
      and (
        ep_a.user_id = auth.uid()
        or ep_b.user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );

create policy "matches_update_authorized"
  on public.matches for update
  to authenticated
  using (
    life_tracker_user_id = auth.uid()
    or exists (
      select 1
      from public.pairings p
      join public.event_participants ep_a on ep_a.id = p.participant_a_id
      join public.event_participants ep_b on ep_b.id = p.participant_b_id
      join public.draft_events de on de.id = p.event_id
      where p.id = pairing_id
      and (
        ep_a.user_id = auth.uid()
        or ep_b.user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );

create policy "life_events_select_workspace_member"
  on public.life_events for select
  to authenticated
  using (
    exists (
      select 1
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "life_events_insert_authorized"
  on public.life_events for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.event_participants ep_a on ep_a.id = p.participant_a_id
      join public.event_participants ep_b on ep_b.id = p.participant_b_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_id
        and m.status = 'in_progress'
        and m.life_tracker_user_id = auth.uid()
        and (
          ep_a.user_id = auth.uid()
          or ep_b.user_id = auth.uid()
          or public.is_workspace_organizer(de.workspace_id)
        )
    )
  );

create policy "life_events_update_organizer"
  on public.life_events for update
  to authenticated
  using (
    exists (
      select 1
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_id and public.is_workspace_organizer(de.workspace_id)
    )
  );


-- =====================================================================
-- CAPA 6: TWO-HEADED GIANT
-- =====================================================================

create table public.tg_pairings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  team_a_label text,
  team_b_label text,
  winning_team text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),

  constraint tg_winning_team_valid check (
    winning_team is null or winning_team in ('a', 'b')
  )
);

create index idx_tg_pairings_event on public.tg_pairings (event_id);

create table public.tg_team_members (
  id uuid primary key default gen_random_uuid(),
  tg_pairing_id uuid not null references public.tg_pairings(id) on delete cascade,
  player_user_id uuid not null references public.users(id),
  team text not null,
  is_borrowed_deck boolean not null default false,
  borrowed_from_user_id uuid references public.users(id),
  borrowed_from_participant_id uuid references public.event_participants(id),
  added_at timestamptz not null default now(),

  unique (tg_pairing_id, player_user_id),
  constraint tg_member_team_valid check (team in ('a', 'b')),
  constraint tg_borrowed_consistency check (
    (is_borrowed_deck = false and borrowed_from_user_id is null and borrowed_from_participant_id is null)
    or (is_borrowed_deck = true and borrowed_from_user_id is not null and borrowed_from_participant_id is not null)
  )
);

create index idx_tg_team_members_pairing on public.tg_team_members (tg_pairing_id);
create index idx_tg_team_members_user on public.tg_team_members (player_user_id);

create table public.tg_matches (
  id uuid primary key default gen_random_uuid(),
  tg_pairing_id uuid not null references public.tg_pairings(id) on delete cascade,
  match_number integer not null,
  starting_life_team_a integer not null default 30,
  starting_life_team_b integer not null default 30,
  winning_team text,
  life_tracker_user_id uuid references public.users(id),
  status text not null default 'in_progress',
  started_at timestamptz not null default now(),
  ended_at timestamptz,

  abort_requested_by uuid references public.users(id),
  abort_requested_at timestamptz,
  abort_confirmed_by uuid references public.users(id),
  abort_confirmed_at timestamptz,

  unique (tg_pairing_id, match_number),
  constraint tg_match_status_valid check (status in ('in_progress', 'completed', 'aborted')),
  constraint tg_match_winning_valid check (
    winning_team is null or winning_team in ('a', 'b')
  ),
  constraint tg_match_number_positive check (match_number > 0),
  constraint tg_match_completed_has_winner check (
    status <> 'completed' or winning_team is not null
  )
);

create index idx_tg_matches_pairing on public.tg_matches (tg_pairing_id);
create index idx_tg_matches_status on public.tg_matches (status);

create table public.tg_life_events (
  id uuid primary key default gen_random_uuid(),
  tg_match_id uuid not null references public.tg_matches(id) on delete cascade,
  team text not null,
  delta integer not null,
  resulting_life integer not null,
  occurred_at timestamptz not null default now(),
  is_undo boolean not null default false,
  undoes_event_id uuid references public.tg_life_events(id),

  constraint tg_life_team_valid check (team in ('a', 'b')),
  constraint tg_life_delta_not_zero check (delta <> 0),
  constraint tg_life_undo_consistency check (
    (is_undo = false and undoes_event_id is null)
    or (is_undo = true and undoes_event_id is not null)
  )
);

create index idx_tg_life_events_match on public.tg_life_events (tg_match_id);
create index idx_tg_life_events_match_time on public.tg_life_events (tg_match_id, occurred_at);
create index idx_tg_life_events_team on public.tg_life_events (team);

-- Triggers 2HG
create or replace function public.set_tg_match_ended_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'completed' and old.status <> 'completed' then
    new.ended_at := now();
  end if;
  return new;
end;
$$;

create trigger on_tg_match_completed_set_ended_at
  before update of status on public.tg_matches
  for each row execute function public.set_tg_match_ended_at();

create or replace function public.finalize_tg_match_abort()
returns trigger
language plpgsql
as $$
begin
  if new.abort_confirmed_by is not null
     and new.abort_requested_by is not null
     and old.abort_confirmed_by is null then
    new.status := 'aborted';
    new.ended_at := now();
  end if;
  return new;
end;
$$;

create trigger on_tg_match_abort_confirmed
  before update on public.tg_matches
  for each row execute function public.finalize_tg_match_abort();

create or replace function public.auto_resolve_tg_match_on_zero_life()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match public.tg_matches%rowtype;
  v_winning_team text;
begin
  if new.resulting_life > 0 then
    return new;
  end if;

  select * into v_match from public.tg_matches where id = new.tg_match_id;

  if v_match.status <> 'in_progress' then
    return new;
  end if;

  if new.team = 'a' then
    v_winning_team := 'b';
  else
    v_winning_team := 'a';
  end if;

  update public.tg_matches
  set winning_team = v_winning_team,
      status = 'completed',
      ended_at = now()
  where id = new.tg_match_id;

  return new;
end;
$$;

create trigger on_tg_life_event_zero
  after insert on public.tg_life_events
  for each row execute function public.auto_resolve_tg_match_on_zero_life();

-- RLS Capa 6
alter table public.tg_pairings enable row level security;
alter table public.tg_team_members enable row level security;
alter table public.tg_matches enable row level security;
alter table public.tg_life_events enable row level security;

create policy "tg_pairings_select_workspace_member"
  on public.tg_pairings for select
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "tg_pairings_insert_organizer"
  on public.tg_pairings for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "tg_pairings_update_organizer"
  on public.tg_pairings for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "tg_team_members_select_workspace_member"
  on public.tg_team_members for select
  to authenticated
  using (
    exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "tg_team_members_modify_organizer"
  on public.tg_team_members for all
  to authenticated
  using (
    exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "tg_matches_select_workspace_member"
  on public.tg_matches for select
  to authenticated
  using (
    exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "tg_matches_insert_player_or_organizer"
  on public.tg_matches for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id
      and (
        public.is_workspace_organizer(de.workspace_id)
        or exists (
          select 1 from public.tg_team_members tm
          where tm.tg_pairing_id = p.id and tm.player_user_id = auth.uid()
        )
      )
    )
  );

create policy "tg_matches_update_authorized"
  on public.tg_matches for update
  to authenticated
  using (
    life_tracker_user_id = auth.uid()
    or exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id
      and (
        public.is_workspace_organizer(de.workspace_id)
        or exists (
          select 1 from public.tg_team_members tm
          where tm.tg_pairing_id = p.id and tm.player_user_id = auth.uid()
        )
      )
    )
  );

create policy "tg_life_events_select_workspace_member"
  on public.tg_life_events for select
  to authenticated
  using (
    exists (
      select 1
      from public.tg_matches m
      join public.tg_pairings p on p.id = m.tg_pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = tg_match_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "tg_life_events_insert_tracker_only"
  on public.tg_life_events for insert
  to authenticated
  with check (
    exists (
      select 1 from public.tg_matches m
      where m.id = tg_match_id
      and m.life_tracker_user_id = auth.uid()
      and m.status = 'in_progress'
    )
  );

create policy "tg_life_events_update_organizer"
  on public.tg_life_events for update
  to authenticated
  using (
    exists (
      select 1
      from public.tg_matches m
      join public.tg_pairings p on p.id = m.tg_pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = tg_match_id and public.is_workspace_organizer(de.workspace_id)
    )
  );


-- =====================================================================
-- CAPA 7: MEDIA (FOTOS Y CURIOSIDADES)
-- =====================================================================

create table public.event_media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  uploaded_by uuid not null references public.users(id),
  media_type text not null,
  storage_path text,
  file_size_bytes integer,
  mime_type text,
  caption text,
  note_content text,
  width_px integer,
  height_px integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint media_type_valid check (media_type in ('photo', 'note')),
  constraint media_photo_has_storage check (
    media_type <> 'photo' or storage_path is not null
  ),
  constraint media_note_has_content check (
    media_type <> 'note' or note_content is not null
  ),
  constraint media_caption_length check (
    caption is null or length(caption) <= 500
  ),
  constraint media_note_length check (
    note_content is null or length(note_content) <= 5000
  ),
  constraint media_file_size_limit check (
    file_size_bytes is null or file_size_bytes <= 5242880
  ),
  constraint media_mime_type_valid check (
    mime_type is null or mime_type in ('image/jpeg', 'image/png', 'image/webp')
  )
);

create index idx_event_media_event on public.event_media (event_id) where deleted_at is null;
create index idx_event_media_uploader on public.event_media (uploaded_by);
create index idx_event_media_type on public.event_media (event_id, media_type) where deleted_at is null;
create index idx_event_media_created on public.event_media (event_id, created_at desc) where deleted_at is null;

-- Trigger: enforcear limite de 5 fotos por user por evento
create or replace function public.enforce_photo_limit_per_user_per_event()
returns trigger
language plpgsql
as $$
declare
  v_count integer;
begin
  if new.media_type <> 'photo' then
    return new;
  end if;

  select count(*) into v_count
  from public.event_media
  where event_id = new.event_id
    and uploaded_by = new.uploaded_by
    and media_type = 'photo'
    and deleted_at is null;

  if v_count >= 5 then
    raise exception 'Cada usuario puede subir máximo 5 fotos por evento.';
  end if;

  return new;
end;
$$;

create trigger on_photo_insert_check_limit
  before insert on public.event_media
  for each row execute function public.enforce_photo_limit_per_user_per_event();

alter table public.event_media enable row level security;

create policy "media_select_workspace_member"
  on public.event_media for select
  to authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "media_insert_participant_or_organizer"
  on public.event_media for insert
  to authenticated
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and (
        public.is_workspace_organizer(de.workspace_id)
        or exists (
          select 1 from public.event_participants ep
          where ep.event_id = de.id and ep.user_id = auth.uid()
        )
      )
    )
  );

create policy "media_update_uploader"
  on public.event_media for update
  to authenticated
  using (
    uploaded_by = auth.uid()
    or exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );

create policy "media_delete_uploader_or_organizer"
  on public.event_media for delete
  to authenticated
  using (
    uploaded_by = auth.uid()
    or exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_organizer(de.workspace_id)
    )
  );


-- =====================================================================
-- CAPA 8: AUDITORÍA, UTILIDADES Y VISTAS DE STATS
-- =====================================================================

-- Trigger universal de updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

create trigger trg_workspaces_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

create trigger trg_cubes_updated_at
  before update on public.cubes
  for each row execute function public.set_updated_at();

create trigger trg_venues_updated_at
  before update on public.venues
  for each row execute function public.set_updated_at();

create trigger trg_draft_events_updated_at
  before update on public.draft_events
  for each row execute function public.set_updated_at();

create trigger trg_event_media_updated_at
  before update on public.event_media
  for each row execute function public.set_updated_at();

-- Tabla de auditoría
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid not null,
  operation text not null,
  performed_by uuid references public.users(id),
  performed_at timestamptz not null default now(),
  old_values jsonb,
  new_values jsonb,
  workspace_id uuid references public.workspaces(id),

  constraint audit_operation_valid check (operation in ('insert', 'update', 'delete'))
);

create index idx_audit_log_table_record on public.audit_log (table_name, record_id);
create index idx_audit_log_user on public.audit_log (performed_by);
create index idx_audit_log_workspace on public.audit_log (workspace_id);
create index idx_audit_log_time on public.audit_log (performed_at desc);

alter table public.audit_log enable row level security;

create policy "audit_log_select_organizer"
  on public.audit_log for select
  to authenticated
  using (
    workspace_id is null
    or public.is_workspace_organizer(workspace_id)
  );

-- Función genérica de auditoría
create or replace function public.audit_table_changes()
returns trigger
language plpgsql
security definer
as $$
declare
  v_workspace_id uuid;
  v_record_id uuid;
begin
  begin
    if tg_op = 'DELETE' then
      v_workspace_id := (to_jsonb(old)->>'workspace_id')::uuid;
      v_record_id := (to_jsonb(old)->>'id')::uuid;
    else
      v_workspace_id := (to_jsonb(new)->>'workspace_id')::uuid;
      v_record_id := (to_jsonb(new)->>'id')::uuid;
    end if;
  exception when others then
    v_workspace_id := null;
  end;

  insert into public.audit_log (
    table_name,
    record_id,
    operation,
    performed_by,
    old_values,
    new_values,
    workspace_id
  ) values (
    tg_table_name,
    v_record_id,
    lower(tg_op),
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end,
    v_workspace_id
  );

  return coalesce(new, old);
end;
$$;

-- Aplicar auditoría a tablas críticas
create trigger trg_audit_matches
  after insert or update or delete on public.matches
  for each row execute function public.audit_table_changes();

create trigger trg_audit_pairings
  after insert or update or delete on public.pairings
  for each row execute function public.audit_table_changes();

create trigger trg_audit_draft_events
  after insert or update or delete on public.draft_events
  for each row execute function public.audit_table_changes();

create trigger trg_audit_workspace_members
  after insert or update or delete on public.workspace_members
  for each row execute function public.audit_table_changes();

-- Vistas consolidadas de stats
create or replace view public.v_player_workspace_stats as
select
  ep.user_id,
  de.workspace_id,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep.id) as pairings_won,
  count(distinct p.id) filter (where p.official_winner_participant_id is not null and p.official_winner_participant_id <> ep.id) as pairings_lost,
  count(distinct p.id) filter (where p.official_winner_participant_id is null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as pairings_pending,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type = 'draft') as draft_matches_won,
  count(m.id) filter (where m.winner_participant_id is not null and m.winner_participant_id <> ep.id and m.match_type = 'draft' and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draft_matches_lost,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type = 'revenge') as revenge_matches_won,
  count(m.id) filter (where m.winner_participant_id is not null and m.winner_participant_id <> ep.id and m.match_type = 'revenge' and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as revenge_matches_lost,
  count(distinct p.id) filter (where p.super_cup_winner_participant_id = ep.id) as super_cups_won,
  count(distinct de.id) filter (where de.champion_user_id = ep.user_id) as championships,
  count(distinct de.id) filter (where ep.role = 'player') as events_as_player,
  count(distinct de.id) filter (where ep.role = 'ghost') as events_as_ghost,
  avg(extract(epoch from (m.ended_at - m.started_at)) / 60) filter (
    where m.status = 'completed'
    and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as avg_match_duration_minutes
from public.event_participants ep
join public.draft_events de on de.id = ep.event_id and de.deleted_at is null
left join public.pairings p on p.event_id = de.id and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
left join public.matches m on m.pairing_id = p.id and m.status = 'completed'
group by ep.user_id, de.workspace_id;

create or replace view public.v_head_to_head_stats as
select
  ep_a.user_id as user_a_id,
  ep_b.user_id as user_b_id,
  de.workspace_id,
  count(distinct p.id) as total_pairings,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep_a.id) as a_pairings_won,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep_b.id) as b_pairings_won,
  count(m.id) filter (where m.winner_participant_id = ep_a.id and m.match_type = 'draft') as a_draft_matches_won,
  count(m.id) filter (where m.winner_participant_id = ep_b.id and m.match_type = 'draft') as b_draft_matches_won,
  count(m.id) filter (where m.winner_participant_id = ep_a.id and m.match_type = 'revenge') as a_revenge_matches_won,
  count(m.id) filter (where m.winner_participant_id = ep_b.id and m.match_type = 'revenge') as b_revenge_matches_won
from public.event_participants ep_a
join public.event_participants ep_b on ep_b.event_id = ep_a.event_id and ep_b.user_id <> ep_a.user_id
join public.draft_events de on de.id = ep_a.event_id and de.deleted_at is null
join public.pairings p on p.event_id = de.id
  and ((p.participant_a_id = ep_a.id and p.participant_b_id = ep_b.id)
       or (p.participant_b_id = ep_a.id and p.participant_a_id = ep_b.id))
left join public.matches m on m.pairing_id = p.id and m.status = 'completed'
where ep_a.user_id < ep_b.user_id
group by ep_a.user_id, ep_b.user_id, de.workspace_id;

create or replace view public.v_player_tg_stats as
select
  tm.player_user_id as user_id,
  de.workspace_id,
  count(distinct tp.id) as tg_pairings_played,
  count(distinct tp.id) filter (where tp.winning_team = tm.team) as tg_pairings_won,
  count(distinct tp.id) filter (where tp.winning_team is not null and tp.winning_team <> tm.team) as tg_pairings_lost
from public.tg_team_members tm
join public.tg_pairings tp on tp.id = tm.tg_pairing_id
join public.draft_events de on de.id = tp.event_id and de.deleted_at is null
group by tm.player_user_id, de.workspace_id;

create or replace view public.v_cube_stats as
select
  c.id as cube_id,
  c.workspace_id,
  c.name,
  count(distinct de.id) as times_used,
  min(de.draft_started_at) as first_used_at,
  max(de.draft_started_at) as last_used_at,
  count(distinct ep.user_id) as unique_players_used
from public.cubes c
left join public.draft_events de on de.cube_id = c.id and de.deleted_at is null
left join public.event_participants ep on ep.event_id = de.id
where c.deleted_at is null
group by c.id, c.workspace_id, c.name;

create or replace view public.v_color_performance as
select
  ep.user_id,
  de.workspace_id,
  pc.color,
  count(distinct p.id) as pairings_played,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep.id) as pairings_won,
  count(m.id) filter (where m.match_type = 'draft' and m.status = 'completed') as draft_matches_played,
  count(m.id) filter (where m.match_type = 'draft' and m.winner_participant_id = ep.id) as draft_matches_won
from public.event_participants ep
join public.participant_colors pc on pc.participant_id = ep.id
join public.draft_events de on de.id = ep.event_id and de.deleted_at is null
left join public.pairings p on p.event_id = de.id and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
left join public.matches m on m.pairing_id = p.id
group by ep.user_id, de.workspace_id, pc.color;

-- Función de exportación
create or replace function public.export_workspace_data(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_result jsonb;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'No tenés permiso para exportar este workspace.';
  end if;

  v_result := jsonb_build_object(
    'workspace', (select to_jsonb(w) from public.workspaces w where w.id = p_workspace_id),
    'members', (select jsonb_agg(to_jsonb(wm)) from public.workspace_members wm where wm.workspace_id = p_workspace_id),
    'cubes', (select jsonb_agg(to_jsonb(c)) from public.cubes c where c.workspace_id = p_workspace_id),
    'venues', (select jsonb_agg(to_jsonb(v)) from public.venues v where v.workspace_id = p_workspace_id),
    'events', (select jsonb_agg(to_jsonb(de)) from public.draft_events de where de.workspace_id = p_workspace_id),
    'participants', (
      select jsonb_agg(to_jsonb(ep))
      from public.event_participants ep
      join public.draft_events de on de.id = ep.event_id
      where de.workspace_id = p_workspace_id
    ),
    'participant_colors', (
      select jsonb_agg(to_jsonb(pc))
      from public.participant_colors pc
      join public.event_participants ep on ep.id = pc.participant_id
      join public.draft_events de on de.id = ep.event_id
      where de.workspace_id = p_workspace_id
    ),
    'pairings', (
      select jsonb_agg(to_jsonb(p))
      from public.pairings p
      join public.draft_events de on de.id = p.event_id
      where de.workspace_id = p_workspace_id
    ),
    'matches', (
      select jsonb_agg(to_jsonb(m))
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where de.workspace_id = p_workspace_id
    ),
    'life_events', (
      select jsonb_agg(to_jsonb(le))
      from public.life_events le
      join public.matches m on m.id = le.match_id
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where de.workspace_id = p_workspace_id
    ),
    'tg_pairings', (
      select jsonb_agg(to_jsonb(tp))
      from public.tg_pairings tp
      join public.draft_events de on de.id = tp.event_id
      where de.workspace_id = p_workspace_id
    ),
    'tg_matches', (
      select jsonb_agg(to_jsonb(tm))
      from public.tg_matches tm
      join public.tg_pairings tp on tp.id = tm.tg_pairing_id
      join public.draft_events de on de.id = tp.event_id
      where de.workspace_id = p_workspace_id
    ),
    'tg_life_events', (
      select jsonb_agg(to_jsonb(tle))
      from public.tg_life_events tle
      join public.tg_matches tm on tm.id = tle.tg_match_id
      join public.tg_pairings tp on tp.id = tm.tg_pairing_id
      join public.draft_events de on de.id = tp.event_id
      where de.workspace_id = p_workspace_id
    ),
    'event_media', (
      select jsonb_agg(to_jsonb(em))
      from public.event_media em
      join public.draft_events de on de.id = em.event_id
      where de.workspace_id = p_workspace_id and em.deleted_at is null
    ),
    'exported_at', now(),
    'export_version', 1
  );

  return v_result;
end;
$$;

-- Función de purga (manual por ahora, programar con pg_cron en futuro)
create or replace function public.purge_soft_deleted(p_days_old integer default 30)
returns table (
  table_name text,
  rows_purged integer
)
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  delete from public.event_media
  where deleted_at is not null
    and deleted_at < (now() - (p_days_old || ' days')::interval);
  get diagnostics v_count = row_count;
  return query select 'event_media'::text, v_count;

  delete from public.draft_events
  where deleted_at is not null
    and deleted_at < (now() - (p_days_old || ' days')::interval);
  get diagnostics v_count = row_count;
  return query select 'draft_events'::text, v_count;

  delete from public.cubes
  where deleted_at is not null
    and deleted_at < (now() - (p_days_old || ' days')::interval);
  get diagnostics v_count = row_count;
  return query select 'cubes'::text, v_count;

  delete from public.venues
  where deleted_at is not null
    and deleted_at < (now() - (p_days_old || ' days')::interval);
  get diagnostics v_count = row_count;
  return query select 'venues'::text, v_count;

  delete from public.workspaces
  where deleted_at is not null
    and deleted_at < (now() - (p_days_old || ' days')::interval);
  get diagnostics v_count = row_count;
  return query select 'workspaces'::text, v_count;
end;
$$;


-- =====================================================================
-- FIN DE LA MIGRACIÓN
-- =====================================================================
-- Total: 17 tablas, 5 vistas, ~15 funciones, ~25 triggers
-- =====================================================================
