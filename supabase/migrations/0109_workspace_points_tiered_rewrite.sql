-- 0109_workspace_points_tiered_rewrite.sql
--
-- Rediseño completo del sistema de "Puntos" de Ranking Global — reemplaza por completo el
-- sistema anterior (0107/0108: 10/6/4/2 + bono de "1° de liga"). El bug reportado sobre ese
-- sistema (Esteban con 28 puntos en vez de 36) queda descartado junto con el sistema entero, no
-- se debuggea.
--
-- Sistema nuevo: solo top3 (nada para 4° en adelante), puntaje por escalones según la cantidad
-- de jugadores (role='player') del evento:
--   4-6 jugadores:  5 / 3 / 2  (1°/2°/3°)
--   7-9 jugadores:  7 / 4 / 3
--   10-12 jugadores: 9 / 6 / 4
--   13+ jugadores:  12 / 8 / 5
-- Eventos de menos de 4 jugadores: 0 puntos (la tabla no define nada por debajo de 4 — no hay
-- top3 real posible ahí de cualquier forma. Sin bono de "1° de liga": ese concepto se elimina
-- del sistema entero, round_robin CON top4 ya no otorga nada distinto a lo que otorga el bracket
-- real).
--
-- Fuentes de verdad, sin cambios respecto a 0107/0108 — solo hasta 3° en vez de hasta 4°:
--   - Round Robin/Suizo CON top4: 1°=ganador de 'final', 2°=perdedor de 'final', 3°=ganador de
--     'third_place'. Mismo timing por instancia (cada fila otorga sus puntos en cuanto ESA fila
--     tiene winner_participant_id, no cuando el evento pasa a status='completed' — ver 0107 para
--     el razonamiento completo). El perdedor de 'third_place' (4° puesto) ya no otorga nada.
--   - Round Robin SIN top4: 1°=champion_user_id (único, desempate real ya implementado). 2°/3°
--     = pos_rank 1/2 de v_rr_no_top_regular_rank (dense_rank de puntaje de fase regular
--     excluyendo al campeón — empate exacto en puntaje = comparten escalón, mismos puntos). Ya
--     no se lee pos_rank=3 (el viejo "4°" del sistema anterior): sin puntos para esa posición.
-- Todo gateado por status in ('completed','concluded'), excluyendo 2HG — igual que siempre.
--
-- v_workspace_placements (0108) NO se toca: ya contaba únicamente 2°/3° (nunca tuvo un
-- "fourth_places"), así que ya era "solo top3" antes de que se lo pidiéramos — confirmado
-- releyendo bracket_second/bracket_third/rr_no_top_second/rr_no_top_third, ninguna de las 4
-- mira 4° puesto. v_rr_no_top_regular_rank tampoco cambia (sigue siendo el mismo dense_rank de
-- siempre; lo nuevo es hasta dónde se LEE ese ranking, no cómo se calcula).
--
-- Columna nueva: #PE (participaciones en eventos) — cantidad de eventos completed/concluded, sin
-- 2HG, donde el usuario jugó como role='player', sin importar el resultado. Se agrega a
-- v_player_workspace_stats (que ya es el hub de agregados por usuario/workspace que consume la
-- pantalla) en vez de crear una vista nueva para una sola columna — mismo join ya existente a
-- draft_events, un FILTER más.

-- ===========================================================================
-- 1. Helper: puntos según cantidad de jugadores del evento y posición final (1/2/3).
-- ===========================================================================
create or replace function public.workspace_ranking_points(p_player_count integer, p_position integer)
returns integer
language sql
immutable
as $$
  select case
    when p_player_count < 4 then 0
    when p_player_count <= 6 then (case p_position when 1 then 5 when 2 then 3 when 3 then 2 else 0 end)
    when p_player_count <= 9 then (case p_position when 1 then 7 when 2 then 4 when 3 then 3 else 0 end)
    when p_player_count <= 12 then (case p_position when 1 then 9 when 2 then 6 when 3 then 4 else 0 end)
    else (case p_position when 1 then 12 when 2 then 8 when 3 then 5 else 0 end)
  end;
$$;

