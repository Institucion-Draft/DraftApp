-- 0135_knockout_second_chance.sql
-- Copa (sólo llaves): 2da oportunidad.
--
-- Quien pierde su primer partido REAL en la copa principal (el primer slot no-bye donde juega: octavos para los
-- que juegan octavos, cuartos o semis para los que entran con bye, etc.) pasa a una segunda copa en paralelo.
-- Quien ya ganó su primer partido y pierde después NO entra. Se excluye a quienes tienen left_event_at (un primer
-- partido perdido por walkover cuenta como perdido, pero si el que perdió es quien se fue, no entra).
-- Se sortea recién cuando TODOS los primeros partidos de la copa principal están resueltos, y sólo si hay 4 o más
-- entrantes. Es un cuadro de eliminación directa normal para N entrantes (4 = semis, 5 a 8 = cuartos con byes,
-- 9 a 16 = octavos con byes), con el mismo reparto balanceado de byes y su propio partido por el 3er y 4to puesto.
-- Todo sigue siendo sandbox: sin puntos ni logros; las vistas de puntos (0131) sólo leen group_origin
-- 'knockout_bracket' y NO se tocan.
--
-- Una copa termina cuando su final Y su 3er puesto están resueltos (su grupo pasa a 'resolved'). El evento pasa a
-- 'completed' cuando terminan las dos copas (o la única copa, si no hay 2da oportunidad). El campeón del evento es
-- el de la copa principal y se corona, como hasta ahora, al resolverse su final.
--
-- CHOQUE DEL DISEÑO CON EL CÓDIGO REAL (resuelto acá): knockout_advance, apply_knockout_walkover y el trigger
-- evaluate_tiebreak_group_after_match buscaban "el" grupo activo del evento (por evento + origen, o limit 1). Con
-- dos grupos activos eso no sirve; se reemplazan:
--   * evaluate_tiebreak_group_after_match: cuerpo de 0130 + una rama temprana SOLO para competition_format =
--     'knockout' (antes de buscar el grupo activo). Los demás formatos no entran a esa rama y siguen idénticos.
--   * knockout_advance: el grupo es el de la copa a la que pertenece el cruce (pairing del cruce pendiente); el
--     campeón del evento se corona sólo con la final de la copa principal; al final intenta sortear la 2da
--     oportunidad y completar el evento.
--   * apply_knockout_walkover: recorre los grupos activos de la Copa (principal y 2da oportunidad).
--   * ensure_revenge_pairing (0134): el cruce pendiente entre los dos se busca en las dos copas; y se cambian dos chequeos de 0134:
--     'status <> playing' pasa a admitir playing, completed y concluded (las venganzas no caducan con el evento,
--     pero no existen antes de terminar el draft) y se quita 'left_event_at is null' (quien se fue también
--     juega venganzas). Son los ÚNICOS cambios de comportamiento sobre el cuerpo 0134 además de la búsqueda en las dos copas; el md5 del encabezado es el del cuerpo 0134 original.
--
-- Alcance:
--   1. event_tiebreak_groups_group_origin_check admite 'knockout_second_chance'.
--   2. knockout_build_bracket(group_id, players uuid[]): el armado del cuadro que estaba dentro de
--      draw_knockout_bracket (seeds, slots, feeds, byes balanceados, avance de byes, materialización), para usarlo
--      en las dos copas. draw_knockout_bracket queda como validaciones + sorteo de jugadores + grupo + build.
--   3. knockout_try_draw_second_chance(group_id) y knockout_maybe_complete_event(event_id): internas.
--   4. Reemplazos (cuerpo vivo de la última migración que define cada una, con los cambios indicados):
--   knockout_advance                     5eca15daf7905fff794f7abe35bac934  (4172 caracteres)
--   apply_knockout_walkover              95f6e9bc9e130733c0f08d147a39ba32  (2171 caracteres)
--   evaluate_tiebreak_group_after_match  20210d61304d199db25aa78680d5c7c3  (22837 caracteres)
--   draw_knockout_bracket                bc964fb936bd67d93b4718c4a0b4c226  (5425 caracteres)
--   ensure_revenge_pairing               7a757c8ca8bf4dee39b076b1dd6d4d7f  (3364 caracteres)
--      (md5 del texto entre los $$ en el archivo de origen, con sus saltos de línea originales)
--
-- NO toca eventos ni pairings existentes. Las Copas ya sorteadas siguen con un único grupo 'knockout_bracket'.

