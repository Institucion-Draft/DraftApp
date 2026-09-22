-- 0120_events_insert_member.sql
--
-- Habilita que cualquier miembro del workspace cree eventos, no solo organizadores (IDEAS.md,
-- "Habilitar que cualquier miembro cree eventos"). Hasta ahora la posta transferible del
-- organizador puntual de un evento (event_organizer_user_id, 0101-0106) nunca se usaba en la
-- práctica: la posta siempre nacía en manos de created_by, y created_by solo podía ser un
-- organizador real (único que podía insertar en draft_events), así que jamás había una posta en
-- manos de alguien que no fuera ya organizador de todo el workspace.
--
-- Cambio: events_insert_organizer pasa de exigir is_workspace_organizer(workspace_id) a
-- is_workspace_member(workspace_id). Se mantiene el nombre de la policy (mismo criterio que
-- participants_insert_organizer en 0103: esa policy también se amplió de organizador real a
-- can_manage_event —organizador O posta— sin renombrarse).
--
-- Nada más se toca:
--   * events_update_organizer / events_delete_organizer: sin cambios. Editar sigue abierto a
--     can_manage_event (organizador real O posta del evento, 0103); eliminar sigue
--     organizer-only, por diseño explícito (ver comentario de 0103: "la posta nunca da esa
--     facultad"). La verificación de abajo confirma que ninguna de las dos cambió.
--   * El resto de "Acciones de organizador" del workspace (generar invitación, ver solicitudes
--     pendientes) no tiene policy propia acá — son otras tablas (workspace_invites,
--     workspace_join_requests), ninguna tocada por esta migración.
--   * El trigger handle_new_draft_event_posta (0101) ya asigna event_organizer_user_id =
--     created_by sin mirar si created_by es organizador — corre igual sin importar quién inserte,
--     así que un miembro no-organizador que crea un evento se vuelve posta-holder de ESE evento
--     automáticamente, sin cambios en el trigger. can_manage_event (0103) ya contempla ese caso
--     (organizador real O event_organizer_user_id = auth.uid()), así que el posta-holder no
--     organizador ya puede gestionar su propio evento de punta a punta con el código existente.
--     (Probado con INSERTs reales bajo rol `authenticated` en un sandbox aparte — no acá: fabricar
--     workspaces/usuarios de prueba dentro de una migración dejaría datos falsos en producción.
--     La verificación de abajo es de solo lectura, sobre la definición de las policies.)
--
-- ===========================================================================
-- VERIFICACIÓN AUTOMÁTICA (de solo lectura: inspecciona pg_policy, no inserta ni borra filas)
-- ===========================================================================

drop policy if exists "events_insert_organizer" on public.draft_events;

create policy "events_insert_organizer"
  on public.draft_events for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
  );

do $$
declare
  v_insert_check text;
  v_update_qual text;
  v_delete_qual text;
begin
  select pg_get_expr(polwithcheck, polrelid) into v_insert_check
  from pg_policy
  where polrelid = 'public.draft_events'::regclass and polname = 'events_insert_organizer';

  if v_insert_check is null then
    raise exception 'Fase de posta abierta a miembros: no se encontró la policy events_insert_organizer tras recrearla. Migración abortada, nada quedó aplicado.';
  end if;
  if v_insert_check !~ 'is_workspace_member' or v_insert_check ~ 'is_workspace_organizer' then
    raise exception 'Fase de posta abierta a miembros: events_insert_organizer no quedó gateada por is_workspace_member (o todavía menciona is_workspace_organizer). Definición actual: %. Migración abortada, nada quedó aplicado.', v_insert_check;
  end if;
  if v_insert_check !~ 'created_by' or v_insert_check !~ 'auth\.uid\(\)' then
    raise exception 'Fase de posta abierta a miembros: events_insert_organizer perdió el chequeo created_by = auth.uid(). Definición actual: %. Migración abortada, nada quedó aplicado.', v_insert_check;
  end if;

  -- events_update_organizer y events_delete_organizer no las toca esta migración: confirmar que
  -- ninguna quedó accidentalmente abierta a is_workspace_member (edición sigue en can_manage_event,
  -- borrado sigue organizer-only puro).
  select pg_get_expr(polqual, polrelid) into v_update_qual
  from pg_policy
  where polrelid = 'public.draft_events'::regclass and polname = 'events_update_organizer';
  if v_update_qual is null or v_update_qual !~ 'can_manage_event' then
    raise exception 'Fase de posta abierta a miembros: events_update_organizer no está como se esperaba (can_manage_event). Definición actual: %. Migración abortada, nada quedó aplicado.', v_update_qual;
  end if;

  select pg_get_expr(polqual, polrelid) into v_delete_qual
  from pg_policy
  where polrelid = 'public.draft_events'::regclass and polname = 'events_delete_organizer';
  if v_delete_qual is null or v_delete_qual !~ 'is_workspace_organizer' or v_delete_qual ~ 'is_workspace_member' then
    raise exception 'Fase de posta abierta a miembros: events_delete_organizer dejó de ser organizer-only puro. Definición actual: %. Migración abortada, nada quedó aplicado.', v_delete_qual;
  end if;

  raise notice 'Fase de posta abierta a miembros: events_insert_organizer ahora exige is_workspace_member (con created_by = auth.uid() intacto); events_update_organizer sigue en can_manage_event; events_delete_organizer sigue organizer-only puro.';
end;
$$;
