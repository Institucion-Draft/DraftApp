-- 0089_top4_bracket_walkover.sql
-- Fase 4 del rediseño de "Me voy": walkover + recálculo por abandono en el bracket REAL de
-- top4 (round_robin_bo1_top4: competition_format='round_robin', top_size=4,
-- group_type='bracket', group_origin='round_robin_topcut', ver 0076/0081).
--
-- Dos regímenes, igual que Fase 3 (0084/0086/0088), pero acá el "grupo empatado" no existe
-- como tal: las 4 seeds ya están fijas por la tabla de la fase regular.
--
--   1. NINGUNA semi del bracket completo tiene actividad todavía (ni siquiera arrancó una
--      partida): se puede recalcular el top4 completo excluyendo a quien se fue — el 5° (o el
--      que corresponda en cascada) sube a ocupar la seed vacante. Esto es consecuencia directa
--      de recomputar computeFinalStandingsWithTiebreakSplit con el roster actual (excluye
--      left_event_at de standings, pero NUNCA de pairingResults — el head-to-head/calidad de
--      rivales de terceros no se recalcula, confirmado A2/B) y volver a tomar el top4 — no hace
--      falta ningún corrimiento manual explícito.
--      Mecanismo: close_active_round_robin_topcut_bracket_group (soft-close, preserva
--      historial) + create_round_robin_top4_bracket de nuevo con el top4 recalculado
--      (computeAndCreateTop4Bracket, cliente).
--   2. Alguna semi ya tiene actividad real: ya no se puede recalcular (perdería historia real
--      de partidas jugadas). Si la persona que se va tiene una fila de bracket (semi, final o
--      third_place) SIN ganador vinculada — con o sin actividad previa en ESA fila puntual,
--      mismo criterio ya validado en 0088 — walkover directo a favor del rival.
--
-- Los puestos 1-4 nunca se le asignan a quien se fue: el walkover reusa el trigger de avance ya
-- existente (evaluate_tiebreak_group_after_match, rama 'bracket', sin cambios) insertando el
-- match como 'in_progress' + UPDATE a 'completed' con is_walkover=true — ese trigger ya corona
-- campeón (final) y resuelve 3°/4° (third_place) exactamente igual que con partidas reales, así
-- que podiumBracketFinalMode (podium.ts) no necesita ningún cambio: lee winner_participant_id
-- de las filas de bracket sin saber ni importarle si fue por walkover o jugado.

-- ── 1. create_round_robin_top4_bracket: angostar el guard de "ya existe" a solo filas ACTIVAS
--    (mismo cambio que 0086 hizo para create_round_robin_first_place_tiebreak_group) — permite
--    que convivan un grupo 'bracket' viejo ya resuelto (por el recálculo del punto 1) con el
--    nuevo, sin bloquear la recreación. Cuerpo idéntico a 0081 salvo esa condición. ────────────
create or replace function public.create_round_robin_top4_bracket(
  p_event_id uuid,
  p_top4_ordered uuid[]
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_top_size integer;
  v_existing integer;
  v_pending integer;
  v_valid_count integer;
  v_distinct_count integer;
  v_new_group_id uuid;
begin
  select competition_format, top_size into v_format, v_top_size
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin' or coalesce(v_top_size, 0) <> 4 then return false; end if;

  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'bracket' and status = 'active';

  if v_existing > 0 then return false; end if;

  if p_top4_ordered is null or array_length(p_top4_ordered, 1) <> 4 then
    return false;
  end if;

  select count(*) into v_distinct_count
  from (select distinct unnest(p_top4_ordered)) u;

  if v_distinct_count <> 4 then return false; end if;

  select count(*) into v_valid_count
  from public.event_participants ep
  where ep.id = any(p_top4_ordered)
    and ep.event_id = p_event_id
    and ep.role = 'player';

  if v_valid_count <> 4 then return false; end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta, sin importar lo
  -- que el cliente haya calculado. Un pairing con official_draw=true (BO2, 1-1) cuenta como
  -- resuelto, no como pendiente.
  select count(*) into v_pending
  from public.pairings
  where event_id = p_event_id
    and official_winner_participant_id is null
    and official_draw is not true;

  if v_pending > 0 then return false; end if;

  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, p_top4_ordered);

  update public.event_tiebreak_groups
  set group_origin = 'round_robin_topcut'
  where id = v_new_group_id;

  return true;
end;
$$;

-- ── 2. close_active_round_robin_topcut_bracket_group: mismo criterio y misma guarda defensiva
--    que close_active_round_robin_first_place_group (0086) — ninguna semi arrancó todavía —
--    pero para group_type='bracket'/group_origin='round_robin_topcut'. Cierra en vez de borrar:
--    preserva event_tiebreak_group_participants/event_tiebreak_bracket_matches como evidencia
--    histórica (útil si en el futuro se quiere mostrar qué seeds tenía el bracket viejo). ──────
create or replace function public.close_active_round_robin_topcut_bracket_group(p_event_id uuid)
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
    and group_type = 'bracket'
    and group_origin = 'round_robin_topcut'
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