-- ===========================================================================
-- 1. group_origin admite 'knockout_second_chance'
-- ===========================================================================
alter table public.event_tiebreak_groups
  drop constraint if exists event_tiebreak_groups_group_origin_check;

alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_group_origin_check
    check (group_origin in (
      'tiebreak', 'swiss_topcut', 'round_robin_topcut', 'round_robin_fourth_place',
      'round_robin_first_place', 'knockout_bracket', 'knockout_second_chance'
    ));

-- ===========================================================================
-- 2. knockout_build_bracket: armado del cuadro (extraído de draw_knockout_bracket)
-- ===========================================================================
create or replace function public.knockout_build_bracket(p_group_id uuid, p_players uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
  v_p integer;
  v_byes integer;
  v_first_slots integer;
  v_first_round text;
  v_bye_positions integer[];
  v_pos integer;
  v_i integer;
begin
  if not exists (select 1 from public.event_tiebreak_groups g where g.id = p_group_id) then
    raise exception 'knockout_build_bracket: el grupo no existe.';
  end if;

  v_n := coalesce(array_length(p_players, 1), 0);
  if v_n < 4 or v_n > 16 then
    raise exception 'Copa (sólo llaves): se necesitan entre 4 y 16 jugadores en el cuadro (hay %).', v_n
      using errcode = '23514';
  end if;

  -- Tamaño del cuadro: 4 (N = 4, arranca en semifinales), 8 (N = 5 a 8, cuartos) o 16 (N = 9 a 16, octavos).
  v_p := case when v_n <= 4 then 4 when v_n <= 8 then 8 else 16 end;
  v_byes := v_p - v_n;
  v_first_slots := v_p / 2;
  v_first_round := case v_p when 4 then 'semi' when 8 then 'quarter' else 'round_of_16' end;

  -- seed = posición en el sorteo (1..N).
  insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
  select p_group_id, ep.id, ep.user_id, t.ord::integer
  from unnest(p_players) with ordinality as t(pid, ord)
  join public.event_participants ep on ep.id = t.pid;

  insert into public.knockout_slots (group_id, round_key, "position")
  select p_group_id, r.round_key, gs
  from (values ('round_of_16', 8), ('quarter', 4), ('semi', 2), ('final', 1), ('third_place', 1)) as r(round_key, n)
  cross join lateral generate_series(1, r.n) as gs
  where (r.round_key <> 'round_of_16' or v_p = 16)  -- octavos sólo con N >= 9
    and (r.round_key <> 'quarter' or v_p >= 8);     -- cuartos sólo con N >= 5

  -- Cada slot alimenta al de la ronda siguiente: posición k -> ceil(k/2), lado 'a' si k es impar.
  update public.knockout_slots s
  set feeds_slot_id = n.id,
      feeds_as = case when s."position" % 2 = 1 then 'a' else 'b' end
  from public.knockout_slots n
  where s.group_id = p_group_id
    and n.group_id = p_group_id
    and n.round_key = case s.round_key
                        when 'round_of_16' then 'quarter'
                        when 'quarter' then 'semi'
                        when 'semi' then 'final'
                      end
    and n."position" = (s."position" + 1) / 2;

  -- Byes en cruces DISTINTOS de la primera ronda (como mucho P/2 - 1: nunca dos byes enfrentados),
  -- repartidos de forma balanceada entre las dos mitades del cuadro y entre los dos cuartos de cada
  -- mitad (ver knockout_pick_bye_positions, más arriba en esta migración).
  v_bye_positions := public.knockout_pick_bye_positions(v_first_slots, v_byes);

  v_i := 1;
  for v_pos in 1..v_first_slots loop
    if v_pos = any (v_bye_positions) then
      update public.knockout_slots s
      set participant_a_id = p_players[v_i], seed_a = v_i, is_bye = true,
          winner_participant_id = p_players[v_i]
      where s.group_id = p_group_id and s.round_key = v_first_round and s."position" = v_pos;
      v_i := v_i + 1;
    else
      update public.knockout_slots s
      set participant_a_id = p_players[v_i], seed_a = v_i,
          participant_b_id = p_players[v_i + 1], seed_b = v_i + 1
      where s.group_id = p_group_id and s.round_key = v_first_round and s."position" = v_pos;
      v_i := v_i + 2;
    end if;
  end loop;

  -- Los que pasan directo ocupan su lugar en la ronda siguiente (dos updates: un mismo slot
  -- siguiente puede recibir un bye de cada lado).
  update public.knockout_slots n
  set participant_a_id = s.winner_participant_id
  from public.knockout_slots s
  where s.group_id = p_group_id and s.is_bye and s.feeds_as = 'a' and n.id = s.feeds_slot_id;

  update public.knockout_slots n
  set participant_b_id = s.winner_participant_id
  from public.knockout_slots s
  where s.group_id = p_group_id and s.is_bye and s.feeds_as = 'b' and n.id = s.feeds_slot_id;

  perform public.knockout_materialize(p_group_id);
end;
$$;

-- ===========================================================================
-- 2b. draw_knockout_bracket: validaciones + sorteo + grupo, y delega el armado en knockout_build_bracket
-- ===========================================================================
create or replace function public.draw_knockout_bracket(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_group_id uuid;
  v_players uuid[];
  v_n integer;
begin
  select de.id, de.workspace_id, de.competition_format, de.status
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null
  for update;

  if v_event.id is null then
    raise exception 'draw_knockout_bracket: el evento no existe.';
  end if;

  if not public.can_manage_event(v_event.workspace_id, v_event.id) then
    raise exception 'draw_knockout_bracket: no tenés permisos para sortear las llaves de este evento.'
      using errcode = '42501';
  end if;

  if v_event.competition_format <> 'knockout' then
    raise exception 'draw_knockout_bracket: el evento no es una Copa (sólo llaves).';
  end if;

  -- Idempotente: si ya hay un sorteo vigente, se devuelve sin volver a sortear.
  select g.id into v_group_id
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  limit 1;
  if v_group_id is not null then
    return v_group_id;
  end if;

  if v_event.status <> 'playing' then
    raise exception 'draw_knockout_bracket: el sorteo se hace al finalizar el draft (el evento está en %).', v_event.status;
  end if;

  select array_agg(ep.id order by random()) into v_players
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player';

  v_n := coalesce(array_length(v_players, 1), 0);
  if v_n < 4 or v_n > 16 then
    raise exception 'Copa (sólo llaves): se necesitan entre 4 y 16 jugadores inscriptos (hay %).', v_n
      using errcode = '23514';
  end if;

  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
  values (p_event_id, 1, 'bracket', 'active', 'knockout_bracket')
  returning id into v_group_id;

  perform public.knockout_build_bracket(v_group_id, v_players);

  return v_group_id;
end;
$$;

-- ===========================================================================
-- 3. knockout_try_draw_second_chance: sortea la 2da oportunidad cuando corresponde
-- ===========================================================================
create or replace function public.knockout_try_draw_second_chance(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group record;
  v_status text;
  v_existing uuid;
  v_all_resolved boolean;
  v_entrants uuid[];
  v_new uuid;
begin
  select g.id, g.event_id, g.group_origin into v_group
  from public.event_tiebreak_groups g where g.id = p_group_id;

  -- Sólo se dispara desde la copa principal.
  if v_group.id is null or v_group.group_origin <> 'knockout_bracket' then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('knockout2:' || v_group.event_id::text));

  -- Idempotente: si ya hay una 2da oportunidad vigente, se devuelve sin volver a sortear.
  select g.id into v_existing
  from public.event_tiebreak_groups g
  where g.event_id = v_group.event_id and g.group_origin = 'knockout_second_chance' and g.status <> 'superseded'
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  select de.status into v_status
  from public.draft_events de where de.id = v_group.event_id and de.deleted_at is null;
  if v_status is distinct from 'playing' then
    return null;
  end if;

  -- "Primer partido real" de cada jugador: el primer slot no-bye (por ronda) en el que está. Los que entran
  -- con bye juegan su primer partido en la ronda siguiente. Entrantes: perdieron ese partido y no se fueron.
  with placed as (
    select p.pid, s."position" as pos, s.winner_participant_id as winner,
           case s.round_key when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3
                            when 'final' then 4 else 5 end as r
    from public.knockout_slots s
    cross join lateral (values (s.participant_a_id), (s.participant_b_id)) as p(pid)
    where s.group_id = p_group_id and not s.is_bye and p.pid is not null
  ), first_slot as (
    select distinct on (pid) pid, winner from placed order by pid, r, pos
  )
  select bool_and(fs.winner is not null),
         coalesce(
           array_agg(fs.pid order by random()) filter (
             where fs.winner is not null and fs.winner <> fs.pid
               and not exists (
                 select 1 from public.event_participants ep where ep.id = fs.pid and ep.left_event_at is not null
               )
           ),
           '{}'::uuid[]
         )
  into v_all_resolved, v_entrants
  from first_slot fs;

  -- Se sortea recién cuando TODOS los primeros partidos de la copa principal están resueltos, y sólo si
  -- hay 4 o más entrantes (con menos no se crea y no pasa nada).
  if v_all_resolved is not true or coalesce(array_length(v_entrants, 1), 0) < 4 then
    return null;
  end if;

  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
  values (v_group.event_id, 1, 'bracket', 'active', 'knockout_second_chance')
  returning id into v_new;

  perform public.knockout_build_bracket(v_new, v_entrants);

  return v_new;
end;
$$;

-- ===========================================================================
-- 3b. knockout_maybe_complete_event: completa el evento cuando terminan las dos copas
-- ===========================================================================
create or replace function public.knockout_maybe_complete_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_main record;
  v_second record;
begin
  select de.status into v_status
  from public.draft_events de where de.id = p_event_id and de.deleted_at is null;
  if v_status is distinct from 'playing' then
    return;
  end if;

  -- Una copa termina cuando su final Y su 3er puesto están resueltos: el grupo pasa a 'resolved'.
  select g.id, g.status, g.champion_user_id into v_main
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  limit 1;
  if v_main.id is null or v_main.status <> 'resolved' then
    return;
  end if;

  select g.id, g.status into v_second
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_second_chance' and g.status <> 'superseded'
  limit 1;
  if v_second.id is not null and v_second.status <> 'resolved' then
    return;
  end if;

  update public.draft_events
  set status = 'completed',
      event_ended_at = now(),
      final_pending = false,
      champion_user_id = coalesce(champion_user_id, v_main.champion_user_id),
      champion_decided_by = coalesce(champion_decided_by, 'tiebreak')
  where id = p_event_id and status = 'playing';
end;
$$;

-- ===========================================================================
-- 4. knockout_advance: group-aware, corona a la principal, sortea la 2da oportunidad y completa el evento
-- ===========================================================================
create or replace function public.knockout_advance(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_pairing record;
  v_group record;
  v_bm record;
  v_slot record;
  v_wins_a integer;
  v_wins_b integer;
  v_needed integer;
  v_winner uuid;
  v_loser uuid;
  v_champion_user uuid;
begin
  select m.id, m.pairing_id, m.match_type, m.status into v_match
  from public.matches m where m.id = p_match_id;

  if v_match.id is null or v_match.match_type <> 'tiebreak' or v_match.status <> 'completed' then
    return;
  end if;

  select p.id, p.event_id into v_pairing from public.pairings p where p.id = v_match.pairing_id;
  if v_pairing.id is null then
    return;
  end if;

  -- Evento dado por concluido (concludeEvent): los cruces sin resolver quedan suspendidos tal cual; una partida
  -- que termine después no hace avanzar el cuadro ni inventa ganadores.
  if exists (select 1 from public.draft_events de where de.id = v_pairing.event_id and de.status = 'concluded') then
    return;
  end if;

  -- 0135: el grupo es el de la copa a la que pertenece ESTE cruce (principal o 2da oportunidad); ya no se
  -- supone un único grupo activo por evento. Un par de jugadores está como mucho en un cruce pendiente.
  select g.id, g.event_id, g.group_origin into v_group
  from public.event_tiebreak_groups g
  join public.event_tiebreak_bracket_matches bm0 on bm0.group_id = g.id
  where g.event_id = v_pairing.event_id
    and g.group_origin in ('knockout_bracket', 'knockout_second_chance')
    and g.status = 'active'
    and bm0.pairing_id = v_pairing.id
    and bm0.winner_participant_id is null
  limit 1;

  if v_group.id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('knockout:' || v_group.id::text));

  select bm.id, bm.bracket_phase, bm.participant_a_id, bm.participant_b_id into v_bm
  from public.event_tiebreak_bracket_matches bm
  where bm.group_id = v_group.id
    and bm.pairing_id = v_pairing.id
    and bm.winner_participant_id is null
  limit 1;

  if v_bm.id is null then
    return;
  end if;

  select count(*) filter (where m.winner_participant_id = v_bm.participant_a_id),
         count(*) filter (where m.winner_participant_id = v_bm.participant_b_id)
  into v_wins_a, v_wins_b
  from public.matches m
  where m.pairing_id = v_pairing.id
    and m.match_type = 'tiebreak'
    and m.status = 'completed';

  v_needed := public.topcut_wins_needed(v_group.event_id, v_bm.bracket_phase);

  if v_wins_a < v_needed and v_wins_b < v_needed then
    return;
  end if;

  if v_wins_a >= v_needed then
    v_winner := v_bm.participant_a_id;
    v_loser := v_bm.participant_b_id;
  else
    v_winner := v_bm.participant_b_id;
    v_loser := v_bm.participant_a_id;
  end if;

  update public.event_tiebreak_bracket_matches
  set winner_participant_id = v_winner, resolved_at = now()
  where id = v_bm.id;

  select s.id, s.round_key, s.feeds_slot_id, s.feeds_as into v_slot
  from public.knockout_slots s where s.bracket_match_id = v_bm.id;

  if v_slot.id is not null then
    update public.knockout_slots set winner_participant_id = v_winner where id = v_slot.id;

    if v_slot.feeds_slot_id is not null then
      update public.knockout_slots
      set participant_a_id = case when v_slot.feeds_as = 'a' then v_winner else participant_a_id end,
          participant_b_id = case when v_slot.feeds_as = 'b' then v_winner else participant_b_id end
      where id = v_slot.feeds_slot_id;
    end if;

    -- Los perdedores de las semis juegan el 3er puesto (misma posición que la semi: a / b).
    if v_slot.round_key = 'semi' then
      update public.knockout_slots
      set participant_a_id = case when v_slot.feeds_as = 'a' then v_loser else participant_a_id end,
          participant_b_id = case when v_slot.feeds_as = 'b' then v_loser else participant_b_id end
      where group_id = v_group.id and round_key = 'third_place';
    end if;

    if v_slot.round_key = 'final' then
      select ep.user_id into v_champion_user from public.event_participants ep where ep.id = v_winner;

      -- Campeón del evento = el de la copa principal, coronado al resolverse su final. El evento pasa a
      -- 'completed' recién cuando terminan las dos copas (knockout_maybe_complete_event, más abajo).
      if v_group.group_origin = 'knockout_bracket' then
        update public.draft_events
        set champion_user_id = v_champion_user,
            champion_decided_by = 'tiebreak',
            final_pending = false
        where id = v_group.event_id and champion_user_id is null;
      end if;

      update public.event_tiebreak_groups
      set champion_user_id = v_champion_user
      where id = v_group.id and champion_user_id is null;
    end if;
  end if;

  perform public.knockout_materialize(v_group.id);

  if not exists (
    select 1 from public.knockout_slots s
    where s.group_id = v_group.id and not s.is_bye and s.winner_participant_id is null
  ) then
    update public.event_tiebreak_groups
    set status = 'resolved', resolved_at = now()
    where id = v_group.id and status = 'active';
  end if;

  -- 2da oportunidad: cada vez que se resuelve algo de la copa principal se revisa si ya se pueden sortear
  -- (idempotente), y después si terminaron las dos copas.
  if v_group.group_origin = 'knockout_bracket' then
    perform public.knockout_try_draw_second_chance(v_group.id);
  end if;
  perform public.knockout_maybe_complete_event(v_group.event_id);
end;
$$;

-- ===========================================================================
-- 5. apply_knockout_walkover ("Me voy"): recorre la copa principal y la 2da oportunidad
-- ===========================================================================
create or replace function public.apply_knockout_walkover(p_participant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  if v_format is distinct from 'knockout' then
    raise exception 'apply_knockout_walkover: el evento no es una Copa (sólo llaves).';
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
    perform pg_advisory_xact_lock(hashtext('knockout:' || v_group_id::text));

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
$$;

-- ===========================================================================
-- 6. evaluate_tiebreak_group_after_match: rama temprana por competition_format = knockout
-- ===========================================================================
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

  -- Copa (competition_format = 'knockout', 0135): puede haber dos grupos activos (la copa principal y la
  -- 2da oportunidad), así que el avance NO depende de "el" grupo activo del evento: knockout_advance
  -- busca la copa a la que pertenece el cruce. Los demás formatos siguen por las ramas de abajo, idénticas.
  if exists (
    select 1 from public.draft_events de where de.id = v_event_id and de.competition_format = 'knockout'
  ) then
    perform public.knockout_advance(new.id);
    return new;
  end if;

  select id, group_type, round_number, group_origin into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  -- Copa (sólo llaves, group_origin='knockout_bracket', 0130): el avance lo resuelve
  -- knockout_advance (16avos a final + 3er puesto, byes, cierre del grupo). Los demás orígenes
  -- siguen exactamente por las ramas de abajo.
  if v_active_group.group_origin = 'knockout_bracket' then
    perform public.knockout_advance(new.id);
    return new;
  end if;

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  -- ROUND ROBIN: sin cambios respecto a 0091.
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

  -- BRACKET (semis+final+3°/4° del top4 real de round_robin O de Suizo, o de la Copa Polémica).
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
      v_w1_left boolean;
      v_w2_left boolean;
      v_l1_left boolean;
      v_l2_left boolean;
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

            -- Gap análogo al del bye (0087/0089): alguno de los 4 puede haberse ido entre que
            -- ganó/perdió su semi y este instante (la otra semi tardó más en resolverse).
            -- Fase 6.8: extendido a swiss_topcut, mismo mecanismo genérico de bracket.
            if v_active_group.group_origin in ('round_robin_topcut', 'swiss_topcut') then
              select exists(select 1 from public.event_participants where id = v_semi_winners[1] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_winners[2] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_losers[1] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_losers[2] and left_event_at is not null)
              into v_w1_left, v_w2_left, v_l1_left, v_l2_left;

              -- Exactamente uno se fue de cada lado: walkover directo a favor del que se queda,
              -- reusando apply_walkover_for_topcut_bracket_leg (dispara este mismo trigger de
              -- nuevo sobre la fila recién creada). Si se fueron los dos de un mismo lado, esa
              -- fila queda pendiente para siempre — mismo criterio que "ambos se fueron".
              if v_w1_left and not v_w2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[1], v_active_group.group_origin);
              elsif v_w2_left and not v_w1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[2], v_active_group.group_origin);
              end if;

              if v_l1_left and not v_l2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[1], v_active_group.group_origin);
              elsif v_l2_left and not v_l1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[2], v_active_group.group_origin);
              end if;
            end if;
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

  -- FOURTH_PLACE: desempate por el 4to puesto de round_robin_bo1_top4 (0071/0072/0091) O
  -- desempate de 1er puesto de round_robin BO3 clásico (0075/0087/0090,
  -- group_origin='round_robin_first_place'). Sin cambios — Suizo no tiene equivalente (el corte
  -- se resuelve matemáticamente, sin disputa en vivo, decisión ya confirmada).
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
      v_bye_left_a boolean;
      v_bye_left_b boolean;
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
        v_wins_needed := case when v_bm_phase = 'final' then 2 else 1 end;

        select count(*) filter (where m.winner_participant_id = v_bm_a),
               count(*) filter (where m.winner_participant_id = v_bm_b)
        into v_wins_a, v_wins_b
        from public.matches m
        where m.pairing_id = new.pairing_id
          and m.match_type = 'tiebreak'
          and m.status = 'completed';

        if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
          return new;
        end if;

        v_winner_participant_id := case when v_wins_a >= v_wins_needed then v_bm_a else v_bm_b end;
      else
        v_winner_participant_id := new.winner_participant_id;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

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
          select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;
          return new;
        end if;

        select array_agg(participant_id order by seed) into v_top3
        from public.event_tiebreak_group_participants
        where group_id = v_active_group.id;

        if v_top3 is not null and array_length(v_top3, 1) = 3 then
          v_top4 := v_top3 || v_winner_participant_id;
          perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
        end if;

        return new;
      end if;

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

      if v_active_group.group_origin = 'round_robin_first_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
          insert into public.event_tiebreak_bracket_matches
            (group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id, resolved_at)
          values (v_active_group.id, 'final', v_next_a_id, v_next_b_id, v_winner_participant_id, now());

          perform public.link_bracket_matches_to_pairings(v_active_group.id);

          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select user_id into v_leader_user_id from public.event_participants
          where id = v_winner_participant_id;

          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;

          return new;
        end if;
      elsif v_active_group.group_origin = 'round_robin_fourth_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
          insert into public.event_tiebreak_bracket_matches
            (group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id, resolved_at)
          values (v_active_group.id, 'final', v_next_a_id, v_next_b_id, v_winner_participant_id, now());

          perform public.link_bracket_matches_to_pairings(v_active_group.id);

          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select array_agg(participant_id order by seed) into v_top3
          from public.event_tiebreak_group_participants
          where group_id = v_active_group.id;

          if v_top3 is not null and array_length(v_top3, 1) = 3 then
            v_top4 := v_top3 || v_winner_participant_id;
            perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
          end if;

          return new;
        end if;
      end if;

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

