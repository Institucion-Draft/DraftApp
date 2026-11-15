-- 0161_cumpleanos_fuente_birth_date.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
-- FASE A de la unificación de cumpleaños: users.birth_date pasa a ser la única fuente. Solo base de datos; el cliente no cambia.
--
-- QUÉ HACE
--   1. RESPALDO: tabla admin_private.users_birthday_backup_0161 (user_id, birthday, birth_date, backed_up_at) con TODOS los usuarios, tomada
--      dentro de la migración y SIN pisar un respaldo previo si se re-corre (solo inserta si la tabla está vacía). Esquema privado
--      (create schema if not exists admin_private; sin acceso para public, anon ni authenticated; la tabla con RLS y sin políticas). Para que
--      siga sin exponerse por la API, admin_private NO debe figurar en Settings > API > Exposed schemas (verificarlo a mano).
--   2. DATOS: donde birth_date es NULL y birthday no, se copia birthday a birth_date. Donde ambas existen NO se toca nada (aunque difieran).
--      Idempotente. Un bloque de verificación FALLA (y deshace todo) si después de migrar queda algún usuario con birthday y sin birth_date.
--      Nota: el UPDATE también mueve users.updated_at de esas filas (trigger trg_users_updated_at).
--   3. LÓGICA (único cambio): public.shiny_chance_for(user, fecha_evento, día_inscripción) lee users.birth_date en vez de users.birthday.
--      is_birthday, birthday_within_days y shiny_chance_for_birthday NO cambian. shiny_chance_for es SECURITY INVOKER y authenticated no tiene
--      SELECT sobre birth_date: dejaría de funcionar si la llamara un cliente (y si fuera DEFINER permitiría averiguar cumpleaños ajenos
--      probando fechas). Se le REVOCA EXECUTE a public/anon/authenticated; assign_rotated_avatar (SECURITY DEFINER) la sigue usando como dueño.
--      Efecto a tener en cuenta: las cuentas con SOLO birth_date (hoy 4, tuyas) pasan a tener chance de shiny de cumpleaños, que antes no tenían.
--   4. FUNCIÓN NUEVA public.birthday_user_ids_today() -> setof uuid (SECURITY DEFINER, search_path fijo, STABLE): solo los ids de usuarios
--      VISIBLES para quien llama (my_visible_user_ids()) cuyo cumpleaños (día y mes de birth_date) es HOY en America/Argentina/Buenos_Aires,
--      con is_birthday(birth_date, <fecha de Buenos Aires pasada explícitamente>). Nunca devuelve la fecha. Permisos: revoke de public y anon,
--      grant solo a authenticated (patrón de la 0151). 29/02: igual que is_birthday: en años no bisiestos cuenta el 28/02 (y no el 1/03); en
--      bisiestos, solo el 29/02. Auxiliar INTERNA public.birthday_user_ids_on(p_day date) (la usa la anterior y las pruebas): SIN ningún
--      permiso para clientes (con una fecha arbitraria permitiría averiguar cumpleaños probando días).
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   shiny_chance_for   baa78dfb226ab88e8ae756986294a39b  (148 caracteres con LF; con CRLF: 18638b1c66b5d747bded9a31ffdff6f9, 154)  [0146]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname = 'shiny_chance_for';
--   (si el md5 vivo no coincide con ninguno de los dos, la base tiene un cuerpo distinto del de la 0146: NO aplicar sin revisar la diferencia).
--
-- ANTES DE APLICAR (solo lectura, en producción)
--   a) my_visible_user_ids() debe existir (la usa la política users_select_related, 0150; su definición NO está en las migraciones del repo):
--        select pg_get_function_result(oid), prosecdef from pg_proc where proname = 'my_visible_user_ids';     -- debe devolver un conjunto de uuid
--   b) Funciones/vistas/políticas que mencionan birthday o birth_date (por si hay definiciones que no están en el repo):
--        select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~* 'birth(day|_date)' order by 1, 2;
--        select schemaname, viewname from pg_views where definition ~* 'birth(day|_date)' and schemaname not in ('pg_catalog', 'information_schema');
--        select schemaname, tablename, policyname from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~* 'birth(day|_date)';
--   c) Estado actual:  select count(*) filter (where birthday is not null and birth_date is null) as a_copiar,
--                             count(*) filter (where birthday is not null and birth_date is not null and (extract(month from birthday), extract(day from birthday)) is distinct from (extract(month from birth_date), extract(day from birth_date))) as conflictos
--                      from public.users;          -- hoy: 7 a copiar y 0 conflictos
--
-- CÓMO APLICARLA (a mano, SQL Editor)
--   1. Correr los pasos "ANTES DE APLICAR" y anotar el resultado.
--   2. Correr ESTE archivo completo (una sola transacción).
--   3. Verificar (abajo).
--
-- VERIFICACIÓN POSTERIOR (como postgres)
--   select count(*) from admin_private.users_birthday_backup_0161;                          -- = cantidad de usuarios
--   select count(*) filter (where birthday is not null and birth_date is null) from public.users;   -- 0
--   select count(*) filter (where birth_date is not null) from public.users;                -- antes 6 (2 con ambas + 4 solo birth_date) + 7 copiados = 13
--   select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'shiny_chance_for';   -- distinto del de arriba
--   select has_function_privilege('authenticated', 'public.birthday_user_ids_today()', 'execute') as hoy_auth,       -- true
--          has_function_privilege('anon', 'public.birthday_user_ids_today()', 'execute') as hoy_anon,               -- false
--          has_function_privilege('authenticated', 'public.birthday_user_ids_on(date)', 'execute') as on_auth,     -- false
--          has_function_privilege('authenticated', 'public.shiny_chance_for(uuid, date, date)', 'execute') as chance_auth;   -- false
--   Como usuario (SQL Editor con un JWT, o desde un cliente): select * from public.birthday_user_ids_today();   -- solo ids de visibles con cumpleaños hoy
--
-- ROLLBACK -- NO CORRER salvo marcha atrás deliberada.
--   1. Volver shiny_chance_for a leer birthday y devolverle el permiso:
--        create or replace function public.shiny_chance_for(p_user_id uuid, p_event_date date, p_ref_day date)
--        returns numeric language sql stable as $$
--          select public.shiny_chance_for_birthday(
--            (select u.birthday from public.users u where u.id = p_user_id),
--            p_event_date,
--            p_ref_day
--          )
--        $$;
--        grant execute on function public.shiny_chance_for(uuid, date, date) to authenticated;
--   2. drop function if exists public.birthday_user_ids_today();
--      drop function if exists public.birthday_user_ids_on(date);
--   3. Restaurar birth_date desde el respaldo (solo las filas que la migración copió; las demás ya coinciden):
--        update public.users u set birth_date = b.birth_date
--        from admin_private.users_birthday_backup_0161 b
--        where b.user_id = u.id and u.birth_date is distinct from b.birth_date;
--      (conservar la tabla de respaldo; borrarla solo cuando ya no haga falta: drop table admin_private.users_birthday_backup_0161;)

