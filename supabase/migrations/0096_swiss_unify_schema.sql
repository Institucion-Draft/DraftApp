-- 0096_swiss_unify_schema.sql
-- Fase 6.4: colapsa competition_format='swiss_bo2' en 'swiss' + match_format='bo2',
-- mismo criterio que 0076 aplicó para round_robin_bo1_top4 -> round_robin + top_size.
--
-- Alcance:
--   1. Migración de datos: swiss_bo2 -> swiss + match_format='bo2'; swiss (BO3) ->
--      match_format='bo3' explícito (en la práctica ya lo era por el default de
--      columna, pero se deja explícito).
--   2. Constraint de competition_format: se saca 'swiss_bo2' de los valores válidos.
--   3 y 5. Se retira el shim swiss_effective_match_format (Fase 6.2/6.3) y sus 3
--      call sites (swiss_points_of, swiss_match_winrate, update_pairing_official_result)
--      vuelven a leer match_format directo de la columna.
--   4. swiss_rounds_manual se generaliza: antes solo lo respetaba
--      maybe_advance_swiss_bo2_round; ahora lo respeta la función de avance
--      unificada, para cualquier match_format de swiss.
--
-- CONSECUENCIA NECESARIA no pedida explícitamente pero inevitable al colapsar el
-- schema: dos pares de funciones/triggers que hoy se distinguen por
-- competition_format='swiss' vs 'swiss_bo2' quedarían con un gate permanentemente
-- muerto post-migración (la cadena 'swiss_bo2' nunca más existiría en la columna):
--   - maybe_advance_swiss_round (gate 'swiss') / maybe_advance_swiss_bo2_round
--     (gate 'swiss_bo2') -> se fusionan en una sola maybe_advance_swiss_round que
--     branchea por match_format para decidir generate_swiss_round vs
--     generate_swiss_bo2_round. Sin este fix, las rondas de los eventos que hoy
--     son swiss_bo2 dejarían de avanzar (su trigger jamás volvería a matchear).
--   - on_swiss_pairing_recalc_tiebreakers (gate 'swiss') /
--     on_swiss_bo2_pairing_recalc_tiebreakers (gate 'swiss_bo2') -> misma fusión,
--     mismo motivo (sin esto, swiss_omw/gw/ogw dejarían de recalcularse para esos
--     eventos).
-- Ambos ya eran, en la práctica, candidatos a fusión por el mismo motivo que
-- Fase 6.3 fusionó la resolución de pairings — acá era inevitable hacerlo también,
-- no es scope creep: dejarlos separados directamente rompe swiss_bo2 en producción
-- apenas se aplica este archivo.
--
-- AVISO IMPORTANTE para Fase 6.5 (no se toca acá, es SQL only): CreateEventScreen.tsx
-- todavía ofrece "Suizo BO2" como opción de picker que inserta literalmente
-- competition_format='swiss_bo2' — después de esta migración esa fila violaría el
-- nuevo constraint y el INSERT fallaría con un error visible al usuario. Y
-- generateEventPairings.ts todavía decide generate_swiss_round vs
-- generate_swiss_bo2_round para la RONDA 1 mirando competitionFormat==='swiss_bo2'
-- (nunca más va a ser cierto) en vez de match_format — hoy es inofensivo porque el
-- cuerpo de generate_swiss_round y generate_swiss_bo2_round producen el mismo
-- resultado en una ronda 1 sin historial de byes, pero queda mal enrutado y frágil.
-- Recomendado desplegar 6.5 inmediatamente después de esta migración, no dejar la
-- ventana abierta.
--
-- VERIFICACIÓN AUTOMÁTICA: para todo evento swiss/swiss_bo2 existente, se guarda
-- snapshot de lo que el shim swiss_effective_match_format devuelve ANTES de tocar
-- nada, y se compara contra el match_format que quede persistido en la columna
-- después de la migración de datos. Deben coincidir exactamente ("cero cambio de
-- comportamiento visible", mismo criterio que 0076). Si un solo evento difiere,
-- aborta la migración entera sin aplicar nada.
--
-- FIX aplicado tras el primer intento real: la verificación automática abortó
-- correctamente al detectar que el UPDATE 'swiss'->match_format='bo3' corría
-- DESPUÉS del que migra swiss_bo2->swiss+bo2, y por eso también re-matcheaba (y
-- pisaba) las filas recién migradas, que para ese momento ya decían
-- competition_format='swiss'. Se invirtió el orden: ver sección 1 más abajo.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES" (shim todavía vigente, competition_format todavía sin migrar)
-- ===========================================================================
create temporary table _swiss_match_format_before on commit drop as
select de.id as event_id, public.swiss_effective_match_format(de.id) as expected_match_format
from public.draft_events de
where de.competition_format in ('swiss', 'swiss_bo2');

-- ===========================================================================
-- 1. MIGRACIÓN DE DATOS
-- ===========================================================================
-- OJO orden: primero fijar match_format='bo3' en los swiss genuinos (BO3
-- clásico), TODAVÍA con swiss_bo2 sin migrar — si este UPDATE corriera después
-- del que migra swiss_bo2, su WHERE (competition_format='swiss') también
-- matchearía las filas recién migradas (ya dicen 'swiss' con match_format='bo2',
-- que es "distinct from 'bo3'") y les pisaría el match_format de vuelta a 'bo3'.
-- Bug real detectado por la verificación automática en el primer intento de esta
-- migración: abortó correctamente en vez de aplicar datos corruptos.
update public.draft_events
set match_format = 'bo3'
where competition_format = 'swiss'
  and match_format is distinct from 'bo3';

update public.draft_events
set match_format = 'bo2',
    competition_format = 'swiss'
where competition_format = 'swiss_bo2';

-- ===========================================================================
-- 2. CONSTRAINT: sacar 'swiss_bo2' de los valores válidos de competition_format
-- ===========================================================================
alter table public.draft_events
  drop constraint if exists draft_events_competition_format_valid;

alter table public.draft_events
  add constraint draft_events_competition_format_valid
    check (competition_format in ('round_robin', 'swiss'));

-- ===========================================================================
-- 3/5. Retirar el shim en sus 3 call sites: leer match_format directo
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
  v_match_format text;
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

  select match_format into v_match_format
  from public.draft_events
  where id = p_event_id;

  v_bye_points := case when v_match_format = 'bo2' then 2 else 3 end;

  return v_wins * 3 + v_draws * 1 + v_byes * v_bye_points;
end;
$$;

create or replace function public.swiss_match_winrate(p_event_id uuid, p_participant_id uuid)
returns numeric
language plpgsql
stable
as $$
declare
  v_match_format text;
  v_played integer;
  v_won integer;
  v_resolved integer;
  v_byes integer;
  v_max_points integer;
  v_points integer;
begin
  select match_format into v_match_format
  from public.draft_events
  where id = p_event_id;

  if v_match_format = 'bo2' then
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

create or replace function public.update_pairing_official_result()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match_format text;
  v_a_wins integer;
  v_b_wins integer;
  v_completed integer;
  v_winning_participant_id uuid;
  v_pairing public.pairings%rowtype;
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  select de.match_format
  into v_match_format
  from public.draft_events de
  where de.id = v_pairing.event_id;

  if v_match_format = 'bo1' then
    select winner_participant_id
    into v_winning_participant_id
    from public.matches
    where pairing_id = new.pairing_id
      and match_type = 'draft'
      and status = 'completed'
    order by match_number
    limit 1;

    if v_winning_participant_id is not null then
      update public.pairings
      set official_winner_participant_id = v_winning_participant_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    end if;

  elsif v_match_format = 'bo2' then
    select
      count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
      count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id),
      count(*)
    into v_a_wins, v_b_wins, v_completed
    from public.matches m
    where m.pairing_id = new.pairing_id
      and m.match_type = 'draft'
      and m.status = 'completed';

    if v_a_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_a_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null
        and official_draw = false;
    elsif v_b_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_b_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null
        and official_draw = false;
    elsif v_completed >= 2 then
      -- 1-1 => empate.
      update public.pairings
      set official_draw = true,
          official_winner_participant_id = null,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null
        and official_draw = false;
    end if;

  elsif v_match_format = 'bo3' then
    select
      count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
      count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id)
    into v_a_wins, v_b_wins
    from public.matches m
    where m.pairing_id = new.pairing_id
      and m.match_type = 'draft'
      and m.status = 'completed';

    if v_a_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_a_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    elsif v_b_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_b_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    end if;
  end if;

  return new;
