-- 0114_workspace_points_breakdown_venue_cube_duration.sql
--
-- Extiende v_workspace_points_breakdown con sede (venue), cubo y duración del draft, para el
-- desplegable de "Detalle de puntos" (PlayerPointsDetailScreen). draft_events ya tiene todo lo
-- necesario (0001_initial_schema.sql): cube_id/venue_id (con nombre en cubes.name/venues.name)
-- y draft_started_at/draft_ended_at para calcular duración — nada de esto se agrega a la tabla
-- base, se lee tal cual ya existe.
--
-- Mismo criterio de 0113: las columnas nuevas van al FINAL de cada select y del union all final
-- (create or replace view no permite reordenar/insertar columnas existentes, solo agregar al
-- final — 42P16 si no se respeta).

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
    de.scheduled_for, de.competition_format, de.top_size,
    v.name as venue_name, c.name as cube_name, de.draft_started_at, de.draft_ended_at
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
  left join public.venues v on v.id = de.venue_id
  left join public.cubes c on c.id = de.cube_id
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
    de.scheduled_for, de.competition_format, de.top_size,
    v.name as venue_name, c.name as cube_name, de.draft_started_at, de.draft_ended_at
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id and ep.user_id = de.champion_user_id and ep.role = 'player'
  join event_player_counts epc on epc.event_id = de.id
  left join public.venues v on v.id = de.venue_id
  left join public.cubes c on c.id = de.cube_id
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
    de.scheduled_for, de.competition_format, de.top_size,
    v.name as venue_name, c.name as cube_name, de.draft_started_at, de.draft_ended_at
  from public.v_rr_no_top_regular_rank r
  join public.draft_events de on de.id = r.event_id
  join event_player_counts epc on epc.event_id = r.event_id
  left join public.venues v on v.id = de.venue_id
  left join public.cubes c on c.id = de.cube_id
  where r.pos_rank <= 2
)
select user_id, workspace_id, event_id, event_name, player_count, position, points,
       scheduled_for, competition_format, top_size, venue_name, cube_name, draft_started_at, draft_ended_at
from bracket_rows
union all
select user_id, workspace_id, event_id, event_name, player_count, position, points,
       scheduled_for, competition_format, top_size, venue_name, cube_name, draft_started_at, draft_ended_at
from champion_rows
union all
select user_id, workspace_id, event_id, event_name, player_count, position, points,
       scheduled_for, competition_format, top_size, venue_name, cube_name, draft_started_at, draft_ended_at
from placement_rows;

grant select on public.v_workspace_points_breakdown to anon, authenticated;
