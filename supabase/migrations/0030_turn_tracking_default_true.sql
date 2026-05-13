-- 0030_turn_tracking_default_true.sql
-- Activar el sistema de turnos con animaciones por defecto en eventos nuevos.

alter table public.draft_events alter column turn_tracking_enabled set default true;
