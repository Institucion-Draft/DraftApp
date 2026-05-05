-- =====================================================================
-- Migration 0008: cooldown de display_name + unicidad case-insensitive
-- =====================================================================

alter table public.users
  add column if not exists display_name_changed_at timestamptz;

create unique index if not exists users_display_name_unique_ci
  on public.users (lower(display_name))
  where display_name is not null;

-- =====================================================================
-- FIN
-- =====================================================================