end;
$$;

-- ===========================================================================
-- 4. Fusión inevitable: avance de ronda unificado, swiss_rounds_manual
--    generalizado a cualquier match_format de swiss
-- ===========================================================================
create or replace function public.maybe_advance_swiss_round()
returns trigger
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_competition_format text;
  v_match_format text;
  v_current_round integer;
  v_total_rounds integer;
  v_pending_pairings integer;
  v_top4 uuid[];
  v_new_group_id uuid;
begin
  -- Señal genérica: el pairing quedó resuelto (ganador, o empate — el empate solo
  -- es posible en match_format='bo2', official_draw siempre queda false en bo3/bo1).
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  -- swiss_rounds_manual generalizado: antes solo lo respetaba la rama bo2.
  select competition_format, match_format, current_swiss_round,
         coalesce(swiss_rounds_manual, swiss_rounds_total)
  into v_competition_format, v_match_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_competition_format <> 'swiss' then return new; end if;
  if v_current_round is null then return new; end if;

  select count(*) into v_pending_pairings
  from public.pairings
  where event_id = v_event_id
    and swiss_round = v_current_round
    and official_winner_participant_id is null
    and official_draw = false;

  if v_pending_pairings > 0 then return new; end if;

  if v_current_round < v_total_rounds then
    if v_match_format = 'bo2' then
      perform public.generate_swiss_bo2_round(v_event_id, v_current_round + 1);
    else
      perform public.generate_swiss_round(v_event_id, v_current_round + 1);
    end if;
    return new;
  end if;

  -- Última ronda: generar bracket de top 4. Mismos criterios que la tabla de
  -- posiciones (Pts > OMW > GW > OGW) más el desempate final por user_id (0050/0093).
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

