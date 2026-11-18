-- 0164_eliminar_evento_cancelado.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
--
-- COPIAR EL ARCHIVO (PowerShell). El -Encoding UTF8 es obligatorio: sin él las tildes se rompen ("está" -> "estÃ¡") en la función y en los comentarios:
--      Get-Content -Raw -Encoding UTF8 <ruta>\0164_eliminar_evento_cancelado.sql | Set-Clipboard
--
-- QUÉ HACE
--   Un evento se "elimina" con borrado LÓGICO: draft_events.deleted_at (authenticated no tiene DELETE de tabla; 0151). El botón del organizador usa el
--   RPC soft_delete_event(uuid) (SECURITY DEFINER), definido SOLO en producción: el repo apenas tiene su GRANT en la 0151. Un UPDATE directo de
--   deleted_at hecho por un cliente falla por RLS ("new row violates row-level security policy"): la política de lectura events_select_member oculta las
--   filas con deleted_at y Postgres rechaza el UPDATE cuyo resultado el usuario ya no puede ver (reproducido en las pruebas de PGlite; confirmar en producción).
--   Esta migración agrega el camino para quien tiene la posta y pone el límite en el SERVIDOR, sin romper al organizador:
--   1. Función nueva public.soft_delete_cancelled_event(p_event_id) (SECURITY DEFINER, search_path fijo, solo authenticated): exige sesión, que el evento
--      exista y no esté eliminado, y can_manage_event (organizador del workspace o posta). Hace el UPDATE de deleted_at; las reglas las aplica el trigger.
--      El cliente usa ESTE RPC solo para quien tiene la posta sin ser organizador; el organizador sigue con soft_delete_event, sin cambios.
--   2. Trigger BEFORE UPDATE OF deleted_at sobre public.draft_events (función draft_events_guard_soft_delete, SECURITY DEFINER, search_path fijo). Aplica a
--      CUALQUIER camino que escriba deleted_at (este RPC, soft_delete_event, un UPDATE directo):
--        * Sin usuario (auth.uid() nulo: SQL Editor, rol de servicio, procesos internos): no se toca nada.
--        * Si deleted_at no cambia: no hace nada.
--        * ORGANIZADOR del workspace (is_workspace_organizer): conserva EXACTAMENTE lo que podía (eliminar y restaurar, en cualquier estado, con o sin
--          partidas). No se agrega ningún requisito para él.
--        * Cualquier otra persona (la posta):
--            - solo puede ELIMINAR (deleted_at de nulo a no nulo); no restaurar ni re-fechar;
--            - solo un evento CANCELADO (status = 'cancelled' antes y después del UPDATE);
--            - si el evento es OFICIAL y tiene alguna partida (matches por enfrentamientos, o tg_matches de gigantes), NO: eso sigue siendo solo del
--              organizador del workspace. Eliminar un oficial con partidas lo saca de estadísticas, ranking y de la cuenta de la partida N.º 420;
--            - en ese UPDATE no puede cambiar NINGÚN otro campo (se compara la fila entera salvo deleted_at y updated_at).
--   Sin cambios en políticas ni grants de draft_events.
--   NO REEMPLAZA ninguna función existente (funciones y trigger nuevos), por eso no hay md5(prosrc) que comprobar. soft_delete_event(uuid) NO se toca.
--
-- EFECTOS LATERALES (idénticos al borrado del organizador: los disparan triggers de la tabla, no el cliente ni el RPC)
--   * Temporadas: draft_events_seasons_sync_trg (0116) se dispara por el cambio de deleted_at y cierra las temporadas que ya puedan cerrarse.
--   * Recompensa especial (0157): special_unlock_event_cancel devuelve la recompensa si el evento SIN draft iniciado se borra.
--   * Estadísticas, rankings y analytics: las vistas y funciones filtran por deleted_at is null; un evento de la posta no oficial o sin partidas no
--     suma nada a la cuenta de la partida N.º 420 (solo cuentan partidas de eventos oficiales, no borrados).
--   * Diferencia posible: si soft_delete_event hiciera algo EXTRA además de escribir deleted_at, el RPC nuevo (que solo escribe deleted_at) no lo haría. Verificar la definición real:  select pg_get_functiondef('public.soft_delete_event(uuid)'::regprocedure);
--
-- ANTES DE APLICAR (solo lectura, en producción)
--   a) can_manage_event e is_workspace_organizer existen:  select proname from pg_proc where proname in ('can_manage_event', 'is_workspace_organizer');   -- las dos
--   b) Que no haya ya un trigger con ese nombre de otro origen:  select tgname from pg_trigger where tgrelid = 'public.draft_events'::regclass and not tgisinternal;
--
-- CÓMO APLICARLA (a mano, SQL Editor)
--   1. Correr los pasos "ANTES DE APLICAR".  2. Pegar y correr ESTE archivo completo (una sola transacción).  3. Verificar (abajo).
--   4. Recién después publicar el cliente nuevo (eas update): llama a soft_delete_cancelled_event; sin la función, la posta no puede eliminar.
--
-- VERIFICACIÓN POSTERIOR (como postgres)
--   select tgname from pg_trigger where tgrelid = 'public.draft_events'::regclass and not tgisinternal and tgname = 'draft_events_guard_soft_delete_trg';   -- 1 fila
--   select has_function_privilege('anon', 'public.draft_events_guard_soft_delete()', 'execute') as trg_anon,
--          has_function_privilege('authenticated', 'public.draft_events_guard_soft_delete()', 'execute') as trg_auth,    -- false, false
--          has_function_privilege('anon', 'public.soft_delete_cancelled_event(uuid)', 'execute') as rpc_anon,
--          has_function_privilege('authenticated', 'public.soft_delete_cancelled_event(uuid)', 'execute') as rpc_auth;   -- false, true
--   Como Martín (posta, member): borrar un evento cancelado no oficial anda; uno no cancelado, o un oficial cancelado con partidas, falla con el aviso.
--
-- ROLLBACK -- NO CORRER salvo marcha atrás deliberada (vuelve a la situación anterior: la posta puede eliminar cualquier evento propio en cualquier estado).
--   drop function if exists public.soft_delete_cancelled_event(uuid);
--   drop trigger if exists draft_events_guard_soft_delete_trg on public.draft_events;
--   drop function if exists public.draft_events_guard_soft_delete();

