-- Snapshot del estado de seguridad (RLS y politicas) tomado de la base el 2026-11-05.
-- Cada politica se recrea con drop policy if exists + create policy.

-- RLS ACTIVADO

alter table public.achievement_definitions enable row level security;
alter table public.achievement_eval_errors enable row level security;
alter table public.achievement_eval_queue enable row level security;
alter table public.achievement_unlocks enable row level security;
alter table public.audit_log enable row level security;
alter table public.context_free_encounters enable row level security;
alter table public.context_free_life_events enable row level security;
alter table public.context_free_matches enable row level security;
alter table public.cube_roulette_spins enable row level security;
alter table public.cubes enable row level security;
alter table public.default_avatars enable row level security;
alter table public.dice_rolls enable row level security;
alter table public.draft_events enable row level security;
alter table public.draft_timer_logs enable row level security;
alter table public.event_color_predictions enable row level security;
alter table public.event_diary_entries enable row level security;
alter table public.event_diary_seen enable row level security;
alter table public.event_media enable row level security;
alter table public.event_participant_avatar_history enable row level security;
alter table public.event_participants enable row level security;
alter table public.event_seating enable row level security;
alter table public.event_seating_pending enable row level security;
alter table public.event_tiebreak_bracket_matches enable row level security;
alter table public.event_tiebreak_group_participants enable row level security;
alter table public.event_tiebreak_groups enable row level security;
alter table public.event_zones enable row level security;
alter table public.knockout_slots enable row level security;
alter table public.life_events enable row level security;
alter table public.match_turns enable row level security;
alter table public.matches enable row level security;
alter table public.pairings enable row level security;
alter table public.participant_colors enable row level security;
alter table public.playground_presence enable row level security;
alter table public.point_config_tiers enable row level security;
alter table public.point_configs enable row level security;
alter table public.season_calendar enable row level security;
alter table public.season_frozen_events enable row level security;
alter table public.season_frozen_positions enable row level security;
alter table public.seasons enable row level security;
alter table public.tg_life_events enable row level security;
alter table public.tg_matches enable row level security;
alter table public.tg_pairings enable row level security;
alter table public.tg_team_members enable row level security;
alter table public.users enable row level security;
alter table public.venues enable row level security;
alter table public.workspace_cube_roulette_config enable row level security;
alter table public.workspace_diary_entries enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.workspace_join_requests enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspaces enable row level security;

-- POLITICAS

drop policy if exists achievement_definitions_select on public.achievement_definitions;
create policy achievement_definitions_select on public.achievement_definitions as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists achievement_unlocks_select_workspace_members on public.achievement_unlocks;
create policy achievement_unlocks_select_workspace_members on public.achievement_unlocks as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists audit_log_select_member on public.audit_log;
create policy audit_log_select_member on public.audit_log as PERMISSIVE for SELECT to authenticated
  using (((workspace_id IS NOT NULL) AND is_workspace_member(workspace_id)));

drop policy if exists cfe_insert_participant on public.context_free_encounters;
create policy cfe_insert_participant on public.context_free_encounters as PERMISSIVE for INSERT to authenticated
  with check ((((user_a_id = auth.uid()) OR (user_b_id = auth.uid())) AND is_workspace_member(workspace_id)));

drop policy if exists cfe_select_member on public.context_free_encounters;
create policy cfe_select_member on public.context_free_encounters as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists cfe_update_participant on public.context_free_encounters;
create policy cfe_update_participant on public.context_free_encounters as PERMISSIVE for UPDATE to authenticated
  using (((user_a_id = auth.uid()) OR (user_b_id = auth.uid())));

drop policy if exists cfle_insert_participant on public.context_free_life_events;
create policy cfle_insert_participant on public.context_free_life_events as PERMISSIVE for INSERT to public
  with check ((EXISTS ( SELECT 1
   FROM (context_free_matches cfm
     JOIN context_free_encounters cfe ON ((cfe.id = cfm.encounter_id)))
  WHERE ((cfm.id = context_free_life_events.match_id) AND ((cfe.user_a_id = auth.uid()) OR (cfe.user_b_id = auth.uid()))))));

