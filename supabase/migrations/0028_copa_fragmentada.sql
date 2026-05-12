-- 0028_copa_fragmentada.sql
-- Empate de 5+ líderes en primer lugar: Copa Fragmentada para todos.
-- Reusa polemica_winners para guardar los user_ids.
-- Distingue por champion_decided_by = 'fragmentada'.

alter table public.draft_events
  drop constraint if exists draft_events_champion_decision_valid;

alter table public.draft_events
  add constraint draft_events_champion_decision_valid
  check (champion_decided_by is null or champion_decided_by in ('auto', 'manual_override', 'tiebreak', 'polemica', 'fragmentada'));

-- Cambiar la rama de 5+ en compute_event_champion para usar 'fragmentada'
create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
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
begin
  select status, champion_user_id into v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;
  if v_event_champion_user_id is not null then return; end if;

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
  if v_pending_pairings_total > v_pending_pairings_blocked then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

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
      status = 'completed', final_pending = false where id = p_event_id and champion_user_id is null;
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
