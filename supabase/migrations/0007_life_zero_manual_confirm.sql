-- =====================================================================
-- Migration 0007: la vida en 0 no cierra el match sola; revertir cancel con DELETE
-- - Quita auto_resolve al insertar life_event (la app confirma ganador)
-- - DELETE de life_events permitido al life_tracker con partida en curso
-- =====================================================================

drop trigger if exists on_life_event_zero on public.life_events;

create policy "life_events_delete_life_tracker"
  on public.life_events for delete
  to authenticated
  using (
    exists (
      select 1
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.event_participants ep_a on ep_a.id = p.participant_a_id
      join public.event_participants ep_b on ep_b.id = p.participant_b_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_id
        and m.status = 'in_progress'
        and m.life_tracker_user_id = auth.uid()
        and (
          ep_a.user_id = auth.uid()
          or ep_b.user_id = auth.uid()
          or public.is_workspace_organizer(de.workspace_id)
        )
    )
  );

-- =====================================================================
-- FIN
-- =====================================================================
