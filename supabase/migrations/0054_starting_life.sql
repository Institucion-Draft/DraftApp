-- 0054_starting_life.sql
--
-- Permite configurar la vida inicial de las partidas por evento.
-- El estándar de Two-Headed Giant es 30; el resto usa 20 por defecto.

alter table public.draft_events
  add column if not exists starting_life integer not null default 20
    check (starting_life in (20, 25, 30));
