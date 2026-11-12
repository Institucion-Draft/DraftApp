-- 0156_cubos_letras_estables.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
--
-- QUÉ CAMBIA
--   Hasta la 0155, analytics_private.cube_pos se rearmaba en CADA refresco con row_number() sobre el alias aleatorio del cubo: las letras
--   públicas de cubo (Cubo A, B, C...) cambiaban en cada refresco. Ahora cada cubo conserva su letra:
--     * Tabla privada nueva analytics_private.cube_orden (cube_id, orden): orden PERMANENTE de cada cubo. Se llena la PRIMERA vez que el
--       cubo entra al conjunto PUBLICADO (usado por algún evento válido y con creador no excluido), NO cuando se crea su alias. Los cubos
--       que entran por primera vez en un mismo refresco reciben su orden en ORDEN ALEATORIO entre ellos y siempre DESPUÉS del mayor orden
--       ya registrado. El orden de un cubo registrado no cambia nunca (las filas no se borran).
--     * cube_pos = row_number() sobre ese orden, solo entre los cubos publicados en ese refresco: letras densas (A..n, sin huecos; el
--       chequeo ids_cubo_con_huecos sigue valiendo) y estables. Solo se corren si un cubo anterior deja de publicarse (borrado, sin uso o
--       con el creador excluido); si vuelve a publicarse recupera su orden y por lo tanto su lugar relativo.
--     * Siembra inicial: si cube_orden está VACÍA, se llena con los cubos publicados HOY (cube_pos vigente, orden = pos actual), de modo
--       que las letras de hoy quedan como están. Si cube_pos está vacío (entornos nuevos) no inserta nada y no falla.
--   refresh_analytics() se redefine IGUAL que en la 0155 salvo el bloque de cubos (marcado abajo). Los JUGADORES no cambian: sus puestos
--   siguen rearmándose en cada refresco. SECURITY DEFINER, search_path fijo con pg_temp al final, SHARE sobre player_optout, RLS y
--   privilegios se mantienen; la tabla nueva vive en analytics_private con RLS y REVOKE explícito (ningún acceso para analytics_reader,
--   anon, authenticated, service_role ni PUBLIC).
--   Privacidad: el orden refleja la fecha de PRIMERA publicación del cubo (ya deducible de eventos.fecha),
--   nunca el orden de creación del cubo ni del alta del usuario (los cubos nuevos de un mismo refresco se mezclan al azar).
--
-- CÓMO APLICARLA EN PRODUCCIÓN (a mano, SQL Editor)
--   0. FUERA de la ventana del cron de refresco (08:30 UTC = 05:30 Buenos Aires; la migración toma el mismo lock y esperaría, pero una
--      corrida del cron ENTRE el paso 1 y el 2 cambiaría las letras antes de sembrar).
--   1. ANTES: anotar el mapa actual (Consulta A de abajo). Esperado hoy: 8 cubos, puestos 1 a 8.
--   2. Correr ESTE archivo completo (es una sola transacción; no llama al refresco).
--   3. Comprobar la siembra (Consulta B): cube_orden debe tener las mismas 8 filas y el mismo orden.
--   4. Refrescar a mano: select analytics_private.refresh_analytics();
--   5. DESPUÉS: repetir la Consulta A y comparar: A..H idénticos. Correr la Consulta C (dos refrescos seguidos, mismo mapa): 0 y 0.
--   6. Correr las verificaciones de operacion.md §e (privilegios y RLS: cube_orden debe aparecer con RLS = true y SIN acceso para nadie
--      salvo el dueño; analytics_control.verificacion todo en true; refresco vigente).
--
-- CONSULTA A (mapa de cubos: puesto, letra pública, nombre real; SOLO para el administrador, el nombre real no sale del SQL Editor)
--   select cp.pos, analytics_private.letras(cp.pos) as letra, c.name
--   from analytics_private.cube_pos cp
--   join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
--   join public.cubes c on c.id = ca.cube_id
--   order by cp.pos;
--
-- CONSULTA B (la siembra conservó el mapa: debe devolver 0 filas)
--   select cp.pos, o.orden
--   from analytics_private.cube_pos cp
--   join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
--   left join analytics_private.cube_orden o on o.cube_id = ca.cube_id
--   where o.orden is distinct from cp.pos;
--
-- CONSULTA C (dos refrescos seguidos dejan el mismo mapa; correr TODO junto en una sola ejecución; esperado: 0 y 0)
--   begin;
--   create temp table _m1 on commit drop as select alias_n, pos from analytics_private.cube_pos;
--   select analytics_private.refresh_analytics();
--   select (select count(*) from (select alias_n, pos from _m1 except select alias_n, pos from analytics_private.cube_pos) a) as faltan_o_cambiaron,
--          (select count(*) from (select alias_n, pos from analytics_private.cube_pos except select alias_n, pos from _m1) b) as aparecieron_o_cambiaron;
--   commit;

