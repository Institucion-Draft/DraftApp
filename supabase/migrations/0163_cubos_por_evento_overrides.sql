-- 0163_cubos_por_evento_overrides.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
-- NO EDITA la 0162 (ya aplicada): la evoluciona.
--
-- COPIAR EL ARCHIVO (PowerShell). El -Encoding UTF8 es obligatorio: sin él las tildes se rompen ("está" -> "estÃ¡") en la función y en los comentarios:
--      Get-Content -Raw -Encoding UTF8 <ruta>\0163_cubos_por_evento_overrides.sql | Set-Clipboard
--
-- QUÉ HACE (cambio de diseño: el evento puede PRENDER o APAGAR cualquier cubo; el nivel global no cambia nunca por eso)
--   1. public.event_cube_exclusions (0162) pasa a public.event_cube_overrides y gana is_enabled boolean not null: el ESTADO PROPIO del evento
--      para ese cubo. Las filas existentes eran exclusiones, así que se convierten a is_enabled = false.
--   2. Elegibilidad efectiva de un cubo en la ruleta de un evento = el estado propio del evento si existe (prendido o apagado, aunque el global
--      diga lo contrario); si no existe, el global en vivo (cubes.is_enabled). La calcula el cliente y la hace valer la guardia del servidor.
--      Prender un cubo en un evento NUNCA toca cubes.is_enabled ni a otros eventos.
--   3. RLS, con el mismo criterio de la 0162: lectura para miembros del workspace del evento; insert, update y delete solo con can_manage_event
--      (organizador del workspace o posta). El insert exige created_by = quien llama. El update solo puede cambiar is_enabled (grant por columna):
--      no se puede reasignar evento, cubo ni autor. Grants mínimos: select, insert, delete y update (is_enabled); nada para anon.
--   4. Guardia de servidor: se REEMPLAZA cube_roulette_spins_guard_enabled() (0162). Rechaza una tirada (result_type = 'cube') solo si el cubo NO es
--      elegible en ESE evento según la regla de arriba. Un cubo apagado en el global pero prendido en el evento puede salir; uno prendido en el
--      global pero apagado en el evento no. Mensajes: "...deshabilitado y no puede salir..." (CUBE_DISABLED, global) o "...deshabilitado en este
--      evento..." (CUBE_DISABLED_IN_EVENT). El trigger se re-crea igual (mismo nombre).
--
-- LO QUE NO CAMBIA
--   * draft_events.cube_id, cube_roulette_spins y todo lo ya jugado: no se tocan filas existentes (salvo convertir las exclusiones de la 0162).
--   * Analytics y letras estables (0156): no se ven afectadas. Ninguna vista ni función de estadísticas mira cubes.is_enabled ni estas tablas.
--   * El nivel global (cubes.is_enabled, 0160) y sus permisos (solo organizador del workspace).
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc) -- el de la 0162, con las tildes correctas:
--   cube_roulette_spins_guard_enabled   346a304d3cc8845fecbed921c54bdef7  (673 caracteres con LF; con CRLF: 4654393338ce4a5a58a6fcfc20c41f2f, 687)  [0162]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname = 'cube_roulette_spins_guard_enabled';
--   La migración lo comprueba sola: si el cuerpo vivo no es el de la 0162 (LF o CRLF) ni ya el de esta migración (re-corrida idempotente),
--   ABORTA sin cambiar nada. En ese caso NO aplicar sin revisar la diferencia.
--
-- ANTES DE APLICAR (solo lectura, en producción)
--   a) La 0162 tiene que estar aplicada:  select to_regclass('public.event_cube_exclusions') as tabla_0162, to_regclass('public.event_cube_overrides') as tabla_0163;
--      -- tabla_0162 con valor y tabla_0163 nula (o al revés si ya se corrió esta migración)
--   b) Pre-check del cuerpo: la consulta de arriba debe dar 346a304d3cc8845fecbed921c54bdef7 o 4654393338ce4a5a58a6fcfc20c41f2f.
--   c) Anotar lo que hay hoy (se convierte a is_enabled = false):  select * from public.event_cube_exclusions;
--
-- CÓMO APLICARLA (a mano, SQL Editor)
--   1. Correr los pasos "ANTES DE APLICAR".  2. Pegar y correr ESTE archivo completo (una sola transacción).  3. Verificar (abajo).
--   4. Recién después publicar el cliente nuevo (eas update): el cliente nuevo lee y escribe event_cube_overrides; sin la tabla falla la ruleta.
--
-- VERIFICACIÓN POSTERIOR (como postgres)
--   select to_regclass('public.event_cube_exclusions') as vieja, to_regclass('public.event_cube_overrides') as nueva;   -- nula, con valor
--   select count(*) as total, count(*) filter (where is_enabled) as prendidos from public.event_cube_overrides;          -- las filas de antes, 0 prendidos
--   select policyname, cmd from pg_policies where tablename = 'event_cube_overrides' order by cmd;                       -- delete, insert, select, update
--   select has_column_privilege('authenticated', 'public.event_cube_overrides', 'is_enabled', 'update') as upd_col,
--          has_column_privilege('authenticated', 'public.event_cube_overrides', 'created_by', 'update') as upd_autor,
--          has_table_privilege('anon', 'public.event_cube_overrides', 'select') as anon_sel;                              -- true, false, false
--   select prosrc ~ 'está deshabilitado' as tilde_ok, md5(prosrc) from pg_proc
--   where pronamespace = 'public'::regnamespace and proname = 'cube_roulette_spins_guard_enabled';                       -- true, distinto de los de arriba
--
-- CLIENTE ANTERIOR (APK o update viejo): no conoce los overrides; sigue mostrando solo lo habilitado en el global. Un cubo apagado en el global
--   pero prendido en un evento no le aparece (no se rompe nada). Un cubo apagado en el evento pero prendido en el global puede sortearlo; la
--   guardia lo rechaza al registrar la tirada con "...deshabilitado en este evento...". Si algún cliente ya publicado leía event_cube_exclusions
--   (la tabla de la 0162, ahora renombrada), esa lectura falla: la ruleta lo ignora (sigue con el global) y la pantalla de cubos del evento
--   muestra error hasta actualizar.
--
-- ROLLBACK -- NO CORRER salvo marcha atrás deliberada (PRIMERO revertir el cliente nuevo: sin la tabla vieja falla la ruleta del cliente de la 0162).
--   Los estados "prendido en el evento" no se pueden representar como exclusión: se pierden. Anotarlos antes:
--        (select event_id, cube_id, is_enabled from public.event_cube_overrides)
--   1. Volver la guardia a la versión de la 0162:
--        create or replace function public.cube_roulette_spins_guard_enabled()
--        returns trigger language plpgsql security definer set search_path = public
--        as $$
--        begin
--          if new.result_type = 'cube' and new.selected_cube_id is not null then
--            if exists (select 1 from public.cubes c where c.id = new.selected_cube_id and c.is_enabled = false) then
--              raise exception 'El cubo está deshabilitado y no puede salir en la ruleta'
--                using errcode = 'P0001', hint = 'CUBE_DISABLED';
--            end if;
--            if exists (select 1 from public.event_cube_exclusions x where x.event_id = new.event_id and x.cube_id = new.selected_cube_id) then
--              raise exception 'El cubo está excluido de este evento y no puede salir en la ruleta'
--                using errcode = 'P0001', hint = 'CUBE_EXCLUDED_FROM_EVENT';
--            end if;
--          end if;
--          return new;
--        end;
--        $$;
--   2. delete from public.event_cube_overrides where is_enabled;
--      drop policy if exists event_cube_overrides_update_manager on public.event_cube_overrides;
--      alter table public.event_cube_overrides drop column is_enabled;
--      alter table public.event_cube_overrides rename to event_cube_exclusions;
--      (y recrear las políticas y los grants de la 0162 sobre la tabla renombrada)

