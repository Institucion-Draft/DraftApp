-- 0155_analytics.sql
-- ESTADO: YA APLICADA EN PRODUCCIÓN (Supabase) A MANO, desde el SQL Editor, el 2026-11-11, junto con el parche de conciliación
--   (docs-analytics/0155b_parche_conciliacion.sql). La definición de analytics_private.v_conciliacion_calc de ESTE archivo ya es la del
--   parche (verificada idéntica): el estado final de la 0155 lo incluye, por eso 0155b NO es una migración aparte.
--   NO RE-APLICAR EN PRODUCCIÓN. Este archivo existe para que el repo refleje el estado real y para reconstruir otros entornos
--   (staging, local) desde cero. No es idempotente en todo (p. ej. el primer refresco del bloque 11 reasigna puestos).
--   Producción tiene agendado en pg_cron (job id 1, creado a mano):
--     select cron.schedule('analytics_refresh', '30 8 * * *', $$select analytics_private.refresh_analytics()$$);   -- 08:30 UTC
--   El segundo trabajo (cierre de sesiones largas de analytics_reader) YA está agendado en producción (job id 2, creado a mano):
--     select cron.schedule('analytics_cerrar_sesiones', '*/5 * * * *', $$select pg_terminate_backend(pid) from pg_stat_activity where usename = 'analytics_reader' and backend_start < now() - interval '5 minutes'$$);
--   Operación (jobs, rol, conexión, verificaciones, refresco manual, exclusiones): docs-analytics/operacion.md.
--   Documentación (contrato, calidad, prueba, parche): docs-analytics/.
--
-- QUÉ HACE
--   Publica estadísticas AGREGADAS y ANONIMIZADAS para el sitio público de análisis. La anonimización ocurre DENTRO de la
--   base: ningún nombre, usuario, email, género, cumpleaños, texto libre, sede ni uuid llega a las tablas que lee el rol.
--
--   analytics_private   mapas de alias (persistente) y de puestos (por refresco), exclusión voluntaria, configuración, clave de ids
--                       (versionada), vistas base y CONTROLES EXACTOS internos. Nadie (salvo el dueño) tiene acceso.
--   analytics           SEIS TABLAS (no vistas) con el contrato: jugadores, cubos, eventos, participaciones, enfrentamientos,
--                       partidas. El rol de lectura solo hace SELECT sobre ellas (RLS activada con una política de lectura para el rol).
--                       Las rellena analytics_private.refresh_analytics(), que aplica ahí la exclusión voluntaria, el workspace y las
--                       reglas del contrato.
--   analytics_control   lo ÚNICO de control que puede leer el rol / el pipeline: refresco (estado), verificacion (solo pasa/no pasa) y
--                       registro_limpieza (conteos que se pueden publicar, con "<5" en lugar de cantidades chicas). Sin detalle por
--                       jugador y con la exclusión voluntaria aplicada.
--   analytics_reader    rol de solo lectura (sin contraseña: se fija fuera de banda). NO puede ejecutar ninguna función propia.
--
-- POR QUÉ TABLAS Y NO VISTAS (A2/M3, primera revisión)
--   Una vista cuyo dueño es postgres se ejecuta con los permisos del dueño, pero PostgreSQL puede evaluar las condiciones que escribe
--   el usuario ANTES del filtro de la vista (empuja las condiciones hacia abajo). Un rol de lectura con permiso para crear funciones
--   temporales (TEMP lo tiene PUBLIC) o escribir un cast que falla podía así provocar errores o avisos (RAISE NOTICE) con valores de
--   filas que la vista iba a descartar (jugadores excluidos). Con tablas ya filtradas esas filas no existen.
--
-- DECISIONES QUE CODIFICA (ver contrato.md)
--   * Solo el workspace de analytics_private.config('workspace_id').
--   * Eventos: is_official, sin deleted_at, sin cancelled_at, no two_headed_giant, estado drafting|playing|completed|concluded.
--   * Fecha de TODA partida = fecha del evento (día del draft en hora de Buenos Aires). No se exporta fecha_juego.
--   * Enfrentamientos de cualquier formato/fase (pairings + bracket/desempates), sin venganzas; empates BO2 con resultado 'empate'.
--   * Walkovers: los enfrentamientos y partidas decididos por walkover NO se publican, ni tampoco las partidas de un enfrentamiento
--     que no se publica; "se fue" tampoco se exporta. Solo se cuentan (agregados, "<5" si son pocos) en registro_limpieza.
--   * Partidas: completadas, con ganador, tipo draft | final | tiebreak.
--   * Importados (data_source distinto de app): duración y color en NULL (configurable).
--   * Mazos prestados, exilio y fantasmas: marcados; el color solo existe para rol = player.
--   * Exclusión voluntaria: se aplica en cada refresco; todo lo que involucre al jugador excluido desaparece. Si el creador de un cubo
--     está excluido, ese cubo no se publica y los eventos que lo usaron quedan con cubo_id NULL (los eventos siguen publicándose).
--   * IDS DE JUGADOR Y DE CUBO = PUESTO CONSECUTIVO 1..n calculado EN CADA REFRESCO (row_number sobre un alias aleatorio privado y
--     DESPUÉS de aplicar la exclusión: sin huecos). El número de un jugador o de un cubo PUEDE CAMBIAR entre refrescos. Los ids de
--     eventos, enfrentamientos y partidas (HMAC con clave versionada) sí son estables dentro de una versión de clave.
--
-- ASUNCIONES A VALIDAR (no pude consultar la base real; ver el resumen de la entrega)
--   A1. postgres es dueño de las tablas y las salta por RLS (no hay FORCE ROW LEVEL SECURITY en las migraciones 0001-0154).
--   A2. pgcrypto está instalado en el esquema extensions (default de Supabase): se usan extensions.hmac y gen_random_bytes.
--   A3. matches.is_borrowed_deck_a / _b se refieren a pairings.participant_a_id / participant_b_id.
--   A4. Los juegos 'tiebreak' se asocian al cruce de bracket por (pairing_id, tiebreak_round = event_tiebreak_groups.round_number).
--
-- RIESGOS CONOCIDOS
--   R1. Los privilegios por defecto GLOBALES de Supabase pueden otorgar a anon/authenticated/service_role sobre objetos nuevos:
--       por eso el bloque 10 hace REVOKE explícito sobre cada objeto. Verificar con calidad.md (P-PRIV-01) y revisar antes
--       pg_default_acl (contrato.md §10.4).
--   R2. 'Evento N' se numera por fecha: si se carga un evento anterior retroactivamente, los nombres posteriores se corren
--       (los id no cambian).
--   R3. Los datos publicados son tan frescos como el último refresco (ver bloque 13 sobre cómo agendarlo).
--   R4. RIESGO ACEPTADO: el rol de lectura puede abusar de TEMP y de SET si se filtra su credencial (contrato.md §10.6).
--
-- ROLLBACK: al final, bloque marcado NO CORRER.

begin;
set local lock_timeout = '3s';

-- ============================================================================================================================
-- 1. ESQUEMAS
-- ============================================================================================================================
create schema if not exists analytics_private;
create schema if not exists analytics;
create schema if not exists analytics_control;

-- ============================================================================================================================
-- 2. ROL DE SOLO LECTURA (sin contraseña: ALTER ROLE analytics_reader PASSWORD '...' se corre fuera de banda y NO se versiona)
-- ============================================================================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_reader') then
    create role analytics_reader
      login
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit
      connection limit 2;
  end if;
end $$;

-- ============================================================================================================================
-- 3. TABLAS PRIVADAS
-- ============================================================================================================================

