-- ============================================================================================
-- CASO C — 12 jugadores, BO1, con tres "Me voy" (antes, en medio y ya ganó), hasta el campeón
-- Prueba del motor de Copa (sólo llaves) contra la base REAL, sin pantallas.
-- TODO corre dentro de UN solo bloque DO (atómico) que termina SIEMPRE con raise exception: el
-- reporte viaja en el mensaje de error y Postgres revierte todo lo que el bloque hizo. Si algo
-- falla a mitad, el handler lo anota en el reporte y el bloque termina igual con el raise final.
-- No hace COMMIT, no crea funciones ni objetos, no deja ningún dato. Eventos de prueba: ZZ_TEST_COPA_*
-- ============================================================================================
do $knockout_test$
declare
  v_ws constant uuid := '804dbb96-c97d-4be5-a017-691657d5ece0';
  v_tomas constant uuid := '24b8c74b-dfeb-4446-a98f-1b1e4c672dfc';
  v_report text := '';
  v_fail integer := 0;
  v_ctx text;
  v_ok boolean;
  v_txt text;
  v_users uuid[]; v_members integer; v_n integer; v_life integer;
  v_e uuid; v_g uuid; v_first_round text; v_byes integer; v_r1 integer;
  v_bm record; v_m uuid; v_num integer; v_k integer; v_guard integer; v_series integer := 0; v_games integer;
  v_p uuid; v_c integer; v_kind text; v_res text; v_sqlstate text; v_try integer;
  v_status text; v_champ uuid; v_decided text; v_gstatus text; v_gchamp uuid; v_x uuid;
  v_rows integer; v_done integer; v_drafts integer; v_wo integer;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_p4 uuid; v_u1 uuid; v_u2 uuid; v_u3 uuid; v_u4 uuid;
  v_before jsonb; v_after jsonb; v_pos integer; v_pts integer; v_exp integer; v_cnt integer;
begin
  -- Sesión sin usuario autenticado en el SQL Editor: se simula a Tomás (organizador) para can_manage_event.
  perform set_config('request.jwt.claim.sub', v_tomas::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_tomas::text, 'role', 'authenticated')::text, true);

  begin
    -- ===== CUERPO DEL CASO =====

    select array_agg(x.id) into v_users from (
      select u.id from public.users u
      left join public.workspace_members wm on wm.user_id = u.id and wm.workspace_id = v_ws
      order by (wm.user_id is null), random()
      limit 12) x;
    v_n := coalesce(array_length(v_users, 1), 0);
    select count(*) into v_members from public.workspace_members wm where wm.workspace_id = v_ws and wm.user_id = any (v_users);
    if v_n < 12 then raise exception 'No hay 12 usuarios en la base para armar el caso (hay %).', v_n; end if;

    insert into public.draft_events
      (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, event_type,
       competition_format, topcut_format, top_size, is_official)
    values (v_ws, 'ZZ_TEST_COPA_C (se revierte)', now(), v_tomas, v_tomas, 'draft', 'knockout', 'bo1', null, false)
    returning id into v_e;
    insert into public.event_participants (event_id, user_id, role)
    select v_e, uid, 'player' from unnest(v_users) as uid;
    select starting_life into v_life from public.draft_events where id = v_e;
