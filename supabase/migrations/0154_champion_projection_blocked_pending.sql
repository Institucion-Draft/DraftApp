-- 0154: la proyeccion de campeon (auto_projected) deja de ignorar los pendientes "bloqueados".
--
-- Bug (evento "Draft Papal", round robin BO3, 7 jugadores): al marcar "ida" a un jugador,
-- apply_walkover_for_participant inserta los walkovers de sus pairings en UNA transaccion y el
-- trigger on_pairing_official_close_update_champion recalcula el campeon tras cada pairing
-- cerrado. En los estados intermedios, el pairing todavia sin walkover entre un rival activo y el
-- jugador que se fue figuraba como is_blocked y quedaba FUERA del denominador de ese rival
-- (pending_active lo excluia), asi que su max_score caia (ej. (3+1)/5 = 0,80 en vez de
-- (3+2)/6 = 0,833) y un lider con 5/6 parecia inalcanzable. Se coronaba como auto_projected y,
-- como el campeon es pegajoso (solo se setea con champion_user_id is null), quedaba fijo.
--
-- Fix: un pendiente contra alguien que se fue cuenta como pendiente que el rival activo PUEDE
-- ganar (va a recibir un walkover a favor). pending_active pasa a contar todo pairing sin
-- resolver del jugador. Para el candidato eso es conservador (min_score lo trata como no ganado)
-- y para los rivales es el mejor caso real. El resto de la funcion queda identico a 0149.
--
-- Rollback (NO CORRER salvo que se quiera volver al comportamiento anterior): volver a crear
-- public.compute_event_champion_impl(uuid) con la definicion de la migracion 0149.

begin;

