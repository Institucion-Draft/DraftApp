-- 0094_swiss_unify_points_tiebreak_functions.sql
-- Fase 6.2: fusiona las funciones de puntaje/desempate duplicadas entre swiss (BO3)
-- y swiss_bo2 en versiones únicas parametrizadas por match_format:
--   swiss_points_of        <- swiss_points_of + swiss_bo2_points_of
--   swiss_opponents        <- swiss_opponents + swiss_bo2_opponents
--   swiss_match_winrate    <- swiss_match_winrate + swiss_bo2_match_winrate
--   recalc_swiss_tiebreakers <- recalc_swiss_tiebreakers + recalc_swiss_bo2_tiebreakers
--
-- competition_format sigue como está (swiss vs swiss_bo2) — eso es Fase 6.4. Acá las
-- funciones unificadas resuelven internamente el match_format efectivo vía el shim
-- swiss_effective_match_format (temporal: hoy match_format no se setea para eventos
-- suizos, así que se deriva de competition_format; Fase 6.4 lo retira y lee
-- match_format directamente).
--
-- Comportamiento preservado exactamente:
--   - Puntos: victoria = 3, empate = 1 (solo puede ocurrir en bo2 — official_draw
--     nunca es true en bo3/bo1), bye = 3 en bo3/bo1, bye = 2 en bo2 (ver 0047).
--   - swiss_opponents: incluye pairings resueltos con ganador O con empate — en
--     bo3/bo1 el empate nunca ocurre, así que el filtro se reduce exactamente al
--     comportamiento original (solo ganador).
--   - swiss_match_winrate: bo2 usa "puntos obtenidos / puntos máximos posibles"
--     (max = (resueltos+byes)*3, igual que swiss_bo2_match_winrate); bo3/bo1 usa el
--     ratio simple ganados/jugados de siempre (no hay empate posible ahí).
--
-- VERIFICACIÓN AUTOMÁTICA incluida al final: toma snapshot de swiss_points/omw/gw/ogw
-- de todo participante de un evento swiss/swiss_bo2 real con rondas suizas generadas
-- (calculados con las funciones VIEJAS, vigentes hasta este punto), vuelve a correr
-- recalc_swiss_tiebreakers (ya unificada) sobre esos mismos eventos, y compara. Si un
-- solo valor difiere, aborta la migración entera (transacción implícita del archivo)
-- sin aplicar nada. Si la base de destino no tiene eventos swiss/swiss_bo2 reales con
-- rondas generadas, esta verificación es un no-op — probar contra staging/prod real.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES" (funciones viejas todavía vigentes en este punto)
-- ===========================================================================
create temporary table _swiss_verify_before (
  participant_id uuid primary key,
  event_id uuid not null,
  points integer,
  omw numeric,
  gw numeric,
  ogw numeric
) on commit drop;

insert into _swiss_verify_before (participant_id, event_id, points, omw, gw, ogw)
select ep.id, ep.event_id, ep.swiss_points, ep.swiss_omw, ep.swiss_gw, ep.swiss_ogw
from public.event_participants ep
join public.draft_events de on de.id = ep.event_id
where de.competition_format in ('swiss', 'swiss_bo2')
  and ep.role = 'player'
  and exists (
    select 1 from public.pairings p
    where p.event_id = ep.event_id and p.swiss_round is not null
  );

-- ===========================================================================
-- 1. SHIM TEMPORAL: match_format efectivo de un evento suizo
-- ===========================================================================
create or replace function public.swiss_effective_match_format(p_event_id uuid)
returns text
language sql
stable
as $$
  select case when de.competition_format = 'swiss_bo2' then 'bo2' else 'bo3' end
  from public.draft_events de
  where de.id = p_event_id;
$$;

-- ===========================================================================
-- 2. swiss_points_of UNIFICADA
-- ===========================================================================
create or replace function public.swiss_points_of(p_event_id uuid, p_participant_id uuid)
returns integer
language plpgsql
stable
as $$
declare
  v_wins integer;
  v_draws integer;
  v_byes integer;
  v_bye_points integer;
