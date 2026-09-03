-- 0076_round_robin_top_size.sql
-- Paso 1 de la unificación arquitectónica: competition_format='round_robin_bo1_top4' deja de
-- ser un competition_format propio y pasa a ser una variación de 'round_robin', señalizada por
-- la nueva columna draft_events.top_size (null = todos contra todos clásico, 4 = con top4).
-- Puro refactor de esquema — cero cambio de comportamiento visible. match_format ya cubría el
-- eje BO1/BO3 independientemente (ver análisis previo); esta migración solo reubica la señal
-- de "hay top4" de competition_format a top_size.
--
-- No se toca evaluate_tiebreak_group_after_match: esa función branchea por group_type/
-- group_origin, nunca por competition_format, así que no hay nada que migrar ahí.

-- ── 1. Nueva columna top_size ────────────────────────────────────────────────────────────────
alter table public.draft_events
  add column if not exists top_size integer;

alter table public.draft_events
  drop constraint if exists draft_events_top_size_valid;

alter table public.draft_events
  add constraint draft_events_top_size_valid
  check (top_size is null or top_size in (2, 4));

-- ── 2. Migrar datos existentes ───────────────────────────────────────────────────────────────
update public.draft_events
set competition_format = 'round_robin', top_size = 4
where competition_format = 'round_robin_bo1_top4';

-- ── 3. Angostar competition_format_valid: round_robin_bo1_top4 ya no es un valor válido ────────
alter table public.draft_events
  drop constraint if exists draft_events_competition_format_valid;

alter table public.draft_events
  add constraint draft_events_competition_format_valid
  check (competition_format in ('round_robin', 'swiss', 'swiss_bo2'));

-- ── 4. compute_event_champion — guard actualizado a top_size ───────────────────────────────────
-- Cuerpo idéntico a 0075, solo cambia cómo se detecta "es un round_robin con top4" (antes
-- competition_format='round_robin_bo1_top4', ahora competition_format='round_robin' and
-- top_size=4). COALESCE(top_size, 0) porque en PL/pgSQL una comparación contra NULL con <> no es
-- true ni false, es NULL — y `if null then` se trata como false (no entra al return), lo que
-- dejaría pasar de largo a un round_robin clásico (top_size null) que sí debe seguir de largo.
create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_competition_format text;
  v_top_size integer;
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_blocked integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_winrate numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_existing_active_group_id uuid;
  v_proj_leader_user_id uuid;
  v_proj_leader_participant_id uuid;
  v_proj_min_winrate numeric;
  v_proj_threats integer;
