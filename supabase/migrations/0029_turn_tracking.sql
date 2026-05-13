-- 0029_turn_tracking.sql
-- Sistema de turnos con animaciones Pokémon.
-- Activable por evento via turn_tracking_enabled.

alter table public.draft_events
  add column if not exists turn_tracking_enabled boolean not null default false;

alter table public.matches
  add column if not exists who_started_participant_id uuid references public.event_participants(id);

create table if not exists public.match_turns (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  turn_number integer not null,
  attacker_user_id uuid not null references public.users(id),
  attacker_participant_id uuid not null references public.event_participants(id),
  life_a_before integer not null,
  life_b_before integer not null,
  life_a_after integer not null,
  life_b_after integer not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  move_category text check (move_category in ('damage', 'absorption', 'self_heal', 'self_damage_both', 'self_damage_only', 'neutral')),
  move_name text,
  unique (match_id, turn_number)
);

create index if not exists idx_match_turns_match on public.match_turns (match_id);

alter table public.match_turns enable row level security;

create policy "select_match_turns_for_workspace_members"
  on public.match_turns
  for select
  using (
    exists (
      select 1 from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_turns.match_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "insert_match_turns_for_participants_or_organizer"
  on public.match_turns
  for insert
  with check (
    exists (
      select 1 from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_turns.match_id
        and (
          public.is_workspace_organizer(de.workspace_id)
          or exists (
            select 1 from public.event_participants ep
            where ep.event_id = de.id and ep.user_id = auth.uid()
              and (ep.id = p.participant_a_id or ep.id = p.participant_b_id)
          )
        )
    )
  );

create policy "update_match_turns_for_participants_or_organizer"
  on public.match_turns
  for update
  using (
    exists (
      select 1 from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_turns.match_id
        and (
          public.is_workspace_organizer(de.workspace_id)
          or exists (
            select 1 from public.event_participants ep
            where ep.event_id = de.id and ep.user_id = auth.uid()
              and (ep.id = p.participant_a_id or ep.id = p.participant_b_id)
          )
        )
    )
  );
