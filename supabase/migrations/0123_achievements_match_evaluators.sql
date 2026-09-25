-- 0123_achievements_match_evaluators.sql
-- Sistema de logros de temporada, parte 3/4: evaluadores de logros de partidas/series, de
-- bracket y de acumulados, más el evaluador único por evento y la red de seguridad.
--   dalo_vuelta, remontada_providencial, por_la_ventana, ventana_puerta_grande, merecido,
--   largar_el_blanco, bancame_un_toque, sospechoso, fanatico_del_registro.
--
-- Fuera de alcance por estructura (no hay nada que excluir explícitamente, pero se confirma): las
-- partidas sueltas del Playground (context_free_*) y el life tracker sin evento viven en tablas
-- distintas a matches/pairings/draft_events, que son las únicas que leen estos evaluadores. Las
-- partidas de venganza (matches.match_type = 'revenge') se excluyen explícitamente donde
-- corresponde (todas las consultas filtran match_type in ('draft','final','tiebreak')).

-- ===========================================================================
-- 1. Series BO3: remontadas
-- ===========================================================================
-- ¿La serie (ganadores de las partidas completadas, en orden) fue una remontada 0-1? Exactamente
-- 3 partidas: perdió la primera el ganador de la serie y ganó las dos siguientes.
create or replace function public.achv_is_bo3_comeback(p_winners uuid[], p_series_winner uuid)
returns boolean
language sql
immutable
as $$
  select p_series_winner is not null
     and coalesce(array_length(p_winners, 1), 0) = 3
     and p_winners[1] is distinct from p_series_winner
     and p_winners[2] = p_series_winner
     and p_winners[3] = p_series_winner;
$$;