begin;
set local lock_timeout = '3s';

-- Pre-check: el cuerpo vivo de la guardia tiene que ser el de la 0162 (LF o CRLF) o ya el de esta migración.
do $precheck$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'cube_roulette_spins_guard_enabled';
  if v_src is null then
    raise exception '0163: falta public.cube_roulette_spins_guard_enabled() (¿están aplicadas la 0160 y la 0162?)';
  end if;
  if md5(v_src) not in (
       '346a304d3cc8845fecbed921c54bdef7',   -- 0162 con LF
       '4654393338ce4a5a58a6fcfc20c41f2f'    -- 0162 con CRLF
     )
     and position('event_cube_overrides' in v_src) = 0 then
    raise exception '0163: el cuerpo vivo de cube_roulette_spins_guard_enabled() (md5 %) no es el de la 0162: NO aplicar sin revisar la diferencia', md5(v_src);
  end if;
  if to_regclass('public.event_cube_exclusions') is null and to_regclass('public.event_cube_overrides') is null then
    raise exception '0163: no existe public.event_cube_exclusions (¿está aplicada la 0162?)';
  end if;
end;
$precheck$;

-- 1. Tabla: renombrar (si falta) y agregar el estado propio ------------------------------------------------------------------------------
do $rename$
begin
  if to_regclass('public.event_cube_exclusions') is not null and to_regclass('public.event_cube_overrides') is null then
    alter table public.event_cube_exclusions rename to event_cube_overrides;
  end if;
end;
$rename$;

alter table public.event_cube_overrides add column if not exists is_enabled boolean;
-- Las filas de la 0162 eran exclusiones: pasan a "apagado en este evento".
update public.event_cube_overrides set is_enabled = false where is_enabled is null;
alter table public.event_cube_overrides alter column is_enabled set not null;

