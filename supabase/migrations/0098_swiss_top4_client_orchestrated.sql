-- 0098_swiss_top4_client_orchestrated.sql
-- Fase 6.6: porta el armado del bracket real de top4 de Suizo al mismo patrón
-- client-orchestrated que ya usa round_robin (create_round_robin_top4_bracket +
-- computeAndCreateTop4Bracket), en vez del trigger automático server-side
-- (maybe_advance_swiss_round armándolo solo al cerrar la última ronda).
--
-- Diseño acordado (sin cambios de alcance):
--   1. top_size=4 fijo para Suizo, reusando la columna existente — Suizo SIEMPRE tiene top4
--      (como ya es hoy, sin excepción), no se agrega ninguna opción de "sin mata-mata". Se
--      migra top_size=4 a todo evento swiss existente, y CreateEventScreen lo setea para los
--      nuevos, para que el chequeo "e.competition_format==='swiss' && e.top_size===4" en
--      EventDetailScreen sea simétrico al de round_robin.
--   2. create_swiss_top4_bracket: función NUEVA, no una generalización de
--      create_round_robin_top4_bracket — el chequeo de "fase regular 100% resuelta" es
--      estructuralmente distinto: round_robin exige que TODOS los pairings del evento tengan
--      ganador (todos deben jugarse); Suizo solo exige que los pairings CON swiss_round
--      asignado estén resueltos — la tabla pairings de un evento suizo tiene muchas filas con
--      swiss_round=null (cruces que `generate_all_pairings` creó pero nunca se llegaron a
--      programar), que NO deben exigirse resueltos. Forzar el guard de round_robin acá sería
--      directamente incorrecto, no solo redundante.
--   3. Se retira por completo el armado de bracket dentro de maybe_advance_swiss_round — la
--      generación de rondas 2..N-1 (y su envoltorio try/catch de 0097) queda intacta, sin
--      tocar. Sin trigger de respaldo server-side (decisión explícita, mismo criterio que ya
--      acepta round_robin en producción: cualquiera que abra EventDetailScreen re-evalúa el
--      chequeo, RPC idempotente).
--
-- Sin eventos suizos en curso cerca de terminar su última ronda al momento de este deploy
-- (confirmado) — de todos modos, SQL y cambios de cliente se despliegan juntos, no
-- escalonado, para no dejar una ventana sin ningún mecanismo activo.

-- ===========================================================================
-- 0. SNAPSHOT + migración de datos: top_size=4 para todo evento swiss existente
-- ===========================================================================
create temporary table _swiss_top_size_before on commit drop as
select id as event_id, top_size
from public.draft_events
where competition_format = 'swiss';

update public.draft_events
set top_size = 4
where competition_format = 'swiss';

-- ===========================================================================
-- 1. create_swiss_top4_bracket
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

  -- Idempotente: no crear un segundo bracket para el mismo evento (cualquier origin).
  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'bracket';

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

  -- Defensa en profundidad: la fase regular suiza debe estar 100% resuelta, sin importar lo
  -- que el cliente haya calculado. A diferencia de round_robin, solo cuentan los pairings CON
  -- swiss_round asignado — las filas swiss_round=null son cruces que nunca se programaron y no
  -- deben exigirse resueltos.
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
-- 2. maybe_advance_swiss_round: retirar el armado de bracket (queda del lado cliente)
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
begin
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

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
    -- No dejar que "no se pudo armar la ronda siguiente" aborte esta transacción (0097): es la
    -- MISMA transacción del resultado que se acaba de cargar, que sí es válido y debe
    -- guardarse igual.
    begin
      if v_match_format = 'bo2' then
        perform public.generate_swiss_bo2_round(v_event_id, v_current_round + 1);
      else
        perform public.generate_swiss_round(v_event_id, v_current_round + 1);
      end if;
      update public.draft_events set swiss_pairing_blocked_reason = null where id = v_event_id;
    exception when others then
      update public.draft_events set swiss_pairing_blocked_reason = sqlerrm where id = v_event_id;
    end;
    return new;
  end if;

  -- Última ronda ya resuelta: el armado del bracket de top4 pasa al cliente (Fase 6.6,
  -- create_swiss_top4_bracket + computeAndCreateTop4Bracket-equivalente), mismo patrón que
  -- round_robin. No se hace nada más acá a propósito.
  return new;
end;
$$;

-- ===========================================================================
-- VERIFICACIÓN AUTOMÁTICA: todo evento swiss quedó con top_size=4
-- ===========================================================================
do $$
declare
  v_mismatch_count integer;
  v_total integer;
begin
  select count(*) into v_total from _swiss_top_size_before;

  select count(*) into v_mismatch_count
  from public.draft_events de
  where de.competition_format = 'swiss' and coalesce(de.top_size, 0) <> 4;

  if v_mismatch_count > 0 then
    raise exception 'Fase 6.6: % evento(s) swiss quedaron con top_size distinto de 4 tras la migración. Migración abortada, nada quedó aplicado.', v_mismatch_count;
  end if;

  raise notice 'Fase 6.6: verificación OK — % evento(s) swiss verificados, todos con top_size=4.', v_total;
end;
$$;