-- Retirar el trigger/función bo2-específico ya fusionado arriba.
drop trigger if exists on_pairing_resolved_advance_swiss_bo2 on public.pairings;
drop function if exists public.maybe_advance_swiss_bo2_round();

-- Rewire del trigger bo3-original: ahora debe disparar también en la transición
-- de empate (antes solo en la transición de ganador), porque esta misma función
-- ya maneja ambos match_format.
drop trigger if exists on_pairing_resolved_advance_swiss on public.pairings;
create trigger on_pairing_resolved_advance_swiss
after update on public.pairings
for each row
when (
  (new.official_draw = true and old.official_draw = false)
  or (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
)
execute function public.maybe_advance_swiss_round();

-- Misma fusión inevitable para el recálculo de tiebreakers.
create or replace function public.on_swiss_pairing_recalc_tiebreakers()
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
  if v_format <> 'swiss' then return new; end if;

  perform public.recalc_swiss_tiebreakers(new.event_id);
  return new;
end;
$$;

drop trigger if exists on_aa_swiss_bo2_pairing_resolved_recalc on public.pairings;
drop function if exists public.on_swiss_bo2_pairing_recalc_tiebreakers();

drop trigger if exists on_aa_swiss_pairing_resolved_recalc on public.pairings;
create trigger on_aa_swiss_pairing_resolved_recalc
after update on public.pairings
for each row
when (
  (new.official_draw = true and old.official_draw = false)
  or (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
)
execute function public.on_swiss_pairing_recalc_tiebreakers();

-- ===========================================================================
-- 3. Retirar el shim, ya sin callers
-- ===========================================================================
drop function if exists public.swiss_effective_match_format(uuid);

-- ===========================================================================
-- VERIFICACIÓN AUTOMÁTICA: match_format persistido == lo que el shim devolvía
-- ===========================================================================
do $$
declare
  v_mismatch_count integer;
  v_details text;
  v_total integer;
begin
  select count(*) into v_total from _swiss_match_format_before;

  select count(*), string_agg(
    format('event %s: shim decía match_format=%s, quedó persistido %s',
      b.event_id, b.expected_match_format, de.match_format),
    E'\n'
  )
  into v_mismatch_count, v_details
  from _swiss_match_format_before b
  join public.draft_events de on de.id = b.event_id
  where de.match_format is distinct from b.expected_match_format;

  if v_mismatch_count > 0 then
    raise exception 'Fase 6.4: % discrepancia(s) de % evento(s) verificado(s) entre el match_format que el shim hubiera devuelto y el que quedó persistido tras la migración. Migración abortada, nada quedó aplicado. Detalle:
%', v_mismatch_count, v_total, v_details;
  end if;

  raise notice 'Fase 6.4: verificación OK — % evento(s) swiss/swiss_bo2 migrado(s), match_format coincide exactamente con lo que el shim hubiera devuelto. Cero cambio de comportamiento visible.', v_total;
end;
$$;
