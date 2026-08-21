-- 0069_round_robin_top4_client_ranking.sql
-- Simplificación: create_round_robin_top4_bracket ya no calcula el ranking (wins/OMW%) ni
-- proyecta "inevitabilidad" con pairings pendientes. El disparador pasa a ser único y simple:
-- el cliente llama esta función solo cuando la fase regular está 100% resuelta (0 pairings
-- sin ganador), y le pasa los 4 participant_ids ya ordenados (rankRoundRobinBo1Standings en
-- podium.ts, con desempate olímpico + calidad de rivales + hash determinista).
-- El servidor solo confía el ORDEN de los seeds al cliente; sigue validando por su cuenta
-- que el evento sea del formato correcto, que no haya bracket ya creado, que los 4 ids sean
-- válidos y distintos, y que la fase regular esté efectivamente terminada (defensa en
-- profundidad ante un cliente desactualizado o una llamada manual al RPC).

drop function if exists public.create_round_robin_top4_bracket(uuid);

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
  v_existing integer;
  v_pending integer;
  v_valid_count integer;
  v_distinct_count integer;
  v_new_group_id uuid;
begin
  select competition_format into v_format
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin_bo1_top4' then return false; end if;

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
  where ep.id = any(p_top4_ordered)
    and ep.event_id = p_event_id
    and ep.role = 'player';

  if v_valid_count <> 4 then return false; end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta, sin importar lo
  -- que el cliente haya calculado.
  select count(*) into v_pending
  from public.pairings
  where event_id = p_event_id
    and official_winner_participant_id is null;

  if v_pending > 0 then return false; end if;

  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, p_top4_ordered);

  update public.event_tiebreak_groups
  set group_origin = 'round_robin_topcut'
  where id = v_new_group_id;

  return true;
end;
$$;
