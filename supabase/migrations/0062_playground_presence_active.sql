alter table public.playground_presence add column if not exists is_active boolean not null default true;
alter table public.playground_presence add column if not exists left_at timestamptz;
