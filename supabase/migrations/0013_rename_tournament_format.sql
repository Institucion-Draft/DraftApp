-- 0013_rename_tournament_format.sql
-- Renombra la columna tournament_format a competition_format en draft_events.
-- El nombre anterior era ambiguo porque "tournament" coincide con un valor de
-- event_type ('draft' / 'tournament' / 'pepidraft'), lo que sugería que el
-- formato aplicaba solo a eventos tipo torneo. En realidad este formato
-- (round-robin / suizas / grupos+playoffs) aplica a cualquier evento sin
-- importar el event_type, por lo que "competition_format" es más preciso.

alter table public.draft_events
  rename column tournament_format to competition_format;
