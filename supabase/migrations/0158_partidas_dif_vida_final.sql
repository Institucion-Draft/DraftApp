-- 0158_partidas_dif_vida_final.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
--
-- QUÉ CAMBIA
--   analytics.partidas gana la columna dif_vida_final integer NULL: vida final del GANADOR menos vida final del PERDEDOR de la partida.
--     * Misma definición que achv_eval_largar_el_blanco (0123): vida final de cada lado = resulting_life del ÚLTIMO life_events de esa partida
--       para ese participante (orden por occurred_at desc, id desc; los undo son filas propias con resulting_life ya corregido). Si un
--       lado no tiene eventos, se usa su vida inicial de la partida (matches.starting_life_a / starting_life_b según sea el participante A o B
--       del pairing).
--     * Si la partida NO tiene NINGÚN life_events, queda NULL (no se usa la vida inicial en ese caso).
--     * Sin límites: puede ser negativa o cero (p. ej. un abandono). No se recorta.
--   El universo de partidas NO cambia: es el de v_partidas_base / analytics.partidas de siempre (oficial, sin 2HG, sin venganzas, sin walkover,
--   sin exclusión voluntaria, solo cruces publicados). Ningún filtro se toca.
--   Objetos: función privada analytics_private.dif_vida_final(match_id) (REVOKE explícito: solo la usa refresh_analytics) y columna nueva.
--   refresh_analytics() se redefine IGUAL que en la 0156 salvo el insert de analytics.partidas (marcado "NUEVO (0158)"): SECURITY DEFINER,
--   search_path fijo con pg_temp al final, lock del refresco, SHARE sobre player_optout, RLS y privilegios se mantienen.
--   Permisos: analytics_reader ya tiene SELECT de TABLA sobre analytics.partidas (0155), que cubre las columnas nuevas; no se cambia ningún
--   GRANT ni ninguna política. La migración aborta (rollback de todo) si analytics_reader no puede leer la columna o si anon/authenticated sí.
--   Privacidad: es un número por partida sobre filas que ya se publican (ids opacos, puestos); no identifica a nadie por sí solo.
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   analytics_private.refresh_analytics   88b5b6cb57e5f872d3b1aecb6b429a9b  (9213 caracteres con LF; con CRLF: 0aab347ec408f9f47ac75b2196881108, 9358)  [0156]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'analytics_private'::regnamespace and proname = 'refresh_analytics';
--   (si el md5 vivo no coincide con ninguno de los dos, la base tiene un cuerpo distinto del de la 0156: NO aplicar sin revisar la diferencia).
--
-- CÓMO APLICARLA EN PRODUCCIÓN (a mano, SQL Editor)
--   0. FUERA de la ventana del cron de refresco (08:30 UTC = 05:30 Buenos Aires): la migración toma el mismo lock y esperaría.
--   1. ANTES: anotar los conteos (select count(*) from analytics.partidas;  hoy 423) y el md5 vivo de refresh_analytics (arriba).
--   2. Correr ESTE archivo completo (una sola transacción; no llama al refresco).
--   3. Refrescar a mano: select analytics_private.refresh_analytics();
--   4. Verificación posterior (abajo): Consulta A (cobertura), B (ninguna partida con eventos quedó en NULL) y C (permisos de la columna).
--   5. Correr las verificaciones de operacion.md §e (privilegios y RLS; analytics_control.verificacion todo en true; refresco vigente).
--   6. Avisar al repo DraftApp-analytics (no se toca desde acá): ver docs-analytics/contrato.md §2.6 y "Impacto en el loader".
--
-- CONSULTA A (cobertura; la ve también analytics_reader). Esperado hoy: 423 partidas, 416 con dato (98,3 %); si baja de 90 %, revisar
--   select count(*) as partidas, count(dif_vida_final) as con_dato,
--          round(100.0 * count(dif_vida_final) / nullif(count(*), 0), 1) as pct, min(dif_vida_final) as minimo, max(dif_vida_final) as maximo
--   from analytics.partidas;
--
-- CONSULTA B (SOLO administrador; esperado 0: toda partida publicada con life_events tiene diferencial)
--   select count(*) from analytics_private.v_partidas_base g
--   join analytics.partidas p on p.id = g.partida_key
--   where p.dif_vida_final is null and exists (select 1 from public.life_events le where le.match_id = g.match_id);
--
-- CONSULTA C (permisos de la columna; esperado: true, false, false)
--   select has_column_privilege('analytics_reader', 'analytics.partidas', 'dif_vida_final', 'select') as lector_lee,
--          has_column_privilege('anon', 'analytics.partidas', 'dif_vida_final', 'select') as anon_lee,
--          has_column_privilege('authenticated', 'analytics.partidas', 'dif_vida_final', 'select') as authenticated_lee;

