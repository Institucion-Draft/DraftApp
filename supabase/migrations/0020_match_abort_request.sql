-- 0020_match_abort_request.sql
-- Sistema de aborto con doble confirmación.
-- Un participante solicita el aborto. El otro tiene 3 minutos para confirmar.
-- Si confirma, el match se aborta (status='aborted').
-- Si no responde en 3 minutos, la solicitud expira y cualquiera puede volver a solicitar.

alter table public.matches
  add column if not exists abort_requested_by uuid references public.users(id),
  add column if not exists abort_requested_at timestamptz;

create index if not exists idx_matches_abort_pending
  on public.matches (abort_requested_at)
  where abort_requested_by is not null;
