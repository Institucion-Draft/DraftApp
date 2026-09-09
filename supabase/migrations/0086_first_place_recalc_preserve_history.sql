-- 0086_first_place_recalc_preserve_history.sql
-- Bug encontrado probando la Fase 3 en vivo: StandingsScreen.tsx resalta con fondo amarillo a
-- quienes disputaron un desempate de 1er puesto leyendo directo event_tiebreak_groups por
-- group_origin='round_robin_first_place' (sin filtrar status) + sus event_tiebreak_bracket_
-- matches. delete_active_round_robin_first_place_group (0084) borraba esa fila por completo
-- cuando el recálculo (tras un abandono, sin que nada hubiera arrancado) resolvía en un único
-- campeón — perdiendo para siempre la evidencia de que hubo una disputa real, y con ella el
-- resaltado en la tabla.
--
-- Fix: en vez de borrar, el grupo viejo se cierra (status='resolved', resolved_at=now()) y se
-- deja tal cual — mismo estado final que deja evaluate_tiebreak_group_after_match cuando el
-- desempate se resuelve jugando de verdad. Así event_tiebreak_group_participants y event_
-- tiebreak_bracket_matches (con los participant_id concretos) sobreviven, y el resaltado de
-- StandingsScreen sigue funcionando igual para ambos jugadores, se hayan ido o no.
--
-- Como consecuencia, create_round_robin_first_place_tiebreak_group deja de poder confiar en
-- "no existe ninguna fila con este group_origin" para decidir si ya hay un desempate armado —
-- ahora puede (a propósito) haber una fila vieja YA RESUELTA del mismo origin conviviendo con
-- el evento. Se angosta ese guard a "no existe ninguna fila ACTIVA con este group_origin", que
-- es lo que en verdad le importa (crear un segundo grupo activo en paralelo sí seguiría siendo
-- un bug; convivir con uno viejo ya resuelto no lo es).

drop function if exists public.delete_active_round_robin_first_place_group(uuid);

-- ── close_active_round_robin_first_place_group (antes "delete_..."): mismo criterio y misma
--    guarda defensiva (ninguna pierna arrancó todavía), pero cierra en vez de borrar. ──────────
create or replace function public.close_active_round_robin_first_place_group(p_event_id uuid)
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

  update public.event_tiebreak_groups
  set status = 'resolved', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$$;

-- ── create_round_robin_first_place_tiebreak_group: angostar el guard de "ya existe" a solo
--    filas activas — cuerpo idéntico al vigente en 0081 salvo esa condición. ───────────────────
create or replace function public.create_round_robin_first_place_tiebreak_group(
  p_event_id uuid,
  p_matches jsonb,
  p_tied_participants_ordered uuid[]
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_top_size integer;
  v_status text;
  v_existing integer;
  v_group_id uuid;
  v_match jsonb;
  v_a_id uuid;
  v_b_id uuid;
  v_advances text;
  v_phase text;
  v_group_size integer;
  v_distinct_count integer;
  v_valid_count integer;
  v_pid uuid;
  v_seed integer;
begin
  select competition_format, top_size, status into v_format, v_top_size, v_status
  from public.draft_events where id = p_event_id and deleted_at is null;

  if v_format <> 'round_robin' or v_top_size is not null then return false; end if;
  if v_status <> 'playing' then return false; end if;

  -- Idempotente: no crear un SEGUNDO grupo ACTIVO de este origin para el mismo evento. A
  -- diferencia de 0081, ya no basta con "existe alguna fila" — puede haber una vieja ya resuelta
  -- (close_active_round_robin_first_place_group, tras un recálculo por abandono) conviviendo a
  -- propósito con el evento, sin que eso bloquee armar la próxima.
  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_origin = 'round_robin_first_place' and status = 'active';
  if v_existing > 0 then return false; end if;

  -- Defensa en profundidad: no pisar cualquier otro grupo activo (compute_event_champion ya no
  -- crea ninguno para este formato, pero por las dudas de un evento viejo con un grupo
  -- 'tiebreak' clásico todavía en curso).
  if exists (
    select 1 from public.event_tiebreak_groups where event_id = p_event_id and status = 'active'
  ) then
    return false;
  end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta (mismo criterio que
  -- create_fourth_place_tiebreak_group / compute_event_champion). Un pairing con
  -- official_draw=true (BO2, 1-1) cuenta como resuelto, no como pendiente.
  if exists (
    select 1 from public.pairings
    where event_id = p_event_id and official_winner_participant_id is null and official_draw is not true
  ) then
    return false;
  end if;

  if p_matches is null or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) = 0 then
    return false;
  end if;

  v_group_size := array_length(p_tied_participants_ordered, 1);
  if p_tied_participants_ordered is null or v_group_size is null or v_group_size < 2 or v_group_size > 4 then
    return false;
  end if;

  select count(*) into v_distinct_count from (select distinct unnest(p_tied_participants_ordered)) u;
  if v_distinct_count <> v_group_size then return false; end if;

  select count(*) into v_valid_count
  from public.event_participants ep
  where ep.id = any(p_tied_participants_ordered) and ep.event_id = p_event_id and ep.role = 'player';
  if v_valid_count <> v_group_size then return false; end if;

  insert into public.event_tiebreak_groups
    (event_id, round_number, group_type, group_origin, status, pending_bracket_matches)
  values (p_event_id, 1, 'fourth_place', 'round_robin_first_place', 'active', p_matches)
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_tied_participants_ordered
  loop
    insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
    select v_group_id, v_pid, ep.user_id, v_seed
    from public.event_participants ep
    where ep.id = v_pid;
    v_seed := v_seed + 1;
  end loop;

  for v_match in select * from jsonb_array_elements(p_matches)
  loop
    if not (v_match ? 'a') or not (v_match ? 'b') then continue; end if;
    if not (v_match->'a' ? 'participantId') or not (v_match->'b' ? 'participantId') then
      continue;
    end if;

    v_a_id := (v_match->'a'->>'participantId')::uuid;
    v_b_id := (v_match->'b'->>'participantId')::uuid;
    v_advances := v_match->>'winnerAdvancesTo';
    v_phase := case when v_advances = 'final_4th' then 'final' else 'semi' end;

    insert into public.event_tiebreak_bracket_matches
      (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group_id, v_phase, v_a_id, v_b_id);
  end loop;

  perform public.link_bracket_matches_to_pairings(v_group_id);

  return true;
end;
$$;
