-- Snapshot del estado de seguridad (funciones y triggers) tomado de la base el 2026-11-05.
-- Generado con pg_get_functiondef y pg_get_triggerdef. Incluye: funciones guard_event_call,
-- can_manage_event, las *_impl y sus wrappers, y los triggers de proteccion.
-- Es idempotente para funciones (create or replace). Los triggers fallan si ya existen:
-- en una base nueva se aplican una sola vez.

-- FUNCIONES

CREATE OR REPLACE FUNCTION public.apply_knockout_walkover(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res integer;
        begin
          v_outer := public.guard_event_call('participant', p_participant_id, 'self_or_manager');
          v_res := public.apply_knockout_walkover_impl(p_participant_id := p_participant_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.apply_knockout_walkover_impl(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_format text;
  v_status text;
  v_group_id uuid;
  v_bm record;
  v_stayer uuid;
  v_count integer := 0;
begin
  select ep.event_id, ep.left_event_at into v_event_id, v_left_event_at
  from public.event_participants ep where ep.id = p_participant_id;

  if v_event_id is null then
    raise exception 'apply_knockout_walkover: el participante no existe.';
  end if;

  select de.competition_format, de.status into v_format, v_status
  from public.draft_events de where de.id = v_event_id and de.deleted_at is null;

  if v_format is null or v_format not in ('knockout', 'zones_knockout') then
    raise exception 'apply_knockout_walkover: el evento no es una Copa (sólo llaves ni grupos + llaves).';
  end if;

  if v_left_event_at is null then
    return 0;
  end if;

  -- 'completed' también: el 3er puesto puede seguir pendiente después de la final.
  if v_status not in ('playing', 'completed') then
    return 0;
  end if;

  -- 0135: puede haber dos cuadros activos (la copa principal y la 2da oportunidad); se recorren los dos.
  for v_group_id in
    select g.id
    from public.event_tiebreak_groups g
    where g.event_id = v_event_id
      and g.group_origin in ('knockout_bracket', 'knockout_second_chance')
      and g.status = 'active'
    order by g.created_at, g.id
  loop
    perform pg_advisory_xact_lock(hashtext('knockout:' \|\| v_group_id::text));

    for v_bm in
      select bm.id, bm.participant_a_id, bm.participant_b_id
      from public.event_tiebreak_bracket_matches bm
      where bm.group_id = v_group_id
        and bm.winner_participant_id is null
        and bm.pairing_id is not null
        and (bm.participant_a_id = p_participant_id or bm.participant_b_id = p_participant_id)
    loop
      v_stayer := case when v_bm.participant_a_id = p_participant_id then v_bm.participant_b_id
                       else v_bm.participant_a_id end;

      -- Si el rival también se fue no hay a quién darle el walkover: queda pendiente.
      if exists (select 1 from public.event_participants where id = v_stayer and left_event_at is not null) then
        continue;
      end if;

      if public.knockout_walkover_row(v_bm.id, v_stayer) > 0 then
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_walkover_for_participant(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res integer;
        begin
          v_outer := public.guard_event_call('participant', p_participant_id, 'self_or_manager');
          v_res := public.apply_walkover_for_participant_impl(p_participant_id := p_participant_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.apply_walkover_for_participant_impl(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
      -- 0138: un pairing de sólo venganza (stage 'revenge') no tiene partido oficial pendiente: nunca recibe walkover.
      and p.stage is distinct from 'revenge'
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
$function$
;

CREATE OR REPLACE FUNCTION public.apply_walkover_for_tiebreak_leg(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res integer;
        begin
          v_outer := public.guard_event_call('participant', p_participant_id, 'self_or_manager');
          v_res := public.apply_walkover_for_tiebreak_leg_impl(p_participant_id := p_participant_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.apply_walkover_for_tiebreak_leg_impl(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    select g.id, g.round_number, g.group_origin
    from public.event_tiebreak_groups g
    where g.event_id = v_event_id
      and g.group_type = 'fourth_place'
      and g.group_origin in ('round_robin_first_place', 'round_robin_fourth_place')
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

      -- round_robin_first_place: semi=BO1(1), final=BO3(2). round_robin_fourth_place: siempre
      -- BO1(1) en cualquier fase — mismo criterio que evaluate_tiebreak_group_after_match.
      v_wins_needed := case
        when v_group.group_origin = 'round_robin_first_place' and v_bm.bracket_phase = 'final' then 2
        else 1
      end;

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
$function$
;

CREATE OR REPLACE FUNCTION public.apply_walkover_for_topcut_bracket_leg(p_participant_id uuid, p_group_origin text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res integer;
        begin
          v_outer := public.guard_event_call('participant', p_participant_id, 'self_or_manager');
          v_res := public.apply_walkover_for_topcut_bracket_leg_impl(p_participant_id := p_participant_id, p_group_origin := p_group_origin);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.apply_walkover_for_topcut_bracket_leg_impl(p_participant_id uuid, p_group_origin text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
      and g.group_type = 'bracket'
      and g.group_origin = p_group_origin
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
      -- Sin filtro de "¿esta fila ya arrancó?": ya existe materializada — walkover directo.
    loop
      v_stayer_id := case
        when v_bm.participant_a_id = p_participant_id then v_bm.participant_b_id
        else v_bm.participant_a_id
      end;

      v_wins_needed := public.topcut_wins_needed(v_event_id, v_bm.bracket_phase);

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
        -- bracket (evaluate_tiebreak_group_after_match, rama 'bracket') dispara en AFTER UPDATE,
        -- no AFTER INSERT.
        update public.matches
        set status = 'completed', winner_participant_id = v_stayer_id, is_walkover = true, ended_at = now()
        where id = v_match_id;
      end loop;

      v_resolved_count := v_resolved_count + 1;
    end loop;
  end loop;

  return v_resolved_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.can_manage_event(p_workspace_id uuid, p_event_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select
    public.is_workspace_organizer(p_workspace_id)
    or exists (
      select 1 from public.draft_events de
      where de.id = p_event_id
        and de.workspace_id = p_workspace_id
        and de.event_organizer_user_id = auth.uid()
        and public.is_workspace_member(p_workspace_id)
    );
$function$
;

CREATE OR REPLACE FUNCTION public.close_active_round_robin_first_place_group(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'self_or_manager');
          v_res := public.close_active_round_robin_first_place_group_impl(p_event_id := p_event_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.close_active_round_robin_first_place_group_impl(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.close_active_round_robin_fourth_place_group(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'self_or_manager');
          v_res := public.close_active_round_robin_fourth_place_group_impl(p_event_id := p_event_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.close_active_round_robin_fourth_place_group_impl(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_type = 'fourth_place'
    and group_origin = 'round_robin_fourth_place'
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
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.close_active_topcut_bracket_group(p_event_id uuid, p_group_origin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'self_or_manager');
          v_res := public.close_active_topcut_bracket_group_impl(p_event_id := p_event_id, p_group_origin := p_group_origin);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.close_active_topcut_bracket_group_impl(p_event_id uuid, p_group_origin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_type = 'bracket'
    and group_origin = p_group_origin
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
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.compute_event_champion(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'self_or_manager');
          perform public.compute_event_champion_impl(p_event_id := p_event_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return;
        end $function$
;

CREATE OR REPLACE FUNCTION public.compute_event_champion_impl(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_competition_format text;
  v_top_size integer;
  v_match_format text;
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_score numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_existing_active_group_id uuid;
  v_proj_leader_user_id uuid;
  v_proj_leader_participant_id uuid;
  v_proj_min_score numeric;
  v_proj_threats integer;
begin
  select competition_format, top_size, match_format, status, champion_user_id
  into v_competition_format, v_top_size, v_match_format, v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  -- Copa (competition_format 'zones_knockout' / 'knockout', 0129): su campeón sale de la final del
  -- bracket, nunca de la tabla de liga. Esta función no interviene en ningún punto: ni proyecta un
  -- líder, ni marca final_pending, ni cambia status.
  if v_competition_format in ('zones_knockout', 'knockout') then return; end if;

  -- round_robin + top_size=4 (antes competition_format='round_robin_bo1_top4') tiene su propio
  -- flujo de cierre vía el bracket de top4; esta función no debe intervenir en ningún punto
  -- para este formato.
  if v_competition_format = 'round_robin' and coalesce(v_top_size, 0) = 4 then return; end if;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;

  select id into v_existing_active_group_id
  from public.event_tiebreak_groups where event_id = p_event_id and status = 'active' limit 1;
  if v_existing_active_group_id is not null then return; end if;

  select count(*), count(*) filter (where official_winner_participant_id is null and official_draw = false)
  into v_total_pairings, v_pending_pairings_total
  from public.pairings p where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Líder matemáticamente inevitable con pairings aún pendientes (0074). BO1/BO3: winrate
  -- proyectado, sin cambios. BO2: puntos totales absolutos (peor caso del candidato = puntos
  -- actuales sin sumar nada de sus pendientes; mejor caso de cada rival = puntos actuales + 3
  -- por cada pendiente que le queda, asumiendo que los gana todos). Quien tiene left_event_at
  -- seteado no puede ser candidato (no va a jugar más) ni contar como amenaza (no puede alcanzar
  -- a nadie si no va a jugar más). El "is_blocked" de pairing_block (mismo criterio "algún lado
  -- se fue" que antes) sigue vivo acá adentro a propósito — ver comentario arriba: decide qué
  -- pendientes cuentan como "todavía disputables" para el rango de la proyección, no si el
  -- evento puede cerrar (eso ahora lo decide solo v_pending_pairings_total).
  if v_pending_pairings_total > 0 and v_event_champion_user_id is null then
    with pairing_block as (
      select
        p.participant_a_id,
        p.participant_b_id,
        p.official_winner_participant_id,
        p.official_draw,
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
          where (pb.official_winner_participant_id is not null or pb.official_draw = true)
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as completed_now,
        count(*) filter (
          where pb.official_winner_participant_id = ep.id
        ) as won_now,
        count(*) filter (
          where pb.official_draw = true
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as draws_now,
        count(*) filter (
          where pb.official_winner_participant_id is null
            and pb.official_draw = false
            and not pb.is_blocked
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as pending_active
      from public.event_participants ep
      left join pairing_block pb on pb.participant_a_id = ep.id or pb.participant_b_id = ep.id
      where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      group by ep.user_id, ep.id
    ),
    projected as (
      select
        user_id,
        participant_id,
        (completed_now + pending_active) as final_completed,
        case when v_match_format = 'bo2'
          then (won_now * 3 + draws_now)::numeric
          else (won_now::numeric / nullif(completed_now + pending_active, 0))
        end as min_score,
        case when v_match_format = 'bo2'
          then (won_now * 3 + draws_now + pending_active * 3)::numeric
          else ((won_now + pending_active)::numeric / nullif(completed_now + pending_active, 0))
        end as max_score
      from projection
    ),
    candidate as (
      select user_id, participant_id, min_score
      from projected
      where final_completed >= v_min_bo3_required
      order by min_score desc nulls last
      limit 1
    )
    select c.user_id, c.participant_id, c.min_score,
      (select count(*) from projected q
        where q.participant_id <> c.participant_id and q.max_score >= c.min_score)
    into v_proj_leader_user_id, v_proj_leader_participant_id, v_proj_min_score, v_proj_threats
    from candidate c;

    if v_proj_leader_user_id is not null and v_proj_min_score is not null and v_proj_threats = 0 then
      update public.draft_events
        set champion_user_id = v_proj_leader_user_id, champion_decided_by = 'auto_projected'
      where id = p_event_id and status = 'playing' and champion_user_id is null;
    end if;
  end if;

  if v_pending_pairings_total > 0 then return; end if;

  -- Criterio de liderazgo: BO1/BO3 = winrate (won/completed), sin cambios. BO2 = puntos totales
  -- absolutos (won*3 + draws*1), no proporción — "completed" (para el umbral v_min_bo3_required)
  -- sigue siendo pairings resueltos, ahora incluyendo empates. Quien tiene left_event_at seteado
  -- queda afuera del pool de candidatos a campeón (sigue siendo necesario: puede terminar con el
  -- mejor récord real aunque el walkover ya haya resuelto sus pendientes en su contra).
  with player_bo3 as (
    select ep.user_id, ep.id as participant_id,
      count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won,
      count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, draws,
      case when v_match_format = 'bo2' then (won * 3 + draws)::numeric
           else (won::numeric / nullif(completed, 0))
      end as score
    from player_bo3 where completed >= v_min_bo3_required
  )
  select max(score), count(*) filter (where score = (select max(score) from eligible))
  into v_max_score, v_leaders_count from eligible;

  if v_max_score is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id from (
      select ep.user_id,
        count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won,
        count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      group by ep.user_id
    ) leaders
    where (case when v_match_format = 'bo2' then (won * 3 + draws)::numeric
                else (won::numeric / nullif(completed, 0))
           end) = v_max_score
      and completed >= v_min_bo3_required;
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
$function$
;

CREATE OR REPLACE FUNCTION public.create_fourth_place_tiebreak_group(p_event_id uuid, p_matches jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'member');
          v_res := public.create_fourth_place_tiebreak_group_impl(p_event_id := p_event_id, p_matches := p_matches);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.create_fourth_place_tiebreak_group(p_event_id uuid, p_matches jsonb, p_top3_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'member');
          v_res := public.create_fourth_place_tiebreak_group_impl(p_event_id := p_event_id, p_matches := p_matches, p_top3_ordered := p_top3_ordered);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.create_fourth_place_tiebreak_group_impl(p_event_id uuid, p_matches jsonb, p_top3_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  where event_id = p_event_id and group_type = 'fourth_place' and status = 'active';

  if v_existing > 0 then return false; end if;

  -- El bracket real de top4 se crea recién cuando este desempate se resuelve (paso posterior);
  -- si ya existe uno ACTIVO, este desempate llegó tarde/duplicado. Uno viejo ya resuelto (0089,
  -- recálculo de Fase 4 que descubrió una disputa nueva) no debe bloquear esto.
  if exists (
    select 1 from public.event_tiebreak_groups
    where event_id = p_event_id and group_type = 'bracket' and group_origin = 'round_robin_topcut'
      and status = 'active'
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
$function$
;

CREATE OR REPLACE FUNCTION public.create_fourth_place_tiebreak_group_impl(p_event_id uuid, p_matches jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format text;
  v_existing integer;
  v_group_id uuid;
  v_match jsonb;
  v_a_id uuid;
  v_b_id uuid;
  v_advances text;
  v_phase text;
begin
  select competition_format into v_format
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin_bo1_top4' then return false; end if;

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
  -- cliente haya calculado (mismo criterio que create_round_robin_top4_bracket, 0069).
  if exists (
    select 1 from public.pairings
    where event_id = p_event_id and official_winner_participant_id is null
  ) then
    return false;
  end if;

  if p_matches is null or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) = 0 then
    return false;
  end if;

  insert into public.event_tiebreak_groups
    (event_id, round_number, group_type, group_origin, status, pending_bracket_matches)
  values (p_event_id, 1, 'fourth_place', 'round_robin_fourth_place', 'active', p_matches)
  returning id into v_group_id;

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
$function$
;

CREATE OR REPLACE FUNCTION public.create_round_robin_first_place_tiebreak_group(p_event_id uuid, p_matches jsonb, p_tied_participants_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'member');
          v_res := public.create_round_robin_first_place_tiebreak_group_impl(p_event_id := p_event_id, p_matches := p_matches, p_tied_participants_ordered := p_tied_participants_ordered);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.create_round_robin_first_place_tiebreak_group_impl(p_event_id uuid, p_matches jsonb, p_tied_participants_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.create_round_robin_top4_bracket(p_event_id uuid, p_top4_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'member');
          v_res := public.create_round_robin_top4_bracket_impl(p_event_id := p_event_id, p_top4_ordered := p_top4_ordered);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.create_round_robin_top4_bracket_impl(p_event_id uuid, p_top4_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  where event_id = p_event_id and group_type = 'bracket' and status = 'active';

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
$function$
;

CREATE OR REPLACE FUNCTION public.create_swiss_top4_bracket(p_event_id uuid, p_top4_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'member');
          v_res := public.create_swiss_top4_bracket_impl(p_event_id := p_event_id, p_top4_ordered := p_top4_ordered);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.create_swiss_top4_bracket_impl(p_event_id uuid, p_top4_ordered uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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

  if v_format <> 'swiss' or coalesce(v_top_size, 0) <> 4 then return false; end if;

  -- Idempotente: no crear un segundo bracket para el mismo evento. Solo filas ACTIVAS bloquean
  -- (un bracket viejo cerrado por recálculo de walkover, status='superseded' o 'resolved', no
  -- debe impedir crear el nuevo).
  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'bracket' and status = 'active';

  if v_existing > 0 then return false; end if;

  if p_top4_ordered is null or array_length(p_top4_ordered, 1) <> 4 then
    return false;
  end if;

  select count(*) into v_distinct_count
  from (select distinct unnest(p_top4_ordered)) u;

  if v_distinct_count <> 4 then return false; end if;

  select count(*) into v_valid_count
  from public.event_participants ep
  where ep.id = any (p_top4_ordered)
    and ep.event_id = p_event_id
    and ep.role = 'player';

  if v_valid_count <> 4 then return false; end if;

  -- Defensa en profundidad: la fase regular suiza debe estar 100% resuelta. Solo cuentan los
  -- pairings CON swiss_round asignado (mismo criterio que 0098).
  select count(*) into v_pending
  from public.pairings
  where event_id = p_event_id
    and swiss_round is not null
    and official_winner_participant_id is null
    and official_draw = false;

  if v_pending > 0 then return false; end if;

  v_new_group_id := public.create_bracket_tiebreak_group(p_event_id, p_top4_ordered);

  update public.event_tiebreak_groups
  set group_origin = 'swiss_topcut'
  where id = v_new_group_id;

  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.event_color_predictions_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if current_user in ('authenticated', 'anon')
     and (NEW.predicted_color is distinct from OLD.predicted_color
          or NEW.event_id is distinct from OLD.event_id
          or NEW.user_id is distinct from OLD.user_id) then
    raise exception 'La predicción de color no se puede modificar' using errcode = '42501';
  end if;
  return NEW;
end
$function$
;

CREATE OR REPLACE FUNCTION public.generate_all_pairings(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'manager');
          perform public.generate_all_pairings_impl(p_event_id := p_event_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return;
        end $function$
;

CREATE OR REPLACE FUNCTION public.generate_all_pairings_impl(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_p1 uuid;
  v_p2 uuid;
  v_p_a uuid;
  v_p_b uuid;
  players uuid[];
  i integer;
  j integer;
  n integer;
begin
  select array_agg(id order by id) into players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  n := coalesce(array_length(players, 1), 0);
  if n < 2 then return; end if;

  i := 1;
  while i < n loop
    j := i + 1;
    while j <= n loop
      v_p1 := players[i];
      v_p2 := players[j];
      if v_p1 < v_p2 then v_p_a := v_p1; v_p_b := v_p2;
      else v_p_a := v_p2; v_p_b := v_p1;
      end if;

      insert into public.pairings (event_id, participant_a_id, participant_b_id)
      values (p_event_id, v_p_a, v_p_b)
      on conflict (event_id, participant_a_id, participant_b_id) do nothing;

      j := j + 1;
    end loop;
    i := i + 1;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_swiss_bo2_round(p_event_id uuid, p_round integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'manager');
          perform public.generate_swiss_bo2_round_impl(p_event_id := p_event_id, p_round := p_round);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return;
        end $function$
;

CREATE OR REPLACE FUNCTION public.generate_swiss_bo2_round_impl(p_event_id uuid, p_round integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_already_played uuid[] := '{}';
  v_rec record;
  v_result uuid[];
  v_p_a uuid;
  v_p_b uuid;
  v_k integer;
begin
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and coalesce(array_length(ep.bye_rounds, 1), 0) = 0
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  for v_rec in
    select participant_a_id, participant_b_id
    from public.pairings
    where event_id = p_event_id and swiss_round is not null
  loop
    v_already_played := v_already_played \|\| v_rec.participant_a_id \|\| v_rec.participant_b_id;
  end loop;

  v_result := public.swiss_find_valid_pairing(v_remaining_participants, v_already_played);

  if v_result is null then
    raise exception 'No existe una combinación de cruces sin repetidos para la ronda % del evento % (Suizo BO2).', p_round, p_event_id;
  end if;

  v_k := 1;
  while v_k <= coalesce(array_length(v_result, 1), 0) loop
    if v_result[v_k] < v_result[v_k + 1] then
      v_p_a := v_result[v_k]; v_p_b := v_result[v_k + 1];
    else
      v_p_a := v_result[v_k + 1]; v_p_b := v_result[v_k];
    end if;

    update public.pairings
    set swiss_round = p_round
    where event_id = p_event_id
      and participant_a_id = v_p_a
      and participant_b_id = v_p_b;

    v_k := v_k + 2;
  end loop;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;

  perform public.recalc_swiss_tiebreakers(p_event_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_swiss_round(p_event_id uuid, p_round integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'manager');
          perform public.generate_swiss_round_impl(p_event_id := p_event_id, p_round := p_round);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return;
        end $function$
;

CREATE OR REPLACE FUNCTION public.generate_swiss_round_impl(p_event_id uuid, p_round integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_already_played uuid[] := '{}';
  v_rec record;
  v_result uuid[];
  v_p_a uuid;
  v_p_b uuid;
  v_k integer;
begin
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and not (p_round = any (ep.bye_rounds))
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  for v_rec in
    select participant_a_id, participant_b_id
    from public.pairings
    where event_id = p_event_id and swiss_round is not null
  loop
    v_already_played := v_already_played \|\| v_rec.participant_a_id \|\| v_rec.participant_b_id;
  end loop;

  v_result := public.swiss_find_valid_pairing(v_remaining_participants, v_already_played);

  if v_result is null then
    raise exception 'No existe una combinación de cruces sin repetidos para la ronda % del evento % (Suizo).', p_round, p_event_id;
  end if;

  v_k := 1;
  while v_k <= coalesce(array_length(v_result, 1), 0) loop
    if v_result[v_k] < v_result[v_k + 1] then
      v_p_a := v_result[v_k]; v_p_b := v_result[v_k + 1];
    else
      v_p_a := v_result[v_k + 1]; v_p_b := v_result[v_k];
    end if;

    update public.pairings
    set swiss_round = p_round
    where event_id = p_event_id
      and participant_a_id = v_p_a
      and participant_b_id = v_p_b;

    v_k := v_k + 2;
  end loop;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;

  perform public.recalc_swiss_tiebreakers(p_event_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_event_call(p_kind text, p_id uuid, p_level text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_event uuid; v_ws uuid; v_ok boolean := false;
begin
  if v_uid is null then return false; end if;
  if pg_trigger_depth() > 0 then return false; end if;
  if coalesce(current_setting('app.guard_inside', true), '') = '1' then return false; end if;

  if p_kind = 'participant' then
    select ep.event_id into v_event from public.event_participants ep where ep.id = p_id;
  else
    v_event := p_id;
  end if;
  select de.workspace_id into v_ws from public.draft_events de where de.id = v_event;
  if v_ws is null then raise exception 'forbidden' using errcode = '42501'; end if;

  if p_level = 'manager' then
    v_ok := public.can_manage_event(v_ws, v_event);
  elsif p_level = 'member' then
    v_ok := public.is_workspace_member(v_ws);
  elsif p_level = 'self_or_manager' then
    v_ok := public.can_manage_event(v_ws, v_event)
      or exists (select 1 from public.event_participants ep
                 where (case when p_kind = 'participant' then ep.id = p_id else ep.event_id = v_event end)
                   and (ep.user_id = v_uid or ep.member_b_user_id = v_uid));
  end if;
  if not v_ok then raise exception 'forbidden' using errcode = '42501'; end if;

  perform set_config('app.guard_inside', '1', true);
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.limit_workspaces_per_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  select count(*) into n from public.workspaces where created_by = NEW.created_by and deleted_at is null;
  if n >= 3 then
    raise exception 'Límite de workspaces por cuenta alcanzado' using errcode = '54000';
  end if;
  return NEW;
end
$function$
;

CREATE OR REPLACE FUNCTION public.matches_guard_finished()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if current_user in ('authenticated', 'anon')
     and (OLD.ended_at is not null
          or OLD.status::text in ('aborted', 'cancelled', 'finished', 'completed')) then
    raise exception 'No se puede modificar un enfrentamiento terminado' using errcode = '42501';
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.randomize_giant_pairs(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'manager');
          perform public.randomize_giant_pairs_impl(p_event_id := p_event_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return;
        end $function$
;

CREATE OR REPLACE FUNCTION public.randomize_giant_pairs_impl(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_part_ids           uuid[];
  v_count              integer;
  v_a_id               uuid;
  v_b_id               uuid;
  v_a_user_id          uuid;
  v_b_user_id          uuid;
  v_a_name             text;
  v_b_name             text;
  v_is_shiny           boolean;
  v_avatar_id          uuid;
  v_b_rotated_avatar_id uuid;
  v_giant_name         text;
  i                    integer;
begin
  -- Participantes elegibles: jugadores activos sin par asignado, en orden aleatorio.
  select array_agg(ep.id order by random())
  into v_part_ids
  from public.event_participants ep
  where ep.event_id        = p_event_id
    and ep.role            = 'player'
    and ep.member_b_user_id is null
    and ep.left_event_at   is null;

  v_count := coalesce(array_length(v_part_ids, 1), 0);

  if v_count % 2 <> 0 or v_count < 4 then
    raise exception 'INVALID_COUNT';
  end if;

  i := 1;
  while i <= v_count - 1 loop
    -- Coin flip: quien queda como A y quien como B es aleatorio dentro del par.
    if random() > 0.5 then
      v_a_id := v_part_ids[i];
      v_b_id := v_part_ids[i + 1];
    else
      v_a_id := v_part_ids[i + 1];
      v_b_id := v_part_ids[i];
    end if;

    -- Datos de miembro A.
    select ep.user_id,
           coalesce(u.display_name, u.username, 'UNK')
    into   v_a_user_id, v_a_name
    from   public.event_participants ep
    join   public.users u on u.id = ep.user_id
    where  ep.id = v_a_id;

    -- Datos de miembro B: usuario, nombre, y avatar/shiny preexistentes de su inscripción.
    select ep.user_id,
           coalesce(u.display_name, u.username, 'UNK'),
           ep.rotated_avatar_id,
           ep.is_shiny
    into   v_b_user_id, v_b_name, v_b_rotated_avatar_id, v_is_shiny
    from   public.event_participants ep
    join   public.users u on u.id = ep.user_id
    where  ep.id = v_b_id;

    -- Conservar avatar/shiny preexistente de B.
    -- Solo si no tiene rotated_avatar_id asignado (caso borde), asignar uno nuevo.
    v_avatar_id := v_b_rotated_avatar_id;
    if v_avatar_id is null then
      select id into v_avatar_id
      from   public.default_avatars
      where  is_active = true
        and  id not in (
               select rotated_avatar_id
               from   public.event_participants
               where  event_id = p_event_id
                 and  rotated_avatar_id is not null
               union all
               select member_b_rotated_avatar_id
               from   public.event_participants
               where  event_id = p_event_id
                 and  member_b_rotated_avatar_id is not null
             )
      order by random()
      limit 1;
      -- Tirada de shiny solo en el fallback (cuando no había avatar previo).
      v_is_shiny := (random() < (1.0 / 4096.0));
    end if;

    -- Nombre del gigante: primera letra mayúscula + resto minúsculas (máx 3 chars).
    v_giant_name := upper(left(v_a_name, 1)) \|\| lower(substring(v_a_name, 2, 2))
                 \|\| '-'
                 \|\| upper(left(v_b_name, 1)) \|\| lower(substring(v_b_name, 2, 2));

    -- Absorber B en la fila de A.
    update public.event_participants
    set member_b_user_id           = v_b_user_id,
        member_b_rotated_avatar_id = v_avatar_id,
        member_b_is_shiny          = v_is_shiny,
        giant_name                 = v_giant_name
    where id = v_a_id;

    -- Eliminar la fila de B (on delete cascade limpia participant_colors de B).
    delete from public.event_participants where id = v_b_id;

    i := i + 2;
  end loop;

  update public.draft_events
  set giant_randomization_done = true
  where id = p_event_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.re_randomize_giant_pairs(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean;
        begin
          v_outer := public.guard_event_call('event', p_event_id, 'manager');
          perform public.re_randomize_giant_pairs_impl(p_event_id := p_event_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return;
        end $function$
;

CREATE OR REPLACE FUNCTION public.re_randomize_giant_pairs_impl(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_done       boolean;
  v_started_at timestamptz;
  v_rec        record;
begin
  select giant_randomization_done, draft_started_at
  into   v_done, v_started_at
  from   public.draft_events
  where  id = p_event_id;

  if not coalesce(v_done, false) then
    raise exception 'RANDOMIZATION_NOT_DONE';
  end if;

  if v_started_at is not null then
    raise exception 'DRAFT_ALREADY_STARTED';
  end if;

  -- Para cada gigante: re-insertar B como participante independiente y limpiar A.
  -- El trigger assign_rotated_avatar le asignará a B su avatar del histórico
  -- (o uno nuevo si no tiene), de forma transitoria — randomize lo absorberá.
  for v_rec in
    select id, member_b_user_id
    from   public.event_participants
    where  event_id = p_event_id
      and  member_b_user_id is not null
  loop
    insert into public.event_participants (event_id, user_id, role)
    values (p_event_id, v_rec.member_b_user_id, 'player');

    update public.event_participants
    set member_b_user_id           = null,
        member_b_rotated_avatar_id = null,
        member_b_is_shiny          = false,
        giant_name                 = null
    where id = v_rec.id;
  end loop;

  -- Limpiar colores declarados del miembro B (chekin de gigantes previo).
  delete from public.participant_colors
  where  participant_id in (
           select id from public.event_participants where event_id = p_event_id
         )
    and  member = 'b';

  -- Nuevo sorteo aleatorio.
  perform public.randomize_giant_pairs(p_event_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.revert_walkover_for_participant(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
        declare v_outer boolean; v_res integer;
        begin
          v_outer := public.guard_event_call('participant', p_participant_id, 'manager');
          v_res := public.revert_walkover_for_participant_impl(p_participant_id := p_participant_id);
          if v_outer then perform set_config('app.guard_inside', '', true); end if;
          return v_res;
        end $function$
;

CREATE OR REPLACE FUNCTION public.revert_walkover_for_participant_impl(p_participant_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_count integer;
begin
  with deleted as (
    delete from public.matches m
    using public.pairings p
    where m.pairing_id = p.id
      and m.is_walkover = true
      and m.match_type = 'draft'
      and m.winner_participant_id <> p_participant_id
      and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id)
    returning m.pairing_id
  ),
  distinct_pairings as (
    select distinct pairing_id from deleted
  )
  update public.pairings
  set official_winner_participant_id = null,
      official_resolved_at = null,
      official_draw = false
  where id in (select pairing_id from distinct_pairings);

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_event_shiny_flag()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.is_shiny = true then
    update public.draft_events
    set has_shiny_participant = true
    where id = new.event_id;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.users_guard_birthday()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if auth.role() in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.birthday := null;
    else
      new.birthday := old.birthday;
    end if;
  end if;
  return new;
end;
$function$
;

-- TRIGGERS

CREATE TRIGGER tr_event_shiny_flag AFTER INSERT OR UPDATE ON public.event_participants FOR EACH ROW EXECUTE FUNCTION update_event_shiny_flag();
CREATE TRIGGER trg_event_color_predictions_guard BEFORE UPDATE ON public.event_color_predictions FOR EACH ROW EXECUTE FUNCTION event_color_predictions_guard();
CREATE TRIGGER trg_limit_workspaces_per_user BEFORE INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION limit_workspaces_per_user();
CREATE TRIGGER trg_matches_guard_finished BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION matches_guard_finished();
CREATE TRIGGER trg_users_guard_birthday BEFORE INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION users_guard_birthday();
