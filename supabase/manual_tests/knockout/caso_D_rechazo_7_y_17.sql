-- ============================================================================================
-- CASO D — rechazo al pasar a drafting con 7 y con 17 jugadores (y aceptación con 8 y 16)
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

    foreach v_n in array array[7, 17, 8, 16] loop
      select array_agg(x.id) into v_users from (
        select u.id from public.users u
        left join public.workspace_members wm on wm.user_id = u.id and wm.workspace_id = v_ws
        order by (wm.user_id is null), random()
        limit v_n) x;
      if coalesce(array_length(v_users, 1), 0) < v_n then
        v_ok := coalesce((false), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'no hay ' || v_n || ' usuarios en la base para armar este caso'; if not v_ok then v_fail := v_fail + 1; end if;
        continue;
      end if;
      select count(*) into v_members from public.workspace_members wm where wm.workspace_id = v_ws and wm.user_id = any (v_users);
      insert into public.draft_events
        (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, event_type,
         competition_format, topcut_format, top_size, is_official)
      values (v_ws, 'ZZ_TEST_COPA_D' || v_n || ' (se revierte)', now(), v_tomas, v_tomas, 'draft', 'knockout', 'bo1', null, false)
      returning id into v_e;
      insert into public.event_participants (event_id, user_id, role) select v_e, uid, 'player' from unnest(v_users) as uid;
      v_report := v_report || E'\n' || E'\nCon ' || v_n || ' jugadores inscriptos (' || v_members || ' miembros reales del workspace):';

      -- scheduled -> drafting (como la app: draft_started_at + status)
      v_res := null; v_sqlstate := null;
      begin
        update public.draft_events set draft_started_at = now(), status = 'drafting' where id = v_e;
        v_res := 'pasó a drafting';
      exception when others then
        v_sqlstate := sqlstate;
        v_res := 'rechazado (' || sqlstate || '): ' || sqlerrm;
      end;
      v_report := v_report || E'\n' || '  scheduled -> drafting: ' || v_res;
      if v_n in (7, 17) then
        v_ok := coalesce((v_sqlstate = '23514' and v_res like '%entre 8 y 16%'), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'con ' || v_n || ' el trigger rechaza el paso a drafting (23514, mensaje "entre 8 y 16")'; if not v_ok then v_fail := v_fail + 1; end if;
        select status into v_status from public.draft_events where id = v_e;
        v_ok := coalesce((v_status = 'scheduled'), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'el evento de ' || v_n || ' sigue en scheduled tras el rechazo (' || v_status || ')'; if not v_ok then v_fail := v_fail + 1; end if;
        -- saltear drafting: scheduled -> playing directo
        v_res := null; v_sqlstate := null;
        begin
          update public.draft_events set status = 'playing' where id = v_e;
          v_res := 'pasó a playing';
        exception when others then
          v_sqlstate := sqlstate;
          v_res := 'rechazado (' || sqlstate || '): ' || sqlerrm;
        end;
        v_report := v_report || E'\n' || '  scheduled -> playing (salteando drafting): ' || v_res;
        v_ok := coalesce((v_sqlstate = '23514'), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'con ' || v_n || ' tampoco se puede saltear drafting hacia playing'; if not v_ok then v_fail := v_fail + 1; end if;
      else
        v_ok := coalesce((v_sqlstate is null and v_res = 'pasó a drafting'), false); v_report := v_report || E'\n  [' || case when v_ok then 'OK   ' else 'FALLA' end || '] ' || 'con ' || v_n || ' el trigger deja pasar a drafting (límite del rango permitido)'; if not v_ok then v_fail := v_fail + 1; end if;
      end if;
    end loop;

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
