-- 0048_swiss_bo2_fixes.sql
--
-- FIX 1: maybe_advance_swiss_bo2_round ya usaba COALESCE(swiss_rounds_manual,
--         swiss_rounds_total) en 0045; se recrea aquí para dejar registro explícito.
-- FIX 2: generate_swiss_bo2_round - bye check corregido: antes usaba
--         `not (p_round = any (bye_rounds))`, que solo excluía si alguien ya
--         tenía bye en la ronda ACTUAL (imposible antes de asignarlo). Ahora
--         excluye a quienes YA tuvieron un bye en cualquier ronda previa.
-- FIX 3: se verifica que el fallback de repetidos está correctamente replicado
--         de generate_swiss_round: primero intenta sin repetidos; si agota todas
--         las opciones (j > n), empareja con el siguiente disponible aunque sea
--         un repetido. La lógica ya era la misma; se preserva íntegra.

-- ===========================================================================
-- FIX 1: Recrear maybe_advance_swiss_bo2_round (ya tenía COALESCE correcto)
-- ===========================================================================
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

-- ===========================================================================
-- FIX 2 + FIX 3: Recrear generate_swiss_bo2_round
-- ===========================================================================
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

  -- FIX 2: bye solo a jugadores que NO tuvieron bye en NINGUNA ronda previa.
  -- La condición anterior `not (p_round = any (bye_rounds))` solo excluía si
  -- alguien ya tenía el número de ronda ACTUAL en su array, lo cual es imposible
  -- antes de asignar el bye. Ahora se excluye a cualquiera con bye_rounds no vacío.
  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and coalesce(array_length(ep.bye_rounds, 1), 0) = 0
    order by public.swiss_bo2_points_of(ep.id, p_event_id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  -- Jugadores que participan en la ronda (excluye al que recibió bye).
  select array_agg(ep.id order by public.swiss_bo2_points_of(ep.id, p_event_id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  -- FIX 3: emparejamiento con fallback de repetidos (igual que generate_swiss_round).
  -- Primero intenta sin repetidos; si no es posible cerrar todos los pairings,
  -- permite repetidos como último recurso.
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
          -- ¿Ya se enfrentaron en una ronda suiza previa?
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

        -- Si todos los oponentes disponibles ya fueron enfrentados, usar el siguiente
        -- como último recurso (igual que generate_swiss_round).
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
