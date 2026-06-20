-- 0056_fix_rls_participant_colors_member_b.sql
--
-- La política colors_modify_self_or_organizer solo verificaba ep.user_id = auth.uid().
-- Para 2HG, el miembro B tiene participant_id = fila del gigante (cuyo user_id es el
-- miembro A), por lo que el INSERT/DELETE de sus propios colores era rechazado por RLS.
-- Fix: agregar ep.member_b_user_id = auth.uid() como condición alternativa.

drop policy if exists "colors_modify_self_or_organizer" on public.participant_colors;

create policy "colors_modify_self_or_organizer"
  on public.participant_colors for all
  to authenticated
  using (
    exists (
      select 1
      from public.event_participants ep
      join public.draft_events de on de.id = ep.event_id
      where ep.id = participant_id
      and (
        ep.user_id = auth.uid()
        or ep.member_b_user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );
