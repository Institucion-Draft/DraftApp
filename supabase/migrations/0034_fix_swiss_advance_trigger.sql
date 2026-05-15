-- 0034_fix_swiss_advance_trigger.sql
-- El trigger de avance de ronda suiza miraba matches.status='completed',
-- pero los pairings se resuelven también por abandono. Cambiar para evaluar
-- pairings con official_winner_participant_id no null.

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
begin
  -- new es un pairing (el trigger ahora va en pairings, no matches)
  if new.official_winner_participant_id is null then return new; end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  select competition_format, current_swiss_round, swiss_rounds_total
  into v_event_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_event_format <> 'swiss' then return new; end if;
  if v_current_round is null then return new; end if;

  -- Contar pairings pendientes de la ronda actual.
  select count(*) into v_pending_pairings
  from public.pairings
  where event_id = v_event_id
    and swiss_round = v_current_round
    and official_winner_participant_id is null;

  if v_pending_pairings > 0 then return new; end if;

  -- Todas cerradas. Si no es la última ronda, generar la siguiente.
  if v_current_round < v_total_rounds then
    perform public.generate_swiss_round(v_event_id, v_current_round + 1);
    return new;
  end if;

  -- Era la última: generar bracket de top 4.
  select array_agg(ep.id order by public.swiss_points_of(v_event_id, ep.id) desc,
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

-- Sacar el trigger viejo de matches.
drop trigger if exists on_match_completed_advance_swiss on public.matches;

-- Nuevo trigger en pairings.
drop trigger if exists on_pairing_resolved_advance_swiss on public.pairings;
create trigger on_pairing_resolved_advance_swiss
after update on public.pairings
for each row
when (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
execute function public.maybe_advance_swiss_round();
