-- 0021_multi_tiebreak.sql
-- Sistema de desempate múltiple (3+ jugadores empatados en primer lugar).
--
-- Modelo:
-- - Cuando compute_event_champion detecta empate de 3 → crea un event_tiebreak_group con round 1.
-- - Cuando detecta empate de 4 → crea un event_tiebreak_group de tipo bracket (semis + final).
-- - Cuando detecta empate de 5+ → asigna Copa Polémica a los empatados.
-- - Cada match del desempate múltiple se registra con match_type='tiebreak' y tiebreak_round.
-- - Las partidas siguen viviendo en el pairing existente entre cada par. Si el par no tiene
--   pairing existente (no se enfrentaron en BO3 oficial), se crea uno nuevo.
-- - Mientras el par no haya jugado SU partida del round actual, el botón en PairingDetail
--   dice "Iniciar desempate". Cuando la jugaron, vuelve a venganza.
-- - Si ya hay campeón anticipado del round (alguien ganó 2 de sus 2 partidas), para los pares
--   restantes el botón dice "Definir 2° y 3er puesto".

-- 1. Columna tiebreak_round en matches (default 1)
alter table public.matches
  add column if not exists tiebreak_round integer;

-- 2. Tabla event_tiebreak_groups: representa una ronda de desempate múltiple
create table if not exists public.event_tiebreak_groups (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  round_number integer not null default 1,
  group_type text not null check (group_type in ('round_robin', 'bracket')),
  status text not null default 'active' check (status in ('active', 'resolved', 'failed')),
  champion_user_id uuid references public.users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_event_tiebreak_groups_event on public.event_tiebreak_groups (event_id);
create index if not exists idx_event_tiebreak_groups_active on public.event_tiebreak_groups (event_id, status) where status = 'active';

-- 3. Tabla event_tiebreak_group_participants: quiénes están en el grupo + seed
create table if not exists public.event_tiebreak_group_participants (
  group_id uuid not null references public.event_tiebreak_groups(id) on delete cascade,
  participant_id uuid not null references public.event_participants(id) on delete cascade,
  user_id uuid not null references public.users(id),
  seed integer not null,
  primary key (group_id, participant_id)
);

create index if not exists idx_etgp_user on public.event_tiebreak_group_participants (user_id);

-- 4. Copa Polémica y Copa Reconocimiento como uuid arrays en draft_events
alter table public.draft_events
  add column if not exists polemica_winners uuid[] default '{}',
  add column if not exists recognition_winners uuid[] default '{}';

-- 5. RLS para las nuevas tablas
alter table public.event_tiebreak_groups enable row level security;
alter table public.event_tiebreak_group_participants enable row level security;

create policy "select_tiebreak_groups_for_workspace_members"
  on public.event_tiebreak_groups
  for select
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_tiebreak_groups.event_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "select_tiebreak_group_participants_for_workspace_members"
  on public.event_tiebreak_group_participants
  for select
  using (
    exists (
      select 1 from public.event_tiebreak_groups etg
      join public.draft_events de on de.id = etg.event_id
      where etg.id = event_tiebreak_group_participants.group_id
        and public.is_workspace_member(de.workspace_id)
    )
  );
