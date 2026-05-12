-- 0023_multi_tiebreak_resolution.sql
-- Lógica de resolución de tiebreak groups (round-robin y bracket).
-- 
-- Round-robin de 3:
--   1. Al cerrarse una match de tiebreak del grupo, contar wins de cada participant en este round.
--   2. Si alguien tiene 2 wins (ganó sus 2 partidas) → campeón anticipado, marca el grupo resolved.
--   3. Si todas las matches del round se cerraron y no hay 2 wins:
--      - Si hay 1-1-1 (triple empate) → crear nuevo grupo round+1 con los mismos 3.
--      - Si hay 1-1-1 en round 2 → desempatar por winrate de partidas individuales del evento.
--      - Si winrate empata también → Copa Polémica.
--
-- Bracket de 4 (semis seed 1v4 + 2v3, final entre ganadores):
--   1. Los pairings de semis son entre seed 1-4 y 2-3 (por winrate de partidas).
--   2. Cuando se completan ambas semis, los ganadores juegan la final.
--   3. Ganador de la final → campeón. Marca grupo resolved.

-- Helper: contar wins de un participant en el round actual del grupo
create or replace function public.count_tiebreak_round_wins(
  p_group_id uuid,
  p_participant_id uuid,
  p_round_number integer
)
returns integer
language sql
security definer
stable
as $$
  select count(*)::integer
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  join public.event_tiebreak_groups etg on etg.id = p_group_id
  join public.event_tiebreak_group_participants etgp1 on etgp1.group_id = etg.id and etgp1.participant_id = p.participant_a_id
  join public.event_tiebreak_group_participants etgp2 on etgp2.group_id = etg.id and etgp2.participant_id = p.participant_b_id
  where m.match_type = 'tiebreak'
    and m.status = 'completed'
    and m.tiebreak_round = p_round_number
    and m.winner_participant_id = p_participant_id
    and p.event_id = etg.event_id;
$$;

-- Helper: contar pairs jugados del round actual del grupo
create or replace function public.count_tiebreak_round_played(
  p_group_id uuid,
  p_round_number integer
)
returns integer
language sql
security definer
stable
as $$
  select count(distinct p.id)::integer
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  join public.event_tiebreak_groups etg on etg.id = p_group_id
  join public.event_tiebreak_group_participants etgp1 on etgp1.group_id = etg.id and etgp1.participant_id = p.participant_a_id
  join public.event_tiebreak_group_participants etgp2 on etgp2.group_id = etg.id and etgp2.participant_id = p.participant_b_id
  where m.match_type = 'tiebreak'
    and m.status = 'completed'
    and m.tiebreak_round = p_round_number
    and p.event_id = etg.event_id;
$$;

-- Helper: winrate de partidas individuales del evento por participant
create or replace function public.event_match_winrate(
  p_event_id uuid,
  p_participant_id uuid
)
returns numeric
language sql
security definer
stable
as $$
  select case
    when count(*) = 0 then 0
    else count(*) filter (where m.winner_participant_id = p_participant_id)::numeric / count(*)
  end
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  where p.event_id = p_event_id
    and m.match_type in ('draft', 'final')
    and m.status = 'completed'
    and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id);
$$;

-- Reescribir evaluate_tiebreak_group_after_match con toda la lógica
create or replace function public.evaluate_tiebreak_group_after_match()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing record;
  v_event_id uuid;
  v_active_group record;
  v_participant_count integer;
  v_played_count integer;
  v_total_pairs_needed integer;
  v_winner_participant_id uuid;
  v_max_wins integer;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_leader_participant_ids uuid[];
  v_max_match_winrate numeric;
  v_winrate_leaders_count integer;
  v_new_group_id uuid;
