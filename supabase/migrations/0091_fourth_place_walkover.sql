-- 0091_fourth_place_walkover.sql
-- Fase 5 del rediseño de "Me voy": walkover + recálculo por abandono en la disputa por el
-- último cupo del top4 de round_robin_bo1_top4 (group_type='fourth_place',
-- group_origin='round_robin_fourth_place', 0071/0072) — la pieza que faltaba entre la fase
-- regular (Fase 1-3) y el bracket real de top4, ya walkover-safe (Fase 4).
--
-- Mismo patrón que Fase 3, aplicado a esta disputa:
--   1. Ventana de recálculo: si nadie en la disputa arrancó ningún partido, recalcular
--      excluyendo a quien se va (close_active_round_robin_fourth_place_group + recrear vía
--      computeAndCreateTop4Bracket, cliente — reusa Fase 4 tal cual, incluye el caso "queda 1
--      solo, entra directo").
--   2. Walkover puntual una vez que algo arrancó: se extiende apply_walkover_for_tiebreak_leg
--      (antes hardcodeada a group_origin='round_robin_first_place') en vez de duplicarla — la
--      única diferencia real entre orígenes es v_wins_needed (round_robin_first_place: BO1
--      semi/BO3 final; round_robin_fourth_place: siempre BO1, cualquier fase, mismo criterio
--      que ya usa evaluate_tiebreak_group_after_match para este origin).
--   3. Gap del bye (mismo problema que 0087/0090, resolución distinta): si el bye de un empate
--      de 3 se va antes de que su fila se cree, en vez de coronar campeón se decide
--      directamente el 4to seed (el ganador de la semi de los otros dos) y se alimenta
--      create_round_robin_top4_bracket con [top3, ganador] — mismo hand-off que el camino
--      normal. La fila se crea igual (ya resuelta, sin match asociado, mismo criterio que 0090)
--      para que la tabla/podio vean quién quedó eliminado de la disputa.
--
-- Punto 4 (guard de seguridad del cliente) confirmado SIN cambios de código: el botón "tu
-- partido" de esta disputa (EventDetailScreen.tsx) navega a PairingDetail con el mismo
-- pairing_id real de siempre (link_bracket_matches_to_pairings linkea contra el pairing de la
-- temporada regular, igual que en Fase 3/4) — el guard de startMatch()/createRematch(), que lee
-- los participantes directo del pairing sin importar contexto, ya lo cubre.
--
-- Hallazgo adicional (gap latente de Fase 4, recién alcanzable ahora): create_fourth_place_
-- tiebreak_group tenía un SEGUNDO guard sin filtro de status — "no crear si ya existe el
-- bracket real de top4" miraba CUALQUIER fila group_type='bracket'/group_origin='round_robin_
-- topcut', incluida una vieja ya cerrada por close_active_round_robin_topcut_bracket_group
-- (0089). Si el recálculo de Fase 4 descubre una disputa nueva por el 4to puesto tras una
-- salida, este guard la bloquearía por error. Se angosta a status='active', mismo criterio que
-- todos los demás guards de este rediseño.

-- ── 1. create_fourth_place_tiebreak_group: angostar AMBOS guards a solo filas activas. Cuerpo
--    idéntico a 0081 salvo esas dos condiciones. ─────────────────────────────────────────────
create or replace function public.create_fourth_place_tiebreak_group(
  p_event_id uuid,
  p_matches jsonb,
  p_top3_ordered uuid[]
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_top_size integer;
  v_existing integer;
  v_group_id uuid;
  v_match jsonb;
  v_a_id uuid;
  v_b_id uuid;
  v_advances text;
  v_phase text;
  v_top3_distinct_count integer;
  v_top3_valid_count integer;
  v_top3_overlap_count integer;
  v_pid uuid;
  v_seed integer;
begin
  select competition_format, top_size into v_format, v_top_size
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin' or coalesce(v_top_size, 0) <> 4 then return false; end if;

  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'fourth_place' and status = 'active';

  if v_existing > 0 then return false; end if;

  -- El bracket real de top4 se crea recién cuando este desempate se resuelve (paso posterior);
  -- si ya existe uno ACTIVO, este desempate llegó tarde/duplicado. Uno viejo ya resuelto (0089,
  -- recálculo de Fase 4 que descubrió una disputa nueva) no debe bloquear esto.
  if exists (
    select 1 from public.event_tiebreak_groups
    where event_id = p_event_id and group_type = 'bracket' and group_origin = 'round_robin_topcut'
      and status = 'active'
  ) then
    return false;
  end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta, sin importar lo que el
  -- cliente haya calculado (mismo criterio que create_round_robin_top4_bracket). Un pairing con
  -- official_draw=true (BO2, 1-1) cuenta como resuelto, no como pendiente.
  if exists (
    select 1 from public.pairings
    where event_id = p_event_id and official_winner_participant_id is null and official_draw is not true
  ) then
    return false;
  end if;

  if p_matches is null or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) = 0 then
    return false;
  end if;

  if p_top3_ordered is null or array_length(p_top3_ordered, 1) <> 3 then
    return false;
  end if;

  select count(*) into v_top3_distinct_count from (select distinct unnest(p_top3_ordered)) u;
  if v_top3_distinct_count <> 3 then return false; end if;

  select count(*) into v_top3_valid_count
  from public.event_participants ep
  where ep.id = any(p_top3_ordered) and ep.event_id = p_event_id and ep.role = 'player';
  if v_top3_valid_count <> 3 then return false; end if;

  -- Ninguno de los 3 ya resueltos puede aparecer como participante concreto dentro de p_matches
  -- (si aparece, no está realmente resuelto — es parte del grupo en disputa).
  select count(*) into v_top3_overlap_count
  from unnest(p_top3_ordered) t3
  where exists (
    select 1 from jsonb_array_elements(p_matches) m
    where (m->'a'->>'participantId')::uuid = t3 or (m->'b'->>'participantId')::uuid = t3
  );
  if v_top3_overlap_count > 0 then return false; end if;

  insert into public.event_tiebreak_groups
    (event_id, round_number, group_type, group_origin, status, pending_bracket_matches)
  values (p_event_id, 1, 'fourth_place', 'round_robin_fourth_place', 'active', p_matches)
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_top3_ordered
  loop
    insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
    select v_group_id, v_pid, ep.user_id, v_seed
    from public.event_participants ep
    where ep.id = v_pid;
    v_seed := v_seed + 1;
  end loop;

  for v_match in select * from jsonb_array_elements(p_matches)
  loop
    if not (v_match ? 'a') or not (v_match ? 'b') then continue; end if;
    if not (v_match->'a' ? 'participantId') or not (v_match->'b' ? 'participantId') then
      -- Depende del ganador de otro partido: se arma más adelante (paso posterior), leyendo
      -- pending_bracket_matches cuando ese partido se resuelva.
      continue;
    end if;

    v_a_id := (v_match->'a'->>'participantId')::uuid;
    v_b_id := (v_match->'b'->>'participantId')::uuid;
    v_advances := v_match->>'winnerAdvancesTo';
    v_phase := case when v_advances = 'final_4th' then 'final' else 'semi' end;

    insert into public.event_tiebreak_bracket_matches
      (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group_id, v_phase, v_a_id, v_b_id);
  end loop;

  perform public.link_bracket_matches_to_pairings(v_group_id);

  return true;
end;
$$;

-- ── 2. close_active_round_robin_fourth_place_group: mismo patrón que
--    close_active_round_robin_first_place_group (0086) / close_active_round_robin_topcut_
--    bracket_group (0089) — ninguna pierna arrancó todavía, cierra en vez de borrar. ──────────
create or replace function public.close_active_round_robin_fourth_place_group(p_event_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_type = 'fourth_place'
    and group_origin = 'round_robin_fourth_place'
    and status = 'active';

  if v_group_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.pairing_id is not null
      and public.tiebreak_leg_has_started(bm.pairing_id)
  ) into v_any_started;

  if v_any_started then
    return false;
  end if;

  update public.event_tiebreak_groups
  set status = 'resolved', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$$;

-- ── 3. apply_walkover_for_tiebreak_leg: extender a group_origin='round_robin_fourth_place' —
--    misma función, no una nueva (la única diferencia real es v_wins_needed). ─────────────────
create or replace function public.apply_walkover_for_tiebreak_leg(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_group record;
  v_bm record;
  v_stayer_id uuid;
  v_wins_needed integer;
  v_stayer_wins integer;
  v_next_number integer;
  v_to_insert integer;
  v_i integer;
  v_match_id uuid;
  v_resolved_count integer := 0;
begin
  select event_id, left_event_at
  into v_event_id, v_left_event_at
  from public.event_participants
  where id = p_participant_id;

  if v_event_id is null or v_left_event_at is null then
    return 0;
  end if;

  for v_group in
    select g.id, g.round_number, g.group_origin
    from public.event_tiebreak_groups g
    where g.event_id = v_event_id
      and g.group_type = 'fourth_place'
      and g.group_origin in ('round_robin_first_place', 'round_robin_fourth_place')
      and g.status = 'active'
      and exists (
        select 1 from public.event_tiebreak_group_participants gp
        where gp.group_id = g.id and gp.participant_id = p_participant_id
      )
  loop
    for v_bm in
      select bm.id, bm.bracket_phase, bm.participant_a_id, bm.participant_b_id, bm.pairing_id
      from public.event_tiebreak_bracket_matches bm
      where bm.group_id = v_group.id
        and bm.winner_participant_id is null
        and (bm.participant_a_id = p_participant_id or bm.participant_b_id = p_participant_id)
        and bm.pairing_id is not null
      -- Sin filtro de "¿esta pierna ya tuvo actividad?": la fila ya existe (materializada, con
      -- ambos participantes concretos) — walkover directo sin importar si tiene 0 o N matches.
    loop
      v_stayer_id := case
        when v_bm.participant_a_id = p_participant_id then v_bm.participant_b_id
        else v_bm.participant_a_id
      end;

      -- round_robin_first_place: semi=BO1(1), final=BO3(2). round_robin_fourth_place: siempre
      -- BO1(1) en cualquier fase — mismo criterio que evaluate_tiebreak_group_after_match.
      v_wins_needed := case
        when v_group.group_origin = 'round_robin_first_place' and v_bm.bracket_phase = 'final' then 2
        else 1
      end;

      select count(*) into v_stayer_wins
      from public.matches
      where pairing_id = v_bm.pairing_id
        and match_type = 'tiebreak'
        and status = 'completed'
        and winner_participant_id = v_stayer_id;

      v_to_insert := v_wins_needed - v_stayer_wins;
      if v_to_insert <= 0 then
        continue;
      end if;

      select coalesce(max(match_number), 0) into v_next_number
      from public.matches
      where pairing_id = v_bm.pairing_id;

      for v_i in 1..v_to_insert loop
        insert into public.matches (pairing_id, match_number, match_type, status, tiebreak_round, started_at)
        values (v_bm.pairing_id, v_next_number + v_i, 'tiebreak', 'in_progress', v_group.round_number, now())
        returning id into v_match_id;

        -- UPDATE aparte (no seteamos 'completed' en el insert): el trigger de avance del
        -- bracket dispara en AFTER UPDATE, no AFTER INSERT.
        update public.matches
        set status = 'completed', winner_participant_id = v_stayer_id, is_walkover = true, ended_at = now()
        where id = v_match_id;
      end loop;

      v_resolved_count := v_resolved_count + 1;
    end loop;
  end loop;

  return v_resolved_count;
end;
$$;

-- ── 4. evaluate_tiebreak_group_after_match — gap del bye para round_robin_fourth_place, mismo
--    punto de chequeo que 0087/0090, hand-off distinto (4to seed + create_round_robin_top4_
--    bracket en vez de coronar campeón). Cuerpo idéntico a 0090 salvo el nuevo elsif. ─────────
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

  select id, group_type, round_number, group_origin into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  -- ROUND ROBIN: sin cambios respecto a 0090.
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

  -- BRACKET (semis+final+3°/4° del top4 real, o de la Copa Polémica): sin cambios respecto a 0090.
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
      v_w1_left boolean;
      v_w2_left boolean;
      v_l1_left boolean;
      v_l2_left boolean;
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

            -- Gap análogo al del bye (0087/0089): alguno de los 4 puede haberse ido entre que
            -- ganó/perdió su semi y este instante (la otra semi tardó más en resolverse). Solo
            -- aplica al top4 real (round_robin_topcut) — swiss_topcut queda intacto.
            if v_active_group.group_origin = 'round_robin_topcut' then
              select exists(select 1 from public.event_participants where id = v_semi_winners[1] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_winners[2] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_losers[1] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_losers[2] and left_event_at is not null)
              into v_w1_left, v_w2_left, v_l1_left, v_l2_left;

              -- Exactamente uno se fue de cada lado: walkover directo a favor del que se queda,
              -- reusando apply_walkover_for_topcut_bracket_leg (dispara este mismo trigger de
              -- nuevo sobre la fila recién creada). Si se fueron los dos de un mismo lado, esa
              -- fila queda pendiente para siempre — mismo criterio que "ambos se fueron".
              if v_w1_left and not v_w2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[1]);
              elsif v_w2_left and not v_w1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[2]);
              end if;

              if v_l1_left and not v_l2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[1]);
              elsif v_l2_left and not v_l1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[2]);
              end if;
            end if;
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

  -- FOURTH_PLACE: desempate por el 4to puesto de round_robin_bo1_top4 (0071/0072/0091) O
  -- desempate de 1er puesto de round_robin BO3 clásico (0075/0087/0090,
  -- group_origin='round_robin_first_place').
  if v_active_group.group_type = 'fourth_place' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_bm_a uuid;
      v_bm_b uuid;
      v_wins_a integer;
      v_wins_b integer;
      v_wins_needed integer;
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
      v_bye_left_a boolean;
      v_bye_left_b boolean;
    begin
      -- Ubicar la fila del bracket que matchea este pairing y sigue sin ganador.
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

      if v_active_group.group_origin = 'round_robin_first_place' then
        -- Victorias necesarias según la fase: semi = BO1 (1), final = BO3 (2) — la final es la
        -- que corona campeón, se juega con la misma exigencia que tenía antes de esta migración.
        v_wins_needed := case when v_bm_phase = 'final' then 2 else 1 end;

        select count(*) filter (where m.winner_participant_id = v_bm_a),
               count(*) filter (where m.winner_participant_id = v_bm_b)
        into v_wins_a, v_wins_b
        from public.matches m
        where m.pairing_id = new.pairing_id
          and m.match_type = 'tiebreak'
          and m.status = 'completed';

        if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
          -- Todavía falta la vuelta de la final (BO3): no resolver esta llave todavía.
          return new;
        end if;

        v_winner_participant_id := case when v_wins_a >= v_wins_needed then v_bm_a else v_bm_b end;
      else
        -- round_robin_fourth_place (comportamiento original, 0072): siempre BO1, la primera
        -- partida decide.
        v_winner_participant_id := new.winner_participant_id;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      -- Ubicar, en pending_bracket_matches (estructura íntegra guardada al crear el grupo), el
      -- índice del partido recién resuelto y su winnerAdvancesTo.
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
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';

        if v_active_group.group_origin = 'round_robin_first_place' then
          -- Acá no hay próxima fase: el ganador de la final ES el campeón del evento.
          select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;
          return new;
        end if;

        -- round_robin_fourth_place (comportamiento original, 0072): arma el top4 real.
        select array_agg(participant_id order by seed) into v_top3
        from public.event_tiebreak_group_participants
        where group_id = v_active_group.id;

        if v_top3 is not null and array_length(v_top3, 1) = 3 then
          v_top4 := v_top3 || v_winner_participant_id;
          perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
        end if;

        return new;
      end if;

      -- Si no, el ganador avanza al partido con índice v_advances (0-based). Revisar si, tras la
      -- sustitución de arriba, ese partido ya tiene AMBOS lados concretos.
      v_next_index := v_advances::integer;

      select ord.elem into v_next_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id and ord.idx - 1 = v_next_index;

      if v_next_match is null
        or not (v_next_match->'a' ? 'participantId')
        or not (v_next_match->'b' ? 'participantId') then
        return new;
      end if;

      v_next_a_id := (v_next_match->'a'->>'participantId')::uuid;
      v_next_b_id := (v_next_match->'b'->>'participantId')::uuid;
      v_next_phase := case when v_next_match->>'winnerAdvancesTo' = 'final_4th' then 'final' else 'semi' end;

      -- Gap del bye (0087/0091): si la próxima fase es la FINAL, uno de los dos lados puede ser
      -- el jugador con bye (concreto desde la creación del grupo, nunca jugó nada él mismo) o el
      -- ganador de una semi que se fue antes de que la otra semi resolviera. Si ese lado ya
      -- tiene left_event_at, esa final nunca va a poder jugarse.
      if v_active_group.group_origin = 'round_robin_first_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          -- Ambos se fueron: no hay ganador real posible. Mismo criterio "ambos se fueron
          -- bloquea para siempre" que compute_event_champion (0083) — no se corona a nadie ni
          -- se crea la final.
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
          -- 0090: crear la fila 'final' igual, con el resultado ya resuelto directamente
          -- (winner_participant_id = el ganador de la semi, resolved_at = now(), sin match
          -- asociado — no es algo que se "juega", es un registro directo del resultado).
          -- Necesaria para que podiumFirstPlaceTiebreakResolvedMode pueda asignar el 2do
          -- puesto (el perdedor de esta fila) a quien se fue, en vez de dejarlo sin puesto.
          insert into public.event_tiebreak_bracket_matches
            (group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id, resolved_at)
          values (v_active_group.id, 'final', v_next_a_id, v_next_b_id, v_winner_participant_id, now());

          perform public.link_bracket_matches_to_pairings(v_active_group.id);

          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select user_id into v_leader_user_id from public.event_participants
          where id = v_winner_participant_id;

          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;

          return new;
        end if;
      elsif v_active_group.group_origin = 'round_robin_fourth_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          -- Ambos se fueron: no hay 4to seed real posible entre estos dos. Mismo criterio
          -- "ambos se fueron bloquea para siempre" — no se crea la fila ni se arma el top4.
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
          -- 0091: mismo fix que 0090, pero acá el ganador no corona campeón — ES el 4to seed.
          -- Crear la fila 'final' ya resuelta (sin match asociado) para que la tabla/podio vean
          -- quién quedó eliminado, cerrar el grupo, y alimentar create_round_robin_top4_bracket
          -- con [top3, ganador] — mismo hand-off que el camino normal (0072, más arriba).
          insert into public.event_tiebreak_bracket_matches
            (group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id, resolved_at)
          values (v_active_group.id, 'final', v_next_a_id, v_next_b_id, v_winner_participant_id, now());

          perform public.link_bracket_matches_to_pairings(v_active_group.id);

          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select array_agg(participant_id order by seed) into v_top3
          from public.event_tiebreak_group_participants
          where group_id = v_active_group.id;

          if v_top3 is not null and array_length(v_top3, 1) = 3 then
            v_top4 := v_top3 || v_winner_participant_id;
            perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
          end if;

          return new;
        end if;
      end if;

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
