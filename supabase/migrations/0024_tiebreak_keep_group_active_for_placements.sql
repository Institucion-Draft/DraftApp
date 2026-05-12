-- 0024_tiebreak_keep_group_active_for_placements.sql
-- Ajuste: cuando hay campeón anticipado en el round-robin, el evento se cierra,
-- pero el grupo de tiebreak queda 'active' hasta que se jueguen los pairs restantes
-- (para definir 2° y 3er puesto). Cuando se cierra la última match del grupo,
-- el grupo pasa a 'resolved'.

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
  v_event_already_completed boolean;
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

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  if v_active_group.group_type = 'round_robin' then
    select count(*) into v_participant_count
    from public.event_tiebreak_group_participants
    where group_id = v_active_group.id;

    v_total_pairs_needed := v_participant_count * (v_participant_count - 1) / 2;
    v_played_count := public.count_tiebreak_round_played(v_active_group.id, v_active_group.round_number);

    -- Si el evento ya está completed (campeón anticipado previo), evaluar si este match
    -- cerró el último pair del grupo (las partidas de 2° y 3° puesto)
    if v_event_already_completed then
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id;
      end if;
      return new;
    end if;

    -- Chequear campeón anticipado
    select participant_id, public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number)
    into v_winner_participant_id, v_max_wins
    from public.event_tiebreak_group_participants
    where group_id = v_active_group.id
    order by public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number) desc
    limit 1;

    if v_max_wins = v_participant_count - 1 then
      select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
          event_ended_at = now(), status = 'completed', final_pending = false
      where id = v_event_id and champion_user_id is null;
      -- Si ya se jugaron todos los pairs, marcar grupo resolved. Sino, dejarlo activo
      -- para que las partidas de 2°/3° se puedan jugar.
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups
        set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now()
        where id = v_active_group.id;
      else
        update public.event_tiebreak_groups
        set champion_user_id = v_leader_user_id
        where id = v_active_group.id;
      end if;
      return new;
    end if;

    if v_played_count < v_total_pairs_needed then return new; end if;

    -- Todos los pares jugados, ningún campeón anticipado: empate
    if v_active_group.round_number = 1 then
      select array_agg(participant_id order by participant_id) into v_leader_participant_ids
      from public.event_tiebreak_group_participants
      where group_id = v_active_group.id;
      update public.event_tiebreak_groups set status = 'failed' where id = v_active_group.id;
      perform public.create_round_robin_tiebreak_group(v_event_id, v_leader_participant_ids, 2);
      return new;
    end if;

    -- Round 2 también empata: winrate de partidas individuales
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
    declare v_completed_matches integer;
    begin
      select count(*) into v_completed_matches
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.event_tiebreak_group_participants etgp1 on etgp1.group_id = v_active_group.id and etgp1.participant_id = p.participant_a_id
      join public.event_tiebreak_group_participants etgp2 on etgp2.group_id = v_active_group.id and etgp2.participant_id = p.participant_b_id
      where m.match_type = 'tiebreak' and m.status = 'completed' and p.event_id = v_event_id;

      if v_completed_matches >= 3 then
        select m.winner_participant_id into v_winner_participant_id
        from public.matches m
        join public.pairings p on p.id = m.pairing_id
        join public.event_tiebreak_group_participants etgp1 on etgp1.group_id = v_active_group.id and etgp1.participant_id = p.participant_a_id
        join public.event_tiebreak_group_participants etgp2 on etgp2.group_id = v_active_group.id and etgp2.participant_id = p.participant_b_id
        where m.match_type = 'tiebreak' and m.status = 'completed' and p.event_id = v_event_id
        order by m.ended_at desc limit 1;

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