v_report := v_report || E'\n' || 'CASO C: 12 jugadores (' || v_members || ' miembros reales del workspace, ' || (v_n - v_members) || ' de relleno), BO1';
    update public.draft_events set draft_started_at = now(), status = 'drafting' where id = v_e;
    update public.draft_events set draft_ended_at = now(), status = 'playing' where id = v_e;
    v_report := v_report || E'\n' || 'Estados: scheduled -> drafting -> playing (el trigger de 8 a 16 jugadores corrió y dejó pasar)';

    v_first_round := 'round_of_16';
    begin
      execute 'set local role authenticated';
      v_g := public.draw_knockout_bracket(v_e);
      execute 'reset role';
      v_report := v_report || E'\n' || 'draw_knockout_bracket ejecutado como rol authenticated (con el claim de Tomás): OK';
    exception when others then
      execute 'reset role';
      v_report := v_report || E'\n' || 'AVISO: draw_knockout_bracket como authenticated falló (' || sqlstate || ': ' || sqlerrm || '); se reintenta como postgres.';
      v_g := public.draw_knockout_bracket(v_e);
    end;
    select count(*) filter (where s.is_bye), count(*) filter (where not s.is_bye)
      into v_byes, v_r1 from public.knockout_slots s where s.group_id = v_g and s.round_key = v_first_round;
    v_report := v_report || E'\n' || 'SORTEO (primera ronda: ' || v_first_round || '): ' || v_byes || ' byes, ' || v_r1 || ' cruces jugables';
    select string_agg(coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = s.winner_participant_id), '(nadie)'), ', ' order by s."position") into v_txt
      from public.knockout_slots s where s.group_id = v_g and s.is_bye;
    v_report := v_report || E'\n' || '  byes (pasan directo): ' || coalesce(v_txt, '(ninguno)');
    select string_agg('    ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = bm.participant_a_id), '(nadie)') || '  vs  ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = bm.participant_b_id), '(nadie)'), E'\n' order by bm.created_at) into v_txt
      from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and bm.bracket_phase = v_first_round;
    v_report := v_report || E'\n' || '  cruces de primera ronda:' || E'
