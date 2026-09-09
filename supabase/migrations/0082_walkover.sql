-- 0082_walkover.sql
-- Fase 1 del rediseño de "Me voy": motor de walkover aislado (ver auditoría previa).
--
-- Diseño de la columna: is_walkover boolean en `matches`, ortogonal a `match_type`. Un partido
-- por abandono de un pairing de fase regular se inserta con match_type='draft' (el mismo valor
-- que cualquier partida oficial normal) + is_walkover=true — así update_pairing_official_result
-- (BO1/BO2/BO3) lo cuenta exactamente igual que una partida jugada de verdad, sin tocar ese
-- trigger ni duplicar su lógica de "quién ganó el pairing". Deja el terreno listo para que una
-- fase futura (5) haga lo mismo con match_type='tiebreak' en brackets, sin volver a tocar
-- evaluate_tiebreak_group_after_match.
--
-- Regla de resolución: las partidas walkover SIEMPRE las gana el que se queda — nunca se le
-- inserta una victoria walkover al que se fue. Las partidas YA jugadas de verdad (por cualquiera
-- de los dos lados) no se tocan ni se revierten; si eso deja un BO2 en 1-1 (el que se fue ya
-- había ganado su única partida jugada antes de irse), el trigger existente lo resuelve como
-- empate — no forzamos una derrota total, porque eso exigiría bypassear/duplicar el conteo del
-- trigger. BO1 y BO3 nunca caen en ese caso (BO1 pendiente siempre es 0-0; BO3 necesita 2
-- victorias de hasta 3, así que el rival completando lo que le falta siempre gana limpio).
--
-- Alcance de esta fase: SOLO pairings de fase regular (excluye explícitamente cualquier pairing
-- ya linkeado a una fila de event_tiebreak_bracket_matches — eso es semis/final/3-4to puesto,
-- que se resuelve en una fase posterior). Si AMBOS lados de un pairing tienen left_event_at
-- seteado, no hay "el que se queda" a quien darle la victoria — se deja sin tocar (igual que hoy,
-- compute_event_champion ya lo trata como "bloqueado, no bloqueante" para el cierre clásico).

-- ── 1. Columna nueva ─────────────────────────────────────────────────────────────────────────
alter table public.matches
  add column if not exists is_walkover boolean not null default false;

-- ── 2. apply_walkover_for_participant: resuelve por abandono los pairings pendientes de fase
--       regular de un participante recién marcado como left_event_at. Idempotente (solo toca
--       pairings todavía pendientes) y seguro de llamar aunque el participante no tenga
--       left_event_at seteado (no hace nada).
create or replace function public.apply_walkover_for_participant(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_event_status text;
  v_match_format text;
  v_pairing record;
  v_stayer_id uuid;
  v_needed integer;
  v_stayer_wins integer;
  v_next_number integer;
  v_to_insert integer;
  v_i integer;
  v_resolved_count integer := 0;
begin
  select event_id, left_event_at
  into v_event_id, v_left_event_at
  from public.event_participants
  where id = p_participant_id;

  if v_event_id is null or v_left_event_at is null then
    return 0;
  end if;

  select status, match_format
  into v_event_status, v_match_format
  from public.draft_events
  where id = v_event_id and deleted_at is null;

  if v_event_status is distinct from 'playing' then
    return 0;
  end if;

  -- Victorias necesarias para que el pairing quede oficialmente cerrado (mismo criterio que
  -- update_pairing_official_result, 0077): BO1 = 1, BO2/BO3 = 2.
  v_needed := case when v_match_format = 'bo1' then 1 else 2 end;

  for v_pairing in
    select p.id, p.participant_a_id, p.participant_b_id
    from public.pairings p
    join public.event_participants epa on epa.id = p.participant_a_id
    join public.event_participants epb on epb.id = p.participant_b_id
    where p.event_id = v_event_id
      and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id)
      and p.official_winner_participant_id is null
      and p.official_draw is not true
      -- Si el rival TAMBIÉN se fue, no hay "el que se queda" a quien darle la victoria.
      and (epa.left_event_at is null or epb.left_event_at is null)
      -- Fuera de alcance en esta fase: pairings ya linkeados a un bracket de desempate.
      and not exists (
        select 1 from public.event_tiebreak_bracket_matches bm
        where bm.pairing_id = p.id
      )
  loop
    v_stayer_id := case
      when v_pairing.participant_a_id = p_participant_id then v_pairing.participant_b_id
      else v_pairing.participant_a_id
    end;

    select count(*) into v_stayer_wins
    from public.matches
    where pairing_id = v_pairing.id
      and match_type = 'draft'
      and status = 'completed'
      and winner_participant_id = v_stayer_id;

    v_to_insert := v_needed - v_stayer_wins;
    if v_to_insert <= 0 then
      continue;
    end if;

    select coalesce(max(match_number), 0) into v_next_number
    from public.matches
    where pairing_id = v_pairing.id;

    for v_i in 1..v_to_insert loop
      insert into public.matches
        (pairing_id, match_number, match_type, winner_participant_id, status, is_walkover, started_at, ended_at)
      values
        (v_pairing.id, v_next_number + v_i, 'draft', v_stayer_id, 'completed', true, now(), now());
    end loop;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  return v_resolved_count;