-- 3.1 Configuración (sin material criptográfico)
create table if not exists analytics_private.config (
  key   text primary key,
  value text not null
);
insert into analytics_private.config (key, value) values
  ('workspace_id',               '804dbb96-c97d-4be5-a017-691657d5ece0'),
  ('tz',                         'America/Argentina/Buenos_Aires'),
  ('min_partida_min',            '1'),    -- duraciones fuera de [min, max] se publican en NULL (y se cuentan en el registro de limpieza)
  ('max_partida_min',            '240'),
  ('min_draft_min',              '5'),
  ('max_draft_min',              '480'),
  ('imported_colors_reliable',   'false'),  -- data_source <> 'app': colores en NULL si es 'false'
  ('imported_durations_reliable','false'),  -- data_source <> 'app': duraciones en NULL si es 'false'
  ('clave_activa',               'ids_v1'), -- nombre de la clave de ids vigente en analytics_private.secret (ver "ROTACIÓN" abajo)
  ('alias_max',                  '99999'),  -- rango FIJO del alias aleatorio PRIVADO (solo sirve para ordenar; no se publica)
  ('umbral_registro',            '5')       -- registro_limpieza: cantidades menores a esto se publican como "<5"
on conflict (key) do nothing;

-- 3.2 Clave para los ids opacos de evento, enfrentamiento y partida. VERSIONADA: cada clave tiene un nombre ('ids_v1', 'ids_v2', ...) y
--     config('clave_activa') indica cuál se usa. Se genera una sola vez por versión.
--
--     ROTACIÓN (procedimiento; cambia TODOS los ids opacos publicados de eventos, enfrentamientos y partidas):
--       1. insert into analytics_private.secret (name, value) values ('ids_v2', encode(extensions.gen_random_bytes(32), 'hex'));
--       2. update analytics_private.config set value = 'ids_v2' where key = 'clave_activa';
--       3. select analytics_private.refresh_analytics();   -- recalcula las seis tablas con la clave nueva
--       4. Republicar TODO: el sitio no puede mezclar ids de dos versiones (los vínculos y marcadores por id dejan de valer).
--       5. Cuando la publicación nueva esté verificada, borrar la clave anterior ('ids_v1') o archivarla fuera de la base.
--     Cuándo rotar: ante sospecha de que la clave se filtró. Rotar no "des-publica" lo ya publicado: si la clave anterior se
--     conoció, los ids viejos siguen siendo calculables con ella; el efecto es que los ids nuevos ya no.
create table if not exists analytics_private.secret (
  name  text primary key,
  value text not null
);
insert into analytics_private.secret (name, value)
values ('ids_v1', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- 3.3 Alias PRIVADOS y persistentes (aleatorios, solo sirven para ordenar y para no reasignar). Sin FK a public.users A PROPÓSITO:
--     el alias sobrevive al borrado de la cuenta y nunca se reutiliza (alias_n es la clave y las filas no se borran). Al borrarse la
--     cuenta, sync_aliases() pone user_id en NULL y conserva alias_n. NO son lo que se publica: lo publicado es el puesto (3.6).
create table if not exists analytics_private.player_alias (
  alias_n    integer primary key check (alias_n > 0),
  user_id    uuid unique,
  created_at timestamptz not null default now()
);
create table if not exists analytics_private.cube_alias (
  cube_id    uuid primary key,
  alias_n    integer not null unique check (alias_n > 0),
  created_at timestamptz not null default now()
);

-- 3.4 Exclusión voluntaria. Sin FK (mismo motivo). Se aplica en cada refresco.
create table if not exists analytics_private.player_optout (
  user_id      uuid primary key,
  requested_at timestamptz not null default now(),
  note         text
);

-- 3.5 Controles EXACTOS internos (conteos reales). NO se publican y solo los lee quien administra (rol dueño). El pipeline solo ve
--     analytics_control.verificacion (pasa/no pasa) y analytics_control.registro_limpieza (conteos con "<5").
create table if not exists analytics_private.control_anomalias (
  chequeo  text primary key,
  cantidad bigint not null
);
create table if not exists analytics_private.control_privacidad (
  chequeo     text primary key,
  violaciones bigint not null
);
create table if not exists analytics_private.control_conciliacion (
  metrica                  text primary key,
  total_app                bigint not null,
  total_curado             bigint not null,
  jugadores_con_diferencia bigint not null
);

-- 3.6 MAPAS DE PUESTOS, rearmados en CADA refresco DESPUÉS de aplicar la exclusión: puesto consecutivo 1..n ordenado por el alias aleatorio
--     privado (sin huecos y sin relación con el orden de alta). Las seis tablas públicas y los controles que miran lo publicado pasan
--     por estos mapas. Cambian entre refrescos.
create table if not exists analytics_private.player_pos (
  alias_n integer primary key,
  pos     integer not null unique check (pos > 0)
);
create table if not exists analytics_private.cube_pos (
  alias_n integer primary key,   -- alias_n de analytics_private.cube_alias
  pos     integer not null unique check (pos > 0)
);

-- Defensa en profundidad: RLS activado y sin políticas. El dueño (postgres) la salta; nadie más lee nada.
alter table analytics_private.config               enable row level security;
alter table analytics_private.secret               enable row level security;
alter table analytics_private.player_alias         enable row level security;
alter table analytics_private.cube_alias           enable row level security;
alter table analytics_private.player_optout        enable row level security;
alter table analytics_private.control_anomalias    enable row level security;
alter table analytics_private.control_privacidad   enable row level security;
alter table analytics_private.control_conciliacion enable row level security;
alter table analytics_private.player_pos           enable row level security;
alter table analytics_private.cube_pos             enable row level security;

-- ============================================================================================================================
-- 4. FUNCIONES PRIVADAS (todas con search_path fijo; pg_temp al final para que nadie pueda anteponer objetos temporales)
-- ============================================================================================================================

-- 1 -> A, 26 -> Z, 27 -> AA ...
create or replace function analytics_private.letras(p_n integer)
returns text
language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare s text := ''; k integer := p_n;
begin
  if p_n is null or p_n < 1 then return null; end if;
  while k > 0 loop
    s := chr(65 + ((k - 1) % 26)) || s;
    k := (k - 1) / 26;
  end loop;
  return s;
end $$;

-- Sincroniza los mapas de alias PRIVADOS con public.users y public.cubes. Idempotente. La llama refresh_analytics(); no hay triggers
-- sobre public.users ni public.cubes.
--   * Cuentas borradas: user_id pasa a NULL y el alias_n se conserva (no se reutiliza).
--   * Usuarios y cubos nuevos: cada uno recibe un número elegido AL AZAR (extensions.gen_random_bytes), uniforme dentro del rango FIJO
--     [1, alias_max] y libre. No depende del orden de alta ni de la cantidad de usuarios. Este número es PRIVADO: solo se usa para
--     ordenar al armar los puestos públicos 1..n de cada refresco. Límite honesto: si el rango se llenara, la función falla.
create or replace function analytics_private.sync_aliases()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, analytics_private, pg_temp
as $$
declare
  v_max bigint; v_u integer := 0; v_c integer := 0; v_d integer := 0; v_try integer; v_n integer; r record;
begin
  select value::bigint into v_max from analytics_private.config where key = 'alias_max';

  update analytics_private.player_alias a set user_id = null
   where a.user_id is not null and not exists (select 1 from public.users u where u.id = a.user_id);
  get diagnostics v_d = row_count;

  for r in select u.id from public.users u
           where not exists (select 1 from analytics_private.player_alias a where a.user_id = u.id)
           order by random()
  loop
    v_try := 0;
    loop
      v_try := v_try + 1;
      if v_try > 100 then raise exception 'analytics: no se pudo asignar un alias libre (alias_max = %)', v_max; end if;
      v_n := 1 + ((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % v_max)::integer;
      begin
        insert into analytics_private.player_alias (alias_n, user_id) values (v_n, r.id);
        v_u := v_u + 1;
        exit;
      exception when unique_violation then
        null;  -- número ocupado: se sortea otro
      end;
    end loop;
  end loop;

  for r in select c.id from public.cubes c
           where not exists (select 1 from analytics_private.cube_alias a where a.cube_id = c.id)
           order by random()
  loop
    v_try := 0;
    loop
      v_try := v_try + 1;
      if v_try > 100 then raise exception 'analytics: no se pudo asignar un alias de cubo libre (alias_max = %)', v_max; end if;
      v_n := 1 + ((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % v_max)::integer;
      begin
        insert into analytics_private.cube_alias (cube_id, alias_n) values (r.id, v_n);
        v_c := v_c + 1;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
  end loop;

  return jsonb_build_object('jugadores_nuevos', v_u, 'cubos_nuevos', v_c, 'cuentas_borradas_desvinculadas', v_d);
end $$;

-- ============================================================================================================================
-- 5. VISTAS BASE (analytics_private): reglas de negocio con ids internos. SOLO las lee refresh_analytics() (dueño). Nadie más.
-- ============================================================================================================================

-- 5.0 Configuración y clave activa en UNA fila tipada.
create or replace view analytics_private.v_cfg with (security_invoker = false) as
select (select value from analytics_private.config where key = 'workspace_id')::uuid                        as workspace_id,
       (select value from analytics_private.config where key = 'tz')                                         as tz,
       (select value from analytics_private.config where key = 'min_partida_min')::integer                  as min_partida_min,
       (select value from analytics_private.config where key = 'max_partida_min')::integer                  as max_partida_min,
       (select value from analytics_private.config where key = 'min_draft_min')::integer                    as min_draft_min,
       (select value from analytics_private.config where key = 'max_draft_min')::integer                    as max_draft_min,
       (select value from analytics_private.config where key = 'imported_colors_reliable') = 'true'         as imported_colors_reliable,
       (select value from analytics_private.config where key = 'imported_durations_reliable') = 'true'      as imported_durations_reliable,
       (select value from analytics_private.config where key = 'umbral_registro')::integer                  as umbral_registro,
       (select value from analytics_private.config where key = 'clave_activa')                              as clave_version,
       (select s.value from analytics_private.secret s
         where s.name = (select value from analytics_private.config where key = 'clave_activa'))            as clave_ids;

-- Id opaco y estable: 48 bits de HMAC-SHA256('<dominio>:<uuid>', clave activa). Dominios: e evento, p pairing, b cruce de bracket, m partida.

-- 5.1 Eventos que entran a los cálculos
create or replace view analytics_private.v_eventos_validos with (security_invoker = false) as
select de.id as event_id,
       ('x' || encode(substring(extensions.hmac('e:' || de.id::text, cfg.clave_ids, 'sha256') from 1 for 6), 'hex'))::bit(48)::bigint as evento_key,
       de.data_source, de.cube_id, de.event_type, de.status, de.competition_format, de.match_format,
       de.created_at,
       (coalesce(de.draft_started_at, de.scheduled_for) at time zone cfg.tz)::date as fecha,
       de.draft_started_at, de.draft_ended_at
from public.draft_events de
cross join analytics_private.v_cfg cfg
where de.workspace_id = cfg.workspace_id
  and de.is_official is true
  and de.deleted_at is null
  and de.cancelled_at is null
  and de.event_type <> 'two_headed_giant'
  and de.status in ('drafting', 'playing', 'completed', 'concluded');

-- 5.1b Cubos publicables: los que NO fueron creados por un jugador en exclusión voluntaria (A4).
create or replace view analytics_private.v_cubos_visibles with (security_invoker = false) as
select c.id as cube_id
from public.cubes c
where not exists (select 1 from analytics_private.player_optout o where o.user_id = c.created_by);

-- 5.2 Participaciones (todos los roles; `excluido` marca la exclusión voluntaria; `se_fue` solo se usa para contar, no se exporta)
create or replace view analytics_private.v_participaciones_base with (security_invoker = false) as
select ep.id as participant_id, ep.event_id, ev.evento_key, ep.user_id, pa.alias_n,
       ep.role as rol,
       ep.self_evaluation as autoevaluacion,
       (ep.left_event_at is not null) as se_fue,
       exists (select 1 from analytics_private.player_optout o where o.user_id = ep.user_id) as excluido,
       case when ep.role = 'player' and (ev.data_source = 'app' or cfg.imported_colors_reliable) then col.combo end as colores
from public.event_participants ep
join analytics_private.v_eventos_validos ev on ev.event_id = ep.event_id
join analytics_private.player_alias pa on pa.user_id = ep.user_id
cross join analytics_private.v_cfg cfg
left join lateral (
  select string_agg(pc.color, '' order by array_position(array['W','U','B','R','G','C'], pc.color)) as combo
  from public.participant_colors pc
  where pc.participant_id = ep.id and pc.member = 'a'
) col on true;

-- 5.3 Pairings de eventos válidos en los que NINGUNO de los dos participantes está excluido (base de los conteos de control).
create or replace view analytics_private.v_pairings_ok with (security_invoker = false) as
select p.id as pairing_id, p.event_id
from public.pairings p
join analytics_private.v_eventos_validos ev on ev.event_id = p.event_id
where not exists (select 1 from analytics_private.v_participaciones_base b
                   where b.participant_id in (p.participant_a_id, p.participant_b_id) and b.excluido);

-- 5.4 Enfrentamientos: pairings (sin venganzas) + cruces de bracket/desempate. Mismas reglas que v_participant_official_results
--     (0152/0153). Incluye los walkover MARCADOS (es_walkover) solo para que el refresco los excluya y los cuente.
create or replace view analytics_private.v_enfrentamientos_base with (security_invoker = false) as
with cruces as (
  select 'p'::text as dom, p.id as src_id, p.event_id, p.id as pairing_id,
         p.swiss_round as ronda,
         case p.stage when 'zone' then 'zona' when 'interzonal' then 'interzonal' when 'bracket' then 'llave' else 'regular' end as fase,
         null::text as etapa,
         null::integer as round_number,
         p.participant_a_id, p.participant_b_id,
         p.official_winner_participant_id as winner_pid,
         coalesce(p.official_draw, false) as empate,
         exists (select 1 from public.matches wm where wm.pairing_id = p.id and wm.is_walkover = true
                   and wm.match_type = any (array['draft','final'])) as walkover,
         exists (select 1 from public.matches m2 where m2.pairing_id = p.id and m2.status = 'completed'
                   and m2.match_type = any (array['draft','final'])) as tiene_partidas,
         exists (select 1 from public.matches m3 where m3.pairing_id = p.id and m3.status = 'completed'
                   and m3.is_walkover is not true and (m3.is_borrowed_deck_a or m3.is_borrowed_deck_b)
                   and m3.match_type = any (array['draft','final'])) as mazo_prestado
  from public.pairings p
  join analytics_private.v_eventos_validos ev on ev.event_id = p.event_id
  where coalesce(p.stage, '') <> 'revenge'
  union all
  select 'b', bm.id, etg.event_id, bm.pairing_id,
         null::integer,
         case etg.group_origin when 'tiebreak' then 'desempate' when 'swiss_topcut' then 'top4' when 'round_robin_topcut' then 'top4'
              when 'round_robin_first_place' then 'desempate_1er_puesto' when 'round_robin_fourth_place' then 'desempate_4to_puesto'
              when 'knockout_bracket' then 'llave' when 'knockout_second_chance' then 'segunda_chance' else 'otro' end,
         case bm.bracket_phase when 'third_place' then 'tercer_puesto' else bm.bracket_phase end,
         etg.round_number,
         bm.participant_a_id, bm.participant_b_id,
         bm.winner_participant_id,
         false,
         exists (select 1 from public.matches wmb where wmb.pairing_id = bm.pairing_id and wmb.match_type = 'tiebreak'
                   and wmb.is_walkover = true and coalesce(wmb.tiebreak_round, 1) = etg.round_number),
         true,
         exists (select 1 from public.matches m4 where m4.pairing_id = bm.pairing_id and m4.match_type = 'tiebreak'
                   and m4.status = 'completed' and m4.is_walkover is not true and (m4.is_borrowed_deck_a or m4.is_borrowed_deck_b)
                   and coalesce(m4.tiebreak_round, 1) = etg.round_number)
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups etg on etg.id = bm.group_id and etg.status <> all (array['failed', 'superseded'])
  join analytics_private.v_eventos_validos ev on ev.event_id = etg.event_id
  where bm.winner_participant_id is not null
)
select x.dom, x.src_id, x.event_id,
       a.evento_key,
       ('x' || encode(substring(extensions.hmac(x.dom || ':' || x.src_id::text, cfg.clave_ids, 'sha256') from 1 for 6), 'hex'))::bit(48)::bigint as enf_key,
       x.pairing_id, x.ronda, x.fase, x.etapa,
       a.alias_n as alias_a, b.alias_n as alias_b, a.rol as rol_a, b.rol as rol_b,
       case when x.winner_pid = x.participant_a_id then a.alias_n when x.winner_pid = x.participant_b_id then b.alias_n end as alias_ganador,
       case when x.winner_pid is not null then 'victoria' when x.empate then 'empate' else 'pendiente' end as resultado,
       x.walkover as es_walkover,
       x.mazo_prestado,
       (a.excluido or b.excluido) as excluido
from cruces x
cross join analytics_private.v_cfg cfg
join analytics_private.v_participaciones_base a on a.participant_id = x.participant_a_id and a.rol in ('player', 'exile')
join analytics_private.v_participaciones_base b on b.participant_id = x.participant_b_id and b.rol in ('player', 'exile')
where x.winner_pid is not null or x.empate or x.tiene_partidas;

-- 5.5 Partidas individuales oficiales (incluye las walkover marcadas, solo para que el refresco las excluya y las cuente)
create or replace view analytics_private.v_partidas_base with (security_invoker = false) as
select m.id as match_id, m.pairing_id, p.event_id,
       ('x' || encode(substring(extensions.hmac('m:' || m.id::text, cfg.clave_ids, 'sha256') from 1 for 6), 'hex'))::bit(48)::bigint as partida_key,
       case when bmx.id is not null then 'b' else 'p' end as dom_enf,
       coalesce(bmx.id, p.id) as src_enf_id,
       ('x' || encode(substring(extensions.hmac((case when bmx.id is not null then 'b' else 'p' end) || ':' || coalesce(bmx.id, p.id)::text,
                                                 cfg.clave_ids, 'sha256') from 1 for 6), 'hex'))::bit(48)::bigint as enf_key,
       a.alias_n as alias_a, b.alias_n as alias_b, a.rol as rol_a, b.rol as rol_b,
       m.match_number as numero, m.match_type as tipo,
       (m.is_walkover is true) as es_walkover,
       case when m.winner_participant_id = p.participant_a_id then a.alias_n
            when m.winner_participant_id = p.participant_b_id then b.alias_n end as alias_ganador,
       st.alias_n as alias_empieza,
       case
         when m.is_walkover is true then null
         when (m.data_source <> 'app' or ev.data_source <> 'app') and not cfg.imported_durations_reliable then null
         when d.mins < cfg.min_partida_min or d.mins > cfg.max_partida_min then null
         else d.mins
       end as duracion_min,
       m.is_borrowed_deck_a as prestado_a, m.is_borrowed_deck_b as prestado_b,
       (a.excluido or b.excluido) as excluido
from public.matches m
join public.pairings p on p.id = m.pairing_id
join analytics_private.v_eventos_validos ev on ev.event_id = p.event_id
cross join analytics_private.v_cfg cfg
join analytics_private.v_participaciones_base a on a.participant_id = p.participant_a_id and a.rol in ('player', 'exile')
join analytics_private.v_participaciones_base b on b.participant_id = p.participant_b_id and b.rol in ('player', 'exile')
left join analytics_private.v_participaciones_base st
       on st.participant_id = m.who_started_participant_id and st.participant_id in (p.participant_a_id, p.participant_b_id)
left join lateral (
  select bm.id
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups etg on etg.id = bm.group_id and etg.status <> all (array['failed', 'superseded'])
  where m.match_type = 'tiebreak'
    and bm.pairing_id = m.pairing_id
    and bm.winner_participant_id is not null
    and etg.round_number = coalesce(m.tiebreak_round, 1)
  order by bm.created_at, bm.id
  limit 1
) bmx on true
left join lateral (
  select round(extract(epoch from (m.ended_at - m.started_at)) / 60.0)::integer as mins
  where m.ended_at is not null and m.started_at is not null and m.ended_at > m.started_at
) d on true
where m.status = 'completed'
  and m.winner_participant_id is not null
  and m.match_type = any (array['draft', 'final', 'tiebreak'])
  and coalesce(p.stage, '') <> 'revenge';

-- ============================================================================================================================
-- 6. TABLAS PÚBLICAS (analytics): el contrato. Solo puestos e ids opacos; sin horas; sin textos libres. Las rellena refresh_analytics().
--    RLS activada con UNA política de lectura para analytics_reader (using (true)); el dueño y el refresco la saltan.
-- ============================================================================================================================

create table if not exists analytics.jugadores (
  id     integer primary key,
  nombre text not null
);

create table if not exists analytics.cubos (
  id     integer primary key,
  nombre text not null
);

create table if not exists analytics.eventos (
  id                 bigint primary key,
  nombre             text not null,
  fecha              date not null,
  event_type         text not null,
  es_oficial         boolean not null,
  estado             text not null,
  competition_format text not null,
  match_format       text not null,
  cubo_id            integer,
  duracion_draft_min integer
);

create table if not exists analytics.participaciones (
  evento_id      bigint not null,
  jugador_id     integer not null,
  rol            text not null,
  colores        text,
  autoevaluacion integer,
  primary key (evento_id, jugador_id)
);

create table if not exists analytics.enfrentamientos (
  id                bigint primary key,
  evento_id         bigint not null,
  ronda             integer,
  fase              text not null,
  etapa             text,
  jugador_a         integer not null,
  jugador_b         integer not null,
  ganador_id        integer,
  resultado         text not null,
  con_mazo_prestado boolean not null
);

create table if not exists analytics.partidas (
  id                bigint primary key,
  enfrentamiento_id bigint not null,
  numero            integer not null,
  tipo              text not null,
  estado            text not null,
  jugador_a         integer not null,
  jugador_b         integer not null,
  ganador_id        integer not null,
  empieza_id        integer,
  duracion_min      integer,
  mazo_prestado_a   boolean not null,
  mazo_prestado_b   boolean not null
);

-- ============================================================================================================================
-- 7. CONTROL: lo único que lee el pipeline (analytics_control) + vistas de cálculo (privadas) + trigger de vigencia
-- ============================================================================================================================

-- 7.1 Estado del refresco (una fila)
create table if not exists analytics_control.refresco (
  id            boolean primary key default true check (id),
  refrescado_en timestamptz,
  clave_version text,
  vigente       boolean not null default false
);
insert into analytics_control.refresco (id) values (true) on conflict (id) do nothing;

-- 7.2 Verificación: SOLO "pasa / no pasa" por chequeo (sin conteos). El pipeline BLOQUEA si alguna fila tiene ok = false.
create table if not exists analytics_control.verificacion (
  chequeo text primary key,
  ok      boolean not null
);

-- 7.3 Registro de limpieza PÚBLICO (para el sitio): cuánto se descartó o se dejó en NULL, como texto; cualquier cantidad menor a
--     config('umbral_registro') (5) se muestra como "<5". Nunca hay detalle por jugador. La exclusión voluntaria está aplicada.
create table if not exists analytics_control.registro_limpieza (
  concepto text primary key,
  cantidad text not null
);

-- RLS + política de lectura para el rol en TODAS las tablas de analytics y analytics_control (A1, segunda revisión).
alter table analytics.jugadores              enable row level security;
alter table analytics.cubos                  enable row level security;
alter table analytics.eventos                enable row level security;
alter table analytics.participaciones        enable row level security;
alter table analytics.enfrentamientos        enable row level security;
alter table analytics.partidas               enable row level security;
alter table analytics_control.refresco           enable row level security;
alter table analytics_control.verificacion       enable row level security;
alter table analytics_control.registro_limpieza  enable row level security;

drop policy if exists reader_select on analytics.jugadores;
create policy reader_select on analytics.jugadores       for select to analytics_reader using (true);
drop policy if exists reader_select on analytics.cubos;
create policy reader_select on analytics.cubos           for select to analytics_reader using (true);
drop policy if exists reader_select on analytics.eventos;
create policy reader_select on analytics.eventos         for select to analytics_reader using (true);
drop policy if exists reader_select on analytics.participaciones;
create policy reader_select on analytics.participaciones for select to analytics_reader using (true);
drop policy if exists reader_select on analytics.enfrentamientos;
create policy reader_select on analytics.enfrentamientos for select to analytics_reader using (true);
drop policy if exists reader_select on analytics.partidas;
create policy reader_select on analytics.partidas        for select to analytics_reader using (true);
drop policy if exists reader_select on analytics_control.refresco;
create policy reader_select on analytics_control.refresco          for select to analytics_reader using (true);
drop policy if exists reader_select on analytics_control.verificacion;
create policy reader_select on analytics_control.verificacion      for select to analytics_reader using (true);
drop policy if exists reader_select on analytics_control.registro_limpieza;
create policy reader_select on analytics_control.registro_limpieza for select to analytics_reader using (true);

-- Al cambiar la exclusión voluntaria (alta, baja, cambio o TRUNCATE), lo publicado deja de ser vigente hasta el próximo refresco (A3).
-- (Trigger sobre una tabla PRIVADA de analytics; no hay triggers sobre public.users ni public.cubes.)
create or replace function analytics_private.tg_optout_invalida()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, analytics_private, pg_temp
as $$
begin
  update analytics_control.refresco set vigente = false;
  return null;
end $$;

drop trigger if exists optout_invalida on analytics_private.player_optout;
create trigger optout_invalida after insert or update or delete on analytics_private.player_optout
  for each statement execute function analytics_private.tg_optout_invalida();
drop trigger if exists optout_invalida_truncate on analytics_private.player_optout;
create trigger optout_invalida_truncate before truncate on analytics_private.player_optout
  for each statement execute function analytics_private.tg_optout_invalida();

-- 7.4 Anomalías (conteos EXACTOS, internos), calculadas con la exclusión aplicada.
create or replace view analytics_private.v_anomalias_calc with (security_invoker = false) as
select 'usuarios_sin_alias_en_eventos_validos'::text as chequeo,
       (select count(distinct ep.user_id) from public.event_participants ep
         join analytics_private.v_eventos_validos ev on ev.event_id = ep.event_id
        where not exists (select 1 from analytics_private.player_alias a where a.user_id = ep.user_id)
          and not exists (select 1 from analytics_private.player_optout o where o.user_id = ep.user_id))::bigint as cantidad
union all
select 'eventos_con_cubo_sin_alias',
       (select count(*) from analytics_private.v_eventos_validos ev
         where ev.cube_id is not null and not exists (select 1 from analytics_private.cube_alias c where c.cube_id = ev.cube_id))
union all
select 'partidas_ended_le_started',
       (select count(*) from public.matches m
         join analytics_private.v_pairings_ok po on po.pairing_id = m.pairing_id
        where m.status = 'completed' and m.is_walkover is not true and m.ended_at is not null and m.ended_at <= m.started_at)
union all
select 'partidas_sin_ended_at',
       (select count(*) from public.matches m
         join analytics_private.v_pairings_ok po on po.pairing_id = m.pairing_id
        where m.status = 'completed' and m.is_walkover is not true and m.ended_at is null)
union all
select 'partidas_duracion_fuera_de_rango',
       (select count(*) from public.matches m
         join analytics_private.v_pairings_ok po on po.pairing_id = m.pairing_id
         cross join analytics_private.v_cfg cfg
        where m.status = 'completed' and m.is_walkover is not true and m.ended_at > m.started_at
          and (extract(epoch from (m.ended_at - m.started_at)) / 60.0 < cfg.min_partida_min
            or extract(epoch from (m.ended_at - m.started_at)) / 60.0 > cfg.max_partida_min))
union all
select 'partidas_ganador_ajeno_al_cruce',
       (select count(*) from public.matches m
         join public.pairings p on p.id = m.pairing_id
         join analytics_private.v_pairings_ok po on po.pairing_id = m.pairing_id
        where m.status = 'completed' and m.winner_participant_id is not null
          and m.winner_participant_id not in (p.participant_a_id, p.participant_b_id))
union all
select 'partidas_tiebreak_sin_cruce_de_bracket',
       (select count(*) from analytics_private.v_partidas_base g
        where g.tipo = 'tiebreak' and g.dom_enf = 'p' and not g.excluido and not g.es_walkover)
union all
select 'partidas_tiebreak_con_mas_de_un_cruce_candidato',
       (select count(*) from (
          select m.id from public.matches m
          join public.event_tiebreak_bracket_matches bm on bm.pairing_id = m.pairing_id and bm.winner_participant_id is not null
          join public.event_tiebreak_groups etg on etg.id = bm.group_id and etg.status <> all (array['failed', 'superseded'])
               and etg.round_number = coalesce(m.tiebreak_round, 1)
          join analytics_private.v_pairings_ok po on po.pairing_id = m.pairing_id
          where m.match_type = 'tiebreak' and m.status = 'completed'
          group by m.id having count(*) > 1) t)
union all
select 'partidas_sin_dato_de_quien_empieza',
       (select count(*) from analytics_private.v_partidas_base g where not g.excluido and not g.es_walkover and g.alias_empieza is null)
union all
select 'participaciones_player_sin_colores',
       (select count(*) from analytics_private.v_participaciones_base b
         join analytics_private.v_eventos_validos ev on ev.event_id = b.event_id
        where not b.excluido and b.rol = 'player' and ev.data_source = 'app' and b.colores is null)
union all
select 'participaciones_player_con_mas_de_4_colores',
       (select count(*) from analytics_private.v_participaciones_base b where not b.excluido and b.rol = 'player' and length(b.colores) > 4)
union all
-- Mira lo PUBLICADO (analytics.partidas usa puestos): pasa por el mapa player_pos.
select 'participaciones_player_sin_partidas',
       (select count(*) from analytics_private.v_participaciones_base b
         join analytics_private.player_pos pp on pp.alias_n = b.alias_n
        where not b.excluido and b.rol = 'player'
          and not exists (select 1 from analytics.partidas g
                          join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
                          where e.evento_id = b.evento_key and pp.pos in (g.jugador_a, g.jugador_b)))
union all
select 'eventos_sin_partidas',
       (select count(*) from analytics_private.v_eventos_validos ev
         where not exists (select 1 from analytics.partidas g
                           join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
                           where e.evento_id = ev.evento_key))
union all
select 'eventos_duracion_draft_fuera_de_rango',
       (select count(*) from analytics_private.v_eventos_validos ev
         cross join analytics_private.v_cfg cfg
         where ev.draft_started_at is not null and ev.draft_ended_at is not null and ev.data_source = 'app'
           and (ev.draft_ended_at <= ev.draft_started_at
             or extract(epoch from (ev.draft_ended_at - ev.draft_started_at)) / 60.0 < cfg.min_draft_min
             or extract(epoch from (ev.draft_ended_at - ev.draft_started_at)) / 60.0 > cfg.max_draft_min))
union all
select 'eventos_fecha_futura',
       (select count(*) from analytics_private.v_eventos_validos ev
         cross join analytics_private.v_cfg cfg
        where ev.fecha > (now() at time zone cfg.tz)::date)
union all
select 'eventos_duplicados_misma_fecha_y_cubo',
       (select count(*) from (
          select ev.fecha, ev.cube_id from analytics_private.v_eventos_validos ev
          group by ev.fecha, ev.cube_id having count(*) > 1) t)
union all
select 'cruces_con_victoria_y_ganador_ajeno',
       (select count(*) from analytics_private.v_enfrentamientos_base e
        where not e.excluido and e.resultado = 'victoria' and e.alias_ganador is null)
union all
select 'partidas_de_origen_importado',
       (select count(*) from public.matches m
         join public.pairings p on p.id = m.pairing_id
         join analytics_private.v_pairings_ok po on po.pairing_id = m.pairing_id
         join analytics_private.v_eventos_validos ev on ev.event_id = p.event_id
        where m.data_source <> 'app' or ev.data_source <> 'app')
-- lo que NO se publica, solo como cantidades
union all
select 'enfrentamientos_walkover_no_publicados',
       (select count(*) from analytics_private.v_enfrentamientos_base e where not e.excluido and e.es_walkover)
union all
select 'partidas_walkover_no_publicadas',
       (select count(*) from analytics_private.v_partidas_base g where not g.excluido and g.es_walkover)
union all
select 'partidas_de_cruce_no_publicado',
       (select count(*) from analytics_private.v_partidas_base g
        where not g.excluido and not g.es_walkover
          and not exists (select 1 from analytics.enfrentamientos e where e.id = g.enf_key))
union all
select 'participaciones_se_fue_no_publicadas',
       (select count(*) from analytics_private.v_participaciones_base b where not b.excluido and b.se_fue);

-- 7.5 Privacidad (conteos EXACTOS de violaciones, internos; todo debe ser 0). Compara lo exportado contra los datos reales DENTRO de la base.
--     Los términos prohibidos excluyen a los usuarios en exclusión voluntaria (su nombre no se usa en ninguna consulta de control).
--     Lo publicado usa PUESTOS: toda comparación contra jugadores/cubos reales pasa por player_pos / cube_pos.
create or replace view analytics_private.v_privacidad_calc with (security_invoker = false) as
with textos as (
  select 'jugadores'::text as vista, regexp_replace(nombre, '^Jugador [0-9]+$', '') as t from analytics.jugadores
  union all select 'cubos', regexp_replace(nombre, '^Cubo [A-Z]+$', '') from analytics.cubos
  union all select 'eventos', regexp_replace(nombre, '^Evento [0-9]+$', '') from analytics.eventos
  union all select 'eventos', concat_ws('|', event_type, estado, competition_format, match_format) from analytics.eventos
  union all select 'participaciones', concat_ws('|', rol, colores) from analytics.participaciones
  union all select 'enfrentamientos', concat_ws('|', fase, etapa, resultado) from analytics.enfrentamientos
  union all select 'partidas', concat_ws('|', tipo, estado) from analytics.partidas
), terminos as (
  select lower(u.display_name) as term from public.users u
   where length(u.display_name) >= 4 and not exists (select 1 from analytics_private.player_optout o where o.user_id = u.id)
  union select lower(u.username) from public.users u
   where length(u.username) >= 4 and not exists (select 1 from analytics_private.player_optout o where o.user_id = u.id)
  union select lower(c.name) from public.cubes c where length(c.name) >= 4
  union select lower(v.name) from public.venues v where length(v.name) >= 4
)
select 'texto_con_uuid'::text as chequeo,
       (select count(*) from textos where t ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::bigint as violaciones
union all
select 'texto_con_arroba', (select count(*) from textos where position('@' in t) > 0)
union all
select 'nombre_real_en_texto_exportado',
       (select count(*) from textos x join terminos k on position(k.term in lower(x.t)) > 0 where x.t <> '')
union all
select 'jugador_excluido_presente',
       (select count(*) from analytics.jugadores j
         join analytics_private.player_pos pp on pp.pos = j.id
         join analytics_private.player_alias a on a.alias_n = pp.alias_n
         join analytics_private.player_optout o on o.user_id = a.user_id)
union all
select 'enfrentamiento_con_jugador_excluido',
       (select count(*) from analytics.enfrentamientos e
         join analytics_private.player_pos pp on pp.pos in (e.jugador_a, e.jugador_b)
         join analytics_private.player_alias a on a.alias_n = pp.alias_n
         join analytics_private.player_optout o on o.user_id = a.user_id)
union all
select 'partida_con_jugador_excluido',
       (select count(*) from analytics.partidas g
         join analytics_private.player_pos pp on pp.pos in (g.jugador_a, g.jugador_b)
         join analytics_private.player_alias a on a.alias_n = pp.alias_n
         join analytics_private.player_optout o on o.user_id = a.user_id)
union all
select 'cubo_de_excluido_publicado',
       ((select count(*) from analytics.cubos c
          join analytics_private.cube_pos cp on cp.pos = c.id
          join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
          join public.cubes pc on pc.id = ca.cube_id
          join analytics_private.player_optout o on o.user_id = pc.created_by)
       + (select count(*) from analytics.eventos e
          join analytics_private.cube_pos cp on cp.pos = e.cubo_id
          join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
          join public.cubes pc on pc.id = ca.cube_id
          join analytics_private.player_optout o on o.user_id = pc.created_by))
union all
select 'ids_jugador_con_huecos',
       (select count(*) from generate_series(1, (select count(*) from analytics.jugadores)::integer) g
         where not exists (select 1 from analytics.jugadores j where j.id = g))
union all
select 'ids_cubo_con_huecos',
       (select count(*) from generate_series(1, (select count(*) from analytics.cubos)::integer) g
         where not exists (select 1 from analytics.cubos c where c.id = g))
union all
select 'alias_duplicado',
       (select count(*) from (select alias_n from analytics_private.player_alias group by alias_n having count(*) > 1) t)
union all
select 'evento_fuera_del_workspace',
       (select count(*) from analytics_private.v_eventos_validos ev
         join public.draft_events de on de.id = ev.event_id
         cross join analytics_private.v_cfg cfg
        where de.workspace_id <> cfg.workspace_id);

-- 7.6 Conciliación (A1/M1): lo PUBLICADO contra las vistas oficiales de la app (0152/0153), por jugador DENTRO de la vista y agregada hacia afuera.
--     Lado curado = analytics.enfrentamientos / analytics.partidas (puestos) pasando por player_pos; lado app = vistas oficiales mapeadas al mismo puesto.
--     Ambos lados excluyen todo cruce/partida donde participe un jugador excluido (en cualquiera de los dos lados).
--     La conciliación compara contra la REGLA DE PUBLICACIÓN, no contra la vista cruda de la app: del lado de la app se excluyen además las partidas de
--     un cruce decidido por walkover (v_partidas_base / v_enfrentamientos_base), porque la publicación no las incluye (contrato.md §1).
--     (v_participant_official_results/_games son security_invoker: se evalúan con los permisos del dueño, que corre el refresco.)
create or replace view analytics_private.v_conciliacion_calc with (security_invoker = false) as
with app_enf as (
  select pp.pos, count(*) as n
  from public.v_participant_official_results r
  join analytics_private.v_eventos_validos ev on ev.event_id = r.event_id
  join analytics_private.player_alias pa on pa.user_id = r.user_id
  join analytics_private.player_pos pp on pp.alias_n = pa.alias_n
  left join public.pairings pq on r.source = 'pairing' and pq.id::text = r.result_id
  left join public.event_tiebreak_bracket_matches bb on r.source = 'bracket' and bb.id::text = r.result_id
  where not exists (select 1 from analytics_private.player_optout o
                    join public.event_participants ex on ex.user_id = o.user_id
                    where ex.id in (coalesce(pq.participant_a_id, bb.participant_a_id), coalesce(pq.participant_b_id, bb.participant_b_id)))
  group by pp.pos
), cur_enf as (
  select s.pos, count(*) as n from (
    select e.evento_id, e.jugador_a as pos from analytics.enfrentamientos e where e.resultado = 'victoria'
    union all
    select e.evento_id, e.jugador_b from analytics.enfrentamientos e where e.resultado = 'victoria'
  ) s
  join analytics.participaciones p on p.evento_id = s.evento_id and p.jugador_id = s.pos and p.rol = 'player'
  group by s.pos
), app_par as (
  select pp.pos, count(*) as n
  from public.v_participant_official_games g
  join analytics_private.v_eventos_validos ev on ev.event_id = g.event_id
  join analytics_private.player_alias pa on pa.user_id = g.user_id
  join analytics_private.player_pos pp on pp.alias_n = pa.alias_n
  join public.matches mm on mm.id::text = g.result_id
  join public.pairings pq on pq.id = mm.pairing_id
  where not exists (select 1 from analytics_private.player_optout o
                    join public.event_participants ex on ex.user_id = o.user_id
                    where ex.id in (pq.participant_a_id, pq.participant_b_id))
  -- >>> PUBLICACIÓN: regla de contrato.md §1, reutilizada de las vistas base (no se duplica a mano). Una partida real de un cruce decidido por
  --     walkover NO se publica porque su cruce no se publica; la vista oficial de la app sí la cuenta, así que se excluye de ESTE lado.
  --     Solo se excluye por walkover: una partida publicable que falte, o cuyo cruce falte por cualquier otro motivo, sigue marcando diferencia.
  and not exists (select 1 from analytics_private.v_partidas_base b
                  join analytics_private.v_enfrentamientos_base cz on cz.enf_key = b.enf_key
                  where b.match_id = mm.id and cz.es_walkover)
  -- <<< PUBLICACIÓN
  group by pp.pos
), cur_par as (
  select s.pos, count(*) as n from (
    select e.evento_id, g.jugador_a as pos from analytics.partidas g join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
    union all
    select e.evento_id, g.jugador_b from analytics.partidas g join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
  ) s
  join analytics.participaciones p on p.evento_id = s.evento_id and p.jugador_id = s.pos and p.rol = 'player'
  group by s.pos
), por_jugador as (
  select 'enfrentamientos'::text as metrica, coalesce(a.pos, c.pos) as pos,
         coalesce(a.n, 0) as valor_app, coalesce(c.n, 0) as valor_curado
  from app_enf a full join cur_enf c on c.pos = a.pos
  union all
  select 'partidas', coalesce(a.pos, c.pos), coalesce(a.n, 0), coalesce(c.n, 0)
  from app_par a full join cur_par c on c.pos = a.pos
)
select p.metrica,
       sum(p.valor_app)::bigint as total_app,
       sum(p.valor_curado)::bigint as total_curado,
       (count(*) filter (where p.valor_app <> p.valor_curado))::bigint as jugadores_con_diferencia
from por_jugador p
group by p.metrica;

-- ============================================================================================================================
-- 8. REFRESCO: ÚNICA forma de escribir las tablas analytics y analytics_control. SECURITY DEFINER, dueño postgres, search_path fijo.
--    Nadie más puede ejecutarlo (ver permisos). Es una sola transacción: el rol de lectura ve el estado anterior o el nuevo, nunca uno a medias.
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

  -- Mapas de puestos 1..n, DESPUÉS de aplicar la exclusión, ordenados por el alias aleatorio privado (sin huecos).
  insert into analytics_private.player_pos (alias_n, pos)
  select s.alias_n, (row_number() over (order by s.alias_n))::integer
  from (select distinct b.alias_n from analytics_private.v_participaciones_base b where not b.excluido) s;

  insert into analytics_private.cube_pos (alias_n, pos)
  select s.alias_n, (row_number() over (order by s.alias_n))::integer
  from (select distinct ca.alias_n
          from analytics_private.cube_alias ca
          join analytics_private.v_cubos_visibles cv on cv.cube_id = ca.cube_id
          join analytics_private.v_eventos_validos ev on ev.cube_id = ca.cube_id) s;

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

-- ============================================================================================================================
-- 9. COMENTARIOS
-- ============================================================================================================================
comment on schema analytics is 'Tablas curadas y anonimizadas para el sitio público (rellenadas por analytics_private.refresh_analytics). Contrato en docs-analytics/contrato.md.';
comment on schema analytics_private is 'PRIVADO: mapas de alias y puestos, exclusión voluntaria, claves de ids, vistas base y controles exactos. Sin acceso para nadie salvo el dueño.';
comment on schema analytics_control is 'Estado del refresco, verificación (pasa/no pasa) y registro de limpieza (con "<5"), sin detalle por jugador, para las pruebas previas a publicar.';

-- ============================================================================================================================
-- 10. PERMISOS
-- ============================================================================================================================

-- 10.1 Nadie entra a los esquemas nuevos salvo el dueño (y el rol de lectura en analytics y analytics_control).
revoke all on schema analytics_private from public, anon, authenticated, service_role, analytics_reader;
revoke all on schema analytics         from public, anon, authenticated, service_role;
revoke all on schema analytics_control from public, anon, authenticated, service_role;

-- 10.2 REVOKE explícito sobre los objetos (R1: los privilegios por defecto globales de Supabase pueden haberse aplicado al crearlos).
--      REGLA: toda migración futura que cree un objeto en estos esquemas debe repetir un REVOKE explícito sobre ese objeto en su propio
--      bloque (los privilegios por defecto globales no se pueden anular desde acá) y correr P-PRIV-01 después.
revoke all on all tables    in schema analytics_private from public, anon, authenticated, service_role, analytics_reader;
revoke all on all tables    in schema analytics         from public, anon, authenticated, service_role, analytics_reader;
revoke all on all tables    in schema analytics_control from public, anon, authenticated, service_role, analytics_reader;
revoke all on all sequences in schema analytics_private from public, anon, authenticated, service_role, analytics_reader;
revoke all on all sequences in schema analytics         from public, anon, authenticated, service_role, analytics_reader;
revoke all on all sequences in schema analytics_control from public, anon, authenticated, service_role, analytics_reader;
revoke all on all functions in schema analytics_private from public, anon, authenticated, service_role, analytics_reader;
revoke all on all functions in schema analytics         from public, anon, authenticated, service_role, analytics_reader;
revoke all on all functions in schema analytics_control from public, anon, authenticated, service_role, analytics_reader;

-- 10.3 Privilegios por defecto (L6) sobre objetos FUTUROS de los tres esquemas.
--      LÍMITE: ALTER DEFAULT PRIVILEGES ... IN SCHEMA solo revoca lo que se hubiera otorgado por defecto A NIVEL DE ESQUEMA; no anula los
--      defaults globales de Supabase ni el EXECUTE para PUBLIC que Postgres da a toda función nueva. PGlite no sirve como evidencia de esto
--      (corre como superusuario). La evidencia es P-PRIV-01 en la base viva, precedido de "select * from pg_default_acl" (contrato.md §10.4).
alter default privileges in schema analytics_private revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges in schema analytics_private revoke all on functions from public, anon, authenticated, service_role;
alter default privileges in schema analytics_private revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema analytics         revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges in schema analytics         revoke all on functions from public, anon, authenticated, service_role;
alter default privileges in schema analytics         revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema analytics_control revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges in schema analytics_control revoke all on functions from public, anon, authenticated, service_role;
alter default privileges in schema analytics_control revoke all on sequences from public, anon, authenticated, service_role;

-- 10.4 Lo ÚNICO que puede hacer el rol: conectarse, usar los dos esquemas y leer estas tablas (con la política de RLS de cada una). NO
--      ejecuta ninguna función propia (ni refresh_analytics ni nada de analytics_private; no tiene USAGE sobre analytics_private) y no lee
--      los controles exactos.
do $$ begin execute format('grant connect on database %I to analytics_reader', current_database()); end $$;
grant usage on schema analytics, analytics_control to analytics_reader;
grant select on analytics.jugadores, analytics.cubos, analytics.eventos, analytics.participaciones,
                analytics.enfrentamientos, analytics.partidas to analytics_reader;
grant select on analytics_control.refresco, analytics_control.verificacion, analytics_control.registro_limpieza to analytics_reader;

-- 10.5 Configuración del rol: tiempos acotados, search_path al esquema analytics.
--     (La barrera real de "solo lectura" es que el rol no tiene ningún privilegio de escritura ni es dueño de nada;
--      default_transaction_read_only y los timeouts son un cinturón extra: el rol PUEDE cambiarlos con SET. Ver contrato.md §10.6.)
alter role analytics_reader set search_path = analytics;
alter role analytics_reader set default_transaction_read_only = on;
alter role analytics_reader set statement_timeout = '60s';
alter role analytics_reader set lock_timeout = '5s';
alter role analytics_reader set idle_in_transaction_session_timeout = '30s';
alter role analytics_reader connection limit 2;

-- 10.6 RIESGO ACEPTADO (evaluado, no mitigado en SQL): el rol puede crear objetos temporales (TEMP lo tiene PUBLIC; un REVOKE por rol no
--     sirve y revocárselo a PUBLIC afecta a los demás roles) y puede cambiar sus propios SET. Una credencial filtrada puede llenar el disco con tablas
--     temporales. Mitigaciones operativas (contraseña larga, Environment protegido de GitHub, transacción de extracción REPEATABLE READ READ ONLY,
--     job de pg_cron que cierra sesiones largas): contrato.md §10.6 y bloque 13.
-- 10.7 NO HECHO (evaluado): "alter default privileges for role postgres in schema public revoke execute on functions from public" cambia el
--     comportamiento de public para todas las migraciones futuras; se deja como decisión aparte (calidad.md P-PRIV-06 lo vigila).

-- ============================================================================================================================
-- 11. PRIMER REFRESCO (llena las tablas al aplicar la migración)
-- ============================================================================================================================
select analytics_private.refresh_analytics();

commit;

-- ============================================================================================================================
-- 12. VERIFICACIÓN POSTERIOR (solo lectura; correr después de aplicar y después de CADA migración futura, como administrador)
-- ============================================================================================================================
-- (0) ANTES de aplicar (paso previo documentado, contrato.md §10.4): revisar los privilegios por defecto vigentes.
--       select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;
-- (a) El rol no debe poder ejecutar nada propio. Esperado: false, false.
--     Sobre extensions.hmac: la migración NO le otorga EXECUTE. Si da true es por la concesión a PUBLIC de pgcrypto (inofensivo: sin la clave
--     no se puede reproducir ningún id; la clave no es legible por el rol). Anotar el valor observado.
-- select has_function_privilege('analytics_reader', 'analytics_private.refresh_analytics()', 'EXECUTE') as ejecuta_refresh,
--        has_schema_privilege('analytics_reader', 'analytics_private', 'USAGE') as usa_privado,
--        has_function_privilege('analytics_reader', 'extensions.hmac(text,text,text)', 'EXECUTE') as ejecuta_hmac;
-- (b) Estado del refresco: select * from analytics_control.refresco;   -- vigente = true y refrescado_en reciente
-- (c) Realtime: ningún objeto nuevo en publicaciones (esperado: 0 filas y 0 publicaciones FOR ALL TABLES):
-- select * from pg_publication_tables where schemaname in ('analytics', 'analytics_private', 'analytics_control');
-- select pubname from pg_publication where puballtables;
-- (d) API: verificar A MANO en el panel de Supabase (Settings → API → Exposed schemas / db_schemas) que NO figuren analytics, analytics_private
--     ni analytics_control. La consulta de apoyo (calidad.md P-PRIV-16) solo ve la configuración del rol authenticator.
-- (e) Correr P-PRIV-01 a P-PRIV-16 de calidad.md.
--
-- ============================================================================================================================
-- 13. AGENDAR EL REFRESCO Y LA LIMPIEZA DE SESIONES (PASO ADMINISTRATIVO; NO forma parte de la migración)
-- ============================================================================================================================
--   NOTA: en producción los dos jobs YA se agendaron a mano: 'analytics_refresh' (job id 1, 30 8 * * *) y 'analytics_cerrar_sesiones'
--   (job id 2, */5 * * * *). Los comandos exactos están en la cabecera y en docs-analytics/operacion.md. No ejecutar nada de este bloque
--   al re-aplicar en producción; quedan comentados a propósito. (La opción A de abajo es la propuesta original: allí el segundo job se
--   llamaba 'analytics_reader_limpieza' y corría cada minuto; en producción es 'analytics_cerrar_sesiones' cada 5 minutos.)
--   Las migraciones del repo no usan pg_cron (solo hay una mención en un comentario de 0001) y no pude comprobar si está habilitada en la
--   base viva: es una extensión que se habilita desde el panel de Supabase (Database → Extensions). Opciones:
--   A) pg_cron (recomendada, si está disponible), unos minutos ANTES de la extracción del pipeline. pg_cron usa hora UTC.
--        create extension if not exists pg_cron;
--        select cron.schedule('analytics_refresh', '30 8 * * *', $$select analytics_private.refresh_analytics()$$);   -- 08:30 UTC = 05:30 Buenos Aires
--      Segundo trabajo: cierra las sesiones de analytics_reader con más de 5 minutos (mitigación del riesgo aceptado, contrato.md §10.6; la
--      extracción lee todo en UNA transacción corta y debe terminar antes de ese límite):
--        select cron.schedule('analytics_reader_limpieza', '* * * * *',
--          $$select pg_terminate_backend(pid) from pg_stat_activity where usename = 'analytics_reader' and backend_start < now() - interval '5 minutes'$$);
--      Los trabajos corren con el usuario que los agenda (postgres), dueño de la función. Ver trabajos: select * from cron.job;
--      Ver corridas: select * from cron.job_run_details order by start_time desc limit 5;
--   B) Sin pg_cron: paso administrativo manual antes de cada extracción, desde el SQL Editor: select analytics_private.refresh_analytics();
--      y, para las sesiones largas, revisión manual de pg_stat_activity (usename = 'analytics_reader').
--   En ambos casos el pipeline NO ejecuta el refresco: solo comprueba analytics_control.refresco (vigente = true y refrescado_en dentro de
--   la ventana definida en calidad.md, P-FRE-01) y se detiene si no se cumple. Tras cada alta, baja o TRUNCATE en
--   analytics_private.player_optout el estado queda "no vigente" automáticamente: correr el refresco a mano Y volver a ejecutar la publicación.
--   Lo publicado ANTES de esa exclusión sigue en snapshots y cachés externas (contrato.md §8).

-- ============================================================================================================================
-- ROLLBACK -- NO CORRER. Solo documenta cómo deshacer. Ejecutar únicamente con revisión manual.
-- Ojo: borrar analytics_private destruye el mapa de alias y las claves de ids: los ids de eventos, enfrentamientos y partidas
-- cambiarían en una reaplicación. Hacer un respaldo de analytics_private.player_alias, cube_alias, player_optout y secret ANTES.
-- ============================================================================================================================
-- NO CORRER:
-- begin;
-- revoke execute on function extensions.hmac(text, text, text) from analytics_reader;   -- primero: un rol con privilegios no se puede borrar
-- drop schema if exists analytics_control cascade;
-- drop schema if exists analytics cascade;
-- drop schema if exists analytics_private cascade;
-- revoke connect on database postgres from analytics_reader;   -- usar el nombre real de la base
-- drop role if exists analytics_reader;
-- commit;
-- (Si se agendó pg_cron:  select cron.unschedule('analytics_refresh');  select cron.unschedule('analytics_reader_limpieza');  )
