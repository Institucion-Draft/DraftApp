-- 0022_multi_tiebreak_logic.sql
-- Lógica del desempate múltiple.
-- Reescribe compute_event_champion para manejar empate de 3 (round-robin) y 4 (bracket).
-- 5+ → Copa Polémica.
-- Trigger evalúa el resultado del tiebreak group cuando se cierra una match de tipo tiebreak.

-- Helper: crea un event_tiebreak_group de tipo round_robin para N=3 empatados
create or replace function public.create_round_robin_tiebreak_group(
  p_event_id uuid,
  p_participant_ids uuid[],
  p_round_number integer
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_seed integer;
  v_pid uuid;
begin
  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status)
  values (p_event_id, p_round_number, 'round_robin', 'active')
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_participant_ids
  loop
    insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
    select v_group_id, v_pid, ep.user_id, v_seed
    from public.event_participants ep
    where ep.id = v_pid;
    v_seed := v_seed + 1;
  end loop;

  return v_group_id;
end;
$$;

-- Helper: crea bracket de 4 (semis seed 1v4 y 2v3, final entre ganadores)
create or replace function public.create_bracket_tiebreak_group(
  p_event_id uuid,
  p_participant_ids uuid[]
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_seed integer;
  v_pid uuid;
begin
  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status)
  values (p_event_id, 1, 'bracket', 'active')
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_participant_ids
  loop
    insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
    select v_group_id, v_pid, ep.user_id, v_seed
    from public.event_participants ep
    where ep.id = v_pid;
    v_seed := v_seed + 1;
  end loop;

  return v_group_id;
end;
$$;

-- Reescribir compute_event_champion
create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_blocked integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_winrate numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_leader_a_user_id uuid;
  v_leader_b_user_id uuid;
  v_leader_a_participant_id uuid;
  v_leader_b_participant_id uuid;
  v_tiebreak_winner_participant_id uuid;
  v_tiebreak_pairing_id uuid;
  v_leader_participant_ids uuid[];
  v_existing_active_group_id uuid;
