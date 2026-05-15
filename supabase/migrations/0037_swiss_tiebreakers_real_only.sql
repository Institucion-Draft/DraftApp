-- 0037_swiss_tiebreakers_real_only.sql
-- swiss_opponents y swiss_game_winrate solo cuentan pairings/partidas resueltas.
-- Si un participant solo tuvo bye y pairings sin resolver, sus tiebreakers quedan null.

-- swiss_opponents: solo oponentes de pairings RESUELTOS (official_winner no null).
create or replace function public.swiss_opponents(p_event_id uuid, p_participant_id uuid)
returns uuid[]
language plpgsql
stable
as $$
declare
  v_opponents uuid[];
begin
  select array_agg(
    case when participant_a_id = p_participant_id then participant_b_id
         else participant_a_id end
  ) into v_opponents
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id is not null
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  return coalesce(v_opponents, '{}');
end;
$$;

-- recalc_swiss_tiebreakers: si no hay datos reales, swiss_gw queda null (no 0).
create or replace function public.recalc_swiss_tiebreakers(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_participant record;
  v_opponents uuid[];
  v_opp uuid;
  v_omw_sum numeric;
  v_omw_count integer;
  v_ogw_sum numeric;
  v_ogw_count integer;
  v_opp_mw numeric;
  v_opp_gw numeric;
  v_games_played integer;
  v_gw numeric;
begin
  for v_participant in
    select id from public.event_participants
    where event_id = p_event_id and role = 'player'
  loop
    v_opponents := public.swiss_opponents(p_event_id, v_participant.id);
    v_omw_sum := 0; v_omw_count := 0;
    v_ogw_sum := 0; v_ogw_count := 0;

    foreach v_opp in array v_opponents loop
      v_opp_mw := public.swiss_match_winrate(p_event_id, v_opp);
      if v_opp_mw < 0.33 then v_opp_mw := 0.33; end if;
      v_omw_sum := v_omw_sum + v_opp_mw;
      v_omw_count := v_omw_count + 1;

      v_opp_gw := public.swiss_game_winrate(p_event_id, v_opp);
      if v_opp_gw < 0.33 then v_opp_gw := 0.33; end if;
      v_ogw_sum := v_ogw_sum + v_opp_gw;
      v_ogw_count := v_ogw_count + 1;
    end loop;

    -- Game win rate propio: null si no jugó partidas individuales.
    select count(*) into v_games_played
    from public.matches m
    join public.pairings p on p.id = m.pairing_id
    where p.event_id = p_event_id
      and p.swiss_round is not null
      and m.match_type = 'draft'
      and m.status = 'completed'
      and (p.participant_a_id = v_participant.id or p.participant_b_id = v_participant.id);

    if v_games_played = 0 then
      v_gw := null;
    else
      v_gw := public.swiss_game_winrate(p_event_id, v_participant.id);
    end if;

    update public.event_participants
    set swiss_points = public.swiss_points_of(p_event_id, v_participant.id),
        swiss_gw = v_gw,
        swiss_omw = case when v_omw_count > 0 then v_omw_sum / v_omw_count else null end,
        swiss_ogw = case when v_ogw_count > 0 then v_ogw_sum / v_ogw_count else null end
    where id = v_participant.id;
  end loop;
end;
$$;
