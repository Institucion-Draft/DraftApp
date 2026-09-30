-- 0127_draft_events_constraints_drift.sql
--
-- Deja en el historial el estado real de prod para draft_events. Todo es idempotente y no cambia
-- nada en prod (ahí ya está así); solo corrige las reconstrucciones desde cero.
--
-- 1. events_type_valid (0003) solo admitía draft, tournament y pepidraft, pero la app crea eventos
--    two_headed_giant. En prod el constraint ya tiene los cuatro valores.
-- 2. events_format_valid y events_champion_decision_valid (0001) quedaron huérfanos: las migraciones
--    posteriores crearon draft_events_competition_format_valid y draft_events_champion_decision_valid
--    con otro nombre sin borrar los viejos. En prod ya no existen; en una base reconstruida el viejo
--    champion_decision (solo 'auto' y 'manual_override') rechazaría 'tiebreak', 'polemica', etc.
-- 3. turn_tracking_enabled: 0030 lo dejó en true, prod lo tiene en false.

alter table public.draft_events drop constraint if exists events_type_valid;

alter table public.draft_events
  add constraint events_type_valid
  check (event_type in ('draft', 'tournament', 'pepidraft', 'two_headed_giant'));

alter table public.draft_events drop constraint if exists events_format_valid;
alter table public.draft_events drop constraint if exists events_champion_decision_valid;

alter table public.draft_events alter column turn_tracking_enabled set default false;
