-- 0072_fourth_place_tiebreak_advance.sql
-- Conecta el avance del desempate por el 4to puesto (group_type='fourth_place', 0071) al cierre
-- de sus partidos. Reescribe evaluate_tiebreak_group_after_match (0039) agregando una tercera
-- rama junto a 'round_robin' y 'bracket'; esas dos quedan copiadas tal cual, sin cambios.
--
-- Mecanismo de avance (mismo patrón que 'bracket': la fila dependiente recién se inserta cuando
-- su dependencia se resuelve, no al crear el grupo), adaptado a que acá el "próximo partido" no
-- siempre es "ganador de semiX vs ganador de semiY" (el caso de bye en un grupo de 3 depende de
-- un participante fijo que no es ganador de nada):
--   1. Ubicar, en pending_bracket_matches (la copia íntegra de computeFourthPlaceTiebreakBracket
--      guardada en 0071), el índice del partido recién resuelto (matcheando participantes) y su
--      winnerAdvancesTo.
--   2. Sustituir, en TODO pending_bracket_matches, cualquier slot {"winnerOfMatch": <ese índice>}
--      por {"participantId": "<ganador real>"} — materializa el resultado para quien dependía de él.
--   3. Si winnerAdvancesTo = 'final_4th': ese ganador ES el 4to puesto. Resolver el grupo y armar
--      el top4 real con los 3 ya conocidos (event_tiebreak_group_participants, seed 1-3) + este
--      ganador, en orden [1°, 2°, 3°, 4°].
--   4. Si no: mirar el partido al que avanza (ya sustituido en el paso 2). Si AMBOS lados ya son
--      concretos (para un grupo de 4, esto requiere que las 2 semis hayan resuelto, no solo una),
--      insertarlo en event_tiebreak_bracket_matches y linkear su pairing. Si todavía falta un
--      lado, no hacer nada más — se completa cuando el otro partido feeder se resuelva.

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
  v_leader_user_id uuid;
  v_leader_participant_ids uuid[];
  v_max_match_winrate numeric;
  v_winrate_leaders_count integer;
  v_event_already_completed boolean;