begin
  select count(*) into v_wins
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id = p_participant_id;

  select count(*) into v_draws
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_draw = true
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  select coalesce(array_length(bye_rounds, 1), 0) into v_byes
  from public.event_participants
  where id = p_participant_id;

  v_bye_points := case when public.swiss_effective_match_format(p_event_id) = 'bo2' then 2 else 3 end;

  return v_wins * 3 + v_draws * 1 + v_byes * v_bye_points;
end;
$$;

-- ===========================================================================
-- 3. swiss_opponents UNIFICADA
-- ===========================================================================
create or replace function public.swiss_opponents(p_event_id uuid, p_participant_id uuid)
returns uuid[]
language plpgsql
stable
as $$
declare
  v_opponents uuid[];
begin
  select array_agg(
    case when participant_a_id = p_participant_id then participant_b_id
         else participant_a_id end
  ) into v_opponents
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and (official_winner_participant_id is not null or official_draw = true)
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  return coalesce(v_opponents, '{}');
end;
$$;

-- ===========================================================================
-- 4. swiss_match_winrate UNIFICADA
-- ===========================================================================
create or replace function public.swiss_match_winrate(p_event_id uuid, p_participant_id uuid)
returns numeric
language plpgsql
stable
as $$
declare
  v_played integer;
  v_won integer;
  v_resolved integer;
  v_byes integer;
  v_max_points integer;
  v_points integer;
begin
  if public.swiss_effective_match_format(p_event_id) = 'bo2' then
    select count(*) into v_resolved
    from public.pairings
    where event_id = p_event_id
      and swiss_round is not null
      and (official_winner_participant_id is not null or official_draw = true)
      and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

    select coalesce(array_length(bye_rounds, 1), 0) into v_byes
    from public.event_participants
    where id = p_participant_id;

    v_max_points := (v_resolved + v_byes) * 3;
    if v_max_points = 0 then return 0; end if;

    v_points := public.swiss_points_of(p_event_id, p_participant_id);
    return v_points::numeric / v_max_points;
  end if;

  -- bo3/bo1: ratio simple ganados/jugados. El bye cuenta para los puntos pero NO
  -- para este winrate (no es una victoria "real" sobre un oponente).
  select count(*) into v_played
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id is not null
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  select count(*) into v_won
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id = p_participant_id;

  if v_played = 0 then return 0; end if;
  return v_won::numeric / v_played;
end;
$$;