-- ===========================================================================
-- 7. ensure_revenge_pairing: cruce pendiente en cualquiera de las dos copas
-- ===========================================================================
create or replace function public.ensure_revenge_pairing(
  p_event_id uuid,
  p_participant_a uuid,
  p_participant_b uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_a uuid;
  v_b uuid;
  v_pairing_id uuid;
begin
  if p_participant_a is null or p_participant_b is null or p_participant_a = p_participant_b then
    raise exception 'ensure_revenge_pairing: hay que elegir dos jugadores distintos.'
      using errcode = '22023';
  end if;

  -- pairings_participants_ordered exige participant_a_id < participant_b_id.
  v_a := least(p_participant_a, p_participant_b);
  v_b := greatest(p_participant_a, p_participant_b);

  select de.id, de.workspace_id, de.competition_format, de.status
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null then
    raise exception 'ensure_revenge_pairing: el evento no existe.';
  end if;

  if v_event.competition_format <> 'knockout' then
    raise exception 'ensure_revenge_pairing: el evento no es una Copa (sólo llaves).';
  end if;

  -- 0135: el chequeo de 0134 (status <> 'playing') pasa a admitir también 'completed' y 'concluded': las
  -- venganzas no caducan con el evento, pero sólo existen una vez terminado el draft (se rechazan 'scheduled',
  -- 'drafting' y 'cancelled').
  if v_event.status not in ('playing', 'completed', 'concluded') then
    raise exception 'ensure_revenge_pairing: las venganzas se juegan una vez terminado el draft (el evento está en %).', v_event.status
      using errcode = '23514';
  end if;

  -- Los dos tienen que ser jugadores de este evento. 0135: quien se fue (left_event_at) también puede jugar
  -- venganzas; sólo pierde sus oficiales pendientes.
  if (
    select count(*)
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.id in (v_a, v_b)
      and ep.role = 'player'
  ) <> 2 then
    raise exception 'ensure_revenge_pairing: los dos tienen que ser jugadores del evento.'
      using errcode = '22023';
  end if;

  -- Quien llama: uno de los dos jugadores, o quien administra el evento.
  if not (
    public.can_manage_event(v_event.workspace_id, v_event.id)
    or exists (
      select 1
      from public.event_participants ep
      where ep.id in (v_a, v_b) and ep.user_id = auth.uid()
    )
  ) then
    raise exception 'ensure_revenge_pairing: no tenés permisos para armar esta venganza.'
      using errcode = '42501';
  end if;

  -- Cruce de llaves pendiente entre los dos (en la copa principal o en la 2da oportunidad): ahí corre la
  -- serie de llaves, no una venganza.
  if exists (
    select 1
    from public.event_tiebreak_bracket_matches bm
    join public.event_tiebreak_groups g on g.id = bm.group_id
    where g.event_id = p_event_id
      and g.group_origin in ('knockout_bracket', 'knockout_second_chance')
      and g.status <> 'superseded'
      and bm.winner_participant_id is null
      and least(bm.participant_a_id, bm.participant_b_id) = v_a
      and greatest(bm.participant_a_id, bm.participant_b_id) = v_b
  ) then
    raise exception 'ensure_revenge_pairing: tienen un cruce de llaves pendiente entre ellos.'
      using errcode = '23514';
  end if;

  insert into public.pairings (event_id, participant_a_id, participant_b_id, stage)
  values (p_event_id, v_a, v_b, 'revenge')
  on conflict (event_id, participant_a_id, participant_b_id) do nothing
  returning id into v_pairing_id;

  if v_pairing_id is null then
    -- Ya existía (un cruce de llaves resuelto o una venganza anterior): se reutiliza, sin tocar su stage.
    select p.id into v_pairing_id
    from public.pairings p
    where p.event_id = p_event_id and p.participant_a_id = v_a and p.participant_b_id = v_b;
  end if;

  return v_pairing_id;
end;
$$;

-- Permisos: las internas no se exponen; draw_knockout_bracket, apply_knockout_walkover y ensure_revenge_pairing
-- conservan los suyos (CREATE OR REPLACE los mantiene).
revoke execute on function public.knockout_build_bracket(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.knockout_try_draw_second_chance(uuid) from public, anon, authenticated;
revoke execute on function public.knockout_maybe_complete_event(uuid) from public, anon, authenticated;
