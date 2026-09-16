-- 0103_can_manage_event_core.sql
-- Fase 3/8: can_manage_event + policies "core" de draft_events y event_participants.
--
-- can_manage_event(workspace_id, event_id) es el nuevo gatekeeper para facultades DE UN EVENTO
-- PUNTUAL: es true si el actor es organizador real del workspace (is_workspace_organizer, sin
-- cambios) O si tiene la posta de ESE evento (event_organizer_user_id, Fase 1/2). No reemplaza a
-- is_workspace_organizer en general — sigue intacta y se sigue usando tal cual en las policies
-- workspace-root (workspace_members, workspace_invites, workspace_join_requests, audit log) y en
-- events_delete_organizer (eliminar evento queda organizer-only, por diseño explícito: la posta
-- nunca da esa facultad).
--
-- Esta fase migra únicamente las 4 policies "core", las más directamente ligadas al diagnóstico
-- (editar evento, y marcar/revertir "me voy" de otro jugador vía event_participants). El resto
-- (pairings/matches/tg_*/life_events, y las periféricas acordadas: event_media,
-- participant_colors, dice_rolls, event_diary_entries) se migran en las Fases 4 y 5, mismo patrón
-- mecánico.

create or replace function public.can_manage_event(p_workspace_id uuid, p_event_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select
    public.is_workspace_organizer(p_workspace_id)
    or exists (
      select 1 from public.draft_events
      where id = p_event_id
        and event_organizer_user_id = auth.uid()
    );
$$;

-- ===========================================================================
-- 1. events_update_organizer (draft_events) — editar evento, cronómetro,
--    iniciar/finalizar draft, cancelar evento, dar por concluido, etc.
--    (events_delete_organizer NO se toca: eliminar sigue organizer-only.)
-- ===========================================================================
drop policy if exists "events_update_organizer" on public.draft_events;

create policy "events_update_organizer"
  on public.draft_events for update
  to authenticated
  using (public.can_manage_event(workspace_id, id));

-- ===========================================================================
-- 2. participants_insert_organizer (event_participants)
-- ===========================================================================
drop policy if exists "participants_insert_organizer" on public.event_participants;

create policy "participants_insert_organizer"
  on public.event_participants for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 3. participants_update_organizer (event_participants) — incluye marcar/
--    revertir "me voy" de OTRO jugador.
-- ===========================================================================
drop policy if exists "participants_update_organizer" on public.event_participants;

create policy "participants_update_organizer"
  on public.event_participants for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 4. participants_delete_organizer (event_participants)
-- ===========================================================================
drop policy if exists "participants_delete_organizer" on public.event_participants;

create policy "participants_delete_organizer"
  on public.event_participants for delete
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and public.can_manage_event(de.workspace_id, de.id)
    )
  );
