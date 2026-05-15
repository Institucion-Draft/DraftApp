-- 0038_bracket_group_origin.sql
-- Distingue si un event_tiebreak_group viene de un desempate o del top cut suizo.

alter table public.event_tiebreak_groups
  add column if not exists group_origin text not null default 'tiebreak',
  add constraint event_tiebreak_groups_origin_valid
    check (group_origin in ('tiebreak', 'swiss_topcut'));

-- maybe_advance_swiss_round debe crear el bracket con group_origin = 'swiss_topcut'.
-- Como create_bracket_tiebreak_group no recibe ese parámetro, lo seteamos después de crearlo.

create or replace function public.maybe_advance_swiss_round()
returns trigger
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_current_round integer;
  v_total_rounds integer;
  v_pending_pairings integer;
  v_event_format text;
  v_top4 uuid[];
  v_new_group_id uuid;
begin
  if new.official_winner_participant_id is null then return new; end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  select competition_format, current_swiss_round, swiss_rounds_total
  into v_event_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_event_format <> 'swiss' then return new; end if;
  if v_current_round is null then return new; end if;

  select count(*) into v_pending_pairings
  from public.pairings
  where event_id = v_event_id
    and swiss_round = v_current_round
    and official_winner_participant_id is null;

  if v_pending_pairings > 0 then return new; end if;

  if v_current_round < v_total_rounds then
    perform public.generate_swiss_round(v_event_id, v_current_round + 1);
    return new;
  end if;

  -- Última ronda: generar bracket de top 4.
  select array_agg(ep.id order by public.swiss_points_of(v_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc,
                                     coalesce(ep.swiss_gw, 0) desc,
                                     coalesce(ep.swiss_ogw, 0) desc)
  into v_top4
  from public.event_participants ep
  where ep.event_id = v_event_id and ep.role = 'player' and ep.left_event_at is null;

  if v_top4 is not null and array_length(v_top4, 1) >= 4 then
    v_top4 := v_top4[1:4];
    v_new_group_id := public.create_bracket_tiebreak_group(v_event_id, v_top4);
    update public.event_tiebreak_groups
    set group_origin = 'swiss_topcut'
    where id = v_new_group_id;
  end if;

  return new;
end;
$$;