begin;
set local lock_timeout = '3s';

-- ============================================================================================================================
-- 1. RESPALDO (esquema privado; no pisa un respaldo previo)
-- ============================================================================================================================
create schema if not exists admin_private;
revoke all on schema admin_private from public, anon, authenticated;

create table if not exists admin_private.users_birthday_backup_0161 (
  user_id     uuid primary key,   -- sin FK a propósito: el respaldo sobrevive al borrado del usuario
  birthday    date,
  birth_date  date,
  backed_up_at timestamptz not null default now()
);
alter table admin_private.users_birthday_backup_0161 enable row level security;   -- sin políticas
revoke all on admin_private.users_birthday_backup_0161 from public, anon, authenticated, service_role;

insert into admin_private.users_birthday_backup_0161 (user_id, birthday, birth_date)
select u.id, u.birthday, u.birth_date
from public.users u
where not exists (select 1 from admin_private.users_birthday_backup_0161);

-- ============================================================================================================================
-- 2. DATOS: birthday -> birth_date solo donde birth_date es NULL
-- ============================================================================================================================
update public.users
set birth_date = birthday
where birth_date is null and birthday is not null;

-- ============================================================================================================================
-- 3. shiny_chance_for lee birth_date (único cambio de lógica; mismo cuerpo que la 0146 salvo la columna)
-- ============================================================================================================================
create or replace function public.shiny_chance_for(p_user_id uuid, p_event_date date, p_ref_day date)
returns numeric
language sql
stable
as $$
  select public.shiny_chance_for_birthday(
    (select u.birth_date from public.users u where u.id = p_user_id),
    p_event_date,
    p_ref_day
  )