begin
  select competition_format, top_size, status, champion_user_id
  into v_competition_format, v_top_size, v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  -- round_robin + top_size=4 (antes competition_format='round_robin_bo1_top4') tiene su propio
  -- flujo de cierre vía el bracket de top4; esta función no debe intervenir en ningún punto
  -- para este formato.
  if v_competition_format = 'round_robin' and coalesce(v_top_size, 0) = 4 then return; end if;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;

  select id into v_existing_active_group_id
  from public.event_tiebreak_groups where event_id = p_event_id and status = 'active' limit 1;
  if v_existing_active_group_id is not null then return; end if;

  select count(*), count(*) filter (where official_winner_participant_id is null),
    count(*) filter (where official_winner_participant_id is null
      and (exists (select 1 from public.event_participants ep where ep.id = p.participant_a_id and ep.left_event_at is not null)
        or exists (select 1 from public.event_participants ep where ep.id = p.participant_b_id and ep.left_event_at is not null)))
  into v_total_pairings, v_pending_pairings_total, v_pending_pairings_blocked
  from public.pairings p where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Líder matemáticamente inevitable con pairings aún pendientes (0074, sin cambios).
  if v_pending_pairings_total > v_pending_pairings_blocked and v_event_champion_user_id is null then
    with pairing_block as (
      select
        p.participant_a_id,
        p.participant_b_id,
        p.official_winner_participant_id,
        (epa.left_event_at is not null or epb.left_event_at is not null) as is_blocked
      from public.pairings p
      join public.event_participants epa on epa.id = p.participant_a_id
      join public.event_participants epb on epb.id = p.participant_b_id
      where p.event_id = p_event_id
    ),
    projection as (
      select
        ep.user_id,
        ep.id as participant_id,
        count(*) filter (
          where pb.official_winner_participant_id is not null
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as completed_now,
        count(*) filter (
          where pb.official_winner_participant_id = ep.id
        ) as won_now,
        count(*) filter (
          where pb.official_winner_participant_id is null
            and not pb.is_blocked
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as pending_active
      from public.event_participants ep
      left join pairing_block pb on pb.participant_a_id = ep.id or pb.participant_b_id = ep.id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    ),
    projected as (
      select
        user_id,
        participant_id,
        (completed_now + pending_active) as final_completed,
        (won_now::numeric / nullif(completed_now + pending_active, 0)) as min_winrate,
        ((won_now + pending_active)::numeric / nullif(completed_now + pending_active, 0)) as max_winrate
      from projection
    ),
    candidate as (
      select user_id, participant_id, min_winrate
      from projected
      where final_completed >= v_min_bo3_required
      order by min_winrate desc nulls last
      limit 1
    )
    select c.user_id, c.participant_id, c.min_winrate,
      (select count(*) from projected q
        where q.participant_id <> c.participant_id and q.max_winrate >= c.min_winrate)
    into v_proj_leader_user_id, v_proj_leader_participant_id, v_proj_min_winrate, v_proj_threats
    from candidate c;

    if v_proj_leader_user_id is not null and v_proj_min_winrate is not null and v_proj_threats = 0 then
      update public.draft_events
        set champion_user_id = v_proj_leader_user_id, champion_decided_by = 'auto_projected'
      where id = p_event_id and status = 'playing' and champion_user_id is null;
    end if;
  end if;

  if v_pending_pairings_total > v_pending_pairings_blocked then return; end if;

  with player_bo3 as (
    select ep.user_id, ep.id as participant_id,
      count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player'
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, (won::numeric / nullif(completed, 0)) as winrate
    from player_bo3 where completed >= v_min_bo3_required
  )
  select max(winrate), count(*) filter (where winrate = (select max(winrate) from eligible))
  into v_max_winrate, v_leaders_count from eligible;

  if v_max_winrate is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id from (
      select ep.user_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id
    ) leaders where (won::numeric / nullif(completed, 0)) = v_max_winrate and completed >= v_min_bo3_required;
    update public.draft_events set champion_user_id = v_leader_user_id, champion_decided_by = 'auto', event_ended_at = now(),
      status = 'completed', final_pending = false where id = p_event_id and status = 'playing';
    return;
  end if;

  -- v_leaders_count >= 2: el desempate de 1er puesto lo arma el CLIENTE (EventDetailScreen.tsx),
  -- igual que round_robin + top_size=4 ya hace para el desempate del 4to puesto — reusa la
  -- cascada completa de tanda1/tanda2 de podium.ts. Esta función se limita a marcar
  -- final_pending=true; el cliente detecta esa señal y llama a
  -- create_round_robin_first_place_tiebreak_group con el grupo ya ordenado.
  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$$;

-- ── 5. create_round_robin_top4_bracket — guard actualizado a top_size ──────────────────────────
-- Cuerpo idéntico a 0069, solo cambia el guard inicial.
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
  -- que el cliente haya calculado.
  select count(*) into v_pending
  from public.pairings
  where event_id = p_event_id
    and official_winner_participant_id is null;

  if v_pending > 0 then return false; end if;

  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, p_top4_ordered);

  update public.event_tiebreak_groups
  set group_origin = 'round_robin_topcut'
  where id = v_new_group_id;

  return true;
end;
$$;

-- ── 6. create_fourth_place_tiebreak_group — guard actualizado a top_size ───────────────────────
-- Cuerpo idéntico a 0071, solo cambia el guard inicial.
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
  -- cliente haya calculado (mismo criterio que create_round_robin_top4_bracket).
  if exists (
    select 1 from public.pairings
    where event_id = p_event_id and official_winner_participant_id is null
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

-- ── 7. create_round_robin_first_place_tiebreak_group — guard actualizado a top_size ────────────
-- Cuerpo idéntico a 0075, solo cambia el guard inicial: además de competition_format='round_robin',
-- ahora exige top_size is null (un round_robin con top_size=4 resuelve el campeón vía el bracket
-- de top4, nunca por esta vía — antes esto era automático porque 'round_robin_bo1_top4' y
-- 'round_robin' eran competition_format distintos).
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
  -- create_fourth_place_tiebreak_group / compute_event_champion).
  if exists (
    select 1 from public.pairings
    where event_id = p_event_id and official_winner_participant_id is null
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