end;
$$;

-- ── 3. revert_walkover_for_participant: deshace el walkover generado por la salida de un
--       participante (llamado desde "Revertir"). Borra las matches walkover donde ese
--       participante quedó como perdedor por abandono, y resetea el resultado oficial de los
--       pairings afectados a su estado neutro (sin re-triggerear update_pairing_official_result
--       porque un DELETE no dispara ese trigger — el reset deja exactamente el estado correcto:
--       "pendiente, con lo que se haya jugado de verdad", sin necesidad de recalcular nada más).
create or replace function public.revert_walkover_for_participant(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  with deleted as (
    delete from public.matches m
    using public.pairings p
    where m.pairing_id = p.id
      and m.is_walkover = true
      and m.winner_participant_id <> p_participant_id
      and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id)
    returning m.pairing_id
  ),
  distinct_pairings as (
    select distinct pairing_id from deleted
  )
  update public.pairings
  set official_winner_participant_id = null,
      official_resolved_at = null,
      official_draw = false
  where id in (select pairing_id from distinct_pairings);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── 4. Fix del gap de eligibilidad encontrado en la auditoría: el CTE `eligible` (y sus
--       contrapartes de proyección y de re-lectura del líder) no excluían a quien tiene
--       left_event_at seteado — alguien que se fue podía terminar coronado campeón. Cuerpo
--       idéntico al vigente en 0079, agregando "and ep.left_event_at is null" en los 3 puntos
--       donde se arma el pool de candidatos/amenazas.
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

  -- Líder matemáticamente inevitable con pairings aún pendientes (0074). BO1/BO3: winrate
  -- proyectado, sin cambios. BO2: puntos totales absolutos (peor caso del candidato = puntos
  -- actuales sin sumar nada de sus pendientes; mejor caso de cada rival = puntos actuales + 3
  -- por cada pendiente que le queda, asumiendo que los gana todos). Quien tiene left_event_at
  -- seteado no puede ser candidato (no va a jugar más) ni contar como amenaza (no puede alcanzar
  -- a nadie si no va a jugar más).
  if v_pending_pairings_total > v_pending_pairings_blocked and v_event_champion_user_id is null then
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

  if v_pending_pairings_total > v_pending_pairings_blocked then return; end if;

  -- Criterio de liderazgo: BO1/BO3 = winrate (won/completed), sin cambios. BO2 = puntos totales
  -- absolutos (won*3 + draws*1), no proporción — "completed" (para el umbral v_min_bo3_required)
  -- sigue siendo pairings resueltos, ahora incluyendo empates. Quien tiene left_event_at seteado
  -- queda afuera del pool de candidatos a campeón.
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