$$;

-- Los clientes no la llaman (la usa assign_rotated_avatar, SECURITY DEFINER) y authenticated no tiene SELECT sobre birth_date.
revoke all on function public.shiny_chance_for(uuid, date, date) from public, anon, authenticated;

-- ============================================================================================================================
-- 4. Cumpleaños de HOY de los usuarios visibles (solo ids)
-- ============================================================================================================================
-- Interna: sin permisos para clientes (una fecha arbitraria permitiría averiguar cumpleaños probando días).
create or replace function public.birthday_user_ids_on(p_day date)
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select u.id
  from public.users u
  where u.id in (select v from public.my_visible_user_ids() as t(v))
    and public.is_birthday(u.birth_date, p_day)
$$;

create or replace function public.birthday_user_ids_today()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  -- El día de HOY en Buenos Aires, pasado explícitamente (is_birthday usaría la fecha del servidor, que en UTC ya es el día siguiente desde las 21:00).
  select public.birthday_user_ids_on((now() at time zone 'America/Argentina/Buenos_Aires')::date)
$$;

revoke all on function public.birthday_user_ids_on(date) from public, anon, authenticated;
revoke all on function public.birthday_user_ids_today() from public, anon;
grant execute on function public.birthday_user_ids_today() to authenticated;

-- ============================================================================================================================
-- 5. VERIFICACIÓN (si algo no se cumple, falla y se deshace toda la migración)
-- ============================================================================================================================
do $verify$
begin
  if exists (select 1 from public.users where birthday is not null and birth_date is null) then
    raise exception '0161: quedan usuarios con birthday y sin birth_date después de migrar';
  end if;
  if (select count(*) from admin_private.users_birthday_backup_0161) = 0 and exists (select 1 from public.users) then
    raise exception '0161: el respaldo quedó vacío';
  end if;
  if (select prosrc from pg_proc where oid = 'public.shiny_chance_for(uuid, date, date)'::regprocedure) !~ 'birth_date' then
    raise exception '0161: shiny_chance_for no lee birth_date';
  end if;
  if has_function_privilege('authenticated', 'public.birthday_user_ids_on(date)', 'execute')
     or has_function_privilege('anon', 'public.birthday_user_ids_on(date)', 'execute')
     or has_function_privilege('anon', 'public.birthday_user_ids_today()', 'execute')
     or not has_function_privilege('authenticated', 'public.birthday_user_ids_today()', 'execute')
     or has_function_privilege('authenticated', 'public.shiny_chance_for(uuid, date, date)', 'execute') then
    raise exception '0161: permisos de funciones incorrectos';
  end if;
  if has_table_privilege('authenticated', 'admin_private.users_birthday_backup_0161', 'select')
     or has_table_privilege('anon', 'admin_private.users_birthday_backup_0161', 'select') then
    raise exception '0161: el respaldo es legible por anon/authenticated';
  end if;
end;
$verify$;

commit;