drop policy if exists cfle_select_member on public.context_free_life_events;
create policy cfle_select_member on public.context_free_life_events as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM (context_free_matches cfm
     JOIN context_free_encounters cfe ON ((cfe.id = cfm.encounter_id)))
  WHERE ((cfm.id = context_free_life_events.match_id) AND is_workspace_member(cfe.workspace_id)))));

drop policy if exists cfm_insert_participant on public.context_free_matches;
create policy cfm_insert_participant on public.context_free_matches as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM context_free_encounters cfe
  WHERE ((cfe.id = context_free_matches.encounter_id) AND ((cfe.user_a_id = auth.uid()) OR (cfe.user_b_id = auth.uid())) AND is_workspace_member(cfe.workspace_id)))));

drop policy if exists cfm_select_member on public.context_free_matches;
create policy cfm_select_member on public.context_free_matches as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM context_free_encounters cfe
  WHERE ((cfe.id = context_free_matches.encounter_id) AND is_workspace_member(cfe.workspace_id)))));

drop policy if exists cfm_update_participant on public.context_free_matches;
create policy cfm_update_participant on public.context_free_matches as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM context_free_encounters cfe
  WHERE ((cfe.id = context_free_matches.encounter_id) AND ((cfe.user_a_id = auth.uid()) OR (cfe.user_b_id = auth.uid()))))));

drop policy if exists roulette_spins_insert_organizer on public.cube_roulette_spins;
create policy roulette_spins_insert_organizer on public.cube_roulette_spins as PERMISSIVE for INSERT to authenticated
  with check (((spun_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = cube_roulette_spins.event_id) AND can_manage_event(de.workspace_id, de.id))))));

drop policy if exists roulette_spins_select_workspace_member on public.cube_roulette_spins;
create policy roulette_spins_select_workspace_member on public.cube_roulette_spins as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = cube_roulette_spins.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists cubes_delete_organizer on public.cubes;
create policy cubes_delete_organizer on public.cubes as PERMISSIVE for DELETE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists cubes_insert_organizer on public.cubes;
create policy cubes_insert_organizer on public.cubes as PERMISSIVE for INSERT to authenticated
  with check ((is_workspace_organizer(workspace_id) AND (created_by = auth.uid())));

drop policy if exists cubes_select_member on public.cubes;
create policy cubes_select_member on public.cubes as PERMISSIVE for SELECT to authenticated
  using (((deleted_at IS NULL) AND is_workspace_member(workspace_id)));

drop policy if exists cubes_update_organizer on public.cubes;
create policy cubes_update_organizer on public.cubes as PERMISSIVE for UPDATE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists default_avatars_select_all on public.default_avatars;
create policy default_avatars_select_all on public.default_avatars as PERMISSIVE for SELECT to authenticated
  using ((is_active = true));

drop policy if exists dice_insert_self_or_organizer on public.dice_rolls;
create policy dice_insert_self_or_organizer on public.dice_rolls as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM (event_participants ep
     JOIN draft_events de ON ((de.id = ep.event_id)))
  WHERE ((ep.id = dice_rolls.participant_id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid()) OR can_manage_event(de.workspace_id, de.id))))));

drop policy if exists dice_select_workspace_member on public.dice_rolls;
create policy dice_select_workspace_member on public.dice_rolls as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = dice_rolls.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists dice_update_organizer on public.dice_rolls;
create policy dice_update_organizer on public.dice_rolls as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = dice_rolls.event_id) AND is_workspace_organizer(de.workspace_id)))));

