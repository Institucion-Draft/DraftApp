-- 0160_cubos_habilitados.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
--
-- QUÉ HACE
--   Permite sacar cubos de la elegibilidad de la ruleta SIN eliminarlos ni tocar nada de lo ya jugado.
--   1. public.cubes.is_enabled boolean not null default true. Los cubos existentes quedan habilitados (el default se aplica a las filas
--      que ya existen). Deshabilitar un cubo NO lo borra, NO lo suprime y NO invalida eventos, drafts, partidas ni estadísticas que lo
--      usaron: draft_events.cube_id, cube_roulette_spins y las vistas de estadísticas no miran la columna.
--   2. Quién la cambia: el patrón de siempre de public.cubes. Escribir cubos requiere ser ORGANIZADOR del workspace: la política
--      cubes_update_organizer (is_workspace_organizer) es la misma que cubes_insert_organizer, y 0151 da UPDATE de tabla a authenticated, así
--      que la columna nueva queda cubierta. Se repite un GRANT UPDATE (is_enabled) explícito por si algún entorno tuviera grants por columna.
--   3. Guardia de servidor en la ruleta: trigger BEFORE INSERT en cube_roulette_spins que rechaza registrar una tirada con result_type = 'cube'
--      cuyo selected_cube_id esté deshabilitado ("el cubo está deshabilitado y no puede salir"). La ELECCIÓN del cubo en la ruleta NO pasa por
--      ninguna función del servidor: la sortea el cliente (Math.random en CubeRouletteScreen) y después inserta la tirada y actualiza
--      draft_events.cube_id. Por eso la regla "un deshabilitado no puede salir" la aplica el cliente nuevo al armar las opciones y este trigger
--      la hace valer también para clientes viejos (APK que no conocen el flag) o con la lista desactualizada. No toca filas ya existentes.
--      NO hay trigger sobre draft_events.cube_id: crear o editar un evento con un cubo deshabilitado sigue siendo posible (no es la ruleta).
--   NO reemplaza el cuerpo de ninguna función existente (no hay md5 que comprobar). Funciones nuevas: cube_roulette_spins_guard_enabled().
--
-- LO QUE NO CAMBIA
--   * La letra estable de cada cubo (0156, analytics_private.cube_orden / cube_pos): se arma con los cubos usados por eventos válidos, sin mirar
--     is_enabled. Habilitar/deshabilitar no cambia ninguna letra, ni quita un cubo ya usado de analytics.cubos.
--   * analytics / contrato.md: NO hace falta actualizarlos (analytics.cubos solo publica id y nombre, y los cubos salen de los eventos).
--   * public.cubes_with_stats (0001: select c.*) no incluye la columna nueva (las vistas con "c.*" se congelan al crearse). El cliente lee
--     is_enabled de public.cubes directamente; la vista sigue sirviendo la lista de cubos como hasta ahora.
--
-- CÓMO APLICARLA EN PRODUCCIÓN (a mano, SQL Editor)
--   1. Aplicar ESTE archivo ANTES de publicar el cliente nuevo (el cliente nuevo pide la columna is_enabled; sin ella falla la carga de la ruleta).
--   2. Verificar:
--        select count(*) filter (where is_enabled) as habilitados, count(*) filter (where not is_enabled) as deshabilitados from public.cubes;   -- todos habilitados
--        select tgname from pg_trigger where tgrelid = 'public.cube_roulette_spins'::regclass and not tgisinternal;   -- incluye cube_roulette_spins_guard_enabled
--        select has_column_privilege('authenticated', 'public.cubes', 'is_enabled', 'update');                        -- true
--   3. Publicar el cliente (eas update). Si hubo que revertir el cliente, la columna puede quedarse: los clientes viejos la ignoran.
--
-- ROLLBACK -- NO CORRER salvo marcha atrás deliberada (PRIMERO revertir el cliente nuevo: sin la columna su carga de la ruleta falla).
--   drop trigger if exists cube_roulette_spins_guard_enabled on public.cube_roulette_spins;
--   drop function if exists public.cube_roulette_spins_guard_enabled();
--   alter table public.cubes drop column if exists is_enabled;    -- pierde qué cubos estaban deshabilitados: anotarlos antes
--   (select id, name from public.cubes where not is_enabled)

begin;
set local lock_timeout = '3s';

alter table public.cubes add column if not exists is_enabled boolean not null default true;

comment on column public.cubes.is_enabled is
  'Habilitado en la ruleta de cubos (default true). Deshabilitar NO borra ni invalida nada de lo jugado; solo saca al cubo de la ruleta. Ver 0160.';

-- Ya existe UPDATE de tabla para authenticated (0151) y la política cubes_update_organizer lo limita a organizadores; se explicita por si
-- algún entorno usara grants por columna.
grant update (is_enabled) on public.cubes to authenticated;

create or replace function public.cube_roulette_spins_guard_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.result_type = 'cube'
     and new.selected_cube_id is not null
     and exists (select 1 from public.cubes c where c.id = new.selected_cube_id and c.is_enabled = false) then
    raise exception 'El cubo está deshabilitado y no puede salir en la ruleta'
      using errcode = 'P0001', hint = 'CUBE_DISABLED';
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
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cubes' and column_name = 'is_enabled'
      and data_type = 'boolean' and is_nullable = 'NO'
  ) then
    raise exception '0160: falta public.cubes.is_enabled (boolean not null)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'cube_roulette_spins_guard_enabled' and tgrelid = 'public.cube_roulette_spins'::regclass and not tgisinternal) then
    raise exception '0160: falta el trigger cube_roulette_spins_guard_enabled';
  end if;
end;
$verify$;

commit;
