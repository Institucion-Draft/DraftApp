-- 0042_extended_stats.sql
-- 1. Reemplaza v_participant_event_placement con soporte correcto para Swiss
--    (top 4 por bracket, posiciones 5+ por swiss_points) y round-robin.
-- 2. Crea v_head_to_head_stats: historial W/L de cada jugador vs cada rival.
-- 3. Crea v_player_streaks: racha más larga de victorias y derrotas.

-- ── 1. v_participant_event_placement ─────────────────────────────────────────

create or replace view public.v_participant_event_placement as
with

bracket_placements as (
  -- Resultados del bracket top-4 para eventos Swiss
  select
    etg.event_id,
    etbm_f.winner_participant_id                              as first_place,
    case when etbm_f.winner_participant_id = etbm_f.participant_a_id
         then etbm_f.participant_b_id
         else etbm_f.participant_a_id end                    as second_place,
    etbm_t.winner_participant_id                              as third_place,
    case when etbm_t.winner_participant_id = etbm_t.participant_a_id
         then etbm_t.participant_b_id
         else etbm_t.participant_a_id end                    as fourth_place
  from public.event_tiebreak_groups etg
  join public.event_tiebreak_bracket_matches etbm_f
    on etbm_f.group_id = etg.id
   and etbm_f.bracket_phase = 'final'
   and etbm_f.winner_participant_id is not null
  join public.event_tiebreak_bracket_matches etbm_t
    on etbm_t.group_id = etg.id
   and etbm_t.bracket_phase = 'third_place'
   and etbm_t.winner_participant_id is not null
  where etg.group_type = 'bracket'
),

bracket_per_participant as (
  -- Una fila por participante que estuvo en el bracket con su puesto exacto
  select event_id, first_place  as participant_id, 1 as bracket_placement from bracket_placements
  union all
  select event_id, second_place as participant_id, 2 as bracket_placement from bracket_placements
  union all
  select event_id, third_place  as participant_id, 3 as bracket_placement from bracket_placements
  union all
  select event_id, fourth_place as participant_id, 4 as bracket_placement from bracket_placements
),

base as (
  select
    ep.id                   as participant_id,
    ep.event_id,
    ep.user_id,
    de.workspace_id,
    de.name                 as event_name,
    de.event_ended_at,
    de.status               as event_status,
    de.scheduled_for,
    de.competition_format,
    ep.swiss_points,
    ep.swiss_omw,
    ep.swiss_gw,
    ep.swiss_ogw,
    bpp.bracket_placement,
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
    )                       as matches_completed,
    count(*) over (partition by ep.event_id) as total_players
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.deleted_at is null
  left join bracket_per_participant bpp
    on bpp.event_id = ep.event_id
   and bpp.participant_id = ep.id
  left join public.pairings p
    on p.event_id = ep.event_id
   and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  left join public.matches m
    on m.pairing_id = p.id
  where ep.role = 'player'
  group by
    ep.id, ep.event_id, ep.user_id,
    de.workspace_id, de.name, de.event_ended_at, de.status, de.scheduled_for,
    de.competition_format, ep.swiss_points, ep.swiss_omw, ep.swiss_gw, ep.swiss_ogw,
    bpp.bracket_placement
),

with_ranks as (
  select
    *,
    rank() over (
      partition by event_id
      order by
        coalesce(swiss_points, 0) desc,
        coalesce(swiss_omw, 0) desc,
        coalesce(swiss_gw, 0) desc,
        coalesce(swiss_ogw, 0) desc
    ) as swiss_rank,
    rank() over (
      partition by event_id
      order by
        case when bo3_completed > 0 then bo3_won::numeric / bo3_completed else 0 end desc,
        case when matches_completed > 0 then matches_won::numeric / matches_completed else 0 end desc
    ) as rr_rank
  from base
)

select
  participant_id,
  event_id,
  user_id,
  workspace_id,
  event_name,
  event_ended_at,
  event_status,
  scheduled_for,
  bo3_won,
  bo3_completed,
  matches_won,
  matches_completed,
  total_players,
  case
    -- Swiss con bracket completo: puestos 1-4 del bracket
    when competition_format = 'swiss' and bracket_placement is not null then bracket_placement
    -- Swiss sin bracket (o posiciones 5+): por swiss_points
    when competition_format = 'swiss'                                    then swiss_rank
    -- Round-robin: por BO3 win rate → match win rate
    else                                                                      rr_rank
  end as placement
from with_ranks;

grant select on public.v_participant_event_placement to anon, authenticated;


-- ── 2. v_head_to_head_stats ──────────────────────────────────────────────────

create or replace view public.v_head_to_head_stats as
select
  ep_me.user_id,
  ep_opp.user_id                                                                  as opponent_user_id,
  de.workspace_id,
  count(distinct p.id)                                                             as total_pairings,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep_me.id)  as pairings_won,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep_opp.id) as pairings_lost
from public.pairings p
join public.draft_events de
  on de.id = p.event_id
 and de.deleted_at is null
join public.event_participants ep_me
  on (p.participant_a_id = ep_me.id or p.participant_b_id = ep_me.id)
 and ep_me.role = 'player'
join public.event_participants ep_opp
  on (p.participant_a_id = ep_opp.id or p.participant_b_id = ep_opp.id)
 and ep_opp.id != ep_me.id
 and ep_opp.role = 'player'
where p.official_winner_participant_id is not null
group by ep_me.user_id, ep_opp.user_id, de.workspace_id;

grant select on public.v_head_to_head_stats to anon, authenticated;


-- ── 3. v_player_streaks ───────────────────────────────────────────────────────

create or replace view public.v_player_streaks as
with ordered_results as (
  select
    ep.user_id,
    de.workspace_id,
    p.created_at                                                       as result_at,
    case when p.official_winner_participant_id = ep.id then 1 else 0 end as won,
    row_number() over (
      partition by ep.user_id, de.workspace_id
      order by p.created_at
    ) as rn
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.deleted_at is null
  join public.pairings p
    on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
   and p.official_winner_participant_id is not null
  where ep.role = 'player'
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

grant select on public.v_player_streaks to anon, authenticated;