drop policy if exists events_delete_organizer on public.draft_events;
create policy events_delete_organizer on public.draft_events as PERMISSIVE for DELETE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists events_insert_organizer on public.draft_events;
create policy events_insert_organizer on public.draft_events as PERMISSIVE for INSERT to authenticated
  with check ((is_workspace_member(workspace_id) AND (created_by = auth.uid())));

drop policy if exists events_select_member on public.draft_events;
create policy events_select_member on public.draft_events as PERMISSIVE for SELECT to authenticated
  using (((deleted_at IS NULL) AND is_workspace_member(workspace_id)));

drop policy if exists events_update_organizer on public.draft_events;
create policy events_update_organizer on public.draft_events as PERMISSIVE for UPDATE to authenticated
  using (can_manage_event(workspace_id, id));

drop policy if exists timer_logs_insert on public.draft_timer_logs;
create policy timer_logs_insert on public.draft_timer_logs as PERMISSIVE for INSERT to public
  with check ((EXISTS ( SELECT 1
   FROM (draft_events de
     JOIN workspace_members wm ON ((wm.workspace_id = de.workspace_id)))
  WHERE ((de.id = draft_timer_logs.event_id) AND (wm.user_id = auth.uid()) AND (wm.role = 'organizer'::text)))));

drop policy if exists timer_logs_insert_organizer on public.draft_timer_logs;
create policy timer_logs_insert_organizer on public.draft_timer_logs as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = draft_timer_logs.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists timer_logs_select_participant_or_organizer on public.draft_timer_logs;
create policy timer_logs_select_participant_or_organizer on public.draft_timer_logs as PERMISSIVE for SELECT to authenticated
  using (((EXISTS ( SELECT 1
   FROM event_participants ep
  WHERE ((ep.event_id = draft_timer_logs.event_id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = draft_timer_logs.event_id) AND can_manage_event(de.workspace_id, de.id))))));

drop policy if exists insert_own_color_prediction on public.event_color_predictions;
create policy insert_own_color_prediction on public.event_color_predictions as PERMISSIVE for INSERT to public
  with check (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_color_predictions.event_id) AND is_workspace_member(de.workspace_id))))));

drop policy if exists select_color_predictions_for_workspace_members on public.event_color_predictions;
create policy select_color_predictions_for_workspace_members on public.event_color_predictions as PERMISSIVE for SELECT to public
  using ((event_id IN ( SELECT draft_events.id
   FROM draft_events)));

drop policy if exists update_own_color_prediction on public.event_color_predictions;
create policy update_own_color_prediction on public.event_color_predictions as PERMISSIVE for UPDATE to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

drop policy if exists diary_delete on public.event_diary_entries;
create policy diary_delete on public.event_diary_entries as PERMISSIVE for DELETE to public
  using (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_diary_entries.event_id) AND can_manage_event(de.workspace_id, de.id))))));

drop policy if exists diary_insert on public.event_diary_entries;
create policy diary_insert on public.event_diary_entries as PERMISSIVE for INSERT to public
  with check (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (event_participants ep
     JOIN draft_events de ON ((de.id = ep.event_id)))
  WHERE ((ep.event_id = event_diary_entries.event_id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid())) AND ((de.status = ANY (ARRAY['drafting'::text, 'playing'::text, 'completed'::text])) OR ((de.scheduled_for)::date = ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires'::text))::date)))))));

drop policy if exists diary_read on public.event_diary_entries;
create policy diary_read on public.event_diary_entries as PERMISSIVE for SELECT to public
  using (((EXISTS ( SELECT 1
   FROM event_participants ep
  WHERE ((ep.event_id = event_diary_entries.event_id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_diary_entries.event_id) AND can_manage_event(de.workspace_id, de.id))))));

drop policy if exists diary_update_own on public.event_diary_entries;
create policy diary_update_own on public.event_diary_entries as PERMISSIVE for UPDATE to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

drop policy if exists event_diary_seen_select_workspace_members on public.event_diary_seen;
create policy event_diary_seen_select_workspace_members on public.event_diary_seen as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_diary_seen.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists media_delete_uploader_or_organizer on public.event_media;
create policy media_delete_uploader_or_organizer on public.event_media as PERMISSIVE for DELETE to authenticated
  using (((uploaded_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_media.event_id) AND can_manage_event(de.workspace_id, de.id))))));

