alter table public.context_free_matches
  add column if not exists started_by_user_id uuid references public.users(id);
