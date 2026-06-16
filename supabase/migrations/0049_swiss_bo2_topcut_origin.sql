-- 0049_swiss_bo2_topcut_origin.sql
--
-- La fase mata-mata de swiss_bo2 debe comportarse igual que la de swiss (bo3).
-- En swiss, maybe_advance_swiss_round marca el bracket recién creado con
-- group_origin = 'swiss_topcut' (ver 0038). swiss_bo2 nunca lo hacía, por lo que
-- su bracket quedaba con el default 'tiebreak' y la UI lo mostraba como
-- "Desempate" (rama round_robin) en lugar de "Fase mata-mata", además de no
-- renderizar el cuadro de mata-mata en la tabla de posiciones.
--
-- FIX 1: recrear maybe_advance_swiss_bo2_round para setear group_origin tras
--        crear el bracket, idéntico a maybe_advance_swiss_round.
-- FIX 2: backfill de los brackets de eventos swiss_bo2 ya existentes.

-- ===========================================================================
-- FIX 1: maybe_advance_swiss_bo2_round setea group_origin = 'swiss_topcut'
-- ===========================================================================
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

  -- Era la última: generar bracket de top 4.
  select array_agg(ep.id order by public.swiss_bo2_points_of(ep.id, v_event_id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
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

-- ===========================================================================
-- FIX 2: backfill de brackets ya generados en eventos swiss_bo2
-- ===========================================================================
update public.event_tiebreak_groups g
set group_origin = 'swiss_topcut'
from public.draft_events e
where g.event_id = e.id
  and e.competition_format = 'swiss_bo2'
  and g.group_type = 'bracket'
  and g.group_origin <> 'swiss_topcut';