drop policy if exists media_insert_participant_or_organizer on public.event_media;
create policy media_insert_participant_or_organizer on public.event_media as PERMISSIVE for INSERT to authenticated
  with check (((uploaded_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_media.event_id) AND (can_manage_event(de.workspace_id, de.id) OR (EXISTS ( SELECT 1
           FROM event_participants ep
          WHERE ((ep.event_id = de.id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid())))))))))));

drop policy if exists media_select_workspace_member on public.event_media;
create policy media_select_workspace_member on public.event_media as PERMISSIVE for SELECT to authenticated
  using (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_media.event_id) AND is_workspace_member(de.workspace_id))))));

drop policy if exists media_update_uploader on public.event_media;
create policy media_update_uploader on public.event_media as PERMISSIVE for UPDATE to authenticated
  using (((uploaded_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_media.event_id) AND is_workspace_organizer(de.workspace_id))))));

drop policy if exists select_avatar_history_for_workspace_members on public.event_participant_avatar_history;
create policy select_avatar_history_for_workspace_members on public.event_participant_avatar_history as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_participant_avatar_history.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists participants_delete_organizer on public.event_participants;
create policy participants_delete_organizer on public.event_participants as PERMISSIVE for DELETE to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_participants.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists participants_insert_organizer on public.event_participants;
create policy participants_insert_organizer on public.event_participants as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_participants.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists participants_insert_self on public.event_participants;
create policy participants_insert_self on public.event_participants as PERMISSIVE for INSERT to authenticated
  with check (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_participants.event_id) AND is_workspace_member(de.workspace_id))))));

drop policy if exists participants_select_workspace_member on public.event_participants;
create policy participants_select_workspace_member on public.event_participants as PERMISSIVE for SELECT to authenticated
  using ((event_id IN ( SELECT draft_events.id
   FROM draft_events)));

drop policy if exists participants_update_organizer on public.event_participants;
create policy participants_update_organizer on public.event_participants as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_participants.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists participants_update_self on public.event_participants;
create policy participants_update_self on public.event_participants as PERMISSIVE for UPDATE to authenticated
  using ((user_id = auth.uid()));

drop policy if exists event_seating_select_members on public.event_seating;
create policy event_seating_select_members on public.event_seating as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_seating.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists event_seating_pending_select_managers on public.event_seating_pending;
create policy event_seating_pending_select_managers on public.event_seating_pending as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_seating_pending.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists select_tiebreak_bracket_matches_for_workspace_members on public.event_tiebreak_bracket_matches;
create policy select_tiebreak_bracket_matches_for_workspace_members on public.event_tiebreak_bracket_matches as PERMISSIVE for SELECT to public
  using ((group_id IN ( SELECT event_tiebreak_groups.id
   FROM event_tiebreak_groups)));

drop policy if exists select_tiebreak_group_participants_for_workspace_members on public.event_tiebreak_group_participants;
create policy select_tiebreak_group_participants_for_workspace_members on public.event_tiebreak_group_participants as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM (event_tiebreak_groups etg
     JOIN draft_events de ON ((de.id = etg.event_id)))
  WHERE ((etg.id = event_tiebreak_group_participants.group_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists select_tiebreak_groups_for_workspace_members on public.event_tiebreak_groups;
create policy select_tiebreak_groups_for_workspace_members on public.event_tiebreak_groups as PERMISSIVE for SELECT to public
  using ((event_id IN ( SELECT draft_events.id
   FROM draft_events)));

drop policy if exists event_zones_select_workspace_member on public.event_zones;
create policy event_zones_select_workspace_member on public.event_zones as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = event_zones.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists select_knockout_slots_for_workspace_members on public.knockout_slots;
create policy select_knockout_slots_for_workspace_members on public.knockout_slots as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM (event_tiebreak_groups g
     JOIN draft_events de ON ((de.id = g.event_id)))
  WHERE ((g.id = knockout_slots.group_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists life_events_delete_life_tracker on public.life_events;
create policy life_events_delete_life_tracker on public.life_events as PERMISSIVE for DELETE to authenticated
  using ((EXISTS ( SELECT 1
   FROM ((((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN event_participants ep_a ON ((ep_a.id = p.participant_a_id)))
     JOIN event_participants ep_b ON ((ep_b.id = p.participant_b_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = life_events.match_id) AND (m.status = 'in_progress'::text) AND (m.life_tracker_user_id = auth.uid()) AND ((ep_a.user_id = auth.uid()) OR (ep_a.member_b_user_id = auth.uid()) OR (ep_b.user_id = auth.uid()) OR (ep_b.member_b_user_id = auth.uid()) OR can_manage_event(de.workspace_id, de.id))))));

drop policy if exists life_events_insert_authorized on public.life_events;
create policy life_events_insert_authorized on public.life_events as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM ((((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN event_participants ep_a ON ((ep_a.id = p.participant_a_id)))
     JOIN event_participants ep_b ON ((ep_b.id = p.participant_b_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = life_events.match_id) AND (m.status = 'in_progress'::text) AND (m.life_tracker_user_id = auth.uid()) AND ((ep_a.user_id = auth.uid()) OR (ep_a.member_b_user_id = auth.uid()) OR (ep_b.user_id = auth.uid()) OR (ep_b.member_b_user_id = auth.uid()) OR can_manage_event(de.workspace_id, de.id))))));

drop policy if exists life_events_select_workspace_member on public.life_events;
create policy life_events_select_workspace_member on public.life_events as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM ((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = life_events.match_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists life_events_update_organizer on public.life_events;
create policy life_events_update_organizer on public.life_events as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM ((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = life_events.match_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists insert_match_turns_for_participants_or_organizer on public.match_turns;
create policy insert_match_turns_for_participants_or_organizer on public.match_turns as PERMISSIVE for INSERT to public
  with check ((EXISTS ( SELECT 1
   FROM ((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = match_turns.match_id) AND (is_workspace_organizer(de.workspace_id) OR (EXISTS ( SELECT 1
           FROM event_participants ep
          WHERE ((ep.event_id = de.id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid())) AND ((ep.id = p.participant_a_id) OR (ep.id = p.participant_b_id))))))))));

drop policy if exists select_match_turns_for_workspace_members on public.match_turns;
create policy select_match_turns_for_workspace_members on public.match_turns as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM ((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = match_turns.match_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists update_match_turns_for_participants_or_organizer on public.match_turns;
create policy update_match_turns_for_participants_or_organizer on public.match_turns as PERMISSIVE for UPDATE to public
  using ((EXISTS ( SELECT 1
   FROM ((matches m
     JOIN pairings p ON ((p.id = m.pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = match_turns.match_id) AND (is_workspace_organizer(de.workspace_id) OR (EXISTS ( SELECT 1
           FROM event_participants ep
          WHERE ((ep.event_id = de.id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid())) AND ((ep.id = p.participant_a_id) OR (ep.id = p.participant_b_id))))))))));

drop policy if exists matches_insert_participant_or_organizer on public.matches;
create policy matches_insert_participant_or_organizer on public.matches as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM (((pairings p
     JOIN event_participants ep_a ON ((ep_a.id = p.participant_a_id)))
     JOIN event_participants ep_b ON ((ep_b.id = p.participant_b_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = matches.pairing_id) AND ((ep_a.user_id = auth.uid()) OR (ep_a.member_b_user_id = auth.uid()) OR (ep_b.user_id = auth.uid()) OR (ep_b.member_b_user_id = auth.uid()) OR can_manage_event(de.workspace_id, de.id))))));

drop policy if exists matches_select_workspace_member on public.matches;
create policy matches_select_workspace_member on public.matches as PERMISSIVE for SELECT to authenticated
  using ((pairing_id IN ( SELECT pairings.id
   FROM pairings)));

drop policy if exists matches_update_authorized on public.matches;
create policy matches_update_authorized on public.matches as PERMISSIVE for UPDATE to authenticated
  using (((life_tracker_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (((pairings p
     JOIN event_participants ep_a ON ((ep_a.id = p.participant_a_id)))
     JOIN event_participants ep_b ON ((ep_b.id = p.participant_b_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = matches.pairing_id) AND ((ep_a.user_id = auth.uid()) OR (ep_a.member_b_user_id = auth.uid()) OR (ep_b.user_id = auth.uid()) OR (ep_b.member_b_user_id = auth.uid()) OR can_manage_event(de.workspace_id, de.id)))))));

drop policy if exists pairings_insert_organizer on public.pairings;
create policy pairings_insert_organizer on public.pairings as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = pairings.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists pairings_select_workspace_member on public.pairings;
create policy pairings_select_workspace_member on public.pairings as PERMISSIVE for SELECT to authenticated
  using ((event_id IN ( SELECT draft_events.id
   FROM draft_events)));

drop policy if exists pairings_update_organizer on public.pairings;
create policy pairings_update_organizer on public.pairings as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = pairings.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists colors_modify_self_or_organizer on public.participant_colors;
create policy colors_modify_self_or_organizer on public.participant_colors as PERMISSIVE for ALL to authenticated
  using ((EXISTS ( SELECT 1
   FROM (event_participants ep
     JOIN draft_events de ON ((de.id = ep.event_id)))
  WHERE ((ep.id = participant_colors.participant_id) AND ((ep.user_id = auth.uid()) OR (ep.member_b_user_id = auth.uid()) OR can_manage_event(de.workspace_id, de.id))))));

drop policy if exists colors_select_workspace_member on public.participant_colors;
create policy colors_select_workspace_member on public.participant_colors as PERMISSIVE for SELECT to authenticated
  using ((participant_id IN ( SELECT event_participants.id
   FROM event_participants)));

drop policy if exists pp_delete_own on public.playground_presence;
create policy pp_delete_own on public.playground_presence as PERMISSIVE for DELETE to authenticated
  using ((user_id = auth.uid()));

drop policy if exists pp_insert_own on public.playground_presence;
create policy pp_insert_own on public.playground_presence as PERMISSIVE for INSERT to authenticated
  with check (((user_id = auth.uid()) AND is_workspace_member(workspace_id)));

drop policy if exists pp_select_member on public.playground_presence;
create policy pp_select_member on public.playground_presence as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists pp_update_own on public.playground_presence;
create policy pp_update_own on public.playground_presence as PERMISSIVE for UPDATE to authenticated
  using ((user_id = auth.uid()));

drop policy if exists point_config_tiers_select_all on public.point_config_tiers;
create policy point_config_tiers_select_all on public.point_config_tiers as PERMISSIVE for SELECT to public
  using (true);

drop policy if exists point_configs_select_all on public.point_configs;
create policy point_configs_select_all on public.point_configs as PERMISSIVE for SELECT to public
  using (true);

drop policy if exists season_calendar_select_all on public.season_calendar;
create policy season_calendar_select_all on public.season_calendar as PERMISSIVE for SELECT to public
  using (true);

drop policy if exists season_frozen_events_select_workspace_members on public.season_frozen_events;
create policy season_frozen_events_select_workspace_members on public.season_frozen_events as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM seasons s
  WHERE ((s.id = season_frozen_events.season_id) AND is_workspace_member(s.workspace_id)))));

drop policy if exists season_frozen_positions_select_workspace_members on public.season_frozen_positions;
create policy season_frozen_positions_select_workspace_members on public.season_frozen_positions as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM seasons s
  WHERE ((s.id = season_frozen_positions.season_id) AND is_workspace_member(s.workspace_id)))));

drop policy if exists seasons_select_workspace_members on public.seasons;
create policy seasons_select_workspace_members on public.seasons as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists tg_life_events_insert_tracker_only on public.tg_life_events;
create policy tg_life_events_insert_tracker_only on public.tg_life_events as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM tg_matches m
  WHERE ((m.id = tg_life_events.tg_match_id) AND (m.life_tracker_user_id = auth.uid()) AND (m.status = 'in_progress'::text)))));

drop policy if exists tg_life_events_select_workspace_member on public.tg_life_events;
create policy tg_life_events_select_workspace_member on public.tg_life_events as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM ((tg_matches m
     JOIN tg_pairings p ON ((p.id = m.tg_pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = tg_life_events.tg_match_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists tg_life_events_update_organizer on public.tg_life_events;
create policy tg_life_events_update_organizer on public.tg_life_events as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM ((tg_matches m
     JOIN tg_pairings p ON ((p.id = m.tg_pairing_id)))
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((m.id = tg_life_events.tg_match_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists tg_matches_insert_player_or_organizer on public.tg_matches;
create policy tg_matches_insert_player_or_organizer on public.tg_matches as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM (tg_pairings p
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = tg_matches.tg_pairing_id) AND (can_manage_event(de.workspace_id, de.id) OR (EXISTS ( SELECT 1
           FROM tg_team_members tm
          WHERE ((tm.tg_pairing_id = p.id) AND (tm.player_user_id = auth.uid())))))))));

drop policy if exists tg_matches_select_workspace_member on public.tg_matches;
create policy tg_matches_select_workspace_member on public.tg_matches as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM (tg_pairings p
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = tg_matches.tg_pairing_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists tg_matches_update_authorized on public.tg_matches;
create policy tg_matches_update_authorized on public.tg_matches as PERMISSIVE for UPDATE to authenticated
  using (((life_tracker_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (tg_pairings p
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = tg_matches.tg_pairing_id) AND (can_manage_event(de.workspace_id, de.id) OR (EXISTS ( SELECT 1
           FROM tg_team_members tm
          WHERE ((tm.tg_pairing_id = p.id) AND (tm.player_user_id = auth.uid()))))))))));

drop policy if exists tg_pairings_insert_organizer on public.tg_pairings;
create policy tg_pairings_insert_organizer on public.tg_pairings as PERMISSIVE for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = tg_pairings.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists tg_pairings_select_workspace_member on public.tg_pairings;
create policy tg_pairings_select_workspace_member on public.tg_pairings as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = tg_pairings.event_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists tg_pairings_update_organizer on public.tg_pairings;
create policy tg_pairings_update_organizer on public.tg_pairings as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM draft_events de
  WHERE ((de.id = tg_pairings.event_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists tg_team_members_modify_organizer on public.tg_team_members;
create policy tg_team_members_modify_organizer on public.tg_team_members as PERMISSIVE for ALL to authenticated
  using ((EXISTS ( SELECT 1
   FROM (tg_pairings p
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = tg_team_members.tg_pairing_id) AND can_manage_event(de.workspace_id, de.id)))));

drop policy if exists tg_team_members_select_workspace_member on public.tg_team_members;
create policy tg_team_members_select_workspace_member on public.tg_team_members as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM (tg_pairings p
     JOIN draft_events de ON ((de.id = p.event_id)))
  WHERE ((p.id = tg_team_members.tg_pairing_id) AND is_workspace_member(de.workspace_id)))));

drop policy if exists users_select_related on public.users;
create policy users_select_related on public.users as PERMISSIVE for SELECT to authenticated
  using ((id IN ( SELECT my_visible_user_ids() AS my_visible_user_ids)));

drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users as PERMISSIVE for UPDATE to authenticated
  using ((auth.uid() = id));

drop policy if exists venues_delete_organizer on public.venues;
create policy venues_delete_organizer on public.venues as PERMISSIVE for DELETE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists venues_insert_organizer on public.venues;
create policy venues_insert_organizer on public.venues as PERMISSIVE for INSERT to authenticated
  with check ((is_workspace_organizer(workspace_id) AND (created_by = auth.uid())));

drop policy if exists venues_select_member on public.venues;
create policy venues_select_member on public.venues as PERMISSIVE for SELECT to authenticated
  using (((deleted_at IS NULL) AND is_workspace_member(workspace_id)));

drop policy if exists venues_update_organizer on public.venues;
create policy venues_update_organizer on public.venues as PERMISSIVE for UPDATE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists cube_roulette_config_select_members on public.workspace_cube_roulette_config;
create policy cube_roulette_config_select_members on public.workspace_cube_roulette_config as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists workspace_diary_insert on public.workspace_diary_entries;
create policy workspace_diary_insert on public.workspace_diary_entries as PERMISSIVE for INSERT to authenticated
  with check (((user_id = auth.uid()) AND is_workspace_member(workspace_id)));

drop policy if exists workspace_diary_read on public.workspace_diary_entries;
create policy workspace_diary_read on public.workspace_diary_entries as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists invites_insert_organizer on public.workspace_invites;
create policy invites_insert_organizer on public.workspace_invites as PERMISSIVE for INSERT to authenticated
  with check (is_workspace_organizer(workspace_id));

drop policy if exists invites_select_member on public.workspace_invites;
create policy invites_select_member on public.workspace_invites as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists invites_update_organizer on public.workspace_invites;
create policy invites_update_organizer on public.workspace_invites as PERMISSIVE for UPDATE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists join_requests_insert_self on public.workspace_join_requests;
create policy join_requests_insert_self on public.workspace_join_requests as PERMISSIVE for INSERT to authenticated
  with check (((user_id = auth.uid()) AND (status = 'pending'::text)));

drop policy if exists join_requests_select_organizer on public.workspace_join_requests;
create policy join_requests_select_organizer on public.workspace_join_requests as PERMISSIVE for SELECT to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists join_requests_select_own on public.workspace_join_requests;
create policy join_requests_select_own on public.workspace_join_requests as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

drop policy if exists join_requests_update_organizer on public.workspace_join_requests;
create policy join_requests_update_organizer on public.workspace_join_requests as PERMISSIVE for UPDATE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists members_delete_organizer on public.workspace_members;
create policy members_delete_organizer on public.workspace_members as PERMISSIVE for DELETE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists members_insert_organizer on public.workspace_members;
create policy members_insert_organizer on public.workspace_members as PERMISSIVE for INSERT to authenticated
  with check (is_workspace_organizer(workspace_id));

drop policy if exists members_select_if_member on public.workspace_members;
create policy members_select_if_member on public.workspace_members as PERMISSIVE for SELECT to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists members_update_organizer on public.workspace_members;
create policy members_update_organizer on public.workspace_members as PERMISSIVE for UPDATE to authenticated
  using (is_workspace_organizer(workspace_id));

drop policy if exists workspaces_insert_authenticated on public.workspaces;
create policy workspaces_insert_authenticated on public.workspaces as PERMISSIVE for INSERT to authenticated
  with check ((created_by = auth.uid()));

drop policy if exists workspaces_select_basic on public.workspaces;
create policy workspaces_select_basic on public.workspaces as PERMISSIVE for SELECT to authenticated
  using (((deleted_at IS NULL) AND (is_public OR (created_by = auth.uid()) OR is_workspace_member(id))));

drop policy if exists workspaces_update_organizer on public.workspaces;
create policy workspaces_update_organizer on public.workspaces as PERMISSIVE for UPDATE to authenticated
  using (is_workspace_organizer(id));