CREATE OR REPLACE FUNCTION public.compute_event_champion_impl(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_competition_format text;
  v_top_size integer;
  v_match_format text;
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_score numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_existing_active_group_id uuid;
  v_proj_leader_user_id uuid;
  v_proj_leader_participant_id uuid;
  v_proj_min_score numeric;
  v_proj_threats integer;
begin
  select competition_format, top_size, match_format, status, champion_user_id
  into v_competition_format, v_top_size, v_match_format, v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  -- Copa (competition_format 'zones_knockout' / 'knockout', 0129): su campeón sale de la final del
  -- bracket, nunca de la tabla de liga. Esta función no interviene en ningún punto: ni proyecta un
  -- líder, ni marca final_pending, ni cambia status.
  if v_competition_format in ('zones_knockout', 'knockout') then return; end if;

  -- round_robin + top_size=4 (antes competition_format='round_robin_bo1_top4') tiene su propio
  -- flujo de cierre vía el bracket de top4; esta función no debe intervenir en ningún punto
  -- para este formato.
  if v_competition_format = 'round_robin' and coalesce(v_top_size, 0) = 4 then return; end if;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;

  select id into v_existing_active_group_id
  from public.event_tiebreak_groups where event_id = p_event_id and status = 'active' limit 1;
  if v_existing_active_group_id is not null then return; end if;

  select count(*), count(*) filter (where official_winner_participant_id is null and official_draw = false)
  into v_total_pairings, v_pending_pairings_total
  from public.pairings p where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Líder matemáticamente inevitable con pairings aún pendientes (0074). BO1/BO3: winrate
  -- proyectado, sin cambios. BO2: puntos totales absolutos (peor caso del candidato = puntos
  -- actuales sin sumar nada de sus pendientes; mejor caso de cada rival = puntos actuales + 3
  -- por cada pendiente que le queda, asumiendo que los gana todos). Quien tiene left_event_at
  -- seteado no puede ser candidato (no va a jugar más) ni contar como amenaza (no puede alcanzar
  -- a nadie si no va a jugar más). 0154: un pendiente contra alguien que se fue ya NO se excluye
  -- (antes: is_blocked): para el jugador activo es un pendiente que va a ganar por walkover, así
  -- que entra en su denominador y en su mejor caso. v_pending_pairings_total sigue siendo lo
  -- único que decide si el evento puede cerrar.
  if v_pending_pairings_total > 0 and v_event_champion_user_id is null then
    with pairing_block as (
      select
        p.participant_a_id,
        p.participant_b_id,
        p.official_winner_participant_id,
        p.official_draw
      from public.pairings p
      where p.event_id = p_event_id
    ),
    projection as (
      select
        ep.user_id,
        ep.id as participant_id,
        count(*) filter (
          where (pb.official_winner_participant_id is not null or pb.official_draw = true)
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as completed_now,
        count(*) filter (
          where pb.official_winner_participant_id = ep.id
        ) as won_now,
        count(*) filter (
          where pb.official_draw = true
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as draws_now,
        count(*) filter (
          where pb.official_winner_participant_id is null
            and pb.official_draw = false
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as pending_active
      from public.event_participants ep
      left join pairing_block pb on pb.participant_a_id = ep.id or pb.participant_b_id = ep.id
      where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      group by ep.user_id, ep.id
    ),
    projected as (
      select
        user_id,
        participant_id,
        (completed_now + pending_active) as final_completed,
        case when v_match_format = 'bo2'
          then (won_now * 3 + draws_now)::numeric
          else (won_now::numeric / nullif(completed_now + pending_active, 0))
        end as min_score,
        case when v_match_format = 'bo2'
          then (won_now * 3 + draws_now + pending_active * 3)::numeric
          else ((won_now + pending_active)::numeric / nullif(completed_now + pending_active, 0))
        end as max_score
      from projection
    ),
    candidate as (
      select user_id, participant_id, min_score
      from projected
      where final_completed >= v_min_bo3_required
      order by min_score desc nulls last
      limit 1
    )
    select c.user_id, c.participant_id, c.min_score,
      (select count(*) from projected q
        where q.participant_id <> c.participant_id and q.max_score >= c.min_score)
    into v_proj_leader_user_id, v_proj_leader_participant_id, v_proj_min_score, v_proj_threats
    from candidate c;

    if v_proj_leader_user_id is not null and v_proj_min_score is not null and v_proj_threats = 0 then
      update public.draft_events
        set champion_user_id = v_proj_leader_user_id, champion_decided_by = 'auto_projected'
      where id = p_event_id and status = 'playing' and champion_user_id is null;
    end if;
  end if;

  if v_pending_pairings_total > 0 then return; end if;

  -- Criterio de liderazgo: BO1/BO3 = winrate (won/completed), sin cambios. BO2 = puntos totales
  -- absolutos (won*3 + draws*1), no proporción — "completed" (para el umbral v_min_bo3_required)
  -- sigue siendo pairings resueltos, ahora incluyendo empates. Quien tiene left_event_at seteado
  -- queda afuera del pool de candidatos a campeón (sigue siendo necesario: puede terminar con el
  -- mejor récord real aunque el walkover ya haya resuelto sus pendientes en su contra).
  with player_bo3 as (
    select ep.user_id, ep.id as participant_id,
      count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won,
      count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, draws,
      case when v_match_format = 'bo2' then (won * 3 + draws)::numeric
           else (won::numeric / nullif(completed, 0))
      end as score
    from player_bo3 where completed >= v_min_bo3_required
  )
  select max(score), count(*) filter (where score = (select max(score) from eligible))
  into v_max_score, v_leaders_count from eligible;

  if v_max_score is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id from (
      select ep.user_id,
        count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won,
        count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      group by ep.user_id
    ) leaders
    where (case when v_match_format = 'bo2' then (won * 3 + draws)::numeric
                else (won::numeric / nullif(completed, 0))
           end) = v_max_score
      and completed >= v_min_bo3_required;
    update public.draft_events set champion_user_id = v_leader_user_id, champion_decided_by = 'auto', event_ended_at = now(),
      status = 'completed', final_pending = false where id = p_event_id and status = 'playing';
    return;
  end if;

  -- v_leaders_count >= 2: el desempate de 1er puesto lo arma el CLIENTE (EventDetailScreen.tsx),
  -- igual que round_robin + top_size=4 ya hace para el desempate del 4to puesto — reusa la
  -- cascada completa de tanda1/tanda2 de podium.ts. Esta función se limita a marcar
  -- final_pending=true; el cliente detecta esa señal y llama a
  -- create_round_robin_first_place_tiebreak_group con el grupo ya ordenado.
  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$function$
;

commit;
