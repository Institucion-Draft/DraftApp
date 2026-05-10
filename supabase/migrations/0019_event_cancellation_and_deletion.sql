-- 0019_event_cancellation_and_deletion.sql
-- Agrega los estados 'cancelled' y soft-delete a draft_events.
-- Eventos cancelled: visibles, marcados como cancelados, sin nuevos partidos, no cuentan al histórico.
-- Eventos eliminados (deleted_at no null): invisibles en listados.

-- 1. Agregar columnas
alter table public.draft_events
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.users(id);

-- 2. Extender el CHECK constraint del status para incluir 'cancelled'
alter table public.draft_events
  drop constraint if exists draft_events_status_check;

alter table public.draft_events
  add constraint draft_events_status_check
  check (status in ('scheduled', 'playing', 'completed', 'cancelled'));
