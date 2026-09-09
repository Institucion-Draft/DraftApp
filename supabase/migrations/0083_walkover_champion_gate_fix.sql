-- 0083_walkover_champion_gate_fix.sql
-- Fix de un bug real encontrado en vivo probando la Fase 1 del walkover (evento
-- 48a178fd-71fa-48de-8427-73c2664161a2): compute_event_champion (0082) decidía si un pairing
-- pendiente "bloqueaba" el cierre mirando si CUALQUIERA de los dos lados tenía left_event_at
-- seteado (OR) — un criterio pensado para la era pre-walkover, donde un pairing contra alguien
-- que se fue iba a quedar sin jugar para siempre y había que ignorarlo a propósito.
--
-- Ahora que existe apply_walkover_for_participant (0082), ese pairing SÍ se va a resolver (con
-- ganador real o por abandono) en cuanto haya un "el que se queda" del lado activo — así que
-- tratarlo como "no bloqueante" solo porque uno de los dos se fue permite que
-- compute_event_champion se adelante al walkover: si Manu se va y todavía le quedan pairings
-- pendientes contra rivales que NO se fueron (que el walkover va a resolver en instantes, pero
-- to en el mismo instante en que se llama a compute_event_champion desde markAsLeft si hubo
-- algún problema de orden), esos pairings ya contaban como "bloqueados" solo por la salida de
-- Manu, sin haberse resuelto todavía de verdad — permitiendo coronar campeón con el evento
-- todavía genuinamente incompleto.
--
-- Fix: "bloqueado" deja de existir como concepto — un pairing pendiente (official_winner_
-- participant_id is null and official_draw = false) SIEMPRE traba el cierre, sin importar
-- left_event_at. Si el walkover ya corrió, el pairing tiene ganador y deja de contar como
-- pendiente (se resuelve solo). Si todavía no corrió (por ejemplo, ambos lados se fueron y
-- quedó pendiente a propósito — caso D del walkover), sigue bloqueando el cierre, correctamente.
-- v_pending_pairings_total no cambia: su definición ya era correcta.
--
-- El filtro "ep.left_event_at is null" del CTE eligible (0082) se mantiene sin cambios: sigue
-- siendo necesario en profundidad — un jugador que se fue con pocos pendientes puede terminar
-- con el mejor récord real incluso después de que el walkover resuelva esos pocos pendientes en
-- su contra, y sin ese filtro se coronaría campeón igual.
--
-- El "is_blocked" interno del bloque de proyección (líder matemáticamente inevitable con
-- pendientes aún abiertos) NO se toca: es un mecanismo distinto, que decide qué pendientes
-- cuentan como "todavía disputables" para el rango peor/mejor-caso de esa proyección, no si el
-- evento puede cerrar — dejarlo como está solo hace la proyección un poco más conservadora
-- cuando alguien se fue, nunca corona de más.

create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
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
  -- a nadie si no va a jugar más). El "is_blocked" de pairing_block (mismo criterio "algún lado
  -- se fue" que antes) sigue vivo acá adentro a propósito — ver comentario arriba: decide qué
  -- pendientes cuentan como "todavía disputables" para el rango de la proyección, no si el
  -- evento puede cerrar (eso ahora lo decide solo v_pending_pairings_total).
  if v_pending_pairings_total > 0 and v_event_champion_user_id is null then
    with pairing_block as (
      select
        p.participant_a_id,
        p.participant_b_id,
        p.official_winner_participant_id,
        p.official_draw,
        (epa.left_event_at is not null or epb.left_event_at is not null) as is_blocked
      from public.pairings p
      join public.event_participants epa on epa.id = p.participant_a_id
      join public.event_participants epb on epb.id = p.participant_b_id
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
            and not pb.is_blocked
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
$$;
