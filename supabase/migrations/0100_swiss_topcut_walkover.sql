-- 0100_swiss_topcut_walkover.sql
-- Fase 6.8: walkover del bracket real de topcut en Suizo (group_origin='swiss_topcut'), mismo
-- patrón que la Fase 4 de round_robin (0089/0092).
--
-- Diseño acordado: el mecanismo central de avance del bracket (evaluate_tiebreak_group_after_match,
-- rama group_type='bracket') YA es genérico entre orígenes — nunca miró group_origin salvo en el
-- gap-fix puntual (alguien se va entre que resuelve su semi y que la OTRA semi crea 'final'/
-- 'third_place'), gateado explícitamente a 'round_robin_topcut' hasta ahora. topcut_wins_needed
-- (0039) tampoco mira competition_format, ya sirve igual para Suizo.
--
-- Generalizamos (no duplicamos) las funciones de walkover del bracket, mismo criterio que 6.2/6.3:
--   - close_active_round_robin_topcut_bracket_group -> RENOMBRADA a close_active_topcut_bracket_group
--     + parámetro p_group_origin (cuerpo ya genérico salvo el literal en el WHERE).
--   - apply_walkover_for_topcut_bracket_leg: mismo nombre (ya neutral), + parámetro p_group_origin.
--   - evaluate_tiebreak_group_after_match: el gate del gap-fix pasa a incluir ambos orígenes.
--
-- create_round_robin_top4_bracket NO se toca (ya tiene el guard correcto desde 0089) ni se
-- fusiona con create_swiss_top4_bracket (mismo criterio de 6.6: el chequeo de "fase regular
-- resuelta" es estructuralmente distinto entre formatos). Sí se le corrige a
-- create_swiss_top4_bracket un bug propio encontrado ahora: su guard de "¿ya existe?" no
-- filtraba por status, así que cerrar (soft-close) el bracket viejo para recalcular lo dejaba
-- viendo esa fila vieja y rechazando crear el nuevo — mismo fix que 0089 le aplicó en su momento
-- a create_round_robin_top4_bracket.
--
-- "Orden de mérito" del corrimiento en Suizo: sin cambios en computeAndCreateSwissTop4Bracket
-- (TS, 6.6) — ya lee swiss_points/omw/gw/ogw persistidas (hechos históricos propios de cada
-- jugador, no afectados por la salida de un tercero) y ya excluye left_event_at, así que
-- volver a llamarla tras cerrar el bracket viejo YA trae al siguiente en mérito a la seed
-- vacante — sin necesidad de ningún parámetro nuevo ni de recalcular nada distinto. El
-- corrimiento secuencial con más de una salida cae gratis: cada "Me voy" es una llamada
-- independiente que recalcula sobre el roster ya actualizado por la salida anterior.

-- ===========================================================================
-- 1. close_active_topcut_bracket_group: rename + generalización de
--    close_active_round_robin_topcut_bracket_group (cuerpo idéntico al vigente en 0092, con
--    group_origin parametrizado en vez de hardcodeado a 'round_robin_topcut').
-- ===========================================================================
create or replace function public.close_active_topcut_bracket_group(
  p_event_id uuid,
  p_group_origin text
)
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
    and group_origin = p_group_origin
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
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$$;

drop function if exists public.close_active_round_robin_topcut_bracket_group(uuid);

-- ===========================================================================
-- 2. apply_walkover_for_topcut_bracket_leg: mismo nombre, + parámetro p_group_origin (cuerpo
--    idéntico al vigente en 0089, salvo el WHERE parametrizado). Se dropea la firma vieja de 1
--    argumento — si no, Postgres las deja convivir como sobrecarga en vez de reemplazarla.
-- ===========================================================================
create or replace function public.apply_walkover_for_topcut_bracket_leg(
  p_participant_id uuid,
  p_group_origin text
)
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
      and g.group_origin = p_group_origin
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
        -- bracket (evaluate_tiebreak_group_after_match, rama 'bracket') dispara en AFTER UPDATE,
        -- no AFTER INSERT.
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

drop function if exists public.apply_walkover_for_topcut_bracket_leg(uuid);

-- ===========================================================================
-- 3. create_swiss_top4_bracket: angostar el guard de "ya existe" a solo filas ACTIVAS (mismo
--    bug, mismo fix, que 0089 le aplicó a create_round_robin_top4_bracket en su momento) —
--    necesario para que el cierre (soft-close, status='superseded') del bracket viejo permita
--    crear el nuevo. Cuerpo idéntico al vigente en 0098 salvo ese guard.
-- ===========================================================================
create or replace function public.create_swiss_top4_bracket(
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

  if v_format <> 'swiss' or coalesce(v_top_size, 0) <> 4 then return false; end if;

  -- Idempotente: no crear un segundo bracket para el mismo evento. Solo filas ACTIVAS bloquean
  -- (un bracket viejo cerrado por recálculo de walkover, status='superseded' o 'resolved', no
  -- debe impedir crear el nuevo).
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
  where ep.id = any (p_top4_ordered)
    and ep.event_id = p_event_id
    and ep.role = 'player';

  if v_valid_count <> 4 then return false; end if;

  -- Defensa en profundidad: la fase regular suiza debe estar 100% resuelta. Solo cuentan los
  -- pairings CON swiss_round asignado (mismo criterio que 0098).
  select count(*) into v_pending
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id is null
    and official_draw = false;

  if v_pending > 0 then return false; end if;

  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, p_top4_ordered);

  update public.event_tiebreak_groups
  set group_origin = 'swiss_topcut'
  where id = v_new_group_id;

  return true;
end;
$$;

-- ===========================================================================
-- 4. evaluate_tiebreak_group_after_match: extender el gate del gap-fix (alguien se va entre
--    que resuelve su semi y que la OTRA semi crea 'final'/'third_place') a ambos orígenes.
--    Cuerpo idéntico al vigente en 0091 salvo ese gate y las 4 llamadas a
--    apply_walkover_for_topcut_bracket_leg, que ahora pasan group_origin explícito.
-- ===========================================================================
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

  -- ROUND ROBIN: sin cambios respecto a 0091.
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

  -- BRACKET (semis+final+3°/4° del top4 real de round_robin O de Suizo, o de la Copa Polémica).
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
            -- ganó/perdió su semi y este instante (la otra semi tardó más en resolverse).
            -- Fase 6.8: extendido a swiss_topcut, mismo mecanismo genérico de bracket.
            if v_active_group.group_origin in ('round_robin_topcut', 'swiss_topcut') then
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
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[1], v_active_group.group_origin);
              elsif v_w2_left and not v_w1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[2], v_active_group.group_origin);
              end if;

              if v_l1_left and not v_l2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[1], v_active_group.group_origin);
              elsif v_l2_left and not v_l1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[2], v_active_group.group_origin);
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
  -- group_origin='round_robin_first_place'). Sin cambios — Suizo no tiene equivalente (el corte
  -- se resuelve matemáticamente, sin disputa en vivo, decisión ya confirmada).
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
        v_wins_needed := case when v_bm_phase = 'final' then 2 else 1 end;

        select count(*) filter (where m.winner_participant_id = v_bm_a),
               count(*) filter (where m.winner_participant_id = v_bm_b)
        into v_wins_a, v_wins_b
        from public.matches m
        where m.pairing_id = new.pairing_id
          and m.match_type = 'tiebreak'
          and m.status = 'completed';

        if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
          return new;
        end if;

        v_winner_participant_id := case when v_wins_a >= v_wins_needed then v_bm_a else v_bm_b end;
      else
        v_winner_participant_id := new.winner_participant_id;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

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
          select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;
          return new;
        end if;

        select array_agg(participant_id order by seed) into v_top3
        from public.event_tiebreak_group_participants
        where group_id = v_active_group.id;

        if v_top3 is not null and array_length(v_top3, 1) = 3 then
          v_top4 := v_top3 || v_winner_participant_id;
          perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
        end if;

        return new;
      end if;

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

      if v_active_group.group_origin = 'round_robin_first_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
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
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
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