begin
  if new.match_type <> 'tiebreak' or new.status <> 'completed' then
    return new;
  end if;

  select event_id into v_pairing
  from public.pairings where id = new.pairing_id;
  v_event_id := v_pairing.event_id;

  select id, group_type, round_number into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  if v_active_group.group_type = 'round_robin' then
    select count(*) into v_participant_count
    from public.event_tiebreak_group_participants
    where group_id = v_active_group.id;

    v_total_pairs_needed := v_participant_count * (v_participant_count - 1) / 2;

    v_played_count := public.count_tiebreak_round_played(v_active_group.id, v_active_group.round_number);

    -- Chequear campeón anticipado: alguien tiene wins = v_participant_count - 1
    select participant_id, public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number)
    into v_winner_participant_id, v_max_wins
    from public.event_tiebreak_group_participants
    where group_id = v_active_group.id
    order by public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number) desc
    limit 1;

    if v_max_wins = v_participant_count - 1 then
      -- Campeón anticipado
      select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
      update public.event_tiebreak_groups
      set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now()
      where id = v_active_group.id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
          event_ended_at = now(), status = 'completed', final_pending = false
      where id = v_event_id and champion_user_id is null;
      return new;
    end if;

    -- Si no jugaron todos los pares aún, esperar
    if v_played_count < v_total_pairs_needed then
      return new;
    end if;

    -- Todos los pares jugados, ningún campeón anticipado: empate
    if v_active_group.round_number = 1 then
      -- Crear round 2 con los mismos participants
      select array_agg(participant_id order by participant_id) into v_leader_participant_ids
      from public.event_tiebreak_group_participants
      where group_id = v_active_group.id;

      update public.event_tiebreak_groups set status = 'failed' where id = v_active_group.id;
      perform public.create_round_robin_tiebreak_group(v_event_id, v_leader_participant_ids, 2);
      return new;
    end if;

    -- Round 2 terminó empate también: desempate por winrate de partidas individuales
    select array_agg(etgp.participant_id) into v_leader_participant_ids
    from public.event_tiebreak_group_participants etgp
    where etgp.group_id = v_active_group.id;

    with winrates as (
      select etgp.participant_id, etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
      from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id
    )
    select max(wr), count(*) filter (where wr = (select max(wr) from winrates))
    into v_max_match_winrate, v_winrate_leaders_count
    from winrates;

    if v_winrate_leaders_count = 1 then
      select user_id into v_leader_user_id
      from (
        select etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
        from public.event_tiebreak_group_participants etgp
        where etgp.group_id = v_active_group.id
      ) wr_table
      where wr = v_max_match_winrate;

      update public.event_tiebreak_groups
      set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now()
      where id = v_active_group.id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
          event_ended_at = now(), status = 'completed', final_pending = false
      where id = v_event_id and champion_user_id is null;
      return new;
    end if;

    -- Empate persiste en winrate: Copa Polémica entre los empatados
    update public.event_tiebreak_groups set status = 'failed', resolved_at = now() where id = v_active_group.id;
    update public.draft_events
    set polemica_winners = (
      select array_agg(etgp.user_id)
      from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id
        and public.event_match_winrate(v_event_id, etgp.participant_id) = v_max_match_winrate
    ),
    champion_decided_by = 'polemica',
    status = 'completed',
    event_ended_at = now(),
    final_pending = false
    where id = v_event_id and champion_user_id is null;
    return new;
  end if;

  -- Bracket de 4
  if v_active_group.group_type = 'bracket' then
    -- Por simplicidad: cuando hay 3 matches cerradas (2 semis + 1 final), determinar campeón.
    -- El ganador de la final es el último winner del grupo.
    declare
      v_completed_matches integer;
    begin
      select count(*) into v_completed_matches
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.event_tiebreak_group_participants etgp1 on etgp1.group_id = v_active_group.id and etgp1.participant_id = p.participant_a_id
      join public.event_tiebreak_group_participants etgp2 on etgp2.group_id = v_active_group.id and etgp2.participant_id = p.participant_b_id
      where m.match_type = 'tiebreak'
        and m.status = 'completed'
        and p.event_id = v_event_id;

      if v_completed_matches >= 3 then
        -- Tomar la última match cerrada como final
        select m.winner_participant_id into v_winner_participant_id
        from public.matches m
        join public.pairings p on p.id = m.pairing_id
        join public.event_tiebreak_group_participants etgp1 on etgp1.group_id = v_active_group.id and etgp1.participant_id = p.participant_a_id
        join public.event_tiebreak_group_participants etgp2 on etgp2.group_id = v_active_group.id and etgp2.participant_id = p.participant_b_id
        where m.match_type = 'tiebreak'
          and m.status = 'completed'
          and p.event_id = v_event_id
        order by m.ended_at desc
        limit 1;

        select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;

        update public.event_tiebreak_groups
        set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now()
        where id = v_active_group.id;
        update public.draft_events
        set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
            event_ended_at = now(), status = 'completed', final_pending = false
        where id = v_event_id and champion_user_id is null;
        return new;
      end if;
    end;
  end if;

  return new;
end;
$$;
