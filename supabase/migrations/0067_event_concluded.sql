-- Add 'concluded' as a valid event status for round_robin events manually closed by organizer.
-- Two constraints cover status: events_status_valid (from 0001) and draft_events_status_check (from 0019).
alter table public.draft_events drop constraint if exists events_status_valid;
alter table public.draft_events drop constraint if exists draft_events_status_check;

alter table public.draft_events
  add constraint draft_events_status_check
  check (status in ('scheduled', 'drafting', 'playing', 'completed', 'cancelled', 'concluded'));