-- ── 3. apply_walkover_for_topcut_bracket_leg: walkover puntual de la(s) fila(s) de bracket
--    PENDIENTES (semi/final/third_place, sin ganador) de un participante recién marcado como
--    left_event_at, dentro de grupos 'bracket'/'round_robin_topcut' activos — sin exigir que
--    ESA fila puntual ya haya tenido actividad (mismo criterio ya validado en 0088: la fila ya
--    existe materializada con ambos participantes concretos, walkover directo sin importar si
--    tiene 0 o N matches previos). El caller (markAsLeft) es quien decide, a nivel de GRUPO, si
--    corresponde este camino (alguna semi ya tiene actividad) o el recálculo completo (punto 1,
--    ninguna semi arrancó) — acá no se vuelve a chequear eso.
--
--    topcut_wins_needed(event_id, bracket_phase) (0039) reemplaza el hardcode semi=1/final=2
--    de 0088 (esa función es específica de round_robin_first_place, siempre BO3 en la final) —
--    acá el formato del top4 puede ser bo1/sf_bo1_f_bo3/bo3, y sirve igual para third_place
--    (mismas victorias necesarias que su fase hermana según el formato).
create or replace function public.apply_walkover_for_topcut_bracket_leg(p_participant_id uuid)
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
    select g.id, g.round_number
    from public.event_tiebreak_groups g
    where g.event_id = v_event_id
      and g.group_type = 'bracket'
      and g.group_origin = 'round_robin_topcut'
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
      -- Sin filtro de "¿esta fila ya arrancó?": ya existe materializada — walkover directo.
    loop
      v_stayer_id := case
        when v_bm.participant_a_id = p_participant_id then v_bm.participant_b_id
        else v_bm.participant_a_id
      end;

      v_wins_needed := public.topcut_wins_needed(v_event_id, v_bm.bracket_phase);

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
        -- bracket (evaluate_tiebreak_group_after_match, rama 'bracket', sin cambios) dispara en
        -- AFTER UPDATE, no AFTER INSERT.
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

-- ── 4. evaluate_tiebreak_group_after_match — gap análogo al del bye (0087), en el OTRO punto
--    donde el bracket 'bracket' materializa filas nuevas: cuando ambas semis resuelven y se
--    crean 'final' (semi_winners) y 'third_place' (semi_losers) recién ahí (0026/0075) — si
--    alguno de esos 4 participantes ya tiene left_event_at en ese instante (dejó de jugar su
--    semi y se fue ANTES de que la fila que lo necesita llegue a crearse), esa fila queda igual
--    de imposible de jugar que la final fantasma de round_robin_first_place.
--
--    A diferencia de 0087 (que directamente corona sin crear la fila, porque ahí no hace falta
--    ninguna fila para exponer el resultado — el campeón sale de un campo dedicado en
--    draft_events), acá SÍ hace falta la fila: podiumBracketFinalMode (podium.ts) lee 2do
--    puesto del winner de 'final' y 3er puesto del winner de 'third_place' — sin esas filas
--    resueltas, esos puestos quedarían vacíos para siempre. Por eso el fix acá es crear la fila
--    igual (necesaria para el podio) y resolverla YA por walkover si corresponde, reusando
--    apply_walkover_for_topcut_bracket_leg (mismo mecanismo matches in_progress->completed,
--    is_walkover=true, que dispara este mismo trigger recursivamente sobre la fila nueva).
--    "Ambos lados de una fila se fueron" no se toca — mismo criterio "bloquea para siempre" que
--    0083/0087: no se le da walkover a nadie en esa fila, queda pendiente.
--
--    Solo aplica a group_origin='round_robin_topcut' (el top4 real) — swiss_topcut (grupos
--    'bracket' del top cut de swiss) queda intacto, fuera de alcance de este rediseño.
--
--    Cuerpo idéntico a 0087 salvo el bloque nuevo, agregado justo después de crear 'final' y
--    'third_place' y linkearlas a sus pairings — antes de eso las filas no tienen pairing_id
--    todavía, y apply_walkover_for_topcut_bracket_leg lo exige.
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

  -- ROUND ROBIN: sin cambios respecto a 0087.
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

  -- BRACKET (semis+final+3°/4° del top4 real, o de la Copa Polémica).
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

  -- FOURTH_PLACE: desempate por el 4to puesto de round_robin_bo1_top4 (0071/0072) O desempate
  -- de 1er puesto de round_robin BO3 clásico (0075/0087, group_origin='round_robin_first_place').
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

      -- Gap del bye (0087): si la próxima fase es la FINAL de un round_robin_first_place, uno de
      -- los dos lados puede ser el jugador con bye (concreto desde la creación del grupo, nunca
      -- jugó nada él mismo). Si ese lado (o el que recién avanzó, aunque en la práctica no puede
      -- haberse ido justo al ganar) ya tiene left_event_at, esa final nunca va a poder jugarse:
      -- no crear la fila, resolver directo.
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
          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select user_id into v_leader_user_id from public.event_participants
          where id = (case when v_bye_left_a then v_next_b_id else v_next_a_id end);

          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;

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
