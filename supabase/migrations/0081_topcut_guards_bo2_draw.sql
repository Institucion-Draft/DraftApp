-- 0081_topcut_guards_bo2_draw.sql
-- Fix confirmado en vivo con logs de cliente: create_round_robin_first_place_tiebreak_group
-- devolvía false silenciosamente para un evento round_robin BO2 con 10/10 pairings resueltos
-- (9 con ganador + 1 empate) porque su guard "defensa en profundidad" solo miraba
-- official_winner_participant_id is null para decidir "fase regular no resuelta" — un pairing
-- empatado (official_draw=true) cumple esa condición sin estar realmente pendiente.
--
-- Mismo patrón exacto ya usado en compute_event_champion desde 0078: agregar
-- "and official_draw is not true" a la condición de "pendiente".
--
-- Se revisaron TODAS las funciones con este patrón (grep de "official_winner_participant_id is
-- null" sobre 0076, que es donde viven las versiones vigentes de las tres). Además de
-- create_round_robin_first_place_tiebreak_group, el mismo guard sin actualizar existe en
-- create_round_robin_top4_bracket y create_fourth_place_tiebreak_group — ninguna de las dos se
-- topó todavía con el bug porque ambas exigen top_size=4, y hoy top_size=4 siempre fuerza
-- match_format='bo1' (CreateEventScreen), así que nunca hay un pairing con official_draw=true en
-- ese camino — pero si en el futuro se habilita BO2 con top_size=4, se rompería exactamente
-- igual. Se corrigen las tres ahora mismo para no dejar la trampa armada.
--
-- Los tres cuerpos son copia exacta de sus versiones vigentes en 0076 — el único cambio es la
-- condición del guard de "fase regular resuelta" en cada una.

-- ── create_round_robin_top4_bracket ──────────────────────────────────────────────────────────
create or replace function public.create_round_robin_top4_bracket(
  p_event_id uuid,
  p_top4_ordered uuid[]
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_top_size integer;
  v_existing integer;
  v_pending integer;
  v_valid_count integer;
  v_distinct_count integer;
  v_new_group_id uuid;
begin
  select competition_format, top_size into v_format, v_top_size
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin' or coalesce(v_top_size, 0) <> 4 then return false; end if;

  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'bracket';

  if v_existing > 0 then return false; end if;

  if p_top4_ordered is null or array_length(p_top4_ordered, 1) <> 4 then
    return false;
  end if;

  select count(*) into v_distinct_count
  from (select distinct unnest(p_top4_ordered)) u;

  if v_distinct_count <> 4 then return false; end if;

  select count(*) into v_valid_count
  from public.event_participants ep
  where ep.id = any(p_top4_ordered)
    and ep.event_id = p_event_id
    and ep.role = 'player';

  if v_valid_count <> 4 then return false; end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta, sin importar lo
  -- que el cliente haya calculado. Un pairing con official_draw=true (BO2, 1-1) cuenta como
  -- resuelto, no como pendiente.
  select count(*) into v_pending
  from public.pairings
  where event_id = p_event_id
    and official_winner_participant_id is null
    and official_draw is not true;

  if v_pending > 0 then return false; end if;

  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, p_top4_ordered);

  update public.event_tiebreak_groups
  set group_origin = 'round_robin_topcut'
  where id = v_new_group_id;

  return true;
end;
$$;

-- ── create_fourth_place_tiebreak_group ───────────────────────────────────────────────────────
create or replace function public.create_fourth_place_tiebreak_group(
  p_event_id uuid,
  p_matches jsonb,
  p_top3_ordered uuid[]
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_top_size integer;
  v_existing integer;
  v_group_id uuid;
  v_match jsonb;
  v_a_id uuid;
  v_b_id uuid;
  v_advances text;
  v_phase text;
  v_top3_distinct_count integer;
  v_top3_valid_count integer;
  v_top3_overlap_count integer;
  v_pid uuid;
  v_seed integer;
begin
  select competition_format, top_size into v_format, v_top_size
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin' or coalesce(v_top_size, 0) <> 4 then return false; end if;

  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'fourth_place';

  if v_existing > 0 then return false; end if;

  -- El bracket real de top4 se crea recién cuando este desempate se resuelve (paso posterior);
  -- si ya existe, este desempate llegó tarde/duplicado.
  if exists (
    select 1 from public.event_tiebreak_groups
    where event_id = p_event_id and group_type = 'bracket' and group_origin = 'round_robin_topcut'
  ) then
    return false;
  end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta, sin importar lo que el
  -- cliente haya calculado (mismo criterio que create_round_robin_top4_bracket). Un pairing con
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

  if p_top3_ordered is null or array_length(p_top3_ordered, 1) <> 3 then
    return false;
  end if;

  select count(*) into v_top3_distinct_count from (select distinct unnest(p_top3_ordered)) u;
  if v_top3_distinct_count <> 3 then return false; end if;

  select count(*) into v_top3_valid_count
  from public.event_participants ep
  where ep.id = any(p_top3_ordered) and ep.event_id = p_event_id and ep.role = 'player';
  if v_top3_valid_count <> 3 then return false; end if;

  -- Ninguno de los 3 ya resueltos puede aparecer como participante concreto dentro de p_matches
  -- (si aparece, no está realmente resuelto — es parte del grupo en disputa).
  select count(*) into v_top3_overlap_count
  from unnest(p_top3_ordered) t3
  where exists (
    select 1 from jsonb_array_elements(p_matches) m
    where (m->'a'->>'participantId')::uuid = t3 or (m->'b'->>'participantId')::uuid = t3
  );
  if v_top3_overlap_count > 0 then return false; end if;

  insert into public.event_tiebreak_groups
    (event_id, round_number, group_type, group_origin, status, pending_bracket_matches)
  values (p_event_id, 1, 'fourth_place', 'round_robin_fourth_place', 'active', p_matches)
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_top3_ordered
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
      -- Depende del ganador de otro partido: se arma más adelante (paso posterior), leyendo
      -- pending_bracket_matches cuando ese partido se resuelva.
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

-- ── create_round_robin_first_place_tiebreak_group ────────────────────────────────────────────
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

  -- Idempotente: no crear un segundo grupo de este origin para el mismo evento.
  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_origin = 'round_robin_first_place';
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
  -- official_draw=true (BO2, 1-1) cuenta como resuelto, no como pendiente — este era el bug
  -- confirmado: un evento BO2 con el pairing decisivo empatado nunca pasaba este guard.
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

  -- A diferencia de create_fourth_place_tiebreak_group (que guarda ahí a los 3 YA resueltos,
  -- ajenos a la disputa): acá TODOS los empatados entran a la disputa, así que se guardan
  -- todos, con seed = orden de tanda1. Necesario para que PairingsListScreen detecte el grupo
  -- (gate >= 2 filas) y para que el podio desempate 3er puesto en un grupo de 4 por seed.
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
      -- Depende del ganador de otro partido: se arma más adelante, cuando ese partido se
      -- resuelva (mismo patrón que create_fourth_place_tiebreak_group).
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