-- ── 5. v_head_to_head_stats: excluir walkover del historial entre dos jugadores específicos.
--       Un pairing con al menos una match walkover queda afuera de bo3_won/bo3_lost (el
--       resultado de la serie fue decidido, al menos en parte, por abandono); las matches
--       individuales walkover quedan afuera de draft_matches_won/lost. bracket_bo3 y
--       revenge_mam no se tocan: walkover en brackets es de una fase posterior, y nunca aplica
--       a match_type='revenge'.
create or replace view public.v_head_to_head_stats as
with
pairing_bo3 as (
  select
    ep_me.user_id,
    ep_opp.user_id                                                                  as opponent_user_id,
    de.workspace_id,
    count(distinct p.id) filter (where p.official_winner_participant_id = ep_me.id)  as bo3_won,
    count(distinct p.id) filter (where p.official_winner_participant_id = ep_opp.id) as bo3_lost
  from public.pairings p
  join public.draft_events de
    on de.id = p.event_id
   and de.deleted_at is null
  join public.event_participants ep_me
    on (p.participant_a_id = ep_me.id or p.participant_b_id = ep_me.id)
   and ep_me.role = 'player'
  join public.event_participants ep_opp
    on (p.participant_a_id = ep_opp.id or p.participant_b_id = ep_opp.id)
   and ep_opp.id <> ep_me.id
   and ep_opp.role = 'player'
  where p.official_winner_participant_id is not null
    and not exists (
      select 1 from public.matches wm
      where wm.pairing_id = p.id and wm.is_walkover = true
    )
  group by ep_me.user_id, ep_opp.user_id, de.workspace_id
),
bracket_bo3 as (
  select
    ep_me.user_id,
    ep_opp.user_id                                                                  as opponent_user_id,
    de.workspace_id,
    count(distinct bm.id) filter (where bm.winner_participant_id = ep_me.id)           as bo3_won,
    count(distinct bm.id) filter (where bm.winner_participant_id = ep_opp.id)          as bo3_lost
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups etg on etg.id = bm.group_id
  join public.draft_events de
    on de.id = etg.event_id
   and de.deleted_at is null
  join public.event_participants ep_me
    on (bm.participant_a_id = ep_me.id or bm.participant_b_id = ep_me.id)
   and ep_me.role = 'player'
  join public.event_participants ep_opp
    on (bm.participant_a_id = ep_opp.id or bm.participant_b_id = ep_opp.id)
   and ep_opp.id <> ep_me.id
   and ep_opp.role = 'player'
  where bm.winner_participant_id is not null
  group by ep_me.user_id, ep_opp.user_id, de.workspace_id
),
bo3_combined as (
  select
    user_id,
    opponent_user_id,
    workspace_id,
    sum(bo3_won)  as pairings_won,
    sum(bo3_lost) as pairings_lost
  from (
    select user_id, opponent_user_id, workspace_id, bo3_won, bo3_lost from pairing_bo3
    union all
    select user_id, opponent_user_id, workspace_id, bo3_won, bo3_lost from bracket_bo3
  ) u
  group by user_id, opponent_user_id, workspace_id
),
official_mam as (
  select
    ep_me.user_id,
    ep_opp.user_id                                                                  as opponent_user_id,
    de.workspace_id,
    count(m.id) filter (where m.winner_participant_id = ep_me.id)                    as draft_matches_won,
    count(m.id) filter (where m.winner_participant_id = ep_opp.id)                   as draft_matches_lost
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  join public.draft_events de
    on de.id = p.event_id
   and de.deleted_at is null
  join public.event_participants ep_me
    on (p.participant_a_id = ep_me.id or p.participant_b_id = ep_me.id)
   and ep_me.role = 'player'
  join public.event_participants ep_opp
    on (p.participant_a_id = ep_opp.id or p.participant_b_id = ep_opp.id)
   and ep_opp.id <> ep_me.id
   and ep_opp.role = 'player'
  where m.status = 'completed'
    and m.winner_participant_id is not null
    and m.match_type in ('draft', 'tiebreak', 'final')
    and m.is_walkover = false
  group by ep_me.user_id, ep_opp.user_id, de.workspace_id
),
revenge_mam as (
  select
    ep_me.user_id,
    ep_opp.user_id                                                                  as opponent_user_id,
    de.workspace_id,
    count(m.id) filter (where m.winner_participant_id = ep_me.id)                    as revenge_matches_won,
    count(m.id) filter (where m.winner_participant_id = ep_opp.id)                   as revenge_matches_lost
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  join public.draft_events de
    on de.id = p.event_id
   and de.deleted_at is null
  join public.event_participants ep_me
    on (p.participant_a_id = ep_me.id or p.participant_b_id = ep_me.id)
   and ep_me.role = 'player'
  join public.event_participants ep_opp
    on (p.participant_a_id = ep_opp.id or p.participant_b_id = ep_opp.id)
   and ep_opp.id <> ep_me.id
   and ep_opp.role = 'player'
  where m.status = 'completed'
    and m.winner_participant_id is not null
    and m.match_type = 'revenge'
  group by ep_me.user_id, ep_opp.user_id, de.workspace_id
),
all_pairs as (
  select user_id, opponent_user_id, workspace_id from bo3_combined
  union
  select user_id, opponent_user_id, workspace_id from official_mam
  union
  select user_id, opponent_user_id, workspace_id from revenge_mam
)
select
  ap.user_id,
  ap.opponent_user_id,
  ap.workspace_id,
  coalesce(b.pairings_won, 0) + coalesce(b.pairings_lost, 0)                       as total_pairings,
  coalesce(b.pairings_won, 0)                                                      as pairings_won,
  coalesce(b.pairings_lost, 0)                                                     as pairings_lost,
  coalesce(o.draft_matches_won, 0)                                                   as draft_matches_won,
  coalesce(o.draft_matches_lost, 0)                                                as draft_matches_lost,
  coalesce(r.revenge_matches_won, 0)                                               as revenge_matches_won,
  coalesce(r.revenge_matches_lost, 0)                                              as revenge_matches_lost,
  coalesce(o.draft_matches_won, 0) + coalesce(r.revenge_matches_won, 0)            as total_matches_won,
  coalesce(o.draft_matches_lost, 0) + coalesce(r.revenge_matches_lost, 0)          as total_matches_lost