begin;
set local lock_timeout = '3s';

do $precheck$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'can_manage_event')
     or not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'is_workspace_organizer') then
    raise exception '0164: faltan can_manage_event / is_workspace_organizer';
  end if;
end;
$precheck$;

create or replace function public.draft_events_guard_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sin usuario (SQL Editor, rol de servicio, procesos internos): no se interviene.
  if auth.uid() is null then
    return new;
  end if;
  if old.deleted_at is not distinct from new.deleted_at then
    return new;
  end if;
  -- El organizador del workspace conserva todo lo que ya podía.
  if public.is_workspace_organizer(new.workspace_id) then
    return new;
  end if;

  -- Cualquier otra persona (la posta): solo ELIMINAR un evento CANCELADO, sin tocar nada más.
  if old.deleted_at is not null or new.deleted_at is null then
    raise exception 'Solo el organizador del workspace puede restaurar o modificar un evento eliminado'
      using errcode = 'P0001', hint = 'EVENT_DELETE_FORBIDDEN';
  end if;
  if not public.can_manage_event(new.workspace_id, new.id) then
    raise exception 'No tenés permiso para eliminar este evento'
      using errcode = '42501', hint = 'EVENT_DELETE_FORBIDDEN';
  end if;
  if old.status is distinct from 'cancelled' or new.status is distinct from 'cancelled' then
    raise exception 'Solo se puede eliminar un evento cancelado'
      using errcode = 'P0001', hint = 'EVENT_NOT_CANCELLED';
  end if;
  if old.is_official and (
       exists (select 1 from public.matches m join public.pairings p on p.id = m.pairing_id where p.event_id = old.id)
    or exists (select 1 from public.tg_matches tm join public.tg_pairings tp on tp.id = tm.tg_pairing_id where tp.event_id = old.id)
  ) then
    raise exception 'Un evento oficial con partidas jugadas solo lo puede eliminar el organizador del workspace'
      using errcode = 'P0001', hint = 'EVENT_HAS_OFFICIAL_MATCHES';
  end if;
  if (to_jsonb(new) - 'deleted_at' - 'updated_at') is distinct from (to_jsonb(old) - 'deleted_at' - 'updated_at') then
    raise exception 'Eliminar un evento no puede modificar otros datos'
      using errcode = 'P0001', hint = 'EVENT_DELETE_ONLY';
  end if;
  return new;
end;
$$;

revoke all on function public.draft_events_guard_soft_delete() from public, anon, authenticated;

drop trigger if exists draft_events_guard_soft_delete_trg on public.draft_events;
create trigger draft_events_guard_soft_delete_trg
  before update of deleted_at on public.draft_events
  for each row execute function public.draft_events_guard_soft_delete();

create or replace function public.soft_delete_cancelled_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'Tenés que iniciar sesión para eliminar un evento' using errcode = '42501';
  end if;
  select workspace_id into v_ws from public.draft_events where id = p_event_id and deleted_at is null;
  if v_ws is null then
    raise exception 'No se encontró el evento' using errcode = 'P0002';
  end if;
  if not public.can_manage_event(v_ws, p_event_id) then
    raise exception 'No tenés permiso para eliminar este evento' using errcode = '42501', hint = 'EVENT_DELETE_FORBIDDEN';
  end if;
  -- Las reglas (cancelado, oficial con partidas, solo deleted_at) las aplica el trigger draft_events_guard_soft_delete.
  update public.draft_events set deleted_at = now() where id = p_event_id;
end;
$$;

revoke all on function public.soft_delete_cancelled_event(uuid) from public, anon;
grant execute on function public.soft_delete_cancelled_event(uuid) to authenticated;

do $verify$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'soft_delete_cancelled_event') then
    raise exception '0164: falta soft_delete_cancelled_event';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'draft_events_guard_soft_delete_trg' and tgrelid = 'public.draft_events'::regclass and not tgisinternal) then
    raise exception '0164: falta el trigger draft_events_guard_soft_delete_trg';
  end if;
end;
$verify$;

commit;
