-- 0045_swiss_bo2.sql
-- Nuevo formato 'swiss_bo2': sistema suizo donde cada pairing es BO2 y por lo tanto
-- puede terminar en empate. Un pairing empatado otorga 1 punto a cada jugador.
--
-- Estados de un pairing:
--   pendiente: official_draw = false, official_winner_participant_id = null
--   empate:    official_draw = true,  official_winner_participant_id = null
--   ganador:   official_draw = false, official_winner_participant_id = <uuid>
--
-- Puntos: victoria = 3, empate = 1, bye = 3, derrota/pendiente = 0.

-- 1. EMPATES EN PAIRINGS ----------------------------------------------------
alter table public.pairings
  add column if not exists official_draw boolean not null default false;

-- 2. NUEVO FORMATO ----------------------------------------------------------
-- El CHECK de competition_format se definió en 0031 como
--   draft_events_competition_format_valid check (competition_format in ('round_robin', 'swiss'))
-- Lo recreamos incluyendo 'swiss_bo2'.
alter table public.draft_events
  drop constraint if exists draft_events_competition_format_valid;

alter table public.draft_events
  add constraint draft_events_competition_format_valid
    check (competition_format in ('round_robin', 'swiss', 'swiss_bo2'));

-- 3. RONDAS CONFIGURABLES PARA BO2 ------------------------------------------
-- swiss_rounds_total ya existe (0031). Si swiss_rounds_manual no es null,
-- sobreescribe el cálculo automático de rondas para el formato swiss_bo2.
alter table public.draft_events
  add column if not exists swiss_rounds_manual integer
    check (swiss_rounds_manual between 3 and 5);

-- 4. PUNTOS BO2 -------------------------------------------------------------
-- Victoria = 3, empate = 1, bye = 3, derrota/pendiente = 0.
create or replace function public.swiss_bo2_points_of(participant_id uuid, event_id uuid)
returns int
language plpgsql
stable
as $$
declare
  v_wins integer;
  v_draws integer;
  v_byes integer;
begin
  -- Pairings ganados.
  select count(*) into v_wins
  from public.pairings
  where pairings.event_id = swiss_bo2_points_of.event_id
    and swiss_round is not null
    and official_winner_participant_id = swiss_bo2_points_of.participant_id;

  -- Pairings empatados en los que el participant estuvo involucrado.
  select count(*) into v_draws
  from public.pairings
  where pairings.event_id = swiss_bo2_points_of.event_id
    and swiss_round is not null
    and official_draw = true
    and (participant_a_id = swiss_bo2_points_of.participant_id
      or participant_b_id = swiss_bo2_points_of.participant_id);

  -- Byes recibidos.
  select coalesce(array_length(bye_rounds, 1), 0) into v_byes
  from public.event_participants
  where id = swiss_bo2_points_of.participant_id;

  return v_wins * 3 + v_draws * 1 + v_byes * 3;
end;
$$;

-- 5. RECÁLCULO DE TIEBREAKERS PARA BO2 --------------------------------------

-- Oponentes reales de un participant en rondas swiss_bo2: pairings resueltos
-- (con ganador o empate), no pendientes, no byes.
create or replace function public.swiss_bo2_opponents(p_event_id uuid, p_participant_id uuid)
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
    and (official_winner_participant_id is not null or official_draw = true)
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  return coalesce(v_opponents, '{}');
end;
$$;

-- "Match win rate" BO2 de un participant: puntos obtenidos / puntos máximos posibles.
-- Puntos máximos = 3 por cada pairing resuelto (ganador o empate) + 3 por cada bye.
create or replace function public.swiss_bo2_match_winrate(p_event_id uuid, p_participant_id uuid)
returns numeric
language plpgsql
stable
as $$
declare
  v_resolved integer;
  v_byes integer;
  v_max_points integer;
  v_points integer;
begin
  select count(*) into v_resolved
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and (official_winner_participant_id is not null or official_draw = true)
    and (participant_a_id = p_participant_id or participant_b_id = p_participant_id);

  select coalesce(array_length(bye_rounds, 1), 0) into v_byes
  from public.event_participants
  where id = p_participant_id;

  v_max_points := (v_resolved + v_byes) * 3;
  if v_max_points = 0 then return 0; end if;

  v_points := public.swiss_bo2_points_of(p_participant_id, p_event_id);
  return v_points::numeric / v_max_points;
end;
$$;

-- Recalcula y persiste swiss_points, swiss_omw, swiss_gw, swiss_ogw para swiss_bo2.
-- OMW% (clamp 0.33): promedio de (puntos del oponente / max posibles) sobre oponentes reales.
-- GW%: partidas individuales ganadas / jugadas (match_type='draft', status='completed').
-- OGW%: promedio de GW% de cada oponente.
create or replace function public.recalc_swiss_bo2_tiebreakers(p_event_id uuid)
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
    v_opponents := public.swiss_bo2_opponents(p_event_id, v_participant.id);
    v_omw_sum := 0; v_omw_count := 0;
    v_ogw_sum := 0; v_ogw_count := 0;

    foreach v_opp in array v_opponents loop
      v_opp_mw := public.swiss_bo2_match_winrate(p_event_id, v_opp);
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
    set swiss_points = public.swiss_bo2_points_of(v_participant.id, p_event_id),
        swiss_gw = v_gw,
        swiss_omw = case when v_omw_count > 0 then v_omw_sum / v_omw_count else null end,
        swiss_ogw = case when v_ogw_count > 0 then v_ogw_sum / v_ogw_count else null end
    where id = v_participant.id;
  end loop;
