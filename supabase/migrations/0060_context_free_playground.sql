-- 0060_context_free_playground.sql
-- Playground de "Partidas sin contexto": presencia, encuentros, partidas y eventos de vida.

-- ── 1. playground_presence ───────────────────────────────────────────────────

create table public.playground_presence (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users(id) on delete cascade,
  workspace_id        uuid        not null references public.workspaces(id) on delete cascade,
  avatar_id           uuid        references public.default_avatars(id),
  is_shiny            boolean     not null default false,
  avatar_assigned_at  timestamptz,
  last_match_ended_at timestamptz,
  joined_at           timestamptz not null default now(),
  unique(user_id, workspace_id)
);

create index idx_playground_presence_workspace on public.playground_presence (workspace_id);

alter table public.playground_presence enable row level security;

create policy "pp_select_member"
  on public.playground_presence for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "pp_insert_own"
  on public.playground_presence for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "pp_update_own"
  on public.playground_presence for update to authenticated
  using (user_id = auth.uid());

create policy "pp_delete_own"
  on public.playground_presence for delete to authenticated
  using (user_id = auth.uid());

-- ── 2. context_free_encounters ───────────────────────────────────────────────

create table public.context_free_encounters (
  id             uuid        primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces(id) on delete cascade,
  user_a_id      uuid        not null references public.users(id),
  user_b_id      uuid        not null references public.users(id),
  encounter_type text        not null check (encounter_type in ('bo1', 'bo3')),
  winner_user_id uuid        references public.users(id),
  colors_a       text[]      not null default '{}',
  colors_b       text[]      not null default '{}',
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  constraint cfe_different_users check (user_a_id <> user_b_id)
);

create index idx_cfe_workspace      on public.context_free_encounters (workspace_id);
create index idx_cfe_users          on public.context_free_encounters (workspace_id, user_a_id, user_b_id);

alter table public.context_free_encounters enable row level security;

create policy "cfe_select_member"
  on public.context_free_encounters for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "cfe_insert_participant"
  on public.context_free_encounters for insert to authenticated
  with check (
    (user_a_id = auth.uid() or user_b_id = auth.uid())
    and public.is_workspace_member(workspace_id)
  );

create policy "cfe_update_participant"
  on public.context_free_encounters for update to authenticated
  using (user_a_id = auth.uid() or user_b_id = auth.uid());

-- ── 3. context_free_matches ──────────────────────────────────────────────────

create table public.context_free_matches (
  id               uuid        primary key default gen_random_uuid(),
  encounter_id     uuid        not null references public.context_free_encounters(id) on delete cascade,
  match_number     integer     not null,
  winner_user_id   uuid        references public.users(id),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  starting_life_a  integer     not null default 20,
  starting_life_b  integer     not null default 20
);

create index idx_cfm_encounter on public.context_free_matches (encounter_id);

alter table public.context_free_matches enable row level security;

create policy "cfm_select_member"
  on public.context_free_matches for select to authenticated
  using (
    exists (
      select 1 from public.context_free_encounters cfe
      where cfe.id = encounter_id
        and public.is_workspace_member(cfe.workspace_id)
    )
  );

create policy "cfm_insert_participant"
  on public.context_free_matches for insert to authenticated
  with check (
    exists (
      select 1 from public.context_free_encounters cfe
      where cfe.id = encounter_id
        and (cfe.user_a_id = auth.uid() or cfe.user_b_id = auth.uid())
        and public.is_workspace_member(cfe.workspace_id)
    )
  );

create policy "cfm_update_participant"
  on public.context_free_matches for update to authenticated
  using (
    exists (
      select 1 from public.context_free_encounters cfe
      where cfe.id = encounter_id
        and (cfe.user_a_id = auth.uid() or cfe.user_b_id = auth.uid())
    )
  );

-- ── 4. context_free_life_events ──────────────────────────────────────────────

create table public.context_free_life_events (
  id         uuid        primary key default gen_random_uuid(),
  match_id   uuid        not null references public.context_free_matches(id) on delete cascade,
  user_id    uuid        not null references public.users(id),
  delta      integer     not null,
  created_at timestamptz not null default now()
);

create index idx_cfle_match on public.context_free_life_events (match_id);

alter table public.context_free_life_events enable row level security;

create policy "cfle_select_member"
  on public.context_free_life_events for select to authenticated
  using (
    exists (
      select 1 from public.context_free_matches cfm
      join public.context_free_encounters cfe on cfe.id = cfm.encounter_id
      where cfm.id = match_id
        and public.is_workspace_member(cfe.workspace_id)
    )
  );

create policy "cfle_insert_participant"
  on public.context_free_life_events for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.context_free_matches cfm
      join public.context_free_encounters cfe on cfe.id = cfm.encounter_id
      where cfm.id = match_id
        and (cfe.user_a_id = auth.uid() or cfe.user_b_id = auth.uid())
        and public.is_workspace_member(cfe.workspace_id)
    )
  );
