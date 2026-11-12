# Operación de la capa de analytics

Estado: **EN PRODUCCIÓN**. Qué es y por qué: [`contrato.md`](contrato.md). Pruebas: [`calidad.md`](calidad.md). Migración: [`0155_analytics.sql`](../supabase/migrations/0155_analytics.sql).
Este documento recoge lo que se hizo a mano y cómo se opera. **No contiene contraseñas, hosts ni referencias de proyecto, y no deben agregarse.**

## a) Estado en producción

- La migración `0155_analytics.sql` se aplicó **a mano desde el SQL Editor el 2026-11-11**, junto con el parche de conciliación (`0155b_parche_conciliacion.sql`, ya incluido en el archivo final). **No se re-aplica en producción.**
- `pg_cron` está habilitado desde el panel (Database > Extensions).
- **Verificación MANUAL en el panel:** Data API > Exposed schemas debe listar **solo `public` y `graphql_public`**. Si aparece cualquier `analytics*`, está mal: quitarlo de inmediato.

## b) Tareas de pg_cron (agendadas a mano)

Las dos corren como `postgres`. Hora UTC.

```sql
-- jobid 1: refresca las tablas publicadas (08:30 UTC = 05:30 Buenos Aires)
select cron.schedule('analytics_refresh', '30 8 * * *', $$select analytics_private.refresh_analytics()$$);

-- jobid 2: cierra sesiones de analytics_reader con más de 5 minutos
select cron.schedule('analytics_cerrar_sesiones', '*/5 * * * *', $$select pg_terminate_backend(pid) from pg_stat_activity where usename = 'analytics_reader' and backend_start < now() - interval '5 minutes'$$);
```

- `postgres` puede cerrar sesiones de otros roles: verificado con `pg_has_role('postgres','pg_signal_backend','member') = true`.
- La extracción debe leer todo en **una transacción corta** y terminar antes de esos 5 minutos.
- Listar los jobs:

```sql
select jobid, jobname, schedule, active from cron.job where jobname like 'analytics%' order by jobid;
```

- Últimas corridas: `select * from cron.job_run_details order by start_time desc limit 5;`

## c) Rol `analytics_reader`

Atributos esperados: puede loguear, `connection limit 2`, no superuser, sin bypassrls, noinherit, y esta configuración: `search_path=analytics`, `default_transaction_read_only=on`, `statement_timeout=60s`, `lock_timeout=5s`, `idle_in_transaction_session_timeout=30s`.

```sql
select r.rolname, r.rolcanlogin, r.rolconnlimit, r.rolsuper, r.rolbypassrls, r.rolinherit,
       (select array_agg(c order by c) from pg_db_role_setting s, unnest(s.setconfig) c where s.setrole = r.oid) as config
from pg_roles r where r.rolname = 'analytics_reader';
```

**Contraseña:** nunca en el repo ni en chat. Se pone desde el panel (Database > Roles > menú de la fila > Reset password) y vive solo en el secreto `ANALYTICS_READER_PASSWORD` del Environment `datos` de GitHub del repo `DraftApp-analytics` (restringido a `main`).

**Rotación:**
1. Generar la contraseña nueva en el portapapeles, sin mostrarla.
2. Actualizar el secreto `ANALYTICS_READER_PASSWORD` en GitHub.
3. Resetearla en el panel con la misma.
4. Correr el workflow **"Probar conexión a los datos"** y comprobar que pasa.

## d) Conexión

Session pooler, puerto `5432`, base `postgres`, usuario con formato `analytics_reader.<ref-del-proyecto>`. El host y el usuario son variables del Environment `datos` (`ANALYTICS_DB_HOST`, `ANALYTICS_DB_USER`). No se escriben aquí.

## e) Verificaciones posteriores a cada migración de analytics

**1. Privilegios y RLS** de cada tabla/vista de los esquemas `analytics*`:

```sql
select n.nspname, c.relname, c.relkind, c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'select')                                   as anon_lee,
       has_table_privilege('authenticated', c.oid, 'select')                          as authenticated_lee,
       has_table_privilege('analytics_reader', c.oid, 'select')                       as lector_lee,
       has_table_privilege('analytics_reader', c.oid, 'insert,update,delete,truncate') as lector_escribe
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('analytics', 'analytics_control', 'analytics_private') and c.relkind in ('r', 'v', 'm', 'p')
order by 1, 2;
```

Esperado:
- `anon_lee` y `authenticated_lee` = `false` en todas las filas.
- `lector_lee` = `true` **solo** en las 6 tablas de `analytics` y las 3 de `analytics_control` (`refresco`, `verificacion`, `registro_limpieza`); `false` en todo `analytics_private`.
- `lector_escribe` = `false` en todas.
- `rls` = `true` en las tablas (las vistas muestran `false`, es normal).

