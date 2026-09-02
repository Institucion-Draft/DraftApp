-- 0074_champion_projected_leader.sql
-- compute_event_champion() (ver 0070) solo evaluaba quién es campeón una vez que
-- TODOS los pairings del evento estaban oficialmente resueltos (o bloqueados por
-- abandono): `if v_pending_pairings_total > v_pending_pairings_blocked then return;`
-- cortaba la ejecución antes de llegar a cualquier cálculo de winrate.
--
-- Esta migración agrega, ANTES de ese corte, una proyección de peor/mejor caso
-- (mismo espíritu que findUniqueSecureLeader en app/src/lib/podium.ts, pero aplicada
-- acá al winrate BO3 por pairing que ya usa esta función, no a bo3Won/OMW/OGW de swiss):
--   - minWinrate(P)  = bo3_ganados(P) / (bo3_completados(P) + bo3_pendientes_activos(P))
--                      (asume que P pierde TODOS sus pendientes no bloqueados)
--   - maxWinrate(Q)  = (bo3_ganados(Q) + bo3_pendientes_activos(Q)) / (bo3_completados(Q) + bo3_pendientes_activos(Q))
--                      (asume que Q gana TODOS los suyos)
-- "bo3_pendientes_activos" excluye pairings pendientes bloqueados por abandono, con el
-- mismo criterio que v_pending_pairings_blocked de más abajo. La elegibilidad
-- (completadas >= v_min_bo3_required) se evalúa contra el total FINAL proyectado
-- (completadas_ahora + pendientes_activos), que es determinístico: cada pendiente activo
-- eventualmente se resuelve sí o sí (gane quien gane), así que el conteo de "completadas"
-- final no depende de resultados futuros, solo el numerador (won) sí.
--
-- Si existe un único participante P tal que ningún otro Q puede empatarlo o superarlo
-- (maxWinrate(Q) < minWinrate(P) para todo Q≠P), se adelanta champion_user_id con
-- champion_decided_by='auto_projected', SIN tocar status/final_pending/event_ended_at:
-- el evento sigue 'playing' hasta que el último pairing realmente cierre. Es el MISMO
-- criterio (winrate + umbral v_min_bo3_required) que la resolución final de abajo
-- (rama v_leaders_count = 1), así que cuando todos los pairings terminen de resolverse,
-- esa rama recalcula desde cero y llega necesariamente al mismo v_leader_user_id.
--
-- Dos ajustes al resto de la función para no "pisar mal el dato" cuando ya se
-- anticipó un campeón (status sigue 'playing' con champion_user_id ya seteado, un
-- estado que antes de esta migración era imposible — antes, champion_user_id no nulo
-- implicaba siempre status ya resuelto):
--   1. Se elimina el guard temprano `if v_event_champion_user_id is not null then
--      return; end if;`: en este punto v_event_status ya está garantizado = 'playing'
--      (el guard de status ya cortó si no), así que ese chequeo solo podía volverse
--      verdadero por una anticipación previa — y en ese caso justamente NO queremos
--      cortar, sino seguir hasta la resolución final real.
--   2. La rama v_leaders_count = 1 (única que setea champion_user_id fuera de esta
--      proyección) cambia su WHERE de `champion_user_id is null` a `status = 'playing'`,
--      porque con la anticipación champion_user_id ya puede estar seteado (al mismo
--      valor, por consistencia matemática) y ese WHERE viejo hubiera bloqueado para
--      siempre la transición real a status='completed' + event_ended_at.
-- El resto de la función (empates de 2/3/4/5+ líderes, brackets, fragmentada) queda
-- exactamente igual: son ramas matemáticamente inalcanzables una vez que hubo un líder
-- inevitable único (el mismo criterio garantiza v_leaders_count = 1 en la resolución
-- final), así que no hace falta tocarlas.
--
-- Caveat conocido (no resuelto acá, fuera del alcance de "modificar
-- compute_event_champion"): esta función solo se dispara desde el trigger
-- on_pairing_official_close_update_champion (AFTER UPDATE de pairings). Si después de
-- anticipar un campeón un jugador abandona el evento y eso bloquea uno de los
-- pendientes activos que se usaron para la proyección, y ese abandono no cierra ningún
-- pairing adicional, la función no vuelve a ejecutarse y el dato anticipado podría
-- quedar desactualizado (y el evento nunca transicionaría a 'completed'). Es un caso
-- borde raro (requiere un abandono posterior a la anticipación); si se quiere cubrir,
-- hace falta un trigger separado sobre event_participants.left_event_at.

-- draft_events_champion_decision_valid (ver 0028_copa_fragmentada.sql) no incluía
-- 'auto_projected': el UPDATE de la proyección de más abajo violaría esa constraint
-- sin este ajuste.
alter table public.draft_events
  drop constraint if exists draft_events_champion_decision_valid;

alter table public.draft_events
  add constraint draft_events_champion_decision_valid
  check (champion_decided_by is null or champion_decided_by in ('auto', 'manual_override', 'tiebreak', 'polemica', 'fragmentada', 'auto_projected'));

create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_competition_format text;
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_blocked integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_winrate numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_leader_a_user_id uuid;
  v_leader_b_user_id uuid;
  v_leader_a_participant_id uuid;
  v_leader_b_participant_id uuid;
  v_tiebreak_winner_participant_id uuid;
  v_tiebreak_pairing_id uuid;
  v_leader_participant_ids uuid[];
  v_existing_active_group_id uuid;
  v_proj_leader_user_id uuid;
  v_proj_leader_participant_id uuid;
  v_proj_min_winrate numeric;
  v_proj_threats integer;
begin
  select competition_format, status, champion_user_id
  into v_competition_format, v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  -- round_robin_bo1_top4 tiene su propio flujo de cierre vía el bracket de top4; esta
  -- función no debe intervenir en ningún punto para este formato.
  if v_competition_format = 'round_robin_bo1_top4' then return; end if;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;

  select id into v_existing_active_group_id
  from public.event_tiebreak_groups where event_id = p_event_id and status = 'active' limit 1;
  if v_existing_active_group_id is not null then return; end if;

  select count(*), count(*) filter (where official_winner_participant_id is null),
    count(*) filter (where official_winner_participant_id is null
      and (exists (select 1 from public.event_participants ep where ep.id = p.participant_a_id and ep.left_event_at is not null)
        or exists (select 1 from public.event_participants ep where ep.id = p.participant_b_id and ep.left_event_at is not null)))
  into v_total_pairings, v_pending_pairings_total, v_pending_pairings_blocked
  from public.pairings p where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Líder matemáticamente inevitable con pairings aún pendientes (ver comentario de
  -- cabecera). Solo corre si todavía hay pendientes activos y no se anticipó ya.
  if v_pending_pairings_total > v_pending_pairings_blocked and v_event_champion_user_id is null then
    with pairing_block as (
      select
        p.participant_a_id,
        p.participant_b_id,
        p.official_winner_participant_id,
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
          where pb.official_winner_participant_id is not null
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as completed_now,
        count(*) filter (
          where pb.official_winner_participant_id = ep.id
        ) as won_now,
        count(*) filter (
          where pb.official_winner_participant_id is null
            and not pb.is_blocked
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as pending_active
      from public.event_participants ep
      left join pairing_block pb on pb.participant_a_id = ep.id or pb.participant_b_id = ep.id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    ),
    projected as (
      select
        user_id,
        participant_id,
        (completed_now + pending_active) as final_completed,
        (won_now::numeric / nullif(completed_now + pending_active, 0)) as min_winrate,
        ((won_now + pending_active)::numeric / nullif(completed_now + pending_active, 0)) as max_winrate
      from projection
    ),
    candidate as (
      select user_id, participant_id, min_winrate
      from projected
      where final_completed >= v_min_bo3_required
      order by min_winrate desc nulls last
      limit 1
    )
    select c.user_id, c.participant_id, c.min_winrate,
      (select count(*) from projected q
        where q.participant_id <> c.participant_id and q.max_winrate >= c.min_winrate)
    into v_proj_leader_user_id, v_proj_leader_participant_id, v_proj_min_winrate, v_proj_threats
    from candidate c;

    if v_proj_leader_user_id is not null and v_proj_min_winrate is not null and v_proj_threats = 0 then
      update public.draft_events
        set champion_user_id = v_proj_leader_user_id, champion_decided_by = 'auto_projected'
      where id = p_event_id and status = 'playing' and champion_user_id is null;
    end if;
  end if;

  if v_pending_pairings_total > v_pending_pairings_blocked then return; end if;

  with player_bo3 as (
    select ep.user_id, ep.id as participant_id,
      count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player'
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, (won::numeric / nullif(completed, 0)) as winrate
    from player_bo3 where completed >= v_min_bo3_required
  )
  select max(winrate), count(*) filter (where winrate = (select max(winrate) from eligible))
  into v_max_winrate, v_leaders_count from eligible;

  if v_max_winrate is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id from (
      select ep.user_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id
    ) leaders where (won::numeric / nullif(completed, 0)) = v_max_winrate and completed >= v_min_bo3_required;
    update public.draft_events set champion_user_id = v_leader_user_id, champion_decided_by = 'auto', event_ended_at = now(),
      status = 'completed', final_pending = false where id = p_event_id and status = 'playing';
    return;
  end if;

  if v_leaders_count = 2 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    ),
    leaders_list as (
      select user_id, participant_id, row_number() over (order by participant_id) as rn
      from player_bo3 where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate
    )
    select (select user_id from leaders_list where rn = 1), (select user_id from leaders_list where rn = 2),
           (select participant_id from leaders_list where rn = 1), (select participant_id from leaders_list where rn = 2)
    into v_leader_a_user_id, v_leader_b_user_id, v_leader_a_participant_id, v_leader_b_participant_id;

    select id, tiebreak_winner_participant_id into v_tiebreak_pairing_id, v_tiebreak_winner_participant_id
    from public.pairings where event_id = p_event_id
      and ((participant_a_id = v_leader_a_participant_id and participant_b_id = v_leader_b_participant_id)
        or (participant_a_id = v_leader_b_participant_id and participant_b_id = v_leader_a_participant_id));

    if v_tiebreak_winner_participant_id is not null then
      select ep.user_id into v_leader_user_id from public.event_participants ep where ep.id = v_tiebreak_winner_participant_id;
      update public.draft_events set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
        event_ended_at = now(), status = 'completed', final_pending = false where id = p_event_id and champion_user_id is null;
      return;
    end if;

    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 3 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    )
    select array_agg(participant_id order by participant_id) into v_leader_participant_ids
    from player_bo3 where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate;
    perform public.create_round_robin_tiebreak_group(p_event_id, v_leader_participant_ids, 1);
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 4 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    ),
    leaders as (
      select participant_id, public.event_match_winrate(p_event_id, participant_id) as match_wr
      from player_bo3 where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate
    )
    select array_agg(participant_id order by match_wr desc, random()) into v_leader_participant_ids from leaders;
    perform public.create_bracket_tiebreak_group(p_event_id, v_leader_participant_ids);
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count >= 5 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    )
    update public.draft_events set polemica_winners = (
      select array_agg(user_id) from player_bo3 where completed >= v_min_bo3_required and (won::numeric / nullif(completed, 0)) = v_max_winrate
    ),
    champion_decided_by = 'fragmentada', status = 'completed', event_ended_at = now(), final_pending = false
    where id = p_event_id and champion_user_id is null;
    return;
  end if;

  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$$;
