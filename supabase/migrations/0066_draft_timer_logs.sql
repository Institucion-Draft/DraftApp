create table if not exists public.draft_timer_logs (
  id                bigserial primary key,
  event_id          uuid        not null references public.draft_events(id) on delete cascade,
  global_pick       integer     not null,
  pack_index        integer     not null,
  pick_in_pack      integer     not null,
  estimated_seconds integer     not null,
  actual_seconds    integer     not null,
  created_at        timestamptz not null default now()
);

alter table public.draft_timer_logs enable row level security;

create policy "Organizers can insert timer logs"
  on public.draft_timer_logs
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.draft_events de
      join public.event_participants ep on ep.event_id = de.id
      where de.id = draft_timer_logs.event_id
        and ep.user_id = auth.uid()
        and ep.role = 'organizer'
    )
  );