begin
  if new.match_type <> 'tiebreak' or new.status <> 'completed' then
    return new;
  end if;

  select event_id, participant_a_id, participant_b_id into v_pairing
  from public.pairings where id = new.pairing_id;
  v_event_id := v_pairing.event_id;

  select id, group_type, round_number into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  -- ROUND ROBIN: sin cambios respecto a 0039.
  if v_active_group.group_type = 'round_robin' then
    select count(*) into v_participant_count
    from public.event_tiebreak_group_participants where group_id = v_active_group.id;

    v_total_pairs_needed := v_participant_count * (v_participant_count - 1) / 2;
    v_played_count := public.count_tiebreak_round_played(v_active_group.id, v_active_group.round_number);

    if v_event_already_completed then
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', resolved_at = now() where id = v_active_group.id;
      end if;
      return new;
    end if;

    select participant_id, public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number)
    into v_winner_participant_id, v_max_wins
    from public.event_tiebreak_group_participants where group_id = v_active_group.id
    order by public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number) desc limit 1;

    if v_max_wins = v_participant_count - 1 then
      select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      else
        update public.event_tiebreak_groups set champion_user_id = v_leader_user_id where id = v_active_group.id;
      end if;
      return new;
    end if;

    if v_played_count < v_total_pairs_needed then return new; end if;

    if v_active_group.round_number = 1 then
      select array_agg(participant_id order by participant_id) into v_leader_participant_ids
      from public.event_tiebreak_group_participants where group_id = v_active_group.id;
      update public.event_tiebreak_groups set status = 'failed' where id = v_active_group.id;
      perform public.create_round_robin_tiebreak_group(v_event_id, v_leader_participant_ids, 2);
      return new;
    end if;

    with winrates as (
      select etgp.participant_id, etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
      from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
    )
    select max(wr), count(*) filter (where wr = (select max(wr) from winrates))
    into v_max_match_winrate, v_winrate_leaders_count from winrates;

    if v_winrate_leaders_count = 1 then
      select user_id into v_leader_user_id from (
        select etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
        from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
      ) wr_table where wr = v_max_match_winrate;
      update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      return new;
    end if;

    update public.event_tiebreak_groups set status = 'failed', resolved_at = now() where id = v_active_group.id;
    update public.draft_events
    set polemica_winners = (
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) = v_max_match_winrate
    ),
    recognition_winners = coalesce(recognition_winners, '{}') || coalesce((
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) < v_max_match_winrate
    ), '{}'),
    champion_decided_by = 'polemica', status = 'completed', event_ended_at = now(), final_pending = false
    where id = v_event_id and champion_user_id is null;
    return new;
  end if;

  -- BRACKET (semis+final+3°/4° del top4 real, o de la Copa Polémica): sin cambios respecto a 0039.
  if v_active_group.group_type = 'bracket' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_bm_a uuid;
      v_bm_b uuid;
      v_wins_a integer;
      v_wins_b integer;
      v_wins_needed integer;
      v_llave_winner uuid;
      v_completed_semis integer;
      v_final_exists boolean;
      v_semi_winners uuid[];
      v_semi_losers uuid[];
      v_bracket_total integer;
      v_bracket_pending integer;
    begin
      select id, bracket_phase, participant_a_id, participant_b_id
      into v_bm_id, v_bm_phase, v_bm_a, v_bm_b
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      select count(*) filter (where m.winner_participant_id = v_bm_a),
             count(*) filter (where m.winner_participant_id = v_bm_b)
      into v_wins_a, v_wins_b
      from public.matches m
      where m.pairing_id = new.pairing_id
        and m.match_type = 'tiebreak'
        and m.status = 'completed';

      v_wins_needed := public.topcut_wins_needed(v_event_id, v_bm_phase);

      if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
        return new;
      end if;

      if v_wins_a >= v_wins_needed then
        v_llave_winner := v_bm_a;
      else
        v_llave_winner := v_bm_b;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_llave_winner,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      if v_bm_phase = 'semi' then
        select count(*) into v_completed_semis
        from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and bracket_phase = 'semi'
          and winner_participant_id is not null;

        if v_completed_semis >= 2 then
          select exists (
            select 1 from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'final'
          ) into v_final_exists;

          if not v_final_exists then
            select
              array_agg(winner_participant_id order by created_at),
              array_agg(
                case when winner_participant_id = participant_a_id
                     then participant_b_id else participant_a_id end
                order by created_at
              )
            into v_semi_winners, v_semi_losers
            from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'semi';

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'final', v_semi_winners[1], v_semi_winners[2]);

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'third_place', v_semi_losers[1], v_semi_losers[2]);

            perform public.link_bracket_matches_to_pairings(v_active_group.id);
          end if;
        end if;

      elsif v_bm_phase = 'final' then
        select user_id into v_leader_user_id
        from public.event_participants where id = v_llave_winner;

        update public.draft_events
        set champion_user_id = v_leader_user_id,
            champion_decided_by = 'tiebreak',
            event_ended_at = now(),
            status = 'completed',
            final_pending = false
        where id = v_event_id and champion_user_id is null;

        update public.event_tiebreak_groups
        set champion_user_id = v_leader_user_id
        where id = v_active_group.id and champion_user_id is null;
      end if;

      select count(*),
             count(*) filter (where winner_participant_id is null)
      into v_bracket_total, v_bracket_pending
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id;

      if v_bracket_total >= 4 and v_bracket_pending = 0 then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';
      end if;

      return new;
    end;
  end if;

  -- FOURTH_PLACE: desempate por el 4to puesto de round_robin_bo1_top4 (0071).
  if v_active_group.group_type = 'fourth_place' then
    declare
      v_bm_id uuid;
      v_bm_a uuid;
      v_bm_b uuid;
      v_resolved_index integer;
      v_resolved_match jsonb;
      v_advances text;
      v_next_index integer;
      v_next_match jsonb;
      v_next_a_id uuid;
      v_next_b_id uuid;
      v_next_phase text;
      v_next_already_exists boolean;
      v_top3 uuid[];
      v_top4 uuid[];
    begin
      -- Ubicar la fila del bracket de 4to puesto que matchea este pairing y sigue sin ganador.
      select id, participant_a_id, participant_b_id
      into v_bm_id, v_bm_a, v_bm_b
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      v_winner_participant_id := new.winner_participant_id;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      -- Ubicar, en pending_bracket_matches (estructura íntegra guardada en 0071), el índice del
      -- partido recién resuelto y su winnerAdvancesTo.
      select ord.idx - 1, ord.elem
      into v_resolved_index, v_resolved_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id
        and (ord.elem->'a' ? 'participantId')
        and (ord.elem->'b' ? 'participantId')
        and (
          ((ord.elem->'a'->>'participantId')::uuid = v_bm_a and (ord.elem->'b'->>'participantId')::uuid = v_bm_b)
          or ((ord.elem->'a'->>'participantId')::uuid = v_bm_b and (ord.elem->'b'->>'participantId')::uuid = v_bm_a)
        )
      limit 1;

      if v_resolved_index is null then
        -- No debería pasar (el partido se insertó a partir de este mismo pending_bracket_matches),
        -- pero sin el índice no hay forma de saber a qué avanza el ganador.
        return new;
      end if;

      v_advances := v_resolved_match->>'winnerAdvancesTo';

      -- Materializar el ganador: sustituir cualquier slot {"winnerOfMatch": v_resolved_index} por
      -- {"participantId": <ganador real>} en TODO pending_bracket_matches.
      update public.event_tiebreak_groups
      set pending_bracket_matches = (
        select jsonb_agg(
          jsonb_build_object(
            'round', elem->'round',
            'a', case
                   when (elem->'a' ? 'winnerOfMatch') and (elem->'a'->>'winnerOfMatch')::integer = v_resolved_index
                   then jsonb_build_object('participantId', v_winner_participant_id::text)
                   else elem->'a'
                 end,
            'b', case
                   when (elem->'b' ? 'winnerOfMatch') and (elem->'b'->>'winnerOfMatch')::integer = v_resolved_index
                   then jsonb_build_object('participantId', v_winner_participant_id::text)
                   else elem->'b'
                 end,
            'winnerAdvancesTo', elem->'winnerAdvancesTo'
          )
          order by ord.idx
        )
        from jsonb_array_elements(pending_bracket_matches) with ordinality as ord(elem, idx)
      )
      where id = v_active_group.id;

      if v_advances = 'final_4th' then
        -- Este partido decidía el 4to puesto: resolver el grupo y armar el top4 real.
        select array_agg(participant_id order by seed) into v_top3
        from public.event_tiebreak_group_participants
        where group_id = v_active_group.id;

        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';

        if v_top3 is not null and array_length(v_top3, 1) = 3 then
          v_top4 := v_top3 || v_winner_participant_id;
          perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
        end if;

        return new;
      end if;

      -- Si no, el ganador avanza al partido con índice v_advances (0-based). Revisar si, tras la
      -- sustitución de arriba, ese partido ya tiene AMBOS lados concretos (un grupo de 4 necesita
      -- que las 2 semis hayan resuelto para esto; un grupo de 3 lo tiene resuelto en este mismo paso).
      v_next_index := v_advances::integer;

      select ord.elem into v_next_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id and ord.idx - 1 = v_next_index;

      if v_next_match is null
        or not (v_next_match->'a' ? 'participantId')
        or not (v_next_match->'b' ? 'participantId') then
        -- Todavía falta el otro partido feeder.
        return new;
      end if;

      v_next_a_id := (v_next_match->'a'->>'participantId')::uuid;
      v_next_b_id := (v_next_match->'b'->>'participantId')::uuid;
      v_next_phase := case when v_next_match->>'winnerAdvancesTo' = 'final_4th' then 'final' else 'semi' end;

      select exists (
        select 1 from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and ((participant_a_id = v_next_a_id and participant_b_id = v_next_b_id)
            or (participant_a_id = v_next_b_id and participant_b_id = v_next_a_id))
      ) into v_next_already_exists;

      if not v_next_already_exists then
        insert into public.event_tiebreak_bracket_matches
          (group_id, bracket_phase, participant_a_id, participant_b_id)
        values (v_active_group.id, v_next_phase, v_next_a_id, v_next_b_id);

        perform public.link_bracket_matches_to_pairings(v_active_group.id);
      end if;

      return new;
    end;
  end if;

  return new;
end;
$$;
