-- =====================================================================
-- Migration 0004: soporte para Life Tracker (Sprint 4)
-- - lock de control por user/celu en matches
-- - registro de rendición
-- =====================================================================

-- 1. Lock de control en matches
alter table public.matches
  add column controlled_by_user_id uuid references public.users(id);

alter table public.matches
  add column controlled_at timestamptz;

create index idx_matches_controlled_by 
  on public.matches (controlled_by_user_id) 
  where controlled_by_user_id is not null;

-- 2. Registro de rendición en matches
alter table public.matches
  add column ended_by_surrender boolean not null default false;

-- =====================================================================
-- FIN
-- =====================================================================