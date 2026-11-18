-- 0162_cubos_por_evento.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
--
-- QUÉ HACE (habilitar/deshabilitar cubos POR EVENTO; el nivel global, cubes.is_enabled de la 0160, no cambia)
--   1. Tabla nueva public.event_cube_exclusions (event_id, cube_id, created_by, created_at; clave primaria (event_id, cube_id)). Una fila = ese
--      cubo queda EXCLUIDO de la ruleta de ESE evento y de ningún otro. Un evento nuevo no tiene filas: lee lo que esté habilitado en el global.
--      FK con ON DELETE CASCADE a draft_events y a cubes: borrar el evento (o el cubo) limpia sus exclusiones. (Los eventos se "borran" con
--      deleted_at, que no dispara el cascade: las filas quedan, inofensivas, igual que cube_roulette_spins.)
--   2. RLS: lectura para cualquier miembro del workspace del evento (mismo criterio que roulette_spins_select_workspace_member); insertar y
--      borrar solo con can_manage_event (organizador del workspace o quien tiene la posta del evento). No hay UPDATE (no hay nada que editar).
--      En el INSERT, created_by tiene que ser quien llama (no se puede firmar como otro). Grants mínimos: select, insert, delete.
--   3. Elegibilidad efectiva de un cubo en la ruleta de un evento = habilitado en el global Y sin fila de exclusión en ese evento. La calcula el
--      cliente (lectura en vivo de cubes.is_enabled y de esta tabla). Un cubo apagado en el global no se puede prender desde un evento: la
--      exclusión por evento solo "resta"; no existe una "inclusión" que pise al global.
--   4. Guardia de servidor: se REEMPLAZA cube_roulette_spins_guard_enabled() (0160). Además de rechazar un cubo deshabilitado en el global,
--      rechaza una tirada (result_type = 'cube') de un cubo excluido en el evento de la tirada ("el cubo está excluido de este evento"). Así
--      un APK viejo, que no conoce las exclusiones, tampoco puede sacar un cubo excluido. El trigger de la 0160 se re-crea igual (mismo nombre).
--
-- LO QUE NO CAMBIA
--   * draft_events.cube_id, cube_roulette_spins y todo lo ya jugado: no se tocan filas existentes. Excluir un cubo NO lo borra ni invalida nada.
--   * Analytics y letras estables (0156): no se ven afectadas. Ni analytics.* ni analytics_private.cube_orden / cube_pos miran is_enabled ni esta
--     tabla (se arman con los cubos usados por los eventos); la tabla nueva no está referenciada por ninguna vista ni función de estadísticas.
--   * public.cubes_with_stats: sin cambios.
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   cube_roulette_spins_guard_enabled   041c85c0262e1efcf08262e7f183f56e  (353 caracteres con LF; con CRLF: 6f2e7465b98a7918eead8c657e0c422d, 363)  [0160]
--   Tercera variante VÁLIDA (la que hay en producción): ad559993f339b45fd564bc8f62396fac  (364 caracteres, CRLF). Es la 0160 aplicada con una
--   codificación errónea: al copiar el archivo sin -Encoding UTF8 la tilde del mensaje quedó como "estÃ¡" en vez de "está". La lógica es idéntica;
--   solo cambia ese texto (1 carácter más). Esta migración la acepta y la reemplaza por el cuerpo correcto en UTF-8.
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname = 'cube_roulette_spins_guard_enabled';
--   La migración lo comprueba sola: si el cuerpo vivo no es el de la 0160 (LF, CRLF o la variante con "estÃ¡") ni ya el de esta migración (re-corrida idempotente),
--   ABORTA sin cambiar nada. En ese caso NO aplicar sin revisar la diferencia.
--
-- ANTES DE APLICAR (solo lectura, en producción)
--   a) La 0160 tiene que estar aplicada:  select count(*) from information_schema.columns where table_name = 'cubes' and column_name = 'is_enabled';   -- 1
--   b) Pre-check del cuerpo:  la consulta de arriba debe dar 041c85c0262e1efcf08262e7f183f56e, 6f2e7465b98a7918eead8c657e0c422d o ad559993f339b45fd564bc8f62396fac.
--   c) can_manage_event debe existir:  select proname from pg_proc where proname in ('can_manage_event', 'is_workspace_member');   -- las dos
--
-- CÓMO APLICARLA (a mano, SQL Editor)
--   COPIAR EL ARCHIVO (PowerShell): el -Encoding UTF8 es obligatorio; sin él las tildes se rompen ("está" -> "estÃ¡") en la función y en los comentarios:
--        Get-Content -Raw -Encoding UTF8 <ruta>\0162_cubos_por_evento.sql | Set-Clipboard
--   1. Correr los pasos "ANTES DE APLICAR".  2. Pegar y correr ESTE archivo completo (una sola transacción).  3. Verificar (abajo).
--   4. Verificar que la tilde quedó bien:  select prosrc ~ 'está excluido' as tilde_ok from pg_proc where proname = 'cube_roulette_spins_guard_enabled';   -- true
--   5. Recién después publicar el cliente nuevo (eas update): el cliente nuevo lee y escribe event_cube_exclusions; sin la tabla falla la ruleta.
--
-- VERIFICACIÓN POSTERIOR (como postgres)
--   select count(*) from public.event_cube_exclusions;                                                    -- 0 (nadie excluyó nada todavía)
--   select policyname, cmd from pg_policies where tablename = 'event_cube_exclusions' order by cmd;      -- select, insert, delete
--   select tgname from pg_trigger where tgrelid = 'public.cube_roulette_spins'::regclass and not tgisinternal;   -- sigue cube_roulette_spins_guard_enabled
--   select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'cube_roulette_spins_guard_enabled';   -- distinto de los dos de arriba
--   select has_table_privilege('authenticated', 'public.event_cube_exclusions', 'insert') as ins,
--          has_table_privilege('anon', 'public.event_cube_exclusions', 'select') as anon_sel;             -- true, false
--   Como Martín (member con la posta) desde un cliente: excluir un cubo del evento anda; como member sin posta, falla por RLS.
--
-- APK VIEJO (cliente anterior): no conoce la tabla, así que sigue mostrando todos los cubos habilitados en el global y puede sortear uno
--   excluido en el evento; la guardia lo rechaza al registrar la tirada ("el cubo está excluido de este evento") y la ruleta le muestra
--   ese error. No rompe nada más. Se corrige al actualizar el cliente.
--
-- ROLLBACK -- NO CORRER salvo marcha atrás deliberada (PRIMERO revertir el cliente nuevo: sin la tabla su carga de la ruleta falla).
--   1. Volver la guardia a la versión de la 0160:
--        create or replace function public.cube_roulette_spins_guard_enabled()
--        returns trigger language plpgsql security definer set search_path = public
--        as $$
--        begin
--          if new.result_type = 'cube'
--             and new.selected_cube_id is not null
--             and exists (select 1 from public.cubes c where c.id = new.selected_cube_id and c.is_enabled = false) then
--            raise exception 'El cubo está deshabilitado y no puede salir en la ruleta'
--              using errcode = 'P0001', hint = 'CUBE_DISABLED';
--          end if;
--          return new;
--        end;
--        $$;
--   2. drop table if exists public.event_cube_exclusions;    -- pierde las exclusiones por evento: anotarlas antes
--        (select event_id, cube_id from public.event_cube_exclusions)