begin;
set local lock_timeout = '3s';

-- ============================================================================================================================
-- 1. TABLA PRIVADA: orden permanente de los cubos
-- ============================================================================================================================
create table if not exists analytics_private.cube_orden (
  cube_id    uuid primary key,                              -- misma clave que analytics_private.cube_alias (sin FK a propósito: las filas sobreviven al borrado del cubo)
  orden      integer not null unique check (orden > 0),     -- permanente; puede tener huecos (cubos que dejaron de publicarse)
  created_at timestamptz not null default now()
);

alter table analytics_private.cube_orden enable row level security;   -- sin políticas: solo el dueño

-- Permisos: REVOKE explícito sobre el objeto nuevo (regla 10.2 de la 0155: los privilegios por defecto globales no se anulan desde el esquema).
revoke all on analytics_private.cube_orden from public, anon, authenticated, service_role, analytics_reader;

-- ============================================================================================================================
-- 2. SIEMBRA INICIAL (solo si cube_orden está vacía; tolerante a cube_pos vacío)
--    El lock es el MISMO que toma refresh_analytics(): mientras corre la migración ningún refresco puede reescribir cube_pos.
-- ============================================================================================================================
select pg_advisory_xact_lock(hashtext('analytics_refresh'));

-- >>> SIEMBRA
insert into analytics_private.cube_orden (cube_id, orden)
select ca.cube_id, cp.pos
from analytics_private.cube_pos cp
join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
where not exists (select 1 from analytics_private.cube_orden);
-- <<< SIEMBRA

-- ============================================================================================================================
-- 3. REFRESCO: igual que la 0155 salvo el bloque marcado "CUBOS (0156)"
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
                                  mazo_prestado_a, mazo_prestado_b)
  select g.partida_key, g.enf_key, g.numero, g.tipo, 'completed',
         least(pa.pos, pb.pos), greatest(pa.pos, pb.pos),
         (select pg.pos from analytics_private.player_pos pg where pg.alias_n = g.alias_ganador),
         (select ps.pos from analytics_private.player_pos ps where ps.alias_n = g.alias_empieza),
         g.duracion_min,
         case when pa.pos <= pb.pos then g.prestado_a else g.prestado_b end,
         case when pa.pos <= pb.pos then g.prestado_b else g.prestado_a end
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

comment on table analytics_private.cube_orden is 'PRIVADO: orden permanente de los cubos (se registra la primera vez que se publican). De aquí sale la letra pública estable.';

commit;

-- ============================================================================================================================
-- ROLLBACK -- NO CORRER. Solo documenta cómo deshacer; ejecutar únicamente con revisión manual.
--   Vuelve a letras que cambian en cada refresco. Orden: PRIMERO restaurar la función (la nueva depende de cube_orden), DESPUÉS borrar la tabla.
--   1. Re-ejecutar la definición de analytics_private.refresh_analytics() de supabase/migrations/0155_analytics.sql (sección 8,
--      "create or replace function analytics_private.refresh_analytics() ... end $$;"), que arma cube_pos con row_number() sobre alias_n.
--   2. begin;
--      drop table if exists analytics_private.cube_orden;
--      commit;
--   3. select analytics_private.refresh_analytics();   -- las letras se reasignan por alias aleatorio (cambian una vez más)
--   Antes de borrar cube_orden, respaldar: select cube_id, orden from analytics_private.cube_orden order by orden;
-- ============================================================================================================================
