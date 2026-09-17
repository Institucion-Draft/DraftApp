-- 0108_workspace_ranking_placements.sql
--
-- Ranking Global: agrega conteo de 2° y 3° puesto por jugador (mismo concepto que "Copas", que
-- ya cuenta 1° vía champion_user_id), usando exactamente las mismas 3 fuentes de verdad ya
-- identificadas para "Puntos" en 0107: champion_user_id (1°, no usado acá), event_tiebreak_
-- bracket_matches (2°/3°/4° del bracket real de round_robin_topcut/swiss_topcut) y el dense_rank
-- de puntaje de fase regular para round_robin SIN top4.
--
-- Antes de duplicar la lógica de dense_rank de round_robin-sin-top4 (ya vive inline dentro de
-- v_workspace_points, 0107) en una segunda vista, se extrae a v_rr_no_top_regular_rank — una
-- vista propia y reusable por ambos consumidores (v_workspace_points la usa para saber quién es
-- 2°/3° a efectos de puntaje; esta migración la reusa para contar CUÁNTAS VECES cada quien llegó
-- a esa posición). Mantener esto en dos copias del mismo window function hubiera sido el tipo de
-- cosa que diverge sola con el tiempo — acá no hay motivo para duplicarlo, es la misma pregunta
-- ("dense_rank de puntaje de fase regular, round_robin sin top4, excluyendo al campeón") las dos
-- veces. v_workspace_points se re-crea (create or replace, mismas 3 columnas de salida en el
-- mismo orden — compatible) para leer de la vista nueva en vez de su CTE inline original.
--
-- El bracket real (bracket_placement en 0107) NO se extrae a una vista compartida: ahí solo se
-- reusa el MISMO patrón de filtros (group_origin/status/de.status), no una computación con estado
-- (como el window function de arriba) — duplicarlo como CTE es el mismo criterio que ya usa el
-- resto del repo (la exclusión de 2HG, por ejemplo, está copiada literal en 5 vistas distintas,
-- sin una vista base compartida).

-- ===========================================================================
-- 1. v_rr_no_top_regular_rank: extraída de v_workspace_points (0107) sin cambios de lógica.
-- ===========================================================================
create or replace view public.v_rr_no_top_regular_rank as
with rr_no_top_points as (
  select
    ep.id as participant_id,
    ep.user_id,
    de.id as event_id,
    de.workspace_id,
    coalesce(sum(
      case
        when p.official_winner_participant_id = ep.id
          then (case when de.match_format = 'bo2' then 3 else 1 end)
        when p.official_winner_participant_id is null
          and p.official_draw = true
          and de.match_format = 'bo2'
          and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
          then 1
        else 0
      end
    ), 0) as points
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.competition_format = 'round_robin'
   and de.top_size is null
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
   and de.champion_user_id is not null
  left join public.pairings p
    on p.event_id = de.id
   and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  where ep.role = 'player'
    and ep.left_event_at is null
    and ep.user_id <> de.champion_user_id
  group by ep.id, ep.user_id, de.id, de.workspace_id
)
select
  participant_id,
  user_id,
  event_id,
  workspace_id,
  dense_rank() over (partition by event_id order by points desc) as pos_rank
from rr_no_top_points;

grant select on public.v_rr_no_top_regular_rank to anon, authenticated;

-- ===========================================================================
-- 2. v_workspace_points: mismo resultado, ahora leyendo el ranking desde la vista compartida.
-- ===========================================================================
create or replace view public.v_workspace_points as
with liga_first_bonus as (
  select gp.user_id, de.workspace_id, 4 as points
  from public.event_tiebreak_group_participants gp
  join public.event_tiebreak_groups g on g.id = gp.group_id
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
  where g.group_type = 'bracket'
    and g.group_origin = 'round_robin_topcut'
    and g.status <> 'superseded'
    and gp.seed = 1
),
bracket_placement as (
  select ep.user_id, de.workspace_id, pts.points
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
  cross join lateral (
    values
      (bm.participant_a_id, case
        when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_a_id then 10 else 6 end)
        when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_a_id then 4 else 2 end)
      end),
      (bm.participant_b_id, case
        when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_b_id then 10 else 6 end)
        when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_b_id then 4 else 2 end)
      end)
  ) as pts(participant_id, points)
  join public.event_participants ep on ep.id = pts.participant_id
  where bm.bracket_phase in ('final', 'third_place')
    and bm.winner_participant_id is not null
),
rr_no_top_champion as (
  select ep.user_id, de.workspace_id, 10 as points
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id
   and ep.user_id = de.champion_user_id
   and ep.role = 'player'
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
rr_no_top_placement as (
  select user_id, workspace_id,
    case pos_rank when 1 then 6 when 2 then 4 when 3 then 2 else 0 end as points
  from public.v_rr_no_top_regular_rank
  where pos_rank <= 3
),
all_points as (
  select user_id, workspace_id, points from liga_first_bonus
  union all
  select user_id, workspace_id, points from bracket_placement
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
-- 3. v_workspace_placements: conteo de veces 2° y 3° puesto, por (user_id, workspace_id).
--    "Copas" (1°) ya existe en v_player_workspace_stats.championships — no se toca acá.
-- ===========================================================================
create or replace view public.v_workspace_placements as
with bracket_second as (
  -- Round Robin CON top4 y Suizo: 2° = perdedor de la fila 'final' del bracket real.
  select ep.user_id, de.workspace_id
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
  join public.event_participants ep
    on ep.id = (case when bm.winner_participant_id = bm.participant_a_id then bm.participant_b_id else bm.participant_a_id end)
  where bm.bracket_phase = 'final'
    and bm.winner_participant_id is not null
),
bracket_third as (
  -- 3° = ganador de la fila 'third_place'.
  select ep.user_id, de.workspace_id
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
  join public.event_participants ep
    on ep.id = bm.winner_participant_id
  where bm.bracket_phase = 'third_place'
    and bm.winner_participant_id is not null
),
rr_no_top_second as (
  select user_id, workspace_id from public.v_rr_no_top_regular_rank where pos_rank = 1
),
rr_no_top_third as (
  select user_id, workspace_id from public.v_rr_no_top_regular_rank where pos_rank = 2
),
seconds as (
  select user_id, workspace_id from bracket_second
  union all
  select user_id, workspace_id from rr_no_top_second
),
thirds as (
  select user_id, workspace_id from bracket_third
  union all
  select user_id, workspace_id from rr_no_top_third
),
second_counts as (
  select user_id, workspace_id, count(*) as second_places
  from seconds
  group by user_id, workspace_id
),
third_counts as (
  select user_id, workspace_id, count(*) as third_places
  from thirds
  group by user_id, workspace_id
),
keys as (
  select user_id, workspace_id from second_counts
  union
  select user_id, workspace_id from third_counts
)
select
  k.user_id,
  k.workspace_id,
  coalesce(sc.second_places, 0) as second_places,
  coalesce(tc.third_places, 0) as third_places
from keys k
left join second_counts sc on sc.user_id = k.user_id and sc.workspace_id = k.workspace_id
left join third_counts tc on tc.user_id = k.user_id and tc.workspace_id = k.workspace_id;

grant select on public.v_workspace_placements to anon, authenticated;
