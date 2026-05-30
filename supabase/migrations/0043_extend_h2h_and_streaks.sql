-- 0043_extend_h2h_and_streaks.sql
-- Corrige totales de partidas, H2H (Oficiales Bo3/MaM + venganzas) y rachas cross-evento.

-- ── 1. v_player_workspace_stats: totales de todas las partidas completadas ───

drop view if exists public.v_player_workspace_stats;
create view public.v_player_workspace_stats as
select
  ep.user_id,
  de.workspace_id,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep.id) as pairings_won,
  count(distinct p.id) filter (where p.official_winner_participant_id is not null and p.official_winner_participant_id <> ep.id) as pairings_lost,
  count(distinct p.id) filter (where p.official_winner_participant_id is null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as pairings_pending,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type = 'draft') as draft_matches_won,
  count(m.id) filter (where m.winner_participant_id is not null and m.winner_participant_id <> ep.id and m.match_type = 'draft' and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draft_matches_lost,
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
  avg(extract(epoch from (m.ended_at - m.started_at)) / 60) filter (
    where m.status = 'completed'
    and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as avg_match_duration_minutes
from public.event_participants ep
join public.draft_events de on de.id = ep.event_id and de.deleted_at is null
left join public.pairings p on p.event_id = de.id and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
left join public.matches m on m.pairing_id = p.id and m.status = 'completed'
group by ep.user_id, de.workspace_id;

grant select on public.v_player_workspace_stats to anon, authenticated;


-- ── 2. v_head_to_head_stats ──────────────────────────────────────────────────

drop view if exists public.v_head_to_head_stats;
create view public.v_head_to_head_stats as
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

grant select on public.v_head_to_head_stats to anon, authenticated;


-- ── 3. v_player_streaks ───────────────────────────────────────────────────────

drop view if exists public.v_player_streaks;
create view public.v_player_streaks as
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

grant select on public.v_player_streaks to anon, authenticated;