-- Remontadas de un evento. Identificación de la serie (no alcanza con pairing_id: en Suizo un
-- pairing puede compartir fila entre la ronda suiza y el cruce del bracket):
--   * regular: pairing + match_type='draft' (BO3 de fase regular);
--   * bracket/desempate: bracket_match.pairing_id + match_type='tiebreak' + tiebreak_round =
--     round_number del grupo (misma convención que podium.ts).
-- Se EXCLUYE toda serie que tenga alguna partida is_walkover.
-- p_only_first_place: solo bracket_phase='final' de grupos que deciden el 1er puesto
-- (round_robin_topcut, swiss_topcut, round_robin_first_place).
create or replace function public.achv_comeback_rows(p_event_id uuid, p_only_first_place boolean)
returns table (winner_user_id uuid, source_kind text, ref jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  v_winners uuid[];
  v_has_walkover boolean;
  v_user uuid;
begin
  -- Serie regular BO3
  if not p_only_first_place then
    for r in
      select p.id as pairing_id, p.official_winner_participant_id as series_winner
      from public.pairings p
      join public.draft_events de on de.id = p.event_id
      where p.event_id = p_event_id
        and de.match_format = 'bo3'
        and p.official_winner_participant_id is not null
        and (de.competition_format <> 'swiss' or p.swiss_round is not null)
    loop
      select bool_or(m.is_walkover)
      into v_has_walkover
      from public.matches m
      where m.pairing_id = r.pairing_id and m.match_type = 'draft';

      select array_agg(m.winner_participant_id order by m.match_number)
      into v_winners
      from public.matches m
      where m.pairing_id = r.pairing_id and m.match_type = 'draft' and m.status = 'completed';

      if not coalesce(v_has_walkover, false) and public.achv_is_bo3_comeback(v_winners, r.series_winner) then
        select ep.user_id into v_user
        from public.event_participants ep
        where ep.id = r.series_winner and ep.role = 'player';
        if v_user is not null then
          winner_user_id := v_user;
          source_kind := 'regular';
          ref := jsonb_build_object('pairing_id', r.pairing_id);
          return next;
        end if;
      end if;
    end loop;
  end if;

  -- Serie de bracket / desempate BO3
  for r in
    select bm.id as bm_id, bm.pairing_id, bm.winner_participant_id as series_winner,
           bm.bracket_phase, g.round_number, g.group_origin
    from public.event_tiebreak_bracket_matches bm
    join public.event_tiebreak_groups g on g.id = bm.group_id
    where g.event_id = p_event_id
      and g.status not in ('superseded', 'failed')
      and bm.winner_participant_id is not null
      and bm.pairing_id is not null
      and (
        not p_only_first_place
        or (bm.bracket_phase = 'final'
            and g.group_origin in ('round_robin_topcut', 'swiss_topcut', 'round_robin_first_place'))
      )
  loop
    select bool_or(m.is_walkover)
    into v_has_walkover
    from public.matches m
    where m.pairing_id = r.pairing_id and m.match_type = 'tiebreak'
      and coalesce(m.tiebreak_round, 1) = r.round_number;

    select array_agg(m.winner_participant_id order by m.match_number)
    into v_winners
    from public.matches m
    where m.pairing_id = r.pairing_id and m.match_type = 'tiebreak'
      and coalesce(m.tiebreak_round, 1) = r.round_number and m.status = 'completed';

    if not coalesce(v_has_walkover, false) and public.achv_is_bo3_comeback(v_winners, r.series_winner) then
      select ep.user_id into v_user
      from public.event_participants ep
      where ep.id = r.series_winner and ep.role = 'player';
      if v_user is not null then
        winner_user_id := v_user;
        source_kind := 'bracket';
        ref := jsonb_build_object('bracket_match_id', r.bm_id, 'bracket_phase', r.bracket_phase);
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$$;

create or replace function public.achv_eval_dalo_vuelta(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;
  for r in select * from public.achv_comeback_rows(p_event_id, false) loop
    if public.grant_achievement('dalo_vuelta', r.winner_user_id, p_event_id, r.ref) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

create or replace function public.achv_eval_remontada_providencial(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;
  for r in select * from public.achv_comeback_rows(p_event_id, true) loop
    if public.grant_achievement('remontada_providencial', r.winner_user_id, p_event_id, r.ref) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 2. Desempate por el 4to puesto
-- ===========================================================================
-- Ganador del desempate por el 4to puesto: el ganador del partido 'final' del grupo
-- group_origin='round_robin_fourth_place' (0071/0091). Ganar por walkover SÍ cuenta.
create or replace function public.achv_fourth_place_winners(p_event_id uuid)
returns table (participant_id uuid, user_id uuid, bracket_match_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select bm.winner_participant_id, ep.user_id, bm.id
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g on g.id = bm.group_id
  join public.event_participants ep on ep.id = bm.winner_participant_id and ep.role = 'player'
  where g.event_id = p_event_id
    and g.group_origin = 'round_robin_fourth_place'
    and g.status not in ('superseded', 'failed')
    and bm.bracket_phase = 'final'
    and bm.winner_participant_id is not null;
$$;

create or replace function public.achv_eval_por_la_ventana(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;
  for r in select * from public.achv_fourth_place_winners(p_event_id) loop
    if public.grant_achievement('por_la_ventana', r.user_id, p_event_id,
         jsonb_build_object('bracket_match_id', r.bracket_match_id)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- Cuando el evento está completed con campeón, si ese campeón ganó el desempate por el 4to
-- puesto de ESE mismo evento.
create or replace function public.achv_eval_ventana_puerta_grande(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_champion uuid;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select status, champion_user_id into v_status, v_champion
  from public.draft_events where id = p_event_id;
  if v_status <> 'completed' or v_champion is null then return 0; end if;

  for r in
    select * from public.achv_fourth_place_winners(p_event_id) w where w.user_id = v_champion
  loop
    if public.grant_achievement('ventana_puerta_grande', r.user_id, p_event_id,
         jsonb_build_object('bracket_match_id', r.bracket_match_id)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 3. Merecido?
-- ===========================================================================
-- Ganar por walkover un enfrentamiento que ya estaba EN CURSO: la serie (mismo pairing y
-- match_type; en bracket/desempate, además tiebreak_round) tiene al menos una partida real
-- (is_walkover=false, completed o in_progress) anterior al walkover. Un corrimiento sin partido
-- jugado no cuenta. Aplica a fase regular y a desempate/bracket. El ganador es quien se queda.
create or replace function public.achv_eval_merecido(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
  v_series_won boolean;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  for r in
    select distinct
      m.pairing_id, m.match_type, coalesce(m.tiebreak_round, 1) as tb_round,
      m.winner_participant_id as stayer_id, ep.user_id,
      min(m.match_number) over (partition by m.pairing_id, m.match_type, coalesce(m.tiebreak_round, 1)) as first_wo_number
    from public.matches m
    join public.pairings pr on pr.id = m.pairing_id
    join public.event_participants ep on ep.id = m.winner_participant_id and ep.role = 'player'
    where pr.event_id = p_event_id
      and m.is_walkover
      and m.status = 'completed'
      and m.match_type in ('draft', 'tiebreak')
      and m.winner_participant_id is not null
  loop
    -- ¿el enfrentamiento ya estaba en curso? (partida real anterior al walkover)
    if not exists (
      select 1 from public.matches m2
      where m2.pairing_id = r.pairing_id
        and m2.match_type = r.match_type
        and (r.match_type <> 'tiebreak' or coalesce(m2.tiebreak_round, 1) = r.tb_round)
        and not m2.is_walkover
        and m2.status in ('completed', 'in_progress')
        and m2.match_number < r.first_wo_number
    ) then
      continue;
    end if;

    -- ¿el pairing / la serie quedó a favor de quien se quedó?
    if r.match_type = 'draft' then
      select exists (
        select 1 from public.pairings p
        where p.id = r.pairing_id and p.official_winner_participant_id = r.stayer_id
      ) into v_series_won;
    else
      select exists (
        select 1
        from public.event_tiebreak_bracket_matches bm
        join public.event_tiebreak_groups g on g.id = bm.group_id
        where bm.pairing_id = r.pairing_id
          and g.event_id = p_event_id
          and g.round_number = r.tb_round
          and g.status not in ('superseded', 'failed')
          and bm.winner_participant_id = r.stayer_id
      ) into v_series_won;
    end if;

    if v_series_won
       and public.grant_achievement('merecido', r.user_id, p_event_id,
             jsonb_build_object('pairing_id', r.pairing_id, 'match_type', r.match_type)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 4. Largá el blanco / Bancame un toque?
-- ===========================================================================
-- Partidas individuales oficiales completadas (match_type draft/final/tiebreak; NUNCA revenge;
-- sin walkovers). Vida final de cada lado = resulting_life del último life_events de esa
-- partida (los undo son filas propias con resulting_life ya corregido), o el starting_life de la
-- propia partida (starting_life_a/b) si ese lado nunca tuvo un cambio de vida.

-- Largá el blanco: el GANADOR se lleva el logro si su vida final le saca 50 o más al perdedor.
create or replace function public.achv_eval_largar_el_blanco(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  for r in
    select m.id as match_id, ep.user_id,
           coalesce(wl.resulting_life,
                    case when m.winner_participant_id = pr.participant_a_id then m.starting_life_a else m.starting_life_b end) as winner_life,
           coalesce(ll.resulting_life,
                    case when lp.loser_id = pr.participant_a_id then m.starting_life_a else m.starting_life_b end) as loser_life
    from public.matches m
    join public.pairings pr on pr.id = m.pairing_id
    join public.event_participants ep on ep.id = m.winner_participant_id and ep.role = 'player'
    cross join lateral (
      select case when m.winner_participant_id = pr.participant_a_id then pr.participant_b_id else pr.participant_a_id end as loser_id
    ) lp
    left join lateral (
      select le.resulting_life from public.life_events le
      where le.match_id = m.id and le.participant_id = m.winner_participant_id
      order by le.occurred_at desc, le.id desc limit 1
    ) wl on true
    left join lateral (
      select le.resulting_life from public.life_events le
      where le.match_id = m.id and le.participant_id = lp.loser_id
      order by le.occurred_at desc, le.id desc limit 1
    ) ll on true
    where pr.event_id = p_event_id
      and m.status = 'completed'
      and m.match_type in ('draft', 'final', 'tiebreak')
      and not m.is_walkover
      and m.winner_participant_id is not null
  loop
    if r.winner_life - r.loser_life >= 50
       and public.grant_achievement('largar_el_blanco', r.user_id, p_event_id,
             jsonb_build_object('match_id', r.match_id, 'winner_life', r.winner_life, 'loser_life', r.loser_life)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- Bancame un toque?: partida de más de 60 minutos medida entre el primer y el último
-- life_events.occurred_at de la partida (started_at/ended_at crudos pueden quedar abiertos por
-- error). Lo reciben LOS DOS jugadores de esa partida.
create or replace function public.achv_eval_bancame_un_toque(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  for r in
    select m.id as match_id, side.user_id,
           extract(epoch from (d.last_at - d.first_at)) / 60.0 as minutes
    from public.matches m
    join public.pairings pr on pr.id = m.pairing_id
    cross join lateral (
      select min(le.occurred_at) as first_at, max(le.occurred_at) as last_at, count(*) as n
      from public.life_events le where le.match_id = m.id
    ) d
    cross join lateral (
      select ep.user_id
      from public.event_participants ep
      where ep.id in (pr.participant_a_id, pr.participant_b_id) and ep.role = 'player'
    ) side
    where pr.event_id = p_event_id
      and m.status = 'completed'
      and m.match_type in ('draft', 'final', 'tiebreak')
      and not m.is_walkover
      and d.n >= 2
      and d.last_at - d.first_at > interval '60 minutes'
  loop
    if public.grant_achievement('bancame_un_toque', r.user_id, p_event_id,
         jsonb_build_object('match_id', r.match_id, 'minutes', round(r.minutes::numeric, 1))) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 5. Acumulados de temporada: Sospechoso / Fanático del registro
-- ===========================================================================
-- Sospechoso: 5 asignaciones del MISMO default_avatars.pokemon_type (tipo principal, 0059)
-- como rotated_avatar_id, contando EVENTOS distintos (count distinct event_id, así una
-- reinscripción con el mismo Pokémon, 0017, no cuenta doble) dentro de la temporada del evento.
-- Solo cuentan eventos elegibles que ya llegaron a playing o más avanzado (no cancelados, no
-- la asignación BEFORE INSERT cruda). Se evalúa para los participantes del evento evaluado, y
-- solo si ese evento ya está en playing o más avanzado.
create or replace function public.achv_eval_sospechoso(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_ws uuid;
  v_season uuid;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select status, workspace_id into v_status, v_ws from public.draft_events where id = p_event_id;
  if v_status not in ('playing', 'completed', 'concluded') then return 0; end if;

  select season_id into v_season from public.v_event_season where event_id = p_event_id;
  if v_season is null then return 0; end if;

  for r in
    select mine.user_id, da.pokemon_type, cnt.n
    from public.event_participants mine
    join public.default_avatars da on da.id = mine.rotated_avatar_id and da.pokemon_type is not null
    cross join lateral (
      select count(distinct ep2.event_id) as n
      from public.event_participants ep2
      join public.default_avatars da2 on da2.id = ep2.rotated_avatar_id
      join public.v_event_season es on es.event_id = ep2.event_id
      join public.draft_events de2 on de2.id = ep2.event_id
      where ep2.user_id = mine.user_id
        and ep2.role = 'player'
        and da2.pokemon_type = da.pokemon_type
        and es.workspace_id = v_ws
        and es.season_id = v_season
        and de2.status in ('playing', 'completed', 'concluded')
        and public.achievement_event_eligible(ep2.event_id)
    ) cnt
    where mine.event_id = p_event_id and mine.role = 'player'
  loop
    if r.n >= 5
       and public.grant_achievement('sospechoso', r.user_id, p_event_id,
             jsonb_build_object('pokemon_type', r.pokemon_type, 'events', r.n)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- Fanático del registro: 10 o más event_diary_entries (curiosity/bug/suggestion, no borradas)
-- acumuladas en todos los eventos elegibles de la temporada del evento, por autor. Los mensajes
-- de logros de la UI no son filas de esta tabla (se sintetizan desde achievement_unlocks), así
-- que no hace falta excluirlos acá. Se evalúa para los autores de entradas del evento evaluado.
create or replace function public.achv_eval_fanatico_del_registro(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_season uuid;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select workspace_id into v_ws from public.draft_events where id = p_event_id;
  select season_id into v_season from public.v_event_season where event_id = p_event_id;
  if v_season is null then return 0; end if;

  for r in
    select a.user_id, cnt.n
    from (
      select distinct dd.user_id
      from public.event_diary_entries dd
      where dd.event_id = p_event_id
        and dd.entry_type in ('curiosity', 'bug', 'suggestion')
        and dd.deleted_at is null
    ) a
    cross join lateral (
      select count(*) as n
      from public.event_diary_entries d2
      join public.v_event_season es on es.event_id = d2.event_id
      where d2.user_id = a.user_id
        and d2.entry_type in ('curiosity', 'bug', 'suggestion')
        and d2.deleted_at is null
        and es.workspace_id = v_ws
        and es.season_id = v_season
        and public.achievement_event_eligible(d2.event_id)
    ) cnt
  loop
    if r.n >= 10
       and public.grant_achievement('fanatico_del_registro', r.user_id, p_event_id,
             jsonb_build_object('entries', r.n)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 6. Evaluador único por evento + red de seguridad
-- ===========================================================================
-- Registra un fallo de evaluación sin propagarlo.
create or replace function public.achievement_log_error(p_event_id uuid, p_code text, p_sqlstate text, p_message text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.achievement_eval_errors (event_id, code, sqlstate, message)
  values (p_event_id, p_code, p_sqlstate, left(p_message, 2000));
exception when others then
  null; -- el log nunca debe romper nada
end;
$$;

-- Evalúa TODOS los logros activos para un evento, mirando su estado actual (idempotente: unique +
-- ON CONFLICT DO NOTHING en achievement_unlocks). Cada logro corre en su propio bloque
-- BEGIN/EXCEPTION: si uno falla se registra en achievement_eval_errors y sigue con el resto sin
-- abortar la transacción que lo disparó. Devuelve la cantidad de desbloqueos nuevos.
create or replace function public.evaluate_achievements(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_def record;
  v_total integer := 0;
  v_n integer;
  v_state text;
  v_msg text;
begin
  if p_event_id is null or not public.achievement_event_eligible(p_event_id) then
    return 0;
  end if;

  for v_def in
    select code from public.achievement_definitions where is_active order by sort_order
  loop
    begin
      execute format('select public.%I($1)', 'achv_eval_' || v_def.code) into v_n using p_event_id;
      v_total := v_total + coalesce(v_n, 0);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      perform public.achievement_log_error(p_event_id, v_def.code, v_state, v_msg);
    end;
  end loop;

  return v_total;
end;
$$;

-- Red de seguridad (para llamar al abrir WorkspaceDetailScreen; ese enganche del cliente NO se
-- implementa en esta fase): reevalúa todos los eventos elegibles del workspace. Cualquier
-- miembro del workspace puede llamarla. Devuelve la cantidad de desbloqueos nuevos.
create or replace function public.sync_workspace_achievements(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_total integer := 0;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Sin permiso';
  end if;

  for v_event in
    select de.id
    from public.draft_events de
    where de.workspace_id = p_workspace_id
      and public.achievement_event_eligible(de.id)
    order by de.draft_started_at
  loop
    v_total := v_total + public.evaluate_achievements(v_event.id);
  end loop;

  return v_total;
end;
$$;

-- ===========================================================================
-- 7. Permisos
-- ===========================================================================
revoke execute on function public.achv_is_bo3_comeback(uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.achv_comeback_rows(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.achv_eval_dalo_vuelta(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_remontada_providencial(uuid) from public, anon, authenticated;
revoke execute on function public.achv_fourth_place_winners(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_por_la_ventana(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_ventana_puerta_grande(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_merecido(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_largar_el_blanco(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_bancame_un_toque(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_sospechoso(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_fanatico_del_registro(uuid) from public, anon, authenticated;
revoke execute on function public.achievement_log_error(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.evaluate_achievements(uuid) from public, anon, authenticated;

-- Pública (cliente): valida is_workspace_member internamente.
revoke execute on function public.sync_workspace_achievements(uuid) from public, anon;
grant execute on function public.sync_workspace_achievements(uuid) to authenticated;
