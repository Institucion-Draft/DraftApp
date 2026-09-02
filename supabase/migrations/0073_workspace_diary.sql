-- 0073_workspace_diary.sql
-- Bitácora de bugs/sugerencias a nivel workspace (sin atarla a un evento).

create table public.workspace_diary_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id),
  kind text not null check (kind in ('bug', 'suggestion')),
  content text not null check (length(content) > 0 and length(content) <= 2000),
  created_at timestamptz not null default now()
);

create index idx_workspace_diary_workspace on public.workspace_diary_entries (workspace_id, created_at);

alter table public.workspace_diary_entries enable row level security;

create policy "workspace_diary_read"
  on public.workspace_diary_entries for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace_diary_insert"
  on public.workspace_diary_entries for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );
