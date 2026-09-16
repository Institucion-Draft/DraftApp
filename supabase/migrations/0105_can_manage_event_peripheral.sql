-- 0105_can_manage_event_peripheral.sql
-- Fase 5/8: can_manage_event en las 5 tablas periféricas confirmadas — life_events/
-- tg_life_events, event_media, participant_colors, dice_rolls, event_diary_entries — más
-- cube_roulette_spins (roulette_spins_insert_organizer), sumada a último momento: el botón
-- "Ruleta" vive adentro del mismo mega-bloque de EventDetailScreen que la Fase 6 va a abrir para
-- can_manage_event, así que había que migrarla ahora para no dejarlo roto (botón visible para el
-- posta-holder, pero el INSERT fallando por RLS). match_turns queda deliberadamente afuera del
-- alcance de este feature por ahora.
--
-- Mismo patrón mecánico que las Fases 3 y 4. Antes de escribir esto se verificó, policy por
-- policy, cuál es la versión REALMENTE vigente (no asumir 0001 a ciegas):
--   - life_events_insert_authorized y life_events_delete_life_tracker: vigentes desde 0057
--     (agregó member_b_user_id). Se parte de esa versión.
--   - life_events_update_organizer y tg_life_events_update_organizer: sin cambios desde 0001.
--   - media_insert_participant_or_organizer: vigente desde 0057. media_delete_uploader_or_organizer:
--     sin cambios desde 0001.
--   - colors_modify_self_or_organizer: vigente desde 0056 (agregó member_b_user_id).
--   - dice_insert_self_or_organizer: vigente desde 0057.
--   - event_diary_entries: "diary_read" vigente desde 0057; "diary_delete" sin cambios desde
--     0040 (nunca tocada por 0057, que solo modificó diary_read/diary_insert).
--
-- Dos exclusiones deliberadas, NO son un olvido:
--   - tg_life_events_insert_tracker_only: nunca tuvo rama de organizador (ni siquiera
--     is_workspace_organizer hoy) — es asimétrico respecto a life_events_insert_authorized, pero
--     no es este el momento de agregar una facultad que nunca existió; solo migramos lo vigente.
--   - tg_life_events no tiene policy de DELETE en ninguna migración — no hay nada que migrar.
--   - diary_insert: su única condición es ser participante; no tiene ni tuvo rama de organizador
--     (a diferencia de diary_read/diary_delete), así que no aplica ningún cambio ahí tampoco.

-- ===========================================================================
-- 1. life_events_insert_authorized (parte de la versión de 0057)
-- ===========================================================================
drop policy if exists "life_events_insert_authorized" on public.life_events;

create policy "life_events_insert_authorized"
  on public.life_events for insert
  to authenticated
  with check (
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
          or ep_a.member_b_user_id = auth.uid()
          or ep_b.user_id = auth.uid()
          or ep_b.member_b_user_id = auth.uid()
          or public.can_manage_event(de.workspace_id, de.id)
        )
    )
  );

-- ===========================================================================
-- 2. life_events_update_organizer (sin cambios desde 0001)
-- ===========================================================================
drop policy if exists "life_events_update_organizer" on public.life_events;

create policy "life_events_update_organizer"
  on public.life_events for update
  to authenticated
  using (
    exists (
      select 1
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 3. life_events_delete_life_tracker (parte de la versión de 0057)
-- ===========================================================================
drop policy if exists "life_events_delete_life_tracker" on public.life_events;

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
          or ep_a.member_b_user_id = auth.uid()
          or ep_b.user_id = auth.uid()
          or ep_b.member_b_user_id = auth.uid()
          or public.can_manage_event(de.workspace_id, de.id)
        )
    )
  );

-- ===========================================================================
-- 4. tg_life_events_update_organizer (sin cambios desde 0001)
-- ===========================================================================
drop policy if exists "tg_life_events_update_organizer" on public.tg_life_events;

create policy "tg_life_events_update_organizer"
  on public.tg_life_events for update
  to authenticated
  using (
    exists (
      select 1
      from public.tg_matches m
      join public.tg_pairings p on p.id = m.tg_pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = tg_match_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 5. media_insert_participant_or_organizer (parte de la versión de 0057)
-- ===========================================================================
drop policy if exists "media_insert_participant_or_organizer" on public.event_media;

create policy "media_insert_participant_or_organizer"
  on public.event_media for insert
  to authenticated
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_id
      and (
        public.can_manage_event(de.workspace_id, de.id)
        or exists (
          select 1 from public.event_participants ep
          where ep.event_id = de.id
            and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
        )
      )
    )
  );

-- ===========================================================================
-- 6. media_delete_uploader_or_organizer (sin cambios desde 0001)
-- ===========================================================================
drop policy if exists "media_delete_uploader_or_organizer" on public.event_media;

create policy "media_delete_uploader_or_organizer"
  on public.event_media for delete
  to authenticated
  using (
    uploaded_by = auth.uid()
    or exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 7. colors_modify_self_or_organizer (vigente desde 0056)
-- ===========================================================================
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
        or public.can_manage_event(de.workspace_id, de.id)
      )
    )
  );

-- ===========================================================================
-- 8. dice_insert_self_or_organizer (vigente desde 0057)
-- ===========================================================================
drop policy if exists "dice_insert_self_or_organizer" on public.dice_rolls;

create policy "dice_insert_self_or_organizer"
  on public.dice_rolls for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.event_participants ep
      join public.draft_events de on de.id = ep.event_id
      where ep.id = participant_id
      and (
        ep.user_id = auth.uid()
        or ep.member_b_user_id = auth.uid()
        or public.can_manage_event(de.workspace_id, de.id)
      )
    )
  );

-- ===========================================================================
-- 9. diary_read (vigente desde 0057) — la rama organizer se reescribe usando
--    can_manage_event en vez del join manual a workspace_members.
-- ===========================================================================
drop policy if exists "diary_read" on public.event_diary_entries;

create policy "diary_read" on public.event_diary_entries for select using (
  exists (
    select 1 from public.event_participants ep
    where ep.event_id = event_diary_entries.event_id
      and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
  ) or exists (
    select 1 from public.draft_events de
    where de.id = event_diary_entries.event_id
      and public.can_manage_event(de.workspace_id, de.id)
  )
);

-- ===========================================================================
-- 10. diary_delete (sin cambios desde 0040 — diary_update_own y diary_insert no
--     tienen rama de organizador, no aplica ningún cambio en esas dos)
-- ===========================================================================
drop policy if exists "diary_delete" on public.event_diary_entries;

create policy "diary_delete" on public.event_diary_entries for delete using (
  user_id = auth.uid()
  or exists (
    select 1 from public.draft_events de
    where de.id = event_diary_entries.event_id
      and public.can_manage_event(de.workspace_id, de.id)
  )
);

-- ===========================================================================
-- 11. roulette_spins_insert_organizer (sin cambios desde 0003) — fuera de la lista
--     original de 5 tablas, sumada porque el botón "Ruleta" del mega-bloque de
--     EventDetailScreen depende de esta policy y la Fase 6 lo va a habilitar para
--     can_manage_event.
-- ===========================================================================
drop policy if exists "roulette_spins_insert_organizer" on public.cube_roulette_spins;

create policy "roulette_spins_insert_organizer"
  on public.cube_roulette_spins for insert
  to authenticated
  with check (
    spun_by = auth.uid()
    and exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );
