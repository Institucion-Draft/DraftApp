-- 0031_swiss_format.sql
-- Sistema de rondas suizas: formato alternativo a round-robin.

alter table public.draft_events
  add column if not exists competition_format text not null default 'round_robin',
  add constraint draft_events_competition_format_valid
    check (competition_format in ('round_robin', 'swiss')),
  add column if not exists swiss_rounds_total integer,
  add column if not exists current_swiss_round integer;

alter table public.event_participants
  add column if not exists swiss_points integer not null default 0,
  add column if not exists swiss_omw numeric,
  add column if not exists swiss_gw numeric,
  add column if not exists swiss_ogw numeric;

alter table public.pairings
  add column if not exists swiss_round integer;

create index if not exists idx_pairings_swiss_round on public.pairings (event_id, swiss_round);