comment on table public.event_cube_overrides is
  'Estado PROPIO de un cubo en UN evento (0163): is_enabled = true lo prende y false lo apaga, sea cual sea el global. Sin fila hereda cubes.is_enabled en vivo. Nunca modifica el global.';
comment on column public.event_cube_overrides.is_enabled is
  'Estado propio del cubo en este evento. Elegible en la ruleta = coalesce(este valor, cubes.is_enabled).';

alter index if exists public.idx_event_cube_exclusions_cube rename to idx_event_cube_overrides_cube;
do $idx$
begin
  if exists (select 1 from pg_class where relname = 'event_cube_exclusions_pkey' and relnamespace = 'public'::regnamespace) then
    alter index public.event_cube_exclusions_pkey rename to event_cube_overrides_pkey;
  end if;
end;
$idx$;

-- 2. RLS y permisos ---------------------------------------------------------------------------------------------------------------------
alter table public.event_cube_overrides enable row level security;

drop policy if exists event_cube_exclusions_select_workspace_member on public.event_cube_overrides;
drop policy if exists event_cube_exclusions_insert_manager on public.event_cube_overrides;
drop policy if exists event_cube_exclusions_delete_manager on public.event_cube_overrides;
drop policy if exists event_cube_overrides_select_workspace_member on public.event_cube_overrides;
drop policy if exists event_cube_overrides_insert_manager on public.event_cube_overrides;
drop policy if exists event_cube_overrides_update_manager on public.event_cube_overrides;
drop policy if exists event_cube_overrides_delete_manager on public.event_cube_overrides;

create policy event_cube_overrides_select_workspace_member on public.event_cube_overrides
  as permissive for select to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_cube_overrides.event_id and public.is_workspace_member(de.workspace_id)
  ));

create policy event_cube_overrides_insert_manager on public.event_cube_overrides
  as permissive for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_cube_overrides.event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

create policy event_cube_overrides_update_manager on public.event_cube_overrides
  as permissive for update to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_cube_overrides.event_id and public.can_manage_event(de.workspace_id, de.id)
  ))
  with check (exists (
    select 1 from public.draft_events de
    where de.id = event_cube_overrides.event_id and public.can_manage_event(de.workspace_id, de.id)
  ));

create policy event_cube_overrides_delete_manager on public.event_cube_overrides
  as permissive for delete to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_cube_overrides.event_id and public.can_manage_event(de.workspace_id, de.id)
  ));

-- Supabase da ALL por defecto a las tablas nuevas: se quita todo y se da solo lo mínimo (update únicamente de is_enabled).
revoke all on public.event_cube_overrides from public, anon, authenticated;
grant select, insert, delete on public.event_cube_overrides to authenticated;
grant update (is_enabled) on public.event_cube_overrides to authenticated;

-- 3. Guardia de servidor (reemplaza la de la 0162) ----------------------------------------------------------------------------------------
create or replace function public.cube_roulette_spins_guard_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override boolean;
  v_global boolean;
begin
  if new.result_type = 'cube' and new.selected_cube_id is not null then
    select o.is_enabled into v_override
    from public.event_cube_overrides o
    where o.event_id = new.event_id and o.cube_id = new.selected_cube_id;
    if v_override is false then
      raise exception 'El cubo está deshabilitado en este evento y no puede salir en la ruleta'
        using errcode = 'P0001', hint = 'CUBE_DISABLED_IN_EVENT';
    end if;
    if v_override is null then
      select c.is_enabled into v_global from public.cubes c where c.id = new.selected_cube_id;
      if v_global is false then
        raise exception 'El cubo está deshabilitado y no puede salir en la ruleta'
          using errcode = 'P0001', hint = 'CUBE_DISABLED';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.cube_roulette_spins_guard_enabled() from public, anon, authenticated;

drop trigger if exists cube_roulette_spins_guard_enabled on public.cube_roulette_spins;
create trigger cube_roulette_spins_guard_enabled
  before insert on public.cube_roulette_spins
  for each row execute function public.cube_roulette_spins_guard_enabled();

do $verify$
begin
  if to_regclass('public.event_cube_exclusions') is not null then
    raise exception '0163: sigue existiendo event_cube_exclusions';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.event_cube_overrides'::regclass and relrowsecurity) then
    raise exception '0163: event_cube_overrides sin RLS';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'event_cube_overrides') <> 4 then
    raise exception '0163: faltan políticas de event_cube_overrides (se esperan 4)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'cube_roulette_spins_guard_enabled' and tgrelid = 'public.cube_roulette_spins'::regclass and not tgisinternal) then
    raise exception '0163: falta el trigger cube_roulette_spins_guard_enabled';
  end if;
  if position('event_cube_overrides' in (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'cube_roulette_spins_guard_enabled')) = 0 then
    raise exception '0163: la guardia no quedó actualizada';
  end if;
end;
$verify$;

commit;