begin
  select status, champion_user_id
  into v_event_status, v_event_champion_user_id
  from public.draft_events
  where id = p_event_id and deleted_at is null;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;
  if v_event_champion_user_id is not null then return; end if;

  -- Si ya hay un tiebreak group activo, no recrear: dejá que el trigger del cierre lo resuelva.
  select id into v_existing_active_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id and status = 'active'
  limit 1;
  if v_existing_active_group_id is not null then return; end if;

  -- Chequear si todos los pendientes están bloqueados por idos
  select
    count(*),
    count(*) filter (where official_winner_participant_id is null),
    count(*) filter (
      where official_winner_participant_id is null
        and (
          exists (select 1 from public.event_participants ep where ep.id = p.participant_a_id and ep.left_event_at is not null)
          or exists (select 1 from public.event_participants ep where ep.id = p.participant_b_id and ep.left_event_at is not null)
        )
    )
  into v_total_pairings, v_pending_pairings_total, v_pending_pairings_blocked
  from public.pairings p
  where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;
  if v_pending_pairings_total > v_pending_pairings_blocked then return; end if;

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player';

  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  with player_bo3 as (
    select
      ep.user_id, ep.id as participant_id,
      count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player'
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, (won::numeric / nullif(completed, 0)) as winrate
    from player_bo3
    where completed >= v_min_bo3_required
  )
  select max(winrate), count(*) filter (where winrate = (select max(winrate) from eligible))
  into v_max_winrate, v_leaders_count
  from eligible;

  if v_max_winrate is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  -- 1 líder único: campeón directo
  if v_leaders_count = 1 then
    select user_id into v_leader_user_id
    from (
      select ep.user_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id
    ) leaders
    where (won::numeric / nullif(completed, 0)) = v_max_winrate and completed >= v_min_bo3_required;

    update public.draft_events
    set champion_user_id = v_leader_user_id, champion_decided_by = 'auto', event_ended_at = now(),
        status = 'completed', final_pending = false
    where id = p_event_id and champion_user_id is null;
    return;
  end if;

  -- 2 líderes: usar tiebreak doble como hoy (en pairing existente)
  if v_leaders_count = 2 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    ),
    leaders_list as (
      select user_id, participant_id, row_number() over (order by participant_id) as rn
      from player_bo3
      where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate
    )
    select
      (select user_id from leaders_list where rn = 1),
      (select user_id from leaders_list where rn = 2),
      (select participant_id from leaders_list where rn = 1),
      (select participant_id from leaders_list where rn = 2)
    into v_leader_a_user_id, v_leader_b_user_id, v_leader_a_participant_id, v_leader_b_participant_id;

    select id, tiebreak_winner_participant_id
    into v_tiebreak_pairing_id, v_tiebreak_winner_participant_id
    from public.pairings
    where event_id = p_event_id
      and (
        (participant_a_id = v_leader_a_participant_id and participant_b_id = v_leader_b_participant_id)
        or (participant_a_id = v_leader_b_participant_id and participant_b_id = v_leader_a_participant_id)
      );

    if v_tiebreak_winner_participant_id is not null then
      select ep.user_id into v_leader_user_id
      from public.event_participants ep
      where ep.id = v_tiebreak_winner_participant_id;

      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
          event_ended_at = now(), status = 'completed', final_pending = false
      where id = p_event_id and champion_user_id is null;
      return;
    end if;

    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  -- 3 líderes: crear round-robin
  if v_leaders_count = 3 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    )
    select array_agg(participant_id order by participant_id) into v_leader_participant_ids
    from player_bo3
    where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate;

    perform public.create_round_robin_tiebreak_group(p_event_id, v_leader_participant_ids, 1);
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  -- 4 líderes: bracket
  if v_leaders_count = 4 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won,
        -- winrate de partidas individuales para seed
        (select count(*) from public.matches m
         join public.pairings p2 on p2.id = m.pairing_id
         where p2.event_id = p_event_id and m.status = 'completed' and m.match_type in ('draft','final')
           and m.winner_participant_id = ep.id) as match_wins,
        (select count(*) from public.matches m
         join public.pairings p2 on p2.id = m.pairing_id
         where p2.event_id = p_event_id and m.status = 'completed' and m.match_type in ('draft','final')
           and (p2.participant_a_id = ep.id or p2.participant_b_id = ep.id)) as match_played
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    )
    select array_agg(participant_id order by (match_wins::numeric / nullif(match_played, 0)) desc, participant_id)
    into v_leader_participant_ids
    from player_bo3
    where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate;

    perform public.create_bracket_tiebreak_group(p_event_id, v_leader_participant_ids);
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  -- 5+ líderes: Copa Polémica directa
  if v_leaders_count >= 5 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    )
    update public.draft_events
    set polemica_winners = (
      select array_agg(user_id) from player_bo3
      where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate
    ),
    champion_decided_by = 'polemica',
    status = 'completed',
    event_ended_at = now(),
    final_pending = false
    where id = p_event_id and champion_user_id is null;
    return;
  end if;

  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$$;

-- Trigger que evalúa el resultado de un tiebreak group cuando una match de tipo tiebreak se cierra
create or replace function public.evaluate_tiebreak_group_after_match()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing record;
  v_event_id uuid;
  v_active_group record;
  v_pending_count integer;
  v_winners_unique uuid[];
begin
  if new.match_type <> 'tiebreak' or new.status <> 'completed' then
    return new;
  end if;

  select event_id, participant_a_id, participant_b_id into v_pairing
  from public.pairings where id = new.pairing_id;

  v_event_id := v_pairing.event_id;

  -- Buscar grupo activo
  select id, group_type, round_number into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then
    return new;
  end if;

  -- Recompute campeón del evento (puede cerrar el evento si ya hay ganador claro)
  perform public.compute_event_champion(v_event_id);
  return new;
end;
$$;

drop trigger if exists on_match_completed_evaluate_tiebreak_group on public.matches;
create trigger on_match_completed_evaluate_tiebreak_group
  after update on public.matches
  for each row
  when (new.match_type = 'tiebreak' and new.status = 'completed')
  execute function public.evaluate_tiebreak_group_after_match();

-- Constraint validation: actualizar el CHECK de champion_decided_by para incluir 'polemica'
alter table public.draft_events
  drop constraint if exists draft_events_champion_decision_valid;

alter table public.draft_events
  add constraint draft_events_champion_decision_valid
  check (champion_decided_by is null or champion_decided_by in ('auto', 'manual_override', 'tiebreak', 'polemica'));
