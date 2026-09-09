-- 0084_walkover_phase3_recalc_window.sql
-- Fase 3 del rediseño de "Me voy": ventana de recálculo, probada sobre el caso más chico —
-- desempate de 1er puesto de round_robin BO3 clásico (group_type='fourth_place',
-- group_origin='round_robin_first_place').
--
-- Regla general (confirmada en el diseño): la ventana para recorrer/recalcular posiciones se
-- CIERRA en el momento exacto en que arranca esa instancia — no antes. Antes de ese momento,
-- "me voy" dispara un recálculo completo (excluyendo a quien se fue, pero sin borrar su aporte
-- al head-to-head/calidad de rivales de los demás — eso NUNCA se recalcula, solo se libera la
-- plaza que ocupaba). Después de ese momento, "me voy" solo produce walkover del partido
-- puntual en curso — nunca un recálculo de posiciones, sin importar la fase/instancia (esto
-- también aplica a semis/final/desempate de 4to puesto en fases futuras, no es específico de
-- este group_origin).

-- ── 1. Helper genérico: ¿esta pierna de desempate puntual ya tiene actividad? ──────────────────
-- Recibe un pairing_id (el mismo pairing_id que cualquier fila de event_tiebreak_bracket_matches
-- ya tiene linkeado) y devuelve si hay algún match_type='tiebreak' in_progress o completed sobre
-- él. No sabe nada de qué fase/formato de desempate es — sirve igual para una semi/final de un
-- bracket real de top4 en Fase 4/5, mismo shape de datos.
create or replace function public.tiebreak_leg_has_started(p_pairing_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.matches
    where pairing_id = p_pairing_id
      and match_type = 'tiebreak'
      and status in ('in_progress', 'completed')
  );
$$;

-- ── 2. delete_active_round_robin_first_place_group: borra el grupo activo de desempate de 1er
--       puesto, SOLO si ninguna de sus piernas arrancó todavía (re-chequea acá, no confía
--       únicamente en que el caller ya lo verificó). event_tiebreak_group_participants y
--       event_tiebreak_bracket_matches caen solos por "on delete cascade" sobre el group_id.
create or replace function public.delete_active_round_robin_first_place_group(p_event_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_origin = 'round_robin_first_place'
    and status = 'active';

  if v_group_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.pairing_id is not null
      and public.tiebreak_leg_has_started(bm.pairing_id)
  ) into v_any_started;

  if v_any_started then
    return false;
  end if;

  delete from public.event_tiebreak_groups where id = v_group_id;
  return true;
end;
$$;

-- ── 3. apply_walkover_for_tiebreak_leg: walkover puntual de las piernas de desempate PENDIENTES
--       de un participante recién marcado como left_event_at, dentro de grupos fourth_place
--       group_origin='round_robin_first_place' activos — solo para piernas que YA arrancaron
--       (tiebreak_leg_has_started); una pierna que todavía no arrancó no se toca acá, es
--       responsabilidad del camino de recálculo completo (borrar + recrear el grupo).
--
--       El resultado se materializa insertando la(s) match(es) faltante(s) — match_type=
--       'tiebreak', is_walkover=true, siempre ganadas por "el que se queda" — y dejando que
--       evaluate_tiebreak_group_after_match haga el resto (avanzar semi→final, coronar
--       campeón): ese trigger dispara en AFTER UPDATE, no AFTER INSERT, así que cada match se
--       inserta 'in_progress' y se cierra con un UPDATE aparte a 'completed' — dos pasos, para
--       reusar el trigger real en vez de duplicar su lógica de avance del bracket.
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
        and public.tiebreak_leg_has_started(bm.pairing_id)
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