-- ===========================================================================
-- 2. v_workspace_points: reescrita desde cero con el sistema de escalones, solo top3.
-- ===========================================================================
create or replace view public.v_workspace_points as
with event_player_counts as (
  select event_id, count(*)::integer as player_count
  from public.event_participants
  where role = 'player'
  group by event_id
),
bracket_top3 as (
  -- Round Robin CON top4 y Suizo (siempre con top4): 1°/2° de la fila 'final', 3° del ganador
  -- de 'third_place'. El perdedor de 'third_place' (4°) no genera fila (position null, se
  -- descarta más abajo).
  select
    ep.user_id,
    de.workspace_id,
    public.workspace_ranking_points(epc.player_count, pts.position) as points
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g
    on g.id = bm.group_id
   and g.group_origin in ('round_robin_topcut', 'swiss_topcut')
   and g.status <> 'superseded'
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
  join event_player_counts epc on epc.event_id = de.id
  cross join lateral (
    values
      (bm.participant_a_id, case
        when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_a_id then 1 else 2 end)
        when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_a_id then 3 else null end)
      end),
      (bm.participant_b_id, case
        when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_b_id then 1 else 2 end)
        when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_b_id then 3 else null end)
      end)
  ) as pts(participant_id, position)
  join public.event_participants ep on ep.id = pts.participant_id
  where bm.bracket_phase in ('final', 'third_place')
    and bm.winner_participant_id is not null
    and pts.position is not null
),
rr_no_top_champion as (
  -- Round Robin SIN top4: 1° = champion_user_id, siempre único.
  select
    ep.user_id,
    de.workspace_id,
    public.workspace_ranking_points(epc.player_count, 1) as points
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id
   and ep.user_id = de.champion_user_id
   and ep.role = 'player'
  join event_player_counts epc on epc.event_id = de.id
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
rr_no_top_placement as (
  -- 2°/3° = pos_rank 1/2 de v_rr_no_top_regular_rank (pos_rank 3, el viejo "4°", ya no se lee).
  select
    r.user_id,
    r.workspace_id,
    public.workspace_ranking_points(epc.player_count, (r.pos_rank + 1)::integer) as points
  from public.v_rr_no_top_regular_rank r
  join event_player_counts epc on epc.event_id = r.event_id
  where r.pos_rank <= 2
),
all_points as (
  select user_id, workspace_id, points from bracket_top3
  union all
  select user_id, workspace_id, points from rr_no_top_champion
  union all
  select user_id, workspace_id, points from rr_no_top_placement
)
select user_id, workspace_id, sum(points)::integer as points
from all_points
group by user_id, workspace_id;

grant select on public.v_workspace_points to anon, authenticated;

-- ===========================================================================
-- 3. v_player_workspace_stats: agrega #PE (completed_events_as_player). Resto sin cambios
--    respecto a 0107 (2HG ya excluido, EJ/PJ ya incluyen bracket real).
-- ===========================================================================
drop view if exists public.v_player_workspace_stats;

create view public.v_player_workspace_stats as
with bracket_pairings as (
  select
    ep.user_id,
    de.workspace_id,
    count(distinct bm.id) filter (where bm.winner_participant_id = ep.id) as won,
    count(distinct bm.id) filter (
      where bm.winner_participant_id is not null and bm.winner_participant_id <> ep.id
    ) as lost
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups etg on etg.id = bm.group_id
  join public.draft_events de
    on de.id = etg.event_id
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
  join public.event_participants ep
    on (bm.participant_a_id = ep.id or bm.participant_b_id = ep.id)
   and ep.role = 'player'
  group by ep.user_id, de.workspace_id
)
select
  ep.user_id,
  de.workspace_id,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep.id)
    + coalesce(max(bp.won), 0) as pairings_won,
  count(distinct p.id) filter (
    where p.official_winner_participant_id is not null and p.official_winner_participant_id <> ep.id
  ) + coalesce(max(bp.lost), 0) as pairings_lost,
  count(distinct p.id) filter (where p.official_winner_participant_id is null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as pairings_pending,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type in ('draft', 'tiebreak', 'final')) as draft_matches_won,
  count(m.id) filter (
    where m.winner_participant_id is not null
      and m.winner_participant_id <> ep.id
      and m.match_type in ('draft', 'tiebreak', 'final')
      and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as draft_matches_lost,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type = 'revenge') as revenge_matches_won,
  count(m.id) filter (where m.winner_participant_id is not null and m.winner_participant_id <> ep.id and m.match_type = 'revenge' and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as revenge_matches_lost,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.status = 'completed') as total_matches_won,
  count(m.id) filter (
    where m.winner_participant_id is not null
      and m.winner_participant_id <> ep.id
      and m.status = 'completed'
      and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as total_matches_lost,
  count(distinct p.id) filter (where p.super_cup_winner_participant_id = ep.id) as super_cups_won,
  count(distinct de.id) filter (where de.champion_user_id = ep.user_id) as championships,
  count(distinct de.id) filter (where ep.role = 'player') as events_as_player,
  count(distinct de.id) filter (where ep.role = 'ghost') as events_as_ghost,
  count(distinct de.id) filter (where ep.role = 'player' and de.status in ('completed', 'concluded')) as completed_events_as_player,
  avg(extract(epoch from (m.ended_at - m.started_at)) / 60) filter (
    where m.status = 'completed'
    and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as avg_match_duration_minutes
from public.event_participants ep
join public.draft_events de
  on de.id = ep.event_id
 and de.deleted_at is null
 and de.event_type <> 'two_headed_giant'
left join public.pairings p on p.event_id = de.id and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
left join public.matches m on m.pairing_id = p.id
left join bracket_pairings bp on bp.user_id = ep.user_id and bp.workspace_id = de.workspace_id
group by ep.user_id, de.workspace_id;

grant select on public.v_player_workspace_stats to anon, authenticated;
