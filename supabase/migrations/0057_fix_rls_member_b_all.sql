-- 0057_fix_rls_member_b_all.sql
--
-- En eventos two_headed_giant, el miembro B queda absorbido en la fila del
-- miembro A (member_b_user_id). Las políticas originales solo comparan
-- ep.user_id = auth.uid(), por lo que el miembro B no puede realizar ninguna
-- operación de escritura ni de lectura restringida.
--
-- Fix: agregar OR ep.member_b_user_id = auth.uid() (o equivalente según tabla)
-- en cada política relevante, preservando el resto de la lógica intacta.
--
-- Tablas afectadas: matches, life_events, match_turns,
--                   event_diary_entries, event_media, dice_rolls.
-- participant_colors ya fue corregida en 0056.

-- ===========================================================================
-- 1. matches_insert_participant_or_organizer
-- ===========================================================================
drop policy if exists "matches_insert_participant_or_organizer" on public.matches;

create policy "matches_insert_participant_or_organizer"
  on public.matches for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.pairings p
      join public.event_participants ep_a on ep_a.id = p.participant_a_id
      join public.event_participants ep_b on ep_b.id = p.participant_b_id
      join public.draft_events de on de.id = p.event_id
      where p.id = pairing_id
      and (
        ep_a.user_id = auth.uid()
        or ep_a.member_b_user_id = auth.uid()
        or ep_b.user_id = auth.uid()
        or ep_b.member_b_user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );

-- ===========================================================================
-- 2. matches_update_authorized
-- ===========================================================================
drop policy if exists "matches_update_authorized" on public.matches;

create policy "matches_update_authorized"
  on public.matches for update
  to authenticated
  using (
    life_tracker_user_id = auth.uid()
    or exists (
      select 1
      from public.pairings p
      join public.event_participants ep_a on ep_a.id = p.participant_a_id
      join public.event_participants ep_b on ep_b.id = p.participant_b_id
      join public.draft_events de on de.id = p.event_id
      where p.id = pairing_id
      and (
        ep_a.user_id = auth.uid()
        or ep_a.member_b_user_id = auth.uid()
        or ep_b.user_id = auth.uid()
        or ep_b.member_b_user_id = auth.uid()
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );

-- ===========================================================================
-- 3. life_events_insert_authorized
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
          or public.is_workspace_organizer(de.workspace_id)
        )
    )
  );

-- ===========================================================================
-- 4. life_events_delete_life_tracker
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
          or public.is_workspace_organizer(de.workspace_id)
        )
    )
  );

-- ===========================================================================
-- 5. insert_match_turns_for_participants_or_organizer
-- ===========================================================================
drop policy if exists "insert_match_turns_for_participants_or_organizer" on public.match_turns;

create policy "insert_match_turns_for_participants_or_organizer"
  on public.match_turns
  for insert
  with check (
    exists (
      select 1 from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_turns.match_id
        and (
          public.is_workspace_organizer(de.workspace_id)
          or exists (
            select 1 from public.event_participants ep
            where ep.event_id = de.id
              and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
              and (ep.id = p.participant_a_id or ep.id = p.participant_b_id)
          )
        )
    )
  );

-- ===========================================================================
-- 6. update_match_turns_for_participants_or_organizer
-- ===========================================================================
drop policy if exists "update_match_turns_for_participants_or_organizer" on public.match_turns;

create policy "update_match_turns_for_participants_or_organizer"
  on public.match_turns
  for update
  using (
    exists (
      select 1 from public.matches m
      join public.pairings p on p.id = m.pairing_id
      join public.draft_events de on de.id = p.event_id
      where m.id = match_turns.match_id
        and (
          public.is_workspace_organizer(de.workspace_id)
          or exists (
            select 1 from public.event_participants ep
            where ep.event_id = de.id
              and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
              and (ep.id = p.participant_a_id or ep.id = p.participant_b_id)
          )
        )
    )
  );

-- ===========================================================================
-- 7. diary_read
-- ===========================================================================
drop policy if exists "diary_read" on public.event_diary_entries;

create policy "diary_read" on public.event_diary_entries for select using (
  exists (
    select 1 from public.event_participants ep
    where ep.event_id = event_diary_entries.event_id
      and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
  ) or exists (
    select 1 from public.workspace_members wm
    join public.draft_events de on de.workspace_id = wm.workspace_id
    where de.id = event_diary_entries.event_id and wm.user_id = auth.uid() and wm.role = 'organizer'
  )
);

-- ===========================================================================
-- 8. diary_insert
-- ===========================================================================
drop policy if exists "diary_insert" on public.event_diary_entries;

create policy "diary_insert" on public.event_diary_entries for insert with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.event_participants ep
    join public.draft_events de on de.id = ep.event_id
    where ep.event_id = event_diary_entries.event_id
      and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
      and (de.status in ('drafting', 'playing', 'completed') or
           (de.scheduled_for::date = (now() at time zone 'America/Argentina/Buenos_Aires')::date))
  )
);

-- ===========================================================================
-- 9. media_insert_participant_or_organizer
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
        public.is_workspace_organizer(de.workspace_id)
        or exists (
          select 1 from public.event_participants ep
          where ep.event_id = de.id
            and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
        )
      )
    )
  );

-- ===========================================================================
-- 10. dice_insert_self_or_organizer
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
        or public.is_workspace_organizer(de.workspace_id)
      )
    )
  );
