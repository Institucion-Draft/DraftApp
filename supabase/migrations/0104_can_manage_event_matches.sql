-- 0104_can_manage_event_matches.sql
-- Fase 4/8: can_manage_event en pairings, matches, y sus equivalentes de two-headed giant
-- (tg_pairings, tg_team_members, tg_matches) — "iniciar cualquier partida entre jugadores".
--
-- Mismo patrón mecánico que la Fase 3: se reemplaza is_workspace_organizer(de.workspace_id) por
-- can_manage_event(de.workspace_id, de.id) en cada policy, sin tocar ningún otro criterio
-- (participante directo, life_tracker_user_id, member_b_user_id de 2HG, etc. quedan intactos).
-- Ninguna de estas 9 policies fue modificada después de 0001 salvo matches_insert_* y
-- matches_update_authorized, cuya versión vigente es la de 0057 (agregó member_b_user_id) — se
-- parte de esa versión acá, no de la original de 0001.

-- ===========================================================================
-- 1. pairings_insert_organizer
-- ===========================================================================
drop policy if exists "pairings_insert_organizer" on public.pairings;

create policy "pairings_insert_organizer"
  on public.pairings for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 2. pairings_update_organizer
-- ===========================================================================
drop policy if exists "pairings_update_organizer" on public.pairings;

create policy "pairings_update_organizer"
  on public.pairings for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 3. matches_insert_participant_or_organizer (parte de la versión de 0057)
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
        or public.can_manage_event(de.workspace_id, de.id)
      )
    )
  );

-- ===========================================================================
-- 4. matches_update_authorized (parte de la versión de 0057)
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
        or public.can_manage_event(de.workspace_id, de.id)
      )
    )
  );

-- ===========================================================================
-- 5. tg_pairings_insert_organizer
-- ===========================================================================
drop policy if exists "tg_pairings_insert_organizer" on public.tg_pairings;

create policy "tg_pairings_insert_organizer"
  on public.tg_pairings for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 6. tg_pairings_update_organizer
-- ===========================================================================
drop policy if exists "tg_pairings_update_organizer" on public.tg_pairings;

create policy "tg_pairings_update_organizer"
  on public.tg_pairings for update
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 7. tg_team_members_modify_organizer
-- ===========================================================================
drop policy if exists "tg_team_members_modify_organizer" on public.tg_team_members;

create policy "tg_team_members_modify_organizer"
  on public.tg_team_members for all
  to authenticated
  using (
    exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 8. tg_matches_insert_player_or_organizer
-- ===========================================================================
drop policy if exists "tg_matches_insert_player_or_organizer" on public.tg_matches;

create policy "tg_matches_insert_player_or_organizer"
  on public.tg_matches for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id
      and (
        public.can_manage_event(de.workspace_id, de.id)
        or exists (
          select 1 from public.tg_team_members tm
          where tm.tg_pairing_id = p.id and tm.player_user_id = auth.uid()
        )
      )
    )
  );

-- ===========================================================================
-- 9. tg_matches_update_authorized
-- ===========================================================================
drop policy if exists "tg_matches_update_authorized" on public.tg_matches;

create policy "tg_matches_update_authorized"
  on public.tg_matches for update
  to authenticated
  using (
    life_tracker_user_id = auth.uid()
    or exists (
      select 1
      from public.tg_pairings p
      join public.draft_events de on de.id = p.event_id
      where p.id = tg_pairing_id
      and (
        public.can_manage_event(de.workspace_id, de.id)
        or exists (
          select 1 from public.tg_team_members tm
          where tm.tg_pairing_id = p.id and tm.player_user_id = auth.uid()
        )
      )
    )
  );
