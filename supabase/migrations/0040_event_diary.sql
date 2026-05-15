-- 0040_event_diary.sql
-- Bitácora digital del evento: curiosidades, bugs, sugerencias.

create table if not exists public.event_diary_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  user_id uuid not null references public.users(id),
  entry_type text not null check (entry_type in ('curiosity', 'bug', 'suggestion')),
  content text not null check (length(content) > 0 and length(content) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_event_diary_event on public.event_diary_entries (event_id, entry_type, created_at);

-- RLS
alter table public.event_diary_entries enable row level security;

-- Lectura: cualquier participante o organizer del workspace puede leer entradas del evento.
create policy "diary_read" on public.event_diary_entries for select using (
  exists (
    select 1 from public.event_participants ep
    where ep.event_id = event_diary_entries.event_id and ep.user_id = auth.uid()
  ) or exists (
    select 1 from public.workspace_members wm
    join public.draft_events de on de.workspace_id = wm.workspace_id
    where de.id = event_diary_entries.event_id and wm.user_id = auth.uid() and wm.role = 'organizer'
  )
);

-- Insert: participante del evento, solo el día del evento (scheduled_for está en hoy o el evento está en curso), o evento ya completed (bitácora retrospectiva).
create policy "diary_insert" on public.event_diary_entries for insert with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.event_participants ep
    join public.draft_events de on de.id = ep.event_id
    where ep.event_id = event_diary_entries.event_id
      and ep.user_id = auth.uid()
      and (de.status in ('drafting', 'playing', 'completed') or
           (de.scheduled_for::date = (now() at time zone 'America/Argentina/Buenos_Aires')::date))
  )
);

-- Update: solo el dueño puede editar su propia entrada (solo content, no entry_type ni nada más).
create policy "diary_update_own" on public.event_diary_entries for update using (
  user_id = auth.uid()
) with check (
  user_id = auth.uid()
);

-- Delete: dueño o organizer.
create policy "diary_delete" on public.event_diary_entries for delete using (
  user_id = auth.uid()
  or exists (
    select 1 from public.workspace_members wm
    join public.draft_events de on de.workspace_id = wm.workspace_id
    where de.id = event_diary_entries.event_id and wm.user_id = auth.uid() and wm.role = 'organizer'
  )
);
