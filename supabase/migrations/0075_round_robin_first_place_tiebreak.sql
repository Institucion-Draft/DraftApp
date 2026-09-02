-- 0075_round_robin_first_place_tiebreak.sql
-- Migra el desempate de 1er puesto de round_robin BO3 clásico al mismo patrón que ya usa
-- round_robin_bo1_top4 para el desempate del 4to puesto (0071/0072): el cliente calcula el
-- orden con la cascada completa de tanda1/tanda2 de podium.ts (head-to-head → calidad de
-- rivales → hash), más precisa que el criterio de solo-winrate que compute_event_champion
-- usaba hasta ahora en sus ramas de 2/3/4/5+ líderes. El trigger deja de resolver el empate
-- por su cuenta y pasa a solo detectar la condición (final_pending=true) y esperar a que el
-- cliente arme y persista el grupo de desempate.
--
-- Reusa group_type='fourth_place' + event_tiebreak_bracket_matches/pending_bracket_matches
-- (misma infraestructura que 0071), con group_origin='round_robin_first_place' nuevo. A
-- diferencia de round_robin_fourth_place:
--   - event_tiebreak_group_participants guarda a TODOS los empatados (no a "los ya
--     resueltos" — acá no hay ninguno resuelto de antemano), seed = orden de tanda1. Esto es
--     necesario para que PairingsListScreen detecte el grupo (gate >= 2 filas) y para que el
--     podio pueda desempatar 3er puesto en un grupo de 4 (ver podium.ts).
--   - Cuando el partido de fase 'final' se resuelve, corona CAMPEÓN DEL EVENTO directamente
--     (status='completed', event_ended_at=now()) en vez de avanzar a una fase siguiente — acá
--     no hay "próxima fase".
--   - Las victorias necesarias por partido dependen de la fase, no son BO1 fijo como en
--     round_robin_fourth_place: 'semi' = 1 victoria (BO1), 'final' = 2 victorias (BO3, la
--     misma exigencia que tenía el desempate de campeón hasta ahora).
--
-- Legacy sin tocar (confirmado seguro, ver análisis previo): create_round_robin_tiebreak_group
-- y create_bracket_tiebreak_group (con seed por winrate) quedan definidas pero ya no las llama
-- compute_event_champion para este caso. create_bracket_tiebreak_group sigue siendo la usada
-- por swiss, swiss_bo2 y el bracket real de top4 de round_robin_bo1_top4 (grep exhaustivo de
-- todas las migraciones lo confirma) — no se toca. Las ramas 'round_robin'/'bracket' de
-- evaluate_tiebreak_group_after_match tampoco se tocan: siguen resolviendo esos mismos formatos
-- y cualquier grupo viejo tipo 'tiebreak'/'swiss_topcut'/'round_robin_topcut' que ya esté en
-- curso.

alter table public.event_tiebreak_groups
  drop constraint if exists event_tiebreak_groups_group_origin_check;

alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_group_origin_check
  check (group_origin in ('tiebreak', 'swiss_topcut', 'round_robin_topcut', 'round_robin_fourth_place', 'round_robin_first_place'));

-- ── 1. create_round_robin_first_place_tiebreak_group ────────────────────────────────────────
-- Análoga a create_fourth_place_tiebreak_group (0071), pero para el desempate de campeón de
-- round_robin BO3 clásico. Recibe p_matches (estructura de computeFourthPlaceTiebreakBracket,
-- igual formato) y p_tied_participants_ordered (el grupo empatado completo, YA ordenado por
-- tanda1 — sin "top3 ya resuelto": acá todos entran a la disputa).
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
  select competition_format, status into v_format, v_status
  from public.draft_events where id = p_event_id and deleted_at is null;

  if v_format <> 'round_robin' then return false; end if;
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

-- ── 2. compute_event_champion — simplificar ─────────────────────────────────────────────────
-- Reemplaza las ramas v_leaders_count = 2/3/4/5+ (que armaban el desempate por su cuenta vía
-- create_round_robin_tiebreak_group/create_bracket_tiebreak_group) por una sola: marcar
-- final_pending=true y devolver el control al cliente. La rama v_leaders_count = 1 (campeón
-- directo) y la proyección de líder inevitable con pendientes (0074) quedan idénticas.
create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_competition_format text;
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
  select competition_format, status, champion_user_id
  into v_competition_format, v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  -- round_robin_bo1_top4 tiene su propio flujo de cierre vía el bracket de top4; esta
  -- función no debe intervenir en ningún punto para este formato.
  if v_competition_format = 'round_robin_bo1_top4' then return; end if;

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

  -- v_leaders_count >= 2: el desempate de 1er puesto ahora lo arma el CLIENTE
  -- (EventDetailScreen.tsx), igual que round_robin_bo1_top4 ya hace para el desempate del 4to
  -- puesto — reusa la cascada completa de tanda1/tanda2 de podium.ts (head-to-head → calidad
  -- de rivales → hash), más precisa que comparar solo winrate acá. Esta función se limita a
  -- marcar final_pending=true; el cliente detecta esa señal (final_pending=true &&
  -- champion_user_id is null, competition_format='round_robin') y llama a
  -- create_round_robin_first_place_tiebreak_group con el grupo ya ordenado.
  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$$;

-- ── 3. evaluate_tiebreak_group_after_match — rama fourth_place extendida ───────────────────
-- Las ramas 'round_robin' y 'bracket' quedan copiadas tal cual desde 0072, sin cambios. La
-- rama 'fourth_place' gana conciencia de fase cuando group_origin='round_robin_first_place':
--   - bracket_phase='semi' → 1 victoria (BO1, igual que round_robin_fourth_place siempre).
--   - bracket_phase='final' → 2 victorias (BO3) — antes de esta migración TODO era BO1 acá.
-- Al resolverse la fase 'final' de round_robin_first_place, corona campeón del evento
-- directamente (status='completed') en vez de armar una fase siguiente.
create or replace function public.evaluate_tiebreak_group_after_match()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing record;
  v_event_id uuid;
  v_active_group record;
  v_participant_count integer;
  v_played_count integer;
  v_total_pairs_needed integer;
  v_winner_participant_id uuid;
  v_max_wins integer;
  v_leader_user_id uuid;
  v_leader_participant_ids uuid[];
  v_max_match_winrate numeric;
  v_winrate_leaders_count integer;
  v_event_already_completed boolean;
begin
  if new.match_type <> 'tiebreak' or new.status <> 'completed' then
    return new;
  end if;

  select event_id, participant_a_id, participant_b_id into v_pairing
  from public.pairings where id = new.pairing_id;
  v_event_id := v_pairing.event_id;

  select id, group_type, round_number, group_origin into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  -- ROUND ROBIN: sin cambios respecto a 0072.
  if v_active_group.group_type = 'round_robin' then
    select count(*) into v_participant_count
    from public.event_tiebreak_group_participants where group_id = v_active_group.id;

    v_total_pairs_needed := v_participant_count * (v_participant_count - 1) / 2;
    v_played_count := public.count_tiebreak_round_played(v_active_group.id, v_active_group.round_number);

    if v_event_already_completed then
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', resolved_at = now() where id = v_active_group.id;
      end if;
      return new;
    end if;

    select participant_id, public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number)
    into v_winner_participant_id, v_max_wins
    from public.event_tiebreak_group_participants where group_id = v_active_group.id
    order by public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number) desc limit 1;

    if v_max_wins = v_participant_count - 1 then
      select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      else
        update public.event_tiebreak_groups set champion_user_id = v_leader_user_id where id = v_active_group.id;
      end if;
      return new;
    end if;

    if v_played_count < v_total_pairs_needed then return new; end if;

    if v_active_group.round_number = 1 then
      select array_agg(participant_id order by participant_id) into v_leader_participant_ids
      from public.event_tiebreak_group_participants where group_id = v_active_group.id;
      update public.event_tiebreak_groups set status = 'failed' where id = v_active_group.id;
      perform public.create_round_robin_tiebreak_group(v_event_id, v_leader_participant_ids, 2);
      return new;
    end if;

    with winrates as (
      select etgp.participant_id, etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
      from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
    )
    select max(wr), count(*) filter (where wr = (select max(wr) from winrates))
    into v_max_match_winrate, v_winrate_leaders_count from winrates;

    if v_winrate_leaders_count = 1 then
      select user_id into v_leader_user_id from (
        select etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
        from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
      ) wr_table where wr = v_max_match_winrate;
      update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      return new;
    end if;

    update public.event_tiebreak_groups set status = 'failed', resolved_at = now() where id = v_active_group.id;
    update public.draft_events
    set polemica_winners = (
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) = v_max_match_winrate
    ),
    recognition_winners = coalesce(recognition_winners, '{}') || coalesce((
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) < v_max_match_winrate
    ), '{}'),
    champion_decided_by = 'polemica', status = 'completed', event_ended_at = now(), final_pending = false
    where id = v_event_id and champion_user_id is null;
    return new;
  end if;

  -- BRACKET (semis+final+3°/4° del top4 real, o de la Copa Polémica): sin cambios respecto a 0072.
  if v_active_group.group_type = 'bracket' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_bm_a uuid;
      v_bm_b uuid;
      v_wins_a integer;
      v_wins_b integer;
      v_wins_needed integer;
      v_llave_winner uuid;
      v_completed_semis integer;
      v_final_exists boolean;
      v_semi_winners uuid[];
      v_semi_losers uuid[];
      v_bracket_total integer;
      v_bracket_pending integer;
    begin
      select id, bracket_phase, participant_a_id, participant_b_id
      into v_bm_id, v_bm_phase, v_bm_a, v_bm_b
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      select count(*) filter (where m.winner_participant_id = v_bm_a),
             count(*) filter (where m.winner_participant_id = v_bm_b)
      into v_wins_a, v_wins_b
      from public.matches m
      where m.pairing_id = new.pairing_id
        and m.match_type = 'tiebreak'
        and m.status = 'completed';

      v_wins_needed := public.topcut_wins_needed(v_event_id, v_bm_phase);

      if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
        return new;
      end if;

      if v_wins_a >= v_wins_needed then
        v_llave_winner := v_bm_a;
      else
        v_llave_winner := v_bm_b;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_llave_winner,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      if v_bm_phase = 'semi' then
        select count(*) into v_completed_semis
        from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and bracket_phase = 'semi'
          and winner_participant_id is not null;

        if v_completed_semis >= 2 then
          select exists (
            select 1 from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'final'
          ) into v_final_exists;

          if not v_final_exists then
            select
              array_agg(winner_participant_id order by created_at),
              array_agg(
                case when winner_participant_id = participant_a_id
                     then participant_b_id else participant_a_id end
                order by created_at
              )
            into v_semi_winners, v_semi_losers
            from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'semi';

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'final', v_semi_winners[1], v_semi_winners[2]);

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'third_place', v_semi_losers[1], v_semi_losers[2]);

            perform public.link_bracket_matches_to_pairings(v_active_group.id);
          end if;
        end if;

      elsif v_bm_phase = 'final' then
        select user_id into v_leader_user_id
        from public.event_participants where id = v_llave_winner;

        update public.draft_events
        set champion_user_id = v_leader_user_id,
            champion_decided_by = 'tiebreak',
            event_ended_at = now(),
            status = 'completed',
            final_pending = false
        where id = v_event_id and champion_user_id is null;

        update public.event_tiebreak_groups
        set champion_user_id = v_leader_user_id
        where id = v_active_group.id and champion_user_id is null;
      end if;

      select count(*),
             count(*) filter (where winner_participant_id is null)
      into v_bracket_total, v_bracket_pending
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id;

      if v_bracket_total >= 4 and v_bracket_pending = 0 then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';
      end if;

      return new;
    end;
  end if;

  -- FOURTH_PLACE: desempate por el 4to puesto de round_robin_bo1_top4 (0071/0072) O desempate
  -- de 1er puesto de round_robin BO3 clásico (0075, group_origin='round_robin_first_place').
  if v_active_group.group_type = 'fourth_place' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_bm_a uuid;
      v_bm_b uuid;
      v_wins_a integer;
      v_wins_b integer;
      v_wins_needed integer;
      v_resolved_index integer;
      v_resolved_match jsonb;
      v_advances text;
      v_next_index integer;
      v_next_match jsonb;
      v_next_a_id uuid;
      v_next_b_id uuid;
      v_next_phase text;
      v_next_already_exists boolean;
      v_top3 uuid[];
      v_top4 uuid[];
    begin
      -- Ubicar la fila del bracket que matchea este pairing y sigue sin ganador.
      select id, bracket_phase, participant_a_id, participant_b_id
      into v_bm_id, v_bm_phase, v_bm_a, v_bm_b
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      if v_active_group.group_origin = 'round_robin_first_place' then
        -- Victorias necesarias según la fase: semi = BO1 (1), final = BO3 (2) — la final es la
        -- que corona campeón, se juega con la misma exigencia que tenía antes de esta migración.
        v_wins_needed := case when v_bm_phase = 'final' then 2 else 1 end;

        select count(*) filter (where m.winner_participant_id = v_bm_a),
               count(*) filter (where m.winner_participant_id = v_bm_b)
        into v_wins_a, v_wins_b
        from public.matches m
        where m.pairing_id = new.pairing_id
          and m.match_type = 'tiebreak'
          and m.status = 'completed';

        if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
          -- Todavía falta la vuelta de la final (BO3): no resolver esta llave todavía.
          return new;
        end if;

        v_winner_participant_id := case when v_wins_a >= v_wins_needed then v_bm_a else v_bm_b end;
      else
        -- round_robin_fourth_place (comportamiento original, 0072): siempre BO1, la primera
        -- partida decide.
        v_winner_participant_id := new.winner_participant_id;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      -- Ubicar, en pending_bracket_matches (estructura íntegra guardada al crear el grupo), el
      -- índice del partido recién resuelto y su winnerAdvancesTo.
      select ord.idx - 1, ord.elem
      into v_resolved_index, v_resolved_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id
        and (ord.elem->'a' ? 'participantId')
        and (ord.elem->'b' ? 'participantId')
        and (
          ((ord.elem->'a'->>'participantId')::uuid = v_bm_a and (ord.elem->'b'->>'participantId')::uuid = v_bm_b)
          or ((ord.elem->'a'->>'participantId')::uuid = v_bm_b and (ord.elem->'b'->>'participantId')::uuid = v_bm_a)
        )
      limit 1;

      if v_resolved_index is null then
        return new;
      end if;

      v_advances := v_resolved_match->>'winnerAdvancesTo';

      -- Materializar el ganador: sustituir cualquier slot {"winnerOfMatch": v_resolved_index} por
      -- {"participantId": <ganador real>} en TODO pending_bracket_matches.
      update public.event_tiebreak_groups
      set pending_bracket_matches = (
        select jsonb_agg(
          jsonb_build_object(
            'round', elem->'round',
            'a', case
                   when (elem->'a' ? 'winnerOfMatch') and (elem->'a'->>'winnerOfMatch')::integer = v_resolved_index
                   then jsonb_build_object('participantId', v_winner_participant_id::text)
                   else elem->'a'
                 end,
            'b', case
                   when (elem->'b' ? 'winnerOfMatch') and (elem->'b'->>'winnerOfMatch')::integer = v_resolved_index
                   then jsonb_build_object('participantId', v_winner_participant_id::text)
                   else elem->'b'
                 end,
            'winnerAdvancesTo', elem->'winnerAdvancesTo'
          )
          order by ord.idx
        )
        from jsonb_array_elements(pending_bracket_matches) with ordinality as ord(elem, idx)
      )
      where id = v_active_group.id;

      if v_advances = 'final_4th' then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';

        if v_active_group.group_origin = 'round_robin_first_place' then
          -- Acá no hay próxima fase: el ganador de la final ES el campeón del evento.
          select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;
          return new;
        end if;

        -- round_robin_fourth_place (comportamiento original, 0072): arma el top4 real.
        select array_agg(participant_id order by seed) into v_top3
        from public.event_tiebreak_group_participants
        where group_id = v_active_group.id;

        if v_top3 is not null and array_length(v_top3, 1) = 3 then
          v_top4 := v_top3 || v_winner_participant_id;
          perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
        end if;

        return new;
      end if;

      -- Si no, el ganador avanza al partido con índice v_advances (0-based). Revisar si, tras la
      -- sustitución de arriba, ese partido ya tiene AMBOS lados concretos.
      v_next_index := v_advances::integer;

      select ord.elem into v_next_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id and ord.idx - 1 = v_next_index;

      if v_next_match is null
        or not (v_next_match->'a' ? 'participantId')
        or not (v_next_match->'b' ? 'participantId') then
        return new;
      end if;

      v_next_a_id := (v_next_match->'a'->>'participantId')::uuid;
      v_next_b_id := (v_next_match->'b'->>'participantId')::uuid;
      v_next_phase := case when v_next_match->>'winnerAdvancesTo' = 'final_4th' then 'final' else 'semi' end;

      select exists (
        select 1 from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and ((participant_a_id = v_next_a_id and participant_b_id = v_next_b_id)
            or (participant_a_id = v_next_b_id and participant_b_id = v_next_a_id))
      ) into v_next_already_exists;

      if not v_next_already_exists then
        insert into public.event_tiebreak_bracket_matches
          (group_id, bracket_phase, participant_a_id, participant_b_id)
        values (v_active_group.id, v_next_phase, v_next_a_id, v_next_b_id);

        perform public.link_bracket_matches_to_pairings(v_active_group.id);
      end if;

      return new;
    end;
  end if;

  return new;
end;
$$;
