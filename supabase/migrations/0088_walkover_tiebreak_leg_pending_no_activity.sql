-- 0088_walkover_tiebreak_leg_pending_no_activity.sql
-- Complementa el fix del gap del bye (0087): 0087 resuelve el caso "la fila de la final nunca
-- se crea porque el bye ya se fue antes de que la semi termine". Pero el bye puede irse
-- DESPUÉS de que la fila ya se creó (la semi resuelve, el bracket avanza solo, la fila 'final'
-- queda materializada con ambos participantes concretos) y ANTES de que nadie alcance a tocar
-- "Iniciar" sobre ella. Confirmado con timestamps reales: la fila se creó a las 21:08:35, la
-- persona se fue a las 21:09:00 — 25 segundos después, sin ningún match de por medio.
--
-- apply_walkover_for_tiebreak_leg (0084) no cubría este caso: su loop exigía
-- tiebreak_leg_has_started(bm.pairing_id) — que ESA fila puntual ya tuviera al menos un match
-- in_progress/completed — antes de darle walkover. Ese chequeo tenía sentido en el diseño
-- original (0084) para decidir si el GRUPO completo podía recalcularse desde cero (nada de
-- nada arrancó todavía) vs si ya había que hacer walkover puntual (algo sí arrancó) — pero acá
-- confunde dos cosas distintas: "¿el grupo en su conjunto ya tiene actividad real, entonces no
-- se puede recalcular?" (eso lo sigue decidiendo el caller en PlayerProfileInEventScreen.tsx,
-- sin cambios) vs "¿esta fila puntual, que ya existe como tal, tuvo su propio match?" — lo
-- segundo no debería importar: una fila de bracket ya materializada (con ambos participantes
-- concretos) representa un enfrentamiento real pendiente, haya tenido 0 o N matches. Regla
-- unificada (confirmada): si existe una fila de bracket sin ganador vinculada a quien se va,
-- walkover de esa fila puntual — sin importar actividad previa. Nunca recalcular el bracket
-- completo una vez que al menos una fila ya existe (eso solo aplica cuando el grupo entero no
-- tiene ninguna actividad, caso que sigue cubierto por el camino de recálculo existente).
--
-- Fix: se quita el filtro tiebreak_leg_has_started(bm.pairing_id) de la selección del loop —
-- ya no es un gate de entrada. v_stayer_wins/v_to_insert siguen calculando correctamente
-- cuántos matches faltan insertar (si la fila nunca se jugó, v_stayer_wins=0 y se insertan
-- los v_wins_needed completos como walkover; si ya tenía progreso real, solo los que faltan).

create or replace function public.apply_walkover_for_tiebreak_leg(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_group record;
  v_bm record;
  v_stayer_id uuid;
  v_wins_needed integer;
  v_stayer_wins integer;
  v_next_number integer;
  v_to_insert integer;
  v_i integer;
  v_match_id uuid;
  v_resolved_count integer := 0;
begin
  select event_id, left_event_at
  into v_event_id, v_left_event_at
  from public.event_participants
  where id = p_participant_id;

  if v_event_id is null or v_left_event_at is null then
    return 0;
  end if;

  for v_group in
    select g.id, g.round_number
    from public.event_tiebreak_groups g
    where g.event_id = v_event_id
      and g.group_type = 'fourth_place'
      and g.group_origin = 'round_robin_first_place'
      and g.status = 'active'
      and exists (
        select 1 from public.event_tiebreak_group_participants gp
        where gp.group_id = g.id and gp.participant_id = p_participant_id
      )
  loop
    for v_bm in
      select bm.id, bm.bracket_phase, bm.participant_a_id, bm.participant_b_id, bm.pairing_id
      from public.event_tiebreak_bracket_matches bm
      where bm.group_id = v_group.id
        and bm.winner_participant_id is null
        and (bm.participant_a_id = p_participant_id or bm.participant_b_id = p_participant_id)
        and bm.pairing_id is not null
      -- Sin filtro de "¿esta pierna ya tuvo actividad?": la fila ya existe (materializada, con
      -- ambos participantes concretos) — walkover directo sin importar si tiene 0 o N matches.
    loop
      v_stayer_id := case
        when v_bm.participant_a_id = p_participant_id then v_bm.participant_b_id
        else v_bm.participant_a_id
      end;

      -- Mismo criterio que evaluate_tiebreak_group_after_match para round_robin_first_place:
      -- semi = BO1 (1 victoria), final = BO3 (2 victorias).
      v_wins_needed := case when v_bm.bracket_phase = 'final' then 2 else 1 end;

      select count(*) into v_stayer_wins
      from public.matches
      where pairing_id = v_bm.pairing_id
        and match_type = 'tiebreak'
        and status = 'completed'
        and winner_participant_id = v_stayer_id;

      v_to_insert := v_wins_needed - v_stayer_wins;
      if v_to_insert <= 0 then
        continue;
      end if;

      select coalesce(max(match_number), 0) into v_next_number
      from public.matches
      where pairing_id = v_bm.pairing_id;

      for v_i in 1..v_to_insert loop
        insert into public.matches (pairing_id, match_number, match_type, status, tiebreak_round, started_at)
        values (v_bm.pairing_id, v_next_number + v_i, 'tiebreak', 'in_progress', v_group.round_number, now())
        returning id into v_match_id;

        -- UPDATE aparte (no seteamos 'completed' en el insert): el trigger de avance del
        -- bracket dispara en AFTER UPDATE, no AFTER INSERT.
        update public.matches
        set status = 'completed', winner_participant_id = v_stayer_id, is_walkover = true, ended_at = now()
        where id = v_match_id;
      end loop;

      v_resolved_count := v_resolved_count + 1;
    end loop;
  end loop;

  return v_resolved_count;
end;
$$;