begin;
set local lock_timeout = '3s';

-- Pre-check: el cuerpo vivo de la guardia tiene que ser el de la 0160 (LF o CRLF) o ya el de esta migración.
do $precheck$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'cube_roulette_spins_guard_enabled';
  if v_src is null then
    raise exception '0162: falta public.cube_roulette_spins_guard_enabled() (¿está aplicada la 0160?)';
  end if;
  if md5(v_src) not in (
       '041c85c0262e1efcf08262e7f183f56e',   -- 0160 con LF
       '6f2e7465b98a7918eead8c657e0c422d',   -- 0160 con CRLF
       'ad559993f339b45fd564bc8f62396fac'    -- 0160 con CRLF y la tilde rota ("estÃ¡"): aplicada con codificación errónea, lógica idéntica
     )
     and position('event_cube_exclusions' in v_src) = 0 then
    raise exception '0162: el cuerpo vivo de cube_roulette_spins_guard_enabled() (md5 %) no es el de la 0160: NO aplicar sin revisar la diferencia', md5(v_src);
  end if;
end;
$precheck$;

-- 1. Tabla ------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.event_cube_exclusions (
  event_id   uuid not null references public.draft_events(id) on delete cascade,
  cube_id    uuid not null references public.cubes(id) on delete cascade,
  created_by uuid not null default auth.uid() references public.users(id),
  created_at timestamptz not null default now(),
  primary key (event_id, cube_id)
);