-- ===========================================================================
-- 5. recalc_swiss_tiebreakers UNIFICADA
-- ===========================================================================
create or replace function public.recalc_swiss_tiebreakers(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_participant record;
  v_opponents uuid[];
  v_opp uuid;
  v_omw_sum numeric;
  v_omw_count integer;
  v_ogw_sum numeric;
  v_ogw_count integer;
  v_opp_mw numeric;
  v_opp_gw numeric;
  v_games_played integer;
  v_gw numeric;
begin
  for v_participant in
    select id from public.event_participants
    where event_id = p_event_id and role = 'player'
  loop
    v_opponents := public.swiss_opponents(p_event_id, v_participant.id);
    v_omw_sum := 0; v_omw_count := 0;
    v_ogw_sum := 0; v_ogw_count := 0;

    foreach v_opp in array v_opponents loop
      v_opp_mw := public.swiss_match_winrate(p_event_id, v_opp);
      if v_opp_mw < 0.33 then v_opp_mw := 0.33; end if;
      v_omw_sum := v_omw_sum + v_opp_mw;
      v_omw_count := v_omw_count + 1;

      v_opp_gw := public.swiss_game_winrate(p_event_id, v_opp);
      if v_opp_gw < 0.33 then v_opp_gw := 0.33; end if;
      v_ogw_sum := v_ogw_sum + v_opp_gw;
      v_ogw_count := v_ogw_count + 1;
    end loop;

    -- Game win rate propio: null si no jugó partidas individuales.
    select count(*) into v_games_played
    from public.matches m
    join public.pairings p on p.id = m.pairing_id
    where p.event_id = p_event_id
      and p.swiss_round is not null
      and m.match_type = 'draft'
      and m.status = 'completed'
      and (p.participant_a_id = v_participant.id or p.participant_b_id = v_participant.id);

    if v_games_played = 0 then
      v_gw := null;
    else
      v_gw := public.swiss_game_winrate(p_event_id, v_participant.id);
    end if;

    update public.event_participants
    set swiss_points = public.swiss_points_of(p_event_id, v_participant.id),
        swiss_gw = v_gw,
        swiss_omw = case when v_omw_count > 0 then v_omw_sum / v_omw_count else null end,
        swiss_ogw = case when v_ogw_count > 0 then v_ogw_sum / v_ogw_count else null end
    where id = v_participant.id;
  end loop;
end;
$$;

-- ===========================================================================
-- 6. Callers de swiss_bo2_points_of / recalc_swiss_bo2_tiebreakers: redirigir a
--    las funciones unificadas. OJO orden de argumentos: swiss_bo2_points_of usaba
--    (participant_id, event_id); swiss_points_of usa (event_id, participant_id) —
--    se invierten los argumentos en cada call site de abajo.
-- ===========================================================================
create or replace function public.generate_swiss_bo2_round(p_event_id uuid, p_round integer)
returns void
language plpgsql
security definer
as $$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_p1 uuid;
  v_p2 uuid;
  v_p_a uuid;
  v_p_b uuid;
  v_already_played boolean;
begin
  -- Asegurar que todos los pairings existan.
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and coalesce(array_length(ep.bye_rounds, 1), 0) = 0
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  declare
    i integer := 1;
    n integer := coalesce(array_length(v_remaining_participants, 1), 0);
  begin
    while i <= n - 1 loop
      v_p1 := v_remaining_participants[i];
      declare j integer := i + 1;
      begin
        while j <= n loop
          v_p2 := v_remaining_participants[j];
          select exists (
            select 1 from public.pairings
            where event_id = p_event_id
              and swiss_round is not null
              and ((participant_a_id = v_p1 and participant_b_id = v_p2)
                or (participant_a_id = v_p2 and participant_b_id = v_p1))
          ) into v_already_played;
          if not v_already_played then exit; end if;
          j := j + 1;
        end loop;

        if j > n then
          v_p2 := v_remaining_participants[i + 1];
          j := i + 1;
        end if;

        if v_p1 < v_p2 then v_p_a := v_p1; v_p_b := v_p2;
        else v_p_a := v_p2; v_p_b := v_p1;
        end if;

        update public.pairings
        set swiss_round = p_round
        where event_id = p_event_id
          and participant_a_id = v_p_a
          and participant_b_id = v_p_b;

        v_remaining_participants := v_remaining_participants[1:j-1] || v_remaining_participants[j+1:n];
        n := n - 1;
      end;
      i := i + 1;
    end loop;
  end;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;

  -- Recalcular tiebreakers (ahora vía la función unificada).
  perform public.recalc_swiss_tiebreakers(p_event_id);
end;
$$;

create or replace function public.maybe_advance_swiss_bo2_round()
returns trigger
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_current_round integer;
  v_total_rounds integer;
  v_pending_pairings integer;
  v_event_format text;
  v_top4 uuid[];
  v_new_group_id uuid;
begin
  -- Solo nos interesa cuando el pairing quedó resuelto (ganador o empate).
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  -- swiss_rounds_manual sobreescribe el cálculo automático.
  select competition_format,
         current_swiss_round,
         coalesce(swiss_rounds_manual, swiss_rounds_total)
  into v_event_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_event_format <> 'swiss_bo2' then return new; end if;
  if v_current_round is null then return new; end if;

  -- Contar pairings pendientes (sin ganador ni empate) de la ronda actual.
  select count(*) into v_pending_pairings
  from public.pairings
  where event_id = v_event_id
    and swiss_round = v_current_round
    and official_winner_participant_id is null
    and official_draw = false;

  if v_pending_pairings > 0 then return new; end if;

  -- Toda la ronda resuelta.
  if v_current_round < v_total_rounds then
    perform public.generate_swiss_bo2_round(v_event_id, v_current_round + 1);
    return new;
  end if;

  -- Era la última: generar bracket de top 4. Mismos criterios que la tabla de
  -- posiciones (Pts > OMW > GW > OGW) más el desempate final por user_id (0050).
  select array_agg(ep.id order by public.swiss_points_of(v_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc,
                                     coalesce(ep.swiss_gw, 0) desc,
                                     coalesce(ep.swiss_ogw, 0) desc,
                                     ep.user_id asc)
  into v_top4
  from public.event_participants ep
  where ep.event_id = v_event_id and ep.role = 'player' and ep.left_event_at is null;

  if v_top4 is not null and array_length(v_top4, 1) >= 4 then
    v_top4 := v_top4[1:4];
    v_new_group_id := public.create_bracket_tiebreak_group(v_event_id, v_top4);
    update public.event_tiebreak_groups
    set group_origin = 'swiss_topcut'
    where id = v_new_group_id;
  end if;

  return new;
end;
$$;

create or replace function public.on_swiss_bo2_pairing_recalc_tiebreakers()
returns trigger
language plpgsql
security definer
as $$
declare
  v_format text;
begin
  if new.swiss_round is null then return new; end if;
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;

  select competition_format into v_format
  from public.draft_events where id = new.event_id;
  if v_format <> 'swiss_bo2' then return new; end if;

  perform public.recalc_swiss_tiebreakers(new.event_id);
  return new;
end;
$$;

-- ===========================================================================
-- 7. Retirar las funciones bo2-específicas ya fusionadas arriba
-- ===========================================================================
drop function if exists public.swiss_bo2_points_of(uuid, uuid);
drop function if exists public.swiss_bo2_opponents(uuid, uuid);
drop function if exists public.swiss_bo2_match_winrate(uuid, uuid);
drop function if exists public.recalc_swiss_bo2_tiebreakers(uuid);

-- ===========================================================================
-- 8. VERIFICACIÓN AUTOMÁTICA: recalcular con las funciones unificadas y comparar
--    contra el snapshot "antes". Aborta toda la migración si algo difiere.
-- ===========================================================================
do $$
declare
  v_event_id uuid;
begin
  for v_event_id in select distinct event_id from _swiss_verify_before loop
    perform public.recalc_swiss_tiebreakers(v_event_id);
  end loop;
end;
$$;

do $$
declare
  v_mismatch_count integer;
  v_details text;
  v_total integer;
begin
  select count(*) into v_total from _swiss_verify_before;

  select count(*), string_agg(
    format(
      'participant %s (event %s): puntos %s->%s, omw %s->%s, gw %s->%s, ogw %s->%s',
      b.participant_id, b.event_id,
      b.points, ep.swiss_points,
      b.omw, ep.swiss_omw,
      b.gw, ep.swiss_gw,
      b.ogw, ep.swiss_ogw
    ), E'\n'
  )
  into v_mismatch_count, v_details
  from _swiss_verify_before b
  join public.event_participants ep on ep.id = b.participant_id
  where b.points is distinct from ep.swiss_points
     or b.omw is distinct from ep.swiss_omw
     or b.gw is distinct from ep.swiss_gw
     or b.ogw is distinct from ep.swiss_ogw;

  if v_mismatch_count > 0 then
    raise exception 'Fase 6.2: % discrepancia(s) de % participante(s) verificado(s) entre las funciones viejas y las unificadas. Migración abortada, nada quedó aplicado. Detalle:
%', v_mismatch_count, v_total, v_details;
  end if;

  raise notice 'Fase 6.2: verificación OK — % participante(s) de evento(s) swiss/swiss_bo2 real(es) con rondas generadas, output idéntico antes/después de unificar.', v_total;
end;
$$;