**2. Verificación:** todo en `true`.

```sql
select * from analytics_control.verificacion order by chequeo;   -- ninguna fila con ok = false
```

**3. Refresco vigente:**

```sql
select * from analytics_control.refresco;   -- vigente = true y refrescado_en reciente
```

## f) Operación

**Refrescar a mano** (SQL Editor, como `postgres`):

```sql
select analytics_private.refresh_analytics();
```

**Excluir a un jugador:**
1. Insertar su `user_id` en `analytics_private.player_optout`. El refresco queda "no vigente" (`vigente = false`) automáticamente.
2. Correr el refresco a mano.
3. **Volver a publicar el sitio.**

Lo ya publicado antes queda en cachés y snapshots externos y no se puede retirar desde la base. Tras cualquier refresco, **los números de jugador pueden cambiar**. **Las letras de cubo (A, B, C…) son estables** desde la migración 0156: cada cubo conserva su letra y solo se corren si un cubo anterior deja de publicarse (borrado, sin uso o con el creador excluido; si vuelve, recupera su lugar).

**Si el sitio no se actualiza**, revisar en este orden:
1. El workflow en el repo `DraftApp-analytics` (última corrida y su error).
2. `analytics_control.verificacion`: una fila con `ok = false` bloquea la publicación.
3. La antigüedad de `analytics_control.refresco.refrescado_en` y que `vigente` sea `true` (¿corrió el job 1? ver `cron.job_run_details`).
4. Los workflows programados de GitHub **se desactivan tras 60 días sin actividad** en el repo: reactivarlo desde la pestaña Actions.

## g) Chequeo de conciliación

`analytics_private.v_conciliacion_calc` compara, por jugador, lo publicado contra las vistas oficiales de la app (`v_participant_official_results` y `v_participant_official_games`, migraciones 0152/0153), con la exclusión voluntaria aplicada en ambos lados. Hacia afuera solo salen los resultados `conciliacion:enfrentamientos` y `conciliacion:partidas` en `analytics_control.verificacion`.

`conciliacion:partidas` puede dar `false` por esto: la vista de la app cuenta partidas reales de series que terminaron en walkover, y la publicación las excluye por contrato (el cruce no se publica). `v_conciliacion_calc` aplica esa misma regla (parche 0155b, ya incluido en la migración).

Si vuelve a dar `false` con **otra causa**, es una anomalía real a investigar. Dónde mirar:

```sql
select * from analytics_control.registro_limpieza order by concepto;   -- qué se descartó o quedó en NULL ("<5" si son pocos)
```

Y como `postgres` (no lo lee el rol), el detalle exacto: `select * from analytics_private.control_conciliacion;`.

## h) Letras de cubo estables (migración 0156)

El orden permanente vive en `analytics_private.cube_orden` (privada, con RLS, sin acceso para el rol ni para `anon`/`authenticated`). Un cubo se registra la primera vez que se publica; los que entran juntos se mezclan al azar entre sí y quedan después de los ya registrados. Las filas nunca se borran.

Aplicación en producción (a mano, SQL Editor; pasos completos en la cabecera de `0156_cubos_letras_estables.sql`): fuera de la ventana del cron (08:30 UTC), anotar el mapa (Consulta A), correr el archivo, comprobar la siembra (Consulta B), refrescar a mano, repetir la Consulta A y correr la Consulta C.

```sql
-- A) mapa de cubos (solo administrador; muestra nombres reales): antes y después deben coincidir
select cp.pos, analytics_private.letras(cp.pos) as letra, c.name
from analytics_private.cube_pos cp
join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
join public.cubes c on c.id = ca.cube_id
order by cp.pos;

-- B) la siembra conservó el mapa (0 filas)
select cp.pos, o.orden
from analytics_private.cube_pos cp
join analytics_private.cube_alias ca on ca.alias_n = cp.alias_n
left join analytics_private.cube_orden o on o.cube_id = ca.cube_id
where o.orden is distinct from cp.pos;
```

```sql
-- C) dos refrescos seguidos dejan el mismo mapa (correr todo junto; esperado 0 y 0)
begin;
create temp table _m1 on commit drop as select alias_n, pos from analytics_private.cube_pos;
select analytics_private.refresh_analytics();
select (select count(*) from (select alias_n, pos from _m1 except select alias_n, pos from analytics_private.cube_pos) a) as faltan_o_cambiaron,
       (select count(*) from (select alias_n, pos from analytics_private.cube_pos except select alias_n, pos from _m1) b) as aparecieron_o_cambiaron;
commit;
```

Después de aplicarla, la verificación de §e debe mostrar `analytics_private.cube_orden` con `rls = true` y todas las columnas de acceso en `false`.
