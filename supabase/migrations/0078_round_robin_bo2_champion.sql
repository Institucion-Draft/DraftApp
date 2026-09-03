-- 0078_round_robin_bo2_champion.sql
-- Sub-paso 2a-bis: compute_event_champion (flujo top_size=null) no contemplaba pairings BO2
-- empatados (official_draw=true) — ni como "resueltos" para el conteo de pendientes, ni en el
-- criterio de liderazgo, que seguía comparando winrate incluso para match_format='bo2'.
--
-- Cambios:
--   1. v_pending_pairings_total / v_pending_pairings_blocked ahora tratan un pairing con
--      official_draw=true como resuelto (no pendiente).
--   2. Criterio de liderazgo: BO1/BO3 sigue usando winrate (won/completed), sin cambios. BO2
--      pasa a usar puntos totales absolutos (won*3 + draws*1) en vez de proporción. El umbral
--      de elegibilidad v_min_bo3_required se sigue midiendo en pairings resueltos (ahora
--      incluyendo empates) para ambos casos.
--
-- No toca el bloque de "líder matemáticamente inevitable con pairings pendientes" (0074): ese
-- sigue comparando winrate de forma proyectada y no distingue empates BO2 ya resueltos de
-- pairings todavía sin jugar — queda fuera de este sub-paso.
-- No toca podium.ts ni el cliente: la cascada tanda1/tanda2 para desempates de 2+ líderes ya
-- está resuelta por separado y no se ve afectada por este cambio.

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
  v_pending_pairings_blocked integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_score numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_existing_active_group_id uuid;
  v_proj_leader_user_id uuid;
  v_proj_leader_participant_id uuid;
  v_proj_min_winrate numeric;
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

  -- Un pairing con official_draw=true (BO2, 1-1) está resuelto igual que uno con ganador: no
  -- cuenta como pendiente ni como bloqueado-pendiente.
  select count(*), count(*) filter (where official_winner_participant_id is null and official_draw = false),
    count(*) filter (where official_winner_participant_id is null and official_draw = false
      and (exists (select 1 from public.event_participants ep where ep.id = p.participant_a_id and ep.left_event_at is not null)
        or exists (select 1 from public.event_participants ep where ep.id = p.participant_b_id and ep.left_event_at is not null)))
  into v_total_pairings, v_pending_pairings_total, v_pending_pairings_blocked
  from public.pairings p where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Líder matemáticamente inevitable con pairings aún pendientes (0074, sin cambios).
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

  -- Criterio de liderazgo: BO1/BO3 = winrate (won/completed), sin cambios. BO2 = puntos totales
  -- absolutos (won*3 + draws*1), no proporción — "completed" (para el umbral v_min_bo3_required)
  -- sigue siendo pairings resueltos, ahora incluyendo empates.
  with player_bo3 as (
    select ep.user_id, ep.id as participant_id,
      count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won,
      count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player'
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
      where ep.event_id = p_event_id and ep.role = 'player'
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