begin;
set local lock_timeout = '3s';
-- El MISMO lock que toma refresh_analytics(): mientras corre la migración ningún refresco puede escribir analytics.partidas.
select pg_advisory_xact_lock(hashtext('analytics_refresh'));

-- ============================================================================================================================
-- 1. COLUMNA NUEVA (sin valor por defecto: hasta el primer refresco queda NULL)
-- ============================================================================================================================
alter table analytics.partidas add column if not exists dif_vida_final integer;
comment on column analytics.partidas.dif_vida_final is 'Vida final del ganador menos vida final del perdedor (resulting_life del último life_events de cada lado; vida inicial si un lado no tiene eventos; NULL si la partida no tiene ningún life_events). Puede ser negativa o cero.';

-- ============================================================================================================================
-- 2. FUNCIÓN PRIVADA: diferencial de vida final de una partida (misma definición que achv_eval_largar_el_blanco, 0123)
-- ============================================================================================================================
create or replace function analytics_private.dif_vida_final(p_match_id uuid)
returns integer
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case
           when not exists (select 1 from public.life_events le0 where le0.match_id = m.id) then null
           else coalesce(wl.resulting_life,
                         case when m.winner_participant_id = p.participant_a_id then m.starting_life_a else m.starting_life_b end)
              - coalesce(ll.resulting_life,
                         case when lp.loser_id = p.participant_a_id then m.starting_life_a else m.starting_life_b end)
         end
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  cross join lateral (
    select case when m.winner_participant_id = p.participant_a_id then p.participant_b_id else p.participant_a_id end as loser_id
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
  where m.id = p_match_id
$$;

revoke all on function analytics_private.dif_vida_final(uuid) from public, anon, authenticated, service_role, analytics_reader;

-- ============================================================================================================================
-- 3. REFRESCO: igual que la 0156 salvo el insert de analytics.partidas (marcado "NUEVO (0158)")
-- ============================================================================================================================
create or replace function analytics_private.refresh_analytics()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, analytics_private, pg_temp
as $$
declare
  v_sync jsonb; v_cnt jsonb; v_umbral integer;
begin
  perform pg_advisory_xact_lock(hashtext('analytics_refresh'));
  -- A3: nadie puede agregar ni quitar exclusiones mientras corre el refresco (SHARE bloquea las escrituras de player_optout hasta el
  -- commit; la lectura sigue permitida). Así una exclusión concurrente espera y queda registrada (vigente = false) DESPUÉS del refresco.
  lock table analytics_private.player_optout in share mode;
  v_sync := analytics_private.sync_aliases();
  select umbral_registro into v_umbral from analytics_private.v_cfg;

  delete from analytics.partidas;
  delete from analytics.enfrentamientos;
  delete from analytics.participaciones;
  delete from analytics.eventos;
  delete from analytics.cubos;
  delete from analytics.jugadores;
  delete from analytics_private.control_anomalias;
  delete from analytics_private.control_privacidad;
  delete from analytics_private.control_conciliacion;
  delete from analytics_control.verificacion;
  delete from analytics_control.registro_limpieza;
  delete from analytics_private.player_pos;
  delete from analytics_private.cube_pos;

  -- Mapa de puestos de JUGADORES 1..n, DESPUÉS de aplicar la exclusión, ordenado por el alias aleatorio privado (sin huecos). Cambia en cada refresco.
  insert into analytics_private.player_pos (alias_n, pos)
  select s.alias_n, (row_number() over (order by s.alias_n))::integer
  from (select distinct b.alias_n from analytics_private.v_participaciones_base b where not b.excluido) s;

  -- >>> CUBOS (0156): orden permanente + puestos densos y estables
  -- (1) Cubos publicados en este refresco que todavía no tienen orden: se registran AHORA (primera vez que se publican), en orden
  --     aleatorio entre ellos y después del mayor orden ya registrado. Los ya registrados no se tocan nunca.
  insert into analytics_private.cube_orden (cube_id, orden)
  select s.cube_id, (select coalesce(max(o.orden), 0) from analytics_private.cube_orden o) + (row_number() over (order by random()))::integer
  from (select ca.cube_id
          from analytics_private.cube_alias ca
         where exists (select 1 from analytics_private.v_cubos_visibles cv where cv.cube_id = ca.cube_id)
           and exists (select 1 from analytics_private.v_eventos_validos ev where ev.cube_id = ca.cube_id)
           and not exists (select 1 from analytics_private.cube_orden o where o.cube_id = ca.cube_id)) s;

  -- (2) Puesto = row_number() sobre el orden permanente, SOLO entre los cubos publicados ahora (sin huecos; estable salvo que alguno deje de publicarse).
  insert into analytics_private.cube_pos (alias_n, pos)
  select ca.alias_n, (row_number() over (order by o.orden))::integer
  from analytics_private.cube_alias ca
  join analytics_private.cube_orden o on o.cube_id = ca.cube_id
  where exists (select 1 from analytics_private.v_cubos_visibles cv where cv.cube_id = ca.cube_id)
    and exists (select 1 from analytics_private.v_eventos_validos ev where ev.cube_id = ca.cube_id);
  -- <<< CUBOS (0156)

  insert into analytics.jugadores (id, nombre)
  select pp.pos, 'Jugador ' || pp.pos from analytics_private.player_pos pp;

  insert into analytics.cubos (id, nombre)
  select cp.pos, 'Cubo ' || analytics_private.letras(cp.pos) from analytics_private.cube_pos cp;

  insert into analytics.eventos (id, nombre, fecha, event_type, es_oficial, estado, competition_format, match_format, cubo_id, duracion_draft_min)
  select e.evento_key,
         'Evento ' || lpad(e.rn::text, 2, '0'),
         e.fecha, e.event_type, true, e.status, e.competition_format, e.match_format,
         -- A4: si el cubo no es publicable (creador excluido) el evento se publica igual, con cubo_id NULL
         (select cp.pos from analytics_private.cube_alias ca
            join analytics_private.cube_pos cp on cp.alias_n = ca.alias_n
            join analytics_private.v_cubos_visibles cv on cv.cube_id = ca.cube_id
           where ca.cube_id = e.cube_id),
         case
           when e.data_source <> 'app' and not cfg.imported_durations_reliable then null
           when e.draft_started_at is null or e.draft_ended_at is null or e.draft_ended_at <= e.draft_started_at then null
           when d.mins < cfg.min_draft_min or d.mins > cfg.max_draft_min then null
           else d.mins
         end
  from (select ev.*, row_number() over (order by ev.fecha, ev.created_at, ev.event_id) as rn
          from analytics_private.v_eventos_validos ev) e
  cross join analytics_private.v_cfg cfg
  cross join lateral (select round(extract(epoch from (e.draft_ended_at - e.draft_started_at)) / 60.0)::integer as mins) d;

  insert into analytics.participaciones (evento_id, jugador_id, rol, colores, autoevaluacion)
  select b.evento_key, pp.pos, b.rol, b.colores, b.autoevaluacion
  from analytics_private.v_participaciones_base b
  join analytics_private.player_pos pp on pp.alias_n = b.alias_n
  where not b.excluido;

  insert into analytics.enfrentamientos (id, evento_id, ronda, fase, etapa, jugador_a, jugador_b, ganador_id, resultado, con_mazo_prestado)
  select e.enf_key, e.evento_key, e.ronda, e.fase, e.etapa,
         least(pa.pos, pb.pos), greatest(pa.pos, pb.pos),
         (select pg.pos from analytics_private.player_pos pg where pg.alias_n = e.alias_ganador),
         e.resultado, e.mazo_prestado
  from analytics_private.v_enfrentamientos_base e
  join analytics_private.player_pos pa on pa.alias_n = e.alias_a
  join analytics_private.player_pos pb on pb.alias_n = e.alias_b
  where not e.excluido and not e.es_walkover;

  insert into analytics.partidas (id, enfrentamiento_id, numero, tipo, estado, jugador_a, jugador_b, ganador_id, empieza_id, duracion_min,
                                  mazo_prestado_a, mazo_prestado_b, dif_vida_final)
  select g.partida_key, g.enf_key, g.numero, g.tipo, 'completed',
         least(pa.pos, pb.pos), greatest(pa.pos, pb.pos),
         (select pg.pos from analytics_private.player_pos pg where pg.alias_n = g.alias_ganador),
         (select ps.pos from analytics_private.player_pos ps where ps.alias_n = g.alias_empieza),
         g.duracion_min,
         case when pa.pos <= pb.pos then g.prestado_a else g.prestado_b end,
         case when pa.pos <= pb.pos then g.prestado_b else g.prestado_a end,
         analytics_private.dif_vida_final(g.match_id)   -- NUEVO (0158): vida final del ganador menos la del perdedor; NULL si la partida no tiene life_events
  from analytics_private.v_partidas_base g
  join analytics_private.player_pos pa on pa.alias_n = g.alias_a
  join analytics_private.player_pos pb on pb.alias_n = g.alias_b
  where not g.excluido and not g.es_walkover
    and exists (select 1 from analytics.enfrentamientos e where e.id = g.enf_key);  -- sin partidas huérfanas

  -- Controles EXACTOS internos
  insert into analytics_private.control_anomalias (chequeo, cantidad)
  select chequeo, cantidad from analytics_private.v_anomalias_calc;
  insert into analytics_private.control_privacidad (chequeo, violaciones)
  select chequeo, violaciones from analytics_private.v_privacidad_calc;
  insert into analytics_private.control_conciliacion (metrica, total_app, total_curado, jugadores_con_diferencia)
  select metrica, total_app, total_curado, jugadores_con_diferencia from analytics_private.v_conciliacion_calc;

  -- Lo que ve el pipeline: pasa/no pasa (sin conteos) ...
  insert into analytics_control.verificacion (chequeo, ok)
  select 'privacidad:' || chequeo, violaciones = 0 from analytics_private.control_privacidad
  union all
  select 'conciliacion:' || metrica, (total_app = total_curado and jugadores_con_diferencia = 0) from analytics_private.control_conciliacion
  union all
  select 'anomalia:' || chequeo, cantidad = 0 from analytics_private.control_anomalias
   where chequeo in ('usuarios_sin_alias_en_eventos_validos', 'eventos_con_cubo_sin_alias', 'partidas_ganador_ajeno_al_cruce',
                     'cruces_con_victoria_y_ganador_ajeno', 'partidas_sin_ended_at');

  -- ... y el registro de limpieza público: cantidades < umbral como "<5"; nunca por jugador.
  insert into analytics_control.registro_limpieza (concepto, cantidad)
  select chequeo, case when cantidad < v_umbral then '<' || v_umbral else cantidad::text end
  from analytics_private.control_anomalias
  where chequeo in ('partidas_ended_le_started', 'partidas_duracion_fuera_de_rango', 'partidas_sin_dato_de_quien_empieza',
                    'participaciones_player_sin_colores', 'partidas_de_origen_importado', 'eventos_duracion_draft_fuera_de_rango',
                    'partidas_tiebreak_sin_cruce_de_bracket', 'enfrentamientos_walkover_no_publicados', 'partidas_walkover_no_publicadas',
                    'partidas_de_cruce_no_publicado', 'participaciones_se_fue_no_publicadas');

  update analytics_control.refresco
     set refrescado_en = now(), clave_version = (select clave_version from analytics_private.v_cfg), vigente = true;

  v_cnt := jsonb_build_object(
    'jugadores',       (select count(*) from analytics.jugadores),
    'cubos',           (select count(*) from analytics.cubos),
    'eventos',         (select count(*) from analytics.eventos),
    'participaciones', (select count(*) from analytics.participaciones),
    'enfrentamientos', (select count(*) from analytics.enfrentamientos),
    'partidas',        (select count(*) from analytics.partidas));
  return v_sync || v_cnt;
end $$;

-- create or replace conserva el dueño y el ACL de la función; se repite el REVOKE explícito por si algún entorno la tuviera abierta.
revoke all on function analytics_private.refresh_analytics() from public, anon, authenticated, service_role, analytics_reader;

-- ============================================================================================================================
-- 4. VERIFICACIÓN (si algo no se cumple, falla y se deshace toda la migración)
-- ============================================================================================================================
do $verify$
begin
  if not has_column_privilege('analytics_reader', 'analytics.partidas', 'dif_vida_final', 'select') then
    raise exception '0158: analytics_reader no puede leer analytics.partidas.dif_vida_final';
  end if;
  if has_column_privilege('anon', 'analytics.partidas', 'dif_vida_final', 'select')
     or has_column_privilege('authenticated', 'analytics.partidas', 'dif_vida_final', 'select') then
    raise exception '0158: anon/authenticated pueden leer analytics.partidas.dif_vida_final';
  end if;
  if has_function_privilege('analytics_reader', 'analytics_private.dif_vida_final(uuid)', 'execute')
     or has_function_privilege('anon', 'analytics_private.dif_vida_final(uuid)', 'execute')
     or has_function_privilege('authenticated', 'analytics_private.dif_vida_final(uuid)', 'execute') then
    raise exception '0158: dif_vida_final(uuid) es ejecutable por roles que no corresponden';
  end if;
end;
$verify$;

commit;

-- ============================================================================================================================
-- ROLLBACK -- NO CORRER. Solo documenta cómo deshacer; ejecutar únicamente con revisión manual.
--   Orden: PRIMERO restaurar el refresco (el nuevo usa la columna y la función), DESPUÉS borrar la función y la columna.
--   1. Re-ejecutar la definición de analytics_private.refresh_analytics() de supabase/migrations/0156_cubos_letras_estables.sql (sección 3,
--      "create or replace function analytics_private.refresh_analytics() ... end $$;"), que inserta analytics.partidas sin dif_vida_final.
--   2. begin;
--      drop function if exists analytics_private.dif_vida_final(uuid);
--      alter table analytics.partidas drop column if exists dif_vida_final;
--      commit;
--   3. select analytics_private.refresh_analytics();
--   Avisar al repo DraftApp-analytics ANTES si ya empezó a leer la columna (su extracción fallaría al no existir).
-- ============================================================================================================================