' || coalesce(v_txt, '    (ninguno)');
v_ok := coalesce((v_byes = 4 and v_r1 = 4), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'sorteo de 12: 4 byes y 4 cruces en octavos (hay ' || v_byes || ' byes, ' || v_r1 || ' cruces)'; if not v_ok then v_fail := v_fail + 1; end if;
    v_report := v_report || E'\n\n"ME VOY":';
    -- (1) ANTES de que arranque el primer cruce: alguien con un cruce de primera ronda armado y sin jugar

    v_p := (select bm.participant_a_id from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and bm.winner_participant_id is null and bm.pairing_id is not null order by bm.created_at limit 1);
    if v_p is null then
      v_report := v_report || E'\n' || '"Me voy" (1) antes del primer cruce: no se encontró un jugador con esa condición (se omite)';
    else
      update public.event_participants set left_event_at = now(), left_event_by = v_tomas where id = v_p;
      begin
        execute 'set local role authenticated';
        v_c := public.apply_knockout_walkover(v_p);
        execute 'reset role';
      exception when others then
        execute 'reset role';
        v_report := v_report || E'\n' || 'AVISO: apply_knockout_walkover como authenticated falló (' || sqlstate || ': ' || sqlerrm || '); se reintenta como postgres.';
        v_c := public.apply_knockout_walkover(v_p);
      end;
      v_report := v_report || E'\n' || '"Me voy" (1) antes del primer cruce: se fue ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = v_p), '(nadie)') || ' -> cruces resueltos por walkover: ' || v_c;
    end if;
v_ok := coalesce((exists (select 1 from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and v_p in (bm.participant_a_id, bm.participant_b_id)
      and bm.winner_participant_id is not null and bm.winner_participant_id <> v_p
      and exists (select 1 from public.matches m where m.pairing_id = bm.pairing_id and m.is_walkover and m.winner_participant_id = bm.winner_participant_id))), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || '(1): perdió un cruce por walkover y el rival avanzó'; if not v_ok then v_fail := v_fail + 1; end if;
    -- se juega UNA serie de octavos

    v_guard := 0;
    loop
      v_guard := v_guard + 1;
      exit when v_guard > 60 or (1 is not null and v_guard > 1);
      select bm.id, bm.pairing_id, bm.participant_a_id, bm.participant_b_id, bm.bracket_phase into v_bm
      from public.event_tiebreak_bracket_matches bm
      where bm.group_id = v_g and bm.winner_participant_id is null and bm.pairing_id is not null
        and not exists (select 1 from public.event_participants ep
                        where ep.id in (bm.participant_a_id, bm.participant_b_id) and ep.left_event_at is not null)
      order by case bm.bracket_phase when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3 when 'final' then 4 else 5 end,
               bm.created_at
      limit 1;
      exit when v_bm.id is null;
      v_series := v_series + 1;
      v_games := 1;
      for v_k in 1..v_games loop
        select coalesce(max(m.match_number), 0) + 1 into v_num from public.matches m where m.pairing_id = v_bm.pairing_id;
        insert into public.matches (pairing_id, match_number, match_type, started_at, starting_life_a, starting_life_b, tiebreak_round)
        values (v_bm.pairing_id, v_num, 'tiebreak', now(), v_life, v_life, 1)
        returning id into v_m;
        update public.matches
        set winner_participant_id = case when false and v_k = 1 and v_series % 2 = 1 then v_bm.participant_b_id else v_bm.participant_a_id end,
            ended_at = now(), status = 'completed'
        where id = v_m;
        exit when (select bm2.winner_participant_id from public.event_tiebreak_bracket_matches bm2 where bm2.id = v_bm.id) is not null;
      end loop;
    end loop;

    -- (2) EN MEDIO de una ronda: alguien con un cruce armado, sin partida en curso y sin haberse ido

    v_p := (select bm.participant_a_id from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and bm.winner_participant_id is null and bm.pairing_id is not null
        and not exists (select 1 from public.event_participants ep where ep.id in (bm.participant_a_id, bm.participant_b_id) and ep.left_event_at is not null)
        and not exists (select 1 from public.matches m where m.pairing_id = bm.pairing_id and m.status = 'in_progress')
        order by bm.created_at desc limit 1);
    if v_p is null then
      v_report := v_report || E'\n' || '"Me voy" (2) en medio de una ronda: no se encontró un jugador con esa condición (se omite)';
    else
      update public.event_participants set left_event_at = now(), left_event_by = v_tomas where id = v_p;
      begin
        execute 'set local role authenticated';
        v_c := public.apply_knockout_walkover(v_p);
        execute 'reset role';
      exception when others then
        execute 'reset role';
        v_report := v_report || E'\n' || 'AVISO: apply_knockout_walkover como authenticated falló (' || sqlstate || ': ' || sqlerrm || '); se reintenta como postgres.';
        v_c := public.apply_knockout_walkover(v_p);
      end;
      v_report := v_report || E'\n' || '"Me voy" (2) en medio de una ronda: se fue ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = v_p), '(nadie)') || ' -> cruces resueltos por walkover: ' || v_c;
    end if;
v_ok := coalesce((exists (select 1 from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and v_p in (bm.participant_a_id, bm.participant_b_id)
      and bm.winner_participant_id is not null and bm.winner_participant_id <> v_p
      and exists (select 1 from public.matches m where m.pairing_id = bm.pairing_id and m.is_walkover and m.winner_participant_id = bm.winner_participant_id))), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || '(2): perdió un cruce por walkover y el rival avanzó'; if not v_ok then v_fail := v_fail + 1; end if;
    -- (3) alguien que YA GANÓ un cruce jugado y espera rival (su próximo cruce todavía no está armado).
    -- Se prefiere quien ganó jugando (no por bye); si no hay, se juegan hasta 3 series más para que aparezca; y si
    -- igual no aparece, se usa quien pasó directo por bye.
    v_x := null; v_kind := null;
    for v_try in 1..4 loop
      select s.winner_participant_id, 'ganó su cruce' into v_x, v_kind
      from public.knockout_slots s join public.knockout_slots n on n.id = s.feeds_slot_id
      where s.group_id = v_g and s.winner_participant_id is not null and not s.is_bye and n.bracket_match_id is null
        and (n.participant_a_id is null or n.participant_b_id is null)
        and not exists (select 1 from public.event_participants ep where ep.id = s.winner_participant_id and ep.left_event_at is not null)
      order by s.created_at limit 1;
      exit when v_x is not null or v_try = 4;
      
    v_guard := 0;
    loop
      v_guard := v_guard + 1;
      exit when v_guard > 60 or (1 is not null and v_guard > 1);
      select bm.id, bm.pairing_id, bm.participant_a_id, bm.participant_b_id, bm.bracket_phase into v_bm
      from public.event_tiebreak_bracket_matches bm
      where bm.group_id = v_g and bm.winner_participant_id is null and bm.pairing_id is not null
        and not exists (select 1 from public.event_participants ep
                        where ep.id in (bm.participant_a_id, bm.participant_b_id) and ep.left_event_at is not null)
      order by case bm.bracket_phase when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3 when 'final' then 4 else 5 end,
               bm.created_at
      limit 1;
      exit when v_bm.id is null;
      v_series := v_series + 1;
      v_games := 1;
      for v_k in 1..v_games loop
        select coalesce(max(m.match_number), 0) + 1 into v_num from public.matches m where m.pairing_id = v_bm.pairing_id;
        insert into public.matches (pairing_id, match_number, match_type, started_at, starting_life_a, starting_life_b, tiebreak_round)
        values (v_bm.pairing_id, v_num, 'tiebreak', now(), v_life, v_life, 1)
        returning id into v_m;
        update public.matches
        set winner_participant_id = case when false and v_k = 1 and v_series % 2 = 1 then v_bm.participant_b_id else v_bm.participant_a_id end,
            ended_at = now(), status = 'completed'
        where id = v_m;
        exit when (select bm2.winner_participant_id from public.event_tiebreak_bracket_matches bm2 where bm2.id = v_bm.id) is not null;
      end loop;
    end loop;

    end loop;
    if v_x is null then
      select s.winner_participant_id, 'pasó directo por bye' into v_x, v_kind
      from public.knockout_slots s join public.knockout_slots n on n.id = s.feeds_slot_id
      where s.group_id = v_g and s.winner_participant_id is not null and s.is_bye and n.bracket_match_id is null
        and (n.participant_a_id is null or n.participant_b_id is null)
        and not exists (select 1 from public.event_participants ep where ep.id = s.winner_participant_id and ep.left_event_at is not null)
      order by s.created_at limit 1;
    end if;
    v_report := v_report || E'\n' || '(3) candidato: ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = v_x), '(nadie)') || ' (' || coalesce(v_kind, '?') || ', espera rival)';

    v_p := v_x;
    if v_p is null then
      v_report := v_report || E'\n' || '"Me voy" (3) ya ganó y espera rival: no se encontró un jugador con esa condición (se omite)';
    else
      update public.event_participants set left_event_at = now(), left_event_by = v_tomas where id = v_p;
      begin
        execute 'set local role authenticated';
        v_c := public.apply_knockout_walkover(v_p);
        execute 'reset role';
      exception when others then
        execute 'reset role';
        v_report := v_report || E'\n' || 'AVISO: apply_knockout_walkover como authenticated falló (' || sqlstate || ': ' || sqlerrm || '); se reintenta como postgres.';
        v_c := public.apply_knockout_walkover(v_p);
      end;
      v_report := v_report || E'\n' || '"Me voy" (3) ya ganó y espera rival: se fue ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = v_p), '(nadie)') || ' -> cruces resueltos por walkover: ' || v_c;
    end if;

    v_x := v_p;  -- el que se fue en (3)
    v_ok := coalesce((v_c = 0), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || '(3) al irse no había nada pendiente que resolver: 0 cruces por walkover (hay ' || coalesce(v_c::text, 'null') || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    -- se juega todo lo que falta; el "hueco" de (3) tiene que resolverse solo cuando se arme su próximo cruce

    v_guard := 0;
    loop
      v_guard := v_guard + 1;
      exit when v_guard > 60 or (null is not null and v_guard > null);
      select bm.id, bm.pairing_id, bm.participant_a_id, bm.participant_b_id, bm.bracket_phase into v_bm
      from public.event_tiebreak_bracket_matches bm
      where bm.group_id = v_g and bm.winner_participant_id is null and bm.pairing_id is not null
        and not exists (select 1 from public.event_participants ep
                        where ep.id in (bm.participant_a_id, bm.participant_b_id) and ep.left_event_at is not null)
      order by case bm.bracket_phase when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3 when 'final' then 4 else 5 end,
               bm.created_at
      limit 1;
      exit when v_bm.id is null;
      v_series := v_series + 1;
      v_games := 1;
      for v_k in 1..v_games loop
        select coalesce(max(m.match_number), 0) + 1 into v_num from public.matches m where m.pairing_id = v_bm.pairing_id;
        insert into public.matches (pairing_id, match_number, match_type, started_at, starting_life_a, starting_life_b, tiebreak_round)
        values (v_bm.pairing_id, v_num, 'tiebreak', now(), v_life, v_life, 1)
        returning id into v_m;
        update public.matches
        set winner_participant_id = case when false and v_k = 1 and v_series % 2 = 1 then v_bm.participant_b_id else v_bm.participant_a_id end,
            ended_at = now(), status = 'completed'
        where id = v_m;
        exit when (select bm2.winner_participant_id from public.event_tiebreak_bracket_matches bm2 where bm2.id = v_bm.id) is not null;
      end loop;
    end loop;

    v_p := v_x;
v_ok := coalesce((exists (select 1 from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and v_p in (bm.participant_a_id, bm.participant_b_id)
      and bm.winner_participant_id is not null and bm.winner_participant_id <> v_p
      and exists (select 1 from public.matches m where m.pairing_id = bm.pairing_id and m.is_walkover and m.winner_participant_id = bm.winner_participant_id))), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || '(3) se resolvió el hueco: el que se fue: perdió un cruce por walkover y el rival avanzó'; if not v_ok then v_fail := v_fail + 1; end if;
    select string_agg(t.l, E'\n' order by t.ord, t.created_at) into v_txt from (
      select case bm.bracket_phase when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3 when 'final' then 4 else 5 end as ord,
             bm.created_at,
             '    ' || rpad(bm.bracket_phase, 12) || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = bm.participant_a_id), '(nadie)') || '  vs  ' || coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = bm.participant_b_id), '(nadie)')
               || '  ->  ' || case when bm.winner_participant_id is null then '(pendiente)' else coalesce((select '#' || gp.seed || ' ' || left(coalesce(u.display_name, u.username), 12) from public.event_tiebreak_group_participants gp join public.event_participants ep on ep.id = gp.participant_id join public.users u on u.id = ep.user_id where gp.group_id = v_g and gp.participant_id = bm.winner_participant_id), '(nadie)') end
               || case when exists (select 1 from public.matches m where m.pairing_id = bm.pairing_id and m.is_walkover) then '   [walkover]' else '' end as l
      from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g) t;
    v_report := v_report || E'\n' || 'QUIÉN AVANZÓ EN CADA RONDA:' || E'
' || coalesce(v_txt, '    (sin cruces)');

    v_report := v_report || E'\n\nVERIFICACIONES:';
    select e.status, e.champion_user_id, e.champion_decided_by into v_status, v_champ, v_decided from public.draft_events e where e.id = v_e;
    select g.status, g.champion_user_id into v_gstatus, v_gchamp from public.event_tiebreak_groups g where g.id = v_g;
    v_ok := coalesce((v_status = 'completed'), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'evento completed (status = ' || coalesce(v_status, 'null') || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    v_ok := coalesce((v_champ is not null and v_decided = 'tiebreak'), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'champion_user_id definido y champion_decided_by = tiebreak (' || coalesce(v_decided, 'null') || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    v_ok := coalesce((v_gstatus = 'resolved' and v_gchamp is not distinct from v_champ), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'grupo resolved con champion_user_id coherente (grupo: ' || coalesce(v_gstatus, 'null') || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    select ep.user_id into v_x from public.event_tiebreak_bracket_matches bm
      join public.event_participants ep on ep.id = bm.winner_participant_id
      where bm.group_id = v_g and bm.bracket_phase = 'final';
    v_ok := coalesce((v_x is not distinct from v_champ and v_x is not null), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'el campeón del evento es el ganador de la final'; if not v_ok then v_fail := v_fail + 1; end if;
    select count(*), count(*) filter (where bm.winner_participant_id is not null) into v_rows, v_done
      from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g;
    v_ok := coalesce((v_rows = 12 and v_done = 12), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || '12 cruces (11 de eliminación + 3er puesto), todos con ganador (hay ' || v_rows || ', resueltos ' || v_done || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    select count(*) into v_cnt from public.event_tiebreak_bracket_matches bm where bm.group_id = v_g and bm.bracket_phase = 'third_place';
    v_ok := coalesce((v_cnt = 1), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'un solo partido por el 3er puesto'; if not v_ok then v_fail := v_fail + 1; end if;
    select count(*) into v_drafts from public.matches m join public.pairings p on p.id = m.pairing_id where p.event_id = v_e and m.match_type = 'draft';
    v_ok := coalesce((v_drafts = 0), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'ninguna partida con match_type = draft (hay ' || v_drafts || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    select count(*) into v_cnt from public.pairings p where p.event_id = v_e and p.stage is distinct from 'bracket';
    v_ok := coalesce((v_cnt = 0), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'todos los pairings del evento tienen stage = bracket (fuera de lo esperado: ' || v_cnt || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    select count(*) into v_wo from public.matches m join public.pairings p on p.id = m.pairing_id where p.event_id = v_e and m.is_walkover;
    select count(*) filter (where g.status = 'active') into v_cnt from public.event_tiebreak_groups g where g.event_id = v_e;
    v_ok := coalesce((v_cnt = 0), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'ningún grupo quedó active (' || v_cnt || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    v_report := v_report || E'\n' || '  (partidas walkover en el evento: ' || v_wo || ')';

    select count(*) into v_cnt from public.event_participants ep where ep.event_id = v_e and ep.left_event_at is not null;
    v_ok := coalesce((v_cnt = 3), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'tres jugadores se fueron (' || v_cnt || ')'; if not v_ok then v_fail := v_fail + 1; end if;
    v_ok := coalesce((v_champ is not null and not exists (select 1 from public.event_participants ep where ep.event_id = v_e and ep.user_id = v_champ and ep.left_event_at is not null)), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'el campeón no es nadie de los que se fueron'; if not v_ok then v_fail := v_fail + 1; end if;

    -- ===== FIN DEL CUERPO DEL CASO =====
  exception when others then
    get stacked diagnostics v_ctx = pg_exception_context;
    v_fail := v_fail + 1;
    v_report := v_report || E'\n*** ERROR INESPERADO (estado ' || sqlstate || '): ' || sqlerrm
      || E'\n    contexto: ' || coalesce(v_ctx, '(sin contexto)');
  end;

  v_report := v_report || E'\n\n' || repeat('=', 70) || E'\nRESUMEN: '
    || case when v_fail = 0 then 'TODO COMO SE ESPERABA' else v_fail::text || ' FALLA(S) O ERROR(ES)' end;

  -- LA TRANSACCIÓN SIEMPRE SE REVIERTE: este raise exception es la única salida del bloque.
  -- Cualquier error del cuerpo cae en el handler de arriba y termina acá igual. Un DO es atómico:
  -- al terminar con error, Postgres deshace TODO lo que hizo (eventos, jugadores, partidas,
  -- grupos, slots, temporadas, auditoría...). Nada se confirma.
  raise exception using
    errcode = 'P0001',
    message = E'\n' || v_report
      || E'\n\nROLLBACK OK: el bloque termina siempre con un error a propósito, así que Postgres revirtió todo (no quedó ningún dato).';
end;
$knockout_test$;
