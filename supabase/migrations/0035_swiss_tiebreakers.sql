-- 0035_swiss_tiebreakers.sql
-- Cálculo de tiebreakers del sistema suizo:
-- OMW% = promedio del match win rate de los oponentes (clampado a mínimo 0.33).
-- GW%  = game win rate propio (partidas individuales ganadas / jugadas).
-- OGW% = promedio del GW% de los oponentes.

-- Match win rate de un participant: BO3 ganados / BO3 jugados (solo swiss_round no null).
-- El bye cuenta como BO3 ganado para los puntos, pero NO para el match win rate
-- (un bye no es una victoria "real" sobre un oponente).
create or replace function public.swiss_match_winrate(p_event_id uuid, p_participant_id uuid)
returns numeric
language plpgsql
stable
as $$
declare
  v_played integer;
  v_won integer;
begin
  select count(*) into v_played
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id is not null
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  select count(*) into v_won
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id = p_participant_id;

  if v_played = 0 then return 0; end if;
  return v_won::numeric / v_played;
end;
$$;

-- Game win rate: partidas individuales (matches) ganadas / jugadas, solo en pairings oficiales suizos.
create or replace function public.swiss_game_winrate(p_event_id uuid, p_participant_id uuid)
returns numeric
language plpgsql
stable
as $$
declare
  v_played integer;
  v_won integer;
begin
  select count(*) into v_played
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  where p.event_id = p_event_id
    and p.swiss_round is not null
    and m.match_type = 'draft'
    and m.status = 'completed'
    and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id);

  select count(*) into v_won
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  where p.event_id = p_event_id
    and p.swiss_round is not null
    and m.match_type = 'draft'
    and m.status = 'completed'
    and m.winner_participant_id = p_participant_id;

  if v_played = 0 then return 0; end if;
  return v_won::numeric / v_played;
end;
$$;

-- Lista de oponentes de un participant en rondas suizas (excluye byes).
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
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  return coalesce(v_opponents, '{}');
end;
$$;

-- Recalcula y persiste swiss_omw, swiss_gw, swiss_ogw de todos los participants del evento.
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
      -- Clamp a mínimo 0.33 (regla oficial Wizards).
      if v_opp_mw < 0.33 then v_opp_mw := 0.33; end if;
      v_omw_sum := v_omw_sum + v_opp_mw;
      v_omw_count := v_omw_count + 1;

      v_opp_gw := public.swiss_game_winrate(p_event_id, v_opp);
      if v_opp_gw < 0.33 then v_opp_gw := 0.33; end if;
      v_ogw_sum := v_ogw_sum + v_opp_gw;
      v_ogw_count := v_ogw_count + 1;
    end loop;

    update public.event_participants
    set swiss_points = public.swiss_points_of(p_event_id, v_participant.id),
        swiss_gw = public.swiss_game_winrate(p_event_id, v_participant.id),
        swiss_omw = case when v_omw_count > 0 then v_omw_sum / v_omw_count else null end,
        swiss_ogw = case when v_ogw_count > 0 then v_ogw_sum / v_ogw_count else null end
    where id = v_participant.id;
  end loop;
end;
$$;

-- Trigger: recalcular tiebreakers cada vez que un pairing suizo se resuelve.
create or replace function public.on_swiss_pairing_recalc_tiebreakers()
returns trigger
language plpgsql
security definer
as $$
declare
  v_format text;
begin
  if new.swiss_round is null then return new; end if;
  if new.official_winner_participant_id is null then return new; end if;

  select competition_format into v_format
  from public.draft_events where id = new.event_id;
  if v_format <> 'swiss' then return new; end if;

  perform public.recalc_swiss_tiebreakers(new.event_id);
  return new;
end;
$$;

drop trigger if exists on_aa_swiss_pairing_resolved_recalc on public.pairings;
create trigger on_aa_swiss_pairing_resolved_recalc
after update on public.pairings
for each row
when (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
execute function public.on_swiss_pairing_recalc_tiebreakers();