end;
$$;

-- 7. FUNCIÓN GENERAR RONDA BO2 ----------------------------------------------
-- Igual que generate_swiss_round pero ordenando/emparejando por swiss_bo2_points_of,
-- y recalculando tiebreakers BO2 al final.
create or replace function public.generate_swiss_bo2_round(p_event_id uuid, p_round integer)
returns void
language plpgsql
security definer
as $$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_p1 uuid;
  v_p2 uuid;
  v_p_a uuid;
  v_p_b uuid;
  v_already_played boolean;
begin
  -- Asegurar que todos los pairings existan.
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and not (p_round = any (ep.bye_rounds))
    order by public.swiss_bo2_points_of(ep.id, p_event_id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_bo2_points_of(ep.id, p_event_id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  declare
    i integer := 1;
    n integer := coalesce(array_length(v_remaining_participants, 1), 0);
  begin
    while i <= n - 1 loop
      v_p1 := v_remaining_participants[i];
      declare j integer := i + 1;
      begin
        while j <= n loop
          v_p2 := v_remaining_participants[j];
          -- Evitar repetir un cruce ya jugado en una ronda previa.
          select exists (
            select 1 from public.pairings
            where event_id = p_event_id
              and swiss_round is not null
              and ((participant_a_id = v_p1 and participant_b_id = v_p2)
                or (participant_a_id = v_p2 and participant_b_id = v_p1))
          ) into v_already_played;
          if not v_already_played then exit; end if;
          j := j + 1;
        end loop;

        if j > n then
          v_p2 := v_remaining_participants[i + 1];
          j := i + 1;
        end if;

        if v_p1 < v_p2 then v_p_a := v_p1; v_p_b := v_p2;
        else v_p_a := v_p2; v_p_b := v_p1;
        end if;

        update public.pairings
        set swiss_round = p_round
        where event_id = p_event_id
          and participant_a_id = v_p_a
          and participant_b_id = v_p_b;

        v_remaining_participants := v_remaining_participants[1:j-1] || v_remaining_participants[j+1:n];
        n := n - 1;
      end;
      i := i + 1;
    end loop;
  end;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;

  -- Recalcular tiebreakers BO2 tras generar la ronda.
  perform public.recalc_swiss_bo2_tiebreakers(p_event_id);
end;
$$;

-- 6. TRIGGER AVANCE BO2 -----------------------------------------------------
-- Se dispara cuando un pairing swiss_bo2 se resuelve (empate o ganador).
-- Si toda la ronda actual está resuelta, avanza la ronda o genera el bracket top 4.
create or replace function public.maybe_advance_swiss_bo2_round()
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
begin
  -- new es un pairing. Solo nos interesa cuando quedó resuelto.
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  -- Rondas totales: swiss_rounds_manual sobreescribe el cálculo automático.
  select competition_format, current_swiss_round,
         coalesce(swiss_rounds_manual, swiss_rounds_total)
  into v_event_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_event_format <> 'swiss_bo2' then return new; end if;
  if v_current_round is null then return new; end if;

  -- Contar pairings pendientes (sin ganador ni empate) de la ronda actual.
  select count(*) into v_pending_pairings
  from public.pairings
  where event_id = v_event_id
    and swiss_round = v_current_round
    and official_winner_participant_id is null
    and official_draw = false;

  if v_pending_pairings > 0 then return new; end if;

  -- Toda la ronda resuelta. Si no es la última, generar la siguiente.
  if v_current_round < v_total_rounds then
    perform public.generate_swiss_bo2_round(v_event_id, v_current_round + 1);
    return new;
  end if;

  -- Era la última: generar bracket de top 4.
  select array_agg(ep.id order by public.swiss_bo2_points_of(ep.id, v_event_id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_top4
  from public.event_participants ep
  where ep.event_id = v_event_id and ep.role = 'player' and ep.left_event_at is null;

  if v_top4 is not null and array_length(v_top4, 1) >= 4 then
    v_top4 := v_top4[1:4];
    perform public.create_bracket_tiebreak_group(v_event_id, v_top4);
  end if;

  return new;
end;
$$;

drop trigger if exists on_pairing_resolved_advance_swiss_bo2 on public.pairings;
create trigger on_pairing_resolved_advance_swiss_bo2
after update on public.pairings
for each row
when (
  (new.official_draw = true and old.official_draw = false)
  or (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
)
execute function public.maybe_advance_swiss_bo2_round();
