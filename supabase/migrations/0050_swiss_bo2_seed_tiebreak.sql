-- 0050_swiss_bo2_seed_tiebreak.sql
--
-- El seeding del bracket de top cut en swiss_bo2 (maybe_advance_swiss_bo2_round)
-- ordenaba a los jugadores solo por puntos y OMW, mientras que la tabla de
-- posiciones (StandingsScreen) desempata por Pts > OMW > GW > OGW. Con jugadores
-- empatados en puntos y OMW el array_agg podía sembrar el top-4 en un orden
-- distinto al que muestra la tabla, produciendo cruces 1-4 / 2-3 incoherentes.
--
-- FIX: usar en el ORDER BY del array_agg EXACTAMENTE los mismos criterios que la
-- tabla, en el mismo orden, y agregar un desempate FINAL determinístico por
-- ep.user_id. StandingsScreen.tsx aplica el mismo desempate final (user_id) en
-- el "return 0" de su sort, de modo que tabla y bracket rompen el empate exacto
-- de forma idéntica.
--
-- NO se hace backfill de eventos existentes: sus brackets ya generados se dejan
-- como están (algunos fueron corregidos a mano). Esto solo afecta la generación
-- de brackets de torneos NUEVOS.

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
  v_new_group_id uuid;
begin
  -- Solo nos interesa cuando el pairing quedó resuelto (ganador o empate).
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  -- swiss_rounds_manual sobreescribe el cálculo automático.
  select competition_format,
         current_swiss_round,
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

  -- Toda la ronda resuelta.
  if v_current_round < v_total_rounds then
    perform public.generate_swiss_bo2_round(v_event_id, v_current_round + 1);
    return new;
  end if;

  -- Era la última: generar bracket de top 4.
  -- El ORDER BY usa los MISMOS criterios que la tabla de posiciones
  -- (Pts > OMW > GW > OGW) más un desempate final determinístico por user_id,
  -- idéntico al sort de StandingsScreen.tsx, para que el seeding coincida con
  -- la tabla incluso en empates exactos.
  select array_agg(ep.id order by public.swiss_bo2_points_of(ep.id, v_event_id) desc,
                                     coalesce(ep.swiss_omw, 0) desc,
                                     coalesce(ep.swiss_gw, 0) desc,
                                     coalesce(ep.swiss_ogw, 0) desc,
                                     ep.user_id asc)
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
