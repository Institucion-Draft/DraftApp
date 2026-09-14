-- 0099_swiss_walkover_regular_phase.sql
-- Fase 6.7: extiende apply_walkover_for_participant (Fase 1 del walkover, 0082) para que
-- funcione correctamente en la fase regular de Suizo.
--
-- Bug encontrado (no solo "sin validar" — activo): apply_walkover_for_participant no filtraba
-- por swiss_round en absoluto. generate_swiss_round/generate_swiss_bo2_round llaman a
-- generate_all_pairings igual que round_robin, creando los n(n-1)/2 cruces posibles — pero en
-- Suizo la MAYORÍA de esas filas nunca reciben un swiss_round (son cruces que el sistema crea
-- de más pero jamás llega a programar, porque Suizo no empareja a todos contra todos). Sin este
-- filtro, alguien que se va de un evento suizo recibía un "walkover" contra CUALQUIERA con quien
-- compartiera un cruce sin jugar en la tabla pairings — incluida gente con la que nunca fue
-- emparejado en ninguna ronda real, inflando sus puntos sin ningún fundamento.
--
-- Fix: agregar `and (competition_format <> 'swiss' or swiss_round is not null)` al filtro de
-- pairings elegibles — condicionado por formato para no tocar en absoluto el comportamiento de
-- round_robin (ahí el filtro no aplica: todos los pairings SÍ están destinados a jugarse).
--
-- revert_walkover_for_participant no necesita cambios: opera únicamente sobre matches
-- is_walkover=true ya existentes: una vez arreglado apply, nunca va a crearse una fila walkover
-- en un pairing swiss_round=null, así que no hay nada nuevo que ese revert deba excluir.
--
-- generate_swiss_round/generate_swiss_bo2_round (0097) y el avance de ronda
-- (maybe_advance_swiss_round) no necesitan cambios: ya excluyen correctamente a quien tiene
-- left_event_at seteado del pool de emparejamiento futuro, y el avance de ronda ya se dispara
-- genéricamente vía la misma cadena de triggers (matches -> update_pairing_official_result ->
-- pairings.official_winner_participant_id -> on_pairing_resolved_advance_swiss) sin importar si
-- el resultado vino de una partida real o de un walkover.
--
-- Confirmado antes de aplicar: "Me voy" nunca se usó en ningún evento suizo hasta ahora (query
-- de count=0) — fix limpio hacia adelante, sin datos existentes que reparar.

-- ===========================================================================
-- apply_walkover_for_participant: agregar el filtro de swiss_round
-- ===========================================================================
create or replace function public.apply_walkover_for_participant(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_event_status text;
  v_competition_format text;
  v_match_format text;
  v_pairing record;
  v_stayer_id uuid;
  v_needed integer;
  v_stayer_wins integer;
  v_next_number integer;
  v_to_insert integer;
  v_i integer;
  v_resolved_count integer := 0;
begin
  select event_id, left_event_at
  into v_event_id, v_left_event_at
  from public.event_participants
  where id = p_participant_id;

  if v_event_id is null or v_left_event_at is null then
    return 0;
  end if;

  select status, competition_format, match_format
  into v_event_status, v_competition_format, v_match_format
  from public.draft_events
  where id = v_event_id and deleted_at is null;

  if v_event_status is distinct from 'playing' then
    return 0;
  end if;

  -- Victorias necesarias para que el pairing quede oficialmente cerrado (mismo criterio que
  -- update_pairing_official_result, 0077): BO1 = 1, BO2/BO3 = 2.
  v_needed := case when v_match_format = 'bo1' then 1 else 2 end;

  for v_pairing in
    select p.id, p.participant_a_id, p.participant_b_id
    from public.pairings p
    join public.event_participants epa on epa.id = p.participant_a_id
    join public.event_participants epb on epb.id = p.participant_b_id
    where p.event_id = v_event_id
      and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id)
      and p.official_winner_participant_id is null
      and p.official_draw is not true
      -- Si el rival TAMBIÉN se fue, no hay "el que se queda" a quien darle la victoria.
      and (epa.left_event_at is null or epb.left_event_at is null)
      -- Fuera de alcance en esta fase: pairings ya linkeados a un bracket de desempate.
      and not exists (
        select 1 from public.event_tiebreak_bracket_matches bm
        where bm.pairing_id = p.id
      )
      -- Suizo: solo pairings efectivamente programados en una ronda (swiss_round asignado).
      -- Las filas swiss_round=null son cruces potenciales que generate_all_pairings crea de más
      -- pero Suizo nunca llega a programar — no representan un partido pendiente real, hacerles
      -- walkover inflaría puntos de gente que nunca fue emparejada contra quien se fue.
      and (v_competition_format <> 'swiss' or p.swiss_round is not null)
  loop
    v_stayer_id := case
      when v_pairing.participant_a_id = p_participant_id then v_pairing.participant_b_id
      else v_pairing.participant_a_id
    end;

    select count(*) into v_stayer_wins
    from public.matches
    where pairing_id = v_pairing.id
      and match_type = 'draft'
      and status = 'completed'
      and winner_participant_id = v_stayer_id;

    v_to_insert := v_needed - v_stayer_wins;
    if v_to_insert <= 0 then
      continue;
    end if;

    select coalesce(max(match_number), 0) into v_next_number
    from public.matches
    where pairing_id = v_pairing.id;

    for v_i in 1..v_to_insert loop
      insert into public.matches
        (pairing_id, match_number, match_type, winner_participant_id, status, is_walkover, started_at, ended_at)
      values
        (v_pairing.id, v_next_number + v_i, 'draft', v_stayer_id, 'completed', true, now(), now());
    end loop;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  return v_resolved_count;
end;
$$;

-- ===========================================================================
-- VERIFICACIÓN AUTOMÁTICA: ningún walkover existente está mal linkeado (esperado: 0, ya
-- confirmado antes de aplicar esta migración — walkover nunca se usó en un evento suizo).
-- ===========================================================================
do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  join public.draft_events de on de.id = p.event_id
  where m.is_walkover = true
    and de.competition_format = 'swiss'
    and p.swiss_round is null;

  if v_bad_count > 0 then
    raise exception 'Fase 6.7: % match(es) walkover existentes están linkeadas a pairings suizos sin swiss_round asignado (cruces nunca programados) — hay datos previos a reparar antes de aplicar este fix. Migración abortada, nada quedó aplicado.', v_bad_count;
  end if;

  raise notice 'Fase 6.7: verificación OK — ningún walkover existente está mal linkeado a un pairing suizo sin ronda asignada.';
end;
$$;
