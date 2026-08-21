-- 0068_round_robin_bo1_top4.sql
-- Nuevo formato: todos contra todos BO1 con top 4 que pasan a bracket.

alter table public.draft_events
  drop constraint if exists draft_events_competition_format_valid;
alter table public.draft_events
  add constraint draft_events_competition_format_valid
  check (competition_format in ('round_robin', 'swiss', 'swiss_bo2', 'round_robin_bo1_top4'));

alter table public.event_tiebreak_groups
  drop constraint if exists event_tiebreak_groups_origin_valid;
alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_origin_valid
  check (group_origin in ('tiebreak', 'swiss_topcut', 'round_robin_topcut'));

-- Crea el bracket top-4 para un evento round_robin_bo1_top4.
-- El cliente llama a esta función solo cuando findGuaranteedTop4 confirma que el top 4
-- es matemáticamente inevitable. La función es idempotente: retorna false si ya existe
-- un bracket o si el evento no aplica.
-- Orden de seeds: victorias desc → OMW% desc (porcentaje de victorias de los rivales).
create or replace function public.create_round_robin_top4_bracket(p_event_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_existing integer;
  v_top4 uuid[];
  v_new_group_id uuid;
begin
  select competition_format into v_format
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin_bo1_top4' then return false; end if;

  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'bracket';

  if v_existing > 0 then return false; end if;

  -- Top 4 por victorias en pairings; desempate por OMW% (media del win-rate de rivales).
  with participant_wins as (
    select ep.id as ep_id,
           count(pr.id) filter (where pr.official_winner_participant_id = ep.id) as wins,
           count(pr.id) filter (where pr.official_winner_participant_id is not null)::float
             as matches_played
    from public.event_participants ep
    left join public.pairings pr on pr.event_id = p_event_id
      and (pr.participant_a_id = ep.id or pr.participant_b_id = ep.id)
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
    group by ep.id
  ),
  omw as (
    select ep.id as ep_id,
           avg(
             case when opp.matches_played > 0
               then opp.wins::float / opp.matches_played
               else 0
             end
           ) as omw_pct
    from public.event_participants ep
    join public.pairings pr on pr.event_id = p_event_id
      and (pr.participant_a_id = ep.id or pr.participant_b_id = ep.id)
    join participant_wins opp on opp.ep_id =
      case when pr.participant_a_id = ep.id then pr.participant_b_id
           else pr.participant_a_id end
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
    group by ep.id
  )
  select array_agg(pw.ep_id order by pw.wins desc, coalesce(o.omw_pct, 0) desc, pw.ep_id)
  into v_top4
  from participant_wins pw
  left join omw o on o.ep_id = pw.ep_id;

  if v_top4 is null or array_length(v_top4, 1) < 4 then return false; end if;

  v_top4 := v_top4[1:4];
  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, v_top4);

  update public.event_tiebreak_groups
  set group_origin = 'round_robin_topcut'
  where id = v_new_group_id;

  return true;
end;
$$;