from all_pairs ap
left join bo3_combined b
  on b.user_id = ap.user_id
 and b.opponent_user_id = ap.opponent_user_id
 and b.workspace_id = ap.workspace_id
left join official_mam o
  on o.user_id = ap.user_id
 and o.opponent_user_id = ap.opponent_user_id
 and o.workspace_id = ap.workspace_id
left join revenge_mam r
  on r.user_id = ap.user_id
 and r.opponent_user_id = ap.opponent_user_id
 and r.workspace_id = ap.workspace_id;

-- ── 6. v_player_streaks: excluir walkover de la racha de victorias/derrotas. Solo la rama
--       "pairings" (fase regular) puede tener matches walkover en esta fase — la rama de
--       bracket_matches y la de match_type='revenge' quedan igual (walkover de brackets es de
--       una fase posterior, y nunca aplica a 'revenge').
create or replace view public.v_player_streaks as
with encounters as (
  select
    ep.user_id,
    de.workspace_id,
    coalesce(p.official_resolved_at, p.created_at)                                   as result_at,
    case when p.official_winner_participant_id = ep.id then 1 else 0 end             as won
  from public.pairings p
  join public.draft_events de
    on de.id = p.event_id
   and de.deleted_at is null
  join public.event_participants ep
    on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
   and ep.role = 'player'
  where p.official_winner_participant_id is not null
    and not exists (
      select 1 from public.matches wm
      where wm.pairing_id = p.id and wm.is_walkover = true
    )

  union all

  select
    ep.user_id,
    de.workspace_id,
    coalesce(bm.resolved_at, bm.created_at)                                          as result_at,
    case when bm.winner_participant_id = ep.id then 1 else 0 end                     as won
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups etg on etg.id = bm.group_id
  join public.draft_events de
    on de.id = etg.event_id
   and de.deleted_at is null
  join public.event_participants ep
    on (bm.participant_a_id = ep.id or bm.participant_b_id = ep.id)
   and ep.role = 'player'
  where bm.winner_participant_id is not null

  union all

  select
    ep.user_id,
    de.workspace_id,
    coalesce(m.ended_at, m.started_at)                                               as result_at,
    case when m.winner_participant_id = ep.id then 1 else 0 end                       as won
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  join public.draft_events de
    on de.id = p.event_id
   and de.deleted_at is null
  join public.event_participants ep
    on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
   and ep.role = 'player'
  where m.match_type = 'revenge'
    and m.status = 'completed'
    and m.winner_participant_id is not null
),
ordered_results as (
  select
    user_id,
    workspace_id,
    result_at,
    won,
    row_number() over (
      partition by user_id, workspace_id
      order by result_at
    ) as rn
  from encounters
),
grouped as (
  select
    *,
    rn - row_number() over (
      partition by user_id, workspace_id, won
      order by result_at
    ) as grp
  from ordered_results
),
streaks as (
  select user_id, workspace_id, won, grp, count(*) as streak_length
  from grouped
  group by user_id, workspace_id, won, grp
)
select
  user_id,
  workspace_id,
  coalesce(max(streak_length) filter (where won = 1), 0) as longest_win_streak,
  coalesce(max(streak_length) filter (where won = 0), 0) as longest_loss_streak
from streaks
group by user_id, workspace_id;
