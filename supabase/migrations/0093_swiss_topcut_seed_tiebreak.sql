-- 0093_swiss_topcut_seed_tiebreak.sql
--
-- El seeding del bracket de top cut en swiss BO3 clásico (maybe_advance_swiss_round)
-- ordenaba a los jugadores por Pts > OMW > GW > OGW sin un desempate final
-- determinístico, a diferencia de swiss_bo2 (fix ya aplicado en 0050) y de
-- StandingsScreen.tsx, que sí agregan un desempate final por user_id. Con
-- jugadores empatados en los 4 criterios, el array_agg podía sembrar el top-4
-- en un orden distinto al que muestra la tabla, produciendo cruces 1-4 / 2-3
-- incoherentes.
--
-- FIX: agregar el mismo desempate final determinístico por ep.user_id que ya
-- tiene swiss_bo2 desde 0050, para que el seeding coincida con la tabla incluso
-- en empates exactos.
--
-- NO se hace backfill de eventos existentes: sus brackets ya generados se dejan
-- como están. Esto solo afecta la generación de brackets de torneos NUEVOS.

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

  -- Última ronda: generar bracket de top 4. El ORDER BY usa los MISMOS
  -- criterios que la tabla de posiciones (Pts > OMW > GW > OGW) más un
  -- desempate final determinístico por user_id, idéntico al sort de
  -- StandingsScreen.tsx y al fix ya aplicado a swiss_bo2 en 0050.
  select array_agg(ep.id order by public.swiss_points_of(v_event_id, ep.id) desc,
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