comment on table public.event_cube_exclusions is
  'Cubos excluidos de la ruleta de UN evento (0162). Un evento nuevo no tiene filas. Elegible = habilitado en el global (cubes.is_enabled) y sin fila acá.';

create index if not exists idx_event_cube_exclusions_cube on public.event_cube_exclusions (cube_id);

-- 2. RLS y permisos ---------------------------------------------------------------------------------------------------------------------
alter table public.event_cube_exclusions enable row level security;

drop policy if exists event_cube_exclusions_select_workspace_member on public.event_cube_exclusions;
create policy event_cube_exclusions_select_workspace_member on public.event_cube_exclusions
  as permissive for select to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_cube_exclusions.event_id and public.is_workspace_member(de.workspace_id)
  ));

drop policy if exists event_cube_exclusions_insert_manager on public.event_cube_exclusions;
create policy event_cube_exclusions_insert_manager on public.event_cube_exclusions
  as permissive for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_cube_exclusions.event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

drop policy if exists event_cube_exclusions_delete_manager on public.event_cube_exclusions;
create policy event_cube_exclusions_delete_manager on public.event_cube_exclusions
  as permissive for delete to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_cube_exclusions.event_id and public.can_manage_event(de.workspace_id, de.id)
  ));

revoke all on public.event_cube_exclusions from public, anon, authenticated;   -- Supabase da ALL por defecto a las tablas nuevas: se quita y se da solo lo mínimo
grant select, insert, delete on public.event_cube_exclusions to authenticated;

-- 3. Guardia de servidor (reemplaza la de la 0160) ----------------------------------------------------------------------------------------
create or replace function public.cube_roulette_spins_guard_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.result_type = 'cube' and new.selected_cube_id is not null then
    if exists (select 1 from public.cubes c where c.id = new.selected_cube_id and c.is_enabled = false) then
      raise exception 'El cubo está deshabilitado y no puede salir en la ruleta'
        using errcode = 'P0001', hint = 'CUBE_DISABLED';
    end if;
    if exists (select 1 from public.event_cube_exclusions x where x.event_id = new.event_id and x.cube_id = new.selected_cube_id) then
      raise exception 'El cubo está excluido de este evento y no puede salir en la ruleta'
        using errcode = 'P0001', hint = 'CUBE_EXCLUDED_FROM_EVENT';
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
  if not exists (select 1 from pg_class where oid = 'public.event_cube_exclusions'::regclass and relrowsecurity) then
    raise exception '0162: event_cube_exclusions sin RLS';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'event_cube_exclusions') <> 3 then
    raise exception '0162: faltan políticas de event_cube_exclusions (se esperan 3)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'cube_roulette_spins_guard_enabled' and tgrelid = 'public.cube_roulette_spins'::regclass and not tgisinternal) then
    raise exception '0162: falta el trigger cube_roulette_spins_guard_enabled';
  end if;
  if position('event_cube_exclusions' in (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'cube_roulette_spins_guard_enabled')) = 0 then
    raise exception '0162: la guardia no quedó actualizada';
  end if;
end;
$verify$;

commit;
