-- 0113_workspace_points_breakdown_event_meta.sql
--
-- Extiende v_workspace_points_breakdown con scheduled_for/competition_format/top_size, para que
-- la pantalla "Detalle de puntos" pueda, con una sola query adicional filtrando por event_id (sin
-- filtro de user_id), traer a la vez: el podio COMPLETO de un evento (todos los que sacaron
-- posición ahí, no solo el jugador que se está viendo) y los metadatos de fecha/modo para mostrar
-- en el desplegable — sin una vista nueva ni una query aparte contra draft_events, reusando el
-- mismo join que la vista ya tenía. Mismas 3 ramas/filtros de 0112, sin cambios de lógica de
-- puntos — solo se agregan columnas.
--
-- IMPORTANTE (fix tras error real al aplicar): Postgres no permite que create or replace view
-- cambie el nombre/orden de columnas existentes de una vista ya creada (42P16) — solo permite
-- AGREGAR columnas nuevas al FINAL de la lista. La primera versión de esta migración insertaba
-- scheduled_for/competition_format/top_size en el medio (entre event_name y player_count),
-- corriendo el nombre de player_count a esa posición y rompiendo el replace. Fix: las 3 columnas
-- nuevas van al final, después de points — el orden de las columnas ya existentes
-- (user_id, workspace_id, event_id, event_name, player_count, position, points) queda intacto.

create or replace view public.v_workspace_points_breakdown as
with event_player_counts as (
  select event_id, count(*)::integer as player_count
  from public.event_participants
  where role = 'player'
  group by event_id
),
bracket_rows as (
  select
    ep.user_id, de.workspace_id, de.id as event_id, de.name as event_name,
    epc.player_count, pts.position,
    public.workspace_ranking_points(epc.player_count, pts.position) as points,
    de.scheduled_for, de.competition_format, de.top_size
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
champion_rows as (
  select
    ep.user_id, de.workspace_id, de.id as event_id, de.name as event_name,
    epc.player_count, 1 as position,
    public.workspace_ranking_points(epc.player_count, 1) as points,
    de.scheduled_for, de.competition_format, de.top_size
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id and ep.user_id = de.champion_user_id and ep.role = 'player'
  join event_player_counts epc on epc.event_id = de.id
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
placement_rows as (
  select
    r.user_id, r.workspace_id, de.id as event_id, de.name as event_name,
    epc.player_count, (r.pos_rank + 1)::integer as position,
    public.workspace_ranking_points(epc.player_count, (r.pos_rank + 1)::integer) as points,
    de.scheduled_for, de.competition_format, de.top_size
  from public.v_rr_no_top_regular_rank r
  join public.draft_events de on de.id = r.event_id
  join event_player_counts epc on epc.event_id = r.event_id
  where r.pos_rank <= 2
)
select user_id, workspace_id, event_id, event_name, player_count, position, points, scheduled_for, competition_format, top_size from bracket_rows
union all
select user_id, workspace_id, event_id, event_name, player_count, position, points, scheduled_for, competition_format, top_size from champion_rows
union all
select user_id, workspace_id, event_id, event_name, player_count, position, points, scheduled_for, competition_format, top_size from placement_rows;

grant select on public.v_workspace_points_breakdown to anon, authenticated;
