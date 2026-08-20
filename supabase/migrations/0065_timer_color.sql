alter table public.draft_events
  add column if not exists timer_color text default 'blue';
