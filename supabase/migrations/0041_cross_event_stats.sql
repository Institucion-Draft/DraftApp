-- v_participant_event_placement
-- Calcula el puesto de cada jugador en cada evento.
-- Criterio: % de enfrentamientos ganados (BO3) → % de partidas draft ganadas.
-- Empates comparten el mismo puesto (RANK, no ROW_NUMBER).

create or replace view public.v_participant_event_placement as
with event_stats as (
  select
    ep.id                   as participant_id,
    ep.event_id,
    ep.user_id,
    de.workspace_id,
    de.name                 as event_name,
    de.event_ended_at,
    de.status               as event_status,
    de.scheduled_for,
    count(distinct p.id) filter (
      where p.official_winner_participant_id = ep.id
    )                       as bo3_won,
    count(distinct p.id) filter (
      where p.official_winner_participant_id is not null
        and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
    )                       as bo3_completed,
    count(m.id) filter (
      where m.winner_participant_id = ep.id
        and m.match_type = 'draft'
        and m.status = 'completed'
    )                       as matches_won,
    count(m.id) filter (
      where m.status = 'completed'
        and m.match_type = 'draft'
    )                       as matches_completed
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.deleted_at is null
  left join public.pairings p
    on p.event_id = ep.event_id
   and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  left join public.matches m
    on m.pairing_id = p.id
  where ep.role = 'player'
  group by
    ep.id, ep.event_id, ep.user_id,
    de.workspace_id, de.name, de.event_ended_at, de.status, de.scheduled_for
),
ranked as (
  select
    *,
    rank() over (
      partition by event_id
      order by
        case when bo3_completed > 0
             then bo3_won::numeric / bo3_completed
             else 0
        end desc,
        case when matches_completed > 0
             then matches_won::numeric / matches_completed
             else 0
        end desc
    ) as placement,
    count(*) over (partition by event_id) as total_players
  from event_stats
)
select * from ranked;

grant select on public.v_participant_event_placement to anon, authenticated;


-- v_player_color_stats
-- Agrega la cantidad de veces que un jugador eligió cada color MTG en el workspace.

create or replace view public.v_player_color_stats as
with color_counts as (
  select
    ep.user_id,
    de.workspace_id,
    pc.color,
    count(*) as times_played
  from public.participant_colors pc
  join public.event_participants ep
    on ep.id = pc.participant_id
  join public.draft_events de
    on de.id = ep.event_id
   and de.deleted_at is null
  where ep.role = 'player'
  group by ep.user_id, de.workspace_id, pc.color
),
totals as (
  select
    user_id,
    workspace_id,
    sum(times_played) as total_color_picks
  from color_counts
  group by user_id, workspace_id
)
select
  cc.user_id,
  cc.workspace_id,
  cc.color,
  cc.times_played,
  t.total_color_picks,
  round(cc.times_played::numeric / t.total_color_picks * 100, 1) as percentage
from color_counts cc
join totals t using (user_id, workspace_id);

grant select on public.v_player_color_stats to anon, authenticated;
